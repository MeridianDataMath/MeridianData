/* MeridianDataHub — account analytics: series building, interval stats, position stats, margin state */
(function () {
  const MD = window.MD; const U = MD.util; const A = MD.api;
  const AN = (MD.analytics = {});

  AN.INTERVALS = { '24h': U.DAY, '7d': 7 * U.DAY, '30d': 30 * U.DAY, all: Infinity };
  /** Resolution used for each interval's series. */
  AN.resFor = (interval) => ({ '24h': 'hour1', '7d': 'hour2', '30d': 'hour8', all: 'day1' }[interval] || 'day1');

  /**
   * Merge archive rows (balance per token, unrealized pnl per token, volume) into one series.
   * Every bucket: {t, balance, upnl, equity, realizedPnl, fee (paid, positive), funding (signed, + received),
   * pnl (= realized + fee delta + funding), deposit, withdrawal (positive), volume}
   */
  AN.buildSeries = function ({ balance = [], upnl = [], volume = [] }) {
    const m = new Map();
    const at = (t) => { let b = m.get(t); if (!b) { b = { t, balance: 0, upnl: 0, realizedPnl: 0, fee: 0, funding: 0, deposit: 0, withdrawal: 0, wfee: 0, volume: 0, hasBalance: false }; m.set(t, b); } return b; };
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
        prev = r;
      }
    }
    for (const r of upnl) { const b = at(r.time); b.upnl += U.num(r.unrealizedPnl); }
    for (const r of volume) { const b = at(r.time); b.volume += U.num(r.volumeUsd); }
    const rows = Array.from(m.values()).sort((a, b) => a.t - b.t);
    // carry balance forward across buckets that only had upnl/volume rows
    let lastBal = 0;
    for (const b of rows) { if (b.hasBalance) lastBal = b.balance; else b.balance = lastBal; b.pnl = b.realizedPnl - b.fee + b.funding; b.equity = b.balance + b.upnl; }
    return rows;
  };

  /** Fetch + build the series for a subaccount over [start, now]. Adds one prior bucket for deltas. */
  AN.loadSeries = async function (sid, { start, resolution, signal, ttl, withVolume = true }) {
    const res = A.RES[resolution];
    const s = Math.max(0, Math.floor(start / res.ms) * res.ms - res.ms);
    const [balance, upnl, volume] = await Promise.all([
      A.history('balance', sid, { start: s, resolution, signal, ttl }),
      A.history('unrealized-pnl', sid, { start: s, resolution, signal, ttl }),
      withVolume ? A.history('volume', sid, { start: s, resolution, signal, ttl }) : Promise.resolve([]),
    ]);
    return AN.buildSeries({ balance, upnl, volume });
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
    let realized = 0, fees = 0, funding = 0, volume = 0, deposits = 0, withdrawals = 0;
    for (const b of inRange) { realized += b.pnl; fees += b.fee; funding += b.funding; volume += b.volume; deposits += b.deposit; withdrawals += b.withdrawal; }
    const last = inRange.length ? inRange[inRange.length - 1] : prev;
    const upnlEnd = live && live.upnl != null ? live.upnl : last ? last.upnl : 0;
    const pnl = realized + (upnlEnd - upnlStart);
    // Drawdown on a flow-adjusted curve (deposits/withdrawals removed → trading losses only).
    // ddUsd = loss since the high-water mark; ddPct = that loss relative to the equity the account
    // would have without it (real equity + loss), so capital added after the peak is respected.
    const curve = [{ t: start, v: eqStart, eq: eqStart }];
    let acc = eqStart, pu = upnlStart;
    for (const b of inRange) { acc += b.pnl + (b.upnl - pu); pu = b.upnl; curve.push({ t: b.t, v: acc, eq: b.equity }); }
    if (live && live.upnl != null && live.equity != null) curve.push({ t: Date.now(), v: acc + (live.upnl - pu), eq: live.equity });
    let peak = -Infinity, ddUsd = 0, ddPct = 0;
    for (const p of curve) {
      if (p.v > peak) peak = p.v;
      const d = peak - p.v;
      if (d > 0.005) {
        if (d > ddUsd) ddUsd = d;
        const base = p.eq + d;
        if (base > 0) { const pct = (d / base) * 100; if (pct > ddPct) ddPct = pct; }
      }
    }
    // returns per bucket (PnL-based, on prior equity)
    const rets = [];
    let prevEq = eqStart, prevUp = upnlStart;
    for (const b of inRange) {
      const gain = b.pnl + (b.upnl - prevUp);
      if (prevEq > 1) rets.push(gain / prevEq);
      prevEq = b.equity; prevUp = b.upnl;
    }
    // Sharpe from a handful of buckets is noise (its standard error is ~1/√n), so it needs at least 10 buckets:
    // the 7-day interval (7 daily buckets) therefore shows none; 24h uses hourly buckets, 30d / all use daily.
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
    return { pnl, realized, fees, funding, volume, deposits, withdrawals, upnlStart, upnlEnd, eqStart, ddUsd, ddPct, sharpe, roi, buckets: inRange.length, curve };
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
    return { equity, balance, upnl, notional, used, available, leverage: equity > 0 ? notional / equity : null, marginRatio: mmTotal > 0 ? equity / mmTotal : null, pools: poolList.sort((a, b) => b.equity - a.equity), positions: rows.sort((a, b) => b.notional - a.notional) };
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
    if (acct.balance === 0 && !positionsOpen.length && !vol) {
      row.inactive = true;
      for (const iv of Object.keys(AN.INTERVALS)) row.stats[iv] = { pnl: 0, volume: 0, roi: null, sharpe: null, ddPct: null, fees: 0, funding: 0 };
      return row;
    }
    const [positions, daily, hourly] = await Promise.all([
      A.positions(sid, { maxPages: 3, signal: o.signal }),
      AN.loadSeries(sid, { start: AN.startFor('all', sa.createdAt), resolution: 'day1', signal: o.signal, ttl: 60000 }),
      AN.loadSeries(sid, { start: Date.now() - U.DAY, resolution: 'hour1', signal: o.signal, ttl: 60000 }),
    ]);
    const ps = AN.positionStats(positions, ref);
    row.winRate = ps.winRate; row.positionsCount = ps.count; row.style = ps.style; row.closedCount = ps.closed.length; row.liquidated = ps.liquidated;
    const live = { upnl: acct.upnl, equity: acct.equity };
    const pick = (s) => ({ pnl: s.pnl, volume: s.volume, roi: s.roi, sharpe: s.sharpe, ddPct: s.ddPct, fees: s.fees, funding: s.funding });
    for (const iv of ['7d', '30d', 'all']) row.stats[iv] = pick(AN.intervalStats(daily, AN.startFor(iv, sa.createdAt), live, U.DAY));
    row.stats['24h'] = pick(AN.intervalStats(hourly, Date.now() - U.DAY, live, U.HOUR));
    return row;
  };

  /** A leaderboard row that never traded: no volume and no positions. The exchange's fee-collector subaccount is one —
   *  its "PnL" is fees received — so lists of traders leave these out and the leaderboard labels them. */
  AN.noTrades = (r) => !(U.num(r.volumeAll) > 0) && !(r.positionsCount > 0) && !(r.openCount > 0);

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
        const remaining = U.num(o.availableQuantity) || U.num(o.quantity);
        const qty = m.whole || !(remaining > 0) ? null : Math.min(remaining, r.abs);
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

  /** Interval start timestamp for an interval key. */
  AN.startFor = (interval, accountCreatedAt) => {
    const len = AN.INTERVALS[interval];
    if (len === Infinity) return Math.max(0, Math.floor((accountCreatedAt || 1787900000000) / U.DAY) * U.DAY);
    return Date.now() - len;
  };
})();
