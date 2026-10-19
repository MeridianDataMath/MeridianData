// Perps analytics: the archive's cumulative fields, interval stats (drawdown net of flows), book slippage, copyability caps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, near } from './_load.mjs';

const MD = load(['js/util.js', 'js/api.js', 'js/analytics.js']);
const AN = MD.analytics, U = MD.util;
const D = U.DAY, T0 = Date.UTC(2026, 8, 1);

test('the archive\'s flow fields are running totals per token: buckets are their differences', () => {
  // day 1: deposit 1,000, realized +50, fee −2 paid; day 2: realized −20 more, withdrawal 100 plus a 1 fee
  const bal = [
    { time: T0, tokenId: 'usd', balance: 1048, realizedPnl: 50, tradingFee: -2, realizedFunding: 0, deposit: 1000, withdrawal: 0, withdrawalFee: 0, depositFee: 0 },
    { time: T0 + D, tokenId: 'usd', balance: 927, realizedPnl: 30, tradingFee: -2, realizedFunding: 0, deposit: 1000, withdrawal: -100, withdrawalFee: -1, depositFee: 0 },
  ];
  const s = AN.buildSeries({ balance: bal, upnl: [{ time: T0, unrealizedPnl: 5 }, { time: T0 + D, unrealizedPnl: 0 }], volume: [] });
  near(assert, s[0].pnl, 48, 1e-9, 'day 1: realized − fee'); near(assert, s[0].deposit, 1000, 1e-9);
  near(assert, s[1].pnl, -20, 1e-9, 'day 2'); near(assert, s[1].withdrawal, 101, 1e-9, 'withdrawal includes its fee'); near(assert, s[1].wfee, 1, 1e-9);
  near(assert, s[0].equity, 1053, 1e-9, 'equity = balance + unrealized');
});

test('mPerp position fees: the balance change no recorded flow explains, counted in PnL', () => {
  // day 1: deposit 1,000, fee 1; day 2: realized +20, fee 1 more, and the balance 10.58 lower than that explains
  const bal = [
    { time: T0, tokenId: 'xau', balance: 999, realizedPnl: 0, tradingFee: -1, realizedFunding: 0, deposit: 1000, withdrawal: 0, withdrawalFee: 0, depositFee: 0, conversionIn: 0, conversionOut: 0 },
    { time: T0 + D, tokenId: 'xau', balance: 1000 + 20 - 2 - 10.58, realizedPnl: 20, tradingFee: -2, realizedFunding: 0, deposit: 1000, withdrawal: 0, withdrawalFee: 0, depositFee: 0, conversionIn: 0, conversionOut: 0 },
  ];
  const s = AN.buildSeries({ balance: bal, upnl: [], volume: [] });
  near(assert, s[0].posFee, 0, 1e-9, 'no residual, no position fee');
  near(assert, s[1].posFee, 10.58, 1e-9, 'paid: positive');
  near(assert, s[1].fee, 1, 1e-9, 'trading fees stay apart');
  near(assert, s[1].pnl, 20 - 1 - 10.58, 1e-9, 'pnl = realized − fee − posFee + funding');
  // the account they are credited to: its balance rises with no flow behind it
  const collector = AN.buildSeries({ balance: [
    { time: T0, tokenId: 'usd', balance: 100, deposit: 100 },
    { time: T0 + D, tokenId: 'usd', balance: 121.62, deposit: 100 },
  ] });
  near(assert, collector[1].posFee, -21.62, 1e-9, 'credited: negative');
  near(assert, collector[1].pnl, 21.62, 1e-9, 'and income in PnL');
  // a conversion between two tokens of one account is a flow on both, not a fee
  const conv = AN.buildSeries({ balance: [
    { time: T0, tokenId: 'a', balance: 500, deposit: 500 }, { time: T0, tokenId: 'b', balance: 0 },
    { time: T0 + D, tokenId: 'a', balance: 300, deposit: 500, conversionOut: -200 }, { time: T0 + D, tokenId: 'b', balance: 200, conversionIn: 200 },
  ] });
  near(assert, conv[1].posFee, 0, 1e-9); near(assert, conv[1].pnl, 0, 1e-9);
  // interval stats: posFees summed over the interval; fees stay trading fees
  const st = AN.intervalStats(s, T0 + D, null, D);
  near(assert, st.posFees, 10.58, 1e-9); near(assert, st.fees, 1, 1e-9); near(assert, st.pnl, 8.42, 1e-9);
  assert.equal(st.fundingCharged, null, 'not netted: no charged-funding figure');
});

