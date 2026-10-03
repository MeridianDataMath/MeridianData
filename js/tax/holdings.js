/* MeridianDataHub — Tax center holdings at an instant: what the wallet held at the period's start and at its end (now,
   for a period still running), for rules that ask for values at a date (a wealth or box-3 return, a year-end value).
   Perps, per margin pool: the cash balance (the archive's level, the one the balance reconciliation uses), the
   unrealized PnL (the archive's figure: price only), the funding charged and not yet settled, equity both ways, and the
   positions open (size and average entry from the fills' replay). Meridian Predict at cost (T.predict.holdingsAt), and
   the USDe lots once they are built. Each value in USD and in the report currency at the rate of the local day before
   the instant. Records, not advice: none of these values is in any total of the report. Pure: no DOM, no network (the
   card is view-holdings; the archive's unrealized PnL is read by T.load.upnl). */
(function () {
  const MD = window.MD; const U = MD.util; const T = MD.tax; const TZ = T.tz;
  const HO = (T.holdings = {});
  const DAY = 86400000, HOUR = 3600000, QEPS = 1e-8, EPS = 1e-9;
  const LIVE = 2 * 60000;   // an instant this close to now reads the archive's newest bucket
  const tokOf = (r) => r.tokenId || r.tokenAddress || 'x';

  // ---------- the instants ----------
  /** The period's start and its end, or now for a period still running: [{key, t, now, label, lotsT (the instant the
   *  USDe lots snapshot their pools at: the period's own end)}]. */
  HO.instants = (P, now) => {
    const n = now != null ? now : P.now != null ? P.now : Date.now();
    const cur = P.end >= n;
    return [
      { key: 'start', t: P.start, now: P.start >= n - LIVE, label: 'Period start', lotsT: P.start },
      { key: 'end', t: cur ? n : P.end, now: cur, label: cur ? 'Now' : 'Period end', lotsT: P.end },
    ];
  };

  /**
   * The archive bucket whose end-of-bucket figures are the levels at instant t: {res, rowT (the bucket's time: the archive
   * files a bucket's end level under its start), at (the instant they are as of), now}. A UTC midnight reads the day
   * before it (day1); any other instant the hour it falls in, rounded up as the ledger rounds a boundary inside an hour
   * (an hour counts in the period it starts in; hour1); an instant within two minutes of now, or later, the newest hour.
   * A UTC day the ledger kept whole (fallbackDays: its hours could not be read or did not add up) reads the edge of that
   * day on the side the ledger put it, so the levels are the ledger's opening and closing balances. o: {now,
   * fallbackDays}.
   */
  HO.archiveRow = (t, o = {}) => {
    const now = o.now != null ? o.now : Date.now();
    const live = { res: 'hour1', rowT: Math.floor(now / HOUR) * HOUR, at: now, now: true };
    if (t >= now - LIVE) return live;
    if (t % DAY === 0) return { res: 'day1', rowT: t - DAY, at: t, now: false };
    const D = Math.floor(t / DAY) * DAY;
    if ((o.fallbackDays || []).includes(D)) { const after = D + DAY / 2 >= t; return { res: 'day1', rowT: after ? D - DAY : D, at: after ? D : D + DAY, now: false }; }
    const at = Math.ceil(t / HOUR) * HOUR;
    return at >= now - LIVE ? live : { res: 'hour1', rowT: at - HOUR, at, now: false };
  };

  /** One T.load.upnl read as the unrealized PnL per pool: {byTok: {tokenId: value}, total, found (the archive had rows
   *  for that bucket), rowT}; the row at rowT only (the archive's endTime is inclusive, so a read also brings the next
   *  bucket), or for now each pool's newest. Null when the read failed or is missing. */
  HO.upnlOf = (read) => {
    if (!read || read.error || !Array.isArray(read.rows)) return null;
    const s = read.spec;
    let rowT = s.rowT;
    if (s.now) rowT = read.rows.reduce((m, r) => Math.max(m, U.num(r.time)), -Infinity);
    const rows = read.rows.filter((r) => U.num(r.time) === rowT);
    const byTok = {};
    for (const r of rows) { const k = tokOf(r); byTok[k] = (byTok[k] || 0) + U.num(r.unrealizedPnl); }
    return { byTok, total: U.sum(Object.values(byTok)), found: rows.length > 0, rowT: rows.length ? rowT : s.rowT };
  };

  /** productId → the margin pool (token id) its positions sit in: the token of its quote token's address. */
  HO.poolOf = (ref) => {
    const byAddr = {}, out = new Map();
    for (const t of Object.values((ref && ref.tokenById) || {})) byAddr[String(t.address || '').toLowerCase()] = t.id;
    for (const p of Object.values((ref && ref.byId) || {})) { const tok = byAddr[String(p.quoteTokenAddress || '').toLowerCase()]; if (tok) out.set(p.id, tok); }
    return out;
  };

  // ---------- perps ----------
  /**
   * Positions open at instant t (held just before it: a fill at t is the period's): [{positionId, productId, ticker, cls,
   * long, size, avgEntry, opened, pool, known, from, p}], oldest first. o: {t, positions (the list), reps
   * (T.fills.disposals' replays by position; null without the trade detail), ref}. The replay gives each one's size and
   * average entry at t; without it the positions list does, and only for a position not changed since t (known: false
   * otherwise, its size then is in the trade detail).
   */
  HO.openAt = (o) => {
    const t = o.t, ref = o.ref || {}, pool = HO.poolOf(ref), out = [];
    for (const p of o.positions || []) {
      const c = U.num(p.createdAt); if (!(c < t)) continue;
      const prod = ref.byId ? ref.byId[p.productId] : null;
      const base = { positionId: p.id, productId: p.productId, ticker: prod ? prod.displayTicker : p.productId, cls: T.fills.classOf(prod), long: String(p.side) === '0', opened: c, pool: pool.get(p.productId) || null, p };
      const r = o.reps ? o.reps.get(p.id) : null;
      if (r) { const q = r.sizeAt(t - 1); if (q > QEPS) out.push(Object.assign(base, { size: q, avgEntry: r.avgAt(t - 1), known: true, from: 'fills' })); continue; }
      const sz = Math.abs(U.num(p.size)), upd = U.num(p.updatedAt);
      if (!(sz > 0 || upd >= t)) continue;   // closed before t
      const known = sz > 0 && upd < t;       // not changed since t: its size now is its size then
      // the exchange's cost is the open size's cost; without it the increases' average holds while nothing was reduced
      const entry = !known ? null : p.cost != null && p.cost !== '' ? U.num(p.cost) / sz : !U.num(p.totalDecreaseQuantity) && U.num(p.totalIncreaseQuantity) ? U.num(p.totalIncreaseNotional) / U.num(p.totalIncreaseQuantity) : null;
      out.push(Object.assign(base, { size: known ? sz : null, avgEntry: entry, known, from: 'list' }));
    }
    return out.sort((a, b) => a.opened - b.opened || (a.positionId < b.positionId ? -1 : 1));
  };

  /**
   * The perps subaccount at instant t. o: {t, now (t is now), levels ({tokenId: level}: the ledger's opening or closing
   * levels), upnl (HO.upnlOf's result; null: not read), unsettled (T.funding.unsettledAt at t; null: the charges could
   * not be read), live (now: the open positions, whose fundingUsd and positionFeeUsd are the exchange's own unsettled
   * funding and position fees, as the account page has them), open (HO.openAt), positions (all, to place a charge's
   * position in its pool), ref}.
   * Returns {t, now, pools: [{tokenId, name, mPerp, cash, upnl, funding (+ received), posFees (+ paid), equity, equityNet,
   * open}], cash, upnl, funding, posFees, equity (cash + unrealized, price only), equityNet (also net of the unsettled
   * funding, and of the position fees where known), open, fundingFrom ('exchange' | 'charges' | null)}. upnl, funding and
   * the equities are null where not known; posFees is known only now (the archive keeps no field for them).
   */
  HO.perpsAt = (o) => {
    const ref = o.ref || {}, pool = HO.poolOf(ref), mp = T.ledger.mPerpPools(ref);
    const prodOf = new Map((o.positions || []).map((p) => [p.id, p.productId]));
    const pools = new Map();
    const at = (tok) => {
      let x = pools.get(tok);
      if (!x) { const tk = ref.tokenById ? ref.tokenById[tok] : null; pools.set(tok, (x = { tokenId: tok, name: tk ? tk.name : String(tok).slice(0, 8), mPerp: mp.has(tok), cash: 0, upnl: 0, funding: 0, posFees: 0, open: 0 })); }
      return x;
    };
    for (const [tok, v] of Object.entries(o.levels || {})) at(tok).cash += U.num(v);
    const open = o.open || [];
    for (const r of open) if (r.pool) at(r.pool).open++;
    // a bucket the archive has no rows for is all zero only when nothing was open
    let upnl = null;
    if (o.upnl && (o.upnl.found || !open.length)) { upnl = o.upnl.total; for (const [tok, v] of Object.entries(o.upnl.byTok)) at(tok).upnl += v; }
    let funding = null, posFees = null, fundingFrom = null;
    const liveOf = new Map();
    if (o.live) {
      funding = 0; posFees = 0; fundingFrom = 'exchange';
      for (const p of o.live) {
        const tok = pool.get(p.productId), f = -U.num(p.fundingUsd), pf = U.num(p.positionFeeUsd);
        funding += f; posFees += pf; liveOf.set(p.id, p);
        if (tok) { at(tok).funding += f; at(tok).posFees += pf; }
      }
    } else if (o.unsettled) {
      funding = o.unsettled.net; fundingFrom = 'charges';
      for (const x of o.unsettled.byPos.values()) { const tok = pool.get(x.productId || prodOf.get(x.positionId)); if (tok) at(tok).funding += x.amount; }
    }
    // each open position's own part: its unsettled funding; now also the exchange's unrealized PnL and position fees
    for (const r of open) {
      const p = liveOf.get(r.positionId), u = o.unsettled ? o.unsettled.byPos.get(r.positionId) : null;
      r.funding = p ? -U.num(p.fundingUsd) : o.unsettled ? (u ? u.amount : 0) : null;
      r.upnl = p ? U.num(p.unrealizedPnl) : null;
      r.posFees = p ? U.num(p.positionFeeUsd) : null;
    }
    const list = Array.from(pools.values()).filter((x) => Math.abs(x.cash) > EPS || Math.abs(x.upnl) > EPS || Math.abs(x.funding) > EPS || Math.abs(x.posFees) > EPS || x.open)
      .sort((a, b) => (a.mPerp === b.mPerp ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.mPerp ? 1 : -1));
    for (const x of list) {
      if (upnl == null) x.upnl = null;
      if (funding == null) x.funding = null;
      if (posFees == null) x.posFees = null;
      x.equity = x.upnl == null ? null : x.cash + x.upnl;
      x.equityNet = x.equity == null || x.funding == null ? null : x.equity + x.funding - (x.posFees || 0);
    }
    const cash = U.sum(list, (x) => x.cash);
    const equity = upnl == null ? null : cash + upnl;
    return { t: o.t, now: !!o.now, pools: list, cash, upnl, funding, posFees, equity, equityNet: equity == null || funding == null ? null : equity + funding - (posFees || 0), open, fundingFrom };
  };

  /**
   * The change in perps equity over the period with deposits and withdrawals (their fees too) taken out, both ways:
   * {price, net, priceC, netC} (null where an end is not known), and what it is made of: the period's net result
   * (result), the change in unrealized PnL (dUpnl) and any balance change the ledger has no entry for (unexplained: the
   * reconciliation's difference); price = result + dUpnl + unexplained. a, b: HO.perpsAt at the start and the end; ca,
   * cb: their equities in the report currency (at the instants' rates; the transfers at their own dates).
   */
  HO.change = (a, b, led, ca, cb) => {
    const L = led.totals, flows = L.deposits - L.withdrawals, flowsC = L.C.deposits - L.C.withdrawals;
    const d = (x, y, f) => (x == null || y == null ? null : y - x - f);
    return {
      price: d(a.equity, b.equity, flows), net: d(a.equityNet, b.equityNet, flows),
      priceC: ca ? d(ca.equity, cb.equity, flowsC) : null, netC: ca ? d(ca.equityNet, cb.equityNet, flowsC) : null,
      deposits: L.deposits, withdrawals: L.withdrawals, result: L.net, dUpnl: a.upnl == null || b.upnl == null ? null : b.upnl - a.upnl, unexplained: led.recon.diff,
    };
  };

  /** The USDe lots at an instant, from a run's snapshots (T.lots.run with at): {pools [{key, units, usd, c}], units, usd,
   *  c} or null when the run has none there. */
  HO.lotsAt = (run, t) => {
    const s = run && run.at ? run.at.find((x) => x.t === t) : null;
    if (!s) return null;
    const pools = s.pools.filter((p) => Math.abs(p.units) > 1e-6);
    return { pools, units: U.sum(pools, (p) => p.units), usd: U.sum(pools, (p) => p.usd), c: U.sum(pools, (p) => p.c) };
  };

  /** The rate a value at instant t converts at: the local day before t (null in USD; {none: true, label: T.fx.NO_RATE}
   *  when that day is before the first published rate). */
  HO.rateAt = (money, t) => (money && money.rates ? money.rates.on(t - 1, money.tz) : null);
  /** A USD value at instant t in the report currency (null stays null; null too where there is no rate, never the first
   *  rate in its place). */
  // nothing held converts to nothing, rate or not (a 2026 tax year starts before the first published rate, with nothing held)
  HO.fxAt = (money, v, t) => { if (v == null) return null; if (Math.abs(v) < 1e-12) return 0; if (!money || !money.rates) return v; const x = HO.rateAt(money, t); return x.none ? null : v * x.r; };

  /**
   * Everything the card and the files show. o: {period, now, money, ref, led (null: no perps subaccount), positions,
   * reads (T.load.upnl's reads, one per instant; null while loading), upnlFailed (the reads failed as a whole), D (the
   * trade detail; null while loading or when it failed), live (the open positions now), prep (T.predict.prepare; null: no
   * Predict record), lots ({runs: {transfer, disposal}, names, method, scope, dep} once built)}.
   * Returns {instants: [{key, t, now, label, rate, perps, perpsC, predict, lots}], change, perps (a subaccount), detail
   * (positions from the fills), upnlState ('loading' | 'ok' | 'failed')}.
   */
  HO.build = (o) => {
    const P = o.period, money = o.money, inst = HO.instants(P, o.now);
    const S = o.D && o.D.funding ? o.D.funding.S : null;
    const out = { instants: [], perps: !!o.led, detail: !!(o.D && o.D.reps), upnlState: o.reads ? 'ok' : o.upnlFailed ? 'failed' : 'loading', change: null };
    inst.forEach((x, i) => {
      const row = Object.assign({}, x, { rate: HO.rateAt(money, x.t), perps: null, perpsC: null, predict: null, lots: null });
      if (o.led) {
        const open = HO.openAt({ t: x.t, positions: o.positions, reps: o.D ? o.D.reps : null, ref: o.ref });
        row.perps = HO.perpsAt({ t: x.t, now: x.now, levels: i === 0 ? o.led.levels.opening : o.led.levels.closing, upnl: o.reads ? HO.upnlOf(o.reads[i]) : null, unsettled: x.now ? null : S ? T.funding.unsettledAt(S.charges, x.t) : null, live: x.now ? (o.live || []) : null, open, positions: o.positions, ref: o.ref });
        const f = (v) => HO.fxAt(money, v, x.t);
        row.perpsC = { cash: f(row.perps.cash), upnl: f(row.perps.upnl), funding: f(row.perps.funding), posFees: f(row.perps.posFees), equity: f(row.perps.equity), equityNet: f(row.perps.equityNet) };
      }
      if (o.prep) row.predict = T.predict.holdingsAt(o.prep, x.t);
      if (o.lots && o.lots.runs) row.lots = { transfer: HO.lotsAt(o.lots.runs.transfer, x.lotsT), disposal: HO.lotsAt(o.lots.runs.disposal, x.lotsT) };
      out.instants.push(row);
    });
    if (o.led) { const [a, b] = out.instants; out.change = HO.change(a.perps, b.perps, o.led, a.perpsC, b.perpsC); }
    return out;
  };

  // ---------- words ----------
  /** The 'Open at period end' tile's line for a period that has ended. n: positions open at the end; upnl: the archive's
   *  unrealized PnL at the end (undefined while it loads, null when it could not be read). */
  HO.tileLine = (n, upnl, money, end) => {
    if (!n) return 'nothing carried into the next period';
    if (upnl === undefined) return 'carried into the next period · unrealized PnL at period end loading…';
    if (upnl == null) return 'carried into the next period · unrealized PnL at period end could not be loaded';
    const c = HO.fxAt(money, upnl, end);
    return `${c == null ? U.fmtUsd(upnl, { sign: true, dp: 2 }) + ' (' + T.fx.NO_RATE + ')' : money.fmt(c, { sign: true })} unrealized at period end (price only, before unsettled funding and position fees) · not included in Net result or Realized PnL`;
  };

  // ---------- rows for the summary and the Holdings file ----------
  const n6 = (v) => (v == null ? '' : T.n6(v));
  const whenText = (x) => (x.key === 'start' ? 'period start' : x.now ? 'now' : 'period end');
  /**
   * [label, USD, report currency] rows of the holdings for the summary export (the report currency at the rate of the
   * local day before each instant; blank where a value is not known).
   */
  HO.rows = (H, money) => {
    const out = [], C = money && money.rates;
    const add = (label, v, x) => out.push([label, n6(v), C ? n6(HO.fxAt(money, v, x.t)) : '']);
    for (const x of H.instants) {
      const w = whenText(x);
      if (C) out.push([`Rate for the holdings at ${w} (the local day before it)`, '', x.rate.none ? T.fx.NO_RATE : `1 USD = ${T.fx.rateCell(x.rate.r)} ${money.ccy} (${x.rate.label})`]);
      if (x.perps) {
        const p = x.perps;
        add(`Perps cash balance at ${w}`, p.cash, x);
        add(`Perps unrealized PnL at ${w} (price only, before unsettled funding and position fees)`, p.upnl, x);
        add(`Perps funding charged, not settled at ${w} (+ received)`, p.funding, x);
        if (x.now) add(`Perps position fees accrued, not settled at ${w}`, p.posFees, x);
        add(`Perps equity at ${w} (cash + unrealized, price only)`, p.equity, x);
        add(`Perps equity at ${w}, net of unsettled funding` + (x.now ? ' and position fees' : ''), p.equityNet, x);
        out.push([`Perps positions open at ${w}`, p.open.length, '']);
      }
      if (x.predict) {
        const q = x.predict, u = q.unclaimed;
        add(`Predict open predictions at ${w}, at stake (cost)`, q.open.cost, x);
        add(`Predict position tokens held at ${w}, at cost`, q.tokens.cost, x);
        add(`Predict decided, not claimed at ${w}: payout of ${u.won} win(s)` + (u.void ? ` and refund of ${u.void} void(s)` : ''), u.payout + u.refund, x);
        out.push([`Predict decided, not claimed at ${w}: losses (count)`, u.lost, '']);
        if (u.held || u.heldLost) add(`Predict tokens held to a decided verdict, not redeemed at ${w} (what they pay)`, u.heldValue, x);
      }
    }
    // in the report currency each equity at its instant's rate and each transfer at its own date's
    if (H.change) {
      out.push(['Perps change in equity over the period, deposits and withdrawals taken out (price only)', n6(H.change.price), C ? n6(H.change.priceC) : '']);
      out.push(['Perps change in equity over the period, deposits and withdrawals taken out (net of unsettled funding)', n6(H.change.net), C ? n6(H.change.netC) : '']);
    }
    return out;
  };

  /** The Holdings file's first rows: what it is and how its values were read. ctx: {H, period, tz, money, addr, sid, pw,
   *  warnings, now}. */
  HO.describe = (ctx) => {
    const P = ctx.period, tz = ctx.tz || P.tz, H = ctx.H, money = ctx.money;
    const at = (x) => (x.now ? 'now, ' : '') + TZ.fmt(x.t, tz, 'datetime') + ' ' + tz + ' (' + new Date(x.t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC)';
    return [
      ['Report', 'Holdings at the period\'s start and end (values at an instant, in no total of the report)'],
      ['Disclaimer', T.DISCLAIMER],
      ['Wallet', ctx.addr || ''], ...(ctx.sid ? [['Subaccount', ctx.sid]] : []), ...(ctx.pw ? [['Predict wallet', ctx.pw]] : []),
      ['Period', P.startText + ' → ' + P.endText], ['Time zone', tz],
      ['Instants', H.instants.map((x) => x.label + ': ' + at(x)).join('; ')],
      ...money.describe(),
      ...(money.rates ? [['Rate at an instant', 'the rate of the local day before the instant (in ' + tz + '), under the source\'s rule; an instant whose day before is earlier than the first published rate has none (' + T.fx.NO_RATE + '): its values stay in USD only']] : []),
      ['Perps cash balance', 'the archive\'s balance per margin pool at the instant (the levels the balance reconciliation uses; a boundary inside an hour reads the end of that hour)'],
      ['Perps unrealized PnL', 'the archive\'s unrealized PnL per margin pool at the instant (its end-of-bucket figure, price only: before funding charged and not settled, and before mPerp position fees accrued); now, its newest bucket'],
      ['Perps unsettled funding', 'funding charged before the instant and settled after it (each hourly charge settles at its position\'s next fill); now, the exchange\'s own figure per open position'],
      ['Perps position fees not settled', 'known now only (the exchange\'s figure per open position): the archive keeps no field for them, so a past instant\'s equity is before them'],
      ['Positions open', H.detail ? 'size and average entry at the instant from the replay of each position\'s fills' : 'from the positions list: a position changed since the instant has no size there (the trade detail gives it)'],
      ['Change in equity', 'equity at the end − equity at the start − deposits + withdrawals (their fees included); equals the period\'s net result + the change in unrealized PnL + any balance change the ledger has no entry for'],
      ['Meridian Predict', 'at cost: open predictions at the wallet\'s own stake or collateral, position tokens on undecided picks at their average cost (the wallet\'s ledger replayed to the instant); decided before the instant (by the decision time, settled on Meridian) and not claimed by it: a win\'s payout, a void\'s refund, losses counted, tokens held to the verdict at what they pay. What an open prediction is worth at the instant is not known here'],
      ['USDe lots', 'units held and their cost under the lots\' method and scope, both deposit readings, when the USDe lots were built on the page'],
      ...(ctx.warnings || []).map((w) => ['Completeness', w]),
      ['Generated (UTC)', new Date(ctx.now != null ? ctx.now : Date.now()).toISOString().replace('T', ' ').slice(0, 19)], ['Site version', T.VERSION],
    ];
  };

  /**
   * The Holdings file (a site report): one row per value per instant, the pools, the positions open at each instant,
   * the change in equity. ctx: {H, period, tz, money, fname, names (the lots' scope names), lotsInfo ({method, scope}),
   * warnings}.
   */
  HO.file = (ctx) => {
    const { H, money } = ctx, tz = ctx.tz || ctx.period.tz, C = money.rates ? money.ccy : null;
    const iso = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const rows = [];
    const add = (x, item, detail, usd, note, count) => rows.push({ x, item, detail: detail || '', usd, note: note || '', count: count == null ? '' : count });
    for (const x of H.instants) {
      const p = x.perps;
      if (p) {
        const na = H.upnlState === 'loading' ? 'not loaded yet' : 'could not be read';
        for (const pl of p.pools) add(x, 'Perps cash balance', pl.name + ' pool', pl.cash);
        add(x, 'Perps cash balance', 'all pools', p.cash);
        for (const pl of p.pools) if (pl.upnl != null) add(x, 'Perps unrealized PnL (price only)', pl.name + ' pool', pl.upnl);
        add(x, 'Perps unrealized PnL (price only)', 'all pools', p.upnl, p.upnl == null ? 'the archive\'s unrealized PnL ' + na : 'before funding charged and not settled, and before position fees accrued');
        add(x, 'Perps funding charged, not settled (+ received)', 'all pools', p.funding, p.funding == null ? 'the funding charges could not be read' : p.fundingFrom === 'exchange' ? 'the exchange\'s figure per open position' : 'charged before the instant, settled after it');
        add(x, 'Perps position fees accrued, not settled', 'all pools', p.posFees, p.posFees == null ? 'not recorded for a past instant' : 'the exchange\'s figure per open position');
        add(x, 'Perps equity (cash + unrealized, price only)', 'all pools', p.equity);
        add(x, 'Perps equity, net of unsettled funding' + (p.posFees != null ? ' and position fees' : ''), 'all pools', p.equityNet, p.posFees == null && p.equityNet != null ? 'before position fees accrued and not settled' : '');
        add(x, 'Perps positions open', '', null, '', p.open.length);
      }
      const q = x.predict;
      if (q) {
        const u = q.unclaimed;
        add(x, 'Predict open predictions, at stake (cost)', '', q.open.cost, 'own stake or collateral of predictions placed and not decided before the instant', q.open.n);
        add(x, 'Predict position tokens held, at cost', q.tokens.n ? U.fmtNum(q.tokens.tokens, 2) + ' tokens' : '', q.tokens.cost, 'pick configurations traded and not decided before the instant, at the ledger\'s average cost', q.tokens.n);
        add(x, 'Predict decided, not claimed: payouts of wins', '', u.payout, 'stake included', u.won);
        add(x, 'Predict decided, not claimed: refunds of voids', '', u.refund, '', u.void);
        add(x, 'Predict decided, not claimed: losses', '', u.lostStake, 'the collateral they forfeit (already paid at the placement); claimed by the counterparty', u.lost);
        add(x, 'Predict tokens held to a decided verdict, not redeemed', u.heldLost ? u.heldLost + ' worthless' : '', u.heldValue, 'what they pay; cost ' + T.n6(u.heldCost), u.held);
      }
      if (x.lots) for (const r of ['transfer', 'disposal']) { const l = x.lots[r]; if (l) add(x, 'USDe lots held: cost (' + T.lots.READING_LABEL[r].toLowerCase() + ')', U.fmtNum(l.units, 6) + ' units', l.usd, ctx.lotsInfo ? T.lots.METHOD_LABEL[ctx.lotsInfo.method] + ' · ' + T.lots.SCOPE_LABEL[ctx.lotsInfo.scope].toLowerCase() : ''); }
    }
    const rate = (x) => x.rate;
    const ccy = C ? [[C, (r) => (r.usd == null ? '' : n6(HO.fxAt(money, r.usd, r.x.t)))], ['USD→' + C + ' rate (the local day before the instant)', (r) => T.fx.rateCell(rate(r.x).r)], [money.rates.src.dateHead, (r) => rate(r.x).label]] : [];
    const main = {
      title: 'Holdings',
      columns: [['Instant', (r) => r.x.label], ['Time (UTC)', (r) => iso(r.x.t)], ...(tz === 'UTC' ? [] : [['Time (' + tz + ')', (r) => TZ.fmt(r.x.t, tz, 'iso')]]),
        ['Item', (r) => r.item], ['Detail', (r) => r.detail], ['Count', (r) => r.count], ['USD', (r) => n6(r.usd)], ...ccy, ['Note', (r) => r.note]],
      rows,
    };
    const pos = [];
    for (const x of H.instants) if (x.perps) for (const r of x.perps.open) pos.push({ x, r });
    const positions = {
      title: 'Positions open at each instant',
      columns: [['Instant', (r) => r.x.label], ['Time (UTC)', (r) => iso(r.x.t)], ['Market', (r) => r.r.ticker], ['Class', (r) => r.r.cls], ['Side', (r) => (r.r.long ? 'LONG' : 'SHORT')],
        ['Size', (r) => n6(r.r.size)], ['Average entry', (r) => n6(r.r.avgEntry)], ['Size from', (r) => (r.r.from === 'fills' ? 'the replay of its fills' : r.r.known ? 'the positions list (not changed since)' : 'not known without the trade detail')],
        ['Opened (UTC)', (r) => iso(r.r.opened)], ...(tz === 'UTC' ? [] : [['Opened (' + tz + ')', (r) => TZ.fmt(r.r.opened, tz, 'iso')]]),
        ['Funding charged, not settled USD (+ received; now: the exchange\'s)', (r) => n6(r.r.funding)],
        ['Unrealized PnL USD (now only: the exchange\'s, price only)', (r) => n6(r.r.upnl)],
        ['Position fees not settled USD (now only: the exchange\'s)', (r) => n6(r.r.posFees)],
        ['Position ID', (r) => r.r.positionId]],
      rows: pos,
    };
    const sections = [main, positions];
    const ch = H.change;
    if (ch) sections.push({
      title: 'Change in perps equity, deposits and withdrawals taken out',
      columns: [['Reading', (r) => r[0]], ['USD', (r) => n6(r[1])], ...(C ? [[C + ' (equities at their instants\' rates, transfers at their own dates)', (r) => n6(r[2])]] : [])],
      rows: [['Price only (unrealized PnL before unsettled funding and position fees)', ch.price, ch.priceC], ['Net of unsettled funding (and position fees where known)', ch.net, ch.netC],
        ['of which: net result of the period', ch.result, null], ['of which: change in unrealized PnL (price only)', ch.dUpnl, null], ['of which: balance change without a ledger entry', ch.unexplained, null],
        ['Deposits in the period', ch.deposits, null], ['Withdrawals in the period (incl. fees)', ch.withdrawals, null]],
    });
    return { name: ctx.fname('holdings'), sections, warnings: (ctx.warnings || []).slice() };
  };
})();
