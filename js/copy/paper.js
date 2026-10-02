/* MeridianDataHub — paper copy: a virtual account that mirrors a leader's fills as they happen, sized and delayed like the
   simulator, kept in localStorage. The exchange's fill history is the record: live fill messages only say when to look,
   and every fill is applied once, under its own id, with the leader's real quantity. Fills the page applies on time are
   priced at the live mark (the delay cost is measured, not modelled); fills found later (the tab was closed, the stream
   dropped) are priced at candle closes. After each sync the copy is lined up with the leader's actual positions.
   Nothing here touches the exchange. */
(function () {
  const MD = window.MD; const U = MD.util;
  const P = (MD.paper = {});
  const EPS = 1e-9;
  P.V = 3;
  P.key = (sid) => 'md.paper.' + sid;
  P.load = (sid) => U.storage.get(P.key(sid), null);
  /** Write the account; rev counts writes, so a tab holding an older copy can tell another tab has moved on. */
  P.save = (st) => { st.rev = (st.rev || 0) + 1; return U.storage.set(P.key(st.sid), st); };
  P.clear = (sid) => U.storage.del(P.key(sid));

  /** The leader's open positions as productId → signed quantity (+ long, − short), from A.openPositions rows. */
  P.leaderBook = (positions) => {
    const m = {};
    for (const p of positions || []) { const q = U.num(p.size); if (q) m[p.productId] = (Number(p.side) === 1 || p.side === 'SELL' ? -1 : 1) * Math.abs(q); }
    return m;
  };

  const blank = (sid, address, settings, pre, startedAt) => ({ v: P.V, sid, address, startedAt, lastSeen: startedAt, fillT: null, rev: 0, settings, pre: Object.assign({}, pre || {}), pre0: Object.assign({}, pre || {}), open: {}, closed: [], log: [], seen: {}, totals: { realized: 0, fees: 0, slip: 0, driftLive: 0, driftModeled: 0, funding: 0, liveFills: 0, caughtUp: 0 } });
  /** A fresh paper account following `sid` with the simulator's settings. pre: the leader's positions at that moment
   *  (P.leaderBook). The copy does not hold them, so the leader cutting or closing one later is not a new position. */
  P.start = (sid, address, settings, pre, startedAt) => { const st = blank(sid, address, settings, pre, startedAt || Date.now()); P.save(st); return st; };
  /** The same account recomputed from scratch: the settings, start and starting positions of `st`, no fills yet. */
  P.fresh = (st, pre) => Object.assign(blank(st.sid, st.address, st.settings, pre != null ? pre : st.pre0 || {}, st.startedAt), { rev: st.rev || 0 });

  function openPos(st, fill, exec, q) {
    const s = st.settings;
    const orderQty = fill.orderQty && fill.orderQty > Math.abs(q) ? fill.orderQty : Math.abs(q);
    const k = s.mode === 'ratio' ? s.ratio : s.size / (orderQty * fill.px);
    // basis: what the quantity still held cost at its entry prices (signed), scaled down in proportion on a reduction:
    // the exchange's average-cost convention. A position kept before it existed has none (see P.unrealized).
    return (st.open[fill.pid] = { pid: fill.pid, ticker: fill.ticker, k, qty: 0, leaderQty: 0, cash: 0, fees: 0, slip: 0, drift: 0, funding: 0, openedAt: exec.at, fills: 0, entryNotional: 0, basis: 0, leaderPx0: fill.px, side: Math.sign(q) });
  }
  /** Close the episode when the copy is flat: realized = cash − fees + funding. */
  function settle(st, pos, at, row, why) {
    if (!(Math.abs(pos.leaderQty) < EPS || Math.abs(pos.qty) < EPS)) return;
    const net = pos.cash - pos.fees + pos.funding;
    const ep = { ticker: pos.ticker, pid: pos.pid, openedAt: pos.openedAt, closedAt: at, entryNotional: pos.entryNotional, gross: pos.cash, fees: pos.fees, funding: pos.funding, drift: pos.drift, slip: pos.slip, net, fills: pos.fills, long: pos.side > 0 };
    if (why) ep.why = why;
    st.closed.unshift(ep); if (st.closed.length > 500) st.closed.length = 500;
    st.totals.realized += net; delete st.open[pos.pid];
    if (row) row.closed = ep;
  }
  function logRow(st, row) { st.log.unshift(row); if (st.log.length > 200) st.log.length = 200; }

  /**
   * Mirror one leader fill into the virtual account. fill: {id, t, pid, ticker, side ('BUY'|'SELL'), qty, px, orderQty
   * (the whole order's quantity when known, so a fixed-size copy is sized on the order, not on its first piece)}.
   * exec: {px (what the copier gets, before slippage), live (true when measured on the tape), at (execution time)}.
   * A fill against the leader's position cuts the copy by the same share of its position as the leader of its whole
   * one, including the part the copy does not hold (st.pre: held before following, or found by P.reconcile); only what
   * goes past zero opens a position on the other side.
   */
  P.apply = (st, fill, exec) => {
    if (st.settings.markets && !st.settings.markets.includes(fill.pid)) {
      // a market the copy does not follow: the fill is marked seen and the leader's position there tracked as not ours
      if (fill.id) { if (st.seen[fill.id]) return null; st.seen[fill.id] = 1; }
      const pre = st.pre || (st.pre = {}); pre[fill.pid] = (pre[fill.pid] || 0) + (fill.side === 'BUY' ? 1 : -1) * Math.abs(fill.qty); if (Math.abs(pre[fill.pid]) < EPS) delete pre[fill.pid];
      st.lastSeen = Math.max(st.lastSeen, fill.t); if (fill.t) st.fillT = Math.max(st.fillT || 0, fill.t);
      return [];
    }
    if (fill.id && st.seen[fill.id]) return null;
    if (fill.id) st.seen[fill.id] = 1;
    const s = st.settings; const pre = st.pre || (st.pre = {});
    const dir = fill.side === 'BUY' ? 1 : -1;
    const out = [];
    const slip = typeof s.slipBps === 'number' ? s.slipBps : (s.slipBps && s.slipBps[fill.pid]) || 0;
    const fee = (notional) => notional * (s.feeRate && s.feeRate[fill.pid] != null ? s.feeRate[fill.pid] : 0.0003);
    const trade = (pos, q, leaderPart) => {
      const d = Math.sign(q); const px = exec.px * (1 + (d * slip) / 1e4);
      const notional = Math.abs(q) * px; const f = fee(notional); const sl = Math.abs(q) * exec.px * (slip / 1e4);
      const drift = q * (exec.px - fill.px);   // what the wait cost, signed like the simulator
      if (pos.basis != null) { if (d === pos.side) pos.basis += q * px; else if (Math.abs(pos.qty) > EPS) pos.basis *= Math.max(0, 1 - Math.abs(q) / Math.abs(pos.qty)); }
      pos.qty += q; pos.leaderQty += leaderPart; pos.cash -= q * px; pos.fees += f; pos.slip += sl; pos.drift += drift; pos.fills++;
      if (d === pos.side) pos.entryNotional += notional;
      st.totals.fees += f; st.totals.slip += sl; st.totals[exec.live ? 'driftLive' : 'driftModeled'] += drift; if (exec.live) st.totals.liveFills++; else st.totals.caughtUp++;
      const row = { t: exec.at, leaderT: fill.t, ticker: fill.ticker, side: q > 0 ? 'BUY' : 'SELL', qty: Math.abs(q), leaderQty: Math.abs(leaderPart), leaderPx: fill.px, px, fee: f, drift, live: !!exec.live };
      logRow(st, row); out.push(row);
      return row;
    };
    let rest = Math.abs(fill.qty);
    const pos0 = st.open[fill.pid]; const tracked = pos0 ? pos0.leaderQty : 0; const p0 = pre[fill.pid] || 0;
    const T = tracked + p0;   // the leader's whole position before this fill, as far as this copy knows
    if (Math.abs(T) > EPS && Math.sign(T) !== dir) {
      const cut = Math.min(rest, Math.abs(T)); const all = cut >= Math.abs(T) - EPS * Math.max(1, Math.abs(T)); const share = all ? 1 : cut / Math.abs(T);
      // the part of an order that closed the old position: a reversal's new position is sized on the rest of the order
      if (fill.oid) { const oc = st.oc || (st.oc = {}); if (Object.keys(oc).length > 200) st.oc = {}; st.oc[fill.oid] = ((st.oc[fill.oid]) || 0) + cut; }
      if (p0) { if (all) delete pre[fill.pid]; else pre[fill.pid] = p0 * (1 - share); }
      if (pos0) {
        const q = all ? -pos0.qty : -pos0.qty * share; const lq = all ? -pos0.leaderQty : -pos0.leaderQty * share;
        if (Math.abs(q) > EPS) { const row = trade(pos0, q, lq); if (all) { pos0.leaderQty = 0; pos0.qty = 0; } settle(st, pos0, exec.at, row); }
        else { pos0.leaderQty += lq; if (all) delete st.open[fill.pid]; }
      }
      rest = all ? Math.max(0, rest - Math.abs(T)) : 0;
    }
    if (rest > EPS) {
      // an entry: in the direction the leader holds (or from flat), a new copy position or an add to it
      let pos = st.open[fill.pid];
      if (pos && pos.side !== dir) { const row = trade(pos, -pos.qty, -pos.leaderQty); pos.leaderQty = 0; pos.qty = 0; settle(st, pos, exec.at, row); pos = null; }   // cannot happen when pre and the copy agree; safe if they do not
      if (!pos) {
        const closedPart = fill.oid && st.oc ? st.oc[fill.oid] || 0 : 0;
        pos = openPos(st, closedPart && fill.orderQty ? Object.assign({}, fill, { orderQty: Math.max(0, fill.orderQty - closedPart) }) : fill, exec, dir * rest);
      }
      let q = s.mode === 'perfill' ? dir * (s.size / exec.px) : dir * rest * pos.k;
      const maxPos = MD.copysim ? MD.copysim.maxPosition(s) : Infinity;   // a scaled-in leader must not make the position any multiple of `size`
      const room = maxPos / exec.px - Math.abs(pos.qty);
      if (Math.abs(q) > room + EPS) { q = dir * Math.max(0, room); pos.capped = true; }
      if (Math.abs(q) < EPS) { pos.leaderQty += dir * rest; if (Math.abs(pos.qty) < EPS && Math.abs(pos.leaderQty) < EPS) delete st.open[fill.pid]; }
      else trade(pos, q, dir * rest);
      if (pos.qty === 0 && pos.fills === 0) { delete st.open[fill.pid]; pre[fill.pid] = (pre[fill.pid] || 0) + dir * rest; }   // nothing bought (no room): the leader's part is untracked
    }
    st.lastSeen = Math.max(st.lastSeen, fill.t);
    if (fill.t) st.fillT = Math.max(st.fillT || 0, fill.t);
    return out;
  };

  /**
   * Apply the leader's fills from the exchange's history (A.page '/v1/order/fill' rows) that this account has not seen,
   * oldest first. price(fill, product) → Promise<{px, live, at}>. orderQty: optional orderId → the order's whole quantity
   * (fixed-size copies), else the pieces of the order in `fills`. Returns the log rows written.
   */
  P.applyFills = async (st, fills, ref, price, orderQty) => {
    const oq = Object.assign({}, orderQty || {});
    const sums = {}; for (const f of fills) sums[f.orderId] = (sums[f.orderId] || 0) + U.num(f.filled);
    for (const k of Object.keys(sums)) if (!(oq[k] > 0)) oq[k] = sums[k];
    const rows = [];
    for (const f of fills.slice().sort((a, b) => (U.num(a.createdAt) - U.num(b.createdAt)) || (String(a.id) < String(b.id) ? -1 : 1))) {
      if (st.seen[f.id] || U.num(f.createdAt) < st.startedAt) continue;
      const prod = ref.byId[f.productId]; if (!prod) continue;
      const exec = await price(f, prod);
      const r = P.apply(st, { id: f.id, oid: f.orderId, t: U.num(f.createdAt), pid: f.productId, ticker: prod.displayTicker, side: U.sideName(f.side), qty: U.num(f.filled), px: U.num(f.price), orderQty: oq[f.orderId] }, exec);
      if (r) rows.push(...r);
    }
    return rows;
  };

  /** Cut a virtual position by `share` (1 = close) at a price without a leader fill: the leader's position changed without
   *  a fill in the history (a liquidation, a deleveraging) or the copy was out of line with it. */
  P.cutAt = (st, pid, share, px, at, why) => {
    const pos = st.open[pid]; if (!pos || !(share > 0)) return null;
    const all = share >= 1 - 1e-12; const q = all ? -pos.qty : -pos.qty * share;
    const notional = Math.abs(q) * px; const fee = notional * (st.settings.feeRate && st.settings.feeRate[pid] != null ? st.settings.feeRate[pid] : 0.0003);
    pos.cash -= q * px; pos.fees += fee; pos.fills++; st.totals.fees += fee;
    if (pos.basis != null) pos.basis = all ? 0 : pos.basis * (1 - share);
    pos.qty = all ? 0 : pos.qty + q; pos.leaderQty = all ? 0 : pos.leaderQty * (1 - share);
    const row = { t: at, leaderT: at, ticker: pos.ticker, side: q > 0 ? 'BUY' : 'SELL', qty: Math.abs(q), leaderQty: 0, leaderPx: px, px, fee, drift: 0, live: false, why };
    logRow(st, row);
    if (all) settle(st, pos, at, row, why);
    return row;
  };
  /** Close a virtual position at a price without a leader fill. */
  P.closeAt = (st, pid, px, at, why) => P.cutAt(st, pid, 1, px, at, why);

  /** Markets where the copy's record of the leader (its copied part plus st.pre) differs from the leader's book. */
  P.needsReconcile = (st, book) => {
    const pre = st.pre || {}; const out = [];
    for (const pid of new Set([...Object.keys(st.open), ...Object.keys(pre), ...Object.keys(book || {})])) {
      const T = (st.open[pid] ? st.open[pid].leaderQty : 0) + (pre[pid] || 0); const a = (book && book[pid]) || 0;
      if (Math.abs(a - T) > 1e-6 * Math.max(1, Math.abs(a), Math.abs(T))) out.push(pid);
    }
    return out;
  };

  /**
   * Line the copy up with the leader's actual positions (P.leaderBook of A.openPositions) once its fills are applied.
   * A fill the history did not show (a liquidation, a deleveraging), or a position the leader held before following,
   * must not leave the copy holding what the leader no longer holds, nor count as a new position later.
   * markOf(pid) → price, or null to leave that market alone (fills still pending there, or no price).
   */
  P.reconcile = (st, book, markOf, at) => {
    const pre = st.pre || (st.pre = {}); const rows = [];
    const pids = new Set([...Object.keys(st.open), ...Object.keys(pre), ...Object.keys(book || {})]);
    for (const pid of pids) {
      const pos = st.open[pid]; const tracked = pos ? pos.leaderQty : 0; const p0 = pre[pid] || 0; const a = (book && book[pid]) || 0;
      const T = tracked + p0;
      if (Math.abs(a - T) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(T))) continue;
      const mk = markOf(pid); if (!mk) continue;
      if (!pos) { if (a) pre[pid] = a; else delete pre[pid]; continue; }   // nothing held: only the record of the leader's untracked part
      if (!a || Math.sign(a) !== Math.sign(tracked)) {
        rows.push(P.closeAt(st, pid, mk, at, a ? 'the leader is on the other side now, without a fill in the history' : 'the leader is flat here without a fill in the history (liquidation or deleveraging)'));
        if (a) pre[pid] = a; else delete pre[pid];
        continue;
      }
      if (Math.abs(a) < Math.abs(T)) {   // the leader holds less than its fills say: the copy cuts the same share
        const share = 1 - Math.abs(a) / Math.abs(T);
        rows.push(P.cutAt(st, pid, share, mk, at, 'the leader\'s position is smaller than its fills say (a fill the history did not show)'));
        if (p0) pre[pid] = p0 * (1 - share);
      } else pre[pid] = a - tracked;   // the leader holds more: its own, not the copy's
      if (Math.abs(pre[pid] || 0) < EPS) delete pre[pid];
    }
    return rows.filter(Boolean);
  };

  /** Accrue `hours` of funding on the open virtual positions at each market's latest hourly rate in `ref` (longs pay when positive). */
  P.accrueFunding = (st, ref, marks, hours) => {
    for (const pos of Object.values(st.open)) {
      const prod = ref.byId[pos.pid]; const mark = marks[pos.pid]; if (!prod || !mark) continue;
      const rate = U.num(prod.fundingRate1h); const paid = Math.sign(pos.qty) * rate * Math.abs(pos.qty) * mark * hours;
      pos.funding -= paid; st.totals.funding -= paid;
    }
  };

  /** Unrealized result of the open virtual positions at the given marks: the quantity held against its basis, before fees.
   *  A position kept before basis existed has only its result so far (partial closes, fees and funding included). */
  P.unrealized = (st, marks) => U.sum(Object.values(st.open), (pos) => (!marks[pos.pid] ? 0 : pos.basis != null ? pos.qty * marks[pos.pid] - pos.basis : pos.cash + pos.qty * marks[pos.pid] - pos.fees + pos.funding));
  /** What the positions still open have already booked: partial closes, fees and funding (the realized part of them). */
  P.bookedOpen = (st) => U.sum(Object.values(st.open), (pos) => (pos.basis != null ? pos.cash + pos.basis - pos.fees + pos.funding : 0));
})();
