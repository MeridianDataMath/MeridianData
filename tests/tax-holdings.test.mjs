// Tax center holdings at an instant (MD.tax.holdings, MD.tax.predict.holdingsAt): which archive bucket holds the
// levels at the period's start and end (a UTC midnight, a local midnight, a boundary inside an hour, a day the ledger
// kept whole, now), the cash per margin pool as the reconciliation has it, the unrealized PnL, the funding charged and
// not settled, equity both ways and the change in equity with transfers taken out; the positions open at an instant
// from the fills' replay and from the positions list (a real subaccount); Meridian Predict at cost at an instant; the
// rate of the local day before the instant; the B20 tile line, the summary rows and the Holdings file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { load, near, root } from './_load.mjs';
import { perps, events, ledger } from './_tax-fixture.mjs';

const MD = load(['js/util.js', 'js/api.js', 'js/predict/api.js', 'js/predict/analytics.js', 'js/tax/core.js', 'js/tax/tz.js', 'js/tax/periods.js', 'js/tax/fx.js', 'js/tax/ledger.js', 'js/tax/load.js', 'js/tax/fills.js', 'js/tax/funding.js', 'js/tax/predict.js', 'js/tax/lots.js', 'js/tax/holdings.js', 'js/tax/exports.js']);
const U = MD.util, P = MD.predict, T = MD.tax, HO = T.holdings, PR = T.predict, FU = T.funding, F = T.fills, PER = T.periods, EX = T.exports, LO = T.lots;
const DAY = 86400000, HOUR = 3600000, LATER = Date.UTC(2030, 0, 1);
const at = (s) => Date.parse(s);
const USD = T.fx.money(null, 'UTC');
/** a report currency whose rate changes every day, as the ECB's */
const eur = (tz = 'UTC') => {
  const d = [], r = [];
  for (let t = Date.UTC(2026, 2, 1), i = 0; t < Date.UTC(2027, 1, 1); t += DAY, i++) { d.push(new Date(t).toISOString().slice(0, 10)); r.push(0.8 + (i % 17) / 100); }
  return T.fx.money(T.fx.rates({ ccy: 'EUR', id: 'ecb', via: 'file', table: { source: 'ecb', ccy: 'EUR', d, r, ref: null }, tz }), tz);
};
const period = (from, to, tz = 'UTC', now = LATER) => PER.resolve({ from, to, tz }, { now, firstT: Date.UTC(2026, 5, 29), browserZone: 'UTC' });

// ---------- which bucket holds the levels at an instant ----------
test('the archive bucket at an instant: the day before a UTC midnight, the hour of a local midnight (rounded up inside an hour), a day the ledger kept whole, now', () => {
  const now = at('2026-10-03T07:05:00Z');
  assert.deepEqual(HO.archiveRow(at('2026-09-29T00:00:00Z'), { now }), { res: 'day1', rowT: at('2026-09-28T00:00:00Z'), at: at('2026-09-29T00:00:00Z'), now: false },
    'a UTC midnight: the daily bucket of the day before (end-of-bucket level filed under its start)');
  // UK 2026/27 starts 6 Apr 00:00 BST = 5 Apr 23:00 UTC
  assert.deepEqual(HO.archiveRow(at('2026-04-05T23:00:00Z'), { now }), { res: 'hour1', rowT: at('2026-04-05T22:00:00Z'), at: at('2026-04-05T23:00:00Z'), now: false });
  // India: 1 Apr 00:00 IST = 31 Mar 18:30 UTC; the ledger counts the hour 18:00–19:00 in the period it starts in
  assert.deepEqual(HO.archiveRow(at('2026-03-31T18:30:00Z'), { now }), { res: 'hour1', rowT: at('2026-03-31T18:00:00Z'), at: at('2026-03-31T19:00:00Z'), now: false });
  // a day whose hours could not be read is whole on the side holding its middle: the level at that day's edge
  const D = at('2026-04-05T00:00:00Z');
  assert.deepEqual(HO.archiveRow(at('2026-04-05T23:00:00Z'), { now, fallbackDays: [D] }), { res: 'day1', rowT: D, at: D + DAY, now: false }, 'the day is before the instant');
  assert.deepEqual(HO.archiveRow(at('2026-04-05T03:00:00Z'), { now, fallbackDays: [D] }), { res: 'day1', rowT: D - DAY, at: D, now: false }, 'the day is after the instant');
  for (const t of [now, now - 60000, now + DAY, at('2026-10-03T07:01:00Z')]) assert.deepEqual(HO.archiveRow(t, { now }), { res: 'hour1', rowT: at('2026-10-03T07:00:00Z'), at: now, now: true }, 'now (or an hour that ends after it): the newest hour');
  assert.deepEqual(HO.archiveRow(at('2026-10-03T07:00:00Z'), { now }), { res: 'hour1', rowT: at('2026-10-03T06:00:00Z'), at: at('2026-10-03T07:00:00Z'), now: false }, 'a whole hour just before now');
  // the instants: a period that has ended, and one still running (its end is now)
  const done = period('2026-09-20', '2026-09-28');
  assert.deepEqual(HO.instants(done, now).map((x) => [x.key, x.t, x.now, x.label, x.lotsT]), [['start', done.start, false, 'Period start', done.start], ['end', done.end, false, 'Period end', done.end]]);
  const running = period('2026-09-20', '2026-12-31', 'UTC', now);
  assert.deepEqual(HO.instants(running, now).map((x) => [x.t, x.now, x.label]), [[running.start, false, 'Period start'], [now, true, 'Now']]);
});

