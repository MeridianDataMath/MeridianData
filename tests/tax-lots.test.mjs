// Tax center, USDe lots (MD.tax.lots): FIFO, LIFO, the moving average and the UK's same-day, 30-day and s104 pooling on
// worked examples; the three scopes and the two deposit readings; opening lots and what no lot covers; the events of a
// real perps account and the Predict wallet's USDe; the USDe/USD price; the files; 50,000 events in well under a second.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { load, near, root } from './_load.mjs';
import { perps, events as fixtureEvents } from './_tax-fixture.mjs';

const MD = load(['js/util.js', 'js/api.js', 'js/predict/api.js', 'js/predict/analytics.js', 'js/tax/core.js', 'js/tax/tz.js', 'js/tax/periods.js', 'js/tax/fx.js', 'js/tax/ledger.js', 'js/tax/load.js', 'js/tax/fills.js', 'js/tax/funding.js', 'js/tax/predict.js', 'js/tax/lots.js', 'js/tax/summary.js', 'js/tax/exports.js']);
const P = MD.predict, T = MD.tax, LO = T.lots, PR = T.predict, EX = T.exports, FX = T.fx;
const DAY = 86400000, HOUR = 3600000;
const USD = FX.money(null, 'UTC');

let N = 0;
/** a flow as usdeEvents writes it: units in or out of a location, valued (usd at par unless given, c in the report currency) */
const E = (t, dir, units, c, o = {}) => Object.assign({ t, dir, loc: LO.PREDICT, units, usd: units, c, px: 1, kind: dir === 'in' ? 'payout' : 'stake', what: '', src: 'test', n: N++ }, o);
const MV = (t, from, to, units, c, kind) => ({ t, dir: 'move', from, to, units, usd: units, c, px: 1, kind, what: '', src: 'test', n: N++ });
const run = (evs, o) => LO.run(evs.slice().sort(LO.order), Object.assign({ tz: 'UTC', scope: 'global', reading: 'transfer' }, o));
const D = (d, h = 9) => Date.UTC(2026, 6, d, h);

// ---------- the methods ----------
test('FIFO, LIFO and the moving average on one pool: cost, gain, the pieces and their dates; at par in USD every gain is 0', () => {
  const evs = [E(D(1), 'in', 10, 8), E(D(2), 'in', 10, 9), E(D(3), 'in', 10, 10), E(D(4), 'out', 15, 15), E(D(5), 'out', 10, 12)];
  const want = { fifo: [8 + 4.5, 4.5 + 5], lifo: [10 + 4.5, 4.5 + 4], average: [13.5, 9] };
  for (const [m, [c1, c2]] of Object.entries(want)) {
    const r = run(evs, { method: m });
    assert.equal(r.disposals.length, 2, m);
    const [a, b] = r.disposals;
    near(assert, a.costC, c1, 1e-9, m + ' first cost'); near(assert, a.gainC, 15 - c1, 1e-9, m + ' first gain');
    near(assert, b.costC, c2, 1e-9, m + ' second cost'); near(assert, b.gainC, 12 - c2, 1e-9, m + ' second gain');
    for (const d of r.disposals) { near(assert, d.gainUsd, 0, 1e-12, m + ': par, USD'); near(assert, d.costUsd, d.units, 1e-12); }
    near(assert, r.pools[0].units, 5, 1e-9, m + ' left');
    assert.equal(r.short.n, 0); assert.equal(r.uncovered.n, 0);
  }
  // the pieces: FIFO the earliest lots, LIFO the latest, the average's dates first in, first out
  const day = (x) => new Date(x.acqT).toISOString().slice(0, 10);
  assert.deepEqual(run(evs, { method: 'fifo' }).disposals[0].pieces.map((x) => [day(x), x.units, x.rule]), [['2026-07-01', 10, 'FIFO'], ['2026-07-02', 5, 'FIFO']]);
  assert.deepEqual(run(evs, { method: 'lifo' }).disposals[0].pieces.map((x) => [day(x), x.units]), [['2026-07-03', 10], ['2026-07-02', 5]]);
  const av = run(evs, { method: 'average' }).disposals[0];
  assert.deepEqual(av.pieces.map((x) => [day(x), x.units, x.rule]), [['2026-07-01', 10, 'average'], ['2026-07-02', 5, 'average']]);
  near(assert, av.pieces[0].c, 9, 1e-9, 'each piece at the average cost'); assert.equal(av.pieces[0].days, 3);
  assert.equal(av.rule, 'average');
});

test('holding periods: days and over a year in calendar dates of the zone (29 Feb\'s anniversary is 28 Feb)', () => {
  const a = Date.UTC(2028, 1, 29, 12), s1 = Date.UTC(2029, 1, 28, 12), s2 = Date.UTC(2029, 2, 1, 12);
  const r = run([E(a, 'in', 2, 2), E(s1, 'out', 1, 1), E(s2, 'out', 1, 1)], { method: 'fifo' });
  assert.deepEqual(r.disposals.map((d) => [d.pieces[0].days, d.pieces[0].overYear]), [[365, false], [366, true]]);
});

