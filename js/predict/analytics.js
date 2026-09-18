/* MeridianDataHub — Predict analytics: normalise predictions and aggregate bettors, makers, vig, categories, combos, series.
   Shared by the browser and scripts/build-snapshot.mjs (Node). */
(function () {
  const MD = window.MD; const U = MD.util;
  const P = (MD.predict = MD.predict || {});
  const DAY = 86400000;

  /** Normalise one raw prediction into plain numbers. */
  P.norm = function (p) {
    const stake = P.usd(p.predictorCollateral), cp = P.usd(p.counterpartyCollateral), pool = stake + cp;
    const picks = ((p.pickConfig && p.pickConfig.picks) || []).map((k) => {
      const c = k.condition || {};
      const ep = c.estimatedPrice == null ? null : Number(c.estimatedPrice);
      const yes = String(k.predictedOutcome).toUpperCase() === 'YES';
      return { id: k.conditionId, q: c.question || c.shortName || k.conditionId, short: c.shortName || c.question || '', yes, ep, fair: ep == null ? null : (yes ? ep : 1 - ep), priceAtBet: k.priceAtBet == null ? null : Number(k.priceAtBet), event: k.event || null, settled: !!c.settled, resolvedToYes: c.resolvedToYes, nonDecisive: !!c.nonDecisive, cat: (c.category && c.category.name) || 'Other', catSlug: (c.category && c.category.slug) || 'other', endTime: c.endTime ? c.endTime * 1000 : null, tags: c.tags || [] };
    });
    let fair = null;
    if (picks.length && picks.every((k) => k.fair != null)) { fair = 1; for (const k of picks) fair *= k.fair; }
    const odds = pool > 0 ? stake / pool : null;
    const cats = Array.from(new Set(picks.map((k) => k.cat)));
    const settled = !!p.settled;
    const won = settled && p.result === 'PREDICTOR_WINS';
    const n = {
      id: p.predictionId, t: P.ms(p.createdAt), settledAt: p.settledAt ? P.ms(p.settledAt) : null,
      predictor: String(p.predictor || '').toLowerCase(), counterparty: String(p.counterparty || '').toLowerCase(),
      stake, cp, pool, odds, multiple: stake > 0 ? pool / stake : null,
      legs: picks.length, combo: picks.length > 1, picks, fair,
      // fairNow / vigNow: against the source market's price as the API reports it now (hindsight for settled bets).
      // fair-at-bet / vig: against the source's price at the moment of the bet (Polymarket price history), set by P.applyAtBet.
      fairNow: fair, vigNow: odds != null && fair != null ? odds - fair : null,
      fairAtBet: null, vig: null, vigPct: null,
      cat: cats.length === 1 ? cats[0] : cats.length > 1 ? 'Mixed' : 'Other', cats,
      settled, result: p.result || null, won, lost: settled && !won,
      pnl: settled ? (won ? cp : -stake) : 0,                             // bettor's realised result
      endsAt: p.pickConfig && p.pickConfig.endsAt ? P.ms(p.pickConfig.endsAt) : null,
      tx: p.createTxHash || null,
    };
    P.applyAtBet(n, picks.map((k) => k.priceAtBet));
    return n;
  };
  /** Attach the source market's YES price at bet time for each leg (null = unknown) and derive fair-at-bet and the true vig:
   *  locked odds − fair-at-bet, > 0 when the bettor paid above the price the source market showed at that moment. */
  P.applyAtBet = function (n, prices) {
    let fair = 1, ok = n.picks.length > 0;
    n.picks.forEach((k, i) => { const p = prices && prices[i] != null && Number.isFinite(Number(prices[i])) ? Number(prices[i]) : null; k.priceAtBet = p; k.fairAtBet = p == null ? null : (k.yes ? p : 1 - p); if (p == null) ok = false; else fair *= k.fairAtBet; });
    n.fairAtBet = ok ? fair : null;
    n.vig = ok && n.odds != null ? n.odds - fair : null;
    n.vigPct = ok && n.odds != null && fair ? (n.odds - fair) / fair : null;
    // combos whose legs sit on the same Polymarket event are correlated, so "fair = product of the legs" understates fair
    // and the measured vig includes the maker's correlation pricing; sameEvent is null when an event is unknown
    const evs = n.picks.map((k) => k.event);
    n.sameEvent = n.picks.length < 2 ? false : evs.some((e) => !e) ? null : new Set(evs).size < evs.length;
    return n;
  };

  /** Compact row for the tape / snapshot. */
  P.compact = (n) => ({ id: n.id, t: n.t, predictor: n.predictor, counterparty: n.counterparty, stake: r4(n.stake), cp: r4(n.cp), odds: n.odds == null ? null : r4(n.odds), fair: n.fair == null ? null : r4(n.fair), legs: n.legs, q: n.picks[0] ? n.picks[0].q : '', yes: n.picks[0] ? n.picks[0].yes : null, cat: n.cat, settled: n.settled, won: n.won, pnl: r4(n.pnl) });
  const r4 = (x) => (x == null ? null : Math.round(x * 1e4) / 1e4);
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const median = (arr) => { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const dayKey = (ms) => Math.floor(ms / DAY) * DAY;
  const weekKey = (ms) => Math.floor((ms - 4 * DAY) / (7 * DAY)) * 7 * DAY + 4 * DAY;   // Monday 00:00 UTC

  /** Aggregate normalised predictions. Returns plain JSON. */
  P.aggregate = function (norms, { tapeSize = 100 } = {}) {
    const bettors = {}, makers = {}, cats = {}, combos = {}, daily = {}, weeks = {};
    const acc = (m, k, init) => m[k] || (m[k] = init());
    const side = () => ({ n: 0, wagered: 0, open: 0, openWagered: 0, settled: 0, won: 0, lost: 0, pnl: 0, combos: 0, legs: 0, oddsSum: 0, oddsN: 0, vigSum: 0, vigN: 0, biggestWin: 0, biggestStake: 0, first: null, last: null, cats: {} });
    const bump = (s, n, asMaker) => {
      s.n++; s.wagered += asMaker ? n.cp : n.stake; s.legs += n.legs; if (n.combo) s.combos++;
      if (n.odds != null) { s.oddsSum += n.odds; s.oddsN++; }
      if (cleanVig(n)) { s.vigSum += n.vig; s.vigN++; }
      if (n.settled) { s.settled++; const w = asMaker ? n.lost : n.won; if (w) s.won++; else s.lost++; const pnl = asMaker ? -n.pnl : n.pnl; s.pnl += pnl; if (pnl > s.biggestWin) s.biggestWin = pnl; }
      else { s.open++; s.openWagered += asMaker ? n.cp : n.stake; }
      const st = asMaker ? n.cp : n.stake; if (st > s.biggestStake) s.biggestStake = st;
      if (s.first == null || n.t < s.first) s.first = n.t; if (s.last == null || n.t > s.last) s.last = n.t;
      s.cats[n.cat] = (s.cats[n.cat] || 0) + 1;
    };
    const finish = (s) => { s.winRate = s.settled ? (s.won / s.settled) * 100 : null; s.roi = s.settled ? (s.pnl / Math.max(1e-9, s.wagered - s.openWagered)) * 100 : null; s.avgOdds = s.oddsN ? s.oddsSum / s.oddsN : null; s.avgVig = s.vigN ? s.vigSum / s.vigN : null; s.avgLegs = s.n ? s.legs / s.n : null; s.topCat = Object.keys(s.cats).sort((a, b) => s.cats[b] - s.cats[a])[0] || null; delete s.oddsSum; delete s.oddsN; delete s.vigSum; delete s.vigN; delete s.legs; return s; };
    // a defensible vig needs a defensible fair: singles and combos across different events; same-event legs are correlated
    const cleanVig = (n) => n.vig != null && n.sameEvent !== true;
    const vigAll = [], vigByCat = {};
    let totals = { n: 0, wagered: 0, cpCommitted: 0, settled: 0, won: 0, lost: 0, bettorPnl: 0, open: 0, openWagered: 0, combos: 0 };
    for (const n of norms) {
      totals.n++; totals.wagered += n.stake; totals.cpCommitted += n.cp; if (n.combo) totals.combos++;
      if (n.settled) { totals.settled++; if (n.won) totals.won++; else totals.lost++; totals.bettorPnl += n.pnl; } else { totals.open++; totals.openWagered += n.stake; }
      const b = acc(bettors, n.predictor, side); bump(b, n, false);
      const m = acc(makers, n.counterparty, side); bump(m, n, true);
      const c = acc(cats, n.cat, () => ({ cat: n.cat, n: 0, wagered: 0, settled: 0, won: 0, pnl: 0, vig: [] })); c.n++; c.wagered += n.stake; if (n.settled) { c.settled++; if (n.won) c.won++; c.pnl += n.pnl; } if (cleanVig(n)) c.vig.push(n.vig);
      const k = acc(combos, n.legs, () => ({ legs: n.legs, n: 0, settled: 0, won: 0, wagered: 0, pnl: 0, odds: [], multiples: [] })); k.n++; k.wagered += n.stake; if (n.settled) { k.settled++; if (n.won) k.won++; k.pnl += n.pnl; } if (n.odds != null) k.odds.push(n.odds); if (n.multiple != null) k.multiples.push(n.multiple);
      const d = acc(daily, dayKey(n.t), () => ({ t: dayKey(n.t), n: 0, wagered: 0, bettors: new Set(), settledPnl: 0, settledN: 0 })); d.n++; d.wagered += n.stake; d.bettors.add(n.predictor);
      if (n.settledAt) { const ds = acc(daily, dayKey(n.settledAt), () => ({ t: dayKey(n.settledAt), n: 0, wagered: 0, bettors: new Set(), settledPnl: 0, settledN: 0 })); ds.settledPnl += n.pnl; ds.settledN++; }
      if (cleanVig(n)) { vigAll.push(n); const wk = acc(weeks, weekKey(n.t), () => ({ t: weekKey(n.t), vig: [], n: 0, wagered: 0 })); wk.vig.push(n.vig); wk.n++; wk.wagered += n.stake; (vigByCat[n.cat] || (vigByCat[n.cat] = [])).push(n.vig); }
    }
    const rowsOf = (m, key) => Object.keys(m).map((a) => Object.assign({ [key]: a }, finish(m[a])));
    const vigSummary = (list) => ({ n: list.length, avg: avg(list), median: median(list), share: list.length ? list.filter((v) => v > 0).length / list.length : null });
    const vig = {
      overall: vigSummary(vigAll.map((n) => n.vig)),
      weighted: vigAll.length ? vigAll.reduce((a, n) => a + n.vig * n.stake, 0) / Math.max(1e-9, vigAll.reduce((a, n) => a + n.stake, 0)) : null,
      byCat: Object.keys(vigByCat).map((c) => Object.assign({ cat: c }, vigSummary(vigByCat[c]))).sort((a, b) => b.n - a.n),
      singles: vigSummary(vigAll.filter((n) => !n.combo).map((n) => n.vig)),
      combosOnly: vigSummary(vigAll.filter((n) => n.combo).map((n) => n.vig)),                       // combos across different events (in the headline)
      combosSameEvent: vigSummary(norms.filter((n) => n.vig != null && n.sameEvent === true).map((n) => n.vig)),   // legs on one Polymarket event: includes correlation pricing, kept out of the headline
      combosUnknown: vigSummary(norms.filter((n) => n.vig != null && n.combo && n.sameEvent == null).map((n) => n.vig)),
      byOddsBucket: [[0, 0.1], [0.1, 0.25], [0.25, 0.5], [0.5, 0.75], [0.75, 0.9], [0.9, 1.01]].map(([a, b]) => Object.assign({ from: a, to: Math.min(1, b) }, vigSummary(vigAll.filter((n) => n.odds >= a && n.odds < b).map((n) => n.vig)))),
      weekly: Object.values(weeks).sort((a, b) => a.t - b.t).map((w) => ({ t: w.t, n: w.n, wagered: w.wagered, avg: avg(w.vig), median: median(w.vig) })),
      // how many predictions have a source price at bet time (the rest have no Polymarket history yet or no source market)
      coverage: { withAtBet: norms.filter((n) => n.vig != null).length, clean: vigAll.length, sameEvent: norms.filter((n) => n.vig != null && n.sameEvent === true).length, total: norms.length, source: 'polymarket-history' },
    };
    return {
      totals: Object.assign(totals, { bettors: Object.keys(bettors).length, makers: Object.keys(makers).length, winRate: totals.settled ? (totals.won / totals.settled) * 100 : null }),
      bettors: rowsOf(bettors, 'address').sort((a, b) => b.pnl - a.pnl),
      makers: rowsOf(makers, 'address').sort((a, b) => b.n - a.n),
      categories: Object.values(cats).map((c) => ({ cat: c.cat, n: c.n, wagered: c.wagered, settled: c.settled, won: c.won, winRate: c.settled ? (c.won / c.settled) * 100 : null, pnl: c.pnl, avgVig: avg(c.vig) })).sort((a, b) => b.wagered - a.wagered),
      combos: Object.values(combos).map((k) => ({ legs: k.legs, n: k.n, settled: k.settled, won: k.won, winRate: k.settled ? (k.won / k.settled) * 100 : null, wagered: k.wagered, pnl: k.pnl, avgOdds: avg(k.odds), avgMultiple: avg(k.multiples), medianMultiple: median(k.multiples) })).sort((a, b) => a.legs - b.legs),
      daily: Object.values(daily).sort((a, b) => a.t - b.t).map((d) => ({ t: d.t, n: d.n, wagered: d.wagered, bettors: d.bettors.size, settledPnl: d.settledPnl, settledN: d.settledN })),
      vig,
      tape: norms.slice().sort((a, b) => b.t - a.t).slice(0, tapeSize).map(P.compact),
    };
  };

  /** Bettor-level summary from that bettor's own predictions (subset of aggregate). */
  P.bettorSummary = (norms) => { const a = P.aggregate(norms, { tapeSize: 0 }); return { stats: a.bettors[0] || null, categories: a.categories, combos: a.combos, daily: a.daily, makers: a.makers }; };

  /** Slim record for the per-wallet snapshot files (≈400 bytes); P.unslim restores everything P.norm produces. */
  // Open predictions keep the leg's conditionId (6th element) so the resolution tracker can look the market up; settled ones don't need it.
  // leg = [question, yes, sourcePriceNow, endTime, category, conditionId (open predictions only), priceAtBet, polymarket event]
  P.slim = (n) => ({ id: n.id, t: n.t, sa: n.settledAt, p: n.predictor, c: n.counterparty, s: r4(n.stake), cp: r4(n.cp), st: n.settled ? 1 : 0, r: n.result, tx: n.tx, cat: n.cat, k: n.picks.map((k) => { const a = [k.q, k.yes ? 1 : 0, k.ep, k.endTime, k.cat, !n.settled && k.id ? k.id : null, k.priceAtBet == null ? null : r4(k.priceAtBet), n.picks.length > 1 ? k.event || null : null]; while (a.length > 5 && a[a.length - 1] == null) a.pop(); return a; }) });
  P.unslim = function (s) {
    if (s.picks) return s;                               // already a full record
    const stake = s.s || 0, cp = s.cp || 0, pool = stake + cp;
    const picks = (s.k || []).map(([q, yes, ep, endTime, cat, id, pb, ev]) => ({ id: id || null, q, short: q, yes: !!yes, ep, fair: ep == null ? null : (yes ? ep : 1 - ep), priceAtBet: pb == null ? null : pb, event: ev || null, settled: false, resolvedToYes: null, nonDecisive: false, cat: cat || s.cat, catSlug: null, endTime: endTime || null, tags: [] }));
    let fair = null; if (picks.length && picks.every((k) => k.fair != null)) { fair = 1; for (const k of picks) fair *= k.fair; }
    const odds = pool > 0 ? stake / pool : null; const settled = !!s.st; const won = settled && s.r === 'PREDICTOR_WINS';
    const n = { id: s.id, t: s.t, settledAt: s.sa || null, predictor: s.p, counterparty: s.c, stake, cp, pool, odds, multiple: stake > 0 ? pool / stake : null, legs: picks.length, combo: picks.length > 1, picks, fair, fairNow: fair, vigNow: odds != null && fair != null ? odds - fair : null, fairAtBet: null, vig: null, vigPct: null, cat: s.cat, cats: Array.from(new Set(picks.map((k) => k.cat))), settled, result: s.r || null, won, lost: settled && !won, pnl: settled ? (won ? cp : -stake) : 0, endsAt: null, tx: s.tx || null };
    return P.applyAtBet(n, picks.map((k) => k.priceAtBet));
  };

  /** Daily account history reconstructed from a wallet's own predictions (used when the API is not reachable). */
  P.historyFromPredictions = function (norms, address, asMaker) {
    const days = {};
    const at = (t) => { const k = dayKey(t); return days[k] || (days[k] = { t: k, pnl: 0, volume: 0, total: 0, won: 0, lost: 0, pending: 0, nonDecisive: 0, deployed: 0, claimable: 0 }); };
    for (const n of norms) {
      const d = at(n.t); d.total++; d.volume += asMaker ? n.cp : n.stake;
      if (n.settled && n.settledAt) { const s = at(n.settledAt); const pnl = asMaker ? -n.pnl : n.pnl; s.pnl += pnl; if ((asMaker ? n.lost : n.won)) s.won++; else if (n.result === 'NON_DECISIVE') s.nonDecisive++; else s.lost++; }
      else if (!n.settled) d.pending++;
    }
    const rows = Object.values(days).sort((a, b) => a.t - b.t);
    let cum = 0; for (const r of rows) { cum += r.pnl; r.cumPnl = cum; }
    return rows;
  };
  /** Compact question row for the snapshot's question explorer. */
  P.compactQuestion = (c) => ({ id: c.conditionId, q: c.question, short: c.shortName, cat: c.category ? c.category.name : null, slug: c.category ? c.category.slug : null, tags: (c.tags || []).slice(0, 6), ep: c.estimatedPrice == null ? null : Number(c.estimatedPrice), oi: P.usd(c.openInterest), v24: Number(c.similarMarketVolume24h) || 0, v7: Number(c.similarMarketVolume7d) || 0, end: c.endTime ? c.endTime * 1000 : null, created: c.createdAt ? P.ms(c.createdAt) : null, settled: !!c.settled, yes: c.resolvedToYes, nd: !!c.nonDecisive, src: c.similarMarket && c.similarMarket.markets ? c.similarMarket.markets[0] : null });
  P.compactTrade = (x) => { const tokens = P.usd(x.tokenAmount), paid = P.usd(x.price); return { t: x.executedAt * 1000, seller: x.seller, buyer: x.buyer, tokens, paid, px: tokens > 0 ? paid / tokens : null, tx: x.txHash }; };
})();