test('funding counted when charged: every bucket net of the funding still unsettled at its end', () => {
  const H = U.HOUR;
  const b = (k, o) => Object.assign({ t: T0 + k * H, realizedPnl: 0, fee: 0, posFee: 0, funding: 0, deposit: 0, withdrawal: 0, volume: 0 }, o);
  const fin = (x) => { x.pnl = x.realizedPnl - x.fee - x.posFee + x.funding; x.equity = x.balance + x.upnl; return x; };
  // a long is opened in bucket 1 (fee 1), charged 10 at the start of buckets 1, 2 and 3, and closed in bucket 4 for +4,
  // fee 1, which settles the 30; price uPnL 5, 8, 3 at the ends of buckets 1-3
  const series = [
    fin(b(0, { deposit: 1000, balance: 1000, upnl: 0 })),
    fin(b(1, { fee: 1, balance: 999, upnl: 5 })),
    fin(b(2, { balance: 999, upnl: 8 })),
    fin(b(3, { balance: 999, upnl: 3 })),
    fin(b(4, { realizedPnl: 4, fee: 1, funding: -30, balance: 972, upnl: 0 })),
  ];
  const charges = [1, 2, 3].map((k) => ({ positionId: 'p', time: T0 + k * H, fundingCharge: '10' }));
  const before = JSON.stringify(series);
  const n = AN.netOfUnsettled(series, charges, 0, H);
  assert.equal(JSON.stringify(series), before, 'the input series is not mutated');
  assert.equal(n.netted, true);
  [0, 10, 20, 30, 0].forEach((owed, k) => { near(assert, n[k].upnl, series[k].upnl - owed, 1e-9, 'upnl at bucket ' + k); near(assert, n[k].equity, series[k].equity - owed, 1e-9, 'equity at bucket ' + k); });
  [0, -10, -10, -10, 0].forEach((fc, k) => near(assert, n[k].fundingCharged, fc, 1e-9, 'charged in bucket ' + k));
  // the whole window: realized − fees − the 30 charged + change in price uPnL
  const all = AN.intervalStats(n, T0 + H, null, H);
  near(assert, all.pnl, 4 - 2 - 30 + 0, 1e-9); near(assert, all.fundingCharged, -30, 1e-9); near(assert, all.funding, -30, 1e-9, 'funding stays the settled figure');
  // from bucket 3: the 20 charged before it is not this window's, the 10 charged in it is
  const late = AN.intervalStats(n, T0 + 3 * H, null, H);
  near(assert, late.pnl, 4 - 1 - 10 + (0 - 8), 1e-9); near(assert, late.fundingCharged, -10, 1e-9);
  near(assert, AN.intervalStats(series, T0 + 3 * H, null, H).pnl, -35, 1e-9, 'the archive basis books the 20 inside the window');
  // no charges: the series as it is
  assert.equal(AN.netOfUnsettled(series, null, 0, H), series);
});

test('funding counted when charged: a position still open matches the live net figures', () => {
  const H = U.HOUR;
  const b = (k, o) => { const x = Object.assign({ t: T0 + k * H, realizedPnl: 0, fee: 0, posFee: 0, funding: 0, deposit: 0, withdrawal: 0, volume: 0 }, o); x.pnl = x.realizedPnl - x.fee - x.posFee + x.funding; x.equity = x.balance + x.upnl; return x; };
  const series = [b(0, { deposit: 1000, balance: 1000, upnl: 0 }), b(1, { fee: 1, balance: 999, upnl: 5 }), b(2, { balance: 999, upnl: 8 })];
  const charges = [{ positionId: 'p', time: T0 + H, fundingCharge: 10 }, { positionId: 'p', time: T0 + 2 * H, fundingCharge: 10 }];
  const n = AN.netOfUnsettled(series, charges, 20, H);   // 20 charged, nothing settled
  const live = { upnl: 6 - 20, equity: 999 + 6 - 20 };   // price uPnL 6 now, net of the 20 owed
  near(assert, AN.intervalStats(n, T0 + H, live, H).pnl, live.equity - 1000, 1e-9, 'from the open: equity change');
  const st = AN.intervalStats(n, T0 + 2 * H, live, H);
  near(assert, st.pnl, live.equity - (999 + 5 - 10), 1e-9, 'from bucket 2: live net equity − net equity at its start');
  near(assert, st.pnl, 0 - 0 - 10 + (6 - 5), 1e-9, 'realized − fees − funding charged + change in price uPnL');
  near(assert, st.fundingCharged, -10, 1e-9);
});

test('funding charges: windows of 1 h to 3 days back from now, rows kept once and in time order', async () => {
  const A = MD.api, H = U.HOUR, page = A.page, calls = [];
  // the stub serves one charge per hour from the hour startTime falls in up to endTime (or now), newest window first
  A.page = async (base, p, params) => {
    calls.push(Object.assign({ at: Date.now() }, params));
    const out = []; const end = params.endTime == null ? Date.now() : params.endTime;
    for (let t = Math.floor(params.startTime / H) * H; t <= end; t += H) out.push({ positionId: 'p1', time: t, fundingCharge: '1' }, { positionId: 'p2', time: t, fundingCharge: '-1' });
    return out;
  };
  try {
    const start = Date.now() - 10 * D;
    const rows = await A.fundingCharges('sid', start);
    assert.ok(calls.length >= 4, 'covers 10 days in windows under 3 days');
    assert.equal(calls[0].endTime, null, 'the first window ends at the archive\'s own clock');
    for (const c of calls) { const span = (c.endTime == null ? c.at : c.endTime) - c.startTime; assert.ok(span >= H && span <= 3 * D, 'span ' + span); }
    assert.ok(calls[calls.length - 1].startTime <= start, 'reaches back to start');
    const keys = rows.map((r) => r.positionId + '|' + r.time);
    assert.equal(new Set(keys).size, keys.length, 'no row twice');
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i].time >= rows[i - 1].time, 'ascending');
    const hours = new Set(rows.map((r) => r.time));
    assert.equal(rows.length, 2 * hours.size, 'every hour of both positions');
  } finally { A.page = page; }
});

