// ─────────────────────────────────────────────────────────────────────────────
// automations/winBack.js — win-back / re-engagement (scheduled).
//
// A periodic sweep finds customers whose most recent order is older than
// `settings.winBackDays` and calls them with an optional win-back discount.
//
// Scheduling: src/server.js starts this on an interval (a setInterval stub).
// TODO (durable scheduling): swap setInterval for a real scheduler (node-cron /
// a job queue) with a leader lock so it survives restarts and doesn't double-run
// across instances.
//
// SCALE NOTE: BigCommerce's V3 customers endpoint doesn't expose "last order
// date", so we page customers and fetch each one's most recent V2 order to date
// it. This is best-effort and fine for small/medium stores; for large catalogs,
// maintain a `last_order_at` index in your DB (updated from store/order/created)
// and query that instead.
// ─────────────────────────────────────────────────────────────────────────────

import { listStores, getStore, getCall, mapCall } from '../store.js';
import { getSettings, getAutomation } from '../settings.js';
import { listCustomers, listCustomerOrders } from '../bigcommerce.js';
import { placeCall, formatMoney } from './_base.js';

/** Max customers to scan per store per sweep (file-stub safety bound). */
const MAX_CUSTOMERS_PER_SWEEP = 50;

/** Run a win-back sweep across all installed stores. Called by the scheduler. */
export async function runWinBackSweep() {
  for (const { storeHash } of listStores()) {
    try {
      const cfg = getAutomation(storeHash, 'winBack');
      if (!cfg?.enabled || !cfg.agentId) continue;
      await sweepStore(storeHash);
    } catch (err) {
      console.error(`[winBack] sweep failed for ${storeHash}:`, err.message);
    }
  }
}

/** Sweep a single store for lapsed customers and place win-back calls. */
async function sweepStore(storeHash) {
  const session = getStore(storeHash);
  if (!session?.accessToken) return;

  const settings = getSettings(storeHash);
  const days = Number(settings.winBackDays) || 60;
  const cfg = settings.automations.winBack;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  let customers = [];
  try {
    customers = await listCustomers(storeHash, { limit: MAX_CUSTOMERS_PER_SWEEP, page: 1 });
  } catch (err) {
    console.error(`[winBack] list customers failed for ${storeHash}:`, err.message);
    return;
  }

  for (const c of customers) {
    // Find the customer's most recent order to date them.
    let lastOrder = null;
    try {
      lastOrder = (await listCustomerOrders(storeHash, c.id))[0] || null;
    } catch {
      lastOrder = null;
    }
    if (!lastOrder?.date_created) continue; // never ordered → not a win-back target
    const lastOrderAtMs = new Date(lastOrder.date_created).getTime();
    if (!(lastOrderAtMs < cutoff)) continue; // ordered recently → skip

    // Dedupe: don't win-back the same customer more than once per `days` window.
    const dedupeKey = `winback:${storeHash}:${c.id}`;
    const prev = getCall(dedupeKey);
    if (prev && new Date(prev.createdAt).getTime() > Date.now() - days * 24 * 60 * 60 * 1000) {
      continue;
    }

    const variables = {
      customer_name: c.first_name || 'there',
      days_since_last_order: String(daysSinceMs(lastOrderAtMs)),
      store_name: storeHash || '',
      discount_code: cfg?.filters?.discountCode || '',
      last_order_total: formatMoney(lastOrder.total_inc_tax, lastOrder.currency_code),
    };

    const res = await placeCall({
      storeHash,
      automation: 'winBack',
      entity: c, // extractPhone() reads c.phone / addresses[0].phone
      variables,
      identifier: `customer:${c.id}`,
      mapExtra: { customerId: c.id },
    });

    // Mark as attempted (even if scheduled/skipped for quiet hours) to avoid
    // hammering the same customer every tick.
    if (res.placed || res.reason === 'within quiet hours') {
      mapCall(dedupeKey, { storeHash, automation: 'winBack', customerId: c.id });
    }
  }
}

function daysSinceMs(ms) {
  if (!ms) return '';
  return Math.max(0, Math.floor((Date.now() - ms) / (24 * 60 * 60 * 1000)));
}
