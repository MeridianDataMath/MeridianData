#!/usr/bin/env node
/**
 * Link-preview cards for the published site (see scripts/cards.mjs). Reads the snapshots in <dist>/data and writes
 *   <dist>/cards/site.png                        the card of the home page and every page without its own
 *   <dist>/cards/a/<address>.png, <dist>/a/<address>.html   one per perps account on the leaderboard
 *   <dist>/cards/p/<address>.png, <dist>/p/<address>.html   one per Predict bettor and market maker
 *   <dist>/cards/s/<id>.png, <dist>/s/<id>.html             one per Predict slip worth sharing (open, just decided, a win)
 * The share pages are served at /a/<address>, /p/<address> and /s/<prediction id> (wrangler's auto-trailing-slash drops
 * ".html").
 * Run by the deploy workflow after the site is assembled:  node scripts/build-cards.mjs --dist dist --jobs <cores>
 *   --deadline <unix seconds>
 * --jobs N splits the cards over N processes (a card takes about 0.1 s of one core; there are a couple of thousand).
 * --deadline stops starting cards at that time, so the deploy after it still fits the job's time limit: the rest are
 * left out (their links fall back to the site's card), slips last and the oldest of them first.
 * Needs @resvg/resvg-js (npm ci at the repo root); the TrueType fonts are in scripts/fonts (Geist, SIL OFL 1.1).
 * Rendering is deterministic, so an unchanged card is byte-identical and the deploy does not upload it again.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeCards, SITE } from './cards.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes('--' + n) ? args[args.indexOf('--' + n) + 1] : d);
const dist = path.resolve(opt('dist', root));
const site = opt('site', SITE);
const only = opt('only', null);   // testing: render just this address or prediction id (and the site card)
const jobs = Math.max(1, Math.min(16, Math.floor(Number(opt('jobs', 1))) || 1));
const deadline = opt('deadline', null) ? Number(opt('deadline')) * 1000 : Infinity;
// --shard i/N (set by the parent below): this process renders every N-th card from the i-th; all of them walk the same
// rows in the same order (and judge slips at the same --now), so between them every card is made once
const [shardI, shardN] = (opt('shard', '0/1').split('/').map(Number));
const now = Number(opt('now', Date.now()));

if (jobs > 1 && !args.includes('--shard')) {
  const t0 = Date.now();
  const codes = await Promise.all(Array.from({ length: jobs }, (_, i) => new Promise((resolve) => {
    const c = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args, '--shard', `${i}/${jobs}`, '--now', String(now)], { stdio: ['ignore', 'inherit', 'inherit'] });
    c.on('error', (e) => { console.warn('shard', i, 'did not start:', e.message); resolve(1); });
    c.on('exit', (code) => resolve(code == null ? 1 : code));
  })));
  console.log(`cards: ${jobs} processes in ${((Date.now() - t0) / 1000).toFixed(1)}s` + (codes.some((c) => c) ? `, ${codes.filter((c) => c).length} failed` : ''));
  process.exit(codes.every((c) => c) ? 1 : 0);   // some cards beat none: the step fails only when every process did
}

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
const t0 = Date.now(); let n = 0, failed = 0, bad = 0, late = 0, turn = 0;
const card = (rel, svg) => { try { write(rel, render(svg)); n++; return rel + '?v=' + ver(svg); } catch (e) { failed++; console.warn('card failed', rel, e.message); return null; } };
const first = shardI === 0;   // the one process that makes the site card and reports skipped rows
/** Is the next card this process's (and is there still time for it)? Called once per card, in the same order everywhere. */
const mine = () => { if ((turn++ % shardN) !== shardI) return false; if (Date.now() > deadline) { late++; return false; } return true; };
// addresses come from the API (through the snapshots) and become file paths and page URLs: anything but a plain address is
// skipped before a path is built from it (JSON.stringify keeps a hostile value on one log line)
const isAddr = (a) => /^0x[0-9a-f]{40}$/.test(a);
const skip = (what, v) => { bad++; if (first) console.warn('skipped', what, JSON.stringify(String(v).slice(0, 100))); return false; };
// one row that fails (its card or its page) must not take every row after it down with it
const each = (what, a, fn) => { try { return fn(); } catch (e) { failed++; console.warn(what, 'failed', a, e.message); return false; } };

