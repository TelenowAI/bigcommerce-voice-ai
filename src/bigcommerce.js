// ─────────────────────────────────────────────────────────────────────────────
// bigcommerce.js — BigCommerce OAuth + signed-JWT verify + Admin API client.
//
// Unlike Shopify there is no first-party Node SDK we depend on here; this module
// implements the small slice of BigCommerce we need with `fetch` + `crypto`:
//
//   OAuth (single-click install):
//     - exchangeCode(): POST https://login.bigcommerce.com/oauth2/token with
//       { client_id, client_secret, code, scope, grant_type, redirect_uri,
//         context } → { access_token, context: "stores/<hash>", user, owner, ... }
//
//   Signed payloads (load / uninstall / remove_user callbacks):
//     - verifySignedPayloadJwt(): BigCommerce signs these as a JWT with the app
//       client secret (HS256). We verify the signature + exp/nbf and return the
//       claims (store_hash, user, owner, ...). (Legacy `signed_payload` HMAC form
//       is also supported as a fallback.)
//
//   Admin API:
//     - adminRequest(): base https://api.bigcommerce.com/stores/<hash>, header
//       X-Auth-Token: <accessToken>. Orders are V2 (/v2/orders/{id}); customers
//       and products are V3 (/v3/...).
//     - write-back helpers: appendOrderStaffNote(), setOrderMetafield(),
//       getOrder(), getCustomer().
//
// SECURITY: never log the access token, the client secret, or the webhook token.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';

import { getStore } from './store.js';

// ── Config from env ──────────────────────────────────────────────────────────

export const HOST = (process.env.HOST || 'http://localhost:3000').replace(/\/$/, '');

export const CLIENT_ID = process.env.BIGCOMMERCE_CLIENT_ID || '';
export const CLIENT_SECRET = process.env.BIGCOMMERCE_CLIENT_SECRET || '';

/** BigCommerce login host (token exchange + JWT issuer). */
const LOGIN_URL = (process.env.BIGCOMMERCE_LOGIN_URL || 'https://login.bigcommerce.com').replace(
  /\/$/,
  '',
);
/** BigCommerce REST API host. */
const API_URL = (process.env.BIGCOMMERCE_API_URL || 'https://api.bigcommerce.com').replace(
  /\/$/,
  '',
);

/** redirect_uri passed to the token endpoint — MUST match the app's Auth Callback URL. */
export const AUTH_CALLBACK_URL = process.env.BIGCOMMERCE_AUTH_CALLBACK || `${HOST}/auth`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  // Don't throw at import time (lets tooling load the module), but warn loudly.
  console.warn(
    '[bigcommerce] BIGCOMMERCE_CLIENT_ID / BIGCOMMERCE_CLIENT_SECRET are not set — ' +
      'OAuth will fail until they are.',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuth
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Exchange the temporary `code` from the /auth callback for a permanent access
 * token. BigCommerce returns the token plus the install context.
 * @param {{ code: string, scope: string, context: string }} q  query params from /auth
 * @returns {Promise<{ access_token: string, scope: string, context: string,
 *                      user?: object, owner?: object }>}
 */
export async function exchangeCode({ code, scope, context }) {
  if (!code) throw new Error('OAuth: missing code');
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('OAuth: app credentials not configured');

  const res = await fetch(`${LOGIN_URL}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: AUTH_CALLBACK_URL,
      grant_type: 'authorization_code',
      code,
      scope,
      context,
    }),
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = data?.error_description || data?.error || `token exchange → ${res.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  if (!data?.access_token || !data?.context) {
    throw new Error('OAuth: token response missing access_token/context');
  }
  return data;
}

/** Extract "abc123" from a BigCommerce context like "stores/abc123". */
export function storeHashFromContext(context) {
  if (!context || typeof context !== 'string') return null;
  const m = context.match(/^stores\/(.+)$/);
  return m ? m[1] : context;
}

// ─────────────────────────────────────────────────────────────────────────────
// Signed payload verification (load / uninstall / remove_user)
// ─────────────────────────────────────────────────────────────────────────────

/** base64url → Buffer. */
function b64urlDecode(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s + pad, 'base64');
}

/**
 * Verify a `signed_payload_jwt` BigCommerce sends to the load/uninstall/
 * remove_user callbacks. It's a JWT signed HS256 with the app client secret.
 * Returns the decoded claims, or throws on any verification failure.
 *
 * Claims of interest: `sub` ("stores/<hash>"), `user` { id, email },
 * `owner` { id, email }, `store_hash`.
 * @param {string} token  the signed_payload_jwt value
 * @param {string} [secret=CLIENT_SECRET]
 * @returns {object} decoded payload claims
 */
export function verifySignedPayloadJwt(token, secret = CLIENT_SECRET) {
  if (!token || typeof token !== 'string') throw new Error('signed JWT: missing token');
  if (!secret) throw new Error('signed JWT: client secret not configured');

  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('signed JWT: malformed');
  const [headerB64, payloadB64, sigB64] = parts;

  const header = JSON.parse(b64urlDecode(headerB64).toString('utf8'));
  if (header.alg !== 'HS256') throw new Error(`signed JWT: unexpected alg ${header.alg}`);

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  const provided = b64urlDecode(sigB64);
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    throw new Error('signed JWT: bad signature');
  }

  const claims = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.nbf === 'number' && now + 30 < claims.nbf) {
    throw new Error('signed JWT: not yet valid');
  }
  if (typeof claims.exp === 'number' && now - 30 > claims.exp) {
    throw new Error('signed JWT: expired');
  }
  // Audience should be our client id when present.
  if (claims.aud && CLIENT_ID && claims.aud !== CLIENT_ID) {
    throw new Error('signed JWT: audience mismatch');
  }
  return claims;
}

