// Tax center archive ledger (MD.tax.ledger): the exchange's daily running totals per margin pool, cut at local
// boundaries with the hourly rows of the UTC days a boundary cuts. Synthetic archives built from one list of events
// (as the exchange's are), with two pools (USD and an mPerp pool), a 30-minute zone (India: every boundary at :30 UTC)
// and split days at both ends and at a month start. The ledger must reconcile to the cent and its months must add up
// to the period.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, near } from './_load.mjs';

const MD = load(['js/util.js', 'js/api.js', 'js/predict/api.js', 'js/predict/analytics.js', 'js/tax/core.js', 'js/tax/tz.js', 'js/tax/periods.js', 'js/tax/ledger.js', 'js/tax/fills.js', 'js/tax/funding.js']);
const L = MD.tax.ledger, PER = MD.tax.periods;
const DAY = 86400000, HOUR = 3600000, LATER = Date.UTC(2030, 0, 1);
const USD = 'tok-usd', XAU = 'tok-xau';
const REF = {
  byId: { btc: { id: 'btc', quoteTokenAddress: '0xUSD' }, xau: { id: 'xau', quoteTokenAddress: '0x5841555553440000000000000000000000000000' } },
  tokenById: {
    [USD]: { id: USD, name: 'USD', address: '0xusd', depositEnabled: true },
    [XAU]: { id: XAU, name: 'XAUUSD', address: '0x5841555553440000000000000000000000000000', depositEnabled: false },
    base: { id: 'base', name: 'XAU', address: '0x0000000000000000000000000000000000000000', depositEnabled: false },
  },
};
const FIELDS = ['deposit', 'withdrawal', 'withdrawalFee', 'depositFee', 'conversionIn', 'conversionOut', 'realizedPnl', 'tradingFee', 'realizedFunding'];
const at = (s) => Date.parse(s);
// an event moves one pool's balance; k is the archive field it is recorded in, or 'bal' for a change with no field
// (an mPerp position fee settling, or an adjustment)
const ev = (t, tok, k, v) => ({ t: at(t), tok, k, v });

/** Archive rows as the exchange serves them: per bucket and pool, running totals at the bucket's end (b1 inclusive, as
 *  its endTime is), 9-decimal strings; volume per bucket. */
function archive(events, vols, b0, b1, ms) {
  const balance = [], volume = [];
  for (let b = b0; b <= b1; b += ms) {
    for (const tok of [USD, XAU]) {
      const r = { balance: 0 }; for (const f of FIELDS) r[f] = 0;
      for (const e of events) if (e.tok === tok && e.t < b + ms) { if (e.k !== 'bal') r[e.k] += e.v; r.balance += e.v; }
      const row = { time: b, tokenId: tok }; for (const [k, v] of Object.entries(r)) row[k] = v.toFixed(9);
      balance.push(row);
    }
    volume.push({ time: b, volumeUsd: String(vols.filter((v) => v.t >= b && v.t < b + ms).reduce((a, v) => a + v.v, 0)) });
  }
  return { balance, volume };
}
/** What load.archive returns for a period: daily rows from the day before it, hourly rows for its split days. */
function loadFor(period, events, vols, opts = {}) {
  const from = Math.floor(period.start / DAY) * DAY - DAY, to = Math.floor(period.end / DAY) * DAY + DAY;   // one row past the end: the endTime is inclusive
  const day = archive(events, vols, from, to, DAY);
  const hour = new Map();
  for (const S of PER.splitDays(period)) { if (opts.skip && opts.skip.includes(S)) continue; const x = archive(events, vols, S - HOUR, S + DAY, HOUR); hour.set(S, opts.cut ? opts.cut(S, x) : x); }
  return { balance: day.balance, volume: day.volume, hour };
}

