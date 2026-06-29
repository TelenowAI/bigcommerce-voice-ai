// ─────────────────────────────────────────────────────────────────────────────
// webhooks/bigcommerce.js — BigCommerce webhook management + inbound receiver.
//
// BigCommerce webhooks differ from Shopify in two important ways:
//   1) We create subscriptions ourselves via POST /v3/hooks with a `destination`
//      (our public URL) and a custom `headers` map. BigCommerce ECHOES those
//      headers back on every delivery.
//   2) BigCommerce does NOT HMAC-sign deliveries. So we put a random per-store
//      shared secret in the webhook's `headers` ({ "X-Telenow-Token": "<secret>" })
//      and verify inbound deliveries by constant-time comparing that header.
//
// Delivery body is small: { scope, store_id, data: { type, id }, hash, ... }.
// It carries only the entity id, so each handler HYDRATES the full entity from
// the Admin API before placing a call.
//
// Subscribed scopes:
//   store/order/created        → order confirmation + COD confirmation
//   store/order/statusUpdated  → delivery / status updates
//   store/customer/created     → lead callback
//   store/cart/created|updated → abandoned cart (delayed re-check)
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import express from 'express';

import { HOST, adminRequest, getOrder, getCustomer } from '../bigcommerce.js';
import { getStore, listStores } from '../store.js';

import { handleOrderConfirmation, handleOrderStatusUpdate } from '../automations/orderUpdates.js';
import { handleCodConfirmation } from '../automations/codConfirmation.js';
import { handleLeadCallback } from '../automations/leadCallback.js';
import { handleAbandonedCart } from '../automations/abandonedCart.js';

export const bigcommerceWebhookRouter = express.Router();

const WEBHOOK_PATH = '/webhooks/bigcommerce';

/** Absolute URL BigCommerce should POST store events to. */
export const BIGCOMMERCE_WEBHOOK_URL = `${HOST}${WEBHOOK_PATH}`;

/** Custom header name carrying our per-store shared verification token. */
const TOKEN_HEADER = 'x-telenow-token';

/** Scopes we subscribe to. Kept in one place so install can report the count. */
export const WEBHOOK_SCOPES = [
  'store/order/created',
  'store/order/statusUpdated',
  'store/customer/created',
  'store/cart/created',
  'store/cart/updated',
];

// ─────────────────────────────────────────────────────────────────────────────
// Subscription lifecycle (create / list / delete via /v3/hooks)
// ─────────────────────────────────────────────────────────────────────────────

/** List this store's existing BigCommerce webhooks. */
async function listBcHooks(storeHash) {
  const data = await adminRequest(storeHash, 'GET', '/v3/hooks');
  return data?.data || [];
}

/**
 * Ensure each scope in WEBHOOK_SCOPES has exactly one active hook pointing at us
 * with the store's shared token in its headers. Idempotent: reuses matching hooks
 * and (re)creates missing/mismatched ones. Call after OAuth install.
 * @param {string} storeHash
 */
export async function ensureBigCommerceWebhooks(storeHash) {
  const store = getStore(storeHash);
  if (!store?.accessToken) throw new Error(`No access token for store ${storeHash}`);
  const token = store.webhookToken;
  if (!token) throw new Error(`No webhook token for store ${storeHash}`);

  let existing = [];
  try {
    existing = await listBcHooks(storeHash);
  } catch (err) {
    console.error(`[bc-webhook] list hooks failed for ${storeHash}:`, err.message);
  }

  let created = 0;
  for (const scope of WEBHOOK_SCOPES) {
    const match = existing.find(
      (h) => h.scope === scope && h.destination === BIGCOMMERCE_WEBHOOK_URL,
    );
    if (match && match.is_active) continue; // already wired

    // Remove a stale/inactive hook for this scope+destination before recreating.
    if (match) {
      try {
        await adminRequest(storeHash, 'DELETE', `/v3/hooks/${match.id}`);
      } catch (err) {
        console.error(`[bc-webhook] delete stale hook ${match.id} failed:`, err.message);
      }
    }

    try {
      await adminRequest(storeHash, 'POST', '/v3/hooks', {
        scope,
        destination: BIGCOMMERCE_WEBHOOK_URL,
        is_active: true,
        headers: { 'X-Telenow-Token': token },
      });
      created++;
    } catch (err) {
      console.error(`[bc-webhook] create hook (${scope}) failed for ${storeHash}:`, err.message);
    }
  }
  console.log(
    `[bc-webhook] ensured ${WEBHOOK_SCOPES.length} scopes for ${storeHash} (${created} (re)created)`,
  );
}

