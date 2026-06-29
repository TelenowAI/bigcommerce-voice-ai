// ─────────────────────────────────────────────────────────────────────────────
// store.js — persistence stub (file-based JSON).
//
// !!! REPLACE WITH A REAL DATABASE IN PRODUCTION !!!
// This module keeps everything in a single JSON file under DATA_DIR plus an
// in-memory cache. It is fine for local development and a single-process demo,
// but it is NOT safe for multi-instance/concurrent production deployments
// (no locking, last-write-wins, whole-file rewrites). Swap the logical stores
// below for tables in Postgres/MySQL/DynamoDB/etc.:
//
//   1. stores       — installed BigCommerce stores keyed by store hash
//                     { storeHash, accessToken, scope, webhookToken, ... }
//   2. settings     — per-store automation settings (see settings.js)
//   3. callMap      — sessionId → { storeHash, orderId, customerId, leadId,
//                     automation, identifier } (for write-back)
//   4. hooks        — per-store Telenow webhook subscription { id, secret }
//   5. attempts     — per-entity dedupe marks (atomic check-and-set)
//   6. leads        — captured leads (PII) + leadSeq per-store id counter
//
// Telenow API keys live inside `settings` (per store). They are secrets — see the
// security note in README.md. Never log them. The per-store `webhookToken` (the
// shared secret BigCommerce echoes back on webhook delivery) lives on the store
// record — also a secret, never logged.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, '..', 'data');

const DB_FILE = path.join(DATA_DIR, 'store.json');

/** @typedef {{ stores: object, settings: object, callMap: object, hooks: object,
 *              attempts: object, leads: object, leadSeq: object }} DB */

/** In-memory cache of the whole DB. Loaded once at startup. */
let db = load();

function emptyDb() {
  return { stores: {}, settings: {}, callMap: {}, hooks: {}, attempts: {}, leads: {}, leadSeq: {} };
}

function load() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DB_FILE)) return emptyDb();
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    return migrate({ ...emptyDb(), ...parsed });
  } catch (err) {
    // Corrupt file shouldn't crash the app — start fresh.
    console.error('[store] failed to load DB, starting empty:', err.message);
    return emptyDb();
  }
}

/**
 * One-time, idempotent rekey of any legacy lead entries that were stored under a
 * BARE numeric id (the pre-fix layout, where two tenants' first leads collided at
 * leads[1]). Re-home each such row under the composite `${storeHash}:${id}` key so
 * existing store.json data isn't orphaned. Rows already keyed compositely (the
 * map key contains ':') are left untouched.
 * @param {DB} d
 * @returns {DB}
 */
function migrate(d) {
  if (!d || !d.leads) return d;
  for (const [mapKey, lead] of Object.entries(d.leads)) {
    if (mapKey.includes(':')) continue; // already composite
    if (!lead || !lead.storeHash || lead.id == null) continue; // can't rekey safely
    const composite = `${lead.storeHash}:${lead.id}`;
    delete d.leads[mapKey];
    d.leads[composite] = { ...lead, key: composite };
  }
  return d;
}

/** Atomically-ish persist the in-memory DB to disk (write tmp + rename). */
function persist() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  } catch (err) {
    console.error('[store] failed to persist DB:', err.message);
  }
}

// ── Stores (installed BigCommerce stores) ────────────────────────────────────

/**
 * Persist an installed store. We store the minimal fields we need to make Admin
 * API calls later (the OAuth access token doesn't expire until the merchant
 * uninstalls) plus the per-store webhook shared token.
 * @param {string} storeHash  e.g. "abc123" (from context "stores/abc123")
 * @param {{ accessToken: string, scope?: string, webhookToken?: string,
 *           context?: string, ownerEmail?: string, userId?: string|number }} session
 */