test('curve points sit at the end of their bucket; the bucket in progress gives way to the live point', () => {
  const row = (t, pnl, upnl, eq) => ({ t, pnl, upnl, equity: eq, deposit: 0, withdrawal: 0, fee: 0, posFee: 0, funding: 0, volume: 0 });
  const series = [row(T0, 0, 0, 1000), row(T0 + D, 10, 0, 1010), row(T0 + 2 * D, -5, 0, 1005)];
  const st = AN.intervalStats(series, T0 + D / 2, null, D);
  assert.deepEqual(st.curve.map((p) => p.t), [T0 + D, T0 + 2 * D, T0 + 3 * D], 'from the previous bucket\'s end, then each bucket\'s end');
  assert.equal(AN.intervalStats(series.slice(1), T0 + D, null, D).curve[0].t, T0 + D, 'no earlier bucket: from the start');
  // hourly, the last bucket still running
  const H = U.HOUR, hs = Math.floor(Date.now() / H) * H;
  const hourly = [row(hs - 2 * H, 0, 0, 500), row(hs - H, 2, 1, 503), row(hs, 1, 3, 506)];
  const t0 = Date.now(); const live = AN.intervalStats(hourly, hs - H, { upnl: 4, equity: 508 }, H); const t1 = Date.now();
  const c = live.curve;
  assert.equal(c.length, 3, 'one point per moment: start, the finished bucket, now');
  assert.equal(c[0].t, hs - H); assert.equal(c[1].t, hs);
  assert.ok(c[2].t >= t0 && c[2].t <= t1, 'the live point at now');
  near(assert, c[2].v - c[0].v, 2 + 1 + (4 - 0), 1e-9, 'the live point carries the running bucket\'s realized and the live uPnL');
  near(assert, live.pnl, c[2].v - c[0].v, 1e-9);
  // the last bucket finished: the live point comes after it
  const done = AN.intervalStats(hourly.slice(0, 2), hs - H, { upnl: 4, equity: 508 }, H);
  assert.equal(done.curve.length, 3); assert.equal(done.curve[1].t, hs);
});

test('exit levels: a partly filled reduce-only exit counts only its unfilled part', () => {
  // long 7 left after 4 of a reduce-only sell of 10 filled (availableQuantity is not reduced by fills)
  const pos = () => ({ p: { productId: 'HYPE' }, long: true, abs: 7, entry: 93.6955, mark: 95 });
  const order = (filled) => ({ productId: 'HYPE', side: '1', status: 'FILLED_PARTIAL', reduceOnly: true, price: '100', quantity: '10', availableQuantity: '10', filled: String(filled), stopPrice: '0' });
  const [r] = AN.attachStops([pos()], [order(4)]);
  assert.equal(r.tp.length, 1); near(assert, r.tp[0].qty, 6, 1e-12); near(assert, r.tp[0].pnl, 6 * (100 - 93.6955), 1e-9);
  const [gone] = AN.attachStops([pos()], [order(10)]);
  assert.equal(gone.tp.length + gone.sl.length, 0, 'a fully consumed remainder is not an exit');
  const [all] = AN.attachStops([pos()], [Object.assign(order(0), { quantity: '0', availableQuantity: '0', close: true })]);
  assert.equal(all.tp[0].qty, null, 'a close-all order still covers the whole position');
});

test('stop map: each position counts once, at the exits the price reaches first; liquidations apart from the stops', () => {
  // a level as the Dashboard's scan makes it (flow: what it does when reached)
  const lv = (pos, posQty, kind, price, qty, side) => ({ pos, posQty, kind, price, qty, posSide: side, mech: kind === 'LIQ' ? 'liq' : 'stop',
    flow: kind === 'ENTRY' ? (side === 'long' ? 'buy' : 'sell') : side === 'long' ? 'sell' : 'buy' });
  // QQQ, 10-19: a long's two stop-losses at 705 sit behind its liquidation at 712.76: it is liquidated first, they never fire
  const qLiq = lv('q', 0.14, 'LIQ', 712.76, 0.14, 'long'), qSl = [lv('q', 0.14, 'SL', 705, 0.14, 'long'), lv('q', 0.14, 'SL', 705, 0.14, 'long')];
  const qf = AN.stopFires([qSl[0], qLiq, qSl[1]], 718.76);
  near(assert, qf.get(qLiq), 0.14, 1e-12); assert.equal(qf.get(qSl[0]), 0); assert.equal(qf.get(qSl[1]), 0);
  const qp = AN.stopPressure([qSl[0], qLiq, qSl[1]], 718.76, 2, qf);
  assert.equal(qp.sells, 0, 'no stop sells'); near(assert, qp.liqDown, 0.14 * 712.76, 1e-9, 'the long is liquidated, apart');
  near(assert, AN.stopPressure([qSl[0], qLiq, qSl[1]], 718.76, 2).sells, 2 * 0.14 * 705, 1e-9, 'without fires: every level whole, as before');
  // SPY, 10-19: a long's whole-position stop at 750.94 closes it before its liquidation at 748.56; its take-profit above
  // is not counted (it sells into a rise, against the move)
  const sTp = lv('s', 9.141, 'TP', 780.44, 9.141, 'long'), sSl = lv('s', 9.141, 'SL', 750.94, 9.141, 'long'), sLiq = lv('s', 9.141, 'LIQ', 748.56, 9.141, 'long');
  const sf = AN.stopFires([sLiq, sTp, sSl], 767.33);
  near(assert, sf.get(sSl), 9.141, 1e-12); assert.equal(sf.get(sLiq), 0); near(assert, sf.get(sTp), 9.141, 1e-12, 'the other side has its own walk');
  const sp = AN.stopPressure([sLiq, sTp, sSl], 767.33, 5, sf);
  near(assert, sp.sells, 9.141 * 750.94, 1e-9); assert.equal(sp.liqDown, 0); assert.equal(sp.buys, 0, 'a take-profit is not a buy or a sell here');
  // partial stops take their part in the order the price reaches them; the liquidation takes what is left
  const p1 = lv('p', 10, 'SL', 98, 4, 'long'), p2 = lv('p', 10, 'SL', 96, 4, 'long'), p3 = lv('p', 10, 'SL', 94, 4, 'long'), pLiq = lv('p', 10, 'LIQ', 95, 10, 'long');
  const pf = AN.stopFires([p3, pLiq, p2, p1], 100);
  assert.deepEqual([pf.get(p1), pf.get(p2), pf.get(pLiq), pf.get(p3)], [4, 4, 2, 0]);
  const pp = AN.stopPressure([p1, p2, p3, pLiq], 100, 5, pf);
  near(assert, pp.sells, 4 * 98 + 4 * 96, 1e-9); near(assert, pp.liqDown, 2 * 95, 1e-9);
  // a stop at the liquidation price goes first; shorts above the mark buy; an entry stop has no position and fires whole
  const tSl = lv('t', 2, 'SL', 103, 2, 'short'), tLiq = lv('t', 2, 'LIQ', 103, 2, 'short'), uLiq = lv('u', 1, 'LIQ', 101, 1, 'short');
  const entry = { kind: 'ENTRY', price: 102, qty: 3, posSide: 'long', mech: 'stop', flow: 'buy' };
  const tf = AN.stopFires([tLiq, tSl, uLiq, entry], 100);
  near(assert, tf.get(tSl), 2, 1e-12); assert.equal(tf.get(tLiq), 0); near(assert, tf.get(entry), 3, 1e-12);
  const tp = AN.stopPressure([tLiq, tSl, uLiq, entry], 100, 5, tf);
  near(assert, tp.buys, 2 * 103 + 3 * 102, 1e-9); near(assert, tp.liqUp, 101, 1e-9); assert.equal(tp.sells + tp.liqDown, 0);
  // the band's edge: 2% holds what is within 2% and nothing past it
  const tp2 = AN.stopPressure([tLiq, tSl, uLiq, entry], 100, 2, tf);
  near(assert, tp2.buys, 3 * 102, 1e-9, 'the stop at +3% is outside'); near(assert, tp2.liqUp, 101, 1e-9);
});

