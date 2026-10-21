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
// The API's claimable positions can lag the chain: on 2026-10-20 it still listed 40 tokens for 0xc1ce…2bf2 to claim on a
// July win, though the wallet had sold them to the Vault in the very transactions that placed its bets and redeemed the
// rest on 15 Sep (its balance of the token is 0; every other listed position matched the chain). So each listed position
// is read on-chain, its side's position token's balanceOf at the chain head (40 calls a request): the lower balance
// counts and a position the chain shows empty is dropped. A failed read keeps the API's answer (agg.claimOnChain unset).
/** The reads for a claimable read's positions (of: wallet → [{pc, side, bal}]): each position with its side's token,
 *  from the predictions' tokens (a position whose token no prediction carries is not read). */
export function claimReads(of, norms) {
  const tokOf = dict();
  for (const n of norms) { const pc = String(n.pc || '').toLowerCase(); if (!pc) continue; if (n.tokP) tokOf[pc + '|P'] = n.tokP; if (n.tokC) tokOf[pc + '|C'] = n.tokC; }
  const out = [];
  for (const a of Object.keys(of)) for (const e of of[a]) { const tok = tokOf[String(e.pc || '').toLowerCase() + '|' + e.side]; if (tok && isAddr(a)) out.push({ a, e, tok }); }
  return out;
}
/** The balanceOf call for a read: {method, params} for rpcBatch. */
export const balanceCall = (r) => ({ method: 'eth_call', params: [{ to: r.tok, data: '0x70a08231' + r.a.slice(2).padStart(64, '0') }, 'latest'] });
/** Apply the chain's answers (rpcBatch results, in the reads' order) to the positions in `of`: a lower balance counts (to a
 *  millionth of a USDe, as claimEntries), an empty position is dropped, a call without an answer leaves the API's balance.
 *  Returns {read, lowered, dropped, unread}. */
export function capClaims(of, reads, results) {
  let lowered = 0, unread = 0;
  reads.forEach((r, i) => {
    const x = results[i]; const hex = x && !x.error && typeof x.result === 'string' ? x.result : null;
    if (!hex || !/^0x[0-9a-f]+$/i.test(hex)) { unread++; return; }
    // 18 decimals, rounded to a millionth as claimEntries rounds the API's balance (truncating made equal balances differ
    // by 0.000001); a winning token pays 1 USDe
    const bal = Math.round(Number(BigInt(hex)) / 1e12) / 1e6;
    if (bal < r.e.bal - 5e-7) { r.e.bal = bal; lowered++; }
  });
  let dropped = 0;
  for (const a of Object.keys(of)) { const before = of[a].length; of[a] = of[a].filter((e) => e.bal > 1e-9); dropped += before - of[a].length; }
  return { read: reads.length - unread, lowered, dropped, unread };
}
// ---------------------------------------------------------------- Meridian OI (the Questions page)
// Meridian's open interest on a question (its app's Open Interest sort, its API's openInterest) is the collateral still in
// escrow behind the predictions on it, a combo in full on each of its questions. On-chain, per pick configuration:
// undecided → its bettor-side token's totalSupply (each P + C pair is 1 USDe in escrow; a market maker that buys a bettor's
// side back and merges the pair takes it out), decided → the winning token's totalSupply (what its holders can still
// redeem). Checked 2026-10-20: equal to the API's figure on 298 of 301 questions, the other three bet on between the
// reads. The figure from the predictions' own pools overstated it where a maker had merged a bought-back bet (0x3f6a…'s
// two Fed singles, sold to 0xea41… on Oct 16: $3.5K each), and the API gives unlisted questions 0, the chain their real
// figure. A decided pick configuration read empty stays empty (its tokens are redeemed and no new ones are minted), so the
// price cache keeps those ('oiDone') and a run reads only the rest. A failed read throws (the caller falls back).
/** The supply reads for the pick configurations on these questions (want: a Set of condition ids), less the drained
 *  decided ones in done: [{pc, ids, tok, decided}], the token being the bettor side's (undecided) or the winner's. */
export function escrowReads(norms, want, done = {}) {
  const pcs = new Map();
  for (const n of norms) {
    if (!n.pc) continue; const ids = n.picks.map((k) => k.id); if (!ids.some((id) => want.has(id))) continue;
    const x = pcs.get(n.pc) || { pc: n.pc, ids: new Set(), tokP: n.tokP, tokC: n.tokC, decided: false, makerWon: false };
    ids.forEach((id) => x.ids.add(id));
    if (n.decided) { x.decided = true; x.makerWon = !n.won && !n.nd; }
    pcs.set(n.pc, x);
  }
  return Array.from(pcs.values()).filter((x) => !(x.decided && done[x.pc])).map((x) => ({ pc: x.pc, ids: Array.from(x.ids), tok: x.decided && x.makerWon ? x.tokC : x.tokP, decided: x.decided })).filter((r) => r.tok);
}
/** The escrow per question from the supply answers (rpcBatch results, in the reads' order): {per: {id: USDe}, drained:
 *  [pc] (decided, empty: never read again), unread}. */
