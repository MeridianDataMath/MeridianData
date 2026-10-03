// Tax center methodology, ZIP and summary (MD.tax.methodology, MD.tax.zip, MD.tax.summary): the record every report
// starts with (G13), the ZIP of everything with its central directory read back and every CRC checked against zlib's,
// gains and losses by class on each disposal's own cash flows under both readings (G09), and the summary file's Predict
// rows under every date basis, never a pointer to another file (B17).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { load, near, root } from './_load.mjs';
import { perps, events, ledger } from './_tax-fixture.mjs';

const MD = load(['js/util.js', 'js/api.js', 'js/predict/api.js', 'js/predict/analytics.js', 'js/tax/core.js', 'js/tax/tz.js', 'js/tax/periods.js', 'js/tax/fx.js', 'js/tax/ledger.js', 'js/tax/load.js', 'js/tax/fills.js', 'js/tax/funding.js', 'js/tax/predict.js', 'js/tax/lots.js', 'js/tax/holdings.js', 'js/tax/summary.js', 'js/tax/methodology.js', 'js/tax/zip.js', 'js/tax/exports.js', 'js/tax/ui.js']);
const U = MD.util, P = MD.predict, T = MD.tax, M = T.methodology, Z = T.zip, S = T.summary, EX = T.exports, PR = T.predict, F = T.fills;
const DAY = 86400000, LATER = Date.UTC(2030, 0, 1);
const USD = T.fx.money(null, 'UTC');
const eur = (tz = 'UTC') => {
  const d = [], r = [];
  for (let t = Date.UTC(2026, 5, 1), i = 0; t < Date.UTC(2027, 1, 1); t += DAY, i++) { d.push(new Date(t).toISOString().slice(0, 10)); r.push(0.8 + (i % 17) / 100); }
  return T.fx.money(T.fx.rates({ ccy: 'EUR', id: 'ecb', via: 'file', table: { source: 'ecb', ccy: 'EUR', d, r, ref: null }, tz }), tz);
};
const period = (from, to, tz = 'UTC') => T.periods.resolve({ from, to, tz }, { firstT: Date.UTC(2026, 5, 29), now: LATER, browserZone: 'UTC' });
const get = (rows, k) => { const r = rows.find((x) => x[0] === k); return r ? r[1] : undefined; };
const prepOf = (file) => {
  const f = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/tax', file), 'utf8'));
  return PR.prepare({ norms: f.predictions.map(P.unslim), trades: f.trades || [], rd: f.rd, rows: f.rows, rowsFmt: f.rowsFmt, truncated: !!f.truncated, total: f.total, newest: f.newest, addr: f.address, builtAt: f.builtAt });
};
const perpsCtx = (name, from, to, money = USD, tz = 'UTC') => {
  const d = perps(name), Pp = period(from, to, tz), ev = events(MD, d, Pp.start, Pp.end), led = ledger(MD, d, Pp, money.fx);
  const D = F.disposals(ev, { ledger: led, period: Pp, ref: d.ref, tz, fx: money.fx });
  return { d, period: Pp, tz, money, fname: (k) => 'meridian-' + k + '.csv', ev, D, ref: d.ref, led, closed: [], now: LATER };
};

// ---------- the methodology record ----------
const base = (o = {}) => Object.assign({ addr: '0x8ddba2fdbfa8542bc52340b74eca451f180c8cec', sid: '01a0c566-fb90-71c2-8d5b-31da92ffcf6b', subName: 'main', pw: { address: '0x1111111111111111111111111111111111111111', via: '0x8ddb' }, link: 'https://meridian.thedatahub.xyz/#/tax?address=0x8ddb', period: period('2026-04-06', '2027-04-05', 'Europe/London'), money: eur('Europe/London'), perps: true, predict: { mode: 'claim', live: false, builtAt: Date.UTC(2026, 9, 3, 6) }, lots: null, warnings: [], now: Date.UTC(2026, 9, 3, 9, 30) }, o);

