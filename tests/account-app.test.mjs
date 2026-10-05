// The account page against Meridian's app: mPerp position fees counted when charged (so an interval books only the fees
// charged inside it), the account state as the app shows it (available never below 0 per pool, leverage on the balance,
// margin ratio = maintenance ÷ equity), and the order book's centre and Total.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, near } from './_load.mjs';

const MD = load(['js/util.js', 'js/api.js', 'js/analytics.js']);
const AN = MD.analytics, U = MD.util, A = MD.api;
const H = U.HOUR, D = U.DAY, T0 = Date.UTC(2026, 9, 1);   // after the mPerps opened (AN.POSITION_FEE_START)

// an hourly series as AN.buildSeries leaves it: price uPnL per bucket, a settled position fee where given
const bucket = (k, o) => { const x = Object.assign({ t: T0 + k * H, balance: 1000, upnl: 0, realizedPnl: 0, fee: 0, posFee: 0, funding: 0, deposit: 0, withdrawal: 0, volume: 0 }, o); x.pnl = x.realizedPnl - x.fee - x.posFee + x.funding; x.equity = x.balance + x.upnl; return x; };
const charge = (t, v) => ({ positionId: 'xau', time: t, positionFeeCharge: String(v) });

test('position fees counted when charged: a window books the fees charged inside it, not every fee still owed', () => {
  // an XAU long opened 10 minutes into bucket 1, charged 10, 10, 5 and 1 in buckets 2 to 5 and never settled (26 owed
  // now); its price PnL is 5 at every bucket's end
  const series = [0, 1, 2, 3, 4, 5].map((k) => bucket(k, { upnl: k ? 5 : 0, deposit: k ? 0 : 1000 }));
  const pf = { charges: [charge(T0 + 2 * H, 10), charge(T0 + 3 * H, 10), charge(T0 + 4 * H + 15 * 60000, 5), charge(T0 + 5 * H, 1)], owed: 26, from: T0 + H + 600000 };
  const before = JSON.stringify(series);
  const n = AN.netOfUnsettled(series, null, 0, H, pf);
  assert.equal(JSON.stringify(series), before, 'the input series is not mutated');
  assert.equal(n.posNetted, true); assert.equal(n.netted, undefined, 'no funding charges: funding keeps its settled basis');
  [0, 0, 10, 20, 25, 26].forEach((owed, k) => near(assert, n[k].upnl, series[k].upnl - owed, 1e-9, 'owed at the end of bucket ' + k));
  [0, 0, 10, 10, 5, 1].forEach((c, k) => near(assert, n[k].posFeeCharged, c, 1e-9, 'charged in bucket ' + k));
  const live = { upnl: 6 - 26, equity: 1000 + 6 - 26 };   // price PnL 6 now, net of the 26 owed
  // from bucket 4: the 5 and the 1 charged in it, not the 20 charged before it began (the archive basis booked all 26)
  const late = AN.intervalStats(n, T0 + 4 * H, live, H);
  near(assert, late.pnl, (6 - 5) - 6, 1e-9); near(assert, late.posFeesCharged, 6, 1e-9); near(assert, late.posFees, 0, 1e-9, 'none settled');
  near(assert, AN.intervalStats(series, T0 + 4 * H, live, H).pnl, (6 - 5) - 26, 1e-9, 'unnetted: the whole fee owed now');
  // from before the position opened: the same either way, every fee charged is in it
  const all = AN.intervalStats(n, T0 + H, live, H);
  near(assert, all.pnl, AN.intervalStats(series, T0 + H, live, H).pnl, 1e-9, 'a window from before the first charge is unchanged');
  near(assert, all.pnl, 6 - 26, 1e-9); near(assert, all.posFeesCharged, 26, 1e-9);
  // no position-fee charges: the series as it is
  assert.equal(AN.netOfUnsettled(series, null, 0, H, null), series);
  assert.equal(AN.netOfUnsettled(series, null, 0, H, { charges: null, owed: 26, from: T0 }), series, 'unreadable charges');
  assert.equal(AN.intervalStats(series, T0, live, H).posFeesCharged, null, 'unnetted: no charged figure');
});

