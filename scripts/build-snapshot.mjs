#!/usr/bin/env node
/**
 * Builds the shared snapshots the site serves to every visitor:
 *   data/leaderboard.json — perps leaderboard (every subaccount, all intervals)
 *   data/predict.json     — Meridian Predict aggregates (bettors, makers, vig, categories, combos, daily series, tape, big wins)
 *                           plus bettors/<address>.json, questions/<conditionId>.json and slips/<2 hex>.json (every prediction by id)
 *   data/predict-ideas.json — winning bettors and their slips that can still be placed (the Copy trading page)
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

// Wallet addresses and condition ids come from the Predict API and become file names (bettors/<address>.json,
// questions/<id>.json): only well-formed ones do, so a malformed or hostile value can never point outside the output
// directory. The maps keyed by them have no prototype, so a key like "__proto__" is just another key.
const isAddr = (a) => /^0x[0-9a-f]{40}$/.test(a);          // P.norm and P.compactTrade lower-case them
const isCond = (id) => /^0x[0-9a-f]{64}$/i.test(id);       // kept as the API writes it: the site asks for questions/<that id>.json
const dict = () => Object.create(null);
const shown = (v) => JSON.stringify(String(v).slice(0, 80));   // one log line, whatever the value holds
const badWallets = new Set(), badConds = new Set();
const keepWallet = (a) => isAddr(a) || (badWallets.add(a), false);
const keepCond = (id) => isCond(id) || (badConds.add(id), false);

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
  cache.tokens = Object.assign(dict(), cache.tokens); cache.preds = Object.assign(dict(), cache.preds);
  const now = Date.now();
  // 1. which predictions still need prices (every leg cached = done; legs that came back null are retried for 3 days)
  const todo = norms.filter((n) => { const c = cache.preds[n.id]; return !(c && c.p.length === n.picks.length && (c.p.every((p) => p != null) || now - c.at < 3 * 86400000)); });
  console.log(`  predict: price-at-bet cache ${Object.keys(cache.preds).length} predictions, ${todo.length} to look up`);
  // 2. YES-token ids from Gamma for the conditions involved (closed markets need a second pass with closed=true)
  // (also the Polymarket event each market belongs to, so combos with legs on the same event can be told apart)
  const condIds = Array.from(new Set(norms.flatMap((n) => n.picks.map((k) => k.id)).filter(isCond)));   // they go into the URL as they are
  const needTok = condIds.filter((id) => { const t = cache.tokens[id]; return !t || t.ev === undefined || (!t.yes && now - t.at > 7 * 86400000); });
  for (let i = 0; i < needTok.length; i += 40) {
    const chunk = needTok.slice(i, i + 40); const seen = new Set();
    for (const closed of [false, true]) {
      const rest = chunk.filter((id) => !seen.has(id)); if (!rest.length) break;
      const arr = await getJson(GAMMA + '?limit=' + rest.length + (closed ? '&closed=true' : '') + '&' + rest.map((id) => 'condition_ids=' + id).join('&'));
      for (const m of Array.isArray(arr) ? arr : []) {
        let toks = []; try { toks = JSON.parse(m.clobTokenIds || '[]'); } catch (_) {}
        const id = String(m.conditionId || '').toLowerCase(); if (!isCond(id)) continue; seen.add(id);
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
  const byCond = dict();
  for (const n of todo) n.picks.forEach((k, i) => { if (k.id && cache.tokens[k.id] && cache.tokens[k.id].yes) (byCond[k.id] || (byCond[k.id] = [])).push({ n, i }); });
  const conds = Object.keys(byCond); let done = 0, lastLog = Date.now(), next = 0;
  const oneCondition = async (id) => {
    const legs = byCond[id]; const times = legs.map((l) => l.n.t);
    const from = Math.floor(Math.min(...times) / 1000) - 6 * 3600, to = Math.floor(Math.max(...times) / 1000) + 3600;
    const spanDays = (to - from) / 86400; const fidelity = spanDays <= 3 ? 1 : spanDays <= 30 ? 5 : spanDays <= 120 ? 15 : 60;
    let hist = [];
    try { const j = await getJson(CLOB_HISTORY + '?market=' + encodeURIComponent(cache.tokens[id].yes) + '&startTs=' + from + '&endTs=' + to + '&fidelity=' + fidelity); hist = (j && j.history) || []; }
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

// ---------------------------------------------------------------- when each prediction settled
// The exchange keeps no decision time. A won prediction was decided when its last leg resolved, which Polymarket records
// (umaEndDate, else closedTime) and which can be a day before the leg's listed end (a price question about Sep 28 is
// listed to end on the 29th): the listed end would date the win late, and the date would move as snapshots pass it.
// Looked up once per question for the big wins' legs and kept in the price cache (resolved: id → {t, at}).
const gammaTime = (s) => { const t = typeof s === 'string' ? Date.parse(s.replace(' ', 'T').replace(/\+00$/, 'Z')) : NaN; return Number.isFinite(t) ? t : null; };
async function attachDecidedAt(norms) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (_) {}
  const resolved = Object.assign(dict(), cache.resolved);
  const now = Date.now();
  // Every decided prediction first, from Meridian's own leg settlement times (condition.settledAt): a win when its last
  // leg settled, a loss when the first leg settled against the bettor (P.legVerdictAt). That is the moment the slip
  // settled, whether or not anyone has claimed it since, and every page dates results by it.
  let fromLegs = 0;
  for (const n of norms) { const v = P.legVerdictAt(n); if (v) { n.decidedAt = Math.min(v, now); fromLegs++; } }
  // Below, Polymarket's resolution times, only for a win paying more than P.BIG_WIN whose legs carry no settlement time:
  // the big wins (net PnL above it) are among them, since the payout includes the PnL; a traded position's own result is
  // only known in P.aggregate, and one that somehow beats its payout (the page dates that itself) would be the only
  // exception
  const wins = norms.filter((n) => n.won && n.pool > P.BIG_WIN && !n.decidedAt);
  const lc = (id) => String(id || '').toLowerCase();
  const ids = Array.from(new Set(wins.flatMap((n) => n.picks.map((k) => lc(k.id))).filter(isCond)));
  const need = ids.filter((id) => { const r = resolved[id]; return !r || (r.t == null && now - r.at > 86400000); });   // no time yet: asked again after a day
  // two passes like the token lookup: Gamma leaves closed markets out unless asked, and a market UMA has resolved may not
  // be marked closed yet
  let failed = false;
  for (let i = 0; i < need.length && !failed; i += 40) {
    const chunk = need.slice(i, i + 40); const seen = new Set();
    for (const closed of [true, false]) {
      const rest = chunk.filter((id) => !seen.has(id)); if (!rest.length) break;
      let arr = null;
      try { arr = await getJson(GAMMA + '?limit=' + rest.length + (closed ? '&closed=true' : '') + '&' + rest.map((id) => 'condition_ids=' + id).join('&')); }
      catch (e) { console.warn('  predict: resolution times failed, the page dates these big wins itself for now:', e.message); failed = true; break; }
      for (const m of Array.isArray(arr) ? arr : []) { const id = lc(m.conditionId); if (!isCond(id)) continue; const t = gammaTime(m.umaEndDate) || (m.closed ? gammaTime(m.closedTime) : null); if (t) { seen.add(id); resolved[id] = { t, at: now }; } }
      await sleep(150);
    }
    if (!failed) for (const id of chunk) if (!seen.has(id)) resolved[id] = { t: null, at: now };
  }
  // the last leg's resolution (its listed end where Polymarket has no time), never after the claim. A win whose last leg
  // has no time yet and a listed end still ahead is left undated (the page estimates it) rather than dated by this build,
  // which would move it at every run
  let dated = 0;
  for (const n of wins) {
    let at = n.t, unknown = false;
    for (const k of n.picks) { const r = resolved[lc(k.id)]; const e = (r && r.t) || k.endTime || 0; if (!(r && r.t) && e > now) unknown = true; if (e > at) at = e; }
    if (unknown && !n.settledAt) continue;
    n.decidedAt = Math.min(at, n.settledAt || Infinity, now); dated++;
  }
  try { const cur = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); cur.resolved = resolved; fs.writeFileSync(cacheFile, JSON.stringify(cur)); }
  catch (_) { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify({ resolved })); }
  console.log(`  predict: ${fromLegs} decided predictions dated from Meridian's leg settlement times; big wins without them dated ${dated} of ${wins.length} (${need.length} resolution times looked up, ${Object.keys(resolved).length} cached)`);
}

// ---------------------------------------------------------------- secondary market
// Every trade (the market is small), each tied to its pick configuration and side through the predictions' position
// tokens (predictorToken / counterpartyToken, shared by every prediction on the same picks), with the value per token
// once the picks are decided: 1 for the winning side, 0 for the losing one, the side's collateral share when void.
async function buildTrades(norms) {
  const raw = []; let after = null;
  try { do { const pg = await P.trades({ first: 25, after }); raw.push(...pg.nodes); after = pg.pageInfo.hasNextPage ? pg.pageInfo.endCursor : null; } while (after); }
  catch (e) { console.warn('predict: trades failed', e.message); }
  const byTok = dict();
  for (const n of norms) for (const [tok, side] of [[n.tokP, 'P'], [n.tokC, 'C']]) if (tok) (byTok[tok] || (byTok[tok] = { side, list: [] })).list.push(n);
  let unmapped = 0;
  const out = raw.map((x) => {
    const t = P.compactTrade(x); const token = String(x.token || '').toLowerCase(); const m = byTok[token];
    if (!m) { unmapped++; return Object.assign(t, { token }); }
    const list = m.list; const n0 = list[0]; const dec = list.find((n) => n.decided);
    const pool = list.reduce((a, n) => a + n.pool, 0), stake = list.reduce((a, n) => a + n.stake, 0), cp = list.reduce((a, n) => a + n.cp, 0);
    const claims = list.filter((n) => n.settled && n.settledAt).map((n) => n.settledAt);
    for (const n of list) n.pcTraded = true;
    return Object.assign(t, { token, pc: n0.pc, side: m.side, pid: n0.id, q: n0.picks[0] ? n0.picks[0].q : '', legs: n0.legs,
      vP: dec ? (dec.nd ? stake / pool : dec.won ? 1 : 0) : null, vC: dec ? (dec.nd ? cp / pool : dec.won ? 0 : 1) : null,
      dAt: dec ? Math.max(...list.map(P.decidedAt)) : null, sa: claims.length ? Math.max(...claims) : null });
  }).sort((a, b) => b.t - a.t);
  if (unmapped) console.warn(`  predict: ${unmapped} of ${raw.length} trades have a token no prediction carries`);
  out.total = raw.length;
  return out;
}

// ---------------------------------------------------------------- Predict
async function buildPredict() {
  const t0 = Date.now();
  const toSec = Math.floor(Date.now() / 1000);
  P.minIntervalMs = 330;                       // ≈180 requests/min, under the API's 200/min per IP
  // sanity probe first so a blocked runner fails loudly with the real reason
  const probe = await P.predictionsCount();
  console.log(`  predict: API reachable, ${probe} predictions in total`);
  // the API also counts launch-day test predictions (no questions attached) that it files before LAUNCH_SEC; they are left out
  let preLaunch = 0; try { preLaunch = await P.predictionsCount({ createdAt: { lte: P.LAUNCH_SEC - 1 } }); } catch (e) { console.warn('predict: pre-launch count failed', e.message); }
  let lastLog = 0;
  const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 0;   // testing: a page per window only
  const raw = await P.predictionsWindowed({
    fromSec: P.LAUNCH_SEC, toSec, windows: 24, concurrency: 4, maxPagesPerWindow: limit ? 1 : 600,
    onProgress: (n) => { if (Date.now() - lastLog > 10000) { lastLog = Date.now(); console.log(`  predict: ${n} predictions so far (${P.stats.requests} requests, ${P.stats.retries} retries)`); } },
  });
  // an incomplete history would publish wrong totals for everyone: better no new snapshot (the previous one stays live)
  if (raw.truncated && !limit) { console.error('predict: a time window hit its page cap, so the history is incomplete; not writing a snapshot (raise windows or maxPagesPerWindow)'); process.exit(1); }
  // a prediction whose predictor or counterparty is not an address is left out whole, so every wallet the aggregates list
  // has its file (the publish step checks that, and that the count stays close to the API's)
  const all = (limit ? raw.slice(0, limit) : raw).map(P.norm);
  const norms = all.filter((n) => [n.predictor, n.counterparty].filter(keepWallet).length === 2);   // both checked: both logged
  const dropped = all.length - norms.length;
  try { await attachPricesAtBet(norms); } catch (e) { console.warn('predict: price-at-bet lookup failed, vig will be missing for new predictions:', e.message); }
  try { await attachDecidedAt(norms); } catch (e) { console.warn('predict: settlement times failed, the page estimates them:', e.message); }
  // the secondary market: every trade, tied to its pick configuration and side through the predictions' position tokens,
  // with the verdict (value per token) where it is in, so PnL can follow the tokens rather than the original bettor
  const trades = await buildTrades(norms);
  const agg = P.aggregate(norms, { tapeSize: 25, trades });   // the Overview's tape shows 25
  if (agg.secondary) console.log(`  predict: secondary market ${agg.secondary.trades} trades (${agg.secondary.mapped} mapped), ${agg.secondary.volume.toFixed(2)} USDe; to bettors ${agg.secondary.toBettors.toFixed(2)}, makers ${agg.secondary.toMakers.toFixed(2)}, others ${agg.secondary.toOthers.toFixed(2)}`);
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
  const withOi = questions.filter((q) => q.oi > 0 && keepCond(q.id));
  // Meridian activity per question from the predictions themselves: n = predictions ever, b = open predictions (not yet
  // decided), s = bettor stake in those, u = decided but unclaimed, l = last prediction. The explorer shows only questions with bets.
  const act = dict();
  for (const n of norms) {
    for (const k of n.picks) {
      const a = act[k.id] || (act[k.id] = { n: 0, b: 0, s: 0, l: 0, by: 0, bn: 0, u: 0, sw: 0 });
      a.n++; a.sw += n.stake; if (!n.decided) { a.b++; a.s += n.stake; if (k.yes) a.by++; else a.bn++; } else if (!n.settled) a.u++; if (n.t > a.l) a.l = n.t;   // by / bn: open bets on YES / NO
    }
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  const rowOf = (k) => ({ id: k.id, q: k.q, short: k.short, cat: k.cat, slug: k.catSlug, tags: k.tags.slice(0, 6), ep: k.ep, oi: 0, v24: 0, v7: 0, end: k.endTime, created: null, settled: k.settled, yes: k.resolvedToYes, nd: k.nonDecisive, pub: k.pub, src: null });
  // plus the questions behind open predictions (a leg can be stuck in resolution) …
  const seenQ = new Set(withOi.map((q) => q.id));
  for (const n of norms) {
    if (n.decided && n.settled) continue;   // open, or decided and not yet claimed: still someone's money
    for (const k of n.picks) { if (!seenQ.has(k.id)) { seenQ.add(k.id); if (keepCond(k.id)) withOi.push(rowOf(k)); } }
  }
  // … and the questions of predictions settled (decided) in the last 30 days, newest settlement first and capped, so
  // "Settled" shows what people bet on; dated by the settlement, not by when a winner claimed
  const settledAt = (n) => P.decidedAt(n) || 0;
  const recent = norms.filter((n) => n.decided && settledAt(n) > Date.now() - 30 * 86400000).sort((a, b) => settledAt(b) - settledAt(a));
  for (const n of recent) {
    if (withOi.length >= 1200) break;
    for (const k of n.picks) { if (!seenQ.has(k.id)) { seenQ.add(k.id); if (keepCond(k.id)) withOi.push(rowOf(k)); } }
  }
  for (const q of withOi) { const a = act[q.id]; q.n = a ? a.n : 0; q.b = a ? a.b : 0; q.s = a ? r2(a.s) : 0; q.l = a ? a.l : null; q.by = a ? a.by : 0; q.bn = a ? a.bn : 0; q.u = a ? a.u : 0; q.sw = a ? r2(a.sw) : 0; }   // sw: bettor stake ever placed on the question
  // open predictions per question with every leg (condition id, side) and the stake: whether anyone can still win a
  // question, and who is owed after it resolves, depends on the other legs of each combo, so the page needs them
  const openBy = dict();
  for (const n of norms) { if (n.decided) continue; for (const k of n.picks) { if (!isCond(k.id)) continue; (openBy[k.id] || (openBy[k.id] = [])).push({ id: n.id, s: r2(n.stake), p: n.predictor, k: n.picks.map((x) => [x.id, x.yes ? 1 : 0]) }); } }
  for (const q of withOi) if (openBy[q.id]) q.op = openBy[q.id];
  // one file per question with all its predictions, legs keeping their ids (the bettor files drop ids of settled legs)
  const qdir = path.join(outDir, 'questions'); fs.mkdirSync(qdir, { recursive: true });
  const byQ = dict();
  for (const n of norms) for (const k of n.picks) if (isCond(k.id)) (byQ[k.id] || (byQ[k.id] = [])).push(n);
  let qfiles = 0;
  for (const q of withOi) {
    const list = (byQ[q.id] || []).sort((a, b) => b.t - a.t);
    fs.writeFileSync(path.join(qdir, q.id + '.json'), JSON.stringify({ id: q.id, q: q.q, builtAt: Date.now(), total: list.length, predictions: list.slice(0, 400).map((n) => P.slim(n, { ids: true })) }));
    qfiles++;
  }
  const out = { builtAt: Date.now(), source: process.env.GITHUB_ACTIONS ? 'github-actions' : 'pc', fromSec: P.LAUNCH_SEC, predictions: norms.length, apiTotal: probe, preLaunch, questions: counts ? { all: counts.all.totalCount, open: counts.open.totalCount, settled: counts.settled.totalCount } : null, agg, questionsWithOi: withOi, trades, tradesTotal: trades.total || trades.length, durationMs: Date.now() - t0, requests: P.stats.requests, retries: P.stats.retries };
  fs.writeFileSync(path.join(outDir, 'predict.json'), JSON.stringify(out));
  // the Copy trading page's ideas: winning bettors and their slips that can still be placed (a few KB, read on its own)
  const ideas = P.ideas(norms, agg);
  fs.writeFileSync(path.join(outDir, 'predict-ideas.json'), JSON.stringify(Object.assign({ builtAt: out.builtAt, criteria: P.IDEAS }, ideas)));
  console.log(`  predict: ${ideas.bettors.length} winning bettors, ${ideas.ideas.length} open ideas`);
  // a few hundred bytes the site's status page can read without the 1 MB snapshot
  fs.writeFileSync(path.join(outDir, 'predict-status.json'), JSON.stringify({ builtAt: out.builtAt, source: out.source, predictions: norms.length, apiTotal: probe, preLaunch, bettors: agg.bettors.length, makers: agg.makers.length, questions: withOi.length, vigCoverage: agg.vig.coverage.withAtBet, trades: trades.length, tradesMapped: trades.filter((t) => t.pc).length, requests: P.stats.requests, retries: P.stats.retries, durationMs: out.durationMs }));
  // one file per wallet (bettor or maker) so a bettor page works without API access; makers keep their latest 600
  const byWallet = dict();
  for (const n of norms) for (const a of [n.predictor, n.counterparty]) if (keepWallet(a)) (byWallet[a] || (byWallet[a] = [])).push(n);
  // each wallet's secondary-market trades travel with its file (a buyer who never bet gets a file for them alone)
  const tradesOf = dict();
  for (const t of trades) for (const a of new Set([t.seller, t.buyer])) { if (!keepWallet(a)) continue; (tradesOf[a] || (tradesOf[a] = [])).push(t); if (!byWallet[a]) byWallet[a] = []; }
  const dir = path.join(outDir, 'bettors'); fs.mkdirSync(dir, { recursive: true });
  let files = 0;
  for (const [addr, list] of Object.entries(byWallet)) {
    list.sort((a, b) => b.t - a.t);
    const truncated = list.length > 600;
    // a truncated file still carries every prediction on a pick configuration the wallet traded, so its ledger is whole
    const kept = truncated ? list.slice(0, 600).concat(list.slice(600).filter((n) => n.pcTraded && (tradesOf[addr] || []).some((t) => t.pc === n.pc))) : list;
    fs.writeFileSync(path.join(dir, addr + '.json'), JSON.stringify({ address: addr, builtAt: out.builtAt, total: list.length, truncated, predictions: kept.map(P.slim), trades: tradesOf[addr] || undefined }));
    files++;
  }
  // every prediction by its id, for the slip page (#/predict/p/<id>): one file per first two hex digits of the id
  // (about 40 predictions, some 25 KB each today, growing with the count), so a shared slip link loads one small file
  // whoever placed it and however many predictions that wallet has (wallet files stop at 600). A bettor who traded its
  // position tokens carries what it still held and its own result (h, lp), as the big wins do.
  const isPid = (id) => /^0x[0-9a-f]{64}$/i.test(id);
  const sdir = path.join(outDir, 'slips'); fs.mkdirSync(sdir, { recursive: true });
  const shards = dict(); let slips = 0;
  for (const n of norms) { if (!isPid(n.id)) continue; const k = n.id.slice(2, 4).toLowerCase(); (shards[k] || (shards[k] = dict()))[n.id.toLowerCase()] = Object.assign(P.slim(n), agg.soldOf(n)); slips++; }
  for (const [k, list] of Object.entries(shards)) fs.writeFileSync(path.join(sdir, k + '.json'), JSON.stringify({ builtAt: out.builtAt, slips: list }));
  console.log(`  predict: ${slips} slips in ${Object.keys(shards).length} files`);
  if (badWallets.size) console.warn(`  predict: skipped ${badWallets.size} wallet values that are not addresses (${dropped} predictions left out, the rest trade parties without a file), e.g. ${Array.from(badWallets).slice(0, 3).map(shown).join(', ')}`);
  if (badConds.size) console.warn(`  predict: skipped ${badConds.size} question ids that are not condition ids (no question file, not in the list), e.g. ${Array.from(badConds).slice(0, 3).map(shown).join(', ')}`);
  console.log(`wrote ${path.join(outDir, 'predict.json')}: ${norms.length} predictions (API says ${probe}), ${agg.bettors.length} bettors, ${agg.makers.length} makers, ${withOi.length} questions, ${trades.length} trades, ${files} wallet files, ${qfiles} question files, ${P.stats.requests} requests, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
if (doPredict) {
  try { await buildPredict(); }
  catch (e) {
    // No agg → the site falls back; the error is published so it can be read without Action logs.
    console.warn('predict snapshot failed:', e && e.stack);
    fs.writeFileSync(path.join(outDir, 'predict.json'), JSON.stringify({ builtAt: Date.now(), error: String(e && (e.stack || e.message || e)), requests: P.stats.requests, retries: P.stats.retries }));
    fs.writeFileSync(path.join(outDir, 'predict-status.json'), JSON.stringify({ builtAt: Date.now(), error: String(e && (e.message || e)), requests: P.stats.requests, retries: P.stats.retries }));
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

// A time budget (--budget seconds, default 9 minutes: the Action's job has 15 and still has to deploy): an account takes
// about two seconds, an active one with fills and candles more, so past a few hundred accounts the build would outlast
// the job. Accounts not reached are left out and the snapshot is marked partial rather than the whole deploy failing.
const budgetMs = (args.includes('--budget') ? Number(args[args.indexOf('--budget') + 1]) : 540) * 1000;
let skipped = 0;
const results = await U.pLimit(
  subs.map((sa) => async () => { if (Date.now() - started > budgetMs) { skipped++; return null; } return AN.buildLeaderboardRow(sa, ref, prices, ctx); }),
  4,
  (done, total) => { if (done % 25 === 0 || done === total) console.log(`  ${done}/${total} · ${((Date.now() - started) / 1000).toFixed(0)}s`); },
);
const rows = []; let failed = 0;
results.forEach((r, i) => { if (r.ok) { if (r.value) rows.push(r.value); } else { failed++; console.warn(`row failed ${subs[i].id}: ${r.error && r.error.message}`); } });
if (skipped) console.warn(`time budget of ${budgetMs / 1000}s reached: ${skipped} of ${subs.length} accounts not built this run`);

const out = { builtAt: Date.now(), rows, partial: failed > 0 || skipped > 0, source: 'github-actions', accounts: subs.length, failed, skipped, budgetS: budgetMs / 1000, durationMs: Date.now() - started };
fs.writeFileSync(path.join(outDir, 'leaderboard.json'), JSON.stringify(out));
const profiled = rows.filter((r) => r.copy && r.copy.driftN).length;
console.log(`wrote ${path.join(outDir, 'leaderboard.json')}: ${rows.length} rows (${profiled} with fill drift, ${ctx.copy.candles.size()} candle windows), ${failed} failed, ${skipped} skipped, ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (!rows.length) process.exit(1);
