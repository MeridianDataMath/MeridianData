// Tax center wording, print and phone (batch 9: B23, B24, B39, B40, B42): the results, costs and transfers rows say what
// each line is and never how it is taxed, and add up to the balance change; the printed report names the wallet, the
// subaccount, the Predict wallet and the period in full; the disclaimer is in every card that can print alone; the print
// rules fit every table on an A4 page and the phone rules keep the amounts in view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { load, near, root } from './_load.mjs';
import { perps, events, ledger } from './_tax-fixture.mjs';

const MD = load(['js/util.js', 'js/api.js', 'js/predict/api.js', 'js/predict/analytics.js', 'js/tax/core.js', 'js/tax/tz.js', 'js/tax/periods.js', 'js/tax/fx.js', 'js/tax/ledger.js', 'js/tax/load.js', 'js/tax/fills.js', 'js/tax/funding.js', 'js/tax/predict.js', 'js/tax/lots.js', 'js/tax/holdings.js', 'js/tax/summary.js', 'js/tax/methodology.js']);
const U = MD.util, T = MD.tax, S = T.summary, M = T.methodology, F = T.fills, FU = T.funding;
const DAY = 86400000, LATER = Date.UTC(2030, 0, 1);
const USD = T.fx.money(null, 'UTC');
const eur = (tz = 'UTC') => {
  const d = [], r = [];
  for (let t = Date.UTC(2026, 5, 1), i = 0; t < Date.UTC(2027, 1, 1); t += DAY, i++) { d.push(new Date(t).toISOString().slice(0, 10)); r.push(0.8 + (i % 17) / 100); }
  return T.fx.money(T.fx.rates({ ccy: 'EUR', id: 'ecb', via: 'file', table: { source: 'ecb', ccy: 'EUR', d, r, ref: null }, tz }), tz);
};
const period = (from, to, tz = 'UTC') => T.periods.resolve({ from, to, tz }, { firstT: Date.UTC(2026, 5, 29), now: LATER, browserZone: 'UTC' });
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
// a treatment stated as fact, or the old hint column: none of it may come back
const TREATMENT = /usual treatment|classification hint|not income|usually not taxable|capital \/ trading|income vs expenses|income and expenses|many tax systems treat|\bis taxable\b|\bis not taxable\b|\byou (must|should)\b/i;

/** the by-type rows of a real period, with the trade detail in (or not) */
const byType = (name, from, to, money = USD, o = {}) => {
  const d = perps(name), P = period(from, to), led = ledger(MD, d, P, money.fx);
  const D = o.noDetail ? null : F.disposals(events(MD, d, P.start, P.end), { ledger: led, period: P, ref: d.ref, tz: 'UTC', fx: money.fx });
  const ff = D ? D.funding.fig : FU.figures(null, led.segments, money.fx);
  const rows = S.byType({ totals: led.totals, X: S.perpsFigures(D, money), ff, funding: o.failed || !!D, pending: o.failed ? 'trade detail not loaded' : 'loading trade detail…' });
  return { led, D, rows };
};

test('results, costs and transfers: every line is a trading result, funding, a fee or a transfer, and they add up to the balance change (B23)', () => {
  for (const [name, from, to] of [['perps-0x2f46-to-2026-10-01.json', '2026-08-01', '2026-09-30'], ['perps-0x8ddb-xau-position-fees.json', '2026-09-01', '2026-09-30'], ['perps-0x8003-liquidation.json', '2026-07-01', '2026-09-30']]) {
    for (const money of [USD, eur()]) {
      const { led, rows } = byType(name, from, to, money);
      assert.deepEqual(S.TYPES, ['trading result', 'funding', 'fee', 'transfer']);
      for (const r of rows) {
        assert.ok(S.TYPES.includes(r.type), name + ': ' + r.cat + ' has type ' + r.type);
        assert.doesNotMatch(r.type + ' ' + r.cat + ' ' + r.note, TREATMENT, r.cat);
        assert.ok(Number.isFinite(r.usd) && Number.isFinite(r.c), r.cat + ' has its amounts');
      }
      // money in and out of the account: the trading results, funding, fees and transfers are the balance change
      near(assert, U.sum(rows, (r) => r.usd), led.recon.expected - led.opening, 0.01, name + ': the rows add up to the balance change');
      near(assert, U.sum(rows.filter((r) => r.type === 'trading result'), (r) => r.usd), led.totals.realized, 0.01, name + ': trading results = the ledger\'s realized PnL');
      near(assert, U.sum(rows.filter((r) => r.type === 'funding'), (r) => r.usd), led.totals.funding, 1e-6, name + ': funding = the ledger\'s');
      near(assert, U.sum(rows.filter((r) => r.type === 'fee'), (r) => r.usd), -(led.totals.fees + led.totals.pfees + led.totals.wfee), 1e-6, name + ': fees');
      near(assert, U.sum(rows.filter((r) => r.type === 'transfer'), (r) => r.usd), led.totals.deposits - led.totals.withdrawals + led.totals.wfee, 1e-6, name + ': transfers net of their fees');
      if (money !== USD) assert.ok(rows.some((r) => Math.abs(r.c - r.usd) > 0.01), 'the report currency is converted');
    }
  }
  // the mPerp account has a position-fee line; one without position fees has none
  assert.ok(byType('perps-0x8ddb-xau-position-fees.json', '2026-09-01', '2026-09-30').rows.some((r) => r.cat === 'Position fees (mPerps)'));
});