// India, 15 Aug – 14 Sep 2026: starts 14 Aug 18:30Z, September starts 31 Aug 18:30Z, ends 14 Sep 18:30Z
const PERIOD = PER.resolve({ fy: 'in', from: '2026-08-15', to: '2026-09-14', tz: 'Asia/Kolkata' }, { now: LATER });
const EVENTS = [
  // before the period
  ev('2026-08-10T10:00:00Z', USD, 'deposit', 1000),
  ev('2026-08-10T11:00:00Z', USD, 'conversionOut', -300), ev('2026-08-10T11:00:00Z', XAU, 'conversionIn', 300),
  ev('2026-08-12T09:00:00Z', USD, 'realizedPnl', 5), ev('2026-08-12T09:00:00Z', USD, 'tradingFee', -0.5),
  // the start's UTC day: before 18:30Z is the day before, and so is the hour from 18:00, which the boundary cuts
  ev('2026-08-14T17:10:00Z', USD, 'realizedPnl', 7),
  ev('2026-08-14T18:10:00Z', USD, 'tradingFee', -0.2),
  ev('2026-08-14T18:40:00Z', USD, 'realizedPnl', 11),
  ev('2026-08-14T19:05:00Z', USD, 'realizedPnl', 13),
  // August (local)
  ev('2026-08-20T12:00:00Z', XAU, 'realizedPnl', -20), ev('2026-08-20T12:00:00Z', XAU, 'tradingFee', -1.5), ev('2026-08-20T12:00:00Z', XAU, 'bal', -0.75),
  ev('2026-08-25T12:00:00Z', USD, 'realizedFunding', 2.5), ev('2026-08-25T12:00:00Z', XAU, 'realizedFunding', -1.25),
  ev('2026-08-28T05:00:00Z', USD, 'deposit', 200),
  // the month boundary's UTC day: the hour from 18:00 is still August
  ev('2026-08-31T18:10:00Z', USD, 'realizedPnl', 3),
  ev('2026-08-31T18:50:00Z', USD, 'realizedPnl', 4),
  ev('2026-08-31T19:10:00Z', USD, 'realizedPnl', 6), ev('2026-08-31T19:10:00Z', XAU, 'bal', -0.4),
  // September (local)
  ev('2026-09-05T08:00:00Z', USD, 'withdrawal', -100), ev('2026-09-05T08:00:00Z', USD, 'withdrawalFee', -1),
  ev('2026-09-10T08:00:00Z', XAU, 'realizedPnl', 9), ev('2026-09-10T08:00:00Z', XAU, 'tradingFee', -0.9), ev('2026-09-10T08:00:00Z', XAU, 'bal', -1.1),
  // the end's UTC day: up to the hour from 18:00 is in, later is the next period
  ev('2026-09-14T10:00:00Z', USD, 'realizedPnl', 2),
  ev('2026-09-14T18:20:00Z', USD, 'tradingFee', -0.3),
  ev('2026-09-14T20:00:00Z', USD, 'realizedPnl', 50),
  ev('2026-09-15T03:00:00Z', USD, 'deposit', 999),
];
const VOLS = [{ t: at('2026-08-20T12:00:00Z'), v: 5000 }, { t: at('2026-08-31T19:10:00Z'), v: 1000 }, { t: at('2026-09-10T08:00:00Z'), v: 3000 }, { t: at('2026-09-14T20:00:00Z'), v: 777 }];
const build = (events = EVENTS, opts = {}) => L.build(Object.assign({ ref: REF, period: PERIOD }, loadFor(PERIOD, events, VOLS, opts), opts.fx ? { fx: opts.fx } : {}));

test('the period: split days at both ends and at the month start, all at :30 UTC', () => {
  assert.equal(new Date(PERIOD.start).toISOString(), '2026-08-14T18:30:00.000Z');
  assert.equal(new Date(PERIOD.end).toISOString(), '2026-09-14T18:30:00.000Z');
  assert.deepEqual(PER.splitDays(PERIOD).map((t) => new Date(t).toISOString().slice(0, 10)), ['2026-08-14', '2026-08-31', '2026-09-14']);
});

