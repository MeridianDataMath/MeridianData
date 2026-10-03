// Tax center fills (MD.tax.fills): every fill to its position, each position replayed from its first fill at average
// entry (the exchange's own method), one disposal row per reduction, liquidation and auto-deleverage included. Checked
// against real subaccounts captured with GET requests (tests/fixtures/tax/): the replay must reproduce every fill's
// realizedPnl as the exchange reports it, and the disposals of each UTC day must add up to the archive's realized PnL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { load, near, root } from './_load.mjs';
import { perps, events, ledger } from './_tax-fixture.mjs';

const MD = load(['js/util.js', 'js/api.js', 'js/predict/api.js', 'js/predict/analytics.js', 'js/tax/core.js', 'js/tax/tz.js', 'js/tax/periods.js', 'js/tax/fx.js', 'js/tax/ledger.js', 'js/tax/load.js', 'js/tax/fills.js', 'js/tax/funding.js', 'js/tax/exports.js']);
const U = MD.util, T = MD.tax, F = T.fills, PER = T.periods;
const at = (s) => Date.parse(s);
const LATER = Date.UTC(2030, 0, 1);
const utc = (from, to) => PER.resolve({ from, to, tz: 'UTC' }, { now: LATER });

// ---------- synthetic positions ----------
const pos = (id, side, createdAt, updatedAt, size = 0, extra = {}) => Object.assign({ id, productId: 'btc', side, size: String(size), createdAt, updatedAt }, extra);
const fill = (id, t, side, qty, price, fee = 0, extra = {}) => Object.assign({ id, productId: 'btc', createdAt: t, side, filled: String(qty), price: String(price), feeUsd: String(fee), type: 'LIMIT' }, extra);
const BTC = { id: 'btc', displayTicker: 'BTC-USD', baseTokenName: 'BTC' };

test('a fill at the close of one position and the opening of the next is split by what the first still holds, its fee pro rata', () => {
  const t1 = at('2026-09-01T10:00:00Z'), t3 = at('2026-09-02T10:00:00Z'), t4 = at('2026-09-03T10:00:00Z');
  const A = pos('A', 0, t1, t3), B = pos('B', 1, t3, t4);
  const fills = [fill('f0', at('2026-08-31T10:00:00Z'), 0, 1, 90), fill('f1', t1, 0, 2, 100, 0.2), fill('f2', t3, 1, 5, 110, 0.5), fill('f3', t4, 0, 3, 105, 0.3)];
  const { byPos, unassigned } = F.assign(fills, null, [B, A]);
  assert.deepEqual(byPos.get('A').map((f) => [f.id, f.qty, f.side]), [['f1', 2, '0'], ['f2', 2, '1']]);
  assert.deepEqual(byPos.get('B').map((f) => [f.id, f.qty, f.side]), [['f2', 3, '1'], ['f3', 3, '0']]);
  near(assert, byPos.get('A')[1].fee, 0.2, 1e-12, 'closing part of the fee'); near(assert, byPos.get('B')[0].fee, 0.3, 1e-12, 'opening part');
  assert.ok(byPos.get('A')[1].split && byPos.get('B')[0].split);
  assert.deepEqual(unassigned.map((f) => f.id), ['f0'], 'a fill before any position is reported, not dropped');
  const ra = F.replay(A, byPos.get('A'), null, { prod: BTC, complete: false }).rows, rb = F.replay(B, byPos.get('B'), null, { prod: BTC }).rows;
  near(assert, ra[0].gross, 20, 1e-12, 'long: (110 − 100) × 2'); near(assert, rb[0].gross, 15, 1e-12, 'short: (110 − 105) × 3');
  near(assert, ra[0].openFee, 0.2, 1e-12); near(assert, ra[0].closeFee, 0.2, 1e-12); near(assert, ra[0].net, 19.6, 1e-12);
  near(assert, rb[0].openFee, 0.3, 1e-12); near(assert, rb[0].closeFee, 0.3, 1e-12);
  assert.equal(ra[0].cls, 'Crypto perps');
});

test('an increase at the instant a position closes belongs to the one that opens', () => {
  const t1 = at('2026-09-01T10:00:00Z'), t3 = at('2026-09-02T10:00:00Z');
  const A = pos('A', 0, t1, t3), B = pos('B', 0, t3, t3 + 1000, 1);
  const { byPos, unassigned } = F.assign([fill('a', t1, 0, 2, 100), fill('b', t3, 1, 2, 101), fill('c', t3, 0, 1, 102)], null, [A, B]);
  assert.deepEqual(byPos.get('A').map((f) => f.id), ['a', 'b']);
  assert.deepEqual(byPos.get('B').map((f) => f.id), ['c']);
  assert.equal(unassigned.length, 0);
});

