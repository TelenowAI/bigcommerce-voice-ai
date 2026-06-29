// ─────────────────────────────────────────────────────────────────────────────
// automations/leadCallback.js — Lead callback (speed-to-lead).
//
// Trigger: BigCommerce webhook `store/customer/created`.
// A newly-created customer — storefront signup, checkout account, an import, a
// lead/contact app — IS the lead signal. The moment one appears we:
//   1) store the lead row (so it shows in the dashboard even if we don't call),
//   2) place an instant Telenow AI callback (delay defaults to 0 — speed-to-lead),
//   3) patch the row with the placement result.
//
// The dispatcher hydrates the V3 customer before this runs. The *result* of the
// call comes back on the Telenow webhook (src/webhooks/telenow.js), which resolves
// the lead via the callMap entry's leadId (or by parsing the "lead:<id>"
// identifier) and marks it completed.
// ─────────────────────────────────────────────────────────────────────────────

import { placeCall } from './_base.js';
import { insertLead, updateLead, markAttempt, clearAttempt } from '../store.js';
import { toE164 } from '../util/phone.js';

/** Default country used for E.164 normalization when a number has no country code. */
const DEFAULT_COUNTRY = process.env.DEFAULT_PHONE_COUNTRY || 'IN';

/**
 * Handle a store/customer/created webhook: capture the lead and call them back.
 * @param {string} storeHash
 * @param {object} customer  BigCommerce V3 customer payload (hydrated).
 * @returns {Promise<{ placed: boolean, reason?: string, leadId: number }>}
 */
export async function handleLeadCallback(storeHash, customer) {
  customer = customer || {};

  // Phone can live on the customer or their first address.
  const rawPhone =
    customer.phone || (Array.isArray(customer.addresses) ? customer.addresses[0]?.phone : '') || '';
  const phone = toE164(rawPhone, DEFAULT_COUNTRY);

  const name = [customer.first_name, customer.last_name].filter(Boolean).join(' ');
  const email = customer.email || '';
  const addr = (Array.isArray(customer.addresses) ? customer.addresses[0] : null) || {};

  // Context strings for the agent. All values are strings (Telenow variables).
  const variables = {
    customer_name: name || 'there',
    email,
    source: 'bigcommerce_customer',
    store_name: storeHash || '',
    company: String(customer.company || addr.company || ''),
    customer_group_id: String(customer.customer_group_id ?? ''),
    city: String(addr.city || ''),
  };

  // BigCommerce redelivers store/customer/created on timeout/retry. Each delivery
  // would otherwise mint a fresh leadId, so placeCall's per-identifier dedupe
  // can't catch it → a duplicate lead row AND a duplicate callback. Dedupe on the
  // STABLE customer id here, before we store or call.
  const customerId = customer.id != null ? String(customer.id) : '';
  const dedupeKey = customerId ? `leadCallback:${storeHash}:customer:${customerId}` : '';
  if (dedupeKey && !markAttempt(dedupeKey)) {
    return { placed: false, reason: 'duplicate customer/created — already handled', leadId: 0 };
  }

  // Always store the lead FIRST so it lands in the dashboard regardless of whether
  // the call is placed (no phone, disabled, quiet hours, etc.).
  const leadId = insertLead(storeHash, {
    source: 'bigcommerce_customer',
    customerId: customer.id ?? null,
    name,
    email,
    phone: phone || '',
    fields: variables,
    status: 'queued',
  });

  // No usable phone → nothing to call. Record and bail.
  if (!phone) {
    updateLead(storeHash, leadId, { status: 'skipped', disposition: 'no phone' });
    return { placed: false, reason: 'no phone', leadId };
  }

  try {
    // placeCall extracts a phone from `entity` OR uses `phoneOverride`; we already
    // normalized one, so pass it explicitly. mapExtra.leadId is persisted on the
    // callMap entry so the result webhook can find this lead.
    const result = await placeCall({
      storeHash,
      automation: 'leadCallback',
      entity: customer,
      variables,
      identifier: `lead:${leadId}`,
      mapExtra: { leadId, customerId: customer.id ?? null },
      phoneOverride: phone,
    });

    if (result?.placed) {
      updateLead(storeHash, leadId, { status: 'placed', sessionId: result.sessionId || null });
    } else {
      // Skipped/scheduled/disabled/quiet-hours/dedupe — keep the reason for the UI.
      updateLead(storeHash, leadId, { status: 'skipped', disposition: result?.reason || 'skipped' });
    }
    return { ...result, leadId };
  } catch (err) {
    // Telenow placement threw (network/4xx). Release the dedupe mark so a genuine
    // redelivery can retry, and record the failure on the lead.
    if (dedupeKey) clearAttempt(dedupeKey);
    updateLead(storeHash, leadId, { status: 'failed', disposition: err.message });
    throw err;
  }
}