test('totals: realized, fees, mPerp position fees, funding and transfers of the period only', () => {
  const led = build(), T = led.totals;
  near(assert, T.realized, 13 - 20 + 3 + 4 + 6 + 9 + 2, 1e-9, 'realized');
  near(assert, T.fees, 1.5 + 0.9 + 0.3, 1e-9, 'trading fees: the 18:20 fee on the last day is in, the 18:10 one on the first is not');
  near(assert, T.pfees, 0.75 + 0.4 + 1.1, 1e-9, 'position fees: the mPerp pool\'s residual');
  near(assert, T.funding, 1.25, 1e-9, 'netted per UTC day: +2.5 and −1.25 on 25 Aug'); assert.ok(!('fundingIn' in T) && !('fundingOut' in T), 'the legs come from T.funding.figures (per settlement), never from a segment\'s sign');
  near(assert, T.deposits, 200, 1e-9); near(assert, T.withdrawals, 101, 1e-9); near(assert, T.wfee, 1, 1e-9);
  near(assert, T.volume, 9000, 1e-9, 'volume: the 20:00 fill on the last day is the next period\'s');
  near(assert, T.net, 17 - 2.7 - 2.25 + 1.25, 1e-9, 'net = realized − fees − position fees + funding');
  assert.deepEqual(led.fallbackDays, []); assert.deepEqual(led.poolDiffs, []); assert.deepEqual(led.pfDays, []);
  assert.equal(led.straddle.length, 3, 'three boundaries inside an hour');
});

test('months and quarters add up to the period, each on the right side of a :30 boundary', () => {
  const led = build();
  assert.deepEqual(led.months.map((m) => m.label), ['Aug 2026', 'Sep 2026']);
  const [aug, sep] = led.months;
  near(assert, aug.realized, 13 - 20 + 3 + 4, 1e-9, 'August holds the hour from 18:00 on 31 Aug (the 18:50 event)');
  near(assert, sep.realized, 6 + 9 + 2, 1e-9);
  near(assert, aug.pfees, 0.75, 1e-9); near(assert, sep.pfees, 1.5, 1e-9);
  for (const k of ['realized', 'fees', 'pfees', 'funding', 'deposits', 'withdrawals', 'wfee', 'volume', 'net']) {
    near(assert, aug[k] + sep[k], led.totals[k], 1e-9, 'months: ' + k);
    near(assert, led.quarters.reduce((a, q) => a + q[k], 0), led.totals[k], 1e-9, 'quarters: ' + k);
  }
  assert.equal(aug.cut, 'from 15 Aug'); assert.equal(sep.cut, 'to 14 Sep');
  assert.equal(led.segments.length, 1 + 16 + 2 + 13 + 1, 'a part of 14 Aug, 16 whole days, 31 Aug in two parts, 13 whole days, a part of 14 Sep');
  const parts = led.segments.filter((s) => s.part).map((s) => new Date(s.day).toISOString().slice(0, 10) + ' ' + s.part);
  assert.deepEqual(parts, ['2026-08-14 18:30–24:00', '2026-08-31 00:00–18:30', '2026-08-31 18:30–24:00', '2026-09-14 00:00–18:30']);
});

test('the reconciliation is exact: opening and closing are the levels at the period\'s instants', () => {
  const led = build();
  near(assert, led.opening, 1000 + 5 - 0.5 + 7 - 0.2 + 11, 1e-9, 'opening: everything up to the end of the hour the start cuts');
  near(assert, led.closing, 1134.6, 1e-9, 'closing');
  near(assert, led.recon.diff, 0, 1e-9, 'opening + deposits − withdrawals + net = closing');
  near(assert, led.segments[led.segments.length - 1].balance, led.closing, 1e-9, 'the last segment ends at the closing balance');
  // each pool's level at the two instants (the Holdings card's cash): the end's UTC day goes on after 18:30Z (+50 at
  // 20:00Z), and that part is the next period's, not the level at the end
  const sum = (lv) => Object.values(lv).reduce((a, v) => a + v, 0);
  near(assert, sum(led.levels.closing), led.closing, 1e-9, 'the pools at the end add up to the closing balance');
  near(assert, sum(led.levels.opening), led.opening, 1e-9, 'the pools at the start add up to the opening balance');
  near(assert, led.levels.closing[USD], 1134.6 - led.levels.closing[XAU], 1e-9);
});

