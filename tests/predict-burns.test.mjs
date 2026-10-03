// The snapshot builder's burn reader (scripts/burns.mjs): against a fake Robinhood Chain RPC that refuses ranges wider
// than N blocks (naming N, as the real one does, or not), each token's width and progress persist across runs, every
// run stays under its cap, the refusal is logged once a run, and it converges: every burn found once, every token read
// to the head, then a call per token still waiting for a redemption. Then the wallets' rd: only once every position they
// held at a paying verdict is accounted for. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_load.mjs';
import { readBurns, redemptions, nextSpan, TRANSFER, pad32, SPAN, LAUNCH_BLOCK } from '../scripts/burns.mjs';

const MD = load(['js/util.js', 'js/api.js', 'js/predict/api.js', 'js/predict/analytics.js']);
const P = MD.predict;
const hex = (n) => '0x' + n.toString(16);
const tok = (i) => '0x' + (0x70000 + i).toString(16).padStart(40, '0');
const W1 = '0x' + 'a1'.padStart(40, '0'), W2 = '0x' + 'a2'.padStart(40, '0'), OTHER = '0x' + 'b9'.padStart(40, '0');
const TS0 = 1782691200;   // block b's time: TS0 + b / 4 seconds
const timeOf = (b) => TS0 + Math.floor(b / 4);
const wei = (x) => '0x' + (BigInt(Math.round(x * 1e6)) * 1000000000000n).toString(16);

/** A fake RPC: eth_getLogs answers one address over at most `limit` blocks (a wider range is refused with the real
 *  message, or with a bare one when named is false), several addresses never; logs carry blockTimestamp 0x0, as the
 *  real ones do. burns: [{token, holder, block, amount}]; mints: {token: tx}; receipts: {tx: block}. */
function fakeRpc({ limit, named = true, burns, receipts = {} }) {
  const seen = { calls: 0, requests: 0, widest: 0, logs: 0, batches: [] };
  const rpc = async (calls) => {
    seen.requests++; seen.calls += calls.length; seen.batches.push(calls.length);
    return calls.map((c) => {
      if (c.method === 'eth_getTransactionReceipt') return receipts[c.params[0]] != null ? { result: { blockNumber: hex(receipts[c.params[0]]) } } : { result: null };
      if (c.method === 'eth_getBlockByNumber') return { result: { timestamp: hex(timeOf(parseInt(c.params[0], 16))) } };
      const q = c.params[0], from = parseInt(q.fromBlock, 16), to = parseInt(q.toBlock, 16), span = to - from + 1;
      if (typeof q.address !== 'string') return { error: { code: -32602, message: 'only one address' } };
      if (span > limit) return { error: { code: -32602, message: named ? `query spans ${span} blocks (${from} to ${to}), but only ${limit} are allowed for this request; narrow the block range` : 'block range too large' } };
      assert.deepEqual([q.topics[0], q.topics[1], q.topics[2]], [TRANSFER, null, pad32('0x0')], 'Transfer, any holder, to zero');
      seen.widest = Math.max(seen.widest, span);
      const out = burns.filter((x) => x.token === q.address && x.block >= from && x.block <= to)
        .map((x) => ({ address: x.token, topics: [TRANSFER, pad32(x.holder), pad32('0x0')], data: wei(x.amount), blockNumber: hex(x.block), blockTimestamp: '0x0' }));
      seen.logs += out.length;
      return { result: out };
    });
  };
  return { rpc, seen };
}

const HEAD = 60000000;
const BURNS = [
  { token: tok(1), holder: W1, block: 41000000, amount: 20 },        // W1 redeems token 1
  { token: tok(1), holder: OTHER, block: 41000500, amount: 3 },      // another holder of it
  { token: tok(2), holder: W2, block: 59000000, amount: 7.5 },       // W2 redeems token 2, late
  { token: tok(3), holder: OTHER, block: 2000000, amount: 1 },       // token 3: W1 holds it, never redeems
];
const WANT = [{ token: tok(1), tx: '0xt1' }, { token: tok(2), tx: null }, { token: tok(3), tx: '0xt3' }];
const RECEIPTS = { '0xt1': 40000000, '0xt3': 1500000 };

