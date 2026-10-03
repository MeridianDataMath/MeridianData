// Tax center exports (MD.tax.exports): the registry, how a report and a tax tool's file are written, the perps daily
// ledger without the archive's padding, and the Meridian Predict files on real wallets (snapshot files kept in
// tests/fixtures/tax): the record plus the secondary-market file add up to the Realized PnL tile under every basis.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { load, near, root } from './_load.mjs';
import { perps, events, ledger } from './_tax-fixture.mjs';

const MD = load(['js/util.js', 'js/api.js', 'js/predict/api.js', 'js/predict/analytics.js', 'js/tax/core.js', 'js/tax/tz.js', 'js/tax/periods.js', 'js/tax/fx.js', 'js/tax/ledger.js', 'js/tax/load.js', 'js/tax/fills.js', 'js/tax/funding.js', 'js/tax/predict.js', 'js/tax/lots.js', 'js/tax/holdings.js', 'js/tax/summary.js', 'js/tax/methodology.js', 'js/tax/zip.js', 'js/tax/exports.js', 'js/tax/ui.js']);
const P = MD.predict, T = MD.tax, PR = T.predict, EX = T.exports;
const DAY = 86400000;
const USD = T.fx.money(null, 'UTC');
const fname = (k) => k + '.csv';
const col = (f, name) => { const c = f.columns.find((x) => x[0] === name); assert.ok(c, 'no column ' + name); return c[1]; };
/** a report currency whose rate changes every day, as the ECB's */
const eur = (tz = 'UTC') => {
  const d = [], r = [];
  for (let t = Date.UTC(2026, 5, 1), i = 0; t < Date.UTC(2027, 1, 1); t += DAY, i++) { d.push(new Date(t).toISOString().slice(0, 10)); r.push(0.8 + (i % 17) / 100); }
  return T.fx.money(T.fx.rates({ ccy: 'EUR', id: 'ecb', via: 'file', table: { source: 'ecb', ccy: 'EUR', d, r, ref: null }, tz }), tz);
};
/** a period from local dates, as the page resolves it */
const period = (fromKey, toKey, tz) => { const p = T.periods.resolve({ from: fromKey, to: toKey, tz }, { firstT: Date.UTC(2026, 5, 29), now: Date.UTC(2027, 0, 20), browserZone: 'UTC' }); assert.equal(p.mode, 'custom'); return p; };

test('the registry: a report starts with its methodology rows, a tool file is exactly the tool\'s header and rows', () => {
  EX.define('test-report', { section: 'test', kind: 'report', label: 'Report', sub: (c) => 'for ' + c.who, build: () => ({ name: 'r.csv', columns: [['A', (r) => r.a], ['B', (r) => r.b]], rows: [{ a: 1, b: 'x' }] }) });
  EX.define('test-tool', { section: 'test', kind: 'tool', label: 'Tool', when: (c) => c.tool, build: () => ({ name: 't.csv', columns: [['Date', (r) => r.d], ['Sent Amount', (r) => r.s]], rows: [{ d: '2026-01-01 10:00 UTC', s: '1' }], warnings: ['part'] }) });
  assert.deepEqual(EX.list('test').map((d) => d.id), ['test-report', 'test-tool']);
  assert.deepEqual(EX.offered('test', { tool: false }).map((d) => d.id), ['test-report'], 'when() decides what is offered');
  assert.equal(EX.text(EX.get('test-report').sub, { who: 'me' }), 'for me'); assert.equal(EX.text('plain'), 'plain');
  const meth = [['Disclaimer', T.DISCLAIMER], ['Completeness', 'complete']];
  const rep = EX.build('test-report', {});
  assert.deepEqual(rep.warnings, []); assert.equal(EX.fileName(rep), 'r.csv');
  assert.equal(EX.render(rep, meth), 'Disclaimer,' + T.cell(T.DISCLAIMER) + '\r\nCompleteness,complete\r\n\r\nA,B\r\n1,x');
  const tool = EX.build('test-tool', {});
  assert.equal(EX.fileName(tool), 't-INCOMPLETE.csv', 'an incomplete file says so in its name');
  assert.equal(EX.render(tool, meth).split('\r\n')[0], 'Date,Sent Amount', 'a tool reads its first row as the header: nothing goes before it');
});

test('the perps daily ledger starts at the first day with a balance or a flow, whatever the archive pads before it (B31)', () => {
  const z = (day) => ({ day, balance: 0, realizedPnl: 0, fee: 0, pfees: 0, funding: 0, deposit: 0, withdrawal: 0, wfee: 0, volume: 0 });
  // 0x2f46…: created 2026-09-04, the archive's chunk answered from 2026-08-27 with zero days
  const days = [];
  for (let d = Date.UTC(2026, 7, 27); d < Date.UTC(2026, 8, 10); d += DAY) days.push(z(d));
  days[8].deposit = 500; days[8].balance = 500;   // 2026-09-04
  days[10].balance = 500;                          // a quiet day later: kept
  const out = EX.fromFirstActive(days);
  assert.equal(out.length, days.length - 8); assert.equal(out[0], days[8]); assert.ok(out.includes(days[10]));
  assert.deepEqual(EX.fromFirstActive(days.slice(0, 8)), [], 'nothing at all: no rows (not every row)');
  assert.deepEqual(EX.fromFirstActive([]), []);
  const onlyBal = [z(0), Object.assign(z(DAY), { balance: 3 })];
  assert.equal(EX.fromFirstActive(onlyBal)[0], onlyBal[1], 'a balance alone counts');
  const fee = [z(0), Object.assign(z(DAY), { pfees: 0.5 })];
  assert.equal(EX.fromFirstActive(fee).length, 1, 'position fees count');
});

test('a converted column leaves the cell blank where the USD amount is blank, never 0 (B31)', () => {
  const money = eur();
  const cols = money.cols((r) => r.v, (r) => r.t, 'Realized PnL');
  assert.deepEqual(cols.map((c) => c[0]), ['Realized PnL EUR', 'USD→EUR rate', 'Rate date (ECB)']);
  const t = Date.UTC(2026, 8, 1, 12);
  assert.deepEqual(cols.map((c) => c[1]({ v: null, t })), ['', '', '']);
  assert.deepEqual(cols.map((c) => c[1]({ v: '', t })), ['', '', '']);
  assert.equal(cols[2][1]({ v: 0, t }), '2026-09-01', 'a real zero still converts');
  assert.deepEqual(USD.cols((r) => r.v, (r) => r.t, 'X'), [], 'none in USD');
});