test('liquidation map: the bankruptcy price, and the jump that would drain the liquidator\'s pool', () => {
  // an isolated 50x SPY long (k = 1/(2·50) + the 0.005% taker fee): its margin is gone k below its liquidation price
  const ST = '0xspy';
  const ref = { byId: { spy: { id: 'spy', displayTicker: 'SPY-USD', quoteTokenAddress: ST, quoteTokenName: 'SPY', maxLeverage: 50, takerFee: '0.00005' } } };
  const st = AN.accountState({ balances: [{ tokenAddress: ST, tokenName: 'SPY', amount: '700', available: '0', totalUsed: '700' }],
    positions: [{ productId: 'spy', size: '20', cost: '15000', fundingUsd: '0', positionFeeUsd: '0' }], ref, prices: { spy: { oraclePrice: '760' } } });
  const r = st.positions[0], k = 1 / 100 + 0.00005;
  near(assert, AN.bankruptcyPrice(r), 760 - (700 + 20 * (760 - 750)) / 20, 1e-9, 'where the pool\'s equity is 0');
  near(assert, AN.bankruptcyPrice(r), r.liqPrice * (1 - k), 1e-9, 'alone in its pool: the liquidation price × (1 − k)');
  // a jump past the bankruptcy price costs the liquidator the difference: 10 × (94 − x) > 47.5 from x < 89.25, so the
  // first 0.1 step past it is 10.8%
  const L = (side, price, bk, qty) => ({ posSide: side, price, bk, qty });
  assert.deepEqual(AN.liquidatorDrain([L('long', 95, 94, 10)], 100, 47.5), { down: 10.8, up: null });
  // a position the jump liquidates before its margin is gone pays the liquidator what was left, which covers the others
  assert.equal(AN.liquidatorDrain([L('long', 95, 94, 10), L('long', 90, 50, 10)], 100, 47.5).down, null, 'a gain of 10 × (x − 50) outweighs it');
  // shorts on a rise; an empty pool drains on any loss; none past max
  assert.deepEqual(AN.liquidatorDrain([L('short', 105, 106, 10)], 100, 47.5), { down: null, up: 10.8 });
  assert.equal(AN.liquidatorDrain([L('short', 105, 106.05, 10)], 100, 0).up, 6.1, 'an empty pool: any loss at all');
  assert.equal(AN.liquidatorDrain([L('long', 50, 49, 10)], 100, 47.5).down, null, 'over 30%: not within it');
  assert.equal(AN.liquidatorDrain([L('long', 50, 49, 10)], 100, 47.5, 60).down, 55.8);
});

test('drawdown and PnL ignore deposits and withdrawals', () => {
  const row = (t, pnl, dep, wd, bal) => ({ t, pnl, deposit: dep, withdrawal: wd, balance: bal, upnl: 0, equity: bal, fee: 0, funding: 0, volume: 0 });
  // start 1,000; lose 100; deposit 500 (not a gain); lose 50; withdraw 400 (not a loss)
  const series = [row(T0, 0, 0, 0, 1000), row(T0 + D, -100, 0, 0, 900), row(T0 + 2 * D, 0, 500, 0, 1400), row(T0 + 3 * D, -50, 0, 0, 1350), row(T0 + 4 * D, 0, 0, 400, 950)];
  const st = AN.intervalStats(series, T0 + D, null, D);
  near(assert, st.pnl, -150, 1e-9, 'PnL = trading only');
  near(assert, st.ddUsd, 150, 1e-9, 'drawdown in USD = trading losses since the peak');
  near(assert, st.deposits, 500, 1e-9); near(assert, st.withdrawals, 400, 1e-9);
  near(assert, st.roi, (-150 / (1000 + 500)) * 100, 1e-9, 'ROI on starting equity + deposits');
  // time-weighted: −100 on 1,000 (−10 %), then −50 on 1,400 (−3.57 %) compound to 13.21 %
  near(assert, st.ddPct, (1 - 0.9 * (1 - 50 / 1400)) * 100, 1e-9, 'drawdown % compounds the returns on the capital at the time');
});

