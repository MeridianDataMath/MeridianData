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

// ---------------------------------------------------------------- Polymarket price at bet time
// The Predict API only exposes a question's source probability as it is now, so a real vig needs the price the mirrored
// Polymarket market showed when the bet was placed. Meridian's conditionId is Polymarket's, so: Gamma API → the YES
// outcome's CLOB token → CLOB price history around each bet → the last price at or before the bet (5-minute buckets).
// Results persist in a cache file (data/cache/polymarket-prices.json, gitignored) so a run only fetches new predictions.
const GAMMA = 'https://gamma-api.polymarket.com/markets';
const CLOB_HISTORY = 'https://clob.polymarket.com/prices-history';
const cacheFile = args.includes('--cache') ? path.resolve(args[args.indexOf('--cache') + 1]) : path.join(root, 'data', 'cache', 'polymarket-prices.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url, tries = 3) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      if (r.status === 429 || r.status >= 500) throw new Error('HTTP ' + r.status);
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { if (i >= tries - 1) throw e; await sleep(1500 * (i + 1)); }
  }
}
async function attachPricesAtBet(norms) {
  let cache = { v: 1, tokens: {}, preds: {} };
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (_) {}
  const now = Date.now();
  // 1. which predictions still need prices (every leg cached = done; legs that came back null are retried for 3 days)
  const todo = norms.filter((n) => { const c = cache.preds[n.id]; return !(c && c.p.length === n.picks.length && (c.p.every((p) => p != null) || now - c.at < 3 * 86400000)); });
  console.log(`  predict: price-at-bet cache ${Object.keys(cache.preds).length} predictions, ${todo.length} to look up`);
  // 2. YES-token ids from Gamma for the conditions involved (closed markets need a second pass with closed=true)
  // (also the Polymarket event each market belongs to, so combos with legs on the same event can be told apart)
  const condIds = Array.from(new Set(norms.flatMap((n) => n.picks.map((k) => k.id)).filter(Boolean)));
  const needTok = condIds.filter((id) => { const t = cache.tokens[id]; return !t || t.ev === undefined || (!t.yes && now - t.at > 7 * 86400000); });
  for (let i = 0; i < needTok.length; i += 40) {
    const chunk = needTok.slice(i, i + 40); const seen = new Set();
    for (const closed of [false, true]) {
      const rest = chunk.filter((id) => !seen.has(id)); if (!rest.length) break;
      const arr = await getJson(GAMMA + '?limit=' + rest.length + (closed ? '&closed=true' : '') + '&' + rest.map((id) => 'condition_ids=' + id).join('&'));
      for (const m of Array.isArray(arr) ? arr : []) {
        let toks = []; try { toks = JSON.parse(m.clobTokenIds || '[]'); } catch (_) {}
        const id = String(m.conditionId || '').toLowerCase(); seen.add(id);
        const ev = (m.events && m.events[0] && (m.events[0].id || m.events[0].slug)) || null;
        cache.tokens[id] = Object.assign({}, cache.tokens[id], { yes: toks[0] || null, outcomes: (() => { try { return JSON.parse(m.outcomes || '[]'); } catch (_) { return []; } })(), ev: ev == null ? null : String(ev), at: now });
      }
      await sleep(150);
    }
    for (const id of chunk) if (!seen.has(id)) cache.tokens[id] = Object.assign({ yes: null }, cache.tokens[id], { ev: null, at: now });
  }
  for (const n of norms) for (const k of n.picks) { const t = k.id && cache.tokens[k.id]; k.event = t && t.ev ? t.ev : null; }
  if (!todo.length) { for (const n of norms) P.applyAtBet(n, (cache.preds[n.id] || {}).p); fs.writeFileSync(cacheFile, JSON.stringify(cache)); return; }
  // 3. one history request per condition covering every new bet on it, then the last price at or before each bet
  const byCond = {};
  for (const n of todo) n.picks.forEach((k, i) => { if (k.id && cache.tokens[k.id] && cache.tokens[k.id].yes) (byCond[k.id] || (byCond[k.id] = [])).push({ n, i }); });
  const conds = Object.keys(byCond); let done = 0, lastLog = Date.now(), next = 0;
  const oneCondition = async (id) => {
    const legs = byCond[id]; const times = legs.map((l) => l.n.t);
    const from = Math.floor(Math.min(...times) / 1000) - 6 * 3600, to = Math.floor(Math.max(...times) / 1000) + 3600;
    const spanDays = (to - from) / 86400; const fidelity = spanDays <= 3 ? 1 : spanDays <= 30 ? 5 : spanDays <= 120 ? 15 : 60;
    let hist = [];
    try { const j = await getJson(CLOB_HISTORY + '?market=' + cache.tokens[id].yes + '&startTs=' + from + '&endTs=' + to + '&fidelity=' + fidelity); hist = (j && j.history) || []; }
    catch (e) { console.warn('  predict: history failed for', id.slice(0, 12), e.message); }
    for (const { n, i } of legs) {
      const t = n.t / 1000; let best = null;
      for (const h of hist) { if (h.t <= t) best = h; else break; }                           // last sample at or before the bet
      if (!best || t - best.t > 86400) { const after = hist.find((h) => h.t > t && h.t - t < 6 * 3600); if (!best && after) best = after; }
      n.picks[i].priceAtBet = best ? Number(best.p) : null;
    }
    done++;
    if (Date.now() - lastLog > 10000) { lastLog = Date.now(); console.log(`  predict: price history ${done}/${conds.length} conditions`); }
  };
  // a few requests in flight, ~8/s overall; the CLOB answered 5/s sequential bursts without complaint
  await Promise.all(Array.from({ length: 3 }, async () => { while (next < conds.length) { const id = conds[next++]; await oneCondition(id); await sleep(250); } }));
  // 4. record, apply, save
  for (const n of todo) cache.preds[n.id] = { p: n.picks.map((k) => (k.priceAtBet == null ? null : Math.round(k.priceAtBet * 10000) / 10000)), at: now };
  for (const n of norms) P.applyAtBet(n, (cache.preds[n.id] || {}).p);
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
  const got = norms.filter((n) => n.vig != null).length;
  console.log(`  predict: price-at-bet ready for ${got}/${norms.length} predictions (${conds.length} history requests)`);
}

