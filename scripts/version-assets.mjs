#!/usr/bin/env node
/**
 * Run by the deploy after the cards (.github/workflows/pages.yml): every page's reference to one of the site's scripts or
 * stylesheets (js/, css/, vendor/) gets ?v=<the first 10 hex of the file's SHA-256>. A file that changes gets a new
 * address, so _headers can let browsers keep those files a year without asking again (immutable). The pages are every
 * .html in the folder: index.html, the share pages under a/, p/ and s/, x-bot/index.html.
 * Then every such reference is checked to carry the version of the file as it is: one without would be held a year by
 * browsers after its file changed, so the run fails instead (nothing deploys).
 *   node scripts/version-assets.mjs --dist dist
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** src="js/app.js", href="/css/app.css" and the like: [whole match, attribute, leading slash, path, query] */
export const REF = /\b(src|href)="(\/?)((?:js|css|vendor)\/[^"?#]+\.(?:js|css))(\?[^"]*)?"/g;

/** A page with each reference versioned by `hashOf(path)` (null: the file is missing, which throws) */
export function versionPage(html, hashOf) {
  return html.replace(REF, (m, attr, slash, p) => {
    const h = hashOf(p); if (!h) throw new Error(`${p} is referenced but not there`);
    return `${attr}="${slash}${p}?v=${h}"`;
  });
}
/** The references of a page that do not carry their file's version, in words (empty: all do) */
export function unversioned(html, hashOf) {
  const out = [];
  for (const m of html.matchAll(REF)) { const want = '?v=' + hashOf(m[3]); if (m[4] !== want) out.push(`${m[3]}${m[4] || ''} (want ${want})`); }
  return out;
}

function main(argv) {
  const at = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
  const dist = path.resolve(at('--dist', 'dist'));
  const memo = new Map();
  const hashOf = (p) => {
    if (!memo.has(p)) { const f = path.join(dist, p); memo.set(p, fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 10) : null); }
    return memo.get(p);
  };
  const pages = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.html')) pages.push(p); } };
  walk(dist);
  let changed = 0;
  for (const p of pages) { const a = fs.readFileSync(p, 'utf8'), b = versionPage(a, hashOf); if (a !== b) { fs.writeFileSync(p, b); changed++; } }
  const bad = [];
  for (const p of pages) for (const x of unversioned(fs.readFileSync(p, 'utf8'), hashOf)) bad.push(`${path.relative(dist, p)}: ${x}`);
  if (bad.length) { for (const b of bad.slice(0, 20)) console.error('::error::not versioned: ' + b); process.exit(1); }
  console.log(`versioned: ${memo.size} scripts and stylesheets in ${changed} of ${pages.length} pages`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