test('losing a little and then withdrawing the rest is a small drawdown, not 100 %', () => {
  const row = (t, pnl, dep, wd, bal) => ({ t, pnl, deposit: dep, withdrawal: wd, balance: bal, upnl: 0, equity: bal, fee: 0, funding: 0, volume: 0 });
  // 0xf92a…: deposited 184, lost 30.59, withdrew everything
  const series = [row(T0, 0, 184, 0, 184), row(T0 + D, -30.59, 0, 0, 153.41), row(T0 + 2 * D, 0, 0, 153.41, 0)];
  const st = AN.intervalStats(series, T0, null, D);
  near(assert, st.ddPct, (30.59 / 184) * 100, 1e-9);
  near(assert, st.ddUsd, 30.59, 1e-9);
});

test('book slippage walks the book from the mid; an order the book cannot absorb has no price', () => {
  const book = { asks: [[101, 10], [102, 10]], bids: [[99, 10], [98, 10]] };   // mid 100
  const buy = AN.bookSlippage(book, true, 1010 + 510);   // 10 @ 101, then 5 @ 102
  near(assert, buy.bps, ((1520 / 15 - 100) / 100) * 1e4, 1e-6, 'average price vs mid');
  const huge = AN.bookSlippage(book, true, 1e6);
  assert.equal(huge.bps, null); near(assert, huge.filled, 2030 / 1e6, 1e-9, 'share it could fill');
});

// a profile that is copyable on every count; each test breaks one thing and expects its limit
const good = () => ({ stats: { all: { pnl: 5000, roi: 25, ddPct: 8 } }, copy: { closed: 60, hold: { scalp: 2, intra: 10, swing: 40, long: 8 }, holdMed: 2 * D, tStat: 5, netTrimBps: 60, weeksActive: 12, weeksPos: 10, liq: 0, top: 12, edgeLeft: 85, slipBps: 2, copySize: 2000, notMed: 3000, slipOwnBps: 3, depthOk: 100, notP90: 6000, lastAt: Date.now() - D, perWeek: 5, tenureD: 120 } });
const with_ = (patch, stats) => { const r = good(); Object.assign(r.copy, patch); if (stats) Object.assign(r.stats.all, stats); return r; };

test('copyability: results first; a profitable, steady account is Copyable and a bigger result scores higher', () => {
  const sc = AN.copyScore(good()); assert.equal(sc.verdict, 'Copyable'); assert.ok(sc.total >= AN.COPY.copyableAt, 'score ' + sc.total);
  assert.ok(AN.copyScore(with_({}, { pnl: 50000 })).total > AN.copyScore(with_({}, { pnl: 1000 })).total, 'more PnL, higher score');
  // a scalper with a thin edge but a big result stays copyable: friction is a fifth of the score, not a veto
  const busy = AN.copyScore(with_({ hold: { scalp: 50, intra: 10, swing: 0, long: 0 }, edgeLeft: 20, tStat: 1 }, { pnl: 20000, roi: 60 }));
  assert.equal(busy.verdict, 'Copyable', 'score ' + busy.total);
});

test('copyability limits: only the hard ones cap the score, each with its reason; a small winner is listed, never Copyable', () => {
  const cases = [
    [with_({}, { pnl: -10 }), 30, /not profitable/],
    [with_({ lastAt: Date.now() - 45 * D }), 50, /no trade for 45 days/],
    [with_({}, { ddPct: 65 }), 50, /max drawdown/],
    [with_({ liq: 15 }), 50, /15 of 60 positions ended in liquidation/],
    [with_({}, { pnl: 120 }), AN.COPY.copyableAt - 1, /under \$500 made all-time/],
  ];
  for (const [row, at, why] of cases) {
    const sc = AN.copyScore(row);
    assert.ok(sc.total <= at, `${why}: ${sc.total} > ${at}`);
    assert.ok(sc.caps.some((x) => x.at === at && why.test(x.why)), `${why}: reason shown`);
  }
  assert.equal(AN.copyScore(with_({}, { pnl: -10 })).verdict, 'Losing so far');
  assert.notEqual(AN.copyScore(with_({}, { pnl: 120 })).verdict, 'Copyable');
  assert.equal(AN.copyScore(with_({ closed: 2 })), null, 'fewer than 3 closed: no score');
  assert.ok(AN.copyScore(with_({ closed: 3 })), '3 closed: scored');
  // no longer limits: few positions, a noisy mean, one jackpot, sizes beyond the books, a thin edge left
  for (const row of [with_({ closed: 8 }), with_({ tStat: 1.2 }), with_({ top: 70 }), with_({ depthOk: 30 }), with_({ edgeLeft: 30 })]) assert.equal(AN.copyScore(row).caps.length, 0);
});

test('copyability: a leader without a positive per-position result says so in its friction; nothing capped keeps raw = total', () => {
  const sc = AN.copyScore(with_({ leaderBps: -3, copyBps: -1, edgeLeft: 0 }));
  assert.match(sc.parts.find((p) => p.key === 'edge').note, /do not make money/);
  assert.ok(sc.raw >= sc.total, `raw ${sc.raw} ≥ total ${sc.total}`);
  // a copier who keeps more than the leader: no ratio as a "share"
  assert.match(AN.copyScore(with_({ leaderBps: 0.1, copyBps: 3.6, edgeLeft: 3600 })).parts.find((p) => p.key === 'edge').note, /keeps more per position than the leader \(3\.6 vs 0\.1 bps\)/);
  const plain = AN.copyScore(good()); assert.equal(plain.caps.length, 0); assert.equal(plain.raw, plain.total, 'nothing capped: raw = total');
});