/**
 * Verify the LEGACY `signed_payload` form (base64 "<payload>.<hmacHex>") still
 * sent by some BigCommerce callbacks. Returns the decoded JSON or throws.
 * @param {string} signedPayload
 * @param {string} [secret=CLIENT_SECRET]
 */
export function verifyLegacySignedPayload(signedPayload, secret = CLIENT_SECRET) {
  if (!signedPayload || typeof signedPayload !== 'string') {
    throw new Error('signed_payload: missing');
  }
  if (!secret) throw new Error('signed_payload: client secret not configured');
  const idx = signedPayload.lastIndexOf('.');
  if (idx < 0) throw new Error('signed_payload: malformed');
  const encodedJson = signedPayload.slice(0, idx);
  const providedSig = signedPayload.slice(idx + 1);
  const expectedSig = crypto.createHmac('sha256', secret).update(encodedJson).digest('hex');
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('signed_payload: bad signature');
  }
  return JSON.parse(Buffer.from(encodedJson, 'base64').toString('utf8'));
}

/**
 * Verify whichever signed form a callback used. BigCommerce now sends
 * `signed_payload_jwt`; older integrations got `signed_payload`. Returns
 * normalized { storeHash, user, owner, raw }.
 * @param {object} query  the request query (load/uninstall/remove_user are GET)
 */
