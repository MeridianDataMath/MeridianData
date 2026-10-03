/* MeridianDataHub — Tax center: one wallet's Meridian Predict record for a period. Both sides of every prediction (as the
   bettor: its stake against the maker's collateral; as the market maker: its collateral against the bettor's stake),
   the secondary market through the wallet's ledger (P.ledger), and three date bases a result can be booked at, none of
   them marked as the one that applies: the claim (the default), the settlement on Meridian (claimable), and the source
   market's resolution (verdict). Sales and matched sets are booked on their own dates under every basis. Records only:
   no tax is computed. Pure: reads MD.predict when called, no DOM, no network (the page loads the data: view-predict). */
(function () {
  const MD = window.MD; const U = MD.util; const T = MD.tax;
  const PR = (T.predict = {});
  const EPS = 1e-9;
  // the wallet files keep stakes and collateral to 4 decimals: a verdict on a remainder below this pays nothing anyone
  // could redeem (the builder, at full precision, finds no position there), so it is no result to list or date
  const DUST = 1e-3;
  const dustVerdict = (e) => Math.abs(e.cash || 0) <= DUST && Math.abs(e.pnl || 0) <= DUST;
  // a wallet whose record holds tokens to a verdict that pays: only then does the dating of held tokens matter
  const paysHeld = (prep) => !!(prep && prep.L && prep.L.events.some((e) => e.kind === 'verdict' && e.cash > DUST));
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ---------- date bases ----------
  // Words: 'decided (settled on Meridian)' is Meridian's verdict, the moment a result becomes claimable; 'claimed (paid
  // out)' is collecting it; the source market 'resolved' it. The rest of the site says 'Settled' for the verdict, so the
  // tax center never says a bare 'settled'.
  PR.MODES = ['claim', 'claimable', 'verdict'];
  PR.DEFAULT = 'claim';
  /** the select's options, and the words a file or tile uses for each basis */
  PR.MODE_LABEL = { claim: 'claim: claimed, paid out (default)', claimable: 'claimable: decided, settled on Meridian', verdict: 'verdict: source market resolved' };
  PR.MODE_TEXT = {
    claim: 'when claimed (paid out): a win or void when this wallet claims it, a loss when the counterparty claims the pool, tokens held to the verdict when this wallet redeems them',
    claimable: 'when decided (settled on Meridian), the moment they became claimable',
    verdict: 'when the source market resolved them, or when decided on Meridian where that time is not known',
  };
  /** the basis as a file's 'Date basis' cell says it */
  PR.MODE_FILE = { claim: 'claim (when claimed, paid out)', claimable: 'claimable (when decided: settled on Meridian)', verdict: 'verdict (when the source market resolved)' };
  /** the tiles' words for what a basis books: 'claimed in period' or 'booked in period' */
  PR.countsLabel = (mode) => (mode === 'claim' ? 'claimed in period' : 'booked in period');
  /** the summary row's name for the Predict figure under a basis */
  PR.pnlLabel = (mode) => 'Predict realized PnL (' + { claim: 'results booked when claimed, paid out', claimable: 'results booked when decided, settled on Meridian', verdict: 'results booked when the source market resolved' }[PR.modeOf(mode)] + ')';
  PR.modeOf = (v) => (PR.MODES.includes(v) ? v : PR.DEFAULT);
  // without the wallet's own redemption times (the snapshot's rd: none yet for this wallet), P.ledger dates tokens held
  // to a winning verdict by its own claim on that side, else by the latest claim on the pick configuration by anyone,
  // which may be another wallet's: every text that says when they are booked says so
  const HELD_NO_RD = 'by this wallet\'s own claim on that side, else by the latest claim on that pick configuration by any wallet (the snapshot has no redemption times for this wallet yet)';
  /** PR.MODE_TEXT for a wallet's record (prep): on the claim basis without redemption times, how held tokens are dated. */
  PR.modeText = (mode, prep) => {
    mode = PR.modeOf(mode);
    return mode === 'claim' && prep && !prep.rd && paysHeld(prep) ? 'when claimed (paid out): a win or void when this wallet claims it, a loss when the counterparty claims the pool, tokens held to a winning verdict ' + HELD_NO_RD : PR.MODE_TEXT[mode];
  };
  /** How the claim basis dates tokens held to a winning verdict, for the methodology: null without a record. */
  PR.heldClaimText = (prep) => (!prep ? null : prep.rd ? 'by this wallet\'s own redemption (its burn of the tokens, read from Robinhood Chain), else its own claim on that side' : paysHeld(prep) ? HELD_NO_RD : null);

  /** Live rows (from the API) take from the wallet's snapshot file what the API does not give them: the claims of
   *  predictions paid through a twin prediction of another wallet on the same token (the snapshot sees every wallet's
   *  claims and marks them, P.markTokenClaims; live, only this wallet's predictions are seen, so its losses claimed that
   *  way would read unclaimed for good), each leg's source-market resolution (vt) and the snapshot's decision time.
   *  fileNorms: the file's predictions, unslimmed. Returns how many claims were taken from the file. */
  PR.mergeSnapshot = (norms, fileNorms) => {
    const byId = new Map((fileNorms || []).map((f) => [f.id, f]));
    let k = 0;
    for (const n of norms || []) {
      const f = byId.get(n.id); if (!f) continue;
      (n.picks || []).forEach((leg, i) => { const g = f.picks && f.picks[i]; if (g && g.verdictAt && !leg.verdictAt) leg.verdictAt = g.verdictAt; });
      if (!n.decidedAt && f.decidedAt) n.decidedAt = f.decidedAt;
      if (n.unclaimed && f.settled && f.settledAt && f.settledAt >= n.t) { n.settled = true; n.unclaimed = false; n.settledAt = f.settledAt; n.viaToken = true; if (!n.stx && f.stx) n.stx = f.stx; k++; }
    }
    return k;
  };

  /** A prediction's dates from the wallet's side (x: an item of prepare's mine): placed; claimable {t, exact} (P.decidedAt:
   *  exact from the legs' own settlement times, else estimated); verdict {t, exact} (P.sourceVerdictAt: exact with every
   *  leg's source time); claim {t, by: 'self' | 'counterparty'} (whoever won claims: this wallet for its win or a void's
   *  refund, the counterparty for this wallet's loss). Null where not there yet. */
  PR.dates = (x) => {
    const P = MD.predict; const n = x.n || x;
    if (!n.decided) return { placed: n.t, claimable: null, verdict: null, claim: null };
    const wonW = x.wonW != null ? x.wonW : n.won;
    return {
      placed: n.t,
      claimable: { t: P.decidedAt(n), exact: !!(P.legVerdictAt(n) || n.decidedAt) },
      verdict: P.sourceVerdictAt(n),
      claim: n.settled && n.settledAt ? { t: n.settledAt, by: wonW || n.nd ? 'self' : 'counterparty' } : null,
    };
  };
  /** When an item is booked under a basis (null: not yet, in claim mode while nobody has claimed). */
  PR.when = (it, mode) => (it.res === 'open' ? null : mode === 'claim' ? (it.claim ? it.claim.t : null) : mode === 'claimable' ? (it.claimable ? it.claimable.t : null) : it.verdict ? it.verdict.t : it.claimable ? it.claimable.t : null);
  /** When a ledger verdict (tokens held to the verdict) is booked under a basis. */
  const whenVerdict = (e, mode) => (mode === 'claim' ? (e.claimAt || null) : mode === 'claimable' ? e.t : e.vt || e.t);

  // ---------- the wallet's record ----------
  /**
   * o: {norms (the loaded predictions, normalised), trades (the wallet's file), rd (its own redemptions, the file's rd),
   * rows / rowsFmt (the file's compact row for every prediction, P.taxRows, when it keeps only the newest), truncated,
   * total (predictions in all), newest (how many of them are loaded), cutoff (ms: rows count for predictions placed
   * before it, the loaded ones from it; Infinity when the rows are the snapshot's own), addr (the Predict wallet), live,
   * builtAt}.
   * Returns {addr, mine: [{n, role, stakeW, pnlW, wonW, lostW, ndW, held, notSold, traded}], L (P.ledger), items (what is
   * booked: the loaded predictions, or the rows plus the loaded ones placed from cutoff), coverage}.
   * mine covers both roles, a bet against itself left out (it moves no money); stakeW is the wallet's own collateral and
   * pnlW its result, signed for its role. held: the share the verdict settles (a traded prediction: the tokens not sold
   * or matched); notSold: the share not sold (a matched set still holds its tokens).
   */
  PR.prepare = (o) => {
    const P = MD.predict;
    const addr = String(o.addr || '').toLowerCase();
    const all = (o.norms || []).filter((n) => (n.predictor === addr || n.counterparty === addr) && !P.selfMatch(n));
    const L = P.ledger(all, o.trades || [], addr, o.rd || undefined);
    const mine = all.map((n) => {
      const mk = n.counterparty === addr; const bp = L.byPrediction[n.id];
      const x = { n, role: mk ? 'maker' : 'bettor', stakeW: mk ? n.cp : n.stake, pnlW: mk ? -n.pnl : n.pnl, wonW: mk ? n.lost : n.won, lostW: mk ? n.won : n.lost, ndW: n.nd, held: bp ? (bp.atRisk != null ? bp.atRisk : bp.held) : 1, notSold: bp ? bp.held : 1, traded: !!bp };
      return x;
    });
    const itemOf = (x) => { const d = PR.dates(x); return { t: x.n.t, stakeW: x.stakeW, pnlW: x.pnlW, res: !x.n.decided ? 'open' : x.ndW ? 'void' : x.wonW ? 'won' : 'lost', maker: x.role === 'maker', claimable: d.claimable, verdict: d.verdict, claim: d.claim, traded: x.traded, pc: x.n.pc || null, x }; };
    const okRows = !!(o.truncated && Array.isArray(o.rows) && o.rows.length && o.rowsFmt === P.ROWS_FMT);
    const cutoff = okRows ? (o.cutoff != null ? o.cutoff : Infinity) : -Infinity;
    const items = [];
    if (okRows) for (const r of o.rows) { if (!(r[0] < cutoff)) continue; const d = P.fromTaxRow(r); items.push(Object.assign(d, { claim: d.claim != null ? { t: d.claim, by: d.res === 'lost' ? 'counterparty' : 'self' } : null, x: null })); }
    for (const x of mine) if (x.n.t >= cutoff) items.push(itemOf(x));
    const roles = { bettor: mine.filter((x) => x.role === 'bettor').length, maker: mine.filter((x) => x.role === 'maker').length };
    if (okRows) { roles.bettor = items.filter((it) => !it.maker).length; roles.maker = items.filter((it) => it.maker).length; }
    return { addr, mine, L, items, rd: o.rd || null, live: !!o.live, coverage: { truncated: !!o.truncated, rows: okRows, loaded: (o.norms || []).length, total: o.total != null ? o.total : (o.norms || []).length, newest: o.newest != null ? o.newest : (o.norms || []).length, roles, builtAt: o.builtAt || null, live: !!o.live } };
  };

  /**
   * The wallet's USDe in and out of its Predict wallet, by exact instant (the USDe lots, T.lots): [{t, kind, amount (+
   * in, − out), what, id, tx}], ascending. Out: every placement's own stake or collateral ('stake'), every position token
   * bought ('buy'). In: a win's payout and a void's refund when this wallet claims them ('payout', 'refund'); a token
   * sale ('sale'); tokens held to the verdict when this wallet redeems them ('redeem': P.ledger's verdict at its claimAt,
   * the wallet's own burn), and a matched set with them ('set'), else at the pick configuration's first own burn or own
   * claim. A loss pays nothing (the stake left at the placement); what is decided and not claimed or redeemed is not
   * USDe yet. A prediction on a pick configuration the wallet traded is paid through its tokens (the ledger), never twice.
   */
  PR.cash = (prep) => {
    const out = [], addr = prep.addr, L = prep.L, rd = prep.rd || null;
    const idOf = (it) => (it.x ? it.x.n.id : ''), txOf = (it) => (it.x ? it.x.n.tx || '' : ''), stxOf = (it) => (it.x ? it.x.n.stx || '' : '');
    const ownClaim = new Map();
    for (const it of prep.items) {
      if (it.stakeW > EPS) out.push({ t: it.t, kind: 'stake', amount: -it.stakeW, what: (it.maker ? 'maker collateral' : 'stake') + ' placed', id: idOf(it), tx: txOf(it) });
      if (it.res === 'open' || !it.claim || it.claim.by !== 'self') continue;
      if (it.pc) ownClaim.set(it.pc, Math.min(ownClaim.has(it.pc) ? ownClaim.get(it.pc) : Infinity, it.claim.t));
      if (it.traded) continue;
      if (it.res === 'won') out.push({ t: it.claim.t, kind: 'payout', amount: it.stakeW + it.pnlW, what: 'payout claimed', id: idOf(it), tx: stxOf(it) });
      else if (it.res === 'void') out.push({ t: it.claim.t, kind: 'refund', amount: it.stakeW, what: 'void refund claimed', id: idOf(it), tx: stxOf(it) });
    }
    for (const tr of L.trades) {
      if (tr.buyer === addr && tr.seller !== addr) out.push({ t: tr.t, kind: 'buy', amount: -tr.paid, what: 'position tokens bought', id: tr.pid || tr.pc || '', tx: tr.tx || '' });
      else if (tr.seller === addr && tr.buyer !== addr) out.push({ t: tr.t, kind: 'sale', amount: tr.paid, what: 'position tokens sold', id: tr.pid || tr.pc || '', tx: tr.tx || '' });
    }
    const redeemed = new Map();
    for (const e of L.events) if (e.kind === 'verdict' && e.claimAt != null) { redeemed.set(e.pc, e.claimAt); if (e.cash > EPS) out.push({ t: e.claimAt, kind: 'redeem', amount: e.cash, what: 'position tokens redeemed', id: e.pc || '' }); }
    const burnOf = (pc) => { const a = rd ? rd[pc + '|P'] : null, b = rd ? rd[pc + '|C'] : null; const l = [a, b, ownClaim.get(pc)].filter((x) => x != null && Number.isFinite(x)); return l.length ? Math.min(...l) : null; };
    for (const e of L.events) if (e.kind === 'set' && e.cash > EPS) { const t = redeemed.has(e.pc) ? redeemed.get(e.pc) : burnOf(e.pc); if (t != null) out.push({ t: Math.max(t, e.t), kind: 'set', amount: e.cash, what: 'matched set redeemed (both sides held)', id: e.pc || '' }); }
    return out.sort((a, b) => a.t - b.t);
  };
  /** What the loaded data leaves out, in words: {text, blocking} (blocking: the period figures are incomplete), or null. */
  PR.coverageNote = (prep) => {
    const c = prep.coverage; if (!c.truncated) return null;
    const role = c.roles.maker >= c.roles.bettor ? 'the market maker' : 'the bettor';
    const src = c.live ? 'the API returned' : 'the snapshot keeps';
    const N = U.fmtNum(c.total, 0), M = U.fmtNum(c.newest, 0);
    if (c.rows) return { blocking: false, text: `This wallet is ${role} on ${N} predictions and ${src} only the newest ${M} of ${N} in full: the period figures come from the snapshot's row for every prediction (complete), the per-prediction export lists only the ${U.fmtNum(prep.mine.length, 0)} loaded in full.` };
    return { blocking: true, text: `This wallet is ${role} on ${N} predictions; ${src} only the newest ${M} of ${N}, so the period figures are incomplete.` };
  };
  /** The note every per-prediction file carries when it cannot list every prediction (null when it can). */
  PR.fileNote = (prep) => {
    const c = prep.coverage; if (!c.truncated) return null;
    const note = PR.coverageNote(prep);
    return note.blocking ? note.text : `This file lists the newest ${U.fmtNum(prep.mine.length, 0)} of the wallet's ${U.fmtNum(c.total, 0)} predictions only (the rest are in the period totals, not listed here).`;
  };

  /**
   * Everything booked under a date basis, by exact instant: [{t, kind, pnl, payout, cost, winGain, lostStake, refund,
   * stake, count, ledger, ref}]. Kinds: 'placed' (stake, every basis: the wagered figures), 'won' / 'lost' / 'void' (a
   * prediction's result; one on a traded pick configuration is only counted (ledger: true, its money is in the ledger's
   * events)), 'sale' / 'set' (the secondary market, on their own dates under every basis), 'held-verdict' (tokens held to
   * the verdict), 'buy' (a purchase: no result of its own). winGain: payout − stake of a win; payout: what a win pays
   * (the pool); lostStake: the collateral a loss forfeits.
   */
  PR.book = (prep, mode) => {
    const ev = [];
    // a traded prediction's result is counted when the ledger books its pick configuration's verdict (where the wallet
    // still held tokens), else at its own date
    const verdictOf = new Map(prep.L.events.filter((e) => e.kind === 'verdict').map((e) => [e.pc, e]));
    for (const it of prep.items) {
      ev.push({ t: it.t, kind: 'placed', stake: it.stakeW, pnl: 0, ref: it });
      if (it.res === 'open') continue;
      const ve = it.traded && it.pc ? verdictOf.get(it.pc) : null;
      const t = ve ? whenVerdict(ve, mode) : PR.when(it, mode); if (t == null) continue;
      if (it.traded) { ev.push({ t, kind: it.res, count: 1, ledger: true, pnl: 0, ref: it }); continue; }
      const e = { t, kind: it.res, count: 1, pnl: it.res === 'void' ? 0 : it.pnlW, payout: 0, cost: it.stakeW, winGain: 0, lostStake: 0, refund: 0, ref: it };
      if (it.res === 'won') { e.winGain = it.pnlW; e.payout = it.stakeW + it.pnlW; } else if (it.res === 'lost') e.lostStake = -it.pnlW; else e.refund = it.stakeW;
      ev.push(e);
    }
    for (const e of prep.L.events) {
      if (e.kind === 'verdict') { const t = whenVerdict(e, mode); if (t != null) ev.push({ t, kind: 'held-verdict', pnl: e.pnl, payout: e.cash, cost: e.cost, ref: e }); }
      else ev.push({ t: e.t, kind: e.kind, pnl: e.pnl, payout: e.cash, cost: e.cost, ref: e });
    }
    for (const tr of prep.L.trades) if (tr.buyer === prep.addr && tr.seller !== prep.addr) ev.push({ t: tr.t, kind: 'buy', pnl: 0, cost: tr.paid, ref: tr });
    return ev.sort((a, b) => a.t - b.t);
  };

  /**
   * The results not claimed by the period's end: this wallet's wins and voids it has not claimed, its losses the
   * counterparty has not claimed, and tokens held to a verdict it has not redeemed (or, worthless, the winners have not
   * claimed). In claim mode, those decided in the period (P.decidedAt: the settlement on Meridian), outside the total
   * ('Decided, not claimed'); under the other bases, those the basis books in the period (PR.when; a ledger verdict at
   * its own booking), in the total and listed for information ('Booked, not yet claimed'): a result resolved at the
   * source just before the period and decided on Meridian in it is the previous period's under the verdict basis.
   * Every item is listed at its decision. Returns {items [{t (decided), exact, booked (when the basis books it), kind,
   * pnl, won, void, claimAt, ref}], title, booked}.
   */
  PR.tail = (prep, mode, period) => {
    const { start, end } = period; const out = []; const claim = mode === 'claim';
    const inP = (t) => t != null && t >= start && t < end;
    for (const it of prep.items) {
      if (it.res === 'open' || it.traded || !it.claimable) continue;
      const d = it.claimable.t, b = claim ? d : PR.when(it, mode); if (!inP(b)) continue;
      const c = it.claim ? it.claim.t : null; if (c != null && c < end) continue;
      out.push({ t: d, exact: it.claimable.exact, booked: b, kind: it.res, pnl: it.res === 'void' ? 0 : it.pnlW, won: it.res === 'won', void: it.res === 'void', claimAt: c, ref: it });
    }
    for (const e of prep.L.events) {
      if (e.kind !== 'verdict' || dustVerdict(e)) continue;
      const b = claim ? e.t : whenVerdict(e, mode); if (!inP(b)) continue;
      if (e.claimAt != null && e.claimAt < end) continue;
      out.push({ t: e.t, exact: true, booked: b, kind: 'held-verdict', pnl: e.pnl, won: e.cash > EPS, void: false, claimAt: e.claimAt || null, ref: e });
    }
    out.sort((a, b) => a.t - b.t);
    return { items: out, booked: !claim, title: claim ? 'Decided, not claimed' : 'Booked, not yet claimed' };
  };

  /**
   * The period's figures from booked events (PR.book) and the tail (PR.tail), by local date in tz; every amount in the
   * report currency at its own date's rate (money.fx). Returns totals {pnl, winGain, payouts, lostStakes, refunds,
   * ledgerGains, ledgerLosses, secondary, wagered (each with ...C in the report currency), placed, won, lost, void (own
   * predictions booked), held (token positions held to the verdict, booked), buys}, days and months (local, each with
   * the same fields; days carry cumPnl and cumPnlC, the in-period cumulative), and tail {items, title, booked, pnl, pnlC,
   * won, lost, void, n}. winGain − lostStakes + ledgerGains + ledgerLosses = pnl.
   */
  PR.figures = (events, tail, period, money, tz) => {
    const TZ = T.tz; const { start, end } = period;
    const zero = () => ({ pnl: 0, pnlC: 0, winGain: 0, winGainC: 0, payouts: 0, payoutsC: 0, lostStakes: 0, lostStakesC: 0, refunds: 0, refundsC: 0, ledgerGains: 0, ledgerGainsC: 0, ledgerLosses: 0, ledgerLossesC: 0, secondary: 0, secondaryC: 0, wagered: 0, wageredC: 0, placed: 0, won: 0, lost: 0, void: 0, held: 0, buys: 0 });
    const add = (r, k, v, t) => { r[k] += v; r[k + 'C'] += money.fx(v, t); };
    const byDay = new Map();
    const dayRow = (t) => { const k = TZ.dayKey(t, tz); let r = byDay.get(k); if (!r) { r = Object.assign({ key: k, t }, zero()); byDay.set(k, r); } return r; };
    for (const e of events) {
      if (!(e.t >= start && e.t < end)) continue;
      const r = dayRow(e.t);
      if (e.kind === 'placed') { r.placed++; add(r, 'wagered', e.stake, e.t); continue; }
      if (e.kind === 'buy') { r.buys++; continue; }
      if (e.count) r[e.kind === 'won' ? 'won' : e.kind === 'lost' ? 'lost' : 'void']++;
      if (e.ledger) continue;
      add(r, 'pnl', e.pnl, e.t);
      if (e.kind === 'won') { add(r, 'winGain', e.winGain, e.t); add(r, 'payouts', e.payout, e.t); }
      else if (e.kind === 'lost') add(r, 'lostStakes', e.lostStake, e.t);
      else if (e.kind === 'void') add(r, 'refunds', e.refund, e.t);
      else { add(r, e.pnl >= 0 ? 'ledgerGains' : 'ledgerLosses', e.pnl, e.t); if (e.kind !== 'held-verdict') add(r, 'secondary', e.pnl, e.t); else if (!(e.ref && dustVerdict(e.ref))) r.held++; }
    }
    const days = Array.from(byDay.values()).sort((a, b) => (a.key < b.key ? -1 : 1));
    { let cum = 0, cumC = 0; for (const r of days) { cum += r.pnl; cumC += r.pnlC; r.cumPnl = cum; r.cumPnlC = cumC; } }
    const sum = (list, into) => { for (const r of list) for (const k of Object.keys(zero())) into[k] += r[k]; return into; };
    const months = new Map();
    for (const r of days) { const k = r.key.slice(0, 7); let m = months.get(k); if (!m) { m = Object.assign({ key: k, label: MON[+k.slice(5, 7) - 1] + ' ' + k.slice(0, 4), t: r.t }, zero()); months.set(k, m); } sum([r], m); }
    const totals = sum(days, zero());
    const ti = tail ? tail.items : [];
    const tl = { items: ti, title: tail ? tail.title : '', booked: tail ? tail.booked : false, n: ti.length, pnl: U.sum(ti, (x) => x.pnl), pnlC: U.sum(ti, (x) => money.fx(x.pnl, x.booked != null ? x.booked : x.t)), won: ti.filter((x) => x.won).length, void: ti.filter((x) => x.void).length };
    tl.lost = tl.n - tl.won - tl.void;
    return Object.assign(totals, { days, months: Array.from(months.values()), tail: tl });
  };

  /** Whether the period has anything to show: a placement, a result booked under any basis, a sale, set or purchase,
   *  or a result decided in it and not claimed (a period whose only event is an unclaimed win is not empty). */
  PR.hasActivity = (prep, period) => PR.MODES.some((m) => PR.book(prep, m).some((e) => e.t >= period.start && e.t < period.end)) || PR.tail(prep, PR.DEFAULT, period).items.length > 0;
  /** The period's realized PnL under every basis: {claim: {pnl, pnlC}, claimable: …, verdict: …}. */
  PR.compare = (prep, period, money) => {
    const out = {};
    for (const m of PR.MODES) { let pnl = 0, pnlC = 0; for (const e of PR.book(prep, m)) if (e.t >= period.start && e.t < period.end && !e.ledger && e.kind !== 'placed' && e.kind !== 'buy') { pnl += e.pnl; pnlC += money ? money.fx(e.pnl, e.t) : e.pnl; } out[m] = { pnl, pnlC }; }
    return out;
  };
  /** What is at stake now, at cost: the wallet's collateral in undecided predictions it did not trade, and on every pick
   *  configuration it traded that is not decided, the cost of the tokens it still holds (its own predictions'
   *  collateral not sold, and position tokens it bought: P.ledger's open). */
  PR.openStakes = (prep) => U.sum(prep.items.filter((it) => it.res === 'open' && !it.traded), (it) => it.stakeW) + U.sum(Object.values(prep.L.open || {}), (o) => Math.max(0, o.cost));

  // ---------- holdings at an instant ----------
  /** The wallet's ledger (P.ledger) as it stood at instant T0: its predictions placed and trades made before T0, and a
   *  pick configuration's verdict only where it was decided before T0 (its decision time as P.ledger takes it: its
   *  trades', else its own predictions'). Claims and redemptions keep their real times, so tokens decided before T0 and
   *  redeemed after it read as not yet redeemed at T0. */
  PR.ledgerAt = (prep, T0) => {
    const P = MD.predict;
    const dec = new Map();
    for (const t of prep.L.trades) if (t.pc && t.dAt) dec.set(t.pc, t.dAt);
    for (const x of prep.mine) { const n = x.n; if (n.pc && n.decided && !dec.has(n.pc)) dec.set(n.pc, P.decidedAt(n)); }
    const known = (pc) => dec.has(pc) && dec.get(pc) < T0;
    const undecided = (n) => Object.assign({}, n, { decided: false, settled: false, unclaimed: false, won: false, lost: false, nd: false, result: null, pnl: 0, settledAt: null });
    const norms = prep.mine.map((x) => x.n).filter((n) => n.t < T0).map((n) => (!n.decided || known(n.pc) ? n : undecided(n)));
    const trades = prep.L.trades.filter((t) => t.t < T0).map((t) => (known(t.pc) ? t : Object.assign({}, t, { vP: null, vC: null, dAt: null })));
    return P.ledger(norms, trades, prep.addr, prep.rd || undefined);
  };
  /**
   * What the wallet held in Meridian Predict at instant T0, at cost, from what happened before it: {t, open {n, cost}
   * (its own predictions placed and not decided before T0: its stake or collateral; one on a pick configuration it had
   * traded by then is in the tokens), tokens {n (pick configurations), tokens, cost} (position tokens on pick configurations not
   * decided before T0, at the ledger's average cost: PR.ledgerAt), unclaimed {won, payout, lost, lostStake, void,
   * refund, held, heldValue, heldCost, heldLost} (decided before T0, by the decision time, and not claimed by it: a
   * win's payout, stake included; a loss counted, with the collateral it forfeits; a void's refund; tokens held to the
   * verdict and not redeemed, what they pay and cost, worthless ones counted), cost (open + tokens)}. What an open
   * prediction is worth at T0 is not known here: these are the record's costs.
   */
  PR.holdingsAt = (prep, T0) => {
    const o = { t: T0, open: { n: 0, cost: 0 }, tokens: { n: 0, tokens: 0, cost: 0 }, unclaimed: { won: 0, payout: 0, lost: 0, lostStake: 0, void: 0, refund: 0, held: 0, heldValue: 0, heldCost: 0, heldLost: 0 }, cost: 0 };
    const u = o.unclaimed;
    // a prediction on a pick configuration the wallet traded is in the ledger's tokens from the wallet's first trade on
    // it; before that it is a prediction like any other. A compact row (a big maker's file) has no pick configuration:
    // it is found among the loaded predictions by its time and stake (none found: in the ledger)
    const first = new Map(); for (const t of prep.L.trades) if (t.pc && !(first.get(t.pc) <= t.t)) first.set(t.pc, t.t);
    const pcOf = new Map(); for (const x of prep.mine) if (x.n.pc) pcOf.set(x.n.t + '|' + Math.round(x.stakeW * 1e4), x.n.pc);
    const inLedger = (it) => { if (!it.traded) return false; const pc = it.pc || pcOf.get(it.t + '|' + Math.round(it.stakeW * 1e4)); return pc == null || first.get(pc) < T0; };
    for (const it of prep.items) {
      if (!(it.t < T0) || inLedger(it)) continue;
      const dec = it.res !== 'open' && it.claimable ? it.claimable.t : null;
      if (dec == null || !(dec < T0)) { o.open.n++; o.open.cost += it.stakeW; continue; }
      if (it.claim && it.claim.t < T0) continue;
      if (it.res === 'won') { u.won++; u.payout += it.stakeW + it.pnlW; }
      else if (it.res === 'lost') { u.lost++; u.lostStake += it.stakeW; }
      else { u.void++; u.refund += it.stakeW; }
    }
    const L = PR.ledgerAt(prep, T0);
    for (const x of Object.values(L.open)) if (x.tokens > EPS || x.cost > EPS) { o.tokens.n++; o.tokens.tokens += x.tokens; o.tokens.cost += Math.max(0, x.cost); }
    for (const e of L.events) {
      if (e.kind !== 'verdict' || dustVerdict(e) || (e.claimAt != null && e.claimAt < T0)) continue;
      if (e.cash > EPS) { u.held++; u.heldValue += e.cash; u.heldCost += e.cost; } else u.heldLost++;
    }
    o.cost = o.open.cost + o.tokens.cost;
    return o;
  };

  /** What the period's realized PnL is made of under a basis, from what is booked in it: [phrase] in a fixed order (own
   *  predictions, secondary-market sales, matched sets, bought position tokens held to the verdict). A wallet that only
   *  bought tokens is not told its total came from predictions it never made. */
  PR.madeOf = (events, prep, mode, period) => {
    const bought = new Set(prep.L.trades.filter((t) => t.buyer === prep.addr && t.seller !== prep.addr).map((t) => t.pc));
    const has = { own: false, sale: false, set: false, bought: false };
    for (const e of events) {
      if (!(e.t >= period.start && e.t < period.end)) continue;
      if (e.kind === 'won' || e.kind === 'lost' || e.kind === 'void') has.own = true;
      else if (e.kind === 'sale') has.sale = true;
      else if (e.kind === 'set') has.set = true;
      else if (e.kind === 'held-verdict') { if (bought.has(e.ref.pc)) has.bought = true; else has.own = true; }
    }
    mode = PR.modeOf(mode);
    const own = { claim: 'claimed (paid out) predictions', claimable: 'predictions decided (settled on Meridian)', verdict: 'predictions whose source market resolved' }[mode];
    const tok = { claim: 'bought position tokens redeemed', claimable: 'bought position tokens decided', verdict: 'bought position tokens whose source market resolved' }[mode];
    return [has.own && own, has.sale && 'secondary-market sales', has.set && 'matched sets (both sides held)', has.bought && tok].filter(Boolean);
  };
  /** madeOf's phrases as one ('a, b and c'), or the basis's own-prediction phrase when nothing is booked. */
  PR.madeOfText = (parts, mode) => {
    if (!parts.length) parts = [{ claim: 'claimed (paid out) predictions', claimable: 'predictions decided (settled on Meridian)', verdict: 'predictions whose source market resolved' }[PR.modeOf(mode)]];
    return parts.length < 2 ? parts[0] : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
  };
  /** The period's secondary market from booked events: {sales, proceeds, sets, buys, paid, pnl, each amount with ...C in
   *  the report currency}. pnl is the sales' and matched sets' result (the part of the realized total the secondary
   *  market makes); a purchase books nothing by itself. */
  PR.secondary = (events, period, money) => {
    const o = { sales: 0, proceeds: 0, proceedsC: 0, sets: 0, buys: 0, paid: 0, paidC: 0, pnl: 0, pnlC: 0 };
    const fx = (v, t) => (money ? money.fx(v, t) : v);
    for (const e of events) {
      if (!(e.t >= period.start && e.t < period.end)) continue;
      if (e.kind === 'buy') { o.buys++; o.paid += e.cost; o.paidC += fx(e.cost, e.t); continue; }
      if (e.kind === 'sale') { o.sales++; o.proceeds += e.payout; o.proceedsC += fx(e.payout, e.t); }
      else if (e.kind === 'set') o.sets++;
      else continue;
      o.pnl += e.pnl; o.pnlC += fx(e.pnl, e.t);
    }
    return o;
  };

  /** The card's note under the basis in force: what each side's result is, when it is booked, how the secondary market
   *  counts. Factual: it names no basis as the one that applies. prep (optional): the wallet's record, so the claim
   *  basis says how held tokens are dated when the snapshot has no redemption times for it. */
  PR.footnote = (mode, prep) => {
    mode = PR.modeOf(mode);
    const heldClaim = 'when this wallet redeems them (worthless ones when the winners claim)' + (prep && !prep.rd && paysHeld(prep) ? ', dated ' + HELD_NO_RD : '');
    return [
      'Both sides of every prediction count: as the bettor, a win collects the market maker\'s collateral and a loss forfeits the stake; as the market maker, a win collects the bettor\'s stake and a loss forfeits the maker collateral.',
      mode === 'claim'
        ? 'This report books results when claimed (paid out): a win or a void\'s refund when this wallet claims it, a loss when the counterparty claims the pool. That claim is the other side\'s transaction and moves none of this wallet\'s money (the stake left it when the prediction was placed).'
        : mode === 'claimable'
          ? 'This report books results when decided (settled on Meridian), the moment they became claimable, whether or not they were claimed (paid out) later.'
          : 'This report books results when the source market resolved them (the leg that decided them), or when decided on Meridian where that time is not known, whether or not they were claimed (paid out) later.',
      'The line above the tiles gives the period under every basis; which date applies depends on the rules that apply to you.',
      'A position sold on the secondary market is a disposal on the day of the sale under every basis: its price minus the average cost of that side\'s tokens held (tokens from the wallet\'s own predictions at its collateral in proportion, bought tokens at their price); holding both sides books the matched amount minus its cost when the second side is acquired.',
      'Position tokens bought on the secondary market and held to the verdict are booked ' + { claim: heldClaim, claimable: 'when their picks were decided (settled on Meridian)', verdict: 'when the source market resolved their picks' }[mode] + ': what they pay minus what they cost; so is the share of an own prediction\'s tokens still held after a sale.',
      mode === 'claim'
        ? 'Results decided in the period and not claimed by its end are listed apart (Decided, not claimed) and are not in the total.'
        : 'Results booked in the period and not claimed by its end are in the total, and listed apart too (Booked, not yet claimed).',
    ].join(' ');
  };

  /** Where a ledger verdict's claim date (claimAt, tokens that pay) comes from: 'burn' (the wallet's own redemption, the
   *  snapshot's rd), 'own' (its own claim on that side, which redeemed the whole balance), 'any' (no redemption times
   *  for the wallet: the latest claim on the pick configuration by any wallet), or null (not redeemed, or worthless). */
  PR.redeemedBy = (prep, e) => {
    if (e.claimAt == null || !(e.cash > EPS)) return null;
    const own = prep.mine.filter((x) => x.n.pc === e.pc && (e.side === 'P' ? x.n.predictor : x.n.counterparty) === prep.addr && x.n.settled && x.n.settledAt).map((x) => x.n.settledAt);
    if (own.length && Math.min(...own) === e.claimAt) return 'own';
    return prep.rd ? 'burn' : 'any';
  };
  /** A traded prediction's status at instant end from its pick configuration's ledger verdict e: tokens that pay are
   *  'tokens redeemed' (this wallet's burn or claim), 'decided, redemption not confirmed' (dated by another wallet's
   *  claim) or 'decided, tokens not redeemed'; worthless ones 'claimed' (by the winners) or 'decided, not claimed'. */
  PR.tokenStatus = (prep, e, end) => {
    const done = e.claimAt != null && e.claimAt < end;
    if (!(e.cash > DUST)) return done ? 'claimed' : 'decided, not claimed';
    return !done ? 'decided, tokens not redeemed' : PR.redeemedBy(prep, e) === 'any' ? 'decided, redemption not confirmed' : 'tokens redeemed';
  };

  // ---------- files (pure: columns and rows; the page downloads them through MD.tax.exports) ----------
  const iso = (t) => (t == null ? '' : new Date(U.num(t)).toISOString().replace('T', ' ').slice(0, 19) + ' UTC');
  const loc = (tz, name, get) => (tz === 'UTC' ? [] : [[name + ' (' + tz + ')', (r) => { const t = get(r); return t == null ? '' : T.tz.fmt(t, tz, 'iso'); }]]);
  const yn = (b) => (b ? 'yes' : 'no');
  const picksText = (n) => (n.picks || []).map((k) => (k.yes ? 'YES: ' : 'NO: ') + k.q).join(' | ');
  const sideText = (s) => (s === 'C' ? 'maker side' : s === 'P' ? 'bettor side' : s === 'both' ? 'both sides' : '');
  /** money.cols with the name on all three headers, so one file can convert an amount at several dates */
  const ccyAt = (money, name, getUsd, getT) => money.cols(getUsd, getT, name).map((c, i) => (i ? [name + ': ' + c[0], c[1]] : c));
  /** a file under another basis than the default says so in its name */
  const sfx = (mode) => (PR.modeOf(mode) === PR.DEFAULT ? '' : '-' + mode);
  const inPeriod = (period) => (t) => t != null && t >= period.start && t < period.end;

  /** The daily ledger: one row per local day with anything booked or placed. Its cumulative runs inside the period, so
   *  the last row is the Realized PnL tile. */
  PR.dailyFile = (fig, ctx) => {
    const { tz, money, mode } = ctx, n6 = T.n6, C = money.rates ? money.ccy : null;
    const columns = [['Date (' + tz + ')', (x) => x.key], ['Date basis', () => PR.MODE_FILE[mode]], ['Realized PnL USD', (x) => n6(x.pnl)], ...money.cols((x) => x.pnl, (x) => x.t, 'Realized PnL'),
      ['Winnings USD (payout − stake of won predictions)', (x) => n6(x.winGain)], ['Payouts of won predictions USD', (x) => n6(x.payouts)], ['Lost stakes USD', (x) => n6(x.lostStakes)], ['Void refunds USD', (x) => n6(x.refunds)],
      ['Ledger gains USD (sales, sets, tokens held to the verdict)', (x) => n6(x.ledgerGains)], ['Ledger losses USD', (x) => n6(x.ledgerLosses)], ['of which secondary market USD (sales and matched sets)', (x) => n6(x.secondary)],
      ['Cumulative PnL in period USD', (x) => n6(x.cumPnl)], ...(C ? [['Cumulative PnL in period ' + C + ' (each day at its own rate)', (x) => n6(x.cumPnlC)]] : []),
      ['Wagered USD', (x) => n6(x.wagered)], ...(C ? [['Wagered ' + C, (x) => n6(x.wageredC)]] : []),
      ['Predictions placed', (x) => x.placed], ['Won (booked)', (x) => x.won], ['Lost (booked)', (x) => x.lost], ['Void (booked)', (x) => x.void], ['Token positions held to the verdict (booked)', (x) => x.held]];
    return { name: ctx.fname('predict-daily-ledger' + sfx(mode)), columns, rows: fig.days };
  };

  /**
   * The record: every loaded prediction of the wallet, in either role, placed, decided or claimed in the period, booked
   * in it, or still open at its end, with all three dates, its status at the period's end and its result from the
   * wallet's side. A prediction on a pick configuration the wallet traded has its PnL in the secondary-market file
   * (the ledger's average cost), so here its Net is blank: the record's counted Net plus that file's realized PnL is the
   * Realized PnL tile; its Booked date and its status both follow its tokens (PR.tokenStatus), not its own claim.
   * Rows: [{x, n, d, res, dec, claim, booked, status}].
   */
  PR.recordFile = (prep, ctx) => {
    const { tz, money, mode, period } = ctx, n6 = T.n6, inP = inPeriod(period), end = period.end;
    const verdictOf = new Map(prep.L.events.filter((e) => e.kind === 'verdict').map((e) => [e.pc, e]));
    const lastSale = new Map();
    for (const e of prep.L.events) if (e.kind === 'sale') lastSale.set(e.pc, Math.max(lastSale.get(e.pc) || -Infinity, e.t));
    const rows = [];
    for (const x of prep.mine) {
      const n = x.n, d = PR.dates(x);
      const res = !n.decided ? 'open' : x.ndW ? 'void' : x.wonW ? 'won' : 'lost';
      const dec = d.claimable ? d.claimable.t : null, claim = d.claim ? d.claim.t : null;
      // a traded prediction settles with its pick configuration's tokens: the date the ledger books them
      // (a verdict on a remainder below the files' precision is no holding: those tokens count as sold)
      const ve0 = x.traded && n.pc ? verdictOf.get(n.pc) : null, ve = ve0 && !dustVerdict(ve0) ? ve0 : null;
      const booked = res === 'open' ? null : ve ? whenVerdict(ve, mode) : PR.when({ res, claimable: d.claimable, verdict: d.verdict, claim: d.claim }, mode);
      const openAtEnd = n.t < end && !(dec != null && dec < end);
      if (!(inP(n.t) || inP(dec) || inP(claim) || inP(booked) || openAtEnd)) continue;
      const sold = x.traded && (x.notSold < 1e-6 || (ve0 && !ve)) && (lastSale.get(n.pc) != null ? lastSale.get(n.pc) : Infinity) < end;
      // a traded prediction's status follows its tokens (the ledger's verdict), as its Booked date does, never its own claim
      const status = sold ? 'sold' : dec == null || dec >= end ? 'open' : ve ? PR.tokenStatus(prep, ve, end) : claim != null && claim < end ? 'claimed' : 'decided, not claimed';
      rows.push({ x, n, d, res, dec, claim, booked, status });
    }
    rows.sort((a, b) => a.n.t - b.n.t);
    const held = (r) => r.x.held;
    const net = (r) => (r.res === 'open' || r.x.traded ? null : (r.res === 'void' ? 0 : r.x.pnlW) * held(r));
    const payout = (r) => (r.res === 'open' ? null : r.res === 'lost' ? 0 : r.claim == null ? null : (r.res === 'won' ? r.n.pool : r.x.stakeW) * held(r));
    const counted = (r) => net(r) != null && inP(r.booked);
    const m6 = (v) => (v == null ? '' : n6(v));
    const columns = [
      ['Side', (r) => (r.x.role === 'maker' ? 'market maker' : 'bettor')],
      ['Placed (UTC)', (r) => iso(r.n.t)], ...loc(tz, 'Placed', (r) => r.n.t),
      ['Decided: settled on Meridian, claimable from (UTC)', (r) => iso(r.dec)], ['Decided time', (r) => (r.d.claimable ? (r.d.claimable.exact ? 'exact' : 'estimated') : '')],
      ['Source market resolved (UTC)', (r) => iso(r.d.verdict && r.d.verdict.t)], ['Source resolution time', (r) => (r.d.verdict ? (r.d.verdict.exact ? 'exact' : 'not known: when decided on Meridian or earlier') : '')],
      ['Claimed, paid out (UTC)', (r) => iso(r.claim)], ['Claimed by', (r) => (r.d.claim ? (r.d.claim.by === 'self' ? 'this wallet' : 'the counterparty') : '')],
      ['Booked (UTC)', (r) => iso(r.booked)], ...loc(tz, 'Booked', (r) => r.booked), ['Date basis', () => PR.MODE_FILE[mode]],
      ['Status at period end', (r) => r.status],
      ['Picks', (r) => picksText(r.n)], ['Legs', (r) => r.n.legs], ['Category', (r) => r.n.cat || ''],
      ['Own stake or collateral USD', (r) => n6(r.x.stakeW)], ['Counterparty', (r) => (r.x.role === 'maker' ? r.n.predictor : r.n.counterparty)],
      ['Counterparty collateral USD', (r) => n6(r.x.role === 'maker' ? r.n.stake : r.n.cp)], ['Locked odds (bettor)', (r) => (r.n.odds == null ? '' : n6(r.n.odds))],
      ['Result (this wallet\'s side)', (r) => r.res], ['Share still held at the verdict', (r) => n6(held(r))],
      ['Payout USD (claimed win: pool × share held; claimed void: the refund; loss: 0)', (r) => m6(payout(r))],
      ['Cost USD (own stake or collateral × share held)', (r) => n6(r.x.stakeW * held(r))],
      ['Net USD (± PnL × share held)', (r) => m6(net(r))],
      ['PnL booked in', (r) => (r.res === 'open' ? '' : r.x.traded ? 'secondary-market file (average cost)' : 'this file')],
      ['Net in this period\'s realized PnL', (r) => yn(counted(r))],
      ...ccyAt(money, 'Net at the decision', (r) => (r.dec != null ? net(r) : null), (r) => r.dec),
      ...ccyAt(money, 'Net at the source resolution', (r) => (r.d.verdict ? net(r) : null), (r) => r.d.verdict.t),
      ...ccyAt(money, 'Net at the claim', (r) => (r.claim != null ? net(r) : null), (r) => r.claim),
      ['Prediction ID', (r) => r.n.id], ['Pick configuration ID', (r) => r.n.pc || ''], ['Placement tx', (r) => r.n.tx || ''], ['Claim tx', (r) => r.n.stx || ''],
    ];
    return { name: ctx.fname('predict-record' + sfx(mode)), columns, rows, net, counted };
  };

  /**
   * The secondary market, itemised from the same booking as the tile: the period's purchases and sales (a sale with its
   * average cost and result), the matched sets (both sides held) on their own dates, and the token positions held to
   * the verdict on the date the basis books them (none yet in claim mode while not redeemed). No total row: with the
   * record's counted Net it adds up to the Realized PnL tile. Rows: [{t, kind, q, legs, side, cp, tokens, cash, cost,
   * pnl, pid, pc, tx}].
   */
  PR.tradesFile = (prep, ctx) => {
    const { tz, money, mode, period } = ctx, n6 = T.n6, addr = prep.addr, L = prep.L, inP = inPeriod(period);
    const saleOf = new Map(L.events.filter((e) => e.kind === 'sale' && e.trade).map((e) => [e.trade, e]));
    const pidOf = new Map(), legsOf = new Map();
    for (const t of L.trades) { if (t.pc && t.pid && !pidOf.has(t.pc)) pidOf.set(t.pc, t.pid); if (t.pc && t.legs && !legsOf.has(t.pc)) legsOf.set(t.pc, t.legs); }
    for (const x of prep.mine) if (x.n.pc) { if (!pidOf.has(x.n.pc)) pidOf.set(x.n.pc, x.n.id); if (!legsOf.has(x.n.pc)) legsOf.set(x.n.pc, x.n.legs); }
    const rows = [];
    for (const t of L.trades) {
      if (!inP(t.t)) continue;
      const sold = t.seller === addr, e = sold ? saleOf.get(t) : null;
      rows.push({ t: t.t, kind: sold ? 'sold' : 'bought', by: 'the trade', q: t.q || '', legs: t.legs || legsOf.get(t.pc) || 1, side: t.side, cp: sold ? t.buyer : t.seller, tokens: t.tokens, cash: t.paid, cost: e ? e.cost : null, pnl: e ? e.pnl : null, pid: t.pid || pidOf.get(t.pc) || '', pc: t.pc || '', tx: t.tx || '' });
    }
    for (const e of L.events) {
      const t = e.kind === 'set' ? e.t : e.kind === 'verdict' ? whenVerdict(e, mode) : null;
      if (!inP(t)) continue;
      const set = e.kind === 'set';
      rows.push({ t, kind: set ? 'both sides held' : 'held to verdict', by: set ? 'the acquisition that matched both sides' : PR.MODE_FILE[mode], q: e.q || '', legs: legsOf.get(e.pc) || 1, side: set ? 'both' : e.side, cp: '', tokens: e.tokens, cash: e.cash, cost: e.cost, pnl: e.pnl, pid: pidOf.get(e.pc) || '', pc: e.pc || '', tx: '' });
    }
    rows.sort((a, b) => a.t - b.t);
    const columns = [['Time (UTC)', (r) => iso(r.t)], ...loc(tz, 'Time', (r) => r.t), ['Kind', (r) => r.kind], ['Dated by', (r) => r.by],
      ['Prediction', (r) => r.q + (r.legs > 1 ? ` (+${r.legs - 1} legs)` : '')], ['Side of the tokens', (r) => sideText(r.side)], ['Counterparty', (r) => r.cp],
      ['Tokens (1 USDe each if the side wins)', (r) => n6(r.tokens)], ['Price per token', (r) => (r.tokens ? n6(r.cash / r.tokens) : '')],
      ['Amount USD (paid or received; held to verdict: what the tokens pay)', (r) => n6(r.cash)],
      ['Cost basis USD (average cost)', (r) => (r.cost == null ? '' : n6(r.cost))], ['Realized PnL USD', (r) => (r.pnl == null ? '' : n6(r.pnl))],
      ...money.cols((r) => r.pnl, (r) => r.t, 'Realized PnL'),
      ['Prediction ID', (r) => r.pid], ['Pick configuration ID', (r) => r.pc], ['Tx', (r) => r.tx]];
    return { name: ctx.fname('predict-secondary-market' + sfx(mode)), columns, rows };
  };

  /**
   * The results not claimed by the period's end (PR.tail), one row per item: the wallet's own predictions and the token
   * positions it held to the verdict alike, dated when decided (settled on Meridian). In claim mode those decided in the
   * period, outside the realized total ('decided, not claimed'); under the other bases those booked in it, in the total
   * ('booked, not yet claimed'), with the date the basis books them. The file states the dates; it does not say which
   * year they belong to.
   */
  PR.unclaimedFile = (prep, ctx, tail) => {
    const { tz, money, mode, period } = ctx, n6 = T.n6;
    tail = tail || PR.tail(prep, mode, period);
    const rows = tail.items.map((it) => {
      if (it.kind === 'held-verdict') {
        const e = it.ref;
        return { t: it.t, exact: it.exact, booked: it.booked, placed: null, picks: e.q || '', src: 'position tokens held (secondary market)', side: sideText(e.side), tokens: e.tokens, cost: e.cost, value: e.cash, result: it.won ? 'won' : 'lost', pnl: it.pnl, id: e.pc || '', claimAt: it.claimAt };
      }
      const r = it.ref, n = r.x ? r.x.n : null;
      const value = it.kind === 'won' ? r.stakeW + r.pnlW : it.kind === 'void' ? r.stakeW : 0;
      return { t: it.t, exact: it.exact, booked: it.booked, placed: r.t, picks: n ? picksText(n) : '', src: 'own prediction', side: r.maker ? 'market maker' : 'bettor', tokens: null, cost: r.stakeW, value, result: it.kind, pnl: it.pnl, id: n ? n.id : '', claimAt: it.claimAt };
    });
    // under a booked basis the booking can fall before the decision (the source market resolved first): both are given
    const bookedCols = tail.booked ? [['Booked (UTC)', (r) => iso(r.booked)], ...loc(tz, 'Booked', (r) => r.booked)] : [];
    const columns = [['Decided: settled on Meridian (UTC)', (r) => iso(r.t)], ...loc(tz, 'Decided', (r) => r.t), ['Decided time', (r) => (r.exact ? 'exact' : 'estimated')], ...bookedCols,
      ['Placed (UTC)', (r) => iso(r.placed)], ['Picks', (r) => r.picks], ['Source', (r) => r.src], ['Side', (r) => r.side], ['Tokens', (r) => (r.tokens == null ? '' : n6(r.tokens))],
      ['Cost USD', (r) => n6(r.cost)], ['Claimable USD', (r) => n6(r.value)], ['Result (this wallet\'s side)', (r) => r.result],
      ['PnL at the decision USD', (r) => n6(r.pnl)], ...money.cols((r) => r.pnl, (r) => r.booked, 'PnL at the decision'),
      ['Claimed after the period (UTC)', (r) => iso(r.claimAt)], ['In this period\'s realized PnL', () => yn(tail.booked)], ['Date basis', () => PR.MODE_FILE[mode]],
      ['ID (prediction, or pick configuration for tokens)', (r) => r.id]];
    return { name: ctx.fname((tail.booked ? 'predict-booked-not-yet-claimed' : 'predict-decided-not-claimed') + sfx(mode)), title: tail.title, columns, rows };
  };
})();