test('the unrealized PnL of one read: the row at its bucket only (the archive\'s endTime is inclusive), per pool; now, the newest; a failed read is null', () => {
  const rowT = at('2026-09-28T00:00:00Z');
  const rows = [
    { time: rowT, tokenId: 'usd', unrealizedPnl: '-795.19' }, { time: rowT, tokenId: 'xau', unrealizedPnl: '-222.93' }, { time: rowT, tokenId: 'spy', unrealizedPnl: '-92.85' },
    { time: rowT + DAY, tokenId: 'usd', unrealizedPnl: '5' }, { time: rowT + DAY, tokenId: 'xau', unrealizedPnl: '6' },
  ];
  const u = HO.upnlOf({ spec: { res: 'day1', rowT, now: false }, rows });
  assert.deepEqual(u.byTok, { usd: -795.19, xau: -222.93, spy: -92.85 });
  near(assert, u.total, -1110.97, 1e-9); assert.equal(u.found, true);
  const n = HO.upnlOf({ spec: { res: 'hour1', rowT: rowT + DAY, now: true }, rows });
  assert.deepEqual(n.byTok, { usd: 5, xau: 6 }, 'now: the newest bucket'); assert.equal(n.rowT, rowT + DAY);
  const none = HO.upnlOf({ spec: { res: 'day1', rowT: rowT - 5 * DAY, now: false }, rows });
  assert.deepEqual([none.found, none.total], [false, 0], 'no row for that bucket (before the account existed)');
  assert.equal(HO.upnlOf({ spec: { res: 'day1', rowT }, error: new Error('503') }), null);
  assert.equal(HO.upnlOf(null), null);
});

test('load.upnl reads one small bucket per instant (now: the last two hours), keeps a closed bucket for the tab, and a failed read fails only its instant', async () => {
  const A = MD.api, calls = [];
  const real = A.history;
  A.history = async (kind, sid, o) => {
    calls.push([kind, sid, o.start, o.end, o.resolution]);
    if (o.start === at('2026-09-01T22:00:00Z')) throw new Error('archive 503');
    return [{ time: o.start, tokenId: 'usd', unrealizedPnl: '1' }];
  };
  try {
    const now = Date.now(), nowT = Math.floor(now / HOUR) * HOUR;
    const specs = [{ res: 'day1', rowT: at('2026-09-28T00:00:00Z'), at: 0, now: false }, { res: 'hour1', rowT: at('2026-09-01T22:00:00Z'), at: 0, now: false }, { res: 'hour1', rowT: nowT, at: now, now: true }];
    const r = await T.load.upnl('sid-1', specs);
    assert.deepEqual(calls, [
      ['unrealized-pnl', 'sid-1', at('2026-09-28T00:00:00Z'), at('2026-09-29T00:00:00Z'), 'day1'],
      ['unrealized-pnl', 'sid-1', at('2026-09-01T22:00:00Z'), at('2026-09-01T23:00:00Z'), 'hour1'],
      ['unrealized-pnl', 'sid-1', nowT - HOUR, undefined, 'hour1'],
    ]);
    assert.ok(r[0].rows && r[2].rows); assert.equal(r[1].error.message, 'archive 503');
    assert.equal(r[0].spec, specs[0]);
    calls.length = 0;
    await T.load.upnl('sid-1', [specs[0], specs[2]]);
    assert.deepEqual(calls, [], 'a closed bucket is kept for the tab, now for a minute');
    A.history = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
    await assert.rejects(T.load.upnl('sid-2', [specs[0]]), { name: 'AbortError' }, 'an abort throws');
  } finally { A.history = real; }
});

// ---------- perps at an instant, synthetic ----------
// a subaccount with the USD pool and an mPerp pool (XAUUSD: cannot be deposited, a product's quote token)
const REF = {
  byId: { btc: { id: 'btc', displayTicker: 'BTC-USD', baseTokenName: 'BTC', quoteTokenAddress: '0xa1' }, xau: { id: 'xau', displayTicker: 'XAU-USD', baseTokenName: 'XAU', quoteTokenAddress: '0xa2' } },
  tokenById: { usd: { id: 'usd', name: 'USD', address: '0xa1', depositEnabled: true }, xaup: { id: 'xaup', name: 'XAUUSD', address: '0xa2', depositEnabled: false } },
};
const D0 = at('2026-09-01T00:00:00Z');
const bal = (t, tokenId, o) => Object.assign({ time: t, tokenId, balance: '0', realizedPnl: '0', tradingFee: '0', realizedFunding: '0', deposit: '0', withdrawal: '0', withdrawalFee: '0', depositFee: '0', conversionIn: '0', conversionOut: '0' }, o);
// running totals per pool, one row a day: deposit 1,000 the day before; +50 realized and 200 converted to the XAU pool
// on day 0; a 100 deposit and −20 realized in the XAU pool on day 1; a 300 withdrawal with a 1 fee on day 2
const BALANCE = [
  bal(D0 - DAY, 'usd', { deposit: '1000', balance: '1000' }),
  bal(D0, 'usd', { deposit: '1000', realizedPnl: '50', conversionOut: '-200', balance: '850' }), bal(D0, 'xaup', { conversionIn: '200', balance: '200' }),
  bal(D0 + DAY, 'usd', { deposit: '1100', realizedPnl: '50', conversionOut: '-200', balance: '950' }), bal(D0 + DAY, 'xaup', { conversionIn: '200', realizedPnl: '-20', balance: '180' }),
  bal(D0 + 2 * DAY, 'usd', { deposit: '1100', realizedPnl: '50', conversionOut: '-200', withdrawal: '-300', withdrawalFee: '-1', balance: '649' }), bal(D0 + 2 * DAY, 'xaup', { conversionIn: '200', realizedPnl: '-20', balance: '180' }),
];
// a BTC long opened on day 0 and still open; an XAU short opened on day 1 and closed after the period
const POS = [
  { id: 'pb', productId: 'btc', side: 0, size: '0.5', cost: '30000', createdAt: D0 + 10 * HOUR, updatedAt: D0 + 10 * HOUR, fundingUsd: '4', positionFeeUsd: '0', unrealizedPnl: '-60' },
  { id: 'px', productId: 'xau', side: 1, size: '0', createdAt: D0 + DAY + 3 * HOUR, updatedAt: D0 + 4 * DAY, totalIncreaseQuantity: '2', totalIncreaseNotional: '7000', totalDecreaseQuantity: '2' },
];
const synth = () => {
  const P0 = period('2026-09-01', '2026-09-03');
  const led = T.ledger.build({ balance: BALANCE, volume: [], hour: null, ref: REF, period: P0 });
  // three hourly charges paid by the long on day 2, no fill after them: unsettled; one received by the short, settled
  // at its close after the period
  const ch = [['pb', D0 + 2 * DAY + HOUR, '1'], ['pb', D0 + 2 * DAY + 2 * HOUR, '1'], ['pb', D0 + 2 * DAY + 3 * HOUR, '1'], ['px', D0 + 2 * DAY + 5 * HOUR, '-0.5'], ['pb', D0 + 11 * HOUR, '0.25']]
    .map(([positionId, time, fundingCharge]) => ({ positionId, productId: positionId === 'pb' ? 'btc' : 'xau', time, fundingCharge }));
  const S = FU.settle(ch, new Map([['pb', [D0 + 10 * HOUR, D0 + 12 * HOUR]], ['px', [D0 + DAY + 3 * HOUR]]]), (id) => (id === 'px' ? D0 + 4 * DAY : null));
  const reads = [{ spec: { res: 'day1', rowT: D0 - DAY, now: false }, rows: [{ time: D0 - DAY, tokenId: 'usd', unrealizedPnl: '0' }, { time: D0 - DAY, tokenId: 'xaup', unrealizedPnl: '0' }] },
    { spec: { res: 'day1', rowT: D0 + 2 * DAY, now: false }, rows: [{ time: D0 + 2 * DAY, tokenId: 'usd', unrealizedPnl: '-40' }, { time: D0 + 2 * DAY, tokenId: 'xaup', unrealizedPnl: '15' }, { time: D0 + 3 * DAY, tokenId: 'usd', unrealizedPnl: '99' }] }];
  return { P0, led, S, reads };
};