async function converge(o, { cap = 12, maxRuns = 30, head = HEAD } = {}) {
  const state = {}, logs = [];
  let runs = 0, last = null;
  for (; runs < maxRuns; runs++) {
    const lines = [];
    last = await readBurns({ rpc: o.rpc, state, want: WANT, head, cap, batch: 4, pause: 0, log: (s) => lines.push(s) });
    assert.ok(last.calls <= cap, `run ${runs}: ${last.calls} calls, cap ${cap}`);
    assert.ok(lines.filter((s) => /refused/.test(s)).length <= 1, 'the refusal is logged once a run');
    logs.push(...lines);
    if (last.read === WANT.length) break;
  }
  return { state, runs: runs + 1, logs, last };
}

test('nextSpan: the width the refusal names, else half, never below the floor', () => {
  assert.equal(nextSpan('query spans 9999994 blocks (68991611 to 78991604), but only 30000 are allowed for this request', SPAN), 30000);
  assert.equal(nextSpan('query spans 10000000 blocks, but only 10000000 are allowed', SPAN), SPAN / 2, 'already that narrow: half');
  assert.equal(nextSpan('block range too large', 4000000), 2000000);
  assert.equal(nextSpan('anything', 1500), 1000);
});

test('a refusal that names the width: the reader takes it, keeps it across runs and reads every token to the head', async () => {
  const f = fakeRpc({ limit: 3000000, burns: BURNS, receipts: RECEIPTS });
  const { state, runs, logs } = await converge(f);
  // 3 tokens, about 47 ranges of 3M blocks, 2 start blocks, 3 refusals and the block times: 5 runs of 12 calls
  assert.ok(runs <= 5, `converged in ${runs} runs`);
  assert.equal(state.span, 3000000, 'the width the RPC named, for every token');
  for (const w of WANT) { const x = state.t[w.token]; assert.equal(x.b, HEAD, w.token + ' read to the head'); assert.equal(x.s, 3000000); }
  assert.equal(state.t[tok(1)].f, 40000000, 'token 1 from its first placement\'s block');
  assert.equal(state.t[tok(2)].f, LAUNCH_BLOCK, 'no placement known: Predict\'s launch block');
  assert.equal(f.seen.widest, 3000000);
  assert.ok(logs.some((s) => /only 3000000 are allowed/.test(s)), 'the RPC\'s own words are logged');
  // every burn once, with its holder, amount and block time
  assert.deepEqual(state.t[tok(1)].l, [[W1, 20, timeOf(41000000)], [OTHER, 3, timeOf(41000500)]]);
  assert.deepEqual(state.t[tok(2)].l, [[W2, 7.5, timeOf(59000000)]]);
  assert.deepEqual(state.t[tok(3)].l, [[OTHER, 1, timeOf(2000000)]]);
  // read to the head: the same head needs no call; 30 000 new blocks need one call per token
  const again = await readBurns({ rpc: f.rpc, state, want: WANT, head: HEAD, cap: 12, pause: 0 });
  assert.equal(again.calls, 0);
  const next = await readBurns({ rpc: f.rpc, state, want: WANT, head: HEAD + 30000, cap: 12, pause: 0 });
  assert.deepEqual([next.calls, next.refused, next.read], [3, 0, 3]);
});

test('a bare refusal: the width halves, is kept across runs, and the reader still converges under the cap', async () => {
  const f = fakeRpc({ limit: 700000, named: false, burns: BURNS, receipts: RECEIPTS });
  const { state, runs } = await converge(f, { cap: 10, maxRuns: 60 });
  assert.ok(runs < 60, `converged in ${runs} runs`);
  for (const w of WANT) { const x = state.t[w.token]; assert.equal(x.b, HEAD); assert.ok(x.s <= 700000 && x.s >= 700000 / 2, 'halved down to a width the RPC answers: ' + x.s); }
  assert.equal(state.span, undefined, 'no width named: none learned for new tokens');
  assert.equal(state.t[tok(1)].l.length, 2); assert.equal(state.t[tok(2)].l.length, 1);
  assert.ok(f.seen.widest <= 700000);
});