/** Delete all of this store's hooks pointing at us (on uninstall). */
export async function removeBigCommerceWebhooks(storeHash) {
  let existing = [];
  try {
    existing = await listBcHooks(storeHash);
  } catch (err) {
    console.error(`[bc-webhook] list hooks (for removal) failed for ${storeHash}:`, err.message);
    return;
  }
  for (const h of existing) {
    if (h.destination !== BIGCOMMERCE_WEBHOOK_URL) continue;
    try {
      await adminRequest(storeHash, 'DELETE', `/v3/hooks/${h.id}`);
    } catch (err) {
      console.error(`[bc-webhook] delete hook ${h.id} failed:`, err.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Inbound verification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the store for a delivery and verify its shared token. BigCommerce
 * deliveries carry `store_id` but NOT the store *hash*; we identify the store by
 * matching the echoed X-Telenow-Token against each store's stored token
 * (constant-time). N = installed stores, so this stays small.
 * @param {import('express').Request} req
 * @param {object} payload  parsed body
 * @returns {{ storeHash: string } | null}
 */
function authenticateDelivery(req, payload) {
  const provided = req.get(TOKEN_HEADER) || req.get('X-Telenow-Token') || '';
  if (!provided) return null;

  // Prefer a store whose producer matches the payload's store hash if present
  // (BigCommerce includes the hash in `producer` like "stores/abc123").
  const producerHash = storeHashFromProducer(payload?.producer);

  const candidates = listStoresSafe();
  // Check the producer-matched store first (still token-verified).
  const ordered = producerHash
    ? [...candidates].sort((a, b) => (a.storeHash === producerHash ? -1 : b.storeHash === producerHash ? 1 : 0))
    : candidates;

  for (const store of ordered) {
    if (!store?.webhookToken) continue;
    if (timingSafeEqualStr(provided, store.webhookToken)) {
      return { storeHash: store.storeHash };
    }
  }
  return null;
}

function storeHashFromProducer(producer) {
  if (!producer || typeof producer !== 'string') return null;
  const m = producer.match(/stores\/([^/]+)/);
  return m ? m[1] : null;
}

function timingSafeEqualStr(a, b) {
  try {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function listStoresSafe() {
  try {
    return listStores();
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The receiver endpoint
// ─────────────────────────────────────────────────────────────────────────────
// Mounted at WEBHOOK_PATH in server.js, so the inner route is '/'. server.js
// applies express.json() for this path (BigCommerce does not HMAC-sign, so we do
// not need the raw body). We ACK 200 fast and dispatch in the background so
// BigCommerce doesn't retry; hydration + the Telenow call happen async.

bigcommerceWebhookRouter.post('/', (req, res) => {
  const payload = req.body || {};

  const auth = authenticateDelivery(req, payload);
  if (!auth) {
    console.warn(`[bc-webhook] token verification failed (scope=${payload?.scope || '?'})`);
    res.status(401).json({ error: 'invalid token' });
    return;
  }

  // ACK immediately; dispatch in the background.
  res.status(200).json({ ok: true });

  dispatch(auth.storeHash, payload).catch((err) =>
    console.error(`[bc-webhook] dispatch failed for ${auth.storeHash}:`, err.message),
  );
});

/**
 * Route a verified delivery to the right automation(s), hydrating the entity
 * from the Admin API first (the webhook only carries the id).
 * @param {string} storeHash
 * @param {object} payload  { scope, data: { type, id }, ... }
 */
async function dispatch(storeHash, payload) {
  const scope = payload?.scope || '';
  const entityId = payload?.data?.id;

  switch (scope) {
    case 'store/order/created': {
      const order = await getOrder(storeHash, entityId);
      if (!order) return;
      // Two independent automations key off order/created. Each is individually
      // gated by its own enabled flag, so both can run or neither.
      runHandler('order/created→confirm', () => handleOrderConfirmation(storeHash, order));
      runHandler('order/created→cod', () => handleCodConfirmation(storeHash, order));
      break;
    }
    case 'store/order/statusUpdated': {
      const order = await getOrder(storeHash, entityId);
      if (!order) return;
      runHandler('order/statusUpdated', () => handleOrderStatusUpdate(storeHash, order, payload));
      break;
    }
    case 'store/customer/created': {
      const customer = (await getCustomer(storeHash, entityId)) || { id: entityId };
      runHandler('customer/created→lead', () => handleLeadCallback(storeHash, customer));
      break;
    }
    case 'store/cart/created':
    case 'store/cart/updated': {
      // Cart payloads carry the cart id; the abandoned-cart handler hydrates +
      // schedules a delayed re-check (see automations/abandonedCart.js).
      runHandler('cart→abandoned', () => handleAbandonedCart(storeHash, entityId, payload));
      break;
    }
    default:
      // Unsubscribed scope (shouldn't happen) — ignore.
      break;
  }
}

/**
 * Safely run a handler in the background, logging skips/errors but never letting
 * a failure surface (we already ACKed 200).
 */
function runHandler(name, fn) {
  Promise.resolve()
    .then(fn)
    .then((r) => {
      if (r && r.placed === false && r.reason) {
        console.log(`[bc-webhook:${name}] skipped: ${r.reason}`);
      }
    })
    .catch((err) => console.error(`[bc-webhook:${name}] error:`, err.message));
}
