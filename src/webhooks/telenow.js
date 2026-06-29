// ─────────────────────────────────────────────────────────────────────────────
// webhooks/telenow.js — receive Telenow call-result webhooks + write back to BigCommerce.
//
// Inbound from Telenow → this app:
//   headers: X-VoiceAI-Signature: sha256=<hex HMAC-SHA256 of raw body>
//            X-VoiceAI-Event:     call.ended | call.analyzed
//            X-VoiceAI-Delivery:  <uuid>
//   body (call.ended / call.analyzed):
//     { event_type, session_id, agent_id, status, duration, from_number,
//       to_number, ended_at, identifier?, transcript?, analysis? }
//
// We verify the HMAC over the RAW body using the signing secret returned when we
// created the hook (persisted per-store). We try the secret of the store that
// owns the originating call (looked up via session_id→entity map); if the call
// isn't found, we fall back to trying all known store secrets.
//
// Write-back:
//   - LEAD callback result   → patch the lead row (resolved BEFORE the order path)
//   - COD confirmation result→ staff note + metafield telenow_cod (confirmed/cancelled/no-response)
//   - any other call         → staff note + telenow_last_call metafield with outcome
//
// Also exports ensureTelenowHook()/removeTelenowHook() used at install + settings.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import express from 'express';

import { HOST, appendOrderStaffNote, setOrderMetafield } from '../bigcommerce.js';
import { getSettings } from '../settings.js';
import { getHook, saveHook, deleteHook, getCall, deleteCall, listStores, updateLead } from '../store.js';
import { TelenowClient, HOOK_SOURCE } from '../telenow.js';

export const telenowWebhookRouter = express.Router();

const WEBHOOK_PATH = '/telenow/webhook';

/** Absolute URL Telenow should POST results to (used when creating the hook). */
export const TELENOW_WEBHOOK_URL = `${HOST}${WEBHOOK_PATH}`;

// ─────────────────────────────────────────────────────────────────────────────
// Hook lifecycle (subscribe / unsubscribe to Telenow result webhooks)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure this store has exactly one Telenow webhook subscription pointing at us,
 * and persist its signing secret. Idempotent: reuses an existing matching hook.
 * Call this after the merchant saves their API key.
 * @param {string} storeHash
 */
export async function ensureTelenowHook(storeHash) {
  const settings = getSettings(storeHash);
  if (!settings.telenowApiKey) throw new Error('No Telenow API key set for store');

  const client = new TelenowClient(settings.telenowApiKey);

  const existingLocal = getHook(storeHash);

  // Check Telenow's side for a bigcommerce-source hook pointing at our URL.
  let remote = [];
  try {
    remote = await client.listHooks(HOOK_SOURCE);
  } catch (err) {
    console.error(`[telenow] listHooks failed for ${storeHash}:`, err.message);
  }
  // Hook fields from the list endpoint are snake_case (target_url).
  const match = (remote || []).find((h) => h.target_url === TELENOW_WEBHOOK_URL);

  if (match && existingLocal?.id === match.id && existingLocal?.secret) {
    return existingLocal; // already wired and we have the secret
  }

  // If there's a remote match but we lost the secret, we must recreate it (the
  // secret is only returned at creation). Delete the stale one first.
  if (match) {
    try {
      await client.deleteHook(match.id);
    } catch (err) {
      console.error(`[telenow] could not delete stale hook ${match.id}:`, err.message);
    }
  }

  const created = await client.createHook({
    targetUrl: TELENOW_WEBHOOK_URL,
    events: ['call.ended', 'call.analyzed'],
    source: HOOK_SOURCE,
    includeTranscript: true,
  });
  // The signing secret is only returned at creation. Prefer signing_secret; the
  // backend also returns it as `secret` for backward compatibility.
  const signingSecret = created?.signing_secret ?? created?.secret;
  if (!signingSecret) {
    throw new Error('Telenow createHook did not return a signing secret');
  }
  saveHook(storeHash, { id: created.id, secret: signingSecret });
  console.log(`[telenow] hook created for ${storeHash} (id=${created.id})`);
  return getHook(storeHash);
}

/** Remove this store's Telenow webhook subscription (on uninstall / key change). */
export async function removeTelenowHook(storeHash) {
  const local = getHook(storeHash);
  const settings = getSettings(storeHash);
  if (local?.id && settings.telenowApiKey) {
    try {
      const client = new TelenowClient(settings.telenowApiKey);
      await client.deleteHook(local.id);
    } catch (err) {
      console.error(`[telenow] deleteHook failed for ${storeHash}:`, err.message);
    }
  }
  deleteHook(storeHash);
}

