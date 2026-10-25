// Leader alerts (js/copy/alerts.js): following, unfollowing and following again while a subscription is still being set
// up leaves exactly one live subscription; a set-up that failed is tried again; a reconnect reads the positions again.
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
const statusFns = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let refFail = 0, posReads = 0;
// an exchange that answers after 30 ms (its markets list refused while refFail > 0), and a socket that counts the live
// handlers per key and lets the test report its status
MD.api = {
  BASE: 'b',
  ref: async () => { await sleep(30); if (refFail > 0) { refFail--; throw new Error('offline'); } return { byTicker: {} }; },
  openPositions: async () => { posReads++; await sleep(30); return []; },
  page: async () => { await sleep(30); return []; },
  ws: {
    subscribe(type, id, fn) { const k = type + '|' + id; const s = handlers.get(k) || new Set(); s.add(fn); handlers.set(k, s); return () => { s.delete(fn); }; },
    onStatus(fn) { statusFns.push(fn); fn('closed'); return () => {}; },
  },
};
load(['js/copy/alerts.js']);
const AL = MD.alerts;
const live = (k) => (handlers.get(k) || new Set()).size;

test('follow, unfollow, follow again during the set-up: followed, with one live subscription', async () => {
  globalThis.document = globalThis.document || { addEventListener() {}, createElement: () => ({}) };
  AL.start();
  const L = { sid: 'S1', address: '0xabc' };
  AL.follow(L); await sleep(5);
  AL.unfollow('S1'); await sleep(5);
  AL.follow(L); await sleep(200);
  assert.equal(AL.isFollowed('S1'), true);
  assert.equal(live('OrderFill|S1'), 1, 'one fill subscription');
  assert.equal(live('SubaccountLiquidation|S1'), 1, 'one liquidation subscription');
  AL.unfollow('S1'); await sleep(5);
  assert.equal(live('OrderFill|S1'), 0, 'unfollowing ends it');
});

test('a leader whose set-up failed is tried again: the card says so until it listens', async () => {
  const L = { sid: 'S2', address: '0xdef' };
  refFail = 1;
  AL.follow(L); await sleep(100);
  assert.equal(live('OrderFill|S2'), 0, 'the markets did not load: nothing is listening yet');
  assert.equal(AL.waiting(), 1, 'counted as waiting for a retry');
  AL.sync(); await sleep(200);   // what the retry timer (or the browser coming back online) does
  assert.equal(live('OrderFill|S2'), 1);
  assert.equal(AL.waiting(), 0);
  AL.unfollow('S2'); await sleep(5);
});

test("after a reconnect the followed leaders' positions are read again", async () => {
  const L = { sid: 'S3', address: '0x123' };
  AL.follow(L); await sleep(200);
  for (const f of statusFns) f('open');   // the socket was open before the drop
  const before = posReads;
  for (const f of statusFns) { f('closed'); f('connecting'); f('open'); }
  await sleep(50);
  assert.equal(posReads, before + 1, 'one re-read for the one leader listened to');
  AL.unfollow('S3'); await sleep(5);
});