// ---------- Meridian Predict on real wallets ----------
const FIXTURES = { buyer: 'predict-0xba3b-buyer.json', trader: 'predict-0xc1ce-trader.json', traded: 'predict-0xaca4-traded.json', maker: 'predict-0xea41-maker.json' };
const prepOf = (key) => {
  const f = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/tax', FIXTURES[key]), 'utf8'));
  return PR.prepare({ norms: f.predictions.map(P.unslim), trades: f.trades || [], rd: f.rd, rows: f.rows, rowsFmt: f.rowsFmt, truncated: !!f.truncated, total: f.total, newest: f.newest, addr: f.address, builtAt: f.builtAt });
};
const ctxOf = (prep, mode, per, money) => {
  const F = PR.figures(PR.book(prep, mode), PR.tail(prep, mode, per), per, money, per.tz);
  const cov = PR.coverageNote(prep);
  return { prep, fig: F, mode, period: per, tz: per.tz, money, fname, notes: { totals: cov && cov.blocking ? cov.text : null, file: PR.fileNote(prep) } };
};
/** the files' realized figures read from their CSV cells, as a spreadsheet would: [USD, report currency] */
const fromCsv = (c) => {
  const rec = EX.build('predict-record', c), sec = EX.offered('predict', c).some((d) => d.id === 'predict-secondary') ? EX.build('predict-secondary', c) : null;
  const at = { claim: 'Net at the claim', claimable: 'Net at the decision', verdict: 'Net at the source resolution' }[c.mode];
  const counted = rec.rows.map(col(rec, 'Net in this period\'s realized PnL'));
  const sum = (f, name, keep) => (f ? f.rows.reduce((a, r, i) => { const v = col(f, name)(r); return a + (keep(i) && v !== '' ? Number(v) : 0); }, 0) : 0);
  const C = c.money.rates ? ' ' + c.money.ccy : null;
  return {
    usd: sum(rec, 'Net USD (± PnL × share held)', (i) => counted[i] === 'yes') + sum(sec, 'Realized PnL USD', () => true),
    ccy: C ? sum(rec, at + C, (i) => counted[i] === 'yes') + sum(sec, 'Realized PnL' + C, () => true) : null,
    n: rec.rows.length + (sec ? sec.rows.length : 0),
  };
};
const PERIODS = [['2026-01-01', '2026-12-31', 'UTC'], ['2026-04-06', '2027-04-05', 'Europe/London'], ['2026-07-01', '2027-06-30', 'Australia/Sydney'], ['2026-07-18', '2026-07-21', 'America/New_York'], ['2026-08-01', '2026-09-30', 'Asia/Kolkata']];

test('real wallets: the record plus the secondary-market file add up to the Realized PnL tile under every basis, in USD and EUR (B09)', () => {
  for (const key of Object.keys(FIXTURES)) {
    const prep = prepOf(key);
    for (const [a, b, tz] of PERIODS) {
      const per = period(a, b, tz), money = eur(tz);
      for (const mode of PR.MODES) {
        const c = ctxOf(prep, mode, per, money), x = fromCsv(c), msg = `${key} ${a}…${b} ${mode}`;
        near(assert, x.usd, c.fig.pnl, Math.max(1, x.n) * 1e-6, msg + ' USD');
        near(assert, x.ccy, c.fig.pnlC, Math.max(1, x.n) * 1e-6, msg + ' EUR');
      }
    }
  }
});

test('real wallets: a pure buyer (0xba3b…) has its whole result itemised in the secondary-market file, its tokens in the decided-not-claimed file, and the words say what it is made of (B26, B28)', () => {
  const prep = prepOf('buyer');
  assert.equal(prep.mine.length, 0, 'no prediction of its own');
  const per = period('2026-01-01', '2026-12-31', 'UTC');
  const c = ctxOf(prep, 'claim', per, USD);
  assert.ok(c.fig.pnl > 700, 'its 2026 result comes from tokens held to the verdict: ' + c.fig.pnl);
  const sec = EX.build('predict-secondary', c);
  const kinds = new Set(sec.rows.map((r) => r.kind));
  assert.deepEqual(Array.from(kinds).sort(), ['bought', 'held to verdict']);
  near(assert, sec.rows.reduce((a, r) => a + (r.pnl || 0), 0), c.fig.pnl, 1e-6);
  assert.deepEqual(PR.madeOf(PR.book(prep, 'claim'), prep, 'claim', per), ['bought position tokens redeemed']);
  assert.ok(PR.openStakes(prep) > 0, 'its open bought tokens count at cost in Open stakes now');
  // its tokens decided and not redeemed: the tail, itemised, the same rows under every basis
  assert.ok(c.fig.tail.n > 0);
  const offered = EX.offered('predict', c).map((d) => d.id);
  assert.deepEqual(offered, ['predict-daily', 'predict-record', 'predict-secondary', 'predict-unclaimed', 'predict-koinly', 'predict-cointracking'], "the site's reports, then the tax tools' files (B16)");
  const un = EX.build('predict-unclaimed', c);
  assert.equal(un.rows.length, c.fig.tail.n); near(assert, un.rows.reduce((a, r) => a + r.pnl, 0), c.fig.tail.pnl, 1e-9);
  assert.equal(EX.text(EX.get('predict-unclaimed').label, c), 'Predict decided, not claimed');
  const cv = ctxOf(prep, 'claimable', per, USD);
  assert.equal(EX.text(EX.get('predict-unclaimed').label, cv), 'Predict booked, not yet claimed');
  // the daily ledger ends at the tile
  const d = EX.build('predict-daily', c);
  assert.equal(col(d, 'Cumulative PnL in period USD')(d.rows[d.rows.length - 1]), T.n6(c.fig.pnl));
});

test('real wallets: a maker (0xea41…) is in the record from its own side, and the files say nothing is missing; a period with no tail offers no tail file', () => {
  const prep = prepOf('maker');
  const per = period('2026-01-01', '2026-12-31', 'UTC');
  const c = ctxOf(prep, 'claim', per, USD);
  const rec = EX.build('predict-record', c);
  assert.deepEqual(rec.warnings, []); assert.equal(EX.fileName(rec), 'predict-record.csv');
  const sides = new Set(rec.rows.map(col(rec, 'Side')));
  assert.ok(sides.has('market maker'));
  for (const r of rec.rows) assert.ok(['open', 'decided, not claimed', 'claimed', 'sold'].includes(r.status), r.status);
  if (!c.fig.tail.n) assert.equal(EX.offered('predict', c).some((d) => d.id === 'predict-unclaimed'), false);
  // the Predict files are site reports (their methodology rows go first), except the two tax-tool files (B16)
  for (const d of EX.list('predict')) assert.equal(d.kind, /-(koinly|cointracking)$/.test(d.id) ? 'tool' : 'report', d.id);
  // the button texts use the tax center's words
  for (const d of EX.list('predict')) for (const m of PR.MODES) {
    const cm = ctxOf(prep, m, per, USD);
    assert.equal(/\bsettled\b(?! on Meridian)/i.test(EX.text(d.label, cm) + ' ' + EX.text(d.sub, cm)), false, d.id + ' ' + m);
  }
});

test('real wallets: the record\'s status at the period end never contradicts its Booked date on the claim basis (0xc1ce…: traded wins booked at another wallet\'s claim)', () => {
  const done = ['claimed', 'tokens redeemed', 'decided, redemption not confirmed'];
  for (const key of Object.keys(FIXTURES)) {
    const prep = prepOf(key);
    for (const [a, b, tz] of PERIODS) {
      const per = period(a, b, tz), rec = EX.build('predict-record', ctxOf(prep, 'claim', per, USD));
      for (const r of rec.rows) {
        if (r.status === 'open' || r.status === 'sold') continue;
        assert.equal(r.booked != null && r.booked < per.end, done.includes(r.status), `${key} ${a} ${r.n.id}: ${r.status}, booked ${r.booked}`);
      }
    }
  }
  // 0xc1ce… has no redemption times in its file: its traded wins are booked at the latest claim on their pick configuration
  const c = ctxOf(prepOf('trader'), 'claim', period('2026-01-01', '2026-12-31', 'UTC'), USD), rec = EX.build('predict-record', c);
  const traded = rec.rows.filter((r) => r.x.traded && r.res === 'won');
  assert.ok(traded.length >= 1);
  for (const r of traded) assert.equal(col(rec, 'Status at period end')(r), 'decided, redemption not confirmed', r.n.id);
});