test('UK pooling on a worked example: same day first, then the next 30 days earliest first, then the s104 pool (Europe/London dates)', () => {
  const t = (m, d, h = 9) => Date.UTC(2026, m - 1, d, h);
  const evs = [
    E(t(4, 10), 'in', 100, 100), E(t(4, 19), 'in', 50, 60),
    E(t(4, 29), 'out', 70, 84), E(t(4, 29, 14), 'in', 20, 25),          // 20 matched the same day
    E(t(5, 4), 'in', 30, 33),                                              // within 30 days of 29 Apr
    E(t(6, 10), 'out', 5, 6), E(t(6, 12), 'out', 8, 9.6),                  // two disposals share the next acquisitions, earliest first
    E(t(6, 15), 'in', 10, 13), E(t(6, 20), 'in', 10, 14),
    E(t(7, 20), 'in', 10, 12),
    E(t(8, 1), 'in', 50, 55), E(t(8, 1, 16), 'out', 20, 25),               // more acquired than disposed of on one day
    E(t(8, 20), 'out', 30, 36),                                            // its 30 days run past the data
  ];
  const r = run(evs, { method: 'uk', tz: 'Europe/London', cutoff: Date.UTC(2026, 8, 1) });
  const [d1, d2, d3, d4, d5] = r.disposals;
  // 29 Apr: 20 at the same day's 25, 30 at 4 May's 33, 20 from the pool of 150 units costing 160
  assert.deepEqual(d1.pieces.map((x) => [x.rule, x.units]), [['same day', 20], ['30 days', 30], ['s104 pool', 20]]);
  near(assert, d1.costC, 25 + 33 + 160 * 20 / 150, 1e-9); near(assert, d1.gainC, 84 - (58 + 160 * 20 / 150), 1e-9);
  assert.equal(d1.rule, 'same day + 30 days + s104 pool');
  assert.equal(d1.pieces[1].days, -5, 'a 30-day match is acquired after the disposal');
  // 10 Jun takes 5 of 15 Jun's; 12 Jun the other 5 of 15 Jun's and 3 of 20 Jun's
  assert.deepEqual(d2.pieces.map((x) => [x.rule, x.units]), [['30 days', 5]]); near(assert, d2.costC, 6.5, 1e-9);
  assert.deepEqual(d3.pieces.map((x) => [x.rule, x.units]), [['30 days', 5], ['30 days', 3]]); near(assert, d3.costC, 6.5 + 4.2, 1e-9);
  // 1 Aug: 20 of that day's 50 at 1.10 each; the other 30 go to the pool
  assert.deepEqual(d4.pieces.map((x) => [x.rule, x.units]), [['same day', 20]]); near(assert, d4.costC, 22, 1e-9);
  // 20 Aug: from the pool (130 left after April, + 7 of 20 Jun's, + 20 Jul's 10, + 1 Aug's 30)
  const poolU = 130 + 7 + 10 + 30, poolC = 160 * 130 / 150 + 9.8 + 12 + 33;
  assert.deepEqual(d5.pieces.map((x) => [x.rule, x.units]), [['s104 pool', 30]]); near(assert, d5.costC, poolC * 30 / poolU, 1e-9);
  assert.deepEqual(r.disposals.map((d) => d.provisional), [false, false, false, false, true], 'only the one whose 30 days are not over');
  near(assert, r.pools[0].units, poolU - 30, 1e-9); near(assert, r.pools[0].c, poolC * (poolU - 30) / poolU, 1e-9);
  // the same-day rule goes by the local date: 23:30 UTC on 28 Apr is 29 Apr in London
  const r2 = run([E(t(4, 10), 'in', 10, 10), E(Date.UTC(2026, 3, 28, 23, 30), 'in', 5, 7), E(t(4, 29), 'out', 5, 6)], { method: 'uk', tz: 'Europe/London' });
  assert.deepEqual(r2.disposals[0].pieces.map((x) => x.rule), ['same day']); near(assert, r2.disposals[0].costC, 7, 1e-9);
  const r3 = run([E(t(4, 10), 'in', 10, 10), E(Date.UTC(2026, 3, 28, 23, 30), 'in', 5, 7), E(t(4, 29), 'out', 5, 6)], { method: 'uk', tz: 'UTC' });
  assert.deepEqual(r3.disposals[0].pieces.map((x) => x.rule), ['s104 pool'], 'in UTC it was the day before (and before the disposal: the pool)');
  // near the end of the data: a disposal its own day's acquisitions cover whole cannot change; one that reaches the pool can
  const r4 = run([E(t(8, 1), 'in', 50, 50), E(t(8, 25), 'in', 10, 11), E(t(8, 25, 15), 'out', 10, 12), E(t(8, 26), 'out', 5, 6)], { method: 'uk', tz: 'Europe/London', cutoff: Date.UTC(2026, 8, 1) });
  assert.deepEqual(r4.disposals.map((d) => [d.rule, d.provisional]), [['same day', false], ['s104 pool', true]]);
});

// ---------- scopes, readings, opening lots ----------
const rate = [0, 0.9, 0.92, 0.95, 0.94, 0.96, 0.97];
const book = (opening = true) => [
  ...(opening ? [E(D(1), 'in', 100, 90, { loc: LO.OUT, kind: 'opening' })] : []),
  MV(D(2), LO.OUT, 'pool:usd', 100, 100 * rate[2], 'deposit'),
  E(D(3), 'in', 10, 10 * rate[3], { loc: 'pool:usd', kind: 'gain' }),
  MV(D(4), 'pool:usd', 'pool:xau', 50, 50 * rate[4], 'convert'),
  E(D(5), 'out', 1, rate[5], { loc: 'pool:xau', kind: 'fee' }),
  MV(D(6), 'pool:usd', LO.OUT, 50, 50 * rate[6], 'withdraw'),
];
const sum = (r) => r.disposals.map((d) => [d.kind, d.key, +d.gainC.toFixed(9)]);

test('scopes and deposit readings: what is a disposal, and against which lots (FIFO)', () => {
  const ev = book();
  // one pool, deposits as transfers: only the fee, against the opening lot (0.90 a unit)
  assert.deepEqual(sum(run(ev, { method: 'fifo', scope: 'global' })), [['fee', 'all', 0.06]]);
  // per wallet: the conversion stays inside the perps subaccount
  assert.deepEqual(sum(run(ev, { method: 'fifo', scope: 'wallet' })), [['fee', 'perps', 0.06]]);
  // per pool: the conversion moves the earliest lots of the USD pool (the opening lots moved in with the deposit) to the
  // XAU pool with their date and cost, so the XAU fee is against the opening lot's 0.90; the withdrawal moves the
  // earliest lots left back out
  const p = run(ev, { method: 'fifo', scope: 'pool', at: [D(7)] });
  assert.deepEqual(sum(p), [['fee', 'pool:xau', 0.06]]);
  assert.equal(new Date(p.disposals[0].pieces[0].acqT).toISOString().slice(0, 10), '2026-07-01', 'the moved lot keeps its acquisition date');
  const end = Object.fromEntries(p.at[0].pools.map((x) => [x.key, [+x.units.toFixed(9), +x.c.toFixed(9)]]));
  assert.deepEqual(end, { out: [50, 45], 'pool:usd': [10, 9.5], 'pool:xau': [49, 44.1] });
  assert.deepEqual(LO.expand(ev, { scope: 'pool', reading: 'disposal' }).filter((o) => o.ev.kind === 'convert').map((o) => [o.op, o.from, o.to, o.units]), [['mv', 'pool:usd', 'pool:xau', 50]], 'a move under the disposal reading too');
  // wrapping as a disposal: the deposit disposes of the opening lots at the day's value, the withdrawal of the pool's
  assert.deepEqual(sum(run(ev, { method: 'fifo', scope: 'global', reading: 'disposal' })), [['deposit', 'all', 2], ['fee', 'all', 0.04], ['withdraw', 'all', 2.5]]);
  assert.deepEqual(sum(run(ev, { method: 'fifo', scope: 'pool', reading: 'disposal' })), [['deposit', 'out', 2], ['fee', 'pool:xau', 0.04], ['withdraw', 'pool:usd', 2.5]]);
  // every scope and reading keeps the units: what is left equals what came in less what went out; a conversion is never
  // a disposal, and no scope comes up short
  for (const scope of LO.SCOPES) for (const reading of LO.READINGS) for (const method of LO.METHODS) {
    const r = run(ev, { method, scope, reading });
    near(assert, U(r.pools, (x) => x.units), 100 + 10 - 1, 1e-9, `${method} ${scope} ${reading}`);
    assert.ok(!r.disposals.some((d) => d.kind === 'convert'), `${method} ${scope} ${reading}: no conversion disposal`);
    assert.deepEqual(r.short, { n: 0, units: 0 }, `${method} ${scope} ${reading}`);
  }
  // in a report currency whose rate moved between acquiring and converting, the conversion gives no gain or loss
  const eurGain = (scope) => U(run(ev, { method: 'fifo', scope }).disposals, (d) => d.gainC);
  near(assert, eurGain('pool'), eurGain('global'), 1e-12, 'per pool and one pool alike: only the fee');
});