export function escrowSum(reads, results) {
  const per = {}, drained = []; let unread = 0;
  reads.forEach((r, i) => {
    const x = results[i]; const hex = x && !x.error && typeof x.result === 'string' && /^0x[0-9a-f]+$/i.test(x.result) ? x.result : null;
    if (!hex) { unread++; return; }
    const v = Number(BigInt(hex)) / 1e18;
    if (r.decided && v < 1e-9) drained.push(r.pc);
    for (const id of r.ids) per[id] = (per[id] || 0) + v;
  });
  return { per, drained, unread };
}
async function escrowOnChain(norms, want) {
  let cache = {}; try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (_) {}
  const done = Object.assign(dict(), cache.oiDone && typeof cache.oiDone === 'object' ? cache.oiDone : null);
  const reads = escrowReads(norms, want, done), results = [];
  for (let i = 0; i < reads.length; i += 25) { if (i) await sleep(250); results.push(...await rpcBatch(reads.slice(i, i + 25).map((r) => ({ method: 'eth_call', params: [{ to: r.tok, data: '0x18160ddd' }, 'latest'] })))); }
  const s = escrowSum(reads, results);
  if (s.unread) throw new Error(`${s.unread} of ${reads.length} token supplies unread`);
  for (const pc of s.drained) done[pc] = 1;
  try { const cur = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); cur.oiDone = done; fs.writeFileSync(cacheFile, JSON.stringify(cur)); }
  catch (_) { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify({ oiDone: done })); }
  return s.per;
}
// The fee Meridian's Polygon reader asks to send a question's result over to Robinhood Chain (quoteResolution; anyone can
// send it with requestResolution): 2.9 POL on 2026-09-23, 0.111 on 2026-10-20, so the page quotes it from each snapshot
const POLYGON_RPC = 'https://polygon-bor-rpc.publicnode.com', POLYGON_READER = '0x3E402e220fB36f4d849F8B3B3b139f68ddb69c98';
async function quoteRelayFee(conditionId) {
  if (!isCond(conditionId)) return null;
  const r = await fetch(POLYGON_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: POLYGON_READER, data: '0x8439252e' + conditionId.slice(2).toLowerCase().padStart(64, '0') }, 'latest'] }), signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  if (j.error || typeof j.result !== 'string' || j.result.length < 66) return null;
  return Number(BigInt(j.result.slice(0, 66))) / 1e18;
}