// ─────────────────────────────────────────────────────────────────────────────
// Signature verification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify X-VoiceAI-Signature ("sha256=<hex>") over the raw body with a secret.
 * Telenow emits HMAC-SHA256 hex-encoded (backend uses hex::encode). We compare
 * against hex and, defensively, base64 — using a constant-time comparison.
 * @param {string} rawBody  exact bytes received
 * @param {string} header   value of X-VoiceAI-Signature
 * @param {string} secret   hook signing secret
 * @returns {boolean}
 */
export function verifyTelenowSignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  const provided = header.startsWith('sha256=') ? header.slice('sha256='.length) : header;
  const mac = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest();
  // Canonical is hex; base64 kept as a belt-and-braces fallback.
  return [mac.toString('hex'), mac.toString('base64')].some((expected) => {
    try {
      const a = Buffer.from(provided);
      const b = Buffer.from(expected);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  });
}

/**
 * Resolve which store/secret a delivery belongs to and verify it.
 * Strategy: if we can match the call by session_id, use that store's secret;
 * otherwise brute-force across all stored secrets (small N) so we still verify.
 * @param {string} rawBody
 * @param {string} sigHeader
 * @param {object} payload  parsed body (for session_id)
 * @returns {{ storeHash: string, call?: object } | null}
 */