test('UK pooling runs with one pool for everything only: a move between pools never competes with the same-day and 30-day matches (no shortfall, no phantom units)', () => {
  assert.deepEqual(LO.scopesFor('uk'), ['global']); assert.deepEqual(LO.scopesFor('fifo'), LO.SCOPES);
  assert.equal(LO.scopeFor('uk', 'pool'), 'global'); assert.equal(LO.scopeFor('uk', null), 'global', 'its only scope');
  assert.equal(LO.scopeFor('fifo', 'pool'), 'pool'); assert.equal(LO.scopeFor('fifo', null), null, 'still to choose');
  assert.equal(LO.scopeFor(null, 'wallet'), 'wallet');
  // one UTC day: 100 into pool a, moved out of Meridian, then 100 spent from pool a (drawn back from outside)
  const t = (h) => Date.UTC(2026, 6, 1, h);
  const evs = [E(t(10), 'in', 100, 90, { loc: 'pool:a', kind: 'gain' }), MV(t(11), 'pool:a', LO.OUT, 100, 91, 'withdraw'), E(t(12), 'out', 100, 92, { loc: 'pool:a', kind: 'fee' })];
  for (const method of LO.METHODS) for (const scope of LO.SCOPES) {
    const r = run(evs, { method, scope, at: [t(13)] }), msg = `${method} ${scope}`;
    assert.equal(r.scope, method === 'uk' ? 'global' : scope, msg);
    assert.deepEqual(r.short, { n: 0, units: 0 }, msg + ': the units were there');
    assert.equal(r.disposals.length, 1, msg); near(assert, r.disposals[0].costC, 90, 1e-9, msg); near(assert, r.disposals[0].gainC, 2, 1e-9, msg);
    near(assert, U(r.at[0].pools, (x) => x.units), 0, 1e-9, msg + ': nothing left in any pool');
  }
  assert.equal(run(evs, { method: 'uk', scope: 'pool' }).disposals[0].rule, 'same day');
  // a shortfall is the matching's, never late data (that is 'not covered'): the lots' methodology says so
  const per = { start: t(0), end: t(24), tz: 'UTC', preset: 'cal', startText: 'a', endText: 'b' };
  const res = Object.assign(run(evs, { method: 'fifo', scope: 'pool' }), { short: { n: 1, units: 2 } });
  const row = Object.fromEntries(LO.describe({ res, period: per, tz: 'UTC', money: USD, now: per.end }))['Disposals without lots'];
  assert.match(row, /a gap in the matching, not in the data/); assert.doesNotMatch(row, /data starts after/);
  const card = fs.readFileSync(path.join(root, 'js/tax/view-lots.js'), 'utf8');
  assert.ok(!card.includes('the data starts after the units were acquired'), 'the card\'s short note does not blame late data');
  // the UK choice names its scope in the lots' methodology
  const uk = Object.fromEntries(LO.describe({ res: run(evs, { method: 'uk', scope: 'wallet' }), period: per, tz: 'UTC', money: USD, now: per.end }));
  assert.match(uk.Scope, /^one pool: .*\(UK pooling runs with one pool for everything only: this page reads the s104 pool as one per person/);
});
const U = (l, f) => l.reduce((a, x) => a + f(x), 0);

test('without opening lots a deposit enters at its value that day, said as not covered; the Predict wallet draws on outside USDe first', () => {
  const r = run(book(false), { method: 'fifo', scope: 'global' });
  assert.deepEqual(r.uncovered, { n: 1, units: 100 });
  assert.deepEqual(sum(r), [['fee', 'all', 0.04]], 'the fee against the deposit\'s value');
  // a stake with nothing held anywhere: acquired at its value, then disposed of: no gain
  const s = run([E(D(3), 'out', 10, 9.5, { kind: 'stake' })], { method: 'fifo', scope: 'pool' });
  assert.equal(s.uncovered.n, 1); near(assert, s.disposals[0].gainC, 0, 1e-12);
  // with USDe outside (an opening lot), the Predict wallet's stake is drawn from it, lots and all
  const o = run([E(D(1), 'in', 20, 18, { loc: LO.OUT, kind: 'opening' }), E(D(3), 'out', 10, 9.5, { kind: 'stake' })], { method: 'fifo', scope: 'pool' });
  assert.equal(o.uncovered.n, 0); assert.equal(o.disposals[0].key, LO.PREDICT); near(assert, o.disposals[0].costC, 9, 1e-9);
  assert.equal(new Date(o.disposals[0].pieces[0].acqT).toISOString().slice(0, 10), '2026-07-01', 'the moved lot keeps its date');
});

test('usdeEvents: opening lots in the report currency, in USD, or in another currency (left out, named)', () => {
  const eur = { ccy: 'EUR', rates: { src: FX.SOURCES.ecb }, fx: (v) => v * 0.9, rate: () => 0.9, cols: () => [], describe: () => [] };
  const o = LO.usdeEvents({ tz: 'UTC', money: eur, opening: [
    { at: 'out', date: '2026-06-01', units: 100, cost: 90, ccy: 'EUR' },
    { at: 'predict', date: '2026-06-02', units: 10, cost: 10, ccy: 'USD' },
    { at: 'out', date: '2026-06-03', units: 5, cost: 4, ccy: 'GBP' },
    { at: 'out', date: '2026-02-30', units: 5, cost: 4, ccy: 'EUR' },   // not a date: dropped
  ] });
  assert.deepEqual(o.events.map((e) => [e.loc, e.units, +e.usd.toFixed(9), +e.c.toFixed(9), e.t]), [['out', 100, 100, 90, Date.UTC(2026, 5, 1)], ['predict', 10, 10, 9, Date.UTC(2026, 5, 2)]]);
  assert.equal(o.skipped.length, 1); assert.equal(o.skipped[0].ccy, 'GBP');
  assert.equal(LO.cleanLot({ at: 'x', date: '2026-01-01', units: -1, cost: 1 }), null);
});

test('usdeEvents: each pool\'s events against the ledger\'s balance, now or at the last whole UTC day before a past cutoff', () => {
  const ref = { byId: { x: { id: 'x', displayTicker: 'BTC-USD', quoteTokenAddress: '0xAA' } }, tokenById: { u: { id: 'u', address: '0xaa', name: 'USD', depositEnabled: true } } };
  const d1 = Date.UTC(2026, 6, 1), d2 = d1 + DAY, d3 = d2 + DAY;
  const Dp = { byPos: new Map(), unassigned: [], rows: [{ t: d2 + HOUR, productId: 'x', gross: 5, ticker: 'BTC-USD', long: true, positionId: 'p' }, { t: d3 + HOUR, productId: 'x', gross: -2, ticker: 'BTC-USD', long: true, positionId: 'p' }], funding: { S: { list: [] } }, fees: { list: [], unmatched: [] } };
  const ev = { positions: [], transfers: [{ id: 't1', type: 'DEPOSIT', amount: '100', fee: '0', createdAt: d1 + HOUR, tokenAddress: '0xaa', tokenName: 'USD', status: 'COMPLETED' }] };
  const dayRows = [{ time: d1, tokenId: 'u', balance: '100' }, { time: d2, tokenId: 'u', balance: '105' }, { time: d3, tokenId: 'u', balance: '103' }];
  const past = LO.usdeEvents({ perps: { D: Dp, ev, ref, dayRows }, tz: 'UTC', money: USD, cutoff: d3 + 12 * HOUR, now: d3 + 40 * DAY });
  assert.deepEqual(past.check.map((c) => [c.name, c.events, c.ledger, c.at]), [['USD', 105, 105, d3]], 'events before 3 Jul against the row of 2 Jul');
  const live = LO.usdeEvents({ perps: { D: Dp, ev, ref, dayRows }, tz: 'UTC', money: USD, cutoff: d3 + 12 * HOUR, now: d3 + 12 * HOUR });
  assert.deepEqual(live.check.map((c) => [c.events, c.ledger, c.diff]), [[103, 103, 0]], 'the level now');
  assert.equal(live.names['pool:0xaa'], 'USD');
  assert.deepEqual(live.events.map((e) => [e.kind, e.dir, e.loc || e.from + '>' + e.to]), [['deposit', 'move', 'out>pool:0xaa'], ['gain', 'in', 'pool:0xaa'], ['loss', 'out', 'pool:0xaa']]);
});

// ---------- a real account and the Predict wallet ----------
test('usdeEvents on a real account with mPerp position fees (0x8ddb…): every gross, fee, funding and position-fee settlement once, in its market\'s pool', () => {
  const d = perps('perps-0x8ddb-xau-position-fees.json');
  const start = Math.floor(d.createdAt / DAY) * DAY, end = d.cutoff;
  const ev = fixtureEvents(MD, d, start, end);
  const Dp = T.fills.disposals(ev, { ledger: { days: [], totals: { realized: 0, C: { realized: 0 } } }, period: { start, end, tz: 'UTC' }, ref: d.ref, tz: 'UTC' });
  const x = LO.usdeEvents({ perps: { D: Dp, ev, ref: d.ref }, tz: 'UTC', money: USD });
  const by = (k) => x.events.filter((e) => e.kind === k).reduce((a, e) => a + (e.dir === 'in' ? e.units : -e.units), 0);
  near(assert, by('gain') + by('loss'), Dp.rows.reduce((a, r) => a + r.gross, 0), 1e-6, 'gross');
  let fees = 0; for (const fs of Dp.byPos.values()) for (const f of fs) if (f.qty > 0) fees += f.fee;
  near(assert, -(by('fee') + by('rebate')), fees, 1e-6, 'fees');
  near(assert, by('funding'), Dp.funding.S.list.reduce((a, s) => a + s.amount, 0), 1e-6, 'funding');
  near(assert, -by('posfee'), Dp.fees.list.reduce((a, s) => a + s.amount, 0) + Dp.fees.unmatched.reduce((a, b) => a + b.amount, 0), 1e-6, 'position fees');
  assert.ok(x.events.some((e) => e.kind === 'posfee'), 'the XAU short pays position fees');
  const xau = d.tokens.find((t) => t.name === 'XAUUSD');
  assert.ok(x.events.filter((e) => e.kind === 'posfee').every((e) => e.loc === LO.poolLoc(xau.address)), 'in the XAU pool');
  assert.equal(x.names[LO.poolLoc(xau.address)], 'XAUUSD');
  // the methods run on it; at par in USD there is no gain; without transfers in the fixture the pools are topped up
  for (const method of LO.METHODS) for (const scope of LO.SCOPES) {
    const r = LO.run(x.events, { method, scope, reading: 'transfer', tz: 'UTC', cutoff: end });
    for (const dd of r.disposals) { assert.ok(Number.isFinite(dd.gainC)); near(assert, dd.gainUsd, 0, 1e-9); }
  }
  // in a report currency whose rate moves, with an opening lot: units and cost are kept under every method, scope and
  // reading (what was acquired = what was disposed of + what is still held)
  const eur = { ccy: 'EUR', rates: { src: FX.SOURCES.ecb }, fx: (v, t) => v * (0.85 + ((Math.floor(t / DAY) % 7) / 100)), rate: (t) => 0.85 + ((Math.floor(t / DAY) % 7) / 100), cols: () => [], describe: () => [] };
  const y = LO.usdeEvents({ perps: { D: Dp, ev, ref: d.ref }, tz: 'UTC', money: eur, opening: [{ at: 'out', date: new Date(start).toISOString().slice(0, 10), units: 500, cost: 420, ccy: 'EUR' }] });
  const inU = U(y.events.filter((e) => e.dir === 'in'), (e) => e.units), outU = U(y.events.filter((e) => e.dir === 'out'), (e) => e.units);
  for (const method of LO.METHODS) for (const scope of LO.SCOPES) for (const reading of LO.READINGS) {
    const r = LO.run(y.events, { method, scope, reading, tz: 'UTC', cutoff: end }), msg = `${method} ${scope} ${reading}`;
    const acqC = U(LO.expand(y.events, { scope, reading }).filter((o) => o.op === 'acq'), (o) => o.c);
    const costC = U(r.disposals, (dd) => U(dd.pieces.filter((p) => p.rule !== 'not covered'), (p) => p.c));
    near(assert, U(r.pools, (p) => p.units), inU - outU + r.uncovered.units + r.short.units, 1e-6, msg + ' units');
    near(assert, acqC, costC + U(r.pools, (p) => p.c), 1e-6, msg + ' cost');
    assert.equal(r.short.n, 0, msg + ': every disposal and move found its units in its scope\'s lots');
  }
});

// a prediction as the API has it (as in tax-predict.test.mjs)
const wei = (x) => (BigInt(Math.round(x * 1e6)) * 1000000000000n).toString();
const sec = (ms) => Math.floor(ms / 1000);
const W = '0x00000000000000000000000000000000000000a1', B = (i) => '0x' + (0xb00 + i).toString(16).padStart(40, '0'), X = '0x00000000000000000000000000000000000000e1';
function mk({ id, predictor = B(1), counterparty = W, stake, cp, t, verdict = null, decidedAt = null, claimedAt = null, pc = 'pc-' + id }) {
  return P.norm({ predictionId: id, predictor, counterparty, predictorCollateral: wei(stake), counterpartyCollateral: wei(cp), predictorToken: 'tp-' + pc, counterpartyToken: 'tc-' + pc,
    settled: !!claimedAt, result: claimedAt ? verdict : null, createdAt: new Date(t).toISOString(), settledAt: claimedAt ? new Date(claimedAt).toISOString() : null, createTxHash: '0xp' + id, settleTxHash: claimedAt ? '0xs' + id : null,
    pickConfig: { pickConfigId: pc, resolved: !!verdict, result: verdict, picks: [{ conditionId: 'c-' + id, predictedOutcome: 'YES', condition: { question: 'Q ' + id, endTime: sec(t + 2 * DAY), settled: !!verdict, settledAt: verdict ? sec(decidedAt) : null, resolvedToYes: verdict === 'PREDICTOR_WINS' ? true : verdict === 'COUNTERPARTY_WINS' ? false : null, nonDecisive: verdict === 'NON_DECISIVE' } }] } });
}
const trade = ({ t, seller, buyer, tokens, paid, n, side = 'P' }) => Object.assign({ t, seller, buyer, tokens, paid, pc: n.pc, pid: n.id, side, q: 'Q', dAt: n.decided ? P.decidedAt(n) : null, sa: n.settledAt },
  !n.decided ? { vP: null, vC: null } : n.won ? { vP: 1, vC: 0 } : n.nd ? { vP: n.stake / n.pool, vC: n.cp / n.pool } : { vP: 0, vC: 1 });

test('PR.cash: the Predict wallet\'s USDe; with everything claimed and redeemed it adds up to the realized PnL on the claim basis', () => {
  const T0 = Date.UTC(2026, 7, 3);
  const p1 = mk({ id: 'p1', predictor: B(1), stake: 10, cp: 40, t: T0, verdict: 'COUNTERPARTY_WINS', decidedAt: T0 + DAY, claimedAt: T0 + DAY + HOUR });   // the maker's win, claimed by it
  const p2 = mk({ id: 'p2', predictor: B(2), stake: 20, cp: 5, t: T0 + HOUR, verdict: 'PREDICTOR_WINS', decidedAt: T0 + DAY, claimedAt: T0 + 3 * DAY });   // the maker's loss
  const p5 = mk({ id: 'p5', predictor: W, counterparty: X, stake: 8, cp: 12, t: T0 + 4 * HOUR, verdict: 'PREDICTOR_WINS', decidedAt: T0 + DAY, claimedAt: T0 + 2 * DAY });   // its own bet, won
  const p7 = mk({ id: 'p7', predictor: W, counterparty: X, stake: 6, cp: 6, t: T0 + 5 * HOUR, verdict: 'NON_DECISIVE', decidedAt: T0 + DAY, claimedAt: T0 + 2 * DAY });   // void: refunded
  // its own bet whose tokens it sells half of before the verdict (lost: worthless), and tokens it buys and redeems
  const p8 = mk({ id: 'p8', predictor: W, counterparty: X, stake: 10, cp: 10, t: T0 + 6 * HOUR, verdict: 'COUNTERPARTY_WINS', decidedAt: T0 + 2 * DAY, claimedAt: T0 + 3 * DAY });
  const p9 = mk({ id: 'p9', predictor: B(3), counterparty: X, stake: 5, cp: 15, t: T0 + 7 * HOUR, verdict: 'PREDICTOR_WINS', decidedAt: T0 + 2 * DAY, claimedAt: T0 + 4 * DAY });
  const trades = [trade({ t: T0 + 8 * HOUR, seller: W, buyer: B(4), tokens: 10, paid: 4, n: p8 }), trade({ t: T0 + 9 * HOUR, seller: B(3), buyer: W, tokens: 20, paid: 9, n: p9 })];
  const rd = { 'pc-p9|P': T0 + 4 * DAY + HOUR };
  const prep = PR.prepare({ norms: [p1, p2, p5, p7, p8, p9], trades, rd, addr: W });
  const cash = PR.cash(prep);
  const kinds = cash.map((c) => [c.kind, +c.amount.toFixed(6)]);
  assert.deepEqual(kinds, [['stake', -40], ['stake', -5], ['stake', -8], ['stake', -6], ['stake', -10], ['sale', 4], ['buy', -9], ['payout', 50], ['payout', 20], ['refund', 6], ['redeem', 20]]);
  const pnl = PR.book(prep, 'claim').filter((e) => !e.ledger && e.kind !== 'placed' && e.kind !== 'buy').reduce((a, e) => a + e.pnl, 0);
  near(assert, cash.reduce((a, c) => a + c.amount, 0), pnl, 1e-9, 'cash in − out = the claim-basis result when everything is collected');
  // nothing is USDe before it is claimed or redeemed
  const open = PR.prepare({ norms: [mk({ id: 'q1', predictor: W, counterparty: X, stake: 3, cp: 3, t: T0, verdict: 'PREDICTOR_WINS', decidedAt: T0 + DAY })], trades: [], addr: W });
  assert.deepEqual(PR.cash(open).map((c) => c.kind), ['stake']);
});

test('PR.cash on four real wallets (snapshot files): stakes, purchases and sales as the record has them, every amount a number', () => {
  const files = ['predict-0xba3b-buyer.json', 'predict-0xc1ce-trader.json', 'predict-0xaca4-traded.json', 'predict-0xea41-maker.json'];
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/tax', f), 'utf8'));
    const prep = PR.prepare({ norms: j.predictions.map(P.unslim), trades: j.trades || [], rd: j.rd, rows: j.rows, rowsFmt: j.rowsFmt, truncated: !!j.truncated, total: j.total, newest: j.newest, addr: j.address, builtAt: j.builtAt });
    const cash = PR.cash(prep);
    for (const c of cash) assert.ok(Number.isFinite(c.amount) && Number.isFinite(c.t), f);
    near(assert, -U(cash.filter((c) => c.kind === 'stake'), (c) => c.amount), U(prep.items, (it) => it.stakeW), 1e-6, f + ' stakes');
    near(assert, -U(cash.filter((c) => c.kind === 'buy'), (c) => c.amount), U(prep.L.trades.filter((t) => t.buyer === prep.addr && t.seller !== prep.addr), (t) => t.paid), 1e-6, f + ' purchases');
    for (let i = 1; i < cash.length; i++) assert.ok(cash[i].t >= cash[i - 1].t, 'in time order');
    const x = LO.usdeEvents({ cash, tz: 'UTC', money: USD });
    const r = LO.run(x.events, { method: 'fifo', scope: 'pool', tz: 'UTC' });
    assert.ok(r.disposals.length > 0, f);
  }
});

