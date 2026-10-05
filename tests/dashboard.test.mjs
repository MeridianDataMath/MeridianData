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