test('a truncated file without its rows: the Predict files carry the completeness note and -INCOMPLETE', () => {
  const prep = prepOf('maker');
  prep.coverage = Object.assign({}, prep.coverage, { truncated: true, rows: false, total: 900, newest: 600 });
  const c = ctxOf(prep, 'claim', period('2026-01-01', '2026-12-31', 'UTC'), USD);
  for (const id of ['predict-daily', 'predict-record']) {
    const f = EX.build(id, c);
    assert.equal(f.warnings.length, 1, id); assert.match(EX.fileName(f), /-INCOMPLETE\.csv$/);
    assert.ok(EX.render(f, [['Completeness', f.warnings[0]]]).startsWith('Completeness,'), id);
  }
});

// ---------- perps: tax-tool imports per event (B14, B15), Form 8949 (G05), report-currency columns (B18) ----------
const U = MD.util, F = T.fills;
const LATER = Date.UTC(2030, 0, 1);
const TR = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/tax/transfers-0x2f46.json'), 'utf8'));
const TRANSFERS = TR.transfers.rows.map((r) => Object.fromEntries(TR.transfers.cols.map((c, i) => [c, r[i]])));
/** the files' context for a fixture and a UTC period (transfers: the real ones of 0x2f46, or none) */
const perpsCtx = (name, from, to, o = {}) => {
  const d = perps(name), per = T.periods.resolve({ from, to, tz: o.tz || 'UTC' }, { now: LATER }), money = o.money || USD;
  const ev = events(MD, d, per.start, per.end);
  if (o.transfers) ev.transfers = TRANSFERS.filter((t) => t.createdAt >= per.start && t.createdAt < per.end);
  const led = ledger(MD, d, per, money.fx);
  const D = F.disposals(ev, { ledger: led, period: per, ref: d.ref, tz: per.tz, fx: money.fx });
  return { d, period: per, tz: per.tz, money, fname: (k) => 'meridian-' + k + '.csv', ev, D, ref: d.ref, led, closed: [], now: LATER };
};
const KOINLY_HEADER = 'Date,Sent Amount,Sent Currency,Received Amount,Received Currency,Fee Amount,Fee Currency,Net Worth Amount,Net Worth Currency,Tag,Description,TxHash';
const CT_HEADER = 'Type,Buy Amount,Buy Cur.,Sell Amount,Sell Cur.,Fee,Fee Cur.,Exchange,Trade-Group,Comment,Date';
const num = (v) => (v === '' ? 0 : Number(v));

