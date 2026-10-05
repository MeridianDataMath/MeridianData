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
      return { id: k.conditionId, q: c.question || c.shortName || k.conditionId, short: c.shortName || c.question || '', yes, ep, fair: ep == null ? null : (yes ? ep : 1 - ep), priceAtBet: k.priceAtBet == null ? null : Number(k.priceAtBet), event: k.event || null, settled: !!c.settled, resolvedToYes: c.resolvedToYes, nonDecisive: !!c.nonDecisive, settledAt: c.settled && c.settledAt ? P.legTime(c.settledAt) : null, pub: c.isPublic == null ? null : !!c.isPublic, cat:(c.category && c.category.name) || 'Other', catSlug: (c.category && c.category.slug) || 'other', endTime: c.endTime ? c.endTime * 1000 : null, tags: c.tags || [] };
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
      tx: p.createTxHash || null, stx: p.settleTxHash || null,   // the placement and the claim
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
    // combos whose legs sit on the same match or asset are correlated, so "fair = product of the legs" is not the fair price
    // and the measured vig includes the maker's correlation pricing; sameEvent is null when a leg's event is unknown.
    // A leg's event is one or more match keys (build-snapshot.mjs: root event, gameId, asset and date), space-separated;
    // legs sharing any key are on one match (an older bare event id is a single key)
    const evs = n.picks.map((k) => k.event);
    if (n.picks.length < 2) n.sameEvent = false;
    else if (evs.some((e) => !e)) n.sameEvent = null;
    else { const seen = new Set(); n.sameEvent = evs.some((e) => { const ks = String(e).split(' '); const hit = ks.some((x) => seen.has(x)); ks.forEach((x) => seen.add(x)); return hit; }); }
    return n;
  };

  /** Compact row for the tape: the fields the Overview's tape has always read, plus every leg (k, as in P.slim, with its
   *  question id), the transaction, the claim time and the traded pick configuration, so a row can be opened (P.full). */
  P.compact = (n) => ({ id: n.id, t: n.t, predictor: n.predictor, counterparty: n.counterparty, stake: r4(n.stake), cp: r4(n.cp), odds: n.odds == null ? null : r4(n.odds), fair: n.fair == null ? null : r4(n.fair), legs: n.legs, q: n.picks[0] ? n.picks[0].q : '', yes: n.picks[0] ? n.picks[0].yes : null, cat: n.cat, settled: n.settled, decided: n.decided, unclaimed: n.unclaimed, nd: n.nd, won: n.won, pnl: r4(n.pnl),
    k: slimLegs(n, true), tx: n.tx || undefined, sa: n.settledAt || undefined, da: n.decidedAt || undefined, pc: n.pcTraded ? n.pc : undefined, stx: n.stx || undefined });
  /** A big win: the bettor won and its net PnL (payout − stake; for a bettor who sold its tokens, its own result with the
   *  sale) is above this many dollars (the Overview lists them). */
  P.BIG_WIN = 500;
  /** A market maker is a counterparty that has taken at least this many predictions. Anyone can take the other side of a
   *  prediction once (0x3106…88d1: a single $1 against $1 at 50 %, settled ten minutes later), which is a test, not a
   *  market; such one-off counterparties are named apart from the makers (their results still count in the totals). */
  P.MAKER_MIN = 5;
  /** Whether a counterparty that took n predictions is a market maker (the Market makers page, a bettor page, its card). */
  P.isMarketMaker = (n) => n >= P.MAKER_MIN;
  P.splitMakers = (rows) => ({ makers: (rows || []).filter((m) => P.isMarketMaker(m.n)), oneOff: (rows || []).filter((m) => !P.isMarketMaker(m.n)) });
  /** The category with the most predictions; a tie goes to the larger stake, then the name (it went to whichever tied category the wallet used last). */
  P.topCategory = (cats, catW) => Object.keys(cats || {}).sort((a, b) => cats[b] - cats[a] || ((catW && catW[b]) || 0) - ((catW && catW[a]) || 0) || (a < b ? -1 : 1))[0] || null;
  const r4 =(x) => (x == null ? null : Math.round(x * 1e4) / 1e4);
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

  /** ROI in percent on one base, for the snapshot's rows (P.aggregate) and a wallet page (P.bettorFigures): the PnL (secondary market included) over the stakes that have met their result, i.e. decided predictions' stakes plus the sold share of open ones (a sale books its result before the verdict, so its stake belongs in the base). Null with neither. */
  P.roiOf = (pnl, decidedStake, soldOpenStake, anyDecided) => (anyDecided || soldOpenStake > 1e-9 ? (pnl / Math.max(1e-9, decidedStake + (soldOpenStake || 0))) * 100 : null);
  /**
   * A wallet's headline figures from its own loaded predictions (all of them: the page uses the snapshot aggregate when
   * they are not) and its history: exchange stats when live (P.account), else rebuilt from claims (P.historyFromPredictions).
   * Checked against the exchange: its history books PnL at the verdict (claimed or not) and already follows secondary-
   * market trades, while its won / lost counts move only at the claim. So live the PnL is the exchange's as it stands; the
   * claim-based fallback adds the decided-but-unclaimed results and the ledger's adjustment. Either way the record adds the
   * unclaimed predictions, and a won prediction whose tokens were sold is not this wallet's to claim.
   * ROI is this PnL as the snapshot's rows count it (P.roiOf; soldOpen: the sold share of open stakes in its base). Avg
   * odds and legs come from the wallet's own row for its role: a maker's are its bettors' odds, as on the Market makers page.
   * Open counts the loaded predictions when they are all loaded; otherwise (truncated) the exchange's pending count, less
   * the unclaimed ones and its self-matched ones still pending (selfPending: the site leaves a self-match out).
   */
  P.bettorFigures = function ({ mine, hist, isMaker, live, ledger, truncated, selfPending }) {
    const totals = hist.reduce((a, x) => { a.won += x.won; a.lost += x.lost; a.pending += x.pending; a.nd += x.nonDecisive; a.pnl += x.pnl; return a; }, { won: 0, lost: 0, pending: 0, nd: 0, pnl: 0 });
    const heldOf = (n) => { const bp = ledger && ledger.byPrediction[n.id]; return bp ? bp.held : 1; };
    // the wallet's own row: mine is one role of one wallet, so a maker's row is makers[0] (bettors[0] of the predictions a
    // maker took is its most profitable counterparty, whose ROI and odds the page used to show)
    const sm = P.bettorSummary(mine); const s = (isMaker ? (sm.makers || [])[0] : sm.stats) || {};
    const unclaimed = mine.filter((n) => n.unclaimed);
    // live, the exchange's won / lost / pending follow the API's settled flag, which a claim sets on one prediction per
    // token only (P.markTokenClaims): the others it paid are still pending there
    const unflagged = live ? mine.filter((n) => n.unclaimed || n.viaToken) : unclaimed;
    const uWon = unclaimed.filter((n) => (isMaker ? n.lost : n.won));
    const uPnl = U.sum(unclaimed, (n) => (isMaker ? -n.pnl : n.pnl));
    const pnl = live ? totals.pnl : totals.pnl + uPnl + (ledger ? ledger.adj : 0);
    // the snapshot rows' ROI (P.roiOf): this PnL over decided stakes and the sold share of open ones
    const stakeOf = (n) => (isMaker ? n.cp : n.stake);
    const decided = mine.filter((n) => n.decided);
    const soldOpen = U.sum(mine.filter((n) => !n.decided), (n) => stakeOf(n) * (1 - heldOf(n)));
    return {
      pnl,
      won: totals.won + unflagged.filter((n) => (isMaker ? n.lost : n.won)).length, lost: totals.lost + unflagged.filter((n) => !n.nd && !(isMaker ? n.lost : n.won)).length, nd: totals.nd,
      open: truncated ? Math.max(0, totals.pending - unflagged.length - (selfPending || 0)) : mine.filter((n) => !n.decided).length,
      unclaimedWon: uWon.filter((n) => heldOf(n) > 1e-6).length, unclaimedPayout: U.sum(uWon, (n) => n.pool * heldOf(n)),
      roi: P.roiOf(pnl, U.sum(decided, stakeOf), soldOpen, decided.length > 0), soldOpen, avgOdds: s.avgOdds, avgLegs: s.avgLegs,
    };
  };

  /** A condition's settlement time on Meridian (unix seconds from the API) in ms. */
  P.legTime = (x) => { const v = Number(x); return Number.isFinite(v) && v > 0 ? (v < 1e12 ? v * 1000 : v) : typeof x === 'string' ? P.ms(x) : null; };
  /** When a prediction was settled on Meridian, from its legs' own settlement times (the API keeps none for the
   *  prediction): a win when its last leg settled, a loss when the first leg settled against the bettor (a combo lost on
   *  its first leg is decided while a later leg, months out, is open). Null when the legs carry no times (records from
   *  before they were kept). Never before the bet or after the claim. */
  P.legVerdictAt = (n) => {
    const legs = n.picks || []; if (!n.decided || !legs.length) return null;
    let at = null;
    if (n.won) { if (legs.every((k) => k.settledAt)) at = Math.max(...legs.map((k) => k.settledAt)); }
    else { const against = legs.filter((k) => k.settled && k.settledAt && (k.nonDecisive || k.resolvedToYes === !k.yes)); if (against.length) at = Math.min(...against.map((k) => k.settledAt)); }
    return at == null ? null : Math.min(Math.max(U.num(n.t), at), n.settledAt || Infinity);
  };
  /** When a prediction was settled (decided): Meridian's own leg settlement times (P.legVerdictAt), else the snapshot's
   *  time (n.decidedAt, 'da'), else an estimate: a win from its last question's end, a loss from the first leg settled
   *  against the bettor, else its last question's end; never before the bet, after its claim, or after now. */
  P.decidedAt = (n) => {
    const exact = P.legVerdictAt(n) || n.decidedAt; if (exact) return exact;
    const legs = n.picks || [];
    const against = n.won ? [] : legs.filter((k) => k.settled && (k.nonDecisive || k.resolvedToYes === !k.yes) && U.num(k.endTime));
    const at = against.length ? Math.min(...against.map((k) => U.num(k.endTime))) : Math.max(0, ...legs.map((k) => U.num(k.endTime) || 0));
    return Math.min(Math.max(U.num(n.t), at), n.settledAt || Infinity, Date.now());
  };
  /** When the source markets resolved a decided prediction ({t, exact}), from each leg's resolution on its source
   *  market (k.verdictAt: the snapshot's per-leg vt, from Polymarket's UMA resolution): a win when its last leg
   *  resolved, a loss (or void) when the first leg against the bettor did. A leg without that time counts at its
   *  Meridian settlement, and a prediction with neither at P.decidedAt; exact only when every leg used had its source
   *  time. Never before the bet or after Meridian settled it (P.decidedAt). Null while undecided. */
  P.sourceVerdictAt = (n) => {
    if (!n || !n.decided) return null;
    const dec = P.decidedAt(n);
    const legs = n.picks || []; const timeOf = (k) => k.verdictAt || k.settledAt || null;
    const use = n.won ? legs : legs.filter((k) => k.settled && (k.nonDecisive || k.resolvedToYes === !k.yes));
    let t = null, exact = false;
    if (use.length && (n.won ? use.every(timeOf) : use.some(timeOf))) {
      const ts = use.map(timeOf).filter(Boolean);
      t = n.won ? Math.max(...ts) : Math.min(...ts);
      exact = use.every((k) => k.verdictAt);
    }
    if (t == null) return { t: dec, exact: false };
    return { t: Math.min(Math.max(U.num(n.t), t), dec), exact };
  };

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
   * adj = pnl − replaced, byPrediction: {id: {pnl, held (the share of its side's tokens not sold; a matched set still
   * holds them), decided, hedged (part of them matched with the other side)}}, open: {pc: {tokens, cost}}, trades (the
   * wallet's, newest first)}.
   * A verdict event also carries side (the side whose tokens it settles), heldP / heldC (tokens held at the verdict) and
   * vt / vtExact (when the source markets resolved: P.sourceVerdictAt of an own prediction, else the trades' vt, else the
   * Meridian decision). Its claimAt, for tokens that pay: the wallet's own redemption (rd: {'<pc>|<P|C>': ms}, the
   * snapshot's record of its burns, P.redemptionTimes), else its earliest own claim on that side (that claim redeemed the
   * whole balance), else null (not redeemed) when rd is given; without rd (an older snapshot) the latest claim on the pick
   * configuration by anyone (sa). Worthless tokens have nothing to redeem: the latest own claim or sa, as a lost
   * prediction is booked when the winner claims.
   */
  P.ledger = function (norms, trades, addr, rd) {
    addr = String(addr || '').toLowerCase();
    const EPS = 1e-9; const pcs = {};
    const at = (pc) => pcs[pc] || (pcs[pc] = { pc, ev: [], own: [], vP: null, vC: null, dAt: null, sa: null, q: null, vt: null, vtExact: false });
    const mine = (trades || []).filter((t) => t.pc && (t.seller === addr || t.buyer === addr));
    for (const t of mine) {
      const b = at(t.pc);
      b.ev.push({ t: t.t, kind: t.seller === addr ? 'sell' : 'buy', side: t.side, q: t.tokens, cash: t.paid, trade: t });
      if (t.vP != null) { b.vP = t.vP; b.vC = t.vC; }
      if (t.dAt) b.dAt = t.dAt; if (t.sa) b.sa = t.sa; if (!b.q) b.q = t.q || null;
      if (t.vt && !b.vtExact) { b.vt = t.vt; b.vtExact = true; }   // a trade carries vt only when the source times are known
    }
    for (const n of norms || []) {
      if (!n.pc || !pcs[n.pc]) continue;
      const b = pcs[n.pc]; const asP = n.predictor === addr, asC = n.counterparty === addr; if (!asP && !asC) continue;
      b.own.push(n);
      if (asP) b.ev.push({ t: n.t, kind: 'own', side: 'P', q: n.pool, cash: n.stake, n });
      if (asC) b.ev.push({ t: n.t, kind: 'own', side: 'C', q: n.pool, cash: n.cp, n });
      if (n.decided && b.vP == null) { b.vP = n.nd ? n.stake / n.pool : n.won ? 1 : 0; b.vC = n.nd ? n.cp / n.pool : n.won ? 0 : 1; }
      if (n.decided && !b.dAt) b.dAt = P.decidedAt(n);
      if (n.decided && !b.vtExact) { const v = P.sourceVerdictAt(n); if (v && (v.exact || !b.vt)) { b.vt = v.t; b.vtExact = v.exact; } }
    }
    const events = [], byPrediction = {}, open = {}; let pnl = 0, replaced = 0;
    for (const b of Object.values(pcs)) {
      b.ev.sort((x, y) => (x.t - y.t) || ((x.kind === 'own' ? 0 : 1) - (y.kind === 'own' ? 0 : 1)));
      // short: tokens sold before the acquisition that supplied them shows up. The trade and prediction clocks differ by
      // seconds, and some wallets sell a bet's tokens the moment it is placed, so a sale can precede its own prediction;
      // its cost is charged when the tokens arrive (or at the verdict at their value, if they never do)
      const hold = { P: { q: 0, c: 0, shorts: [] }, C: { q: 0, c: 0, shorts: [] } }; let pcPnl = 0, setQ = 0;
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
          setQ += m; hold.P.q -= m; hold.P.c -= cP; hold.C.q -= m; hold.C.c -= cC;
          book({ t: e.t, kind: 'set', tokens: m, cash: m, cost: cP + cC, pnl: m - cP - cC });
        }
      }
      // tokens still short at the end came from outside the ledger (a transfer): they are owed at their value
      const short = (hs) => U.sum(hs.shorts, (s) => s.q);
      const heldP = hold.P.q - short(hold.P), heldC = hold.C.q - short(hold.C), heldCost = hold.P.c + hold.C.c;
      if (b.vP != null) {
        const value = heldP * b.vP + heldC * b.vC;
        const side = heldP > EPS && (heldC <= EPS || heldP * b.vP >= heldC * b.vC) ? 'P' : 'C';
        const claimed = b.own.filter((n) => n.settled && n.settledAt);
        const ownSide = claimed.filter((n) => (side === 'P' ? n.predictor : n.counterparty) === addr).map((n) => n.settledAt);
        const burn = rd ? rd[b.pc + '|' + side] : undefined;
        const claimAt = value > EPS
          ? (burn || (ownSide.length ? Math.min(...ownSide) : rd ? null : (claimed.length ? Math.max(...claimed.map((n) => n.settledAt)) : b.sa || null)))   // winnings: cash only once this wallet redeems
          : (claimed.length ? Math.max(...claimed.map((n) => n.settledAt)) : b.sa || null);   // worthless: booked when the winners claim
        const dAt = b.dAt || Date.now();
        if (Math.abs(heldP) > EPS || Math.abs(heldC) > EPS || Math.abs(heldCost) > EPS) book({ t: dAt, kind: 'verdict', side, heldP, heldC, tokens: heldP + heldC, cash: value, cost: heldCost, pnl: value - heldCost, claimAt, vt: b.vt ? Math.min(b.vt, dAt) : dAt, vtExact: !!b.vt && b.vtExact });
      } else open[b.pc] = { tokens: heldP + heldC, cost: heldCost };
      // the per-prediction results this replaces, and each own prediction's share of the pick configuration's result
      const ownPoolP = U.sum(b.own.filter((n) => n.predictor === addr), (n) => n.pool), ownPoolC = U.sum(b.own.filter((n) => n.counterparty === addr), (n) => n.pool);
      const ownPool = ownPoolP + ownPoolC;
      for (const n of b.own) {
        if (n.decided) replaced += (n.predictor === addr ? n.pnl : 0) + (n.counterparty === addr ? -n.pnl : 0);
        const side = n.predictor === addr ? 'P' : 'C'; const sidePool = side === 'P' ? ownPoolP : ownPoolC;
        // under a thousandth of a token left is rounding (the files keep stake and collateral to 4 decimals), not a holding
        const heldTok = (side === 'P' ? heldP : heldC) + setQ;   // a matched set still holds its tokens (it pays the same whatever the verdict): only a sale lowers held
        const share = (tok) => (sidePool > 0 && tok >= 1e-3 ? Math.max(0, Math.min(1, tok / sidePool)) : 0);
        // held: the share not sold (labels, claimability); atRisk: the share the verdict itself settles, a matched set's
        // result already booked at the set (the tax center's settled-bets export multiplies the result by it)
        byPrediction[n.id] = { pnl: ownPool > 0 ? pcPnl * (n.pool / ownPool) : 0, held: share(heldTok), atRisk: share(side === 'P' ? heldP : heldC), decided: b.vP != null, hedged: setQ > EPS };
      }
    }
    events.sort((a, b) => a.t - b.t);
    return { events, pnl, replaced, adj: pnl - replaced, byPrediction, open, trades: mine.slice().sort((a, b) => b.t - a.t) };
  };

  /**
   * A wallet's positions on the pick configurations it traded, from its ledger L (P.ledger) on one side (P: its bets as
   * the bettor, C: as the market maker): its bets there and the tokens of that side it bought and sold, split where a
   * sale leaves it holding nothing, so a bet placed after that starts a new position. Returns [{pc, side, bets (norms),
   * sales (L's sale events), buys (trades), t0, t1 (its first event and its last sale, or its first event), stake (its
   * bets' stake or collateral), in (that plus what it paid for tokens), pnl (its sales and matched sets at the ledger's
   * average cost, and on the last position the verdict on what it still held), held (share of its tokens still held at
   * its end), out (a sale left it holding nothing), decided}]. A sale out of tokens the wallet did not have yet (the
   * trade clock running seconds ahead of its own bet) does not split.
   */
  P.positions = function (norms, L, addr, side = 'P') {
    addr = String(addr || '').toLowerCase();
    const EPS = 1e-6, out = [];
    const pcs = new Set((L && L.trades || []).filter((t) => t.pc && t.side === side).map((t) => t.pc));
    for (const pc of pcs) {
      const bets = (norms || []).filter((n) => n.pc === pc && (side === 'P' ? n.predictor : n.counterparty) === addr && !P.selfMatch(n));
      const items = bets.map((n) => ({ t: n.t, k: 0, q: n.pool, cash: side === 'P' ? n.stake : n.cp, n }))
        .concat(L.trades.filter((t) => t.pc === pc && t.side === side && t.buyer === addr && t.seller !== addr).map((t) => ({ t: t.t, k: 1, q: t.tokens, cash: t.paid, buy: t })))
        .concat(L.events.filter((e) => e.kind === 'sale' && e.pc === pc && e.side === side).map((e) => ({ t: e.t, k: 2, q: e.tokens, sale: e })))
        .sort((x, y) => x.t - y.t || x.k - y.k);
      const sets = L.events.filter((e) => e.kind === 'set' && e.pc === pc);
      const verdict = L.events.find((e) => e.kind === 'verdict' && e.pc === pc) || null;
      let cur = null, hold = 0;
      const start = (t) => { cur = { pc, side, bets: [], sales: [], buys: [], t0: t, t1: t, stake: 0, in: 0, got: 0, pnl: 0, held: 0, out: false, decided: !!verdict }; out.push(cur); };
      for (const it of items) {
        if (!cur || (cur.out && it.k !== 2)) start(it.t);
        if (it.k === 2) { hold -= it.q; cur.sales.push(it.sale); cur.pnl += it.sale.pnl; cur.t1 = it.t; if (Math.abs(hold) <= EPS && cur.got > EPS) { hold = 0; cur.out = true; } continue; }
        hold += it.q; cur.got += it.q; cur.in += it.cash;
        if (it.n) { cur.bets.push(it.n); cur.stake += it.cash; } else cur.buys.push(it.buy);
        if (!cur.sales.length) cur.t1 = it.t;
      }
      const list = out.filter((p) => p.pc === pc);
      for (const e of sets) { const p = list.filter((x) => x.t0 <= e.t).pop() || list[0]; if (p) p.pnl += e.pnl; }
      const last = list[list.length - 1];
      if (last && verdict) last.pnl += verdict.pnl;
      if (last && !last.out) last.held = last.got > EPS ? Math.max(0, Math.min(1, hold / last.got)) : 0;
      for (const p of list) delete p.got;
    }
    return out;
  };

  /** A prediction a wallet made against itself. */
  P.selfMatch = (n) => !!n.predictor && n.predictor === n.counterparty;
  /** A claim redeems the wallet's whole balance of a position token (one pick configuration and side: tokP / tokC are
   *  shared by every prediction on the same picks), but the API flags only the prediction the claim went through as
   *  settled; the wallet's other decided predictions on that token were paid by the same claim (checked on-chain:
   *  2026-10-01, bettors' 251 such wins, $32.7K; 2026-10-02, the makers' 726 on 305 tokens; every token at 0). They are
   *  marked claimed at that claim's time; viaToken says the API (and so the exchange's won / lost / pending counts) still
   *  calls them unsettled. Returns how many were marked. */
  P.markTokenClaims = function (norms) {
    const key = (n) => (n.won ? n.predictor + '|' + n.tokP : n.counterparty + '|' + n.tokC);   // the winner's wallet and token
    const at = new Map();
    // the earliest claim: it redeemed the whole balance (every prediction on the token shares one verdict, so all were
    // placed before it); a later claim on the same token redeemed nothing
    // (with its transaction, which is then the claim of every prediction it paid)
    for (const n of norms) if (n.settled && n.settledAt && !n.nd && (n.won ? n.tokP : n.tokC)) { const k2 = key(n); const c = at.get(k2); if (!c || n.settledAt < c.t) at.set(k2, { t: n.settledAt, stx: n.stx || null }); }
    let k = 0;
    for (const n of norms) { if (!n.unclaimed || n.nd || !(n.won ? n.tokP : n.tokC)) continue; const c = at.get(key(n)); if (c && c.t >= n.t) { n.settled = true; n.unclaimed = false; n.settledAt = c.t; n.viaToken = true; if (!n.stx && c.stx) n.stx = c.stx; k++; } }
    return k;
  };
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
    const side = () => ({ n: 0, wagered: 0, open: 0, openWagered: 0, decided: 0, settled: 0, unclaimed: 0, unclaimedWon: 0, unclaimedPayout: 0, won: 0, lost: 0, pnl: 0, combos: 0, legs: 0, oddsSum: 0, oddsN: 0, vigSum: 0, vigN: 0, biggestWin: 0, biggestStake: 0, first: null, last: null, cats: {}, catW: {}, rBets: [] });
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
      s.catW[n.cat] = (s.catW[n.cat] || 0) + (asMaker ? n.cp : n.stake);
    };
    const finish = (s, isBettor) => { const decided = s.won + s.lost; s.winRate = decided ? (s.won / decided) * 100 : null; s.roi = P.roiOf(s.pnl, s.wagered - s.openWagered, s.soldOpen || 0, s.decided > 0); s.avgOdds = s.oddsN ? s.oddsSum / s.oddsN : null; s.avgVig = s.vigN ? s.vigSum / s.vigN : null; s.avgLegs = s.n ? s.legs / s.n : null; s.topCat = P.topCategory(s.cats, s.catW);
      s.rec = isBettor && records ? recordOf(s.rBets) : null;
      for (const k of ['oddsSum', 'oddsN', 'vigSum', 'legs', 'rBets', 'catW', 'soldOpen']) delete s[k]; return s; };   // vigN stays: how many predictions avgVig covers
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
      // unrounded: the tiers compare it with 0.02 / 0.1 (0x7dbb…: 0.10017, rounded to 0.1, read as good); luckText formats it for display
      return { n: ps.length, won, expected: r4(U.sum(ps)), luck: P.luckOf(ps, won), predictions: bets.length };
    }
    // a defensible vig needs a defensible fair: singles and combos with every leg on a different match; legs on the same
    // match or asset are correlated
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
      // results on the day they settled (decided), claimed or not; no page draws them yet
      if (n.decided) { const v = dayKey(P.decidedAt(n)); const ds = acc(daily, v, () => ({ t: v, n: 0, wagered: 0, bettors: new Set(), settledPnl: 0, settledN: 0 })); ds.settledPnl += n.pnl; ds.settledN++; }
      if (cleanVig(n)) { vigAll.push(n); const wk = acc(weeks, weekKey(n.t), () => ({ t: weekKey(n.t), vig: [], n: 0, wagered: 0 })); wk.vig.push(n.vig); wk.n++; wk.wagered += n.stake; (vigByCat[n.cat] || (vigByCat[n.cat] = [])).push(n.vig); }
    }
    // secondary market: a wallet that sold (or bought) position tokens gets the ledger's result in place of the
    // per-prediction one for those pick configurations. The adjustment goes to the wallet's bettor row, or its maker row
    // when it only makes markets; a wallet in neither (a buyer who never bet) is counted apart.
    let secondary = null;
    const ledgerOf = Object.create(null);   // wallet → its ledger's byPrediction (the wallets that traded)
    const ledgerAll = Object.create(null);  // wallet → its whole ledger (big wins: its positions, P.positions)
    if (trades && trades.length) {
      const tradedPc = new Set(trades.map((t) => t.pc).filter(Boolean));
      const decidedBy = {}; for (const n of norms) if (n.decided) (decidedBy[n.predictor] || (decidedBy[n.predictor] = [])).push(n);   // each bettor's decided predictions (its best win)
      const byW = {}; for (const n of norms) if (n.pc && tradedPc.has(n.pc)) { (byW[n.predictor] || (byW[n.predictor] = [])).push(n); if (n.counterparty !== n.predictor) (byW[n.counterparty] || (byW[n.counterparty] = [])).push(n); }
      const wallets = new Set(); for (const t of trades) if (t.pc) { wallets.add(t.seller); wallets.add(t.buyer); }
      secondary = { trades: trades.length, mapped: trades.filter((t) => t.pc).length, volume: U.sum(trades, (t) => t.paid), toBettors: 0, toMakers: 0, toOthers: 0 };
      for (const w of wallets) {
        const L = P.ledger(byW[w] || [], trades, w); ledgerOf[w] = L.byPrediction; ledgerAll[w] = L;
        if (Math.abs(L.adj) < 1e-9 && !Object.keys(L.byPrediction).length) continue;
        const b = bettors[w], m = makers[w];
        const row = b && (!m || b.n >= m.n) ? b : m;
        if (row) { row.pnl += L.adj; row.secondary = (row.secondary || 0) + L.adj; if (row === b) { totals.bettorPnl += L.adj; secondary.toBettors += L.adj; } else secondary.toMakers += L.adj; }
        else secondary.toOthers += L.adj;
        // a won prediction whose tokens were sold is not this wallet's to claim any more
        if (row) for (const n of byW[w] || []) { const bp = L.byPrediction[n.id]; if (!bp || !n.unclaimed) continue; const ownWin = row === b ? n.won : n.lost; if (ownWin && bp.held < 1) { row.unclaimedPayout -= n.pool * (1 - bp.held); if (bp.held < 1e-6) row.unclaimedWon--; } }
        // a sale out of a still-open prediction is realized at the sale, so its stake joins the ROI base (finish, P.roiOf)
        if (row) for (const n of byW[w] || []) { const bp = L.byPrediction[n.id]; if (!bp || n.decided || !(bp.held < 1)) continue; if ((row === b ? n.predictor : n.counterparty) === w) row.soldOpen = (row.soldOpen || 0) + (row === b ? n.stake : n.cp) * (1 - bp.held); }
        // the best win counts the bettor's own result where it traded the tokens (as big wins do): a win sold before the verdict is not its win
        if (b) { let best = 0; for (const n of decidedBy[w] || []) { const bp = L.byPrediction[n.id]; const v = bp ? bp.pnl : n.pnl; if (v > best) best = v; } b.biggestWin = best; }
      }
    }
    const rowsOf = (m, key) => Object.keys(m).map((a) => Object.assign({ [key]: a }, finish(m[a], m === bettors)));
    const vigSummary = (list) => ({ n: list.length, avg: avg(list), median: median(list), share: list.length ? list.filter((v) => v > 0).length / list.length : null });
    const vig = {
      overall: vigSummary(vigAll.map((n) => n.vig)),
      weighted: vigAll.length ? vigAll.reduce((a, n) => a + n.vig * n.stake, 0) / Math.max(1e-9, vigAll.reduce((a, n) => a + n.stake, 0)) : null,
      byCat: Object.keys(vigByCat).map((c) => Object.assign({ cat: c }, vigSummary(vigByCat[c]))).sort((a, b) => b.n - a.n),
      singles: vigSummary(vigAll.filter((n) => !n.combo).map((n) => n.vig)),
      combosOnly: vigSummary(vigAll.filter((n) => n.combo).map((n) => n.vig)),                       // combos with every leg on a different match (in the headline)
      combosSameEvent: vigSummary(norms.filter((n) => n.vig != null && n.sameEvent === true).map((n) => n.vig)),   // legs on the same match or asset: includes correlation pricing, kept out of the headline
      combosUnknown: vigSummary(norms.filter((n) => n.vig != null && n.combo && n.sameEvent == null).map((n) => n.vig)),
      byOddsBucket: [[0, 0.1], [0.1, 0.25], [0.25, 0.5], [0.5, 0.75], [0.75, 0.9], [0.9, 1.01]].map(([a, b]) => Object.assign({ from: a, to: Math.min(1, b) }, vigSummary(vigAll.filter((n) => n.odds >= a && n.odds < b).map((n) => n.vig)))),
      weekly: Object.values(weeks).sort((a, b) => a.t - b.t).map((w) => ({ t: w.t, n: w.n, wagered: w.wagered, avg: avg(w.vig), median: median(w.vig) })),
      // how many predictions have a source price at bet time (the rest have no Polymarket history yet or no source market)
      coverage: { withAtBet: norms.filter((n) => n.vig != null).length, clean: vigAll.length, sameEvent: norms.filter((n) => n.vig != null && n.sameEvent === true).length, total: norms.length, source: 'polymarket-history' },
    };
    // Ex-post view, no source price needed: on settled bets, the odds the bettors locked (their implied win probability)
    // against how often they actually won, and the money-weighted result. Correlation and bettor skill are in the outcomes,
    // so this is the maker's realized edge; the price is luck (± = 95% interval on the hit rate, allowing for bets on the
    // same question winning or losing together) and needing settlement.
    const settledBets = norms.filter((n) => n.decided && !n.nd && n.odds != null);   // decided, claimed or not
    // Bets on the same question win or lose together (41 singles on one Fed decision), so the hit rate does not spread like
    // independent coin flips: it is simulated with every question resolved once for all its bets, YES with its Polymarket
    // price at bet (averaged over the bets on it; without one, the locked odds of the singles on it, else 1/2), 1,000 runs
    // with a fixed seed so a rebuild gives the same figures. ± = 1.96 standard deviations of the simulated hit rate.
    let sharedSd = null;
    if (records && settledBets.length) {
      const qIx = new Map(), qAcc = [];
      const legIx = settledBets.map((n) => n.picks.map((k) => {
        const key = k.id || 'q:' + k.q + '|' + (k.endTime || ''); let i = qIx.get(key);
        if (i == null) { i = qAcc.length; qIx.set(key, i); qAcc.push([0, 0, 0, 0]); }
        const a = qAcc[i];
        if (k.priceAtBet != null) { a[0] += k.priceAtBet; a[1]++; } else if (n.picks.length === 1) { a[2] += k.yes ? n.odds : 1 - n.odds; a[3]++; }
        return k.yes ? i + 1 : -(i + 1);
      }));
      const qYes = qAcc.map(([s, c, s2, c2]) => Math.min(0.999, Math.max(0.001, c ? s / c : c2 ? s2 / c2 : 0.5)));
      let seed = 1; const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
      const wins = Array.from({ length: 1000 }, () => { const o = qYes.map((p) => rnd() < p); return Uint8Array.from(legIx, (ls) => (ls.every((x) => (x > 0 ? o[x - 1] : !o[-x - 1])) ? 1 : 0)); });
      const pos = new Map(settledBets.map((n, i) => [n, i]));
      sharedSd = (list) => {
        const ix = list.map((n) => pos.get(n));
        const hs = wins.map((w) => { let s = 0; for (const i of ix) s += w[i]; return s / ix.length; });
        const m = hs.reduce((a, b) => a + b, 0) / hs.length;
        return Math.sqrt(hs.reduce((a, b) => a + (b - m) * (b - m), 0) / (hs.length - 1));
      };
    }
    const realizedOf = (list) => {
      const k = list.length; if (!k) return { n: 0, implied: null, hit: null, ci: null, gap: null, stake: 0, pnl: 0, roi: null };
      const implied = list.reduce((a, n) => a + n.odds, 0) / k, hit = list.filter((n) => n.won).length / k;
      const stake = list.reduce((a, n) => a + n.stake, 0), pnl = list.reduce((a, n) => a + n.pnl, 0);
      // without the simulation (a single wallet's figures): the Wilson interval, which stays honest at a 0 % or 100 % hit
      // rate (a one-bet bucket reaches that trivially); it is centred off the raw hit rate, so its bounds are given as well
      const z = 1.96;
      if (sharedSd) return { n: k, implied, hit, ci: z * sharedSd(list), ciKind: 'shared', gap: implied - hit, stake, pnl, roi: stake > 0 ? pnl / stake : null };
      const ci = (z * Math.sqrt((hit * (1 - hit)) / k + (z * z) / (4 * k * k))) / (1 + (z * z) / k), c = (hit + (z * z) / (2 * k)) / (1 + (z * z) / k);
      return { n: k, implied, hit, ci, ciKind: 'wilson', lo: Math.max(0, c - ci), hi: Math.min(1, c + ci), gap: implied - hit, stake, pnl, roi: stake > 0 ? pnl / stake : null };
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
      bigWins: bigWins ? bigList() : undefined,
    };
    // the same {h, lp} for any record the caller writes (the snapshot's slip files); not enumerable, so not in the JSON
    Object.defineProperty(out, 'soldOf', { value: sold, enumerable: false });
    return out;
    // a bettor who sold its position tokens before the verdict does not collect the payout: its share still held (h) and
    // its own result on the prediction, the sale included (lp), from its ledger
    function sold(n) { const bp = ledgerOf[n.predictor] && ledgerOf[n.predictor][n.id]; return bp ? { h: r4(bp.held), lp: r4(bp.pnl) } : null; }
    // Big wins: what a bettor made, above P.BIG_WIN. A slip it kept: payout − stake, at its verdict. On picks whose
    // position tokens it traded, its bets share one token, so a position (P.positions: its bets until a sale leaves it
    // holding nothing) counts once, at its largest bet, with its own result: its sales, and the verdict on what it still
    // held. Listed when over P.BIG_WIN as a cash-out (it sold), whatever the verdict, or as a win (it held to a win). A
    // cash-out counts from its last sale when it sold everything or the picks are still open. Records keep the slip's
    // own h and lp (sold) and add gp {n, s, pool, in (stakes + tokens bought), lp, h (share still held)} and, for the
    // sales, co {t, cash, cost, tok} (P.unslim: group, cashOut). Newest first.
    function bigList() {
      const out = [];
      for (const n of norms) {
        const bp = ledgerOf[n.predictor] && ledgerOf[n.predictor][n.id];
        if (!bp && n.won && n.pnl > P.BIG_WIN) out.push({ at: P.decidedAt(n) || n.t, rec: P.slim(n, { ids: true }) });
      }
      for (const w of Object.keys(ledgerAll)) {
        for (const pos of P.positions(norms, ledgerAll[w], w, 'P')) {
          if (!(pos.pnl > P.BIG_WIN) || !pos.bets.length) continue;
          const cashed = pos.sales.length > 0, won = !!pos.bets[0].won;
          if (!cashed && !(pos.decided && won)) continue;   // nothing sold and no win: no result of its own yet (or a hedge's)
          const top = pos.bets.slice().sort((x, y) => y.stake - x.stake || x.t - y.t)[0];
          const rec = Object.assign(P.slim(top, { ids: true }), sold(top));
          rec.gp = { n: pos.bets.length, s: r4(pos.stake), pool: r4(U.sum(pos.bets, (x) => x.pool)), in: r4(pos.in), lp: r4(pos.pnl), h: r4(pos.held) };
          if (cashed) rec.co = { t: pos.t1, cash: r4(U.sum(pos.sales, (e) => e.cash)), cost: r4(U.sum(pos.sales, (e) => e.cost)), tok: r4(U.sum(pos.sales, (e) => e.tokens)) };
          out.push({ at: cashed && (pos.out || !pos.decided) ? pos.t1 : P.decidedAt(top) || top.t, rec });
        }
      }
      return out.sort((a, b) => b.at - a.at).map((x) => x.rec);
    }
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
   *  profit, and has won more of them than its locked odds implied. Its tier says how rarely luck alone gives that
   *  record: strong at strongLuck or rarer, good at goodLuck; when no winning bettor reaches good, the best record counts
   *  as good, so the list always has one to point at. (Plain thresholds, not a cut across every bettor tested: with some
   *  140 bettors ranked by luck, luck alone is expected to give up to a tenth of them a good record, so the tiers rank
   *  records and do not establish skill.) */
  P.IDEAS = { minDecided: 10, strongLuck: 0.02, goodLuck: 0.1 };
  /** { bettors, ideas, tested }: every winning bettor, least likely by luck first, with its tier and the number of its
   *  ideas; those ideas, the bettor's predictions the site still offers to copy at `now` (undecided, every leg before the
   *  end time Meridian lists for it, a listed end and no betting cutoff, and not settled, the bettor still holding at
   *  least half its tokens), best record first, then newest; tested = bettors with a record. agg: P.aggregate over the
   *  same norms (its bettor rows and soldOf). */
  P.ideas = function (norms, agg, now = Date.now()) {
    const tested = agg.bettors.filter((b) => b.rec && b.rec.n >= P.IDEAS.minDecided);
    const tierOf = (luck) => (luck <= P.IDEAS.strongLuck ? 'strong' : luck <= P.IDEAS.goodLuck ? 'good' : null);
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
    if (bettors.length && !bettors.some((b) => b.tier)) bettors[0].tier = 'good';   // the best record, when none reaches good
    return { bettors, ideas, tested: tested.length };
  };

  /** Bettor-level summary from that bettor's own predictions (subset of aggregate). */
  // (no record: it is the snapshot's, over every prediction with its question ids; a wallet file has neither)
  P.bettorSummary = (norms) => { const a = P.aggregate(norms, { tapeSize: 0, bigWins: false, records: false }); return { stats: a.bettors[0] || null, categories: a.categories, combos: a.combos, daily: a.daily, makers: a.makers }; };

  /** Slim record for the per-wallet snapshot files (≈400 bytes); P.unslim restores everything P.norm produces. */
  // Open predictions keep the leg's conditionId (6th element) so the resolution tracker can look the market up; settled
  // ones don't need it, except where o.ids asks for every leg's (question files, the Overview's tape and big wins).
  // Meridian's result for a settled question (9th element) says which legs won or lost a decided prediction.
  // leg = [question, yes, sourcePriceNow, endTime, category, conditionId, priceAtBet, polymarket event, result (1 YES, 0 NO, 2 50/50),
  //        Meridian settlement (s), source-market resolution (s, vt: only where o.vt asks, the wallet files)]
  // o.stx adds the claim's transaction (the wallet files; slips and question files stay small)
  const legResult = (k) => (k.settled ? (k.nonDecisive ? 2 : k.resolvedToYes ? 1 : 0) : null);
  function slimLegs(n, ids, vt) { return n.picks.map((k) => { const a = [k.q, k.yes ? 1 : 0, k.ep, k.endTime, k.cat, (ids || !n.settled) && k.id ? k.id : null, k.priceAtBet == null ? null : r4(k.priceAtBet), n.picks.length > 1 ? k.event || null : null, legResult(k), k.settled && k.settledAt ? Math.round(k.settledAt / 1000) : null, vt && k.verdictAt ? Math.round(k.verdictAt / 1000) : null]; while (a.length > 5 && a[a.length - 1] == null) a.pop(); return a; }); }
  P.slim = (n, o) => ({ id: n.id, t: n.t, sa: n.settledAt, p: n.predictor, c: n.counterparty, s: r4(n.stake), cp: r4(n.cp), st: n.settled ? 1 : 0, pc: n.pcTraded ? n.pc : undefined, dv: n.decided && !n.settled ? (n.won ? 1 : n.nd ? 2 : 0) : undefined, r: n.result, tx: n.tx, cat: n.cat, da: n.decidedAt || undefined, k: slimLegs(n, !!(o && o.ids), !!(o && o.vt)), stx: o && o.stx && n.stx ? n.stx : undefined });
  P.unslim = function (s) {
    if (s.picks) return s;                               // already a full record
    const stake = s.s || 0, cp = s.cp || 0, pool = stake + cp;
    const picks = (s.k || []).map(([q, yes, ep, endTime, cat, id, pb, ev, res, sat, vt]) => ({ id: id || null, q, short: q, yes: !!yes, ep, fair: ep == null ? null : (yes ? ep : 1 - ep), priceAtBet: pb == null ? null : pb, event: ev || null, settled: res != null, resolvedToYes: res === 1 ? true : res === 0 ? false : null, nonDecisive: res === 2, settledAt: res != null && sat ? sat * 1000 : null, verdictAt: vt ? vt * 1000 : null, cat: cat || s.cat, catSlug: null, endTime: endTime || null, tags: [] }));
    let fair = null; if (picks.length && picks.every((k) => k.fair != null)) { fair = 1; for (const k of picks) fair *= k.fair; }
    const odds = pool > 0 ? stake / pool : null; const settled = !!s.st; const decided = settled || s.dv != null;
    const won = settled ? s.r === 'PREDICTOR_WINS' : s.dv === 1; const nd = settled ? s.r === 'NON_DECISIVE' : s.dv === 2;
    const n = { id: s.id, t: s.t, settledAt: s.sa || null, predictor: s.p, counterparty: s.c, stake, cp, pool, odds, multiple: stake > 0 ? pool / stake : null, legs: picks.length, combo: picks.length > 1, picks, fair, fairNow: fair, vigNow: odds != null && fair != null ? odds - fair : null, fairAtBet: null, vig: null, vigPct: null, cat: s.cat, cats: Array.from(new Set(picks.map((k) => k.cat))), settled, decided, unclaimed: decided && !settled, result: settled ? (s.r || null) : decided ? (won ? 'PREDICTOR_WINS' : nd ? 'NON_DECISIVE' : 'COUNTERPARTY_WINS') : null, won, lost: decided && !won && !nd, nd, pnl: decided && !nd ? (won ? cp : -stake) : 0, endsAt: null, tx: s.tx || null, stx: s.stx || null, pc: s.pc || null, pcTraded: !!s.pc,   // a file keeps pc only where its tokens were traded
      // big wins and tape rows: when it was decided (from the source markets' resolution), and for a bettor who traded its
      // position tokens the share it still held at the verdict and its own result, the sale included (P.aggregate)
      decidedAt: s.da || null, held: s.h == null ? null : s.h, tradedPnl: s.lp == null ? null : s.lp,
      // big wins: a traded position (its bets on the same picks, counted together) and its sales (P.aggregate's bigList)
      group: s.gp || null, cashOut: s.co || null };
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
      r: settled ? (x.won ? 'PREDICTOR_WINS' : x.nd ? 'NON_DECISIVE' : 'COUNTERPARTY_WINS') : null, tx: x.tx, stx: x.stx, cat: x.cat, h: x.h, lp: x.lp, da: x.da, k: x.k || [[x.q || '', x.yes ? 1 : 0]] });
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

  /** When a wallet redeemed its position tokens, from its own burns (a claim burns the wallet's whole balance of the
   *  token: Transfer wallet → 0x0, read from the chain by the snapshot builder). logs: [{token, amount (tokens), t (ms)}];
   *  byTok: token address → '<pc>|<P|C>' (object or Map); held: '<pc>|<P|C>' → tokens held at the verdict, or {tokens,
   *  after (the verdict, ms)}: burns more than a day before it are not this redemption. Returns {'<pc>|<P|C>': ms}: the
   *  burn at which the tokens burned reach the tokens held (a hundredth of a token, or 0.01 %, short is rounding: the
   *  files keep amounts to 4 decimals), else the last burn (fewer tokens than the ledger counts reached the wallet);
   *  none for tokens never burned. */
  P.redemptionTimes = function (logs, byTok, held) {
    const keyOf = (tok) => { const a = String(tok || '').toLowerCase(); return byTok instanceof Map ? byTok.get(a) : byTok[a]; };
    const by = {};
    for (const l of logs || []) { const key = keyOf(l.token); if (key && held[key] != null) (by[key] || (by[key] = [])).push(l); }
    const out = {};
    for (const key of Object.keys(by)) {
      const hd = typeof held[key] === 'number' ? { tokens: held[key] } : held[key];
      const from = hd.after != null ? hd.after - DAY : -Infinity;
      const list = by[key].filter((l) => l.t >= from && l.amount > 0).sort((a, b) => a.t - b.t);
      if (!list.length) continue;
      const need = hd.tokens - Math.max(0.01, hd.tokens * 1e-4);
      let cum = 0, at = null;
      for (const l of list) { cum += l.amount; if (cum >= need) { at = l.t; break; } }
      out[key] = at != null ? at : list[list.length - 1].t;
    }
    return out;
  };

  /** The tax center's compact rows for a wallet file that keeps only its newest predictions (rowsFmt 1): every
   *  prediction of the wallet in either role (self-matches left out), newest first, as
   *  [t (ms), stakeW (its own collateral), pnlW (its result once decided, signed for its role; 0 while open or void),
   *   code, claimable (s, P.decidedAt), verdict (s, P.sourceVerdictAt), claim (s, the claim that settled it, by either
   *   side), traded (1: a pick configuration the wallet traded, booked through P.ledger)], 0 where a time is not there.
   *  code: the result from the wallet's side in bits 0-1 (0 open, 1 won, 2 lost, 3 void), +4 claimable estimated, +8
   *  verdict without its source time (the Meridian settlement or less), +16 the wallet is the maker. */
  P.ROWS_FMT = 1;
  P.taxRows = function (norms, addr, isTraded) {
    addr = String(addr || '').toLowerCase();
    const s = (t) => (t ? Math.round(t / 1000) : 0);
    return (norms || []).filter((n) => (n.predictor === addr || n.counterparty === addr) && !P.selfMatch(n)).sort((a, b) => b.t - a.t).map((n) => {
      const mk = n.counterparty === addr;
      const res = !n.decided ? 0 : n.nd ? 3 : (mk ? n.lost : n.won) ? 1 : 2;
      const exactDec = n.decided && !!(P.legVerdictAt(n) || n.decidedAt);
      const v = n.decided ? P.sourceVerdictAt(n) : null;
      const code = res + (n.decided && !exactDec ? 4 : 0) + (v && !v.exact ? 8 : 0) + (mk ? 16 : 0);
      return [n.t, r4(mk ? n.cp : n.stake), r4(mk ? -n.pnl : n.pnl), code, n.decided ? s(P.decidedAt(n)) : 0, v ? s(v.t) : 0, n.settled ? s(n.settledAt) : 0, isTraded && isTraded(n) ? 1 : 0];
    });
  };
  /** One P.taxRows row as {t, stakeW, pnlW, res ('open' | 'won' | 'lost' | 'void'), maker, claimable {t, exact},
   *  verdict {t, exact}, claim (ms or null), traded}. */
  P.fromTaxRow = (r) => {
    const code = r[3] | 0, res = ['open', 'won', 'lost', 'void'][code & 3];
    return { t: r[0], stakeW: r[1], pnlW: r[2], res, maker: !!(code & 16), claimable: r[4] ? { t: r[4] * 1000, exact: !(code & 4) } : null, verdict: r[5] ? { t: r[5] * 1000, exact: !(code & 8) } : null, claim: r[6] ? r[6] * 1000 : null, traded: !!r[7] };
  };
  /** Compact question row for the snapshot's question explorer. */
  P.compactQuestion = (c) => ({ id: c.conditionId, q: c.question, short: c.shortName, cat: c.category ? c.category.name : null, slug: c.category ? c.category.slug : null, tags: (c.tags || []).slice(0, 6), ep: c.estimatedPrice == null ? null : Number(c.estimatedPrice), oi: P.usd(c.openInterest), v24: Number(c.similarMarketVolume24h) || 0, v7: Number(c.similarMarketVolume7d) || 0, end: c.endTime ? c.endTime * 1000 : null, created: c.createdAt ? P.ms(c.createdAt) : null, settled: !!c.settled, yes: c.resolvedToYes, nd: !!c.nonDecisive, pub: c.isPublic == null ? null : !!c.isPublic, src: c.similarMarket && c.similarMarket.markets ? c.similarMarket.markets[0] : null });
  P.compactTrade = (x) => { const tokens = P.usd(x.tokenAmount), paid = P.usd(x.price); return { t: x.executedAt * 1000, seller: String(x.seller || '').toLowerCase(), buyer: String(x.buyer || '').toLowerCase(), tokens, paid, px: tokens > 0 ? paid / tokens : null, tx: x.txHash, token: String(x.token || '').toLowerCase() }; };
})();