test('cash per margin pool is the reconciliation\'s opening and closing balance; equity = cash + unrealized, and net of the funding not settled', () => {
  const { P0, led, S, reads } = synth();
  assert.deepEqual(led.levels.opening, { usd: 1000 }); assert.deepEqual(led.levels.closing, { usd: 649, xaup: 180 });
  near(assert, led.opening, 1000, 1e-9); near(assert, led.closing, 829, 1e-9);
  const D = { reps: null, funding: { S } };
  const H = HO.build({ period: P0, now: LATER, money: USD, ref: REF, led, positions: POS, reads, D: null, live: [], prep: null });
  const [a, b] = H.instants;
  assert.equal(a.perps.cash, 1000); assert.equal(a.perps.upnl, 0); assert.equal(a.perps.equity, 1000); assert.equal(a.perps.open.length, 0);
  assert.equal(a.perps.funding, null, 'no trade detail yet: the funding not settled is not known'); assert.equal(a.perps.equityNet, null);
  near(assert, b.perps.cash, 829, 1e-9); near(assert, b.perps.upnl, -25, 1e-9, 'the bucket\'s row only'); near(assert, b.perps.equity, 804, 1e-9);
  assert.deepEqual(b.perps.pools.map((p) => [p.name, p.mPerp, p.cash, p.upnl, p.equity, p.open]), [['USD', false, 649, -40, 609, 1], ['XAUUSD', true, 180, 15, 195, 1]], 'USD first, then the mPerp pools');
  assert.equal(b.perps.posFees, null, 'position fees not settled: not recorded for a past instant');
  // with the trade detail: the funding charged before the end and settled after it, per position and per pool
  const H2 = HO.build({ period: P0, now: LATER, money: USD, ref: REF, led, positions: POS, reads, D, live: [], prep: null });
  const b2 = H2.instants[1].perps;
  near(assert, b2.funding, -2.5, 1e-12, 'paid 3 by the long (no fill after its charges), received 0.5 by the short (settled at its close, after the end)');
  assert.equal(b2.fundingFrom, 'charges');
  assert.deepEqual(b2.pools.map((p) => p.funding), [-3, 0.5]);
  near(assert, b2.equityNet, 804 - 2.5, 1e-9);
  assert.deepEqual(b2.open.map((r) => [r.positionId, r.funding]), [['pb', -3], ['px', 0.5]]);
  near(assert, U.sum(b2.open, (r) => r.funding), FU.unsettledAt(S.charges, P0.end).net, 1e-12);
  assert.equal(H2.instants[0].perps.funding, 0, 'nothing open at the start: nothing unsettled');
  // the change in equity with the transfers taken out: the net result + the change in unrealized PnL
  const ch = H2.change;
  near(assert, led.totals.deposits, 100, 1e-9); near(assert, led.totals.withdrawals, 301, 1e-9); near(assert, led.totals.net, 30, 1e-9);
  near(assert, ch.price, 804 - 1000 - 100 + 301, 1e-9); near(assert, ch.price, ch.result + ch.dUpnl + ch.unexplained, 1e-9);
  near(assert, ch.net, 801.5 - 1000 - 100 + 301, 1e-9);
});

