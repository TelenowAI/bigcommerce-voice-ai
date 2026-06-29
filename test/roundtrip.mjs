// ─────────────────────────────────────────────────────────────────────────────
// test/roundtrip.mjs — local end-to-end round-trip harness for the BigCommerce app.
//
// Proves the FULL integration chain works locally with NO real BigCommerce store,
// NO real Telenow backend, and NO hosting. It drives the plugin's REAL modules:
//
//   BigCommerce store/customer/created webhook  (token-verified for real, against
//                                                the per-store webhookToken)
//        → dispatch hydrates the customer from the Admin API  ← MOCK BC Admin API
//        → handleLeadCallback → placeCall → TelenowClient.initiateCall
//        → MOCK Telenow records the call + returns a sessionId
//        → MOCK Telenow fires a call.analyzed result webhook (HEX HMAC)
//        → telenow webhook receiver writes back to the LEAD store
//
// FULLY EXERCISED including hydration: BigCommerce webhooks carry only the entity
// id, so the dispatcher calls getCustomer() against the Admin API. We stand up a
// minimal mock BigCommerce Admin API and point BIGCOMMERCE_API_URL at it, so the
// hydration step runs for real (nothing is stubbed out).
//
// Run:  npm run roundtrip      (exits 0 with all PASS, non-zero on any FAIL)
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { startMockTelenow, httpPost } from './mock-telenow.mjs';