// ---------------------------------------------------------------- Predict
async function buildPredict() {
  const t0 = Date.now();
  const toSec = Math.floor(Date.now() / 1000);
  P.minIntervalMs = 330;                       // ≈180 requests/min, under the API's 200/min per IP
  // sanity probe first so a blocked runner fails loudly with the real reason
  const probe = await P.predictionsCount();
  console.log(`  predict: API reachable, ${probe} predictions in total`);
  let lastLog = 0;
  const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 0;   // testing: a page per window only
  const raw = await P.predictionsWindowed({
    fromSec: P.LAUNCH_SEC, toSec, windows: 24, concurrency: 4, maxPagesPerWindow: limit ? 1 : 600,
    onProgress: (n) => { if (Date.now() - lastLog > 10000) { lastLog = Date.now(); console.log(`  predict: ${n} predictions so far (${P.stats.requests} requests, ${P.stats.retries} retries)`); } },
  });
  const norms = (limit ? raw.slice(0, limit) : raw).map(P.norm);
  try { await attachPricesAtBet(norms); } catch (e) { console.warn('predict: price-at-bet lookup failed, vig will be missing for new predictions:', e.message); }
  const agg = P.aggregate(norms, { tapeSize: 100 });
  console.log(`  predict: vig coverage ${agg.vig.coverage.withAtBet}/${agg.vig.coverage.total} predictions have a source price at bet time`);
  let counts = null;
  try { counts = await P.conditionCounts(); } catch (e) { console.warn('predict: condition counts failed', e.message); }
  // questions with Meridian open interest (the explorer's offline set) + the latest secondary-market trades
  const questions = []; let after = null; let pages = 0;
  try {
    do {
      const pg = await P.conditions({ settled: false, orderBy: 'OPEN_INTEREST', dir: 'DESC', first: 25, after });
      const rows = pg.nodes.map(P.compactQuestion); questions.push(...rows); pages++;
      after = pg.pageInfo.hasNextPage && rows[rows.length - 1].oi > 0 ? pg.pageInfo.endCursor : null;
    } while (after && pages < 60);
  } catch (e) { console.warn('predict: questions failed', e.message); }
  const withOi = questions.filter((q) => q.oi > 0);
  // Meridian activity per question from the predictions themselves: n = predictions ever, b = open predictions (not yet
  // decided), s = bettor stake in those, u = decided but unclaimed, l = last prediction. The explorer shows only questions with bets.
  const act = {};
  for (const n of norms) {
    for (const k of n.picks) {
      const a = act[k.id] || (act[k.id] = { n: 0, b: 0, s: 0, l: 0, by: 0, bn: 0, u: 0, sw: 0 });
      a.n++; a.sw += n.stake; if (!n.decided) { a.b++; a.s += n.stake; if (k.yes) a.by++; else a.bn++; } else if (!n.settled) a.u++; if (n.t > a.l) a.l = n.t;   // by / bn: open bets on YES / NO
    }
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  const rowOf = (k) => ({ id: k.id, q: k.q, short: k.short, cat: k.cat, slug: k.catSlug, tags: k.tags.slice(0, 6), ep: k.ep, oi: 0, v24: 0, v7: 0, end: k.endTime, created: null, settled: k.settled, yes: k.resolvedToYes, nd: k.nonDecisive, src: null });
  // plus the questions behind open predictions (a leg can be stuck in resolution) …
  const seenQ = new Set(withOi.map((q) => q.id));
  for (const n of norms) {
    if (n.decided && n.settled) continue;   // open, or decided and not yet claimed: still someone's money
    for (const k of n.picks) { if (!seenQ.has(k.id)) { seenQ.add(k.id); withOi.push(rowOf(k)); } }
  }
  // … and the questions of predictions settled in the last 30 days (newest first, capped), so "Settled" shows what people bet on
  const recent = norms.filter((n) => n.settled && n.settledAt && n.settledAt > Date.now() - 30 * 86400000).sort((a, b) => b.settledAt - a.settledAt);
  for (const n of recent) {
    if (withOi.length >= 1200) break;
    for (const k of n.picks) { if (!seenQ.has(k.id)) { seenQ.add(k.id); withOi.push(rowOf(k)); } }
  }
  for (const q of withOi) { const a = act[q.id]; q.n = a ? a.n : 0; q.b = a ? a.b : 0; q.s = a ? r2(a.s) : 0; q.l = a ? a.l : null; q.by = a ? a.by : 0; q.bn = a ? a.bn : 0; q.u = a ? a.u : 0; q.sw = a ? r2(a.sw) : 0; }   // sw: bettor stake ever placed on the question
  // open predictions per question with every leg (condition id, side) and the stake: whether anyone can still win a
  // question, and who is owed after it resolves, depends on the other legs of each combo, so the page needs them
  const openBy = {};
  for (const n of norms) { if (n.decided) continue; for (const k of n.picks) { if (!k.id) continue; (openBy[k.id] || (openBy[k.id] = [])).push({ id: n.id, s: r2(n.stake), p: n.predictor, k: n.picks.map((x) => [x.id, x.yes ? 1 : 0]) }); } }
  for (const q of withOi) if (openBy[q.id]) q.op = openBy[q.id];
  // one file per question with all its predictions, legs keeping their ids (the bettor files drop ids of settled legs)
  const qdir = path.join(outDir, 'questions'); fs.mkdirSync(qdir, { recursive: true });
  const byQ = {};
  for (const n of norms) for (const k of n.picks) if (k.id) (byQ[k.id] || (byQ[k.id] = [])).push(n);
  let qfiles = 0;
  for (const q of withOi) {
    const list = (byQ[q.id] || []).sort((a, b) => b.t - a.t);
    fs.writeFileSync(path.join(qdir, q.id + '.json'), JSON.stringify({ id: q.id, q: q.q, builtAt: Date.now(), total: list.length, predictions: list.slice(0, 400).map((n) => Object.assign(P.slim(n), { k: n.picks.map((k) => [k.q, k.yes ? 1 : 0, k.ep, k.endTime, k.cat, k.id, k.priceAtBet == null ? null : Math.round(k.priceAtBet * 1e4) / 1e4, n.picks.length > 1 ? k.event || null : null]) })) }));
    qfiles++;
  }
  let trades = [];
  try { const t1 = await P.trades({ first: 25 }); trades = t1.nodes.map(P.compactTrade); if (t1.pageInfo.hasNextPage) { const t2 = await P.trades({ first: 25, after: t1.pageInfo.endCursor }); trades.push(...t2.nodes.map(P.compactTrade)); } trades.total = t1.totalCount; } catch (e) { console.warn('predict: trades failed', e.message); }
  const out = { builtAt: Date.now(), source: process.env.GITHUB_ACTIONS ? 'github-actions' : 'pc', fromSec: P.LAUNCH_SEC, predictions: norms.length, apiTotal: probe, questions: counts ? { all: counts.all.totalCount, open: counts.open.totalCount, settled: counts.settled.totalCount } : null, agg, questionsWithOi: withOi, trades, tradesTotal: trades.total || trades.length, durationMs: Date.now() - t0, requests: P.stats.requests, retries: P.stats.retries };
  fs.writeFileSync(path.join(outDir, 'predict.json'), JSON.stringify(out));
  // one file per wallet (bettor or maker) so a bettor page works without API access; makers keep their latest 600
  const byWallet = {};
  for (const n of norms) { (byWallet[n.predictor] || (byWallet[n.predictor] = [])).push(n); (byWallet[n.counterparty] || (byWallet[n.counterparty] = [])).push(n); }
  const dir = path.join(outDir, 'bettors'); fs.mkdirSync(dir, { recursive: true });
  let files = 0;
  for (const [addr, list] of Object.entries(byWallet)) {
    list.sort((a, b) => b.t - a.t);
    const truncated = list.length > 600;
    fs.writeFileSync(path.join(dir, addr + '.json'), JSON.stringify({ address: addr, builtAt: out.builtAt, total: list.length, truncated, predictions: (truncated ? list.slice(0, 600) : list).map(P.slim) }));
    files++;
  }
  console.log(`wrote ${path.join(outDir, 'predict.json')}: ${norms.length} predictions (API says ${probe}), ${agg.bettors.length} bettors, ${agg.makers.length} makers, ${withOi.length} questions, ${trades.length} trades, ${files} wallet files, ${qfiles} question files, ${P.stats.requests} requests, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
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
// copy profiles (Copy trading → Leaders): today's books for slippage at each account's size, and one-minute candles for
// the price drift after each account's fills, shared across accounts
ctx.copy = await AN.copyContext(ref, ctx);
console.log(`markets=${ref.active.length} accounts=${subs.length} books=${Object.keys(ctx.copy.depth).length}`);

const results = await U.pLimit(
  subs.map((sa) => () => AN.buildLeaderboardRow(sa, ref, prices, ctx)),
  4,
  (done, total) => { if (done % 25 === 0 || done === total) console.log(`  ${done}/${total}`); },
);
const rows = []; let failed = 0;
results.forEach((r, i) => { if (r.ok) rows.push(r.value); else { failed++; console.warn(`row failed ${subs[i].id}: ${r.error && r.error.message}`); } });

const out = { builtAt: Date.now(), rows, partial: failed > 0, source: 'github-actions', accounts: subs.length, failed, durationMs: Date.now() - started };
fs.writeFileSync(path.join(outDir, 'leaderboard.json'), JSON.stringify(out));
const profiled = rows.filter((r) => r.copy && r.copy.driftN).length;
console.log(`wrote ${path.join(outDir, 'leaderboard.json')}: ${rows.length} rows (${profiled} with fill drift, ${ctx.copy.candles.size()} candle windows), ${failed} failed, ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (!rows.length) process.exit(1);
