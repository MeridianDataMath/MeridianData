// Leader alerts (js/copy/alerts.js): following, unfollowing and following again while a subscription is still being set
// up leaves exactly one live subscription.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_load.mjs';

// the module keeps timers (its owner heartbeat, the resyncs): let them not hold this test process open
const si = globalThis.setInterval, st0 = globalThis.setTimeout;
globalThis.setInterval = (...a) => { const t = si(...a); if (t && t.unref) t.unref(); return t; };
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.location = { origin: 'https://x', pathname: '/', hash: '' };
const MD = load(['js/util.js']);
MD.util.toast = () => {};
const handlers = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// an exchange that answers after 30 ms, and a socket that counts the live handlers per key
MD.api = {
  BASE: 'b',
  ref: async () => { await sleep(30); return { byTicker: {} }; },
  openPositions: async () => { await sleep(30); return []; },
  page: async () => { await sleep(30); return []; },
  ws: { subscribe(type, id, fn) { const k = type + '|' + id; const s = handlers.get(k) || new Set(); s.add(fn); handlers.set(k, s); return () => { s.delete(fn); }; } },
};
load(['js/copy/alerts.js']);
const AL = MD.alerts;

test('follow, unfollow, follow again during the set-up: followed, with one live subscription', async () => {
  globalThis.document = globalThis.document || { addEventListener() {}, createElement: () => ({}) };
  AL.start();
  const L = { sid: 'S1', address: '0xabc' };
  AL.follow(L); await sleep(5);
  AL.unfollow('S1'); await sleep(5);
  AL.follow(L); await sleep(200);
  assert.equal(AL.isFollowed('S1'), true);
  assert.equal((handlers.get('OrderFill|S1') || new Set()).size, 1, 'one fill subscription');
  assert.equal((handlers.get('SubaccountLiquidation|S1') || new Set()).size, 1, 'one liquidation subscription');
  AL.unfollow('S1'); await sleep(5);
  assert.equal((handlers.get('OrderFill|S1') || new Set()).size, 0, 'unfollowing ends it');
});
