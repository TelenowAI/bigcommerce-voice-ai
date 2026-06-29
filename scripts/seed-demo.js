// ─────────────────────────────────────────────────────────────────────────────
// scripts/seed-demo.js — seed a fake installed store for LOCAL UI PREVIEW ONLY.
//
// This lets you open the settings page at:
//   http://localhost:3000/app?storeHash=demostore
// without going through a real BigCommerce OAuth install. The access token is a
// dummy and will fail any real Admin API call — it's only here so the settings
// API recognizes the store as "installed".
//
// DO NOT use in production. Run via `npm run dev:preview`.
// ─────────────────────────────────────────────────────────────────────────────

import { saveStore, getStore } from '../src/store.js';

const STORE_HASH = 'demostore';

if (!getStore(STORE_HASH)) {
  saveStore(STORE_HASH, {
    accessToken: 'bc_dummy_preview_token',
    scope: 'store_v2_orders store_v2_customers',
  });
  console.log(`[seed] created demo store ${STORE_HASH} (dummy token — preview only)`);
} else {
  console.log(`[seed] demo store ${STORE_HASH} already present`);
}
