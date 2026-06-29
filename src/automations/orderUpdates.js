// ─────────────────────────────────────────────────────────────────────────────
// automations/orderUpdates.js — order confirmation & delivery/status updates.
//
// Triggers:
//   - store/order/created        → "orderConfirmation" call (thank-you / confirm)
//   - store/order/statusUpdated  → "orderUpdates" call (read out the new status,
//                                  e.g. Shipped / Awaiting Pickup / Completed)
//
// The full V2 order is hydrated by the webhook dispatcher before these run. Note
// that V2 line items live at /v2/orders/{id}/products (not inline); if the caller
// hasn't attached them we still place the call with the fields we have.
//
// The *result* of each call comes back on the Telenow webhook and is handled in
// src/webhooks/telenow.js (a generic outcome note + a telenow_last_call metafield).
// ─────────────────────────────────────────────────────────────────────────────

import { placeCall, formatMoney, summarizeLineItems, firstName } from './_base.js';

/**
 * store/order/created → plain order confirmation call (separate from COD
 * confirmation; both are independently toggleable, enable only one if you don't
 * want two calls on a COD order).
 * @param {string} storeHash @param {object} order  hydrated V2 order
 */
export async function handleOrderConfirmation(storeHash, order) {
  const variables = {
    customer_name: firstName(order),
    order_number: String(order.id),
    order_items: summarizeLineItems(order.products),
    order_total: formatMoney(order.total_inc_tax, order.currency_code),
    currency: order.currency_code || '',
    order_status: order.status || '',
    store_name: storeName(order, storeHash),
  };

  return placeCall({
    storeHash,
    automation: 'orderConfirmation',
    entity: order,
    variables,
    identifier: `order:${order.id}`,
    mapExtra: { orderId: order.id },
  });
}

/**
 * store/order/statusUpdated → delivery / status update call. BigCommerce sends
 * this whenever an order's status changes (e.g. Shipped, Partially Shipped,
 * Awaiting Pickup, Completed, Cancelled). We read out the new status; merchants
 * can restrict which statuses trigger a call via filters.statuses.
 * @param {string} storeHash @param {object} order  hydrated V2 order
 * @param {object} [payload]  the raw webhook (may carry status ids in data.status)
 */
export async function handleOrderStatusUpdate(storeHash, order, _payload) {
  const status = order.status || '';

  const variables = {
    customer_name: firstName(order),
    order_number: String(order.id),
    order_status: status,
    order_items: summarizeLineItems(order.products),
    order_total: formatMoney(order.total_inc_tax, order.currency_code),
    currency: order.currency_code || '',
    store_name: storeName(order, storeHash),
  };

  return placeCall({
    storeHash,
    automation: 'orderUpdates',
    entity: order,
    variables,
    // Include the status in the identifier so a genuine *new* status change isn't
    // blocked by the dedupe mark from a previous status on the same order.
    identifier: `order:${order.id}:${slug(status)}`,
    mapExtra: { orderId: order.id, status },
  });
}

/** Prefer a human store name if BigCommerce attached one; else the store hash. */
function storeName(order, storeHash) {
  return order?.store_name || storeHash || '';
}

/** Lowercase, hyphenate a status for use in a dedupe identifier. */
function slug(s) {
  return String(s || 'status')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