test('position fees counted when charged: a fill settles what was owed, and each fee stays on the bucket it was charged in', () => {
  // charged 10 and 10 in buckets 2 and 3; a partial close in bucket 4 settles those 20 (posFee), then 5 more in bucket 4
  // and 1 in bucket 5 (6 owed now)
  const series = [0, 1, 2, 3, 4, 5].map((k) => bucket(k, { upnl: k ? 5 : 0, posFee: k === 4 ? 20 : 0, balance: k >= 4 ? 980 : 1000 }));
  const pf = { charges: [charge(T0 + 2 * H, 10), charge(T0 + 3 * H, 10), charge(T0 + 4 * H + 30 * 60000, 5), charge(T0 + 5 * H, 1)], owed: 6, from: T0 + H };
  const n = AN.netOfUnsettled(series, null, 0, H, pf);
  [0, 0, 10, 20, 5, 6].forEach((owed, k) => near(assert, n[k].upnl, series[k].upnl - owed, 1e-9, 'owed at the end of bucket ' + k));
  [0, 0, 10, 10, 5, 1].forEach((c, k) => near(assert, n[k].posFeeCharged, c, 1e-9, 'charged in bucket ' + k));
  const live = { upnl: 5 - 6, equity: 980 + 5 - 6 };
  const late = AN.intervalStats(n, T0 + 4 * H, live, H);
  near(assert, late.pnl, -6, 1e-9, 'the 20 settled in the window were charged before it');
  near(assert, late.posFees, 20, 1e-9, 'settled'); near(assert, late.posFeesCharged, 6, 1e-9, 'charged');
  // the PnL decomposes: realized − trading fees − position fees charged + funding + the change in price uPnL
  near(assert, late.pnl, 0 - 0 - late.posFeesCharged + 0 + (5 - 5), 1e-9);
});

test('position fees: nothing is ever owed to the account, and nothing before the first position charged one', () => {
  // the exchange's account is credited fees (a negative posFee) and is charged none itself: its series stays as it is
  const credited = [0, 1, 2].map((k) => bucket(k, { posFee: k === 1 ? -21.62 : 0, upnl: 3 }));
  const n = AN.netOfUnsettled(credited, null, 0, H, { charges: [], owed: 0, from: T0 });
  credited.forEach((b, k) => { near(assert, n[k].upnl, b.upnl, 1e-9, 'upnl ' + k); near(assert, n[k].posFeeCharged, b.posFee, 1e-9, 'its credits stay where they settled'); });
  // an owed figure that the charges read cannot explain (a position opened before `from`, say) is not carried back past it
  const s = [0, 1, 2, 3].map((k) => bucket(k, { upnl: 2 }));
  const m = AN.netOfUnsettled(s, null, 0, H, { charges: [charge(T0 + 3 * H, 4)], owed: 9, from: T0 + 2 * H });
  [0, 0, 5, 9].forEach((owed, k) => near(assert, m[k].upnl, 2 - owed, 1e-9, 'bucket ' + k));
  near(assert, m[2].posFeeCharged, 5, 1e-9, 'booked where the read charges begin'); near(assert, m[3].posFeeCharged, 4, 1e-9);
  near(assert, U.sum(m, (b) => b.posFeeCharged), 9, 1e-9, 'every fee owed now is booked once');
});