// ---------- figures, facts and files ----------
test('per fiscal year (UK: 5 Apr and 6 Apr are different years), totals in a range, and the US fact line', () => {
  const evs = [E(Date.UTC(2026, 3, 1), 'in', 10, 9), E(Date.UTC(2026, 3, 5, 12), 'out', 1, 1, { kind: 'fee' }), E(Date.UTC(2026, 3, 6, 12), 'out', 2, 2), E(Date.UTC(2026, 3, 7, 12), 'out', 1, 0.5, { kind: 'loss' })];
  const r = run(evs, { method: 'fifo', tz: 'Europe/London' });
  const y = LO.byYear(r.disposals, { preset: 'uk', tz: 'Europe/London' });
  assert.deepEqual(y.map((x) => [x.label, x.n, x.fees]), [['Tax year 2026/27', 2, 0], ['Tax year 2025/26', 1, 1]]);
  near(assert, y[0].gainsC, 2 - 1.8, 1e-9); near(assert, y[0].lossesC, 0.5 - 0.9, 1e-9); near(assert, y[0].netC, 0.2 - 0.4, 1e-9);
  const tot = LO.totals(r.disposals, Date.UTC(2026, 3, 6), Date.UTC(2026, 3, 8));
  assert.equal(tot.n, 2); near(assert, tot.proceedsC, 2.5, 1e-9);
  const f = LO.facts(evs.concat([MV(Date.UTC(2026, 3, 6), LO.OUT, 'pool:usd', 5, 5, 'deposit')]), Date.UTC(2026, 3, 1), Date.UTC(2026, 4, 1));
  assert.deepEqual([f.any, f.fees, f.other, f.wraps], [true, 1, 2, 1]);
  assert.equal(LO.factText(f), 'USDe disposed of in the period: yes (1 fee payment, 2 other); plus 1 deposit or withdrawal, a disposal only if wrapping USDe into MeridianUSD counts as one');
  assert.equal(LO.factText(LO.facts([], 0, 1)), 'USDe disposed of in the period: no');
});