test('average entry, opening-fee shares, partial disposals and VARIOUS acquisition dates', () => {
  const p = pos('P', 0, at('2026-09-01T10:00:00Z'), at('2026-09-04T10:00:00Z'), 0, { totalIncreaseQuantity: '2', totalDecreaseQuantity: '2', totalIncreaseNotional: '220', realizedPnl: '0' });
  const fs = [fill('1', at('2026-09-01T10:00:00Z'), 0, 1, 100, 1), fill('2', at('2026-09-02T10:00:00Z'), 0, 1, 120, 1), fill('3', at('2026-09-03T10:00:00Z'), 1, 1, 130, 0.5), fill('4', at('2026-09-04T10:00:00Z'), 1, 1, 90, 0.5)].map((f) => F.norm(f, 'order'));
  const r = F.replay(p, fs, null, { prod: BTC, tz: 'UTC', complete: true });
  assert.equal(r.rows.length, 2);
  const [a, b] = r.rows;
  near(assert, a.avgEntry, 110, 1e-12); near(assert, a.gross, 20, 1e-12); near(assert, b.gross, -20, 1e-12);
  near(assert, a.openFee + b.openFee, 2, 1e-12, 'the opening fees, shared by quantity closed'); near(assert, a.openFee, 1, 1e-12);
  assert.equal(a.partial, true); assert.equal(b.partial, false);
  assert.equal(a.acquired, 'VARIOUS', 'averaged over increases on two dates'); assert.equal(a.n, 3, 'its number among the position\'s fills');
  assert.equal(r.check.ok, true, 'quantities, entry notional and realized PnL match the position');
  assert.equal(r.sizeAt(at('2026-09-02T12:00:00Z')), 2); assert.equal(r.avgAt(at('2026-09-02T12:00:00Z')), 110); assert.equal(r.sizeAt(at('2026-08-01T00:00:00Z')), 0);
  // proceeds − cost = net, for a long and for a short (the notional convention)
  for (const x of r.rows) near(assert, x.proceeds - x.cost, x.net, 1e-9);
  near(assert, a.cost, 110 + 1, 1e-12, 'a long\'s cost: entry notional plus its opening fee');
  const s = pos('S', 1, 0, 2, 0); const sr = F.replay(s, [F.norm(fill('x', 0, 1, 2, 50, 0.1), 'order'), F.norm(fill('y', 2, 0, 2, 40, 0.1), 'order')], null, {}).rows[0];
  near(assert, sr.gross, 20, 1e-12); near(assert, sr.proceeds, 100 - 0.1, 1e-12, 'a short\'s proceeds: entry notional less its opening fee'); near(assert, sr.proceeds - sr.cost, sr.net, 1e-12);
});

test('a position marked deleveraged whose fills carry no DELEVERAGE type: its final reduction is flagged', () => {
  const fs = [fill('1', 0, 0, 2, 100), fill('2', 1, 1, 1, 90), fill('3', 2, 1, 1, 80, 0, { type: 'DELEVERAGE' })].map((f) => F.norm(f, 'position'));
  assert.deepEqual(F.replay(pos('P', 0, 0, 2, 0, { wasDeleveraged: true }), fs, null, {}).rows.map((r) => r.adl), [false, true], 'by its type');
  fs[2].type = 'MARKET';
  assert.deepEqual(F.replay(pos('P', 0, 0, 2, 0, { wasDeleveraged: true }), fs, null, {}).rows.map((r) => r.adl), [false, true], 'by the position\'s flag');
  assert.deepEqual(F.replay(pos('P', 0, 0, 2, 0, { isLiquidated: true }), fs.slice(0, 2), null, {}).rows.map((r) => r.liq), [false], 'not while the position is still open');
});

test('average cost within a position (the exchange\'s method), not FIFO (B21)', () => {
  const p = pos('P', 0, 0, 3);
  const r = F.replay(p, [fill('1', 0, 0, 1, 100), fill('2', 1, 0, 1, 200), fill('3', 2, 1, 1, 150), fill('4', 3, 1, 1, 150)].map((f) => F.norm(f, 'order')), null, {});
  assert.deepEqual(r.rows.map((x) => x.gross), [0, 0], 'FIFO would book +50 then −50');
});

test('held over a year: calendar dates in the report\'s zone, the anniversary of 29 Feb clamped to 28 Feb (B22)', () => {
  const run = (open, close, tz) => F.replay(pos('P', 0, at(open), at(close)), [F.norm(fill('1', at(open), 0, 1, 100), 'order'), F.norm(fill('2', at(close), 1, 1, 100), 'order')], null, { tz }).rows[0].longTerm;
  assert.equal(run('2027-03-01T10:00:00Z', '2028-02-29T12:00:00Z', 'UTC'), false, '365.08 days, but the anniversary (1 Mar) is not reached');
  assert.equal(run('2026-06-01T10:00:00Z', '2027-06-01T11:00:00Z', 'UTC'), false, 'sold on the anniversary: exactly one year');
  assert.equal(run('2026-06-01T10:00:00Z', '2027-06-02T00:00:00Z', 'UTC'), true);
  assert.equal(run('2028-02-29T10:00:00Z', '2029-02-28T23:00:00Z', 'UTC'), false, 'acquired 29 Feb: the anniversary is 28 Feb');
  assert.equal(run('2028-02-29T10:00:00Z', '2029-03-01T00:00:00Z', 'UTC'), true);
  // the same instants are different dates in Tokyo: acquired 1 Mar there, sold 1 Mar a year later
  assert.equal(run('2027-02-28T16:00:00Z', '2028-03-01T14:59:00Z', 'UTC'), true, 'in UTC: acquired 28 Feb, sold 1 Mar');
  assert.equal(run('2027-02-28T16:00:00Z', '2028-03-01T14:59:00Z', 'Asia/Tokyo'), false, 'in Tokyo: acquired and sold on 1 Mar');
});

test('a disposal carries Form 8949\'s US reading of the holding period beside the anniversary flag, from the last increase; per position per day both are and-ed', () => {
  // opened 28 Feb 2027 (February's last day, 2028 a leap year), reduced twice on 29 Feb 2028 and once on 1 Mar
  const fl = [fill('1', at('2027-02-28T10:00:00Z'), 0, 2, 100), fill('2', at('2028-02-29T10:00:00Z'), 1, 1, 110), fill('3', at('2028-02-29T20:00:00Z'), 1, 0.5, 110), fill('4', at('2028-03-01T10:00:00Z'), 1, 0.5, 120)].map((f) => F.norm(f, 'order'));
  const rows = F.replay(pos('P', 0, at('2027-02-28T10:00:00Z'), at('2028-03-01T10:00:00Z')), fl, null, { tz: 'UTC' }).rows;
  assert.deepEqual(rows.map((r) => [r.longTerm, r.longTermUS]), [[true, false], [true, false], [true, true]], '29 Feb 2028: over a year by the anniversary, not under Rev. Rul. 66-7; 1 Mar: both');
  const days = F.byPositionDay(rows, 'UTC');
  assert.deepEqual(days.map((x) => [x.fills, x.longTerm, x.longTermUS]), [[2, true, false], [1, true, true]]);
  // a later increase restarts both counts
  const fl2 = [fill('1', at('2027-01-31T10:00:00Z'), 0, 1, 100), fill('2', at('2027-02-28T10:00:00Z'), 0, 1, 100), fill('3', at('2028-02-29T10:00:00Z'), 1, 2, 110)].map((f) => F.norm(f, 'order'));
  const r2 = F.replay(pos('Q', 0, at('2027-01-31T10:00:00Z'), at('2028-02-29T10:00:00Z')), fl2, null, { tz: 'UTC' }).rows[0];
  assert.deepEqual([r2.longTerm, r2.longTermUS, r2.acquired], [true, false, 'VARIOUS'], 'counted from the last increase (28 Feb 2027), the stricter convention');
});

