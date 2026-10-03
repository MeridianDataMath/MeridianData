/* MeridianDataHub — Tax center summary: gains and losses by class (crypto perps, commodity mPerps, equity-ETF mPerps, any
   other market by its ticker), each disposal on its own cash flows under both readings of funding and position fees;
   Meridian Predict under every date basis; the USDe lots under both deposit readings; and the summary file with every
   total of the report; and the perps lines by type (results, costs and transfers). Sections are never summed together
   (perps, Predict and USDe lots follow different rules in most countries, and the page does not choose them). Records
   only: no tax is computed. Pure: no DOM, no network. */
(function () {
  const MD = window.MD; const U = MD.util; const T = MD.tax;
  const S = (T.summary = {});
  const n6 = (v) => (v == null ? '' : T.n6(v));

  /** the classes in the order the tables list them; any other market is 'Other · <ticker>', after them */
  S.CLASSES = ['Crypto perps', 'Commodity mPerps', 'Equity-ETF mPerps'];
  /** A market's class, by its base token (BTC, ETH, SOL, HYPE · XAU, XAG · SPY, QQQ). */
  S.classOf = (prod) => T.fills.classOf(prod);
  S.READINGS = ['separate', 'inside'];
  S.READING_LABEL = { separate: 'Funding and position fees as separate items', inside: 'Funding and position fees inside the result' };

  /** One disposal's cash flows under a reading: credits (money in: a positive result; funding received when inside) and
   *  debits (money out: a negative result, its trading fees; funding paid and position fees when inside); credits −
   *  debits = its net under that reading. A credit-signed fee (a rebate) counts as a credit. C: the same in the report
   *  currency, each part as T.fills.replay converted it (the opening-fee share and the carried funding and position fees
   *  at the dates paid), on the side its USD sign puts it, so credits − debits = netC or netAllC; the USD amounts when
   *  the row has none. */
  S.flows = (r, reading) => {
    const c = (k) => (r[k + 'C'] != null ? r[k + 'C'] : r[k]);
    const fee = r.openFee + r.closeFee, feeC = c('openFee') + c('closeFee');
    let cr = 0, db = 0, crC = 0, dbC = 0;
    // a part on the credit side when its USD sign says money in, else on the debit side, in both currencies
    const put = (usd, cc, inWhenPositive) => { if ((usd >= 0) === inWhenPositive) { cr += Math.abs(usd); crC += inWhenPositive ? cc : -cc; } else { db += Math.abs(usd); dbC += inWhenPositive ? -cc : cc; } };
    put(r.gross, c('gross'), true);
    put(fee, feeC, false);
    if (reading === 'inside') { put(r.fundingIn, c('fundingIn'), true); put(r.posFeeIn, c('posFeeIn'), false); }
    return { credits: cr, debits: db, net: reading === 'inside' ? r.netAll : r.net, C: { credits: crC, debits: dbC, net: reading === 'inside' ? c('netAll') : c('net') } };
  };
  const blank = () => ({ n: 0, nG: 0, nL: 0, proceeds: 0, costs: 0, gains: 0, losses: 0, net: 0 });
  const zero = (o) => Object.assign(o, blank(), { C: blank() });
  // a result's money (u: USD, c: the report currency, each {proceeds, costs, net}); gains and losses by its USD sign, so
  // a disposal is a gain or a loss in both currencies
  const addTo = (x, u, c) => {
    x.n++; x.C.n++;
    x.proceeds += u.proceeds; x.costs += u.costs; x.net += u.net;
    x.C.proceeds += c.proceeds; x.C.costs += c.costs; x.C.net += c.net;
    if (u.net > 0) { x.nG++; x.gains += u.net; x.C.gains += c.net; } else if (u.net < 0) { x.nL++; x.losses += u.net; x.C.losses += c.net; }
  };
  const order = (c) => { const i = S.CLASSES.indexOf(c); return i < 0 ? S.CLASSES.length : i; };

  /**
   * The period's disposals (rows: T.fills' disposal rows) by class under a reading ('separate' | 'inside'), each in USD
   * and in the report currency, each part at its own date's rate (S.flows' C; money: T.fx.money, USD when left out).
   * Returns [{cls, n, nG, nL, proceeds, costs, gains (sum of the positive nets), losses (sum of the negative nets), net,
   * C: {…}}] in class order, then the perps total ({cls: 'Perps total', total: true}).
   */
  S.byClass = (rows, reading, money) => {
    const m = new Map(), tot = zero({ cls: 'Perps total', total: true });
    const inC = !!(money && money.rates);
    for (const r of rows || []) {
      const f = S.flows(r, reading), u = { proceeds: f.credits, costs: f.debits, net: f.net }, c = inC ? { proceeds: f.C.credits, costs: f.C.debits, net: f.C.net } : u;
      let x = m.get(r.cls); if (!x) m.set(r.cls, (x = zero({ cls: r.cls })));
      addTo(x, u, c); addTo(tot, u, c);
    }
    return Array.from(m.values()).sort((a, b) => order(a.cls) - order(b.cls) || (a.cls < b.cls ? -1 : a.cls > b.cls ? 1 : 0)).concat([tot]);
  };

  /**
   * Meridian Predict's results booked in the period under a date basis (T.predict.book), like a class: n results (won,
   * lost, void, sales, matched sets, tokens held to the verdict; one counted in the ledger's events is counted there),
   * proceeds (what each paid: a win's payout, a void's refund, a sale's price, what tokens held to the verdict paid; a
   * loss pays nothing), costs (proceeds − result: the stake, collateral or average cost), gains, losses, net (= the
   * Realized PnL tile), each with C. prep: T.predict.prepare; money optional.
   */
  S.predict = (prep, mode, period, money) => {
    const x = zero({ cls: 'Meridian Predict', mode: T.predict.modeOf(mode) });
    for (const e of T.predict.book(prep, x.mode)) {
      if (!(e.t >= period.start && e.t < period.end) || e.ledger || e.kind === 'placed' || e.kind === 'buy') continue;
      const proceeds = e.kind === 'void' ? e.refund || 0 : e.payout || 0, k = money ? money.rate(e.t) : 1;
      addTo(x, { proceeds, costs: proceeds - e.pnl, net: e.pnl }, { proceeds: proceeds * k, costs: (proceeds - e.pnl) * k, net: e.pnl * k });
    }
    return x;
  };

  /** The USDe lots' period totals under both deposit readings (runs: {transfer, disposal} of T.lots.run): [{reading, …T.lots.totals}]. */
  S.usde = (runs, period) => (runs ? T.lots.READINGS.filter((r) => runs[r]).map((r) => Object.assign({ reading: r }, T.lots.totals(runs[r].disposals, period.start, period.end))) : []);

  /** The perps tiles' figures from the period's disposals (D: T.fills.disposals): gains and losses (gross), liquidations,
   *  held over a year, the realized PnL the disposals leave out. Null without the detail. */
  S.perpsFigures = (D, money) => {
    if (!D) return null;
    const fx = (v, t) => (money ? money.fx(v, t) : v);
    const inP = D.inP, g = inP.filter((r) => r.gross > 0), l = inP.filter((r) => r.gross < 0), lt = inP.filter((r) => r.longTerm);
    return {
      inP, gains: U.sum(g, (r) => r.gross), gainsC: U.sum(g, (r) => fx(r.gross, r.t)), nG: g.length,
      losses: U.sum(l, (r) => r.gross), lossesC: U.sum(l, (r) => fx(r.gross, r.t)), nL: l.length, nLiq: inP.filter((r) => r.liq).length, nAdl: inP.filter((r) => r.adl).length,
      lt: lt.length, ltNet: U.sum(lt, (r) => r.net), ltNetC: money && money.rates ? U.sum(lt, (r) => (r.netC != null ? r.netC : fx(r.net, r.t))) : U.sum(lt, (r) => r.net),
      outside: D.outside, showOutside: Math.abs(D.outside.usd) >= 0.01,
    };
  };

  // ---------- results, costs and transfers, by type ----------
  // a Type says what a line is, in the ledger's own terms, never how a tax system treats it: that differs by country,
  // and for funding, fees and deposits it is unsettled in several
  S.TYPES = ['trading result', 'funding', 'fee', 'transfer'];
  /**
   * The rows of 'Results, costs and transfers': [{cat, type, usd, c, note}], signed as money into (+) or out of (−) the
   * account, in USD and the report currency; usd and c are null while the trade detail loads. ctx: {totals (T.ledger's
   * totals, with .C), X (S.perpsFigures; null without the detail), ff (T.funding.figures), funding (true once the
   * funding legs are known: the detail is in, or failed and every day is netted), pending (the note while it loads)}.
   * With every amount known they add up to the balance change: deposits − withdrawals + the net result.
   */
  S.byType = (ctx) => {
    const L = ctx.totals, LC = L.C, X = ctx.X, ff = ctx.ff, known = !!ctx.funding, wait = ctx.pending || 'loading trade detail…';
    const nb = known && ff ? ff.fallback.length : 0;
    const fb = nb ? `; ${U.fmtNum(nb, 0)} UTC day${nb === 1 ? '' : 's'} netted per day (settlement detail unavailable)` : '';
    return [
      { cat: 'Trading gains', type: 'trading result', usd: X ? X.gains : null, c: X ? X.gainsC : null, note: X ? 'disposals (each reduction, partial close, liquidation or auto-deleverage) with a positive gross result, before fees and funding' : wait },
      { cat: 'Trading losses', type: 'trading result', usd: X ? X.losses : null, c: X ? X.lossesC : null, note: X ? 'disposals with a negative gross result, before fees and funding' : wait },
      X && X.showOutside ? { cat: 'Realized PnL outside the disposals', type: 'trading result', usd: X.outside.usd, c: X.outside.C, note: 'the exchange\'s ledger less the disposals listed; see the note under the tiles' } : null,
      { cat: 'Funding received (gross, per settlement)', type: 'funding', usd: known ? ff.received : null, c: known ? ff.C.received : null, note: known ? 'settled into the balance at a fill of the position; the hourly charges between two of its fills settle as one amount' + fb : wait },
      { cat: 'Funding paid (gross, per settlement)', type: 'funding', usd: known ? -ff.paid : null, c: known ? -ff.C.paid : null, note: known ? 'as above, the settlements that came out negative' + fb : wait },
      { cat: 'Trading fees', type: 'fee', usd: -L.fees, c: -LC.fees, note: 'taker / maker fees on every fill' },
      L.pfees ? { cat: 'Position fees (mPerps)', type: 'fee', usd: -L.pfees, c: -LC.pfees, note: 'charged on XAU, XAG, SPY and QQQ positions; booked when settled into the balance (at a fill of the position)' } : null,
      L.wfee ? { cat: 'Withdrawal & deposit fees', type: 'fee', usd: -L.wfee, c: -LC.wfee, note: 'charged by the exchange on transfers' } : null,
      { cat: 'Deposits', type: 'transfer', usd: L.deposits, c: LC.deposits, note: 'USDe deposited, wrapped into MeridianUSD 1:1' },
      { cat: 'Withdrawals', type: 'transfer', usd: -(L.withdrawals - L.wfee), c: -(LC.withdrawals - LC.wfee), note: 'MeridianUSD unwrapped into USDe and withdrawn, net of the fees above' },
    ].filter(Boolean);
  };

  // ---------- files ----------
  const C_OF = (money) => (money && money.rates ? money.ccy : null);
  /**
   * The rows of 'Gains and losses by class': perps per class under both readings (when the trade detail is in), Meridian
   * Predict under every basis (when its record is), the USDe lots under both deposit readings (when built). ctx:
   * {period, money, D, predict ({prep, mode} | …), lots ({runs, method, scope} | null)}.
   */
  S.classRows = (ctx) => {
    const out = [], P = ctx.period, money = ctx.money;
    if (ctx.D) for (const reading of S.READINGS) for (const x of S.byClass(ctx.D.inP, reading, money)) out.push(Object.assign({ section: 'Meridian perps', what: x.cls, reading: S.READING_LABEL[reading] }, x));
    const pr = ctx.predict;
    if (pr && pr.prep) for (const m of T.predict.MODES) out.push(Object.assign(S.predict(pr.prep, m, P, money), { section: 'Meridian Predict (not summed with perps)', what: 'Predictions and position tokens', reading: 'results dated ' + T.predict.MODE_FILE[m] + (m === T.predict.modeOf(pr.mode) ? ' (this report)' : '') }));
    const L = ctx.lots;
    if (L && L.runs) for (const u of S.usde(L.runs, P)) {
      const x = { section: 'USDe lots (not summed with perps or Predict)', what: T.lots.METHOD_LABEL[L.method] + ', ' + T.lots.SCOPE_LABEL[L.scope].toLowerCase(), reading: T.lots.READING_LABEL[u.reading], n: u.n, nG: null, nL: null, proceeds: u.proceedsUsd, costs: u.costUsd, gains: u.gainsUsd, losses: u.lossesUsd, net: u.netUsd, C: { proceeds: u.proceedsC, costs: u.costC, gains: u.gainsC, losses: u.lossesC, net: u.netC } };
      out.push(x);
    }
    return out;
  };
  const classColumns = (money) => {
    const C = C_OF(money);
    return [
      ['Section', (r) => r.section], ['Class', (r) => r.what], ['Reading or date basis', (r) => r.reading],
      ['Disposals', (r) => r.n], ['with a gain', (r) => (r.nG == null ? '' : r.nG)], ['with a loss', (r) => (r.nL == null ? '' : r.nL)],
      ['Proceeds USD', (r) => n6(r.proceeds)], ['Costs USD', (r) => n6(r.costs)], ['Gains USD (sum of positive results)', (r) => n6(r.gains)], ['Losses USD (sum of negative results)', (r) => n6(r.losses)], ['Net USD', (r) => n6(r.net)],
      ...(C ? [['Proceeds ' + C, (r) => n6(r.C.proceeds)], ['Costs ' + C, (r) => n6(r.C.costs)], ['Gains ' + C, (r) => n6(r.C.gains)], ['Losses ' + C, (r) => n6(r.C.losses)], ['Net ' + C, (r) => n6(r.C.net)]] : []),
    ];
  };
  /** What the by-class figures are, for a file's methodology rows. */
  S.classNotes = () => [
    ['Gains and losses by class', 'each perps disposal counted once, on its own date, after its own trading fees; proceeds and costs are its cash flows (credits: a positive result, funding received when inside; debits: a negative result, fees, funding paid and position fees when inside), not notional; gains are the sum of the positive results, losses of the negative ones; both readings of funding and position fees are given, neither marked as the one that applies'],
    ['Predict in the classes', 'per result booked in the period under each date basis: proceeds are what it paid (a win\'s payout, a void\'s refund, a sale\'s price; a loss pays nothing), costs the stake, collateral or average cost'],
    ['Classes', 'by the market\'s base token: BTC, ETH, SOL, HYPE: crypto perps; XAU, XAG: commodity mPerps; SPY, QQQ: equity-ETF mPerps; any other market by its ticker; perps, Predict and USDe lots are never summed together'],
  ];
  /** The 'Gains and losses by class' file (a site report). ctx: as S.classRows, plus fname and warnings. */
  S.classFile = (ctx) => ({ name: ctx.fname('gains-losses-by-class'), sections: [{ title: 'Gains and losses by class', columns: classColumns(ctx.money), rows: S.classRows(ctx) }], warnings: (ctx.warnings || []).slice(), extra: S.classNotes() });

  /**
   * The summary files' parts, in an order that cannot race: the perps part first (it waits for the trade detail, and
   * the holdings' funding not settled at a past instant comes from that detail), then the holdings rows; the Predict
   * part loads alongside from the start. o: {perps, hold, predict}, each a function returning a promise, or null for a
   * section the report does not have. Returns {perps (null without one), hold ([] without one), predict}.
   */
  S.gather = async (o) => {
    const pr = o.predict ? Promise.resolve(o.predict()) : Promise.resolve(null);
    pr.catch(() => {});   // awaited below; a failure there is not unhandled while the perps part loads
    const perps = o.perps ? await o.perps() : null;
    const [hold, predict] = await Promise.all([o.hold ? o.hold() : [], pr]);
    return { perps, hold, predict };
  };

  /**
   * The summary file (a site report): the period, every perps total with the gross funding legs, the holdings at the
   * period's start and end, Meridian Predict's realized PnL under every date basis, its gross split under the report's
   * basis and the results not claimed by the period's end under every basis, the USDe lots; then gains and losses by
   * class, the perps monthly and quarterly tables and the Predict months (the gross split). ctx: {period,
   * money, fname, perps ({led, closed, D, ff (T.funding.figures), openAtEnd (count), openUpnl (now; null when ended),
   * monthly, quarters, closedOverYear}) or null, hold (T.holdings.rows), predict ({prep, mode} | {missing} | {failed} |
   * null), lots ({runs, method, scope, facts (T.lots.facts of the period)} | null), warnings}.
   */
  S.summaryFile = (ctx) => {
    const P = ctx.period, tz = P.tz, money = ctx.money, C = C_OF(money), PR = T.predict;
    const rows = [['Period start', P.startText, ''], ['Period end (the first instant after it)', P.endText, '']];
    const x = ctx.perps;
    if (x) {
      const LT = x.led.totals, LC = LT.C, X = S.perpsFigures(x.D, money), ff = x.ff, F0 = x.D ? x.D.funding : {};
      const wins = x.closed.filter((c) => c.net > 0).length, losses = x.closed.filter((c) => c.net < 0).length;
      rows.push(
        ['Perps net result (realized PnL − trading fees − position fees + funding)', n6(LT.net), n6(LC.net)], ['Perps realized PnL (the exchange\'s ledger, gross)', n6(LT.realized), n6(LC.realized)],
        ...(X ? [['Perps gains (disposals with a positive gross result)', n6(X.gains), n6(X.gainsC)], ['Perps losses (disposals with a negative gross result)', n6(X.losses), n6(X.lossesC)], ['Perps disposals', X.inP.length, '']] : []),
        X && X.showOutside ? ['Perps realized PnL outside the disposals (a check: the ledger less the disposals listed)', n6(X.outside.usd), n6(X.outside.C)] : null,
        ['Perps trading fees', n6(LT.fees), n6(LC.fees)], ['Perps position fees (mPerps, settled)', n6(LT.pfees), n6(LC.pfees)], ['Perps withdrawal & deposit fees', n6(LT.wfee), n6(LC.wfee)],
        ['Perps funding received (gross, per settlement)', n6(ff.received), n6(ff.C.received)], ['Perps funding paid (gross, per settlement)', n6(ff.paid), n6(ff.C.paid)], ['Perps funding (net)', n6(LT.funding), n6(ff.C.received - ff.C.paid)],
        ff.fallback.length ? ['UTC days whose funding is netted per day (settlement detail unavailable)', ff.fallback.length, ''] : null,
        F0.chargedIn ? ['Perps funding charged in the period (net, for information)', n6(F0.chargedIn.net), n6(F0.chargedIn.C.net)] : null,
        F0.chargedIn ? ['Perps funding charged in the period and settled after it (net, for information)', n6(F0.chargedIn.after.net), n6(F0.chargedIn.C.after)] : null,
        ['Perps deposits', n6(LT.deposits), n6(LC.deposits)], ['Perps withdrawals (incl. fees)', n6(LT.withdrawals), n6(LC.withdrawals)], ['Perps volume', n6(LT.volume), n6(LC.volume)],
        ['Opening balance', n6(x.led.opening), ''], ['Closing balance', n6(x.led.closing), ''],
        ['Closed positions', x.closed.length, ''], ['Winning positions (net > 0)', wins, ''], ['Losing positions (net < 0)', losses, ''],
        ...(X ? [['Liquidation disposals', X.nLiq, ''], ['Auto-deleverage disposals', X.nAdl, '']] : []),
        [`Positions held more than one year (calendar dates, ${tz})`, x.closedOverYear, ''],
        ...(X ? [[`Disposals held more than one year (calendar dates, ${tz}): net`, n6(X.ltNet), n6(X.ltNetC)], ['Opening fees on positions open at period end (paid, not yet part of a disposal)', n6(x.D.openFeesEnd), C ? n6(x.D.openFeesEndC) : '']] : []),
        ['Open positions at period end', x.openAtEnd, ''], ['Balance reconciliation difference', n6(x.led.recon.diff), ''],
        (ctx.hold || []).length || x.openUpnl == null ? null : ['Unrealized PnL of open positions (now, after unsettled funding and position fees)', n6(x.openUpnl), ''],
      );
    }
    rows.push(...(ctx.hold || []));
    // Meridian Predict under every basis (B17): never a pointer to another file
    const pr = ctx.predict;
    if (pr && pr.prep) {
      const cmp = PR.compare(pr.prep, P, money), mode = PR.modeOf(pr.mode);
      for (const m of PR.MODES) rows.push([`Predict realized PnL, results dated ${PR.MODE_FILE[m]}` + (m === mode ? ' (this report)' : ''), n6(cmp[m].pnl), C ? n6(cmp[m].pnlC) : '']);
      // the gross split under the report's basis (G11): winnings − lost stakes + ledger gains + ledger losses = its
      // realized PnL; payouts, void refunds and wagered beside them, never netted
      const G = PR.figures(PR.book(pr.prep, mode), null, P, money, tz), at = ', results dated ' + PR.MODE_FILE[mode];
      rows.push(...[['Predict winnings (payout − stake of won predictions)' + at, 'winGain'], ['Predict payouts of won predictions (stake included)' + at, 'payouts'], ['Predict lost stakes (collateral of lost predictions)' + at, 'lostStakes'],
        ['Predict void refunds' + at, 'refunds'], ['Predict ledger gains (sales, matched sets, tokens held to the verdict)' + at, 'ledgerGains'], ['Predict ledger losses' + at, 'ledgerLosses'],
        ['Predict wagered (stakes and maker collateral placed in the period)', 'wagered']].map(([k, f]) => [k, n6(G[f]), C ? n6(G[f + 'C']) : '']));
      // the results not claimed by the period's end, per basis (PR.tail): decided in it under the claim basis (outside
      // its total), booked in it under the others (inside theirs)
      for (const m of PR.MODES) {
        const tail = PR.tail(pr.prep, m, P).items, tl = U.sum(tail, (i) => i.pnl), tlC = U.sum(tail, (i) => money.fx(i.pnl, i.booked));
        rows.push([m === 'claim' ? 'Predict decided in the period, not claimed by its end (PnL at the decision): not in the claim basis\'s realized PnL'
          : `Predict booked in the period on the ${m} basis, not claimed by its end (PnL as booked, converted at its booking date): in the ${m} basis's realized PnL`, n6(tl), C ? n6(tlC) : '']);
      }
    } else if (pr && pr.missing) rows.push(['Predict realized PnL (no Meridian Predict record for this wallet)', '0', C ? '0' : '']);
    else rows.push(['Predict realized PnL', 'not available (Predict data did not load)', '']);
    const L = ctx.lots;
    // the US Form 1040 digital-asset fact line first, as on the card (a fact of the data, not an answer)
    if (L && L.runs && L.facts) rows.push(T.lots.factRow(L.facts).concat(['']));
    if (L && L.runs) for (const u of S.usde(L.runs, P)) {
      const w = 'USDe lots (' + T.lots.READING_LABEL[u.reading].toLowerCase() + ')';
      rows.push([w + ': disposals', u.n, ''], [w + ': proceeds', n6(u.proceedsUsd), C ? n6(u.proceedsC) : ''], [w + ': cost', n6(u.costUsd), C ? n6(u.costC) : ''], [w + ': gains', n6(u.gainsUsd), C ? n6(u.gainsC) : ''], [w + ': losses', n6(u.lossesUsd), C ? n6(u.lossesC) : ''], [w + ': net', n6(u.netUsd), C ? n6(u.netC) : '']);
    } else rows.push(['USDe lots', 'not computed (choose a lot method and a scope in the USDe lots card)', '']);

    const sections = [{ title: 'Summary', columns: [['Metric', (r) => r[0]], ['USD', (r) => r[1]], ...(C ? [[C, (r) => r[2]]] : [])], rows: rows.filter(Boolean) }];
    const cls = S.classRows({ period: P, money, D: x ? x.D : null, predict: pr, lots: L });
    if (cls.length) sections.push({ title: 'Gains and losses by class', columns: classColumns(money), rows: cls });
    if (x) {
      sections.push({ title: 'Perps by month (' + tz + ')', columns: [['Month (' + tz + ')', (m) => m.label + (m.cut ? ' (' + m.cut + ')' : '')], ['Realized PnL USD', (m) => n6(m.realized)], ['Fees USD', (m) => n6(m.fees + (m.pfees || 0))], ['Funding USD', (m) => n6(m.funding)], ['Net USD', (m) => n6(m.net)], ['Deposits USD', (m) => n6(m.deposits)], ['Withdrawals USD (incl. fees)', (m) => n6(m.withdrawals)], ['Volume USD', (m) => n6(m.volume)], ...(C ? [['Net ' + C, (m) => n6(m.C.net)]] : [])], rows: x.monthly });
      sections.push({ title: 'Perps by quarter', columns: [['Quarter', (q) => q.label], ['From (' + tz + ')', (q) => T.tz.dayKey(q.t0, tz)], ['To (' + tz + ')', (q) => T.tz.dayKey(q.t1 - 1, tz)], ['Realized PnL USD', (q) => n6(q.realized)], ['Fees USD', (q) => n6(q.fees + (q.pfees || 0))], ['Funding USD', (q) => n6(q.funding)], ['Net USD', (q) => n6(q.net)], ...(C ? [['Net ' + C, (q) => n6(q.C.net)]] : [])], rows: x.quarters });
    }
    if (pr && pr.prep) {
      const mode = PR.modeOf(pr.mode), F = PR.figures(PR.book(pr.prep, mode), null, P, money, tz);
      // the gross split per month in both currencies (each amount at its own date's rate), so the identity holds in each
      const split = [['Realized PnL', 'pnl'], ['Winnings', 'winGain'], ['Payouts', 'payouts'], ['Lost stakes', 'lostStakes'], ['Ledger gains', 'ledgerGains'], ['Ledger losses', 'ledgerLosses'], ['Wagered', 'wagered']];
      if (F.months.length) sections.push({ title: 'Meridian Predict by month (' + tz + '), results dated ' + PR.MODE_FILE[mode], columns: [['Month', (m) => m.label], ...split.map(([k, f]) => [k + ' USD', (m) => n6(m[f])]), ...(C ? split.map(([k, f]) => [k + ' ' + C, (m) => n6(m[f + 'C'])]) : [])], rows: F.months });
    }
    return { name: ctx.fname('summary'), sections, warnings: (ctx.warnings || []).slice(), extra: S.classNotes() };
  };
})();
