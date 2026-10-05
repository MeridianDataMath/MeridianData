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

test('funding and position fees follow the copier\'s share of size × time, not the average over fills', async () => {
  // the leader opens 0.01, scales to 10 a second later and holds for 99 s; the fixed $2,000 copy is 20 units, then capped at 100
  const e = { pid: 'p', start: 0, end: 100000, side: 1, qty: 0, fundingRecv: -10, posFee: 1, fills: [fill(0, 0.01, 'o1'), fill(1000, 9.99, 'o2'), fill(100000, -10, 'o3')] };
  const r = await S.replayEpisode(e, Object.assign({ mode: 'fixed' }, base), null);
  const k = (20 * 1000 + 100 * 99000) / (0.01 * 1000 + 10 * 99000);   // ≈ 10, where the per-fill average was (2,000 + 10) / 2
  near(assert, r.k, k, 1e-9); near(assert, r.funding, -10 * k, 1e-9); near(assert, r.posFee, k, 1e-9);
});

test('position records: the nearest unused one per episode; an open position\'s unapplied funding counts', () => {
  // four SOL episodes 1-4 s apart, records listed newest first (as the API returns them)
  const starts = [40800, 42655, 43865, 44734];
  const eps = starts.map((t) => ({ pid: 'sol', start: t }));
  const recs = starts.slice().reverse().map((t) => ({ id: 'r' + t, productId: 'sol', createdAt: t, size: '0', fundingAccruedUsd: String(t / 1e5) }));
  S.attachPositions(eps, recs);
  assert.deepEqual(eps.map((e) => e.pos.id), starts.map((t) => 'r' + t), 'each episode its own record');
  near(assert, eps[0].fundingRecv, -0.408, 1e-12);
  const [open] = S.attachPositions([{ pid: 'xau', start: 1000 }], [{ id: 'o', productId: 'xau', createdAt: 1000, size: '3', fundingAccruedUsd: '2', fundingUsd: '421', positionFeeAccruedUsd: '0.1', positionFeeUsd: '0.0009' }]);
  near(assert, open.fundingRecv, -423, 1e-9, 'applied and charged-but-unapplied funding (paid)'); near(assert, open.posFee, 0.1009, 1e-12);
});

// The audit's XAU position 01a0fd11-12b7… (finding #27): a short of 3 opened at 4,185, bought back in two fills; the
// exchange's record and fills as /v1/position/{id} and /v1/position/fill return them
const xauRec = { id: '01a0fd11-12b7-7736-a72c-4c3cc60962f9', productId: 'xau', cost: '0', feesAccruedUsd: '0.6216615', positionFeeAccruedUsd: '11.06787639', fundingUsd: '0', positionFeeUsd: '0', fundingAccruedUsd: '-11.869723563', realizedPnl: '121.77', size: '0', side: 1, totalIncreaseNotional: '12555', totalIncreaseQuantity: '3', totalDecreaseNotional: '12433.23', totalDecreaseQuantity: '3', createdAt: 1790952149682, updatedAt: 1791014705992, isLiquidated: false };
const xauFills = [
  { id: 'a', orderId: 'o1', productId: 'xau', side: 1, filled: '3', price: '4185', feeUsd: '0', createdAt: 1790952149682 },
  { id: 'b', orderId: 'o2', productId: 'xau', side: 0, filled: '0.1', price: '4144.7', feeUsd: '0.0207235', createdAt: 1791014620143 },
  { id: 'c', orderId: 'o3', productId: 'xau', side: 0, filled: '2.9', price: '4144.4', feeUsd: '0.600938', createdAt: 1791014705992 },
];

