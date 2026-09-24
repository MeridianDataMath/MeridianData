// Predict wallets: the Meridian app places predictions from a ZeroDev Kernel account its owner controls, not from the
// owner's address (which holds the perps account). Example pair: owner 0x1111… → Predict wallet 0x4824….
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_load.mjs';

const mem = new Map();   // localStorage for the cache
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const MD = load(['js/util.js', 'js/api.js', 'js/predict/api.js', 'js/predict/wallets.js']);
const P = MD.predict, W = P.wallets;
MD.util.sleep = async () => {};   // the RPC retry's backoff
P._live = false;                 // activity comes from snapshot files unless a test says otherwise

const OWNER = '0x1111111111111111111111111111111111111111', WALLET = '0x4824a415cec98e79c47d5b90d2fc74e4fc1bccac';
const FAKE = '0x' + 'fa'.repeat(20);   // a contract that wrote OWNER into the validator's storage for itself
// ethers: KernelFactory.getAddress(Kernel.initialize(0x01‖ECDSA validator, 0x0, owner, 0x, []), 0x0)
const REF = '0x48aac3920000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001243c3b752b01845adb2c711129d4f3966735ed98a9f09fc4ce570000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000001411111111111111111111111111111111111111110000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';
const word = (a) => '0x' + a.slice(2).padStart(64, '0');
const derived = (owner) => (owner === OWNER ? WALLET : '0xaa' + owner.slice(4));   // any other owner's account, never deployed

// stubbed network: the RPC (factory + validator), snapshot files for the addresses in FILES (value: file body), GraphQL counts
const log = [], FILES = new Map(), COUNTS = new Map();
let fail429 = 0; const factoryFails = new Set();
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('data/bettors/')) { const a = u.slice(13, 55); return FILES.has(a) ? { ok: true, json: async () => FILES.get(a) } : { ok: false, json: async () => null }; }
  if (u === P.URL) { const b = JSON.parse(init.body); const a = b.variables.filter && b.variables.filter.participant; return { ok: true, status: 200, json: async () => ({ data: { predictions: { totalCount: COUNTS.get(a) || 0 } } }) }; }
  const calls = JSON.parse(init.body); log.push(calls);
  if (fail429 > 0) { fail429--; return { status: 429, json: async () => ({ jsonrpc: '2.0', error: { code: 429, message: 'Too Many Requests' } }) }; }
  return { status: 200, json: async () => calls.map((c) => {
    const { to, data } = c.params[0];
    // the owner sits before hookData, initConfig and the call's padding
    if (to === W.FACTORY) { const owner = '0x' + data.slice(-248, -208); return factoryFails.has(owner) ? { id: c.id, error: { message: 'execution reverted' } } : { id: c.id, result: word(derived(owner)) }; }
    if (to === W.ECDSA) { const acct = '0x' + data.slice(-40); return { id: c.id, result: word(acct === WALLET || acct === FAKE ? OWNER : '0x' + '0'.repeat(40)) }; }
    return { id: c.id, error: { message: 'unknown' } };
  }) };
};
const reset = () => { mem.clear(); FILES.clear(); COUNTS.clear(); factoryFails.clear(); fail429 = 0; log.length = 0; P._live = false; };
const bets = { predictions: [{ id: 'x' }] };

test('the factory call matches what ethers encodes for the Meridian app\'s account', () => {
  assert.equal(W.walletCalldata(OWNER), REF);
  assert.equal(W.walletCalldata(OWNER.toUpperCase().replace('0X', '0x')), REF, 'any case');
  assert.equal(W.ownerCalldata(WALLET), '0x20709efc' + WALLET.slice(2).padStart(64, '0'));
  assert.equal(W.addrOf(word(WALLET)), WALLET);
});