test('the record names the wallet, the period in local time and UTC, the zone, the rates, every reading and the disclaimer (G13)', () => {
  const m = M.build(base());
  assert.equal(m[0][0], 'Report'); assert.equal(get(m, 'Disclaimer'), T.DISCLAIMER);
  assert.match(T.DISCLAIMER, /not a tax adviser/);
  assert.equal(get(m, 'Wallet'), '0x8ddba2fdbfa8542bc52340b74eca451f180c8cec');
  assert.equal(get(m, 'Subaccount'), 'main · 01a0c566-fb90-71c2-8d5b-31da92ffcf6b');
  assert.match(get(m, 'Predict wallet'), /^0x1111.*smart account/);
  assert.match(get(m, 'Period'), /6 Apr 2026 00:00 Europe\/London \(2026-04-05 23:00 UTC\)/, 'local and the exact UTC instant');
  assert.match(get(m, 'Time zone'), /^Europe\/London \(Europe\/London, UTC\+01:00 at the period start\)/);
  for (const k of ['Report currency', 'Rate source', 'Rate rule', 'Latest rate']) assert.ok(get(m, k), k);
  assert.match(get(m, 'USDe valuation'), /1 USDe = 1 USD/);
  assert.match(get(m, 'Funding and position fees'), /neither marked as the one that applies/);
  assert.match(get(m, 'Meridian Predict'), /claim \(when claimed, paid out\) in this report; also computed beside it: claimable .* and verdict/);
  assert.match(get(m, 'Meridian Predict data'), /published snapshot, built 2026-10-03 06:00:00 UTC/);
  assert.doesNotMatch(get(m, 'Meridian Predict'), /position tokens held to a winning verdict/, 'not said before the record is loaded');
  // with the record: how the claim basis dates tokens held to a winning verdict, with or without redemption times
  // (a record holding tokens to a verdict that pays: only then is there anything to date)
  const held = (rd, pays = true) => get(M.build(base({ predict: { mode: 'claim', live: false, builtAt: 0, held: PR.heldClaimText({ rd, L: { events: pays ? [{ kind: 'verdict', cash: 5, pnl: 1 }] : [] } }) } })), 'Meridian Predict');
  assert.match(held(null), /on the claim basis, position tokens held to a winning verdict are dated by this wallet's own claim on that side, else by the latest claim on that pick configuration by any wallet \(the snapshot has no redemption times for this wallet yet\)$/);
  assert.match(held({}), /dated by this wallet's own redemption \(its burn of the tokens/);
  assert.doesNotMatch(held(null, false), /position tokens held to a winning verdict/, 'no paying verdict held: nothing to date, no fallback named');
  assert.match(get(m, 'USDe lots'), /^not computed/);
  assert.equal(get(m, 'Completeness'), 'no truncated read, failed check or netted day was found');
  assert.equal(get(m, 'Generated (UTC)'), '2026-10-03 09:30:00'); assert.equal(get(m, 'Site version'), T.VERSION);
  // no treatment is named as the law: every reading is described as what this report does, or computed side by side
  const text = m.map((r) => r[1]).join(' ');
  assert.doesNotMatch(text, /\byou (must|should)\b|\bis taxable\b|\bthe correct\b/i);
  // a Predict-only wallet: no perps rows; Predict that did not load says so; lots built say how
  const p = M.build(base({ sid: null, subName: null, perps: false, predict: { failed: true }, pw: null, warnings: ['x', 'y'], lots: { method: 'fifo', scope: 'pool', dep: 'transfer', opening: 2, valuation: { kind: 'market', name: 'DefiLlama USDe/USD', rule: 'daily' } } }));
  assert.equal(get(p, 'Perps disposals'), undefined);
  assert.match(get(p, 'Subaccount'), /^none/);
  assert.equal(get(p, 'Meridian Predict'), 'not available (the Predict data did not load)');
  assert.match(get(p, 'USDe lots'), /^FIFO: first in, first out; per pool; both deposit readings computed .*2 opening lot/);
  assert.match(get(p, 'USDe valuation'), /except the USDe lots: DefiLlama USDe\/USD, daily/);
  assert.equal(get(p, 'Completeness'), 'x; y');
});

test('a file\'s rows: its title, its own completeness, its describe rows (a key the record has is replaced, a new one goes before Data sources, the USDe lots\' fact line right after Time zone)', () => {
  const m = M.build(base());
  const rows = M.csvRows(m, 'Form 8949 statement', { warnings: ['part missing'], extra: [['Report', 'ignored'], ['Wallet', 'ignored'], ['Report currency', 'EUR (as the lots value it)'], ['Lot method', 'FIFO']] });
  assert.equal(get(rows, 'Report'), 'Form 8949 statement'); assert.equal(get(rows, 'Wallet'), get(m, 'Wallet'), 'the generic rows stay the record\'s');
  assert.equal(get(rows, 'Completeness'), 'part missing');
  assert.equal(get(rows, 'Report currency'), 'EUR (as the lots value it)');
  const keys = rows.map((r) => r[0]);
  assert.equal(keys.indexOf('Lot method'), keys.indexOf('Data sources') - 1);
  // the USDe lots' Form 1040 fact line heads the file: right after the period's zone, not with the other new rows
  const fact = T.lots.factRow(T.lots.facts([], 0, 1));
  const lk = M.csvRows(m, 'USDe disposals (lots)', { extra: [['Lot method', 'FIFO'], fact] }).map((r) => r[0]);
  assert.equal(lk.indexOf(fact[0]), lk.indexOf('Time zone') + 1);
  assert.equal(lk.indexOf('Lot method'), lk.indexOf('Data sources') - 1);
  assert.equal(get(M.csvRows(m, 'x', { warnings: [] }), 'Completeness'), 'nothing missing was found in this file\'s data');
  assert.equal(get(m, 'Report'), 'Meridian tax records', 'the record itself is not changed');
  // as text and JSON: every row, the files and what each misses, the tax-tool notes
  const files = [{ name: 'a.csv', kind: 'report', warnings: [] }, { name: 'k-INCOMPLETE.csv', kind: 'tool', warnings: ['2 UTC day(s) as daily totals'] }];
  const txt = M.text(m, { files, notes: M.toolNotes(), skipped: ['USDe lots files (not computed)'] });
  for (const [k] of m) assert.ok(txt.includes('\r\n' + k + ': '), k);
  assert.ok(txt.includes('- k-INCOMPLETE.csv (tax-tool import file: the tool\'s header first, no methodology rows): incomplete: 2 UTC day(s) as daily totals'));
  assert.ok(txt.includes('Not included\r\n- USDe lots files (not computed)'));
  assert.ok(txt.includes('Koinly universal CSV: header Date, Sent Amount, Sent Currency, Received Amount, Received Currency, Fee Amount, Fee Currency, Net Worth Amount, Net Worth Currency, Tag, Description, TxHash'));
  const js = JSON.parse(M.json(m, { files, notes: M.toolNotes() }));
  assert.equal(js.version, T.VERSION); assert.equal(js.record.length, m.length); assert.equal(js.record[1].value, T.DISCLAIMER);
  assert.deepEqual(js.files.map((f) => f.kind), ['report', 'tool']); assert.ok(js.toolNotes.length >= 4);
});

// ---------- the ZIP ----------
/** reads a ZIP back the way an unzipper does: the end record, the central directory, each local header and its data */
const unzip = (buf) => {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let e = buf.length - 22; while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  assert.ok(e >= 0, 'end of central directory record');
  const n = dv.getUint16(e + 10, true), cdSize = dv.getUint32(e + 12, true), cdOff = dv.getUint32(e + 16, true);
  assert.equal(cdOff + cdSize, e, 'the central directory ends where the end record starts');
  const out = []; let p = cdOff;
  for (let i = 0; i < n; i++) {
    assert.equal(dv.getUint32(p, true), 0x02014b50, 'central directory record ' + i);
    const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true), crc = dv.getUint32(p + 16, true), size = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nl));
    assert.equal(dv.getUint32(off, true), 0x04034b50, 'local header of ' + name);
    assert.equal(dv.getUint32(off + 14, true), crc, 'local and central CRC agree');
    const lnl = dv.getUint16(off + 26, true), lxl = dv.getUint16(off + 28, true);
    const data = buf.subarray(off + 30 + lnl + lxl, off + 30 + lnl + lxl + size);
    out.push({ name, flags, method, crc, size, usize, data, date: dv.getUint16(p + 14, true), time: dv.getUint16(p + 12, true) });
    p += 46 + nl + xl + cl;
  }
  return out;
};

