// Tax center funding and position fees (MD.tax.funding): each hourly charge settles at its position's first fill at or
// after it, received and paid kept apart per settlement; mPerp position fees go to the fills of their pool in the hour
// they settle in. Checked against real subaccounts (tests/fixtures/tax/): the settlements of each UTC day must add up
// to the archive's settled funding, and each closed position's to the exchange's own totals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, near } from './_load.mjs';
import { perps, events, ledger } from './_tax-fixture.mjs';

const MD = load(['js/util.js', 'js/api.js', 'js/predict/api.js', 'js/predict/analytics.js', 'js/tax/core.js', 'js/tax/tz.js', 'js/tax/periods.js', 'js/tax/fx.js', 'js/tax/ledger.js', 'js/tax/load.js', 'js/tax/fills.js', 'js/tax/funding.js', 'js/tax/exports.js']);
const U = MD.util, T = MD.tax, F = T.fills, FU = T.funding, PER = T.periods, EX = T.exports;
const at = (s) => Date.parse(s);
const H = 3600000, DAY = 86400000, LATER = Date.UTC(2030, 0, 1);
const utc = (from, to) => PER.resolve({ from, to, tz: 'UTC' }, { now: LATER });
const MM = perps('perps-0x2f46-to-2026-10-01.json');
const AUGSEP = utc('2026-08-01', '2026-09-30');
const disposals = (d, P, o = {}) => { const led = ledger(MD, d, P, o.fx); return { led, D: F.disposals(events(MD, d, P.start, P.end, o), { ledger: led, period: P, ref: d.ref, tz: P.tz, fx: o.fx }) }; };

test('0x2f46, Aug–Sep 2026: funding received 233.89 and paid 589.60, per settlement, netting to the ledger (B03)', () => {
  const { led, D } = disposals(MM, AUGSEP);
  const fig = D.funding.fig;
  near(assert, fig.received, 233.89, 0.005, 'received'); near(assert, fig.paid, 589.60, 0.005, 'paid');
  near(assert, fig.received - fig.paid, led.totals.funding, 1e-6, 'received − paid = the ledger\'s net funding');
  assert.deepEqual(fig.fallback, [], 'every UTC day\'s settlements add up to the archive');
  // the per-day net the page showed before is several times smaller on both sides; the ledger no longer sums it (B03)
  const netIn = U.sum(led.segments, (s) => Math.max(s.funding, 0)), netOut = U.sum(led.segments, (s) => Math.max(-s.funding, 0));
  assert.ok(netIn < fig.received / 3 && netOut < fig.paid / 1.4);
  for (const o of [led.totals, led.totals.C, ...led.months, ...led.quarters]) assert.ok(!('fundingIn' in o) && !('fundingOut' in o), 'no per-segment netted legs that could pass for the settlements');
  const legs = FU.legs(D.funding.S.list, AUGSEP.start, AUGSEP.end);
  near(assert, legs.received, fig.received, 1e-6); near(assert, legs.paid, fig.paid, 1e-6);
  // every closed position's settlements are the exchange's whole-life funding (fundingAccruedUsd, paid = +)
  let n = 0;
  for (const p of MM.positions) if (U.num(p.size) === 0 && U.num(p.updatedAt) < MM.cutoff) { const x = D.funding.byPos.get(p.id) || { received: 0, paid: 0 }; near(assert, x.received - x.paid, -U.num(p.fundingAccruedUsd), 1e-6, p.id); n++; }
  assert.ok(n >= 100, n + ' positions');
});

