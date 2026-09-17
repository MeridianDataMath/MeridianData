#!/usr/bin/env node
/**
 * Builds the shared snapshots the site serves to every visitor:
 *   data/leaderboard.json — perps leaderboard (every subaccount, all intervals)
 *   data/predict.json     — Meridian Predict aggregates (bettors, makers, vig, categories, combos, daily series, tape)
 * Reuses the site's own browser modules so the numbers match a local build.
 * Runs in GitHub Actions (see .github/workflows/pages.yml). Needs Node 18+ (global fetch).
 *
 *   node scripts/build-snapshot.mjs                 # both
 *   node scripts/build-snapshot.mjs --perps         # leaderboard only (what GitHub Actions runs: the Predict API
 *                                                   #   returns 403 to datacenter IPs, so that snapshot is built on a PC)
 *   node scripts/build-snapshot.mjs --predict --out <dir>
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes('--' + n);
const outDir = args.includes('--out') ? path.resolve(args[args.indexOf('--out') + 1]) : path.join(root, 'data');
const doPredict = flag('predict') || !flag('perps');
const doPerps = flag('perps') || !flag('predict');

// minimal browser shims for the classic-script modules
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
for (const f of ['js/util.js', 'js/api.js', 'js/analytics.js', 'js/predict/api.js', 'js/predict/analytics.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
}
const { MD } = globalThis;
const A = MD.api, AN = MD.analytics, U = MD.util, P = MD.predict;
fs.mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------- Predict
async function buildPredict() {
  const t0 = Date.now();
  const toSec = Math.floor(Date.now() / 1000);
  P.minIntervalMs = 330;                       // ≈180 requests/min, under the API's 200/min per IP
  // sanity probe first so a blocked runner fails loudly with the real reason
  const probe = await P.predictionsCount();
  console.log(`  predict: API reachable, ${probe} predictions in total`);
  let lastLog = 0;
  const raw = await P.predictionsWindowed({
    fromSec: P.LAUNCH_SEC, toSec, windows: 24, concurrency: 4, maxPagesPerWindow: 600,
    onProgress: (n) => { if (Date.now() - lastLog > 10000) { lastLog = Date.now(); console.log(`  predict: ${n} predictions so far (${P.stats.requests} requests, ${P.stats.retries} retries)`); } },
  });
  const norms = raw.map(P.norm);
  const agg = P.aggregate(norms, { tapeSize: 100 });
  let counts = null;
  try { counts = await P.conditionCounts(); } catch (e) { console.warn('predict: condition counts failed', e.message); }
  const out = { builtAt: Date.now(), source: process.env.GITHUB_ACTIONS ? 'github-actions' : 'pc', fromSec: P.LAUNCH_SEC, predictions: norms.length, apiTotal: probe, questions: counts ? { all: counts.all.totalCount, open: counts.open.totalCount, settled: counts.settled.totalCount } : null, agg, durationMs: Date.now() - t0, requests: P.stats.requests, retries: P.stats.retries };
  fs.writeFileSync(path.join(outDir, 'predict.json'), JSON.stringify(out));
  console.log(`wrote ${path.join(outDir, 'predict.json')}: ${norms.length} predictions (API says ${probe}), ${agg.bettors.length} bettors, ${agg.makers.length} makers, ${P.stats.requests} requests, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
if (doPredict) {
  try { await buildPredict(); }
  catch (e) {
    // No agg → the site falls back; the error is published so it can be read without Action logs.
    console.warn('predict snapshot failed:', e && e.stack);
    fs.writeFileSync(path.join(outDir, 'predict.json'), JSON.stringify({ builtAt: Date.now(), error: String(e && (e.stack || e.message || e)), requests: P.stats.requests, retries: P.stats.retries }));
    if (!doPerps) process.exit(1);
  }
}
if (!doPerps) process.exit(0);

// ------------------------------------------------------------------- Perps
const started = Date.now();
const ctx = { signal: new AbortController().signal };
const ref = await A.ref(ctx);
const subs = await A.allSubaccounts({ signal: ctx.signal, ttl: 0 });
const prices = await A.marketPrices(ref.active.map((p) => p.id), ctx);
console.log(`markets=${ref.active.length} accounts=${subs.length}`);

const results = await U.pLimit(
  subs.map((sa) => () => AN.buildLeaderboardRow(sa, ref, prices, ctx)),
  4,
  (done, total) => { if (done % 25 === 0 || done === total) console.log(`  ${done}/${total}`); },
);
const rows = []; let failed = 0;
results.forEach((r, i) => { if (r.ok) rows.push(r.value); else { failed++; console.warn(`row failed ${subs[i].id}: ${r.error && r.error.message}`); } });

const out = { builtAt: Date.now(), rows, partial: failed > 0, source: 'github-actions', accounts: subs.length, failed, durationMs: Date.now() - started };
fs.writeFileSync(path.join(outDir, 'leaderboard.json'), JSON.stringify(out));
console.log(`wrote ${path.join(outDir, 'leaderboard.json')}: ${rows.length} rows, ${failed} failed, ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (!rows.length) process.exit(1);