async function checkClaimsOnChain(norms, claims) {
  const reads = claimReads(claims.of, norms), results = [];
  for (let i = 0; i < reads.length; i += 40) { if (i) await sleep(300); results.push(...await rpcBatch(reads.slice(i, i + 40).map(balanceCall))); }
  const r = capClaims(claims.of, reads, results);
  console.log(`  predict: claimable positions read on-chain: ${r.read} of ${reads.length}, ${r.lowered} hold less than the API lists (${r.dropped} nothing)${r.unread ? `, ${r.unread} unread (the API's balance stands)` : ''}`);
  return r.unread === 0;
}

// ---------------------------------------------------------------- Meridian's own lists
// The site's origin cannot ask the Predict API, so what Meridian's app lists beside the predictions travels with the
// snapshot: its competitions and their standings, its PnL ranking, the matches the listed questions belong to, its Hot
// lists and its most used tags. A left-out wallet (P.EXCLUDED) is in none of them.
const round2 = (x) => Math.round(x * 100) / 100;
const numOr = (v) => (v == null || v === '' ? null : Number(v) || 0);
const outWallet = (a) => !isAddr(a) || P.EXCLUDED.has(a);
export const COMP_STANDINGS = 25;
/** A competition as the snapshot keeps it: its window (ms), prizes by place, rules, how many matches, groups and
 *  questions it names (and how many questions qualify in all), and its standings best first, up to COMP_STANDINGS: each
 *  entry's place, wallet, multiplier, payout and stake (USDe) and the prediction behind it. */
export function compactCompetition(c, standings, eligibleN, out = outWallet, legsOf = null) {
  const k = (c && c.eligibleMarketKinds) || {};
  const rows = (standings || []).map((x) => Object.assign({}, x, { account: String((x && x.account) || '').toLowerCase() })).filter((x) => !out(x.account)).sort((a, b) => a.rank - b.rank);
  return {
    slug: c.slug, title: c.title, label: c.label || null, start: c.startsAt ? Date.parse(c.startsAt) : null, end: c.endsAt ? Date.parse(c.endsAt) : null,
    payouts: (c.payouts || []).map((v) => Number(v) || 0), unit: c.prizeUnit || 'USDe', minStake: Number(c.minStake) || 0, minLegs: c.minLegs || null, rankBy: c.rankBy || null, noEarlySales: !!c.disqualifyEarlySales,
    markets: { games: (k.gameEventIds || []).length, groups: (k.groupIds || []).length, questions: (k.conditionIds || []).length, eligible: eligibleN == null ? null : eligibleN },
    entries: rows.length,
    // l: the prediction's legs, from the snapshot's own predictions (the standings do not carry them)
    standings: rows.slice(0, COMP_STANDINGS).map((x) => { const id = x.predictionId || null, l = id && legsOf ? legsOf.get(String(id).toLowerCase()) : null; return Object.assign({ r: x.rank, a: x.account, m: x.multiplier == null ? null : Math.round(Number(x.multiplier) * 1e4) / 1e4, p: round2(P.usd(x.payout)), s: round2(P.usd(x.stake)), id }, l ? { l } : null); }),
  };
}
async function readCompetitions(legsOf) {
  const d = await P.gql('{ competitions { slug title label startsAt endsAt payouts prizeUnit minStake minLegs rankBy disqualifyEarlySales eligibleMarketKinds { gameEventIds groupIds conditionIds } } }');
  const out = [];
  for (const c of (d && d.competitions) || []) {
    let st = [], elig = null;
    try {
      const s = await P.gql('query($s: String!) { competition(slug: $s) { eligibleConditionIds leaderboard { rank account multiplier predictionId payout stake } } }', { s: c.slug });
      st = (s.competition && s.competition.leaderboard) || []; elig = s.competition && Array.isArray(s.competition.eligibleConditionIds) ? s.competition.eligibleConditionIds.length : null;
    } catch (e) { console.warn('  predict: the standings of competition', shown(c.slug), 'failed:', e.message); }
    out.push(compactCompetition(c, st, elig, outWallet, legsOf));
  }
  return out.sort((a, b) => (b.end || 0) - (a.end || 0));
}
// Meridian's monthly Predict Leaderboard, before the competitions above: its app works the standings out from the
// predictions (no API list) and still shows them (read from its code 2026-10-21). Four cycles from 1 July 2026 16:00 UTC,
// three of 21 days (the third runs to 3 September), then 3 to 30 September, which its competitions page lists as "Monthly
// Competition"; its leaderboard page steps back through the others. Each pays the same USD prizes plus a token bonus.
const LEGACY_START = Date.UTC(2026, 6, 1, 16), LEGACY_LEN = 21 * 86400000, LEGACY_SEP = Date.UTC(2026, 8, 3, 16), LEGACY_END = Date.UTC(2026, 8, 30, 16);
export const LEGACY_PAYOUTS = [2500, 1000, 500, 250, 250, 100, 100, 100, 100, 100];
const LEGACY_BONUS = [['$cashcat', [25000, 10000, 5000, 2500, 2500, 1000, 1000, 1000, 1000, 1000]], ['PONS', [75000, 30000, 15000, 7500, 7500, 3000, 3000, 3000, 3000, 3000]], ['$cashcat', [12500, 5000, 2500, 1250, 1250, 500, 500, 500, 500, 500]], ['HOOD', [25, 10, 5, 2.5, 2.5, 1, 1, 1, 1, 1]]];
// the predictions its leaderboard never counts (its blocklist)
const LEGACY_BLOCKED = new Set(['0x06cd38afaf33dd44a568f94c470c34d489c14501632f9ad7689bf653a3e9ef67', '0x6c76074155c95246a73067468afe58048209343c162716e69d0e442ee894067a', '0x1077e445321906fd538d71a99eef82b53e5876fa399a079f5d8f0aa2c3d5ecbf', '0xc3a988f69e93b9b98949d65bb0c7f47b98fdba530e95f8dd6335781ac1c5ca62', '0xdaf737c407de9ad1f634af43de2fcba71cd9caa42ca48a24720ae3d1197225de', '0x1b2b2d8ae56dfe1c2ffe66e2f75f013df68788e11369148522fb2c161a86b368', '0x0290d6f345542f309b893c533522a7876ec0d16913e999112c03d48613d144d4', '0x0d78b3ebf74d965da67306d86f5e04a0f85c3173cc79e43f401cf5b6a3ee8f55', '0xdf8fed35fa06803db437b25e04ed0ab82ded79e184767556b08a413c45c2782b', '0xd1b7abde2332f097fa2d32fe519ad184161f04c1df3183853c5f080d0a5c0ab8', '0xeda70ffcafc0d1e1e85ca10c889993bc57707f08bb9027b6bd146c7bade4168c', '0xf165c34b7193512273387cd832d82d10bc152ffbd50b2ee9985d43a4ee25ee9f', '0x92920d295b090fc901f8f90450bdff004a53be12d07b306845342c1e3d1b0057']);
export const legacyCycle = (i) => { const start = i <= 2 ? LEGACY_START + i * LEGACY_LEN : LEGACY_SEP; return { i, start, end: i === 2 ? LEGACY_SEP : i === 3 ? LEGACY_END : start + LEGACY_LEN }; };
/** A cycle's standings as its app works them out: a winning prediction (settled by the API's own claim, not one paid by
 *  a claim on its token) of 2 legs or more and a stake of 25 or more, placed and settled within the cycle, not on the
 *  blocklist, whose bettor sold none of its tokens before the settlement (trades within the cycle); each wallet's best
 *  multiplier (payout ÷ stake), best first, ranked before the left-out wallets go. (The app also wants every leg resolved
 *  by Meridian's own resolver: all were in these cycles, its 37 standings of September checked 2026-10-21.) */
export function legacyStandings(norms, trades, cy, out = outWallet) {
  const firstSale = new Map();
  for (const t of trades || []) { if (!(t.t >= cy.start && t.t <= cy.end)) continue; const k = t.seller + '|' + t.token, x = firstSale.get(k); if (x === undefined || t.t < x) firstSale.set(k, t.t); }
  const best = new Map();
  for (const n of norms || []) {
    if (!n.settled || n.viaToken || n.result !== 'PREDICTOR_WINS' || n.legs < 2 || LEGACY_BLOCKED.has(String(n.id).toLowerCase())) continue;
    const sa = n.settledAt; if (!sa || sa < cy.start || sa > cy.end || !(n.t >= cy.start && n.t <= cy.end)) continue;
    if (n.tokP) { const s = firstSale.get(n.predictor + '|' + n.tokP); if (s !== undefined && s < sa) continue; }
    if (!(n.stake >= 25)) continue;
    const m = (n.stake + n.cp) / n.stake, b = best.get(n.predictor);
    if (!b || m > b.m) best.set(n.predictor, { a: n.predictor, m, s: n.stake, p: n.stake + n.cp, id: n.id, l: n.legs });
  }
  return [...best.values()].sort((a, b) => b.m - a.m).map((x, i) => Object.assign(x, { r: i + 1 })).filter((x) => !out(x.a));
}
/** The four cycles as the snapshot keeps a competition (compactCompetition), with `bonus` (the token prizes by place),
 *  `legacy` (the cycle, for its app's link) and `weeks` (its app's "3-Week Competition") */
export function legacyCompetitions(norms, trades, out = outWallet) {
  const day = (t) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(t);
  return [0, 1, 2, 3].map((i) => {
    const cy = legacyCycle(i), rows = legacyStandings(norms, trades, cy, out), [unit, bonus] = LEGACY_BONUS[i];
    return {
      slug: 'legacy-cycle-' + i, title: i === 3 ? 'Monthly Competition' : 'Predict Leaderboard · ' + day(cy.start) + ' – ' + day(cy.end), label: 'Predict Leaderboard', legacy: i, weeks: Math.round((cy.end - cy.start) / (7 * 86400000)),
      start: cy.start, end: cy.end, payouts: LEGACY_PAYOUTS.slice(), unit: 'USD', bonus: { unit, payouts: bonus.slice() }, minStake: 25, minLegs: 2, rankBy: 'MULTIPLIER', noEarlySales: true,
      markets: null, entries: rows.length,
      standings: rows.slice(0, COMP_STANDINGS).map((x) => ({ r: x.r, a: x.a, m: Math.round(x.m * 1e4) / 1e4, p: round2(x.p), s: round2(x.s), id: x.id, l: x.l })),
    };
  });
}
/** Meridian's PnL ranks by wallet (its app's leaderboard): { address: [rank, PnL in USDe] }, its own ranks. */
export function rankMap(nodes, out = outWallet) {
  const m = dict();
  for (const x of nodes || []) { const a = String((x && x.account && x.account.address) || '').toLowerCase(); if (!out(a) && x.rank != null) m[a] = [x.rank, round2(P.usd(x.pnl))]; }
  return m;
}
/** All time and over the last 30 days, the window its app ranks its top traders by (its social search): { n (wallets
 *  ranked), all, n30, d30, at }. */
async function readPnlRanks() {
  const read = async (since) => {
    const nodes = []; let after = null, pages = 0, total = null;
    do {
      const d = await P.gql('query($first: Int!, $since: Int!, $after: String) { leaderboard(metric: PNL, first: $first, after: $after, filter: { timestamp: { gte: $since } }) { totalCount pageInfo { hasNextPage endCursor } nodes { rank pnl account { address } } } }', { first: P.PAGE, since, after });
      const lb = d.leaderboard || {}; if (total == null) total = lb.totalCount;
      nodes.push(...(lb.nodes || [])); pages++;
      after = lb.pageInfo && lb.pageInfo.hasNextPage ? lb.pageInfo.endCursor : null;
    } while (after && pages < 80);
    return { n: total, map: rankMap(nodes) };
  };
  const all = await read(0), d30 = await read(Math.floor(Date.now() / 1000) - 30 * 86400);
  return { n: all.n, all: all.map, n30: d30.n, d30: d30.map, at: Date.now() };
}
/** A match (Meridian's cluster of the questions on one event) as the snapshot keeps it: name, start (ms), league, and the
 *  app's volume over 24 hours and 7 days (the mirrored markets', low-odds trading left out; the API answers at most two
 *  volume windows in one request). */
export const compactMatch = (p) => ({ n: p.name || null, t: p.startTime ? Date.parse(p.startTime) : null, lg: (p.teams || []).map((t) => t.league).find(Boolean) || null,
  v: { d1: numOr(p.d1), d7: numOr(p.d7) } });
export async function readMatches(evIds) {   // exported for a check against the live API
  const ids = Array.from(new Set((evIds || []).filter((x) => x != null && x !== '').map(String)));
  const out = dict(), win = (w) => `displayVolume(filter: {}, window: ${w}, excludeLowOdds: true)`;
  for (let i = 0; i < ids.length; i += P.PAGE) {
    const d = await P.gql(`query($ids: [String!]!, $n: Int!) { clustersConnection(first: $n, filter: { externalEventIds: $ids }) { nodes { preview { externalEventId name startTime teams { league } d1: ${win('TWENTY_FOUR_HOURS')} d7: ${win('SEVEN_DAYS')} } } } }`, { ids: ids.slice(i, i + P.PAGE), n: P.PAGE });
    for (const n of (d.clustersConnection && d.clustersConnection.nodes) || []) { const p = n && n.preview; if (p && p.externalEventId != null && p.name) out[String(p.externalEventId)] = compactMatch(p); }   // (some come without a name: nothing to show)
  }
  return out;
}
// Meridian's app's question list as it opens (its default view, hotFilter): questions not resolved yet, in every category
// but the price ones, the 15-minute up/down questions left out, a chance between 1 and 99 % (it hides the others until
// asked), a match's questions as one entry; sorted by the mirrored markets' volume over a window of its sort menu
// (Breaking 1H, Trending 4H, Hot 24H, its default, Top 7D), low-odds trading left out. As its code builds it (read
// 2026-10-21), with the groups it never lists (its disabledPredictGroups), its price categories and its first page of 15.
export const HOT_N = 15, HOT_HIDDEN_GROUPS = new Set([925, 926]), HOT_NO_CATS = new Set(['prices-crypto', 'prices-equity', 'prices-commodities']);
export const HOT_WINDOWS = {
  h1: { order: 'SIMILAR_MARKET_VOLUME_1H_FILTERED', filter: 'ONE_HOUR_FILTERED', cluster: 'ONE_HOUR', field: 'similarMarketVolumeFiltered1h' },
  h4: { order: 'SIMILAR_MARKET_VOLUME_4H_FILTERED', filter: 'FOUR_HOURS_FILTERED', cluster: 'FOUR_HOURS', field: 'similarMarketVolumeFiltered4h' },
  d1: { order: 'SIMILAR_MARKET_VOLUME_24H_FILTERED', filter: 'TWENTY_FOUR_HOURS_FILTERED', cluster: 'TWENTY_FOUR_HOURS', field: 'similarMarketVolumeFiltered24h' },
  d7: { order: 'SIMILAR_MARKET_VOLUME_7D_FILTERED', filter: 'SEVEN_DAYS_FILTERED', cluster: 'SEVEN_DAYS', field: 'similarMarketVolumeFiltered7d' },
};
export const hotFilter = (cats, win) => ({ categorySlugs: cats, resolutionStatus: 'UNRESOLVED', excludeTags: ['15 Minute Up/Down'], estimatedPrice: { gte: 0.01, lte: 0.99 }, similarMarketVolumeWindow: HOT_WINDOWS[win].filter, clustered: true });
/** Whether the app lists a group: one of its questions between 1 and 99 % (or without a price), or all of them settled */
const hotGroupShown = (cs) => cs.length > 0 && (cs.every((c) => c.settled) || cs.some((c) => { const p = c.estimatedPrice == null ? NaN : Number(c.estimatedPrice); return !Number.isFinite(p) || (p >= 0.01 && p <= 0.99); }));
/** A Hot list as the snapshot keeps it, in the app's order: a match (k 'm': its name, start, league and the API's volume
 *  of its questions over the window), a group (k 'g': its questions' volumes added up, every one of them, and how many)
 *  or a question (k 'c'), each with its category and match (ev). `nodes`: the list's nodes, a group's questions all read
 *  (the API pages them 25 at a time), their volume as `vol`. The groups the app does not list are left out. */
export function hotRows(nodes, hidden = HOT_HIDDEN_GROUPS) {
  const gid = (x) => (x == null ? null : Number(x)), ev = (x) => (x == null || x === '' ? null : String(x));
  return (nodes || []).filter(Boolean).map((n) => {
    if (n.__typename === 'ConditionGroupCluster') {
      const p = n.preview || {};
      if (!p.name || hidden.has(gid(p.anchorGroup && p.anchorGroup.groupId))) return null;
      return { k: 'm', id: ev(p.externalEventId), q: p.name, cat: p.category ? p.category.name : null, ev: ev(p.externalEventId), t: p.startTime ? Date.parse(p.startTime) : null, lg: (p.teams || []).map((t) => t && t.league).find(Boolean) || null, v: round2(Number(p.vol) || 0) };
    }
    if (n.__typename === 'ConditionGroup') {
      const cs = (n.conditions && n.conditions.nodes) || [];
      if (hidden.has(gid(n.groupId)) || !hotGroupShown(cs)) return null;
      return { k: 'g', id: String(n.groupId), q: n.name, cat: n.category ? n.category.name : null, ev: ev(n.externalEventId), v: round2(cs.reduce((s, c) => s + (Number(c.vol) || 0), 0)), n: cs.length };
    }
    if (n.__typename === 'Condition') {
      if (hidden.has(gid(n.conditionGroup && n.conditionGroup.groupId))) return null;
      return { k: 'c', id: n.conditionId, q: n.question, cat: n.category ? n.category.name : null, ev: ev(n.conditionGroup && n.conditionGroup.externalEventId), v: round2(Number(n.vol) || 0) };
    }
    return null;
  }).filter(Boolean);
}
/** Meridian stake by group and by match (the questions sharing an event id), each prediction once however many of its
 *  legs are in it: { g: { groupId: USDe }, ev: { eventId: USDe } }; `qOf` maps a question id to its listed row (g, ev).
 *  A question's own sw counts a combo on every question it includes, so adding those up would count it twice. */
export function stakeByGroup(norms, qOf) {
  const g = dict(), ev = dict();
  for (const n of norms || []) {
    const gs = new Set(), es = new Set();
    for (const k of n.picks || []) { const q = qOf.get(k.id); if (!q) continue; if (q.g != null) gs.add(String(q.g)); if (q.ev != null) es.add(String(q.ev)); }
    for (const x of gs) g[x] = (g[x] || 0) + n.stake;
    for (const x of es) ev[x] = (ev[x] || 0) + n.stake;
  }
  return { g, ev };
}
/** The Hot lists' rows with mw, the stake placed through Meridian on the question (`swOf`), the group or the match
 *  (stakeByGroup), where there is any; `stakes` marks a snapshot that has them */
export function hotStakes(hot, swOf, by) {
  for (const w of Object.keys(HOT_WINDOWS)) for (const r of (hot && hot[w]) || []) { const v = r.k === 'g' ? by.g[r.id] : r.k === 'm' ? by.ev[r.ev] : swOf(r.id); if (v > 0) r.mw = round2(v); }
  if (hot) hot.stakes = true;
  return hot;
}
/** One list (a key of HOT_WINDOWS): its first page, then the rest of each group's questions the way the app reads them
 *  (the same request again from the group's cursor) */
async function readHotList(cats, win) {
  const w = HOT_WINDOWS[win], f = hotFilter(cats, win);
  const query = `query($f: QuestionFilter!, $n: Int!, $gca: String) { questions(first: $n, filter: $f, orderBy: { field: ${w.order}, direction: DESC }) { edges { node { __typename
    ... on Condition { conditionId question vol: ${w.field} category { name } conditionGroup { groupId externalEventId } }
    ... on ConditionGroup { groupId name externalEventId category { name } conditions(first: 25, after: $gca) { nodes { vol: ${w.field} estimatedPrice settled } pageInfo { hasNextPage endCursor } } }
    ... on ConditionGroupCluster { preview { name externalEventId startTime category { name } anchorGroup { groupId } teams { league } vol: displayVolume(filter: $f, window: ${w.cluster}, excludeLowOdds: true) } } } } } }`;
  const nodesOf = (d) => ((d.questions && d.questions.edges) || []).map((e) => e && e.node).filter(Boolean);
  const nodes = nodesOf(await P.gql(query, { f, n: HOT_N }));
  for (const g of nodes) {
    if (g.__typename !== 'ConditionGroup' || !g.conditions) continue;
    let pi = g.conditions.pageInfo || {}, pages = 0;
    while (pi.hasNextPage && pi.endCursor && pages++ < 8) {
      const again = nodesOf(await P.gql(query, { f, n: HOT_N, gca: pi.endCursor })).find((x) => x.__typename === 'ConditionGroup' && String(x.groupId) === String(g.groupId));
      if (!again || !again.conditions) break;
      g.conditions.nodes = (g.conditions.nodes || []).concat(again.conditions.nodes || []); pi = again.conditions.pageInfo || {};
    }
  }
  return hotRows(nodes);
}
/** All four lists; one that fails is left out (its tab with it) and the others kept: on 2026-10-21 18:13 CEST one
 *  timeout cost the snapshot every list. Throws only when none could be read. */
export async function readHot() {   // exported for a check against the live API
  const cats = ((await P.gql('{ categories(first: 25) { nodes { slug } } }')).categories.nodes || []).map((c) => c.slug).filter((s) => s && !HOT_NO_CATS.has(s));
  const out = { at: Date.now() }, failed = [];
  for (const win of Object.keys(HOT_WINDOWS)) { try { out[win] = await readHotList(cats, win); } catch (e) { failed.push(win + ': ' + e.message); } }
  if (failed.length === Object.keys(HOT_WINDOWS).length) throw new Error(failed.join('; '));
  if (failed.length) console.warn('  predict: Hot lists left out (' + failed.join('; ') + ')');
  return out;
}
async function readTags() {
  const d = await P.gql('{ tags(first: 20, orderBy: { field: CONDITION_COUNT, direction: DESC }) { nodes { name } } }');
  return ((d.tags && d.tags.nodes) || []).map((t) => t.name).filter(Boolean);
}

// ---------------------------------------------------------------- wallets' cash
// Each wallet's deposits and withdrawals on Meridian's chain as its app lists them (collateralTransfers without the
// protocol's own) and its cash balance day by day (collateralBalanceHistory), kept in a cache beside the price cache. A
// build reads the wallets never read (the most recently active first), then those active since their last read, then
// those not read for a week, within a request budget; the rest wait for a later build.
const cashFile = path.join(path.dirname(cacheFile), 'predict-cash.json');
export const CASH_BUDGET = 240, CASH_PAGES = 8, CASH_STALE_MS = 7 * 86400000;
/** The wallets a build reads, in order: `active` maps each wallet to its last activity (ms), `cache` holds what was read. */
export function cashPlan(active, cache, now, max) {
  const never = [], since = [], stale = [];
  for (const [a, t] of Object.entries(active)) {
    const c = cache[a];
    if (!c) never.push([a, t]); else if (t > c.at) since.push([a, t]); else if (now - c.at > CASH_STALE_MS) stale.push([a, t]);
  }
  const by = (x, y) => y[1] - x[1];
  return never.sort(by).concat(since.sort(by), stale.sort(by)).slice(0, max).map((x) => x[0]);
}
/** A wallet's transfers as its file keeps them, newest first: [ms, USDe (+ in, − out), the other address, tx]. */
export function cashTransfers(nodes, addr) {
  return (nodes || []).map((x) => {
    const from = String(x.from || '').toLowerCase(), to = String(x.to || '').toLowerCase(), v = round2(P.usd(x.value)), out = from === addr;
    return [Date.parse(x.timestamp), out ? -v : v, out ? to : from, x.transactionHash || null];
  }).filter((x) => x[0] && x[1]).sort((a, b) => b[0] - a[0]);
}
/** Its balance day by day, oldest first: [ms, USDe], from `from` on (the history runs back as far as it is paged, at 0
 *  before the wallet had anything) and from the day before its first balance that is not 0. */
export const cashBalances = (nodes, from = 0) => {
  const list = (nodes || []).map((x) => [Date.parse(x.timestamp), round2(P.usd(x.amount))]).filter((x) => x[0] && x[0] >= from).sort((a, b) => a[0] - b[0]);
  const i = list.findIndex((x) => x[1] !== 0);
  return i < 0 ? [] : list.slice(Math.max(0, i - 1));
};
/** Where a wallet's balance history needs reading back to: two days before its first activity or transfer, not before
 *  the exchange's start. */
export const cashFrom = (first, xf) => { const t = Math.min(first || Infinity, ...(xf || []).map((x) => x[0])); return Number.isFinite(t) ? Math.max(P.EXCHANGE_START_SEC * 1000, t - 2 * 86400000) : P.EXCHANGE_START_SEC * 1000; };
/** One wallet, at most `budget` requests; `first` its first prediction or trade (ms). cut: the budget ran out before its
 *  history did (then it is read again later). */
async function readCashOf(addr, budget, first) {
  let used = 0;
  const all = async (q, pick, stop) => {
    const nodes = []; let after = null, pages = 0;
    do {
      used++; const c = pick(await P.gql(q, { a: addr, c: P.CHAIN, first: P.PAGE, after })) || {}; const got = c.nodes || [];
      nodes.push(...got); pages++; after = c.pageInfo && c.pageInfo.hasNextPage ? c.pageInfo.endCursor : null;
      if (stop && got.length && stop(got[got.length - 1])) after = null;   // the page reached back far enough
    } while (after && pages < CASH_PAGES && used < budget);
    return { nodes, cut: !!after && pages < CASH_PAGES };
  };
  const xf = await all('query($a: Address!, $c: Int, $first: Int!, $after: String) { collateralTransfers(first: $first, after: $after, filter: { account: $a, chainId: $c, excludeProtocol: true }, orderBy: { field: TIMESTAMP, direction: DESC }) { pageInfo { hasNextPage endCursor } nodes { from to timestamp transactionHash value } } }', (d) => d.collateralTransfers);
  const transfers = cashTransfers(xf.nodes, addr), from = cashFrom(first, transfers);
  const bh = xf.cut ? { nodes: [], cut: true } : await all('query($a: Address!, $c: Int, $first: Int!, $after: String) { account(address: $a, chainId: $c) { collateralBalanceHistory(first: $first, after: $after, intervalSeconds: 86400) { pageInfo { hasNextPage endCursor } nodes { timestamp amount } } } }', (d) => d.account && d.account.collateralBalanceHistory, (x) => Date.parse(x.timestamp) < from);
  return { used, cut: xf.cut || bh.cut, entry: { at: Date.now(), xf: transfers, bh: cashBalances(bh.nodes, from) } };
}
async function readCash(active, first) {
  let cache = dict();
  try { Object.assign(cache, JSON.parse(fs.readFileSync(cashFile, 'utf8')).w || {}); } catch (_) {}
  let used = 0, read = 0;
  for (const a of cashPlan(active, cache, Date.now(), CASH_BUDGET)) {
    if (used >= CASH_BUDGET) break;
    try { const r = await readCashOf(a, CASH_BUDGET - used, first[a]); used += r.used; if (!r.cut) { cache[a] = r.entry; read++; } }
    catch (e) { used++; console.warn('  predict: the cash of', a, 'failed:', e.message); }
  }
  try { fs.mkdirSync(path.dirname(cashFile), { recursive: true }); fs.writeFileSync(cashFile, JSON.stringify({ v: 1, w: cache })); }
  catch (e) { console.warn('  predict: the cash cache was not saved:', e.message); }
  console.log(`  predict: cash of ${read} wallets read (${used} requests), ${Object.keys(cache).length} kept, ${cashPlan(active, cache, Date.now(), Infinity).length} left for later builds`);
  return cache;
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
  // a left-out wallet's bets (P.EXCLUDED) are not in any file the site reads
  const all = (limit ? raw.slice(0, limit) : raw).map(P.norm).filter((n) => !P.excluded(n));
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
  let claimOnChain = false;
  if (claims) { try { claimOnChain = await checkClaimsOnChain(norms, claims); } catch (e) { console.warn('predict: on-chain read of the claimable positions failed, the API\'s balances stand:', e.message); } }
  const agg = P.aggregate(norms, { tapeSize: 25, trades, claims: claims ? claims.of : null });   // the Overview's tape shows 25
  if (claims) { agg.claimAt = claims.at; if (claimOnChain) agg.claimOnChain = true; }
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
      // u: decided, payout not claimed yet: its winner still holds the winning tokens where the balances were read
      // (n.toClaim, P.aggregate), else the settled flag (settling and claiming are separate steps on Meridian)
      a.n++; a.sw += n.stake; if (!n.decided) { a.b++; a.s += n.stake; if (k.yes) a.by++; else a.bn++; } else if (n.toClaim != null ? n.toClaim : !n.settled) a.u++; if (n.t > a.l) a.l = n.t;   // by / bn: open bets on YES / NO
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
  // the rows taken from predictions carry no source link and no volume: Meridian's API has both (by condition id)
  const byQid = new Map(withOi.map((q) => [String(q.id).toLowerCase(), q]));
  const bare = withOi.filter((q) => q.src == null);
  try {
    for (let i = 0; i < bare.length; i += 25) {
      const pg = await P.conditions({ conditionIds: bare.slice(i, i + 25).map((q) => q.id), first: 25 });
      for (const c of pg.nodes || []) { const q = byQid.get(String(c.conditionId).toLowerCase()); if (!q) continue; const x = P.compactQuestion(c); Object.assign(q, { src: x.src, va: x.va, f1: x.f1, f4: x.f4, f24: x.f24, f7: x.f7, v24: x.v24, v7: x.v7, ev: x.ev, g: x.g, ep: x.ep != null ? x.ep : q.ep, pub: x.pub != null ? x.pub : q.pub, tags: x.tags.length ? x.tags : q.tags }); }
    }
  } catch (e) { console.warn('predict: source links and volumes of the questions taken from predictions failed:', e.message); }
  // Meridian OI as Meridian counts it, read on-chain (escrowOnChain); the API's figure is kept to compare. A failed read
  // falls back to the pools of the predictions not yet settled, which overstate it where a maker merged a bought-back bet
  const apiOi = new Map(questions.map((q) => [String(q.id).toLowerCase(), q.oi]));
  let oiFrom = 'pools';
  try {
    const per = await escrowOnChain(qNorms, new Set(withOi.map((q) => q.id)));
    for (const q of withOi) q.oi = r2(per[q.id] || 0);
    oiFrom = 'chain';
    const listed = withOi.filter((q) => apiOi.get(String(q.id).toLowerCase()) > 0), same = listed.filter((q) => Math.abs(apiOi.get(String(q.id).toLowerCase()) - q.oi) < 0.02).length;
    console.log(`  predict: Meridian OI read on-chain for ${withOi.length} questions; equal to the API's openInterest on ${same} of the ${listed.length} it lists (bets placed between the reads differ)`);
  } catch (e) {
    console.warn('predict: open interest on-chain failed, the pools of the predictions not yet settled stand in:', e.message);
    const escrow = dict();
    for (const n of qNorms) { if (n.settled) continue; for (const id of new Set(n.picks.map((k) => k.id))) escrow[id] = (escrow[id] || 0) + n.pool; }
    for (const q of withOi) q.oi = r2(escrow[q.id] || 0);
  }
  // the fee for sending a question's result from Polygon (anyone can): the Questions page quotes it
  let relayFee = null;
  try { const pol = await quoteRelayFee(withOi.length ? withOi[0].id : null); if (pol != null) relayFee = { pol: Math.round(pol * 1e4) / 1e4, at: Date.now() }; }
  catch (e) { console.warn('predict: relay fee quote failed:', e.message); }
  // Meridian's own lists beside the predictions (readCompetitions and the rest); each failure leaves its part out
  let competitions = null, pnlRank = null, matches = null, hot = null, tags = null;
  try { competitions = await readCompetitions(new Map(norms.map((n) => [String(n.id).toLowerCase(), n.legs]))); console.log(`  predict: ${competitions.length} competitions`); } catch (e) { console.warn('predict: competitions failed:', e.message); }
  // the monthly leaderboard of July to September, worked out from the predictions as Meridian's app does (legacyCompetitions)
  try { const legacy = legacyCompetitions(norms, trades); competitions = (competitions || []).concat(legacy); console.log(`  predict: monthly leaderboard: ${legacy.map((c) => c.entries).join(' / ')} entries in its 4 cycles`); } catch (e) { console.warn('predict: monthly leaderboard failed:', e.message); }
  try { pnlRank = await readPnlRanks(); console.log(`  predict: Meridian's PnL ranks of ${pnlRank.n} wallets (${pnlRank.n30} over 30 days)`); } catch (e) { console.warn('predict: PnL ranks failed:', e.message); }
  try { matches = await readMatches(withOi.map((q) => q.ev)); console.log(`  predict: ${Object.keys(matches).length} matches of the listed questions`); } catch (e) { console.warn('predict: matches failed:', e.message); }
  try { hot = await readHot(); hotStakes(hot, (id) => (act[id] ? act[id].sw : 0), stakeByGroup(qNorms, new Map(withOi.map((q) => [q.id, q])))); } catch (e) { console.warn('predict: Hot lists failed:', e.message); }
  try { tags = await readTags(); } catch (e) { console.warn('predict: tags failed:', e.message); }
  // open predictions per question with every leg (condition id, side) and the stake: whether anyone can still win a
  // question, and who is owed after it resolves, depends on the other legs of each combo, so the page needs them
  // x: 1 marks an open prediction whose bettor has sold all its tokens to market makers (its ledger holds none of them):
  // the bettor was paid through the secondary market and the makers hold both sides, so nobody but them waits for its
  // settlement (the Questions page then counts it as nobody's money still owed)
  const makerSet = new Set((agg.makers || []).map((m) => m.address));
  const sellers = new Set(trades.filter((t) => t.side === 'P' && t.pc).map((t) => t.seller));
  const ledgerBy = dict();
  const cashedOut = (n) => {
    if (!sellers.has(n.predictor)) return false;
    const bp = (ledgerBy[n.predictor] || (ledgerBy[n.predictor] = P.ledger(norms, trades, n.predictor).byPrediction))[n.id];
    return !!bp && bp.held < 1e-3 && trades.every((t) => t.pc !== n.pc || t.side !== 'P' || t.seller !== n.predictor || makerSet.has(t.buyer));
  };
  const openBy = dict();
  for (const n of qNorms) {
    if (n.decided) continue;
    const x = cashedOut(n) ? { x: 1 } : null;
    for (const k of n.picks) { if (!isCond(k.id)) continue; (openBy[k.id] || (openBy[k.id] = [])).push(Object.assign({ id: n.id, s: r2(n.stake), p: n.predictor, k: n.picks.map((y) => [y.id, y.yes ? 1 : 0]) }, x)); }
  }
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
  const out = { builtAt: Date.now(), source: process.env.GITHUB_ACTIONS ? 'github-actions' : 'pc', fromSec: P.LAUNCH_SEC, predictions: norms.length, apiTotal: probe, preLaunch, oiFrom, relayFee, competitions, pnlRank, matches, hot, tags, questions: counts ? { all: counts.all.totalCount, open: counts.open.totalCount, settled: counts.settled.totalCount } : null, agg, questionsWithOi: withOi, recentFrom, trades, tradesTotal: trades.total || trades.length, durationMs: Date.now() - t0, requests: P.stats.requests, retries: P.stats.retries };
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
  // each wallet's deposits, withdrawals and daily cash (readCash), by its last prediction or trade
  let cash = dict();
  try {
    const active = dict(), first = dict();
    for (const [a, list] of Object.entries(byWallet)) {
      const ts = list.map((n) => n.t).concat((tradesOf[a] || []).map((t) => t.t || 0)).filter((t) => t > 0);
      active[a] = ts.length ? Math.max(...ts) : 0; first[a] = ts.length ? Math.min(...ts) : null;
    }
    cash = await readCash(active, first);
  } catch (e) { console.warn('predict: wallet cash failed, the files go out without it:', e.message); }
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
    // its deposits and withdrawals (the newest 200) and daily cash as last read (cash.at), when read yet
    const cs = cash[addr];
    fs.writeFileSync(path.join(dir, addr + '.json'), JSON.stringify({ address: addr, builtAt: out.builtAt, total: list.length, truncated, newest: Math.min(list.length, 600), curve: curve && curve.length >= 2 ? curve : undefined, daily, predictions: kept.map((n) => Object.assign(P.slim(n, { stx: true, vt: true }), agg.soldOf(n))), trades: tradesOf[addr] || undefined, rd: rdOf[addr] || undefined, rows, rowsFmt: rows ? P.ROWS_FMT : undefined, claim,
      cash: cs ? { at: cs.at, xf: cs.xf.slice(0, 200), xfN: cs.xf.length, bh: cs.bh } : undefined }));
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
  // the left-out wallets' accounts (U.EXCLUDED) are not built at all, nor counted
  const subs = (await A.allSubaccounts({ signal: ctx.signal, ttl: 0 })).filter((sa) => !U.isExcluded(sa.account));
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
  const built = new Map(), failedAt = [], lastErr = new Map();
  // why a row failed, in a form that adds up across accounts (no addresses, ids or URLs)
  const why = (r) => (r.ok ? 'time budget reached' : String((r.error && r.error.message) || 'error').replace(/https?:\/\/\S+/g, '').replace(/0x[0-9a-f]{6,}|[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '…').replace(/\s+/g, ' ').trim().slice(0, 80));
  results.forEach((r, i) => { if (r.ok) { if (r.value) built.set(subs[i].id, r.value); } else { failedAt.push(i); lastErr.set(i, why(r)); console.warn(`row failed ${subs[i].id}: ${r.error && r.error.message}`); } });
  if (skipped) console.warn(`time budget of ${budgetMs / 1000}s reached: ${skipped} of ${subs.length} accounts not built this run`);
  // a failed row is built once more, after a pause and two at a time (one of its many requests timed out or was refused
  // under load), while the budget lasts
  if (failedAt.length) {
    await sleep(3000);
    const again = await U.pLimit(failedAt.map((i) => async () => (Date.now() - started > budgetMs ? null : AN.buildLeaderboardRow(subs[i], ref, prices, ctx))), 2);
    again.forEach((r, j) => { const sa = subs[failedAt[j]]; if (r.ok && r.value) built.set(sa.id, r.value); else { lastErr.set(failedAt[j], why(r)); console.warn(`row failed again ${sa.id}: ${r.ok ? 'time budget reached' : r.error && r.error.message}`); } });
  }
  // still failing: on GitHub's runners Meridian's API refuses some requests under load (built from a PC every account
  // builds: 2026-10-16, 325 of 325), so one last try after a longer pause, one account at a time, while the budget lasts
  const left = failedAt.filter((i) => !built.has(subs[i].id));
  if (left.length && Date.now() - started + 20000 < budgetMs) {
    await sleep(20000);
    const last = await U.pLimit(left.map((i) => async () => (Date.now() - started > budgetMs ? null : AN.buildLeaderboardRow(subs[i], ref, prices, ctx))), 1);
    last.forEach((r, j) => { const sa = subs[left[j]]; if (r.ok && r.value) built.set(sa.id, r.value); else { lastErr.set(left[j], why(r)); console.warn(`row failed a third time ${sa.id}: ${r.ok ? 'time budget reached' : r.error && r.error.message}`); } });
  }
  const failedIx = failedAt.filter((i) => !built.has(subs[i].id)), failed = failedIx.length;
  const failReasons = {}; for (const i of failedIx) { const w = lastErr.get(i) || 'error'; failReasons[w] = (failReasons[w] || 0) + 1; }

  const merged = mergeRows(subs, built, built.size < subs.length ? await previousSnapshots() : []);
  const { carried, missing } = merged, rows = merged.rows.filter((r) => !(r && U.isExcluded(r.account)));   // left-out wallets (U.EXCLUDED)
  // partial: not every account was built by this run (carried: rows from an earlier snapshot; missing: accounts without a row)
  const out = { builtAt: Date.now(), rows, partial: failed > 0 || skipped > 0, source: process.env.GITHUB_ACTIONS ? 'github-actions' : 'local', accounts: subs.length, failed, failReasons, skipped, retried: failedAt.length, carried, missing, budgetS: budgetMs / 1000, durationMs: Date.now() - started };
  fs.writeFileSync(path.join(outDir, 'leaderboard.json'), JSON.stringify(out));
  const profiled = rows.filter((r) => r.copy && r.copy.driftN).length;
  console.log(`wrote ${path.join(outDir, 'leaderboard.json')}: ${rows.length} rows (${built.size} built, ${carried} carried over, ${missing} missing; ${profiled} with fill drift, ${ctx.copy.candles.size()} candle windows), ${failed} failed (${failedAt.length} retried), ${skipped} skipped, ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (!built.size) process.exit(1);   // nothing built this run: the step fails (the file still carries the earlier rows)
}
if (doPerps) await buildPerps();
