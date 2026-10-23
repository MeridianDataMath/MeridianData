#!/usr/bin/env node
/**
 * The deploy's gate for the Predict snapshot (.github/workflows/pages.yml): copies it from a checkout of the snapshot
 * repository into data/, taking only the files the snapshot machine publishes, and refuses one that would break or
 * mislead the site. The snapshot is taken as data only: no link, no other name, nothing that is not JSON.
 *   node scripts/check-snapshot.mjs --from .snap-repo --to data
 * Refused (exit 1: nothing deploys, and the live site keeps the last good snapshot):
 *   - no predict.json, or one without Predict data
 *   - a file that is not JSON, or one over 25 MB (Cloudflare's limit for one file)
 *   - more than MAX_FILES files or MAX_BYTES in all (2,230 files and 29 MB on 2026-10-24): a runaway build or a
 *     tampered repository must not push the deploy past Cloudflare's 20,000-file limit
 * A left-out wallet's own file (U.EXCLUDED), which a snapshot from an older builder could hold, is not copied.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MAX_FILES = 8000, MAX_BYTES = 150e6, MAX_FILE = 25e6;
/** The names the snapshot machine publishes, relative with forward slashes */
export const NAME = /^(predict\.json|predict-status\.json|predict-ideas\.json|bettors\/0x[0-9a-f]{40}\.json|questions\/0x[0-9a-fA-F]{64}\.json|slips\/[0-9a-f]{2}\.json)$/;

/** The files to take from a snapshot checkout: regular files (a link is not one) with a published name, one level of
 *  folders deep, a left-out wallet's own file dropped. → relative names, sorted */
export function pick(dir, excluded) {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!rel && e.name !== '.git') walk(r); continue; }
      if (!e.isFile() || !NAME.test(r)) continue;
      const m = /^bettors\/(0x[0-9a-f]{40})\.json$/.exec(r);
      if (m && excluded && excluded.has(m[1])) continue;
      out.push(r);
    }
  };
  walk('');
  return out.sort();
}

/** What makes a snapshot unfit to deploy, in words (empty: fit). files: [{name, size, text}] */
export function problems(files) {
  const e = []; let bytes = 0;
  if (files.length > MAX_FILES) e.push(`${files.length} files, more than the ${MAX_FILES} a snapshot may have`);
  let predict = null;
  for (const f of files) {
    bytes += f.size;
    if (f.size > MAX_FILE) { e.push(`${f.name} is over 25 MB`); continue; }
    let j; try { j = JSON.parse(f.text); } catch (err) { e.push(`${f.name} is not JSON (${err.message})`); continue; }
    if (f.name === 'predict.json') predict = j;
  }
  if (bytes > MAX_BYTES) e.push(`${(bytes / 1e6).toFixed(0)} MB in all, more than the ${MAX_BYTES / 1e6} MB a snapshot may have`);
  if (!predict) { if (!files.some((f) => f.name === 'predict.json')) e.push('no predict.json'); }
  else if (!predict.agg || !(predict.predictions > 0)) e.push('predict.json holds no Predict data' + (predict.error ? ` (its build failed: ${String(predict.error).split('\n')[0].slice(0, 200)})` : ''));
  return e;
}

/** The left-out wallets, read from the site's own list in js/util.js (U.EXCLUDED = new Set([...]): the file needs a
 *  browser to run, so the list is read as text) */
export function excludedWallets() {
  const src = fs.readFileSync(path.join(root, 'js/util.js'), 'utf8');
  const m = /U\.EXCLUDED\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(src);
  if (!m) throw new Error('js/util.js: U.EXCLUDED not found');
  return new Set((m[1].match(/0x[0-9a-fA-F]{40}/g) || []).map((a) => a.toLowerCase()));
}

async function main(argv) {
  const at = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
  const from = path.resolve(at('--from', '.snap-repo')), to = path.resolve(at('--to', 'data'));
  const names = pick(from, excludedWallets());
  const files = names.map((name) => { const p = path.join(from, name); return { name, size: fs.statSync(p).size, text: fs.readFileSync(p, 'utf8') }; });
  const bad = problems(files);
  if (bad.length) { for (const b of bad) console.error(`::error::Predict snapshot refused: ${b}`); process.exit(1); }
  for (const f of files) { const p = path.join(to, f.name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, f.text); }
  const n = (dir) => names.filter((x) => x.startsWith(dir + '/')).length;
  let age = ''; try { const b = Number(JSON.parse(files.find((f) => f.name === 'predict-status.json').text).builtAt); if (b > 0) age = `, built ${((Date.now() - b) / 60000).toFixed(0)} min ago`; } catch (_) {}
  console.log(`Predict snapshot: ${files.length} files (${n('bettors')} wallet, ${n('questions')} question, ${n('slips')} slip files), ${(files.reduce((a, f) => a + f.size, 0) / 1e6).toFixed(1)} MB${age}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch((e) => { console.error(`::error::${e.message}`); process.exit(1); });