test('position fees come from mPerp pools only: a residual in the USD pool stays a reconciliation difference', () => {
  const led = build(EVENTS.concat([ev('2026-09-02T12:00:00Z', USD, 'bal', 0.1)]));
  near(assert, led.totals.pfees, 2.25, 1e-9, 'not booked as a position fee');
  assert.equal(led.poolDiffs.length, 1); assert.equal(led.poolDiffs[0].pool, 'USD'); near(assert, led.poolDiffs[0].diff, 0.1, 1e-9);
  near(assert, led.recon.diff, 0.1, 1e-9, 'the reconciliation shows it');
  assert.deepEqual(Array.from(L.mPerpPools(REF)), [XAU], 'the base token (address 0x0) and the depositable USD pool are not mPerp pools');
});

test('an mPerp residual that is a credit, or that comes without any fill, is named', () => {
  const led = build(EVENTS.concat([ev('2026-09-03T12:00:00Z', XAU, 'bal', -0.6), ev('2026-09-04T12:00:00Z', XAU, 'bal', 0.2)]));
  assert.deepEqual(led.pfDays.map((x) => [new Date(x.seg.day).toISOString().slice(0, 10), x.reason]), [['2026-09-03', 'no-volume'], ['2026-09-04', 'credit']]);
  near(assert, led.totals.pfees, 2.25 + 0.6 - 0.2, 1e-9, 'still booked, and still reconciling');
  near(assert, led.recon.diff, 0, 1e-9);
});

test('hours that do not add up to the day keep the day whole, on the side holding most of it', () => {
  // the hourly ledger of 31 Aug stops before 19:00 (late, or a failed read): its hours no longer add up to the day
  const cut = (S, x) => (S === Date.UTC(2026, 7, 31) ? { balance: x.balance.filter((r) => r.time < S + 19 * HOUR), volume: x.volume } : x);
  const led = build(EVENTS, { cut });
  assert.deepEqual(led.fallbackDays, [Date.UTC(2026, 7, 31)]);
  const [aug, sep] = led.months;
  near(assert, aug.realized, 13 - 20 + 3 + 4 + 6, 1e-9, 'the whole day is August: 18.5 of its 24 hours are');
  near(assert, sep.realized, 9 + 2, 1e-9);
  near(assert, led.recon.diff, 0, 1e-9, 'still exact');
  // and a split day whose hours were never read at all
  const none = build(EVENTS, { skip: [Date.UTC(2026, 7, 14)] });
  assert.deepEqual(none.fallbackDays, [Date.UTC(2026, 7, 14)]);
  near(assert, none.totals.realized, 17 - 13, 1e-9, '14 Aug is mostly before the start: left out whole');
  near(assert, none.recon.diff, 0, 1e-9);
  // the levels follow the side a whole day is put on, at both ends
  const sum = (lv) => Object.values(lv).reduce((a, v) => a + v, 0);
  near(assert, sum(none.levels.opening), none.opening, 1e-9);
  const late = build(EVENTS, { skip: [Date.UTC(2026, 8, 14)] });
  assert.deepEqual(late.fallbackDays, [Date.UTC(2026, 8, 14)]);
  near(assert, late.closing, 1134.6 + 50, 1e-9, '14 Sep is mostly before the end: in whole, its 20:00Z result too');
  near(assert, sum(late.levels.closing), late.closing, 1e-9);
  // a quiet day: the levels it starts and ends with
  const quiet = L.build(Object.assign(loadFor(PER.resolve({ from: '2026-08-11', to: '2026-08-11', tz: 'UTC' }, { now: LATER }), EVENTS, []), { ref: REF, period: PER.resolve({ from: '2026-08-11', to: '2026-08-11', tz: 'UTC' }, { now: LATER }) }));
  near(assert, sum(quiet.levels.opening), 1000, 1e-9); near(assert, sum(quiet.levels.closing), 1000, 1e-9);
});

test('UTC: whole days only, and the row the inclusive endTime adds is not the period\'s', () => {
  const P = PER.resolve({ from: '2026-09-01', to: '2026-09-30', tz: 'UTC' }, { now: LATER });
  const events = [ev('2026-08-31T23:00:00Z', USD, 'deposit', 50), ev('2026-09-01T00:00:00Z', USD, 'realizedPnl', 1), ev('2026-09-30T23:59:59Z', USD, 'realizedPnl', 2), ev('2026-10-01T00:00:00Z', USD, 'realizedPnl', 4)];
  const data = loadFor(P, events, []);
  assert.ok(data.balance.some((r) => r.time === P.end), 'the archive returned the row at the end');
  const led = L.build(Object.assign({ ref: REF, period: P }, data));
  assert.deepEqual(led.splitDays, []); assert.equal(led.segments.length, 30);
  near(assert, led.totals.realized, 3, 1e-9); near(assert, led.opening, 50, 1e-9); near(assert, led.closing, 53, 1e-9);
});

