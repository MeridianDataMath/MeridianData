/* MeridianDataHub — Tax center perps cards for one subaccount and period: the tiles and reconciliation, results and
   costs, monthly and quarterly tables, by market, disposals, closed positions, every transaction and the perps exports.
   The archive figures render at once; the per-fill detail (fills, settlements, disposals: MD.tax.load.events) loads
   right after, with a progress line and Cancel (above a size, MD.tax.load.detailSize, on request), and fills in what
   needs it. Builds DOM only when called. */
(function () {
  const MD = window.MD; const U = MD.util; const UI = MD.ui; const C = MD.charts; const h = U.h;
  const T = MD.tax; const TZ = T.tz;
  const VP = (T.viewPerps = {});
  const PAGE = 25, PRINT_MAX = 2000;
  const isoTime = (ms) => new Date(U.num(ms)).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const isoDate = (ms) => new Date(U.num(ms)).toISOString().slice(0, 10);
  const plural = (n, w, ws) => `${U.fmtNum(n, 0)} ${n === 1 ? w : ws || w + 's'}`;

  /**
   * ctx: {sa, sid, addr, ref, period, money, pnlEl, rates, cur, fname(kind), positions, led (T.ledger.build), arch
   * (load.archive), now, signal, onCleanup, upnlEnd (a promise of the archive's unrealized PnL at the period end, null
   * when it could not be read: the Open at period end tile of a period that has ended), holdingsCard (placed after
   * Gains and losses by class), onDetail(ev, D, err, o) (called when the trade detail loads or fails, and with o
   * {deferred: true} when it waits to be asked for), summaryCtx() (a promise of the summary files' context, from the
   * page), methodology(file, extra) (a report's methodology rows),
   * classExtras() ({predict: {prep, mode} | null, lots: {runs, method, scope} | null}: the other sections of Gains and
   * losses by class), zip() and importNotes() (the page's ZIP of everything and the tax-tool import notes)}.
   * Returns {cards (in page order), start(), summaryPerps(), files(), toolFiles(), warnings(), refreshClasses(),
   * rateBasis()}: start draws the chart and loads the per-fill detail, or offers to when it is big (call it once the
   * cards are in the page); summaryPerps, files and toolFiles wait for the detail (or its failure, and start it when it
   * waited to be asked for) and give the summary's perps part, every perps
   * file built, and the perps tax-tool files built; rateBasis says how the perps figures convert to the report currency
   * (the methodology's Rate rule). Once the detail is in, a non-USD report recasts the ledger's report-currency figures
   * from the events (T.ledger.recast), so the tiles, tables, summary and holdings agree with the disposals.
   */
  VP.render = function (ctx) {
    const { sid, addr, ref, period, money, pnlEl, rates, cur, fname, positions, led } = ctx;
    const { mode, tz, start, end, label } = period;
    const TUI = T.ui, EX = T.exports, F = T.fills, FU = T.funding, S = T.summary;
    const { exBtn } = TUI;
    const now = ctx.now;
    const loc = (t) => TZ.fmt(t, tz, 'iso');
    const amber = (...kids) => h('div.small', { style: { marginTop: '8px', color: 'var(--amber)' } }, ...kids);
    const fmtC = (v, o) => money.fmt(v, o);

    // ---- the archive: segments are whole UTC days and the parts of the UTC days a local boundary cuts ----
    const days = led.segments;
    const LT = led.totals;
    const TT = { realized: LT.realized, fees: LT.fees, posFees: LT.pfees, funding: LT.funding, deposits: LT.deposits, withdrawals: LT.withdrawals, wfee: LT.wfee, volume: LT.volume, net: LT.net };
    // in the report currency: each UTC day at its middle's rate until the trade detail is in, then each fill, settlement
    // and transfer at its own local date (T.ledger.recast), so the tiles agree with the disposals and settlements
    const tcOf = () => ({ realized: LT.C.realized, fees: LT.C.fees, posFees: LT.C.pfees, funding: LT.C.funding, deposits: LT.C.deposits, withdrawals: LT.C.withdrawals, wfee: LT.C.wfee, volume: LT.C.volume, net: LT.C.net });
    let TC = tcOf();
    // monthly and fiscal quarters, by local date; the quiet stretch before the account's first activity is left out, and
    // so are the months of a custom range that have not started yet
    const quiet = (m) => !m.realized && !m.fees && !m.pfees && !m.funding && !m.deposits && !m.withdrawals && !m.volume;
    let monthly = led.months.filter((m, i) => i === 0 || m.t0 <= now);
    while (monthly.length > 1 && quiet(monthly[0])) monthly = monthly.slice(1);
    let quarters = led.quarters.filter((q, i) => i === 0 || q.t0 <= now);
    while (quarters.length > 1 && quiet(quarters[0])) quarters = quarters.slice(1);

    // closed positions in the period: each with its whole-life result at its close (a summary per position; the period's
    // disposals are the rows below it)
    const closed = positions.filter((p) => U.num(p.size) === 0 && U.num(p.totalDecreaseQuantity) > 0 && U.num(p.updatedAt) >= start && U.num(p.updatedAt) < end)
      .map((p) => {
        const prod = ref.byId[p.productId]; const incQ = U.num(p.totalIncreaseQuantity), decQ = U.num(p.totalDecreaseQuantity);
        const fees = U.num(p.feesAccruedUsd), pfees = U.num(p.positionFeeAccruedUsd), fund = -U.num(p.fundingAccruedUsd), gross = U.num(p.realizedPnl);
        const net = gross - fees - pfees + fund, t = U.num(p.updatedAt), t0 = U.num(p.createdAt);
        return { p, t, rate: money.rate(t), ticker: prod ? prod.displayTicker : p.productId, tick: prod && prod.tickSize, long: String(p.side) === '0', size: incQ, entry: incQ ? U.num(p.totalIncreaseNotional) / incQ : 0, exit: decQ ? U.num(p.totalDecreaseNotional) / decQ : 0, cost: U.num(p.totalIncreaseNotional), proceeds: U.num(p.totalDecreaseNotional), gross, fees, pfees, funding: fund, net, netC: money.fx(net, t), grossC: money.fx(gross, t), hold: t - t0, longTerm: TZ.heldOverYear(t0, t, tz), liq: !!p.isLiquidated, adl: !!p.wasDeleveraged };
      })
      .sort((a, b) => b.t - a.t);
    const wins = closed.filter((c) => c.net > 0), losses = closed.filter((c) => c.net < 0);
    const longestHold = closed.length ? Math.max(...closed.map((c) => c.hold)) : 0;
    const largestWin = wins.length ? wins.reduce((a, c) => (c.net > a.net ? c : a)) : null, largestLoss = losses.length ? losses.reduce((a, c) => (c.net < a.net ? c : a)) : null;
    const closedOverYear = closed.filter((c) => c.longTerm).length;
    // open at period end (not realized yet, but part of a complete picture); current while the period has not ended
    const current = end >= now;
    const openNow = positions.filter((p) => U.num(p.size) !== 0);
    const openAtEnd = current ? openNow : positions.filter((p) => U.num(p.createdAt) < end && (U.num(p.size) !== 0 || U.num(p.updatedAt) >= end));
    // now, as on the account page: net of unsettled funding and position fees. A period that has ended takes the
    // archive's unrealized PnL at its end instead (ctx.upnlEnd, price only: the archive keeps no unsettled funding or
    // position fees); the tile line and the Holdings card read them, never Net result or the reconciliation
    const openUpnl = U.sum(openNow, (p) => U.num(p.unrealizedPnl) - U.num(p.fundingUsd) - U.num(p.positionFeeUsd));
    let upnlEnd = ctx.upnlEnd ? undefined : null;   // undefined while it loads, null when it could not be read

    // ---- the per-fill detail: null until loaded ----
    let ev = null, D = null, evErr = null, evPromise = null;
    // it loads on its own for a period of ordinary size; a bigger one (many positions, or fills and funding charges
    // reaching far back) waits for 'Load trade detail' or an export that needs it (T.load.detailSize)
    const size = T.load.detailSize(positions, start, end, now);
    let asked = size.auto;
    const fundFig = () => (D ? D.funding.fig : FU.figures(null, days, money.fx));   // without the detail every day is netted
    const exCtx = () => ({ period, tz, money, fname, ev, D, ref, led, closed, events, sid, addr, now, positions });

    // ---- balance reconciliation (an accountant's first check): opening + deposits − withdrawals + result = closing ----
    const opening = led.opening, closing = led.closing, expected = led.recon.expected, reconDiff = led.recon.diff;
    const poolDiffs = led.poolDiffs;
    const partName = (s) => isoDate(s.day) + (s.part ? ' ' + s.part + ' UTC' : '');
    const reconRows = [['Opening balance', opening], ['+ Deposits', TT.deposits], ['− Withdrawals (incl. fees)', -TT.withdrawals], ['+ Realized PnL', TT.realized], ['− Trading fees', -TT.fees], ['− Position fees (mPerps)', -TT.posFees], ['+ Funding', TT.funding], ['= Expected closing balance', expected], ['Closing balance (ledger)', closing], ['Difference', Math.abs(reconDiff) < 0.005 ? 0 : reconDiff]];   // float dust is no "-$0.00"
    const reconCard = h('details.recon', { style: { marginTop: '12px' } }, h('summary.small', { style: { cursor: 'pointer', color: 'var(--text-2)' } }, 'Balance reconciliation · ', h('span', { class: Math.abs(reconDiff) < 0.05 ? 'pos' : 'neg' }, Math.abs(reconDiff) < 0.005 ? 'exact' : 'difference ' + U.fmtUsd(reconDiff, { sign: true, dp: 2 })), h('span.dim', ' · opening + deposits − withdrawals + result = closing')),
      h('div.card.tight.wrap-cells', { style: { marginTop: '8px', maxWidth: '520px' } }, UI.table({ cols: [{ key: 'k', label: 'Step', render: (r) => h('span', { class: /^=|Closing|Difference/.test(r[0]) ? 'bold' : '' }, r[0]) }, { key: 'v', label: 'USD', num: true, render: (r) => h('span', { class: r[0] === 'Difference' ? (Math.abs(r[1]) < 0.05 ? 'pos' : 'neg') : '' }, U.fmtUsd(r[1], { sign: r[0] === 'Difference' || /^[+−]/.test(r[0]), dp: 2 })) }], rows: reconRows })),
      poolDiffs.length ? amber('Unexplained by the ledger: ' + poolDiffs.map((d) => `${d.pool} pool ${U.fmtUsd(d.diff, { sign: true, dp: 2 })}`).join(', ') + '. ' + (poolDiffs.length > 1 ? 'The exchange changed those pools\' balances without a deposit, trade, fee or funding entry for them; these changes are' : 'The exchange changed that pool\'s balance without a deposit, trade, fee or funding entry for it; it is') + ' left out of every figure above and noted here so the report stays honest.') : null,
      led.pfDays.length ? amber('Booked as position fees, but unlike one: ' + led.pfDays.slice(0, 6).map((x) => `${partName(x.seg)} ${U.fmtUsd(x.pfees, { sign: true, dp: 2 })} (${x.reason === 'credit' ? 'a credit' : 'no fill that day'})`).join(', ') + (led.pfDays.length > 6 ? ` and ${led.pfDays.length - 6} more (the daily ledger export has them all)` : '') + '. A position fee settles into an mPerp pool at a fill of its position; a change there that no ledger entry explains and that is a credit, or that comes without any fill, may be another adjustment by the exchange.') : null,
      led.fallbackDays.length ? amber('The exchange\'s hourly ledger for ' + led.fallbackDays.map(isoDate).join(', ') + ' could not be read or does not add up to its daily ledger, so ' + (led.fallbackDays.length > 1 ? 'those UTC days are' : 'that UTC day is') + ' counted whole, in the period holding most of its hours.') : null,
      h('div.dim.small', { style: { marginTop: '6px' } }, 'Balances are summed across the account\'s margin pools; conversions between pools cancel out. Position fees on mPerp markets are not in the exchange\'s daily fee line; they are the mPerp pool\'s balance change that no other ledger entry explains, booked when the exchange settles them (at a fill of the position), like funding.'
        + (led.splitDays.length ? ` The exchange keeps its ledger per UTC day: the ${led.splitDays.length} UTC day${led.splitDays.length > 1 ? 's' : ''} the period's local boundaries cut ${led.splitDays.length > 1 ? 'are' : 'is'} split hour by hour` + (led.straddle.length ? ', and an hour a boundary cuts in its middle (this zone is not a whole number of hours from UTC) counts in the period it starts in; fills, settlements and transfers count by their exact time' : '') + '.' : '')));

    // ---- figures from the disposals (null until the detail is in) ----
    const fig = () => S.perpsFigures(D, money);
    const pending = () => (evErr ? 'trade detail not loaded' : asked ? 'loading trade detail…' : 'trade detail not loaded yet');
    // what a table that needs the detail shows until it is in
    const waitText = () => (asked ? 'Loading trade detail…' : 'Trade detail not loaded yet: Load trade detail, above.');

    // ---- summary tiles ----
    const tilesWrap = h('div');
    const renderTiles = () => {
      const X = fig(), ff = fundFig();
      const fb = ff.fallback.length;
      U.replace(tilesWrap, h('div.stats',
        UI.stat('Net result', fmtC(TC.net, { sign: true }), 'realized PnL − fees − position fees + funding', U.pnlClass(TT.net)),
        UI.stat('Realized PnL', fmtC(TC.realized, { sign: true }), 'gross, the exchange\'s ledger: every reduction and close', U.pnlClass(TT.realized)),
        UI.stat('Gains', X ? fmtC(X.gainsC, { sign: true }) : '…', X ? `${plural(X.nG, 'disposal')} · gross, before fees and funding` : pending(), 'pos'),
        UI.stat('Losses', X ? fmtC(X.lossesC, { sign: true }) : '…', X ? `${plural(X.nL, 'disposal')}` + (X.nLiq ? ` · ${X.nLiq} liquidation${X.nLiq > 1 ? 's' : ''}` : '') + (X.nAdl ? ` · ${X.nAdl} auto-deleverage` : '') + ' · gross, before fees and funding' : pending(), 'neg'),
        UI.stat('Fees', fmtC(TC.fees + TC.posFees), `${fmtC(TC.fees)} trading` + (TT.posFees ? ` · ${fmtC(TC.posFees)} position (mPerps)` : '') + (TT.wfee ? ` · plus ${fmtC(TC.wfee)} on withdrawals` : '')),
        UI.stat('Funding', fmtC(TC.funding, { sign: true }), (D || evErr ? `${fmtC(ff.C.received)} received · ${fmtC(ff.C.paid)} paid (gross, per settlement)` + (fb ? ` · ${plural(fb, 'day')} netted per day: settlement detail unavailable` : '') : 'received and paid: ' + pending()), U.pnlClass(TT.funding)),
        UI.stat('Deposits', fmtC(TC.deposits)),
        UI.stat('Withdrawals', fmtC(TC.withdrawals), TT.wfee ? 'incl. withdrawal & deposit fees' : null),
        UI.stat('Closed positions', String(closed.length), closed.length ? `win rate ${U.fmtPct((wins.length / closed.length) * 100, { dp: 0 })} · longest hold ${U.fmtDuration(longestHold)}` : null),
        UI.stat('Held over a year', X && X.lt ? fmtC(X.ltNetC, { sign: true }) : X ? '—' : '…', X ? (X.lt ? `${plural(X.lt, 'disposal')} of positions held more than one year (calendar dates, ${tz}) · net` : 'no position held over a year') : pending()),
        UI.stat('Volume', fmtC(TC.volume, { compact: true }), 'traded notional'),
        current
          ? UI.stat('Open at period end', String(openNow.length), openNow.length ? `${money.now(openUpnl, { sign: true })} unrealized now, after unsettled funding and position fees · not included in Net result or Realized PnL` + money.nowTag() : 'no open positions')
          : UI.stat('Open at period end', String(openAtEnd.length), T.holdings.tileLine(openAtEnd.length, upnlEnd, money, end))));
    };
    if (!current && ctx.upnlEnd) ctx.upnlEnd.then((v) => { upnlEnd = v; renderTiles(); }, () => { upnlEnd = null; renderTiles(); });

    // ---- the detail's progress, and what the checks found ----
    const evLine = h('div', { style: { marginTop: '10px' } });
    const checksEl = h('div');
    const renderChecks = () => {
      if (!D) { U.replace(checksEl); return; }
      const X = fig(), w = EX.eventWarnings({ ev, D }), out = [];
      if (X.showOutside) {
        const daysTxt = D.day.bad.slice(0, 6).map((b) => partName(b.seg) + ' ' + U.fmtUsd(b.diff, { sign: true, dp: 2 })).join(', ') + (D.day.bad.length > 6 ? ` and ${D.day.bad.length - 6} more` : '');
        out.push(amber('Realized PnL outside the disposals: ', h('b', fmtC(X.outside.C, { sign: true })), `. The exchange's ledger has ${fmtC(TC.realized, { sign: true })} for the period; the disposals add up to ${fmtC(X.gainsC + X.lossesC, { sign: true })}.`
          + (D.day.bad.length ? ` The UTC days that do not reconcile: ${daysTxt}.` : '') + (Math.abs(X.outside.shift) >= 0.01 ? ` Fills in the hour a boundary cuts in its middle count by their exact time here and by the hour in the ledger (${U.fmtUsd(-X.outside.shift, { sign: true, dp: 2 })}).` : '')));
      }
      if (D.fees.bad.length || D.fees.unmatched.length) out.push(amber(`Position fees of ${plural(D.fees.bad.length || D.fees.unmatched.length, 'UTC day')} could not be matched to the fills of their pool, so the position fees inside those disposals are incomplete; the Fees figures above come from the ledger and are complete.`));
      if (D.funding.fig.fallback.length) out.push(amber(`${plural(D.funding.fig.fallback.length, 'day')} netted per day: settlement detail unavailable (${D.funding.S ? 'the settlements found do not add up to the exchange\'s ledger' : 'the hourly funding charges could not be read'}), so received and paid there are that day's net.`));
      if (w.length) out.push(amber('Incomplete trade detail: ' + w.join('; ') + '. The ledger figures above are complete; the per-disposal tables and exports are marked.'));
      U.replace(checksEl, ...out);
    };

    // ---- results, costs and transfers, by type (T.summary.byType): what each line is, never how it is taxed ----
    // the note sits under its category and wraps, so the amount stays in view on a phone
    const catWrap = h('div.wrap-cells'), catInfo = h('div.dim.small', { style: { padding: '10px 14px' } });
    const renderCats = () => {
      const rows = S.byType({ totals: LT, X: fig(), ff: fundFig(), funding: !!(D || evErr), pending: pending() });
      U.replace(catWrap, UI.table({ cols: [
        { key: 'c', label: 'Category', render: (r) => h('div', r.cat, h('div.dim.xs', { style: { whiteSpace: 'normal', maxWidth: '420px', lineHeight: '1.35', marginTop: '2px' } }, r.note)) },
        { key: 'k', label: 'Type', title: 'what the line is (a trading result, funding, a fee or a transfer); how each is treated depends on the rules that apply to you', render: (r) => h('span.dim', r.type) },
        { key: 'a', label: 'Amount', num: true, render: (r) => (r.usd == null ? h('span.dim', '…') : pnlEl(r.c, r.usd)) },
      ], rows }));
      const F0 = D && D.funding, ci = F0 && F0.chargedIn;
      U.replace(catInfo, D ? [
        'For information, in no total: ',
        ci ? `funding charged in the period ${fmtC(ci.C.net, { sign: true })} (${fmtC(ci.C.received)} received, ${fmtC(ci.C.paid)} paid, hour by hour), of which ${fmtC(ci.C.after, { sign: true })} was settled after it or not yet; ` : '',
        `opening fees paid on positions still open at the period end, not yet part of any disposal: ${fmtC(rates ? D.openFeesEndC : D.openFeesEnd)}` + (rates ? ' (each at the date it was paid)' : '') + '.',
      ] : null);
    };

    // ---- gains and losses by class (G09): each disposal on its own cash flows, both readings of funding and position
    // fees in two tables, Meridian Predict and the USDe lots apart (never summed with perps) ----
    // on a phone the class names wrap, the amounts stay on one line, and each row is a grid (css: .tax-classes)
    const classWrap = h('div.wrap-cells.tax-classes');
    // a grid row loses a table's semantics in some browsers: the roles keep these tables tables for a screen reader
    const tableRoles = (el) => {
      const t = el.querySelector('table'); if (!t) return el;
      t.setAttribute('role', 'table');
      for (const [sel, role] of [['thead, tbody', 'rowgroup'], ['tr', 'row'], ['th', 'columnheader'], ['td', 'cell']]) for (const x of t.querySelectorAll(sel)) x.setAttribute('role', role);
      return el;
    };
    const renderClasses = () => {
      if (!D) { U.replace(classWrap, UI.empty(evErr ? 'The trade detail did not load: gains and losses by class need it.' : waitText())); return; }
      // dust only when both currencies are: a USDe lot at par is $0 but has a real report-currency gain or loss
      const amt = (vC, vUsd) => (Math.abs(vUsd) < 0.005 && !(Math.abs(vC) >= 0.005) ? h('span.dim', fmtC(0)) : pnlEl(vC, Math.abs(vUsd) < 0.005 ? vC : vUsd));
      // on a phone (css: .tax-classes) Proceeds and Costs fold under the name, so Disposals, Gains, Losses and Net stay in
      // view; the heading can break (a soft hyphen) to keep its column narrow
      const folded = (x) => h('div.dim.xs.tax-fold-only', 'proceeds ' + fmtC(x.C.proceeds) + ' · costs ' + fmtC(x.C.costs));
      const cols = (first) => [
        { key: 'c', label: first, render: (x) => h('div', h('span', { class: x.total ? 'bold' : '' }, x.cls === 'Meridian Predict' ? x.label : x.cls), folded(x)) },
        { key: 'n', label: 'Dis\u00ADposals', num: true, title: 'with a gain / with a loss', render: (x) => h('span', U.fmtNum(x.n, 0), x.nG != null ? h('span.dim.xs.num-sub', ` (${x.nG} / ${x.nL})`) : null) },
        { key: 'p', label: 'Proceeds', num: true, cls: 'tax-fold', title: 'credits: positive results (and funding received, inside)', render: (x) => h('span.num', fmtC(x.C.proceeds)) },
        { key: 'k', label: 'Costs', num: true, cls: 'tax-fold', title: 'debits: negative results and trading fees (and funding paid and position fees, inside)', render: (x) => h('span.num', fmtC(x.C.costs)) },
        { key: 'g', label: 'Gains', num: true, title: 'the sum of the positive results', render: (x) => amt(x.C.gains, x.gains) },
        { key: 'l', label: 'Losses', num: true, title: 'the sum of the negative results', render: (x) => amt(x.C.losses, x.losses) },
        { key: 'net', label: 'Net', num: true, render: (x) => amt(x.C.net, x.net) },
      ];
      const tables = S.READINGS.map((r) => h('div', { style: { marginBottom: '12px' } }, h('div.small.dim', { style: { margin: '0 0 6px' } }, S.READING_LABEL[r]), h('div.card.tight', tableRoles(UI.table({ cols: cols('Class'), rows: S.byClass(D.inP, r, money), empty: 'No disposals in this period' })))));
      // the other sections: Predict under the card's basis, the USDe lots under both deposit readings
      const ex = ctx.classExtras ? ctx.classExtras() : {}, other = [];
      if (ex.predict && ex.predict.prep) { const x = S.predict(ex.predict.prep, ex.predict.mode, period, money); other.push(Object.assign(x, { label: 'Meridian Predict · results dated ' + T.predict.MODE_FILE[x.mode] })); }
      if (ex.lots && ex.lots.runs) for (const u of S.usde(ex.lots.runs, period)) other.push({ cls: 'USDe', label: 'USDe lots · ' + T.lots.READING_LABEL[u.reading].toLowerCase(), n: u.n, nG: null, nL: null, proceeds: u.proceedsUsd, costs: u.costUsd, gains: u.gainsUsd, losses: u.lossesUsd, net: u.netUsd, C: { proceeds: u.proceedsC, costs: u.costC, gains: u.gainsC, losses: u.lossesC, net: u.netC } });
      const otherCols = cols('Section'); otherCols[0] = { key: 'c', label: 'Section', render: (x) => h('div', x.label, folded(x)) };
      U.replace(classWrap, ...tables,
        other.length ? h('div', h('div.small.dim', { style: { margin: '0 0 6px' } }, 'Other sections, each on its own: not summed with perps or with each other'), h('div.card.tight', tableRoles(UI.table({ cols: otherCols, rows: other })))) : null,
        h('div.dim.small', { style: { marginTop: '8px' } }, 'Each perps disposal (a reduction, partial close, liquidation or auto-deleverage) is counted once, on its own date, after its own trading fees. Proceeds and costs are its cash flows, not notional: credits are a positive result (and, inside, funding received), debits a negative result and its fees (and, inside, funding paid and position fees). Gains add up the positive results, losses the negative ones. Both readings of funding and position fees are shown and neither is marked as the one that applies. Meridian Predict: proceeds are what each result paid (a loss pays nothing), costs its stake, collateral or average cost. Classes by the market\'s base token; which box or line a class goes in is not said here.'));
    };

    // ---- monthly / quarterly ----
    const mCanvas = h('canvas');
    const monthlyWrap = h('div'), quarterWrap = h('div.wrap-cells');
    // the monthly and quarterly tables, drawn again when the trade detail recasts their report-currency figures
    const renderPeriods = () => {
      U.replace(monthlyWrap, UI.table({ cols: [
        { key: 'm', label: 'Month', render: (m) => h('span', m.label, m.cut ? h('span.dim.xs', ' ' + m.cut) : null) },
        { key: 'r', label: 'Realized PnL', num: true, render: (m) => pnlEl(m.C.realized, m.realized) },
        { key: 'f', label: 'Fees', num: true, title: 'trading fees plus position fees', render: (m) => fmtC(m.C.fees + (m.C.pfees || 0)) },
        { key: 'fu', label: 'Funding', num: true, render: (m) => pnlEl(m.C.funding, m.funding) },
        { key: 'n', label: 'Net', num: true, render: (m) => pnlEl(m.C.net, m.net) },
        { key: 'd', label: 'Deposits', num: true, render: (m) => fmtC(m.C.deposits) },
        { key: 'w', label: 'Withdrawals', num: true, title: 'incl. withdrawal and deposit fees', render: (m) => fmtC(m.C.withdrawals) },
        { key: 'v', label: 'Volume', num: true, render: (m) => fmtC(m.C.volume, { compact: true }) },
      ], rows: monthly, empty: 'No activity in this period' }));
      U.replace(quarterWrap, UI.table({ cols: [
        { key: 'q', label: 'Quarter', render: (q) => h('div', q.label, h('div.dim.xs', TZ.fmt(q.t0, tz, 'short') + ' – ' + TZ.fmt(q.t1 - 1, tz, 'short'))) },
        { key: 'r', label: 'Realized PnL', num: true, render: (q) => pnlEl(q.C.realized, q.realized) },
        { key: 'f', label: 'Fees', num: true, title: 'trading fees plus position fees', render: (q) => fmtC(q.C.fees + (q.C.pfees || 0)) },
        { key: 'fu', label: 'Funding', num: true, render: (q) => pnlEl(q.C.funding, q.funding) },
        { key: 'n', label: 'Net', num: true, render: (q) => pnlEl(q.C.net, q.net) },
      ], rows: quarters, empty: 'No activity in this period' }));
    };
    // in another currency the axis is in that currency too, in whole units like C.axisUsd; drawn once the cards are in
    // the page (start), and again when the trade detail recasts the months
    let chartOn = false;
    const drawChart = () => { if (chartOn) C.bars(mCanvas, monthly.map((m) => m.label), monthly.map((m) => m.C.net), rates ? { fmt: (v) => fmtC(v), axisFmt: (v) => fmtC(v, { compact: true, dp: Math.abs(v) < 10 && v % 1 !== 0 ? 2 : 0 }) } : {}); };

    // ---- by market, from the period's disposals ----
    const marketWrap = h('div');
    const renderMarket = () => {
      if (!D) { U.replace(marketWrap, UI.empty(evErr ? 'The trade detail did not load: by market needs it.' : waitText())); return; }
      const m = {};
      for (const r of D.inP) {
        const x = m[r.ticker] || (m[r.ticker] = { ticker: r.ticker, cls: r.cls, n: 0, wins: 0, gross: 0, fees: 0, net: 0, inside: 0, netAll: 0, notional: 0, C: { gross: 0, fees: 0, net: 0, inside: 0, netAll: 0, notional: 0 } });
        x.n++; if (r.net > 0) x.wins++;
        x.gross += r.gross; x.fees += r.openFee + r.closeFee; x.net += r.net; x.inside += r.fundingIn - r.posFeeIn; x.netAll += r.netAll; x.notional += r.exitNotional;
        // each part as the replay converted it: the opening-fee share and the carried funding and fees at the dates paid
        x.C.gross += r.grossC; x.C.fees += r.openFeeC + r.closeFeeC; x.C.net += r.netC; x.C.inside += r.fundingInC - r.posFeeInC; x.C.netAll += r.netAllC; x.C.notional += r.exitNotionalC;
      }
      U.replace(marketWrap, UI.table({ cols: [
        { key: 'm', label: 'Market', render: (r) => UI.marketCell(r.ticker, r.cls) },
        { key: 'n', label: 'Disposals', num: true, render: (r) => String(r.n) },
        { key: 'wr', label: 'Win rate', num: true, title: 'disposals with a positive net result (after their fees)', render: (r) => U.fmtPct((r.wins / r.n) * 100, { dp: 0 }) },
        { key: 'g', label: 'Realized PnL', num: true, render: (r) => pnlEl(r.C.gross, r.gross) },
        { key: 'f', label: 'Fees', num: true, title: 'opening-fee shares and closing fees of the disposals', render: (r) => fmtC(r.C.fees) },
        { key: 'net', label: 'Net', num: true, title: 'gross − fees; funding and position fees as separate items', render: (r) => pnlEl(r.C.net, r.net) },
        { key: 'in', label: 'Funding & position fees inside', num: true, title: 'the settlements since each position opened, shared by quantity closed', render: (r) => pnlEl(r.C.inside, r.inside) },
        { key: 'na', label: 'Net, inside', num: true, title: 'net with funding and position fees inside the result', render: (r) => pnlEl(r.C.netAll, r.netAll) },
        { key: 'v', label: 'Closed notional', num: true, render: (r) => fmtC(r.C.notional, { compact: true }) },
      ], rows: Object.values(m).sort((a, b) => b.notional - a.notional), empty: 'No disposals in this period' }));
    };

    // ---- disposals: one row per reducing fill, or merged per position per local day ----
    let printAll = false;   // print hides the pagers, so the tables get every row (see beforeprint below)
    const dispWrap = h('div'); let dView = 'fill', dPage = 1;
    const dispSeg = UI.seg([{ v: 'fill', label: 'Per fill' }, { v: 'day', label: 'Per position per day' }], dView, (v) => { dView = v; dPage = 1; renderDisp(); }, 'sm');
    // a neutral flag (not one country's term for it); a UK report leaves it out, as the UK research found no line drawn
    // at one year for these gains there. The data columns keep the flag in every report.
    const overYearChip = (on, style) => (on && period.preset !== 'uk' ? h('span.chip.blue', { style: style || null, title: `held for more than one year (calendar dates, ${tz})` }, 'held > 1 yr') : null);
    const flags = (r) => h('span.tax-flags',
      r.partial ? UI.chip('partial', '') : null, r.liq ? UI.chip('LIQ', 'red') : null, r.adl ? UI.chip('ADL', 'amber') : null,
      overYearChip(r.longTerm));
    const renderDisp = () => {
      if (!D) { U.replace(dispWrap, UI.empty(evErr ? 'The trade detail did not load.' : waitText())); return; }
      // print: every row; above PRINT_MAX fills, the per-position-per-day view
      const big = printAll && dView === 'fill' && D.inP.length > PRINT_MAX;
      const view = big ? 'day' : dView;
      dispViewTag.textContent = view === 'day' ? 'per position per local day' : 'per fill';
      const all = (view === 'day' ? F.byPositionDay(D.inP, tz) : D.inP).slice().reverse();
      const slice = printAll ? all : all.slice((dPage - 1) * PAGE, dPage * PAGE);
      const tick = (r) => (ref.byId[r.productId] || {}).tickSize;
      U.replace(dispWrap,
        big ? h('div.small.muted', { style: { padding: '8px 14px' } }, `${U.fmtNum(D.inP.length, 0)} disposals: printed per position per local day; the Disposals export lists every fill.`) : null,
        UI.table({ cols: [
          { key: 't', label: TUI.tzLabel('Time', tz), render: (r) => h('span.dim', { title: isoTime(r.t) + (r.fills > 1 ? ` · ${r.fills} fills, the last at this time` : '') }, loc(r.t).slice(0, 16)) },
          { key: 'm', label: 'Market', render: (r) => UI.marketCell(r.ticker) },
          { key: 's', label: 'Side', render: (r) => U.sideEl(r.long, true) },
          { key: 'q', label: 'Qty', num: true, render: (r) => U.fmtQty(r.qty) },
          { key: 'e', label: 'Avg entry', num: true, title: 'the position\'s average entry price at this reduction (the exchange\'s method)', render: (r) => U.fmtPrice(r.avgEntry, tick(r)) },
          { key: 'x', label: 'Exit', num: true, render: (r) => U.fmtPrice(r.exit, tick(r)) },
          { key: 'g', label: 'Realized PnL', num: true, render: (r) => pnlEl(r.grossC, r.gross) },
          { key: 'f', label: 'Fees', num: true, title: 'the opening-fee share (the fees of the increases still open, shared by quantity closed) plus the closing fee' + (rates ? '; each fee at the date it was paid' : ''), render: (r) => fmtC(r.openFeeC + r.closeFeeC) },
          { key: 'n', label: 'Net', num: true, title: 'gross − fees; funding and position fees as separate items, on their settlement dates', render: (r) => pnlEl(r.netC, r.net) },
          { key: 'in', label: 'Funding & fees inside', num: true, title: 'funding minus position fees settled since the position opened, shared by quantity closed (the inside-the-result reading)' + (rates ? '; each settlement at its own date' : ''), render: (r) => (Math.abs(r.fundingIn - r.posFeeIn) < 0.005 ? h('span.dim', '—') : pnlEl(r.fundingInC - r.posFeeInC, r.fundingIn - r.posFeeIn)) },
          { key: 'na', label: 'Net, inside', num: true, render: (r) => pnlEl(r.netAllC, r.netAll) },
          { key: 'fl', label: '', render: flags },
        ], rows: slice, empty: 'No disposals in this period' }),
        !printAll && all.length > PAGE ? UI.pager({ page: dPage, pageSize: PAGE, total: all.length, onPage: (p) => { dPage = p; renderDisp(); } }) : null);
    };

    // left out of print until the detail is in, like All transactions; in print the view the table shows is named, as
    // its switch is hidden
    const dispViewTag = h('span.print-only.dim.small');
    const dispCard = h('div.card.tight.no-print', h('div.card-head', h('h2', 'Disposals'), h('span.dim.small', 'each reduction, partial close, liquidation or auto-deleverage on its own date'), h('span.grow'), h('span.no-print', dispSeg), dispViewTag),
      h('div.small.muted', { style: { padding: '10px 14px', borderBottom: '1px solid var(--border-2)' } }, 'Each reduction is booked against the position\'s average entry price (the exchange\'s method) and listed as its own disposal. Funding and position fees are shown two ways, side by side, neither marked as the one that applies: Net leaves them as separate items on their settlement dates (the Funding and Fees lines above, the Funding settlements export); Net, inside adds those settled since the position opened, shared by the quantity closed.'),
      dispWrap);

    // ---- closed positions: a whole-life summary per position ----
    const ledgerWrap = h('div'); let lpage = 1;
    const truncNote = positions.truncated ? h('div.small', { style: { padding: '10px 14px', borderBottom: '1px solid var(--border-2)', color: 'var(--amber)' } }, `The exchange returned only the newest ${U.fmtNum(positions.length, 0)} positions, so older ones are missing from the per-position tables and exports. The ledger totals above are complete.`) : null;
    const renderLedger = () => {
      const slice = printAll ? closed : closed.slice((lpage - 1) * PAGE, lpage * PAGE);
      U.replace(ledgerWrap, UI.table({ cols: [
        { key: 'closed', label: TUI.tzLabel('Closed', tz), render: (c) => h('span.dim', { title: isoTime(c.t) }, loc(c.t).slice(0, 16)) },
        { key: 'm', label: 'Market', render: (c) => UI.marketCell(c.ticker) },
        { key: 'side', label: 'Side', render: (c) => U.sideEl(c.long, true) },
        { key: 'size', label: 'Size', num: true, render: (c) => U.fmtQty(c.size) },
        { key: 'entry', label: 'Avg entry', num: true, render: (c) => U.fmtPrice(c.entry, c.tick) },
        { key: 'exit', label: 'Avg exit', num: true, render: (c) => U.fmtPrice(c.exit, c.tick) },
        { key: 'cost', label: 'Cost', num: true, render: (c) => fmtC(c.cost * c.rate) },
        { key: 'gross', label: 'Realized PnL', num: true, render: (c) => pnlEl(c.grossC, c.gross) },
        { key: 'fees', label: 'Fees', num: true, render: (c) => fmtC((c.fees + c.pfees) * c.rate) },
        { key: 'fund', label: 'Funding', num: true, render: (c) => fmtC(c.funding * c.rate, { sign: true }) },
        { key: 'net', label: 'Net', num: true, render: (c) => pnlEl(c.netC, c.net) },
        { key: 'hold', label: 'Held', num: true, render: (c) => h('span', U.fmtDuration(c.hold), overYearChip(c.longTerm, { marginLeft: '6px' })) },
        { key: 'flag', label: '', render: (c) => (c.liq ? UI.chip('LIQ', 'red') : c.adl ? UI.chip('ADL', 'amber') : '') },
      ], rows: slice, empty: 'No positions closed in this period' }), !printAll && closed.length > PAGE ? UI.pager({ page: lpage, pageSize: PAGE, total: closed.length, onPage: (p) => { lpage = p; renderLedger(); } }) : null);
    };

    // ---- all transactions: every fill (liquidation and deleverage fills included), settlement, transfer and close ----
    let events = null;
    const txWrap = h('div'); let txType = 'all', txPage = 1;
    const TX_TYPES = [{ v: 'all', label: 'All' }, { v: 'trade', label: 'Fills' }, { v: 'funding', label: 'Funding & position fees' }, { v: 'transfer', label: 'Deposits, withdrawals & conversions' }, { v: 'close', label: 'Position closes' }];
    const txCount = h('span.dim.small'), txCheck = h('div.small', { style: { padding: '8px 14px' } });
    // every fill, settlement, transfer and close of the period (js/tax/exports.js: the same rows as the export)
    const buildEvents = () => EX.transactions({ ev, D, ref, period, tz, closed, now, led });
    const renderTx = () => {
      if (!events) { U.replace(txWrap, UI.empty(evErr ? 'The trade detail did not load.' : waitText())); U.replace(txCheck); txCount.textContent = ''; return; }
      const rows = txType === 'all' ? events : events.filter((e) => e.type === txType || (txType === 'funding' && e.type === 'posfee'));
      const slice = printAll ? rows : rows.slice((txPage - 1) * PAGE, txPage * PAGE);
      // the filter is named in the count: print hides the filter itself, and the heading still says every transaction
      txCount.textContent = (txType === 'all' ? '' : TX_TYPES.find((x) => x.v === txType).label + ': ') + `${U.fmtNum(rows.length, 0)} of ${U.fmtNum(events.length, 0)} events`;
      const dust = (v) => (Math.abs(v) < 0.005 ? 0 : v);   // no "-$0.00"
      const sum = dust(U.sum(events, (e) => e.amount)), want = dust(closing - opening), diff = sum - want;
      U.replace(txCheck, h('span', { class: Math.abs(diff) < 0.01 ? 'dim' : '', style: Math.abs(diff) < 0.01 ? null : { color: 'var(--amber)' } }, `Sum of the cash effects ${U.fmtUsd(sum, { sign: true, dp: 2 })} · closing − opening balance ${U.fmtUsd(want, { sign: true, dp: 2 })}` + (Math.abs(diff) < 0.01 ? ' · they match' : ` · difference ${U.fmtUsd(diff, { sign: true, dp: 2 })} (see the notes under the tiles and the balance reconciliation)`)));
      const chip = { trade: ['fill', ''], close: ['position close', 'accent'], funding: ['funding', 'blue'], posfee: ['position fee', 'blue'], transfer: ['transfer', 'amber'] };
      U.replace(txWrap, UI.table({ cols: [
        { key: 't', label: TUI.tzLabel('Time', tz), render: (e) => h('span.dim', { title: isoTime(e.t) }, loc(e.t)) },
        { key: 'ty', label: 'Type', render: (e) => UI.chip(chip[e.type][0], chip[e.type][1]) },
        { key: 'w', label: 'What', render: (e) => h('span', e.what) },
        { key: 'a', label: 'Cash effect', num: true, title: 'Money in (+) or out (−) of the account from this event: a fill\'s realized PnL (on a reduction) less its fee, a funding or position-fee settlement, a transfer net of its fee; a position close is a marker with no cash effect. Together they equal the balance change, as the line above the table checks.', render: (e) => (e.amount ? pnlEl(money.fx(e.amount, e.t), e.amount) : h('span.dim', '—')) },
        { key: 'f', label: 'Fee', num: true, title: 'the fee part of the cash effect', render: (e) => (e.fee ? fmtC(money.fx(e.fee, e.t)) : h('span.dim', '—')) },
        { key: 'n', label: 'Notional', num: true, render: (e) => (e.notional ? fmtC(money.fx(e.notional, e.t)) : h('span.dim', '—')) },
        { key: 'd', label: '', render: (e) => h('span.dim.small', e.detail, e.tx ? [' · ', h('a', { href: U.explorerTx(e.tx), target: '_blank', rel: 'noopener' }, 'tx')] : null) },
      ], rows: slice, empty: 'No events of this type in the period' }), !printAll && rows.length > PAGE ? UI.pager({ page: txPage, pageSize: PAGE, total: rows.length, onPage: (p) => { txPage = p; renderTx(); } }) : null);
    };
    const txHead = h('div.row.wrap', { style: { gap: '8px', padding: '10px 14px 0' } }, UI.seg(TX_TYPES, txType, (v) => { txType = v; txPage = 1; renderTx(); }, 'sm'), h('span.grow'), txCount);
    // left out of print until the detail is in: a printed report holds the rows or not the card
    const txCard = h('div.card.tight.no-print', h('div.card-head', h('h2', 'All transactions'), h('span.dim.small', 'fills (liquidation and auto-deleverage fills included), funding and position-fee settlements, deposits, withdrawals and conversions, position closes; newest first')), txHead, txCheck, txWrap);

    // print / PDF: the pagers are hidden in print, so the tables print every row and go back to their page afterwards;
    // the balance reconciliation prints open (the opening and closing balances are in it) and closes again if it was
    const renderAll = () => { renderTiles(); renderChecks(); renderCats(); renderClasses(); renderPeriods(); renderMarket(); renderDisp(); renderLedger(); renderTx(); renderExports(); };
    let reconWasOpen = false;
    const bp = () => { printAll = true; reconWasOpen = reconCard.open; reconCard.open = true; renderDisp(); renderLedger(); renderTx(); };
    const ap = () => { printAll = false; reconCard.open = reconWasOpen; renderDisp(); renderLedger(); renderTx(); };
    if (!ctx.signal.aborted) { window.addEventListener('beforeprint', bp); window.addEventListener('afterprint', ap); ctx.onCleanup(() => { window.removeEventListener('beforeprint', bp); window.removeEventListener('afterprint', ap); }); }

    // ---- loading the detail: automatic once the cards are in (on request above T.load.AUTO), cached for the tab, one
    // promise every export waits on ----
    const loadEvents = () => {
      if (evPromise) return evPromise;
      const again = !asked || evErr;
      asked = true; evErr = null;
      if (again && ctx.onDetail) ctx.onDetail(null, null, null);   // the Holdings card waits for it again
      const ac = new AbortController(); const stop = () => ac.abort();
      ctx.signal.addEventListener('abort', stop); ctx.onCleanup(() => ctx.signal.removeEventListener('abort', stop));
      const prog = TUI.progress(evLine, stop);
      const say = (s) => prog.set('Loading trade detail: ' + [s.fillPages ? `fills ${plural(s.fillPages, 'page')}` + (s.fillRows ? ` (${U.fmtNum(s.fillRows, 0)})` : '') : 'fills…', s.posTotal ? `positions ${s.posDone}/${s.posTotal}` : null, s.fundTotal ? `funding ${s.fundDone}/${s.fundTotal}` : null].filter(Boolean).join(' · '));
      say({ fillPages: 0 });
      evPromise = T.load.events(sid, { start, end, ref, dayRows: ctx.arch.balance, signal: ac.signal, progress: say }).then((x) => {
        ev = x; D = F.disposals(ev, { ledger: led, period, ref, tz, fx: money.fx });
        // every report-currency total from the same events, each at its own local date (the ledger's whole-day
        // conversion stays only where the detail does not add up): the tiles, months, quarters, summary and holdings
        if (rates) { T.ledger.recast(led, D.ledgerC); TC = tcOf(); drawChart(); }
        events = buildEvents();
        dispCard.classList.remove('no-print'); txCard.classList.remove('no-print');   // their rows are in: they print
        const n = D.inP.length, w = EX.eventWarnings({ ev, D });
        U.replace(evLine, h('div.dim.small', `Trade detail: ${plural(ev.fills.length, 'fill')}, ${plural(ev.touched.length, 'position')} and ${ev.charges ? plural(ev.charges.length, 'hourly funding charge') : 'no funding charges (unreadable)'} read; ${plural(n, 'disposal')} in the period` + (w.length ? '' : ', each UTC day checked against the exchange\'s ledger') + '.'));
        renderAll();
        if (ctx.onDetail) ctx.onDetail(ev, D, null);   // the Holdings card: sizes and unsettled funding at the instants
        return D;
      }, (e) => {
        evPromise = null; evErr = e;
        if (ctx.signal.aborted) throw e;
        if (ctx.onDetail) ctx.onDetail(null, null, e);
        U.replace(evLine, h('div.small', { style: { color: 'var(--amber)' } }, (T.isAbort(e) ? 'Trade detail not loaded (cancelled).' : 'Trade detail not loaded: ' + e.message + '.') + ' The ledger figures above are complete; gains, losses, funding received and paid, by market, disposals and every transaction need it. ', h('button.btn.sm', { onclick: () => { loadEvents().catch(() => {}); } }, 'Load again')));
        renderAll();
        throw e;
      });
      renderAll();
      return evPromise;
    };
    const needEvents = async () => { const x = await loadEvents(); return x; };

    // ---- exports: the registry's files (js/tax/exports.js), a site report with the report's methodology first ----
    // without the trade detail (it failed or was cancelled) the files that can do without it still export, marked
    // incomplete; the others need it
    const tryEvents = async () => { try { await needEvents(); } catch (e) { if (ctx.signal.aborted) throw e; } };
    const ready = async (d) => { if (d.needs.includes('events')) await needEvents(); else if (d.needs.includes('events?')) await tryEvents(); };
    const run = async (d) => {
      await ready(d);
      const c = d.section === 'summary' ? await ctx.summaryCtx() : exCtx();
      const f = EX.build(d.id, c);
      TUI.save(f, f.kind === 'tool' ? null : ctx.methodology(f, f.extra));
    };
    const exText = h('p.dim.small', { style: { margin: '0 0 12px' } }), exList = h('div.metric-list');
    // the buttons follow the detail: a tax-tool file says which days are daily totals once it is in
    const renderExports = () => {
      // an export still preparing keeps its button (and spinner): the card redraws once it is done
      if (exList.querySelector('button[disabled]')) { if (!ctx.signal.aborted) setTimeout(renderExports, 1000); return; }
      const c = exCtx();
      exText.textContent = EX.cardText({ money, tz });
      const btn = (d, cc) => exBtn(EX.text(d.label, cc), EX.text(d.sub, cc), () => run(d), true);
      U.replace(exList, ...EX.offered('summary', c).map((d) => btn(d, c)), ...EX.offered('perps', c).map((d) => btn(d, c)),
        ctx.importNotes ? exBtn('Import notes (methodology.txt)', 'How the tax-tool files are made (tags, UTC, daily rows where the detail is not available), with this report\'s methodology and what each file is missing.', ctx.importNotes, true) : null,
        ctx.zip ? exBtn('Download everything (ZIP)', 'Every file of this report (perps, Meridian Predict under its card\'s date basis, holdings, the USDe lots once built), plus methodology.txt and methodology.json; it waits for the trade detail and the Predict data.', ctx.zip, true) : null);
    };
    const exportsCard = h('div.card.no-print', h('h3', { style: { marginBottom: '4px' } }, 'Exports (CSV)'), exText, exList);
    // the perps part of the summary and of the ZIP, once the detail is in (or failed)
    const summaryPerps = async () => { await tryEvents(); return { led, closed, D, ff: fundFig(), openAtEnd: openAtEnd.length, openUpnl: current ? openUpnl : null, monthly, quarters, closedOverYear }; };
    const files = async () => {
      await tryEvents();
      const c = exCtx();
      return EX.offered('perps', c).filter((d) => D || !d.needs.includes('events')).map((d) => EX.build(d.id, c));
    };
    const skipped = () => (D ? [] : EX.offered('perps', exCtx()).filter((d) => d.needs.includes('events')).map((d) => EX.text(d.label, exCtx()) + ' (the trade detail did not load)'));

    // ---- layout ----
    const created = U.num(ctx.sa.createdAt);
    const activeDays = new Set(days.filter((b) => b.realizedPnl || b.fee || b.pfees || b.funding || b.deposit || b.withdrawal || b.volume).map((b) => b.day)).size;
    const periodLine = h('div.small.dim', { style: { marginBottom: '10px' } }, 'Period ', period.startText, ' → ', period.endText, period.ongoing && mode === 'custom' ? ' (not over yet)' : '');
    const fxLine = ctx.fxLine || null;
    renderAll();
    const cards = [
      h('div.card', h('div.row', { style: { marginBottom: '6px' } }, h('h2', label), UI.chip('perps', 'accent'), h('span.grow'), h('span.dim.small', (created > start ? `account since ${TZ.fmt(created, tz, 'short')} · ` : '') + `${activeDays} day${activeDays === 1 ? '' : 's'} with activity · ${positions.length}${positions.truncated ? '+' : ''} position${positions.length === 1 && !positions.truncated ? '' : 's'} on record`)), periodLine, tilesWrap, fxLine, evLine, checksEl, reconCard),
      UI.card('Results, costs and transfers', h('div', catWrap, catInfo), h('span.dim.small', 'by type: what each line is')),
      UI.card('Gains and losses by class', classWrap, h('span.dim.small', 'each disposal on its own cash flows · both readings')),
      ctx.holdingsCard || null,   // Holdings at period start and end (js/tax/view-holdings.js)
      h('div.grid.cols-2', h('div.card.chart-fill.no-print', h('h3', { style: { marginBottom: '10px', flex: 'none' } }, 'Net result by month'), h('div.chart-box.sm', mCanvas)), UI.card('Quarterly breakdown', quarterWrap, h('span.dim.small', (mode === 'year' ? 'fiscal quarters' : 'calendar quarters') + ' · ' + tz))),
      UI.card('Monthly breakdown', monthlyWrap, h('span.dim.small', 'local months · ' + tz)),
      UI.card('By market', marketWrap, h('span.dim.small', 'the period\'s disposals')),
      dispCard,
      UI.card('Closed positions', h('div', truncNote, h('div.small.muted', { style: { padding: '10px 14px', borderBottom: '1px solid var(--border-2)' } }, 'A summary per position fully closed in the period, with its whole result (partial closes before the period included); the period\'s gains and losses come from the disposals above.'), ledgerWrap), h('span.dim.small', `${closed.length} in period` + (largestWin ? ` · best ${fmtC(largestWin.netC, { sign: true })}` : '') + (largestLoss ? ` · worst ${fmtC(largestLoss.netC, { sign: true })}` : ''))),
      txCard, exportsCard,
    ].filter(Boolean);
    return {
      cards,
      start() {
        chartOn = true; drawChart();
        if (size.auto) { loadEvents().catch(() => {}); return; }
        // a big period: said, with the button that starts it (an export that needs it starts it too)
        const why = [size.truncated ? 'more positions than one read returns' : null, size.touched > T.load.AUTO.positions ? plural(size.touched, 'position') + ' to replay' : null, size.days > T.load.AUTO.days ? `fills and hourly funding charges from ${plural(size.days, 'day')} back` : null].filter(Boolean).join(', ');
        U.replace(evLine, h('div.small.dim', `Trade detail not loaded yet: this period needs ${why}, so it loads on request. The ledger figures above are complete; gains, losses, funding received and paid, by market, disposals and every transaction need it, and an export that needs it loads it first. `,
          h('button.btn.sm', { onclick: () => { loadEvents().catch(() => {}); } }, 'Load trade detail')));
        if (ctx.onDetail) ctx.onDetail(null, null, null, { deferred: true });
      },
      summaryPerps,
      files,
      toolFiles: async () => { await tryEvents(); const c = exCtx(); return EX.offered('perps', c).filter((d) => d.kind === 'tool').map((d) => EX.build(d.id, c)); },
      skipped,
      /** what the report's methodology says is missing from the perps part */
      warnings: () => (D ? EX.eventWarnings({ ev, D }) : evErr ? [EX.NO_DETAIL] : ['the trade detail had not loaded']).concat(led.fallbackDays.length ? [led.fallbackDays.length + ' UTC day(s) the period\'s boundaries cut counted whole (their hourly ledger could not be read)'] : []),
      refreshClasses: () => renderClasses(),
      /** how the perps figures are converted to the report currency, for the Rate rule (null in USD) */
      rateBasis: () => (rates ? EX.DISPOSAL_RATE_TEXT + '; ' + T.ledger.basisText(led) : null),
    };
  };
})();
