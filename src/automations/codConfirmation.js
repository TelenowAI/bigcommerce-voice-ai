// ─────────────────────────────────────────────────────────────────────────────
// automations/codConfirmation.js — COD confirmation / RTO reduction.
//
// Trigger: BigCommerce webhook `store/order/created`.
// If the order is Cash-on-Delivery (and therefore at risk of return-to-origin),
// call the customer to confirm BEFORE fulfillment.
//
// The *result* of the call comes back on the Telenow webhook and is handled in
// src/webhooks/telenow.js, which writes back onto the order:
//   confirmed  → staff note + metafield telenow_cod = "confirmed"
//   cancelled  → staff note + metafield telenow_cod = "cancelled"   (no auto-cancel)
//   unknown    → staff note + metafield telenow_cod = "no-response"
// ─────────────────────────────────────────────────────────────────────────────

import { getAutomation } from '../settings.js';
import { placeCall, formatMoney, summarizeLineItems, firstName } from './_base.js';

/**
 * Heuristic COD detection across the ways BigCommerce can express it. The V2
 * order carries `payment_method` (free-text, e.g. "Cash on Delivery", "Manual")
 * and `payment_provider_id`. Merchants can add extra method substrings via
 * filters.codMethodsExtra. Case-insensitive match on "cash on delivery"/"cod".
 * @param {object} order
 * @param {string[]} [extraMethods]
 * @returns {boolean}
 */
export function isCodOrder(order, extraMethods = []) {
  if (!order) return false;

  const needles = ['cash on delivery', 'cod', 'cash_on_delivery', ...extraMethods]
    .map((s) => String(s).toLowerCase())
    .filter(Boolean);

  const haystacks = [order.payment_method, order.payment_provider_id]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase());

  const methodMatch = haystacks.some((h) => needles.some((n) => h.includes(n)));

  // COD/manual orders are typically not captured at creation. A "Manual" method
  // with no online capture is a secondary signal.
  const manual = haystacks.some((h) => h.includes('manual') || h.includes('cash'));
  const pending = ['pending', 'awaiting payment', 'awaiting fulfillment'].includes(
    String(order.status || '').toLowerCase(),
  );

  return methodMatch || (manual && pending);
}

/**
 * Handle a store/order/created webhook for COD confirmation.
 * @param {string} storeHash @param {object} order  hydrated V2 order
 */
export async function handleCodConfirmation(storeHash, order) {
  const cfg = getAutomation(storeHash, 'codConfirmation');
  const extraMethods = cfg?.filters?.codMethodsExtra || [];

  if (!isCodOrder(order, extraMethods)) {
    return { placed: false, reason: 'not a COD order' };
  }

  // Optional minimum-order-value filter (skip tiny COD orders if configured).
  const minValue = Number(cfg?.filters?.minOrderValue) || 0;
  if (minValue > 0 && Number(order.total_inc_tax) < minValue) {
    return { placed: false, reason: `below minOrderValue ${minValue}` };
  }

  const variables = {
    customer_name: firstName(order),
    order_number: String(order.id),
    order_items: summarizeLineItems(order.products),
    order_total: formatMoney(order.total_inc_tax, order.currency_code),
    currency: order.currency_code || '',
    payment_method: 'Cash on Delivery',
    shipping_city: order.billing_address?.city || '',
    store_name: order?.store_name || storeHash || '',
  };

  return placeCall({
    storeHash,
    automation: 'codConfirmation',
    entity: order,
    variables,
    identifier: `order:${order.id}`,
    mapExtra: { orderId: order.id },
  });
}