test('the report currency: each segment at the rate of its middle, whose local date holds most of it', () => {
  // a rate per local date in India, as the page's: 2 in August, 3 from 1 September
  const fx = (usd, t) => usd * (MD.tax.tz.dayKey(t, 'Asia/Kolkata') < '2026-09-01' ? 2 : 3);
  const led = build(EVENTS, { fx });
  const [aug, sep] = led.months;
  near(assert, aug.C.net, aug.net * 2, 1e-9); near(assert, sep.C.net, sep.net * 3, 1e-9);
  near(assert, led.totals.C.net, aug.net * 2 + sep.net * 3, 1e-9);
  const part = led.segments.find((s) => s.part === '18:30–24:00' && s.day === Date.UTC(2026, 7, 31));
  assert.equal(part.tm, Date.UTC(2026, 7, 31, 21, 15), 'the middle of 18:30–24:00');
});

test('a split day on which nothing moved needs no hourly read', () => {
  const D = Date.UTC(2026, 7, 31), dayOf = (t) => Math.floor(t / DAY) * DAY;
  const events = EVENTS.filter((e) => dayOf(e.t) !== D), vols = VOLS.filter((v) => dayOf(v.t) !== D);
  const data = loadFor(PERIOD, events, vols);
  assert.deepEqual(L.quietDays(data.balance, data.volume, PER.splitDays(PERIOD)), [D], 'only 31 Aug is quiet');
  data.hour.delete(D);   // load.archive does not read it
  const led = L.build(Object.assign({ ref: REF, period: PERIOD }, data));
  assert.deepEqual(led.fallbackDays, []);
  assert.equal(led.segments.filter((s) => s.day === D).length, 2, 'still in its two parts, both empty');
  near(assert, led.recon.diff, 0, 1e-9);
  near(assert, led.totals.realized, 13 - 20 + 9 + 2, 1e-9);
});