test('what was charged, settled and left unsettled adds up: settled in a period = unsettled at its start + charged in it − unsettled at its end', () => {
  const S = disposals(MM, AUGSEP).D.funding.S;
  for (const [a, b] of [[at('2026-09-10T00:00:00Z'), at('2026-09-20T00:00:00Z')], [AUGSEP.start, AUGSEP.end], [at('2026-09-18T13:30:00Z'), at('2026-09-18T15:45:00Z')]]) {
    const legs = FU.legs(S.list, a, b), u0 = FU.unsettledAt(S.charges, a), u1 = FU.unsettledAt(S.charges, b), ch = FU.chargedIn(S.charges, a, b);
    near(assert, legs.net, u0.net + ch.net - u1.net, 1e-6);
  }
  const ch = FU.chargedIn(S.charges, AUGSEP.start, AUGSEP.end), u = FU.unsettledAt(S.charges, AUGSEP.end);
  near(assert, ch.after.net, u.net, 1e-6, 'nothing was charged before August: what is unsettled at the end was charged in the period');
  const mid = at('2026-09-15T00:00:00Z'), c2 = FU.chargedIn(S.charges, AUGSEP.start, AUGSEP.end, (v, t) => v * (t < mid ? 2 : 3));
  near(assert, c2.C.net, U.sum(S.charges.filter((c) => c.t >= AUGSEP.start && c.t < AUGSEP.end), (c) => c.amount * (c.t < mid ? 2 : 3)), 1e-6, 'each charge at its own date\'s rate');
  near(assert, c2.C.after, ch.after.net * 3, 1e-6, 'the unsettled tail is all after mid-September');
  assert.ok(u.byPos.size >= 1 && u.byPos.size <= 10, 'only positions open on 1 Oct');
  for (const x of u.byPos.values()) { const p = MM.positions.find((y) => y.id === x.positionId); assert.ok(U.num(p.size) !== 0 || U.num(p.updatedAt) >= MM.cutoff, 'open at the end: ' + x.positionId); }
});

test('the per-day self-check: a day whose charges are missing falls back to its own net, and no charges at all nets every day', () => {
  const led = ledger(MD, MM, AUGSEP);
  // the busiest funding day loses its charges
  const D0 = led.days.reduce((a, s) => (Math.abs(s.funding) > Math.abs(a.funding) ? s : a)).day;
  const ev = events(MD, MM, AUGSEP.start, AUGSEP.end);
  const evMissing = Object.assign({}, ev, { charges: ev.charges.filter((c) => Math.floor(U.num(c.time) / DAY) * DAY !== D0 - DAY && Math.floor(U.num(c.time) / DAY) * DAY !== D0) });
  const D = F.disposals(evMissing, { ledger: led, period: AUGSEP, ref: MM.ref, tz: 'UTC' });
  assert.ok(D.funding.fig.fallback.length >= 1 && D.funding.fig.fallback.some((s) => s.day === D0), 'the day falls back');
  near(assert, D.funding.fig.received - D.funding.fig.paid, led.totals.funding, 1e-6, 'and the period still nets to the ledger');
  const none = FU.figures(null, led.days, null);
  assert.equal(none.fallback.length, led.days.filter((s) => Math.abs(s.funding) > 1e-9).length, 'every day with funding');
  assert.ok(none.fallback.length > 10);
  near(assert, none.received, U.sum(led.days, (s) => Math.max(s.funding, 0)), 1e-9); near(assert, none.paid, U.sum(led.days, (s) => Math.max(-s.funding, 0)), 1e-9);
  // each settlement converts at its own date; a fallback day at its rate instant
  const fx = (usd, t) => usd * (t < at('2026-09-15T00:00:00Z') ? 2 : 3);
  const conv = FU.figures(D.funding.S.list, led.days, fx);
  const byHand = U.sum(D.funding.S.list.filter((s) => s.amount > 0 && s.t >= AUGSEP.start && s.t < AUGSEP.end && !conv.bySeg[F.segmentOf(led.days)(s.t)].fallback), (s) => fx(s.amount, s.t));
  near(assert, conv.C.received, byHand + U.sum(conv.fallback.filter((s) => s.funding > 0), (s) => fx(s.funding, s.tm)), 1e-6);
});