test('the positions open at an instant from the positions list: sizes only where the position has not changed since', () => {
  const t = D0 + DAY + 5 * HOUR;
  const open = HO.openAt({ t, positions: POS, reps: null, ref: REF });
  assert.deepEqual(open.map((r) => [r.positionId, r.ticker, r.cls, r.long, r.size, r.avgEntry, r.known, r.pool]), [
    ['pb', 'BTC-USD', 'Crypto perps', true, 0.5, 60000, true, 'usd'],
    ['px', 'XAU-USD', 'Commodity mPerps', false, null, null, false, 'xaup']], 'the short was closed later: its size then needs the fills');
  assert.deepEqual(HO.openAt({ t: D0 + 10 * HOUR, positions: POS, ref: REF }).map((r) => r.positionId), [], 'a position opened at the instant is the period\'s, not held before it');
  assert.deepEqual(HO.openAt({ t: D0 + 4 * DAY, positions: POS, ref: REF }).map((r) => r.positionId), ['pb', 'px'], 'closed at the instant: still held just before it');
  assert.deepEqual(HO.openAt({ t: D0 + 4 * DAY + 1, positions: POS, ref: REF }).map((r) => r.positionId), ['pb']);
});

test('now: the exchange\'s own unsettled funding and position fees per open position, so equity is the account page\'s', () => {
  const { led, reads } = synth();
  const now = D0 + 2 * DAY + 7 * HOUR + 5 * 60000;
  const P1 = period('2026-09-01', '2026-12-31', 'UTC', now);
  const live = [{ id: 'pb', productId: 'btc', side: 0, size: '0.5', cost: '30000', createdAt: D0 + 10 * HOUR, updatedAt: D0 + 10 * HOUR, fundingUsd: '568.9871428564946', positionFeeUsd: '0', unrealizedPnl: '-40' },
    { id: 'pz', productId: 'xau', side: 0, size: '33.3634', cost: '139262.16794', createdAt: D0 + HOUR, updatedAt: D0 + HOUR, fundingUsd: '-2', positionFeeUsd: '111.052281319', unrealizedPnl: '15' }];
  const nowRead = { spec: { res: 'hour1', rowT: Math.floor(now / HOUR) * HOUR, now: true }, rows: [{ time: Math.floor(now / HOUR) * HOUR - HOUR, tokenId: 'usd', unrealizedPnl: '-39' }, { time: Math.floor(now / HOUR) * HOUR, tokenId: 'usd', unrealizedPnl: '-40' }, { time: Math.floor(now / HOUR) * HOUR, tokenId: 'xaup', unrealizedPnl: '15' }] };
  const H = HO.build({ period: P1, now, money: USD, ref: REF, led, positions: live, reads: [reads[0], nowRead], D: null, live, prep: null });
  const b = H.instants[1];
  assert.equal(b.now, true); assert.equal(b.label, 'Now');
  near(assert, b.perps.upnl, -25, 1e-12, 'the newest bucket');
  assert.equal(b.perps.fundingFrom, 'exchange');
  near(assert, b.perps.funding, -568.9871428564946 + 2, 1e-12); near(assert, b.perps.posFees, 111.052281319, 1e-12);
  // the account page: balance + Σ (unrealized − fundingUsd − positionFeeUsd)
  const page = led.closing + U.sum(live, (p) => U.num(p.unrealizedPnl) - U.num(p.fundingUsd) - U.num(p.positionFeeUsd));
  near(assert, b.perps.equityNet, page, 1e-9);
  assert.deepEqual(b.perps.open.map((r) => [r.positionId, r.size, r.upnl, r.posFees]), [['pz', 33.3634, 15, 111.052281319], ['pb', 0.5, -40, 0]]);
  near(assert, b.perps.open[0].avgEntry, 139262.16794 / 33.3634, 1e-9);
  // a bucket with no rows: zero only when nothing was open
  const empty = { spec: { res: 'day1', rowT: D0 - 3 * DAY, now: false }, rows: [] };
  assert.equal(HO.perpsAt({ t: D0, levels: {}, upnl: HO.upnlOf(empty), open: [], ref: REF }).upnl, 0);
  assert.equal(HO.perpsAt({ t: D0, levels: {}, upnl: HO.upnlOf(empty), open: [{ pool: 'usd' }], ref: REF }).upnl, null, 'positions open and no archive row: not known');
});

// ---------- a real subaccount ----------
const MM = perps('perps-0x2f46-to-2026-10-01.json');
const utc = (from, to) => PER.resolve({ from, to, tz: 'UTC' }, { now: LATER });

test('0x2f46: the positions open at an instant from the fills\' replay are the positions list\'s, with its sizes where they are known', () => {
  const P0 = utc('2026-08-01', '2026-09-30');
  const led = ledger(MD, MM, P0);
  const D = F.disposals(events(MD, MM, P0.start, P0.end), { ledger: led, period: P0, ref: MM.ref, tz: 'UTC' });
  let seen = 0;
  for (const t of [at('2026-09-10T00:00:00Z'), at('2026-09-18T13:30:00Z'), at('2026-09-25T00:00:00Z'), P0.end]) {
    const fills = HO.openAt({ t, positions: MM.positions, reps: D.reps, ref: MM.ref }), list = HO.openAt({ t, positions: MM.positions, ref: MM.ref });
    assert.deepEqual(fills.map((r) => r.positionId), list.map((r) => r.positionId), new Date(t).toISOString());
    for (const r of fills) { assert.ok(r.size > 0 && r.avgEntry > 0 && r.known && r.from === 'fills'); seen++; }
    for (const [i, r] of list.entries()) if (r.known) { near(assert, r.size, fills[i].size, 1e-8, r.positionId); if (r.avgEntry != null) near(assert, r.avgEntry, fills[i].avgEntry, 1e-6 * fills[i].avgEntry); }
    // the funding not settled: per position and per pool, adding up to T.funding.unsettledAt
    const u = FU.unsettledAt(D.funding.S.charges, t);
    const p = HO.perpsAt({ t, levels: {}, unsettled: u, open: fills, positions: MM.positions, ref: MM.ref });
    near(assert, U.sum(p.pools, (x) => x.funding), u.net, 1e-9);
    near(assert, U.sum(p.open, (r) => r.funding), u.net, 1e-9, 'only positions open at the instant have funding not settled');
  }
  assert.ok(seen >= 4, seen + ' open positions seen');
  // at the period end the replay holds what the exchange says is still open
  for (const r of HO.openAt({ t: MM.cutoff, positions: MM.positions, reps: D.reps, ref: MM.ref })) {
    const p = MM.positions.find((x) => x.id === r.positionId);
    if (U.num(p.size) !== 0 && U.num(p.updatedAt) < MM.cutoff) near(assert, r.size, Math.abs(U.num(p.size)), 1e-8, p.id);
  }
});