test('a batch that fails or burns without their block times: nothing is kept but the width, the next run reads them again', async () => {
  const f = fakeRpc({ limit: SPAN, burns: BURNS, receipts: RECEIPTS });
  const state = {};
  const down = async () => { throw new Error('HTTP 502'); };
  const lines = [];
  await readBurns({ rpc: async (c) => (c[0].method === 'eth_getLogs' ? down() : f.rpc(c)), state, want: WANT, head: HEAD, cap: 50, pause: 0, log: (s) => lines.push(s) });
  assert.ok(lines.some((s) => /burn logs failed/.test(s)));
  for (const w of WANT) assert.equal(state.t[w.token].b, state.t[w.token].f - 1, 'nothing read');
  // block times refused: the logs are read but not kept
  await readBurns({ rpc: async (c) => (c[0].method === 'eth_getBlockByNumber' ? c.map(() => ({ error: { message: 'no' } })) : f.rpc(c)), state, want: WANT, head: HEAD, cap: 50, pause: 0 });
  assert.equal(state.t[tok(1)].l.length, 0); assert.ok(state.t[tok(1)].b < HEAD);
  const ok = await readBurns({ rpc: f.rpc, state, want: WANT, head: HEAD, cap: 50, pause: 0 });
  assert.equal(ok.read, 3); assert.equal(state.t[tok(1)].l.length, 2);
});

test('rd: a wallet gets it once every position it held at a paying verdict is redeemed or read to the head; a redeemed token is read no more', async () => {
  const byTok = { [tok(1)]: 'pc1|P', [tok(2)]: 'pc2|C', [tok(3)]: 'pc3|P' }, tokOf = { 'pc1|P': tok(1), 'pc2|C': tok(2), 'pc3|P': tok(3) };
  const at = (b) => timeOf(b) * 1000;
  const held = { [W1]: { 'pc1|P': { tokens: 20, after: at(40500000) }, 'pc3|P': { tokens: 4, after: at(1600000) } }, [W2]: { 'pc2|C': { tokens: 7.5, after: at(58000000) } } };
  const f = fakeRpc({ limit: SPAN, burns: BURNS, receipts: RECEIPTS });
  const state = {};
  const plan = () => redemptions({ held, tokOf, byTok, state, head: HEAD, redemptionTimes: P.redemptionTimes });
  let r = plan();
  assert.deepEqual(r.rd, {}, 'nothing read: no wallet has rd yet');
  assert.deepEqual(Array.from(r.open).sort(), [tok(1), tok(2), tok(3)]);
  // a cap that reaches only the receipts and two of the ranges
  await readBurns({ rpc: f.rpc, state, want: Array.from(r.open).map((t) => ({ token: t, tx: WANT.find((w) => w.token === t).tx })), head: HEAD, cap: 4, batch: 2, pause: 0 });
  r = plan();
  assert.equal(r.rd[W1], undefined, 'W1\'s token 3 is not read to the head yet');
  for (let i = 0; i < 10 && r.open.size; i++) {
    await readBurns({ rpc: f.rpc, state, want: Array.from(r.open).map((t) => ({ token: t })), head: HEAD, cap: 4, batch: 2, pause: 0 });
    r = plan();
  }
  assert.deepEqual(r.rd[W1], { 'pc1|P': at(41000000) }, 'token 1 redeemed by its own burn; token 3 read to the head and never redeemed');
  assert.deepEqual(r.rd[W2], { 'pc2|C': at(59000000) });
  // the chain moves on: only token 3 (held, not redeemed) is still to read
  const later = redemptions({ held, tokOf, byTok, state, head: HEAD + 5000, redemptionTimes: P.redemptionTimes });
  assert.deepEqual(Array.from(later.open), [tok(3)]);
  assert.equal(later.rd[W2] != null, true, 'W2 keeps its rd: its only position is redeemed');
  assert.equal(later.rd[W1], undefined, 'W1 waits for token 3 to be read to the new head');
  // a position whose token is not known never gives the wallet rd
  const blind = redemptions({ held: { [W2]: { 'pc2|C': held[W2]['pc2|C'], 'pc9|P': { tokens: 1, after: 0 } } }, tokOf, byTok, state, head: HEAD, redemptionTimes: P.redemptionTimes });
  assert.deepEqual(blind.rd, {});
});