test('the trade detail loads on its own up to a size, and waits to be asked for above it (load.detailSize)', () => {
  const S = T.load.detailSize, DAY = 86400000, P = utc('2026-08-01', '2026-09-30');
  // the largest real account checked loads on its own
  const mm = perps('perps-0x2f46-to-2026-10-01.json');
  const big = S(mm.positions, P.start, P.end, LATER);
  assert.equal(big.auto, true); assert.ok(big.touched > 50 && big.touched <= T.load.AUTO.positions, String(big.touched));
  assert.equal(big.touched, T.load.touched(mm.positions, P.start, P.end).length);
  // many positions to replay
  const many = Array.from({ length: T.load.AUTO.positions + 1 }, (_, i) => pos('p' + i, 0, P.start + i * 1000, P.start + i * 1000 + 500));
  assert.deepEqual(S(many, P.start, P.end, LATER), { auto: false, touched: T.load.AUTO.positions + 1, days: 61, truncated: false });
  assert.equal(S(many.slice(1), P.start, P.end, LATER).auto, true, 'at the limit it still loads on its own');
  // a position carried in from long before: fills and funding charges reach back that far
  const old = [pos('o', 0, P.end - (T.load.AUTO.days + 1) * DAY, P.end - DAY, 1)];
  const far = S(old, P.start, P.end, LATER);
  assert.equal(far.auto, false); assert.equal(far.days, T.load.AUTO.days + 1);
  // a period still running counts to now, not to its end
  assert.equal(S(old, P.start, P.end, P.end - 30 * DAY).days, T.load.AUTO.days + 1 - 30);
  // a position list the exchange cut short: asked for
  const cut = Object.assign([pos('c', 0, P.start, P.start + 1000)], { truncated: true });
  assert.equal(S(cut, P.start, P.end, LATER).auto, false);
  // nothing touched: nothing to read
  assert.deepEqual(S([], P.start, P.end, LATER), { auto: true, touched: 0, days: 61, truncated: false });
  // the perps card follows it: on its own when auto, else a 'Load trade detail' button; the holdings say they wait
  const vp = fs.readFileSync(path.join(root, 'js/tax/view-perps.js'), 'utf8');
  assert.match(vp, /const size = T\.load\.detailSize\(positions, start, end, now\);/);
  assert.match(vp, /if \(size\.auto\) \{ loadEvents\(\)\.catch\(\(\) => \{\}\); return; \}/);
  assert.match(vp, /'Load trade detail'\)/);
  assert.match(vp, /ctx\.onDetail\(null, null, null, \{ deferred: true \}\)/);
  assert.match(fs.readFileSync(path.join(root, 'js/tax/view-holdings.js'), 'utf8'), /st\.deferred = !!\(o && o\.deferred\)/);
});

test('per position per local day: amounts summed, prices weighted', () => {
  const p = pos('P', 0, 0, at('2026-09-02T23:30:00Z'));
  const fs = [fill('1', 0, 0, 3, 100, 0.3), fill('2', at('2026-09-02T08:00:00Z'), 1, 1, 110, 0.1), fill('3', at('2026-09-02T20:00:00Z'), 1, 1, 120, 0.1), fill('4', at('2026-09-02T23:30:00Z'), 1, 1, 90, 0.1)].map((f) => F.norm(f, 'order'));
  const rows = F.replay(p, fs, null, { tz: 'UTC' }).rows;
  const utcDays = F.byPositionDay(rows, 'UTC'), berlin = F.byPositionDay(rows, 'Europe/Berlin');
  assert.equal(utcDays.length, 1); assert.equal(utcDays[0].fills, 3); near(assert, utcDays[0].gross, 10 + 20 - 10, 1e-12); near(assert, utcDays[0].exit, 320 / 3, 1e-12);
  assert.equal(berlin.length, 2, 'the 23:30 UTC fill is on 3 Sep in Berlin');
  near(assert, berlin[0].gross + berlin[1].gross, 20, 1e-12);
});

