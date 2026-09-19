/* MeridianDataHub — copy simulator: replay a leader's fills as a follower who acts a little later, at taker fees, with
   slippage at their own size, and see what would have been kept. Pure functions over public data (fills, positions,
   one-minute oracle candles, today's books); the page wires them to settings and charts. */
(function () {
  const MD = window.MD; const U = MD.util; const A = MD.api; const AN = MD.analytics;
  const S = (MD.copysim = {});
  const EPS = 1e-9;

  /**
   * Position episodes from a subaccount's fills, oldest first: a position opens when the net quantity of a market leaves
   * zero and closes when it returns there. A fill that crosses zero (a reversal) is split into the closing part and the
   * opening part of the next episode. Fills are ordered by time, then by id (UUIDv7, so time-ordered) for fills that
   * share a millisecond. Each episode: {pid, start, end (null while open), side (+1 long), fills: [{t, q (signed), px,
   * fee, maker, oid}], qty (open quantity, signed)}.
   */
  S.episodes = function (fills, positions) {
    const rows = fills.slice().sort((a, b) => (U.num(a.createdAt) - U.num(b.createdAt)) || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
    const done = [], open = {};
    // The exchange's own position records anchor the reconstruction: at every recorded close the net quantity is zero.
    // When the fill window starts inside an older position, the running quantity is off by that position's size and
    // every later episode in the market would be a phantom; forcing a close at the record's close time stops that at
    // the first known close. A record that closes without a fill of its own (a liquidation) is closed the same way.
    const closes = {};
    for (const p of positions || []) if (U.num(p.size) === 0 && U.num(p.totalDecreaseQuantity) > 0) (closes[p.productId] || (closes[p.productId] = [])).push({ t: U.num(p.updatedAt), createdAt: U.num(p.createdAt), px: U.num(p.totalDecreaseNotional) / U.num(p.totalDecreaseQuantity), p });
    for (const list of Object.values(closes)) list.sort((a, b) => a.t - b.t);
    const idx = {}, ended = {};   // ended: close times of episodes the fills themselves closed, per market
    const forceCloses = (pid, before) => {
      const list = closes[pid]; if (!list) return;
      while ((idx[pid] || 0) < list.length && list[idx[pid] || 0].t < before) {
        const c = list[idx[pid] || 0]; idx[pid] = (idx[pid] || 0) + 1;
        if ((ended[pid] || []).some((t) => Math.abs(t - c.t) < 1000)) continue;   // a fill closed this record: nothing to force
        const e = open[pid]; if (!e || e.start > c.t) continue;
        const matched = Math.abs(e.start - c.createdAt) < 5000;
        e.fills.push({ t: c.t, q: -e.qty, px: c.px, fee: 0, maker: false, synthetic: true, oid: null });
        e.qty = 0; e.end = c.t; e.forced = true; if (!matched) e.partial = true;
        done.push(e); delete open[pid];
      }
    };
    for (const f of rows) {
      const filled = U.num(f.filled), px = U.num(f.price); if (!(filled > 0) || !(px > 0)) continue;
      const q = (U.sideName(f.side) === 'BUY' ? 1 : -1) * filled; const t = U.num(f.createdAt);
      forceCloses(f.productId, t);
      const feeRate = U.num(f.feeUsd) / (filled * px);   // the leader's own rate on this fill (maker or taker)
      let e = open[f.productId]; let rest = q;
      if (e && Math.sign(e.qty) !== Math.sign(q) && Math.abs(q) > Math.abs(e.qty) + EPS) {
        // crosses zero: close what is open at this price, the remainder opens the next episode
        const closeQ = -e.qty;
        e.fills.push({ t, q: closeQ, px, fee: Math.abs(closeQ) * px * feeRate, maker: !!f.isMaker, oid: f.orderId });
        e.qty = 0; e.end = t; done.push(e); (ended[f.productId] || (ended[f.productId] = [])).push(t); delete open[f.productId]; e = null; rest = q - closeQ;
      }
      if (!e) e = open[f.productId] = { pid: f.productId, start: t, end: null, side: Math.sign(rest), qty: 0, fills: [] };
      e.fills.push({ t, q: rest, px, fee: Math.abs(rest) * px * feeRate, maker: !!f.isMaker, oid: f.orderId });
      e.qty += rest;
      if (Math.abs(e.qty) < EPS) { e.qty = 0; e.end = t; done.push(e); (ended[f.productId] || (ended[f.productId] = [])).push(t); delete open[f.productId]; }
    }
    for (const pid of Object.keys(open)) forceCloses(pid, Infinity);   // records that closed after the last fill (a liquidation at the end)
    return done.concat(Object.values(open)).sort((a, b) => a.start - b.start);
  };

  /**
   * Attach the exchange's own position record to each episode (funding, position fees, liquidation flag), and flag
   * episodes the fill window cannot have seen whole: when the exchange says a position in that market was already open
   * at the episode's first fill, that fill was a reduction or close of an older position (the fill history is
   * fetched newest-first and cut off), not an opening, and the episode is left out of the replay.
   */
  S.attachPositions = function (episodes, positions) {
    for (const e of episodes) {
      const p = (positions || []).find((p) => p.productId === e.pid && Math.abs(U.num(p.createdAt) - e.start) < 5000);
      e.pos = p || null;
      if (!p && (positions || []).some((p) => p.productId === e.pid && U.num(p.createdAt) < e.start - 5000 && (U.num(p.size) !== 0 || U.num(p.updatedAt) >= e.start))) e.partial = true;
      e.liq = !!(p && p.isLiquidated);
      e.fundingRecv = p ? -U.num(p.fundingAccruedUsd) : 0;         // + = received
      e.posFee = p ? U.num(p.positionFeeAccruedUsd) : 0;
    }
    return episodes;
  };

  /** Leader's own result of an episode: gross from its fills (cash flow), fees, funding, position fee, entry notional. */
  S.leaderResult = function (e, mark) {
    const gross = -U.sum(e.fills, (f) => f.q * f.px) + (e.qty ? e.qty * (mark || e.fills[e.fills.length - 1].px) : 0);
    const fees = U.sum(e.fills, (f) => f.fee);
    const entryNotional = U.sum(e.fills.filter((f) => Math.sign(f.q) === e.side), (f) => Math.abs(f.q) * f.px);
    return { gross, fees, funding: e.fundingRecv || 0, posFee: e.posFee || 0, net: gross - fees + (e.fundingRecv || 0) - (e.posFee || 0), entryNotional };
  };

  /** The notional of the leader's opening order: every fill of the episode's first order, not just its first piece. */
  S.firstOrderNotional = function (e) {
    const first = e.fills[0]; const same = first.oid ? e.fills.filter((f) => f.oid === first.oid && Math.sign(f.q) === e.side) : [first];
    return { qty: U.sum(same, (f) => Math.abs(f.q)), notional: U.sum(same, (f) => Math.abs(f.q) * f.px) };
  };

  /**
   * Replay one episode as a copier. settings: {mode: 'fixed' | 'perfill' | 'ratio', size (USD), ratio, delaySec,
   * slipBps (per pid or number), feeRate (per pid or number), priceAt(pid, t, px, delaySec) → price the copier gets}.
   *   fixed:   the leader's opening order is `size` USD for the copier; later adds and reductions follow in proportion.
   *   perfill: every entry fill is `size` USD; reductions cut the copier's position by the same share as the leader's.
   *   ratio:   every fill is `ratio` × the leader's quantity.
   * Funding and position fees scale with the copier's average share of the leader's position over the episode.
   */
  S.replayEpisode = async function (e, settings, mark) {
    const fo = S.firstOrderNotional(e);
    const kFixed = settings.mode === 'ratio' ? settings.ratio : settings.size / fo.notional;
    const slip = typeof settings.slipBps === 'number' ? settings.slipBps : (settings.slipBps && settings.slipBps[e.pid]) || 0;
    const feeRate = typeof settings.feeRate === 'number' ? settings.feeRate : (settings.feeRate && settings.feeRate[e.pid]) || 0.0003;
    let cash = 0, fees = 0, driftCost = 0, slipCost = 0, notional = 0, entryNotional = 0, leaderQty = 0, copierQty = 0, shareSum = 0, shareN = 0;
    const legs = [];
    for (const f of e.fills) {
      let q;
      if (settings.mode === 'perfill') {
        const entry = Math.sign(f.q) === e.side;
        q = entry ? Math.sign(f.q) * (settings.size / f.px) : (leaderQty ? (f.q / leaderQty) * copierQty : 0);   // a reduction cuts the same share
        if (!entry && Math.abs(q) > Math.abs(copierQty)) q = -copierQty;
      } else q = f.q * kFixed;
      const dir = Math.sign(q);
      const late = f.synthetic ? f.px : await settings.priceAt(e.pid, f.t, f.px, settings.delaySec);   // a liquidation exit is taken at the leader's exit price
      const px = late * (1 + (dir * slip) / 1e4);
      cash -= q * px; const n = Math.abs(q) * px; notional += n; if (dir === e.side) entryNotional += n; const fee = n * feeRate; fees += fee;
      driftCost += q * (late - f.px);                 // paid because the price moved before the copier acted: a buy at a higher price, a sell at a lower one
      slipCost += Math.abs(q) * late * (slip / 1e4);
      leaderQty += f.q; copierQty += q;
      if (Math.abs(leaderQty) > EPS) { shareSum += Math.abs(copierQty / leaderQty); shareN++; }
      legs.push({ t: f.t + settings.delaySec * 1000, q, px, leaderPx: f.px, fee });
    }
    const k = shareN ? shareSum / shareN : kFixed;    // the copier's share of the leader's position, for funding and position fees
    const openQ = copierQty; const m = openQ ? (mark || e.fills[e.fills.length - 1].px) : 0;
    const gross = cash + openQ * m;
    const funding = (e.fundingRecv || 0) * k, posFee = (e.posFee || 0) * k;
    return { k, gross, fees, funding, posFee, driftCost, slipCost, net: gross - fees + funding - posFee, notional, entryNotional, legs };
  };

  /**
   * Replay every episode of a leader that opened at or after `since`. Returns per-episode rows (leader vs copier), totals,
   * cumulative curves for both, and the copier's max drawdown on its own cumulative net.
   */
  S.replay = async function ({ episodes, settings, marks, since = 0, ref }) {
    const rows = []; let partial = 0, noFunding = 0;
    for (const e of episodes) {
      if (e.start < since) continue;
      if (settings.markets && settings.markets.size && !settings.markets.has(e.pid)) continue;
      if (e.partial) { partial++; continue; }
      const mark = e.qty ? marks && marks[e.pid] : null;
      if (e.qty && !mark) continue;   // open with no price to mark it: leave out rather than guess
      if (!e.pos) noFunding++;
      const L = S.leaderResult(e, mark); const Cp = await S.replayEpisode(e, settings, mark);
      const prod = ref && ref.byId[e.pid];
      rows.push({ e, ticker: prod ? prod.displayTicker : e.pid, long: e.side > 0, open: !!e.qty, liq: e.liq, t0: e.start, t1: e.end || Date.now(), hold: (e.end || Date.now()) - e.start, L, C: Cp,
        leaderBps: L.entryNotional ? (L.net / L.entryNotional) * 1e4 : null, copierBps: Cp.entryNotional ? (Cp.net / Cp.entryNotional) * 1e4 : null });
    }
    rows.sort((a, b) => a.t1 - b.t1);
    const T = { leaderNet: 0, leaderGross: 0, leaderFees: 0, copierNet: 0, copierGross: 0, fees: 0, drift: 0, slip: 0, funding: 0, posFee: 0, n: rows.length, wins: 0, open: 0, liq: 0, notional: 0, partial, noFunding };
    let cum = 0, cumL = 0, peak = 0, dd = 0; const curve = [], curveL = [];
    for (const r of rows) {
      T.leaderNet += r.L.net; T.leaderGross += r.L.gross; T.leaderFees += r.L.fees; T.copierNet += r.C.net; T.copierGross += r.C.gross; T.fees += r.C.fees; T.drift += r.C.driftCost; T.slip += r.C.slipCost; T.funding += r.C.funding; T.posFee += r.C.posFee; T.notional += r.C.notional;
      if (r.C.net > 0) T.wins++; if (r.open) T.open++; if (r.liq) T.liq++;
      cum += r.C.net; cumL += r.L.net; curve.push({ x: r.t1, y: cum }); curveL.push({ x: r.t1, y: cumL });
      if (cum > peak) peak = cum; if (peak - cum > dd) dd = peak - cum;
    }
    T.maxDd = dd; T.winRate = rows.length ? (T.wins / rows.length) * 100 : null;
    T.edgeKept = T.leaderNet > 0 ? (T.copierNet / T.leaderNet) * 100 : null;
    return { rows, T, curve, curveL };
  };

  /**
   * The price a copier gets `delaySec` after a leader's fill, from one-minute oracle closes: inside the fill's own minute
   * the price runs from the fill price to that minute's close; in a later minute it runs from the previous minute's close
   * to that minute's close. Counts the fills that had no candle (then the fill price is used, and no drift).
   */
  S.priceAtFactory = function (candles, ref) {
    const stats = { fills: 0, noCandle: 0 };
    const fn = async (pid, t, px, delaySec) => {
      if (!delaySec) return px;
      stats.fills++;
      const prod = ref.byId[pid]; if (!prod) { stats.noCandle++; return px; }
      const target = t + delaySec * 1000;
      const m0 = Math.floor(t / 60000) * 60000, mT = Math.floor(target / 60000) * 60000;
      const cT = await candles.at(prod.ticker, target);
      if (cT == null) { stats.noCandle++; return px; }
      if (mT === m0) { const left = m0 + 60000 - t; return left > 0 ? px + (cT - px) * Math.min(1, (target - t) / left) : cT; }
      const cPrev = await candles.at(prod.ticker, mT - 1);
      const from = cPrev == null ? px : cPrev;
      return from + (cT - from) * ((target - mT) / 60000);
    };
    fn.stats = stats;
    return fn;
  };

  /** Slippage per market for a copier's notional, from today's books (bps, average of both sides; 60 when unfillable). */
  S.slippageFor = function (depth, ref, notional) {
    const out = {};
    for (const p of ref.active) {
      const book = depth[p.id]; if (!book) continue;
      const a = AN.bookSlippage(book, true, notional), b = AN.bookSlippage(book, false, notional);
      const v = a.bps != null && b.bps != null ? (a.bps + b.bps) / 2 : a.bps != null ? a.bps : b.bps;
      out[p.id] = v == null ? 60 : Math.min(v, 60);
    }
    return out;
  };

  /** Everything the page needs for one leader: fills, positions, episodes, books, candle cache, marks. */
  S.load = async function (sid, { signal, maxFillPages = 30 } = {}) {
    const ref = await A.ref({ signal });
    const [fills, positions, depth] = await Promise.all([
      A.page(A.BASE, '/v1/order/fill', { subaccountId: sid }, { maxPages: maxFillPages, signal }),
      A.positions(sid, { maxPages: 5, signal }),
      (async () => { const d = {}; await U.pLimit(ref.active.map((p) => async () => { try { d[p.id] = await A.liquidity(p.id, { signal }); } catch (_) {} }), 4); return d; })(),
    ]);
    const episodes = S.attachPositions(S.episodes(fills, positions), positions);
    const pm = await A.marketPrices(ref.active.map((p) => p.id), { signal, ttl: 10000 }).catch(() => ({}));
    const marks = {}; for (const [pid, x] of Object.entries(pm)) marks[pid] = U.num(x.oraclePrice) || U.num(x.markPrice) || null;
    const oldestFill = fills.length ? Math.min(...fills.map((f) => U.num(f.createdAt))) : null;
    return { ref, fills, positions, episodes, depth, marks, candles: AN.candleCache({ signal }), truncated: !!fills.truncated, oldestFill, positionsTruncated: !!positions.truncated };
  };
})();
