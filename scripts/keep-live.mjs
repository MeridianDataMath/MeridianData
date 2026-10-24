#!/usr/bin/env node
/**
 * Run by the deploy (.github/workflows/pages.yml) after the builders: what a builder failed to write this run is taken
 * from the live site, so a failed step deploys the last good file again instead of dropping it.
 *   data/leaderboard.json   when the perps build wrote none: the published one, as it is (its builtAt says how old, and
 *                           the pages show that age)
 *   data/fx/                every exchange-rate source the FX build did not write: the published file, and its entry
 *                           in data/fx/index.json
 * What the live site does not have either stays out, as before; nothing here fails the deploy.
 *   node scripts/keep-live.mjs [--site https://…] [--data data]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const gh = !!process.env.GITHUB_ACTIONS;
const warn = (s) => console.warn((gh ? '::warning::' : '') + s);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };

/** The published file at `rel` as parsed JSON and its text; throws when it is not there or not JSON */
async function getLive(site, rel, fetchImpl) {
  const r = await fetchImpl(`${site}/${rel}`, { signal: AbortSignal.timeout(30000), headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = await r.text(); return { json: JSON.parse(text), text };
}

/** data/leaderboard.json from the live site when this run has none. → what was done, in words (null: nothing) */
export async function keepLeaderboard({ site, data, fetchImpl = globalThis.fetch }) {
  const f = path.join(data, 'leaderboard.json');
  // a file this run wrote stays, unless it is no leaderboard (a build stopped mid-write by an older builder, a full disk)
  let broken = false;
  if (fs.existsSync(f)) { try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (Array.isArray(j.rows) && j.rows.length) return null; } catch (_) {} broken = true; fs.rmSync(f, { force: true }); }
  const what = broken ? 'the perps build left a leaderboard.json that is not one' : 'the perps build wrote no leaderboard.json';
  try {
    const { json, text } = await getLive(site, 'data/leaderboard.json', fetchImpl);
    if (!Array.isArray(json.rows) || !json.rows.length) throw new Error('it has no rows');
    fs.mkdirSync(data, { recursive: true }); fs.writeFileSync(f, text);
    return `${what}: the published one (built ${new Date(json.builtAt).toISOString()}) goes out again`;
  } catch (e) { return `${what}, and the published one was not read (${e.message}): the pages build it in the browser`; }
}

/** The FX sources this run did not write, from the live site. → what was done, in words (null: nothing) */
export async function keepFx({ site, data, fetchImpl = globalThis.fetch }) {
  const dir = path.join(data, 'fx'); const idxFile = path.join(dir, 'index.json');
  let live; try { live = (await getLive(site, 'data/fx/index.json', fetchImpl)).json; } catch (e) { return fs.existsSync(idxFile) ? null : `no exchange rates this run, and the published ones were not read (${e.message})`; }
  const idx = readJson(idxFile) || { v: live.v, builtAt: live.builtAt, floor: live.floor, files: {} };
  idx.files = idx.files || {};
  const kept = [];
  for (const [id, entry] of Object.entries(live.files || {})) {
    if (idx.files[id] && fs.existsSync(path.join(dir, idx.files[id].file))) continue;   // written this run
    if (!entry || !/^[a-z0-9-]+\.json$/.test(String(entry.file))) continue;   // a plain name in data/fx/, nothing else
    try {
      const { json, text } = await getLive(site, 'data/fx/' + entry.file, fetchImpl);
      if (!Array.isArray(json.dates) || !json.dates.length) throw new Error('no dates');
      fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, entry.file), text);
      idx.files[id] = entry; if (idx.failed) delete idx.failed[id];
      kept.push(id);
    } catch (e) { warn(`exchange rates: ${id} neither built nor read from the site (${e.message})`); }
  }
  if (!kept.length) return null;
  if (idx.failed && !Object.keys(idx.failed).length) delete idx.failed;
  fs.writeFileSync(idxFile, JSON.stringify(idx));
  return `exchange rates: ${kept.join(', ')} not built this run; the published ${kept.length > 1 ? 'files go' : 'file goes'} out again`;
}

async function main(argv) {
  const at = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
  const site = String(at('--site', 'https://meridian.thedatahub.xyz')).replace(/\/+$/, ''), data = path.resolve(at('--data', 'data'));
  for (const said of [await keepLeaderboard({ site, data }), await keepFx({ site, data })]) if (said) warn(said);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch((e) => warn(`keep-live: ${e.message}`));