test('files: the disposals (four sections) and the flows, each a site report with the lots\' methodology first', () => {
  const evs = book();
  const per = { start: D(3), end: D(7), tz: 'UTC', preset: 'cal', startText: 'a', endText: 'b' };
  const fname = (k) => k + '.csv';
  // UK pooling asked per pool runs with one pool (its only scope)
  const res = run(evs, { method: 'uk', scope: 'pool', at: [per.end], cutoff: D(7) }), alt = run(evs, { method: 'uk', scope: 'pool', reading: 'disposal', at: [per.end] });
  const ctx = { res, alt, events: evs.slice().sort(LO.order), period: per, tz: 'UTC', money: USD, fname, names: { 'pool:usd': 'USD', 'pool:xau': 'XAUUSD' } };
  for (const d of EX.list('lots')) assert.equal(d.kind, 'report', d.id);
  const f = EX.build('lots-disposals', ctx);
  assert.equal(f.name, 'usde-lots-uk-global.csv');
  assert.deepEqual(f.sections.map((s) => s.title), ['Disposals in the period (deposits as transfers)', 'Matched pieces', 'Per fiscal year and scope, both readings (every year of the data)', 'Pools at the period end (deposits as transfers)']);
  assert.deepEqual(f.sections[0].rows.map((d) => d.kind), ['fee'], 'the conversion is no disposal');
  assert.ok(!f.sections[0].columns.some((c) => / EUR$/.test(c[0])), 'no report-currency columns in USD');
  assert.deepEqual(new Set(f.sections[2].rows.map((r) => r.reading)), new Set(['Deposits as transfers', 'Wrapping as a disposal']));
  const meth = LO.describe({ res, events: ctx.events, period: per, tz: 'UTC', money: USD, addr: '0xabc', opening: [{ at: 'out', date: '2026-07-01', units: 100, cost: 90, ccy: 'USD' }], cutoff: D(7), now: D(8) });
  assert.deepEqual(meth.slice(0, 2).map((x) => x[0]), ['Report', 'Disclaimer']);
  assert.equal(meth[1][1], T.DISCLAIMER);
  assert.match(meth.find((x) => x[0] === 'Opening lots')[1], /outside Meridian 2026-07-01: 100 USDe, cost 90 USD/);
  assert.match(meth.find((x) => x[0] === 'Lot method')[1], /same local day first/);
  assert.match(meth.find((x) => x[0] === 'Conversions between pools')[1], /^read as a move, never a disposal, under both readings: .* keep their lots, acquisition dates and cost/);
  // the US Form 1040 digital-asset fact line, right after the period (D3 to D7: the fee; the withdrawal counted apart;
  // the conversion neither), as a fact and not an answer
  const i = meth.findIndex((x) => x[0] === LO.FACT_ROW_KEY);
  assert.equal(meth[i - 1][0], 'Time zone');
  assert.match(LO.FACT_ROW_KEY, /^USDe disposed of in the period \(Meridian activity only; a fact, not an answer to the US Form 1040 digital-asset question\)$/);
  assert.equal(meth[i][1], 'yes (1 fee payment, 0 other); plus 1 deposit or withdrawal, a disposal only if wrapping USDe into MeridianUSD counts as one');
  assert.equal(LO.factText(LO.facts(ctx.events, per.start, per.end)), LO.FACT_KEY + ': ' + meth[i][1], 'the card\'s line, word for word');
  assert.equal(LO.describe({ res, period: per, tz: 'UTC', money: USD, now: D(8) }).findIndex((x) => x[0] === LO.FACT_ROW_KEY), -1, 'no events: no fact line');
  const csv = EX.render(f, meth);
  assert.ok(csv.startsWith('Report,'), 'methodology first'); assert.ok(csv.includes('\r\n\r\nDisposals in the period'));
  const fl = EX.build('lots-flows', ctx);
  assert.equal(fl.rows.length, evs.length, 'every flow up to the period end');
  assert.ok(fl.columns.some((c) => c[0] === 'Moved to'));
  assert.equal(fl.columns.find((c) => c[0] === 'In period')[1](fl.rows[0]), 'no');
  // both lots files start with it
  for (const x of [f, fl]) { const head = EX.render(x, meth).split('\r\n\r\n')[0]; assert.ok(head.includes(LO.FACT_KEY + ' (Meridian activity only'), x.name); }
});