// ── Test config ────────────────────────────────────────────────────────────────
const STORE_HASH = 'rtstore1';
const ACCESS_TOKEN = 'bc_access_token_test';
const CUSTOMER_ID = 5544;
const TEST_PORT = 4012;
const HOST = `http://127.0.0.1:${TEST_PORT}`;
const PHONE_LOCAL = '9876543210';
const EXPECTED_E164 = '+919876543210';

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: Boolean(cond), detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function waitFor(predicate, { timeoutMs = 4000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-await-in-loop
  while (Date.now() < deadline) {
    if (predicate()) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * Minimal mock BigCommerce Admin API so the dispatcher's getCustomer() hydration
 * runs for real. Serves GET /stores/<hash>/v3/customers?id:in=<id> →
 * { data: [customer] }. Records requests so we can assert hydration happened.
 */
async function startMockBcAdmin(customer) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push({ method: req.method, path: url.pathname + url.search, authToken: req.headers['x-auth-token'] });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.pathname.includes('/v3/customers')) {
      res.end(JSON.stringify({ data: [customer], meta: {} }));
      return;
    }
    res.end(JSON.stringify({ data: [] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenow-bigcommerce-rt-'));
  const mock = await startMockTelenow();

  // The customer the (mock) Admin API will hand back during hydration.
  const customer = {
    id: CUSTOMER_ID,
    first_name: 'Asha',
    last_name: 'Rao',
    email: 'asha@example.com',
    phone: PHONE_LOCAL,
    company: 'Rao Traders',
    customer_group_id: 2,
    addresses: [{ city: 'Bengaluru', phone: PHONE_LOCAL, company: 'Rao Traders' }],
  };
  const bcAdmin = await startMockBcAdmin(customer);

  // Env MUST be set before importing any plugin module.
  process.env.DATA_DIR = dataDir;
  process.env.TELENOW_API_BASE = mock.base;
  process.env.BIGCOMMERCE_API_URL = bcAdmin.base; // ← hydration target
  process.env.HOST = HOST;
  process.env.PORT = String(TEST_PORT);
  process.env.BIGCOMMERCE_CLIENT_ID = 'test-client-id';
  process.env.BIGCOMMERCE_CLIENT_SECRET = 'test-client-secret';
  process.env.DEFAULT_PHONE_COUNTRY = 'IN';

  const origListen = http.Server.prototype.listen;
  let appServer = null;
  http.Server.prototype.listen = function patched(...args) {
    appServer = this;
    return origListen.apply(this, args);
  };

  const store = await import('../src/store.js');
  const settings = await import('../src/settings.js');
  const session = await import('../src/session.js');
  await import('../src/server.js'); // starts the real app on TEST_PORT
  http.Server.prototype.listen = origListen;

  await waitFor(() => appServer && appServer.listening, { timeoutMs: 4000 });

  try {
    // Seed install + settings directly via the plugin's store/settings (no OAuth).
    // Use a known webhookToken so we can sign the inbound BigCommerce webhook.
    const WEBHOOK_TOKEN = 'bc_webhook_token_test';
    store.saveStore(STORE_HASH, {
      accessToken: ACCESS_TOKEN,
      scope: 'store_v2_orders store_v2_customers',
      webhookToken: WEBHOOK_TOKEN,
      context: `stores/${STORE_HASH}`,
    });
    store.saveHook(STORE_HASH, { id: 'hook_test', secret: mock.createdHooks[0]?.secret || 'whsec_test_123' });
    settings.updateSettings(STORE_HASH, {
      telenowApiKey: 'vai_live_testkey_roundtrip',
      automations: {
        leadCallback: { enabled: true, agentId: 'agent-uuid-test', delayMinutes: 0 },
      },
    });
    const seededToken = store.getStore(STORE_HASH)?.webhookToken;
    check('seed: store + hook + settings persisted',
      store.getStore(STORE_HASH) && store.getHook(STORE_HASH)?.secret === 'whsec_test_123' &&
      settings.getAutomation(STORE_HASH, 'leadCallback').enabled && seededToken === WEBHOOK_TOKEN);

    // Simulate BigCommerce store/customer/created webhook. BigCommerce does NOT
    // HMAC-sign — it echoes the per-store shared token we set on the hook, so we
    // send the SAME token the plugin persisted. Body carries only the entity id;
    // the dispatcher hydrates the customer from the (mock) Admin API.
    const bcBody = JSON.stringify({
      scope: 'store/customer/created',
      store_id: 99,
      producer: `stores/${STORE_HASH}`,
      data: { type: 'customer', id: CUSTOMER_ID },
      hash: 'abc',
      created_at: Math.floor(Date.now() / 1000),
    });
    const webhookRes = await httpPost(`${HOST}/webhooks/bigcommerce`, bcBody, {
      'Content-Type': 'application/json',
      'X-Telenow-Token': seededToken,
    });
    check('bigcommerce webhook accepted (token verified, 200)', webhookRes.status === 200,
      `status=${webhookRes.status}`);

    // Handler runs async after the 200 ACK. Wait for the placed call.
    await waitFor(() => mock.initiateCalls.length >= 1);
    const call = mock.initiateCalls[0];
    check('mock BC Admin API was hit for hydration',
      bcAdmin.requests.some((r) => r.path.includes('/v3/customers')),
      bcAdmin.requests.map((r) => r.path).join(' | '));
    check('mock Telenow received an initiate-call', Boolean(call));
    check('initiate-call has expected E.164 phone',
      call?.mobileNumber === EXPECTED_E164, `mobileNumber=${call?.mobileNumber}`);
    check('initiate-call identifier starts "lead:"',
      typeof call?.identifier === 'string' && call.identifier.startsWith('lead:'),
      `identifier=${call?.identifier}`);
    check('initiate-call carries the configured agentId',
      call?.agentId === 'agent-uuid-test', `agentId=${call?.agentId}`);

    // A lead row was stored, "placed", with the sessionId + the BC customer id.
    await waitFor(() => {
      const ls = store.listLeads(STORE_HASH, 10);
      return ls.length >= 1 && ls[0].status === 'placed';
    });
    const leads = store.listLeads(STORE_HASH, 10);
    const lead = leads[0];
    check('a lead row was stored', Boolean(lead) && leads.length === 1);
    check('lead captured the phone (E.164)', lead?.phone === EXPECTED_E164, `phone=${lead?.phone}`);
    check('lead linked to BC customer id', String(lead?.customerId) === String(CUSTOMER_ID),
      `customerId=${lead?.customerId}`);
    check('lead moved to status "placed"', lead?.status === 'placed', `status=${lead?.status}`);
    const sessionId = lead?.sessionId;
    check('lead has the Telenow sessionId', Boolean(sessionId), `sessionId=${sessionId}`);

    // Fire the result webhook (correct HEX signature) → 200 + lead → completed.
    const goodRes = await mock.fireResultWebhook(`${HOST}/telenow/webhook`, { sessionId });
    check('result webhook (valid signature) → 200', goodRes.status === 200, `status=${goodRes.status}`);
    await waitFor(() => store.getLead(STORE_HASH, lead.id)?.status === 'completed');
    const completed = store.getLead(STORE_HASH, lead.id);
    check('lead updated to "completed"', completed?.status === 'completed', `status=${completed?.status}`);
    check('lead disposition is "confirmed"', completed?.disposition === 'confirmed',
      `disposition=${completed?.disposition}`);
    check('lead recorded duration from result', completed?.duration === 42, `duration=${completed?.duration}`);

    // Negative test: a WRONG signature → 401 and NO further lead change.
    const before = JSON.stringify(store.getLead(STORE_HASH, lead.id));
    const badRes = await mock.fireResultWebhook(`${HOST}/telenow/webhook`, {
      sessionId,
      signature: 'sha256=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      bodyOverride: {
        event_type: 'call.analyzed',
        session_id: sessionId,
        status: 'completed',
        duration: 999,
        analysis: { disposition: 'cancelled', summary: 'should not be applied' },
      },
    });
    check('result webhook (wrong signature) → 401', badRes.status === 401, `status=${badRes.status}`);
    await new Promise((r) => setTimeout(r, 150));
    const after = JSON.stringify(store.getLead(STORE_HASH, lead.id));
    check('lead unchanged after bad-signature webhook', before === after);

    // ── /api/* auth (IDOR fix): the data routes derive the tenant from a SIGNED
    //    Bearer session token, NOT the query param. No token → 401; valid → 200.
    const noAuthRes = await fetch(`${HOST}/api/leads?storeHash=${STORE_HASH}`);
    check('GET /api/leads with NO Authorization → 401', noAuthRes.status === 401,
      `status=${noAuthRes.status}`);

    const validToken = session.mintSessionToken(STORE_HASH);
    const authRes = await fetch(`${HOST}/api/leads?storeHash=${STORE_HASH}`, {
      headers: { Authorization: `Bearer ${validToken}` },
    });
    check('GET /api/leads with valid Bearer token → 200', authRes.status === 200,
      `status=${authRes.status}`);
  } finally {
    if (appServer) await new Promise((resolve) => appServer.close(() => resolve()));
    await mock.close();
    await bcAdmin.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length ? 'FAIL' : 'PASS'}: ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('Failed checks:', failed.map((f) => f.name).join('; '));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('roundtrip harness crashed:', err);
  process.exitCode = 1;
});