test('owner → wallet and back, batched, cached', async () => {
  reset();
  const [w, o] = await Promise.all([W.walletOf(OWNER), W.ownerOf(WALLET)]);
  assert.equal(w, WALLET); assert.equal(o, OWNER);
  assert.equal(log[0].length, 2, 'both first calls in one request');
  const n = log.length;
  assert.equal(await W.walletOf(OWNER), WALLET); assert.equal(await W.ownerOf(WALLET), OWNER);
  assert.equal(log.length, n, 'answered from the cache');
  assert.equal(await W.ownerOf(OWNER), null, 'a plain wallet has no owner');
});

test('an owner record the account wrote for itself counts only at the owner\'s own derived address', async () => {
  reset();
  assert.equal(await W.ownerOf(FAKE), null, 'FAKE names OWNER, but OWNER\'s Predict wallet is 0x4824…');
  assert.equal(await W.ownerOf(WALLET), OWNER);
});

test('an account derived here that nobody has deployed yet still knows its owner', async () => {
  reset();
  const x = '0x' + '77'.repeat(20);
  const w = await W.walletOf(x);
  assert.equal(await W.ownerOf(w), x, 'no validator entry yet, but it was derived from x');
  assert.ok(!mem.get('md.predict.wallets.v1').includes('"o:' + w + '"'), 'that empty answer is not remembered');
  assert.deepEqual(await W.resolve(w), { owner: x, wallet: w, isWallet: true });
});

test('a burst refused with 429 is retried', async () => {
  reset(); fail429 = 2;
  assert.equal(await W.walletOf(OWNER), WALLET);
  assert.equal(log.length, 3);
});

test('resolve: a Predict wallet does not need its own derivation to succeed', async () => {
  reset(); factoryFails.add(WALLET);
  assert.deepEqual(await W.resolve(WALLET), { owner: OWNER, wallet: WALLET, isWallet: true });
  assert.deepEqual(await W.resolve(OWNER), { owner: OWNER, wallet: WALLET, isWallet: false });
});

test('predictAddress: the perps owner\'s predictions are its wallet\'s', async () => {
  reset(); FILES.set(WALLET, bets);
  const r = await W.predictAddress(OWNER);
  assert.equal(r.address, WALLET); assert.equal(r.via, WALLET); assert.equal(r.active, true); assert.equal(r.also, null);
  const self = await W.predictAddress(WALLET);
  assert.equal(self.address, WALLET); assert.equal(self.via, null);
  // a wallet that bets directly keeps its own predictions
  const direct = '0x' + '12'.repeat(20); FILES.set(direct, bets);
  const d = await W.predictAddress(direct);
  assert.equal(d.address, direct); assert.equal(d.via, null); assert.equal(d.active, true);
  // activity under both: the wallet's is shown and the other one is named
  FILES.set(OWNER, bets);
  assert.equal((await W.predictAddress(OWNER)).also, OWNER);
  // nobody home: the Predict wallet is where predictions would be, and nothing is active
  const none = await W.predictAddress('0x' + '34'.repeat(20));
  assert.equal(none.address, derived('0x' + '34'.repeat(20))); assert.equal(none.active, false);
});

test('a wallet whose only activity is secondary-market trades counts, live or not', async () => {
  reset();
  const trader = '0x' + 'ba'.repeat(20); FILES.set(trader, { predictions: [], trades: [{ t: 1 }] });
  assert.equal(await W.hasActivity(trader), true, 'offline');
  P._live = true;   // live: no predictions to count, the snapshot file still has the trades
  assert.equal(await W.hasActivity(trader), true, 'live');
  COUNTS.set(OWNER, 3); assert.equal(await W.hasActivity(OWNER), true, 'live count');
  assert.equal(await W.hasActivity('0x' + '99'.repeat(20)), false);
  const r = await W.predictAddress(trader);
  assert.equal(r.address, trader, 'keeps the trader, not its empty derived wallet'); assert.equal(r.active, true);
});

test('an unreachable RPC falls back to the address itself, with the error', async () => {
  reset(); fail429 = 99;
  const r = await W.predictAddress('0x' + '56'.repeat(20));
  assert.equal(r.address, '0x' + '56'.repeat(20)); assert.ok(r.error);
});