test('the summary file carries the fact line before the USDe lots rows; not computed: no fact line', () => {
  const S = T.summary, evs = book().sort(LO.order);
  const per = { start: D(3), end: D(7), tz: 'UTC', preset: 'cal', startText: 'a', endText: 'b' };
  const o = { method: 'fifo', scope: 'pool', at: [per.end] };
  const lots = { runs: { transfer: run(evs, o), disposal: run(evs, Object.assign({ reading: 'disposal' }, o)) }, method: 'fifo', scope: 'pool', facts: LO.facts(evs, per.start, per.end) };
  const rows = S.summaryFile({ period: per, money: USD, fname: (k) => k + '.csv', perps: null, hold: [], predict: { missing: true }, lots, warnings: [] }).sections[0].rows;
  const i = rows.findIndex((r) => r[0] === LO.FACT_ROW_KEY);
  assert.deepEqual(rows[i], [LO.FACT_ROW_KEY, 'yes (1 fee payment, 0 other); plus 1 deposit or withdrawal, a disposal only if wrapping USDe into MeridianUSD counts as one', '']);
  assert.equal(rows[i + 1][0], 'USDe lots (deposits as transfers): disposals');
  assert.equal(rows[i + 1][1], 1, 'the conversion is no disposal per pool');
  const none = S.summaryFile({ period: per, money: USD, fname: (k) => k, perps: null, hold: [], predict: { missing: true }, lots: null }).sections[0].rows;
  assert.ok(!none.some((r) => r[0] === LO.FACT_ROW_KEY)); assert.ok(none.some((r) => r[0] === 'USDe lots' && /not computed/.test(r[1])));
});