test('the ZIP: stored entries with UTF-8 names whose central directory parses and whose CRCs are zlib\'s (G13)', () => {
  const big = 'x'.repeat(70000) + '€';
  const bytes = Z.build([{ name: 'meridian-summary.csv', data: '﻿Report,a\r\n' }, { name: 'méthodologie €.txt', data: 'héllo' }, { name: 'raw.bin', data: new Uint8Array([0, 1, 2, 255]) }, { name: 'big.csv', data: big }, { name: 'meridian-summary.csv', data: 'second' }], new Date(Date.UTC(2026, 9, 3, 9, 30, 41)));
  const files = unzip(bytes);
  assert.deepEqual(files.map((f) => f.name), ['meridian-summary.csv', 'méthodologie €.txt', 'raw.bin', 'big.csv', 'meridian-summary (2).csv'], 'UTF-8 names; a name used twice gets a number');
  for (const f of files) {
    assert.equal(f.method, 0, 'stored'); assert.equal(f.flags & 0x0800, 0x0800, 'UTF-8 flag'); assert.equal(f.size, f.usize);
    assert.equal(f.crc, zlib.crc32(f.data), 'CRC of ' + f.name);
    assert.equal(f.crc, Z.crc32(f.data));
  }
  assert.equal(new TextDecoder().decode(files[1].data), 'héllo'); assert.equal(new TextDecoder().decode(files[3].data), big);
  assert.deepEqual(Array.from(files[2].data), [0, 1, 2, 255]);
  assert.equal(files[0].date, ((2026 - 1980) << 9) | (10 << 5) | 3, 'MS-DOS date'); assert.equal(files[0].time, (9 << 11) | (30 << 5) | 20, 'MS-DOS time, two-second steps');
  assert.equal(Z.crc32(Z.utf8('123456789')), 0xcbf43926, 'the CRC-32 check value');
  // the bundle: report CSVs with a byte-order mark and their methodology first, tool CSVs exactly as the tool takes them,
  // then methodology.txt and methodology.json
  const rep = { kind: 'report', name: 'meridian-summary.csv', label: 'Summary', warnings: [], columns: [['A', (r) => r.a]], rows: [{ a: 1 }] };
  const tool = { kind: 'tool', name: 'meridian-koinly.csv', label: 'Perps: Koinly universal CSV', warnings: ['1 UTC day(s) as a daily total'], columns: EX.koinlyColumns(), rows: [] };
  const m = M.build(base());
  const entries = EX.bundle([{ file: rep, meth: M.csvRows(m, 'Summary', { warnings: [] }) }, { file: tool, meth: null }], m, { skipped: ['USDe lots files (not computed)'] });
  assert.deepEqual(entries.map((e) => e.name), ['meridian-summary.csv', 'meridian-koinly-INCOMPLETE.csv', 'methodology.txt', 'methodology.json']);
  assert.ok(entries[0].data.startsWith('﻿Report,Summary\r\nDisclaimer,'), 'a report: a byte-order mark, then its methodology');
  assert.equal(entries[1].data.split('\r\n')[0], EX.KOINLY.join(','), 'a tool file: its header first, no mark');
  assert.ok(entries[2].data.includes('meridian-koinly-INCOMPLETE.csv') && entries[2].data.includes('Not included'));
  const back = unzip(Z.build(entries, new Date()));
  assert.equal(new TextDecoder().decode(back[3].data), entries[3].data);
  assert.equal(JSON.parse(new TextDecoder().decode(back[3].data)).files[1].warnings[0], '1 UTC day(s) as a daily total');
});

