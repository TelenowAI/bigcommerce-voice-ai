# BigCommerce Voice AI — AI Voice Agent for BigCommerce | Telenow

**Turn BigCommerce store events into automated, natural-sounding AI phone calls — and write every call outcome back onto the order.**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Platform: BigCommerce](https://img.shields.io/badge/Platform-BigCommerce-34313F.svg)](https://www.bigcommerce.com/)
[![Node](https://img.shields.io/badge/Node->=18-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Powered by Telenow](https://img.shields.io/badge/Powered_by-Telenow-6C47FF.svg)](https://telenow.ai)

**BigCommerce Voice AI** is a free, open-source BigCommerce app that connects your store to [Telenow](https://telenow.ai) — a voice-AI service that places automated outbound phone calls to your shoppers. Install it once and an **AI voice agent** calls the right customer at the right moment for **abandoned cart recovery**, **COD confirmation** and **RTO reduction**, **order confirmation calls**, **delivery updates**, **failed-delivery retry**, **win-back**, and instant **lead callback** — in English, Hindi, and other Indian and global languages — then records the result straight onto the order as a staff note and metafield. The app itself is free; it talks to your own Telenow account using a `vai_live_…` API key, and Telenow bills call usage on its own platform (no charges run through BigCommerce). The benefit is simple: store events become AI phone calls, and the call outcome is written back where your team already works.

## Table of Contents

- [✨ Features](#-features)
- [🚀 Installation](#-installation)
- [⚙️ Configuration](#️-configuration)
- [🧩 How it works](#-how-it-works)
- [🔐 OAuth & install flow](#-oauth--install-flow)
- [🤖 Automations & write-back](#-automations--the-data-written-back)
- [📥 Telenow webhooks (inbound)](#-telenow-webhooks-inbound)
- [🛡️ Security notes](#️-security-notes)
- [🛒 Abandoned cart — limitations](#-abandoned-cart--limitations)
- [✅ Production checklist](#-production-checklist)
- [🧪 Local round-trip test](#-local-round-trip-test)
- [📂 Project layout](#-project-layout)
- [📞 About Telenow](#-about-telenow)
- [📄 License](#-license)

## ✨ Features

Every automation is independently toggleable, with its own Telenow agent, delay, quiet-hours window, and filters.

- **🛒 Abandoned cart recovery** — when a shopper leaves items behind (`store/cart/created` / `store/cart/updated`), the AI voice agent waits a configurable delay, re-checks that the cart still exists, and calls with the recovery link back to checkout — a higher-touch nudge than yet another email.
- **💰 COD confirmation & RTO reduction** — the moment a Cash-on-Delivery order arrives (`store/order/created`), the AI calls the buyer to confirm the order and address *before* you ship, cutting return-to-origin (RTO) losses and fake/abandoned COD orders. The outcome — `confirmed` / `cancelled` / `no-response` — is written to a staff note and a `telenow.telenow_cod` order metafield.
- **📦 Order confirmation calls** — a thank-you / confirm-details call on every new order (`store/order/created`).
- **🚚 Delivery & shipping updates** — reads out each new order status (Shipped, Awaiting Pickup, Completed…) on `store/order/statusUpdated`, so the AI can answer "where is my order?".
- **🔁 Failed-delivery / NDR retry** — because delivery calls ride on order-status changes, a failed or refused delivery status triggers a follow-up call to re-arrange delivery.
- **🔄 Win-back & re-engagement** — a scheduled sweep finds customers whose last order is older than *N* days and calls them back, with an optional discount code.
- **⚡ Lead callback (speed-to-lead)** — every new customer (`store/customer/created`) triggers an instant AI callback and lands in the in-app **Recent leads** dashboard.
- **⭐ Reviews, feedback & NPS by voice** — point any automation (typically delivery/post-purchase) at a Telenow agent scripted to collect review, feedback, or NPS responses by phone.
- **🗣️ Two-way live Q&A** — during a call the Telenow agent can answer shopper questions using the live order, product, and customer context the app passes in.
- **📝 Order write-back** — every call appends an order **staff note** plus a `telenow.last_call` order **metafield** (session id, status, disposition, duration); COD additionally writes `telenow.telenow_cod`. Lead calls patch the lead row instead.
- **🌐 Multilingual & Hindi voice agent** — calls use the Telenow agents you've already built — your script, your voice, English / Hindi / other Indian and global languages.
- **🌙 Quiet hours** — per-automation, timezone-aware quiet-hours windows suppress calls (and re-check at fire time for delayed calls).
- **🎛️ Per-automation config** — independent enable/disable, agent id, delay, quiet hours, and filters (min order value, extra COD method names, discount code, allowed statuses) for every use case.

Built on **Node.js 18+** (global `fetch`), **Express**, and `dotenv`, with no heavy dependencies and no database required (a file-based store stub you swap out in production).

## 🚀 Installation

```bash
git clone https://github.com/TelenowAI/bigcommerce-voice-ai.git
cd bigcommerce-voice-ai
npm install
cp .env.example .env      # fill in the values below
npm start                 # or: npm run dev  (node --watch)
```

You need a public HTTPS URL (BigCommerce and Telenow both call you). In dev, use a tunnel:

```bash
ngrok http 3000           # then set HOST=https://<id>.ngrok-free.app in .env
```

## ⚙️ Configuration

Configure the app with environment variables in `.env`:

| Var | Required | Description |
| --- | --- | --- |
| `HOST` | ✅ | Public HTTPS base URL of this app (no trailing slash). Builds the OAuth/load/uninstall callbacks, the BigCommerce webhook destination, and the Telenow webhook target. |
| `PORT` | | Listen port (default `3000`). |
| `BIGCOMMERCE_CLIENT_ID` / `BIGCOMMERCE_CLIENT_SECRET` | ✅ | From your app in the BigCommerce Developer Portal (My Apps → View Client ID). |
| `BIGCOMMERCE_AUTH_CALLBACK` | | OAuth `redirect_uri` sent to the token endpoint. Defaults to `<HOST>/auth`; must EXACTLY match the app's Auth Callback URL. |
| `TELENOW_API_BASE` | | Telenow API base (default `https://api.telenow.ai`). |
| `DATA_DIR` | | Where the file store persists (default `./data`). |
| `DEFAULT_PHONE_COUNTRY` | | ISO-2 country for E.164 normalization of local numbers (default `IN`). |
| `SWEEP_INTERVAL_MS` / `SWEEP_RUN_ON_BOOT` | | Win-back sweep cadence (default 6h) / run once at boot for testing. |

> The **Telenow API key is not an env var** — each merchant pastes their own `vai_live_…` key in the settings page (`/app`), where it is stored per store and validated via `GET /api/v1/me`.

### BigCommerce app callback URLs (Developer Portal → Technical)

| Field | Value |
| --- | --- |
| Auth Callback URL | `<HOST>/auth` |
| Load Callback URL | `<HOST>/load` |
| Uninstall Callback URL | `<HOST>/uninstall` |
| Remove User Callback URL | `<HOST>/remove-user` |

Scopes required: **Orders** (read/modify), **Customers** (read-only), **Products** (read-only), **Carts** (read-only), and **Information & Settings / Webhooks** (modify) so the app can create webhooks and write order notes/metafields.

## 🧩 How it works

```
BigCommerce store ──webhook(shared token)──▶  this app  ──POST /api/sessions/initiate-call──▶  Telenow
       ▲                                        │   ▲                                              │
       └──Admin API (staff notes/metafields)────┘   └──────POST /telenow/webhook (HMAC) ◀──────────┘
                                                            (call.ended / call.analyzed)
```

A BigCommerce store event fires a webhook to this app; the app builds the agent context and asks Telenow to place the call; when the call ends, Telenow posts the signed result back, and the app writes the outcome onto the order (or lead row).

## 🔐 OAuth & install flow

1. The merchant clicks **Install** in the BigCommerce control panel. BigCommerce redirects to `<HOST>/auth?code=…&scope=…&context=stores/<hash>`.
2. The app **exchanges the code** for a permanent access token at `https://login.bigcommerce.com/oauth2/token` (client id/secret + `redirect_uri`), receiving `{ access_token, context }`. It derives the **store hash** from `context` and persists `{ storeHash, accessToken }`. A random per-store **webhook token** is minted at this point.
3. The app **registers BigCommerce webhooks** (`POST /v3/hooks`) for `store/order/created`, `store/order/statusUpdated`, `store/customer/created`, `store/cart/created`, `store/cart/updated`, each with `headers: { "X-Telenow-Token": "<store token>" }`. If a Telenow key is already set it also **subscribes the Telenow result webhook**.
4. **`/load`** (opened from the control panel), **`/uninstall`**, and **`/remove-user`** are authenticated by verifying the `signed_payload_jwt` BigCommerce sends (HS256 with the app client secret; legacy `signed_payload` HMAC is also accepted). `/uninstall` removes both webhook sets and purges all local data (including leads — PII).
5. In `/app` the merchant pastes their Telenow API key (validated via `GET /api/v1/me`), picks an **agent ID** per automation, toggles automations, and sets delays/quiet-hours. Saving a new key (re)subscribes the Telenow webhook via `POST /api/v1/hooks`.

## 🤖 Automations & the data written back

Each automation builds a `variables` object and calls `POST /api/sessions/initiate-call` (note: **not** `/api/v1`) with the agent, the E.164 number, an `identifier` (e.g. `order:12345`), and `machineDetection: "hangup"`. The response is **enveloped** (`{ success, data: { sessionId } }`); we read `data.sessionId` and persist `sessionId → entity` so the result webhook can find it.

| Automation | BigCommerce trigger | Variables passed to the agent | Write-back on result |
| --- | --- | --- | --- |
| Order confirmation | `store/order/created` | `customer_name, order_number, order_items, order_total, currency, order_status` | staff note + `telenow.last_call` |
| COD confirmation | `store/order/created` (COD only) | `customer_name, order_number, order_items, order_total, payment_method, shipping_city` | staff note + `telenow.telenow_cod` = `confirmed`/`cancelled`/`no-response` + `telenow.last_call` |
| Delivery / status updates | `store/order/statusUpdated` | `customer_name, order_number, order_status, order_items, order_total` | staff note + `telenow.last_call` |
| Lead callback | `store/customer/created` | `customer_name, email, source, company, city` | lead row patched (status, disposition, summary, duration) |
| Win-back | scheduled | `customer_name, days_since_last_order, discount_code?, last_order_total` | staff note + `telenow.last_call` (order id when known) |
| Abandoned cart | `store/cart/created\|updated` | `cart_items, cart_total, currency, recovery_url, discount_code?` | logged (usually no order yet) |

> **COD cancelled does NOT auto-cancel the order** — we only write a note + metafield so the merchant reviews first. There's a clearly-marked `TODO` in `src/webhooks/telenow.js` to optionally `PUT /v2/orders/{id}` with the Cancelled status.

### How COD is detected

The V2 order's `payment_method` (free-text, e.g. "Cash on Delivery", "Manual") and `payment_provider_id` are matched case-insensitively against `cash on delivery` / `cod` (extend via `filters.codMethodsExtra`); a "Manual"/cash method on an unpaid order is a secondary signal. See `isCodOrder()` in `src/automations/codConfirmation.js`.

### How leads & COD results map back

The Telenow result webhook carries the `identifier` we sent and we also persist `sessionId → { storeHash, orderId | leadId, automation }`. On a result we **resolve the lead branch first** (`call.leadId` or an `identifier` of `lead:<id>`) and patch the lead row; only if it is not a lead do we resolve the order (`order:<id>`) and write the staff note + metafields. COD outcome is read from `analysis.disposition` (with a summary/transcript keyword fallback) → `confirmed` / `cancelled` / `unknown`.

## 📥 Telenow webhooks (inbound)

We subscribe with `POST /api/v1/hooks` (`events: ["call.ended","call.analyzed"]`, `source: "bigcommerce"`, `includeTranscript: true`) and store the returned signing **secret** per store (`signing_secret ?? secret`, returned **only** at creation). Telenow then POSTs results to `<HOST>/telenow/webhook` with:

```
X-VoiceAI-Signature: sha256=<hex HMAC-SHA256 of the raw body>
X-VoiceAI-Event:     call.ended | call.analyzed
X-VoiceAI-Delivery:  <uuid>
```

We verify by recomputing the HMAC over the **raw body** with that secret as **hex** (base64 fallback), constant-time, then resolve the entity and write back.

## 🛡️ Security notes

- **Two inbound verification paths.** Telenow webhooks are HMAC-verified (hex) against the per-hook signing secret. BigCommerce does **not** HMAC-sign, so we put a random per-store token in each webhook's `headers` and BigCommerce echoes it back — we verify it constant-time (`X-Telenow-Token`). Bad signatures/tokens get `401`. The Telenow route receives the **raw body** (mounted before the JSON parser) so the bytes match exactly.
- **Signed JWT on lifecycle callbacks.** `/load`, `/uninstall`, `/remove-user` verify BigCommerce's `signed_payload_jwt` (HS256 with the client secret) including `exp`/`nbf`/`aud`.
- **E.164 normalization.** Phone numbers from BigCommerce are normalized to E.164 before dialing (`src/util/phone.js`); un-normalizable numbers are skipped, never dialed.
- **Never log secrets.** The Telenow `X-API-Key`, the BigCommerce access token, the client secret, and the per-store webhook token are never logged or sent to the browser — the settings page only ever sees a masked key hint. Phone numbers are masked in logs and in the leads UI.
- **Dedupe on stable platform ids.** Calls dedupe on the BigCommerce **order id / customer id / cart id** (atomic check-and-set), not a freshly-generated local id, so webhook redeliveries don't double-call. The mark is released on placement failure so a genuine retry can proceed.
- **Quiet hours.** Calls are suppressed inside each automation's local quiet-hours window (and re-checked at fire time for delayed calls).
- **Leads hold PII.** New-customer leads (name/email/phone) are stored for the dashboard. `deleteStore()` purges everything for a store (stores/settings/hooks/callMap/attempts/leads) on uninstall; `redactCustomerLeads()` erases a single customer's lead rows.

## 🛒 Abandoned cart — limitations

BigCommerce has **no first-class "cart abandoned" webhook** (`store/cart/updated` fires on every edit). The app schedules a delayed call on a cart event and, right before firing, re-checks via `GET /v3/carts/{id}` that the cart still exists (not converted/cleared). Caveats (all marked `TODO` in `src/automations/abandonedCart.js`):

- A guest cart usually has **no phone** until checkout starts, so such carts are skipped. Best results come from pairing this with a checkout-started signal or a cart attached to a registered customer.
- For stronger "still abandoned?" signals, also cross-check the **Abandoned Cart API** / orders created from the cart.
- The delay uses `setTimeout` (see `_base.js`) — swap for a durable job queue in production.

## ✅ Production checklist

- [ ] **Swap the file store for a real DB.** `src/store.js` is an in-memory + JSON-file stub (no locking, last-write-wins, single-process). Move stores/settings/callMap/hooks/attempts/leads to Postgres/MySQL/DynamoDB. The logical stores are documented at the top of the file.
- [ ] **Durable scheduling for delays + sweeps.** Delayed calls use `setTimeout` and win-back uses `setInterval` — neither survives a restart or scales across instances. Use a job queue (BullMQ/Redis, SQS) or `node-cron` with a leader lock.
- [ ] **Host on HTTPS** with a stable `HOST`. Re-register webhooks if the URL changes.
- [ ] **Privacy/erasure.** On uninstall we purge all local data; for full erasure also forward redaction/export to Telenow for the actual voice recordings/transcripts (TODOs marked in `src/webhooks/telenow.js`).
- [ ] **Per-customer call frequency caps / suppression list** (don't call the same shopper repeatedly across automations).
- [ ] **Win-back accuracy / scale.** `winBack.js` pages V3 customers and fetches each one's latest order to date them — fine for small/medium stores; maintain a `last_order_at` index from `store/order/created` for large catalogs.
- [ ] **Abandoned cart depth.** Wire a checkout-started signal and/or the Abandoned Cart API for guest carts (see limitations above).

## 🧪 Local round-trip test

A self-contained harness proves the **entire integration chain** end-to-end on
your machine — **no real BigCommerce store, no real Telenow backend, and no
hosting required**. It drives the app's real modules (the wired Express app, the
BigCommerce webhook token verifier, the Admin-API customer hydration, `placeCall`,
the Telenow client, the result-webhook receiver and the lead store), with an
in-process mock Telenow API **and** a minimal mock BigCommerce Admin API.

```bash
npm run roundtrip
```

What it exercises (the lead-callback path, whose write-back is to the app's own
lead store, so no BigCommerce write-back API is needed):

1. Seeds an installed store (with a known per-store `webhookToken`) + Telenow hook
   + settings directly via `store.js` (bypassing OAuth), enabling the
   `leadCallback` automation with an agent id and a Telenow API key.
2. POSTs a `store/customer/created` webhook to `/webhooks/bigcommerce` carrying the
   stored `X-Telenow-Token` header (BigCommerce doesn't HMAC-sign — it echoes the
   shared token) and a `{ scope, data:{ id } }` body.
3. Because the webhook carries only the entity id, the dispatcher **hydrates the
   customer from the Admin API** — the harness stands up a tiny mock BigCommerce
   Admin API (pointed to via `BIGCOMMERCE_API_URL`) that returns a customer with a
   phone, so the hydration step runs for real (nothing is stubbed). It asserts the
   mock Admin API was actually hit.
4. Asserts the mock Telenow received an `initiate-call` with the expected E.164
   number and a `lead:<id>` identifier, and that a lead row was stored, linked to
   the BC customer id, and moved to `placed`.
5. Fires a `call.analyzed` **result webhook** back at `/telenow/webhook`, signed
   with the mock's hook secret (`X-VoiceAI-Signature: sha256=<hex>`), and asserts
   the lead is updated to `completed` / disposition `confirmed`.
6. Asserts a result webhook with a **wrong signature** is rejected with `401` and
   leaves the lead unchanged.

It prints `PASS`/`FAIL` per check and exits non-zero on any failure. It uses a
throwaway temp `DATA_DIR` (removed on exit) and dummy credentials, so it needs no
real keys and touches no network. Test files live in `test/`
(`test/mock-telenow.mjs`, `test/roundtrip.mjs`).

## 📂 Project layout

```
src/
  server.js               Express app: routers, body parsers, settings API, scheduler
  bigcommerce.js          OAuth (code→token), signed-JWT verify, Admin API client + write-back
  auth.js                 Lifecycle callbacks: /auth (install), /load, /uninstall, /remove-user
  telenow.js              Telenow API client (me, initiateCall, createHook, listHooks, deleteHook)
  settings.js             Per-store settings model + defaults + redaction
  store.js                Persistence STUB (file JSON) — stores/settings/callMap/hooks/attempts/leads
  webhooks/
    bigcommerce.js        BC webhook mgmt (/v3/hooks) + inbound receiver (token verify) + dispatch
    telenow.js            Telenow result receiver (HMAC hex) + write-back + hook lifecycle
  automations/
    _base.js              placeCall(): gating (enabled/key/agent/quiet/delay) + dial + stable-id dedupe
    orderUpdates.js       orderConfirmation + orderStatusUpdate
    codConfirmation.js    COD detection + confirmation call
    leadCallback.js       new-customer speed-to-lead + lead row
    winBack.js            scheduled lapsed-customer sweep
    abandonedCart.js      cart recovery (delayed re-check)
  util/
    phone.js              E.164 normalization
    quietHours.js         timezone-aware quiet-hours check
  public/app.html         embedded settings UI + Recent-leads card + legal footer
scripts/
  seed-demo.js            seed a dummy installed store for local UI preview
```

## 📞 About Telenow

[Telenow](https://telenow.ai) is a voice-AI platform for building multilingual AI phone agents that make and take real calls — for sales, support, confirmations, and reminders — in English, Hindi, and other Indian and global languages. This BigCommerce app is one of several e-commerce connectors that turn store events into automated Telenow calls. Create an account, build your agent, and grab a `vai_live_…` API key to get started.

- 🌐 Website: [telenow.ai](https://telenow.ai)
- 📚 Docs: [telenow.ai/docs](https://telenow.ai/docs)
- 💸 Pricing: [telenow.ai/#pricing](https://telenow.ai/#pricing)

## 📄 License

Released under the [MIT License](LICENSE).