// ---------- the USDe/USD price ----------
const LLAMA = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/fx/defillama-usde-2026-09-14_2026-10-03.json'), 'utf8'));
test('USDe/USD: DefiLlama\'s points dated by the nearest UTC midnight; a local date takes its own price or the last before', () => {
  const s = FX.fromLlama(LLAMA);
  assert.equal(s.dates[0], '2026-09-14'); assert.equal(s.dates.at(-1), '2026-10-03'); assert.equal(s.dates.length, 20);
  assert.equal(FX.fromLlama({ coins: { x: { prices: [{ timestamp: Date.UTC(2026, 5, 7, 23, 59, 59) / 1000, price: 0.999 }] } } }).dates[0], '2026-06-08', 'a point a second before midnight is the next date');
  const px = FX.usdePrices(FX.usdeTable(s), 'Asia/Tokyo');
  // 2026-09-30 20:00 UTC is 1 Oct in Tokyo: 1 Oct's price
  near(assert, px.at(Date.UTC(2026, 8, 30, 20)), s.prices[s.dates.indexOf('2026-10-01')], 1e-15);
  near(assert, px.at(Date.UTC(2026, 11, 1)), s.prices.at(-1), 1e-15, 'after the last: the last');
  near(assert, px.at(Date.UTC(2026, 0, 1)), s.prices[0], 1e-15, 'before the first: the first');
  assert.throws(() => FX.usdeTable({ dates: ['2026-01-01'], prices: [] }), /not a USDe price file/);
});

