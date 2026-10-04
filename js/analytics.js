/* MeridianDataHub — account analytics: series building, interval stats, position stats, margin state */
(function () {
  const MD = window.MD; const U = MD.util; const A = MD.api;
  const AN = (MD.analytics = {});

  AN.INTERVALS = { '24h': U.DAY, '7d': 7 * U.DAY, '30d': 30 * U.DAY, all: Infinity };
  /** Resolution used for each interval's series. */
  AN.resFor = (interval) => ({ '24h': 'hour1', '7d': 'hour2', '30d': 'hour8', all: 'day1' }[interval] || 'day1');

  // every flow the archive's balance rows record, as running totals per token (outflows negative)
  const FLOWS = ['realizedPnl', 'tradingFee', 'realizedFunding', 'deposit', 'withdrawal', 'withdrawalFee', 'depositFee', 'conversionIn', 'conversionOut'];
  /**
   * Merge archive rows (balance per token, unrealized pnl per token, volume) into one series.
   * Every bucket: {t, balance, upnl, equity, realizedPnl, fee (trading fees paid, positive), posFee (mPerp position fees
   * paid, positive; negative on the account they are credited to), funding (signed, + received),
   * pnl (= realized − fee − posFee + funding), deposit, withdrawal (positive), volume}
   */
  AN.buildSeries = function ({ balance = [], upnl = [], volume = [] }) {
    const m = new Map();
    const at = (t) => { let b = m.get(t); if (!b) { b = { t, balance: 0, upnl: 0, realizedPnl: 0, fee: 0, posFee: 0, funding: 0, deposit: 0, withdrawal: 0, wfee: 0, volume: 0, hasBalance: false }; m.set(t, b); } return b; };
    // The archive reports flows (realizedPnl, tradingFee, realizedFunding, deposit, withdrawal, fees) as
    // running totals per token; `balance` is the end-of-bucket level. Diff consecutive buckets per token.
    const byToken = U.groupBy(balance, (r) => r.tokenId || r.tokenAddress || 'x');
    for (const rows of Object.values(byToken)) {
      rows.sort((a, b) => a.time - b.time);
      let prev = null;
      for (const r of rows) {
        const b = at(r.time); b.hasBalance = true;
        const d = (k) => U.num(r[k]) - (prev ? U.num(prev[k]) : 0);
        b.balance += U.num(r.balance);
        b.realizedPnl += d('realizedPnl');
        b.fee += -d('tradingFee');
        b.funding += d('realizedFunding');
        b.deposit += d('deposit');
        b.withdrawal += -d('withdrawal') - d('withdrawalFee') - d('depositFee');
        b.wfee += -d('withdrawalFee') - d('depositFee');   // the fee part of the line above (an expense, unlike the transfer itself)
        // mPerp position fees leave the balance but the archive has no field for them: the part of the balance change no
        // listed flow explains (rounded to the archive's 9 decimals, so float noise on a large balance is not a fee)
        b.posFee += -Math.round((d('balance') - FLOWS.reduce((a, k) => a + d(k), 0)) * 1e9) / 1e9;
        prev = r;
      }
    }
    for (const r of upnl) { const b = at(r.time); b.upnl += U.num(r.unrealizedPnl); }
    for (const r of volume) { const b = at(r.time); b.volume += U.num(r.volumeUsd); }
    const rows = Array.from(m.values()).sort((a, b) => a.t - b.t);
    // carry balance forward across buckets that only had upnl/volume rows
    let lastBal = 0;
    for (const b of rows) { if (b.hasBalance) lastBal = b.balance; else b.balance = lastBal; b.pnl = b.realizedPnl - b.fee - b.posFee + b.funding; b.equity = b.balance + b.upnl; }
    return rows;
  };

  /** Fetch + build the series for a subaccount over [start, now]. Adds one prior bucket for deltas. With `charges`, also
   *  the funding charged since then (series.charges, for AN.netOfUnsettled; null when not asked for or not readable). */
  AN.loadSeries = async function (sid, { start, resolution, signal, ttl, withVolume = true, charges = false }) {
    const res = A.RES[resolution];
    const s = Math.max(0, Math.floor(start / res.ms) * res.ms - res.ms);
    const [balance, upnl, volume, ch] = await Promise.all([
      A.history('balance', sid, { start: s, resolution, signal, ttl }),
      A.history('unrealized-pnl', sid, { start: s, resolution, signal, ttl }),
      withVolume ? A.history('volume', sid, { start: s, resolution, signal, ttl }) : Promise.resolve([]),
      charges ? A.fundingCharges(sid, s, { signal, ttl }).catch((e) => { if (e && e.name === 'AbortError') throw e; return null; }) : Promise.resolve(null),
    ]);
    const series = AN.buildSeries({ balance, upnl, volume });
    series.charges = ch;
    return series;
  };

  /** The archive's unrealized PnL leaves out funding charged to open positions but not yet settled into the balance
   *  (Meridian settles it when a position is increased, reduced or closed); the live figures subtract it. This puts every
   *  bucket on that basis: owed at a bucket's end = owed now − charges after it − funding settled after it. Adds
   *  fundingCharged per bucket (+ = received, like funding). Returns a new series marked netted, or the series as it is
   *  when there are no charges. */
  AN.netOfUnsettled = function (series, charges, unsettledNow, bucketMs) {
    if (!charges || !series || !series.length) return series;
    const ch = charges.map((c) => [U.num(c.time), U.num(c.fundingCharge)]).sort((a, b) => a[0] - b[0]);
    const out = series.map((b) => Object.assign({}, b));
    let owed = U.num(unsettledNow), i = ch.length - 1;
    for (let k = out.length - 1; k >= 0; k--) {
      const b = out[k];
      while (i >= 0 && ch[i][0] >= b.t + bucketMs) owed -= ch[i--][1];   // charged after this bucket ended
      b.upnl -= owed; b.equity -= owed;
      let inside = 0; while (i >= 0 && ch[i][0] >= b.t) inside += ch[i--][1];
      b.fundingCharged = -inside;
      owed -= inside + b.funding;   // at the bucket's start: less what was charged in it and what settled in it (+ received)
    }
    out.netted = true;
    return out;
  };

  /**
   * Stats over buckets with t >= start. live: {upnl, equity} for the current moment (optional).
   */
  AN.intervalStats = function (series, start, live, bucketMs) {
    const inRange = series.filter((b) => b.t >= start);
    const before = series.filter((b) => b.t < start);
    const prev = before.length ? before[before.length - 1] : null;
    const upnlStart = prev ? prev.upnl : 0;
    const eqStart = prev ? prev.equity : 0;
    let realized = 0, fees = 0, posFees = 0, funding = 0, volume = 0, deposits = 0, withdrawals = 0;
    for (const b of inRange) { realized += b.pnl; fees += b.fee; posFees += b.posFee || 0; funding += b.funding; volume += b.volume; deposits += b.deposit; withdrawals += b.withdrawal; }
    // funding charged inside the interval (+ = received), known once AN.netOfUnsettled has put the series on that basis
    const fundingCharged = series.netted ? U.sum(inRange, (b) => b.fundingCharged || 0) : null;
    const last = inRange.length ? inRange[inRange.length - 1] : prev;
    const upnlEnd = live && live.upnl != null ? live.upnl : last ? last.upnl : 0;
    const pnl = realized + (upnlEnd - upnlStart);
    // Drawdown on a flow-adjusted curve (deposits/withdrawals removed → trading losses only).
    // ddUsd = loss since the high-water mark, in dollars.
    const bm = bucketMs || U.DAY; const nowT = Date.now();
    // archive rows carry end-of-bucket values under the bucket's start: each point sits at the bucket's end (the one in progress at now)
    const curve = [{ t: prev ? Math.max(start, prev.t + bm) : start, v: eqStart, eq: eqStart }];
    let acc = eqStart, pu = upnlStart;
    for (const b of inRange) { acc += b.pnl + (b.upnl - pu); pu = b.upnl; curve.push({ t: Math.min(b.t + bm, nowT), v: acc, eq: b.equity }); }
    if (live && live.upnl != null && live.equity != null) {
      const p = { t: nowT, v: acc + (live.upnl - pu), eq: live.equity };
      const lastB = inRange[inRange.length - 1];
      if (lastB && lastB.t + bm > nowT) curve[curve.length - 1] = p; else curve.push(p);   // the bucket in progress is replaced by the live figure: one point per moment
    }
    let peak = -Infinity, ddUsd = 0;
    for (const p of curve) { if (p.v > peak) peak = p.v; const d = peak - p.v; if (d > 0.005 && d > ddUsd) ddUsd = d; }
    // ddPct on a time-weighted return index: each bucket's gain on the capital it had (equity at its start plus that
    // bucket's deposits), compounded, so money moving in or out changes neither the index nor the drawdown. The old
    // base (equity at the trough + the loss) went to zero when an account lost a little and then withdrew the rest,
    // which read as a 100 % drawdown.
    let idx = 1, idxPeak = 1, ddPct = 0, capEq = eqStart, capUp = upnlStart;
    const step = (gain, deposit, eqAfter) => {
      const base = capEq + (deposit || 0);
      if (base > 1) { idx *= Math.max(0, 1 + gain / base); if (idx > idxPeak) idxPeak = idx; const dd = (1 - idx / idxPeak) * 100; if (dd > ddPct) ddPct = dd; }
      capEq = eqAfter;
    };
    for (const b of inRange) { step(b.pnl + (b.upnl - capUp), b.deposit, b.equity); capUp = b.upnl; }
    if (live && live.upnl != null && live.equity != null) step(live.upnl - capUp, 0, live.equity);
    // returns per bucket (PnL-based, on prior equity)
    const rets = [];
    let prevEq = eqStart, prevUp = upnlStart;
    for (const b of inRange) {
      const gain = b.pnl + (b.upnl - prevUp);
      if (prevEq > 1) rets.push(gain / prevEq);
      prevEq = b.equity; prevUp = b.upnl;
    }
    // Sharpe from a handful of buckets is noise (its standard error is ~1/√n), so it needs at least 10 returns; buckets
    // follow AN.resFor (1 h for 24h, 2 h for 7d, 8 h for 30d, 1 day for all-time) on every page.
    let sharpe = null;
    const nz = rets.filter((r) => r !== 0);
    if (rets.length >= 10 && nz.length >= 3) {
      const mean = rets.reduce((a, x) => a + x, 0) / rets.length;
      const sd = Math.sqrt(rets.reduce((a, x) => a + (x - mean) * (x - mean), 0) / (rets.length - 1));
      const per = bucketMs || U.DAY;
      if (sd > 0) sharpe = (mean / sd) * Math.sqrt((365 * U.DAY) / per);
    }
    const capital = Math.max(eqStart, 0) + deposits;
    const roi = capital > 1 ? (pnl / capital) * 100 : null;
    return { pnl, realized, fees, posFees, funding, fundingCharged, volume, deposits, withdrawals, upnlStart, upnlEnd, eqStart, ddUsd, ddPct, sharpe, roi, buckets: inRange.length, curve };
  };

  /** A flow-adjusted cumulative PnL curve (intervalStats' `curve`) as at most `max` [unix seconds, USD] pairs from 0,
   *  evenly thinned with the last point kept: small enough to ship in the leaderboard snapshot. */
  AN.compactCurve = (curve, max = 60) => {
    if (!curve || curve.length < 2) return null;
    const base = curve[0].v; const n = curve.length; const out = [];
    const step = Math.max(1, (n - 1) / (max - 1));
    for (let f = 0; f < n - 1; f += step) { const p = curve[Math.round(f)]; out.push([Math.round(p.t / 1000), Math.round((p.v - base) * 100) / 100]); }
    const last = curve[n - 1]; out.push([Math.round(last.t / 1000), Math.round((last.v - base) * 100) / 100]);
    return out;
  };

  AN.styleFromDuration = (ms) => (ms == null ? '—' : ms < U.HOUR ? 'Scalper' : ms < U.DAY ? 'Intraday' : ms < 7 * U.DAY ? 'Swing' : 'Long-term');

  /** Position-level stats. Closed positions are those with size 0 and some decrease. */
  AN.positionStats = function (positions, ref) {
    const closed = [], open = [];
    for (const p of positions) {
      const size = U.num(p.size);
      const net = U.num(p.realizedPnl) - U.num(p.feesAccruedUsd) - U.num(p.fundingAccruedUsd) - U.num(p.positionFeeAccruedUsd);
      const vol = U.num(p.totalIncreaseNotional) + U.num(p.totalDecreaseNotional);
      const row = { p, net, gross: U.num(p.realizedPnl), vol, duration: U.num(p.updatedAt) - U.num(p.createdAt), long: String(p.side) === '0', ticker: (ref && ref.byId[p.productId] && ref.byId[p.productId].displayTicker) || p.productId };
      if (size === 0 && U.num(p.totalDecreaseQuantity) > 0) closed.push(row); else if (size !== 0) open.push(row);
    }
    const wins = closed.filter((c) => c.net > 0), losses = closed.filter((c) => c.net < 0);
    const sumW = U.sum(wins, (c) => c.net), sumL = U.sum(losses, (c) => c.net);
    const byMarket = {};
    for (const c of closed.concat(open)) {
      const k = c.ticker; const b = byMarket[k] || (byMarket[k] = { ticker: k, count: 0, closed: 0, wins: 0, pnl: 0, vol: 0, longs: 0 });
      b.count++; b.vol += c.vol; if (c.long) b.longs++;
      if (c.p && U.num(c.p.size) === 0) { b.closed++; b.pnl += c.net; if (c.net > 0) b.wins++; }
    }
    const durations = closed.map((c) => c.duration).filter((d) => d >= 0);
    const avgDur = durations.length ? U.sum(durations) / durations.length : null;
    return {
      closed, open, count: positions.length,
      wins: wins.length, losses: losses.length,
      winRate: closed.length ? (wins.length / closed.length) * 100 : null,
      profitFactor: sumL < 0 ? sumW / -sumL : wins.length ? Infinity : null,
      avgWin: wins.length ? sumW / wins.length : null, avgLoss: losses.length ? sumL / losses.length : null,
      largestWin: wins.length ? Math.max(...wins.map((c) => c.net)) : null, largestLoss: losses.length ? Math.min(...losses.map((c) => c.net)) : null,
      totalNet: U.sum(closed, (c) => c.net), totalVol: U.sum(closed.concat(open), (c) => c.vol),
      avgDuration: avgDur, style: AN.styleFromDuration(avgDur),
      longs: closed.concat(open).filter((c) => c.long).length, shorts: closed.concat(open).filter((c) => !c.long).length,
      liquidated: positions.filter((p) => p.isLiquidated).length,
      byMarket: Object.values(byMarket).sort((a, b) => b.vol - a.vol),
      expectancy: closed.length ? U.sum(closed, (c) => c.net) / closed.length : null,
    };
  };

  /**
   * Live margin state from balances + open positions + prices. Mirrors the app's pool maths:
   * pool equity = balance + Σ(uPnL − unapplied funding − unapplied position fee);
   * maintenance = Σ notional × (1/(2·maxLev) + takerFee); liq price solved per position.
   */
  AN.accountState = function ({ balances = [], positions = [], ref, prices = {} }) {
    const pools = {};
    for (const b of balances) {
      const key = String(b.tokenAddress).toLowerCase();
      pools[key] = { key, name: b.tokenName, balance: U.num(b.amount), available: U.num(b.available), used: U.num(b.totalUsed), upnl: 0, mm: 0, notional: 0, positions: [] };
    }
    const rows = [];
    for (const p of positions) {
      const prod = ref && ref.byId[p.productId]; if (!prod) continue;
      const key = String(prod.quoteTokenAddress).toLowerCase();
      const pool = pools[key] || (pools[key] = { key, name: prod.quoteTokenName, balance: 0, available: 0, used: 0, upnl: 0, mm: 0, notional: 0, positions: [] });
      const size = U.num(p.size); const abs = Math.abs(size);
      const px = prices[p.productId]; const mark = px ? U.num(px.oraclePrice) : 0;
      const entry = abs > 0 ? U.num(p.cost) / abs : 0;
      const upnlApi = U.num(p.unrealizedPnl);
      const upnl = mark > 0 && entry > 0 ? size * (mark - entry) : upnlApi;
      const net = upnl - U.num(p.fundingUsd) - U.num(p.positionFeeUsd);
      const notional = abs * (mark || entry);
      const maxLev = U.num(prod.maxLeverage) || 1;
      const k = 1 / (2 * maxLev) + U.num(prod.takerFee);
      const mm = notional * k;
      const row = { p, prod, ticker: prod.displayTicker, size, abs, long: size > 0, mark, entry, upnl, net, notional, mm, k, maxLev, pool, funding: U.num(p.fundingUsd), positionFee: U.num(p.positionFeeUsd), realized: U.num(p.realizedPnl), roe: null, liqPrice: null, distPct: null, leverage: null };
      pool.upnl += net; pool.mm += mm; pool.notional += notional; pool.positions.push(row); rows.push(row);
    }
    let equity = 0, balance = 0, upnl = 0, notional = 0, used = 0, available = 0, mmTotal = 0;
    const poolList = Object.values(pools);
    for (const pool of poolList) {
      pool.equity = pool.balance + pool.upnl;
      pool.ratio = pool.mm > 0 ? pool.equity / pool.mm : null;
      pool.leverage = pool.equity > 0 ? pool.notional / pool.equity : null;
      for (const r of pool.positions) {
        const eqFor = pool.equity - pool.mm + r.mm;
        let liq = null;
        if (r.abs > 0 && r.mark > 0) {
          if (r.long) liq = (r.mark - eqFor / r.abs) / (1 - r.k); else liq = (r.mark + eqFor / r.abs) / (1 + r.k);
          if (liq < 0) liq = 0;
          r.liqPrice = liq;
          r.distPct = eqFor <= r.mm ? 0 : Math.abs((liq - r.mark) / r.mark) * 100;
        }
        const margin = r.notional / r.maxLev;
        r.roe = margin > 0 ? (r.net / margin) * 100 : null;
        r.leverage = pool.equity > 0 ? r.notional / pool.equity : null;
      }
      equity += pool.equity; balance += pool.balance; upnl += pool.upnl; notional += pool.notional; used += pool.used; available += pool.available; mmTotal += pool.mm;
    }
    // unsettledFunding: the open positions' funding not yet in the balance (fundingUsd, + = paid), for AN.netOfUnsettled
    return { equity, balance, upnl, notional, used, available, unsettledFunding: U.sum(rows, (r) => r.funding), leverage: equity > 0 ? notional / equity : null, marginRatio: mmTotal > 0 ? equity / mmTotal : null, pools: poolList.sort((a, b) => b.equity - a.equity), positions: rows.sort((a, b) => b.notional - a.notional) };
  };

  /**
   * All leaderboard metrics for one subaccount (shared by the browser build and scripts/build-snapshot.mjs).
   * ctx: {signal}. Returns a plain JSON-serialisable row.
   */
  AN.buildLeaderboardRow = async function (sa, ref, prices, ctx) {
    const sid = sa.id;
    const o = { signal: ctx && ctx.signal };
    const [balances, positionsOpen, vol] = await Promise.all([A.balances(sid, o), A.openPositions(sid, o), A.totalVolume(sid, o).catch(() => 0)]);
    const acct = AN.accountState({ balances, positions: positionsOpen, ref, prices });
    const row = { sid, account: sa.account, name: U.decodeBytes32(sa.name), createdAt: sa.createdAt, equity: acct.equity, balance: acct.balance, upnl: acct.upnl, notional: acct.notional, openCount: positionsOpen.length, volumeAll: vol, stats: {}, winRate: null, positionsCount: 0, closedCount: 0, liquidated: 0, style: '—', inactive: false };
    if (AN.EXCHANGE[sid]) row.exchange = true;   // for the share cards, which have no MD.analytics
    if (acct.balance === 0 && !positionsOpen.length && !vol) {
      row.inactive = true;
      for (const iv of Object.keys(AN.INTERVALS)) row.stats[iv] = { pnl: 0, volume: 0, roi: null, sharpe: null, ddPct: null, fees: 0, posFees: 0, funding: 0 };
      return row;
    }
    const copyCtx = ctx && ctx.copy;   // {depth, candles} from AN.copyContext: the snapshot build adds a copy profile per account
    // each interval on the account page's buckets (AN.resFor), so both pages show the same figures
    const sAll = AN.startFor('all', sa.createdAt), s7 = AN.startFor('7d', sa.createdAt), s30 = AN.startFor('30d', sa.createdAt), s24 = Date.now() - U.DAY;
    const so = { signal: o.signal, ttl: 60000 };
    const [positions, daily, hourly, h2, h8, charges] = await Promise.all([
      A.positions(sid, { maxPages: copyCtx ? 5 : 3, signal: o.signal }),
      AN.loadSeries(sid, Object.assign({ start: sAll, resolution: 'day1' }, so)),
      AN.loadSeries(sid, Object.assign({ start: s24, resolution: 'hour1' }, so)),
      AN.loadSeries(sid, Object.assign({ start: s7, resolution: 'hour2' }, so)),
      AN.loadSeries(sid, Object.assign({ start: s30, resolution: 'hour8' }, so)),
      A.fundingCharges(sid, sAll - U.DAY, so).catch((e) => { if (e && e.name === 'AbortError') throw e; return null; }),   // unreadable: the rows keep the settled basis
    ]);
    const net = (s, ms) => AN.netOfUnsettled(s, charges, acct.unsettledFunding, ms);
    const dailyN = net(daily, U.DAY);
    const ps = AN.positionStats(positions, ref);
    row.winRate = ps.winRate; row.positionsCount = ps.count; row.style = ps.style; row.closedCount = ps.closed.length; row.liquidated = ps.liquidated;
    const live = { upnl: acct.upnl, equity: acct.equity };
    // funding as charged when the charges were readable (else as settled); fees are trading fees, posFees mPerp position fees
    const pick = (s) => ({ pnl: s.pnl, volume: s.volume, roi: s.roi, sharpe: s.sharpe, ddPct: s.ddPct, fees: s.fees, posFees: s.posFees, funding: s.fundingCharged != null ? s.fundingCharged : s.funding });
    row.stats['24h'] = pick(AN.intervalStats(net(hourly, U.HOUR), s24, live, U.HOUR));
    row.stats['7d'] = pick(AN.intervalStats(net(h2, 2 * U.HOUR), s7, live, 2 * U.HOUR));
    row.stats['30d'] = pick(AN.intervalStats(net(h8, 8 * U.HOUR), s30, live, 8 * U.HOUR));
    const all = AN.intervalStats(dailyN, sAll, live, U.DAY);
    row.stats.all = pick(all);
    row.curve = AN.compactCurve(all.curve);   // the all-time PnL line for the account's link preview card
    if (copyCtx) {
      // fills and the price drift after them only for accounts with a track record worth copying (the candle cache is shared)
      let decays = null;
      if (ps.closed.length >= 3) {
        try { const fills = await A.page(A.BASE, '/v1/order/fill', { subaccountId: sid }, { maxPages: 10, signal: o.signal }); decays = await AN.fillDrift(fills, ref, copyCtx.candles); }
        catch (e) { if (e && e.name === 'AbortError') throw e; }
      }
      row.copy = AN.buildCopyProfile({ positions, daily: dailyN, equity: acct.equity, createdAt: sa.createdAt, ref, depth: copyCtx.depth, decays });
    }
    return row;
  };

  /** A leaderboard row that never traded: no volume and no positions. The exchange's fee-collector subaccount is one —
   *  its "PnL" is fees received — so lists of traders leave these out and the leaderboard labels them. */
  AN.noTrades = (r) => !(U.num(r.volumeAll) > 0) && !(r.positionsCount > 0) && !(r.openCount > 0);

  /** Subaccounts the exchange credits itself: not traders, so lists of traders leave them out and the leaderboard labels
   *  them (the fee collector is caught by AN.noTrades). Keyed by subaccount id; the text is the leaderboard's tooltip. */
  AN.EXCHANGE = {
    '01a047c4-2be2-774c-ae58-1e45d2f2a99d': 'Created with the markets at launch, days before any user account. It took over a liquidated trader\'s position (SOL, 25 Sep 2026), and the position fees charged on mPerps are credited to it. Its PnL is not trading.',
  };
  AN.exchangeAccount = (r) => (r && AN.EXCHANGE[r.sid]) || null;

  // ---------- Copy trading: what a follower would actually keep ----------
  /**
   * A taker order of `notional` USD walked through one side of the book: average price paid vs the mid, in bps.
   * Levels further than `band` (default 20%) from the mid are ignored (parked far quotes are not liquidity). `filled` is
   * the share of the notional the book can absorb inside that band; bps is null when it cannot absorb all of it.
   */
  AN.bookSlippage = function (book, buy, notional, band = 0.2) {
    const lv = (side) => (side || []).map(([p, q]) => [U.num(p), U.num(q)]).filter(([p, q]) => p > 0 && q > 0);
    const asks = lv(book && book.asks).sort((a, b) => a[0] - b[0]), bids = lv(book && book.bids).sort((a, b) => b[0] - a[0]);
    if (!asks.length || !bids.length) return { bps: null, filled: 0, mid: null };
    const mid = (asks[0][0] + bids[0][0]) / 2;
    let left = notional, cost = 0, qty = 0;
    for (const [p, q] of buy ? asks : bids) {
      if (Math.abs(p - mid) / mid > band) break;
      const take = Math.min(left, p * q); cost += take; qty += take / p; left -= take;
      if (left <= 1e-9) break;
    }
    const filled = notional > 0 ? (notional - Math.max(left, 0)) / notional : 1;
    if (left > 1e-9 || !qty) return { bps: null, filled, mid };
    return { bps: (Math.abs(cost / qty - mid) / mid) * 1e4, filled: 1, mid };
  };

  /**
   * One-minute oracle candles, fetched in 3,000-bar windows and kept for the run, so "the price exactly N minutes after a
   * fill" is two lookups and a straight line between those closes. Shared by every account of a snapshot build (the same
   * market-days come up again and again).
   */
  AN.candleCache = function (o) {
    const W = 3000 * 60000; const wins = new Map();
    const load = async (ticker, k) => {
      const key = ticker + '|' + k; if (wins.has(key)) return wins.get(key);
      const p = A.candles(ticker, '1', k * W, (k + 1) * W, 3000, o).then((rows) => { const m = new Map(); for (const c of rows) m.set(c.t, c.c); return m; }).catch(() => new Map());
      wins.set(key, p); return p;
    };
    return {
      /** close of the minute containing t (ms), or null when the window has no bar there */
      async at(ticker, t) { const minute = Math.floor(t / 60000) * 60000; const m = await load(ticker, Math.floor(minute / W)); const v = m.get(minute); return v == null ? null : U.num(v); },
      size() { return wins.size; },
    };
  };

  /**
   * Everything a would-be copier needs to know about an account, from its positions, fills and daily series:
   * sizes, hold times, markets, consistency, and the frictions of following (slippage at the account's size against
   * today's books, price drift in the minutes after each fill, taker fees). Returns a compact JSON block for the snapshot.
   *
   * `depth`: productId → book snapshot (AN.copyContext); `candles`: AN.candleCache. Both optional: without them the
   * friction fields stay null and the score falls back to hold-time proxies.
   */
  AN.COPY_SIZE = 2000;   // the copier this score is written for: a $2,000 position, or the leader's median size when that is smaller
  AN.buildCopyProfile = function ({ positions = [], daily = [], equity = 0, createdAt = null, ref, depth, decays }) {
    const now = Date.now();
    const ps = AN.positionStats(positions, ref);
    const closed = ps.closed;
    const r1 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
    const median = (arr) => { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
    const pct = (arr, p) => { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]; };   // nearest rank: the 90th percentile of 10 sizes is the 9th, not the largest
    const out = { closed: closed.length, open: ps.open.length, closed30: closed.filter((c) => U.num(c.p.updatedAt) > now - 30 * U.DAY).length, liq: ps.liquidated, adl: positions.filter((p) => p.wasDeleveraged).length };
    // hold times
    const holds = closed.map((c) => c.duration).filter((d) => d >= 0);
    out.holdMed = holds.length ? Math.round(median(holds)) : null;
    const bucket = (d) => (d < U.HOUR ? 'scalp' : d < U.DAY ? 'intra' : d < 7 * U.DAY ? 'swing' : 'long');
    out.hold = { scalp: 0, intra: 0, swing: 0, long: 0 }; for (const d of holds) out.hold[bucket(d)]++;
    // sizes (entry notional of each position: what a copier would mirror)
    const sizes = closed.concat(ps.open).map((c) => U.num(c.p.totalIncreaseNotional)).filter((x) => x > 0);
    out.notMed = sizes.length ? Math.round(median(sizes)) : null; out.notP90 = sizes.length ? Math.round(pct(sizes, 0.9)) : null;
    out.lev = out.notMed && equity > 0 ? Math.round((out.notMed / equity) * 100) / 100 : null;
    // markets (share of positions)
    const all = closed.concat(ps.open); const byT = U.groupBy(all, (c) => c.ticker);
    out.markets = Object.entries(byT).map(([t, arr]) => ({ t, n: arr.length, share: r1((arr.length / all.length) * 100) })).sort((a, b) => b.n - a.n).slice(0, 6);
    out.nMarkets = Object.keys(byT).length;
    // result per position in bps of entry notional: gross, and net of trading fees (funding left out on both sides)
    const withCost = closed.filter((c) => U.num(c.p.totalIncreaseNotional) > 0);
    const bps = (c) => (U.num(c.p.realizedPnl) / U.num(c.p.totalIncreaseNotional)) * 1e4;
    const costSum = U.sum(withCost, (c) => U.num(c.p.totalIncreaseNotional));
    out.grossBps = withCost.length ? r1(U.sum(withCost, (c) => U.num(c.p.realizedPnl)) / costSum * 1e4) : null;        // notional-weighted
    out.netFeeBps = withCost.length ? r1(U.sum(withCost, (c) => U.num(c.p.realizedPnl) - U.num(c.p.feesAccruedUsd) - U.num(c.p.positionFeeAccruedUsd)) / costSum * 1e4) : null;
    out.grossMedBps = withCost.length ? r1(median(withCost.map(bps))) : null;
    out.fundBps = withCost.length ? r1(U.sum(withCost, (c) => -U.num(c.p.fundingAccruedUsd)) / costSum * 1e4) : null;   // received, a copier gets it too
    // A copier at a fixed size gets each position's result in equal measure, so the edge is the plain per-position mean,
    // not the notional-weighted one; from 10 positions on, the most extreme 5% on each side (at least one position) is
    // winsorized so one jackpot or one blow-up cannot carry it; below 10 it is the plain mean. The t-statistic says
    // whether that mean is clear of the noise.
    const mean = (arr) => (arr.length ? U.sum(arr) / arr.length : null);
    const wins5 = (arr) => { if (arr.length < 10) return arr.slice(); const s = arr.slice().sort((a, b) => a - b); const k = Math.max(1, Math.floor(0.05 * s.length)); const lo = s[k], hi = s[s.length - 1 - k]; return arr.map((x) => Math.min(hi, Math.max(lo, x))); };
    const perPos = (f) => withCost.map((c) => (f(c) / U.num(c.p.totalIncreaseNotional)) * 1e4);
    const wGross = wins5(perPos((c) => U.num(c.p.realizedPnl)));
    const wNet = wins5(perPos((c) => U.num(c.p.realizedPnl) - U.num(c.p.feesAccruedUsd) - U.num(c.p.positionFeeAccruedUsd) - U.num(c.p.fundingAccruedUsd)));   // what the leader kept: gross − fees + funding received
    out.grossTrimBps = wGross.length ? r1(mean(wGross)) : null;
    out.nTrim = wNet.length;   // the count the mean is over: under 10 nothing is winsorized
    const leadRaw = wNet.length ? mean(wNet) : null;   // unrounded, for edge left
    out.netTrimBps = r1(leadRaw);
    const sd = wNet.length > 2 ? Math.sqrt(U.sum(wNet, (x) => (x - mean(wNet)) ** 2) / (wNet.length - 1)) : null;
    out.tStat = sd > 0 ? r1(mean(wNet) / (sd / Math.sqrt(wNet.length))) : null;
    const feesRaw = withCost.length ? mean(perPos((c) => U.num(c.p.feesAccruedUsd))) : null;   // the leader's trading fees per position: a copier pays its own instead
    out.feesBps = r1(feesRaw);
    out.posFeeBps = withCost.length ? r1(mean(perPos((c) => U.num(c.p.positionFeeAccruedUsd)))) : null;   // mPerp position fees: a copier holding the same position pays the same per unit, so they stay in the result, like funding
    out.fundPosBps = withCost.length ? r1(mean(perPos((c) => -U.num(c.p.fundingAccruedUsd)))) : null;
    const wins = closed.filter((c) => c.net > 0); const winSum = U.sum(wins, (c) => c.net);
    out.top = wins.length ? r1((Math.max(...wins.map((c) => c.net)) / winSum) * 100) : null;                             // largest win as % of all wins
    // consistency: profitable weeks among active weeks (flow-adjusted daily gains)
    const weeks = {}; let prevUp = null;
    // weeks from Monday 00:00 UTC (the epoch was a Thursday), as js/predict/analytics.js weekKey
    for (const b of daily) { const gain = b.pnl + (prevUp == null ? 0 : b.upnl - prevUp); prevUp = b.upnl; const k = Math.floor((b.t - 4 * U.DAY) / (7 * U.DAY)); const w = weeks[k] || (weeks[k] = { gain: 0, active: false }); w.gain += gain; if (b.volume > 0 || Math.abs(gain) > 0.005) w.active = true; }
    const active = Object.values(weeks).filter((w) => w.active);
    out.weeksActive = active.length; out.weeksPos = active.filter((w) => w.gain > 0).length;
    // activity
    const times = all.map((c) => U.num(c.p.updatedAt)).concat(all.map((c) => U.num(c.p.createdAt))).filter(Boolean);
    out.lastAt = times.length ? Math.max(...times) : null; out.firstAt = times.length ? Math.min(...times) : null;
    if (createdAt && (!out.firstAt || U.num(createdAt) < out.firstAt)) out.firstAt = U.num(createdAt);   // the position list is a window; the account's age is not
    out.tenureD = out.firstAt ? r1((now - out.firstAt) / U.DAY) : null;
    out.perWeek = out.firstAt && closed.length ? r1(closed.length / Math.max(1, (now - out.firstAt) / (7 * U.DAY))) : null;
    // frictions: slippage at the account's typical size against today's books, weighted by its market mix; and how much
    // of its 90th-percentile size the books absorb within 1% of the mid
    out.copySize = out.notMed ? Math.min(out.notMed, AN.COPY_SIZE) : null;
    if (depth && out.notMed && ref) {
      let w = 0, slipSum = 0, slipOwn = 0, fillSum = 0, feeSum = 0;
      const both = (book, notional) => { const s = AN.bookSlippage(book, true, notional), s2 = AN.bookSlippage(book, false, notional); const v = s.bps != null && s2.bps != null ? (s.bps + s2.bps) / 2 : s.bps != null ? s.bps : s2.bps; return v == null ? 60 : Math.min(v, 60); };   // unfillable counts as 60 bps
      for (const m of out.markets) {
        const prod = ref.byTicker[m.t] || Object.values(ref.byId).find((p) => p.displayTicker === m.t); if (!prod || !depth[prod.id]) continue;
        w += m.n; slipSum += both(depth[prod.id], out.copySize) * m.n; slipOwn += both(depth[prod.id], out.notMed) * m.n;
        const big = AN.bookSlippage(depth[prod.id], true, out.notP90 || out.notMed, 0.01); const ok = big.filled;   // the share of a 90th-percentile order the asks within 1% of the mid absorb
        fillSum += Math.max(0, Math.min(1, ok)) * m.n; feeSum += U.num(prod.takerFee) * 1e4 * m.n;
      }
      out.slipBps = w ? r1(slipSum / w) : null; out.slipOwnBps = w ? r1(slipOwn / w) : null; out.depthOk = w ? r1((fillSum / w) * 100) : null; out.feeBps = w ? r1(feeSum / w) : null;
    } else { out.slipBps = null; out.slipOwnBps = null; out.depthOk = null; out.feeBps = null; }
    // drift after the account's own fills (measured by the caller, which has the candles): notional-weighted bps a
    // copier gives up by acting exactly 1 and 5 minutes later, positive = worse price (fills more than 5% from the
    // oracle at the time are left out)
    out.drift1 = decays ? decays.drift1 : null; out.drift5 = decays ? decays.drift5 : null; out.driftN = decays ? decays.n : 0;
    // what is left for a copier per position: the leader's trimmed result plus funding (both sides get it) net of fees,
    // minus a copier's own taker fees, drift and slippage on the way in and out (fills per position ≈ 2)
    if (out.grossTrimBps != null && out.feeBps != null && out.slipBps != null && out.drift1 != null) {
      out.leaderBps = out.netTrimBps;
      out.copyBps = r1(out.netTrimBps + out.feesBps - 2 * (out.feeBps + out.slipBps + out.drift1));   // the leader's trading fees swapped for the copier's (from the rounded rows, so the page's waterfall adds up)
      // edge left from the unrounded means: a leader result near zero must not be divided at its rounded value.
      // A leader whose positions do not make money after fees leaves nothing to copy: a measured zero, not an unknown
      const copyRaw = leadRaw + feesRaw - 2 * (out.feeBps + out.slipBps + out.drift1);
      out.edgeLeft = out.leaderBps > 0 ? r1(Math.max(-100, (copyRaw / leadRaw) * 100)) : 0;
    } else { out.leaderBps = null; out.copyBps = null; out.edgeLeft = null; }
    return out;
  };

  /**
   * Price drift after each of an account's fills: for a buy, the move up exactly one minute (and five minutes) after it;
   * for a sell, the move down. A copier arriving later pays it. Notional-weighted bps over up to `max` fills (the newest
   * first, as the API returns them). Fills more than 5% from the oracle at the time are left out.
   */
  AN.fillDrift = async function (fills, ref, candles, max = 400) {
    const rows = fills.filter((f) => U.num(f.filled) > 0 && U.num(f.price) > 0).slice(0, max);
    let w = 0, d1 = 0, d5 = 0, n = 0;
    await U.pLimit(rows.map((f) => async () => {
      const prod = ref.byId[f.productId]; if (!prod) return;
      const t = U.num(f.createdAt), px = U.num(f.price), sign = U.sideName(f.side) === 'BUY' ? 1 : -1, notional = U.num(f.filled) * px;
      // the price exactly ms after the fill, interpolated between one-minute closes as the copy simulator does (null until that minute has closed)
      const after = async (ms) => { const target = t + ms; const m0 = Math.floor(t / 60000) * 60000, mT = Math.floor(target / 60000) * 60000; if (mT + 60000 > Date.now()) return null; const cT = await candles.at(prod.ticker, target); if (cT == null) return null; if (mT === m0) return px + (cT - px) * Math.min(1, ms / (m0 + 60000 - t)); const cP = await candles.at(prod.ticker, mT - 1); const from = cP == null ? px : cP; return from + (cT - from) * ((target - mT) / 60000); };
      const [p0, p1, p5] = await Promise.all([candles.at(prod.ticker, t), after(60000), after(5 * 60000)]);
      if (p1 == null || p5 == null) return;
      const ref0 = p0 != null ? p0 : p1;   // the oracle at the fill (a minute later when that bar is missing)
      if (Math.abs(px / ref0 - 1) > 0.05) return;   // a fill that swept a parked far quote ($1 bid, an ask 56% over the oracle) is not a move a copier pays, and notional-weighted it would outweigh every other fill
      w += notional; d1 += sign * ((p1 - px) / px) * 1e4 * notional; d5 += sign * ((p5 - px) / px) * 1e4 * notional; n++;
    }), 6);
    if (!n || !w) return { drift1: null, drift5: null, n: 0 };
    return { drift1: Math.round((d1 / w) * 10) / 10, drift5: Math.round((d5 / w) * 10) / 10, n };
  };

  /** Shared inputs for the copy profiles of one build: today's books for every active market, and a candle cache. */
  AN.copyContext = async function (ref, o) {
    const depth = {};
    await U.pLimit(ref.active.map((p) => async () => { try { depth[p.id] = await A.liquidity(p.id, o); } catch (_) {} }), 4);
    return { depth, candles: AN.candleCache(o) };
  };

  /**
   * Copyability score, 0–100, from a snapshot row's copy profile. Three pillars a copier cares about, each 0–100 with
   * its parts exposed for the page: track record (is there an edge, and is it steady), copy friction (how much of that
   * edge survives being copied a minute later at this size), activity (is the account still trading). Null when there
   * is not enough history to say anything (fewer than 5 closed positions).
   */
  AN.copyScore = function (row) {
    const c = row.copy; const s = (row.stats && row.stats.all) || {};
    if (!c || c.closed < 5) return null;
    const cl = (x, a, b) => Math.min(b, Math.max(a, x));
    const parts = [];
    const daysSince = c.lastAt ? (Date.now() - c.lastAt) / U.DAY : null;
    const add = (pillar, key, label, v, w, note) => { parts.push({ pillar, key, label, v: v == null ? null : cl(v, 0, 1), w, note }); };
    // track record
    add('track', 'sample', 'Sample size', cl(c.closed / 40, 0, 1), 0.15, `${c.closed} closed positions (40+ for full marks)`);
    add('track', 'profit', 'Profitability', s.pnl > 0 ? cl(0.3 + (s.roi || 0) / 30, 0.3, 1) : 0, 0.15, s.pnl > 0 ? `all-time PnL ${U.fmtUsd(s.pnl, { sign: true, dp: 0 })} · ROI ${s.roi == null ? '—' : U.fmtPct(s.roi, { dp: 0 })}` : 'not profitable so far');
    add('track', 'signal', 'Clear of noise', c.tStat == null ? null : cl(c.tStat / 4, 0, 1), 0.2, c.tStat == null ? 'too few positions to tell' : `per-position result ${U.fmtNum(c.netTrimBps, 1)} bps after fees and funding, t = ${U.fmtNum(c.tStat, 1)} (4+ for full marks: the mean is well clear of the noise)`);
    add('track', 'steady', 'Consistency', c.weeksActive >= 3 ? c.weeksPos / c.weeksActive : null, 0.2, c.weeksActive >= 3 ? `${c.weeksPos} of ${c.weeksActive} active weeks profitable (weeks start Monday 00:00 UTC)` : 'fewer than 3 active weeks');
    add('track', 'dd', 'Drawdown', s.ddPct == null ? null : cl(1 - s.ddPct / 40, 0, 1), 0.15, s.ddPct == null ? 'no drawdown on record' : `max drawdown ${U.fmtDd(s.ddPct)}`);
    add('track', 'liq', 'Liquidations', cl(1 - (c.liq / Math.max(c.closed, 1)) * 5, 0, 1), 0.1, c.liq ? `${c.liq} liquidated of ${c.closed}` : 'never liquidated');
    add('track', 'conc', 'Concentration', c.top == null ? null : cl(1 - (c.top - 30) / 70, 0, 1), 0.1, c.top == null ? 'no winning position yet' : `largest win is ${U.fmtPct(c.top, { dp: 0 })} of all wins`);
    // copy friction
    const scalp = c.closed ? c.hold.scalp / c.closed : 0, intra = c.closed ? c.hold.intra / c.closed : 0;
    const noEdge = c.leaderBps != null && c.leaderBps <= 0;   // edge left is 0 then, but not because of a copier's costs
    add('friction', 'edge', 'Edge left after copying', c.edgeLeft == null ? null : cl(c.edgeLeft / 100, 0, 1), 0.4, c.edgeLeft == null ? 'not measurable yet' : noEdge ? 'the leader\'s positions do not make money after fees and funding: no edge to keep' : c.edgeLeft > 100 ? `the copier keeps more per position than the leader (${U.fmtNum(c.copyBps, 1)} vs ${U.fmtNum(c.leaderBps, 1)} bps)` : c.edgeLeft <= 0 ? 'nothing survives a copier\'s fees, drift and slippage' : `${U.fmtPct(c.edgeLeft, { dp: 0 })} of the leader's per-trade result survives fees, drift and slippage`);
    add('friction', 'hold', 'Hold times', cl(1 - scalp - intra * 0.4, 0, 1), 0.25, `median hold ${c.holdMed == null ? '—' : U.fmtDuration(c.holdMed)} · ${U.fmtPct(scalp * 100, { dp: 0 })} scalps`);
    add('friction', 'slip', 'Slippage for a copier', c.slipBps == null ? null : cl(1 - c.slipBps / 30, 0, 1), 0.2, c.slipBps == null ? 'no book data' : `${U.fmtNum(c.slipBps, 1)} bps to enter ${U.fmtUsd(c.copySize || AN.COPY_SIZE, { compact: true, dp: 0 })} at today's depth` + (c.slipOwnBps != null && c.slipOwnBps > c.slipBps ? ` (${U.fmtNum(c.slipOwnBps, 1)} bps at their own ${U.fmtUsd(c.notMed, { compact: true, dp: 0 })})` : ''));
    add('friction', 'depth', 'Depth for their big trades', c.depthOk == null ? null : c.depthOk / 100, 0.15, c.depthOk == null ? 'no book data' : `${U.fmtPct(c.depthOk, { dp: 0 })} of a ${U.fmtUsd(c.notP90 || 0, { compact: true, dp: 0 })} order fills within 1%`);
    add('activity', 'recent', 'Recently active', daysSince == null ? 0 : cl(1 - daysSince / 14, 0, 1), 0.4, daysSince == null ? 'no activity' : `last trade ${U.fmtAgo(c.lastAt)}`);
    // under a week old, perWeek is the plain count (the week is not over): say so rather than call it a weekly rate
    add('activity', 'cadence', 'Cadence', c.perWeek == null ? 0 : cl(c.perWeek / 3, 0, 1), 0.3, c.perWeek == null ? '—' : c.tenureD < 7 ? `${c.closed} position${c.closed === 1 ? '' : 's'} closed in its first ${U.fmtDuration(Date.now() - c.firstAt)}` : `${U.fmtNum(c.perWeek, c.perWeek >= 10 ? 0 : 1)} positions closed per week`);
    add('activity', 'tenure', 'Track length', c.tenureD == null ? 0 : cl(c.tenureD / 30, 0, 1), 0.3, c.tenureD == null ? '—' : c.tenureD < 1 ? 'less than a day on the exchange' : `${U.fmtNum(c.tenureD, 0)} day${Math.round(c.tenureD) === 1 ? '' : 's'} on the exchange`);
    // a pillar is the weighted mean of its known parts (unknown parts are left out, not counted as zero)
    const pillar = (name) => { const ps = parts.filter((p) => p.pillar === name && p.v != null); const w = U.sum(ps, (p) => p.w); return w ? (U.sum(ps, (p) => p.v * p.w) / w) * 100 : 0; };
    const track = pillar('track'), friction = pillar('friction'), activity = pillar('activity');
    let total = 0.35 * track + 0.45 * friction + 0.2 * activity;
    const raw = total;   // before the caps, for the page's formula line
    // caps: a single disqualifier must not be averaged away by strong pillars. Each carries its reason for the page.
    const caps = [];
    const cap = (at, why) => { if (total > at) { total = at; } caps.push({ at, why }); };
    const losing = !(s.pnl > 0);
    if (losing) { total = Math.min(total * 0.6, 45); caps.push({ at: 45, why: 'not profitable so far' }); }
    if (noEdge) cap(40, 'the per-position result after fees and funding is not positive: no edge to copy');
    else if (c.edgeLeft != null && c.edgeLeft <= 0) cap(40, 'nothing survives copying: fees, drift and slippage exceed the per-position result');
    else if (c.edgeLeft != null && c.edgeLeft < 100) cap(Math.round(30 + c.edgeLeft * 0.7), `${U.fmtPct(c.edgeLeft, { dp: 0 })} of the per-position result survives copying`);   // graded: 57% left is the least that can be Copyable
    if (c.closed < 10) cap(55, `only ${c.closed} closed positions`); else if (c.closed < 20) cap(65, `only ${c.closed} closed positions`);
    if (c.tStat != null && c.tStat < 2 && c.closed >= 10) cap(60, `the per-position result is not clear of the noise (t = ${U.fmtNum(c.tStat, 1)})`);
    if (c.depthOk != null && c.depthOk < 50) cap(60, `their sizes exceed today's books (${U.fmtPct(c.depthOk, { dp: 0 })} of a ${U.fmtUsd(c.notP90 || 0, { compact: true, dp: 0 })} order fills within 1%)`);
    if (daysSince != null && daysSince > 60) cap(45, `no trade for ${Math.round(daysSince)} days`); else if (daysSince != null && daysSince > 30) cap(60, `no trade for ${Math.round(daysSince)} days`);
    if (c.closed && c.liq / c.closed >= 0.1) cap(55, `${c.liq} of ${c.closed} positions ended in liquidation`);
    if (c.top != null && c.top >= 60) cap(60, `one position is ${U.fmtPct(c.top, { dp: 0 })} of all wins`);
    if (s.ddPct != null && s.ddPct >= 40) cap(60, `max drawdown ${U.fmtDd(s.ddPct)}`);
    const verdict = losing ? 'Losing so far' : total >= 70 ? 'Copyable' : total >= 50 ? 'Copy with care' : 'Hard to copy';
    return { total: Math.round(total), raw: Math.round(raw), track: Math.round(track), friction: Math.round(friction), activity: Math.round(activity), verdict, losing, parts, caps: caps.filter((x) => x.at <= Math.round(total) + 0.5 || x.at === 45 && losing) };
  };

  /** Describe an order's stop / grouping semantics. */
  AN.orderMeta = function (o) {
    const stop = U.num(o.stopPrice) > 0;
    return {
      stop,
      kind: stop ? (String(o.stopType) === '0' ? 'TP' : 'SL') : null,
      trigger: String(o.stopPriceType) === '0' ? 'last' : 'mark',
      oco: !!o.groupId && String(o.groupContingencyType) === '1',
      oto: !!o.groupId && String(o.groupContingencyType) === '0',
      whole: !!o.close || U.num(o.quantity) === 0,
      pending: o.status === 'PENDING' || o.triggered === 'NOT_TRIGGERED',
    };
  };

  /**
   * Attach exit levels to accountState position rows from the account's active orders (working + pending).
   * Sets r.tp and r.sl: arrays of {price, qty (null = whole position), kind:'stop'|'limit', trigger, oco, distPct, pnl, order},
   * nearest to the mark first. Stops use the exchange's TP/SL type; a reduce-only limit order on the closing side
   * counts as a limit exit and is a take profit when it sits beyond the entry price.
   */
  AN.attachStops = function (rows, orders) {
    for (const r of rows) {
      const closingSide = r.long ? '1' : '0';
      const tp = [], sl = [];
      for (const o of orders || []) {
        if (o.productId !== r.p.productId || String(o.side) !== closingSide) continue;
        if (!/^(NEW|PENDING|FILLED_PARTIAL)$/.test(o.status)) continue;
        const m = AN.orderMeta(o);
        let price, kind;
        if (m.stop) { price = U.num(o.stopPrice); kind = 'stop'; }
        else { if (!(o.reduceOnly || o.close)) continue; price = U.num(o.price); if (!(price > 0)) continue; kind = 'limit'; }
        // availableQuantity does not go down as the order fills, so the unfilled part is it less what has filled
        const remaining = Math.max(0, (U.num(o.availableQuantity) || U.num(o.quantity)) - U.num(o.filled));
        if (!m.whole && !(remaining > 0)) continue;   // a fully consumed remainder is not a whole-position exit
        const qty = m.whole ? null : Math.min(remaining, r.abs);
        const ref = r.mark || r.entry;
        const distPct = ref > 0 ? ((price - ref) / ref) * 100 : null;
        const pnl = (r.long ? 1 : -1) * (qty == null ? r.abs : qty) * (price - r.entry);
        const e = { price, qty, kind, trigger: m.trigger, oco: m.oco, distPct, pnl, order: o };
        const isTp = m.stop ? m.kind === 'TP' : (r.long ? price >= r.entry : price <= r.entry);
        (isTp ? tp : sl).push(e);
      }
      const near = (a, b) => Math.abs(a.distPct == null ? 0 : a.distPct) - Math.abs(b.distPct == null ? 0 : b.distPct);
      r.tp = tp.sort(near); r.sl = sl.sort(near);
    }
    return rows;
  };

  // ---------- the order book, order by order ----------
  // The public book (L2Book, market-liquidity) has every price level but not who rests there. Every subaccount's
  // working orders (GET /v1/order?isWorking=true, public per subaccount) add up to it level by level, so read from all
  // subaccounts they give each resting limit order with the account that placed it.

  /** The resting limit orders among order rows (A.openOrders / A.activeOrders): a LIMIT that is live (not a stop still
   *  waiting for its trigger, not pending) with quantity left. owner(subaccountId) → the account address, if known.
   *  Returns [{id, sid, account, productId, side 'a' (sell) | 'b' (buy), price, qty (the unfilled part, as the book
   *  shows it), createdAt, expiresAt (ms, null if none), postOnly, reduceOnly}]. */
  AN.restingOrders = function (rows, owner) {
    const out = [];
    for (const o of rows || []) {
      if (!o || o.type !== 'LIMIT' || o.triggered === 'NOT_TRIGGERED' || !(o.status === 'NEW' || o.status === 'FILLED_PARTIAL')) continue;
      const price = U.num(o.price);
      // availableQuantity does not go down as the order fills (AN.attachStops): the unfilled part is it less what filled
      const qty = Math.max(0, (U.num(o.availableQuantity) || U.num(o.quantity)) - U.num(o.filled));
      if (!(price > 0) || !(qty > 0)) continue;
      out.push({ id: o.id, sid: o.subaccountId, account: owner ? owner(o.subaccountId) || null : null, productId: o.productId,
        side: String(o.side) === '1' || o.side === 'SELL' ? 'a' : 'b', price, qty, createdAt: U.num(o.createdAt) || null,
        expiresAt: U.num(o.expiresAt) > 0 ? U.num(o.expiresAt) * 1000 : null, postOnly: !!o.postOnly, reduceOnly: !!o.reduceOnly });
    }
    return out;
  };

  /** One product's resting orders summed per side and price: {a: Map price → qty, b: Map}. */
  AN.ordersAtLevels = function (orders, productId) {
    const lv = { a: new Map(), b: new Map() };
    for (const o of orders || []) if (o.productId === productId) lv[o.side].set(o.price, (lv[o.side].get(o.price) || 0) + o.qty);
    return lv;
  };

  /** The orders against the live book (asks, bids: Maps price → qty): levels where the two agree, and those that do not
   *  ({side, price, book, orders}, either 0 where it has nothing). Quantities carry 9 decimals; sums are compared to that. */
  AN.bookCheck = function (asks, bids, orders, productId) {
    const lv = AN.ordersAtLevels(orders, productId), differ = []; let matched = 0;
    for (const [side, live] of [['a', asks], ['b', bids]]) {
      for (const p of new Set([...live.keys(), ...lv[side].keys()])) {
        const b = Math.max(0, live.get(p) || 0), q = lv[side].get(p) || 0;
        if (!(b > 0) && !(q > 0)) continue;
        if (Math.abs(b - q) <= 1e-9 * Math.max(1, b)) matched++; else differ.push({ side, price: p, book: b, orders: q });
      }
    }
    return { matched, differ };
  };

  /** Interval start timestamp for an interval key. */
  AN.startFor = (interval, accountCreatedAt) => {
    const len = AN.INTERVALS[interval];
    if (len === Infinity) return Math.max(0, Math.floor((accountCreatedAt || 1787900000000) / U.DAY) * U.DAY);
    return Date.now() - len;
  };
})();