test('a closed position\'s result is Meridian\'s Closed P&L; the site\'s net, with position fees, rides along', () => {
  const [e] = S.attachPositions(S.episodes(xauFills, [xauRec]), [xauRec]);
  const L = S.leaderResult(e, null);
  assert.equal(L.fromRecord, true, 'the record is this position whole');
  near(assert, L.app, 121.77 + 11.869723563 - 0.6216615, 1e-9, 'the app\'s +$133.02: realized − fundingAccrued − feesAccrued');
  near(assert, L.net, 121.77 - 0.6216615 + 11.869723563 - 11.06787639, 1e-9, 'the site\'s +$121.95');
  near(assert, L.appPct, L.app / 12555, 1e-12, 'Closed P&L % on the notional opened');
  near(assert, L.gross - L.fees + L.fundingSettled, L.app, 1e-9, 'the fills give the same figure');
  // no whole record (it holds fills outside the episode): the same sum from the fills, funding settled only
  const part = Object.assign({}, e, { pos: Object.assign({}, xauRec, { totalIncreaseQuantity: '4' }), fundingRecv: 12, fundingSettled: 10, posFee: 3 });
  const P = S.leaderResult(part, null);
  assert.equal(P.fromRecord, false); near(assert, P.app, 121.77 - 0.6216615 + 10, 1e-9, 'unsettled funding left out'); near(assert, P.net, 121.77 - 0.6216615 + 12 - 3, 1e-9);
});

test('an open position\'s result is the app\'s gross P&L on the average entry of what is held', () => {
  const f = (t, q, p) => ({ t, q, px: p, fee: 0, oid: 'o' + t });
  // bought 1 at 100, sold half at 120 (+10 realized), bought 1 more at 200: 1.5 held at an average of 166.67
  const e = { pid: 'p', start: 0, end: null, side: 1, qty: 1.5, fundingRecv: -2, fundingSettled: -1, posFee: 0.5, fills: [f(0, 1, 100), f(1, -0.5, 120), f(2, 1, 200)] };
  near(assert, S.avgEntry(e), 250 / 1.5, 1e-9, 'a cut takes out cost at the average');
  const L = S.leaderResult(e, 180);
  near(assert, L.app, 1.5 * (180 - 250 / 1.5), 1e-9, '(mark − average entry) × size: +$20');
  near(assert, L.appPct, (180 - 250 / 1.5) / (250 / 1.5), 1e-12, 'the price move');
  near(assert, L.net, 30 - 2 - 0.5, 1e-9, 'the site\'s net: the +$10 partial close, funding and position fees too');
  const s = S.leaderResult({ pid: 'p', start: 0, side: -1, qty: -2, fills: [f(0, -2, 100)] }, 90);
  near(assert, s.app, 20, 1e-9, 'a short gains as the price falls'); near(assert, s.appPct, 0.1, 1e-12);
});

test('the replay sums the app\'s figure for the leader and keeps the copier and the share kept on the net basis', async () => {
  const [e] = S.attachPositions(S.episodes(xauFills, [xauRec]), [xauRec]);
  const R = await S.replay({ episodes: [e], settings: { mode: 'ratio', ratio: 1, delaySec: 0, slipBps: 0, feeRate: 0, priceAt }, marks: {}, since: 0, ref: null });
  near(assert, R.T.leaderApp, 133.018062063, 1e-9); near(assert, R.T.leaderNet, 121.950185673, 1e-9);
  near(assert, R.rows[0].leaderAppBps, (133.018062063 / 12555) * 1e4, 1e-9);
  // a copy of the whole position at no fee: its net is the leader's gross + funding − position fees, against the leader's net
  near(assert, R.T.copierNet, 121.77 + 11.869723563 - 11.06787639, 1e-9);
  near(assert, R.T.edgeKept, (R.T.copierNet / R.T.leaderNet) * 100, 1e-9, 'the share kept is net against net');
});

