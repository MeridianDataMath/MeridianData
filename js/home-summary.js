/* MeridianDataHub — the home page's summary: the few rows and figures the home page shows, cut from the published
   leaderboard and Predict snapshots. Each deploy writes it to data/home.json (scripts/build-home.mjs), so the home page
   reads a few KB instead of both snapshots (about 2.3 MB); a browser that finds no such file builds the same from the
   snapshots themselves. Pure: no network, no DOM, so it runs in Node too. */
(function () {
  const MD = window.MD; const U = MD.util; const AN = MD.analytics; const P = MD.predict;
  const HS = (MD.homeSummary = {});
  HS.ROWS = 5;          // rows per card
  HS.BOOKS = 8;         // the accounts whose open positions the Biggest open positions card reads live
  HS.WEEK_DAYS = 7;     // the Predict button's figure: what was wagered over the last 7 UTC days, today included

  /** The traders among the leaderboard's rows: Meridian's own accounts (the liquidator, the fee collector: AN.KNOWN, and
   *  any row with no trades) and the market makers are left out, as from every list of traders to copy, and so are the
   *  wallets the site leaves out (U.EXCLUDED:
   *  a snapshot from before they were has them, and the deploy reads the file without the Leaderboard's filter). */
  HS.traders = (rows) => rows.filter((r) => r && !r.inactive && r.stats && r.stats.all && !U.isExcluded(r.account) && !AN.noTrades(r) && !AN.exchangeAccount(r) && !AN.marketMaker(r));
  /** When a big win counts, as the Overview's Recent sorts them: a win from its settlement, a cash-out from its last sale. */
  HS.winAt = (n) => (P.fromSale(n) ? n.cashOut.t : P.decidedAt(n));
  // a top row keeps what the card and its tooltips read (AN.sitePnlTitle reads basis and stats.all)
  const topRow = (r) => ({ account: r.account, sid: r.sid, name: r.name, style: r.style, basis: r.basis, carried: r.carried || undefined, builtAt: r.carried ? r.builtAt : undefined, stats: { all: r.stats.all } });

  /** The summary of a leaderboard snapshot (lb), a Predict snapshot (snap, with its agg) and the Predict status file
   *  (status); a part whose source is missing is left out. Wins and bets stay in the snapshot's own slim and compact
   *  forms (P.full opens them). */
  HS.build = ({ lb = null, snap = null, status = null, now = Date.now() } = {}) => {
    const out = { builtAt: now };
    if (lb && Array.isArray(lb.rows)) {
      const tr = HS.traders(lb.rows);
      out.lb = {
        builtAt: lb.builtAt, cov: AN.snapshotCoverage(lb), accounts: lb.rows.length,
        top: U.sortBy(tr, (r) => r.stats.all.pnl, true).slice(0, HS.ROWS).map(topRow),
        copyable: tr.filter((r) => { const sc = AN.copyScore(r); return !!(sc && sc.verdict === 'Copyable'); }).length,
        // the biggest open books as of the snapshot: the home page reads their positions live
        books: U.sortBy(tr.filter((r) => r.openCount > 0 && U.num(r.notional) > 0), (r) => U.num(r.notional), true).slice(0, HS.BOOKS).map((r) => ({ account: r.account, sid: r.sid })),
      };
    }
    if (snap && snap.agg) {
      const a = snap.agg;
      const wins = (a.bigWins || []).map((x) => ({ x, n: P.full(x) })).filter((w) => P.bigPnl(w.n) > P.BIG_WIN);
      // a snapshot from before agg.bigBets: the big ones among its newest 25
      const bets = a.bigBets ? a.bigBets.slice(0, HS.ROWS) : (a.tape || []).filter((x) => x.stake >= P.BIG_BET).slice(0, HS.ROWS);
      const from = Math.floor(now / U.DAY) * U.DAY - (HS.WEEK_DAYS - 1) * U.DAY;
      const week = (a.daily || []).filter((d) => d.t >= from);
      out.predict = {
        builtAt: snap.builtAt, hasWins: !!a.bigWins, fullBets: !!a.bigBets,
        wins: U.sortBy(wins, (w) => HS.winAt(w.n), true).slice(0, HS.ROWS).map((w) => w.x),
        bets,
        week: { wagered: U.sum(week, (d) => d.wagered), n: U.sum(week, (d) => d.n) },
      };
    }
    if (status) out.status = { builtAt: status.builtAt, bettors: status.bettors, predictions: status.predictions, questionsLive: status.questionsLive };
    return out;
  };
})();
