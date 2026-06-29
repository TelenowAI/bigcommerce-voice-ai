// ─────────────────────────────────────────────────────────────────────────────
// auth.js — BigCommerce single-click app lifecycle callbacks.
//
// BigCommerce calls these (all GET) over the lifetime of the install:
//   GET /auth         → install: ?code&scope&context → exchange for access token,
//                       persist the store, register BigCommerce webhooks, and (if
//                       a Telenow key is already set) subscribe the Telenow hook.
//                       Then render/redirect into the app UI.
//   GET /load         → open the app: ?signed_payload_jwt → verify → /app.
//   GET /uninstall    → merchant removed the app: verify → purge store data +
//                       remove BigCommerce + Telenow hooks.
//   GET /remove-user  → a user lost access (multi-user store): verify → log
//                       (single-tenant data model has nothing per-user to remove).
//
// All of load/uninstall/remove-user are authenticated by verifying the
// signed_payload_jwt with the app client secret (see bigcommerce.js).
// ─────────────────────────────────────────────────────────────────────────────

import express from 'express';

import {
  HOST,
  exchangeCode,
  storeHashFromContext,
  verifyCallbackSignature,
} from './bigcommerce.js';
import { saveStore, deleteStore, getStore } from './store.js';
import { mintSessionToken } from './session.js';
import { getSettings } from './settings.js';
import { ensureTelenowHook, removeTelenowHook } from './webhooks/telenow.js';
import { ensureBigCommerceWebhooks, removeBigCommerceWebhooks } from './webhooks/bigcommerce.js';

export const authRouter = express.Router();

// ── Install (OAuth callback) ──────────────────────────────────────────────────
// BigCommerce redirects the merchant here with ?code&scope&context after they
// click "Install" / "Confirm" in the control panel.
authRouter.get('/auth', async (req, res) => {
  const { code, scope, context } = req.query;
  if (!code || !context) {
    res.status(400).send('Missing OAuth code/context. Install from the BigCommerce control panel.');
    return;
  }

  try {
    const token = await exchangeCode({
      code: String(code),
      scope: String(scope || ''),
      context: String(context),
    });

    const storeHash = storeHashFromContext(token.context);
    if (!storeHash) {
      res.status(400).send('OAuth: could not resolve store hash from context');
      return;
    }

    // Persist the store. saveStore mints a webhookToken on first install.
    saveStore(storeHash, {
      accessToken: token.access_token,
      scope: token.scope,
      context: token.context,
      ownerEmail: token.owner?.email,
      userId: token.user?.id,
    });

    // Register BigCommerce webhooks for this store (idempotent).
    try {
      await ensureBigCommerceWebhooks(storeHash);
    } catch (err) {
      console.error(`[auth] webhook registration error for ${storeHash}:`, err.message);
    }

    // Subscribe Telenow result webhooks if a key is already set (usually set later
    // in /app — ensureTelenowHook is also called from the settings save path).
    try {
      const settings = getSettings(storeHash);
      if (settings.telenowApiKey) await ensureTelenowHook(storeHash);
    } catch (err) {
      console.error(`[auth] Telenow hook setup skipped for ${storeHash}:`, err.message);
    }

    console.log(`[auth] installed for store ${storeHash}`);
    res.redirect(`/app?storeHash=${encodeURIComponent(storeHash)}`);
  } catch (err) {
    console.error('[auth] OAuth install failed:', err.message);
    res.status(500).send(`OAuth failed: ${err.message}`);
  }
});

// ── Load (open the app UI from the control panel) ─────────────────────────────
authRouter.get('/load', (req, res) => {
  try {
    const { storeHash } = verifyCallbackSignature(req.query);
    if (!storeHash) {
      res.status(400).send('load: could not resolve store hash');
      return;
    }
    if (!getStore(storeHash)) {
      // Installed in BigCommerce but we have no token (e.g. data reset) — ask them
      // to reinstall via the control panel.
      res.status(409).send('App not fully installed for this store. Please reinstall.');
      return;
    }
    // Mint a signed session token (this is the VERIFIED entry point) and hand it to
    // the UI via the URL FRAGMENT so it never lands in query strings / logs. The
    // UI sends it back as `Authorization: Bearer <t>` on every /api/* call.
    const token = mintSessionToken(storeHash);
    res.redirect(`/app?storeHash=${encodeURIComponent(storeHash)}#t=${encodeURIComponent(token)}`);
  } catch (err) {
    console.error('[auth] load verification failed:', err.message);
    res.status(401).send(`Invalid load request: ${err.message}`);
  }
});

// ── Uninstall ─────────────────────────────────────────────────────────────────
authRouter.get('/uninstall', async (req, res) => {
  try {
    const { storeHash } = verifyCallbackSignature(req.query);
    if (!storeHash) {
      res.status(400).send('uninstall: could not resolve store hash');
      return;
    }
    console.log(`[auth] uninstall for store ${storeHash} — cleaning up`);
    // Best-effort external cleanup BEFORE we drop the local token (both calls need
    // the access token + Telenow key, which deleteStore would erase).
    try {
      await removeBigCommerceWebhooks(storeHash);
    } catch (err) {
      console.error(`[auth] BC webhook cleanup failed for ${storeHash}:`, err.message);
    }
    try {
      await removeTelenowHook(storeHash);
    } catch (err) {
      console.error(`[auth] Telenow hook cleanup failed for ${storeHash}:`, err.message);
    }
    deleteStore(storeHash); // purges store/settings/hooks/callMap/attempts/leads (PII)
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[auth] uninstall verification failed:', err.message);
    res.status(401).send(`Invalid uninstall request: ${err.message}`);
  }
});

// ── Remove user (multi-user stores) ───────────────────────────────────────────
authRouter.get('/remove-user', (req, res) => {
  try {
    const { storeHash, user } = verifyCallbackSignature(req.query);
    // Our data model is per-store (single-tenant), so there's no per-user data to
    // remove. Acknowledge so BigCommerce stops retrying. If you later store
    // per-user prefs, delete them here.
    console.log(`[auth] remove-user for store ${storeHash} user=${user?.email || user?.id || '?'}`);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[auth] remove-user verification failed:', err.message);
    res.status(401).send(`Invalid remove-user request: ${err.message}`);
  }
});

/**
 * Tiny landing helper for "/". The single-click install starts from the
 * BigCommerce control panel (which calls /auth), so there's nothing to do here
 * but show a hint.
 */
export function rootHandler(_req, res) {
  res
    .status(200)
    .type('html')
    .send(
      `<h1>Telenow for BigCommerce</h1>
       <p>Install this app from the BigCommerce control panel (Apps). BigCommerce
          will call <code>${HOST}/auth</code> to complete the install.</p>
       <p>Already installed? Open it from your store's Apps menu, or visit the
          <a href="/app">settings page</a> (add <code>?storeHash=</code>).</p>`,
    );
}