export function saveStore(storeHash, session = {}) {
  const prev = db.stores[storeHash] || {};
  db.stores[storeHash] = {
    storeHash,
    accessToken: session.accessToken ?? prev.accessToken,
    scope: session.scope ?? prev.scope,
    context: session.context ?? prev.context ?? `stores/${storeHash}`,
    // Shared secret we set on BigCommerce webhooks; BigCommerce echoes it back in
    // the delivery headers so we can verify (BigCommerce does not HMAC-sign).
    webhookToken: session.webhookToken ?? prev.webhookToken ?? randomToken(),
    ownerEmail: session.ownerEmail ?? prev.ownerEmail,
    userId: session.userId ?? prev.userId,
    installedAt: prev.installedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  persist();
  return db.stores[storeHash];
}

/** @returns {{ storeHash: string, accessToken: string, webhookToken: string } | undefined} */
export function getStore(storeHash) {
  return db.stores[storeHash];
}

export function listStores() {
  return Object.values(db.stores);
}

/** Generate a random opaque token for BigCommerce webhook verification. */
export function randomToken() {
  return crypto.randomBytes(16).toString('hex'); // 32 hex chars
}

/**
 * Remove a store and ALL of its associated data. Used on app uninstall /
 * store/redact. Purges everything we hold for the store (PII included).
 * @param {string} storeHash
 */
export function deleteStore(storeHash) {
  delete db.stores[storeHash];
  delete db.settings[storeHash];
  delete db.hooks[storeHash];
  // Drop any callMap entries belonging to this store.
  for (const [sid, entry] of Object.entries(db.callMap)) {
    if (entry?.storeHash === storeHash) delete db.callMap[sid];
  }
  // Drop dedupe attempts. Keys are "<automation>:<storeHash>:<identifier>"
  // (see _base.js), so match on ":<storeHash>:".
  for (const k of Object.keys(db.attempts)) {
    if (k.includes(`:${storeHash}:`)) delete db.attempts[k];
  }
  // Drop this store's leads (PII) and reset its lead id counter.
  for (const [id, lead] of Object.entries(db.leads)) {
    if (lead?.storeHash === storeHash) delete db.leads[id];
  }
  delete db.leadSeq[storeHash];
  persist();
}

// ── Settings (per store) ──────────────────────────────────────────────────────
// Raw get/set — the typed model + defaults live in settings.js.

export function getSettingsRaw(storeHash) {
  return db.settings[storeHash];
}

export function setSettingsRaw(storeHash, settings) {
  db.settings[storeHash] = settings;
  persist();
  return settings;
}

// ── Call map (sessionId → entity) ─────────────────────────────────────────────
// Persisted so the Telenow result webhook can find the originating order/lead.

/**
 * @param {string} sessionId  Telenow sessionId returned by initiate-call
 * @param {{ storeHash: string, orderId?: string|number, customerId?: string|number,
 *           leadId?: number, automation: string, identifier?: string }} entry
 */
export function mapCall(sessionId, entry) {
  db.callMap[sessionId] = { ...entry, createdAt: new Date().toISOString() };
  persist();
}

export function getCall(sessionId) {
  return db.callMap[sessionId];
}

export function deleteCall(sessionId) {
  delete db.callMap[sessionId];
  persist();
}

// ── Per-entity attempt dedupe ────────────────────────────────────────────────
// BigCommerce redelivers webhooks (on timeout/retry), and several store events
// can fire for the same entity, so we record an attempt per
// (store+automation+entity) and refuse to place a second call for the same key
// within a TTL. Atomic check-and-set so two near-simultaneous deliveries can't
// both pass the guard.

/**
 * Record an attempt for `key` IF one isn't already live. Returns true if this
 * caller "won" (should proceed to place the call), false if a live attempt
 * already exists (skip — duplicate).
 * @param {string} key   stable key, e.g. "codConfirmation:abc123:order:456"
 * @param {number} ttlMs how long the attempt blocks re-attempts (default 24h)
 */
export function markAttempt(key, ttlMs = 24 * 60 * 60 * 1000) {
  if (!key) return true;
  const now = Date.now();
  const prev = db.attempts[key];
  if (prev && now - prev.at < (prev.ttlMs ?? ttlMs)) {
    return false; // a live attempt already exists → caller should skip
  }
  db.attempts[key] = { at: now, ttlMs };
  // Opportunistically GC expired entries so the map doesn't grow unbounded.
  for (const [k, v] of Object.entries(db.attempts)) {
    if (now - v.at >= (v.ttlMs ?? ttlMs)) delete db.attempts[k];
  }
  persist();
  return true;
}

/** Forget an attempt (e.g. to allow a retry after a failed placement). */
export function clearAttempt(key) {
  if (db.attempts[key]) {
    delete db.attempts[key];
    persist();
  }
}

// ── Telenow hook subscription (per store) ─────────────────────────────────────
// We store the hook id + signing secret returned by POST /api/v1/hooks so we
// can verify inbound X-VoiceAI-Signature and clean up on uninstall.

/** @param {string} storeHash @param {{ id: string, secret: string }} hook */
export function saveHook(storeHash, hook) {
  db.hooks[storeHash] = { ...hook, savedAt: new Date().toISOString() };
  persist();
}

export function getHook(storeHash) {
  return db.hooks[storeHash];
}

/**
 * Find the store that owns a Telenow hook by its signing secret. Used by the
 * Telenow webhook receiver to verify the signature when the payload doesn't
 * carry the store. Returns { storeHash, hook } or undefined.
 */
export function findStoreByHookSecret(secret) {
  for (const [storeHash, hook] of Object.entries(db.hooks)) {
    if (hook?.secret === secret) return { storeHash, hook };
  }
  return undefined;
}

export function deleteHook(storeHash) {
  delete db.hooks[storeHash];
  persist();
}

// ── Leads (per store) ─────────────────────────────────────────────────────────
// A lead is captured when BigCommerce creates a customer (store/customer/created
// — signup / checkout account / a contact app). We store it FIRST (so it appears
// in the dashboard even if the call is skipped), then place a speed-to-lead
// callback and patch the row with the result. These rows hold PII
// (name/email/phone).
//
// File-stub caveat (same as the rest of this module): swap for a DB table in
// production. We cap the collection to the most recent ~1000 rows per store so
// the JSON file doesn't grow without bound.

const MAX_LEADS_PER_STORE = 1000;

/**
 * Insert a new lead row and return its auto-increment id (per-store counter).
 * @param {string} storeHash
 * @param {object} data  { source, customerId, name, email, phone, fields,
 *                         sessionId, agentId, status, disposition, summary, duration }
 * @returns {number} the new lead id
 */
export function insertLead(storeHash, data = {}) {
  const id = (db.leadSeq[storeHash] = (db.leadSeq[storeHash] || 0) + 1);
  // Namespace the lead key by store so per-store counters never collide.
  const key = `${storeHash}:${id}`;
  db.leads[key] = {
    id,
    key,
    storeHash,
    createdAt: new Date().toISOString(),
    source: data.source ?? '',
    customerId: data.customerId ?? null,
    name: data.name ?? '',
    email: data.email ?? '',
    phone: data.phone ?? '',
    fields: data.fields ?? {},
    sessionId: data.sessionId ?? null,
    agentId: data.agentId ?? null,
    status: data.status ?? 'queued',
    disposition: data.disposition ?? '',
    summary: data.summary ?? '',
    duration: data.duration ?? null,
  };
  pruneLeads(storeHash);
  persist();
  return id;
}

/** Patch an existing lead row (shallow merge). No-op if it doesn't exist. */
export function updateLead(storeHash, id, patch = {}) {
  const key = `${storeHash}:${id}`;
  const lead = db.leads[key];
  if (!lead || lead.storeHash !== storeHash) return undefined;
  db.leads[key] = { ...lead, ...patch, updatedAt: new Date().toISOString() };
  persist();
  return db.leads[key];
}

/** @returns {object|undefined} the lead row, or undefined. */
export function getLead(storeHash, id) {
  const lead = db.leads[`${storeHash}:${id}`];
  return lead && lead.storeHash === storeHash ? lead : undefined;
}

/** List a store's leads, newest first, capped to `limit`. */
export function listLeads(storeHash, limit = 100) {
  return Object.values(db.leads)
    .filter((l) => l?.storeHash === storeHash)
    .sort((a, b) => Number(b.id) - Number(a.id))
    .slice(0, limit);
}

/** Erase all lead rows tied to a BigCommerce customer id (privacy erasure). */
export function redactCustomerLeads(storeHash, customerId) {
  if (customerId == null) return 0;
  let removed = 0;
  for (const [key, lead] of Object.entries(db.leads)) {
    if (lead?.storeHash === storeHash && String(lead.customerId) === String(customerId)) {
      delete db.leads[key];
      // Defensively clear the dedupe mark for this customer's lead callback.
      delete db.attempts[`leadCallback:${storeHash}:customer:${customerId}`];
      removed++;
    }
  }
  if (removed) persist();
  return removed;
}

/** Keep only the most recent MAX_LEADS_PER_STORE rows for a store (file-stub bound). */
function pruneLeads(storeHash) {
  const keys = Object.values(db.leads)
    .filter((l) => l?.storeHash === storeHash)
    .sort((a, b) => Number(b.id) - Number(a.id))
    .slice(MAX_LEADS_PER_STORE)
    .map((l) => l.key);
  for (const key of keys) delete db.leads[key];
}