const lb = readJson(path.join(dist, 'data', 'leaderboard.json'));
const pr = readJson(path.join(dist, 'data', 'predict.json'));
// perps rows are checked before the site card adds them up, so a broken row cannot cost that card either
if (lb && Array.isArray(lb.rows)) lb.rows = lb.rows.filter((r) => isAddr(String((r && r.account) || '').toLowerCase()) || skip('account', r && r.account));
if (first) each('site card', 'site', () => card('cards/site.png', K.siteSvg({ lb, pr })));

// perps accounts: one card per address (the leaderboard has one row per subaccount; the busiest one represents it)
let accounts = 0;
if (lb && Array.isArray(lb.rows)) {
  const byAddr = new Map();
  for (const r of lb.rows) { const a = String(r.account).toLowerCase(); const cur = byAddr.get(a); if (!cur || (Number(r.volumeAll) || 0) > (Number(cur.volumeAll) || 0)) byAddr.set(a, Object.assign({}, r, { account: a })); }
  for (const [a, r] of byAddr) {
    if (only && a !== only) continue;
    if (!mine()) continue;
    const ok = each('account', a, () => {
      const image = card(`cards/a/${a}.png`, K.accountSvg(r)); if (!image) return false;
      const text = K.accountText(r);
      write(`a/${a}.html`, K.sharePage({ kind: 'a', address: a, title: text.title, description: text.description, image, target: `/#/account?address=${a}&sub=${encodeURIComponent(r.sid)}` }));
      return true;
    });
    if (ok) accounts++;
  }
} else if (first) console.warn('no leaderboard snapshot: no account cards');

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
    if (!mine()) continue;
    const ok = each('wallet', a, () => {
      const file = both.has(a) ? null : readJson(path.join(dist, 'data', 'bettors', a + '.json'));
      const image = card(`cards/p/${a}.png`, K.walletSvg(Object.assign({}, r, { address: a }), file, isMaker)); if (!image) return false;
      const text = K.walletText(r, isMaker);
      write(`p/${a}.html`, K.sharePage({ kind: 'p', address: a, title: text.title, description: text.description, image, target: `/#/predict/bettor?address=${a}` }));
      return true;
    });
    if (ok) wallets++;
  }
} else if (first) console.warn('no Predict snapshot: no wallet cards');

// Predict slips (the files in data/slips) that people share (js/cards.js slipCardWanted: open, decided in the last week, a
// recent or big win), open ones first and then the most recently decided, so a deadline leaves out the oldest; any other
// slip's link still works, with the site's card
let slips = 0;
const slipDir = path.join(dist, 'data', 'slips');
if (fs.existsSync(slipDir)) {
  const isId = (id) => /^0x[0-9a-f]{64}$/.test(id);
  const list = [];
  for (const f of fs.readdirSync(slipDir).filter((x) => /^[0-9a-f]{2}\.json$/.test(x)).sort()) {
    const file = readJson(path.join(slipDir, f));
    for (const r of Object.values((file && file.slips) || {})) {
      let s; try { s = MD.predict.full(r); } catch (e) { if (first) { failed++; console.warn('slip unreadable in', f, e.message); } continue; }
      const id = String((s && s.id) || '').toLowerCase(); if (!isId(id)) { skip('slip', s && s.id); continue; }
      if (only && id !== only) continue;
      if (K.slipCardWanted(s, now)) list.push([id, s, s.decided ? (s.decidedAt || MD.predict.decidedAt(s) || 0) : Infinity]);
    }
  }
  list.sort((a, b) => b[2] - a[2] || (a[0] < b[0] ? -1 : 1));
  for (const [id, s] of list) {
    if (!mine()) continue;
    const ok = each('slip', id, () => {
      const image = card(`cards/s/${id}.png`, K.slipSvg(s, { now })); if (!image) return false;
      const text = K.slipText(s, now);
      write(`s/${id}.html`, K.sharePage({ kind: 's', id, title: text.title, description: text.description, image, target: `/#/predict/p/${id}` }));
      return true;
    });
    if (ok) slips++;
  }
} else if (first) console.warn('no slip files: no slip cards');

console.log(`cards${shardN > 1 ? ` ${shardI + 1}/${shardN}` : ''}: ${n} images (${accounts} accounts, ${wallets} Predict wallets, ${slips} slips${first ? ', site' : ''}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`
  + (failed ? `, ${failed} failed` : '') + (bad && first ? `, ${bad} rows skipped (not an address)` : '') + (late ? `, ${late} left out at the deadline` : ''));
if (failed && !n) process.exit(1);