test('results, costs and transfers before the trade detail: the ledger lines are there, the rest says it is loading or netted (B23)', () => {
  const loading = byType('perps-0x2f46-to-2026-10-01.json', '2026-08-01', '2026-09-30', USD, { noDetail: true }).rows;
  for (const r of loading) {
    if (r.type === 'trading result' || r.type === 'funding') { assert.equal(r.usd, null, r.cat); assert.equal(r.note, 'loading trade detail…'); }
    else assert.ok(Number.isFinite(r.usd), r.cat);
  }
  assert.ok(!loading.some((r) => r.cat === 'Realized PnL outside the disposals'), 'no check line without the disposals');
  // the detail failed: funding is each UTC day's net, said so; gains and losses stay unknown
  const failed = byType('perps-0x2f46-to-2026-10-01.json', '2026-08-01', '2026-09-30', USD, { noDetail: true, failed: true });
  const fund = failed.rows.filter((r) => r.type === 'funding');
  assert.equal(fund.length, 2); for (const r of fund) { assert.ok(Number.isFinite(r.usd)); assert.match(r.note, /UTC days? netted per day/); }
  near(assert, fund[0].usd + fund[1].usd, failed.led.totals.funding, 1e-6);
  assert.equal(failed.rows.find((r) => r.cat === 'Trading gains').note, 'trade detail not loaded');
});

test('the printed report names the wallet, subaccount, Predict wallet and period in full, with when it was generated (B40)', () => {
  const P = period('2026-04-06', '2027-04-05', 'Europe/London');
  const ctx = { addr: '0x8ddba2fdbfa8542bc52340b74eca451f180c8cec', sid: '01a0c566-fb90-71c2-8d5b-31da92ffcf6b', subName: 'main', pw: { address: '0x1111111111111111111111111111111111111111', via: '0x8ddb' }, period: P, now: Date.UTC(2026, 9, 3, 9, 30, 5) };
  const line = M.identity(ctx);
  assert.equal(line, 'Wallet 0x8ddba2fdbfa8542bc52340b74eca451f180c8cec · subaccount main (01a0c566-fb90-71c2-8d5b-31da92ffcf6b) · Predict wallet 0x1111111111111111111111111111111111111111 · '
    + '2026-04-06 → 2027-04-05: ' + P.startText + ' → ' + P.endText + ' · generated 2026-10-03 09:30:05 UTC');
  // the period is in its zone and in UTC: 6 Apr 2026 00:00 in London is 5 Apr 23:00 UTC
  assert.match(line, /Europe\/London \(2026-04-05 23:00 UTC\)/);
  assert.doesNotMatch(line, /…/, 'nothing is shortened');
  // a Predict-only wallet, its Predict wallet not looked up yet, then one whose Predict data failed
  assert.match(M.identity(Object.assign({}, ctx, { sid: null, subName: null, pw: null })), /^Wallet 0x8ddb\S+ · no perps subaccount · Predict wallet not looked up yet · /);
  assert.match(M.identity(Object.assign({}, ctx, { pw: null, predict: { failed: true } })), /Predict wallet not known \(the Predict data did not load\)/);
  assert.match(M.identity(Object.assign({}, ctx, { pw: '0x2222222222222222222222222222222222222222' })), /Predict wallet 0x2{40} /);
});

