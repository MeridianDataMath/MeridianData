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
      return { id: k.conditionId, q: c.question || c.shortName || k.conditionId, short: c.shortName || c.question || '', yes, ep, fair: ep == null ? null : (yes ? ep : 1 - ep), priceAtBet: k.priceAtBet == null ? null : Number(k.priceAtBet), event: k.event || null, settled: !!c.settled, resolvedToYes: c.resolvedToYes, nonDecisive: !!c.nonDecisive, pub: c.isPublic == null ? null : !!c.isPublic, cat:(c.category && c.category.name) || 'Other', catSlug: (c.category && c.category.slug) || 'other', endTime: c.endTime ? c.endTime * 1000 : null, tags: c.tags || [] };
    });
    let fair = null;
    if (picks.length && picks.every((k) => k.fair != null)) { fair = 1; for (const k of picks) fair *= k.fair; }
    const odds = pool > 0 ? stake / pool : null;
    const cats = Array.from(new Set(picks.map((k) => k.cat)));
    // Two steps on the exchange: a prediction is DECIDED once its pickConfig resolves (every leg resolved on Meridian,
    // verdict recorded on-chain), and SETTLED only when the winner claims. Most of the "unsettled" tail is decided and
    // simply unclaimed, so results count from the verdict; settlement is the cash step.
    const pc = p.pickConfig || {};
    const settled = !!p.settled;
    const verdict = settled ? p.result : pc.resolved ? pc.result : null;
    const decided = settled || (!!pc.resolved && !!verdict);
    const won = decided && verdict === 'PREDICTOR_WINS';
    // NON_DECISIVE exists in the API's enum, but Meridian's escrow settles a 50/50 leg as COUNTERPARTY_WINS (a loss for
    // the bettor) and no prediction has ever carried this result; kept as "void, stake returned" in case it ever appears
    const nd = decided && verdict === 'NON_DECISIVE';
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
      settled, decided, unclaimed: decided && !settled, result: verdict || null, won, lost: decided && !won && !nd, nd,
      pnl: decided && !nd ? (won ? cp : -stake) : 0,                      // bettor's result once decided (void = 0)
      endsAt: p.pickConfig && p.pickConfig.endsAt ? P.ms(p.pickConfig.endsAt) : null,
      tx: p.createTxHash || null,
      // position tokens are per pick configuration and side (every prediction on the same picks shares them); the
      // secondary market trades these, so they tie a trade back to its predictions
      pc: pc.pickConfigId || null, tokP: p.predictorToken ? String(p.predictorToken).toLowerCase() : null, tokC: p.counterpartyToken ? String(p.counterpartyToken).toLowerCase() : null,
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

  /** Compact row for the tape: the fields the Overview's tape has always read, plus every leg (k, as in P.slim, with its
   *  question id), the transaction, the claim time and the traded pick configuration, so a row can be opened (P.full). */
  P.compact = (n) => ({ id: n.id, t: n.t, predictor: n.predictor, counterparty: n.counterparty, stake: r4(n.stake), cp: r4(n.cp), odds: n.odds == null ? null : r4(n.odds), fair: n.fair == null ? null : r4(n.fair), legs: n.legs, q: n.picks[0] ? n.picks[0].q : '', yes: n.picks[0] ? n.picks[0].yes : null, cat: n.cat, settled: n.settled, decided: n.decided, unclaimed: n.unclaimed, nd: n.nd, won: n.won, pnl: r4(n.pnl),
    k: slimLegs(n, true), tx: n.tx || undefined, sa: n.settledAt || undefined, pc: n.pcTraded ? n.pc : undefined });
  /** A big win: the bettor won and its net PnL (payout − stake; for a bettor who sold its tokens, its own result with the
   *  sale) is above this many dollars (the Overview lists them). */
  P.BIG_WIN = 500;
  const r4 = (x) => (x == null ? null : Math.round(x * 1e4) / 1e4);
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const median = (arr) => { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const dayKey = (ms) => Math.floor(ms / DAY) * DAY;
  const weekKey = (ms) => Math.floor((ms - 4 * DAY) / (7 * DAY)) * 7 * DAY + 4 * DAY;   // Monday 00:00 UTC

  /** A prediction's result from one side (the bettor's unless asMaker): {label, tone, title}. "Unclaimed" is shown only
   *  where that side has something to collect (its win, or a void's refund) and still holds the tokens (held: the share
   *  not sold on the secondary market): a loss is simply lost, whether or not the winner has claimed. */
  P.resultFor = (n, asMaker, held = 1) => {
    if (!n.decided) return { label: 'open', tone: 'accent' };
    const won = asMaker ? n.lost : n.won; const mineToClaim = n.unclaimed && held > 1e-6;
    if (n.nd) return { label: mineToClaim ? 'void · refund unclaimed' : 'void', tone: 'amber' };
    if (won) return { label: mineToClaim ? 'won · unclaimed' : 'won', tone: 'green' };
    return { label: 'lost', tone: 'red', title: n.unclaimed ? (asMaker ? 'The bettor has not collected the payout yet' : 'The market maker has not collected the pool yet') : null };
  };

  /**
   * A wallet's headline figures from its own loaded predictions (all of them: the page uses the snapshot aggregate when
   * they are not) and its history: exchange stats when live (P.account), else rebuilt from claims (P.historyFromPredictions).
   * Checked against the exchange: its history books PnL at the verdict (claimed or not) and already follows secondary-
   * market trades, while its won / lost counts move only at the claim. So live the PnL is the exchange's as it stands; the
   * claim-based fallback adds the decided-but-unclaimed results and the ledger's adjustment. Either way the record adds the
   * unclaimed predictions, and a won prediction whose tokens were sold is not this wallet's to claim.
   */
  P.bettorFigures = function ({ mine, hist, isMaker, live, ledger }) {
    const totals = hist.reduce((a, x) => { a.won += x.won; a.lost += x.lost; a.pending += x.pending; a.nd += x.nonDecisive; a.pnl += x.pnl; return a; }, { won: 0, lost: 0, pending: 0, nd: 0, pnl: 0 });
    const heldOf = (n) => { const bp = ledger && ledger.byPrediction[n.id]; return bp ? bp.held : 1; };
    const s = P.bettorSummary(mine).stats || {};
    const unclaimed = mine.filter((n) => n.unclaimed);
    const uWon = unclaimed.filter((n) => (isMaker ? n.lost : n.won));
    const uPnl = U.sum(unclaimed, (n) => (isMaker ? -n.pnl : n.pnl));
    return {
      pnl: live ? totals.pnl : totals.pnl + uPnl + (ledger ? ledger.adj : 0),
      won: totals.won + uWon.length, lost: totals.lost + unclaimed.filter((n) => !n.nd && !(isMaker ? n.lost : n.won)).length, nd: totals.nd,
      open: Math.max(0, totals.pending - unclaimed.length),
      unclaimedWon: uWon.filter((n) => heldOf(n) > 1e-6).length, unclaimedPayout: U.sum(uWon, (n) => n.pool * heldOf(n)),
      roi: s.roi, avgOdds: s.avgOdds, avgLegs: s.avgLegs,
    };
  };

  /** When a prediction was decided: the API keeps no decision time, so its last question's end (or the bet itself). */
  // never later than its claim or than now: a combo lost on its first leg is decided while a later leg (months out) is open
  P.decidedAt = (n) => Math.min(Math.max(U.num(n.t), ...(n.picks || []).map((k) => U.num(k.endTime) || 0)), n.settledAt || Infinity, Date.now());

  /**
   * One wallet's secondary-market ledger over the pick configurations it traded. Position tokens belong to a pick
   * configuration and a side (every prediction on the same picks shares them); one token pays 1 USDe if its side wins,
   * nothing if it loses, its share of the side's collateral if the question is void. Per pick configuration and side the
   * wallet's tokens carry an average cost (its own predictions add the pool at its collateral, purchases add what was
   * paid), and:
   *   - a sale books its proceeds minus the average cost of the tokens sold, at the sale;
   *   - holding both sides books the matched amount (it pays for sure) minus its cost, at the moment both are held;
   *   - what is still held settles at the verdict (tokens × value − cost).
   * Checked against the exchange's own account PnL on 2026-09-22 for every wallet that ever traded (79 sellers, both
   * large buyers): per-prediction results replaced by this ledger reproduce it to the cent, open positions included.
   * trades: compact trades {t, seller, buyer, tokens, paid, pc, side 'P' | 'C', vP, vC (value per token once decided,
   * null while open), dAt (decision time), sa (claim time)}.
   * Returns {events: [{t, pc, kind 'sale' | 'set' | 'verdict', pnl, tokens, cash, cost, claimAt}], pnl (realized, verdict
   * basis), replaced (the per-prediction results of the wallet's own decided predictions on those pick configurations),
   * adj = pnl − replaced, byPrediction: {id: {pnl, held}}, open: {pc: {tokens, cost}}, trades (the wallet's, newest first)}.
   */
  P.ledger = function (norms, trades, addr) {
    addr = String(addr || '').toLowerCase();
    const EPS = 1e-9; const pcs = {};
    const at = (pc) => pcs[pc] || (pcs[pc] = { pc, ev: [], own: [], vP: null, vC: null, dAt: null, sa: null, q: null });
    const mine = (trades || []).filter((t) => t.pc && (t.seller === addr || t.buyer === addr));
    for (const t of mine) {
      const b = at(t.pc);
      b.ev.push({ t: t.t, kind: t.seller === addr ? 'sell' : 'buy', side: t.side, q: t.tokens, cash: t.paid, trade: t });
      if (t.vP != null) { b.vP = t.vP; b.vC = t.vC; }
      if (t.dAt) b.dAt = t.dAt; if (t.sa) b.sa = t.sa; if (!b.q) b.q = t.q || null;
    }
    for (const n of norms || []) {
      if (!n.pc || !pcs[n.pc]) continue;
      const b = pcs[n.pc]; const asP = n.predictor === addr, asC = n.counterparty === addr; if (!asP && !asC) continue;
      b.own.push(n);
      if (asP) b.ev.push({ t: n.t, kind: 'own', side: 'P', q: n.pool, cash: n.stake, n });
      if (asC) b.ev.push({ t: n.t, kind: 'own', side: 'C', q: n.pool, cash: n.cp, n });
      if (n.decided && b.vP == null) { b.vP = n.nd ? n.stake / n.pool : n.won ? 1 : 0; b.vC = n.nd ? n.cp / n.pool : n.won ? 0 : 1; }
      if (n.decided && !b.dAt) b.dAt = P.decidedAt(n);
    }
    const events = [], byPrediction = {}, open = {}; let pnl = 0, replaced = 0;
    for (const b of Object.values(pcs)) {
      b.ev.sort((x, y) => (x.t - y.t) || ((x.kind === 'own' ? 0 : 1) - (y.kind === 'own' ? 0 : 1)));
      // short: tokens sold before the acquisition that supplied them shows up. The trade and prediction clocks differ by
      // seconds, and some wallets sell a bet's tokens the moment it is placed, so a sale can precede its own prediction;
      // its cost is charged when the tokens arrive (or at the verdict at their value, if they never do)
      const hold = { P: { q: 0, c: 0, shorts: [] }, C: { q: 0, c: 0, shorts: [] } }; let pcPnl = 0;
      const book = (e) => { events.push(Object.assign({ pc: b.pc, q: b.q }, e)); pnl += e.pnl; pcPnl += e.pnl; return events[events.length - 1]; };
      for (const e of b.ev) {
        const hs = hold[e.side];
        if (e.kind === 'sell') {
          const take = Math.min(e.q, hs.q); const basis = hs.q > EPS ? hs.c * (take / hs.q) : 0;
          hs.q -= take; hs.c -= basis; if (hs.q < EPS) { hs.q = 0; hs.c = 0; }
          const sale = book({ t: e.t, kind: 'sale', side: e.side, tokens: e.q, cash: e.cash, cost: basis, pnl: e.cash - basis, trade: e.trade });
          if (e.q - take > EPS) hs.shorts.push({ sale, q: e.q - take });
          continue;
        }
        let q = e.q, cash = e.cash;
        while (hs.shorts.length && q > EPS) {   // these tokens were already sold: their cost completes that sale
          const s = hs.shorts[0]; const cover = Math.min(s.q, q); const basis = cash * (cover / q);
          s.sale.cost += basis; s.sale.pnl -= basis; pnl -= basis; pcPnl -= basis;
          s.q -= cover; q -= cover; cash -= basis; if (s.q < EPS) hs.shorts.shift();
        }
        hs.q += q; hs.c += cash;
        const m = Math.min(hold.P.q, hold.C.q);
        if (m > EPS) {   // both sides held: m tokens pay m whatever happens
          const cP = hold.P.c * (m / hold.P.q), cC = hold.C.c * (m / hold.C.q);
          hold.P.q -= m; hold.P.c -= cP; hold.C.q -= m; hold.C.c -= cC;
          book({ t: e.t, kind: 'set', tokens: m, cash: m, cost: cP + cC, pnl: m - cP - cC });
        }
      }
      // tokens still short at the end came from outside the ledger (a transfer): they are owed at their value
      const short = (hs) => U.sum(hs.shorts, (s) => s.q);
      const heldP = hold.P.q - short(hold.P), heldC = hold.C.q - short(hold.C), heldCost = hold.P.c + hold.C.c;
      if (b.vP != null) {
        const claimed = b.own.filter((n) => n.settled && n.settledAt);
        const claimAt = claimed.length ? Math.max(...claimed.map((n) => n.settledAt)) : b.sa || null;
        if (Math.abs(heldP) > EPS || Math.abs(heldC) > EPS || Math.abs(heldCost) > EPS) book({ t: b.dAt || Date.now(), kind: 'verdict', tokens: heldP + heldC, cash: heldP * b.vP + heldC * b.vC, cost: heldCost, pnl: heldP * b.vP + heldC * b.vC - heldCost, claimAt });
      } else open[b.pc] = { tokens: heldP + heldC, cost: heldCost };
      // the per-prediction results this replaces, and each own prediction's share of the pick configuration's result
      const ownPoolP = U.sum(b.own.filter((n) => n.predictor === addr), (n) => n.pool), ownPoolC = U.sum(b.own.filter((n) => n.counterparty === addr), (n) => n.pool);
      const ownPool = ownPoolP + ownPoolC;
      for (const n of b.own) {
        if (n.decided) replaced += (n.predictor === addr ? n.pnl : 0) + (n.counterparty === addr ? -n.pnl : 0);
        const side = n.predictor === addr ? 'P' : 'C'; const sidePool = side === 'P' ? ownPoolP : ownPoolC;
        // under a thousandth of a token left is rounding (the files keep stake and collateral to 4 decimals), not a holding
        const heldTok = side === 'P' ? heldP : heldC;
        byPrediction[n.id] = { pnl: ownPool > 0 ? pcPnl * (n.pool / ownPool) : 0, held: sidePool > 0 && heldTok >= 1e-3 ? Math.max(0, Math.min(1, heldTok / sidePool)) : 0, decided: b.vP != null };
      }
    }
    events.sort((a, b) => a.t - b.t);
    return { events, pnl, replaced, adj: pnl - replaced, byPrediction, open, trades: mine.slice().sort((a, b) => b.t - a.t) };
  };

  /** A prediction a wallet made against itself. */
  P.selfMatch = (n) => !!n.predictor && n.predictor === n.counterparty;
  /** Aggregate normalised predictions (self-matches left out). Returns plain JSON. trades: the secondary market (see P.ledger), optional.
   *  tape (the newest tapeSize) and bigWins (every win whose net PnL is above P.BIG_WIN, latest verdict first) are slim records
   *  with every leg's question id, so a page can show and open each one. */
  P.aggregate = function (norms, { tapeSize = 25, trades = null, bigWins = true, records = true } = {}) {
    // a self-match (one wallet on both sides: a test at launch, $0.50 against itself) moves no money and is no market
    // making; counted in its figures it made its wallet a "market maker" with one prediction
    const selfMatched = norms.filter(P.selfMatch).length;
    if (selfMatched) norms = norms.filter((n) => !P.selfMatch(n));
    const bettors = {}, makers = {}, cats = {}, combos = {}, daily = {}, weeks = {};
    const acc = (m, k, init) => m[k] || (m[k] = init());
    // decided = verdict in (claimed or not); settled = claimed; unclaimed = decided, not claimed (unclaimedWon / unclaimedPayout: money this side can collect)
    // (r*: the record against the odds, see finish; decided predictions with odds, not void)
    const side = () => ({ n: 0, wagered: 0, open: 0, openWagered: 0, decided: 0, settled: 0, unclaimed: 0, unclaimedWon: 0, unclaimedPayout: 0, won: 0, lost: 0, pnl: 0, combos: 0, legs: 0, oddsSum: 0, oddsN: 0, vigSum: 0, vigN: 0, biggestWin: 0, biggestStake: 0, first: null, last: null, cats: {}, rBets: [] });
    const bump = (s, n, asMaker) => {
      s.n++; s.wagered += asMaker ? n.cp : n.stake; s.legs += n.legs; if (n.combo) s.combos++;
      if (n.odds != null) { s.oddsSum += n.odds; s.oddsN++; }
      if (cleanVig(n)) { s.vigSum += n.vig; s.vigN++; }
      if (n.decided) { s.decided++; if (n.settled) s.settled++; else { s.unclaimed++; const w = asMaker ? n.lost : n.won; if (w) { s.unclaimedWon++; s.unclaimedPayout += n.pool; } } if (n.nd) s.nd = (s.nd || 0) + 1; else { const w = asMaker ? n.lost : n.won; if (w) s.won++; else s.lost++; } const pnl = asMaker ? -n.pnl : n.pnl; s.pnl += pnl; if (pnl > s.biggestWin) s.biggestWin = pnl; }
      else { s.open++; s.openWagered += asMaker ? n.cp : n.stake; }
      const st = asMaker ? n.cp : n.stake; if (st > s.biggestStake) s.biggestStake = st;
      // the record against the odds (bettors; recordOf): a leg is its question id, or its text where a file dropped the id
      if (!asMaker && n.decided && !n.nd && n.odds > 0 && n.odds < 1) s.rBets.push({ id: n.id, t: n.t, p: n.odds, won: n.won, stake: n.stake, legs: n.picks.map((k) => k.id || 'q:' + k.q) });
      if (s.first == null || n.t < s.first) s.first = n.t; if (s.last == null || n.t > s.last) s.last = n.t;
      s.cats[n.cat] = (s.cats[n.cat] || 0) + 1;
    };
    const finish = (s, isBettor) => { const decided = s.won + s.lost; s.winRate = decided ? (s.won / decided) * 100 : null; s.roi = s.decided ? (s.pnl / Math.max(1e-9, s.wagered - s.openWagered)) * 100 : null; s.avgOdds = s.oddsN ? s.oddsSum / s.oddsN : null; s.avgVig = s.vigN ? s.vigSum / s.vigN : null; s.avgLegs = s.n ? s.legs / s.n : null; s.topCat = Object.keys(s.cats).sort((a, b) => s.cats[b] - s.cats[a])[0] || null;
      s.rec = isBettor && records ? recordOf(s.rBets) : null;
      for (const k of ['oddsSum', 'oddsN', 'vigSum', 'vigN', 'legs', 'rBets']) delete s[k]; return s; };
    // The record against the odds (bettors): rec = { n bets, of them won, expected wins (the sum of their locked chances),
    // luck, predictions }, luck = P.luckOf: how likely that many wins or more would be if every bet's true chance were
    // exactly its locked odds. Counted in wins, not money: one 50× long shot that hit weighs one win, not fifty.
    // Bets, not predictions: luck needs independent trials, and predictions that share a question share their fate (the
    // same pick placed again: 0xec7a… had 11 predictions on 3 outcomes; combos built on one match or tournament). So the
    // predictions linked through shared questions are one bet, and that bet is one real event: its largest-stake
    // prediction, at that prediction's own odds and with its own result (a chance and an outcome that belong together;
    // averaging the odds of a group while counting it won on most of its stake could turn one big winning single and
    // small losing combos around it into a clean win). Every decided prediction counts, sold or not: a copier holds a
    // pick to the verdict, and leaving out what was sold dropped the losers bettors dumped mid-event.
    function recordOf(bets) {
      if (!bets.length) return null;
      const parent = bets.map((_, i) => i);
      const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
      const byLeg = new Map();
      bets.forEach((b, i) => { for (const k of b.legs) { if (byLeg.has(k)) parent[find(i)] = find(byLeg.get(k)); else byLeg.set(k, i); } });
      const groups = new Map(); bets.forEach((b, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(b); });
      const ps = []; let won = 0;
      for (const g of groups.values()) {
        const rep = g.reduce((a, b) => (b.stake > a.stake || (b.stake === a.stake && b.t < a.t) ? b : a));   // the largest stake; the earliest of equal ones
        ps.push(rep.p); if (rep.won) won++;
      }
      return { n: ps.length, won, expected: r4(U.sum(ps)), luck: Number(P.luckOf(ps, won).toPrecision(3)), predictions: bets.length };
    }
    // a defensible vig needs a defensible fair: singles and combos across different events; same-event legs are correlated
    const cleanVig = (n) => n.vig != null && n.sameEvent !== true;
    const vigAll = [], vigByCat = {};
    let totals = { n: 0, wagered: 0, cpCommitted: 0, decided: 0, settled: 0, unclaimed: 0, unclaimedWon: 0, unclaimedWonPayout: 0, unclaimedLost: 0, won: 0, lost: 0, bettorPnl: 0, open: 0, openWagered: 0, combos: 0 };
    for (const n of norms) {
      totals.n++; totals.wagered += n.stake; totals.cpCommitted += n.cp; if (n.combo) totals.combos++;
      if (n.decided) { totals.decided++; if (n.settled) totals.settled++; else { totals.unclaimed++; if (n.won) { totals.unclaimedWon++; totals.unclaimedWonPayout += n.pool; } else if (!n.nd) totals.unclaimedLost++; } if (n.nd) totals.nd = (totals.nd || 0) + 1; else if (n.won) totals.won++; else totals.lost++; totals.bettorPnl += n.pnl; } else { totals.open++; totals.openWagered += n.stake; }
      const b = acc(bettors, n.predictor, side); bump(b, n, false);
      const m = acc(makers, n.counterparty, side); bump(m, n, true);
      const c = acc(cats, n.cat, () => ({ cat: n.cat, n: 0, wagered: 0, settled: 0, won: 0, pnl: 0, vig: [] })); c.n++; c.wagered += n.stake; if (n.decided) { c.settled++; if (n.won) c.won++; c.pnl += n.pnl; } if (cleanVig(n)) c.vig.push(n.vig);
      const k = acc(combos, n.legs, () => ({ legs: n.legs, n: 0, settled: 0, won: 0, wagered: 0, pnl: 0, odds: [], multiples: [] })); k.n++; k.wagered += n.stake; if (n.decided) { k.settled++; if (n.won) k.won++; k.pnl += n.pnl; } if (n.odds != null) k.odds.push(n.odds); if (n.multiple != null) k.multiples.push(n.multiple);
      const d = acc(daily, dayKey(n.t), () => ({ t: dayKey(n.t), n: 0, wagered: 0, bettors: new Set(), settledPnl: 0, settledN: 0 })); d.n++; d.wagered += n.stake; d.bettors.add(n.predictor);
      if (n.settledAt) { const ds = acc(daily, dayKey(n.settledAt), () => ({ t: dayKey(n.settledAt), n: 0, wagered: 0, bettors: new Set(), settledPnl: 0, settledN: 0 })); ds.settledPnl += n.pnl; ds.settledN++; }
      if (cleanVig(n)) { vigAll.push(n); const wk = acc(weeks, weekKey(n.t), () => ({ t: weekKey(n.t), vig: [], n: 0, wagered: 0 })); wk.vig.push(n.vig); wk.n++; wk.wagered += n.stake; (vigByCat[n.cat] || (vigByCat[n.cat] = [])).push(n.vig); }
    }
    // secondary market: a wallet that sold (or bought) position tokens gets the ledger's result in place of the
    // per-prediction one for those pick configurations. The adjustment goes to the wallet's bettor row, or its maker row
    // when it only makes markets; a wallet in neither (a buyer who never bet) is counted apart.
    let secondary = null;
    const ledgerOf = Object.create(null);   // wallet → its ledger's byPrediction (the wallets that traded)
    if (trades && trades.length) {
      const tradedPc = new Set(trades.map((t) => t.pc).filter(Boolean));
      const byW = {}; for (const n of norms) if (n.pc && tradedPc.has(n.pc)) { (byW[n.predictor] || (byW[n.predictor] = [])).push(n); if (n.counterparty !== n.predictor) (byW[n.counterparty] || (byW[n.counterparty] = [])).push(n); }
      const wallets = new Set(); for (const t of trades) if (t.pc) { wallets.add(t.seller); wallets.add(t.buyer); }
      secondary = { trades: trades.length, mapped: trades.filter((t) => t.pc).length, volume: U.sum(trades, (t) => t.paid), toBettors: 0, toMakers: 0, toOthers: 0 };
      for (const w of wallets) {
        const L = P.ledger(byW[w] || [], trades, w); ledgerOf[w] = L.byPrediction;
        if (Math.abs(L.adj) < 1e-9 && !Object.keys(L.byPrediction).length) continue;
        const b = bettors[w], m = makers[w];
        const row = b && (!m || b.n >= m.n) ? b : m;
        if (row) { row.pnl += L.adj; row.secondary = (row.secondary || 0) + L.adj; if (row === b) { totals.bettorPnl += L.adj; secondary.toBettors += L.adj; } else secondary.toMakers += L.adj; }
        else secondary.toOthers += L.adj;
        // a won prediction whose tokens were sold is not this wallet's to claim any more
        if (row) for (const n of byW[w] || []) { const bp = L.byPrediction[n.id]; if (!bp || !n.unclaimed) continue; const ownWin = row === b ? n.won : n.lost; if (ownWin && bp.held < 1) { row.unclaimedPayout -= n.pool * (1 - bp.held); if (bp.held < 1e-6) row.unclaimedWon--; } }
      }
    }
    const rowsOf = (m, key) => Object.keys(m).map((a) => Object.assign({ [key]: a }, finish(m[a], m === bettors)));
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
    // Ex-post view, no source price needed: on settled bets, the odds the bettors locked (their implied win probability)
    // against how often they actually won, and the money-weighted result. Correlation and bettor skill are in the outcomes,
    // so this is the maker's realized edge; the price is luck (± = 95% interval on the hit rate) and needing settlement.
    const settledBets = norms.filter((n) => n.decided && !n.nd && n.odds != null);   // decided, claimed or not
    const realizedOf = (list) => {
      const k = list.length; if (!k) return { n: 0, implied: null, hit: null, ci: null, gap: null, stake: 0, pnl: 0, roi: null };
      const implied = list.reduce((a, n) => a + n.odds, 0) / k, hit = list.filter((n) => n.won).length / k;
      const stake = list.reduce((a, n) => a + n.stake, 0), pnl = list.reduce((a, n) => a + n.pnl, 0);
      // Wilson half-width: the plain normal interval collapses to ±0 at a 0 % or 100 % hit rate, which a one-bet
      // bucket reaches trivially; Wilson stays honest about how little a handful of bets can say
      const z = 1.96, ci = (z * Math.sqrt((hit * (1 - hit)) / k + (z * z) / (4 * k * k))) / (1 + (z * z) / k);
      return { n: k, implied, hit, ci, gap: implied - hit, stake, pnl, roi: stake > 0 ? pnl / stake : null };
    };
    const realized = {
      overall: realizedOf(settledBets),
      singles: realizedOf(settledBets.filter((n) => !n.combo)),
      combosOnly: realizedOf(settledBets.filter((n) => n.combo && n.sameEvent === false)),
      combosSameEvent: realizedOf(settledBets.filter((n) => n.combo && n.sameEvent === true)),
      combosUnknown: realizedOf(settledBets.filter((n) => n.combo && n.sameEvent == null)),
      byOddsBucket: [[0, 0.05], [0.05, 0.1], [0.1, 0.25], [0.25, 0.5], [0.5, 0.75], [0.75, 0.9], [0.9, 1.01]].map(([a, b]) => Object.assign({ from: a, to: Math.min(1, b) }, realizedOf(settledBets.filter((n) => n.odds >= a && n.odds < b)))),
      byCat: Object.keys(cats).map((c) => Object.assign({ cat: c }, realizedOf(settledBets.filter((n) => n.cat === c)))).filter((r) => r.n).sort((a, b) => b.n - a.n),
    };
    vig.realized = realized;
    const out = {
      totals: Object.assign(totals, { selfMatched, bettors: Object.keys(bettors).length, makers: Object.keys(makers).length, winRate: totals.won + totals.lost ? (totals.won / (totals.won + totals.lost)) * 100 : null }),
      bettors: rowsOf(bettors, 'address').sort((a, b) => b.pnl - a.pnl),
      makers: rowsOf(makers, 'address').sort((a, b) => b.n - a.n),
      categories: Object.values(cats).map((c) => ({ cat: c.cat, n: c.n, wagered: c.wagered, settled: c.settled, won: c.won, winRate: c.settled ? (c.won / c.settled) * 100 : null, pnl: c.pnl, avgVig: avg(c.vig) })).sort((a, b) => b.wagered - a.wagered),
      combos: Object.values(combos).map((k) => ({ legs: k.legs, n: k.n, settled: k.settled, won: k.won, winRate: k.settled ? (k.won / k.settled) * 100 : null, wagered: k.wagered, pnl: k.pnl, avgOdds: avg(k.odds), avgMultiple: avg(k.multiples), medianMultiple: median(k.multiples) })).sort((a, b) => a.legs - b.legs),
      daily: Object.values(daily).sort((a, b) => a.t - b.t).map((d) => ({ t: d.t, n: d.n, wagered: d.wagered, bettors: d.bettors.size, settledPnl: d.settledPnl, settledN: d.settledN })),
      vig,
      secondary,
      tape: norms.slice().sort((a, b) => b.t - a.t).slice(0, tapeSize).map((n) => Object.assign(P.compact(n), sold(n))),
      bigWins: bigWins ? norms.filter((n) => n.won && netPnl(n) > P.BIG_WIN).sort((a, b) => (b.decidedAt || P.decidedAt(b)) - (a.decidedAt || P.decidedAt(a))).map((n) => Object.assign(P.slim(n, { ids: true }), sold(n))) : undefined,
    };
    // the same {h, lp} for any record the caller writes (the snapshot's slip files); not enumerable, so not in the JSON
    Object.defineProperty(out, 'soldOf', { value: sold, enumerable: false });
    return out;
    // a bettor who sold its position tokens before the verdict does not collect the payout: its share still held (h) and
    // its own result on the prediction, the sale included (lp), from its ledger
    function sold(n) { const bp = ledgerOf[n.predictor] && ledgerOf[n.predictor][n.id]; return bp ? { h: r4(bp.held), lp: r4(bp.pnl) } : null; }
    // what the bettor made on it: payout − stake, or its own result where it traded the tokens (a win sold for little is none)
    function netPnl(n) { const bp = ledgerOf[n.predictor] && ledgerOf[n.predictor][n.id]; return bp ? bp.pnl : n.pnl; }
  };

  /** How likely `won` or more wins out of bets with these chances would be by luck alone, if each bet's true chance were
   *  exactly its locked odds: the upper tail of the Poisson-binomial distribution, exact at any size. Exact matters:
   *  long shots make the distribution far from normal. d[k] = P(k wins so far) for k < won, and d[won] = P(won or more),
   *  a bin that absorbs (a win there stays a win), so the work is bets × won. */
  P.luckOf = function (ps, won) {
    if (won <= 0) return 1;
    if (won > ps.length) return 0;
    const d = new Float64Array(won + 1); d[0] = 1;
    ps.forEach((p, i) => {
      for (let k = Math.min(i + 1, won); k >= 1; k--) d[k] = k === won ? d[k] + d[k - 1] * p : d[k] * (1 - p) + d[k - 1] * p;
      d[0] *= 1 - p;
    });
    return Math.min(1, Math.max(0, d[won]));
  };

  /** Winning bettors and their ideas to copy (the Copy trading page, from the snapshot's predict-ideas.json). A winning
   *  bettor has at least minDecided decided bets (rec.n: predictions linked by a shared question count once), is in
   *  profit, and has won more of them than its locked odds implied. Its tier says how clear of luck that record is:
   *  ranking ~180 wallets by luck turns up a dozen "1 in 10" records by chance alone, so a tier is a Benjamini–Hochberg
   *  cut across every bettor with a record, keeping the expected share of lucky ones among the strong under strongFdr
   *  and among the good under goodFdr. */
  P.IDEAS = { minDecided: 10, strongFdr: 0.1, goodFdr: 0.25 };
  /** { bettors, ideas, tested, byChance }: every winning bettor, least likely by luck first, with its tier and the number
   *  of its ideas; those ideas, the bettor's predictions that can still be placed at `now` (undecided, every leg before
   *  its Meridian cutoff and not settled, the bettor still holding at least half its tokens), best record first, then
   *  newest; tested = bettors with a record; byChance = how many of them luck alone would give a record of 1 in 10 or
   *  better. agg: P.aggregate over the same norms (its bettor rows and soldOf). */
  P.ideas = function (norms, agg, now = Date.now()) {
    const tested = agg.bettors.filter((b) => b.rec && b.rec.n >= P.IDEAS.minDecided);
    const lucks = tested.map((b) => b.rec.luck).sort((a, b) => a - b);
    const cut = (q) => { let c = -1; lucks.forEach((l, i) => { if (l <= ((i + 1) / lucks.length) * q) c = l; }); return c; };   // the largest luck a BH cut at q keeps
    const strongCut = cut(P.IDEAS.strongFdr), goodCut = cut(P.IDEAS.goodFdr);
    const tierOf = (luck) => (luck <= strongCut ? 'strong' : luck <= goodCut ? 'good' : null);
    const winning = tested.filter((b) => b.pnl > 0 && b.rec.won > b.rec.expected);
    const byAddr = new Map(winning.map((b) => [b.address, b]));
    const sold = (n) => (agg.soldOf ? agg.soldOf(n) : null);
    const held = (n) => { const s = sold(n); return s && s.h != null ? s.h : 1; };
    const open = norms.filter((n) => byAddr.has(n.predictor) && !n.decided && !P.selfMatch(n) && n.picks.length && n.picks.every((k) => k.endTime && k.endTime > now && !k.settled) && held(n) >= 0.5);
    const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
    const ranked = winning.slice().sort((a, b) => a.rec.luck - b.rec.luck || b.pnl - a.pnl);
    const rank = new Map(ranked.map((b, i) => [b.address, i]));
    // one idea per bettor and set of picks: the same slip placed again (0x2dc3… put the same 97% favourite on four
    // times) is the newest of them, with the count (x)
    const same = (n) => n.predictor + '|' + n.picks.map((k) => k.id + ':' + (k.yes ? 1 : 0)).sort().join(',');
    const seen = new Map(), ideas = [];
    for (const n of open.sort((a, b) => rank.get(a.predictor) - rank.get(b.predictor) || b.t - a.t)) {
      const k = same(n); if (seen.has(k)) { seen.get(k).x++; continue; }
      const rec = Object.assign(P.slim(n, { ids: true }), sold(n), { x: 1 }); seen.set(k, rec); ideas.push(rec);
    }
    const count = {}; for (const r of ideas) count[r.p] = (count[r.p] || 0) + 1;
    const bettors = ranked.map((b) => ({ address: b.address, luck: b.rec.luck, tier: tierOf(b.rec.luck), n: b.rec.n, predictions: b.rec.predictions, won: b.rec.won, expected: b.rec.expected, pnl: r2(b.pnl), roi: r2(b.roi), wagered: r2(b.wagered), last: b.last, topCat: b.topCat, ideas: count[b.address] || 0 }));
    return { bettors, ideas, tested: tested.length, byChance: Math.round(tested.length * 0.1) };
  };

  /** Bettor-level summary from that bettor's own predictions (subset of aggregate). */
  // (no record: it is the snapshot's, over every prediction with its question ids; a wallet file has neither)
  P.bettorSummary = (norms) => { const a = P.aggregate(norms, { tapeSize: 0, bigWins: false, records: false }); return { stats: a.bettors[0] || null, categories: a.categories, combos: a.combos, daily: a.daily, makers: a.makers }; };

  /** Slim record for the per-wallet snapshot files (≈400 bytes); P.unslim restores everything P.norm produces. */
  // Open predictions keep the leg's conditionId (6th element) so the resolution tracker can look the market up; settled
  // ones don't need it, except where o.ids asks for every leg's (question files, the Overview's tape and big wins).
  // Meridian's result for a settled question (9th element) says which legs won or lost a decided prediction.
  // leg = [question, yes, sourcePriceNow, endTime, category, conditionId, priceAtBet, polymarket event, result (1 YES, 0 NO, 2 50/50)]
  const legResult = (k) => (k.settled ? (k.nonDecisive ? 2 : k.resolvedToYes ? 1 : 0) : null);
  function slimLegs(n, ids) { return n.picks.map((k) => { const a = [k.q, k.yes ? 1 : 0, k.ep, k.endTime, k.cat, (ids || !n.settled) && k.id ? k.id : null, k.priceAtBet == null ? null : r4(k.priceAtBet), n.picks.length > 1 ? k.event || null : null, legResult(k)]; while (a.length > 5 && a[a.length - 1] == null) a.pop(); return a; }); }
  P.slim = (n, o) => ({ id: n.id, t: n.t, sa: n.settledAt, p: n.predictor, c: n.counterparty, s: r4(n.stake), cp: r4(n.cp), st: n.settled ? 1 : 0, pc: n.pcTraded ? n.pc : undefined, dv: n.decided && !n.settled ? (n.won ? 1 : n.nd ? 2 : 0) : undefined, r: n.result, tx: n.tx, cat: n.cat, da: n.decidedAt || undefined, k: slimLegs(n, !!(o && o.ids)) });
  P.unslim = function (s) {
    if (s.picks) return s;                               // already a full record
    const stake = s.s || 0, cp = s.cp || 0, pool = stake + cp;
    const picks = (s.k || []).map(([q, yes, ep, endTime, cat, id, pb, ev, res]) => ({ id: id || null, q, short: q, yes: !!yes, ep, fair: ep == null ? null : (yes ? ep : 1 - ep), priceAtBet: pb == null ? null : pb, event: ev || null, settled: res != null, resolvedToYes: res === 1 ? true : res === 0 ? false : null, nonDecisive: res === 2, cat: cat || s.cat, catSlug: null, endTime: endTime || null, tags: [] }));
    let fair = null; if (picks.length && picks.every((k) => k.fair != null)) { fair = 1; for (const k of picks) fair *= k.fair; }
    const odds = pool > 0 ? stake / pool : null; const settled = !!s.st; const decided = settled || s.dv != null;
    const won = settled ? s.r === 'PREDICTOR_WINS' : s.dv === 1; const nd = settled ? s.r === 'NON_DECISIVE' : s.dv === 2;
    const n = { id: s.id, t: s.t, settledAt: s.sa || null, predictor: s.p, counterparty: s.c, stake, cp, pool, odds, multiple: stake > 0 ? pool / stake : null, legs: picks.length, combo: picks.length > 1, picks, fair, fairNow: fair, vigNow: odds != null && fair != null ? odds - fair : null, fairAtBet: null, vig: null, vigPct: null, cat: s.cat, cats: Array.from(new Set(picks.map((k) => k.cat))), settled, decided, unclaimed: decided && !settled, result: settled ? (s.r || null) : decided ? (won ? 'PREDICTOR_WINS' : nd ? 'NON_DECISIVE' : 'COUNTERPARTY_WINS') : null, won, lost: decided && !won && !nd, nd, pnl: decided && !nd ? (won ? cp : -stake) : 0, endsAt: null, tx: s.tx || null, pc: s.pc || null, pcTraded: !!s.pc,   // a file keeps pc only where its tokens were traded
      // big wins and tape rows: when it was decided (from the source markets' resolution), and for a bettor who traded its
      // position tokens the share it still held at the verdict and its own result, the sale included (P.aggregate)
      decidedAt: s.da || null, held: s.h == null ? null : s.h, tradedPnl: s.lp == null ? null : s.lp };
    return P.applyAtBet(n, picks.map((k) => k.priceAtBet));
  };
  /** Any stored prediction row as a full record: a full record as it is, a slim one (big wins, wallet and question
   *  files) unslimmed, a tape row (P.compact) through the slim form. A tape row from before rows kept every leg has the
   *  first one only: marked partial, with its real leg count, so a page can complete it from the bettor's file. */
  P.full = function (x) {
    if (x.picks) return x;
    if (x.p) return P.unslim(x);
    const decided = !!x.decided, settled = !!x.settled;
    const n = P.unslim({ id: x.id, t: x.t, sa: x.sa, p: x.predictor, c: x.counterparty, s: x.stake, cp: x.cp, st: settled ? 1 : 0, pc: x.pc, dv: decided && !settled ? (x.won ? 1 : x.nd ? 2 : 0) : undefined,
      r: settled ? (x.won ? 'PREDICTOR_WINS' : x.nd ? 'NON_DECISIVE' : 'COUNTERPARTY_WINS') : null, tx: x.tx, cat: x.cat, h: x.h, lp: x.lp, k: x.k || [[x.q || '', x.yes ? 1 : 0]] });
    if (!x.k) Object.assign(n, { legs: x.legs || 1, combo: (x.legs || 1) > 1, partial: true });
    return n;
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
  P.compactQuestion = (c) => ({ id: c.conditionId, q: c.question, short: c.shortName, cat: c.category ? c.category.name : null, slug: c.category ? c.category.slug : null, tags: (c.tags || []).slice(0, 6), ep: c.estimatedPrice == null ? null : Number(c.estimatedPrice), oi: P.usd(c.openInterest), v24: Number(c.similarMarketVolume24h) || 0, v7: Number(c.similarMarketVolume7d) || 0, end: c.endTime ? c.endTime * 1000 : null, created: c.createdAt ? P.ms(c.createdAt) : null, settled: !!c.settled, yes: c.resolvedToYes, nd: !!c.nonDecisive, pub: c.isPublic == null ? null : !!c.isPublic, src: c.similarMarket && c.similarMarket.markets ? c.similarMarket.markets[0] : null });
  P.compactTrade = (x) => { const tokens = P.usd(x.tokenAmount), paid = P.usd(x.price); return { t: x.executedAt * 1000, seller: String(x.seller || '').toLowerCase(), buyer: String(x.buyer || '').toLowerCase(), tokens, paid, px: tokens > 0 ? paid / tokens : null, tx: x.txHash, token: String(x.token || '').toLowerCase() }; };
})();