test('settlement: at the first fill at or after the charge, at the close when no fill follows, unsettled while open', () => {
  const ft = new Map([['A', [at('2026-09-01T10:30:00Z'), at('2026-09-01T14:00:00Z')]], ['B', [at('2026-09-01T09:00:00Z')]], ['C', [at('2026-09-01T09:00:00Z')]]]);
  const closeOf = (id) => (id === 'B' ? at('2026-09-01T16:20:00Z') : null);   // B was liquidated, its last fill not loaded
  const c = (pid, t, v) => ({ positionId: pid, productId: 'btc', time: at(t), fundingCharge: String(v) });
  const S = FU.settle([c('A', '2026-09-01T10:00:00Z', 1), c('A', '2026-09-01T11:00:00Z', -0.5), c('A', '2026-09-01T14:00:00Z', 2), c('A', '2026-09-01T15:00:00Z', 4), c('B', '2026-09-01T16:00:00Z', -3), c('C', '2026-09-01T10:00:00Z', 1)], ft, closeOf);
  assert.deepEqual(S.list.map((s) => [s.positionId, new Date(s.t).toISOString().slice(11, 16), s.amount, s.n]), [['A', '10:30', -1, 1], ['A', '14:00', -1.5, 2], ['B', '16:20', 3, 1]]);
  assert.deepEqual(FU.legs(S.list, 0, LATER), { received: 3, paid: 2.5, net: 0.5, n: 3 }, 'received and paid per settlement, never netted across them');
  const u = FU.unsettledAt(S.charges, LATER);
  assert.deepEqual(Array.from(u.byPos.keys()).sort(), ['A', 'C'], 'A after its last fill and C, both open, stay unsettled');
  near(assert, u.paid, 5, 1e-12);
  const before = FU.unsettledAt(S.charges, at('2026-09-01T12:00:00Z'));
  near(assert, before.net, 0.5 - 1, 1e-12, 'at noon: A\'s 11:00 charge (settled at 14:00) and C\'s');
});

test('position fees: an hour with fills of two positions is split by notional; a bucket without fills is reported', () => {
  const ref = { byId: { xau: { id: 'xau', quoteTokenAddress: '0xXAU' }, btc: { id: 'btc', quoteTokenAddress: '0xUSD' } }, tokenById: { tx: { id: 'tx', address: '0xxau', depositEnabled: false }, tu: { id: 'tu', address: '0xusd', depositEnabled: true } } };
  const P1 = { id: 'P1', productId: 'xau', side: 0 }, P2 = { id: 'P2', productId: 'xau', side: 1 }, P3 = { id: 'P3', productId: 'btc', side: 0 };
  const f = (pid, t, qty, price) => ({ positionId: pid, t, qty, price, fee: 0, side: '0' });
  const t0 = at('2026-09-01T10:00:00Z');
  const byPos = new Map([['P1', [f('P1', t0 + 60000, 1, 1000)]], ['P2', [f('P2', t0 + 120000, 2, 1000), f('P2', t0 + 5 * H, 1, 1000)]], ['P3', [f('P3', t0 + 60000, 5, 100)]]]);
  const day = [{ t0: at('2026-09-01T00:00:00Z'), t1: at('2026-09-02T00:00:00Z'), tokenId: 'tx', amount: 3.5 }];
  assert.deepEqual(FU.feeDays(day, byPos, [P1, P2, P3], ref), [day[0].t0], 'two XAU positions filled that day: its hours are needed');
  const buckets = [{ t0, t1: t0 + H, tokenId: 'tx', amount: 3 }, { t0: t0 + 5 * H, t1: t0 + 6 * H, tokenId: 'tx', amount: 0.5 }, { t0: t0 + 9 * H, t1: t0 + 10 * H, tokenId: 'tx', amount: 0.2 }];
  const PF = FU.posFees(buckets, byPos, [P1, P2, P3], ref);
  near(assert, PF.byPos.get('P1'), 1, 1e-12, 'notional 1,000 of 3,000'); near(assert, PF.byPos.get('P2'), 2 + 0.5, 1e-12);
  assert.equal(PF.byPos.get('P3'), undefined, 'a USD-pool position pays none of the XAU pool\'s fees');
  assert.deepEqual(PF.unmatched.map((b) => b.amount), [0.2]);
  assert.deepEqual(PF.list.map((s) => [s.positionId, s.t - t0]), [['P1', 60000], ['P2', 120000], ['P2', 5 * H]]);
});

