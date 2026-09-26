// Link-preview cards: the SVG artwork and the share pages behind /a/<address> and /p/<address> (scripts/cards.mjs).
// The PNG rendering itself (resvg) is left to the deploy workflow; these check what goes into it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { load, root } from './_load.mjs';
import { makeCards, esc } from '../scripts/cards.mjs';

const MD = load(['js/util.js', 'js/api.js', 'js/predict/api.js', 'js/predict/analytics.js']);
const K = makeCards({ U: MD.util, P: MD.predict, site: 'https://example.test' });
const A1 = '0x7c7565ad321ad3df118738fb16ea3bfd416334de', ME = '0x00000000000000000000000000000000000000b1', MAKER = '0x00000000000000000000000000000000000000a1';
const clean = (svg) => { assert.doesNotMatch(svg, /undefined|NaN|Infinity|\[object/); assert.match(svg, /^<svg [^>]*width="1200" height="630"/); };

test('text is escaped for XML and HTML', () => {
  assert.equal(esc('a & b < c > "d" \'e\''), 'a &amp; b &lt; c &gt; &quot;d&quot; &#39;e&#39;');
});

test('an account card: headline in the account\'s colour, its curve, no stray values', () => {
  const row = { account: A1, sid: 's1', createdAt: Date.UTC(2026, 8, 18), equity: 8038.39, volumeAll: 122036.09, winRate: 100, style: 'Swing', openCount: 1, positionsCount: 2, closedCount: 1, liquidated: 0,
    stats: { all: { pnl: 2044.19, roi: 34.1, ddPct: 19.38 } }, curve: [[1789689600, 0], [1789776000, 38.4], [1789862400, 1600], [1790121600, 2044.19]] };
  const svg = K.accountSvg(row); clean(svg);
  assert.match(svg, />\+\$2,044\.19</); assert.match(svg, /#34d487/, 'green for a gain');
  assert.match(svg, /0x7c75…34de/); assert.match(svg, /Swing trader · since Sep 18, 2026/); assert.match(svg, />Equity curve · All time</);
  assert.match(svg, /<path d="M[^"]+" fill="none" stroke="#34d487"/, 'the PnL line');
  const loss = K.accountSvg(Object.assign({}, row, { stats: { all: { pnl: -2300.87, roi: -0.2, ddPct: 0.17 } }, curve: null }));
  clean(loss); assert.match(loss, />-\$2,300\.87</); assert.match(loss, /#ef454a/); assert.match(loss, /Not enough history for a curve yet/, 'no curve: said so');
  const t = K.accountText(row); assert.match(t.title, /^0x7c75…34de on Meridian: \+\$2,044\.19 all-time PnL$/);
});

test('with dollar amounts hidden the card leads with the return and shows no dollar figure', () => {
  const row = { account: A1, createdAt: Date.UTC(2026, 8, 18), equity: 8038.39, volumeAll: 122036.09, winRate: 100, style: 'Swing', positionsCount: 2,
    stats: { all: { pnl: 2044.19, roi: 34.1, ddPct: 19.38 } }, curve: [[1789689600, 0], [1789862400, 1600], [1790121600, 2044.19]] };
  const svg = K.flexSvg(Object.assign(K.accountInput(row), { hideAmounts: true })); clean(svg);
  assert.match(svg, />\+34%</, 'the return is the headline'); assert.match(svg, />RETURN · ALL TIME</);
  assert.doesNotMatch(svg, /\$/, 'no dollar amount anywhere');
  assert.match(svg, />Sep 18 – Sep 23, 2026</, 'the period instead of the ROI pill');
  const loss = K.flexSvg(Object.assign({}, K.accountInput(Object.assign({}, row, { stats: { all: { pnl: -50, roi: -5.2 } } })), { hideAmounts: true }));
  assert.match(loss, />-5\.2%</); assert.match(loss, /#ef454a/);
});

test('big figures switch to compact and shrink to fit', () => {
  assert.equal(K.money(123456.78, true), '+$123.5K');
  assert.equal(K.money(-99999.5, true), '-$99,999.50');
  const svg = K.accountSvg({ account: A1, equity: 1e6, volumeAll: 3.5e6, stats: { all: { pnl: 1234567.89, roi: 12 } } }); clean(svg);
  assert.match(svg, />\+\$1\.23M</);
});

const wei = (x) => (BigInt(Math.round(x * 1e6)) * 1000000000000n).toString();
const pred = (id, stake, cp, verdict, t) => MD.predict.slim(MD.predict.norm({ predictionId: id, predictor: ME, counterparty: MAKER, predictorCollateral: wei(stake), counterpartyCollateral: wei(cp), settled: false, result: null,
  createdAt: new Date(t).toISOString(), settledAt: null, pickConfig: { pickConfigId: 'pc-' + id, resolved: !!verdict, result: verdict, picks: [{ conditionId: 'c' + id, predictedOutcome: 'YES', condition: { question: 'Q', endTime: Math.floor((t + 3600000) / 1000) } }] } }));

test('a wallet\'s curve adds its decided results in time and ends at its PnL; a truncated file has none', () => {
  const T = Date.UTC(2026, 7, 1), D = 86400000;
  const file = { address: ME, truncated: false, trades: [], predictions: [pred('w', 10, 30, 'PREDICTOR_WINS', T), pred('l', 5, 8, 'COUNTERPARTY_WINS', T + D), pred('o', 3, 4, null, T + 2 * D)] };
  const c = K.walletCurve(file, ME);
  assert.equal(c[c.length - 1][1], 30 - 5); assert.equal(c[0][1], 0); assert.ok(c.every((p, i) => !i || p[0] >= c[i - 1][0]), 'in time order');
  const maker = K.walletCurve(file, MAKER); assert.equal(maker[maker.length - 1][1], -(30 - 5), 'the maker\'s side is the mirror');
  assert.equal(K.walletCurve(Object.assign({}, file, { truncated: true }), ME), null);
  const svg = K.walletSvg({ address: ME, n: 3, won: 1, lost: 1, pnl: 25, roi: 166.7, wagered: 18, winRate: 50, avgOdds: 0.3, first: T, topCat: 'Sports' }, file, false); clean(svg);
  assert.match(svg, /BETTOR · MERIDIAN PREDICT/); assert.match(svg, />1W \/ 1L</); assert.match(svg, /Mostly Sports/);
});

test('the share page carries the card for unfurlers and sends people on to the page', () => {
  const html = K.sharePage({ kind: 'a', address: A1, title: 'Tom & "Jerry"', description: 'a < b', image: 'cards/a/' + A1 + '.png?v=abc', target: '/#/account?address=' + A1 + '&sub=s1' });
  assert.match(html, /<meta property="og:image" content="https:\/\/example\.test\/cards\/a\/0x7c75[0-9a-f]+\.png\?v=abc">/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(html, /<meta property="og:url" content="https:\/\/example\.test\/a\/0x7c7565ad321ad3df118738fb16ea3bfd416334de">/);
  assert.match(html, /content="Tom &amp; &quot;Jerry&quot;"/, 'attributes escaped');
  assert.match(html, /<a id="go" href="\/#\/account\?address=0x7c75[0-9a-f]+&amp;sub=s1">/, 'the target, for js/share.js');
  assert.match(html, /<script src="\/js\/share\.js" defer><\/script>/);
  assert.doesNotMatch(html, /http-equiv="refresh"/, 'no meta refresh: Facebook\'s crawler would follow it to the home page\'s card');
  assert.doesNotMatch(html, /<script>|<script [^>]*>[^<]|<style|\sstyle=|\son[a-z]+=/i, 'no inline code: the site\'s CSP would block it');
  assert.throws(() => K.sharePage({ kind: 'a', address: 'x"><script>', title: 't', description: 'd', image: 'i', target: '/' }));
});

test('the CSP in _headers allows index.html\'s inline script by its hash, and nothing else inline', () => {
  const lines = fs.readFileSync(path.join(root, '_headers'), 'utf8').split(/\r?\n/);
  const block = lines.slice(lines.indexOf('/*') + 1); const end = block.findIndex((l) => /^\S/.test(l) && !l.startsWith('#'));
  const csp = block.slice(0, end < 0 ? undefined : end).map((l) => /^\s+Content-Security-Policy:\s*(.+)$/.exec(l)).filter(Boolean).map((m) => m[1]);
  assert.equal(csp.length, 1, 'one policy for /*');
  const dir = Object.fromEntries(csp[0].split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const inline = [...index.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  assert.equal(inline.length, 1);
  assert.deepEqual(dir['script-src'], ["'self'", ...inline], 'script-src carries the hash of the inline script as it is now');
  assert.deepEqual(dir['style-src'], ["'self'"]);
  assert.doesNotMatch(csp[0], /unsafe-inline|unsafe-eval/);
  assert.doesNotMatch(index, /\sstyle=|\son[a-z]+=/i, 'no inline style or handler in index.html');
  assert.deepEqual(dir['object-src'], ["'none'"]); assert.deepEqual(dir['base-uri'], ["'none'"]);
});

test('the site card counts accounts and Predict activity', () => {
  const svg = K.siteSvg({ lb: { rows: [{ volumeAll: 1000 }, { volumeAll: 2500 }] }, pr: { agg: { totals: { bettors: 711, wagered: 350000 } } } }); clean(svg);
  assert.match(svg, />2</); assert.match(svg, />\$3,500</); assert.match(svg, />711</); assert.match(svg, />\$350\.0K</);
});