export function verifyCallbackSignature(query = {}) {
  if (query.signed_payload_jwt) {
    const claims = verifySignedPayloadJwt(query.signed_payload_jwt);
    return {
      storeHash: storeHashFromContext(claims.sub) || claims.store_hash || null,
      user: claims.user || null,
      owner: claims.owner || null,
      raw: claims,
    };
  }
  if (query.signed_payload) {
    const data = verifyLegacySignedPayload(query.signed_payload);
    return {
      storeHash: storeHashFromContext(data.context) || data.store_hash || null,
      user: data.user || null,
      owner: data.owner || null,
      raw: data,
    };
  }
  throw new Error('no signed_payload_jwt / signed_payload on request');
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin REST API
// ─────────────────────────────────────────────────────────────────────────────

/** Admin REST base for a store, e.g. https://api.bigcommerce.com/stores/abc123 */
function adminBase(storeHash) {
  return `${API_URL}/stores/${storeHash}`;
}

/**
 * Authenticated Admin REST request. Returns parsed JSON (or null).
 * @param {string} storeHash
 * @param {string} method
 * @param {string} path  begins with "/v2/..." or "/v3/..."
 * @param {object} [body]
 */
export async function adminRequest(storeHash, method, path, body) {
  const session = getStore(storeHash);
  if (!session?.accessToken) {
    throw new Error(`No access token for store ${storeHash} — is the app installed?`);
  }
  const res = await fetch(`${adminBase(storeHash)}${path}`, {
    method,
    headers: {
      'X-Auth-Token': session.accessToken, // ← auth; never log this value
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg =
      data?.title || data?.errors || data?.error || `BigCommerce ${method} ${path} → ${res.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data;
}

/**
 * Fetch a full V2 order. The webhook only carries the order id, so we hydrate.
 * @param {string} storeHash @param {string|number} orderId
 * @returns {Promise<object|null>}
 */
export async function getOrder(storeHash, orderId) {
  // V2 order responses are the bare object (not enveloped).
  return adminRequest(storeHash, 'GET', `/v2/orders/${orderId}`);
}

/**
 * Fetch a single V3 customer (used to hydrate store/customer/created and to read
 * a phone number).
 * @param {string} storeHash @param {string|number} customerId
 * @returns {Promise<object|null>}  the customer object, or null
 */
export async function getCustomer(storeHash, customerId) {
  // V3 list endpoint enveloped as { data: [...], meta }.
  const data = await adminRequest(
    storeHash,
    'GET',
    `/v3/customers?id:in=${encodeURIComponent(customerId)}`,
  );
  return data?.data?.[0] || null;
}

/**
 * Append a line to an order as a STAFF note (V2 orders carry `staff_notes`).
 * We read the current value first so we don't clobber existing notes.
 * @param {string} storeHash @param {string|number} orderId @param {string} line
 */
export async function appendOrderStaffNote(storeHash, orderId, line) {
  if (!line) return;
  const order = await getOrder(storeHash, orderId).catch(() => null);
  const existing = order?.staff_notes ? `${order.staff_notes}\n` : '';
  const staff_notes = `${existing}${line}`.slice(0, 65535);
  return adminRequest(storeHash, 'PUT', `/v2/orders/${orderId}`, { staff_notes });
}

/**
 * Write a metafield onto an order (namespace "telenow"). BigCommerce order
 * metafields are V3: /v3/orders/{id}/metafields. We upsert by key.
 * @param {string} storeHash
 * @param {string|number} orderId
 * @param {string} key
 * @param {string} value
 * @param {'text'|'string'} [permissionSet='app_only']  unused placeholder; kept simple
 */
export async function setOrderMetafield(storeHash, orderId, key, value) {
  const namespace = 'telenow';
  // Look for an existing metafield with this namespace+key to decide POST vs PUT.
  let existingId = null;
  try {
    const list = await adminRequest(
      storeHash,
      'GET',
      `/v3/orders/${orderId}/metafields?namespace=${encodeURIComponent(
        namespace,
      )}&key=${encodeURIComponent(key)}`,
    );
    existingId = list?.data?.[0]?.id ?? null;
  } catch {
    existingId = null; // listing failed → attempt a create
  }

  const payload = {
    namespace,
    key,
    value: String(value),
    permission_set: 'app_only',
  };

  if (existingId) {
    return adminRequest(storeHash, 'PUT', `/v3/orders/${orderId}/metafields/${existingId}`, {
      value: String(value),
      permission_set: 'app_only',
    });
  }
  return adminRequest(storeHash, 'POST', `/v3/orders/${orderId}/metafields`, payload);
}

/**
 * Best-effort: list customers ordered by last activity for the win-back sweep.
 * V3 customers don't expose "last order date" directly, so the sweep filters
 * client-side (see automations/winBack.js). Returns the raw V3 page.
 * @param {string} storeHash @param {{ limit?: number, page?: number }} [opts]
 */
export async function listCustomers(storeHash, { limit = 50, page = 1 } = {}) {
  const data = await adminRequest(
    storeHash,
    'GET',
    `/v3/customers?limit=${limit}&page=${page}&include=addresses`,
  );
  return data?.data || [];
}

/**
 * Best-effort: fetch a customer's orders (V2) to find their most recent one.
 * Used by the win-back sweep to compute "days since last order".
 * @param {string} storeHash @param {string|number} customerId
 * @returns {Promise<Array<object>>}
 */
export async function listCustomerOrders(storeHash, customerId) {
  const data = await adminRequest(
    storeHash,
    'GET',
    `/v2/orders?customer_id=${encodeURIComponent(customerId)}&sort=date_created:desc&limit=1`,
  );
  return Array.isArray(data) ? data : [];
}