test('0x2f46 in a local zone: the levels at each instant are the archive rows the bucket rule picks, and add up to the reconciliation\'s balances', () => {
  for (const [from, to, tz] of [['2026-08-01', '2026-09-30', 'UTC'], ['2026-09-10', '2026-09-24', 'Europe/London'], ['2026-09-05', '2026-09-27', 'Asia/Kolkata']]) {
    const P0 = PER.resolve({ from, to, tz }, { now: LATER });
    const led = ledger(MD, MM, P0);   // no hourly rows: a busy split day is kept whole (fallbackDays)
    near(assert, U.sum(Object.values(led.levels.opening)), led.opening, 1e-9); near(assert, U.sum(Object.values(led.levels.closing)), led.closing, 1e-9);
    const inst = HO.instants(P0, LATER);
    inst.forEach((x, i) => {
      const s = HO.archiveRow(x.t, { now: LATER, fallbackDays: led.fallbackDays });
      if (s.res !== 'day1') { assert.ok(x.t % DAY !== 0 && !led.fallbackDays.includes(Math.floor(x.t / DAY) * DAY)); return; }
      // the daily rows at the bucket: each pool's last row at or before it
      const last = new Map(); for (const r of MM.balance) if (U.num(r.time) <= s.rowT) last.set(r.tokenId, U.num(r.balance));
      near(assert, U.sum(Array.from(last.values())), i ? led.closing : led.opening, 1e-6, `${tz} ${x.key}`);
    });
  }
});

test('the change in equity on a real subaccount: deposits and withdrawals out, it is the net result plus the change in unrealized PnL', () => {
  const P0 = utc('2026-09-05', '2026-09-25');
  const led = ledger(MD, MM, P0);
  const read = (rowT, v) => ({ spec: { res: 'day1', rowT, now: false }, rows: [{ time: rowT, tokenId: MM.tokens[0].id, unrealizedPnl: String(v) }] });
  const H = HO.build({ period: P0, now: LATER, money: USD, ref: MM.ref, led, positions: MM.positions, reads: [read(P0.start - DAY, -12.5), read(P0.end - DAY, 40.25)], D: null, live: [], prep: null });
  const c = H.change;
  near(assert, c.dUpnl, 52.75, 1e-9);
  near(assert, c.price, H.instants[1].perps.equity - H.instants[0].perps.equity - led.totals.deposits + led.totals.withdrawals, 1e-9);
  near(assert, c.price, led.totals.net + 52.75 + led.recon.diff, 1e-6);
  assert.equal(c.net, null, 'no funding not settled without the trade detail');
});

// ---------- the rate at an instant ----------
test('values at an instant convert at the rate of the local day before it, and say which date that is', () => {
  const tz = 'Europe/London', money = eur(tz);
  const P0 = PER.resolve({ fy: 'uk', year: 2026, tz }, { now: LATER, firstT: Date.UTC(2026, 5, 29), browserZone: 'UTC' });
  assert.equal(P0.start, at('2026-04-05T23:00:00Z'));
  const r = HO.rateAt(money, P0.start);
  assert.equal(r.label, '2026-04-05', 'the start of 6 Apr reads 5 Apr (the last full local day before the instant)');
  near(assert, HO.fxAt(money, 100, P0.start), 100 * money.rates.on(at('2026-04-05T12:00:00Z'), tz).r, 1e-12);
  assert.equal(HO.fxAt(money, null, P0.start), null);
  assert.equal(HO.rateAt(USD, P0.start), null); assert.equal(HO.fxAt(USD, 7, P0.start), 7);
  const { led, reads } = synth();
  const P1 = period('2026-09-01', '2026-09-03', tz);
  const H = HO.build({ period: P1, now: LATER, money, ref: REF, led, positions: POS, reads, D: null, live: [], prep: null });
  assert.deepEqual(H.instants.map((x) => x.rate.label), ['2026-08-31', '2026-09-03']);
  near(assert, H.instants[1].perpsC.equity, H.instants[1].perps.equity * money.rates.on(at('2026-09-03T12:00:00Z'), tz).r, 1e-9);
});

// ---------- Meridian Predict at an instant ----------
const wei = (x) => (BigInt(Math.round(x * 1e6)) * 1000000000000n).toString();
const sec = (ms) => Math.floor(ms / 1000);
const W = '0x00000000000000000000000000000000000000a1';
const B1 = '0x0000000000000000000000000000000000000b01';
const X = '0x00000000000000000000000000000000000000e1';
const T0 = Date.UTC(2026, 7, 3);
function mk({ id, predictor = W, counterparty = X, stake, cp, t, verdict = null, decidedAt = null, claimedAt = null }) {
  const pc = 'pc-' + id;
  return P.norm({ predictionId: id, predictor, counterparty, predictorCollateral: wei(stake), counterpartyCollateral: wei(cp), predictorToken: 'tp-' + pc, counterpartyToken: 'tc-' + pc,
    settled: !!claimedAt, result: claimedAt ? verdict : null, createdAt: new Date(t).toISOString(), settledAt: claimedAt ? new Date(claimedAt).toISOString() : null, createTxHash: '0xp' + id, settleTxHash: claimedAt ? '0xs' + id : null,
    pickConfig: { pickConfigId: pc, resolved: !!verdict, result: verdict, picks: [{ conditionId: 'c-' + id, predictedOutcome: 'YES', condition: { question: 'Q ' + id, endTime: sec(t + 30 * DAY), settled: !!verdict, settledAt: verdict ? sec(decidedAt) : null, resolvedToYes: verdict === 'PREDICTOR_WINS' ? true : verdict === 'COUNTERPARTY_WINS' ? false : null, nonDecisive: verdict === 'NON_DECISIVE' } }] } });
}
const trade = ({ t, seller, buyer, tokens, paid, n, side = 'P' }) => Object.assign({ t, seller, buyer, tokens, paid, pc: n.pc, pid: n.id, side, q: 'Q', dAt: n.decided ? P.decidedAt(n) : null, sa: n.settledAt },
  !n.decided ? { vP: null, vC: null } : n.won ? { vP: 1, vC: 0 } : n.nd ? { vP: n.stake / n.pool, vC: n.cp / n.pool } : { vP: 0, vC: 1 });