test('the share kept is against the leader\'s result at the copier\'s size: a cost-free copy keeps 100%', async () => {
  const e = { pid: 'p', start: 0, end: 2000, side: 1, qty: 0, pos: {}, fundingRecv: 0, posFee: 0, fills: [{ t: 0, q: 10, px: 100, fee: 0, oid: 'a' }, { t: 2000, q: -10, px: 110, fee: 0, oid: 'b' }] };
  for (const s of [{ mode: 'ratio', ratio: 0.1 }, { mode: 'fixed', size: 2000 }]) {
    const R = await S.replay({ episodes: [e], settings: Object.assign({ delaySec: 0, slipBps: 0, feeRate: 0, priceAt }, s), marks: {}, since: 0, ref: null });
    near(assert, R.T.leaderNet, 100, 1e-9, 'the leader\'s own dollars');
    near(assert, R.T.edgeKept, 100, 1e-9, s.mode); near(assert, R.T.leaderScaled, R.T.copierNet, 1e-9);
    near(assert, R.curveL[R.curveL.length - 1].y, R.T.leaderScaled, 1e-9, 'the leader\'s curve at the copier\'s size');
  }
});

test('paper copy: average-cost basis keeps the entry price; partial closes are booked, not unrealized', () => {
  const ratio1 = { mode: 'ratio', ratio: 1, delay: 0, slipBps: 0, feeRate: { p: 0 } };
  const go = (st, id, side, qty, p) => PP.apply(st, { id, t: 1, pid: 'p', ticker: 'P', side, qty, px: p }, { px: p, live: true, at: 1 });
  const st = PP.start('sid', '0x', ratio1, {});
  go(st, 'b', 'BUY', 10, 100); go(st, 's', 'SELL', 9, 150);
  const pos = st.open.p;
  near(assert, pos.basis / pos.qty, 100, 1e-9, 'Avg entry stays 100');
  near(assert, PP.unrealized(st, { p: 150 }), 50, 1e-9, 'the 1 still held');
  near(assert, st.totals.realized + PP.bookedOpen(st), 450, 1e-9, 'the 9 sold');
  near(assert, PP.unrealized(st, { p: 150 }) + PP.bookedOpen(st), pos.cash + pos.qty * 150, 1e-9, 'the sum is unchanged');
  // cut, then added to: 0.5 left at 100, plus 1 at 200
  const st2 = PP.start('sid', '0x', ratio1, {});
  go(st2, 'b1', 'BUY', 1, 100); go(st2, 's1', 'SELL', 0.5, 120); go(st2, 'b2', 'BUY', 1, 200);
  near(assert, st2.open.p.basis / st2.open.p.qty, 250 / 1.5, 1e-9);
  // a reconcile cut scales the basis the same way
  PP.cutAt(st2, 'p', 0.5, 300, 2, 'test');
  near(assert, st2.open.p.basis / st2.open.p.qty, 250 / 1.5, 1e-9); near(assert, st2.open.p.qty, 0.75, 1e-12);
  // a position kept before the basis existed keeps the old split, and an add does not start a partial basis
  const old = PP.start('sid', '0x', ratio1, {});
  go(old, 'b', 'BUY', 10, 100); delete old.open.p.basis; go(old, 's', 'SELL', 9, 150); go(old, 'b2', 'BUY', 1, 160);
  assert.equal(old.open.p.basis, undefined);
  near(assert, PP.bookedOpen(old), 0, 0); near(assert, PP.unrealized(old, { p: 150 }), old.open.p.cash + old.open.p.qty * 150, 1e-9);
});

test('paper copy: a fill in a market left out is marked seen and tracked as the leader\'s own, without a trade', () => {
  const st = PP.start('sid', '0x', { mode: 'fixed', size: 2000, ratio: 0.1, delay: 0, slipBps: 0, feeRate: {}, markets: ['a'] }, {});
  const f = (id, pid, side, qty, t) => ({ id, t, pid, ticker: pid.toUpperCase(), side, qty, px: 100, orderQty: qty });
  assert.deepEqual(PP.apply(st, f('x1', 'b', 'BUY', 2, 5000), { px: 100, live: true, at: 5000 }), []);
  assert.equal(st.seen.x1, 1); assert.equal(st.fillT, 5000); near(assert, st.pre.b, 2, 1e-12);
  assert.deepEqual(Object.keys(st.open), []); assert.equal(st.log.length, 0);
  assert.equal(PP.apply(st, f('x1', 'b', 'BUY', 2, 5000), { px: 100, live: true, at: 5000 }), null, 'once');
  PP.apply(st, f('x2', 'b', 'SELL', 2, 6000), { px: 100, live: true, at: 6000 });
  assert.equal(st.pre.b, undefined, 'the leader flat there again'); assert.deepEqual(PP.needsReconcile(st, {}), []);
  PP.apply(st, f('y1', 'a', 'BUY', 2, 7000), { px: 100, live: true, at: 7000 });
  near(assert, st.open.a.qty * 100, 2000, 1e-6, 'a followed market is copied');
});

