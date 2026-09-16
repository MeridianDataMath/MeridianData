#!/usr/bin/env node
/**
 * Builds data/leaderboard.json — the shared leaderboard snapshot the site serves to every visitor.
 * Reuses the site's own browser modules (util / api / analytics) so the numbers match a local build.
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
for (const f of ['js/util.js', 'js/api.js', 'js/analytics.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
}
const { MD } = globalThis;
const A = MD.api, AN = MD.analytics, U = MD.util;

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
fs.mkdirSync(path.join(root, 'data'), { recursive: true });
fs.writeFileSync(path.join(root, 'data', 'leaderboard.json'), JSON.stringify(out));
console.log(`wrote data/leaderboard.json: ${rows.length} rows, ${failed} failed, ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (!rows.length) process.exit(1);