test('no page text, comment or README line states a treatment; the disclaimer is in every card that prints on its own (B23, B24)', () => {
  const files = ['js/pages/tax.js', 'js/app.js', ...fs.readdirSync(path.join(root, 'js/tax')).map((f) => 'js/tax/' + f)];
  const hits = [];
  for (const f of files) read(f).split('\n').forEach((l, i) => { if (TREATMENT.test(l)) hits.push(`${f}:${i + 1}: ${l.trim().slice(0, 100)}`); });
  read('README.md').split('\n').forEach((l, i) => { if (TREATMENT.test(l)) hits.push(`README.md:${i + 1}: ${l.trim().slice(0, 100)}`); });
  assert.deepEqual(hits, []);
  const keep = (src) => (src.match(/footer-note\.print-keep[^\n]*DISCLAIMER\)/g) || []).length;
  assert.equal(keep(read('js/pages/tax.js')), 2, 'the perps notes card and the Predict-only page');
  assert.equal(keep(read('js/tax/view-lots.js')), 1, 'the USDe lots card');
  assert.equal(keep(read('js/tax/view-holdings.js')), 1, 'the Holdings card');
  assert.match(T.DISCLAIMER, /not a tax adviser/); assert.match(T.DISCLAIMER, /no tax is computed/);
  // the Predict-only page has the period line and the rate line (or the note that rates failed) beside its notice
  assert.match(read('js/pages/tax.js'), /This wallet has no Meridian perps subaccount[^\n]*periodLine, fxLine\)/);
  assert.match(read('js/pages/tax.js'), /fxNote \? h\('div\.small\.neg'/);
});

/** a top-level @media block of the stylesheet, by its exact query */
const mediaBlock = (css, query) => {
  const at = css.indexOf('@media ' + query + ' {'); assert.ok(at >= 0, 'no @media ' + query);
  let depth = 0, i = css.indexOf('{', at);
  for (let j = i; j < css.length; j++) { if (css[j] === '{') depth++; else if (css[j] === '}' && --depth === 0) return css.slice(i + 1, j); }
  throw new Error('unclosed @media ' + query);
};

