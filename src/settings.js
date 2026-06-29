// ─────────────────────────────────────────────────────────────────────────────
// settings.js — per-store settings model.
//
// Each store has one settings object:
//   - telenowApiKey: the merchant's `vai_live_...` key (SECRET — never log it)
//   - automations:   per-use-case config { enabled, agentId, delayMinutes,
//                     quietHours, filters, ... }
//   - winBackDays:   threshold for the win-back scheduled job
//
// Persistence is delegated to store.js (file stub today, DB tomorrow).
// ─────────────────────────────────────────────────────────────────────────────

import { getSettingsRaw, setSettingsRaw } from './store.js';

/**
 * The canonical list of automations the app ships with. Each has a stable key
 * used in the settings UI and the webhook dispatcher. `triggers` is purely
 * documentation of which BigCommerce webhook scopes / cron drive it.
 */
export const AUTOMATIONS = [
  {
    key: 'orderConfirmation',
    label: 'Order confirmation call',
    triggers: ['store/order/created'],
    defaultDelayMinutes: 0,
  },
  {
    key: 'codConfirmation',
    label: 'COD order confirmation / RTO reduction',
    triggers: ['store/order/created (COD only)'],
    defaultDelayMinutes: 5,
  },
  {
    key: 'orderUpdates',
    label: 'Delivery / status updates',
    triggers: ['store/order/statusUpdated'],
    defaultDelayMinutes: 0,
  },
  {
    key: 'leadCallback',
    label: 'Lead callback (new customer)',
    triggers: ['store/customer/created'],
    defaultDelayMinutes: 0,
  },
  {
    key: 'winBack',
    label: 'Win-back / re-engagement',
    triggers: ['scheduled'],
    defaultDelayMinutes: 0,
  },
  {
    key: 'abandonedCart',
    label: 'Abandoned cart recovery',
    triggers: ['store/cart/created', 'store/cart/updated'],
    defaultDelayMinutes: 30,
  },
];

/** Build the default config for a single automation. */
function defaultAutomation(def) {
  return {
    enabled: false,
    agentId: '', // Telenow agent UUID — required when enabled
    delayMinutes: def.defaultDelayMinutes ?? 0,
    // Quiet hours: don't place calls within this local window. 24h "HH:MM".
    quietHours: { enabled: false, start: '21:00', end: '09:00', timezone: 'Asia/Kolkata' },
    // Free-form filters per automation (see each automation module for usage).
    filters: {
      // e.g. minOrderValue, allowedCountries: ['IN'], codMethodsExtra: [],
      // discountCode
    },
  };
}

/** Build a fresh default settings object for a newly-installed store. */
export function defaultSettings(storeHash) {
  const automations = {};
  for (const def of AUTOMATIONS) automations[def.key] = defaultAutomation(def);
  return {
    storeHash,
    telenowApiKey: '',
    winBackDays: 60, // call customers whose last order is older than N days
    automations,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Get a store's settings, filling in any missing automations with defaults so
 * older persisted blobs stay forward-compatible as we add use cases.
 * @param {string} storeHash
 */
export function getSettings(storeHash) {
  const stored = getSettingsRaw(storeHash);
  const base = defaultSettings(storeHash);
  if (!stored) return base;
  // Merge: stored wins, but ensure every known automation key exists.
  const merged = { ...base, ...stored };
  merged.automations = { ...base.automations, ...(stored.automations || {}) };
  for (const def of AUTOMATIONS) {
    merged.automations[def.key] = {
      ...defaultAutomation(def),
      ...(merged.automations[def.key] || {}),
    };
  }
  return merged;
}

/** Convenience: config for one automation. */
export function getAutomation(storeHash, key) {
  return getSettings(storeHash).automations[key];
}

/**
 * Persist a settings update (shallow-merged onto current). Pass only the fields
 * you want to change. Returns the full, merged settings.
 * @param {string} storeHash
 * @param {Partial<ReturnType<typeof defaultSettings>>} patch
 */
export function updateSettings(storeHash, patch = {}) {
  const current = getSettings(storeHash);
  const next = {
    ...current,
    ...patch,
    automations: { ...current.automations },
    updatedAt: new Date().toISOString(),
  };
  // Deep-merge automations if provided.
  if (patch.automations) {
    for (const [key, cfg] of Object.entries(patch.automations)) {
      next.automations[key] = { ...current.automations[key], ...cfg };
    }
  }
  setSettingsRaw(storeHash, next);
  return next;
}

/**
 * Settings safe to send to the browser settings UI: the API key is masked so we
 * never ship the raw secret to the client.
 */
export function getRedactedSettings(storeHash) {
  const s = getSettings(storeHash);
  return {
    ...s,
    telenowApiKey: maskKey(s.telenowApiKey),
    telenowApiKeySet: Boolean(s.telenowApiKey),
  };
}

/** "vai_live_abcd…wxyz" → show only a hint, never the full secret. */
export function maskKey(key) {
  if (!key) return '';
  if (key.length <= 12) return '••••';
  return `${key.slice(0, 9)}…${key.slice(-4)}`;
}