test('funding and position fees together: both owed figures come off each bucket, each with its own charged figure', () => {
  const series = [0, 1, 2].map((k) => bucket(k, { upnl: 4 }));
  const fund = [{ positionId: 'xau', time: T0 + H, fundingCharge: '3' }, { positionId: 'xau', time: T0 + 2 * H, fundingCharge: '3' }];
  const n = AN.netOfUnsettled(series, fund, 6, H, { charges: [charge(T0 + 2 * H, 2)], owed: 2, from: T0 + H });
  assert.equal(n.netted, true); assert.equal(n.posNetted, true);
  [0, 3, 8].forEach((owed, k) => near(assert, n[k].upnl, 4 - owed, 1e-9, 'bucket ' + k));
  near(assert, n[2].fundingCharged, -3, 1e-9); near(assert, n[2].posFeeCharged, 2, 1e-9);
  // AN.netLive reads both from the series and the live state
  const ser = series.slice(); ser.charges = fund; ser.posCharges = { rows: [charge(T0 + 2 * H, 2)], from: T0 + H };
  const live = AN.netLive(ser, { unsettledFunding: 6, unsettledPositionFee: 2 }, H);
  assert.deepEqual(live.map((b) => b.upnl), n.map((b) => b.upnl));
  const fundOnly = series.slice(); fundOnly.charges = fund; fundOnly.posCharges = null;
  assert.equal(AN.netLive(fundOnly, { unsettledFunding: 6, unsettledPositionFee: 2 }, H).posNetted, undefined);
});

test('where the position-fee charges must be read from: the first position charged one that was open at the start or after it', () => {
  const s0 = T0 + 5 * D;
  const p = (o) => Object.assign({ size: '0', positionFeeAccruedUsd: '0', positionFeeUsd: '0', createdAt: T0, updatedAt: T0 }, o);
  assert.equal(AN.positionFeeFrom([], s0), null, 'no positions');
  assert.equal(AN.positionFeeFrom([p({ size: '1' })], s0), null, 'never charged a fee: nothing to read');
  assert.equal(AN.positionFeeFrom([p({ positionFeeAccruedUsd: '4', updatedAt: s0 - H })], s0), null, 'closed and settled before the start');
  assert.equal(AN.positionFeeFrom([p({ positionFeeAccruedUsd: '4', createdAt: s0 - 2 * D, updatedAt: s0 + H })], s0), s0, 'closed after the start: from the start');
  assert.equal(AN.positionFeeFrom([p({ size: '1', positionFeeUsd: '0.0058', createdAt: s0 + 3 * H, updatedAt: s0 + 3 * H }), p({ size: '2', createdAt: s0 - D })], s0), s0 + 3 * H, 'opened after the start: from its opening');
  assert.equal(AN.positionFeeFrom([p({ size: '1', positionFeeUsd: '1', createdAt: Date.UTC(2026, 8, 1) })], Date.UTC(2026, 7, 30)), AN.POSITION_FEE_START, 'no charge before the mPerps opened');
  // a list cut short may lack an older position
  const cut = (rows) => Object.assign(rows, { truncated: true });
  assert.equal(AN.positionFeeFrom(cut([p({ size: '1', positionFeeUsd: '1', createdAt: s0 + D })]), s0), s0);
  assert.equal(AN.positionFeeFrom(cut([p({ size: '1' })]), s0, 0), null);
  assert.equal(AN.positionFeeFrom(cut([p({ size: '1' })]), s0, 3), s0, 'a fee owed now');
});

test('position-fee charges: 5-hour windows back from the next whole hour, boundary rows kept once, null when a window is cut short', async () => {
  const page = A.page, calls = [];
  // the stub serves one charge every 15 minutes from startTime to endTime (or now), both ends inclusive like the archive
  A.page = async (base, p, params) => {
    calls.push(Object.assign({ at: Date.now(), path: p }, params));
    const out = []; const end = params.endTime == null ? Date.now() : params.endTime; const Q = 15 * 60000;
    for (let t = Math.ceil(params.startTime / Q) * Q; t <= end; t += Q) out.push({ positionId: 'p1', time: t + 88, positionFeeCharge: '0.5' });
    if (params.startTime % Q === 0 && params.startTime > 0) out.unshift({ positionId: 'p1', time: params.startTime - Q + 88, positionFeeCharge: '0.5' });   // the 5-minute bucket before the start comes back too
    return out;
  };
  try {
    const start = Date.now() - 2 * D;
    const rows = await A.positionFeeCharges('sid', start);
    assert.ok(calls.every((c) => c.path === '/v1/subaccount/position-fee'));
    assert.ok(calls.length >= 10, 'two days in windows of 5 hours');
    assert.equal(calls.filter((c) => c.endTime == null).length, 1, 'only the newest window ends at the archive\'s own clock');
    for (const c of calls) { const span = (c.endTime == null ? c.at : c.endTime) - c.startTime; assert.ok(span > 0 && span <= 5 * H, 'span ' + span); }
    assert.ok(Math.min(...calls.map((c) => c.startTime)) <= start, 'reaches back to start');
    const keys = rows.map((r) => r.positionId + '|' + r.time);
    assert.equal(new Set(keys).size, keys.length, 'no row twice');
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i].time > rows[i - 1].time, 'ascending');
    // o.end bounds the rows
    const end = Date.now() - D;
    const early = await A.positionFeeCharges('sid', start, { end });
    assert.ok(early.length && early.every((r) => r.time < end));
    // a window with more rows than are read: no partial list
    A.page = async () => Object.assign([], { truncated: true });
    assert.equal(await A.positionFeeCharges('sid', Date.now() - 6 * H), null);
  } finally { A.page = page; }
});