test('paper copy follows the same cap and ends flat', () => {
  const st = PP.start('sid', '0x', { mode: 'fixed', size: 2000, ratio: 0.1, delay: 0, slipBps: 0, feeRate: {} });
  const seq = [[0.08, 'BUY'], [3, 'BUY'], [3, 'BUY'], [3.15, 'BUY'], [4.615, 'SELL'], [4.615, 'SELL']];
  seq.forEach(([qty, side], i) => PP.apply(st, { id: 'f' + i, t: i * 1000, pid: 'p', ticker: 'P', side, qty, px, orderQty: qty }, { px, live: true, at: i * 1000 }));
  assert.deepEqual(Object.keys(st.open), []);
  near(assert, st.closed[0].entryNotional, 10000, 1e-6, 'capped at five times the size');
  assert.equal(PP.apply(st, { id: 'f0', t: 0, pid: 'p', ticker: 'P', side: 'BUY', qty: 1, px }, { px, live: true, at: 0 }), null, 'a fill already mirrored is ignored');
});

// The report of 2026-09-25: following 0x7c75… at 19:23 while its ETH long (30.738, opened 12:30) was open; its two closing
// sells at 19:35 were mirrored as a new $2,000 short, closed "at mark" a day later for −$13.
const ETH = 'eth', settings = { mode: 'fixed', size: 2000, ratio: 0.1, delay: 30, slipBps: 0, feeRate: {} };
const sell = (id, qty, t, px = 2676.1) => ({ id, t, pid: ETH, ticker: 'ETH-USD', side: 'SELL', qty, px, orderQty: 30.738 });
const buy = (id, qty, t, px = 2636.5, orderQty = qty) => ({ id, t, pid: ETH, ticker: 'ETH-USD', side: 'BUY', qty, px, orderQty });

test('a position the leader held when following started is not the copy\'s: closing it opens nothing', () => {
  const st = PP.start('sid', '0x', settings, PP.leaderBook([{ productId: ETH, side: 0, size: '30.738' }]));
  assert.deepEqual(st.pre, { [ETH]: 30.738 });
  PP.apply(st, sell('s1', 16.8105, 1), { px: 2675.56, live: false, at: 31 });
  near(assert, st.pre[ETH], 13.9275, 1e-9, 'the cut comes off the untracked part');
  PP.apply(st, sell('s2', 13.9275, 2), { px: 2675.56, live: false, at: 32 });
  assert.deepEqual(Object.keys(st.open), [], 'no phantom short');
  assert.equal(st.pre[ETH], undefined); assert.equal(st.log.length, 0); assert.equal(st.totals.realized, 0);
  // the leader flat, the copy flat: lining up changes nothing
  assert.deepEqual(PP.reconcile(st, {}, () => 2691.25, 99), []);
});

