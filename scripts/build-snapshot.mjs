#!/usr/bin/env node
/**
 * Builds the shared snapshots the site serves to every visitor:
 *   data/leaderboard.json — perps leaderboard (every subaccount, all intervals)
 *   data/predict.json     — Meridian Predict aggregates (bettors, makers, vig, categories, combos, daily series, tape, big wins)
 *                           plus bettors/<address>.json, questions/<conditionId>.json and slips/<2 hex>.json (every prediction by id)
 *   data/predict-ideas.json — winning bettors and their slips the site still offers to copy (undecided, no leg past its
 *     listed end, settled or closed; the Copy trading page)
 * Reuses the site's own browser modules so the numbers match a local build.
 * Runs in GitHub Actions (see .github/workflows/pages.yml). Needs Node 18+ (global fetch).
 *
 *   node scripts/build-snapshot.mjs                 # both
 *   node scripts/build-snapshot.mjs --perps         # leaderboard only (what GitHub Actions runs: the Predict API
 *                                                   #   returns 403 to datacenter IPs, so that snapshot is built on a PC)
 *   node scripts/build-snapshot.mjs --predict --out <dir>
 *
 * The pure helpers below are exported for tests/snapshot-build.test.mjs; importing this file builds and writes nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes('--' + n);
// run as a script (by this file's name, so a different drive-letter case or a linked folder still builds), or imported
const asScript = /(^|[\\/])build-snapshot\.mjs$/i.test(process.argv[1] || '');
const outDir = args.includes('--out') ? path.resolve(args[args.indexOf('--out') + 1]) : path.join(root, 'data');
const doPredict = asScript && (flag('predict') || !flag('perps'));
const doPerps = asScript && (flag('perps') || !flag('predict'));

// minimal browser shims for the classic-script modules
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
for (const f of ['js/util.js', 'js/api.js', 'js/analytics.js', 'js/predict/api.js', 'js/predict/analytics.js', 'js/cards.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
}
const { MD } = globalThis;
const A = MD.api, AN = MD.analytics, U = MD.util, P = MD.predict;
const KC = MD.cards.make({ U, P });   // the wallet curve the pages draw (curveFromPredictions), for the truncated wallet files
if (asScript) fs.mkdirSync(outDir, { recursive: true });

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
// outcome's CLOB token → CLOB price history around each bet → the last price at or before the bet (1- or 5-minute samples).
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
  // 1. which predictions still need prices (every leg cached = done; legs that came back null are retried every 3 days until
  // priced, and at once if they were looked up before the windows were split (w: their history request spanned over 15
  // days, which the CLOB refuses))
  const todo = norms.filter((n) => { const c = cache.preds[n.id]; return !(c && c.p.length === n.picks.length && (c.p.every((p) => p != null) || (c.w && now - c.at < 3 * 86400000))); });
  console.log(`  predict: price-at-bet cache ${Object.keys(cache.preds).length} predictions, ${todo.length} to look up`);
  // 2. YES-token ids from Gamma for the conditions involved (closed markets need a second pass with closed=true)
  // (also the match each market belongs to, so combos with legs on the same match can be told apart; evv 2: the match
  // keys below, so a token cached with the older bare event id is looked up once more)
  const condIds = Array.from(new Set(norms.flatMap((n) => n.picks.map((k) => k.id)).filter(isCond)));   // they go into the URL as they are
  const needTok = condIds.filter((id) => { const t = cache.tokens[id]; return !t || t.evv !== 2 || (!t.yes && now - t.at > 7 * 86400000); });
  // a failed request stops the lookups for this run and keeps what came back: the rest is asked again next run, and the
  // prices below still apply (a throw here would leave every prediction without its vig)
  let tokFailed = false;
  for (let i = 0; i < needTok.length && !tokFailed; i += 40) {
    const chunk = needTok.slice(i, i + 40); const seen = new Set();
    for (const closed of [false, true]) {
      const rest = chunk.filter((id) => !seen.has(id)); if (!rest.length) break;
      let arr = null;
      try { arr = await getJson(GAMMA + '?limit=' + rest.length + (closed ? '&closed=true' : '') + '&' + rest.map((id) => 'condition_ids=' + id).join('&')); }
      catch (e) { console.warn('  predict: Gamma market lookup failed, the rest is asked again next run:', e.message); tokFailed = true; break; }
      for (const m of Array.isArray(arr) ? arr : []) {
        let toks = []; try { toks = JSON.parse(m.clobTokenIds || '[]'); } catch (_) {}
        const id = String(m.conditionId || '').toLowerCase(); if (!isCond(id)) continue; seen.add(id);
        const e0 = m.events && m.events[0];
        // one match, not one Polymarket event: a game's More Markets / Exact Score / player-prop events are children of its
        // main event (parentEventId) and not every child carries the game's gameId; an asset's "above ___ on <date>" and
        // "price on <date>" events are one price at one time. Two legs sharing any of these keys are on one match
        const root = e0 ? (e0.parentEventId || e0.id || e0.slug) : null;
        const sm = e0 && String(e0.slug || '').match(/^([a-z0-9]+)-(?:above|price)-on-(.+)$/);
        const ev = root == null ? null : ['r' + root].concat(e0.gameId ? ['g' + e0.gameId] : [], sm ? ['s' + sm[1] + '|' + sm[2]] : []).join(' ');
        cache.tokens[id] = Object.assign({}, cache.tokens[id], { yes: toks[0] || null, outcomes: (() => { try { return JSON.parse(m.outcomes || '[]'); } catch (_) { return []; } })(), ev, evv: 2, at: now });
      }
      await sleep(150);
    }
    if (!tokFailed) for (const id of chunk) if (!seen.has(id)) cache.tokens[id] = Object.assign({ yes: null }, cache.tokens[id], { ev: null, evv: 2, at: now });
  }
  for (const n of norms) for (const k of n.picks) { const t = k.id && cache.tokens[k.id]; k.event = t && t.ev ? t.ev : null; }
  if (!todo.length) { for (const n of norms) P.applyAtBet(n, (cache.preds[n.id] || {}).p); fs.writeFileSync(cacheFile, JSON.stringify(cache)); return; }
  // 3. history requests per condition covering its new bets, then the last price at or before each bet
  const byCond = dict();
  for (const n of todo) n.picks.forEach((k, i) => { if (k.id && cache.tokens[k.id] && cache.tokens[k.id].yes) (byCond[k.id] || (byCond[k.id] = [])).push({ n, i }); });
  const conds = Object.keys(byCond); let done = 0, lastLog = Date.now(), next = 0;
  const oneCondition = async (id) => {
    // the CLOB refuses a window longer than 15 days (HTTP 400 "interval is too long"), so one request per run of bets within
    // 13 days (with the 6 h before and 1 h after, under 15)
    const sorted = byCond[id].slice().sort((a, b) => a.n.t - b.n.t); const groups = [];
    for (const l of sorted) { const g = groups[groups.length - 1]; if (g && l.n.t - g[0].n.t <= 13 * 86400000) g.push(l); else groups.push([l]); }
    for (const legs of groups) {
      const times = legs.map((l) => l.n.t);
      const from = Math.floor(Math.min(...times) / 1000) - 6 * 3600, to = Math.floor(Math.max(...times) / 1000) + 3600;
      const fidelity = (to - from) / 86400 <= 3 ? 1 : 5;
      let hist = [];
      try { const j = await getJson(CLOB_HISTORY + '?market=' + encodeURIComponent(cache.tokens[id].yes) + '&startTs=' + from + '&endTs=' + to + '&fidelity=' + fidelity); if (!j) console.warn('  predict: history refused for', id.slice(0, 12), from, to); hist = (j && j.history) || []; }
      catch (e) { console.warn('  predict: history failed for', id.slice(0, 12), e.message); }
      for (const { n, i } of legs) {
        const t = n.t / 1000; let best = null;
        for (const h of hist) { if (h.t <= t) best = h; else break; }                         // last sample at or before the bet
        if (!best) best = hist.find((h) => h.t > t && h.t - t < 6 * 3600) || null;             // else the first one within 6 h after
        n.picks[i].priceAtBet = best ? Number(best.p) : null;
      }
    }
    done++;
    if (Date.now() - lastLog > 10000) { lastLog = Date.now(); console.log(`  predict: price history ${done}/${conds.length} conditions`); }
  };
  // a few requests in flight, ~8/s overall; the CLOB answered 5/s sequential bursts without complaint
  await Promise.all(Array.from({ length: 3 }, async () => { while (next < conds.length) { const id = conds[next++]; await oneCondition(id); await sleep(250); } }));
  // 4. record, apply, save
  for (const n of todo) cache.preds[n.id] = { p: n.picks.map((k) => (k.priceAtBet == null ? null : Math.round(k.priceAtBet * 10000) / 10000)), at: now, w: 1 };
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
  // and every leg of every decided prediction, for the tax center's verdict date basis (when the source market resolved,
  // P.sourceVerdictAt: slim leg element 11, vt, in the wallet files): the big wins' legs first, then the rest, at most
  // about 150 requests a run, so the first runs fill the cache over a few builds and later ones ask only for new legs
  const winIds = wins.flatMap((n) => n.picks.map((k) => lc(k.id)));
  const legIds = norms.filter((n) => n.decided).flatMap((n) => n.picks.map((k) => lc(k.id)));
  const ids = Array.from(new Set(winIds.concat(legIds).filter(isCond)));
  const need = ids.filter((id) => { const r = resolved[id]; return !r || (r.t == null && now - r.at > 86400000); });   // no time yet: asked again after a day
  // two passes like the token lookup: Gamma leaves closed markets out unless asked, and a market UMA has resolved may not
  // be marked closed yet
  let failed = false, requests = 0;
  for (let i = 0; i < need.length && !failed && requests < 150; i += 40) {
    const chunk = need.slice(i, i + 40); const seen = new Set();
    for (const closed of [true, false]) {
      const rest = chunk.filter((id) => !seen.has(id)); if (!rest.length) break;
      let arr = null; requests++;
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
  // each decided leg's source-market resolution (null where Polymarket has none, or it is not looked up yet)
  let withVt = 0;
  try { for (const n of norms) if (n.decided) for (const k of n.picks) { const r = resolved[lc(k.id)]; k.verdictAt = r && r.t ? r.t : null; if (k.verdictAt) withVt++; } }
  catch (e) { console.warn('  predict: source resolution times not attached:', e.message); }
  try { const cur = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); cur.resolved = resolved; fs.writeFileSync(cacheFile, JSON.stringify(cur)); }
  catch (_) { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify({ resolved })); }
  console.log(`  predict: ${fromLegs} decided predictions dated from Meridian's leg settlement times; big wins without them dated ${dated} of ${wins.length} (${need.length} resolution times to look up, ${requests} requests this run, ${Object.keys(resolved).length} cached, ${withVt} decided legs with a source time)`);
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
    // vt: when the source markets resolved the picks (P.sourceVerdictAt), only where every leg's time is known: a buyer
    // with no prediction of its own on them dates its verdict by it on the tax center's verdict basis
    let vt; try { const v = dec ? P.sourceVerdictAt(dec) : null; vt = v && v.exact ? v.t : undefined; } catch (_) { vt = undefined; }
    return Object.assign(t, { token, pc: n0.pc, side: m.side, pid: n0.id, q: n0.picks[0] ? n0.picks[0].q : '', legs: n0.legs,
      vP: dec ? (dec.nd ? stake / pool : dec.won ? 1 : 0) : null, vC: dec ? (dec.nd ? cp / pool : dec.won ? 0 : 1) : null,
      dAt: dec ? Math.max(...list.map(P.decidedAt)) : null, sa: claims.length ? Math.max(...claims) : null, vt });
  }).sort((a, b) => b.t - a.t);
  if (unmapped) console.warn(`  predict: ${unmapped} of ${raw.length} trades have a token no prediction carries`);
  out.total = raw.length;
  return out;
}

// ---------------------------------------------------------------- own redemptions (the tax center's claim dates)
// A claim burns the wallet's whole balance of a position token (Transfer wallet → 0x0, emitted by the token). The API
// flags only the prediction a claim went through, and a buyer has no prediction to flag, so for the tokens a trading
// wallet's ledger still held at a verdict that pays, its own burns say when it redeemed them (P.redemptionTimes).
// scripts/burns.mjs reads them from Robinhood Chain with eth_getLogs one token at a time (the RPC spans 10M blocks for
// one address but only 30 000 without one, which it refused every run when this read whole wallets), from the first
// placement on the token's pick configuration, paced (the RPC answers bursts with 429), at most 10 calls per request
// and BURN_CAP a run. Each token's progress, width and burns are kept under 'burnRead' in the price cache, so a later
// run reads only new blocks and a token whose every holder has redeemed is not read again. A wallet gets rd in its file
// only once every position it held at a paying verdict is redeemed or read to the chain head; until then the page keeps
// the older rule (its own claim on that side, else the latest claim on the pick configuration) and says so.
const RH_RPC = 'https://rpc.mainnet.chain.robinhood.com';
const BURN_CAP = args.includes('--burn-cap') ? Number(args[args.indexOf('--burn-cap') + 1]) : 300;
async function rpcBatch(calls) {
  const body = JSON.stringify(calls.map((c, i) => ({ jsonrpc: '2.0', id: i, method: c.method, params: c.params })));
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(RH_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json(); const arr = Array.isArray(j) ? j : [j];
      const byId = new Map(arr.map((x) => [x && x.id, x]));
      return calls.map((_, k) => byId.get(k) || { error: { message: 'no answer' } });
    } catch (e) { if (i >= 2) throw e; await sleep(2000 * (i + 1)); }
  }
}
async function attachRedemptions(norms, trades) {
  // the reader is loaded here, inside the caller's try: if it fails, the files go out without rd, never without a snapshot
  const B = await import('./burns.mjs');
  // what each trading wallet held at a verdict that pays, per pick configuration and side (its ledger, as P.aggregate
  // builds it: its own predictions on the traded pick configurations, self-matches left out)
  const tradedPc = new Set(trades.map((t) => t.pc).filter(Boolean));
  const byW = dict();
  for (const n of norms) if (n.pc && tradedPc.has(n.pc) && !P.selfMatch(n)) for (const a of new Set([n.predictor, n.counterparty])) (byW[a] || (byW[a] = [])).push(n);
  const wallets = new Set(); for (const t of trades) if (t.pc) for (const a of [t.seller, t.buyer]) if (isAddr(a)) wallets.add(a);
  const held = dict();
  for (const w of wallets) {
    const L = P.ledger(byW[w] || [], trades, w);
    for (const e of L.events) if (e.kind === 'verdict' && e.cash > 1e-9) (held[w] || (held[w] = dict()))[e.pc + '|' + e.side] = { tokens: e.side === 'P' ? e.heldP : e.heldC, after: e.t };
  }
  // each side's token, and the first placement on each pick configuration (its tokens' first block)
  const byTok = dict(), tokOf = dict(), first = dict();
  for (const n of norms) {
    if (n.tokP) { byTok[n.tokP] = n.pc + '|P'; tokOf[n.pc + '|P'] = n.tokP; }
    if (n.tokC) { byTok[n.tokC] = n.pc + '|C'; tokOf[n.pc + '|C'] = n.tokC; }
    if (n.pc && n.tx && !(first[n.pc] && first[n.pc].t <= n.t)) first[n.pc] = { t: n.t, tx: n.tx };
  }
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (_) {}
  const state = cache.burnRead && cache.burnRead.t ? cache.burnRead : { t: {} };
  const head = parseInt((await rpcBatch([{ method: 'eth_blockNumber', params: [] }]))[0].result, 16);
  if (!(head > 0)) throw new Error('no chain head');
  const args0 = { held, tokOf, byTok, state, head, redemptionTimes: P.redemptionTimes };
  const want = Array.from(B.redemptions(args0).open).map((token) => { const f = first[byTok[token].split('|')[0]]; return { token, tx: f ? f.tx : null }; });
  const r = await B.readBurns({ rpc: rpcBatch, state, want, head, cap: BURN_CAP, batch: 10, pause: 300, sleep, log: (s) => console.warn(s) });
  // 'burns' was the whole-wallet reader's progress, never advanced: replaced
  try { const cur = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); cur.burnRead = state; delete cur.burns; fs.writeFileSync(cacheFile, JSON.stringify(cur)); }
  catch (_) { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify({ burnRead: state })); }
  const { rd } = B.redemptions(args0);
  const found = Object.values(rd).reduce((a, x) => a + Object.keys(x).length, 0);
  const blind = Object.values(held).reduce((a, h) => a + Object.keys(h).filter((k) => !tokOf[k]).length, 0);
  console.log(`  predict: own redemptions for ${Object.keys(rd).length} of ${Object.keys(held).length} wallets holding tokens at a verdict that pays (${found} redeemed; ${r.calls} RPC calls this run, ${r.refused} refused, ${r.read} of ${want.length} tokens to read now at the head ${head}${blind ? `; ${blind} positions without a known token` : ''})`);
  return rd;
}

// ---------------------------------------------------------------- claimable winnings (the app's Claimable Payout)
// The app's Claim card sums positions(holder, claimable: true): the position tokens a wallet still holds on a pick
// configuration whose verdict pays their side, by balance (a claim burns the whole balance). It reads the token, not
// prediction.settled: a prediction can be settled while its winner still holds the tokens (settling and redeeming are
// separate calls) and unsettled after the winner's tokens were sold or redeemed through another prediction on the same
// picks, so the flag alone misstates what is left to claim in both directions. P.aggregate takes the balances (a
// wallet's win is unclaimed while it still holds the winning token), each wallet file gets claim: [{pc, side, bal}]
// (empty when nothing is claimable) and predict.json agg.claimAt, the read's time; a failed read leaves all of it out, so
// the pages keep their older rule. The API answers the query only with a holder ("Claimable positions require holder"),
// caps one field at 3 aliases a request and refuses batched requests, so one request asks about three wallets, and only
// wallets that can hold a paying token: the winner of a decided prediction (the bettor of a win, the maker of a loss)
// and a buyer on the secondary market once the pick configuration is decided. A wallet whose
// last answer was empty and that has won or bought nothing since is not asked again until that answer is CLAIM_RECHECK_MS
// old (CLAIM_REFRESH of those a run, the oldest first; a token sent to it outside the market shows up then): a run asks
// about the wallets with winnings still to claim, the new winners and a slice of the rest. Kept under 'claimRead' in the
// price cache: {w: {address: {at, k, n}}}, k the wallet's decided wins and buys when asked, n its claimable positions.
export const CLAIM_RECHECK_MS = 12 * 3600000;
export const CLAIM_REFRESH = 30;
const CLAIM_MAX_REQUESTS = 400;   // ~160 on a first run (no cache) with 480 wallets to ask; past this the read fails
/** address → how many decided predictions it won (either side; a void one pays nothing in the app) and decided pick
 *  configurations it bought on: the count changes whenever it may have come to hold a paying token since. */