test('the series reads the position-fee charges only for an account that was charged some, from where they can matter', async () => {
  const saved = { history: A.history, fundingCharges: A.fundingCharges, positionFeeCharges: A.positionFeeCharges };
  const asked = [];
  Object.assign(A, {
    history: async () => [],
    fundingCharges: async () => [],
    positionFeeCharges: async (sid, from) => { asked.push(from); return [charge(from + H, 1)]; },
  });
  try {
    const start = Date.now() - D, s = Math.floor(start / H) * H - H;
    const none = await AN.loadSeries('sid', { start, resolution: 'hour1', charges: true, positions: Promise.resolve([{ size: '1', positionFeeUsd: '0', positionFeeAccruedUsd: '0', createdAt: 0 }]) });
    assert.equal(none.posCharges, null); assert.equal(asked.length, 0, 'never charged a fee: no request');
    const opened = Date.now() - 3 * H;
    const one = await AN.loadSeries('sid', { start, resolution: 'hour1', charges: true, positions: [{ size: '1', positionFeeUsd: '2', positionFeeAccruedUsd: '0', createdAt: opened, updatedAt: opened }] });
    assert.deepEqual(asked, [opened]); assert.equal(one.posCharges.from, opened); assert.equal(one.posCharges.rows.length, 1);
    const older = await AN.loadSeries('sid', { start, resolution: 'hour1', positions: [{ size: '1', positionFeeUsd: '2', createdAt: start - 5 * D }] });
    assert.equal(older.posCharges.from, s, 'open since before the series: from its first bucket');
    // unreadable charges or positions: the settled basis, not a failed series
    A.positionFeeCharges = async () => { throw new Error('archive down'); };
    assert.equal((await AN.loadSeries('sid', { start, resolution: 'hour1', positions: [{ size: '1', positionFeeUsd: '2', createdAt: opened }] })).posCharges, null);
    assert.equal((await AN.loadSeries('sid', { start, resolution: 'hour1', positions: Promise.reject(new Error('api down')) })).posCharges, null);
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    await assert.rejects(AN.loadSeries('sid', { start, resolution: 'hour1', positions: Promise.reject(abort) }), (e) => e.name === 'AbortError', 'an abort still aborts');
  } finally { Object.assign(A, saved); }
});

