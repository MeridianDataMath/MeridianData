/* MeridianDataHub — Tax center funding and position fees, per position and per settlement. Meridian charges funding every
   hour but moves it into the balance only at a fill of the position (an increase, a reduction or the close): each
   hourly charge settles at the position's first fill at or after it (checked hour by hour against the archive on every
   account tried). mPerp position fees settle the same way; the archive has no field for them, so each bucket's residual
   in an mPerp pool goes to that pool's fills in the bucket, by notional. Received and paid are kept apart, per
   settlement, never netted across positions or days. Pure: no DOM, no network. */
(function () {
  const MD = window.MD; const U = MD.util; const T = MD.tax;
  const FU = (T.funding = {});
  const EPS = 1e-6, DAY = 86400000;
  // first index with a[i] >= t
  const lb = (a, t) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < t) lo = m + 1; else hi = m; } return lo; };

  /** Ascending fill instants per position (F.assign's byPos). */
  FU.fillTimes = (byPos) => { const m = new Map(); for (const [pid, fs] of byPos) m.set(pid, Array.from(new Set(fs.filter((f) => f.qty > 0).map((f) => f.t))).sort((a, b) => a - b)); return m; };

  /**
   * Settles each hourly charge. charges: the archive's rows ({positionId, productId, time, fundingCharge: + = paid});
   * fillTimes: Map(positionId → ascending fill instants); closeOf(positionId): the close instant of a closed position
   * (its updatedAt), else null. A charge settles at the position's first fill at or after it, or, when no loaded fill
   * comes after it, at the close; one of an open position stays unsettled. Returns {list: settlements ascending
   * [{positionId, productId, t, amount (+ = received), from, to, n (charges)}], charges: [{positionId, productId, t,
   * amount, settleT (null: not settled in the data)}]}.
   */
  FU.settle = function (charges, fillTimes, closeOf) {
    const agg = new Map(), out = [];
    for (const c of charges || []) {
      const pid = c.positionId, t = U.num(c.time), amount = -U.num(c.fundingCharge);
      const ft = fillTimes.get(pid) || [];
      const i = lb(ft, t);
      let s = i < ft.length ? ft[i] : null;
      if (s == null) { const cl = closeOf ? closeOf(pid) : null; if (cl != null && cl >= t) s = cl; }
      out.push({ positionId: pid, productId: c.productId || null, t, amount, settleT: s });
      if (s == null) continue;
      const k = pid + '|' + s;
      let x = agg.get(k);
      if (!x) agg.set(k, (x = { positionId: pid, productId: c.productId || null, t: s, amount: 0, from: t, to: t, n: 0 }));
      x.amount += amount; x.n++; if (t < x.from) x.from = t; if (t > x.to) x.to = t;
    }
    return { list: Array.from(agg.values()).sort((a, b) => a.t - b.t), charges: out };
  };

  /** Settlements in [a, b) split into received (net positive ones) and paid (net negative ones, as a positive number). */
  FU.legs = (list, a, b) => {
    let received = 0, paid = 0, n = 0;
    for (const s of list) if (s.t >= a && s.t < b) { n++; if (s.amount > 0) received += s.amount; else paid -= s.amount; }
    return { received, paid, net: received - paid, n };
  };

  /** Per position: {pid → Map(t → amount)} for F.replay's settle maps. */
  FU.byPosition = (list) => { const m = new Map(); for (const s of list) { let x = m.get(s.positionId); if (!x) m.set(s.positionId, (x = new Map())); x.set(s.t, (x.get(s.t) || 0) + s.amount); } return m; };

  /**
   * Checks each ledger segment's settled funding (the archive's realizedFunding) against the settlements that land in
   * it (by the hour rule of F.segmentOf), and builds the period's figures. A segment that does not match within 1e-6
   * (truncated fills, charges older than the archive keeps, a partial liquidation) falls back to its own net, received
   * or paid by its sign. fx(usd, t): the report currency, each settlement at its own date and a fallback segment at its
   * rate instant (tm). Returns {received, paid, net, C: {received, paid}, bySeg: [{received, paid, fallback}],
   * fallback: [segments]}.
   */
  FU.figures = (list, segments, fx) => {
    const conv = fx || ((v) => v);
    const at = T.fills.segmentOf(segments);
    const bySeg = segments.map(() => ({ received: 0, paid: 0, rC: 0, pC: 0, sum: 0, fallback: false }));
    for (const s of list || []) {
      const i = at(s.t); if (i < 0) continue;
      const b = bySeg[i]; b.sum += s.amount;
      if (s.amount > 0) { b.received += s.amount; b.rC += conv(s.amount, s.t); } else { b.paid -= s.amount; b.pC -= conv(s.amount, s.t); }
    }
    const out = { received: 0, paid: 0, net: 0, C: { received: 0, paid: 0 }, bySeg, fallback: [] };
    segments.forEach((seg, i) => {
      const b = bySeg[i];
      // without any charges every day with funding is netted; a day without funding has nothing to net
      if (!list ? Math.abs(seg.funding) > 1e-9 : Math.abs(b.sum - seg.funding) > EPS) {
        b.fallback = true; out.fallback.push(seg);
        b.received = seg.funding > 0 ? seg.funding : 0; b.paid = seg.funding < 0 ? -seg.funding : 0;
        b.rC = b.received ? conv(b.received, seg.tm) : 0; b.pC = b.paid ? conv(b.paid, seg.tm) : 0;
      }
      out.received += b.received; out.paid += b.paid; out.C.received += b.rC; out.C.paid += b.pC;
    });
    out.net = out.received - out.paid;
    return out;
  };

  /** Charged before T and not settled by T (settled at or after it, or not at all in the data), per position:
   *  {received, paid, net, byPos: Map(positionId → {amount, from, to, n})}; a position's charges settle as one amount, so
   *  each position counts as received or paid by its net. */
  FU.unsettledAt = (charges, T0) => {
    const byPos = new Map();
    for (const c of charges || []) {
      if (!(c.t < T0) || (c.settleT != null && c.settleT < T0)) continue;
      let x = byPos.get(c.positionId);
      if (!x) byPos.set(c.positionId, (x = { positionId: c.positionId, productId: c.productId, amount: 0, from: c.t, to: c.t, n: 0 }));
      x.amount += c.amount; x.n++; if (c.t < x.from) x.from = c.t; if (c.t > x.to) x.to = c.t;
    }
    let received = 0, paid = 0;
    for (const x of byPos.values()) if (x.amount > 0) received += x.amount; else paid -= x.amount;
    return { received, paid, net: received - paid, byPos };
  };

  /** Funding charged in [a, b) (each hourly charge by its sign), and the part of it settled at or after b (or not yet).
   *  fx(usd, t): the report currency, each charge at its own date (C: {received, paid, net, after}). */
  FU.chargedIn = (charges, a, b, fx) => {
    const conv = fx || ((v) => v);
    const o = { received: 0, paid: 0, net: 0, n: 0, after: { received: 0, paid: 0, net: 0, n: 0 }, C: { received: 0, paid: 0, net: 0, after: 0 } };
    for (const c of charges || []) {
      if (c.t < a || c.t >= b) continue;
      const v = conv(c.amount, c.t);
      o.n++; if (c.amount > 0) { o.received += c.amount; o.C.received += v; } else { o.paid -= c.amount; o.C.paid -= v; }
      if (c.settleT == null || c.settleT >= b) { o.after.n++; o.C.after += v; if (c.amount > 0) o.after.received += c.amount; else o.after.paid -= c.amount; }
    }
    o.net = o.received - o.paid; o.after.net = o.after.received - o.after.paid; o.C.net = o.C.received - o.C.paid;
    return o;
  };

  // ---------- mPerp position fees ----------
  /** productId → the mPerp pool (token id) its margin sits in. */
  FU.poolOf = (ref) => {
    const mp = T.ledger.mPerpPools(ref), byAddr = {}, out = new Map();
    for (const t of Object.values((ref && ref.tokenById) || {})) if (mp.has(t.id)) byAddr[String(t.address || '').toLowerCase()] = t.id;
    for (const p of Object.values((ref && ref.byId) || {})) { const tok = byAddr[String(p.quoteTokenAddress || '').toLowerCase()]; if (tok) out.set(p.id, tok); }
    return out;
  };
  /** Fills of each mPerp pool, ascending: Map(tokenId → [{t, positionId, productId, notional}]). */
  const poolFills = (byPos, positions, ref) => {
    const poolOf = FU.poolOf(ref), out = new Map();
    for (const p of positions) {
      const tok = poolOf.get(p.productId); if (!tok) continue;
      let l = out.get(tok); if (!l) out.set(tok, (l = []));
      for (const f of byPos.get(p.id) || []) if (f.qty > 0) l.push({ t: f.t, positionId: p.id, productId: p.productId, notional: f.qty * f.price });
    }
    for (const l of out.values()) { l.sort((a, b) => a.t - b.t); l.ts = l.map((x) => x.t); }
    return out;
  };
  const inBucket = (l, t0, t1) => { const out = []; if (!l.ts) return out; for (let i = lb(l.ts, t0); i < l.length && l[i].t < t1; i++) out.push(l[i]); return out; };

  /** The UTC days among day buckets on which two or more positions of the pool were filled: their hours are needed to
   *  tell the positions' fees apart (load.events reads them). */
  FU.feeDays = (dayBuckets, byPos, positions, ref) => {
    const pf = poolFills(byPos, positions, ref), out = new Set();
    for (const b of dayBuckets) { const fs = inBucket(pf.get(b.tokenId) || [], b.t0, b.t1); if (new Set(fs.map((f) => f.positionId)).size >= 2) out.add(b.t0); }
    return Array.from(out).sort((a, b) => a - b);
  };

  /** Day buckets, with each day in `hours` (Map(day → hourly balance rows from the hour before it)) replaced by its
   *  hourly buckets when they add up to the day's residual pool by pool (otherwise the day stays whole). */
  FU.feeBuckets = (dayBuckets, hours, ref) => {
    const out = [];
    for (const b of dayBuckets) {
      const rows = hours && hours.get ? hours.get(b.t0) : null;
      if (!rows) { out.push(b); continue; }
      const hs = T.ledger.residuals(rows, ref, 3600000, b.t0).filter((x) => x.tokenId === b.tokenId && x.t0 < b.t0 + DAY);
      if (Math.abs(U.sum(hs, (x) => x.amount) - b.amount) > EPS) out.push(b); else out.push(...hs);
    }
    return out.sort((a, b) => a.t0 - b.t0);
  };

  /**
   * Position fees per position and fill. buckets: FU.feeBuckets; byPos: F.assign's map. Each bucket's amount goes to the
   * pool's fills inside it, split by notional (a bucket with one position's fills is that position's). Returns {list:
   * [{positionId, productId, t, amount (+ = paid)}] ascending, unmatched: [buckets with no fill], byPos: Map(positionId
   * → total)}.
   */
  FU.posFees = (buckets, byPos, positions, ref) => {
    const pf = poolFills(byPos, positions, ref), agg = new Map(), unmatched = [], tot = new Map();
    for (const b of buckets) {
      const fs = inBucket(pf.get(b.tokenId) || [], b.t0, b.t1);
      if (!fs.length) { unmatched.push(b); continue; }
      const N = U.sum(fs, (f) => f.notional);
      for (const f of fs) {
        const v = N > 0 ? b.amount * f.notional / N : b.amount / fs.length;
        const k = f.positionId + '|' + f.t;
        let x = agg.get(k); if (!x) agg.set(k, (x = { positionId: f.positionId, productId: f.productId, t: f.t, amount: 0 }));
        x.amount += v; tot.set(f.positionId, (tot.get(f.positionId) || 0) + v);
      }
    }
    return { list: Array.from(agg.values()).sort((a, b) => a.t - b.t), unmatched, byPos: tot };
  };

  /** Each ledger segment's position fees (the mPerp residual) against the attributed settlements in it: the segments
   *  off by more than 1e-6. */
  FU.feeCheck = (list, segments) => {
    const at = T.fills.segmentOf(segments), sum = new Float64Array(segments.length);
    for (const s of list || []) { const i = at(s.t); if (i >= 0) sum[i] += s.amount; }
    const bad = [];
    segments.forEach((seg, i) => { if (Math.abs(seg.pfees - sum[i]) > EPS) bad.push({ seg, i, ledger: seg.pfees, fills: sum[i], diff: seg.pfees - sum[i] }); });
    return bad;
  };
})();