test('copyability notes say which PnL they read: Meridian\'s on a row with that basis, the site\'s net figure on an older one', () => {
  const app = Object.assign(good(), { basis: 'app' });
  assert.match(AN.copyScore(app).parts.find((p) => p.key === 'profit').note, /^all-time PnL \+\$5,000 \(as Meridian's app\) \(\$10,000\+ for full marks\)$/);
  assert.match(AN.copyScore(good()).parts.find((p) => p.key === 'profit').note, /\(the site's net figure\)/);
  assert.match(AN.copyScore(Object.assign(with_({}, { pnl: -10 }), { basis: 'app' })).parts.find((p) => p.key === 'profit').note, /^not profitable so far \(as Meridian's app\)$/);
  assert.match(AN.copyScore(app).parts.find((p) => p.key === 'dd').note, /on the site's net PnL/);
  assert.match(AN.copyScore(good()).parts.find((p) => p.key === 'steady').note, /weeks start Monday 00:00 UTC/);
});

// ---- the copy profile (AN.buildCopyProfile) on closed positions of $1,000 entry each
const P_ID = 'p';
const cref = { byTicker: {}, byId: { [P_ID]: { id: P_ID, ticker: 'PUSD', displayTicker: 'P-USD', takerFee: '0.00005' } } };
const closedPos = (i, o) => Object.assign({ id: 'x' + i, productId: P_ID, side: '0', size: '0', totalIncreaseQuantity: '10', totalDecreaseQuantity: '10', totalIncreaseNotional: '1000', totalDecreaseNotional: '1000', realizedPnl: '0', feesAccruedUsd: '0', positionFeeAccruedUsd: '0', fundingAccruedUsd: '0', createdAt: T0 + i * 3600000, updatedAt: T0 + i * 3600000 + 600000 }, o);
const atBps = (b) => String((b / 1e4) * 1000);   // a result in bps of the $1,000 entry, as USD
const tight = { asks: [[100.01, 1e6]], bids: [[99.99, 1e6]] };   // mid 100, 1 bps each side at any size

test('copy profile: winsorized from 10 positions, one position on each side at 20, the plain mean below 10', () => {
  const nine = [0, 1, 2, 3, 4, 5, 6, 7, 1000].map((b, i) => closedPos(i, { realizedPnl: atBps(b) }));
  const p9 = AN.buildCopyProfile({ positions: nine, ref: cref });
  assert.equal(p9.nTrim, 9); near(assert, p9.netTrimBps, Math.round(((28 + 1000) / 9) * 10) / 10, 1e-9, 'plain mean: the 1,000 stays');
  const twenty = [-500].concat(Array.from({ length: 18 }, (_, i) => i + 1), [500]).map((b, i) => closedPos(i, { realizedPnl: atBps(b) }));
  const p20 = AN.buildCopyProfile({ positions: twenty, ref: cref });
  assert.equal(p20.nTrim, 20);
  near(assert, p20.netTrimBps, (1 + 171 + 18) / 20, 1e-9, '−500 → 1 and 500 → 18: one clipped on each side');
  near(assert, p20.grossTrimBps, 9.5, 1e-9);
});

test('copy profile: the 90th percentile by nearest rank, weeks from Monday 00:00 UTC', () => {
  const ten = Array.from({ length: 10 }, (_, i) => closedPos(i, { totalIncreaseNotional: String((i + 1) * 100) }));
  const p = AN.buildCopyProfile({ positions: ten, ref: cref });
  assert.equal(p.notP90, 900, 'the 9th of 10, not the largest'); assert.equal(p.notMed, 550);
  // Sat 26 and Sun 27 Sep 2026 against Mon 28 and Tue 29: two weeks, one profitable (Thursday weeks made it one)
  const MON = Date.UTC(2026, 8, 28); assert.equal(new Date(MON).getUTCDay(), 1);
  const day = (t, pnl) => ({ t, pnl, upnl: 0, volume: 100 });
  const w = AN.buildCopyProfile({ positions: ten, ref: cref, daily: [day(MON - 2 * D, 10), day(MON - D, 10), day(MON, -5), day(MON + D, -5)] });
  assert.equal(w.weeksActive, 2); assert.equal(w.weeksPos, 1);
});

test('book slippage within a band: depth for big trades counts only the asks within 1% of the mid', () => {
  const book = { asks: [[100.5, 0.1], [110, 100]], bids: [[99.5, 100]] };   // mid 100: $10.05 within 1%, the rest 10% out
  const wide = AN.bookSlippage(book, true, 1005);
  assert.equal(wide.filled, 1, 'fills within 20%'); assert.ok(wide.bps > 100, 'at more than 1% on average');
  const near1 = AN.bookSlippage(book, true, 1005, 0.01);
  near(assert, near1.filled, 0.01, 1e-9); assert.equal(near1.bps, null);
  const p = AN.buildCopyProfile({ positions: Array.from({ length: 5 }, (_, i) => closedPos(i, { totalIncreaseNotional: '1005' })), ref: cref, depth: { [P_ID]: book } });
  assert.equal(p.depthOk, 1, '1% of a 90th-percentile order fills within 1%');
});

test('copy profile: position fees stay in the result, only trading fees are swapped; edge left from the unrounded means', () => {
  // 50 bps gross, 5 bps trading fees, 2 bps position fees: 43 bps kept
  const pos = Array.from({ length: 5 }, (_, i) => closedPos(i, { realizedPnl: atBps(50), feesAccruedUsd: atBps(5), positionFeeAccruedUsd: atBps(2) }));
  const decays = { drift1: 1, drift5: 2, n: 10 };
  const p = AN.buildCopyProfile({ positions: pos, ref: cref, depth: { [P_ID]: tight }, decays });
  near(assert, p.netTrimBps, 43, 1e-9); near(assert, p.feesBps, 5, 1e-9); near(assert, p.posFeeBps, 2, 1e-9);
  near(assert, p.feeBps, 0.5, 1e-9); near(assert, p.slipBps, 1, 1e-9);
  near(assert, p.copyBps, 43 + 5 - 2 * (0.5 + 1 + 1), 1e-9, 'the copier pays the position fees too');
  // a leader result of 0.07 bps rounds to 0.1: the ratio is taken on 0.07 (5,100%), not on the rounded 0.1 (3,600%)
  const thin = Array.from({ length: 5 }, (_, i) => closedPos(i, { realizedPnl: atBps(4.57), feesAccruedUsd: atBps(4.5) }));
  const q = AN.buildCopyProfile({ positions: thin, ref: cref, depth: { [P_ID]: tight }, decays: { drift1: -1, drift5: 0, n: 10 } });
  near(assert, q.leaderBps, 0.1, 1e-9); near(assert, q.copyBps, 3.6, 1e-9, 'the waterfall line from the rounded rows');
  near(assert, q.edgeLeft, 5100, 0.5);
});

test('price drift: exactly one and five minutes after the fill, a fill far off the oracle left out', async () => {
  const M = 60000, T = Math.floor((Date.now() - 3600000) / M) * M;   // a closed hour
  const closes = new Map([['P|' + T, 100.5], ['P|' + (T + M), 101], ['P|' + (T + 4 * M), 102], ['P|' + (T + 5 * M), 104]]);
  for (let k = 0; k < 10; k++) closes.set('BTC|' + (T + k * M), 81000);
  const candles = { at: async (tk, t) => { const v = closes.get(tk + '|' + Math.floor(t / M) * M); return v == null ? null : v; } };
  const ref = { byId: { p: { ticker: 'P' }, btc: { ticker: 'BTC' } } };
  const fills = [
    { productId: 'p', side: 0, price: '100', filled: '1', createdAt: T + 20000 },
    { productId: 'btc', side: 1, price: '1', filled: '0.00047', createdAt: T + 30000 },   // a market sell that hit a $1 bid
  ];
  const d = await AN.fillDrift(fills, ref, candles);
  assert.equal(d.n, 1, 'the $1 fill is left out');
  // 80 s after the minute start: a third of the way from the 100.5 close to the 101 close; 320 s: from 102 to 104
  near(assert, d.drift1, Math.round(((100.5 + 0.5 / 3 - 100) / 100) * 1e5) / 10, 1e-9);
  near(assert, d.drift5, Math.round(((102 + 2 / 3 - 100) / 100) * 1e5) / 10, 1e-9);
  // a fill whose five-minute mark falls in a minute that has not closed yet is not measured yet
  const fresh = await AN.fillDrift([{ productId: 'p', side: 0, price: '100', filled: '1', createdAt: Date.now() - 90000 }], ref, { at: async () => 100 });
  assert.equal(fresh.n, 0);
});

test('market categories as Hyperliquid files them: a cross market is crypto; an mPerp an index, commodity, currency or pre-IPO by name, else a stock', () => {
  const cat = (base, mode = 'ISOLATED') => AN.marketCategory({ baseTokenName: base, marginMode: mode });
  assert.deepEqual(AN.MARKET_CATS.map(([k]) => k), ['crypto', 'stocks', 'indices', 'commodities', 'fx', 'preipo'], 'Hyperliquid\'s order: Crypto, then its Tradfi tabs');
  // Meridian's markets in October 2026
  for (const b of ['BTC', 'ETH', 'SOL', 'HYPE', 'NEAR', 'ZEC', 'VVV', 'ENA', 'LIT']) assert.equal(cat(b, 'CROSS'), 'crypto', b);
  assert.equal(cat('SPY'), 'indices', 'the S&P 500 (Hyperliquid: US500, SP500)'); assert.equal(cat('QQQ'), 'indices', 'the Nasdaq-100 (USTECH, XYZ100)');
  assert.equal(cat('XAU'), 'commodities', 'gold'); assert.equal(cat('xag'), 'commodities', 'silver, in any letter case');
  assert.equal(cat('EUR'), 'fx'); assert.equal(cat('OPENAI'), 'preipo');
  assert.equal(cat('TSLA'), 'stocks', 'an mPerp not named above'); assert.equal(cat('SMH'), 'stocks', 'a sector fund, as on Hyperliquid');
  assert.equal(cat('GAS', 'CROSS'), 'crypto', 'a cross market is crypto whatever its name'); assert.equal(AN.marketCategory({}), 'crypto');
});

test('size outside Meridian: a coin\'s CoinGecko cap at its price, metals and index funds from the mark, the rest by their usual size', () => {
  const A = MD.api;
  const p = (base, mode = 'CROSS') => ({ baseTokenName: base, marginMode: mode });
  // CoinGecko's rows: the largest coin of each symbol counts; a symbol it does not return is null
  const caps = A.parseMarketCaps([{ symbol: 'lit', id: 'lighter', market_cap: 7.4e8, current_price: 2.96 }, { symbol: 'lit', id: 'litentry', market_cap: 3e7, current_price: 0.6 }, { symbol: 'btc', id: 'bitcoin', market_cap: 1.6e12, current_price: 81000 }], ['BTC', 'LIT', 'VVV']);
  assert.deepEqual(caps.LIT, { mcap: 7.4e8, price: 2.96, id: 'lighter' }); assert.equal(caps.VVV, null);
  assert.deepEqual(AN.marketSize(p('BTC'), caps, 81500), { usd: 1.6e12, src: 'coingecko' });
  // a coin of that symbol at another price is another coin: its last known size orders it instead
  assert.equal(AN.marketSize(p('LIT'), caps, 0.6).src, 'hint');
  assert.equal(AN.marketSize(p('VVV'), caps, 22).src, 'hint', 'not answered: the last known size');
  // gold and silver: the metal above ground at the mark
  const gold = AN.marketSize(p('XAU', 'ISOLATED'), null, 4000), silver = AN.marketSize(p('XAG', 'ISOLATED'), null, 50);
  assert.equal(gold.src, 'metal'); near(assert, gold.usd, 216265 * 32150.75 * 4000, 1);
  assert.ok(gold.usd > silver.usd);
  // indices by their companies\' value: the S&P 500 before the Nasdaq-100; nothing known: null
  assert.ok(AN.marketSize(p('SPY', 'ISOLATED')).usd > AN.marketSize(p('QQQ', 'ISOLATED')).usd);
  // an index fund at its mark: the value of its shares, still ranked by its index like any index market
  const spy = AN.marketSize(p('SPY', 'ISOLATED'), null, 768), qqq = AN.marketSize(p('QQQ', 'ISOLATED'), null, 719);
  assert.equal(spy.src, 'fund'); near(assert, spy.usd, 1066480000 * 768, 1); near(assert, qqq.usd, 674900000 * 719, 1);
  assert.ok(spy.order > qqq.order); assert.equal(spy.order, AN.marketSize(p('US500', 'ISOLATED')).usd, 'the same index as US500');
  assert.equal(AN.marketSize(p('NEWCOIN'), caps, 1), null);
  // Meridian\'s crypto markets in October 2026, without CoinGecko: the largest first
  const order = ['LIT', 'ENA', 'BTC', 'HYPE', 'SOL', 'ETH', 'ZEC', 'NEAR', 'VVV'].sort((a, b) => AN.marketSize(p(b)).usd - AN.marketSize(p(a)).usd);
  assert.deepEqual(order, ['BTC', 'ETH', 'SOL', 'ZEC', 'HYPE', 'NEAR', 'ENA', 'VVV', 'LIT']);
});

test('the market maker is known by its wallet, in any letter case, so the home page\'s top wallets leave it out', () => {
  assert.ok(AN.marketMaker({ account: '0x2F46C3FCE6BDA596C2771BCA618C4F69AE3E56B2', sid: 'any' }));
  assert.equal(AN.marketMaker({ account: '0xa6b9cf0000000000000000000000000000000000' }), null);
  assert.equal(AN.marketMaker({}), null); assert.equal(AN.marketMaker(null), null);
});

test('Meridian\'s own accounts are named by wallet (the liquidator, the fee collector) and flagged on their rows', async () => {
  const EX = '01a047c4-2be2-774c-ae58-1e45d2f2a99d', FEES = '01a047c4-2bd1-70db-9c88-6b93739534a5';
  const LIQ_W = '0x15982b91cfbcb0ef69d8d4c4c98c0003881917f7', FEES_W = '0xff68fda91b0e785b4aee674d3b428c4ab6d8eaa7';
  assert.equal(AN.known({ account: LIQ_W.toUpperCase().replace('0X', '0x') }).label, 'Meridian liquidator account');
  assert.equal(AN.known({ account: FEES_W }).label, 'Meridian fee collector');
  assert.equal(AN.known({ account: '0x2f46c3fce6bda596c2771bca618c4f69ae3e56b2' }).label, 'Market maker');
  assert.ok(AN.exchangeAccount({ account: FEES_W })); assert.equal(AN.marketMaker({ account: FEES_W }), null);
  // a row with no wallet: only the liquidator's subaccount id is known
  assert.ok(AN.exchangeAccount({ sid: EX })); assert.equal(AN.exchangeAccount({ sid: FEES }), null); assert.equal(AN.exchangeAccount(null), null);
  // an empty account takes the inactive path, so no archive is needed; the flags are set either way
  const A = MD.api, saved = { balances: A.balances, openPositions: A.openPositions, totalVolume: A.totalVolume };
  Object.assign(A, { balances: async () => [], openPositions: async () => [], totalVolume: async () => 0 });
  try {
    const ref = { byId: {}, active: [] };
    const row = await AN.buildLeaderboardRow({ id: EX, account: LIQ_W, createdAt: T0 }, ref, {}, {});
    assert.equal(row.exchange, true); assert.equal(row.role, 'Meridian liquidator account'); assert.equal(row.inactive, true);
    const fees = await AN.buildLeaderboardRow({ id: FEES, account: FEES_W, createdAt: T0 }, ref, {}, {});
    assert.equal(fees.exchange, true); assert.equal(fees.role, 'Meridian fee collector');
    const other = await AN.buildLeaderboardRow({ id: 'x', account: '0x' + '1'.repeat(40), createdAt: T0 }, ref, {}, {});
    assert.equal('exchange' in other, false, 'an ordinary row gains no field'); assert.equal('role' in other, false);
  } finally { Object.assign(A, saved); }
});
