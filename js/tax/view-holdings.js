/* MeridianDataHub — Tax center: the 'Holdings at period start and end' card. What the wallet held at the period's start
   and at its end (now, for a period still running), from MD.tax.holdings: the perps subaccount per margin pool (cash,
   unrealized PnL, funding charged and not settled, equity), the positions open, Meridian Predict at cost, and the USDe
   lots once they are built; each value in USD and the report currency at the rate of the local day before the instant.
   Its inputs arrive one by one (the archive's unrealized PnL, the trade detail, the Predict record, the lots) and the
   card redraws as each does. Builds DOM only when called. */
(function () {
  const MD = window.MD; const U = MD.util; const UI = MD.ui; const h = U.h;
  const T = MD.tax; const TZ = T.tz;
  const VH = (T.viewHoldings = {});

  /**
   * card: the card's element; ctx: {addr, sid (null: no perps subaccount), ref, period, money, fname, now, led (null
   * without a subaccount), positions, upnl (a promise of T.load.upnl's reads, one per instant; null without a
   * subaccount), predict() (a promise of the Predict card's data, or null), signal, methodology(file, extra) (a report's
   * methodology rows)}.
   * Returns {setDetail(ev, D, err, o) (the perps trade detail, or why it did not load; o {deferred: true}: it waits to
   * be asked for), setLots(L) (the USDe lots card's
   * runs: {runs, names, method, scope, dep}), summaryRows() (a promise of T.holdings.rows once the instants' figures are
   * in, for the summary export), fileParts() (a promise of the Holdings file and its own methodology rows), warnings()}.
   */
  VH.render = function (card, ctx) {
    const HO = T.holdings, EX = T.exports, TUI = T.ui;
    const { period, money } = ctx, tz = period.tz, C = money.rates ? money.ccy : null;
    // deferred: the trade detail waits to be asked for (a big period: view-perps' Load trade detail)
    const st = { reads: null, upnlFailed: !ctx.upnl, ev: null, D: null, detailErr: null, deferred: false, pred: undefined, lots: null };
    const live = (ctx.positions || []).filter((p) => U.num(p.size) !== 0);
    const model = () => HO.build({ period, now: ctx.now, money, ref: ctx.ref, led: ctx.led, positions: ctx.positions || [], reads: st.reads, upnlFailed: st.upnlFailed, D: st.D, live, prep: st.pred ? st.pred.prep : null, lots: st.lots });
    const amber = (...kids) => h('div.small', { style: { marginTop: '8px', color: 'var(--amber)' } }, ...kids);
    const dim = (...kids) => h('div.small.dim', { style: { marginTop: '8px' } }, ...kids);
    const fmtC = (v, o) => money.fmt(v, o);
    const plural = (n, w, ws) => `${U.fmtNum(n, 0)} ${n === 1 ? w : ws || w + 's'}`;
    const isoTime = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

    // an amount at an instant: the report currency at that instant's rate, USD beside it when that is another currency
    const amt = (v, x, o = {}) => {
      if (v == null) return h('span.dim.num-note', o.na || '—');   // words, not an amount: they may wrap on a phone
      if (Math.abs(v) < 0.005) v = 0;   // no "-$0.00"
      const c = HO.fxAt(money, v, x.t);
      // an instant before the first published rate has none: the value stays in USD, said so (never a later rate)
      if (C && c == null) return h('span', { title: T.fx.NO_RATE }, h('span.dim.num-note', 'no rate'), h('div.dim.xs', U.fmtUsd(v, { sign: !!o.sign, dp: 2 })));
      const el = h('span.num', { class: o.sign ? U.pnlClass(v) : '' }, fmtC(c, { sign: !!o.sign }));
      return C ? h('span', { title: U.fmtUsd(v, { sign: !!o.sign, dp: 2 }) + ' at ' + T.fx.rateLine(x.rate, C) }, el, h('div.dim.xs', U.fmtUsd(v, { sign: !!o.sign, dp: 2 }))) : el;
    };
    // a count beside an amount; on a phone it moves under the amount (css: .num-sub), so the column stays narrow
    const sub = (text) => h('span.dim.xs.num-sub', h('span.num-sep', ' · '), text);
    const count = (n, w) => sub(plural(n, w));

    const draw = () => {
      const H = model(), [a, b] = H.instants;
      const pending = (what) => (what === 'upnl' ? (H.upnlState === 'loading' ? 'loading…' : 'could not be loaded') : st.D || st.detailErr ? 'not available' : st.deferred ? 'needs the trade detail' : 'loading…');
      const rows = [];
      if (H.perps) {
        const naUp = (x) => (x.perps.upnl == null ? pending('upnl') : null);
        const naFund = (x) => (x.now ? '—' : st.D ? 'not readable (funding charges)' : st.detailErr || st.deferred ? 'needs the trade detail' : 'loading…');
        rows.push(
          { k: 'Perps cash balance', title: 'MeridianUSD in every margin pool at the instant (the archive\'s level; the balance reconciliation\'s opening and closing balance)', v: (x) => amt(x.perps.cash, x) },
          { k: 'Unrealized PnL (price only)', title: 'The exchange archive\'s figure at the instant: before funding charged and not settled, and before mPerp position fees accrued', v: (x) => amt(x.perps.upnl, x, { sign: true, na: naUp(x) }) },
          { k: 'Funding charged, not settled', title: 'Charged every hour while a position is open and settled at its next fill: received (+) or paid (−) but not yet in the balance at the instant' + (b.now ? '; now, the exchange\'s own figure per open position' : ''), v: (x) => amt(x.perps.funding, x, { sign: true, na: naFund(x) }) },
          { k: 'Position fees accrued, not settled (mPerps)', title: 'Known now only (the exchange\'s figure per open position): the archive keeps no field for them, so a past instant\'s equity is before them', v: (x) => (x.now ? amt(x.perps.posFees, x) : h('span.dim.num-note', 'not recorded')) },
          { k: 'Equity (cash + unrealized, price only)', bold: true, v: (x) => amt(x.perps.equity, x, { na: naUp(x) }) },
          { k: 'Equity, net of unsettled funding', title: 'Cash + unrealized PnL + funding charged and not settled; now also less the position fees accrued (as the account page has it)', v: (x) => amt(x.perps.equityNet, x, { na: x.perps.equity == null ? naUp(x) : naFund(x) }) },
          { k: 'Positions open', v: (x) => h('span.num', String(x.perps.open.length)) });
      }
      if (st.pred === undefined) rows.push({ k: 'Meridian Predict', v: () => h('span.dim.num-note', 'loading…') });
      else if (st.pred) {
        rows.push(
          { k: 'Predict: open predictions, at stake (cost)', title: 'This wallet\'s own stake or collateral in predictions placed and not decided before the instant (one on a pick configuration it traded is in the tokens below)', v: (x) => h('span', amt(x.predict.open.cost, x), count(x.predict.open.n, 'prediction')) },
          { k: 'Predict: position tokens held, at cost', title: 'Tokens on pick configurations this wallet traded and not decided before the instant, at the ledger\'s average cost (its own predictions\' collateral, purchases at their price)', v: (x) => h('span', amt(x.predict.tokens.cost, x), x.predict.tokens.n ? count(x.predict.tokens.n, 'pick configuration') : null) },
          { k: 'Predict: decided, not claimed: payouts', title: 'Wins (and voids\' refunds) decided before the instant (settled on Meridian) and not claimed by it: what claiming pays, stake included', v: (x) => h('span', amt(x.predict.unclaimed.payout + x.predict.unclaimed.refund, x), count(x.predict.unclaimed.won, 'win'), x.predict.unclaimed.void ? count(x.predict.unclaimed.void, 'void') : null) },
          { k: 'Predict: decided, not claimed: losses', title: 'Losses decided before the instant whose pool the counterparty had not claimed by it: counted; their collateral left the wallet when they were placed', v: (x) => h('span.num', String(x.predict.unclaimed.lost)) });
        if (H.instants.some((x) => x.predict.unclaimed.held || x.predict.unclaimed.heldLost)) rows.push({ k: 'Predict: tokens held to a decided verdict, not redeemed', title: 'Position tokens held when their picks were decided, not redeemed by the instant: what they pay', v: (x) => h('span', amt(x.predict.unclaimed.heldValue, x), x.predict.unclaimed.held ? count(x.predict.unclaimed.held, 'pick configuration') : null, x.predict.unclaimed.heldLost ? sub(`${x.predict.unclaimed.heldLost} worthless`) : null) });
      }
      if (st.lots && st.lots.runs) {
        const L = (x, r) => x.lots && x.lots[r];
        rows.push(
          { k: 'USDe lots held: units', title: 'USDe and MeridianUSD units the lots hold at the instant (Meridian activity and the opening lots entered)', v: (x) => (L(x, 'transfer') ? h('span.num', U.fmtNum(L(x, 'transfer').units, 2)) : h('span.dim', '—')) },
          ...['transfer', 'disposal'].map((r) => ({ k: 'USDe lots held: cost, ' + T.lots.READING_LABEL[r].toLowerCase(), title: 'Their cost under ' + T.lots.METHOD_LABEL[st.lots.method] + ', ' + T.lots.SCOPE_LABEL[st.lots.scope].toLowerCase() + ', ' + T.lots.READING_TEXT[r], v: (x) => (L(x, r) ? h('span.num', fmtC(C ? L(x, r).c : L(x, r).usd)) : h('span.dim', '—')) })));
      }
      // a heading that already says Now does not say it twice
      const head = (x) => h('div', x.label, x.now && x.label === 'Now' ? null : h('div.dim.xs', x.now ? 'now' : TZ.fmt(x.t, tz, 'datetime') + (tz === 'UTC' ? ' UTC' : '')), x.rate ? h('div.dim.xs', T.fx.rateLine(x.rate, C)) : null);
      const main = UI.table({ cols: [
        { key: 'k', label: 'Item', render: (r) => h('span', { class: r.bold ? 'bold' : '', title: r.title || null }, r.k) },
        { key: 'a', label: head(a), num: true, render: (r) => r.v(a) },
        { key: 'b', label: head(b), num: true, render: (r) => r.v(b) },
      ], rows, empty: 'Nothing to show' });

      // the change in equity, transfers taken out, and what it is made of
      const ch = H.change;
      // in another currency an equity at an instant before the first published rate has none: said, not a figure
      const chAmt = (u, c) => (C && c == null ? h('span.dim', T.fx.NO_RATE) : h('b', { class: 'num ' + U.pnlClass(u) }, fmtC(C ? c : u, { sign: true })));
      const changeEl = ch ? h('div.small', { style: { marginTop: '10px' } }, 'Change in perps equity over the period, deposits and withdrawals taken out: ',
        ch.price == null ? h('span.dim', 'price only ' + pending('upnl')) : h('span', 'price only ', chAmt(ch.price, ch.priceC)),
        ' · ', ch.net == null ? h('span.dim', 'net of unsettled funding ' + (ch.price == null ? pending('upnl') : 'not available')) : h('span', 'net of unsettled funding ', chAmt(ch.net, ch.netC)),
        ch.price == null ? null : h('span.dim', ` · in USD ${U.fmtUsd(ch.price, { sign: true, dp: 2 })} = net result ${U.fmtUsd(ch.result, { sign: true, dp: 2 })} + change in unrealized PnL ${U.fmtUsd(ch.dUpnl, { sign: true, dp: 2 })}` + (Math.abs(ch.unexplained) >= 0.005 ? ` + balance change without a ledger entry ${U.fmtUsd(ch.unexplained, { sign: true, dp: 2 })}` : '') + (C ? `; in ${C} each equity at its instant's rate, deposits and withdrawals at their own dates` : ''))) : null;

      // per margin pool, both instants
      let poolTbl = null;
      if (H.perps) {
        const ids = []; for (const x of H.instants) for (const p of x.perps.pools) if (!ids.includes(p.tokenId)) ids.push(p.tokenId);
        const poolOf = (x, id) => x.perps.pools.find((p) => p.tokenId === id) || null;
        const name = (id) => { for (const x of H.instants) { const p = poolOf(x, id); if (p) return p.name + (p.mPerp ? ' (mPerp)' : ''); } return id; };
        const cell = (x, id, k, o) => { const p = poolOf(x, id); return p ? amt(p[k], x, o) : h('span.dim', '—'); };
        if (ids.length > 1) poolTbl = h('div', { style: { marginTop: '12px' } }, h('div.small.dim', { style: { marginBottom: '4px' } }, 'Per margin pool'), h('div.card.tight.wrap-cells', UI.table({ cols: [
          { key: 'p', label: 'Pool', render: (id) => name(id) },
          { key: 'c0', label: 'Cash · start', num: true, render: (id) => cell(a, id, 'cash') },
          { key: 'u0', label: 'Unrealized · start', num: true, render: (id) => cell(a, id, 'upnl', { sign: true }) },
          { key: 'e0', label: 'Equity · start', num: true, render: (id) => cell(a, id, 'equity') },
          { key: 'c1', label: 'Cash · ' + (b.now ? 'now' : 'end'), num: true, render: (id) => cell(b, id, 'cash') },
          { key: 'u1', label: 'Unrealized · ' + (b.now ? 'now' : 'end'), num: true, render: (id) => cell(b, id, 'upnl', { sign: true }) },
          { key: 'e1', label: 'Equity · ' + (b.now ? 'now' : 'end'), num: true, render: (id) => cell(b, id, 'equity') },
        ], rows: ids })));
      }

      // the positions open at each instant
      let posTbl = null;
      if (H.perps) {
        const list = []; for (const x of H.instants) for (const r of x.perps.open) list.push({ x, r });
        const tick = (r) => ((ctx.ref.byId || {})[r.productId] || {}).tickSize;
        posTbl = h('div', { style: { marginTop: '12px' } }, h('div.small.dim', { style: { marginBottom: '4px' } }, 'Positions open at each instant'), h('div.card.tight.wrap-cells', UI.table({ cols: [
          { key: 'i', label: 'Instant', render: (o) => o.x.label },
          { key: 'm', label: 'Market', render: (o) => UI.marketCell(o.r.ticker, o.r.cls) },
          { key: 's', label: 'Side', render: (o) => U.sideEl(o.r.long, true) },
          { key: 'q', label: 'Size', num: true, render: (o) => (o.r.size == null ? h('span.dim', { title: 'changed since the instant: its size then comes from the trade detail' }, '—') : U.fmtQty(o.r.size)) },
          { key: 'e', label: 'Avg entry', num: true, title: 'the position\'s average entry price at the instant (the exchange\'s method)', render: (o) => (o.r.avgEntry == null ? h('span.dim', '—') : U.fmtPrice(o.r.avgEntry, tick(o.r))) },
          { key: 'o', label: TUI.tzLabel('Opened', tz), render: (o) => h('span.dim', { title: isoTime(o.r.opened) }, TZ.fmt(o.r.opened, tz, 'iso').slice(0, 16)) },
          { key: 'f', label: 'Funding not settled', num: true, title: 'funding charged and not settled at the instant (+ received); now, the exchange\'s figure', render: (o) => amt(o.r.funding, o.x, { sign: true, na: '—' }) },
          { key: 'u', label: 'Unrealized now', num: true, title: 'the exchange\'s figure now, price only (a past instant has it per pool, above)', render: (o) => amt(o.r.upnl, o.x, { sign: true, na: '—' }) },
        ], rows: list, empty: 'No position open at either instant' })));
      }

      // what is missing or how a value was read, said plainly
      const notes = [];
      const failedAt = upnlFailedAt();
      if (H.perps && (H.upnlState === 'failed' || failedAt.length)) notes.push(amber('The archive\'s unrealized PnL ' + (failedAt.length ? 'at ' + failedAt.join(' and ') + ' ' : '') + 'could not be read' + (st.upnlErr ? ' (' + st.upnlErr + ')' : '') + ': equity there is not shown. Cash, positions and Predict are.'));
      if (H.perps && st.detailErr) notes.push(amber('The trade detail did not load: positions changed since an instant have no size here, and the funding charged and not settled at a past instant is not available.'));
      else if (H.perps && st.deferred) notes.push(dim('The trade detail is not loaded yet (Load trade detail, in the perps card above): until it is, positions changed since an instant have no size here, and the funding charged and not settled at a past instant is not shown.'));
      if (H.perps && st.D && !st.D.funding.S) notes.push(amber('The hourly funding charges could not be read: the funding not settled at a past instant is not available.'));
      if (st.pred === null) notes.push(dim('No Meridian Predict record for this wallet: nothing held there.'));
      if (!st.lots) notes.push(dim('The USDe lots held at each instant appear here once the USDe lots card is built (it asks for a lot method and a scope).'));
      // where the archive's figures are not at the instant itself: the end of the hour a boundary cuts, or the edge of a
      // UTC day the ledger kept whole
      const asOf = H.perps && st.reads ? H.instants.map((x, i) => (st.reads[i] && !x.now && st.reads[i].spec.at !== x.t ? { x, at: st.reads[i].spec.at } : null)).filter(Boolean) : [];
      if (asOf.some((o) => o.at - o.x.t < 3600000 && o.x.t % 3600000 !== 0)) notes.push(dim('An instant inside an hour (a zone that is not a whole number of hours from UTC) reads the archive at the end of that hour, as the ledger counts that hour in the period it starts in.'));
      for (const o of asOf.filter((y) => !(y.at - y.x.t < 3600000 && y.x.t % 3600000 !== 0))) notes.push(amber(`The exchange's hourly ledger of the UTC day the ${o.x.label.toLowerCase()} falls in could not be read, so the perps values there are as of ${isoTime(o.at)}, the edge of that day on the side the balance reconciliation counts it.`));

      const lotsInfo = st.lots ? { method: st.lots.method, scope: st.lots.scope } : null;
      // the file reads the inputs as they are when it is saved; the report's methodology first, with the holdings' own
      // rows in it (T.holdings.describe)
      const save = () => { const x = fileParts(); TUI.save(x.file, ctx.methodology ? ctx.methodology(x.file, x.extra) : x.extra); };
      const d = EX.get('holdings'), dctx = { H, money, lotsInfo };
      U.replace(card,
        h('div.row.wrap', { style: { marginBottom: '6px' } }, h('h2', 'Holdings at period start and end'), UI.chip('values at an instant', ''), h('span.grow')),
        h('p.muted.small', { style: { margin: '0 0 10px', maxWidth: '900px' } }, `What the wallet held at the period's start and ${b.now ? 'now (the period is still running)' : 'at its end'}, for rules that ask for values at a date. ` + (C ? `Each value in ${C} at the rate of the local day before its instant (${tz}), USD below it. ` : '') + (H.perps ? 'Unrealized PnL is the exchange archive\'s figure, price only; ' : '') + 'Meridian Predict is at cost (what an open prediction is worth is not known here). None of these values is in ' + (H.perps ? 'Net result or ' : '') + 'any total of this report.'),
        h('div.card.tight.wrap-cells', main), changeEl, poolTbl, posTbl, ...notes,
        h('div.metric-list.no-print', { style: { marginTop: '14px' } }, TUI.exBtn(EX.text(d.label, dctx), EX.text(d.sub, dctx), save, true)),
        // values at a date are asked for by some rules and not others: the card says what it is, never which applies
        h('div.footer-note.print-keep', { style: { textAlign: 'left', paddingBottom: 0 } }, T.DISCLAIMER));
    };
    // the Holdings file and its own methodology rows, from the inputs as they are now
    const fileParts = () => {
      const c = { H: model(), period, tz, money, fname: ctx.fname, lotsInfo: st.lots ? { method: st.lots.method, scope: st.lots.scope } : null, warnings: warnings() };
      return { file: EX.build('holdings', c), extra: HO.describe(Object.assign({ addr: ctx.addr, sid: ctx.sid, pw: st.pred && st.pred.pw ? st.pred.pw.address : null, now: Date.now() }, c)) };
    };
    // the instants whose unrealized-PnL read failed (by name), when the others were read
    const upnlFailedAt = () => (st.reads ? HO.instants(period, ctx.now).filter((x, i) => st.reads[i] && st.reads[i].error).map((x) => x.label.toLowerCase()) : []);
    const warnings = () => {
      const w = [];
      if (ctx.led && st.upnlFailed) w.push('the archive\'s unrealized PnL could not be read: no equity at the instants');
      else if (ctx.led && !st.reads) w.push('the archive\'s unrealized PnL had not loaded');
      else if (ctx.led && upnlFailedAt().length) w.push('the archive\'s unrealized PnL at ' + upnlFailedAt().join(' and ') + ' could not be read: no equity there');
      if (ctx.led && st.detailErr) w.push('the trade detail did not load: positions changed since an instant have no size, and funding not settled at a past instant is missing');
      else if (ctx.led && st.D) w.push(...EX.eventWarnings({ ev: st.ev, D: st.D }));
      // still loading, or waiting to be asked for: a file saved now lacks what it brings, and says so
      else if (ctx.led) w.push('the trade detail had not loaded: positions changed since an instant have no size, and funding not settled at a past instant is missing');
      if (st.pred && st.pred.prep) { const cov = T.predict.coverageNote(st.pred.prep); if (cov && cov.blocking) w.push(cov.text); }
      return w;
    };

    // ---- the inputs, each redrawing the card when it arrives ----
    const upnlP = ctx.upnl ? ctx.upnl.then((r) => { st.reads = r; if (r.some((x) => x.error)) st.upnlErr = r.find((x) => x.error).error.message; draw(); }, (e) => { st.upnlFailed = true; st.upnlErr = T.isAbort(e) ? 'cancelled' : e.message; draw(); }) : Promise.resolve();
    const predP = (ctx.predict ? Promise.resolve(ctx.predict()) : Promise.resolve(null)).then((D) => { st.pred = D && D.prep ? D : null; draw(); }, () => { st.pred = null; draw(); });
    draw();
    return {
      setDetail(ev, D, err, o) { st.ev = ev; st.D = D; st.detailErr = err ? (T.isAbort(err) ? 'cancelled' : err.message) : null; st.deferred = !!(o && o.deferred); draw(); },
      setLots(L) { st.lots = L; draw(); },
      summaryRows: async () => { await Promise.all([upnlP, predP]); return HO.rows(model(), money); },
      /** the Holdings file built ({file, extra}: its own methodology rows) once the instants' figures are in */
      fileParts: async () => { await Promise.all([upnlP, predP]); return fileParts(); },
      /** what the report's methodology says is missing from the holdings */
      warnings: () => warnings(),
    };
  };
})();