// ---------- real subaccounts ----------
test('0x2f46 (a market maker, many partial closes): the replay reproduces every fill\'s realizedPnl and each position\'s totals', () => {
  const d = perps('perps-0x2f46-to-2026-10-01.json');
  const { byPos, unassigned } = F.assign(d.fills, null, d.positions);
  assert.equal(unassigned.length, 0, 'every order fill has its position');
  let checked = 0;
  const reps = new Map();
  for (const p of d.positions) {
    const r = F.replay(p, byPos.get(p.id), null, { prod: d.ref.byId[p.productId], complete: U.num(p.updatedAt) < d.cutoff });
    reps.set(p.id, r);
    if (r.check.ok != null) { checked++; assert.equal(r.check.ok, true, 'position ' + p.id + ': ' + JSON.stringify(r.check)); }
  }
  assert.ok(checked >= 100, 'checked ' + checked);
  // the exchange's own per-fill realizedPnl (/v1/position/fill) for the 20 positions with the most fills
  let n = 0, worst = 0, splits = 0;
  for (const id of new Set(d.positionFills.map((f) => f.positionId))) {
    const p = d.positions.find((x) => x.id === id);
    const pool = reps.get(id).rows.slice();
    for (const f of d.pfOf(id).map((x) => F.norm(x, 'position')).filter((x) => x.side !== String(p.side))) {
      const j = pool.findIndex((r) => r.t === f.t && Math.abs(r.qty - f.qty) < 1e-9 && r.exit === f.price);
      assert.ok(j >= 0, 'a disposal for the exchange\'s fill at ' + f.t);
      worst = Math.max(worst, Math.abs(pool[j].gross - f.pnl)); n++; pool.splice(j, 1);
    }
    // the fees of the replayed fills, split ones included, are the exchange's
    near(assert, U.sum(byPos.get(id), (f) => f.fee), U.sum(d.pfOf(id), (f) => U.num(f.feeUsd)), 1e-9, 'fees of ' + id);
    splits += byPos.get(id).filter((f) => f.split).length;
  }
  assert.ok(n >= 150, 'compared ' + n + ' fills'); assert.ok(worst < 1e-6, 'worst difference ' + worst);
  assert.ok(splits > 0, 'order fills split between a closing and an opening position are among them');
  // opening-fee shares plus the fees still open add up to every increase's fee
  let inc = 0, shares = 0, open = 0;
  for (const p of d.positions) { for (const f of byPos.get(p.id)) if (f.side === String(p.side)) inc += f.fee; const r = reps.get(p.id); shares += U.sum(r.rows, (x) => x.openFee); open += r.check.openFees; }
  near(assert, shares + open, inc, 1e-9, 'opening fees');
});

test('0x2f46, Aug–Sep 2026: each UTC day\'s disposals add up to the archive\'s realized PnL', () => {
  const d = perps('perps-0x2f46-to-2026-10-01.json');
  const P = utc('2026-08-01', '2026-09-30'), led = ledger(MD, d, P);
  const D = F.disposals(events(MD, d, P.start, P.end), { ledger: led, period: P, ref: d.ref, tz: 'UTC' });
  assert.deepEqual(D.day.bad, [], 'no UTC day off');
  near(assert, U.sum(D.inP, (r) => r.gross), led.totals.realized, 1e-6, 'Σ gross = the ledger\'s realized PnL');
  near(assert, led.totals.realized, -5922.791667, 1e-6);
  near(assert, D.outside.usd, 0, 1e-6, 'nothing outside the disposals');
  assert.deepEqual(D.failed, []); assert.equal(D.unassigned.length, 0);
  const gains = U.sum(D.inP.filter((r) => r.gross > 0), (r) => r.gross), losses = U.sum(D.inP.filter((r) => r.gross < 0), (r) => r.gross);
  near(assert, gains + losses, led.totals.realized, 1e-6, 'gains + losses = realized PnL');
  assert.ok(D.inP.some((r) => r.partial), 'partial closes of positions open at the period end have rows');
  // a position open at the period end: its partial closes are disposals of the period
  const open = D.inP.filter((r) => { const p = d.positions.find((x) => x.id === r.positionId); return U.num(p.size) !== 0 || U.num(p.updatedAt) >= P.end; });
  assert.ok(open.length > 0 && Math.abs(U.sum(open, (r) => r.gross)) > 100, 'more than $100 realized on positions still open');
});

test('0x8003: the liquidation fill of 2026-09-25 11:06:40Z is a disposal of its own, from the position\'s fill list', () => {
  const d = perps('perps-0x8003-liquidation.json');
  const liq = d.positions.find((p) => p.isLiquidated);
  assert.ok(liq, 'the fixture has the liquidated position');
  assert.ok(!d.fills.some((f) => f.type === 'LIQUIDATION'), 'no order fill is the liquidation');
  const P = utc('2026-09-01', '2026-09-30'), led = ledger(MD, d, P);
  const ev = events(MD, d, P.start, P.end);
  assert.ok(ev.posFills.has(liq.id));
  const D = F.disposals(ev, { ledger: led, period: P, ref: d.ref, tz: 'UTC' });
  const row = D.inP.find((r) => r.liq);
  assert.ok(row, 'a liquidation row');
  assert.equal(new Date(row.t).toISOString(), '2026-09-25T11:06:40.097Z');
  near(assert, row.gross, -287.694458, 1e-6); assert.equal(row.closeFee, 0); assert.equal(row.partial, false); assert.equal(row.type, 'LIQUIDATION');
  near(assert, U.sum(D.inP, (r) => r.gross), -291.895058, 1e-6, 'the account\'s whole realized PnL');
  near(assert, U.sum(D.inP, (r) => r.gross), led.totals.realized, 1e-6);
  assert.deepEqual(D.day.bad, []); assert.equal(D.unassigned.length, 0, 'the liquidated position\'s order fills are not counted twice');
  assert.equal(D.reps.get(liq.id).check.ok, true);
});

test('0x8ddb: an XAU short with position fees, replayed and reconciled', () => {
  const d = perps('perps-0x8ddb-xau-position-fees.json');
  const P = utc('2026-09-01', '2026-09-30'), led = ledger(MD, d, P);
  // every position read from its own fill list too: the replay from order fills must agree with it
  const all = d.positions.map((p) => p.id);
  for (const also of [[], all]) {
    const D = F.disposals(events(MD, d, P.start, P.end, { also }), { ledger: led, period: P, ref: d.ref, tz: 'UTC' });
    assert.deepEqual(D.day.bad, []); assert.deepEqual(D.failed, []);
    near(assert, U.sum(D.inP, (r) => r.gross), led.totals.realized, 1e-6);
    const xau = D.inP.filter((r) => r.ticker === 'XAU-USD' && !r.long);
    assert.ok(xau.length >= 1, 'the XAU short');
    assert.equal(xau[0].cls, 'Commodity mPerps');
    for (const r of D.inP) near(assert, r.proceeds - r.cost, r.net, 1e-9);
    const feeOf = d.positions.filter((x) => U.num(x.positionFeeAccruedUsd) > 0);
    assert.equal(feeOf.length, 1, 'one position paid position fees');
    near(assert, U.num(feeOf[0].positionFeeAccruedUsd), 10.57990724, 1e-9);
    const rows = D.inP.filter((r) => r.positionId === feeOf[0].id);
    assert.ok(rows.length && rows.every((r) => r.ticker === 'XAU-USD' && !r.long));
    near(assert, U.sum(rows, (r) => r.posFeeIn), 10.57990724, 1e-6, 'inside reading: the position\'s whole position fee');
    near(assert, U.sum(rows, (r) => r.posFeeAt), 10.57990724, 1e-6, 'settled at its fills');
    near(assert, U.sum(D.inP, (r) => r.netAll), U.sum(D.inP, (r) => r.net + r.fundingIn - r.posFeeIn), 1e-9);
  }
});