function authenticateDelivery(rawBody, sigHeader, payload) {
  // 1) Preferred: locate by the call we placed.
  const call = payload?.session_id ? getCall(payload.session_id) : undefined;
  if (call?.storeHash) {
    const hook = getHook(call.storeHash);
    if (hook?.secret && verifyTelenowSignature(rawBody, sigHeader, hook.secret)) {
      return { storeHash: call.storeHash, call };
    }
  }
  // 2) Fallback: try every stored secret (handles calls not in the map, e.g.
  //    after a restart dropped the in-memory map). N = installed stores.
  for (const { storeHash } of listStores()) {
    const hook = getHook(storeHash);
    if (hook?.secret && verifyTelenowSignature(rawBody, sigHeader, hook.secret)) {
      // Defense: never write a session-matched call under a DIFFERENT tenant than
      // the one that authenticated. If the session maps to another store, drop it.
      return { storeHash, call: call?.storeHash === storeHash ? call : undefined };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The receiver endpoint
// ─────────────────────────────────────────────────────────────────────────────
// Mounted at WEBHOOK_PATH in server.js, so the inner route is '/'. server.js also
// applies express.text({ type: '*/*' }) for this path so req.body is the raw
// string we must HMAC. Always ACK 2xx once authenticated so Telenow doesn't
// retry; do the BigCommerce write-back asynchronously.

telenowWebhookRouter.post('/', async (req, res) => {
  const rawBody = typeof req.body === 'string' ? req.body : req.body?.toString('utf8') ?? '';
  const sig = req.get('X-VoiceAI-Signature');
  const eventHeader = req.get('X-VoiceAI-Event');

  let payload;
  try {
    payload = JSON.parse(rawBody || '{}');
  } catch {
    res.status(400).send('invalid JSON');
    return;
  }

  const auth = authenticateDelivery(rawBody, sig, payload);
  if (!auth) {
    console.warn(`[telenow] signature verification failed (event=${eventHeader})`);
    res.status(401).send('invalid signature');
    return;
  }

  // ACK immediately; process write-back in the background.
  res.status(200).json({ ok: true });

  handleResult(auth.storeHash, auth.call, payload).catch((err) =>
    console.error(`[telenow] write-back failed for ${auth.storeHash}:`, err.message),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Outcome → BigCommerce write-back
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply the call outcome. Lead callbacks resolve to a lead row; everything else
 * resolves to a BigCommerce order.
 * @param {string} storeHash
 * @param {object|undefined} call  the persisted callMap entry (has orderId/leadId/automation)
 * @param {object} payload         the Telenow webhook body
 */
async function handleResult(storeHash, call, payload) {
  const eventType = payload.event_type || '';
  const sessionId = payload.session_id;

  // ── Lead callback: write back to the lead row, not an order (resolve FIRST) ──
  // A lead session never has an order to tag, and resolving it before the order
  // path means a lead result is never mis-handled as an order.
  let leadId = call?.leadId;
  if (!leadId) {
    const id = parseIdentifier(payload.identifier);
    if (id?.type === 'lead') leadId = id.value;
  }
  if (leadId) {
    updateLead(storeHash, leadId, {
      status: 'completed',
      disposition: readDisposition(payload),
      summary: payload.analysis?.summary || '',
      duration: payload.duration ?? null,
      sessionId: payload.session_id || null,
    });
    console.log(`[telenow] wrote back lead=${leadId} store=${storeHash}`);
    cleanupIfFinal(eventType, sessionId);
    return;
  }

  // Resolve the order id. Prefer the persisted map; fall back to parsing the
  // identifier we sent (e.g. "order:12345" or "order:12345:shipped").
  let orderId = call?.orderId;
  const automation = call?.automation;
  if (!orderId) {
    const id = parseIdentifier(payload.identifier);
    if (id?.type === 'order') orderId = id.value;
  }

  // No order (e.g. an abandoned-cart call) → just log.
  if (!orderId) {
    console.log(
      `[telenow] result for session=${sessionId} automation=${automation || '?'} ` +
        `has no order to write back (likely a cart/customer call) — logged only`,
    );
    cleanupIfFinal(eventType, sessionId);
    return;
  }

  const disposition = readDisposition(payload);
  const summary = payload.analysis?.summary || '';
  const durationLine = payload.duration ? ` (${payload.duration}s)` : '';

  // ── COD-specific write-back ──────────────────────────────────────────────────
  if (automation === 'codConfirmation') {
    let codValue = 'no-response';
    let note;
    if (disposition === 'confirmed') {
      codValue = 'confirmed';
      note = `Telenow: COD CONFIRMED by customer${durationLine}.${summary ? ' ' + summary : ''}`;
    } else if (disposition === 'cancelled') {
      codValue = 'cancelled';
      note = `Telenow: COD CANCELLED/refused by customer${durationLine}.${summary ? ' ' + summary : ''}`;
      // TODO (optional): auto-cancel via PUT /v2/orders/{id} { status_id: 5 } (Cancelled).
      // We deliberately DO NOT auto-cancel — the merchant reviews the metafield first.
    } else {
      note = `Telenow: COD call completed, no clear confirmation${durationLine}.${
        summary ? ' ' + summary : ''
      }`;
    }
    await appendOrderStaffNote(storeHash, orderId, note);
    await setOrderMetafield(storeHash, orderId, 'telenow_cod', codValue);
  } else {
    // ── Generic outcome note for non-COD automations ──────────────────────────
    const label = automation ? `[${automation}] ` : '';
    await appendOrderStaffNote(
      storeHash,
      orderId,
      `Telenow ${label}call ${payload.status || 'completed'}${durationLine}.${
        summary ? ' ' + summary : ''
      }`,
    );
  }

  // ── Structured metafield for app access (best-effort) ─────────────────────────
  try {
    await setOrderMetafield(
      storeHash,
      orderId,
      'last_call',
      JSON.stringify({
        session_id: sessionId,
        status: payload.status,
        disposition,
        duration: payload.duration,
        ended_at: payload.ended_at,
      }),
    );
  } catch (err) {
    console.error(`[telenow] metafield write failed for order ${orderId}:`, err.message);
  }

  console.log(
    `[telenow] wrote back order=${orderId} automation=${automation || '?'} disposition=${disposition}`,
  );

  cleanupIfFinal(eventType, sessionId);
}

/** Drop the session→entity mapping once we've seen a terminal event. */
function cleanupIfFinal(eventType, sessionId) {
  // call.analyzed is the richest/last event; clean up after it. If only
  // call.ended arrives (no analysis configured), the entry is GC'd later.
  if (eventType === 'call.analyzed' && sessionId) deleteCall(sessionId);
}

/**
 * Map Telenow's analysis to a COD decision. `analysis` may carry a disposition/
 * summary; we look at a few likely fields and keyword-match the summary fallback.
 * @param {object} payload
 * @returns {'confirmed'|'cancelled'|'unknown'}
 */
function readDisposition(payload) {
  const a = payload.analysis || {};
  const raw = String(a.disposition || a.outcome || a.result || a.label || '').toLowerCase();

  if (/(confirm|accept|yes|approved|will take|keep)/.test(raw)) return 'confirmed';
  if (/(cancel|refus|reject|decline|no longer|don'?t want|return)/.test(raw)) return 'cancelled';

  // Fallback: scan the summary text.
  const summary = String(a.summary || payload.transcript || '').toLowerCase();
  if (summary) {
    if (/(confirmed the order|wants to keep|will accept|happy to pay)/.test(summary)) {
      return 'confirmed';
    }
    if (/(cancel|does not want|refused|won'?t accept|return it)/.test(summary)) {
      return 'cancelled';
    }
  }
  return 'unknown';
}

/** Parse identifiers like "order:12345" / "order:123:shipped" / "lead:99". */
function parseIdentifier(identifier) {
  if (!identifier || typeof identifier !== 'string') return null;
  const [type, value] = identifier.split(':');
  if (!type || !value) return null;
  return { type, value };
}
