// The dashboard's funding and trade-size helpers, held to what Meridian's app shows (figures from the app audit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_load.mjs';

const MD = load(['js/util.js', 'js/router.js', 'js/pages/dashboard.js']);
const U = MD.util, D = MD.router.pages.dashboard;
const pct4 = (x) => U.fmtPct(x, { dp: 4 });

test('funding rates print as the app prints them: 4 dp, a minus but no plus, 1y = projected × 8760', () => {
  // SPY at 20:15:57 UTC: projected 0.000105556 → the app's 1h 0.0106% and 1y 92.4671%
  assert.equal(pct4(D.ratePct('0.000105556')), '0.0106%');
  assert.equal(pct4(D.ratePct('0.000105556', 24 * 365)), '92.4671%');
  // HYPE: projected −0.00000245 shows −0.0002% in red while the last charge was +0.000009487
  assert.equal(pct4(D.ratePct('-0.00000245')), '-0.0002%');
  assert.equal(pct4(D.ratePct('0.000009487')), '0.0009%');
  // a rate that rounds to zero has no sign, as Intl's signDisplay 'negative' leaves it
  assert.equal(pct4(D.ratePct('-0.000000004')), '0.0000%');
  assert.equal(pct4(D.ratePct(0)), '0.0000%');
});

test('funding rates round half away from zero on the exact decimal, where rate × 100 in floats lands under the edge', () => {
  // −0.0029915 × 100 is −0.29914999… as a float, which printed −0.2991%; the app (9-decimal integers, Intl) shows −0.2992%
  assert.equal(pct4(D.ratePct('-0.0029915')), '-0.2992%');
  assert.equal(pct4(D.ratePct('0.0029915')), '0.2992%');
  assert.equal(pct4(D.ratePct('0.0000005')), '0.0001%');   // exactly half a unit: away from zero
  assert.equal(pct4(D.ratePct('-0.0000005')), '-0.0001%');
});

const H = 3600000, T0 = Date.UTC(2026, 9, 5, 21, 0);
const XAU = { id: 'xau', marginMode: 'ISOLATED', fundingRate1h: '0.000076893' };
const BTC = { id: 'btc', marginMode: 'CROSS', fundingRate1h: '-0.000014591' };
const gaps = [{ productId: 'xau', startTime: T0, endTime: T0 + H }, { productId: 'xau', startTime: T0 + 24 * H, endTime: T0 + 25 * H }];

test('an mPerp market inside a mark-price gap pauses funding; outside it, and on a cross market, funding runs', () => {
  assert.equal(D.fundingGap(XAU, gaps, T0 + 6 * 60000).endTime, T0 + H);
  assert.equal(D.fundingGap(XAU, gaps, T0), gaps[0]);          // the start is inside
  assert.equal(D.fundingGap(XAU, gaps, T0 + H), null);         // the end is not: the market has reopened
  assert.equal(D.fundingGap(XAU, gaps, T0 - 1), null);
  assert.equal(D.fundingGap(BTC, [{ productId: 'btc', startTime: T0, endTime: T0 + H }], T0 + 1), null);   // cross never pauses
  // overlapping gaps: funding resumes when the last of them ends
  const two = [{ productId: 'xau', startTime: T0, endTime: T0 + H }, { productId: 'xau', startTime: T0 + H / 2, endTime: T0 + 2 * H }];
  assert.equal(D.fundingGap(XAU, two, T0 + H * 0.75).endTime, T0 + 2 * H);
});

test('fundingOf: the projected rate from REST is the figure, the WebSocket fr1h only without it, and Paused in a closure', () => {
  const projected = { btc: { productId: 'btc', fundingRateProjected1h: '-0.000020096' }, xau: { productId: 'xau', fundingRateProjected1h: '0' } };
  const b = D.fundingOf(BTC, { projected, live: { fr1h: '-0.00002035' }, gaps, t: T0 + 60000 });
  assert.equal(b.projPct, -0.002);                             // REST, not the WebSocket's -0.00002035
  assert.equal(b.lastPct, -0.0015);                            // the last charge stays beside it
  assert.equal(b.aprPct, D.ratePct('-0.000020096', 8760));     // annualized from the projected rate, not the last charge
  assert.equal(b.paused, false);
  assert.equal(D.fundingOf(BTC, { projected: {}, live: { fr1h: '-0.00002035' }, gaps, t: T0 }).projPct, -0.002);   // WS stands in
  const none = D.fundingOf(BTC, { projected: {}, live: {}, gaps, t: T0 });
  assert.equal(none.projPct, null); assert.equal(none.aprPct, null);
  // XAU at 21:06 UTC inside the daily 21:00–22:00 closure: the site showed +0.0077% and +67.4%, the app "Paused"
  const x = D.fundingOf(XAU, { projected, live: {}, gaps, t: T0 + 6 * 60000 });
  assert.equal(x.paused, true); assert.equal(x.until, T0 + H);
  assert.equal(pct4(x.lastPct), '0.0077%');
  // the Annualized column shows the last charge annualized while paused (the projected rate is 0 in a closure)
  assert.equal(x.lastAprPct, D.ratePct(XAU.fundingRate1h, 8760));
  assert.equal(D.fundingOf(XAU, { projected, live: {}, gaps, t: T0 + H }).paused, false);
});