export function claimCandidates(norms, trades) {
  const k = dict();
  for (const n of norms) { if (!n.decided || n.nd) continue; const w = n.won ? n.predictor : n.counterparty; if (isAddr(w)) k[w] = (k[w] || 0) + 1; }
  for (const t of trades || []) if (t.pc && (t.vP != null || t.vC != null) && isAddr(t.buyer)) k[t.buyer] = (k[t.buyer] || 0) + 1;
  return k;
}
/** Which candidates to ask this run (seen: the cache's {address: {at, k, n}}): every one never asked, holding something
 *  claimable at its last answer, or with a new win or buy since; then up to `refresh` of the others whose answer is
 *  older than `recheckMs`, the oldest first. */
export function claimPlan(cand, seen, now, { recheckMs = CLAIM_RECHECK_MS, refresh = CLAIM_REFRESH } = {}) {
  const must = [], old = [];
  for (const a of Object.keys(cand)) { const s = seen[a]; if (!s || !(s.n === 0) || s.k !== cand[a]) must.push(a); else if (now - s.at > recheckMs) old.push(a); }
  old.sort((a, b) => seen[a].at - seen[b].at);
  return must.concat(old.slice(0, refresh));
}
/** One page of positions(holder, claimable: true) → [{pc, side, bal}] as the app counts them: a row with its
 *  prediction, a balance above zero, on the side the verdict pays (NON_DECISIVE pays nothing in the app); bal in USDe
 *  (a winning token pays 1). */