// ---------- gains and losses by class ----------
test('by class: each disposal\'s credits − debits is its net under both readings; classes add up to the perps total (G09)', () => {
  for (const [name, from, to] of [['perps-0x2f46-to-2026-10-01.json', '2026-09-01', '2026-09-30'], ['perps-0x8ddb-xau-position-fees.json', '2026-09-01', '2026-10-02'], ['perps-0x8003-liquidation.json', '2026-09-01', '2026-09-30']]) {
    const c = perpsCtx(name, from, to, eur());
    const rows = c.D.inP;
    for (const r of rows) for (const reading of S.READINGS) { const f = S.flows(r, reading); near(assert, f.credits - f.debits, reading === 'inside' ? r.netAll : r.net, 1e-9); assert.ok(f.credits >= 0 && f.debits >= 0); }
    for (const reading of S.READINGS) {
      const cls = S.byClass(rows, reading, c.money), tot = cls[cls.length - 1], parts = cls.slice(0, -1);
      assert.equal(tot.cls, 'Perps total'); assert.equal(tot.n, rows.length);
      for (const k of ['n', 'nG', 'nL', 'proceeds', 'costs', 'gains', 'losses', 'net']) near(assert, U.sum(parts, (x) => x[k]), tot[k], 1e-6, name + ' ' + reading + ' ' + k);
      for (const x of cls) { near(assert, x.gains + x.losses, x.net, 1e-6); near(assert, x.proceeds - x.costs, x.net, 1e-6); near(assert, x.C.gains + x.C.losses, x.C.net, 1e-6); near(assert, x.C.proceeds - x.C.costs, x.C.net, 1e-6); }
      near(assert, tot.net, U.sum(rows, (r) => (reading === 'inside' ? r.netAll : r.net)), 1e-6);
      near(assert, tot.C.net, U.sum(rows, (r) => (reading === 'inside' ? r.netAllC : r.netC)), 1e-6, 'each part at its own date\'s rate');
      for (const x of parts) assert.ok(S.CLASSES.includes(x.cls) || /^Other · /.test(x.cls), x.cls);
    }
  }
  // 0x8ddb…: gold and silver are commodity mPerps, SPY an equity-ETF mPerp; the cash-flow proceeds are not notional
  const c = perpsCtx('perps-0x8ddb-xau-position-fees.json', '2026-09-01', '2026-10-02');
  const cls = S.byClass(c.D.inP, 'separate', USD);
  assert.deepEqual(cls.map((x) => x.cls), ['Commodity mPerps', 'Equity-ETF mPerps', 'Perps total']);
  assert.ok(cls[2].proceeds < U.sum(c.D.inP, (r) => r.exitNotional) / 50, 'cash flows, far below the notional');
  // a fee rebate is a credit; a position-fee credit too
  const f = S.flows({ gross: -2, openFee: -0.5, closeFee: 0.2, fundingIn: -1, posFeeIn: -0.25, net: -1.7, netAll: -2.45 }, 'inside');
  near(assert, f.credits, 0.3 + 0.25, 1e-12); near(assert, f.debits, 2 + 1, 1e-12); near(assert, f.credits - f.debits, -2.45, 1e-12);
  assert.equal(S.classOf({ baseTokenName: 'HYPE' }), 'Crypto perps'); assert.equal(S.classOf({ baseTokenName: 'XAG' }), 'Commodity mPerps'); assert.equal(S.classOf({ baseTokenName: 'QQQ' }), 'Equity-ETF mPerps');
  assert.equal(S.classOf({ baseTokenName: 'DOGE', displayTicker: 'DOGE-USD' }), 'Other · DOGE-USD');
});