test('the event loader: liquidated positions read from their own fills, a closed range kept for the tab, progress reported', async () => {
  const d = perps('perps-0x8003-liquidation.json');
  const A = MD.api, saved = { positions: A.positions, page: A.page, fundingCharges: A.fundingCharges, positionFills: A.positionFills, history: A.history };
  const calls = { positionFills: [], page: 0 };
  const states = [];
  A.positions = async () => Object.assign(d.positions.slice(), { truncated: false });
  A.page = async (base, path, params, o) => {
    calls.page++;
    const inR = (t) => t > U.num(params.createdAfter) && t < U.num(params.createdBefore);
    const rows = path === '/v1/order/fill' ? d.fills.filter((f) => inR(U.num(f.createdAt))) : [];
    if (o && o.onPage) o.onPage(1, rows.length);
    return Object.assign(rows, { truncated: false });
  };
  A.fundingCharges = async (sid, start, o) => { if (o.onProgress) o.onProgress(1, 1); return d.charges.filter((c) => U.num(c.time) >= start && U.num(c.time) < o.end); };
  A.positionFills = async (id) => { calls.positionFills.push(id); return Object.assign(d.pfOf(id), { truncated: false }); };
  A.history = async () => d.balance;
  try {
    const P = utc('2026-09-01', '2026-09-30');
    const o = { start: P.start, end: P.end, ref: d.ref, dayRows: d.balance, progress: (s) => states.push(s) };
    const ev = await T.load.events(d.sid, o);
    assert.deepEqual(calls.positionFills, [d.positions.find((p) => p.isLiquidated).id], 'only the liquidated position is read from its fill list');
    assert.equal(ev.fills.length, d.fills.length); assert.equal(ev.charges.length, d.charges.length);
    assert.ok(states.some((s) => s.fillPages === 1) && states.some((s) => s.fundDone === 1) && states.some((s) => s.posTotal === 1));
    assert.deepEqual(ev.truncated, { positions: false, fills: false, transfers: false, charges: false, posFills: [] });
    const n = calls.page;
    assert.equal(await T.load.events(d.sid, o), ev, 'a range that ended is kept for the tab');
    assert.equal(calls.page, n);
    // a range still running is extended: only fills after the last read are asked for, the liquidated position is not read again
    const asked = [];
    A.page = async (base, path, params) => { if (path === '/v1/order/fill') asked.push(params.createdAfter); return Object.assign(path === '/v1/order/fill' ? d.fills.filter((f) => U.num(f.createdAt) > U.num(params.createdAfter)) : [], { truncated: false }); };
    const run = { start: P.start, end: Date.now() + 86400000, ref: d.ref, dayRows: d.balance };
    const e1 = await T.load.events(d.sid, run), e2 = await T.load.events(d.sid, run);
    assert.equal(asked[1], e1.to - 1, 'the second read starts where the first ended');
    assert.equal(e2.fills.length, d.fills.length, 'no fill lost or doubled');
    assert.equal(calls.positionFills.length, 2, 'the liquidated position read once per range');
  } finally { Object.assign(A, saved); }
});