test('FX.usde: the published file when the deploy wrote one; DefiLlama from the browser otherwise (cached); GET only', async () => {
  const s = FX.fromLlama(LLAMA);
  const file = { v: 1, source: 'defillama', fetchedAt: '2026-10-03T06:00:00.000Z', dates: s.dates, prices: s.prices };
  const res = (body, json = true) => ({ ok: true, status: 200, headers: { get: () => (json ? 'application/json' : 'text/html') }, json: async () => body });
  const seen = [];
  const fetchA = async (url, init) => { seen.push([url, init && init.method]); if (/index\.json$/.test(url)) return res({ v: 1, files: { usde: { file: 'usde-usd.json', from: s.dates[0], to: s.dates.at(-1), fetchedAt: file.fetchedAt } } }); if (/usde-usd\.json$/.test(url)) return res(file); throw new Error('unexpected ' + url); };
  T.cache.clear();
  const a = await FX.usde({ tz: 'UTC', now: Date.UTC(2026, 9, 3, 7), fetch: fetchA, storage: null });
  assert.equal(a.via, 'file'); assert.equal(a.fetchedAt, file.fetchedAt); assert.equal(a.latest.date, '2026-10-03');
  // no file published (Cloudflare answers index.html): DefiLlama, once, then from sessionStorage
  T.cache.clear(); seen.length = 0;
  const store = new Map(), storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  const fetchB = async (url, init) => { seen.push([url, init && init.method]); if (/^data\/fx\//.test(url)) return res('<html>', false); if (url.startsWith('https://coins.llama.fi/chart/')) return res(LLAMA); throw new Error('unexpected ' + url); };
  const b = await FX.usde({ tz: 'UTC', now: Date.UTC(2026, 9, 3, 7), fetch: fetchB, storage });
  assert.equal(b.via, 'defillama'); assert.equal(b.table.d.length, 20);
  assert.ok(seen.some(([u]) => /coins\.llama\.fi\/chart\/ethereum:0x4c9EDD5852cd905f086C759E8383e09bff1E68B3\?start=1780272000&span=\d+&period=1d/.test(u)));
  T.cache.clear(); const n = seen.length;
  await FX.usde({ tz: 'UTC', now: Date.UTC(2026, 9, 3, 7, 30), fetch: fetchB, storage });
  assert.equal(seen.filter(([u]) => u.startsWith('https://coins')).length, 1, 'the second read within the hour is cached');
  assert.ok(seen.length > n);
  for (const [, m] of seen) assert.ok(!m || m === 'GET');
  T.cache.clear();
});

// ---------- scale ----------
test('50,000 events in well under a second for every method (per pool: moves, conversions and top-ups; and one pool) (no quadratic step)', () => {
  const evs = []; let t = Date.UTC(2026, 6, 1);
  const locs = ['pool:a', 'pool:b', LO.PREDICT];
  evs.push(E(t, 'in', 1e6, 0.9e6, { loc: LO.OUT, kind: 'opening' }));
  evs.push(MV(t + 1, LO.OUT, 'pool:a', 3e5, 2.7e5, 'deposit'), MV(t + 2, LO.OUT, LO.PREDICT, 1e5, 0.9e5, 'topup'));
  for (let i = 0; i < 50000; i++) {
    t += 7 * 60000;
    const loc = locs[i % 3], r = i % 10, u = 1 + (i % 17) * 0.37, c = u * (0.9 + (i % 101) / 1000);
    if (r < 4) evs.push(E(t, 'in', u, c, { loc, kind: 'gain' }));
    else if (r < 9) evs.push(E(t, 'out', u, c, { loc, kind: 'fee' }));
    else evs.push(MV(t, 'pool:a', 'pool:b', u, c, i % 20 === 9 ? 'convert' : 'withdraw'));
  }
  evs.sort(LO.order);
  // the per-pool scope does the most (moves and conversions between pools, top-ups); one pool the largest pools (UK
  // pooling runs with one pool only)
  for (const [method, scope] of ['fifo', 'lifo', 'average'].map((m) => [m, 'pool']).concat([['uk', 'global'], ['fifo', 'global'], ['average', 'wallet']])) {
    const t0 = performance.now();
    const r = LO.run(evs, { method, scope, reading: 'disposal', tz: 'Europe/London', cutoff: t });
    const ms = performance.now() - t0;
    assert.ok(ms < 1000, `${method} ${scope}: ${ms.toFixed(0)} ms`);
    assert.ok(r.disposals.length > 25000);
    assert.ok(!r.disposals.some((d) => d.kind === 'convert'), `${method} ${scope}: a conversion is a move`);
    assert.equal(r.short.n, 0, `${method} ${scope}: no shortfall`);
  }
});

test('an opening lot dated before the first published rate: its cost\'s other currency at that first rate, named on the card and in the lots\' methodology, never silently (B2)', () => {
  const d = [], r = [];
  for (let t = Date.UTC(2026, 5, 1), i = 0; t < Date.UTC(2026, 9, 1); t += DAY, i++) { d.push(new Date(t).toISOString().slice(0, 10)); r.push(0.8 + i / 1000); }
  const money = FX.money(FX.rates({ ccy: 'EUR', id: 'ecb', via: 'file', table: { source: 'ecb', ccy: 'EUR', d, r, ref: null }, tz: 'UTC' }), 'UTC');
  const o = LO.usdeEvents({ tz: 'UTC', money, opening: [
    { at: 'out', date: '2025-11-03', units: 100, cost: 87, ccy: 'EUR' },   // before 1 Jun 2026: no rate of its own
    { at: 'out', date: '2026-01-05', units: 10, cost: 10, ccy: 'USD' },
    { at: 'out', date: '2026-07-01', units: 5, cost: 4.5, ccy: 'EUR' },    // has its own date's rate
  ] });
  const [a, b, c] = o.events;
  assert.equal(a.c, 87, 'the entered cost stays as entered'); near(assert, a.usd, 87 / 0.8, 1e-9, 'its USD at the first rate (1 Jun 2026)');
  assert.equal(b.usd, 10); near(assert, b.c, 10 * 0.8, 1e-12);
  near(assert, c.usd, 4.5 / money.rate(Date.UTC(2026, 6, 1)), 1e-12);
  assert.deepEqual(o.early.map((x) => [x.date, x.rate]), [['2025-11-03', '2026-06-01'], ['2026-01-05', '2026-06-01']]);
  assert.equal(LO.earlyText('EUR')(o.early[0]), 'outside Meridian 2025-11-03: 100 USDe, cost 87 EUR: dated before the first published rate, so its cost in USD is at the first rate there is (2026-06-01), not at its own date\'s');
  assert.match(LO.earlyText('EUR')(o.early[1]), /cost 10 USD: .* so its cost in EUR is at the first rate/);
  const per = { start: Date.UTC(2026, 6, 1), end: Date.UTC(2026, 7, 1), tz: 'UTC', preset: 'cal', startText: 'a', endText: 'b' };
  const res = LO.run(o.events, { method: 'fifo', scope: 'global', reading: 'transfer', tz: 'UTC', at: [per.end] });
  const meth = Object.fromEntries(LO.describe({ res, period: per, tz: 'UTC', money, opening: [], early: o.early, now: per.end }));
  assert.match(meth['Opening lots before the first rate'], /^outside Meridian 2025-11-03: .*; outside Meridian 2026-01-05: /);
  assert.equal(Object.fromEntries(LO.describe({ res, period: per, tz: 'UTC', money, opening: [], now: per.end }))['Opening lots before the first rate'], undefined);
  // in USD there is nothing to convert
  assert.deepEqual(LO.usdeEvents({ tz: 'UTC', money: USD, opening: [{ at: 'out', date: '2025-11-03', units: 1, cost: 1, ccy: 'USD' }] }).early, []);
});
