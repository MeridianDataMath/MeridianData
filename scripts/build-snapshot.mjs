#!/usr/bin/env node
/**
 * Builds the shared snapshots the site serves to every visitor:
 *   data/leaderboard.json — perps leaderboard (every subaccount, all intervals)
 *   data/predict.json     — Meridian Predict aggregates (bettors, makers, vig, categories, combos, daily series, tape)
 * Reuses the site's own browser modules so the numbers match a local build.
 * Runs in GitHub Actions (see .github/workflows/pages.yml). Needs Node 18+ (global fetch).
 *
 *   node scripts/build-snapshot.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// minimal browser shims for the classic-script modules
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
for (const f of ['js/util.js', 'js/api.js', 'js/analytics.js', 'js/predict/api.js', 'js/predict/analytics.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
}
const { MD } = globalThis;
const A = MD.api, AN = MD.analytics, U = MD.util, P = MD.predict;
fs.mkdirSync(path.join(root, 'data'), { recursive: true });

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
  const out = { builtAt: Date.now(), source: 'github-actions', fromSec: P.LAUNCH_SEC, predictions: norms.length, apiTotal: probe, questions: counts ? { all: counts.all.totalCount, open: counts.open.totalCount, settled: counts.settled.totalCount } : null, agg, durationMs: Date.now() - t0, requests: P.stats.requests, retries: P.stats.retries };
  fs.writeFileSync(path.join(root, 'data', 'predict.json'), JSON.stringify(out));
  console.log(`wrote data/predict.json: ${norms.length} predictions (API says ${probe}), ${agg.bettors.length} bettors, ${agg.makers.length} makers, ${P.stats.requests} requests, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
try { await buildPredict(); }
catch (e) {
  // No agg → the site falls back to a browser build; the error is published so it can be read without Action logs.
  console.warn('predict snapshot failed (site falls back to a browser build):', e && e.stack);
  fs.writeFileSync(path.join(root, 'data', 'predict.json'), JSON.stringify({ builtAt: Date.now(), source: 'github-actions', error: String(e && (e.stack || e.message || e)), requests: P.stats.requests, retries: P.stats.retries }));
}

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
fs.writeFileSync(path.join(root, 'data', 'leaderboard.json'), JSON.stringify(out));
console.log(`wrote data/leaderboard.json: ${rows.length} rows, ${failed} failed, ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (!rows.length) process.exit(1);