test('a cut of a position partly held before following cuts the copy by the same share', () => {
  const st = PP.start('sid', '0x', settings, { [ETH]: 10 });
  PP.apply(st, buy('b1', 10, 1, 2000), { px: 2000, live: true, at: 1 });   // the leader adds 10: the copy opens $2,000
  near(assert, st.open[ETH].qty, 1, 1e-9);
  PP.apply(st, sell('s1', 5, 2, 2100), { px: 2100, live: true, at: 2 });   // 5 of 20 = a quarter
  near(assert, st.open[ETH].qty, 0.75, 1e-9); near(assert, st.open[ETH].leaderQty, 7.5, 1e-9); near(assert, st.pre[ETH], 7.5, 1e-9);
  PP.apply(st, sell('s2', 15, 3, 2100), { px: 2100, live: true, at: 3 });   // the rest
  assert.deepEqual(Object.keys(st.open), []); assert.equal(st.pre[ETH], undefined);
  near(assert, st.totals.realized, 100 - st.totals.fees, 1e-6, 'bought 1 at 2000, sold at 2100');
  // a sell past zero opens a short with what goes past it
  PP.apply(st, sell('s3', 4, 4, 2100), { px: 2100, live: true, at: 4 });
  assert.equal(st.open[ETH].side, -1);
});

test('the leader\'s whole trade mirrored from the start ends with its profit, whatever order the history returns', async () => {
  const st = PP.start('sid', '0x', settings, {});
  const ref = { byId: { [ETH]: { displayTicker: 'ETH-USD' } } };
  const f = (id, side, filled, price, createdAt) => ({ id, orderId: side + 'o', productId: ETH, side, filled: String(filled), price: String(price), createdAt });
  const fills = [f('c2', 1, 13.9275, 2676.1, 5000), f('o1', 0, 17.0742, 2636.5, 1000), f('c1', 1, 16.8105, 2676.1, 4900), f('o2', 0, 13.6638, 2636.5, 1038)];
  st.startedAt = 0;
  await PP.applyFills(st, fills, ref, async (x) => ({ px: Number(x.price), live: false, at: x.createdAt }));
  assert.deepEqual(Object.keys(st.open), []); assert.ok(st.totals.realized > 25, 'about +1.5 % of $2,000');
  assert.equal(st.fillT, 5000);
  assert.equal((await PP.applyFills(st, fills, ref, async (x) => ({ px: 1, live: false, at: 0 }))).length, 0, 'applied once');
});

test('a reversal opens the new side sized on the part of the order that opened it', () => {
  const st = PP.start('sid', '0x', settings, {}, 1);
  PP.apply(st, { id: 'b', oid: 'o1', t: 1, pid: ETH, ticker: 'ETH-USD', side: 'BUY', qty: 10, px: 2000, orderQty: 10 }, { px: 2000, live: true, at: 1 });
  // one sell order of 40: 10 close the long, 30 open a short, which is the copy's $2,000
  PP.apply(st, { id: 's', oid: 'o2', t: 2, pid: ETH, ticker: 'ETH-USD', side: 'SELL', qty: 40, px: 2000, orderQty: 40 }, { px: 2000, live: true, at: 2 });
  assert.equal(st.open[ETH].side, -1);
  near(assert, Math.abs(st.open[ETH].qty) * 2000, 2000, 1e-6, 'sized on 30, not on 40');
  assert.equal(st.startedAt, 1, 'the start can be given on the exchange\'s clock');
});

test('needsReconcile lists only the markets where the copy\'s record of the leader is off', () => {
  const st = PP.start('sid', '0x', settings, { a: 5 });
  PP.apply(st, { id: 'b', t: 1, pid: 'b', ticker: 'B', side: 'BUY', qty: 2, px: 100, orderQty: 2 }, { px: 100, live: true, at: 1 });
  assert.deepEqual(PP.needsReconcile(st, { a: 5, b: 2 }), []);
  assert.deepEqual(PP.needsReconcile(st, { a: 5, b: 3, c: 1 }).sort(), ['b', 'c']);
  assert.deepEqual(PP.needsReconcile(st, {}).sort(), ['a', 'b']);
});

