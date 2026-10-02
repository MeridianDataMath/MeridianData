// Link-preview cards: the SVG artwork and the share pages behind /a/<address>, /p/<address> and /s/<prediction id>
// (scripts/cards.mjs).
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

test('a wallet\'s curve adds its decided results in time and ends at its PnL; a truncated file\'s is the snapshot\'s', () => {
  const T = Date.UTC(2026, 7, 1), D = 86400000;
  const file = { address: ME, truncated: false, trades: [], predictions: [pred('w', 10, 30, 'PREDICTOR_WINS', T), pred('l', 5, 8, 'COUNTERPARTY_WINS', T + D), pred('o', 3, 4, null, T + 2 * D)] };
  const c = K.walletCurve(file, ME);
  assert.equal(c[c.length - 1][1], 30 - 5); assert.equal(c[0][1], 0); assert.ok(c.every((p, i) => !i || p[0] >= c[i - 1][0]), 'in time order');
  const maker = K.walletCurve(file, MAKER); assert.equal(maker[maker.length - 1][1], -(30 - 5), 'the maker\'s side is the mirror');
  // a truncated file holds only its newest predictions: never a curve from them, the snapshot's from every prediction when it has one
  assert.equal(K.walletCurve(Object.assign({}, file, { truncated: true }), ME), null);
  const full = [[1785000000, 0], [1785500000, -3360], [1786000000, 13368.5]];
  assert.deepEqual(K.walletCurve(Object.assign({}, file, { truncated: true, curve: full }), ME), full);
  const svg = K.walletSvg({ address: ME, n: 3, won: 1, lost: 1, pnl: 25, roi: 166.7, wagered: 18, winRate: 50, avgOdds: 0.3, first: T, topCat: 'Sports' }, file, false); clean(svg);
  assert.match(svg, /BETTOR · MERIDIAN PREDICT/); assert.match(svg, />1W \/ 1L</); assert.match(svg, /Top category Sports/, 'a plurality, not "mostly"');
  const row = { address: MAKER, n: 5565, won: 4049, lost: 1426, pnl: 13368.5, roi: 1, wagered: 1550834, winRate: 74, first: T };
  const noCurve = K.walletSvg(row, Object.assign({}, file, { truncated: true }), true); clean(noCurve);
  assert.match(noCurve, /Curve not drawn: over 600 predictions/, 'the reason, not "not enough history"'); assert.doesNotMatch(noCurve, /Not enough history/);
  assert.doesNotMatch(K.walletSvg(row, Object.assign({}, file, { truncated: true, curve: full }), true), /Curve not drawn/);
});

test('a one-off counterparty (under P.MAKER_MIN predictions) is not called a market maker (0x3106…: one $1 test)', () => {
  const T = Date.UTC(2026, 8, 29);
  const one = { address: MAKER, n: 1, won: 0, lost: 1, pnl: -1, roi: -100, wagered: 1, winRate: 0, first: T };
  const svg = K.walletSvg(one, null, true); clean(svg);
  assert.match(svg, /COUNTERPARTY · MERIDIAN PREDICT/); assert.match(svg, /COUNTERPARTY PNL · ALL TIME/); assert.match(svg, /One-off counterparty since Sep 29, 2026/);
  assert.doesNotMatch(svg, /MARKET MAKER|Market maker/);
  const t = K.walletText(one, true);
  assert.match(t.description, /^1 prediction taken · /); assert.match(t.title, / counterparty PnL$/);
  const mm = Object.assign({}, one, { n: 16 });
  assert.match(K.walletSvg(mm, null, true), /MARKET MAKER · MERIDIAN PREDICT/); assert.match(K.walletSvg(mm, null, true), /Market maker since/);
  assert.match(K.walletText(mm, true).title, / maker PnL$/); assert.match(K.walletText(mm, true).description, /^16 predictions taken/);
  assert.match(K.walletText({ address: ME, n: 1, won: 1, lost: 0, pnl: 25, wagered: 25, topCat: 'Sports' }, false).description, /^1 prediction · .* · top category Sports\./);
});