test('the report currency from the events: each fill, settlement and transfer at its own local date, the totals, months and quarters summed again; a UTC day whose events do not add up converts whole, named (B2)', () => {
  const F = MD.tax.fills, FU = MD.tax.funding, TZ = MD.tax.tz;
  // a rate per local date in India (1 + its day of the month / 100): an event late in a UTC day falls on the next local
  // date, whose rate is not the one of the day's middle
  const fx = (usd, t) => usd * (1 + Number(TZ.dayKey(t, 'Asia/Kolkata').slice(8)) / 100);
  const EV2 = EVENTS.concat([ev('2026-08-25T20:00:00Z', USD, 'realizedPnl', 8), ev('2026-08-25T20:00:00Z', USD, 'tradingFee', -0.25)]);
  const led = build(EV2, { fx });
  assert.deepEqual(led.basisC, { events: false, fallback: null });
  assert.match(L.basisText(led), /the trade detail is not loaded, so each UTC day \(or part of a day a boundary cuts\) converts whole/);
  assert.ok(led.segments.every((s) => s.mi >= 0 && s.qi >= 0), 'each segment knows its month and quarter');
  // the events as the trade detail has them
  const rows = EV2.filter((e) => e.k === 'realizedPnl').map((e) => ({ t: e.t, gross: e.v }));
  const fills = EV2.filter((e) => e.k === 'tradingFee').map((e) => ({ t: e.t, fee: -e.v }));
  const pfees = EV2.filter((e) => e.k === 'bal' && e.tok === XAU).map((e) => ({ t: e.t, amount: -e.v }));
  const fig = FU.figures(EV2.filter((e) => e.k === 'realizedFunding').map((e) => ({ t: e.t, amount: e.v })), led.segments, fx);
  const transfers = [{ type: 'DEPOSIT', amount: '200', fee: '0', createdAt: at('2026-08-28T05:00:00Z'), status: 'COMPLETED' }, { type: 'WITHDRAW', amount: '100', fee: '1', createdAt: at('2026-09-05T08:00:00Z'), status: 'COMPLETED' },
    { type: 'DEPOSIT', amount: '999', fee: '0', createdAt: at('2026-09-15T03:00:00Z'), status: 'COMPLETED' }, { type: 'DEPOSIT', amount: '5', fee: '0', createdAt: at('2026-09-01T03:00:00Z'), status: 'FAILED' }];
  const conv = F.ledgerC(led.segments, { rows, fills, pfees, fig, transfers }, fx);
  assert.deepEqual(conv.fallback, { realized: [], fee: [], pfees: [], funding: [], transfer: [] }, 'every UTC day adds up');
  // by the ledger's hour rule: an event in the hour a boundary cuts counts in the part that hour starts in
  const at0 = F.segmentOf(led.segments), sumC = (list, f) => list.reduce((a, x) => (at0(x.t) >= 0 ? a + fx(f(x), x.t) : a), 0);
  const day25 = led.segments.findIndex((s) => s.day === Date.UTC(2026, 7, 25));
  near(assert, conv.segs[day25].realizedPnl, 8 * 1.26, 1e-12, 'the 20:00Z result on its own local date (26 Aug)');
  near(assert, led.segments[day25].C.realizedPnl, 8 * 1.25, 1e-12, 'the ledger had it at the day\'s middle (25 Aug)');
  L.recast(led, conv);
  const C = led.totals.C;
  near(assert, C.realized, sumC(rows, (x) => x.gross), 1e-9); near(assert, C.fees, sumC(fills, (x) => x.fee), 1e-9); near(assert, C.pfees, sumC(pfees, (x) => x.amount), 1e-9);
  near(assert, C.funding, fig.C.received - fig.C.paid, 1e-12, 'funding net = received − paid, in the report currency too');
  near(assert, C.net, C.realized - C.fees - C.pfees + C.funding, 1e-9);
  near(assert, C.deposits, fx(200, at('2026-08-28T05:00:00Z')), 1e-12); near(assert, C.withdrawals, fx(101, at('2026-09-05T08:00:00Z')), 1e-12); near(assert, C.wfee, fx(1, at('2026-09-05T08:00:00Z')), 1e-12);
  for (const k of ['realized', 'fees', 'pfees', 'funding', 'deposits', 'withdrawals', 'net']) {
    near(assert, led.months.reduce((a, m) => a + m.C[k], 0), C[k], 1e-9, 'months ' + k);
    near(assert, led.quarters.reduce((a, q) => a + q.C[k], 0), C[k], 1e-9, 'quarters ' + k);
  }
  near(assert, led.totals.realized, 13 - 20 + 8 + 3 + 4 + 6 + 9 + 2, 1e-9, 'USD untouched');
  assert.equal(led.basisC.events, true);
  assert.match(L.basisText(led), /each fill, settlement and transfer at the rate of its own local date.*every UTC day's detail adds up to the ledger, so no day converts whole/);
  // a result the detail lacks (the 19:05Z one, in the start's part): that part's realized PnL converts whole, named
  const led2 = build(EV2, { fx });
  const conv2 = F.ledgerC(led2.segments, { rows: rows.filter((x) => x.t !== at('2026-08-14T19:05:00Z')), fills, pfees, fig, transfers }, fx);
  assert.deepEqual(conv2.fallback.realized, [0]);
  near(assert, conv2.segs[0].realizedPnl, fx(13, led2.segments[0].tm), 1e-12);
  L.recast(led2, conv2);
  assert.match(L.basisText(led2), /converts whole at the rate of the local date holding its middle: realized PnL on 2026-08-14 18:30–24:00 UTC/);
  // transfers that do not add up (none read): that day's deposits, withdrawals and fees whole, together
  const conv3 = F.ledgerC(led2.segments, { rows, fills, pfees, fig, transfers: [] }, fx);
  assert.equal(conv3.fallback.transfer.length, 2);
  // a ledger of another length is left as it is
  assert.equal(L.recast(led2, { segs: [], fallback: {} }).basisC.fallback, conv2.fallback);
});