const book = () => {
  const a = mk({ id: 'a', stake: 10, cp: 30, t: T0, verdict: 'PREDICTOR_WINS', decidedAt: T0 + DAY, claimedAt: T0 + 3 * DAY });             // a win, claimed two days after its decision
  const b = mk({ id: 'b', stake: 5, cp: 5, t: T0 + HOUR, verdict: 'COUNTERPARTY_WINS', decidedAt: T0 + 2 * DAY, claimedAt: T0 + 4 * DAY });   // a loss, the maker claims the pool later
  const c = mk({ id: 'c', stake: 8, cp: 2, t: T0 + 2 * HOUR });                                                                             // open
  const d = mk({ id: 'd', predictor: B1, counterparty: W, stake: 4, cp: 6, t: T0 + 3 * HOUR, verdict: 'COUNTERPARTY_WINS', decidedAt: T0 + DAY });   // as the maker: a win never claimed
  const e = mk({ id: 'e', stake: 3, cp: 3, t: T0, verdict: 'NON_DECISIVE', decidedAt: T0 + DAY, claimedAt: T0 + 5 * DAY });                 // void, refund claimed later
  const f = mk({ id: 'f', stake: 10, cp: 10, t: T0 + 4 * HOUR });                                                                           // open, 8 of its 20 tokens sold
  const g = mk({ id: 'g', stake: 6, cp: 4, t: T0, verdict: 'PREDICTOR_WINS', decidedAt: T0 + 2 * DAY });                                    // won, half sold first, the rest redeemed later
  const trades = [trade({ t: T0 + 10 * HOUR, seller: W, buyer: X, tokens: 8, paid: 5, n: f }), trade({ t: T0 + HOUR, seller: W, buyer: X, tokens: 5, paid: 3, n: g })];
  return PR.prepare({ norms: [a, b, c, d, e, f, g], trades, rd: { 'pc-g|P': T0 + 6 * DAY }, addr: W });
};

test('Predict at an instant: open predictions at stake, tokens at the ledger\'s cost as it stood, results decided and not claimed by the decision time', () => {
  const prep = book();
  const h1 = PR.holdingsAt(prep, T0 + 5 * HOUR);
  assert.deepEqual(h1.open, { n: 6, cost: 10 + 5 + 8 + 6 + 3 + 10 }, 'every own prediction not decided yet, the maker\'s at its collateral; f is not traded yet: a plain prediction');
  assert.deepEqual(h1.tokens, { n: 1, tokens: 5, cost: 3 }, 'g after the sale of half its tokens: in the ledger');
  assert.deepEqual(PR.holdingsAt(prep, T0 + 11 * HOUR).tokens, { n: 2, tokens: 12 + 5, cost: 6 + 3 }, 'f after its sale: 12 of its 20 tokens at 6');
  assert.deepEqual(Object.values(h1.unclaimed).every((v) => v === 0), true);
  const h2 = PR.holdingsAt(prep, T0 + 2 * DAY + HOUR);
  assert.deepEqual(h2.open, { n: 1, cost: 8 });
  assert.deepEqual(h2.tokens, { n: 1, tokens: 12, cost: 6 }, 'f after selling 8 of 20 tokens: 12 at 6');
  const u = h2.unclaimed;
  assert.deepEqual([u.won, u.payout, u.lost, u.lostStake, u.void, u.refund], [2, 40 + 10, 1, 5, 1, 3], 'a and d won (pool, stake included), b lost, e void');
  assert.deepEqual([u.held, u.heldValue, u.heldCost, u.heldLost], [1, 5, 3, 0], 'g: decided, not redeemed yet');
  const h3 = PR.holdingsAt(prep, LATER);
  assert.deepEqual([h3.open.cost, h3.tokens.cost, h3.unclaimed.won, h3.unclaimed.payout, h3.unclaimed.held, h3.unclaimed.lost], [8, 6, 1, 10, 0, 0], 'd is never claimed; g redeemed');
  near(assert, h3.cost, PR.openStakes(prep), 1e-12, 'now: the card\'s Open stakes now');
  // the same results the Predict card lists as decided and not claimed by an instant
  const tail = PR.tail(prep, 'claim', { start: 0, end: T0 + 2 * DAY + HOUR });
  assert.deepEqual(['won', 'lost', 'void', 'held-verdict'].map((k) => tail.items.filter((x) => x.kind === k).length), [2, 1, 1, 1]);
  near(assert, U.sum(tail.items.filter((x) => x.kind === 'won'), (x) => x.ref.stakeW + x.ref.pnlW), u.payout, 1e-12);
});