test('a long curve is thinned to 90 points and keeps its real high and low; one point per second', () => {
  const T = Date.UTC(2026, 7, 1), H1 = 3600000;
  // 200 results an hour apart swinging between $0 and $1, with a $51 high at the 60th and a −$40 low at the 150th
  // (both fell between the evenly spaced samples, so the card's peak read $1), ending at $7
  const v = Array.from({ length: 201 }, (_, j) => (j === 60 ? 51 : j === 150 ? -40 : j === 200 ? 7 : j % 2));
  const preds = v.slice(1).map((y, i) => { const d = y - v[i]; return d > 0 ? pred('p' + i, 1, d, 'PREDICTOR_WINS', T + i * H1) : pred('p' + i, -d, 1, 'COUNTERPARTY_WINS', T + i * H1); });
  const c = K.walletCurve({ address: ME, truncated: false, trades: [], predictions: preds }, ME);
  assert.ok(c.length <= 90, String(c.length));
  assert.equal(Math.max(...c.map((p) => p[1])), 51); assert.equal(Math.min(...c.map((p) => p[1])), -40);
  assert.equal(c[c.length - 1][1], 7, 'ends at the total'); assert.equal(c[0][1], 0);
  assert.ok(c.every((p, i) => !i || p[0] > c[i - 1][0]), 'in time order, one point per moment');
  assert.match(K.walletSvg({ address: ME, n: 200, won: 100, lost: 100, pnl: 7, roi: 1, wagered: 200, winRate: 50, avgOdds: 0.5, first: T }, { truncated: false, trades: [], predictions: preds }, false), />peak \+\$51\.00</);
  // two results settled in the same second have no order between them: one point, after both
  const same = K.walletCurve({ address: ME, truncated: false, trades: [], predictions: [pred('s1', 10, 30, 'PREDICTOR_WINS', T), pred('s2', 5, 8, 'COUNTERPARTY_WINS', T)] }, ME);
  assert.deepEqual(same.map((p) => p[1]), [0, 25]);
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

// a prediction as the slip files carry it (P.slim), legs [question, YES?] each
const ID = '0x' + 'ab'.repeat(32);
const slip = (stake, cp, verdict, t, legs) => MD.predict.full(MD.predict.slim(MD.predict.norm({ predictionId: ID, predictor: ME, counterparty: MAKER, predictorCollateral: wei(stake), counterpartyCollateral: wei(cp), settled: false, result: null,
  createdAt: new Date(t).toISOString(), settledAt: null, pickConfig: { pickConfigId: 'pc', resolved: !!verdict, result: verdict,
    picks: legs.map(([q, yes], i) => ({ conditionId: 'c' + i, predictedOutcome: yes ? 'YES' : 'NO', condition: { question: q, endTime: Math.floor((t + 86400000) / 1000) } })) } })));

test('a slip card leads with the result: net PnL once won, the stake once lost, the payout while open', () => {
  const T = Date.UTC(2026, 8, 27);
  const won = slip(25, 943.5, 'PREDICTOR_WINS', T, [['Will France win on 2026-09-28?', true], ['Uruguay covers -1.5 spread vs Korea Republic?', true], ['Will Armenia vs Montenegro total be over 3.5?', true]]);
  let svg = K.slipSvg(won); clean(svg);
  assert.match(svg, />\+\$944</, 'whole dollars from $100 up'); assert.match(svg, />Won · 3-leg combo</); assert.match(svg, /#34d487/);
  assert.match(svg, />\$969 paid on a \$25\.00 stake</); assert.match(svg, />38\.74×</); assert.match(svg, />SETTLED</);
  assert.match(svg, />Uruguay covers -1\.5 spread vs Korea</, 'a long question wraps'); assert.match(svg, />Republic\?</);
  assert.match(K.slipText(won).title, /^Won \+\$944 on a \$25\.00 3-leg combo \(38\.74×\) · Meridian Predict$/);

  const lost = slip(25, 1249, 'COUNTERPARTY_WINS', T, [['A?', true], ['B?', false], ['C?', true]]);
  svg = K.slipSvg(lost); clean(svg);
  assert.match(svg, />-\$25\.00</); assert.match(svg, /#ef454a/); assert.match(svg, /would have paid \$1,274/);

  const open = slip(5, 2.78, null, Date.now(), [['Will the price of Bitcoin be between $82,000 and $84,000 on September 30?', true]]);
  svg = K.slipSvg(open); clean(svg);
  assert.match(svg, />PAYS</); assert.match(svg, />\$7\.78</); assert.match(svg, />Live · Single</); assert.match(svg, /on a \$5\.00 stake, if it wins/);
  // Meridian's end time is a listed end, not a betting cutoff: Meridian has taken bets after it
  assert.match(svg, />LISTED END</); assert.doesNotMatch(svg, /BETS CLOS/); assert.match(svg, />Copy this slip on MeridianDataHub</); assert.doesNotMatch(svg, /one click/);
  assert.match(K.slipText(open).description, /^YES Will the price of Bitcoin.*Copy it on MeridianDataHub\.$/);
  assert.match(K.slipText(open).description, /September 30\? Placed /, 'no "?." after a question'); assert.doesNotMatch(K.slipText(open).description, /\?\./);
  // "pays" the payout: the dialog's "To win" is the profit, so the preview does not say "to win" for the payout
  assert.equal(K.slipText(open).title, '$5.00 single at 1.56×: pays $7.78 if it wins · Meridian Predict');

  const shut = slip(5, 2.78, null, Date.now() - 2 * 86400000, [['A?', true], ['B?', true]]);   // a leg past its listed end, not decided yet
  svg = K.slipSvg(shut); clean(svg);
  assert.match(svg, />LISTED END</); assert.doesNotMatch(svg, /BETS CLOS/); assert.match(svg, />Awaiting result · 2-leg combo</); assert.doesNotMatch(svg, />Live · /);
  assert.doesNotMatch(svg, /Copy this slip/); assert.doesNotMatch(K.slipText(shut).description, /Copy it/);

  const many = slip(4, 4.72, 'PREDICTOR_WINS', T,Array.from({ length: 9 }, (_, i) => ['Question number ' + i + '?', i % 2 === 0]));
  svg = K.slipSvg(many); clean(svg);
  assert.match(svg, />\+ 5 more legs</, 'four legs shown, the rest counted'); assert.equal((svg.match(/>Question number \d\?</g) || []).length, 4);
  assert.match(K.slipText(many).description, / · \+5 more\. Placed /, 'the full stop stays after the count');
});

test('a bettor who sold its tokens: the card and its link preview show its own result, as the slip page does', () => {
  const T = Date.UTC(2026, 7, 3);
  // 0xd3cccb0f…: $500 at 1.12×, all 561.98 tokens sold for $25 before the verdict, so the bettor made −$475 and the
  // buyer collected the payout (the card said "Won +$61.98")
  const won = Object.assign(slip(500, 61.9835, 'PREDICTOR_WINS', T, [['Strait of Hormuz traffic returns to normal by August 31?', false]]), { held: 0, tradedPnl: -475 });
  let svg = K.slipSvg(won); clean(svg);
  assert.match(svg, />-\$475</); assert.doesNotMatch(svg, />\+\$61\.98</);
  assert.match(svg, />WON · BETTOR PNL INCL\. TOKEN SALE</); assert.match(svg, />\$562 paid on a \$500 stake to the token buyer</);
  assert.match(svg, /<text [^>]*font-weight="700" font-size="\d+" fill="#ef454a">-\$475</, 'its own loss in red, though the slip won');
  assert.match(K.slipText(won).title, /^\$500 single \(1\.12×\) won; the bettor sold its tokens: bettor PnL -\$475 · Meridian Predict$/);
  // 0x31952f74…: lost, 96% of the tokens sold first, +$1.45 for the bettor
  const lost = Object.assign(slip(9.4, 31.4, 'COUNTERPARTY_WINS', T, [['A?', true]]), { held: 0.0435, tradedPnl: 1.4501 });
  svg = K.slipSvg(lost); clean(svg);
  assert.match(svg, />\+\$1\.45</); assert.match(svg, />LOST · BETTOR PNL INCL\. TOKEN SALE</); assert.match(svg, /96% of its tokens</);
  assert.doesNotMatch(svg, /token buyer/, 'a lost slip pays no buyer');
  assert.match(K.slipText(lost).title, /: lost; the bettor sold 96% of its tokens: bettor PnL \+\$1\.45 · Meridian Predict$/);
});

test('a near-certain slip never reads 100% or 1.00×; a win Meridian has not settled the leg of is "paid as won"', () => {
  // 0x5e598788…: $300 against $0.0228, odds 0.99992
  const sure = slip(300, 0.0228, null, Date.now(), [['Q?', true]]);
  const svg = K.slipSvg(sure); clean(svg);
  assert.match(svg, />99\.9%</); assert.doesNotMatch(svg, />100%</); assert.match(svg, />1\.0001×</);
  assert.match(K.slipText(sure).title, / at 1\.0001×: /);
  // 0x73f05a88…: the $1 test against 0x3106…, paid as won while its question (Flamengo's title) is still open
  const paid = slip(1, 1, 'PREDICTOR_WINS', Date.UTC(2026, 8, 29), [['Will Flamengo win Brazil Série A?', true]]);
  assert.match(K.slipSvg(paid), />paid as won · Other</);
  paid.picks[0].settled = true; paid.picks[0].resolvedToYes = true;
  assert.match(K.slipSvg(paid), />won · Other</); assert.doesNotMatch(K.slipSvg(paid), /paid as won/);
});

test('the deploy makes cards for the slips people share', () => {
  const now = Date.UTC(2026, 8, 30), D = 864e5;
  const W = (o) => K.slipCardWanted(Object.assign({ decided: true, won: false, pnl: 0 }, o), now);
  assert.equal(W({ decided: false }), true, 'open');
  assert.equal(W({ decidedAt: now - 3 * D }), true, 'a loss of this week');
  assert.equal(W({ decidedAt: now - 10 * D }), false, 'an older loss');
  assert.equal(W({ won: true, pnl: 20, decidedAt: now - 20 * D }), true, 'a win of the last 30 days');
  assert.equal(W({ won: true, pnl: 20, decidedAt: now - 40 * D }), false);
  assert.equal(W({ won: true, pnl: 800, decidedAt: now - 90 * D }), true, 'a big win, however old');
  // P.BIG_WIN is net PnL, a bettor's token sale included
  assert.equal(W({ won: true, pnl: 20, tradedPnl: 600, decidedAt: now - 90 * D }), true, 'a big win of the bettor\'s own');
  assert.equal(W({ won: true, pnl: 600, tradedPnl: 20, decidedAt: now - 90 * D }), false, 'payout − stake over $500, but the bettor sold first');
});

test('a slip\'s share page lives at /s/<prediction id> and opens the slip page', () => {
  const html = K.sharePage({ kind: 's', id: ID, title: 'Won +$944', description: 'd', image: 'cards/s/' + ID + '.png?v=abc', target: '/#/predict/p/' + ID });
  assert.match(html, new RegExp(`<meta property="og:url" content="https://example\\.test/s/${ID}">`));
  assert.match(html, /<meta property="og:type" content="article">/);
  assert.match(html, new RegExp(`<a id="go" href="/#/predict/p/${ID}">`));
  assert.throws(() => K.sharePage({ kind: 's', id: '0x12', title: 't', description: 'd', image: 'i', target: '/' }));
  assert.throws(() => K.sharePage({ kind: 's', id: ID.toUpperCase().replace('0X', '0x') + '"', title: 't', description: 'd', image: 'i', target: '/' }));
});

test('index.html sends /a/, /p/, /s/ and /predict/p/ paths on to their hash routes', () => {
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const code = /<script>([\s\S]*?)<\/script>/.exec(index)[1];
  const go = (pathname) => { let to = null; new Function('location', code)({ pathname, replace: (u) => { to = u; } }); return to; };
  assert.equal(go('/a/' + A1.toUpperCase().replace('0X', '0x')), '/#/account?address=' + A1);
  assert.equal(go('/p/' + A1), '/#/predict/bettor?address=' + A1);
  assert.equal(go('/s/' + ID), '/#/predict/p/' + ID);
  assert.equal(go('/predict/p/' + ID + '/'), '/#/predict/p/' + ID);
  assert.equal(go('/s/0x12'), null); assert.equal(go('/'), null);
});

test('the site card counts accounts and Predict activity', () => {
  const svg = K.siteSvg({ lb: { rows: [{ volumeAll: 1000 }, { volumeAll: 2500 }] }, pr: { agg: { totals: { bettors: 711, wagered: 350000 } } } }); clean(svg);
  assert.match(svg, />2</); assert.match(svg, />\$3,500</); assert.match(svg, />711</); assert.match(svg, />\$350\.0K</);
});

test('a self-matched slip (one wallet on both sides) says so on its card and in its link preview', () => {
  const T = Date.UTC(2026, 6, 9);
  const n = MD.predict.full(MD.predict.slim(MD.predict.norm({ predictionId: ID, predictor: ME, counterparty: ME, predictorCollateral: wei(0.5), counterpartyCollateral: wei(0.5), settled: false, result: null,
    createdAt: new Date(T).toISOString(), settledAt: null, pickConfig: { pickConfigId: 'pc', resolved: true, result: 'PREDICTOR_WINS',
      picks: [{ conditionId: 'c0', predictedOutcome: 'YES', condition: { question: 'Spain beats Belgium?', endTime: Math.floor((T + 86400000) / 1000) } }] } })));
  const svg = K.slipSvg(n); clean(svg);
  assert.match(svg, />WON · BETTOR SIDE</); assert.match(svg.replace(/<\/text><text[^>]*>/g, ' '), /self-matched: one wallet on both sides/, 'the sub-line (wrapped over two lines)');
  assert.match(K.slipText(n).title, /self-matched \(one wallet on both sides\)$/);
});