test('print: no card clips its table, text cells wrap at 9px, amounts stay on one line, the help link is hidden (B39, B40)', () => {
  const css = read('css/app.css'), pr = mediaBlock(css, 'print');
  assert.match(pr, /\.card\.tight \{ overflow: visible; \}/);
  assert.match(pr, /table\.tbl \{ font-size: 9px; \}/);
  assert.doesNotMatch(pr, /table\.tbl \{ font-size: 11px; \}/);
  assert.match(pr, /table\.tbl th, table\.tbl td \{ white-space: normal; padding: 4px 5px; \}/);
  assert.match(pr, /table\.tbl td\.num \{ white-space: nowrap; \}/);
  assert.match(pr, /\.no-print, a\.defs \{ display: none !important; \}/);
  assert.match(pr, /span\.print-only \{ display: inline !important; \}/, 'a full address prints inside its line');
  assert.match(css, /^\.print-only \{ display: none; \}/m, 'on screen the print-only parts are hidden');
  // headings, chips and notes under the figures; a disposal's flags stack; a zone heading can break after its slashes
  assert.match(pr, /table\.tbl th \{ font-size: 8px; \}/);
  assert.match(pr, /table\.tbl \.chip \{ font-size: 8px; padding: 0 4px; \}/);
  assert.match(pr, /table\.tbl \.small, table\.tbl \.xs \{ font-size: 8px; \}/);
  assert.match(pr, /\.tax-flags \{ flex-wrap: wrap; \}/);
  for (const f of ['js/tax/view-perps.js', 'js/tax/view-lots.js', 'js/tax/view-holdings.js']) {
    assert.doesNotMatch(read(f), /label: `\w+ \(\$\{tz\}\)`/, f + ': a zone heading is TUI.tzLabel');
    assert.match(read(f), /label: TUI\.tzLabel\('/, f);
  }
  assert.match(read('js/tax/ui.js'), /TUI\.wbr = \(text\) => String\(text\)\.replace\(\/\[\/_\]\/g, '\$&\\n'\)/, 'no lookbehind (older Safari)');
});

test('phone: the results, reconciliation, quarterly, class and holdings tables wrap their text, never their amounts (B42)', () => {
  const css = read('css/app.css');
  assert.ok(!/@media \(max-width: 720px\)/.test(css), 'the phone layout is for screens only: an A4 page is as narrow');
  const ph = mediaBlock(css, 'screen and (max-width: 720px)');
  assert.match(ph, /\.wrap-cells table\.tbl th, \.wrap-cells table\.tbl td:not\(\.num\) \{ white-space: normal; \}/);
  assert.match(ph, /\.wrap-cells table\.tbl th, \.wrap-cells table\.tbl td \{ padding: 8px 6px; \}/);
  const vp = read('js/tax/view-perps.js'), vh = read('js/tax/view-holdings.js');
  assert.match(vp, /const catWrap = h\('div\.wrap-cells'\)/, 'results, costs and transfers');
  assert.match(vp, /h\('div\.card\.tight\.wrap-cells', \{ style: \{ marginTop: '8px', maxWidth: '520px' \} \}/, 'the reconciliation');
  assert.match(vp, /const monthlyWrap = h\('div'\), quarterWrap = h\('div\.wrap-cells'\)/, 'the quarterly table wraps its text, the monthly one keeps scrolling sideways');
  assert.match(vp, /UI\.card\('Quarterly breakdown', quarterWrap,/);
  assert.match(vp, /const classWrap = h\('div\.wrap-cells\.tax-classes'\)/);
  assert.match(vp, /UI\.card\('Monthly breakdown', monthlyWrap,/);
  assert.match(vh, /h\('div\.card\.tight\.wrap-cells', main\)/);
  // a count beside an amount goes under it, and words in a number cell may wrap: the holdings fit 375 px
  assert.match(ph, /\.wrap-cells td\.num \.num-sub \{ display: block; white-space: normal; \}/);
  assert.match(ph, /\.wrap-cells td\.num \.num-sep \{ display: none; \}/);
  assert.match(ph, /\.wrap-cells td\.num \.num-note \{ white-space: normal; \}/);
  assert.match(vh, /const sub = \(text\) => h\('span\.dim\.xs\.num-sub', h\('span\.num-sep', ' · '\), text\)/);
  assert.match(vh, /if \(v == null\) return h\('span\.dim\.num-note'/);
  // three columns: the note sits under its category
  assert.match(vp, /label: 'Category', render: \(r\) => h\('div', r\.cat, h\('div\.dim\.xs'/);
  assert.match(vp, /label: 'Type'/);
});

test('phone: the class tables fold Proceeds and Costs under the name and put the name on its own line, so Disposals, Gains, Losses and Net stay in view; print keeps every column', () => {
  const css = read('css/app.css'), ph = mediaBlock(css, 'screen and (max-width: 720px)'), pr = mediaBlock(css, 'print');
  assert.match(css, /^\.tax-fold-only \{ display: none; \}/m, 'the folded line is hidden on a wide screen and in print');
  assert.match(ph, /\.tax-classes table\.tbl \.tax-fold \{ display: none; \}/);
  assert.match(ph, /\.tax-classes \.tax-fold-only \{ display: block; \}/);
  // each row a grid: the name (and the Class heading) on a line of its own, then four aligned columns
  assert.match(ph, /\.tax-classes table\.tbl tr \{ display: grid; grid-template-columns: 19% repeat\(3, 27%\); \}/);
  assert.match(ph, /\.tax-classes table\.tbl tr > :first-child \{ grid-column: 1 \/ -1; \}/);
  assert.match(ph, /\.tax-classes table\.tbl td\.num \{ font-size: 12px; \}/);
  assert.doesNotMatch(pr, /tax-fold/);
  const vp = read('js/tax/view-perps.js');
  assert.match(vp, /\{ key: 'p', label: 'Proceeds', num: true, cls: 'tax-fold',/);
  assert.match(vp, /\{ key: 'k', label: 'Costs', num: true, cls: 'tax-fold',/);
  const folds = vp.split('\n').filter((l) => l.includes("cls: 'tax-fold'")).map((l) => /\{ key: '(\w+)'/.exec(l)[1]);
  assert.deepEqual(folds, ['p', 'k'], 'Disposals, Gains, Losses and Net stay in view');
  // the line under the name, in both the class tables and Other sections (the same columns)
  assert.match(vp, /const folded = \(x\) => h\('div\.dim\.xs\.tax-fold-only', 'proceeds ' \+ fmtC\(x\.C\.proceeds\) \+ ' · costs ' \+ fmtC\(x\.C\.costs\)\);/);
  assert.match(vp, /label: first, render: \(x\) => h\('div', h\('span', \{ class: x\.total \? 'bold' : '' \}, [^\n]*\), folded\(x\)\) \}/);
  assert.match(vp, /otherCols\[0\] = \{ key: 'c', label: 'Section', render: \(x\) => h\('div', x\.label, folded\(x\)\) \};/);
  assert.match(vp, /const classWrap = h\('div\.wrap-cells\.tax-classes'\)/, 'both tables sit inside the block the phone rules name');
  // a grid row drops a table's semantics in some browsers: both tables get their roles back
  assert.match(vp, /for \(const \[sel, role\] of \[\['thead, tbody', 'rowgroup'\], \['tr', 'row'\], \['th', 'columnheader'\], \['td', 'cell'\]\]\)/);
  assert.equal((vp.match(/tableRoles\(UI\.table\(/g) || []).length, 2);
  assert.match(vp, /label: 'Dis\\u00ADposals'/, 'the heading may break to keep its column narrow');
});

test('every Tax center export button shows a spinner and says when building its file fails (TUI.exBtn\'s async flag)', () => {
  // the arguments of each exBtn( … ) call, strings and nested calls skipped
  const calls = (src) => {
    const out = [];
    for (const m of src.matchAll(/\bexBtn\(/g)) {
      let i = m.index + m[0].length, depth = 1, q = null, args = '';
      for (; i < src.length && depth; i++) {
        const ch = src[i];
        if (q) { if (ch === '\\') { args += ch + src[++i]; continue; } if (ch === q) q = null; args += ch; continue; }
        if (ch === '\'' || ch === '"' || ch === '`') q = ch;
        else if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
        if (depth) args += ch;
      }
      out.push(args);
    }
    return out;
  };
  let n = 0;
  for (const f of ['js/pages/tax.js', 'js/tax/view-perps.js', 'js/tax/view-predict.js', 'js/tax/view-lots.js', 'js/tax/view-holdings.js']) {
    const cs = calls(read(f));
    assert.ok(cs.length, f + ' has export buttons');
    for (const a of cs) { n++; assert.match(a, /,\s*true\s*$/, f + ': exBtn(' + a.slice(0, 60) + '…) without the async flag'); }
  }
  assert.ok(n >= 10, String(n));
  assert.match(read('js/tax/ui.js'), /TUI\.exBtn = \(label, sub, fn, async\) => \{ const b = h\('button\.btn', \{\}, U\.icon\('download'\), label\); b\.addEventListener\('click', async \? TUI\.busyFn\(b, fn\) : fn\);/);
  assert.match(read('js/tax/ui.js'), /U\.toast\('Export failed: ' \+ e\.message, TUI\.WARN_MS\)/);
});

test('the held-over-a-year chip is neutral (not one country\'s term) and left out of a UK report; the files keep the column', () => {
  const vp = read('js/tax/view-perps.js');
  assert.doesNotMatch(vp, /'long-term'\)/, 'no US capital-gains term on the chip');
  assert.match(vp, /const overYearChip = \(on, style\) => \(on && period\.preset !== 'uk' \? h\('span\.chip\.blue', \{ style: style \|\| null, title: `held for more than one year \(calendar dates, \$\{tz\}\)` \}, 'held > 1 yr'\) : null\);/);
  assert.equal((vp.match(/overYearChip\((r|c)\.longTerm/g) || []).length, 2, 'the disposals and the closed positions');
  // the data columns stay in every report
  assert.match(read('js/tax/exports.js'), /\[`Held over a year \(calendar dates, \$\{tz\}\)`, \(r\) => yn\(r\.longTerm\)\]/);
  assert.match(read('js/tax/exports.js'), /\[`Held more than one year \(calendar dates, \$\{tz\}\)`, \(x\) => yn\(x\.longTerm\)\]/);
});

test('the README names what the Tax center leaves out on purpose and what the plan deferred, each with its reason', () => {
  const md = read('README.md'), at = md.indexOf('  * *Not built*, deferred by the plan with its reasons:'), end = md.indexOf('  * *Not a tax adviser*');
  assert.ok(at > md.indexOf('  * *Out of scope*, on purpose:') && end > at, 'a Not built list after Out of scope');
  const list = md.slice(at, end);
  for (const re of [/specific identification of USDe lots: it needs an identification made at the time of each disposal/, /XUDLUSS/, /monthly-average and year-end conventions: no rule checked requires them/, /India Schedule VDA file: the Disposals file already has/, /Hong Kong fiscal-year preset: a custom range covers it/, /Australian 12-month CGT flag: \*held over a year\*/]) assert.match(list, re);
});
