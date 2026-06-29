// ─────────────────────────────────────────────────────────────────────────────
// server.js — Express app entrypoint.
//
// Wiring order matters because of body parsers:
//   - The Telenow webhook needs the RAW body for HMAC, so it gets
//     express.text({ type: '*/*' }) and is mounted BEFORE the global JSON parser.
//   - The BigCommerce webhook is NOT HMAC-signed (we verify a shared token in the
//     echoed headers), so it can use express.json().
//   - The settings API gets express.json().
//   - /app serves the static settings page.
//
// Run with: `npm start` (needs env from .env — see .env.example).
// ─────────────────────────────────────────────────────────────────────────────

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import 'dotenv/config';
import express from 'express';

import { HOST } from './bigcommerce.js';
import { authRouter, rootHandler } from './auth.js';
import { bigcommerceWebhookRouter } from './webhooks/bigcommerce.js';
import { telenowWebhookRouter, ensureTelenowHook } from './webhooks/telenow.js';
import { getSettings, getRedactedSettings, updateSettings, AUTOMATIONS } from './settings.js';
import { getStore, listLeads } from './store.js';
import { verifySessionToken } from './session.js';
import { TelenowClient } from './telenow.js';
import { runWinBackSweep } from './automations/winBack.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.disable('x-powered-by');

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'telenow-bigcommerce' }));

// ── Telenow webhook receiver (RAW body — must come before express.json) ───────
// Telenow's X-VoiceAI-Signature verifies over raw bytes.
app.use('/telenow/webhook', express.text({ type: '*/*', limit: '2mb' }), telenowWebhookRouter);

// ── BigCommerce webhook receiver (JSON; verified by shared token header) ───────
app.use('/webhooks/bigcommerce', express.json({ limit: '2mb' }), bigcommerceWebhookRouter);

// ── Everything else can use JSON ──────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));

// ── OAuth + lifecycle callbacks (/auth, /load, /uninstall, /remove-user) ──────
app.use(authRouter);

// ── Landing ───────────────────────────────────────────────────────────────────
app.get('/', rootHandler);