test('leaderboard row: a fee charged two days ago and still owed is in 7d and 30d, not in 24h; all time unchanged', async () => {
  const now = Date.now(), created = now - 10 * D, opened = now - 3 * D;
  const XAU = 'p-xau', TOKEN = '0xxau';
  const ref = { byId: { [XAU]: { id: XAU, displayTicker: 'XAU-USD', ticker: 'XAUXAUUSD', marginMode: 'ISOLATED', quoteTokenAddress: TOKEN, quoteTokenName: 'XAU', maxLeverage: 20, takerFee: '0.00005', tickSize: '0.1', lotSize: '0.0001' } }, active: [] };
  const pos = { id: 'pos1', productId: XAU, side: 0, size: '1', cost: '4000', unrealizedPnl: '0', fundingUsd: '0', positionFeeUsd: '30', positionFeeAccruedUsd: '0', fundingAccruedUsd: '0', feesAccruedUsd: '0', realizedPnl: '0', totalIncreaseNotional: '4000', totalIncreaseQuantity: '1', totalDecreaseNotional: '0', totalDecreaseQuantity: '0', createdAt: opened, updatedAt: opened };
  const fees = [0, 1, 2].map((i) => ({ positionId: 'pos1', time: now - 50 * H + i * H, positionFeeCharge: '10' }));
  // the archive: a 1,000 deposit at creation, the position's price PnL 10 from its opening (the price does not move)
  const history = async (kind, sid, { start, resolution }) => {
    const ms = A.RES[resolution].ms, rows = [];
    for (let t = Math.floor(start / ms) * ms; t <= now; t += ms) {
      if (t + ms <= created) continue;
      if (kind === 'balance') rows.push({ time: t, tokenId: 'xau', balance: '1000', deposit: '1000', realizedPnl: '0', tradingFee: '0', realizedFunding: '0', withdrawal: '0', withdrawalFee: '0', depositFee: '0' });
      else if (kind === 'unrealized-pnl') rows.push({ time: t, tokenId: 'xau', unrealizedPnl: t + ms > opened ? '10' : '0' });
    }
    return rows;
  };
  const saved = { balances: A.balances, openPositions: A.openPositions, totalVolume: A.totalVolume, positions: A.positions, history: A.history, fundingCharges: A.fundingCharges, positionFeeCharges: A.positionFeeCharges };
  const asked = [];
  Object.assign(A, {
    balances: async () => [{ tokenAddress: TOKEN, tokenName: 'XAU', amount: '1000', available: '700', totalUsed: '300' }],
    openPositions: async () => [pos], totalVolume: async () => 4000, positions: async () => [pos], history, fundingCharges: async () => [],
    positionFeeCharges: async (sid, from) => { asked.push(from); return fees; },
  });
  try {
    const sa = { id: 'sid', account: '0xabc', createdAt: created };
    const prices = { [XAU]: { oraclePrice: '4010' } };
    const row = await AN.buildLeaderboardRow(sa, ref, prices, {});
    assert.deepEqual(asked, [opened], 'read from the position\'s opening');
    near(assert, row.stats['24h'].pnl, 0, 1e-6, '24h: nothing charged in it, the price did not move');
    near(assert, row.stats['24h'].posFees, 0, 1e-6);
    near(assert, row.stats['7d'].pnl, 10 - 30, 1e-6, '7d: the price PnL less the 30 charged'); near(assert, row.stats['7d'].posFees, 30, 1e-6, 'as charged');
    near(assert, row.stats['30d'].pnl, 10 - 30, 1e-6); near(assert, row.stats['30d'].posFees, 30, 1e-6);
    near(assert, row.stats.all.pnl, 10 - 30, 1e-6);
    // without the charges: the old basis, the whole 30 in every window; all time the same
    A.positionFeeCharges = async () => null;
    const old = await AN.buildLeaderboardRow(sa, ref, prices, {});
    near(assert, old.stats['24h'].pnl, -30, 1e-6); near(assert, old.stats.all.pnl, row.stats.all.pnl, 1e-6, 'all time unchanged');
    near(assert, old.stats['7d'].posFees, 0, 1e-6, 'settled: none');
  } finally { Object.assign(A, saved); }
});

