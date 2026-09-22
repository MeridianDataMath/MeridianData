// Copy simulator (MD.copysim) and paper copy (MD.paper): sizing, the per-position cap, reductions, closing flat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, near } from './_load.mjs';

const MD = load(['js/util.js', 'js/api.js', 'js/analytics.js', 'js/copy/sim.js', 'js/copy/paper.js']);
const S = MD.copysim, PP = MD.paper;
const px = 100;
const fill = (t, q, oid) => ({ t, q, px, fee: Math.abs(q) * px * 0.0003, maker: false, oid });
const priceAt = async (pid, t, p) => p;
const base = { size: 2000, ratio: 0.1, delaySec: 0, slipBps: 0, feeRate: 0.0003, priceAt };
const flat = (r) => Math.abs(r.legs.reduce((a, l) => a + l.q, 0));
// a leader who opens with $8, scales in to $923, then cuts half and closes: the case that made a "fixed $2,000" copy
// $226,804 before the cap
const scaledIn = { pid: 'p', start: 0, end: 5000, side: 1, qty: 0, fills: [fill(0, 0.08, 'o1'), fill(1000, 3, 'o2'), fill(2000, 3, 'o3'), fill(3000, 3.15, 'o4'), fill(4000, -4.615, 'o5'), fill(5000, -4.615, 'o6')] };

test('fixed size: adds follow the leader only up to five times the size, and the copy is flat when the leader is', async () => {
  const r = await S.replayEpisode(scaledIn, Object.assign({ mode: 'fixed' }, base), null);
  near(assert, r.entryNotional, 5 * 2000, 1e-6, 'entry notional capped');
  assert.equal(r.capped, true);
  near(assert, flat(r), 0, 1e-9, 'open quantity after the close');
});

test('an explicit maximum per position is respected', async () => {
  const r = await S.replayEpisode(scaledIn, Object.assign({ mode: 'fixed', maxPos: 3000 }, base), null);
  near(assert, r.entryNotional, 3000, 1e-6);
  near(assert, flat(r), 0, 1e-9);
});

test('within the cap, adds are proportional as before ($800 then +$800 → $2,000 then +$2,000)', async () => {
  const e = { pid: 'p', start: 0, end: 2000, side: 1, qty: 0, fills: [fill(0, 8, 'a'), fill(1000, 8, 'b'), fill(2000, -16, 'c')] };
  const r = await S.replayEpisode(e, Object.assign({ mode: 'fixed' }, base), null);
  near(assert, r.entryNotional, 4000, 1e-6); assert.equal(r.capped, false);
});

test('per-fill and ratio modes close flat; ratio is not capped', async () => {
  for (const mode of ['perfill', 'ratio']) { const r = await S.replayEpisode(scaledIn, Object.assign({ mode }, base), null); near(assert, flat(r), 0, 1e-9, mode); }
  const r = await S.replayEpisode(scaledIn, Object.assign({ mode: 'ratio' }, base), null);
  near(assert, r.entryNotional, 0.1 * 923, 1e-6, 'ratio: 10% of the leader');
});

test('the first-order notional covers every piece of the opening order', () => {
  const e = { side: 1, fills: [fill(0, 1, 'o1'), fill(1, 2, 'o1'), fill(2, 3, 'o2')] };
  near(assert, S.firstOrderNotional(e).notional, 300, 1e-9);
});

test('the delayed price runs from the fill to its minute\'s close, then close to close', async () => {
  const closes = new Map([[0, 101], [60000, 103]]);
  const candles = { at: async (tk, t) => (closes.has(Math.floor(t / 60000) * 60000) ? closes.get(Math.floor(t / 60000) * 60000) : null) };
  const f = S.priceAtFactory(candles, { byId: { p: { ticker: 'X' } } });
  near(assert, await f('p', 30000, 100, 15), 100 + (101 - 100) * (15 / 30), 1e-9, 'inside the fill\'s minute');
  near(assert, await f('p', 30000, 100, 60), 101 + (103 - 101) * (30000 / 60000), 1e-9, 'in the next minute');
  near(assert, await f('p', 30000, 100, 0), 100, 0, 'no delay: the fill price');
});

test('paper copy follows the same cap and ends flat', () => {
  const st = PP.start('sid', '0x', { mode: 'fixed', size: 2000, ratio: 0.1, delay: 0, slipBps: 0, feeRate: {} });
  const seq = [[0.08, 'BUY'], [3, 'BUY'], [3, 'BUY'], [3.15, 'BUY'], [4.615, 'SELL'], [4.615, 'SELL']];
  seq.forEach(([qty, side], i) => PP.apply(st, { id: 'f' + i, t: i * 1000, pid: 'p', ticker: 'P', side, qty, px, orderQty: qty }, { px, live: true, at: i * 1000 }));
  assert.deepEqual(Object.keys(st.open), []);
  near(assert, st.closed[0].entryNotional, 10000, 1e-6, 'capped at five times the size');
  assert.equal(PP.apply(st, { id: 'f0', t: 0, pid: 'p', ticker: 'P', side: 'BUY', qty: 1, px }, { px, live: true, at: 0 }), null, 'a fill already mirrored is ignored');
});