export function claimEntries(nodes) {
  const out = [];
  for (const p of nodes || []) {
    if (!p || !p.prediction || !p.prediction.predictionId) continue;
    let wei; try { wei = BigInt(p.balance); } catch (_) { continue; }
    const side = p.side === 'PREDICTOR' ? 'P' : p.side === 'COUNTERPARTY' ? 'C' : null, res = p.pickConfig && p.pickConfig.result;
    if (!(wei > 0n) || !(side === 'P' ? res === 'PREDICTOR_WINS' : side === 'C' && res === 'COUNTERPARTY_WINS')) continue;
    out.push({ pc: p.pickConfigId || p.pickConfig.pickConfigId, side, bal: Math.round(P.usd(p.balance) * 1e6) / 1e6 });
  }
  return out;
}
const claimQuery = (k) => `query Claimable(${Array.from({ length: k }, (_, i) => `$h${i}: Address!, $a${i}: String`).join(', ')}) { ${Array.from({ length: k }, (_, i) => `h${i}: positions(first: ${P.PAGE}, after: $a${i}, filter: { holder: $h${i}, chainId: ${P.CHAIN}, claimable: true }, orderBy: { field: CREATED_AT, direction: DESC }) { pageInfo { hasNextPage endCursor } nodes { side balance pickConfigId prediction { predictionId } pickConfig { result } } }`).join(' ')} }`;
/** → {at, of: {address: [{pc, side, bal}]}} for every candidate (an empty list for one not asked: nothing claimable at
 *  its last answer and nothing new since); throws when a request fails, after keeping the answers already complete. */