test('the event loader reads to the end of the hour a period ends in: the ledger counts that hour in the period (India, 18:30Z)', async () => {
  const d = perps('perps-0x8003-liquidation.json');
  const A = MD.api, saved = { positions: A.positions, page: A.page, fundingCharges: A.fundingCharges, positionFills: A.positionFills, history: A.history };
  const asked = {}, end19 = Date.UTC(2026, 8, 27, 19);
  // a deposit inside the period, one in the half hour after its end (the ledger's last hour still counts it), one after
  const transfers = [{ id: 't1', createdAt: Date.UTC(2026, 8, 20, 12), type: 'DEPOSIT', amount: '10', fee: '0', status: 'COMPLETED' },
    { id: 't2', createdAt: Date.UTC(2026, 8, 27, 18, 40), type: 'DEPOSIT', amount: '20', fee: '0', status: 'COMPLETED' },
    { id: 't3', createdAt: Date.UTC(2026, 8, 27, 19, 5), type: 'DEPOSIT', amount: '30', fee: '0', status: 'COMPLETED' }];
  A.positions = async () => Object.assign(d.positions.slice(), { truncated: false });
  A.page = async (base, path, params) => {
    asked[path] = params;
    const inR = (t) => t > U.num(params.createdAfter) && t < U.num(params.createdBefore);
    return Object.assign(path === '/v1/order/fill' ? d.fills.filter((f) => inR(U.num(f.createdAt))) : path === '/v1/token/transfer' ? transfers.filter((t) => inR(t.createdAt)) : [], { truncated: false });
  };
  A.fundingCharges = async (sid, start, o) => { asked.charges = o.end; return d.charges.filter((c) => U.num(c.time) >= start && U.num(c.time) < o.end); };
  A.positionFills = async (id) => Object.assign(d.pfOf(id), { truncated: false });
  A.history = async () => d.balance;
  try {
    const P = PER.resolve({ from: '2026-09-15', to: '2026-09-27', tz: 'Asia/Kolkata' }, { now: LATER });
    assert.equal(P.end, Date.UTC(2026, 8, 27, 18, 30));
    const ev = await T.load.events(d.sid + '-in', { start: P.start, end: P.end, ref: d.ref, dayRows: d.balance });
    assert.equal(asked['/v1/order/fill'].createdBefore, end19, 'fills to 19:00Z');
    assert.equal(asked['/v1/token/transfer'].createdBefore, end19, 'transfers to 19:00Z');
    assert.equal(asked.charges, end19, 'funding charges to 19:00Z');
    assert.equal(ev.to, end19);
    assert.deepEqual(ev.transfers.map((t) => t.id), ['t1'], 'the period\'s own transfers end at its exact end');
    assert.deepEqual(ev.hourTransfers.map((t) => t.id), ['t1', 't2'], 'the checks also see the one in the hour the end cuts');
    // a period that ends on the hour reads to its end, as before
    const Q = utc('2026-09-15', '2026-09-27');
    await T.load.events(d.sid + '-utc', { start: Q.start, end: Q.end, ref: d.ref, dayRows: d.balance });
    assert.equal(asked['/v1/order/fill'].createdBefore, Q.end);
    // one that ended a few minutes ago inside an hour stays open for the tab until that hour is over: read again
    // a frozen clock at half past an hour, so the hour the end cuts is never over whatever minute the suite runs at (the
    // real clock made this fail between hh:05 and hh:06, which would stop the deploy)
    const H = 3600000, realNow = Date.now, fixed = Math.floor(realNow() / H) * H + 30 * 60000;
    Date.now = () => fixed;
    try {
      const end = fixed - 6 * 60000;
      const o2 = { start: end - 86400000, end, ref: d.ref, dayRows: d.balance };
      let pages = 0; const page0 = A.page; A.page = async (...x) => { pages++; return page0(...x); };
      await T.load.events(d.sid + '-recent', o2); const n1 = pages;
      await T.load.events(d.sid + '-recent', o2);
      assert.ok(n1 > 0 && pages > n1, 'the hour the end cuts is not over: not kept as it is');
    } finally { Date.now = realNow; }
  } finally { Object.assign(A, saved); }
});