test('Predict as a class: proceeds − costs = the Realized PnL tile under every basis, gains and losses apart (G09, G11)', () => {
  for (const file of ['predict-0xc1ce-trader.json', 'predict-0xba3b-buyer.json', 'predict-0xea41-maker.json', 'predict-0xaca4-traded.json']) {
    const prep = prepOf(file), Pp = period('2026-01-01', '2026-12-31'), money = eur();
    for (const mode of PR.MODES) {
      const x = S.predict(prep, mode, Pp, money), fig = PR.figures(PR.book(prep, mode), null, Pp, money, 'UTC');
      near(assert, x.net, fig.pnl, 1e-6, file + ' ' + mode); near(assert, x.C.net, fig.pnlC, 1e-6, file + ' ' + mode + ' EUR');
      near(assert, x.proceeds - x.costs, x.net, 1e-6); near(assert, x.gains + x.losses, x.net, 1e-6);
      assert.ok(x.gains >= 0 && x.losses <= 0 && x.proceeds >= 0);
    }
  }
});

test('the summary file: Predict under every basis with its report currency, its gross split and each basis\'s results not claimed by the end; never a pointer to another file (B17, G11)', () => {
  const prep = prepOf('predict-0xc1ce-trader.json'), Pp = period('2026-01-01', '2026-12-31'), money = eur();
  const f = S.summaryFile({ period: Pp, money, fname: (k) => k + '.csv', perps: null, hold: [['Perps cash balance at period start', '1', '0.8']], predict: { prep, mode: 'verdict' }, lots: null, warnings: [] });
  const sum = f.sections[0];
  assert.equal(sum.title, 'Summary'); assert.deepEqual(sum.columns.map((c) => c[0]), ['Metric', 'USD', 'EUR']);
  const rows = sum.rows, txt = rows.map((r) => r.join(',')).join('\n');
  assert.doesNotMatch(txt, /see the|see Predict/i);
  const cmp = PR.compare(prep, Pp, money);
  for (const m of PR.MODES) {
    const r = rows.find((x) => x[0].startsWith('Predict realized PnL, results dated ' + PR.MODE_FILE[m]));
    assert.ok(r, m); assert.equal(r[1], T.n6(cmp[m].pnl)); assert.equal(r[2], T.n6(cmp[m].pnlC), 'the report currency is filled');
    assert.equal(/\(this report\)$/.test(r[0]), m === 'verdict');
    // each basis's own tail: decided in the period under the claim basis, booked in it under the others
    const t = rows.find((x) => (m === 'claim' ? x[0].startsWith('Predict decided in the period, not claimed by its end') : x[0].startsWith(`Predict booked in the period on the ${m} basis, not claimed by its end`)) && x[0].includes(`the ${m} basis's realized PnL`));
    assert.ok(t, 'tail ' + m);
    const items = PR.tail(prep, m, Pp).items;
    assert.equal(t[1], T.n6(U.sum(items, (i) => i.pnl))); assert.equal(t[2], T.n6(U.sum(items, (i) => money.fx(i.pnl, i.t))));
  }
  // the gross split under the report's basis (G11), in USD and EUR: winnings − lost stakes + ledger gains + ledger
  // losses = the realized row; payouts, void refunds and wagered beside them
  const num = (k, i) => { const r = rows.find((x) => x[0].startsWith(k)); assert.ok(r, k); return Number(r[i]); };
  const G = PR.figures(PR.book(prep, 'verdict'), null, Pp, money, 'UTC');
  for (const [i, sfx] of [[1, ''], [2, 'C']]) {
    const realized = num('Predict realized PnL, results dated ' + PR.MODE_FILE.verdict, i);
    near(assert, num('Predict winnings', i) - num('Predict lost stakes', i) + num('Predict ledger gains', i) + num('Predict ledger losses', i), realized, 1e-5, 'the gross split adds up ' + (sfx || 'USD'));
    near(assert, num('Predict payouts of won predictions', i), G['payouts' + sfx], 1e-6); near(assert, num('Predict void refunds', i), G['refunds' + sfx], 1e-6); near(assert, num('Predict wagered', i), G['wagered' + sfx], 1e-6);
  }
  assert.ok(num('Predict ledger gains', 1) > 0 || num('Predict winnings', 1) > 0, 'a real wallet\'s split is not all zero');
  assert.match(rows.find((x) => x[0].startsWith('Predict winnings'))[0], /results dated verdict \(when the source market resolved\)$/);
  assert.ok(rows.some((r) => r[0] === 'Perps cash balance at period start'), 'the holdings rows');
  assert.ok(rows.some((r) => r[0] === 'USDe lots' && /not computed/.test(r[1])));
  assert.equal(rows[0][0], 'Period start'); assert.match(rows[0][1], /UTC/);
  // the classes and the Predict months follow
  const titles = f.sections.map((s) => s.title);
  assert.ok(titles.includes('Gains and losses by class')); assert.ok(titles.some((t) => /^Meridian Predict by month/.test(t)));
  const pm = f.sections.find((s) => /^Meridian Predict by month/.test(s.title)), heads = pm.columns.map((c) => c[0]);
  for (const k of ['Realized PnL', 'Winnings', 'Payouts', 'Lost stakes', 'Ledger gains', 'Ledger losses', 'Wagered']) for (const c of ['USD', 'EUR']) assert.ok(heads.includes(k + ' ' + c), k + ' ' + c);
  near(assert, pm.rows.reduce((a, m) => a + m.payoutsC, 0), G.payoutsC, 1e-6, 'the months\' payouts add up to the period\'s');
  for (const m of pm.rows) near(assert, m.winGainC - m.lostStakesC + m.ledgerGainsC + m.ledgerLossesC, m.pnlC, 1e-6, m.label + ' EUR identity');
  const cls = f.sections.find((s) => s.title === 'Gains and losses by class');
  assert.equal(cls.rows.filter((r) => r.section.startsWith('Meridian Predict')).length, 3, 'one row per basis');
  // Predict that did not load, or no record at all
  const failed = S.summaryFile({ period: Pp, money, fname: (k) => k, perps: null, hold: [], predict: { failed: true }, lots: null });
  assert.deepEqual(failed.sections[0].rows.find((r) => /^Predict/.test(r[0])), ['Predict realized PnL', 'not available (Predict data did not load)', '']);
  const missing = S.summaryFile({ period: Pp, money: USD, fname: (k) => k, perps: null, hold: [], predict: { missing: true }, lots: null });
  assert.deepEqual(missing.sections[0].rows.find((r) => /^Predict/.test(r[0])), ['Predict realized PnL (no Meridian Predict record for this wallet)', '0', '']);
  assert.deepEqual(missing.sections[0].columns.map((c) => c[0]), ['Metric', 'USD'], 'USD: no report-currency column');
});

