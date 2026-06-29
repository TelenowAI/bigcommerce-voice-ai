// ─────────────────────────────────────────────────────────────────────────────
// automations/abandonedCart.js — Abandoned cart recovery.
//
// Triggers: BigCommerce webhooks `store/cart/created` and `store/cart/updated`.
//
// BigCommerce has NO first-class "cart abandoned" webhook (cart/updated fires on
// every edit). The pattern we use: on a cart event, schedule a delayed call
// (cfg.delayMinutes, default 30). Right before firing we re-check that the cart
// still exists (not converted/deleted) and grab the recovery URL — if the cart is
// gone, it (almost certainly) converted or was cleared, so we skip.
//
// Dedupe is on the STABLE cart id, so the many cart/updated deliveries for one
// cart schedule at most one call within the TTL.
//
// LIMITATIONS / TODO:
//   - A guest cart often has no phone until checkout starts; such carts are
//     skipped (no number to dial). For best results pair this with a checkout/
//     started signal or read the phone from an attached customer.
//   - The "still abandoned?" check uses GET /v3/carts/{id}; for stronger signals,
//     also cross-check the Abandoned Cart API / orders created from the cart.
//   - Durable scheduling: the delay uses setTimeout (see _base.js) — swap for a
//     job queue in production so it survives restarts.
// ─────────────────────────────────────────────────────────────────────────────

import { getAutomation } from '../settings.js';
import { adminRequest } from '../bigcommerce.js';
import { placeCall, formatMoney, summarizeLineItems } from './_base.js';

/**
 * Handle a store/cart/created|updated webhook.
 * @param {string} storeHash
 * @param {string} cartId   the cart id from the webhook (data.id)
 * @param {object} [_payload]
 */
export async function handleAbandonedCart(storeHash, cartId, _payload) {
  if (!cartId) return { placed: false, reason: 'no cart id' };

  const cfg = getAutomation(storeHash, 'abandonedCart');
  if (!cfg?.enabled) return { placed: false, reason: 'automation "abandonedCart" disabled' };

  const cart = await getCart(storeHash, cartId);
  if (!cart) return { placed: false, reason: 'cart not found (already converted/cleared)' };

  // A cart with no line items is nothing to recover.
  const items = lineItemsOf(cart);
  if (items.length === 0) return { placed: false, reason: 'empty cart' };

  // Find a phone: a registered customer's profile, else any address on the cart.
  const phone = await cartPhone(storeHash, cart);
  if (!phone) return { placed: false, reason: 'no phone on cart (guest, pre-checkout)' };

  const recoveryUrl = cart?.redirect_urls?.checkout_url || cart?.checkout_url || '';

  const variables = {
    customer_name: 'there', // carts rarely carry a name pre-checkout
    cart_items: summarizeLineItems(items),
    cart_total: formatMoney(cart.cart_amount ?? cart.base_amount, cart.currency?.code),
    currency: cart.currency?.code || '',
    recovery_url: recoveryUrl,
    store_name: storeHash || '',
    discount_code: cfg?.filters?.discountCode || '',
  };

  return placeCall({
    storeHash,
    automation: 'abandonedCart',
    entity: cart,
    variables,
    identifier: `cart:${cartId}`,
    phoneOverride: phone,
    mapExtra: {
      cartId,
      // Re-check right before the (delayed) call fires: only call if still abandoned.
      shouldStillCall: () => stillAbandoned(storeHash, cartId),
    },
  });
}

/** GET a cart via the V3 Carts API. Returns the cart object or null. */
async function getCart(storeHash, cartId) {
  try {
    const data = await adminRequest(
      storeHash,
      'GET',
      `/v3/carts/${encodeURIComponent(cartId)}?include=redirect_urls`,
    );
    return data?.data || null;
  } catch {
    // 404 → cart gone (converted/cleared). Any error → treat as not-found.
    return null;
  }
}

/** Pull line items from a V3 cart (physical + digital). */
function lineItemsOf(cart) {
  const li = cart?.line_items || {};
  return [...(li.physical_items || []), ...(li.digital_items || [])];
}

/**
 * Best-effort phone for a cart. If the cart belongs to a registered customer,
 * read the customer's phone; otherwise we have nothing reliable pre-checkout.
 */
async function cartPhone(storeHash, cart) {
  const { extractPhone } = await import('../util/phone.js');
  const country = process.env.DEFAULT_PHONE_COUNTRY || 'IN';
  // Some cart shapes embed an email/customer; try the customer profile if present.
  const customerId = cart?.customer_id;
  if (customerId) {
    try {
      const { getCustomer } = await import('../bigcommerce.js');
      const customer = await getCustomer(storeHash, customerId);
      const p = extractPhone(customer, country);
      if (p) return p;
    } catch {
      /* fall through */
    }
  }
  return extractPhone(cart, country);
}

/** Re-check (at fire time) that the cart still exists → still abandoned. */
async function stillAbandoned(storeHash, cartId) {
  const cart = await getCart(storeHash, cartId);
  return Boolean(cart && lineItemsOf(cart).length > 0);
}