test('live-feed rows carry the product lot, so sizes print at the lot decimals as the app does', () => {
  const p = { displayTicker: 'BTC', tickSize: '1', lotSize: '0.00001' };
  const r = D.restTrade(p, { id: 'a', createdAt: 1, takerSide: '1', filled: '1.19645', price: '85706', takerOrderId: 'o1' });
  assert.equal(r.lot, '0.00001'); assert.equal(r.makerOrder, null);
  assert.equal(U.fmtQty(r.size, r.lot), '1.19645');           // a fixed 4 dp showed 1.1965, a size off the lot grid
  const w = D.wsTrades(p, { t: 5, data: { t: 7, d: [{ id: 'b', sd: 0, sz: '0.0061', px: '85772', sids: ['s1', 's2'] }] } });
  assert.equal(w.length, 1); assert.equal(w[0].t, 7); assert.equal(w[0].taker, 's1'); assert.equal(w[0].maker, 's2');
  assert.equal(U.fmtQty(w[0].size, w[0].lot), '0.00610');     // padded to the lot, as the app pads
  assert.deepEqual(D.wsTrades(p, { data: {} }), []);
});

test('trading fees: a REST fill carries its own, a live fill\'s are worked out from the rates; 24h fees and the OI cap', () => {
  const p = { displayTicker: 'BTC-USD', tickSize: '1', lotSize: '0.00001', takerFee: '0.00005', makerFee: '0' };
  // BTC, Oct 21: 0.00014 at 82,908 paid $0.000580356 as taker, nothing as maker
  const r = D.restTrade(p, { id: 'a', createdAt: 1, takerSide: 1, makerSide: 0, filled: '0.00014', price: '82908', takerFeeUsd: '0.000580356', makerFeeUsd: '0' });
  assert.deepEqual(D.tradeFee(r), { taker: 0.000580356, maker: 0, exact: true });
  const w = D.wsTrades(p, { data: { t: 7, d: [{ id: 'b', sd: 1, sz: '0.00278', px: '82921', sids: ['s1', 's2'] }] } })[0];
  const f = D.tradeFee(w);
  assert.equal(f.exact, false); assert.equal(f.maker, 0);
  assert.ok(Math.abs(f.taker - 0.011526019) < 1e-9, 'the REST history charged this fill $0.011526019');
  // a REST row without the fee fields falls back to the rates too
  assert.equal(D.tradeFee(D.restTrade(p, { id: 'c', filled: '1', price: '100' })).exact, false);
  assert.equal(D.pctT('0.00005'), '0.005%'); assert.equal(D.pctT('0.0025'), '0.25%'); assert.equal(D.pctT('0.02'), '2%'); assert.equal(D.pctT('0'), '0%');
  const fz = D.fees24h([{ volUsd: 1e6, p }, { volUsd: 2e5, p: { takerFee: '0.0001', makerFee: '-0.00001' } }]);
  assert.ok(Math.abs(fz.taker - 70) < 1e-9); assert.ok(Math.abs(fz.maker + 2) < 1e-9);
  // the cap is one side's: openInterest counts longs and shorts, so one side is half of it
  const u = D.oiUse({ maxOpenInterestUsd: '20000000', openInterest: '100' }, 80000);
  assert.equal(u.side, 4e6); assert.equal(u.cap, 2e7); assert.equal(u.share, 0.2);
  assert.equal(D.oiUse({ openInterest: '1' }, 1), null);
});

test('mPerp position fees: the last weekend closure (not a weekday evening hour) and its charges added up', () => {
  const H = 3600000, t = Date.UTC(2026, 9, 20, 21, 30);
  const gaps = [
    { productId: 'xau', startTime: Date.UTC(2026, 9, 16, 21), endTime: Date.UTC(2026, 9, 18, 22) },   // the weekend, 49 h
    { productId: 'xau', startTime: Date.UTC(2026, 9, 19, 21), endTime: Date.UTC(2026, 9, 19, 22) },   // a weekday evening, 1 h
    { productId: 'xau', startTime: Date.UTC(2026, 9, 20, 21), endTime: Date.UTC(2026, 9, 20, 22) },   // still open at t
    { productId: 'xau', startTime: Date.UTC(2026, 9, 9, 21), endTime: Date.UTC(2026, 9, 11, 22) },    // the weekend before
    { productId: 'spy', startTime: Date.UTC(2026, 9, 17, 0), endTime: Date.UTC(2026, 9, 19, 0) },
  ];
  assert.equal(D.lastLongGap(gaps, 'xau', t).endTime, Date.UTC(2026, 9, 18, 22));
  assert.equal(D.lastLongGap(gaps, 'spy', t).startTime, Date.UTC(2026, 9, 17, 0));
  assert.equal(D.lastLongGap(gaps, 'qqq', t), null);
  assert.equal(D.lastLongGap(gaps, 'xau', t, 0.5 * H).endTime, Date.UTC(2026, 9, 19, 22), 'shorter windows count when asked');
  // QQQ, Oct 17-19: 191 charges every 15 minutes; three of them here
  const s = D.chargesSum([{ positionFeeRate: '0.000001', chargePerUnitUsd: '0.000707', cadenceMinutes: 15 }, { positionFeeRate: '0.0000014', chargePerUnitUsd: '0.00099', cadenceMinutes: 15 }, { positionFeeRate: '0', chargePerUnitUsd: '0', cadenceMinutes: 15 }]);
  assert.equal(s.n, 3); assert.equal(s.cadence, 15);
  assert.ok(Math.abs(s.rate - 0.0000024) < 1e-12); assert.ok(Math.abs(s.perUnit - 0.001697) < 1e-12); assert.ok(Math.abs(s.maxRate - 0.0000014) < 1e-12);
  assert.deepEqual(D.chargesSum([]), { n: 0, rate: 0, perUnit: 0, maxRate: 0, cadence: null });
});