async function attachClaims(norms, trades) {
  const at = Date.now();
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (_) {}
  const seen = Object.assign(dict(), cache.claimRead && cache.claimRead.w);
  const cand = claimCandidates(norms, trades);
  const ask = claimPlan(cand, seen, at);
  // three wallets a request; a wallet with more than a page goes back in the queue with its cursor
  const of = dict(), queue = ask.map((a) => [a, null]); let requests = 0, failure = null;
  while (queue.length && !failure) {
    if (requests >= CLAIM_MAX_REQUESTS) { failure = new Error(`over ${CLAIM_MAX_REQUESTS} requests`); break; }
    const batch = queue.splice(0, 3); const vars = {};
    batch.forEach(([a, after], i) => { vars['h' + i] = a; vars['a' + i] = after; });
    let d = null; requests++;
    try { d = await P.gql(claimQuery(batch.length), vars); } catch (e) { failure = e; break; }
    batch.forEach(([a], i) => {
      const pg = d && d['h' + i]; if (!pg || !Array.isArray(pg.nodes)) { failure = failure || new Error('no answer for ' + a); return; }
      (of[a] || (of[a] = [])).push(...claimEntries(pg.nodes));
      if (pg.pageInfo && pg.pageInfo.hasNextPage && pg.pageInfo.endCursor) queue.push([a, pg.pageInfo.endCursor]);
      else seen[a] = { at, k: cand[a], n: of[a].length };   // complete: remembered
    });
  }
  try { const cur = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); cur.claimRead = { w: seen }; fs.writeFileSync(cacheFile, JSON.stringify(cur)); }
  catch (_) { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify({ claimRead: { w: seen } })); }
  if (failure) throw new Error(`${failure.message} (${requests} requests, ${ask.length} wallets to ask)`);
  for (const a of Object.keys(cand)) if (!of[a]) of[a] = [];
  const holders = Object.values(of).filter((l) => l.length).length, total = Object.values(of).reduce((s, l) => s + l.reduce((x, e) => x + e.bal, 0), 0);
  console.log(`  predict: claimable winnings ${total.toFixed(2)} USDe in ${holders} wallets (asked ${ask.length} of ${Object.keys(cand).length} that can hold a paying token, ${requests} requests)`);
  return { at, of };
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
  // a claim pays every prediction the wallet holds on that token, the API flags one: the others count as claimed with it
  // (before attachDecidedAt, whose dates are never after the claim)
  console.log('  predict: ' + P.markTokenClaims(norms) + ' decided predictions paid by a claim on the same token');
  try { await attachPricesAtBet(norms); } catch (e) { console.warn('predict: price-at-bet lookup failed, vig will be missing for new predictions:', e.message); }
  try { await attachDecidedAt(norms); } catch (e) { console.warn('predict: settlement times failed, the page estimates them:', e.message); }
  // the secondary market: every trade, tied to its pick configuration and side through the predictions' position tokens,
  // with the verdict (value per token) where it is in, so PnL can follow the tokens rather than the original bettor
  const trades = await buildTrades(norms);
  // when each trading wallet redeemed the tokens it still held at a verdict (rd in its file; the tax center's claim dates)
  let rdOf = dict();
  try { rdOf = await attachRedemptions(norms, trades); } catch (e) { console.warn('predict: own redemptions failed, the tax center keeps the latest claim for now:', e.message); }
  // the app's Claimable Payout per wallet (claim in its file, agg.claimAt): with these balances P.aggregate counts a win
  // as unclaimed while its winner still holds the winning tokens; a failed read leaves all of it out (the settled flag)
  let claims = null;
  try { claims = await attachClaims(norms, trades); }
  catch (e) { console.warn('predict: claimable positions failed, the files go out without them:', e.message); }
  const agg = P.aggregate(norms, { tapeSize: 25, trades, claims: claims ? claims.of : null });   // the Overview's tape shows 25
  if (claims) agg.claimAt = claims.at;
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
  const qNorms = norms.filter((n) => !P.selfMatch(n));   // a bet against itself moves no money: left out of every figure, the Questions page included
  const act = dict();
  for (const n of qNorms) {
    for (const k of n.picks) {
      const a = act[k.id] || (act[k.id] = { n: 0, b: 0, s: 0, l: 0, by: 0, bn: 0, u: 0, sw: 0 });
      a.n++; a.sw += n.stake; if (!n.decided) { a.b++; a.s += n.stake; if (k.yes) a.by++; else a.bn++; } else if (!n.settled) a.u++; if (n.t > a.l) a.l = n.t;   // by / bn: open bets on YES / NO
    }
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  const rowOf = (k) => ({ id: k.id, q: k.q, short: k.short, cat: k.cat, slug: k.catSlug, tags: k.tags.slice(0, 6), ep: k.ep, oi: 0, v24: 0, v7: 0, end: k.endTime, created: null, settled: k.settled, yes: k.resolvedToYes, nd: k.nonDecisive, pub: k.pub, src: null });
  // plus the questions behind open predictions (a leg can be stuck in resolution) …
  const seenQ = new Set(withOi.map((q) => q.id));
  for (const n of qNorms) {
    if (n.decided && n.settled) continue;   // open, or decided and not yet claimed: still someone's money
    for (const k of n.picks) { if (!seenQ.has(k.id)) { seenQ.add(k.id); if (keepCond(k.id)) withOi.push(rowOf(k)); } }
  }
  const questionsLive = withOi.length;   // questions with money still on them; the rest of the list is the questions of the most recently settled predictions
  // … and the questions of predictions settled (decided) in the last 30 days, newest settlement first, up to 1,200 rows
  // in all, so "Settled" shows what people bet on; dated by the settlement, not by when a winner claimed. The cap usually
  // cuts the 30-day window to a few days: recentFrom says how far back it reaches (the settlement of the last prediction
  // taken, or the window's start when the cap was not reached)
  const settledAt = (n) => P.decidedAt(n) || 0;
  const cutoff30 = Date.now() - 30 * 86400000;
  const recent = qNorms.filter((n) => n.decided && settledAt(n) > cutoff30).sort((a, b) => settledAt(b) - settledAt(a));
  let recentFrom = null;
  for (const n of recent) {
    if (withOi.length >= 1200) break;
    recentFrom = settledAt(n);
    for (const k of n.picks) { if (!seenQ.has(k.id)) { seenQ.add(k.id); if (keepCond(k.id)) withOi.push(rowOf(k)); } }
  }
  if (withOi.length < 1200) recentFrom = cutoff30;   // the 30-day window, not the cap, set the limit
  for (const q of withOi) { const a = act[q.id]; q.n = a ? a.n : 0; q.b = a ? a.b : 0; q.s = a ? r2(a.s) : 0; q.l = a ? a.l : null; q.by = a ? a.by : 0; q.bn = a ? a.bn : 0; q.u = a ? a.u : 0; q.sw = a ? r2(a.sw) : 0; }   // sw: bettor stake ever placed on the question
  // Meridian OI from the predictions: stake + maker collateral of every prediction on the question not yet claimed (a
  // combo counts in full on each of its questions). It matches the API's openInterest on nearly every row the API lists
  // (125 of 133 on 2026-10-02); the API reports 0 for unlisted questions and is not asked about settled ones, so every
  // row gets this figure
  const escrow = dict();
  for (const n of qNorms) { if (n.settled) continue; for (const id of new Set(n.picks.map((k) => k.id))) escrow[id] = (escrow[id] || 0) + n.pool; }
  for (const q of withOi) q.oi = r2(escrow[q.id] || 0);
  // open predictions per question with every leg (condition id, side) and the stake: whether anyone can still win a
  // question, and who is owed after it resolves, depends on the other legs of each combo, so the page needs them
  const openBy = dict();
  for (const n of qNorms) { if (n.decided) continue; for (const k of n.picks) { if (!isCond(k.id)) continue; (openBy[k.id] || (openBy[k.id] = [])).push({ id: n.id, s: r2(n.stake), p: n.predictor, k: n.picks.map((x) => [x.id, x.yes ? 1 : 0]) }); } }
  for (const q of withOi) if (openBy[q.id]) q.op = openBy[q.id];
  // one file per question with all its predictions, legs keeping their ids (the bettor files drop ids of settled legs)
  const qdir = path.join(outDir, 'questions'); fs.mkdirSync(qdir, { recursive: true });
  const byQ = dict();
  for (const n of qNorms) for (const k of n.picks) if (isCond(k.id)) (byQ[k.id] || (byQ[k.id] = [])).push(n);
  let qfiles = 0;
  for (const q of withOi) {
    const list = (byQ[q.id] || []).sort((a, b) => b.t - a.t);
    // a bettor who traded its position tokens carries what it still held and its own result (h, lp), as the slips do
    fs.writeFileSync(path.join(qdir, q.id + '.json'), JSON.stringify({ id: q.id, q: q.q, builtAt: Date.now(), total: list.length, predictions: list.slice(0, 400).map((n) => Object.assign(P.slim(n, { ids: true }), agg.soldOf(n))) }));
    qfiles++;
  }
  const out = { builtAt: Date.now(), source: process.env.GITHUB_ACTIONS ? 'github-actions' : 'pc', fromSec: P.LAUNCH_SEC, predictions: norms.length, apiTotal: probe, preLaunch, questions: counts ? { all: counts.all.totalCount, open: counts.open.totalCount, settled: counts.settled.totalCount } : null, agg, questionsWithOi: withOi, recentFrom, trades, tradesTotal: trades.total || trades.length, durationMs: Date.now() - t0, requests: P.stats.requests, retries: P.stats.retries };
  fs.writeFileSync(path.join(outDir, 'predict.json'), JSON.stringify(out));
  // the Copy trading page's ideas: winning bettors and their slips the site still offers to copy (a few KB, read on its own)
  const ideas = P.ideas(norms, agg);
  fs.writeFileSync(path.join(outDir, 'predict-ideas.json'), JSON.stringify(Object.assign({ builtAt: out.builtAt, criteria: P.IDEAS }, ideas)));
  console.log(`  predict: ${ideas.bettors.length} winning bettors, ${ideas.ideas.length} open ideas`);
  // a few hundred bytes the site's status page can read without the 1 MB snapshot
  fs.writeFileSync(path.join(outDir, 'predict-status.json'), JSON.stringify({ builtAt: out.builtAt, source: out.source, predictions: norms.length, apiTotal: probe, preLaunch, bettors: agg.bettors.length, makers: P.splitMakers(agg.makers).makers.length, questions: withOi.length, questionsLive, recentFrom, vigCoverage: agg.vig.coverage.withAtBet, vigTotal: agg.vig.coverage.total, vigClean: agg.vig.coverage.clean, vigSameEvent: agg.vig.coverage.sameEvent, selfMatched: agg.totals.selfMatched || 0, trades: trades.length, tradesMapped: trades.filter((t) => t.pc).length, requests: P.stats.requests, retries: P.stats.retries, durationMs: out.durationMs }));
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
    // a truncated file holds the newest 600 and older traded ones only, so what needs every prediction is written here,
    // for the role the page counts (loadBettor: the side with more predictions in the file): its curve and its stake per
    // UTC day. newest: how many of the file's predictions are the newest (the rest are the older traded ones)
    const own = list.filter((n) => !P.selfMatch(n)), keptOwn = kept.filter((n) => !P.selfMatch(n));
    const mk = keptOwn.filter((n) => n.counterparty === addr).length > keptOwn.filter((n) => n.predictor === addr).length;
    const role = own.filter((n) => (mk ? n.counterparty : n.predictor) === addr);
    const curve = truncated ? KC.curveFromPredictions(role, tradesOf[addr] || [], addr) : null;
    const daily = truncated ? (() => { const d = {}; for (const n of role) { const k = Math.floor(n.t / 864e5) * 864e5; d[k] = (d[k] || 0) + (mk ? n.cp : n.stake); } return Object.entries(d).map(([t, v]) => [Number(t), r2(v)]).sort((a, b) => a[0] - b[0]); })() : undefined;
    // the tax center: each prediction's claim transaction and its legs' source-market resolution (stx, vt), the wallet's
    // own redemptions (rd), and in a truncated file a compact row for every prediction of the wallet (rows, rowsFmt), so
    // its period figures are whole
    let rows;
    if (truncated) {
      try { const myPcs = new Set((tradesOf[addr] || []).map((t) => t.pc).filter(Boolean)); rows = P.taxRows(list, addr, (n) => !!(n.pcTraded && myPcs.has(n.pc))); }
      catch (e) { rows = undefined; console.warn('  predict: tax rows failed for', addr, e.message); }
    }
    // what it can claim now, as the app's Claim card counts it (attachClaims; [] for nothing, left out when the read failed)
    const claim = claims ? claims.of[addr] || [] : undefined;
    // a bettor who traded its position tokens carries what it still held and its own result (h, lp), as the slips do, so
    // its prediction opened from the maker's page shows the bettor's side as it stood
    fs.writeFileSync(path.join(dir, addr + '.json'), JSON.stringify({ address: addr, builtAt: out.builtAt, total: list.length, truncated, newest: Math.min(list.length, 600), curve: curve && curve.length >= 2 ? curve : undefined, daily, predictions: kept.map((n) => Object.assign(P.slim(n, { stx: true, vt: true }), agg.soldOf(n))), trades: tradesOf[addr] || undefined, rd: rdOf[addr] || undefined, rows, rowsFmt: rows ? P.ROWS_FMT : undefined, claim }));
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
if (asScript && !doPerps) process.exit(0);

// ------------------------------------------------------------------- Perps
// An account whose row fails twice (or is not reached in the time budget) keeps its row from the newest earlier snapshot
// that has one, so the file lists every account and the pages rank the whole exchange: the row is marked carried with
// the time it was built (a row carried again keeps that time), and the pages say how many rows are older than the
// snapshot and how old. A row older than CARRY_MAX_MS is not carried (the account counts as missing): a week-old PnL
// ranked among current ones misleads more than a gap the pages point out.
export const CARRY_MAX_MS = 7 * 86400000;
/** The rows to publish, in the account list's order: each account's row from this run (built: sid → row), else its
 *  newest row in the earlier snapshots `prevs` (any of them null) no older than CARRY_MAX_MS, else none.
 *  → {rows, carried, missing} */
export function mergeRows(subs, built, prevs, now = Date.now()) {
  const old = new Map();
  for (const s of prevs || []) {
    if (!s || !Array.isArray(s.rows)) continue;
    for (const r of s.rows) {
      if (!r || typeof r.sid !== 'string') continue;
      const at = r.carried && r.builtAt ? r.builtAt : s.builtAt;
      const o = old.get(r.sid);
      if (at > 0 && now - at <= CARRY_MAX_MS && (!o || at > o.at)) old.set(r.sid, { r, at });
    }
  }
  const rows = []; let carried = 0, missing = 0;
  for (const sa of subs) {
    const r = built.get(sa.id), o = r ? null : old.get(sa.id);
    if (r) rows.push(r);
    else if (o) { rows.push(Object.assign({}, o.r, { carried: true, builtAt: o.at })); carried++; }
    else missing++;
  }
  return { rows, carried, missing };
}
/** The snapshots this build replaces: the one in the output directory (a local run's) and the published one (an
 *  Action's checkout has no data/). Either can be absent; nothing here fails the build. */
async function previousSnapshots() {
  const out = [];
  try { out.push(JSON.parse(fs.readFileSync(path.join(outDir, 'leaderboard.json'), 'utf8'))); } catch (_) {}
  try {
    const r = await fetch(A.SITE_URL + '/data/leaderboard.json', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    if (r.ok) out.push(await r.json()); else console.warn(`published leaderboard.json not read: HTTP ${r.status}`);
  } catch (e) { console.warn('published leaderboard.json not read:', e.message); }
  return out;
}
async function buildPerps() {
  const started = Date.now();
  const ctx = { signal: new AbortController().signal };
  const ref = await A.ref(ctx);
  const subs = await A.allSubaccounts({ signal: ctx.signal, ttl: 0 });
  const prices = await A.marketPrices(ref.active.map((p) => p.id), ctx);
  // copy profiles (Copy trading → Leaders): today's books for slippage at each account's size, and one-minute candles for
  // the price drift after each account's fills, shared across accounts
  ctx.copy = await AN.copyContext(ref, ctx);
  console.log(`markets=${ref.active.length} accounts=${subs.length} books=${Object.keys(ctx.copy.depth).length}`);

  // A time budget (--budget seconds, default 9 minutes: the Action's job has 15 and still has to deploy): four accounts are
  // built at a time and one takes two to three seconds from a PC (the Action's runner is about twice as fast), an active one
  // with fills and candles more, and an older one more again, since its funding charges are read three days at a time, one
  // request after another (five to seven seconds at four to five weeks old). So past several hundred accounts the build
  // would outlast the job. Accounts not reached keep their earlier row (mergeRows) and the snapshot is marked partial
  // rather than the whole deploy failing.
  const budgetMs = (args.includes('--budget') ? Number(args[args.indexOf('--budget') + 1]) : 540) * 1000;
  let skipped = 0;
  const results = await U.pLimit(
    subs.map((sa) => async () => { if (Date.now() - started > budgetMs) { skipped++; return null; } return AN.buildLeaderboardRow(sa, ref, prices, ctx); }),
    4,
    (done, total) => { if (done % 25 === 0 || done === total) console.log(`  ${done}/${total} · ${((Date.now() - started) / 1000).toFixed(0)}s`); },
  );
  const built = new Map(), failedAt = [];
  results.forEach((r, i) => { if (r.ok) { if (r.value) built.set(subs[i].id, r.value); } else { failedAt.push(i); console.warn(`row failed ${subs[i].id}: ${r.error && r.error.message}`); } });
  if (skipped) console.warn(`time budget of ${budgetMs / 1000}s reached: ${skipped} of ${subs.length} accounts not built this run`);
  // a failed row is built once more, after a pause and two at a time (one of its many requests timed out or was refused
  // under load), while the budget lasts
  if (failedAt.length) {
    await sleep(3000);
    const again = await U.pLimit(failedAt.map((i) => async () => (Date.now() - started > budgetMs ? null : AN.buildLeaderboardRow(subs[i], ref, prices, ctx))), 2);
    again.forEach((r, j) => { const sa = subs[failedAt[j]]; if (r.ok && r.value) built.set(sa.id, r.value); else console.warn(`row failed again ${sa.id}: ${r.ok ? 'time budget reached' : r.error && r.error.message}`); });
  }
  const failed = failedAt.filter((i) => !built.has(subs[i].id)).length;

  const { rows, carried, missing } = mergeRows(subs, built, built.size < subs.length ? await previousSnapshots() : []);
  // partial: not every account was built by this run (carried: rows from an earlier snapshot; missing: accounts without a row)
  const out = { builtAt: Date.now(), rows, partial: failed > 0 || skipped > 0, source: process.env.GITHUB_ACTIONS ? 'github-actions' : 'local', accounts: subs.length, failed, skipped, retried: failedAt.length, carried, missing, budgetS: budgetMs / 1000, durationMs: Date.now() - started };
  fs.writeFileSync(path.join(outDir, 'leaderboard.json'), JSON.stringify(out));
  const profiled = rows.filter((r) => r.copy && r.copy.driftN).length;
  console.log(`wrote ${path.join(outDir, 'leaderboard.json')}: ${rows.length} rows (${built.size} built, ${carried} carried over, ${missing} missing; ${profiled} with fill drift, ${ctx.copy.candles.size()} candle windows), ${failed} failed (${failedAt.length} retried), ${skipped} skipped, ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (!built.size) process.exit(1);   // nothing built this run: the step fails (the file still carries the earlier rows)
}
if (doPerps) await buildPerps();
