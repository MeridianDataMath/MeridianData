/* MeridianDataHub — Tax center perps ledger: the exchange's archive (per UTC day, running totals per margin pool) cut at
   the period's local boundaries. Whole UTC days come from the daily rows; a UTC day that a boundary cuts is split hour
   by hour from the hourly rows. Pure: no DOM, no network. */
(function () {
  const MD = window.MD; const U = MD.util; const T = MD.tax;
  const L = (T.ledger = {});
  const DAY = 86400000, HOUR = 3600000, EPS = 1e-6;
  // every flow the archive's balance rows carry, as running totals per token (outflows negative), as in AN.buildSeries
  const FLOWS = ['realizedPnl', 'tradingFee', 'realizedFunding', 'deposit', 'withdrawal', 'withdrawalFee', 'depositFee', 'conversionIn', 'conversionOut'];
  const KEYS = ['realizedPnl', 'fee', 'funding', 'deposit', 'withdrawal', 'wfee', 'conv', 'residual'];
  const tokOf = (r) => r.tokenId || r.tokenAddress || 'x';
  const hm = (t) => new Date(t).toISOString().slice(11, 16);

  /** Margin pools of mPerp markets: tokens that cannot be deposited and are some product's quote token (XAUUSD, SPYUSD, …). */
  L.mPerpPools = (ref) => {
    const out = new Set(); if (!ref) return out;
    const quotes = new Set(Object.values(ref.byId || {}).map((p) => String(p.quoteTokenAddress || '').toLowerCase()).filter(Boolean));
    for (const t of Object.values(ref.tokenById || {})) if (!t.depositEnabled && quotes.has(String(t.address || '').toLowerCase())) out.add(t.id);
    return out;
  };

  /** One bucket of one pool against the one before it (null: the pool's first): flows with the trader's signs, the end
   *  level, and the residual, the balance change no flow explains (rounded to the archive's 9 decimals, so float noise on
   *  a large balance is not a fee). */
  const delta = (r, prev) => {
    const d = (k) => U.num(r[k]) - (prev ? U.num(prev[k]) : 0);
    const flows = FLOWS.reduce((a, k) => a + d(k), 0);
    return {
      realizedPnl: d('realizedPnl'), fee: -d('tradingFee'), funding: d('realizedFunding'), deposit: d('deposit'),
      withdrawal: -d('withdrawal') - d('withdrawalFee') - d('depositFee'), wfee: -d('withdrawalFee') - d('depositFee'),
      conv: d('conversionIn') + d('conversionOut'),
      residual: -Math.round((d('balance') - flows) * 1e9) / 1e9,
      level: U.num(r.balance),
    };
  };
  const addInto = (acc, d) => { for (const k of KEYS) acc[k] += d[k]; acc.level = d.level; return acc; };
  const zero = () => ({ realizedPnl: 0, fee: 0, funding: 0, deposit: 0, withdrawal: 0, wfee: 0, conv: 0, residual: 0, level: null });
  const quiet = (toks, vol) => Math.abs(vol) <= EPS && Array.from(toks.values()).every((d) => KEYS.every((k) => Math.abs(d[k]) <= EPS));

  /** The days among `days` (UTC day starts) on which no pool changed and nothing traded, from the daily rows: a split
   *  day like that needs no hourly read (before an account existed, or a quiet day). */
  L.quietDays = (balance, volume, days) => {
    const want = new Set(days), toks = new Map(), vol = new Map();
    for (const r of volume) { const t = U.num(r.time); if (want.has(t)) vol.set(t, (vol.get(t) || 0) + U.num(r.volumeUsd)); }
    for (const rows of Object.values(U.groupBy(balance, tokOf))) {
      rows.sort((a, b) => U.num(a.time) - U.num(b.time));
      let prev = null;
      for (const r of rows) { const t = U.num(r.time); if (want.has(t)) { let m = toks.get(t); if (!m) toks.set(t, (m = new Map())); m.set(tokOf(r), delta(r, prev)); } prev = r; }
    }
    return days.filter((d) => quiet(toks.get(d) || new Map(), vol.get(d) || 0));
  };

  /** The mPerp pools' residuals (the position fees the exchange settled) per archive bucket: [{t0, t1, tokenId, amount
   *  (+ = paid)}], from balance rows of one resolution (ms: the bucket length). Rows before `from` are only the starting
   *  point of each pool; a pool's first row with nothing before it counts from zero (a new account). */
  L.residuals = (rows, ref, ms, from) => {
    const mp = L.mPerpPools(ref), out = [];
    for (const [tok, list] of Object.entries(U.groupBy(rows || [], tokOf))) {
      if (!mp.has(tok)) continue;
      list.sort((a, b) => U.num(a.time) - U.num(b.time));
      let prev = null;
      for (const r of list) {
        const t = U.num(r.time);
        if (from != null && t < from) { prev = r; continue; }
        const d = delta(r, prev); prev = r;
        if (Math.abs(d.residual) > 1e-9) out.push({ t0: t, t1: t + ms, tokenId: tok, amount: d.residual });
      }
    }
    return out.sort((a, b) => a.t0 - b.t0);
  };

  /** Split UTC day D at the boundaries inside it, from its hourly rows (balance from the hour before D, volume). An hour
   *  counts in the part it starts in, so a boundary at :30 or :45 (India, Adelaide, Newfoundland) leaves the hour across
   *  it on the earlier side. Null when the hours do not add up to the day's own row, pool by pool (a missing or late
   *  hour): the caller then keeps the day whole. */
  L.splitDay = function (D, dayToks, dayVol, H, cuts, P) {
    const inner = cuts.filter((c) => c > D && c < D + DAY);
    const edges = [D].concat(inner, [D + DAY]);
    const parts = edges.slice(0, -1).map((t0, i) => ({ t0, t1: edges[i + 1], day: D, part: hm(t0) + '–' + (edges[i + 1] === D + DAY ? '24:00' : hm(edges[i + 1])), inP: t0 >= P.start && t0 < P.end, toks: new Map(), volume: 0 }));
    if (quiet(dayToks, dayVol)) return parts;   // nothing moved that day: nothing to split, the hours are not needed
    if (!H || !Array.isArray(H.balance) || !Array.isArray(H.volume)) return null;
    const partOf = (t) => { let i = 0; while (i < inner.length && inner[i] <= t) i++; return parts[i]; };
    const sums = new Map();
    for (const [tok, rows] of Object.entries(U.groupBy(H.balance.filter((r) => U.num(r.time) >= D - HOUR && U.num(r.time) < D + DAY), tokOf))) {
      rows.sort((a, b) => U.num(a.time) - U.num(b.time));
      let prev = null;
      for (const r of rows) {
        const t = U.num(r.time);
        if (t < D) { prev = r; continue; }   // the hour before the day is only the starting point
        const d = delta(r, prev); prev = r;
        const p = partOf(t);
        addInto(p.toks.get(tok) || (p.toks.set(tok, zero()), p.toks.get(tok)), d);
        addInto(sums.get(tok) || (sums.set(tok, zero()), sums.get(tok)), d);
      }
    }
    for (const tok of new Set([...dayToks.keys(), ...sums.keys()])) {
      const a = dayToks.get(tok) || zero(), b = sums.get(tok) || zero();
      if (KEYS.some((k) => Math.abs(a[k] - b[k]) > EPS)) return null;
      if (a.level != null && b.level != null && Math.abs(a.level - b.level) > EPS) return null;
    }
    let vol = 0;
    for (const r of H.volume) { const t = U.num(r.time); if (t < D || t >= D + DAY) continue; const v = U.num(r.volumeUsd); partOf(t).volume += v; vol += v; }
    if (Math.abs(vol - dayVol) > EPS) return null;
    return parts;
  };

  // funding received and paid are not summed here: a segment's funding is already netted, so its sign says nothing about
  // the settlements; the legs come from T.funding.figures, per settlement
  const blank = () => ({ realized: 0, fees: 0, pfees: 0, funding: 0, deposits: 0, withdrawals: 0, wfee: 0, volume: 0, net: 0 });
  const addOne = (o, x) => {
    o.realized += x.realizedPnl; o.fees += x.fee; o.pfees += x.pfees; o.funding += x.funding; o.deposits += x.deposit; o.withdrawals += x.withdrawal;
    o.wfee += x.wfee; o.volume += x.volume; o.net += x.net;
  };
  const addSeg = (acc, s) => { addOne(acc, s); addOne(acc.C, s.C); acc.days++; return acc; };

  /**
   * The period's ledger. balance / volume: daily archive rows from the day before the period; hour: Map(UTC day →
   * {balance, volume}) of hourly rows for the split days (T.periods.splitDays); ref: products and tokens (A.ref), for the
   * mPerp pools; period: T.periods.resolve(…); fx(usd, t): the report currency (identity when left out).
   * Returns {segments (= days), totals, months, quarters, opening, closing, levels {opening, closing} ({tokenId: level}:
   * each pool at the two instants; opening and closing are their sums), recon, pools, poolDiffs, pfDays, fallbackDays,
   * splitDays, straddle}. A segment is one UTC day, or one part of a split day: {t0, t1, day, part ('HH:MM–HH:MM' UTC, null
   * for a whole day), fallback, realizedPnl, fee, pfees, funding, deposit, withdrawal, wfee, volume, net, balance (level at
   * its end), tm (the instant its currency rate is read at: its middle, on the local date that holds most of it), C}.
   * mPerp position fees (pfees) are the residual of the mPerp pools only: the exchange books them into the balance when it
   * settles them, at a fill that increases, reduces or closes the position, and the archive has no field for them. The
   * USD pool's residual stays a real check (poolDiffs) instead of being booked as a fee.
   */
  L.build = function ({ balance = [], volume = [], hour = null, ref = null, period, fx = null }) {
    const PER = T.periods; const P = period;
    const conv = fx || ((usd) => usd);
    const mp = L.mPerpPools(ref);
    const months = PER.months(P).map((m) => Object.assign(m, blank(), { C: blank(), days: 0 }));
    const quarters = PER.quarters(P).map((q) => Object.assign(q, blank(), { C: blank(), days: 0 }));
    const bucket = PER.bucketer(P, months, quarters);
    const cuts = PER.boundaries(P);
    const splitDays = PER.splitDays(P), splits = new Set(splitDays);

    // per UTC day and pool: the change since the pool's previous row; rows at or after the end are not the period's
    // (the archive's endTime is inclusive)
    const perDay = new Map();
    for (const rows of Object.values(U.groupBy(balance.filter((r) => U.num(r.time) < P.end), tokOf))) {
      rows.sort((a, b) => U.num(a.time) - U.num(b.time));
      let prev = null;
      for (const r of rows) { const t = U.num(r.time); let m = perDay.get(t); if (!m) perDay.set(t, (m = new Map())); m.set(tokOf(r), delta(r, prev)); prev = r; }
    }
    const volDay = new Map();
    for (const r of volume) { const t = U.num(r.time); if (t < P.end) volDay.set(t, (volDay.get(t) || 0) + U.num(r.volumeUsd)); }

    const pieces = [], fallbackDays = [];
    for (const D of Array.from(new Set([...perDay.keys(), ...volDay.keys()])).sort((a, b) => a - b)) {
      const toks = perDay.get(D) || new Map(), vol = volDay.get(D) || 0;
      if (!splits.has(D)) { pieces.push({ t0: D, t1: D + DAY, tb: D, day: D, part: null, inP: D >= P.start && D < P.end, toks, volume: vol }); continue; }
      const parts = L.splitDay(D, toks, vol, hour && hour.get ? hour.get(D) : null, cuts, P);
      if (parts) { for (const p of parts) pieces.push(Object.assign(p, { tb: p.t0 })); continue; }
      // the hours could not be read or do not add up: the whole day goes to the side holding most of it, flagged
      const mid = D + DAY / 2;
      fallbackDays.push(D);
      pieces.push({ t0: D, t1: D + DAY, tb: mid, day: D, part: null, fallback: true, inP: mid >= P.start && mid < P.end, toks, volume: vol });
    }
    pieces.sort((a, b) => a.t0 - b.t0);

    // walk the pieces in time order, keeping each pool's level: the opening balance is the level before the first piece
    // in the period, the closing one the level after its last, so opening + flows = closing holds by construction
    const level = new Map(); const sumLevel = () => U.sum(Array.from(level.values()));
    const pools = {}, segments = [];
    let opening = null, closing = null, preStart = 0, openLv = null, closeLv = null, preLv = {};
    const totals = Object.assign(blank(), { C: blank(), days: 0 });
    for (const p of pieces) {
      if (p.inP && opening == null) { opening = sumLevel(); openLv = Object.fromEntries(level); }
      const s = { t0: p.t0, t1: p.t1, day: p.day, part: p.part, fallback: !!p.fallback, realizedPnl: 0, fee: 0, pfees: 0, funding: 0, deposit: 0, withdrawal: 0, wfee: 0, conv: 0, unexplained: 0, volume: p.volume };
      for (const [tok, d] of p.toks) {
        if (d.level != null) level.set(tok, d.level);
        if (!p.inP) continue;
        s.realizedPnl += d.realizedPnl; s.fee += d.fee; s.funding += d.funding; s.deposit += d.deposit; s.withdrawal += d.withdrawal; s.wfee += d.wfee; s.conv += d.conv;
        const isM = mp.has(tok);
        if (isM) s.pfees += d.residual; else s.unexplained += d.residual;
        const t = ref && ref.tokenById ? ref.tokenById[tok] : null;
        const pool = pools[tok] || (pools[tok] = { tokenId: tok, name: t ? t.name : String(tok).slice(0, 8), mPerp: isM, residual: 0, realizedPnl: 0, fee: 0, funding: 0 });
        pool.residual += d.residual; pool.realizedPnl += d.realizedPnl; pool.fee += d.fee; pool.funding += d.funding;
      }
      if (!p.inP) { if (p.t0 < P.start) { preStart = sumLevel(); preLv = Object.fromEntries(level); } continue; }
      s.net = s.realizedPnl - s.fee - s.pfees + s.funding;
      s.balance = closing = sumLevel(); closeLv = Object.fromEntries(level);
      s.tm = Math.floor((p.t0 + p.t1) / 2);
      s.C = { realizedPnl: conv(s.realizedPnl, s.tm), fee: conv(s.fee, s.tm), pfees: conv(s.pfees, s.tm), funding: conv(s.funding, s.tm), deposit: conv(s.deposit, s.tm), withdrawal: conv(s.withdrawal, s.tm), wfee: conv(s.wfee, s.tm), volume: conv(s.volume, s.tm), net: conv(s.net, s.tm) };
      const b = bucket(Math.min(Math.max(p.tb, P.start), P.end - 1));
      s.mi = b.mi; s.qi = b.qi;   // its month and quarter, for L.recast
      if (b.mi >= 0) addSeg(months[b.mi], s);
      if (b.qi >= 0) addSeg(quarters[b.qi], s);
      addSeg(totals, s);
      segments.push(s);
    }
    if (opening == null) opening = closing = preStart;
    // each pool's level at the two instants (holdings at the period's start and end), as the walk had them there: the
    // part of a split day after the end (or a day kept whole on the far side) moves the levels past the period's end
    const expected = opening + totals.deposits - totals.withdrawals + totals.net;
    const poolList = Object.values(pools);
    return {
      segments, days: segments, totals, months, quarters, opening, closing,
      levels: { opening: openLv || preLv, closing: closeLv || preLv },
      recon: { expected, diff: closing - expected },
      pools: poolList,
      // the exchange changed a non-mPerp pool without any ledger entry: left out of every figure and named (diff = the
      // balance change less the recorded flows); mPerp pools are 0 here by construction, their residual is the position fee
      poolDiffs: poolList.filter((x) => !x.mPerp && Math.abs(x.residual) >= 0.005).map((x) => ({ pool: x.name, tokenId: x.tokenId, diff: -x.residual })),
      // an mPerp residual that is a credit, or that came with no fill at all, is booked as a position fee but may be another
      // adjustment: the page names those days
      pfDays: segments.filter((s) => s.pfees < -0.005 || (Math.abs(s.pfees) >= 0.005 && !s.volume)).map((s) => ({ seg: s, pfees: s.pfees, reason: s.pfees < 0 ? 'credit' : 'no-volume' })),
      fallbackDays, splitDays,
      straddle: cuts.filter((c) => c % HOUR !== 0),   // boundaries inside an hour: that hour counts in the period it starts in
      basisC: { events: false, fallback: null },   // the report currency per segment, until L.recast
    };
  };

  /**
   * The report-currency figures recast from the events (T.fills.ledgerC: each fill, settlement and transfer at the rate
   * of its own local date; a segment whose events of one kind do not add up to the ledger's stays converted whole at its
   * middle's date): each segment's C, then the totals, months and quarters summed from them again, in place, so every
   * figure that reads the ledger (tiles, by type, monthly, quarterly, summary, the change in equity) agrees with the
   * disposals and settlements in the same file. The USD figures are untouched. Sets led.basisC to {events: true,
   * fallback} (T.fills.ledgerC's segment indexes per kind).
   */
  L.recast = (led, conv) => {
    if (!led || !conv || !conv.segs || conv.segs.length !== led.segments.length) return led;
    const zeroC = (o) => { for (const k of Object.keys(o.C)) o.C[k] = 0; };
    zeroC(led.totals); led.months.forEach(zeroC); led.quarters.forEach(zeroC);
    led.segments.forEach((s, i) => {
      const c = conv.segs[i];
      s.C = { realizedPnl: c.realizedPnl, fee: c.fee, pfees: c.pfees, funding: c.funding, deposit: c.deposit, withdrawal: c.withdrawal, wfee: c.wfee, volume: c.volume, net: c.net };
      addOne(led.totals.C, s.C);
      if (s.mi >= 0) addOne(led.months[s.mi].C, s.C);
      if (s.qi >= 0) addOne(led.quarters[s.qi].C, s.C);
    });
    led.basisC = { events: true, fallback: conv.fallback };
    return led;
  };

  /** The report-currency basis of the ledger's figures in words, for the Rate rule (the page's methodology): from the
   *  events once L.recast ran, the UTC days still converted whole named; otherwise every UTC day whole. */
  L.basisText = (led) => {
    const day = (s) => new Date(s.day).toISOString().slice(0, 10) + (s.part ? ' ' + s.part + ' UTC' : '');
    if (!led) return '';
    if (!led.basisC || !led.basisC.events) return 'perps ledger totals (realized PnL, fees, funding, transfers, by month and quarter): the trade detail is not loaded, so each UTC day (or part of a day a boundary cuts) converts whole at the rate of the local date holding its middle';
    const fb = led.basisC.fallback || {}, words = { realized: 'realized PnL', fee: 'trading fees', pfees: 'position fees', funding: 'funding', transfer: 'deposits and withdrawals' };
    const list = (ix) => ix.slice(0, 8).map((i) => day(led.segments[i])).join(', ') + (ix.length > 8 ? ` and ${ix.length - 8} more` : '');
    const parts = Object.keys(words).filter((k) => fb[k] && fb[k].length).map((k) => words[k] + ' on ' + list(fb[k]));
    return 'perps ledger totals (realized PnL, fees, funding, transfers, by month and quarter): each fill, settlement and transfer at the rate of its own local date, the same amounts as the disposals and the settlements; '
      + (parts.length ? 'where the per-event detail does not add up to the exchange\'s ledger the UTC day converts whole at the rate of the local date holding its middle: ' + parts.join('; ') : 'every UTC day\'s detail adds up to the ledger, so no day converts whole')
      + '; the traded volume (for information) converts each UTC day whole at the rate of the local date holding its middle, and the daily ledger file gives each UTC day\'s net both ways';
  };
})();