// ── Embedded settings UI ──────────────────────────────────────────────────────
app.get('/app', (_req, res) => {
  // The page reads ?storeHash= itself; we just serve the static shell.
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Settings API (consumed by /app)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve + validate the store for an /api/* data route. The tenant is derived
 * from a SIGNED session token in the `Authorization: Bearer <t>` header — NOT
 * from the (non-secret, guessable) ?storeHash= query — so one merchant can't read
 * or overwrite another's data by swapping the query param. 401 if the token is
 * missing/invalid/expired; 404 if the resolved store isn't installed.
 */
function requireInstalledStore(req, res) {
  const authz = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(authz.trim());
  const token = m ? m[1].trim() : '';
  const storeHash = verifySessionToken(token);
  if (!storeHash) {
    res.status(401).json({ error: 'missing or invalid session token' });
    return null;
  }
  if (!getStore(storeHash)) {
    res.status(404).json({ error: 'store not installed — complete OAuth first' });
    return null;
  }
  return storeHash;
}

// GET current settings (redacted key) + the automation catalog for the UI.
app.get('/api/settings', (req, res) => {
  const storeHash = requireInstalledStore(req, res);
  if (!storeHash) return;
  res.json({
    settings: getRedactedSettings(storeHash),
    catalog: AUTOMATIONS.map(({ key, label, triggers }) => ({ key, label, triggers })),
  });
});

// GET captured leads (newest first) for the Leads view in the embedded app.
app.get('/api/leads', (req, res) => {
  const storeHash = requireInstalledStore(req, res);
  if (!storeHash) return;
  res.json({ leads: listLeads(storeHash, 100) });
});

// POST settings update. If the API key changed, (re)subscribe the Telenow hook.
app.post('/api/settings', async (req, res) => {
  const storeHash = requireInstalledStore(req, res);
  if (!storeHash) return;

  const before = getSettings(storeHash).telenowApiKey;
  const patch = sanitizeSettingsPatch(req.body);
  const saved = updateSettings(storeHash, patch);

  let hookStatus = '';
  if (patch.telenowApiKey && patch.telenowApiKey !== before) {
    try {
      const client = new TelenowClient(saved.telenowApiKey);
      await client.me(); // throws if invalid
      await ensureTelenowHook(storeHash);
      hookStatus = 'Telenow connected and result webhook subscribed.';
    } catch (err) {
      hookStatus = `Saved, but Telenow setup failed: ${err.message}`;
    }
  }

  res.json({ settings: getRedactedSettings(storeHash), hookStatus });
});

// POST validate-key: optionally save a new key, then call Telenow /me.
app.post('/api/validate-key', async (req, res) => {
  const storeHash = requireInstalledStore(req, res);
  if (!storeHash) return;

  if (req.body?.telenowApiKey) {
    updateSettings(storeHash, { telenowApiKey: String(req.body.telenowApiKey) });
  }
  const key = getSettings(storeHash).telenowApiKey;
  if (!key) {
    res.status(400).json({ error: 'no API key set' });
    return;
  }
  try {
    const me = await new TelenowClient(key).me();
    res.json(me);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Whitelist + coerce the settings patch coming from the browser so we never
 * persist arbitrary fields. Mirrors the shape settings.js understands.
 */
function sanitizeSettingsPatch(body = {}) {
  const out = {};
  if (typeof body.telenowApiKey === 'string' && body.telenowApiKey.trim()) {
    out.telenowApiKey = body.telenowApiKey.trim();
  }
  if (body.winBackDays != null) out.winBackDays = Number(body.winBackDays) || 60;

  if (body.automations && typeof body.automations === 'object') {
    out.automations = {};
    for (const def of AUTOMATIONS) {
      const a = body.automations[def.key];
      if (!a) continue;
      out.automations[def.key] = {
        enabled: Boolean(a.enabled),
        agentId: typeof a.agentId === 'string' ? a.agentId.trim() : '',
        delayMinutes: Math.max(0, Number(a.delayMinutes) || 0),
        filters: a.filters && typeof a.filters === 'object' ? a.filters : undefined,
        quietHours: a.quietHours
          ? {
              enabled: Boolean(a.quietHours.enabled),
              start: String(a.quietHours.start || '21:00'),
              end: String(a.quietHours.end || '09:00'),
              timezone: String(a.quietHours.timezone || 'Asia/Kolkata'),
            }
          : undefined,
      };
      if (out.automations[def.key].filters === undefined) delete out.automations[def.key].filters;
      if (out.automations[def.key].quietHours === undefined) {
        delete out.automations[def.key].quietHours;
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduled jobs (win-back sweep)
//
// Simple setInterval scheduler. TODO: swap for node-cron or a real job runner in
// production; also guard against overlapping runs across multiple instances.
// ─────────────────────────────────────────────────────────────────────────────

const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS) || 6 * 60 * 60 * 1000; // 6h

function startSchedulers() {
  const tick = async () => {
    try {
      await runWinBackSweep();
    } catch (err) {
      console.error('[scheduler] win-back sweep error:', err.message);
    }
  };
  // Don't run at boot by default; first run after one interval. Set
  // SWEEP_RUN_ON_BOOT=1 to run once at startup for testing.
  if (process.env.SWEEP_RUN_ON_BOOT === '1') tick();
  const t = setInterval(tick, SWEEP_INTERVAL_MS);
  t.unref?.(); // don't keep the process alive solely for the timer
  console.log(`[scheduler] win-back sweep every ${Math.round(SWEEP_INTERVAL_MS / 3600000)}h`);
}

// ── 404 + error handlers ──────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'not found', path: req.path }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[server] unhandled error:', err);
  if (!res.headersSent) res.status(500).json({ error: 'internal error' });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nTelenow BigCommerce app listening on :${PORT}`);
  console.log(`  Public HOST:          ${HOST}`);
  console.log(`  Auth callback:        ${HOST}/auth`);
  console.log(`  Load callback:        ${HOST}/load`);
  console.log(`  Uninstall callback:   ${HOST}/uninstall`);
  console.log(`  Remove-user callback: ${HOST}/remove-user`);
  console.log(`  Settings UI:          ${HOST}/app?storeHash=YOUR_STORE_HASH`);
  console.log(`  BigCommerce webhooks → ${HOST}/webhooks/bigcommerce`);
  console.log(`  Telenow webhooks →     ${HOST}/telenow/webhook`);
  console.log(`  Telenow API base:     ${process.env.TELENOW_API_BASE || 'https://api.telenow.ai'}\n`);
  startSchedulers();
});

export { app };