test('the summary file with perps: every total, both funding legs, both readings per class, the monthly and quarterly tables', () => {
  const c = perpsCtx('perps-0x2f46-to-2026-10-01.json', '2026-09-01', '2026-09-30', eur());
  const ff = c.D.funding.fig;
  const f = S.summaryFile({ period: c.period, money: c.money, fname: c.fname, perps: { led: c.led, closed: [], D: c.D, ff, openAtEnd: 3, openUpnl: null, monthly: c.led.months, quarters: c.led.quarters, closedOverYear: 0 }, hold: [], predict: { missing: true }, lots: null, warnings: [] });
  const rows = f.sections[0].rows, val = (k) => (rows.find((r) => r[0].startsWith(k)) || [])[1];
  assert.equal(val('Perps realized PnL'), T.n6(c.led.totals.realized)); assert.equal(val('Perps net result'), T.n6(c.led.totals.net));
  assert.equal(val('Perps funding received (gross'), T.n6(ff.received)); assert.equal(val('Perps funding paid (gross'), T.n6(ff.paid));
  near(assert, Number(val('Perps gains')) + Number(val('Perps losses')), c.led.totals.realized, 1e-5, 'the disposals add up to the ledger');
  const cls = f.sections.find((s) => s.title === 'Gains and losses by class').rows;
  for (const reading of Object.values(S.READING_LABEL)) assert.ok(cls.some((r) => r.reading === reading && r.what === 'Perps total'), reading);
  assert.deepEqual(f.sections.map((s) => s.title).slice(-2), ['Perps by month (UTC)', 'Perps by quarter']);
  assert.equal(f.name, 'meridian-summary.csv');
  // as a report: the methodology first, then the tables, each with its title
  const csv = EX.render(Object.assign({ kind: 'report' }, f), M.csvRows(M.build(base({ period: c.period, money: c.money })), 'Summary', { warnings: [] }));
  assert.ok(csv.startsWith('Report,Summary\r\n')); assert.ok(csv.includes('\r\n\r\nSummary\r\nMetric,USD,EUR\r\n'));
});

