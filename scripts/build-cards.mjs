#!/usr/bin/env node
/**
 * Link-preview cards for the published site (see scripts/cards.mjs). Reads the snapshots in <dist>/data and writes
 *   <dist>/cards/site.png                        the card of the home page and every page without its own
 *   <dist>/cards/a/<address>.png, <dist>/a/<address>.html   one per perps account on the leaderboard
 *   <dist>/cards/p/<address>.png, <dist>/p/<address>.html   one per Predict bettor and market maker
 * The share pages are served at /a/<address> and /p/<address> (wrangler's auto-trailing-slash drops ".html").
 * Run by the deploy workflow after the site is assembled:  node scripts/build-cards.mjs --dist dist
 * Needs @resvg/resvg-js (npm ci at the repo root); the TrueType fonts are in scripts/fonts (Geist, SIL OFL 1.1).
 * Rendering is deterministic, so an unchanged card is byte-identical and the deploy does not upload it again.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { makeCards, SITE } from './cards.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes('--' + n) ? args[args.indexOf('--' + n) + 1] : d);
const dist = path.resolve(opt('dist', root));
const site = opt('site', SITE);
const only = opt('only', null);   // testing: render just this address (and the site card)

globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
for (const f of ['js/util.js', 'js/api.js', 'js/analytics.js', 'js/predict/api.js', 'js/predict/analytics.js']) vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
const { MD } = globalThis;
const K = makeCards({ U: MD.util, P: MD.predict, site });

const { Resvg } = await import('@resvg/resvg-js');
const fontDir = path.join(root, 'scripts', 'fonts');
const fontFiles = fs.readdirSync(fontDir).filter((f) => f.endsWith('.ttf')).map((f) => path.join(fontDir, f));
const render = (svg) => new Resvg(svg, { fitTo: { mode: 'original' }, background: '#09090a', font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Geist' } }).render().asPng();

const readJson = (p) => { try { const t = fs.readFileSync(p, 'utf8'); return t.trimStart().startsWith('{') ? JSON.parse(t) : null; } catch (_) { return null; } };
const write = (rel, data) => { const p = path.join(dist, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
const ver = (svg) => crypto.createHash('sha1').update(svg).digest('hex').slice(0, 10);   // the image URL changes only when the image does
const t0 = Date.now(); let n = 0, failed = 0, bad = 0;
const card = (rel, svg) => { try { write(rel, render(svg)); n++; return rel + '?v=' + ver(svg); } catch (e) { failed++; console.warn('card failed', rel, e.message); return null; } };
// addresses come from the API (through the snapshots) and become file paths and page URLs: anything but a plain address is
// skipped before a path is built from it (JSON.stringify keeps a hostile value on one log line)
const isAddr = (a) => /^0x[0-9a-f]{40}$/.test(a);
const skip = (what, v) => { bad++; console.warn('skipped', what, JSON.stringify(String(v).slice(0, 100))); return false; };
// one row that fails (its card or its page) must not take every row after it down with it
const each = (what, a, fn) => { try { return fn(); } catch (e) { failed++; console.warn(what, 'failed', a, e.message); return false; } };

const lb = readJson(path.join(dist, 'data', 'leaderboard.json'));
const pr = readJson(path.join(dist, 'data', 'predict.json'));
// perps rows are checked before the site card adds them up, so a broken row cannot cost that card either
if (lb && Array.isArray(lb.rows)) lb.rows = lb.rows.filter((r) => isAddr(String((r && r.account) || '').toLowerCase()) || skip('account', r && r.account));
each('site card', 'site', () => card('cards/site.png', K.siteSvg({ lb, pr })));

// perps accounts: one card per address (the leaderboard has one row per subaccount; the busiest one represents it)
let accounts = 0;
if (lb && Array.isArray(lb.rows)) {
  const byAddr = new Map();
  for (const r of lb.rows) { const a = String(r.account).toLowerCase(); const cur = byAddr.get(a); if (!cur || (Number(r.volumeAll) || 0) > (Number(cur.volumeAll) || 0)) byAddr.set(a, Object.assign({}, r, { account: a })); }
  for (const [a, r] of byAddr) {
    if (only && a !== only) continue;
    const ok = each('account', a, () => {
      const image = card(`cards/a/${a}.png`, K.accountSvg(r)); if (!image) return false;
      const text = K.accountText(r);
      write(`a/${a}.html`, K.sharePage({ kind: 'a', address: a, title: text.title, description: text.description, image, target: `/#/account?address=${a}&sub=${encodeURIComponent(r.sid)}` }));
      return true;
    });
    if (ok) accounts++;
  }
} else console.warn('no leaderboard snapshot: no account cards');

// Predict wallets: every bettor and market maker in the snapshot, with the wallet's file for its curve
let wallets = 0;
if (pr && pr.agg) {
  const rows = [].concat((pr.agg.makers || []).map((r) => [r, true]), (pr.agg.bettors || []).map((r) => [r, false]));
  // a wallet on both sides (rare) gets its maker card, without the curve: the file's curve mixes both roles
  const lc = (r) => String((r && r.address) || '').toLowerCase();
  const makerSet = new Set((pr.agg.makers || []).map(lc)), both = new Set((pr.agg.bettors || []).map(lc).filter((a) => makerSet.has(a)));
  const seen = new Set();
  for (const [r, isMaker] of rows) {
    const a = lc(r); if (!isAddr(a)) { skip('wallet', r && r.address); continue; }
    if (seen.has(a)) continue; seen.add(a);
    if (only && a !== only) continue;
    const ok = each('wallet', a, () => {
      const file = both.has(a) ? null : readJson(path.join(dist, 'data', 'bettors', a + '.json'));
      const image = card(`cards/p/${a}.png`, K.walletSvg(Object.assign({}, r, { address: a }), file, isMaker)); if (!image) return false;
      const text = K.walletText(r, isMaker);
      write(`p/${a}.html`, K.sharePage({ kind: 'p', address: a, title: text.title, description: text.description, image, target: `/#/predict/bettor?address=${a}` }));
      return true;
    });
    if (ok) wallets++;
  }
} else console.warn('no Predict snapshot: no wallet cards');

console.log(`cards: ${n} images (${accounts} accounts, ${wallets} Predict wallets, site) in ${((Date.now() - t0) / 1000).toFixed(1)}s` + (failed ? `, ${failed} failed` : '') + (bad ? `, ${bad} rows skipped (not an address)` : ''));
if (failed && !n) process.exit(1);