test('Predict at an instant on four real wallets: now is Open stakes now, and the results decided and not claimed are the Predict card\'s', () => {
  for (const f of ['predict-0xba3b-buyer.json', 'predict-0xc1ce-trader.json', 'predict-0xaca4-traded.json', 'predict-0xea41-maker.json']) {
    const j = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/tax', f), 'utf8'));
    const prep = PR.prepare({ norms: j.predictions.map(P.unslim), trades: j.trades || [], rd: j.rd, rows: j.rows, rowsFmt: j.rowsFmt, truncated: !!j.truncated, total: j.total, newest: j.newest, addr: j.address, builtAt: j.builtAt });
    near(assert, PR.holdingsAt(prep, LATER).cost, PR.openStakes(prep), 1e-6, f + ': now');
    for (const t of [Date.UTC(2026, 6, 15), Date.UTC(2026, 7, 20), Date.UTC(2026, 8, 10), Date.UTC(2026, 8, 30)]) {
      const hx = PR.holdingsAt(prep, t), u = hx.unclaimed;
      for (const v of [hx.open.cost, hx.tokens.cost, hx.tokens.tokens, u.payout, u.refund, u.lostStake, u.heldValue, u.heldCost]) assert.ok(Number.isFinite(v) && v >= -1e-9, f);
      // the Predict card's decided-not-claimed results, plus any on a pick configuration the wallet traded only later
      const tail = PR.tail(prep, 'claim', { start: 0, end: t }).items, msg = `${f} ${new Date(t).toISOString().slice(0, 10)}`;
      const nTraded = prep.items.filter((it) => it.traded).length;
      for (const k of ['won', 'lost', 'void']) { const d = u[k] - tail.filter((x) => x.kind === k).length; assert.ok(d >= 0 && d <= nTraded, msg + ' ' + k); }
      // open: placed before the instant and not decided before it
      const notDecided = (it) => it.t < t && (it.res === 'open' || !(it.claimable.t < t));
      assert.ok(hx.open.n >= prep.items.filter((it) => !it.traded && notDecided(it)).length && hx.open.n <= prep.items.filter(notDecided).length, msg);
    }
  }
});

// ---------- the words, the summary rows and the file ----------
test('the Open at period end tile of a past period: the archive\'s unrealized PnL at the end, price only, in no total (B20)', () => {
  const end = at('2026-09-29T00:00:00Z');
  assert.equal(HO.tileLine(7, -1111.52, USD, end), '-$1,111.52 unrealized at period end (price only, before unsettled funding and position fees) · not included in Net result or Realized PnL');
  assert.equal(HO.tileLine(7, undefined, USD, end), 'carried into the next period · unrealized PnL at period end loading…');
  assert.equal(HO.tileLine(7, null, USD, end), 'carried into the next period · unrealized PnL at period end could not be loaded');
  assert.equal(HO.tileLine(0, null, USD, end), 'nothing carried into the next period');
  const money = eur();
  assert.ok(HO.tileLine(2, 100, money, end).startsWith(money.fmt(100 * money.rates.on(end - 1, 'UTC').r, { sign: true }) + ' unrealized at period end'), 'at the rate of the last day in the period');
  assert.ok(!/not recorded/.test(HO.tileLine(1, 0, USD, end)));
});

test('the summary rows and the Holdings file: both instants, perps and Predict, USD and the report currency at each instant\'s rate, the methodology first', () => {
  const { P0, led, S, reads } = synth();
  const money = eur();
  const lotsRun = (r) => LO.run([{ t: D0 - DAY, dir: 'in', loc: LO.PREDICT, units: 50, usd: 50, c: 40, px: 1, kind: 'payout', what: '', src: 'test', n: 1 }, { t: D0 + DAY, dir: 'out', loc: LO.PREDICT, units: 20, usd: 20, c: 17, px: 1, kind: 'stake', what: '', src: 'test', n: 2 }], { method: 'fifo', scope: 'global', reading: r, tz: 'UTC', at: [P0.start, P0.end] });
  const lots = { runs: { transfer: lotsRun('transfer'), disposal: lotsRun('disposal') }, names: {}, method: 'fifo', scope: 'global', dep: 'transfer' };
  const H = HO.build({ period: P0, now: LATER, money, ref: REF, led, positions: POS, reads, D: { reps: null, funding: { S } }, live: [], prep: book(), lots });
  assert.deepEqual(H.instants.map((x) => x.lots.transfer.units), [50, 30]);
  const rows = HO.rows(H, money), get = (label) => { const r = rows.find((x) => x[0] === label); assert.ok(r, 'no row ' + label); return r; };
  const rEnd = money.rates.on(P0.end - 1, 'UTC').r;
  assert.deepEqual(get('Perps unrealized PnL at period end (price only, before unsettled funding and position fees)').slice(0, 2), ['Perps unrealized PnL at period end (price only, before unsettled funding and position fees)', '-25']);
  assert.equal(get('Perps equity at period end (cash + unrealized, price only)')[2], T.n6(804 * rEnd));
  assert.equal(get('Perps equity at period start (cash + unrealized, price only)')[1], '1000');
  assert.equal(get('Perps equity at period end, net of unsettled funding')[1], '801.5');
  assert.equal(get('Perps positions open at period end')[1], 2);
  assert.match(get('Rate for the holdings at period end (the local day before it)')[2], /^1 USD = [0-9.]+ EUR \(2026-09-03\)$/);
  assert.ok(rows.some((r) => /^Predict open predictions at period start, at stake \(cost\)$/.test(r[0])));
  assert.ok(rows.some((r) => /^Perps change in equity over the period, deposits and withdrawals taken out \(price only\)$/.test(r[0]) && r[1] === T.n6(H.change.price)));
  // the file: a site report, its methodology first (the disclaimer included), then the tables
  const ctx = { H, period: P0, tz: 'UTC', money, fname: (k) => k + '.csv', lotsInfo: { method: 'fifo', scope: 'global' }, warnings: [] };
  const file = EX.build('holdings', ctx);
  assert.equal(file.kind, 'report'); assert.equal(EX.fileName(file), 'holdings.csv');
  assert.deepEqual(file.sections.map((s) => s.title), ['Holdings', 'Positions open at each instant', 'Change in perps equity, deposits and withdrawals taken out']);
  const meth = HO.describe(Object.assign({ addr: W, sid: 'sid-1', now: LATER }, ctx));
  assert.deepEqual(meth.slice(0, 2).map((r) => r[0]), ['Report', 'Disclaimer']); assert.equal(meth[1][1], T.DISCLAIMER);
  const csv = EX.render(file, meth);
  assert.ok(csv.startsWith('Report,'));
  const main = file.sections[0], col = (name) => { const c = main.columns.find((x) => x[0] === name); assert.ok(c, 'no column ' + name); return c[1]; };
  assert.deepEqual(main.columns.map((c) => c[0]), ['Instant', 'Time (UTC)', 'Item', 'Detail', 'Count', 'USD', 'EUR', 'USD→EUR rate (the local day before the instant)', 'Rate date (ECB)', 'Note']);
  const eq = main.rows.find((r) => r.x.key === 'end' && r.item === 'Perps equity (cash + unrealized, price only)');
  assert.deepEqual([col('USD')(eq), col('EUR')(eq), col('Rate date (ECB)')(eq), col('Time (UTC)')(eq)], ['804', T.n6(804 * rEnd), '2026-09-03', '2026-09-04 00:00:00 UTC']);
  const pf = main.rows.find((r) => r.x.key === 'end' && r.item === 'Perps position fees accrued, not settled');
  assert.deepEqual([col('USD')(pf), col('EUR')(pf), col('Note')(pf)], ['', '', 'not recorded for a past instant'], 'blank, never 0, where a value is not known');
  assert.ok(main.rows.some((r) => r.item === 'Predict decided, not claimed: payouts of wins'));
  assert.ok(main.rows.some((r) => /^USDe lots held: cost \(wrapping as a disposal\)$/.test(r.item)));
  assert.equal(file.sections[1].rows.length, 2, 'the two positions open at the end');
  // a Predict-only wallet: no perps rows, no change
  const H2 = HO.build({ period: P0, now: LATER, money: USD, ref: REF, led: null, positions: [], reads: null, prep: book() });
  assert.equal(H2.change, null); assert.equal(H2.instants[0].perps, null);
  assert.ok(HO.rows(H2, USD).every((r) => !/^Perps/.test(r[0])));
  assert.deepEqual(EX.build('holdings', Object.assign({}, ctx, { H: H2, money: USD })).sections.map((s) => s.rows.length), [12, 0]);
});

