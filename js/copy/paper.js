/* MeridianDataHub — paper copy: a virtual account that mirrors a leader's fills as they happen, sized and delayed like the
   simulator, kept in localStorage. Live fills are priced off the real tape `delay` seconds later (the delay cost is
   measured, not modelled); fills that happened while the tab was closed are caught up from the leader's public fills
   at candle prices. Nothing here touches the exchange. */
(function () {
  const MD = window.MD; const U = MD.util;
  const P = (MD.paper = {});
  const EPS = 1e-9;
  P.key = (sid) => 'md.paper.' + sid;
  P.load = (sid) => U.storage.get(P.key(sid), null);
  P.save = (st) => U.storage.set(P.key(st.sid), st);
  P.clear = (sid) => U.storage.del(P.key(sid));

  /** A fresh paper account following `sid` with the simulator's settings. */
  P.start = (sid, address, settings) => {
    const st = { v: 2, sid, address, startedAt: Date.now(), lastSeen: Date.now(), settings, open: {}, closed: [], log: [], seen: {}, totals: { realized: 0, fees: 0, slip: 0, driftLive: 0, driftModeled: 0, funding: 0, liveFills: 0, caughtUp: 0 } };
    P.save(st); return st;
  };

  /**
   * Mirror one leader fill into the virtual account. fill: {id, t, pid, ticker, side ('BUY'|'SELL'), qty, px, orderQty
   * (the whole order's quantity when known, so a fixed-size copy is sized on the order, not on its first piece)}.
   * exec: {px (what the copier gets, before slippage), live (true when measured on the tape), at (execution time)}.
   */
  P.apply = (st, fill, exec) => {
    if (fill.id && st.seen[fill.id]) return null;
    if (fill.id) st.seen[fill.id] = 1;
    const s = st.settings; const dir = fill.side === 'BUY' ? 1 : -1; const q0 = dir * fill.qty;
    let pos = st.open[fill.pid];
    const parts = [];
    // a fill that crosses zero closes the episode and opens the next with the remainder, as on the exchange
    if (pos && Math.sign(pos.leaderQty) !== dir && fill.qty > Math.abs(pos.leaderQty) + EPS) {
      parts.push({ q: -pos.leaderQty, closing: true });
      parts.push({ q: q0 + pos.leaderQty, closing: false });
    } else parts.push({ q: q0, closing: !!pos && Math.sign(pos.leaderQty) !== dir });
    const out = [];
    for (const part of parts) {
      pos = st.open[fill.pid];
      if (!pos) {
        const orderQty = fill.orderQty && fill.orderQty > Math.abs(part.q) ? fill.orderQty : Math.abs(part.q);
        const k = s.mode === 'ratio' ? s.ratio : s.size / (orderQty * fill.px);
        pos = st.open[fill.pid] = { pid: fill.pid, ticker: fill.ticker, k, qty: 0, leaderQty: 0, cash: 0, fees: 0, slip: 0, drift: 0, funding: 0, openedAt: exec.at, fills: 0, entryNotional: 0, leaderPx0: fill.px, side: Math.sign(part.q) };
      }
      let q;
      const entry = Math.sign(part.q) === pos.side;
      if (!entry) { q = pos.leaderQty ? (part.q / pos.leaderQty) * pos.qty : 0; if (Math.abs(q) > Math.abs(pos.qty)) q = -pos.qty; }   // the same share as the leader cut
      else {
        q = s.mode === 'perfill' ? Math.sign(part.q) * (s.size / exec.px) : part.q * pos.k;
        const maxPos = MD.copysim ? MD.copysim.maxPosition(s) : Infinity;   // a scaled-in leader must not make the position any multiple of `size`
        const room = maxPos / exec.px - Math.abs(pos.qty);
        if (Math.abs(q) > room + EPS) { q = Math.sign(q) * Math.max(0, room); pos.capped = true; }
      }
      if (Math.abs(q) < EPS) { pos.leaderQty += part.q; if (Math.abs(pos.leaderQty) < EPS && Math.abs(pos.qty) < EPS) delete st.open[fill.pid]; continue; }
      const d = Math.sign(q);
      const slip = typeof s.slipBps === 'number' ? s.slipBps : (s.slipBps && s.slipBps[fill.pid]) || 0;
      const px = exec.px * (1 + (d * slip) / 1e4);
      const notional = Math.abs(q) * px; const fee = notional * (s.feeRate && s.feeRate[fill.pid] != null ? s.feeRate[fill.pid] : 0.0003);
      const drift = q * (exec.px - fill.px);        // what the wait cost, signed like the simulator
      pos.qty += q; pos.leaderQty += part.q; pos.cash -= q * px; pos.fees += fee; pos.slip += Math.abs(q) * exec.px * (slip / 1e4); pos.drift += drift; pos.fills++;
      if (d === pos.side) pos.entryNotional += notional;
      st.totals.fees += fee; st.totals.slip += Math.abs(q) * exec.px * (slip / 1e4); st.totals[exec.live ? 'driftLive' : 'driftModeled'] += drift; if (exec.live) st.totals.liveFills++; else st.totals.caughtUp++;
      const row = { t: exec.at, leaderT: fill.t, ticker: fill.ticker, side: q > 0 ? 'BUY' : 'SELL', qty: Math.abs(q), leaderQty: Math.abs(part.q), leaderPx: fill.px, px, fee, drift, live: !!exec.live };
      st.log.unshift(row); if (st.log.length > 200) st.log.length = 200;
      if (Math.abs(pos.leaderQty) < EPS || Math.abs(pos.qty) < EPS) {
        const net = pos.cash - pos.fees + pos.funding;
        const ep = { ticker: pos.ticker, pid: pos.pid, openedAt: pos.openedAt, closedAt: exec.at, entryNotional: pos.entryNotional, gross: pos.cash, fees: pos.fees, funding: pos.funding, drift: pos.drift, slip: pos.slip, net, fills: pos.fills, long: pos.side > 0 };
        st.closed.unshift(ep); if (st.closed.length > 500) st.closed.length = 500;
        st.totals.realized += net; delete st.open[fill.pid];
        row.closed = ep;
      }
      out.push(row);
    }
    st.lastSeen = Math.max(st.lastSeen, fill.t);
    return out;
  };

  /** Close a virtual position at a price without a leader fill (the leader went flat by liquidation or a fill the history did not show). */
  P.closeAt = (st, pid, px, at, why) => {
    const pos = st.open[pid]; if (!pos) return null;
    const q = -pos.qty; const notional = Math.abs(q) * px; const fee = notional * (st.settings.feeRate && st.settings.feeRate[pid] != null ? st.settings.feeRate[pid] : 0.0003);
    pos.cash -= q * px; pos.fees += fee; pos.fills++; st.totals.fees += fee;
    const net = pos.cash - pos.fees + pos.funding;
    const ep = { ticker: pos.ticker, pid, openedAt: pos.openedAt, closedAt: at, entryNotional: pos.entryNotional, gross: pos.cash, fees: pos.fees, funding: pos.funding, drift: pos.drift, slip: pos.slip, net, fills: pos.fills, long: pos.side > 0, why };
    st.closed.unshift(ep); st.totals.realized += net; delete st.open[pid];
    const row = { t: at, leaderT: at, ticker: pos.ticker, side: q > 0 ? 'BUY' : 'SELL', qty: Math.abs(q), leaderQty: 0, leaderPx: px, px, fee, drift: 0, live: false, closed: ep, why };
    st.log.unshift(row); if (st.log.length > 200) st.log.length = 200;
    return row;
  };

  /** Accrue an hour of funding on the open virtual positions from each market's current hourly rate (longs pay when positive). */
  P.accrueFunding = (st, ref, marks, hours) => {
    for (const pos of Object.values(st.open)) {
      const prod = ref.byId[pos.pid]; const mark = marks[pos.pid]; if (!prod || !mark) continue;
      const rate = U.num(prod.fundingRate1h); const paid = Math.sign(pos.qty) * rate * Math.abs(pos.qty) * mark * hours;
      pos.funding -= paid; st.totals.funding -= paid;
    }
  };

  /** Unrealized result of the open virtual positions at the given marks. */
  P.unrealized = (st, marks) => U.sum(Object.values(st.open), (pos) => (marks[pos.pid] ? pos.cash + pos.qty * marks[pos.pid] - pos.fees + pos.funding : 0));
})();