test('account state as Meridian\'s app: available never below 0 per pool, leverage on the balance, margin ratio = maintenance ÷ equity', () => {
  const USD = '0xusd', XT = '0xxau';
  const ref = { byId: {
    btc: { id: 'btc', displayTicker: 'BTC-USD', quoteTokenAddress: USD, quoteTokenName: 'USD', maxLeverage: 10, takerFee: '0.00005' },
    xau: { id: 'xau', displayTicker: 'XAU-USD', quoteTokenAddress: XT, quoteTokenName: 'XAU', maxLeverage: 20, takerFee: '0.00005' },
  } };
  const balances = [{ tokenAddress: USD, tokenName: 'USD', amount: '100', available: '-20', totalUsed: '50' }, { tokenAddress: XT, tokenName: 'XAU', amount: '1000', available: '300', totalUsed: '200' }];
  const positions = [
    { productId: 'btc', size: '0.01', cost: '800', fundingUsd: '0', positionFeeUsd: '0' },
    { productId: 'xau', size: '1', cost: '4000', fundingUsd: '5', positionFeeUsd: '30' },
  ];
  const a = AN.accountState({ balances, positions, ref, prices: { btc: { oraclePrice: '81000' }, xau: { oraclePrice: '4010' } } });
  near(assert, a.available, 300, 1e-9, 'the cross pool\'s −20 counts as 0, as the app clamps each pool');
  const usd = a.pools.find((p) => p.name === 'USD'), xau = a.pools.find((p) => p.name === 'XAU');
  near(assert, usd.available, 0, 1e-9);
  near(assert, usd.equity, 100 + 10, 1e-9); near(assert, xau.equity, 1000 + 10 - 5 - 30, 1e-9, 'net of unsettled funding and position fee');
  near(assert, a.unsettledPositionFee, 30, 1e-9); near(assert, a.unsettledFunding, 5, 1e-9);
  const mmU = 810 * (1 / 20 + 0.00005), mmX = 4010 * (1 / 40 + 0.00005);
  near(assert, usd.marginRatio, mmU / 110, 1e-12); near(assert, xau.marginRatio, mmX / 975, 1e-12);
  near(assert, a.mm, mmU + mmX, 1e-9); near(assert, a.marginRatio, (mmU + mmX) / 1085, 1e-12, 'all pools: maintenance ÷ equity');
  near(assert, a.leverage, 4820 / 1100, 1e-12, 'notional ÷ balance'); near(assert, a.leverageEquity, 4820 / 1085, 1e-12, 'notional ÷ equity');
  // the app's edge cases: nothing held → 0; equity at or under 0 → 1 (it prints "100%+")
  assert.equal(AN.marginRatio(0, 100), 0); assert.equal(AN.marginRatio(5, 0), 1); assert.equal(AN.marginRatio(5, -3), 1); near(assert, AN.marginRatio(5, 20), 0.25, 1e-12);
  const empty = AN.accountState({ balances: [balances[0]], positions: [], ref, prices: {} });
  assert.equal(empty.marginRatio, null, 'no position: no ratio'); assert.equal(empty.pools[0].marginRatio, null); assert.equal(empty.leverage, 0);
  assert.equal(AN.accountState({ balances: [], positions: [], ref, prices: {} }).leverage, null, 'no balance: no leverage');
});

test('order book as Meridian\'s: the mid in the centre, Total the size from the touch in the base asset at its lot size', () => {
  // BTC at 20:15:27 UTC: bid 85,658, ask 85,675
  const m = AN.bookMid(85675, 85658);
  near(assert, m.mid, 85666.5, 1e-9); assert.equal(U.fmtPrice(m.mid, '1'), '85,667', 'at the tick\'s decimals, half up as the app rounds');
  assert.equal(U.fmtPct(m.spreadPct, { dp: 2 }), '0.02%');
  assert.deepEqual(AN.bookMid(null, 85658), { mid: null, spreadPct: null }, 'a side empty');
  // the third ask level out: the app's Total 1.16725 BTC; the levels' value 100,024.10
  const asks = AN.bookDepth([[85680, 0.52526], [85693, 0.11673], [85704, 0.52526]]);
  assert.equal(U.fmtQty(asks[2].c, '0.00001'), '1.16725');
  near(assert, asks[2].usd, 85680 * 0.52526 + 85693 * 0.11673 + 85704 * 0.52526, 1e-6);
  assert.equal(U.fmtUsd(asks[2].usd), '$100,024.10');
  assert.equal(U.fmtQty(1.19645, '0.00001'), '1.19645', 'a level at the lot size, not rounded to 4 dp');
  assert.deepEqual(AN.bookDepth(null), []);
});