test('in another currency every figure of a file agrees once the trade detail is in: the net result is the by-class total, funding net = received − paid (0x8ddb…, AUD, Sydney, 2026/27) (B2)', () => {
  const tz = 'Australia/Sydney', d = [], r = [];
  for (let t = Date.UTC(2026, 5, 1), i = 0; t < Date.UTC(2027, 1, 1); t += DAY, i++) { d.push(new Date(t).toISOString().slice(0, 10)); r.push(1.4 + (i % 17) / 50); }
  const money = T.fx.money(T.fx.rates({ ccy: 'AUD', id: 'ecb', via: 'file', table: { source: 'ecb', ccy: 'AUD', d, r, ref: null }, tz }), tz);
  const fx0 = perps('perps-0x8ddb-xau-position-fees.json');
  const Pp = T.periods.resolve({ fy: 'au', year: 2026, tz }, { now: LATER, firstT: Date.UTC(2026, 5, 29), browserZone: tz });
  const ev = events(MD, fx0, Pp.start, Pp.end), led = ledger(MD, fx0, Pp, money.fx);
  const D = F.disposals(ev, { ledger: led, period: Pp, ref: fx0.ref, tz, fx: money.fx });
  const inside = () => S.byClass(D.inP, 'inside', money).at(-1);
  near(assert, led.totals.net, inside().net, 1e-6, 'in USD the two agree: every position opened and closed in the period');
  assert.ok(Math.abs(led.totals.C.net - inside().C.net) > 1, 'each UTC day at its middle\'s rate (the Sydney date can differ) did not agree');
  T.ledger.recast(led, D.ledgerC);
  near(assert, led.totals.C.net, inside().C.net, 1e-6, 'from the same events at the same dates, they agree');
  const sum = S.summaryFile({ period: Pp, money, fname: (k) => k + '.csv', perps: { led, closed: [], D, ff: D.funding.fig, openAtEnd: 0, openUpnl: null, monthly: led.months, quarters: led.quarters, closedOverYear: 0 }, hold: [], predict: { missing: true }, lots: null, warnings: [] });
  const row = (k) => sum.sections[0].rows.find((x) => x[0].startsWith(k));
  near(assert, Number(row('Perps funding (net)')[2]), Number(row('Perps funding received')[2]) - Number(row('Perps funding paid')[2]), 2e-6, 'net = received − paid in AUD');
  const cls = sum.sections.find((s) => s.title === 'Gains and losses by class').rows.find((x) => x.what === 'Perps total' && x.reading === S.READING_LABEL.inside);
  near(assert, Number(row('Perps net result')[2]), cls.C.net, 2e-6, 'the summary\'s net result is the by-class total, inside');
  near(assert, led.months.reduce((a, m) => a + m.C.net, 0), led.totals.C.net, 1e-9, 'the months add up to it');
  // the Rate rule says how: each part at its own date, and which UTC days convert whole
  const m = M.build(base({ period: Pp, money, rateBasis: EX.DISPOSAL_RATE_TEXT + '; ' + T.ledger.basisText(led) }));
  assert.match(get(m, 'Rate rule'), /; a perps disposal's result, closing fee and notional legs convert at the disposal date .*; perps ledger totals \(realized PnL, fees, funding, transfers, by month and quarter\): each fill, settlement and transfer at the rate of its own local date/);
  assert.match(get(m, 'Rate rule'), /converts whole at the rate of the local date holding its middle: deposits and withdrawals on /, 'the fixture has no transfers: those days are named');
  assert.doesNotMatch(get(M.build(base({ period: Pp, money })), 'Rate rule'), /perps ledger totals/);
});

test('by class in another currency: each part on the side its USD sign puts it, at the dates the replay converted it (B2)', () => {
  const r = { gross: -2, openFee: -0.5, closeFee: 0.2, fundingIn: -1, posFeeIn: -0.25, net: -1.7, netAll: -2.45, grossC: -4, openFeeC: -0.7, closeFeeC: 0.4, fundingInC: -1.5, posFeeInC: -0.3, netC: -3.7, netAllC: -4.9 };
  const f = S.flows(r, 'inside');
  near(assert, f.credits, 0.3 + 0.25, 1e-12); near(assert, f.debits, 2 + 1, 1e-12);
  near(assert, f.C.credits, 0.3 + 0.3, 1e-12, 'the rebate and the position-fee credit, as converted'); near(assert, f.C.debits, 4 + 1.5, 1e-12);
  near(assert, f.C.credits - f.C.debits, r.netAllC, 1e-12); near(assert, S.flows(r, 'separate').C.net, r.netC, 1e-12);
  const money = { ccy: 'EUR', rates: {}, rate: () => 99 };   // the rate is never read for a disposal: its parts are converted
  const tot = S.byClass([Object.assign({ cls: 'Crypto perps', t: 0 }, r)], 'separate', money).at(-1);
  near(assert, tot.C.net, -3.7, 1e-12); near(assert, tot.C.losses, -3.7, 1e-12); near(assert, tot.C.proceeds - tot.C.costs, -3.7, 1e-12);
});

test('the summary files gather the perps part (and its trade detail) before the holdings rows, the Predict part alongside: no holdings row is built without the detail', async () => {
  const log = [], later = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));
  let detail = false;
  const out = await S.gather({
    perps: async () => { log.push('perps'); await later(20); detail = true; log.push('perps in'); return { D: 'detail' }; },
    hold: async () => { log.push('holdings, detail ' + (detail ? 'in' : 'missing')); return [['row']]; },
    predict: async () => { log.push('predict'); await later(5); log.push('predict in'); return { prep: 1 }; },
  });
  assert.deepEqual(log, ['predict', 'perps', 'predict in', 'perps in', 'holdings, detail in']);
  assert.deepEqual(out, { perps: { D: 'detail' }, hold: [['row']], predict: { prep: 1 } });
  // a wallet without a perps subaccount: the holdings at once; without either: empty parts
  assert.deepEqual(await S.gather({ perps: null, hold: async () => [1], predict: async () => ({ missing: true }) }), { perps: null, hold: [1], predict: { missing: true } });
  assert.deepEqual(await S.gather({ perps: null, hold: null, predict: null }), { perps: null, hold: [], predict: null });
  // a Predict part that fails while the perps part loads is the gather's failure, never an unhandled one
  await assert.rejects(S.gather({ perps: () => later(10, null), hold: null, predict: () => Promise.reject(new Error('predict')) }), /predict/);
  // the page builds the summary and the ZIP's summary through it
  assert.match(fs.readFileSync(path.join(root, 'js/pages/tax.js'), 'utf8'), /const summaryCtx = async \(\) => \{\r?\n\s+const \{ perps, hold, predict \} = await TX\.summary\.gather\(\{ perps: vp \? \(\) => vp\.summaryPerps\(\) : null, hold: hv \? \(\) => hv\.summaryRows\(\)/);
});

test('the holding period row: the last increase convention said as the stricter one, and Form 8949\'s month-end reading of Rev. Rul. 66-7', () => {
  const v = get(M.build(base()), 'Holding period');
  assert.match(v, /a disposal averaged over several increases counts from the last of them, which is stricter than counting from the position's opening/);
  assert.match(v, /Form 8949 statement's Part also follows the IRS's month-end ruling \(Rev\. Rul\. 66-7, read for one year\): an acquisition on the last day of a month is held more than a year only from the first day of the 13th month after it/);
  assert.match(v, /28 Feb 2027 sold on 29 Feb 2028 is Part I there and held over a year elsewhere/);
  assert.equal(get(M.build(base({ perps: false })), 'Holding period'), undefined, 'no perps, no holding-period row');
});
