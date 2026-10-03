/* MeridianDataHub — Tax center fills: every fill of a subaccount assigned to its position, and each position replayed
   from its first fill at average entry, the exchange's own method (checked: it reproduces every fill's realizedPnl to
   1e-6), so each reduction, partial close, liquidation or auto-deleverage becomes one disposal row on its own date.
   Pure: no DOM, no network. */
(function () {
  const MD = window.MD; const U = MD.util; const T = MD.tax; const TZ = T.tz;
  const F = (T.fills = {});
  const EPS = 1e-9, QEPS = 1e-8, HOUR = 3600000;
  // fill types that are order fills of the subaccount itself; the others (LIQUIDATION, DELEVERAGE, …) exist only on the
  // position's own fill list (/v1/position/fill)
  const ORDER_TYPES = new Set(['MARKET', 'LIMIT']);
  const byTime = (a, b) => a.t - b.t || (a.id && b.id ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : 0);

  /** The class a market's results are summed in: by its base token. */
  F.classOf = (prod) => {
    const b = String((prod && (prod.baseTokenName || prod.displayTicker)) || '').toUpperCase().replace(/-.*$/, '');
    if (['BTC', 'ETH', 'SOL', 'HYPE'].includes(b)) return 'Crypto perps';
    if (['XAU', 'XAG'].includes(b)) return 'Commodity mPerps';
    if (['SPY', 'QQQ'].includes(b)) return 'Equity-ETF mPerps';
    return 'Other · ' + ((prod && prod.displayTicker) || b || '?');
  };

  /** One fill, from /v1/order/fill (src 'order') or /v1/position/fill (src 'position', which carries realizedPnl). */
  F.norm = (f, src) => ({
    t: U.num(f.createdAt), productId: f.productId || null, side: String(f.side), qty: U.num(f.filled), price: U.num(f.price), fee: U.num(f.feeUsd),
    type: String(f.type || ''), reduceOnly: !!f.reduceOnly, isMaker: f.isMaker == null ? null : !!f.isMaker, id: f.id || null, orderId: f.orderId || null,
    pnl: f.realizedPnl != null && f.realizedPnl !== '' ? U.num(f.realizedPnl) : null, src,
  });
  const endOf = (p) => (U.num(p.size) !== 0 ? Infinity : U.num(p.updatedAt));

  /**
   * Every fill to its position. orderFills: /v1/order/fill rows; posFills: Map(positionId → /v1/position/fill rows) for
   * the positions read directly (liquidated, deleveraged, or failing their check), which stand for that position: the
   * order fills they repeat are taken out first, by instant, market and side. The rest is a sweep per market over the
   * positions sorted by opening: a fill goes to the position whose life [createdAt, updatedAt] (to now while open)
   * holds it. Positions on one market never overlap, except at the instant one closes and the next opens: there a
   * reducing fill closes the old one up to what it still holds and the rest opens the new one (an order fill split in
   * two, its fee pro rata to quantity), as the exchange books it. Returns {byPos: Map(positionId → fills ascending),
   * unassigned (fills, or parts of one, no position holds)}.
   */
  F.assign = function (orderFills, posFills, positions) {
    posFills = posFills || new Map();
    const byPos = new Map(positions.map((p) => [p.id, []]));
    const pById = new Map(positions.map((p) => [p.id, p]));
    const unassigned = [];
    const left = (orderFills || []).map((f) => Object.assign(F.norm(f, 'order'), { left: U.num(f.filled) }));
    const key = (t, pid, side) => t + '|' + pid + '|' + side;
    const idx = new Map();
    for (const f of left) { const k = key(f.t, f.productId, f.side); let l = idx.get(k); if (!l) idx.set(k, (l = [])); l.push(f); }
    for (const [pid, list] of posFills) {
      const p = pById.get(pid); if (!p) continue;
      const own = (list || []).map((f) => Object.assign(F.norm(f, 'position'), { productId: p.productId, positionId: pid })).sort(byTime);
      byPos.set(pid, own);
      for (const f of own) {
        if (!ORDER_TYPES.has(f.type)) continue;
        let q = f.qty;
        for (const o of (idx.get(key(f.t, p.productId, f.side)) || []).sort(byTime)) { if (q <= EPS) break; const take = Math.min(q, o.left); o.left -= take; q -= take; }
      }
    }
    const sweep = new Map(), fillsOf = new Map();
    for (const p of positions) if (!posFills.has(p.id)) { let l = sweep.get(p.productId); if (!l) sweep.set(p.productId, (l = [])); l.push(p); }
    for (const f of left) if (f.left > EPS) { let l = fillsOf.get(f.productId); if (!l) fillsOf.set(f.productId, (l = [])); l.push(f); }
    const piece = (f, q, pid) => Object.assign({}, f, { qty: q, fee: f.qty ? f.fee * q / f.qty : 0, positionId: pid, split: q < f.qty - EPS, left: undefined });
    for (const [prod, fs] of fillsOf) {
      fs.sort(byTime);
      const ps = (sweep.get(prod) || []).slice().sort((a, b) => U.num(a.createdAt) - U.num(b.createdAt));
      const open = ps.map(() => 0);
      let i = 0;
      for (const f of fs) {
        while (i < ps.length && endOf(ps[i]) < f.t) i++;
        let q = f.left;
        for (let j = i; j < ps.length && q > EPS && U.num(ps[j].createdAt) <= f.t; j++) {
          const p = ps[j]; if (endOf(p) < f.t) continue;
          let take;
          if (f.side !== String(p.side)) take = Math.min(q, open[j]);   // reduces it, up to what it still holds
          else { const next = ps[j + 1]; take = endOf(p) === f.t && next && U.num(next.createdAt) <= f.t ? 0 : q; }   // an increase at a close goes to the position that opens
          if (take <= EPS) continue;
          byPos.get(p.id).push(piece(f, take, p.id));
          open[j] += f.side === String(p.side) ? take : -take; q -= take;
        }
        if (q > EPS) unassigned.push(piece(f, q, null));
      }
    }
    for (const [pid, l] of byPos) if (!posFills.has(pid)) l.sort(byTime);
    return { byPos, unassigned };
  };

  /**
   * Replays one position from its first fill at average entry: an increase moves the average, a reduction books
   * (exit − average) × quantity (the sign flipped for a short) against it and leaves it where it is. fills: the
   * position's fills ascending (F.assign). settle: {funding: Map(t → amount, + = received), fee: Map(t → position fee,
   * + = paid)}, the settlements at each fill instant (T.funding). o: {prod, tz, complete (the fills cover the whole life
   * of the position, so its totals can be checked), fx(usd, t) (the report currency; USD when left out)}.
   * Returns {rows (one per reducing fill), sizeAt(t), avgAt(t), check}. A row: {positionId, productId, ticker, cls, long,
   * n (the fill's number in the position), t, qty, avgEntry, exit, gross (the exchange's realizedPnl of the fill when
   * read, else the replay's), openFee (the fees of the increases still open, shared by quantity closed), closeFee (the
   * fill's own), fundingAt / posFeeAt (settled at this fill), fundingIn / posFeeIn (settled since the position opened and
   * not yet carried by an earlier disposal, shared by quantity closed: the 'inside the result' reading), net (gross −
   * both fees), netAll (net + fundingIn − posFeeIn), entryNotional, exitNotional, proceeds and cost (a labelled
   * convention: a long's cost is its entry notional plus its opening fee, a short's proceeds its entry notional less it;
   * proceeds − cost = net either way), opened, acquired (local date of the increases it is averaged over, or 'VARIOUS'),
   * firstInc / lastInc, longTerm (the last of them more than a year before, in local dates), longTermUS (the same with
   * Rev. Rul. 66-7's month-end reading: Form 8949's Part), partial (the position stays
   * open), liq, adl, type, src, fillId}; and in the report currency (o.fx), each part at its own local date as UK
   * CG78310 and German §20 Abs. 4 S. 1 EStG read it: openFeeC (each increase's fee at its own date, shared like
   * openFee), fundingInC and posFeeInC (each settlement at its own date, shared likewise), closeFeeC, grossC and the
   * notional legs (entryNotionalC, exitNotionalC) at the disposal date, netC, netAllC, proceedsC and costC (built the same
   * way, so proceedsC − costC = netC).
   */
  F.replay = function (p, fills, settle, o = {}) {
    const tz = o.tz || 'UTC', prod = o.prod || null, fx = o.fx || ((v) => v);
    const long = String(p.side) === '0', dir = long ? 1 : -1;
    const fAt = (settle && settle.funding) || new Map(), pAt = (settle && settle.fee) || new Map();
    const ticker = prod ? prod.displayTicker : p.productId, cls = F.classOf(prod);
    const used = new Set(), dates = new Set(), steps = [], rows = [];
    let q = 0, avg = 0, openFees = 0, carryF = 0, carryP = 0, k = 0, first = null, firstInc = null, lastInc = null;
    // the same three in the report currency, each amount at the rate of the date it was paid
    let openFeesC = 0, carryFC = 0, carryPC = 0;
    let incQ = 0, decQ = 0, incN = 0, realized = 0, maxDiff = 0, over = 0, nFills = 0;
    for (const f of fills) {
      k++;
      if (!(f.qty > 0)) continue;
      nFills++;
      // a settlement belongs to the first fill at its instant (two fills of one position can share a millisecond)
      let sf = 0, sp = 0;
      if (!used.has(f.t)) { used.add(f.t); sf = fAt.get(f.t) || 0; sp = pAt.get(f.t) || 0; }
      carryF += sf; carryP += sp; carryFC += fx(sf, f.t); carryPC += fx(sp, f.t);
      if (first == null) first = f.t;
      if (f.side === String(p.side)) {
        avg = (avg * q + f.price * f.qty) / (q + f.qty); q += f.qty; openFees += f.fee; openFeesC += fx(f.fee, f.t);
        incQ += f.qty; incN += f.price * f.qty; dates.add(TZ.dayKey(f.t, tz));
        if (firstInc == null) firstInc = f.t; lastInc = f.t;
      } else {
        // the exchange opens a new position rather than flipping one: a reduction beyond what is open is only reported
        if (f.qty > q + QEPS) over += f.qty - q;
        const qty = Math.min(f.qty, q);
        if (qty > EPS) {
          const rep = (f.price - avg) * qty * dir;
          const gross = f.pnl != null ? f.pnl : rep;
          if (f.pnl != null) maxDiff = Math.max(maxDiff, Math.abs(rep - f.pnl));
          const full = q - qty <= QEPS, share = full ? 1 : qty / q;
          const openFee = openFees * share, fIn = carryF * share, pIn = carryP * share;
          const openFeeC = openFeesC * share, fInC = carryFC * share, pInC = carryPC * share;
          openFees = full ? 0 : openFees - openFee; carryF = full ? 0 : carryF - fIn; carryP = full ? 0 : carryP - pIn;
          openFeesC = full ? 0 : openFeesC - openFeeC; carryFC = full ? 0 : carryFC - fInC; carryPC = full ? 0 : carryPC - pInC;
          const entryN = avg * qty, exitN = f.price * qty;
          const net = gross - openFee - f.fee;
          const proceeds = long ? entryN + openFee + net : entryN - openFee;
          const cost = long ? entryN + openFee : entryN - openFee - net;
          // the notional legs, the result and the closing fee at the disposal date; the opening-fee share at the dates paid
          const grossC = fx(gross, f.t), closeFeeC = fx(f.fee, f.t), entryNC = fx(entryN, f.t), exitNC = fx(exitN, f.t);
          const netC = grossC - openFeeC - closeFeeC;
          const proceedsC = long ? entryNC + openFeeC + netC : entryNC - openFeeC;
          const costC = long ? entryNC + openFeeC : entryNC - openFeeC - netC;
          q = full ? 0 : q - qty;
          rows.push({
            positionId: p.id, productId: p.productId, ticker, cls, long, n: k, t: f.t, qty, avgEntry: avg, exit: f.price, gross,
            openFee, closeFee: f.fee, fundingAt: sf, posFeeAt: sp, fundingIn: fIn, posFeeIn: pIn, net, netAll: net + fIn - pIn,
            entryNotional: entryN, exitNotional: exitN, proceeds, cost,
            grossC, openFeeC, closeFeeC, fundingInC: fInC, posFeeInC: pInC, netC, netAllC: netC + fInC - pInC, entryNotionalC: entryNC, exitNotionalC: exitNC, proceedsC, costC,
            opened: first, firstInc, lastInc,
            acquired: dates.size === 1 ? Array.from(dates)[0] : 'VARIOUS', longTerm: lastInc != null && TZ.heldOverYear(lastInc, f.t, tz),
            // Form 8949's Part: the same, with Rev. Rul. 66-7's month-end reading (TZ.heldOverYear)
            longTermUS: lastInc != null && TZ.heldOverYear(lastInc, f.t, tz, 'us'),
            partial: q > QEPS, liq: f.type === 'LIQUIDATION', adl: f.type === 'DELEVERAGE', type: f.type, src: f.src, fillId: f.id || null,
          });
          realized += gross; decQ += qty;
        }
      }
      steps.push({ t: f.t, q, avg });
    }
    // a position the exchange marks liquidated or deleveraged whose fills carry no such type: its final reduction is it
    const last = rows.length && q <= QEPS ? rows[rows.length - 1] : null;
    if (last && p.isLiquidated && !rows.some((r) => r.liq)) last.liq = true;
    if (last && p.wasDeleveraged && !rows.some((r) => r.adl)) last.adl = true;
    let unF = 0, unP = 0;
    for (const [t, v] of fAt) if (!used.has(t)) unF += v;
    for (const [t, v] of pAt) if (!used.has(t)) unP += v;
    // openFees: the fees of increases still open at the last fill (not yet part of any disposal)
    const check = { incQ, decQ, incNotional: incN, realized, maxDiff, over, fills: nFills, openFees, unattached: { funding: unF, fee: unP }, ok: null };
    if (o.complete) {
      const sizeNow = Math.abs(U.num(p.size));
      check.ok = Math.abs(incQ - U.num(p.totalIncreaseQuantity)) <= QEPS && Math.abs(decQ - U.num(p.totalDecreaseQuantity)) <= QEPS
        && Math.abs(incN - U.num(p.totalIncreaseNotional)) <= 1e-6 && Math.abs(realized - U.num(p.realizedPnl)) <= 1e-6 + 1e-9 * nFills
        && Math.abs(q - sizeNow) <= QEPS && over <= QEPS;
    }
    const at = (t) => { let lo = 0, hi = steps.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (steps[m].t <= t) { r = m; lo = m + 1; } else hi = m - 1; } return r < 0 ? null : steps[r]; };
    return {
      rows, check, first,
      sizeAt: (t) => { const s = at(t); return s ? s.q : 0; },
      avgAt: (t) => { const s = at(t); return s && s.q > QEPS ? s.avg : null; },
    };
  };

  /** The ledger segment (UTC day, or part of a split day) an instant's change lands in: the archive counts a change in
   *  the hour it happens and an hour in the part it starts in, so the lookup is by the hour's start. segments: ascending
   *  (T.ledger.build's days). Returns t → index or -1. */
  F.segmentOf = (segments) => {
    const t0 = segments.map((s) => s.t0);
    return (t) => {
      const h = Math.floor(t / HOUR) * HOUR;
      let lo = 0, hi = t0.length - 1, r = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (t0[m] <= h) { r = m; lo = m + 1; } else hi = m - 1; }
      return r >= 0 && h < segments[r].t1 ? r : -1;
    };
  };

  /**
   * Each ledger segment's realized PnL against its disposals (all rows, by the hour rule of F.segmentOf). Returns
   * {bad: [{seg, i, ledger, rows, diff}] (segments off by more than 1e-6), byHour (the rows' gross summed over the
   * period's segments)}.
   */
  F.dayCheck = (rows, segments) => {
    const at = F.segmentOf(segments), sum = new Float64Array(segments.length);
    let byHour = 0;
    for (const r of rows) { const i = at(r.t); if (i >= 0) { sum[i] += r.gross; byHour += r.gross; } }
    const bad = [];
    segments.forEach((s, i) => { const d = s.realizedPnl - sum[i]; if (Math.abs(d) > 1e-6) bad.push({ seg: s, i, ledger: s.realizedPnl, rows: sum[i], diff: d }); });
    return { bad, byHour };
  };

  /**
   * The period's disposals, settlements and checks from load.events' result (ev). ctx: {ledger (T.ledger.build), period,
   * ref, tz, fx(usd, t)}. Every position the period touches is replayed from its first fill, with the funding and
   * position fees settled at each of its fills. Returns {rows (all disposals of those positions, ascending), inP (the
   * period's, by exact instant), reps: Map(positionId → replay), failed (positions whose replay does not give the
   * exchange's totals), unchecked (positions that changed after the data ends), unassigned (fills in the period no
   * position holds), day (F.dayCheck), outside {usd, C, shift} (the ledger's realized PnL less the disposals': 0 when
   * everything reconciles; shift: what the hour a boundary cuts moves), funding {S (T.funding.settle), fig
   * (T.funding.figures), inP (settlements in the period by exact instant), chargedIn, unsettledEnd, byPos: Map(id →
   * {received, paid})}, fees {list, inP, unmatched, bad, byPos, mismatch (positions whose attributed fees differ from the
   * exchange's)}, openFeesEnd (opening fees still on positions open at the period end)}.
   */
  F.disposals = function (ev, ctx) {
    const FU = T.funding, P = ctx.period, tz = ctx.tz || P.tz, fx = ctx.fx || ((v) => v), ref = ctx.ref || {};
    const DAY = 86400000;
    const posById = new Map(ev.positions.map((p) => [p.id, p]));
    const asg = F.assign(ev.fills, ev.posFills, ev.positions);
    const closeOf = (pid) => { const p = posById.get(pid); return p && U.num(p.size) === 0 ? U.num(p.updatedAt) : null; };
    const S = ev.charges ? FU.settle(ev.charges, FU.fillTimes(asg.byPos), closeOf) : null;
    const buckets = FU.feeBuckets(T.ledger.residuals(ev.pre || [], ref, DAY, ev.resFrom), ev.pfHours, ref);
    const PF = FU.posFees(buckets, asg.byPos, ev.positions, ref);
    const fBy = S ? FU.byPosition(S.list) : new Map(), pBy = FU.byPosition(PF.list);
    const truncP = new Set((ev.truncated && ev.truncated.posFills) || []);
    const reps = new Map(), rows = [], failed = [], mismatch = [];
    let unchecked = 0, openFeesEnd = 0, openFeesEndC = 0;
    for (const p of ev.touched || ev.positions) {
      const fs = asg.byPos.get(p.id) || [];
      const complete = !(ev.truncated && ev.truncated.fills) && !truncP.has(p.id) && U.num(p.createdAt) >= ev.from && U.num(p.updatedAt) < ev.to;
      const r = F.replay(p, fs, { funding: fBy.get(p.id), fee: pBy.get(p.id) }, { prod: ref.byId ? ref.byId[p.productId] : null, tz, complete, fx });
      reps.set(p.id, r);
      if (r.check.ok === false) failed.push(p); else if (r.check.ok == null) unchecked++;
      if (complete && Math.abs((PF.byPos.get(p.id) || 0) - U.num(p.positionFeeAccruedUsd)) > 1e-6) mismatch.push(p);
      for (const x of r.rows) rows.push(x);
      // opening fees of increases not yet closed at the period end: paid, but not part of any disposal of the period (in
      // the report currency each at the date it was paid)
      let of = 0, ofC = 0, q = 0;
      for (const x of fs) { if (x.t >= P.end) break; if (x.side === String(p.side)) { of += x.fee; ofC += fx(x.fee, x.t); q += x.qty; } else if (q > 0) { const c = Math.min(x.qty, q); of -= of * c / q; ofC -= ofC * c / q; q -= c; } }
      if (q > QEPS) { openFeesEnd += of; openFeesEndC += ofC; }
    }
    rows.sort((a, b) => a.t - b.t || a.n - b.n);
    const inP = rows.filter((r) => r.t >= P.start && r.t < P.end);
    const day = F.dayCheck(rows, ctx.ledger.days);
    const unassigned = asg.unassigned.filter((f) => f.t >= P.start && f.t < P.end);
    let funding = null;
    if (S) {
      const byPos = new Map();
      for (const s of S.list) { let x = byPos.get(s.positionId); if (!x) byPos.set(s.positionId, (x = { received: 0, paid: 0 })); if (s.amount > 0) x.received += s.amount; else x.paid -= s.amount; }
      funding = { S, fig: FU.figures(S.list, ctx.ledger.days, fx), inP: S.list.filter((s) => s.t >= P.start && s.t < P.end), chargedIn: FU.chargedIn(S.charges, P.start, P.end, fx), unsettledEnd: FU.unsettledAt(S.charges, P.end), byPos };
    } else funding = { S: null, fig: FU.figures(null, ctx.ledger.days, fx), inP: [], chargedIn: null, unsettledEnd: null, byPos: new Map() };
    const fees = { list: PF.list, inP: PF.list.filter((s) => s.t >= P.start && s.t < P.end), unmatched: PF.unmatched.filter((b) => b.t1 > P.start && b.t0 < P.end), bad: FU.feeCheck(PF.list, ctx.ledger.days), byPos: PF.byPos, mismatch };
    // the ledger's figures in the report currency from these events, each at its own local date (T.ledger.recast applies
    // them to the page's ledger); the realized PnL outside the disposals is the ledger's less theirs on that same basis
    const fillFees = [];
    for (const fs of asg.byPos.values()) for (const f of fs) if (f.qty > 0 || f.fee) fillFees.push(f);
    for (const f of asg.unassigned) fillFees.push(f);
    const ledgerC = F.ledgerC(ctx.ledger.days, { rows, fills: fillFees, pfees: PF.list, fig: funding.fig, transfers: ev.hourTransfers || ev.transfers || [] }, fx);
    const sumInP = U.sum(inP, (r) => r.gross);
    const outside = { usd: ctx.ledger.totals.realized - sumInP, C: U.sum(ledgerC.segs, (s) => s.realizedPnl) - U.sum(inP, (r) => r.grossC), shift: sumInP - day.byHour };
    return { rows, inP, reps, byPos: asg.byPos, failed, unchecked, unassigned, day, outside, funding, fees, openFeesEnd, openFeesEndC, ledgerC };
  };

  const isDep = (t) => /DEPOSIT/.test(String(t.type || '').toUpperCase()), isWd = (t) => /WITHDRAW/.test(String(t.type || '').toUpperCase());
  /**
   * The ledger's report-currency figures from the events, each at the rate of its own local date (fx), per segment
   * (T.ledger.build's days, by the hour rule of F.segmentOf): realized PnL from the disposals (src.rows), trading fees
   * from the fills (src.fills: every fill piece, fees of fills that close nothing too), position fees from their
   * settlements (src.pfees, + = paid), funding from T.funding.figures (src.fig: received and paid apart, its own
   * fallback), deposits, withdrawals and their fees from the completed transfers (src.transfers). A segment whose events
   * of one kind do not add up to the ledger's (within 1e-6) converts that kind whole at its rate instant (tm: the local
   * date holding its middle), as T.ledger.build does, and is named in fallback; the traded volume, for information
   * only, always converts that way. Returns {segs: [{realizedPnl, fee, pfees, funding, deposit, withdrawal, wfee, volume,
   * net}], fallback: {realized, fee, pfees, funding, transfer} (segment indexes)}.
   */
  F.ledgerC = (segments, src, fx) => {
    const cv = fx || ((v) => v), at = F.segmentOf(segments), n = segments.length;
    const sum = () => ({ u: new Float64Array(n), c: new Float64Array(n) });
    const add = (o, t, v) => { const i = at(t); if (i < 0 || !v) return; o.u[i] += v; o.c[i] += cv(v, t) || 0; };
    const gross = sum(), fee = sum(), pf = sum(), dep = sum(), wd = sum(), wf = sum();
    for (const r of src.rows || []) add(gross, r.t, r.gross);
    for (const f of src.fills || []) add(fee, f.t, f.fee);
    for (const s of src.pfees || []) add(pf, s.t, s.amount);
    for (const x of src.transfers || []) {
      if (x.status && String(x.status).toUpperCase() !== 'COMPLETED') continue;
      const t = U.num(x.createdAt), amt = U.num(x.amount), fe = U.num(x.fee);
      // the ledger's withdrawal line holds withdrawals with their fee on top and the deposit fees; its fee line both fees
      if (isDep(x)) { add(dep, t, amt); add(wd, t, fe); add(wf, t, fe); } else if (isWd(x)) { add(wd, t, amt + fe); add(wf, t, fe); }
    }
    const fb = { realized: [], fee: [], pfees: [], funding: [], transfer: [] };
    const bySeg = src.fig ? src.fig.bySeg : null;
    const segs = segments.map((s, i) => {
      const whole = (v) => cv(v, s.tm) || 0;
      const pick = (o, ledger, key) => { if (Math.abs(o.u[i] - ledger) <= 1e-6) return o.c[i]; if (key) fb[key].push(i); return whole(ledger); };
      const realizedPnl = pick(gross, s.realizedPnl, 'realized'), feeC = pick(fee, s.fee, 'fee'), pfees = pick(pf, s.pfees, 'pfees');
      const b = bySeg ? bySeg[i] : null;
      if (!b || b.fallback) { if (Math.abs(s.funding) > 1e-9) fb.funding.push(i); }
      const funding = b ? b.rC - b.pC : whole(s.funding);
      // deposits, withdrawals and their fees together: either all from the transfers or all whole, so they stay one set
      const tOk = Math.abs(dep.u[i] - s.deposit) <= 1e-6 && Math.abs(wd.u[i] - s.withdrawal) <= 1e-6 && Math.abs(wf.u[i] - s.wfee) <= 1e-6;
      if (!tOk) fb.transfer.push(i);
      const deposit = tOk ? dep.c[i] : whole(s.deposit), withdrawal = tOk ? wd.c[i] : whole(s.withdrawal), wfee = tOk ? wf.c[i] : whole(s.wfee);
      return { realizedPnl, fee: feeC, pfees, funding, deposit, withdrawal, wfee, volume: whole(s.volume), net: realizedPnl - feeC - pfees + funding };
    });
    return { segs, fallback: fb };
  };

  const ADD = ['qty', 'gross', 'openFee', 'closeFee', 'fundingAt', 'posFeeAt', 'fundingIn', 'posFeeIn', 'net', 'netAll', 'entryNotional', 'exitNotional', 'proceeds', 'cost',
    'grossC', 'openFeeC', 'closeFeeC', 'fundingInC', 'posFeeInC', 'netC', 'netAllC', 'entryNotionalC', 'exitNotionalC', 'proceedsC', 'costC'];
  /** Disposal rows merged per position per local day: amounts summed, prices weighted by quantity, the last fill's time;
   *  fills: how many were merged. */
  F.byPositionDay = (rows, tz) => {
    const m = new Map();
    for (const r of rows) {
      const k = r.positionId + '|' + TZ.dayKey(r.t, tz);
      const x = m.get(k);
      if (!x) { m.set(k, Object.assign({}, r, { fills: 1, first: r.t })); continue; }
      for (const a of ADD) x[a] += r[a];
      x.fills++; x.t = r.t; x.n = r.n; x.partial = r.partial; x.liq = x.liq || r.liq; x.adl = x.adl || r.adl; x.longTerm = x.longTerm && r.longTerm; x.longTermUS = x.longTermUS && r.longTermUS;
      if (x.acquired !== r.acquired) x.acquired = 'VARIOUS';
      x.lastInc = r.lastInc;
    }
    const out = Array.from(m.values());
    for (const x of out) { x.avgEntry = x.qty ? x.entryNotional / x.qty : 0; x.exit = x.qty ? x.exitNotional / x.qty : 0; }
    return out.sort((a, b) => a.t - b.t);
  };
})();