test('0x2f46 and 0x8ddb: position fees go to the right positions, hour by hour where two of a pool were filled the same day', () => {
  const { led, D } = disposals(MM, AUGSEP);
  const ev = events(MD, MM, AUGSEP.start, AUGSEP.end);
  assert.ok(ev.pfHours.size >= 2, 'days with two positions of one pool: ' + ev.pfHours.size);
  assert.deepEqual(D.fees.bad, [], 'each day\'s attributed fees are the ledger\'s'); assert.deepEqual(D.fees.unmatched, []);
  assert.deepEqual(D.fees.mismatch, [], 'each closed position\'s fees are the exchange\'s positionFeeAccruedUsd');
  near(assert, U.sum(D.fees.inP, (s) => s.amount), led.totals.pfees, 1e-6);
  const x = disposals(perps('perps-0x8ddb-xau-position-fees.json'), utc('2026-09-01', '2026-09-30')).D;
  near(assert, U.sum(x.fees.list, (s) => s.amount), 10.57990724, 1e-6); assert.deepEqual(x.fees.mismatch, []);
});

test('inside-the-result reading: each closed position\'s disposals carry all its settled funding and position fees', () => {
  const { D } = disposals(MM, AUGSEP);
  let n = 0;
  for (const p of MM.positions) {
    if (U.num(p.size) !== 0 || U.num(p.updatedAt) >= MM.cutoff || U.num(p.createdAt) < AUGSEP.start) continue;
    const rows = D.rows.filter((r) => r.positionId === p.id);
    if (!rows.length) continue;
    near(assert, U.sum(rows, (r) => r.fundingIn), -U.num(p.fundingAccruedUsd), 1e-6, 'funding of ' + p.id);
    near(assert, U.sum(rows, (r) => r.posFeeIn), U.num(p.positionFeeAccruedUsd), 1e-6, 'position fees of ' + p.id);
    near(assert, U.sum(rows, (r) => r.netAll), U.num(p.realizedPnl) - U.num(p.feesAccruedUsd) - U.num(p.positionFeeAccruedUsd) - U.num(p.fundingAccruedUsd), 1e-6, 'whole result of ' + p.id);
    n++;
  }
  assert.ok(n >= 100, n + ' positions');
});