test('Koinly and CoinTracking: their exact headers first, one row per event in UTC oldest first, adding up to the exchange\'s ledger (B14, B15)', () => {
  const c = perpsCtx('perps-0x2f46-to-2026-10-01.json', '2026-09-01', '2026-09-30', { transfers: true });
  const LT = c.led.totals;
  const k = EX.build('perps-koinly', c), ct = EX.build('perps-cointracking', c);
  assert.equal(k.kind, 'tool'); assert.equal(ct.kind, 'tool');
  assert.deepEqual(k.warnings, [], 'every UTC day reconciles: no daily rows'); assert.equal(EX.fileName(k), 'meridian-koinly.csv');
  const kc = EX.render(k, [['Report', 'methodology rows never go in a tool file']]).split('\r\n'), cc = EX.render(ct, [['Report', 'x']]).split('\r\n');
  assert.equal(kc[0], KOINLY_HEADER, 'Koinly reads its first row as the header (support.koinly.io 9489976)'); assert.equal(EX.KOINLY.join(','), KOINLY_HEADER);
  assert.equal(cc[0], CT_HEADER); assert.equal(EX.COINTRACKING.join(','), CT_HEADER);
  // dates: UTC to the second, oldest first; a deposit before the results of the same instant
  const col = (f, name) => f.columns.findIndex((x) => x[0] === name);
  const rows = k.rows, dates = rows.map((r) => r.date);
  assert.ok(dates.every((x) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(x)), 'YYYY-MM-DD HH:mm:ss');
  assert.deepEqual(dates.slice().sort(), dates, 'oldest first');
  assert.equal(col(k, 'Tag'), 9);
  // tags (9490023, 9490027): realized gain per disposal fill with its closing fee, futures fee, funding fee; transfers untagged
  const by = (tag) => rows.filter((r) => r.tag === tag);
  assert.deepEqual(Array.from(new Set(rows.map((r) => r.tag))).sort(), ['', 'funding fee', 'futures fee', 'realized gain']);
  // one row per disposal fill, except fills of one order in the same second with the same amount and fee (8 of them on
  // 21 Sep 2026 20:36:41): Koinly would skip all but one as exact duplicates, so they are one row with the amounts added
  const disp = c.D.inP.filter((r) => Math.abs(r.gross) >= 5e-7);
  assert.equal(by('realized gain').length, new Set(disp.map((r) => EX.utcStamp(r.t) + '|' + T.n6(r.gross) + '|' + T.n6(r.closeFee))).size);
  assert.ok(by('realized gain').length < disp.length);
  const merged = by('realized gain').find((r) => r.merged === 8);
  assert.ok(merged && merged.date === '2026-09-21 20:36:41' && /fill 14 \(and 7 more of the same second and amount added into this row/.test(merged.what), merged && merged.what);
  near(assert, merged.sent, 8 * 97.512315, 1e-5);
  near(assert, U.sum(by('realized gain'), (r) => r.received - r.sent), LT.realized, 1e-5, 'realized gains and losses: the ledger\'s realized PnL');
  near(assert, U.sum(by('realized gain'), (r) => r.fee) + U.sum(by('futures fee'), (r) => r.sent - r.received), LT.fees + LT.pfees, 1e-5, 'closing fees, other fill fees and position fees');
  near(assert, U.sum(by('funding fee'), (r) => r.received - r.sent), LT.funding, 1e-5, 'funding per settlement');
  near(assert, U.sum(by(''), (r) => r.received - r.sent - r.fee), LT.deposits - LT.withdrawals, 1e-6, 'deposits and withdrawals');
  assert.ok(by('realized gain').some((r) => r.received > 0) && by('realized gain').some((r) => r.sent > 0), 'gains and losses kept apart, never netted');
  // transfers per event: three deposits on 10 Sep 2026 are three rows; a withdrawal has its fee and the paying tx, a deposit none
  const sep10 = by('').filter((r) => r.date.startsWith('2026-09-10'));
  assert.deepEqual(sep10.map((r) => [r.date, r.received, r.sent, r.fee]), [['2026-09-10 13:01:12', 10, 0, 0], ['2026-09-10 13:03:13', 10, 0, 0], ['2026-09-10 13:03:19', 0, 9, 1], ['2026-09-10 13:05:56', 100000, 0, 0]]);
  assert.match(sep10[2].tx, /^0x[0-9a-f]{64}$/); assert.equal(sep10[0].tx, '', 'a deposit carries no hash (its finalized tx is the relayer\'s)');
  // CoinTracking: the same events, its types and the Funding Rate group
  const types = new Set(ct.rows.map((r) => r.type));
  for (const t of ['Derivatives / Futures Profit', 'Derivatives / Futures Loss', 'Margin Fee', 'Other Income', 'Other Fee', 'Deposit', 'Withdrawal']) assert.ok(types.has(t), t);
  assert.ok(!types.has('Derivatives / Futures Fee'), 'not a CoinTracking type');
  assert.ok(ct.rows.filter((r) => r.type === 'Other Income' || r.type === 'Other Fee').every((r) => r.group === 'Funding Rate'), 'funding in group Funding Rate');
  near(assert, U.sum(ct.rows, (r) => r.buy - r.sell - r.fee), LT.net + LT.deposits - LT.withdrawals, 1e-5, 'CoinTracking adds up to the balance change');
  near(assert, U.sum(rows, (r) => r.received - r.sent - r.fee), LT.net + LT.deposits - LT.withdrawals, 1e-5, 'Koinly adds up to the balance change');
  // the CSV cells read back to the same totals (as a spreadsheet would)
  const cells = kc.slice(1).map((l) => l.split(','));
  near(assert, U.sum(cells, (x) => num(x[3]) - num(x[1]) - num(x[5])), LT.net + LT.deposits - LT.withdrawals, 1e-3);
  assert.ok(cells.every((x) => (x[1] === '' || x[2] === 'USDe') && (x[3] === '' || x[4] === 'USDe')), 'USDe');
  // the button says what a file holds and, once the detail is in, which days are daily rows
  assert.match(EX.text(EX.get('perps-koinly').sub, c), /^Perps: one row per disposal fill/);
  assert.match(EX.text(EX.get('perps-koinly').label, c), /^Perps: Koinly/);
});

test('a UTC day whose detail does not add up, and every day without the detail: that day\'s ledger total at 10:00 UTC, the file marked (B14)', () => {
  // the 0x8ddb… fixture has no transfer list: its deposit days fall back to the ledger's totals
  const c = perpsCtx('perps-0x8ddb-xau-position-fees.json', '2026-09-01', '2026-10-02');
  const x = EX.perpsTool(c), LT = c.led.totals;
  assert.ok(x.fallback.transfer.length > 0 && !x.fallback.trade.length && !x.fallback.funding.length);
  for (const e of x.events.filter((y) => y.daily)) assert.equal(EX.utcStamp(e.t).slice(11), '10:00:00');
  assert.match(x.warnings.join(' '), /UTC day\(s\) of deposits and withdrawals as one daily total stamped 10:00 UTC/);
  const k = EX.build('perps-koinly', c);
  assert.match(EX.fileName(k), /-INCOMPLETE\.csv$/);
  near(assert, U.sum(k.rows, (r) => r.received - r.sent - r.fee), LT.net + LT.deposits - LT.withdrawals, 1e-5, 'the totals still add up');
  // without the trade detail: one row per kind per UTC day, all at 10:00 UTC
  const nd = EX.perpsTool(Object.assign({}, c, { D: null })), kn = EX.koinlyRows(nd.events);
  assert.ok(kn.every((r) => r.date.endsWith(' 10:00:00')));
  near(assert, U.sum(kn, (r) => r.received - r.sent - r.fee), LT.net + LT.deposits - LT.withdrawals, 1e-5);
  assert.match(nd.warnings[0], /^the trade detail did not load: every UTC day/);
  assert.match(EX.text(EX.get('perps-koinly').sub, Object.assign({}, c, { D: null })), /every UTC day is one row per kind of its total, stamped 10:00 UTC/);
  // 10:00 UTC keeps the UTC date from UTC−10 to UTC+13: New Zealand's 31 March stays in its tax year
  const seg = { day: Date.UTC(2027, 2, 31), t0: Date.UTC(2027, 2, 31), t1: Date.UTC(2027, 3, 1) };
  const t = EX.dailyAt(seg, { start: 0, end: Infinity });
  assert.equal(T.tz.dayKey(t, 'Pacific/Auckland'), '2027-03-31'); assert.equal(T.tz.dayKey(t, 'Pacific/Honolulu'), '2027-03-31');
  // inside a part of a split day, and inside the period
  assert.equal(EX.dailyAt({ day: Date.UTC(2026, 3, 5), t0: Date.UTC(2026, 3, 5, 23), t1: Date.UTC(2026, 3, 6) }, { start: Date.UTC(2026, 3, 5, 23), end: Infinity }), Date.UTC(2026, 3, 5, 23));
  assert.equal(EX.dailyAt({ day: Date.UTC(2026, 3, 5), t0: Date.UTC(2026, 3, 5), t1: Date.UTC(2026, 3, 5, 6) }, null), Date.UTC(2026, 3, 5, 5, 59, 59));
});

test('a deposit in the half hour after an India period ends: the ledger counts it in the period\'s last hour, the file leaves it out, no day falls back', () => {
  const P = T.periods.resolve({ from: '2026-09-15', to: '2026-09-27', tz: 'Asia/Kolkata' }, { now: Date.UTC(2030, 0, 1) });
  const day = Date.UTC(2026, 8, 27), seg = (t0, t1, deposit) => ({ t0, t1, day: Math.floor(t0 / DAY) * DAY, part: t1 - t0 < DAY ? 'part' : null, realizedPnl: 0, fee: 0, pfees: 0, funding: 0, deposit, withdrawal: 0, wfee: 0 });
  // 20 Sep: a deposit of 10; 27 Sep up to 18:30Z, whose last hour (18:00–19:00) holds a deposit of 20 at 18:40Z
  const segs = [seg(Date.UTC(2026, 8, 20), Date.UTC(2026, 8, 21), 10), seg(day, P.end, 20)];
  const tr = (id, t, amount) => ({ id, createdAt: t, type: 'DEPOSIT', amount: String(amount), fee: '0', status: 'COMPLETED' });
  const t1 = tr('t1', Date.UTC(2026, 8, 20, 12), 10), t2 = tr('t2', Date.UTC(2026, 8, 27, 18, 40), 20);
  const D = { rows: [], byPos: new Map(), unassigned: [], failed: [], day: { bad: [] }, funding: { fig: { bySeg: segs.map(() => ({ fallback: false })) }, inP: [] }, fees: { inP: [], bad: [] } };
  const c = { period: P, led: { segments: segs }, D, ref: {}, ev: { positions: [], transfers: [t1], hourTransfers: [t1, t2], truncated: {} } };
  const x = EX.perpsTool(c);
  assert.deepEqual(x.fallback.transfer, [], 'the end\'s last hour holds the deposit the ledger counts there');
  assert.deepEqual(x.events.map((e) => [e.kind, e.amount]), [['deposit', 10]], 'only the period\'s own deposit goes out, by its exact instant');
  assert.deepEqual(x.warnings, []);
  // read only to the exact end (the loader before it read the end's hour), the day fell back to its ledger total
  const old = EX.perpsTool(Object.assign({}, c, { ev: { positions: [], transfers: [t1], truncated: {} } }));
  assert.equal(old.fallback.transfer.length, 1);
});

test('a tool skips exact duplicates, so two equal rows of one second are merged, amounts added; fee rebates and position-fee credits keep their sign', () => {
  const t = Date.UTC(2026, 8, 20, 12, 0, 0, 250);
  const ev = [{ t, kind: 'predict', amount: 5, fee: 0, tx: '0xabc', what: 'a' }, { t: t + 500, kind: 'predict', amount: 5, fee: 0, tx: '0xabc', what: 'b' }, { t, kind: 'pnl', amount: -3, fee: -0.1, tx: '', what: 'Meridian perps: c' }, { t, kind: 'posfee', amount: 0.2, fee: 0, tx: '', what: 'd' }];
  const k = EX.koinlyRows(ev);
  assert.equal(k.length, 4, 'the two predict rows of the same second, amount and hash are one');
  assert.equal(k[0].received, 10); assert.match(k[0].what, /^a \(and 1 more of the same second/);
  assert.deepEqual(k.slice(1).map((r) => [r.tag, r.sent, r.received, r.fee]), [['realized gain', 3, 0, 0], ['futures fee', 0, 0.1, 0], ['futures fee', 0, 0.2, 0]]);
  const ct = EX.ctRows(ev);
  assert.deepEqual(ct.map((r) => r.type), ['Derivatives / Futures Profit', 'Derivatives / Futures Loss', 'Other Income', 'Other Income']);
  assert.equal(ct[0].buy, 10); assert.equal(ct[0].group, 'Predict');
});

test('Meridian Predict tax-tool files: one row per result booked under the card\'s basis, adding up to the Realized PnL tile (B16)', () => {
  for (const key of Object.keys(FIXTURES)) {
    const prep = prepOf(key);
    for (const [a, b, tz] of PERIODS) {
      const per = period(a, b, tz);
      for (const mode of PR.MODES) {
        const c = ctxOf(prep, mode, per, USD);
        const k = EX.build('predict-koinly', c), ct = EX.build('predict-cointracking', c);
        const msg = `${key} ${a} ${mode}`;
        near(assert, U.sum(k.rows, (r) => r.received - r.sent), c.fig.pnl, Math.max(1, k.rows.length) * 1e-6, msg);
        near(assert, U.sum(ct.rows, (r) => r.buy - r.sell), c.fig.pnl, Math.max(1, ct.rows.length) * 1e-6, msg + ' CoinTracking');
        assert.ok(k.rows.every((r) => r.tag === 'realized gain' && /^Meridian Predict: /.test(r.what)), msg);
        assert.ok(ct.rows.every((r) => r.group === 'Predict' && /^Derivatives \/ Futures (Profit|Loss)$/.test(r.type)), msg);
        assert.deepEqual(k.rows.map((r) => r.t), k.rows.map((r) => r.t).slice().sort((x, y) => x - y), 'oldest first');
        assert.equal(EX.render(k).split('\r\n')[0], KOINLY_HEADER); assert.equal(EX.render(ct).split('\r\n')[0], CT_HEADER);
        assert.equal(k.name, 'predict-koinly' + (mode === 'claim' ? '' : '-' + mode) + '.csv');
      }
    }
  }
  // a win this wallet claimed carries its claim transaction
  const c = ctxOf(prepOf('maker'), 'claim', period('2026-01-01', '2026-12-31', 'UTC'), USD);
  const won = EX.predictToolEvents(c).filter((e) => / won as market maker/.test(e.what));
  assert.ok(won.length && won.some((e) => /^0x[0-9a-f]{64}$/.test(e.tx)));
});

test('Form 8949 statement: (a) to (h) in order, MM/DD/YYYY, Part I and II by the anniversary rule, both boxes, totals that are the rows\' sums, a check against the ledger (G05)', () => {
  const c = perpsCtx('perps-0x2f46-to-2026-10-01.json', '2026-09-01', '2026-09-30', { money: eur() });
  const f = EX.build('perps-8949', c);
  assert.equal(f.kind, 'report'); assert.equal(f.label, 'Form 8949 statement'); assert.equal(EX.fileName(f), 'meridian-form-8949-statement.csv');
  const [st, tot, sum, chk] = f.sections;
  const head = st.columns.map((x) => x[0]);
  assert.deepEqual(head.slice(0, 13), ['Part', 'Box if a digital asset (no Form 1099-DA)', 'Box if not a digital asset (no Form 1099-B)', '(a) Description of property', '(b) Date acquired (UTC)', '(c) Date sold or disposed of (UTC)', '(d) Proceeds USD', '(e) Cost or other basis USD', '(f) Code(s)', '(g) Amount of adjustment', '(h) Gain or (loss) USD',
    'Funding and position fees inside the result USD (that reading: settled since the position opened, by quantity closed)', '(h) Gain or (loss) USD, funding and position fees inside']);
  assert.deepEqual(head.slice(13, 19), ['(d) Proceeds EUR', '(e) Cost or other basis EUR', '(h) Gain or (loss) EUR', '(h) Gain or (loss), funding and position fees inside EUR', 'USD→EUR rate', 'Rate date (ECB)'], 'B18: the report currency, the disposal date\'s rate beside it');
  assert.equal(st.rows.length, c.D.inP.length);
  const cell = (r, name) => st.columns.find((x) => x[0] === name)[1](r);
  for (const r of st.rows) {
    assert.match(cell(r, '(c) Date sold or disposed of (UTC)'), /^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/2026$/);
    assert.match(cell(r, '(b) Date acquired (UTC)'), /^((0[1-9]|1[0-2])\/\d{2}\/2026|VARIOUS)$/);
    assert.match(cell(r, '(a) Description of property'), /^[\d.]+ [A-Z]+-USD perpetual (long|short) · position [0-9a-f-]{36} · fill \d+$/);
    assert.equal(cell(r, '(f) Code(s)'), ''); assert.equal(cell(r, '(g) Amount of adjustment'), '');
    near(assert, Number(cell(r, '(d) Proceeds USD')) - Number(cell(r, '(e) Cost or other basis USD')), Number(cell(r, '(h) Gain or (loss) USD')), 2e-6);
    // each part at its own date (the opening-fee share and the carried funding at the dates paid): (d) − (e) = (h) in EUR too
    near(assert, Number(cell(r, '(d) Proceeds EUR')) - Number(cell(r, '(e) Cost or other basis EUR')), Number(cell(r, '(h) Gain or (loss) EUR')), 2e-6);
    assert.equal(cell(r, '(h) Gain or (loss) EUR'), T.n6(r.r.netC)); assert.equal(cell(r, '(h) Gain or (loss), funding and position fees inside EUR'), T.n6(r.r.netAllC));
  }
  // September 2026: everything held under a year
  assert.ok(st.rows.every((x) => x.part === 'I' && cell(x, 'Box if a digital asset (no Form 1099-DA)') === 'I' && cell(x, 'Box if not a digital asset (no Form 1099-B)') === 'C'));
  // totals: the rows' sums, per Part and reading
  const sep = tot.rows.find((x) => x.part === 'I' && !x.inside), ins = tot.rows.find((x) => x.part === 'I' && x.inside);
  near(assert, sep.h, U.sum(st.rows, (x) => x.h), 1e-9); near(assert, sep.d, U.sum(st.rows, (x) => x.d), 1e-9); near(assert, sep.e, U.sum(st.rows, (x) => x.e), 1e-9);
  near(assert, ins.h, U.sum(st.rows, (x) => x.hIn), 1e-9); near(assert, ins.d - ins.e, ins.h, 1e-6, 'inside: funding received in (d), paid and position fees in (e)');
  near(assert, sep.hC, U.sum(st.rows, (x) => x.r.netC), 1e-6); near(assert, ins.hC, U.sum(st.rows, (x) => x.r.netAllC), 1e-6); near(assert, ins.dC - ins.eC, ins.hC, 1e-6);
  assert.ok(f.extra.some(([k, v]) => k === 'Form 8949 in EUR' && /opening-fee share .* convert at the dates they were paid/.test(v)), 'the file says how its EUR columns are converted');
  assert.equal(tot.columns[0][1](sep), 'Schedule D line 3 (box C or I)');
  assert.equal(sum.columns.find((x) => x[0] === '(f) Code(s)')[1](sep), 'M'); assert.equal(sum.columns.find((x) => x[0] === '(a) Description of property')[1](sep), 'Meridian perpetuals – see attached statement');
  // the check: Σ(h) is the ledger's realized PnL − trading fees, item by item
  const diff = chk.rows.find((x) => x[0] === 'Difference');
  assert.equal(diff[1], 0); near(assert, f.check.sumH, f.check.expected, 1e-6);
  assert.ok(f.check.openEnd > 0, 'opening fees on positions still open at the end are named');
  // as a report: its methodology first, the Form 8949 notes among it
  const csv = EX.render(f, T.methodology.csvRows([['Report', 'x'], ['Data sources', 'y']], f.label, { extra: f.extra, warnings: f.warnings })).split('\r\n');
  assert.equal(csv[0], 'Report,Form 8949 statement'); assert.ok(csv[1].startsWith('Form 8949,')); assert.ok(csv[2].startsWith('Form 8949 in EUR,')); assert.equal(csv[4], ''); assert.equal(csv[5], 'Form 8949 statement: one row per disposal');
});

test('Form 8949: a disposal after the anniversary is Part II (boxes F and L), one on it Part I; totals per Part', () => {
  const pos = (id, opened, closed, productId = 'btc') => ({ id, productId, side: '0', size: '0', createdAt: opened, updatedAt: closed, totalIncreaseQuantity: '1', totalDecreaseQuantity: '1', totalIncreaseNotional: '100', realizedPnl: '10', isLiquidated: false });
  const fl = (id, t, side, price, productId = 'btc') => ({ id, productId, createdAt: t, side, filled: '1', price: String(price), feeUsd: '0.1', type: 'LIMIT' });
  const ref = { byId: { btc: { id: 'btc', displayTicker: 'BTC-USD', baseTokenName: 'BTC' }, eth: { id: 'eth', displayTicker: 'ETH-USD', baseTokenName: 'ETH' } } };
  const a0 = Date.UTC(2026, 9, 1, 8), A = pos('A', a0, Date.UTC(2027, 9, 1, 9)), B = pos('B', a0 + 1000, Date.UTC(2027, 9, 2, 9), 'eth');
  const fills = [fl('a1', a0, '0', 100), fl('b1', a0 + 1000, '0', 100, 'eth'), fl('a2', Date.UTC(2027, 9, 1, 9), '1', 110), fl('b2', Date.UTC(2027, 9, 2, 9), '1', 110, 'eth')];
  const per = T.periods.resolve({ from: '2027-01-01', to: '2027-12-31', tz: 'UTC' }, { now: LATER });
  const led = T.ledger.build({ balance: [], volume: [], ref, period: per });
  const ev = { positions: [A, B], touched: [A, B], from: a0, to: per.end, fills, transfers: [], posFills: new Map(), charges: [], pre: [], resFrom: 0, pfHours: new Map(), truncated: { positions: false, fills: false, transfers: false, charges: false, posFills: [] }, failed: [] };
  const D = F.disposals(ev, { ledger: led, period: per, ref, tz: 'UTC' });
  const f = EX.form8949({ period: per, tz: 'UTC', money: USD, fname: (k) => k + '.csv', ev, D, led });
  const st = f.sections[0], cell = (r, n) => st.columns.find((x) => x[0] === n)[1](r);
  assert.deepEqual(st.rows.map((r) => [cell(r, '(b) Date acquired (UTC)'), cell(r, '(c) Date sold or disposed of (UTC)'), cell(r, 'Part'), cell(r, 'Box if a digital asset (no Form 1099-DA)'), cell(r, 'Box if not a digital asset (no Form 1099-B)')]),
    [['10/01/2026', '10/01/2027', 'I (short-term)', 'I', 'C'], ['10/01/2026', '10/02/2027', 'II (long-term)', 'L', 'F']], 'sold on the anniversary: short-term; the day after: long-term (Tax Topic 409)');
  const tot = f.sections[1].rows;
  assert.deepEqual(tot.map((x) => [x.part, x.inside, x.n]), [['I', false, 1], ['I', true, 1], ['II', false, 1], ['II', true, 1]]);
  near(assert, tot[2].h, 10 - 0.2, 1e-9); assert.equal(f.sections[1].columns[0][1](tot[2]), 'Schedule D line 10 (box F or L)');
});

test('Form 8949: labelled as one reading (no IRS guidance on perps), Part by Rev. Rul. 66-7 at a month\'s end while Disposals keep the anniversary flag, Part II only from the last increase', () => {
  const ref = { byId: { btc: { id: 'btc', displayTicker: 'BTC-USD', baseTokenName: 'BTC' } } };
  // opened 28 Feb 2027 (February's last day; 2028 a leap year), reduced on 29 Feb 2028 and closed on 1 Mar 2028
  const t0 = Date.UTC(2027, 1, 28, 10), t1 = Date.UTC(2028, 1, 29, 10), t2 = Date.UTC(2028, 2, 1, 10);
  const A = { id: 'A', productId: 'btc', side: '0', size: '0', createdAt: t0, updatedAt: t2, totalIncreaseQuantity: '2', totalDecreaseQuantity: '2', totalIncreaseNotional: '200', realizedPnl: '30', isLiquidated: false };
  const fl = (id, t, side, qty, price) => ({ id, productId: 'btc', createdAt: t, side, filled: String(qty), price: String(price), feeUsd: '0.1', type: 'LIMIT' });
  const per = T.periods.resolve({ from: '2028-01-01', to: '2028-12-31', tz: 'UTC' }, { now: LATER });
  const led = T.ledger.build({ balance: [], volume: [], ref, period: per });
  const ev = { positions: [A], touched: [A], from: t0, to: per.end, fills: [fl('a1', t0, '0', 2, 100), fl('a2', t1, '1', 1, 110), fl('a3', t2, '1', 1, 120)], transfers: [], posFills: new Map(), charges: [], pre: [], resFrom: 0, pfHours: new Map(), truncated: { positions: false, fills: false, transfers: false, charges: false, posFills: [] }, failed: [] };
  const D = F.disposals(ev, { ledger: led, period: per, ref, tz: 'UTC' });
  const c = { period: per, tz: 'UTC', money: USD, fname: (k) => k + '.csv', ev, D, led };
  const f = EX.build('perps-8949', c), st = f.sections[0], cell = (r, n) => st.columns.find((x) => x[0] === n)[1](r);
  assert.deepEqual(st.rows.map((r) => [cell(r, '(c) Date sold or disposed of (UTC)'), cell(r, 'Part')]), [['02/29/2028', 'I (short-term)'], ['03/01/2028', 'II (long-term)']], 'held over a year from 1 Mar 2028 only');
  const disp = EX.build('perps-disposals', c);
  assert.deepEqual(disp.rows.map((r) => col(disp, 'Held over a year (calendar dates, UTC)')(r)), ['yes', 'yes'], 'the Disposals file keeps the anniversary rule');
  // the reading, on the button, in the file's methodology row, and in the README row; the convention said in the file
  const READING = /for the reading that reports each perp disposal as a capital gain or loss on Form 8949 and Schedule D; the IRS has issued no guidance on perpetual futures, and other readings \(a swap \/ notional principal contract, a trader's mark-to-market election\) report them elsewhere/;
  const row = f.extra.find(([k]) => k === 'Form 8949')[1];
  assert.match(row, READING); assert.match(row, /Rev\. Rul\. 66-7/);
  assert.match(row, /Part II only when the last increase the disposal is averaged over is more than a year old/);
  assert.match(EX.text(EX.get('perps-8949').sub, c), /^For the reading that reports each perp disposal as a capital gain or loss on Form 8949 and Schedule D; the IRS has issued no guidance on perpetual futures/);
  assert.match(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), /\| Form 8949 statement \| report \| disposal \| for the reading that reports each perp disposal as a capital gain or loss on Form 8949 and Schedule D \(the IRS has issued no guidance on perpetual futures, and other readings, a swap \/ notional principal contract or a trader's mark-to-market election, report them elsewhere\)/);
});

test('closed positions say in their own methodology that a row is a whole-life result, not the period\'s figure (B01)', () => {
  const f = EX.build('perps-closed', { period: period('2026-01-01', '2026-12-31', 'UTC'), tz: 'UTC', money: USD, fname, D: null, closed: [] });
  assert.deepEqual(f.extra, [EX.CLOSED_ROW]);
  assert.equal(EX.CLOSED_ROW[0], 'Closed positions');
  assert.match(EX.CLOSED_ROW[1], /whole-life result dated at the final close: its PnL, fees and funding include those booked on earlier partial closes, before the period too, so a row is not the period's figure; the period's disposals are in the Disposals and Form 8949 files/);
  // it travels with the file: the methodology rows that start it
  const csv = EX.render(f, T.methodology.csvRows([['Report', 'x'], ['Data sources', 'y']], f.label, { extra: f.extra, warnings: f.warnings })).split('\r\n');
  assert.ok(csv[1].startsWith('Closed positions,'), csv[1]);
  assert.match(EX.text(EX.get('perps-closed').sub, { money: USD }), /whole-life result dated at the close \(partial closes before the period included: not the period's figure, which is in Disposals\)/);
});

test('closed positions in another currency: every amount at the close date\'s rate, with the rate and its date; the notional never at the open date (B18)', () => {
  const money = eur();
  const p = { id: 'p1', createdAt: Date.UTC(2026, 6, 1, 10), updatedAt: Date.UTC(2026, 8, 15, 10) };
  const x = { p, t: p.updatedAt, ticker: 'BTC-USD', long: true, size: 1, entry: 100, exit: 110, cost: 100, proceeds: 110, gross: 10, fees: 0.2, pfees: 0, funding: -0.5, net: 9.3, hold: p.updatedAt - p.createdAt, longTerm: false, liq: false, adl: false };
  const f = EX.build('perps-closed', { period: period('2026-01-01', '2026-12-31', 'UTC'), tz: 'UTC', money, fname, D: null, closed: [x] });
  const cols = f.columns.map((c) => c[0]);
  for (const n of ['Entry notional EUR', 'Exit notional EUR', 'Realized PnL EUR', 'Trading fees EUR', 'Position fees EUR', 'Funding EUR', 'Net EUR', 'USD→EUR rate', 'Rate date (ECB)']) assert.ok(cols.includes(n), n);
  const v = (n) => f.columns.find((c) => c[0] === n)[1](x), r = money.rate(p.updatedAt);
  assert.notEqual(r, money.rate(p.createdAt), 'the fixture\'s rate differs between the two dates');
  near(assert, Number(v('Entry notional EUR')), 100 * r, 1e-6); near(assert, Number(v('Net EUR')), 9.3 * r, 1e-6);
  assert.equal(v('Rate date (ECB)'), '2026-09-15');
  near(assert, Number(v('Exit notional EUR')) - Number(v('Entry notional EUR')), Number(v('Realized PnL EUR')), 1e-6, 'no FX result invented on the notional');
  assert.deepEqual(f.warnings, [EX.NO_DETAIL], 'without the trade detail it says what is missing');
  assert.match(EX.text(EX.get('perps-closed').sub, { money }), /at the close date's rate/);
});

test('the exports card says which files carry the report currency and which are per event, per day, per position or period totals (B29)', () => {
  const txt = EX.cardText({ money: eur(), tz: 'Europe/London' });
  assert.match(txt, /Summary, Gains and losses by class, Disposals, Funding settlements, Form 8949 statement, Closed positions and All transactions add EUR beside each amount/);
  assert.match(txt, /Daily ledger adds the net in EUR/);
  assert.match(txt, /Fills \(trades\), Deposits, withdrawals & conversions, Perps: Koinly universal CSV and Perps: CoinTracking CSV have no EUR column/);
  assert.match(txt, /One row per event: Disposals, Funding settlements, Form 8949 statement, All transactions, Fills \(trades\), Deposits, withdrawals & conversions, Perps: Koinly universal CSV and Perps: CoinTracking CSV; per UTC day: Daily ledger; per position: Closed positions; period totals: Summary and Gains and losses by class\./);
  assert.match(txt, /Meridian Predict has its own Koinly and CoinTracking files in the Predict section; import both\./);
  assert.doesNotMatch(txt, /carry every event|daily totals;/, 'no claim the files do not keep');
  const usd = EX.cardText({ money: USD, tz: 'UTC' });
  assert.doesNotMatch(usd, /EUR|beside each amount/); assert.match(usd, /^Amounts in USD \(transfer amounts in token units, the tax-tool files in USDe\)\./);
  const only = EX.cardText({ money: USD, tz: 'UTC', sections: ['summary'] });
  assert.doesNotMatch(only, /Koinly|UTC days/);
});

test('every file of the registry: a report starts with its methodology rows, a tool file with exactly its tool\'s header (G13)', () => {
  const c = perpsCtx('perps-0x2f46-to-2026-10-01.json', '2026-09-01', '2026-09-30', { transfers: true, money: eur() });
  c.events = EX.transactions(c);
  const meth = (f) => T.methodology.csvRows([['Report', 'r'], ['Disclaimer', T.DISCLAIMER], ['Completeness', ''], ['Data sources', 'd']], f.label, { warnings: f.warnings, extra: f.extra });
  const pc = ctxOf(prepOf('trader'), 'claim', period('2026-01-01', '2026-12-31', 'UTC'), eur());
  const sc = { period: c.period, tz: 'UTC', money: c.money, fname, perps: { led: c.led, closed: [], D: c.D, ff: c.D.funding.fig, openAtEnd: 0, openUpnl: null, monthly: c.led.months, quarters: c.led.quarters, closedOverYear: 0 }, D: c.D, hold: [], predict: { prep: pc.prep, mode: 'claim' }, lots: null, warnings: [] };
  let n = 0;
  for (const [section, ctx] of [['summary', sc], ['perps', c], ['predict', pc]]) {
    for (const d of EX.offered(section, ctx)) {
      const f = EX.build(d.id, ctx), first = EX.render(f, meth(f)).split('\r\n')[0];
      if (d.kind === 'tool') assert.ok(first === KOINLY_HEADER || first === CT_HEADER, d.id + ': ' + first);
      else { assert.equal(first, 'Report,' + T.cell(f.label), d.id); assert.ok(EX.render(f, meth(f)).includes('Disclaimer,' + T.cell(T.DISCLAIMER))); }
      n++;
    }
  }
  assert.ok(n >= 17, 'every file: ' + n);
  // the all-transactions file: the cash effects add up to the balance change (a netted funding day never twice)
  const all = EX.build('perps-all', c);
  near(assert, U.sum(all.rows, (e) => e.amount), c.led.closing - c.led.opening, 1e-5);
});

test('a download that is incomplete says so in its name and for about six seconds, in a live region (B41)', () => {
  // a DOM just big enough for U.h, U.toast and the download link
  class El { constructor(tag) { this.tagName = tag; this.attrs = {}; this.cls = new Set(); this.style = {}; this.dataset = {}; this.kids = []; this.textContent = ''; this.classList = { add: (k) => this.cls.add(k), remove: (k) => this.cls.delete(k) }; } setAttribute(k, v) { this.attrs[k] = String(v); } appendChild(x) { this.kids.push(x); return x; } addEventListener() {} click() { clicked.push(this.attrs.download || this.download); } remove() {} }
  const clicked = [], timers = [];
  const saved = { document: globalThis.document, Node: globalThis.Node, setTimeout: globalThis.setTimeout, URL: globalThis.URL };
  globalThis.Node = El; globalThis.document = { createElement: (t) => new El(t), createTextNode: (s) => s, body: new El('body') };
  globalThis.setTimeout = (fn, ms) => { timers.push(ms); return 0; };
  globalThis.URL = Object.assign(Object.create(saved.URL), { createObjectURL: () => 'blob:x', revokeObjectURL() {} });
  try {
    T.ui.download('meridian-fills-0x2f-2026.csv', 'a,b', { warn: ['more order fills than could be read (500 pages)'] });
    const toast = globalThis.document.body.kids.find((k) => k.cls.has('toast'));
    assert.ok(toast, 'a toast');
    assert.equal(toast.attrs.role, 'status'); assert.equal(toast.attrs['aria-live'], 'polite'); assert.equal(toast.attrs['aria-atomic'], 'true');
    assert.equal(toast.textContent, 'more order fills than could be read (500 pages) · Downloaded meridian-fills-0x2f-2026-INCOMPLETE.csv');
    assert.deepEqual(clicked, ['meridian-fills-0x2f-2026-INCOMPLETE.csv']);
    assert.ok(timers.includes(6000), 'shown for about 6 s');
    // a name that already says it is not marked twice; a complete file keeps the short toast
    T.ui.download('x-INCOMPLETE.csv', 'a', { warn: ['w'] }); assert.equal(clicked[1], 'x-INCOMPLETE.csv');
    timers.length = 0; T.ui.download('y.csv', 'a'); assert.equal(toast.textContent, 'Downloaded y.csv'); assert.ok(timers.includes(1600));
  } finally { Object.assign(globalThis, saved); }
});

test('the Disposals file in another currency: the result and notional legs at the disposal date\'s rate, the opening-fee share and the carried funding and fees at the dates paid, the nets built from those parts, said in the file (B2)', () => {
  const c = perpsCtx('perps-0x2f46-to-2026-10-01.json', '2026-09-01', '2026-09-30', { money: eur() });
  const f = EX.build('perps-disposals', c), col = (n) => { const x = f.columns.find((y) => y[0] === n); assert.ok(x, 'no column ' + n); return x[1]; };
  const names = f.columns.map((x) => x[0]).filter((n) => / EUR$/.test(n));
  assert.deepEqual(names, ['Realized PnL (gross) EUR', 'Opening fee share (each at the date paid) EUR', 'Closing fee EUR', 'Net (separate) EUR', 'Funding carried in (each at its settlement date) EUR', 'Position fees carried in (each at its settlement date) EUR', 'Net (inside) EUR', 'Proceeds EUR', 'Cost EUR']);
  let differs = 0;
  for (const r of f.rows) {
    const k = c.money.rate(r.t);
    assert.equal(col('Realized PnL (gross) EUR')(r), T.n6(r.gross * k)); assert.equal(col('USD→EUR rate')(r), T.fx.rateCell(k));
    assert.equal(col('Opening fee share (each at the date paid) EUR')(r), T.n6(r.openFeeC)); assert.equal(col('Net (separate) EUR')(r), T.n6(r.netC)); assert.equal(col('Net (inside) EUR')(r), T.n6(r.netAllC));
    near(assert, Number(col('Proceeds EUR')(r)) - Number(col('Cost EUR')(r)), Number(col('Net (separate) EUR')(r)), 2e-6);
    near(assert, r.grossC - r.openFeeC - r.closeFeeC, r.netC, 1e-9);
    if (Math.abs(r.openFeeC - r.openFee * k) > 1e-6) differs++;
  }
  assert.ok(differs > 0, 'opening fees paid on earlier dates than their disposal convert at those dates');
  assert.deepEqual(f.extra.map((x) => x[0]), ['Disposals in EUR']); assert.equal(f.extra[0][1], EX.DISPOSAL_RATE_TEXT);
  assert.match(EX.text(EX.get('perps-disposals').sub, c), /in EUR the result and the notional legs at the disposal date's rate, the opening-fee share and the funding and position fees carried in at the dates they were paid\.$/);
  assert.deepEqual(EX.build('perps-disposals', perpsCtx('perps-0x2f46-to-2026-10-01.json', '2026-09-01', '2026-09-30')).extra, [], 'nothing to say in USD');
});

test('the daily ledger in another currency: each UTC day\'s net at its middle\'s rate, and as the totals have it once the detail recast them (B2)', () => {
  const c = perpsCtx('perps-0x2f46-to-2026-10-01.json', '2026-09-01', '2026-09-30', { money: eur('Australia/Sydney'), tz: 'Australia/Sydney', transfers: true });
  T.ledger.recast(c.led, c.D.ledgerC);
  const f = EX.build('perps-daily', c), col = (n) => f.columns.find((y) => y[0] === n)[1];
  const evC = 'Net EUR, each event at its own local date (as the totals)';
  assert.deepEqual(f.columns.map((x) => x[0]).slice(-4), ['Net EUR', 'USD→EUR rate', 'Rate date (ECB)', evC]);
  near(assert, f.rows.reduce((a, b) => a + Number(col(evC)(b)), 0), c.led.totals.C.net, 1e-5, 'the events\' column adds up to the summary\'s net');
  for (const b of f.rows) near(assert, Number(col('Net EUR')(b)), b.net * c.money.rate(b.tm), 1e-6);
  assert.ok(f.rows.some((b) => Math.abs(Number(col('Net EUR')(b)) - Number(col(evC)(b))) > 1e-4), 'in Sydney a UTC day can hold two local dates');
  assert.match(EX.text(EX.get('perps-daily').sub, c), /the net in EUR at the rate of the local date holding the day's middle \(with that rate and its date\) and as the totals have it/);
});
