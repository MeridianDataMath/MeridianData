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
  R.LIVENESS = 7200;                 // UMA default challenge window (s); sports/crypto markets set a shorter customLiveness
  R.BOND_USD = 750;                  // proposal bond per Polymarket's resolution docs
  R.TTL_MARKET = 5 * 60000; R.TTL_ORACLE = 60000;
  R.POLYGONSCAN = 'https://polygonscan.com/address/';
  const SEL = { getQuestion: '0x58c039cd', optimisticOracle: '0x22302922', getRequest: '0xa9904f9b' };
  const IDENT = '5945535f4f525f4e4f5f51554552590000000000000000000000000000000000'; // bytes32("YES_OR_NO_QUERY")
  const E18 = 10n ** 18n, HALF = 5n * 10n ** 17n, INT_MIN = -(2n ** 255n);
  const lc = (s) => String(s || '').toLowerCase();
  const isAbort = (e) => e && e.name === 'AbortError';
  const jsonArr = (s) => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : null; } catch (e) { return null; } };
  const ts = (s) => { if (!s) return null; const t = Date.parse(typeof s === 'string' ? s.replace(' ', 'T').replace(/\+00$/, 'Z') : s); return Number.isFinite(t) ? t : null; };

  // ---------------------------------------------------------------- Polymarket (Gamma)
  const markets = new Map();  // conditionId → { at, m | null }
  const compact = (m) => {
    const ev = m.events && m.events[0]; const evSlug = ev && ev.slug;
    const outcomes = jsonArr(m.outcomes) || ['Yes', 'No'];
    const prices = (jsonArr(m.outcomePrices) || []).map(Number);
    return {
      id: lc(m.conditionId), slug: m.slug, question: m.question,
      url: 'https://polymarket.com/event/' + (evSlug || m.slug) + (evSlug && evSlug !== m.slug ? '/' + m.slug : ''),
      endAt: ts(m.endDate), startAt: ts(m.startDate), gameAt: ts(m.gameStartTime), closed: !!m.closed, closedAt: ts(m.closedTime), acceptingOrders: !!m.acceptingOrders,
      uma: String(m.umaResolutionStatus || '').toLowerCase(), umaHistory: jsonArr(m.umaResolutionStatuses) || [], resolvedAt: ts(m.umaEndDate),
      adapter: m.resolvedBy || null, questionId: m.questionID || null, negRisk: !!m.negRisk,
      outcomes, prices, rules: m.description || '', liveness: Number(m.customLiveness) || R.LIVENESS, bond: Number(m.umaBond) || null, updatedAt: ts(m.updatedAt),
    };
  };
  /** The outcome Polymarket resolved to, from the settled token prices. */
  R.resolvedOutcome = (m) => { if (!m || !m.prices.length) return null; const i = m.prices.findIndex((p) => p >= 0.99); if (i >= 0) return m.outcomes[i] || null; if (m.prices.every((p) => Math.abs(p - 0.5) < 0.01)) return '50/50'; return null; };

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
  R.load = async function (ids, { signal, deep = true } = {}) {
    await R.markets(ids, { signal });
    if (!deep) return;
    const now = Date.now();
    const need = ids.map(lc).map((id) => (markets.get(id) || {}).m).filter((m) => m && !m.closed && (m.uma || !m.acceptingOrders || (m.endAt && m.endAt < now)));
    if (need.length) await R.oracle(need, { signal });
  };
  R.get = (id) => { const m = markets.get(lc(id)); const o = oracles.get(lc(id)); return { m: m ? m.m : undefined, o: o ? o.o : undefined, loaded: !!m }; };
  /** Which side of a Meridian question the source market resolved to: true = YES (Polymarket's first outcome, the one
   *  Meridian's YES mirrors), false = NO, 'void' = 50/50, null = not resolved or unknown. */
  R.resolvedYes = (m) => { if (!m || !m.prices || !m.prices.length) return null; const i = m.prices.findIndex((p) => p >= 0.99); if (i === 0) return true; if (i === 1) return false; if (m.prices.every((p) => Math.abs(p - 0.5) < 0.01)) return 'void'; return null; };
  /** A pick the source market has already resolved against (the question not yet settled on Meridian): the bettor's
   *  stake is gone, only the settlement is pending. */
  R.pickLost = (pick, id) => { if (!id || pick.settled) return false; const { m } = R.get(id); if (!m || !(m.closed || m.uma === 'resolved')) return false; const y = R.resolvedYes(m); return y === true || y === false ? y !== !!pick.yes : false; };
  /** An unsettled question that has resolved on the source market with nobody on the winning side (by / bn = open
   *  bets on YES / NO from the snapshot): only the makers are waiting, so lists of questions leave it out. */
  R.questionDead = (q, id) => { if (q.settled || q.by == null || q.bn == null) return false; const { m } = R.get(id); if (!m || !(m.closed || m.uma === 'resolved')) return false; const y = R.resolvedYes(m); if (y === true) return !(q.by > 0); if (y === false) return !(q.bn > 0); return false; };

  // ---------------------------------------------------------------- state machine
  /**
   * q: Meridian view { end (ms), settled, yes, nd }.  Returns
   * { code, chip:[text, cls], main, sub, at (ms the main line refers to), outcome, o, m }
   * codes: settled · resolved · paused · vote · disputed · proposed · settling · awaiting · trading · unknown
   */
  R.state = function (q, id, now = Date.now()) {
    const { m, o } = R.get(id);
    const cd = (t) => (t > now ? 'in ' + U.fmtCountdown(t - now) : U.fmtAgo(t));
    const live = (s) => (s === 1 ? '1 s' : s < 3600 ? Math.round(s / 60) + ' min' : (s / 3600).toFixed(s % 3600 ? 1 : 0) + ' h');
    if (q.settled) return { code: 'settled', chip: q.nd ? ['void', 'amber'] : q.yes ? ['YES', 'green'] : ['NO', 'red'], main: 'Settled on Meridian', sub: m && m.resolvedAt ? 'Polymarket resolved ' + U.fmtDateTime(m.resolvedAt) : null, m, o };
    if (!m) return { code: 'unknown', chip: ['open', 'accent'], main: q.end ? (q.end > now ? 'Ends ' + cd(q.end) : 'Ended ' + cd(q.end)) : 'No end time', sub: m === null ? 'no Polymarket record for this question' : null, m, o };
    // Meridian often stops taking predictions well before the market itself ends; that is what people mistake for "resolution"
    const cutoff = q.end && m.endAt && m.endAt - q.end > 3600000 ? (q.end > now ? 'Meridian bets close ' + U.fmtDateTime(q.end) : 'Meridian bets closed ' + U.fmtDate(q.end)) : null;
    const liveness = (o && o.liveness) || m.liveness;
    const bond = o && o.bond ? Number(o.bond) / 1e6 : m.bond || R.BOND_USD;
    if (m.closed || m.uma === 'resolved' || (o && o.settled)) {
      const out = R.resolvedOutcome(m) || (o && o.settled ? priceName(o.resolvedPrice, o, m) : null); const at = m.resolvedAt || m.closedAt;
      return { code: 'resolved', chip: ['resolved · settling', 'blue'], main: 'Resolved' + (out ? ' ' + out : '') + (at ? ' ' + cd(at) : ''), sub: 'on Polymarket · not settled on Meridian yet', at, outcome: out, m, o };
    }
    if (o && o.paused) return { code: 'paused', chip: ['paused', 'amber'], main: 'Resolution paused by Polymarket', sub: 'under review · no timeline', m, o };
    if (o && !isZero(o.disputer)) return { code: 'vote', chip: ['UMA vote', 'red'], main: 'Proposal disputed' + (o.reset ? ' twice' : '') + ' → UMA vote', sub: 'UMA token holders vote on the outcome · typically 2–6 days', m, o };
    if (o && !isZero(o.proposer)) {
      const out = priceName(o.proposedPrice, o, m); const at = o.expiration; const since = at ? at - liveness * 1000 : null;
      if (at && at < now) return { code: 'settling', chip: ['proposed: ' + out, 'accent'], main: out + ' proposed · window closed ' + cd(at), sub: 'no dispute · Polymarket finalises next, then Meridian settles', at, outcome: out, m, o };
      return { code: 'proposed', chip: ['proposed: ' + out, 'accent'], main: out + ' proposed' + (since ? ' ' + cd(since) : ''), sub: 'challenge window ends ' + (at ? U.fmtHM(at) + ' (' + cd(at) + ')' : 'in ' + live(liveness)) + (o.reset ? ' · 2nd proposal' : ''), at, outcome: out, m, o };
    }
    if (o && o.reset) return { code: 'disputed', chip: ['disputed', 'red'], main: 'First proposal disputed', sub: 'waiting for a new proposal · then another ' + live(liveness) + ' challenge window', m, o };
    if (/disput|challeng/.test(m.uma)) return { code: 'disputed', chip: ['disputed', 'red'], main: 'Proposal disputed', sub: 'UMA dispute process · typically 2–6 days', m, o };
    if (/propos/.test(m.uma)) return { code: 'proposed', chip: ['proposed', 'accent'], main: 'Outcome proposed on UMA' + (m.updatedAt ? ' ~' + cd(m.updatedAt) : ''), sub: 'challenge window ≈ ' + live(liveness) + '; exact times not available for this market type', at: m.updatedAt ? m.updatedAt + liveness * 1000 : null, m, o };
    // sports markets carry the fixture time; a postponed game keeps its old endDate but moves gameStartTime forward
    const game = m.gameAt && m.gameAt > (m.endAt || 0) ? m.gameAt : null; const end = game || m.endAt;
    if ((end && end < now) || !m.acceptingOrders) return { code: 'awaiting', chip: ['awaiting proposal', 'amber'], main: (game ? 'Game started ' : 'Market ended ') + (end ? cd(end) : ''), sub: 'nobody has proposed an outcome yet · $' + U.fmtNum(bond, 0) + ' bond, then a ' + live(liveness) + ' challenge window', at: end, m, o };
    if (game) return { code: 'trading', chip: ['open', 'accent'], main: 'Game starts ' + U.fmtDateTime(game) + ' (' + cd(game) + ')', sub: (m.endAt < now ? 'rescheduled · ' : '') + 'resolves after the final result' + (cutoff ? ' · ' + cutoff : ''), at: game, m, o };
    if (!m.endAt) return { code: 'trading', chip: ['open', 'accent'], main: 'No end date on Polymarket', sub: cutoff || 'resolves when the outcome is known · see rules', m, o };
    return { code: 'trading', chip: ['open', 'accent'], main: 'Resolves after ' + U.fmtDateTime(m.endAt) + ' (' + cd(m.endAt) + ')', sub: cutoff || 'earlier if the outcome is known before then · see rules', at: m.endAt, m, o };
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
  R.explainer = () => 'How a question resolves: Polymarket markets settle through UMA\'s optimistic oracle. After the event, anyone can propose the outcome with a $' + R.BOND_USD + ' bond; a challenge window follows (2 h by default, shorter for sports and crypto markets). An undisputed proposal resolves the market. A dispute forces a second proposal; a second dispute goes to a UMA token-holder vote (2–6 days). Meridian settles the question once Polymarket has resolved it.';

  R.openDetails = function (q, id, opts = {}) {
    const s = R.state(q, id); const m = s.m, o = s.o; const UI = MD.ui;
    const kv = []; const row = (k, v) => { if (v != null && v !== '') kv.push(h('div.k', k), h('div', v)); };
    const short = (a) => h('a', { href: R.POLYGONSCAN + a, target: '_blank', rel: 'noopener', title: a }, U.shortAddr(a, 6));
    row('Status', h('div', UI.chip(s.chip[0], s.chip[1]), ' ', s.main, s.sub ? h('div.xs.dim', s.sub) : null));
    if (m) {
      row('Polymarket market ends', m.endAt ? U.fmtDateTime(m.endAt) + (m.endAt > Date.now() ? ' · in ' + U.fmtCountdown(m.endAt - Date.now()) : ' · ' + U.fmtAgo(m.endAt)) : '—');
      if (m.gameAt) row('Fixture', U.fmtDateTime(m.gameAt) + (m.gameAt > Date.now() ? ' · in ' + U.fmtCountdown(m.gameAt - Date.now()) : ' · ' + U.fmtAgo(m.gameAt)) + (m.gameAt > (m.endAt || 0) + 3600000 ? ' · rescheduled after the listed end' : ''));
      row('Meridian betting cutoff', q.end ? U.fmtDateTime(q.end) + (m.endAt && m.endAt - q.end > 3600000 ? ' · ' + U.fmtDuration(m.endAt - q.end) + ' before the market ends' : '') : '—');
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
