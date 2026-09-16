/* MeridianData — Tax center: period summaries, monthly breakdown, ledgers and CSV exports for one subaccount */
(function () {
  const MD = window.MD; const U = MD.util; const A = MD.api; const AN = MD.analytics; const UI = MD.ui; const C = MD.charts; const h = U.h;
  const isAbort = (e) => e && e.name === 'AbortError';
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const isoTime = (ms) => new Date(U.num(ms)).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const isoDate = (ms) => new Date(U.num(ms)).toISOString().slice(0, 10);
  const n6 = (x) => String(Math.round(U.num(x) * 1e6) / 1e6);
  const PAGE = 25;

  // ---------- CSV ----------
  const cell = (v) => { if (v == null) return ''; const s = String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const toCsv = (cols, rows) => [cols.map((c) => cell(c[0])).join(',')].concat(rows.map((r) => cols.map((c) => cell(c[1](r))).join(','))).join('\r\n');
  const download = (name, text) => {
    const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name }); document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    U.toast('Downloaded ' + name);
  };

  MD.router.pages.tax = {
    async mount(root, route, ctx) {
      MD.setTopbar(h('span.title', 'Tax center'));
      const last = U.storage.get('md.lastAccount', null) || {};
      let addr = String(route.params.address || last.address || '').trim().toLowerCase();
      let subParam = route.params.sub || (addr && addr === String(last.address || '').toLowerCase() ? last.sub : null);

      // ---- account picker ----
      const input = h('input.input', { placeholder: 'Wallet address (0x…) or subaccount ID', value: addr, spellcheck: false });
      const subSel = h('select.input', { style: { display: 'none', width: 'auto' }, onchange: (e) => { MD.router.setParams({ sub: e.target.value }); } });
      const pickErr = h('div.small.neg', { style: { minHeight: '16px', marginTop: '6px' } });
      const picker = h('form.row.wrap', { onsubmit: async (e) => {
        e.preventDefault(); pickErr.textContent = '';
        const v = input.value.trim();
        if (U.isAddress(v)) { MD.router.setParams({ address: v.toLowerCase(), sub: null }); return; }
        if (U.isUuid(v)) { try { const sa = await A.subaccount(v); MD.router.setParams({ address: sa.account, sub: sa.id }); } catch (err) { pickErr.textContent = 'Subaccount not found'; } return; }
        pickErr.textContent = 'Enter a 0x wallet address or a subaccount ID';
      } }, h('div.grow', input), subSel, h('button.btn.primary', { type: 'submit' }, 'Load'));
      const head = h('div.card',
        h('div.row.wrap', { style: { marginBottom: '6px' } }, h('h2', 'Tax center'), UI.chip('records · not advice', ''), h('span.grow'), h('button.btn.sm.ghost', { onclick: () => window.print() }, U.icon('printer'), 'Print / PDF')),
        h('p.muted', { style: { margin: '0 0 12px', maxWidth: '860px' } }, 'Yearly and monthly totals of realised PnL, fees, funding, deposits and withdrawals for a Meridian subaccount, with ledgers you can hand to an accountant or import into a tax tool. All timestamps are UTC and all amounts are USD-equivalent (USDe-settled).'),
        picker, pickErr);
      const body = h('div.stack');
      U.replace(root, h('div.page', h('div.stack', head, body)));

      if (!U.isAddress(addr)) { U.replace(body, h('div.card', h('div.empty', 'Enter a wallet address above, or open any account page and press "Tax" in its header.'))); return; }

      // ---- resolve subaccount ----
      let subs, sa, ref;
      try { [subs, ref] = await Promise.all([A.subaccountsOf(addr, ctx), A.ref(ctx)]); }
      catch (e) { if (isAbort(e)) return; U.replace(body, UI.error(e, () => MD.router.dispatch())); return; }
      if (!subs.length) { U.replace(body, h('div.card', h('div.empty', 'No Meridian subaccounts are registered for this address.'))); return; }
      sa = subs.find((s) => s.id === subParam) || subs[0];
      if (subs.length > 1) { subSel.style.display = ''; U.replace(subSel, subs.map((s) => h('option', { value: s.id, selected: s.id === sa.id }, U.decodeBytes32(s.name)))); }
      const sid = sa.id;

      // ---- period ----
      const nowY = new Date().getUTCFullYear();
      const firstY = new Date(U.num(sa.createdAt) || Date.now()).getUTCFullYear();
      const years = []; for (let y = nowY; y >= Math.min(firstY, nowY); y--) years.push(y);
      let start, end, label, mode;
      if (route.params.from && route.params.to) { mode = 'custom'; start = Date.parse(route.params.from + 'T00:00:00Z'); end = Date.parse(route.params.to + 'T00:00:00Z') + U.DAY; label = route.params.from + ' → ' + route.params.to; }
      else { mode = 'year'; const y = U.num(route.params.year) || nowY; start = Date.UTC(y, 0, 1); end = Math.min(Date.UTC(y + 1, 0, 1), Date.now()); label = 'Tax year ' + y; }
      if (!(end > start)) { U.replace(body, h('div.card', h('div.error', 'Invalid period.'))); return; }
      const yearSeg = UI.seg(years.map((y) => ({ v: y, label: String(y) })), mode === 'year' ? (U.num(route.params.year) || nowY) : null, (y) => MD.router.setParams({ year: y, from: null, to: null }), 'sm');
      const fromIn = h('input.input.sm', { type: 'date', value: route.params.from || isoDate(start), style: { width: 'auto' } });
      const toIn = h('input.input.sm', { type: 'date', value: route.params.to || isoDate(end - 1), style: { width: 'auto' } });
      const controls = h('div.card', h('div.row.wrap',
        h('span.dim.small', 'Period'), yearSeg, h('span.dim.small', 'or custom (UTC)'), fromIn, h('span.dim', '→'), toIn,
        h('button.btn.sm', { onclick: () => { if (fromIn.value && toIn.value && fromIn.value <= toIn.value) MD.router.setParams({ from: fromIn.value, to: toIn.value, year: null }); } }, 'Apply'),
        h('span.grow'), h('span.dim.small', U.shortAddr(addr, 6) + ' · ' + U.decodeBytes32(sa.name) + ' · since ' + U.fmtDate(sa.createdAt))));
      const status = h('div.card', UI.loading('Collecting daily ledgers and position history…'));
      U.replace(body, controls, status);

      // ---- data ----
      let series, positions;
      try {
        const [bal, vol, pos] = await Promise.all([
          A.history('balance', sid, { start: start - U.DAY, end, resolution: 'day1', signal: ctx.signal, ttl: 5 * 60000 }),
          A.history('volume', sid, { start: start - U.DAY, end, resolution: 'day1', signal: ctx.signal, ttl: 5 * 60000 }),
          A.positions(sid, { maxPages: 25, signal: ctx.signal, ttl: 5 * 60000 }),
        ]);
        series = AN.buildSeries({ balance: bal, upnl: [], volume: vol });
        positions = pos;
      } catch (e) { if (isAbort(e)) return; U.replace(status, UI.error(e, () => MD.router.dispatch())); return; }
      const days = series.filter((b) => b.t >= start && b.t < end);
      const sum = (k) => U.sum(days, (b) => b[k]);
      const T = { realized: sum('realizedPnl'), fees: sum('fee'), funding: sum('funding'), deposits: sum('deposit'), withdrawals: sum('withdrawal'), volume: sum('volume') };
      T.net = T.realized - T.fees + T.funding;
      // monthly
      const months = {};
      for (const b of days) { const d = new Date(b.t); const k = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); const m = months[k] || (months[k] = { key: k, label: MON[d.getUTCMonth()] + ' ' + d.getUTCFullYear(), realized: 0, fees: 0, funding: 0, deposits: 0, withdrawals: 0, volume: 0, days: 0 }); m.realized += b.realizedPnl; m.fees += b.fee; m.funding += b.funding; m.deposits += b.deposit; m.withdrawals += b.withdrawal; m.volume += b.volume; m.days++; }
      const monthly = Object.values(months).sort((a, b) => (a.key < b.key ? -1 : 1)).map((m) => Object.assign(m, { net: m.realized - m.fees + m.funding }));
      // closed positions in period (attributed to the close date)
      const closed = positions.filter((p) => U.num(p.size) === 0 && U.num(p.totalDecreaseQuantity) > 0 && U.num(p.updatedAt) >= start && U.num(p.updatedAt) < end)
        .map((p) => { const prod = ref.byId[p.productId]; const incQ = U.num(p.totalIncreaseQuantity), decQ = U.num(p.totalDecreaseQuantity); const fees = U.num(p.feesAccruedUsd), pfees = U.num(p.positionFeeAccruedUsd), fund = -U.num(p.fundingAccruedUsd), gross = U.num(p.realizedPnl); return { p, ticker: prod ? prod.displayTicker : p.productId, tick: prod && prod.tickSize, long: String(p.side) === '0', size: incQ, entry: incQ ? U.num(p.totalIncreaseNotional) / incQ : 0, exit: decQ ? U.num(p.totalDecreaseNotional) / decQ : 0, cost: U.num(p.totalIncreaseNotional), proceeds: U.num(p.totalDecreaseNotional), gross, fees, pfees, funding: fund, net: gross - fees - pfees + fund, hold: U.num(p.updatedAt) - U.num(p.createdAt), liq: !!p.isLiquidated, adl: !!p.wasDeleveraged }; })
        .sort((a, b) => U.num(b.p.updatedAt) - U.num(a.p.updatedAt));
      const liqCount = closed.filter((c) => c.liq).length;
      const openAtEnd = positions.filter((p) => U.num(p.size) !== 0).length;
      // The period totals come from the exchange's settled daily ledger, so they also contain PnL booked on
      // partial closes of positions that are still open. The per-position table lists only fully closed ones.
      const closedGross = U.sum(closed, (c) => c.gross);
      const unlisted = T.realized - closedGross;

      // ---- render ----
      const tiles = h('div.stats',
        UI.stat('Net result', U.fmtUsd(T.net, { sign: true }), 'realised PnL − fees + funding', U.pnlClass(T.net)),
        UI.stat('Realised PnL', U.fmtUsd(T.realized, { sign: true }), 'gross, from position closes', U.pnlClass(T.realized)),
        UI.stat('Trading fees', U.fmtUsd(T.fees), 'taker/maker fees paid'),
        UI.stat('Funding', U.fmtUsd(T.funding, { sign: true }), 'net received (+) / paid (−)', U.pnlClass(T.funding)),
        UI.stat('Deposits', U.fmtUsd(T.deposits)),
        UI.stat('Withdrawals', U.fmtUsd(T.withdrawals), 'incl. withdrawal fees'),
        UI.stat('Closed positions', String(closed.length), liqCount ? liqCount + ' liquidated' : null),
        UI.stat('Volume', U.fmtUsd(T.volume, { compact: true })));
      const mCanvas = h('canvas');
      const monthlyTbl = UI.table({
        cols: [
          { key: 'm', label: 'Month', render: (m) => m.label },
          { key: 'r', label: 'Realised PnL', num: true, render: (m) => U.pnlEl(m.realized) },
          { key: 'f', label: 'Fees', num: true, render: (m) => U.fmtUsd(m.fees) },
          { key: 'fu', label: 'Funding', num: true, render: (m) => U.pnlEl(m.funding) },
          { key: 'n', label: 'Net', num: true, render: (m) => U.pnlEl(m.net) },
          { key: 'd', label: 'Deposits', num: true, render: (m) => U.fmtUsd(m.deposits) },
          { key: 'w', label: 'Withdrawals', num: true, render: (m) => U.fmtUsd(m.withdrawals) },
          { key: 'v', label: 'Volume', num: true, render: (m) => U.fmtUsd(m.volume, { compact: true }) },
        ], rows: monthly, empty: 'No activity in this period',
      });
      // positions ledger with client-side pager
      const ledgerWrap = h('div'); let lpage = 1;
      const renderLedger = () => {
        const slice = closed.slice((lpage - 1) * PAGE, lpage * PAGE);
        U.replace(ledgerWrap, UI.table({
          cols: [
            { key: 'closed', label: 'Closed (UTC)', render: (c) => h('span.dim', isoTime(c.p.updatedAt).slice(0, 16)) },
            { key: 'm', label: 'Market', render: (c) => UI.marketCell(c.ticker) },
            { key: 'side', label: 'Side', render: (c) => U.sideEl(c.long, true) },
            { key: 'size', label: 'Size', num: true, render: (c) => U.fmtQty(c.size) },
            { key: 'entry', label: 'Avg entry', num: true, render: (c) => U.fmtPrice(c.entry, c.tick) },
            { key: 'exit', label: 'Avg exit', num: true, render: (c) => U.fmtPrice(c.exit, c.tick) },
            { key: 'cost', label: 'Cost', num: true, render: (c) => U.fmtUsd(c.cost) },
            { key: 'gross', label: 'Realised PnL', num: true, render: (c) => U.pnlEl(c.gross) },
            { key: 'fees', label: 'Fees', num: true, render: (c) => U.fmtUsd(c.fees + c.pfees) },
            { key: 'fund', label: 'Funding', num: true, render: (c) => U.pnlEl(c.funding) },
            { key: 'net', label: 'Net', num: true, render: (c) => U.pnlEl(c.net) },
            { key: 'hold', label: 'Held', num: true, render: (c) => U.fmtDuration(c.hold) },
            { key: 'flag', label: '', render: (c) => (c.liq ? UI.chip('LIQ', 'red') : c.adl ? UI.chip('ADL', 'amber') : '') },
          ], rows: slice, empty: 'No positions closed in this period',
        }), closed.length > PAGE ? UI.pager({ page: lpage, pageSize: PAGE, total: closed.length, onPage: (p) => { lpage = p; renderLedger(); } }) : null);
      };
      renderLedger();

      // ---- exports ----
      const fname = (kind) => `meridian-${kind}-${U.shortAddr(addr, 4).replace('…', '-')}-${isoDate(start)}_${isoDate(end - 1)}.csv`;
      const busy = (btn, fn) => async () => { btn.disabled = true; const old = btn.innerHTML; btn.innerHTML = ''; U.append(btn, [h('span.spinner'), ' Preparing…']); try { await fn(); } catch (e) { if (!isAbort(e)) U.toast('Export failed: ' + e.message); } btn.disabled = false; btn.innerHTML = old; };
      const exportSummary = () => download(fname('summary'), toCsv([['Metric', (r) => r[0]], ['USD', (r) => r[1]]],
        [['Period start (UTC)', isoDate(start)], ['Period end (UTC)', isoDate(end - 1)], ['Wallet', addr], ['Subaccount', sid], ['Net result', n6(T.net)], ['Realised PnL', n6(T.realized)], ['Trading fees', n6(T.fees)], ['Funding (net)', n6(T.funding)], ['Deposits', n6(T.deposits)], ['Withdrawals', n6(T.withdrawals)], ['Volume', n6(T.volume)], ['Closed positions', closed.length], ['Liquidations', liqCount]])
        + '\r\n\r\n' + toCsv([['Month', (m) => m.label], ['Realised PnL', (m) => n6(m.realized)], ['Fees', (m) => n6(m.fees)], ['Funding', (m) => n6(m.funding)], ['Net', (m) => n6(m.net)], ['Deposits', (m) => n6(m.deposits)], ['Withdrawals', (m) => n6(m.withdrawals)], ['Volume', (m) => n6(m.volume)]], monthly));
      const exportDaily = () => download(fname('daily-ledger'), toCsv([['Date (UTC)', (b) => isoDate(b.t)], ['Realised PnL', (b) => n6(b.realizedPnl)], ['Trading fees', (b) => n6(b.fee)], ['Funding', (b) => n6(b.funding)], ['Net', (b) => n6(b.realizedPnl - b.fee + b.funding)], ['Deposits', (b) => n6(b.deposit)], ['Withdrawals', (b) => n6(b.withdrawal)], ['Volume', (b) => n6(b.volume)], ['Balance end of day', (b) => n6(b.balance)]], days));
      const exportPositions = () => download(fname('closed-positions'), toCsv([['Closed (UTC)', (c) => isoTime(c.p.updatedAt)], ['Opened (UTC)', (c) => isoTime(c.p.createdAt)], ['Market', (c) => c.ticker], ['Side', (c) => (c.long ? 'LONG' : 'SHORT')], ['Size', (c) => n6(c.size)], ['Avg entry', (c) => n6(c.entry)], ['Avg exit', (c) => n6(c.exit)], ['Cost USD', (c) => n6(c.cost)], ['Proceeds USD', (c) => n6(c.proceeds)], ['Realised PnL', (c) => n6(c.gross)], ['Trading fees', (c) => n6(c.fees)], ['Position fees', (c) => n6(c.pfees)], ['Funding', (c) => n6(c.funding)], ['Net', (c) => n6(c.net)], ['Held hours', (c) => (c.hold / U.HOUR).toFixed(2)], ['Liquidated', (c) => (c.liq ? 'yes' : 'no')], ['Deleveraged', (c) => (c.adl ? 'yes' : 'no')], ['Position ID', (c) => c.p.id]], closed));
      const exportFills = async () => {
        const fills = await A.page(A.BASE, '/v1/order/fill', { subaccountId: sid, createdAfter: start, createdBefore: end }, { maxPages: 50, signal: ctx.signal });
        if (fills.truncated) U.toast('More than 10,000 fills; export truncated');
        download(fname('fills'), toCsv([['Time (UTC)', (f) => isoTime(f.createdAt)], ['Market', (f) => (ref.byId[f.productId] ? ref.byId[f.productId].displayTicker : f.productId)], ['Side', (f) => U.sideName(f.side)], ['Order type', (f) => f.type], ['Quantity', (f) => n6(f.filled)], ['Price', (f) => n6(f.price)], ['Notional USD', (f) => n6(U.num(f.filled) * U.num(f.price))], ['Fee USD', (f) => n6(f.feeUsd)], ['Maker', (f) => (f.isMaker ? 'yes' : 'no')], ['Reduce only', (f) => (f.reduceOnly ? 'yes' : 'no')], ['Order ID', (f) => f.orderId], ['Fill ID', (f) => f.id]], fills));
      };
      const exportTransfers = async () => {
        const tr = await A.page(A.BASE, '/v1/token/transfer', { subaccountId: sid, createdAfter: start, createdBefore: end }, { maxPages: 20, signal: ctx.signal });
        download(fname('transfers'), toCsv([['Time (UTC)', (t) => isoTime(t.createdAt)], ['Type', (t) => t.type], ['Token', (t) => t.tokenName], ['To token', (t) => t.toTokenName || ''], ['Amount', (t) => n6(t.amount)], ['Fee', (t) => n6(t.fee)], ['Status', (t) => t.status], ['Initiated tx', (t) => t.initiatedTransactionHash || ''], ['Finalized tx', (t) => t.finalizedTransactionHash || ''], ['Transfer ID', (t) => t.id]], tr));
      };
      const exportKoinly = () => {
        // Koinly "universal" template: Date, Sent Amount, Sent Currency, Received Amount, Received Currency, Fee Amount, Fee Currency, Net Worth Amount, Net Worth Currency, Label, Description, TxHash
        const rows = [];
        const date = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
        for (const b of days) {
          if (Math.abs(b.realizedPnl) >= 0.000001) rows.push({ Date: date(b.t), Sent: b.realizedPnl < 0 ? n6(-b.realizedPnl) : '', Received: b.realizedPnl > 0 ? n6(b.realizedPnl) : '', Label: 'realized gain', Description: 'Meridian perps realised PnL (daily total)' });
          if (b.fee > 0.000001) rows.push({ Date: date(b.t), Sent: n6(b.fee), Received: '', Label: 'margin fee', Description: 'Meridian trading fees (daily total)' });
          if (Math.abs(b.funding) >= 0.000001) rows.push({ Date: date(b.t), Sent: b.funding < 0 ? n6(-b.funding) : '', Received: b.funding > 0 ? n6(b.funding) : '', Label: b.funding > 0 ? 'realized gain' : 'margin fee', Description: 'Meridian funding payments (daily total)' });
          if (b.deposit > 0.000001) rows.push({ Date: date(b.t), Sent: '', Received: n6(b.deposit), Label: '', Description: 'Deposit to Meridian' });
          if (b.withdrawal > 0.000001) rows.push({ Date: date(b.t), Sent: n6(b.withdrawal), Received: '', Label: '', Description: 'Withdrawal from Meridian' });
        }
        download(fname('koinly'), toCsv([['Date', (r) => r.Date], ['Sent Amount', (r) => r.Sent], ['Sent Currency', (r) => (r.Sent ? 'USDe' : '')], ['Received Amount', (r) => r.Received], ['Received Currency', (r) => (r.Received ? 'USDe' : '')], ['Fee Amount', () => ''], ['Fee Currency', () => ''], ['Net Worth Amount', () => ''], ['Net Worth Currency', () => ''], ['Label', (r) => r.Label], ['Description', (r) => r.Description], ['TxHash', () => '']], rows));
      };
      const exBtn = (label, sub, fn, async) => { const b = h('button.btn', {}, U.icon('download'), label); b.addEventListener('click', async ? busy(b, fn) : fn); return h('div.metric', h('div', b), h('div.s', { style: { marginTop: '6px' } }, sub)); };
      const exportsCard = h('div.card', h('h3', { style: { marginBottom: '10px' } }, 'Exports (CSV, UTC)'), h('div.metric-list',
        exBtn('Summary & monthly', 'Totals for the period plus the month-by-month table.', exportSummary),
        exBtn('Daily ledger', 'One row per day: realised PnL, fees, funding, deposits, withdrawals, balance.', exportDaily),
        exBtn('Closed positions', 'Every position closed in the period with entry, exit, PnL, fees, funding.', exportPositions),
        exBtn('Fills (trades)', 'Every fill in the period with price, quantity, fee and maker flag.', exportFills, true),
        exBtn('Deposits & withdrawals', 'Transfers and margin conversions with transaction hashes.', exportTransfers, true),
        exBtn('Koinly universal CSV', 'Daily PnL, fees and funding in Koinly\'s universal template (labels: realized gain / margin fee). Check the mapping in your tool.', exportKoinly)));

      const info = h('div.card', h('h3', { style: { marginBottom: '10px' } }, 'What counts on Meridian'),
        h('div.roadmap',
          h('div.it', h('div.t', 'Realised PnL'), h('div.d', 'Booked whenever a position is reduced or closed, including liquidations and auto-deleveraging. The period totals use the exchange\'s settled daily figures, so they include partial closes of positions you still hold; the table below lists only positions fully closed in the period.')),
          h('div.it', h('div.t', 'Funding'), h('div.d', 'Paid or received every hour while a position is open. Shown net: positive means you received funding.')),
          h('div.it', h('div.t', 'Fees'), h('div.d', 'Taker/maker trading fees, plus position fees on mPerp markets (XAU, XAG, SPY, QQQ) and withdrawal fees.')),
          h('div.it', h('div.t', 'Deposits & withdrawals'), h('div.d', 'Movements of USDe in and out of the exchange. Usually not taxable events themselves, but they reconcile your balance.')),
          h('div.it', h('div.t', 'Margin conversions'), h('div.d', 'Moving margin between the USD pool and an mPerp pool (USD ⇄ XAUUSD etc.) converts 1:1 between USD-equivalent tokens; they are internal and net to zero across the account.')),
          h('div.it', h('div.t', 'Currency'), h('div.d', 'Everything settles in USDe. Amounts are shown at 1 USDe = 1 USD; if your jurisdiction requires it, apply the USDe/fiat rate of each day.'))),
        h('div.footer-note', { style: { textAlign: 'left', paddingBottom: 0 } }, 'MeridianData is not a tax adviser. Rules for perpetual futures differ by country; use these records with a professional or a tax tool.'));

      U.replace(body, controls,
        h('div.card', h('div.row', { style: { marginBottom: '12px' } }, h('h2', label), h('span.grow'), h('span.dim.small', `${days.length} days · ${positions.length}${positions.truncated ? '+' : ''} positions on record · ${openAtEnd} open now`)), tiles),
        h('div.grid.cols-2', UI.card('Monthly breakdown', monthlyTbl), h('div.card', h('h3', { style: { marginBottom: '10px' } }, 'Net result by month'), h('div.chart-box.sm', mCanvas))),
        UI.card('Closed positions', h('div',
          Math.abs(unlisted) >= 0.01 ? h('div.small.muted', { style: { padding: '10px 14px', borderBottom: '1px solid var(--border-2)' } },
            'These are positions fully closed in the period. ', h('b', U.fmtUsd(closedGross, { sign: true })), ' of the period\'s ',
            h('b', U.fmtUsd(T.realized, { sign: true })), ' realised PnL comes from them; the remaining ', h('b', U.fmtUsd(unlisted, { sign: true })),
            ' was booked on partial closes of positions that are still open.') : null,
          ledgerWrap), h('span.dim.small', `${closed.length} in period`)),
        exportsCard, info);
      C.bars(mCanvas, monthly.map((m) => m.label), monthly.map((m) => m.net));
    },
  };
})();