test('reconcile: flat leader closes the copy, a smaller leader position cuts it, a larger one is the leader\'s own', () => {
  const st = PP.start('sid', '0x', settings, {});
  PP.apply(st, buy('b1', 10, 1, 2000), { px: 2000, live: true, at: 1 });
  PP.reconcile(st, { [ETH]: 15 }, () => 2000, 2);
  near(assert, st.pre[ETH], 5, 1e-9, 'the leader added 5 the history did not show: not the copy\'s');
  PP.reconcile(st, { [ETH]: 7.5 }, () => 2000, 3);
  near(assert, st.open[ETH].qty, 0.5, 1e-9, 'half the leader\'s position gone: half the copy'); near(assert, st.pre[ETH], 2.5, 1e-9);
  assert.deepEqual(PP.reconcile(st, { [ETH]: 7.5 }, () => null, 4), [], 'no price: left alone');
  const rows = PP.reconcile(st, {}, () => 2100, 5);
  assert.equal(rows.length, 1); assert.ok(rows[0].why); assert.deepEqual(Object.keys(st.open), []);
});

// The copy agent's order records (what Copy history is built from): only what the agent itself opened is a position
const rec = (id, side, opts, fills) => Object.assign({ id, pid: 'btc', side, reduceOnly: false, close: false, fills }, opts);
const fl = (id, t, qty, px) => ({ id, t, qty, px, fee: qty * px * 0.0003 });

test('agent fills: a close of a position the agent adopted (or that was traded by hand) is not a position of its own', () => {
  // a long of 2 adopted at start, closed by the agent's close order when the leader closed
  assert.deepEqual(S.agentFills([rec('c', 'SELL', { reduceOnly: true, close: true }, [fl('f1', 1000, 2, 119)])]), []);
  // the same, cut by half first (a reduce-only sell)
  assert.deepEqual(S.agentFills([rec('r', 'SELL', { reduceOnly: true }, [fl('f1', 1000, 1, 119)]), rec('c', 'SELL', { reduceOnly: true, close: true }, [fl('f2', 2000, 1, 120)])]), []);
});

test('agent fills: an opening and its close are unchanged', () => {
  const recs = [rec('o', 'BUY', {}, [fl('f1', 1000, 0.5, 100), fl('f2', 1001, 0.5, 101)]), rec('c', 'SELL', { reduceOnly: true, close: true }, [fl('f3', 5000, 1, 110)])];
  const out = S.agentFills(recs);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((x) => [x.id, x.side, x.filled, x.price, x.orderId]), [['f1', 0, 0.5, 100, 'o'], ['f2', 0, 0.5, 101, 'o'], ['f3', 1, 1, 110, 'c']]);
  near(assert, out[2].feeUsd, 1 * 110 * 0.0003, 1e-12, 'fee kept whole');
  const eps = S.episodes(out, []);
  assert.equal(eps.length, 1); assert.equal(eps[0].qty, 0); assert.equal(eps[0].side, 1);
});

test('agent fills: the agent\'s own long after a phantom close survives, and a close larger than its own part is cut', () => {
  // Close all of a hand long (SELL 2), then the agent opens a long of 1 and the leader closes it
  const recs = [rec('h', 'SELL', { reduceOnly: true, close: true }, [fl('f1', 1000, 2, 119)]), rec('o', 'BUY', {}, [fl('f2', 2000, 1, 120)])];
  const eps = S.episodes(S.agentFills(recs), []);
  assert.equal(eps.length, 1); assert.equal(eps[0].side, 1); near(assert, eps[0].qty, 1, 1e-12, 'one open long, not a short');
  // an adopted long of 2 plus the agent's own add of 1, all closed together: only the 1 is the agent's
  const mixed = S.agentFills([rec('a', 'BUY', {}, [fl('f1', 1000, 1, 100)]), rec('c', 'SELL', { reduceOnly: true, close: true }, [fl('f2', 2000, 3, 110)])]);
  near(assert, mixed[1].filled, 1, 1e-12); near(assert, mixed[1].feeUsd, 3 * 110 * 0.0003 / 3, 1e-12, 'the fee in proportion');
  assert.equal(S.episodes(mixed, [])[0].qty, 0);
});
