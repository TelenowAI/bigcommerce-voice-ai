// ─────────────────────────────────────────────────────────────────────────────
// session.js — signed UI session tokens for the /api/* data routes.
//
// The embedded settings UI is opened with ?storeHash=, but storeHash is NOT a
// secret (it appears in URLs/logs and can be guessed). So the /api/* routes must
// NOT trust the query param for auth — anyone who knows another tenant's hash
// could otherwise read its leads (PII) and overwrite its Telenow key/agents.
//
// Instead we mint a short-lived HMAC token at the VERIFIED entry point (/load,
// after the BigCommerce signed_payload_jwt verifies) and derive the tenant from
// THAT token on every API call. Same proven scheme as the Magento RecoveryUrl
// service: token = base64url("<storeHash>.<exp>.<hmac>"), hmac signed over
// "<storeHash>.<exp>" with the app secret, compared constant-time, expiry-checked.
//
// APP_SECRET reuses the BigCommerce client secret (the exact env var used to
// verify the signed_payload_jwt in bigcommerce.js). If it is unset the token
// can't be minted or verified — we degrade safely (mint→'' , verify→null), which
// makes the /api routes reject with 401 rather than silently trusting the query.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';

/** Token lifetime: how long a minted UI session stays valid. */
const TTL_SECONDS = 8 * 60 * 60; // 8h

/** The app secret used to sign tokens — same env as the BigCommerce client secret. */
function appSecret() {
  return process.env.BIGCOMMERCE_CLIENT_SECRET || '';
}

/** URL-safe base64 encode (no padding). */
function base64UrlEncode(str) {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** URL-safe base64 decode → utf8 string ('' on failure). */
function base64UrlDecode(str) {
  try {
    const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
    const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
    return Buffer.from(s + pad, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Mint a signed session token for a store, or '' if the app secret is unset.
 * @param {string} storeHash
 * @returns {string} base64url token, or ''
 */
export function mintSessionToken(storeHash) {
  const key = appSecret();
  if (!key || !storeHash) return '';
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const data = `${storeHash}.${exp}`;
  const hmac = crypto.createHmac('sha256', key).update(data).digest('hex');
  return base64UrlEncode(`${data}.${hmac}`);
}

/**
 * Verify a session token and return its storeHash, or null when the token is
 * missing, malformed, tampered, expired, or the app secret is unset.
 * @param {string} token
 * @returns {string|null}
 */
export function verifySessionToken(token) {
  const key = appSecret();
  if (!key || !token || typeof token !== 'string') return null;

  const decoded = base64UrlDecode(token.trim());
  if (!decoded) return null;

  // "<storeHash>.<exp>.<hmac>" — exactly three parts.
  const parts = decoded.split('.');
  if (parts.length !== 3) return null;
  const [storeHash, expPart, providedHmac] = parts;
  if (!storeHash || !/^\d+$/.test(expPart) || !providedHmac) return null;

  const data = `${storeHash}.${expPart}`;
  const expectedHmac = crypto.createHmac('sha256', key).update(data).digest('hex');
  const a = Buffer.from(providedHmac);
  const b = Buffer.from(expectedHmac);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  if (Number(expPart) < Math.floor(Date.now() / 1000)) return null; // expired

  return storeHash;
}