test('an instant before the first published rate has none: the card\'s heading, the summary rows and the Holdings file say so and leave the converted values blank, never a later rate (B2)', () => {
  const { P0, led, S, reads } = synth();
  // rates from 2 Sep only: the start (1 Sep 00:00, whose day before is 31 Aug) has none, the end (4 Sep) has 3 Sep's
  const d = [], r = [];
  for (let t = Date.UTC(2026, 8, 2), i = 0; t < Date.UTC(2026, 9, 1); t += DAY, i++) { d.push(new Date(t).toISOString().slice(0, 10)); r.push(0.9 + i / 100); }
  const money = T.fx.money(T.fx.rates({ ccy: 'EUR', id: 'ecb', via: 'file', table: { source: 'ecb', ccy: 'EUR', d, r, ref: null }, tz: 'UTC' }), 'UTC');
  const x0 = HO.rateAt(money, P0.start);
  assert.deepEqual([x0.none, x0.label, x0.r], [true, T.fx.NO_RATE, null]);
  assert.equal(HO.fxAt(money, 1000, P0.start), null, 'a value there stays in USD only'); assert.equal(HO.fxAt(money, 0, P0.start), 0, 'nothing held converts to nothing, rate or not'); assert.equal(HO.fxAt(money, null, P0.start), null);
  assert.equal(HO.rateAt(money, P0.end).date, '2026-09-03');
  const H = HO.build({ period: P0, now: LATER, money, ref: REF, led, positions: POS, reads, D: { reps: null, funding: { S } }, live: [], prep: null });
  assert.equal(H.instants[0].rate.none, true);
  assert.equal(H.instants[0].perpsC.cash, null); assert.equal(H.instants[0].perps.cash, 1000);
  assert.equal(H.change.priceC, null, 'no change in EUR without the start\'s rate'); assert.ok(H.change.price != null);
  const rows = HO.rows(H, money), get = (label) => rows.find((x) => x[0] === label);
  assert.deepEqual(get('Rate for the holdings at period start (the local day before it)'), ['Rate for the holdings at period start (the local day before it)', '', T.fx.NO_RATE]);
  assert.deepEqual(get('Perps cash balance at period start'), ['Perps cash balance at period start', '1000', '']);
  assert.match(get('Rate for the holdings at period end (the local day before it)')[2], /^1 USD = [0-9.]+ EUR \(2026-09-03\)$/);
  assert.equal(T.fx.rateLine(H.instants[0].rate, 'EUR'), T.fx.NO_RATE);
  const file = EX.build('holdings', { H, period: P0, tz: 'UTC', money, fname: (k) => k + '.csv', lotsInfo: null, warnings: [] });
  const main = file.sections[0], col = (name) => main.columns.find((c) => c[0] === name)[1];
  const cash = main.rows.find((x) => x.x.key === 'start' && x.item === 'Perps cash balance' && x.detail === 'all pools');
  assert.deepEqual([col('USD')(cash), col('EUR')(cash), col('USD→EUR rate (the local day before the instant)')(cash), col('Rate date (ECB)')(cash)], ['1000', '', '', T.fx.NO_RATE]);
  const meth = Object.fromEntries(HO.describe({ H, period: P0, tz: 'UTC', money, addr: W, now: LATER }));
  assert.match(meth['Rate at an instant'], /has none \(no rate \(before the first published rate\)\): its values stay in USD only/);
  // the tile line of a period that ended: the USD figure, said so
  assert.match(HO.tileLine(1, -25, money, P0.start), /^-\$25\.00 \(no rate \(before the first published rate\)\) unrealized at period end/);
});