test('load.span: what another read of this tab covers is not read again (done or still running); a failed or truncated read is not reused, nor an open one for transfers; closed parts go through the request cache', async () => {
  const A = MD.api, page0 = A.page, H = 3600000, T0 = Date.UTC(2026, 7, 1), FILL = '/v1/order/fill', TR = '/v1/token/transfer';
  const rows = Array.from({ length: 60 }, (_, i) => ({ id: 'f' + String(i).padStart(2, '0'), createdAt: T0 + i * H }));
  const asked = []; let gate = null;   // gate: a read still running until it opens
  A.page = async (base, path, params, o) => {
    asked.push([path, params.createdAfter + 1, params.createdBefore, o.ttl]);
    if (gate) await gate;
    if (o.signal && o.signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    const out = rows.filter((r) => r.createdAt > params.createdAfter && r.createdAt < params.createdBefore);
    if (o.onPage) o.onPage(1, out.length);
    return Object.assign(out, { truncated: false });
  };
  const ids = (l) => l.map((r) => r.id).join(','), want = (a, b) => ids(rows.filter((r) => r.createdAt >= a && r.createdAt < b));
  const ranges = () => asked.map((x) => [x[1], x[2]]);
  try {
    T.cache.clear();
    // the period's read, then the whole history's: only the hours before and after it are asked for
    assert.equal(ids(await T.load.span(FILL, 's', T0 + 10 * H, T0 + 30 * H, { maxPages: 500 })), want(T0 + 10 * H, T0 + 30 * H));
    asked.length = 0; const seen = [];
    const l = await T.load.span(FILL, 's', T0, T0 + 50 * H, { maxPages: 500, onPage: (n, r) => seen.push([n, r]) });
    assert.equal(ids(l), want(T0, T0 + 50 * H), 'every row once, in time order');
    assert.deepEqual(ranges(), [[T0, T0 + 10 * H], [T0 + 30 * H, T0 + 50 * H]]);
    assert.deepEqual(seen.at(-1), [2, 50], 'progress: the pages read, the rows read and reused');
    assert.ok(asked.every((x) => x[3] === 5 * 60000), 'a closed range goes through the request cache');
    // a range inside what was read asks for nothing; another subaccount or list is its own
    asked.length = 0;
    assert.equal(ids(await T.load.span(FILL, 's', T0 + 12 * H, T0 + 20 * H)), want(T0 + 12 * H, T0 + 20 * H)); assert.equal(asked.length, 0);
    await T.load.span(FILL, 's2', T0 + 12 * H, T0 + 20 * H); await T.load.span(TR, 's', T0 + 12 * H, T0 + 20 * H, { closedOnly: true });
    assert.equal(asked.length, 2);

    // two loads at once: the second waits for the first's read rather than asking for the same pages
    T.cache.clear(); asked.length = 0;
    let open; gate = new Promise((r) => { open = r; });
    const a1 = T.load.span(FILL, 's', T0 + 10 * H, T0 + 30 * H), a2 = T.load.span(FILL, 's', T0, T0 + 50 * H);
    await new Promise((r) => setTimeout(r, 5)); gate = null; open();
    assert.equal(ids(await a2), want(T0, T0 + 50 * H)); await a1;
    assert.deepEqual(ranges(), [[T0 + 10 * H, T0 + 30 * H], [T0, T0 + 10 * H], [T0 + 30 * H, T0 + 50 * H]]);
    // the first is cancelled: its abort is not the second's, which reads that part itself
    T.cache.clear(); asked.length = 0; gate = new Promise((r) => { open = r; });
    const ac = new AbortController();
    const b1 = T.load.span(FILL, 's', T0 + 10 * H, T0 + 30 * H, { signal: ac.signal }), b2 = T.load.span(FILL, 's', T0, T0 + 50 * H);
    await new Promise((r) => setTimeout(r, 5)); ac.abort(); gate = null; open();
    await assert.rejects(b1, (e) => T.isAbort(e));
    assert.equal(ids(await b2), want(T0, T0 + 50 * H));
    assert.deepEqual(ranges(), [[T0 + 10 * H, T0 + 30 * H], [T0, T0 + 10 * H], [T0 + 10 * H, T0 + 30 * H], [T0 + 30 * H, T0 + 50 * H]]);
    // the second's own cancel still stops it while it waits
    T.cache.clear(); gate = new Promise((r) => { open = r; });
    const ac2 = new AbortController();
    const c1 = T.load.span(FILL, 's', T0 + 10 * H, T0 + 30 * H), c2 = T.load.span(FILL, 's', T0 + 10 * H, T0 + 20 * H, { signal: ac2.signal });
    ac2.abort(); gate = null; open();
    await assert.rejects(c2, (e) => T.isAbort(e)); await c1;

    // a truncated read is not reused
    T.cache.clear(); asked.length = 0;
    const page1 = A.page; A.page = async (...x) => Object.assign(await page1(...x), { truncated: true });
    assert.equal((await T.load.span(FILL, 's', T0 + 10 * H, T0 + 30 * H)).truncated, true); A.page = page1;
    asked.length = 0; await T.load.span(FILL, 's', T0, T0 + 50 * H);
    assert.deepEqual(ranges(), [[T0, T0 + 50 * H]]);
    // transfers (closedOnly): a range still open when read is not reused (a pending transfer can complete); fills are
    const now = Date.now();
    T.cache.clear(); asked.length = 0;
    await T.load.span(TR, 's', now - 2 * H, now + H, { closedOnly: true }); await T.load.span(TR, 's', now - 3 * H, now + 2 * H, { closedOnly: true });
    assert.deepEqual(ranges(), [[now - 2 * H, now + H], [now - 3 * H, now + 2 * H]]);
    assert.deepEqual(asked.map((x) => x[3]), [0, 0], 'an open range skips the request cache');
    asked.length = 0;
    await T.load.span(FILL, 's', now - 2 * H, now + H); await T.load.span(FILL, 's', now - 3 * H, now + 2 * H);
    assert.deepEqual(ranges(), [[now - 2 * H, now + H], [now - 3 * H, now - 2 * H], [now + H, now + 2 * H]]);
  } finally { A.page = page0; gate = null; T.cache.clear(); }
});

test('the USDe lots\' whole history after the period\'s trade detail reads only the fills and transfers outside it, and gets the same events as a read from scratch', async () => {
  const d = perps('perps-0x8003-liquidation.json');
  const A = MD.api, saved = { positions: A.positions, page: A.page, fundingCharges: A.fundingCharges, positionFills: A.positionFills, history: A.history };
  const asked = [];
  A.positions = async () => Object.assign(d.positions.slice(), { truncated: false });
  A.page = async (base, path, params) => {
    asked.push([path, U.num(params.createdAfter) + 1, U.num(params.createdBefore)]);
    const inR = (t) => t > U.num(params.createdAfter) && t < U.num(params.createdBefore);
    return Object.assign(path === '/v1/order/fill' ? d.fills.filter((f) => inR(U.num(f.createdAt))) : [], { truncated: false });
  };
  A.fundingCharges = async (sid, start, o) => d.charges.filter((c) => U.num(c.time) >= start && U.num(c.time) < o.end);
  A.positionFills = async (id) => Object.assign(d.pfOf(id), { truncated: false });
  A.history = async () => d.balance;
  const ids = (ev) => ev.fills.map((f) => f.id).sort().join(',');
  try {
    T.cache.clear();
    const P = utc('2026-09-22', '2026-09-24');
    const ev = await T.load.events(d.sid, { start: P.start, end: P.end, ref: d.ref, dayRows: d.balance });
    asked.length = 0;
    const o = { first: U.num(d.createdAt), end: P.end + 30 * 86400000, ref: d.ref };
    const life = await T.load.lifetime(d.sid, o);
    const fillReads = asked.filter((x) => x[0] === '/v1/order/fill');
    assert.ok(fillReads.length >= 1);
    for (const [, a, b] of fillReads) assert.ok(b <= ev.from || a >= ev.to, 'never inside the period\'s read');
    assert.ok(life.ev.from < ev.from, 'the history starts before the positions the period touches');
    for (const [, a, b] of asked.filter((x) => x[0] === '/v1/token/transfer')) assert.ok(b <= P.start || a >= ev.to, 'transfers: only outside the closed period\'s read');
    // the same as a read from scratch
    T.cache.clear(); asked.length = 0;
    const fresh = await T.load.lifetime(d.sid, o);
    assert.deepEqual(asked.filter((x) => x[0] === '/v1/order/fill').map((x) => [x[1], x[2]]), [[fresh.ev.from, fresh.ev.to]]);
    assert.equal(ids(life.ev), ids(fresh.ev)); assert.equal(life.ev.fills.length, d.fills.length);
    assert.equal(life.D.rows.length, fresh.D.rows.length);
  } finally { Object.assign(A, saved); T.cache.clear(); }
});

test('the report currency: a disposal\'s opening-fee share and the funding and position fees carried into it convert at the dates they were paid, its result, closing fee and notional legs at its own (UK CG78310, DE §20 Abs. 4 S. 1) (B2)', () => {
  // one rate per UTC date: 1 on 1 Sep, 2 on 2 Sep, 3 on 3 Sep, 4 on 4 Sep
  const fx = (usd, t) => usd * new Date(t).getUTCDate();
  const t1 = at('2026-09-01T10:00:00Z'), t2 = at('2026-09-02T10:00:00Z'), t3 = at('2026-09-03T10:00:00Z'), t4 = at('2026-09-04T10:00:00Z');
  const p = pos('A', 0, t1, t4);
  // buys of 2 on 1 and 2 Sep (fees 0.4 and 0.6; funding +0.5 settled at the second), sells of 2 on 3 Sep (funding −0.2
  // and a position fee 0.1 settled at it) and on 4 Sep
  const fs = [fill('1', t1, 0, 2, 100, 0.4), fill('2', t2, 0, 2, 110, 0.6), fill('3', t3, 1, 2, 120, 0.3), fill('4', t4, 1, 2, 90, 0.2)].map((f) => F.norm(f, 'order'));
  const settle = { funding: new Map([[t2, 0.5], [t3, -0.2]]), fee: new Map([[t3, 0.1]]) };
  const [a, b] = F.replay(p, fs, settle, { prod: BTC, tz: 'UTC', fx }).rows;
  near(assert, a.openFee, 0.5, 1e-12); near(assert, a.openFeeC, (0.4 * 1 + 0.6 * 2) / 2, 1e-12, 'half the opening fees, each at the date paid');
  near(assert, a.fundingIn, 0.15, 1e-12); near(assert, a.fundingInC, (0.5 * 2 - 0.2 * 3) / 2, 1e-12, 'each settlement at its own date');
  near(assert, a.posFeeInC, 0.1 * 3 / 2, 1e-12);
  near(assert, a.grossC, 30 * 3, 1e-12); near(assert, a.closeFeeC, 0.3 * 3, 1e-12, 'the result and its closing fee at the disposal date');
  near(assert, a.netC, 90 - 0.8 - 0.9, 1e-12); near(assert, a.netAllC, a.netC + 0.2 - 0.15, 1e-12);
  assert.ok(Math.abs(a.netC - a.net * 3) > 0.5, 'not the USD net at the disposal date\'s rate');
  near(assert, a.entryNotionalC, 210 * 3, 1e-9); near(assert, a.exitNotionalC, 240 * 3, 1e-9, 'the notional legs at the disposal date');
  near(assert, a.proceedsC - a.costC, a.netC, 1e-9); near(assert, a.costC, 630 + 0.8, 1e-9, 'a long\'s cost: the entry notional at the disposal date plus its opening-fee share as paid');
  // the rest goes with the second disposal, still at the dates paid
  near(assert, b.openFeeC, 0.8, 1e-12); near(assert, b.fundingInC, 0.2, 1e-12); near(assert, b.posFeeInC, 0.15, 1e-12);
  near(assert, b.netC, -30 * 4 - 0.8 - 0.2 * 4, 1e-12); near(assert, b.proceedsC - b.costC, b.netC, 1e-9);
  // a short: its proceeds are the entry notional less the opening-fee share as paid
  const s = F.replay(pos('S', 1, t1, t3), [F.norm(fill('x', t1, 1, 2, 50, 0.1), 'order'), F.norm(fill('y', t3, 0, 2, 40, 0.1), 'order')], null, { fx }).rows[0];
  near(assert, s.proceedsC, 100 * 3 - 0.1, 1e-12); near(assert, s.proceedsC - s.costC, s.netC, 1e-12); near(assert, s.netC, 20 * 3 - 0.1 - 0.3, 1e-12);
  // without a report currency every C is the USD amount
  const u = F.replay(p, fs, settle, { tz: 'UTC' }).rows[0];
  for (const k of ['gross', 'openFee', 'closeFee', 'fundingIn', 'posFeeIn', 'net', 'netAll', 'proceeds', 'cost', 'entryNotional', 'exitNotional']) near(assert, u[k + 'C'], u[k], 1e-12, k);
  // per position per local day: the C amounts summed too
  const day = F.byPositionDay([a, Object.assign({}, a, { t: a.t + 1000, n: 9 })], 'UTC');
  near(assert, day[0].netC, 2 * a.netC, 1e-12); near(assert, day[0].openFeeC, 2 * a.openFeeC, 1e-12);
});

test('opening fees still open at the period end, in the report currency each at the date it was paid (B2)', () => {
  const fx = (usd, t) => usd * new Date(t).getUTCDate();
  const t1 = at('2026-09-01T10:00:00Z'), t2 = at('2026-09-02T10:00:00Z'), t3 = at('2026-09-03T10:00:00Z');
  const B = pos('B', 0, t1, t3, 3, { totalIncreaseQuantity: '4', totalDecreaseQuantity: '1' });
  const fills = [fill('1', t1, 0, 2, 100, 0.4), fill('2', t2, 0, 2, 110, 0.6), fill('3', t3, 1, 1, 120, 0.1)];
  const per = PER.resolve({ from: '2026-09-01', to: '2026-09-03', tz: 'UTC' }, { now: LATER });
  const led = T.ledger.build({ balance: [], volume: [], ref: { byId: { btc: BTC } }, period: per });
  const ev = { positions: [B], touched: [B], from: t1, to: per.end, fills, transfers: [], posFills: new Map(), charges: [], pre: [], resFrom: 0, pfHours: new Map(), truncated: { positions: false, fills: false, transfers: false, charges: false, posFills: [] }, failed: [] };
  const D = F.disposals(ev, { ledger: led, period: per, ref: { byId: { btc: BTC } }, tz: 'UTC', fx });
  near(assert, D.openFeesEnd, 1 * 3 / 4, 1e-12, 'three quarters of the opening fees are still open');
  near(assert, D.openFeesEndC, (0.4 * 1 + 0.6 * 2) * 3 / 4, 1e-12);
  // the perps card shows it in the report currency (view-perps), not in USD
  const vp = fs.readFileSync(path.join(root, 'js/tax/view-perps.js'), 'utf8');
  assert.match(vp, /not yet part of any disposal: \$\{fmtC\(rates \? D\.openFeesEndC : D\.openFeesEnd\)\}/);
});