test('the Disposals and Funding settlements files: report files with every column, the report currency at each row\'s date, -INCOMPLETE when incomplete', () => {
  const fx = (usd, t) => usd * 2;
  const rates = { ccy: 'EUR', src: { dateHead: 'Rate date (ECB)' } };
  const money = { ccy: 'EUR', rates, fx, cols: (g, gt, name) => [[name + ' EUR', (r) => T.n6(g(r) * 2)], ['USD→EUR rate', () => '2'], ['Rate date (ECB)', () => 'x']] };
  const P = utc('2026-09-01', '2026-09-30');
  const d = perps('perps-0x8003-liquidation.json');
  const ev = events(MD, d, P.start, P.end), led = ledger(MD, d, P);
  const D = F.disposals(ev, { ledger: led, period: P, ref: d.ref, tz: 'Europe/Berlin' });
  const ctx = { period: Object.assign({}, P, { tz: 'Europe/Berlin' }), tz: 'Europe/Berlin', money, fname: (k) => 'meridian-' + k + '.csv', ev, D, ref: d.ref };
  const file = EX.build('perps-disposals', ctx);
  assert.equal(file.kind, 'report'); assert.deepEqual(file.warnings, []); assert.equal(EX.fileName(file), 'meridian-disposals.csv');
  const csv = EX.render(file).split('\r\n');
  const head = csv[0].split(',');
  for (const c of ['Position', 'Market', 'Class', 'Side', 'Fill no. in position', 'Time (UTC)', 'Time (Europe/Berlin)', 'Quantity', 'Average entry', 'Exit price', 'Realized PnL (gross) USD', 'Opening fee share USD', 'Closing fee USD', 'Proceeds USD (notional convention)', 'Cost USD (notional convention)', 'Date acquired (Europe/Berlin)', 'Liquidation', 'Position ID', 'Realized PnL (gross) EUR', 'Net (inside) EUR', 'USD→EUR rate', 'Rate date (ECB)'])
    assert.ok(head.includes(c), 'column ' + c);
  assert.equal(csv.length, 1 + D.inP.length);
  const liq = csv.find((l) => l.includes('2026-09-25 11:06:40 UTC'));
  assert.ok(liq && /,yes,no,/.test(liq) && liq.includes('-287.694458'), liq);
  // a report gets the methodology first; a tool file never does, and an incomplete file says so in its name
  const m = EX.render(file, [['Title', 'x'], ['Disclaimer', T.DISCLAIMER]]).split('\r\n');
  assert.equal(m[0], 'Title,x'); assert.equal(m[2], ''); assert.equal(m[3], csv[0]);
  assert.equal(EX.render(Object.assign({}, file, { kind: 'tool' }), [['Title', 'x']]).split('\r\n')[0], csv[0]);
  assert.equal(EX.fileName({ name: 'meridian-disposals-0x12-2026.csv', warnings: ['x'] }), 'meridian-disposals-0x12-2026-INCOMPLETE.csv');
  const fund = EX.build('perps-funding', ctx);
  const rows = EX.render(fund).split('\r\n');
  assert.ok(rows[0].startsWith('Status,Settled (UTC),Settled (Europe/Berlin)'));
  assert.equal(rows.length - 1, D.funding.inP.length, 'one row per settlement, nothing unsettled at the end');
  near(assert, U.sum(D.funding.inP, (s) => s.amount), D.funding.fig.received - D.funding.fig.paid, 1e-6);
  assert.deepEqual(EX.list('perps').map((x) => x.id).slice(0, 2), ['perps-disposals', 'perps-funding']);
});

test('funding charges bounded by an end: the windows stop there and nothing after it is kept', async () => {
  const A = MD.api, page = A.page, calls = [];
  A.page = async (base, p, params) => {
    calls.push(params);
    const out = []; const end = params.endTime == null ? Date.now() : params.endTime;
    for (let t = Math.floor(params.startTime / H) * H; t <= end; t += H) out.push({ positionId: 'p1', time: t, fundingCharge: '1' });
    return out;
  };
  try {
    const end = Math.floor(Date.now() / H) * H - 20 * DAY + 30 * 60000, start = end - 5 * DAY;
    const prog = [];
    const rows = await A.fundingCharges('sid', start, { end, onProgress: (d, n) => prog.push([d, n]) });
    assert.ok(calls.every((c) => c.endTime != null && c.endTime <= end + H), 'every window ends by the hour after the end');
    assert.ok(rows.every((r) => r.time < end) && rows.length >= 5 * 24, 'charges before the end only');
    assert.equal(prog[prog.length - 1][0], calls.length, 'progress counts the windows');
  } finally { A.page = page; }
});

test('A.page reports each page it reads', async () => {
  const fetch0 = globalThis.fetch, seen = [];
  let n = 0;
  globalThis.fetch = async () => { n++; return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ data: [{ id: n }, { id: n + 0.5 }], hasNext: n < 3, nextCursor: n < 3 ? 'c' + n : null }) }; };
  try {
    const rows = await MD.api.page('https://x', '/v1/order/fill', { subaccountId: 's' }, { onPage: (p, r) => seen.push([p, r]) });
    assert.equal(rows.length, 6); assert.deepEqual(seen, [[1, 2], [2, 4], [3, 6]]);
  } finally { globalThis.fetch = fetch0; }
});
