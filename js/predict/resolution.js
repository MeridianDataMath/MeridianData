/* MeridianDataHub — Predict resolution tracker.
 * Every Meridian Predict question mirrors a Polymarket market (same conditionId), and Polymarket resolves through
 * UMA's optimistic oracle: someone proposes an outcome with a bond, a challenge window runs, a dispute sends it to a
 * second proposal and finally a UMA token vote. Meridian settles the question after Polymarket has resolved it.
 * This module reads (1) the market from Polymarket's public Gamma API and (2) the live oracle request from the
 * UMA CTF adapter + optimistic oracle on Polygon, and turns them into one "where is this in the pipeline" state.
 * Both sources allow browser requests from any origin; nothing here needs the Predict API. */
(function () {
  const MD = window.MD; const U = MD.util; const P = MD.predict; const h = U.h;
  const R = (P.res = {});

  R.GAMMA = 'https://gamma-api.polymarket.com/markets';
  R.RPCS = ['https://polygon-bor-rpc.publicnode.com', 'https://1rpc.io/matic'];
  R.LIVENESS = 7200;                 // UMA default challenge window (s); many sports, price and weather markets set a shorter customLiveness
  R.TTL_MARKET = 5 * 60000; R.TTL_ORACLE = 60000;
  R.POLYGONSCAN = 'https://polygonscan.com/address/';
  const SEL = { getQuestion: '0x58c039cd', optimisticOracle: '0x22302922', getRequest: '0xa9904f9b' };
  const IDENT = '5945535f4f525f4e4f5f51554552590000000000000000000000000000000000'; // bytes32("YES_OR_NO_QUERY")
  const E18 = 10n ** 18n, HALF = 5n * 10n ** 17n, INT_MIN = -(2n ** 255n);
  const lc = (s) => String(s || '').toLowerCase();
  const isAbort = (e) => e && e.name === 'AbortError';
  const jsonArr = (s) => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : null; } catch (e) { return null; } };
  const ts = (s) => { if (!s) return null; const t = Date.parse(typeof s === 'string' ? s.replace(' ', 'T').replace(/\+00$/, 'Z') : s); return Number.isFinite(t) ? t : null; };

  // ---------------------------------------------------------------- dates
  const DAY = 86400000;
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  /** Hours US Eastern time is behind UTC at instant t: daylight time from the 2nd Sunday of March to the 1st Sunday of November. */
  const etOffset = (t) => {
    const y = new Date(t).getUTCFullYear(); const sunday = (mo, n) => 1 + ((7 - new Date(Date.UTC(y, mo, 1)).getUTCDay()) % 7) + (n - 1) * 7;
    return t >= Date.UTC(y, 2, sunday(2, 2), 7) && t < Date.UTC(y, 10, sunday(10, 1), 6) ? 4 : 5;
  };
  /** The deadline a question states in its title ("… by September 30?", "… through Oct 5, 2026"): 11:59 PM ET that day,
   *  or null. When the title has no year, the year whose date lies nearest `near` (ms, the listed end): "by December 31?"
   *  listed to end 2027-01-01 04:59Z is Dec 31, 2026 (11:59 PM ET), not 2027. */
  R.titleDeadline = (text, near) => {
    const mm = /\b(?:by|before|through|thru|until)\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?/i.exec(text || '');
    if (!mm) return null;
    const mo = MONTHS.indexOf(mm[1].toLowerCase()); const d = Number(mm[2]); if (mo < 0 || d < 1 || d > 31) return null;
    const at = (y) => { const t = Date.UTC(y, mo, d, 23, 59); return t + etOffset(t) * 3600000; };
    if (mm[3]) return at(Number(mm[3]));
    const ref = near || Date.now(); const y0 = new Date(ref).getUTCFullYear();
    return [y0 - 1, y0, y0 + 1].map(at).reduce((a, b) => (Math.abs(b - ref) < Math.abs(a - ref) ? b : a));
  };

  // ---------------------------------------------------------------- Polymarket (Gamma)
  const markets = new Map();  // conditionId → { at, m | null }
  // Gamma is untyped JSON: every field that is shown or built into a request is read as the text it should be, so an
  // object where a string belongs (outcomes inside the JSON-in-a-string included) cannot reach the page as one
  const txt = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
  const compact = (m) => {
    const ev = m.events && m.events[0]; const evSlug = txt(ev && ev.slug);
    const outcomes = (jsonArr(m.outcomes) || ['Yes', 'No']).map(txt);
    const prices = (jsonArr(m.outcomePrices) || []).map(Number);
    // Polymarket's listed end date is sometimes earlier than the deadline in the question itself (a copied date:
    // "Another GTA VI trailer released by September 30?" was listed as ending Sep 1, like the Aug 31 market beside it).
    // The rules go by the question, so an open market keeps running to the stated deadline; listedEnd keeps the listing.
    let endAt = ts(m.endDate), listedEnd = null;
    const dl = m.closed ? null : R.titleDeadline(txt(m.question), endAt);
    if (dl && endAt && dl - endAt > DAY && dl - endAt < 400 * DAY) { listedEnd = endAt; endAt = dl; }
    // a game's slug keeps the date it was first listed for ("mls-sea-rsl-2026-04-12") when the fixture is re-dated
    const slug = txt(m.slug); const sd = /(\d{4})-(\d{2})-(\d{2})/.exec(evSlug || slug);
    const source = String((ev && ev.resolutionSource) || m.resolutionSource || '');
    return {
      id: lc(m.conditionId), slug, question: txt(m.question),
      url: 'https://polymarket.com/event/' + (evSlug || slug) + (evSlug && evSlug !== slug ? '/' + slug : ''),
      endAt, listedEnd, startAt: ts(m.startDate), gameAt: ts(m.gameStartTime), closed: !!m.closed, closedAt: ts(m.closedTime), acceptingOrders: !!m.acceptingOrders,
      // sports only: weather markets carry a gameStartTime too (the day being measured)
      sport: !!(m.sportsMarketType || (ev && ev.gameId)), listedDay: sd ? Date.UTC(+sd[1], +sd[2] - 1, +sd[3], 12) : null, period: ev && ev.period ? String(ev.period) : null,
      // the game is over (Gamma sets it on game events only): the result is known, though the market can keep trading
      // and Meridian keep taking bets until the market resolves
      ended: !!(ev && ev.ended),
      source: /^https?:\/\//i.test(source) ? source : null, tokens: jsonArr(m.clobTokenIds) || [],
      uma: String(m.umaResolutionStatus || '').toLowerCase(), umaHistory: (jsonArr(m.umaResolutionStatuses) || []).map(txt), resolvedAt: ts(m.umaEndDate),
      // the neg-risk adapter (0x69c47De9…) keys its request by negRiskRequestID: getQuestion(questionID) there is empty
      adapter: txt(m.resolvedBy) || null, questionId: txt(m.negRisk && m.negRiskRequestID ? m.negRiskRequestID : m.questionID) || null, negRisk: !!m.negRisk,
      outcomes, prices, rules: txt(m.description), liveness: Number(m.customLiveness) || R.LIVENESS, bond: Number(m.umaBond) || null,
    };
  };
  /** The outcome Polymarket resolved to, from the settled token prices. */
  R.resolvedOutcome = (m) => { if (!m || !m.prices.length) return null; const i = m.prices.findIndex((p) => p >= 0.99); if (i >= 0) return m.outcomes[i] || null; if (m.prices.every((p) => Math.abs(p - 0.5) < 0.01)) return '50/50'; return null; };
  /** The outcome trading highest: { name, p }. */
  R.leader = (m) => { if (!m || !m.prices.length) return null; let i = 0; m.prices.forEach((p, k) => { if (p > m.prices[i]) i = k; }); return Number.isFinite(m.prices[i]) ? { name: m.outcomes[i] || 'outcome ' + (i + 1), p: m.prices[i] } : null; };
  R.DECIDED = 0.95;   // an unresolved market trading this high on one outcome: the result is known, only the proposal is missing
  // 99.95 % reads 99.9 %, never 100 %: the market has not resolved
  const pct = (p) => (p > 0.99 && p < 1 ? (Math.floor(p * 1000 + 1e-6) / 10).toFixed(1) + '%' : p < 0.01 && p > 0 ? (Math.ceil(p * 1000 - 1e-6) / 10).toFixed(1) + '%' : U.fmtPct(p * 100, { dp: 0 }));
  // the stretch after the scheduled start that the played check measured (R.history asks for at most 3 days)
  const hvWin = (hv, game) => (!hv || !hv.to || !Number.isFinite(hv.to) ? 'hours' : hv.to - game >= 3 * DAY - 60000 ? '3 days' : U.fmtCountdown(hv.to - game));
  /** "Tohoku Rakuten Golden Eagles 27% · Fukuoka SoftBank Hawks 73%" */
  R.oddsText = (m) => (m && m.prices.length ? m.outcomes.map((o, i) => o + ' ' + (Number.isFinite(m.prices[i]) ? pct(m.prices[i]) : '—')).join(' · ') : '');
  /** What Polymarket's game feed says in the event's `period`: 'postponed', 'cancelled' or null (NS, a live period, or
   *  nothing: the feeds of some leagues, NPB and CPBL among them, stay on NS whatever happens). */
  // seen: "POST" (La Liga Levante–Athletic, re-dated), "CAN" (WTA Monterrey Bartunkova–Potapova, never played: 50-50)
  R.feedStatus = (period) => { const p = String(period || '').toLowerCase(); return /^(post|ppd)/.test(p) ? 'postponed' : /^(can|abd|aband)/.test(p) ? 'cancelled' : null; };

  // ---------------------------------------------------------------- odds around a game (Polymarket CLOB)
  // A game that is played moves its odds: the winner trades at 99 % within hours of the final whistle (NPB Rakuten–
  // SoftBank on Sep 20: 38 % at the start, 99.95 % three hours later), and even a tie or an abandoned game leaves the
  // pre-game level. Odds that stay where they were long after the scheduled start mean the game was most likely not played.
  R.PRICES = 'https://clob.polymarket.com/prices-history';
  R.NO_RESULT_HOURS = 12;   // this long after the scheduled start with no result, a game is checked for a postponement
  R.MOVE = 0.1;             // |median odds after the start − median before| at which the game counts as played (a tie
                            // from 38 % moves 12 points; the rained-out NPB game's median moved half a point)
  R.SWING = 0.25;           // or this wide a swing in the first six hours: in-game trading
  const hist = new Map();   // conditionId → { at, h }
  const median = (a) => { const s = a.slice().sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
  /** points [{ t (s), p }] of the first outcome around a game starting at gameAt (ms), up to `end` (ms, the end of the
   *  window asked for) → { pre, post, swing, moved, n, to } or null when there is too little trading to tell. */
  R.playedCheck = (pts, gameAt, end = Infinity) => {
    const pre = [], post = [], early = [];
    for (const x of pts || []) {
      const t = Number(x.t) * 1000, p = Number(x.p); if (!Number.isFinite(t) || !Number.isFinite(p)) continue;
      if (t > end) continue;   // the CLOB appends its latest price even when endTs is long past
      if (t <= gameAt) pre.push(p); else { if (t <= gameAt + 6 * 3600000) early.push(p); if (t >= gameAt + 2 * 3600000) post.push(p); }
    }
    if (!pre.length || post.length < 3) return null;
    const a = median(pre.slice(-12)), b = median(post);
    const decided = (p) => p >= 0.97 || p <= 0.03;
    const swing = early.length ? Math.max(...early) - Math.min(...early) : 0;
    const moved = Math.abs(b - a) >= R.MOVE || swing >= R.SWING || (!decided(a) && post.filter(decided).length >= 2);
    return { pre: a, post: b, swing, moved, n: post.length, to: end };
  };
  R.history = async function (list, { signal, now = Date.now() } = {}) {
    const todo = list.filter((m) => m.tokens[0] && m.gameAt && !(hist.get(m.id) && now - hist.get(m.id).at < R.TTL_MARKET));
    await Promise.all(todo.map(async (m) => {
      const from = Math.floor((m.gameAt - 12 * 3600000) / 1000), to = Math.floor(Math.min(now, m.gameAt + 3 * DAY) / 1000);
      try {
        const r = await fetch(R.PRICES + '?market=' + encodeURIComponent(m.tokens[0]) + '&startTs=' + from + '&endTs=' + to + '&fidelity=60', { signal });
        if (!r.ok) throw new Error('prices ' + r.status);
        const j = await r.json(); hist.set(m.id, { at: now, h: R.playedCheck(j && j.history, m.gameAt, to * 1000) });
      } catch (e) { if (isAbort(e)) throw e; }
    }));
  };

  R.markets = async function (ids, { signal } = {}) {
    const now = Date.now(); const want = Array.from(new Set(ids.map(lc))).filter((id) => { const c = markets.get(id); return !c || now - c.at > R.TTL_MARKET; });
    const fetchChunk = async (chunk, closed) => {
      const r = await fetch(R.GAMMA + '?limit=' + chunk.length + (closed ? '&closed=true' : '') + '&' + chunk.map((id) => 'condition_ids=' + id).join('&'), { signal });
      if (!r.ok) throw new Error('Gamma ' + r.status);
      const arr = await r.json(); const seen = new Set();
      for (const m of Array.isArray(arr) ? arr : []) { const c = compact(m); markets.set(c.id, { at: now, m: c }); seen.add(c.id); }
      return chunk.filter((id) => !seen.has(id));
    };
    for (let i = 0; i < want.length; i += 40) {
      const chunk = want.slice(i, i + 40);
      try {
        const missing = await fetchChunk(chunk, false);            // Gamma leaves closed (resolved) markets out unless asked
        const gone = missing.length ? await fetchChunk(missing, true) : [];
        for (const id of gone) markets.set(id, { at: now, m: null });
      } catch (e) { if (isAbort(e)) throw e; break; }   // keep whatever we had; the page renders Meridian-only info
    }
  };

  // ---------------------------------------------------------------- UMA oracle on Polygon
  const oracles = new Map();  // conditionId → { at, o | null }
  const ooOf = new Map();     // adapter → optimistic oracle address
  const word = (hex, i) => hex.slice(i * 64, (i + 1) * 64);
  const uint = (hex, i) => BigInt('0x' + (word(hex, i) || '0'));
  const int = (hex, i) => { const v = uint(hex, i); return v >= 2n ** 255n ? v - 2n ** 256n : v; };
  const addr = (hex, i) => { const w = word(hex, i); return w ? '0x' + w.slice(24) : null; };
  const isZero = (a) => !a || /^0x0+$/.test(a);
  const pad = (hex) => hex.padStart(64, '0');
  async function rpc(calls, signal) {
    let last;
    for (const url of R.RPCS) {
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(calls), signal });
        if (!r.ok) throw new Error('RPC ' + r.status);
        const arr = await r.json(); if (!Array.isArray(arr)) throw new Error('RPC: bad response');
        const byId = new Map(arr.map((x) => [x.id, x])); return calls.map((c) => byId.get(c.id) || {});
      } catch (e) { if (isAbort(e)) throw e; last = e; }
    }
    throw last || new Error('RPC unavailable');
  }
  const call = (id, to, data) => ({ jsonrpc: '2.0', id, method: 'eth_call', params: [{ to, data }, 'latest'] });
  /** UmaCtfAdapter.getQuestion → { requestTs, reward, bond, liveness, resolved, paused, reset, ancillary } or null when the adapter has no such record. */
  function parseQuestion(res) {
    if (!res || !res.result || res.result.length < 2 + 64 * 3) return null;
    const hex = res.result.slice(2); const base = Number(uint(hex, 0)) / 32;
    let heads = null; for (let k = 8; k <= 14; k++) if (uint(hex, base + k) === BigInt((k + 1) * 32)) { heads = k + 1; break; }
    if (!heads) return null;
    const w = (k) => uint(hex, base + k);
    const q = heads === 12
      ? { requestTs: Number(w(0)), reward: w(1), bond: w(2), liveness: Number(w(3)), resolved: w(5) === 1n, paused: w(6) === 1n, reset: w(7) === 1n, refund: w(8) === 1n }
      : { requestTs: Number(w(0)), reward: w(1), bond: w(2), liveness: 0, resolved: w(4) === 1n, paused: w(5) === 1n, reset: w(6) === 1n, refund: w(7) === 1n };
    if (!q.requestTs) return null;
    const off = base + Number(w(heads - 1)) / 32; const len = Number(uint(hex, off));
    q.ancHex = hex.slice((off + 1) * 64, (off + 1) * 64 + len * 2);
    try { q.ancillary = new TextDecoder().decode(Uint8Array.from(q.ancHex.match(/../g) || [], (b) => parseInt(b, 16))); } catch (e) { q.ancillary = ''; }
    const mm = /p1 corresponds to (.+?), p2 to (.+?), p3 to (.+?)(?:\.|,|$)/i.exec(q.ancillary || '');
    q.names = mm ? [mm[1].trim(), mm[2].trim(), mm[3].trim()] : null;
    return q;
  }
  /** OptimisticOracleV2.getRequest → proposer / disputer / proposed price / challenge-window end. */
  function parseRequest(res) {
    if (!res || !res.result || res.result.length < 2 + 64 * 16) return null;
    const hex = res.result.slice(2);
    return { proposer: addr(hex, 0), disputer: addr(hex, 1), settled: uint(hex, 3) === 1n, bond: uint(hex, 9), liveness: Number(uint(hex, 10)), proposedPrice: int(hex, 11), resolvedPrice: int(hex, 12), expiration: Number(uint(hex, 13)) * 1000 || null };
  }
  const priceName = (p, q, m) => {
    const names = q.names || (m && m.outcomes.length === 2 && /^yes$/i.test(m.outcomes[0]) ? [m.outcomes[1], m.outcomes[0], 'unknown/50-50'] : null);
    if (p === 0n) return names ? names[0] : 'p1'; if (p === E18) return names ? names[1] : 'p2'; if (p === HALF) return '50/50'; if (p === INT_MIN) return 'too early to resolve'; return String(p);
  };

  R.oracle = async function (list, { signal } = {}) {
    const now = Date.now();
    const todo = list.filter((x) => x.adapter && x.questionId && !(oracles.get(x.id) && now - oracles.get(x.id).at < R.TTL_ORACLE));
    if (!todo.length) return;
    const adapters = Array.from(new Set(todo.map((x) => x.adapter))).filter((a) => !ooOf.has(a));
    let calls = []; let n = 1;
    for (const x of todo) calls.push(Object.assign(call(n++, x.adapter, SEL.getQuestion + x.questionId.slice(2)), { x }));
    for (const a of adapters) calls.push(Object.assign(call(n++, a, SEL.optimisticOracle), { adapter: a }));
    let res; try { res = await rpc(calls.map(({ x, adapter, ...c }) => c), signal); } catch (e) { if (isAbort(e)) throw e; return; }
    const second = []; n = 1;
    calls.forEach((c, i) => {
      if (c.adapter) { const a = addr((res[i].result || '').slice(2), 0); if (a && !isZero(a)) ooOf.set(c.adapter, a); return; }
      const q = parseQuestion(res[i]);
      if (!q) { oracles.set(c.x.id, { at: now, o: null }); return; }
      const o = Object.assign({ id: c.x.id, adapter: c.x.adapter }, q); oracles.set(c.x.id, { at: now, o }); second.push(o);
    });
    const reqs = second.filter((o) => ooOf.get(o.adapter)).map((o) => {
      const anc = o.ancHex; const data = SEL.getRequest + pad(o.adapter.slice(2).toLowerCase()) + IDENT + pad(o.requestTs.toString(16)) + pad('80') + pad((anc.length / 2).toString(16)) + anc + '0'.repeat((64 - (anc.length % 64)) % 64);
      return Object.assign(call(n++, ooOf.get(o.adapter), data), { o });
    });
    if (!reqs.length) return;
    let res2; try { res2 = await rpc(reqs.map(({ o, ...c }) => c), signal); } catch (e) { if (isAbort(e)) throw e; return; }
    reqs.forEach((c, i) => { const r = parseRequest(res2[i]); if (r) Object.assign(c.o, r, { liveness: r.liveness || c.o.liveness || R.LIVENESS }); });
  };

  // ---------------------------------------------------------------- loading + lookup
  /** Fetch Polymarket records for these Meridian condition ids and, for the ones past their end or in resolution, the oracle request. */
  R.load = async function (ids, { signal, deep = true, now = Date.now() } = {}) {
    await R.markets(ids, { signal });
    if (!deep) return;
    const need = ids.map(lc).map((id) => (markets.get(id) || {}).m).filter((m) => m && !m.closed && (m.uma || !m.acceptingOrders || (m.endAt && m.endAt < now) || (m.gameAt && m.gameAt < now)));
    if (need.length) await R.oracle(need, { signal });
    // games long past their start with no result and no proposal: were they played at all?
    const late = need.filter((m) => m.sport && m.gameAt && now - m.gameAt >= R.NO_RESULT_HOURS * 3600000 && !m.uma && !(R.leader(m) && R.leader(m).p >= R.DECIDED) && !R.feedStatus(m.period));
    if (late.length) await R.history(late, { signal, now });
  };
  R.get = (id) => { const m = markets.get(lc(id)); const o = oracles.get(lc(id)); const hv = hist.get(lc(id)); return { m: m ? m.m : undefined, o: o ? o.o : undefined, hv: hv ? hv.h : undefined, loaded: !!m }; };
  /** Which side of a Meridian question the source market resolved to: true = YES (Polymarket's first outcome, the one
   *  Meridian's YES mirrors), false = NO, 'void' = 50/50, null = not resolved or unknown. */
  R.STUCK_DAYS = 7;   // resolved on the source market this long ago and still unsettled on Meridian = settlement backlog
  R.resolvedYes = (m) => { if (!m || !m.prices || !m.prices.length) return null; const i = m.prices.findIndex((p) => p >= 0.99); if (i === 0) return true; if (i === 1) return false; if (m.prices.every((p) => Math.abs(p - 0.5) < 0.01)) return 'void'; return null; };
  // Meridian's escrow has no refund outcome: a leg that resolves 50/50 (non-decisive) settles the prediction as
  // COUNTERPARTY_WINS, exactly like a leg resolved against the bettor (seen on every such prediction, single legs included).
  /** A pick the source market has already resolved against the bettor, 50/50 included (the question not yet settled on
   *  Meridian): the stake is gone, only the settlement is pending. */
  R.pickLost = (pick, id) => { if (!id || pick.settled) return false; const { m } = R.get(id); if (!m || !(m.closed || m.uma === 'resolved')) return false; const y = R.resolvedYes(m); return y === 'void' ? true : y === true || y === false ? y !== !!pick.yes : false; };
  /** State of one open prediction from its legs [[conditionId, yes], ...] and the source markets loaded so far:
   *  lost = a leg resolved against the bettor or 50/50 (the combo is gone whatever the other legs do); won = every leg
   *  resolved in the bettor's favour (a payout is owed, only the settlement is pending, resolvedAt = the last leg's
   *  resolution); otherwise pending (a leg still open, or not loaded). */
  R.predictionState = (legs) => {
    let won = true, at = 0, unknown = false;
    for (const [id, yes] of legs) {
      const { m } = R.get(id);
      if (!m || !(m.closed || m.uma === 'resolved')) { won = false; if (!m) unknown = true; continue; }
      const y = R.resolvedYes(m);
      if (y === true || y === false) { if (y !== !!yes) return { code: 'lost' }; at = Math.max(at, m.resolvedAt || m.closedAt || 0); }
      else if (y === 'void') return { code: 'lost', void: true };
      else won = false;   // unclear outcome: no payout claim yet
    }
    return won && legs.length ? { code: 'won', at } : { code: 'pending', unknown };
  };
  /** Every leg id of a question's open predictions (q.op from the snapshot), for one R.load. */
  R.legIds = (q) => Array.from(new Set((q.op || []).flatMap((p) => p.k.map((k) => k[0])).filter(Boolean)));
  /** An unsettled question none of whose open predictions can still win: each has a leg resolved against its bettor.
   *  Only the makers are waiting, so lists of questions leave it out. Unknown without the open predictions. */
  R.questionDead = (q) => { if (q.settled || !q.op || !q.op.length) return false; return q.op.every((p) => R.predictionState(p.k).code === 'lost'); };
  /** Open predictions on a question that are fully won, i.e. payouts owed; those won STUCK_DAYS or more ago are the
   *  settlement backlog. Returns { won, stake, stuck, stuckStake, oldestD } */
  R.owed = (q, now = Date.now()) => {
    const out = { won: 0, stake: 0, stuck: 0, stuckStake: 0, oldestD: 0 };
    for (const p of q.op || []) { const st = R.predictionState(p.k); if (st.code !== 'won') continue; out.won++; out.stake += p.s || 0; const d = st.at ? Math.floor((now - st.at) / 86400000) : 0; if (d >= R.STUCK_DAYS) { out.stuck++; out.stuckStake += p.s || 0; if (d > out.oldestD) out.oldestD = d; } }
    return out;
  };

  // ---------------------------------------------------------------- state machine
  /**
   * q: Meridian view { end (ms), settled, yes, nd }.  Returns
   * { code, chip:[text, cls], main, sub, at (ms the main line refers to), outcome, o, m }
   * codes: settled · resolved · paused · vote · disputed · proposed · settling · awaiting · postponed · noresult · trading · unknown
   */
  R.state = function (q, id, now = Date.now()) {
    const { m, o, hv } = R.get(id);
    const cd = (t) => (t > now ? 'in ' + U.fmtCountdown(t - now) : U.fmtAgo(t));
    const live = (s) => (s === 1 ? '1 s' : s < 3600 ? Math.round(s / 60) + ' min' : (s / 3600).toFixed(s % 3600 ? 1 : 0) + ' h');
    if (q.settled) return { code: 'settled', chip: q.nd ? ['50/50', 'amber'] : q.yes ? ['YES', 'green'] : ['NO', 'red'], main: 'Settled on Meridian', sub: m && m.resolvedAt ? 'Polymarket resolved ' + U.fmtDateTime(m.resolvedAt) : null, m, o };
    if (!m) return { code: 'unknown', chip: ['open', 'accent'], main: q.end ? (q.end > now ? 'Ends ' + cd(q.end) : 'Ended ' + cd(q.end)) : 'No end time', sub: m === null ? 'no Polymarket record for this question' : null, m, o };
    // Meridian's listed end time often comes well before the market itself ends; that is what people mistake for
    // "resolution". It is a listed end, not a betting cutoff: Meridian has taken bets after it
    const meridianEnd = q.end && m.endAt && m.endAt - q.end > 3600000 ? 'Meridian end time ' + (q.end > now ? U.fmtDateTime(q.end) : U.fmtDate(q.end)) : null;
    const liveness = (o && o.liveness) || m.liveness;
    // the bond is set per market (Gamma umaBond, $250 or $500 on nearly every question); unknown, no amount is stated
    const bond = o && o.bond ? Number(o.bond) / 1e6 : m.bond;
    if (m.closed || m.uma === 'resolved' || (o && o.settled)) {
      const out = R.resolvedOutcome(m) || (o && o.settled ? priceName(o.resolvedPrice, o, m) : null); const at = m.resolvedAt || m.closedAt;
      // settlement normally follows within a day or two; beyond a week the question is stuck on Meridian's side
      const stuckD = at ? Math.floor((now - at) / 86400000) : 0;
      const owed = q.op ? R.owed(q, now) : null;
      const stuck = owed ? owed.stuck > 0 : stuckD >= R.STUCK_DAYS;
      // Meridian learns an outcome only when a relay transaction on Polygon sends it over LayerZero; its settlement bot
      // sends them for listed questions, not for unlisted ones (isPublic false), which stay unsettled unless someone sends
      // the relay by hand
      const why = stuck && q.pub === false ? ' · unlisted question: Meridian\'s settlement bot does not relay these from Polygon' : '';
      // one age per row: the chip carries none, the main line dates the question's own resolution, and the payout age
      // (a combo is fully won only at its last leg) is labelled in the sub-line
      return { code: 'resolved', stuck, unlisted: q.pub === false, stuckD, owed, chip: stuck ? ['resolved · stuck', 'amber'] : ['resolved · settling', 'blue'], main: 'Resolved' + (out ? ' ' + out : '') + (at ? ' ' + cd(at) : ''),
        sub: (stuck ? (owed ? owed.won + ' won prediction' + (owed.won > 1 ? 's' : '') + ' (' + U.fmtUsd(owed.stake) + ') waiting for settlement' + (owed.stuck ? ' · the oldest has been fully won on Polymarket for ' + owed.oldestD + ' days' : '') : 'on Polymarket ' + stuckD + ' days ago · still not settled on Meridian')
          : owed && owed.won ? owed.won + ' won prediction' + (owed.won > 1 ? 's' : '') + ' awaiting settlement on Meridian' : 'on Polymarket · not settled on Meridian yet') + why, at, outcome: out, m, o };
    }
    if (o && o.paused) return { code: 'paused', chip: ['paused', 'amber'], main: 'Resolution paused by Polymarket', sub: 'under review · no timeline', m, o };
    if (o && !isZero(o.disputer)) return { code: 'vote', chip: ['UMA vote', 'red'], main: 'Proposal disputed' + (o.reset ? ' twice' : '') + ' → UMA vote', sub: 'UMA token holders vote on the outcome · typically 2–6 days', m, o };
    if (o && !isZero(o.proposer)) {
      const out = priceName(o.proposedPrice, o, m); const at = o.expiration; const since = at ? at - liveness * 1000 : null;
      if (at && at < now) return { code: 'settling', chip: ['proposed: ' + out, 'accent'], main: out + ' proposed · window closed ' + cd(at), sub: 'no dispute · Polymarket finalizes next, then Meridian settles', at, outcome: out, m, o };
      return { code: 'proposed', chip: ['proposed: ' + out, 'accent'], main: out + ' proposed' + (since ? ' ' + cd(since) : ''), sub: 'challenge window ends ' + (at ? U.fmtHM(at) + ' (' + cd(at) + ')' : 'in ' + live(liveness)) + (o.reset ? ' · 2nd proposal' : ''), at, outcome: out, m, o };
    }
    if (o && o.reset) return { code: 'disputed', chip: ['disputed', 'red'], main: 'First proposal disputed', sub: 'waiting for a new proposal · then another ' + live(liveness) + ' challenge window', m, o };
    if (/disput|challeng/.test(m.uma)) return { code: 'disputed', chip: ['disputed', 'red'], main: 'Proposal disputed', sub: 'UMA dispute process · typically 2–6 days', m, o };
    // Gamma says proposed but the oracle request is not known here (not read yet, the slip page, an RPC failure): Gamma's
    // updatedAt is a batch-refresh stamp, not the proposal time, so no time is stated
    if (/propos/.test(m.uma)) return { code: 'proposed', chip: ['proposed', 'accent'], main: 'Outcome proposed on UMA', sub: 'challenge window ' + live(liveness) + ' from the proposal', at: null, m, o };
    const proposal = (bond ? '$' + U.fmtNum(bond, 0) + ' bond, then a ' : 'a proposal opens a ') + live(liveness) + ' challenge window';
    const lead = R.leader(m); const known = lead && lead.p >= R.DECIDED ? lead : null;
    // Sports markets carry the fixture time; the listed end date is only a placeholder (for many leagues start + 7 days).
    // A postponed game keeps its market open until the make-up game has been played, and one cancelled with no make-up
    // resolves 50-50, which Meridian settles as a loss for the bettor. Signs of a postponement, most direct first:
    // Polymarket's game feed says so (period POST: La Liga Levante–Athletic, Sep 16, moved to Oct 21); the fixture was
    // re-dated past the day in the market's slug and Meridian's end time (MLS Seattle–Real Salt Lake, Apr 12 → Sep 24);
    // or, where the feed never changes (NPB, CPBL), the game is long past its start with no result and over the stretch
    // R.history measured (up to 3 days after the start) the median odds stayed within R.MOVE of the pre-game level (NPB
    // Rakuten–SoftBank, Sep 21, rained out: 41 % before, 39 % over the next two days). That is a sign, not a report from
    // the league, so it reads "probably postponed".
    const game = m.sport ? m.gameAt : null;
    if (game) {
      const orig = m.listedDay;
      const moved = !!(orig && game - orig > DAY && !(q.end && q.end > game - DAY));
      const feed = R.feedStatus(m.period);
      const was = moved ? ' from ' + U.fmtDateShort(orig) : '';
      // the league's own date (the listing's day, noon UTC) reads the same in every time zone; the start time does not
      const day = U.fmtDateShort(orig && Math.abs(game - orig) <= DAY ? orig : game);
      const ifOff = 'if it is cancelled instead, it resolves 50-50, which Meridian settles as a loss for the bettor';
      const base = { at: game, orig: moved ? orig : null, feed, hv, m, o };
      if (feed === 'cancelled') return Object.assign(base, { code: 'postponed', chip: ['cancelled', 'red'], main: 'Game cancelled' + (moved ? ' (postponed' + was + ')' : ''), sub: 'Polymarket\'s game feed marks it cancelled · without a make-up game it resolves 50-50, which Meridian settles as a loss for the bettor' });
      if (game > now) {
        if (moved || feed === 'postponed') return Object.assign(base, { code: 'postponed', chip: ['postponed', 'amber'], main: 'Postponed' + was + ' · now ' + U.fmtWhen(game) + ' (' + cd(game) + ')', sub: 'the market stays open until the rescheduled game has been played · ' + ifOff });
        return { code: 'trading', chip: ['open', 'accent'], main: 'Game starts ' + U.fmtDateTime(game) + ' (' + cd(game) + ')', sub: 'resolves after the final result' + (meridianEnd ? ' · ' + meridianEnd : ''), at: game, m, o };
      }
      const what = moved ? 'Make-up game' : 'Game';
      // a price this lopsided can come minutes before the end, so "started", not "over"
      if (known) return Object.assign(base, { code: 'awaiting', chip: ['awaiting proposal', 'amber'], main: what + ' started ' + cd(game) + ' · Polymarket prices ' + known.name + ' at ' + pct(known.p), sub: 'the outcome is proposed once the final result is in · ' + proposal });
      if (feed === 'postponed') return Object.assign(base, { code: 'postponed', chip: ['postponed', 'amber'], main: 'Postponed · not played on ' + day, sub: 'Polymarket\'s game feed marks it postponed · no new date listed yet · the market stays open until the make-up game has been played; ' + ifOff });
      if (now - game >= R.NO_RESULT_HOURS * 3600000) {
        const after = U.fmtCountdown(now - game);
        if (hv && !hv.moved) return Object.assign(base, { code: 'postponed', chip: ['postponed', 'amber'], main: 'Probably postponed · no sign it was played on ' + day, sub: 'no result ' + after + ' after the scheduled start, and in the first ' + hvWin(hv, game) + ' after it the median odds stayed within ' + Math.round(R.MOVE * 100) + ' points of the pre-game level (' + pct(hv.pre) + ' before, ' + pct(hv.post) + ' after) · no new date on Polymarket yet · the market stays open until the make-up game has been played; ' + ifOff });
        return Object.assign(base, { code: 'noresult', chip: ['no result · ' + (now - game >= DAY ? Math.floor((now - game) / DAY) + 'd' : Math.floor((now - game) / 3600000) + 'h'), 'amber'], main: what + ' scheduled ' + U.fmtWhen(game) + ' · no result yet',
          sub: hv ? 'the odds moved after the start, but no winner is priced in (' + R.oddsText(m) + ') · an abandoned or unfinished game resolves 50-50, which Meridian settles as a loss for the bettor; a postponed one stays open until it is played'
            : 'no result ' + after + ' after the scheduled start · a postponed game stays open until it is played; ' + ifOff });
      }
      return Object.assign(base, { code: 'awaiting', chip: ['awaiting proposal', 'amber'], main: what + ' started ' + cd(game) + (moved ? ' (postponed' + was + ')' : ''), sub: 'the outcome is proposed once the final result is in · ' + proposal });
    }
    // a market whose listed end date was earlier than the question's own deadline runs to that deadline (compact())
    const listed = m.listedEnd ? 'Polymarket lists ' + U.fmtDate(m.listedEnd) + ' as its end date, earlier than the deadline in the question' : null;
    // Gamma's endDate is only the listed date: a market still taking orders with no outcome priced in has not ended
    // (Karen Bass: listed Jun 3, runoff Nov 3)
    if (m.endAt && m.endAt < now && m.acceptingOrders && !known) return { code: 'trading', chip: ['open', 'accent'], main: 'Still trading on Polymarket · its listed end date (' + U.fmtDate(m.endAt) + ') has passed', sub: ['no outcome priced in yet' + (m.prices.length ? ' (' + R.oddsText(m) + ')' : ''), 'resolves as its rules state', meridianEnd].filter(Boolean).join(' · '), at: m.endAt, m, o };
    if (m.endAt && m.endAt < now) return { code: 'awaiting', chip: ['awaiting proposal', 'amber'], main: 'Market ended ' + cd(m.endAt), sub: (known ? 'Polymarket prices ' + known.name + ' at ' + pct(known.p) + ' · nobody has proposed it yet · ' : 'nobody has proposed an outcome yet · ') + proposal, at: m.endAt, m, o };
    if (!m.acceptingOrders) return { code: 'awaiting', chip: ['awaiting proposal', 'amber'], main: 'Trading halted on Polymarket', sub: 'nobody has proposed an outcome yet · ' + proposal, at: m.endAt, m, o };
    if (!m.endAt) return { code: 'trading', chip: ['open', 'accent'], main: 'No end date on Polymarket', sub: meridianEnd || 'resolves when the outcome is known · see rules', m, o };
    // the end date is a listing or a deadline, not a resolution time: the market resolves when its rules say
    return { code: 'trading', chip: ['open', 'accent'], main: (m.listedEnd ? 'Deadline in the question ' : 'Polymarket end date ') + U.fmtDateTime(m.endAt) + ' (' + cd(m.endAt) + ')', sub: [meridianEnd, listed, 'Polymarket resolves it once the outcome is known under its rules, which can be before or after this date · see rules'].filter(Boolean).join(' · '), at: m.endAt, m, o };
  };

  // ---------------------------------------------------------------- rendering
  R.chip = (q, id) => { const s = R.state(q, id); return MD.ui.chip(s.chip[0], s.chip[1]); };
  /** Resolution column cell: main line, detail line, and an info button that opens the full picture. */
  R.cell = function (q, id, opts = {}) {
    const s = R.state(q, id);
    const btn = h('button.btn.sm.icon.ghost.res-info', { title: 'Resolution details', onclick: (e) => { e.stopPropagation(); R.openDetails(q, id, opts); } }, U.icon('info'));
    return h('div.res-cell', h('div.row', { style: { gap: '4px', alignItems: 'flex-start' } }, h('div', h('div', { class: s.code === 'unknown' ? 'dim' : '' }, s.main), s.sub ? h('div.xs.dim', s.sub) : null), s.m ? btn : null));
  };
  /** One-line version for lists that show several legs. */
  R.line = function (q, id) {
    const s = R.state(q, id);
    return h('div.res-line', MD.ui.chip(s.chip[0], s.chip[1]), ' ', h('span.small', { class: s.code === 'unknown' ? 'dim' : '' }, s.main));
  };
  R.explainer = () => 'How a question resolves: Polymarket markets settle through UMA\'s optimistic oracle. After the event, one of Polymarket\'s approved proposers proposes the outcome and posts a bond, set per market ($250 or $500 on nearly every question here; a question\'s row shows it once its market has ended); a challenge window follows (2 h by default, 10–60 min on many sports, price and weather markets). An undisputed proposal resolves the market. A dispute forces a second proposal; a second dispute goes to a UMA token-holder vote (2–6 days). Meridian settles the question once the result has been relayed from Polygon, usually within minutes of Polymarket resolving; its settlement bot skips unlisted questions, which stay unsettled until someone else sends the relay transaction (anyone can, for about 3 POL). A postponed game keeps its question open until the make-up game has been played; one cancelled without a make-up game resolves 50/50. On Meridian a leg that resolves 50/50 counts as a loss for the bettor.';

  R.openDetails = function (q, id, opts = {}) {
    const s = R.state(q, id); const m = s.m, o = s.o; const UI = MD.ui;
    const kv = []; const row = (k, v) => { if (v != null && v !== '') kv.push(h('div.k', k), h('div', v)); };
    const short = (a) => h('a', { href: R.POLYGONSCAN + a, target: '_blank', rel: 'noopener', title: a }, U.shortAddr(a, 6));
    row('Status', h('div', UI.chip(s.chip[0], s.chip[1]), ' ', s.main, s.sub ? h('div.xs.dim', s.sub) : null));
    if (m) {
      // the listed date is a deadline, not when the market closes: one still trading past it says so
      row(m.listedEnd ? 'Deadline in the question' : 'Polymarket end date', m.endAt ? U.fmtDateTime(m.endAt) + (m.endAt > Date.now() ? ' · in ' + U.fmtCountdown(m.endAt - Date.now()) : ' · ' + U.fmtAgo(m.endAt) + (s.code === 'trading' ? ' · the market is still trading' : '')) + (m.listedEnd ? ' · Polymarket lists ' + U.fmtDateTime(m.listedEnd) + ', which is earlier' : '') + (s.code === 'postponed' || s.code === 'noresult' ? ' · only a placeholder for a game: the market runs until the result is in' : '') : '—');
      if (m.gameAt) row('Fixture', U.fmtDateTime(m.gameAt) + (m.gameAt > Date.now() ? ' · in ' + U.fmtCountdown(m.gameAt - Date.now()) : ' · ' + U.fmtAgo(m.gameAt)) + (s.orig ? ' · re-dated: first listed for ' + U.fmtDate(s.orig) : ''));
      if (s.code === 'postponed' || s.code === 'noresult') {
        const hv = s.hv;
        row('Game status', s.feed ? 'Polymarket\'s game feed: ' + s.feed + (s.orig ? '; the fixture was moved from ' + U.fmtDate(s.orig) : '')
          : s.orig ? 'moved from ' + U.fmtDate(s.orig) + ' (the date in the market\'s listing and Meridian\'s end time) to ' + U.fmtDateTime(m.gameAt)
          : hv ? 'odds of ' + (m.outcomes[0] || 'the first outcome') + ': ' + pct(hv.pre) + ' before the scheduled start, ' + pct(hv.post) + ' in the first ' + hvWin(hv, m.gameAt) + ' after it (median of ' + hv.n + ' hourly prices). A game that is played moves them, usually to 99 % within hours of the end' + (hv.moved ? '; these moved, so it was probably started' : '; these did not, so it was most likely not played')
          : 'no price history to check whether it was played');
        row('If it is postponed', 'the market stays open until the make-up game has been played, whatever the date Polymarket lists. Cancelled with no make-up game: resolves 50-50, which Meridian settles as a loss for the bettor' + (m.source ? '. Make-up dates are announced by the league (link below)' : ''));
      }
      if (!m.closed && m.prices.length) row('Polymarket odds', R.oddsText(m));
      row('Meridian end time', q.end ? U.fmtDateTime(q.end) + (m.endAt && m.endAt - q.end > 3600000 ? ' · ' + U.fmtDuration(m.endAt - q.end) + ' before the market ends' : '') : '—');
      if (q.pub === false) row('Listed on Meridian', 'no — an unlisted question. Meridian\'s settlement bot does not relay results for unlisted questions from Polygon, so once Polymarket resolves it, it stays unsettled on Meridian until someone sends the relay transaction');
      row('Trading on Polymarket', m.closed ? 'closed' : m.acceptingOrders ? 'open' : 'halted (pending resolution)');
      if (o) {
        row('Oracle request', 'opened ' + U.fmtDateTime(o.requestTs * 1000) + (o.reset ? ' · reset after a dispute' : ''));
        if (!isZero(o.proposer)) row('Proposal', h('span', s.outcome ? h('b', s.outcome) : null, ' by ', short(o.proposer), o.expiration ? ' · challenge window ends ' + U.fmtDateTime(o.expiration) : ''));
        if (!isZero(o.disputer)) row('Disputed by', short(o.disputer));
        row('Challenge window', (o.liveness / 60).toFixed(0) + ' min · bond ' + U.fmtUsd(Number(o.bond) / 1e6));
        if (o.names) row('Outcomes', o.names[0] + ' / ' + o.names[1] + ' / ' + o.names[2]);
      } else if (m.uma) row('UMA status', m.uma + (m.umaHistory.length ? ' (' + m.umaHistory.join(' → ') + ')' : ''));
      const out = R.resolvedOutcome(m); if (out && (m.closed || m.uma === 'resolved')) row('Polymarket outcome', out + (m.resolvedAt ? ' · ' + U.fmtDateTime(m.resolvedAt) : ''));
      row('Resolver contract', m.adapter ? h('span', short(m.adapter), m.negRisk ? ' · multi-outcome (neg-risk) market' : '') : '—');
    }
    const links = h('div.row.wrap', { style: { marginTop: '12px', gap: '6px' } },
      m ? h('a.btn.sm', { href: m.url, target: '_blank', rel: 'noopener' }, U.icon('external'), 'Open on Polymarket') : null,
      m && m.source ? h('a.btn.sm.ghost', { href: m.source, target: '_blank', rel: 'noopener', title: 'The resolution source named by the market' }, U.icon('external'), 'Official source · ' + m.source.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/.*$/, '')) : null,
      opts.appUrl ? h('a.btn.sm.ghost', { href: opts.appUrl, target: '_blank', rel: 'noopener' }, U.icon('external'), 'Meridian Predict') : null,
      h('a.btn.sm.ghost', { href: 'https://docs.polymarket.com/polymarket-learn/markets/how-are-markets-resolved', target: '_blank', rel: 'noopener' }, U.icon('external'), 'How resolution works'));
    const body = h('div',
      h('div.kv', kv),
      m && m.rules ? h('div', { style: { marginTop: '14px' } }, h('div.small.dim', { style: { marginBottom: '6px' } }, 'Resolution rules (from Polymarket)'), h('div.rules', m.rules)) : null,
      h('p.muted.small', { style: { margin: '14px 0 0' } }, R.explainer()),
      links);
    UI.modal({ title: q.question || (m && m.question) || 'Resolution', body });
  };
})();
