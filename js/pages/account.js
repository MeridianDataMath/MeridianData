/* MeridianData — Account page: Overview / Live / Performance / Rewards */
(function () {
  const MD = window.MD; const U = MD.util; const A = MD.api; const AN = MD.analytics; const UI = MD.ui; const C = MD.charts; const h = U.h;

  const TABS = [['overview', 'Overview'], ['live', 'Live'], ['performance', 'Performance'], ['rewards', 'Rewards']];
  const RANGES = [{ v: '24h', label: '24h' }, { v: '7d', label: '7d' }, { v: '30d', label: '30d' }, { v: 'all', label: 'All time' }];
  const METRICS = [{ v: 'pnl', label: 'PnL' }, { v: 'volume', label: 'Volume' }, { v: 'balance', label: 'Balance' }, { v: 'equity', label: 'Equity' }, { v: 'funding', label: 'Funding' }, { v: 'fees', label: 'Fees' }];

  const child = (ctx) => { const ac = new AbortController(); const c = { signal: ac.signal, cleanup: [], onCleanup(f) { this.cleanup.push(f); }, abort() { ac.abort(); this.cleanup.forEach((f) => { try { f(); } catch (_) {} }); this.cleanup = []; } }; ctx.onCleanup(() => c.abort()); ctx.signal.addEventListener('abort', () => ac.abort()); return c; };
  const isAbort = (e) => e && e.name === 'AbortError';
  const tickerOf = (ref, pid) => (ref.byId[pid] ? ref.byId[pid].displayTicker : U.shortAddr(pid, 4));
  const tickOf = (ref, pid) => (ref.byId[pid] ? ref.byId[pid].tickSize : null);

  /** table with cursor-based server paging */
  function cursorTable({ fetchPage, cols, empty, pageSize = 25, onRow }) {
    const wrap = h('div');
    let page = 1, cursors = [null], hasNext = false, rows = [], loading = false;
    const render = () => U.replace(wrap, UI.table({ cols, rows, empty, onRow }), UI.cursorPager({ page, hasNext, count: rows.length, loading, onPrev: () => go(page - 1), onNext: () => go(page + 1) }));
    const go = async (p) => {
      if (p < 1) return; loading = true; render();
      try {
        const r = await fetchPage(cursors[p - 1], pageSize);
        rows = r.rows; hasNext = r.hasNext; page = p;
        if (r.hasNext && cursors.length === p) cursors.push(r.nextCursor);
      } catch (e) { if (isAbort(e)) return; rows = []; hasNext = false; U.replace(wrap, UI.error(e, () => go(p))); loading = false; return; }
      loading = false; render();
    };
    go(1);
    wrap.reload = () => { cursors = [null]; go(1); };
    return wrap;
  }

  /** liquidation price cell: '—' when the pool equity makes a price-driven liquidation impossible */
  const liqCell = (r) => {
    if (r.liqPrice == null) return '—';
    if (r.liqPrice <= 0 || (!r.long && r.distPct > 500)) return h('span.dim', { title: 'Pool equity far exceeds the maintenance margin' }, 'none');
    const cls = r.distPct < 5 ? 'neg' : r.distPct < 15 ? '' : 'dim';
    return h('span', U.fmtPrice(r.liqPrice, r.prod.tickSize), h('span.xs', { class: cls, style: r.distPct >= 5 && r.distPct < 15 ? { color: 'var(--amber)' } : null }, ' ' + (r.distPct > 500 ? '>500%' : U.fmtPct(r.distPct, { dp: 1 }))));
  };
  const ratioTxt = (x) => (x == null ? null : x > 999 ? '>999×' : U.fmtNum(x, 1) + '×');
  const flags = (o) => {
    const f = []; const m = AN.orderMeta(o);
    if (m.stop) f.push(m.kind + ' @' + U.fmtPrice(o.stopPrice) + (m.trigger === 'last' ? ' (last)' : ''));
    if (o.reduceOnly) f.push('RO'); if (o.postOnly) f.push('PO'); if (o.close) f.push('CLOSE');
    if (m.oco) f.push('OCO'); else if (m.oto) f.push('OTO');
    if (o.timeInForce && o.timeInForce !== 'GTD') f.push(o.timeInForce);
    return f.join(' · ');
  };
  /** TP / SL cell for a position row: nearest level, distance from mark, PnL if it fires, and how it was placed */
  const exitCell = (r, list) => {
    if (!list || !list.length) return h('span.dim', '—');
    const e = list[0];
    const tags = [];
    if (e.kind === 'limit') tags.push('limit');
    if (e.oco) tags.push('OCO');
    if (e.kind === 'stop' && e.trigger === 'last') tags.push('last px');
    if (e.qty != null) tags.push(U.fmtQty(e.qty));
    return h('div', { style: { lineHeight: '1.25' }, title: (e.kind === 'stop' ? 'Stop order on the exchange' : 'Reduce-only limit order') + ' · PnL at this level before fees' },
      h('div', U.fmtPrice(e.price, r.prod.tickSize), tags.length ? h('span.xs.dim', ' ' + tags.join(' · ')) : null),
      h('div.xs', e.distPct == null ? null : h('span.dim', U.fmtPct(e.distPct, { sign: true, dp: 1 }) + ' · '), h('span', { class: U.pnlClass(e.pnl) }, U.fmtUsd(e.pnl, { sign: true })), list.length > 1 ? h('span.dim', ' · +' + (list.length - 1) + ' more') : null));
  };
  const orderCols = (ref) => [
    { key: 'm', label: 'Symbol', render: (r) => UI.marketCell(tickerOf(ref, r.productId)) },
    { key: 'side', label: 'Side', render: (r) => U.sideEl(r.side) },
    { key: 'type', label: 'Type', render: (r) => { const m = AN.orderMeta(r); return m.stop ? h('span', m.kind, h('span.dim.xs', ' ' + r.type.toLowerCase())) : r.type; } },
    { key: 'price', label: 'Price', num: true, render: (r) => { const m = AN.orderMeta(r); if (m.stop) return h('span', U.fmtPrice(r.stopPrice, tickOf(ref, r.productId)), h('span.dim.xs', ' trigger')); return U.num(r.price) ? U.fmtPrice(r.price, tickOf(ref, r.productId)) : 'MKT'; } },
    { key: 'qty', label: 'Quantity', num: true, render: (r) => (AN.orderMeta(r).whole ? h('span.dim', 'all') : U.fmtQty(r.quantity)) },
    { key: 'filled', label: 'Filled', num: true, render: (r) => U.fmtQty(r.filled) },
    { key: 'value', label: 'Value', num: true, render: (r) => { const v = U.num(r.price) * U.num(r.availableQuantity); return v > 0 ? U.fmtUsd(v) : h('span.dim', '—'); } },
    { key: 'status', label: 'Status', render: (r) => UI.chip(r.status, r.status === 'NEW' ? 'accent' : r.status === 'PENDING' ? 'amber' : r.status === 'FILLED_PARTIAL' ? 'blue' : '') },
    { key: 'flags', label: 'Flags', render: (r) => h('span.dim.small', flags(r)) },
    { key: 'created', label: 'Created', render: (r) => h('span.dim', U.fmtDateTimeS(r.createdAt)) },
  ];

  MD.router.pages.account = {
    async mount(root, route, ctx) {
      const page = h('div.page');
      root.appendChild(page);
      MD.setTopbar(h('span.title', 'Account'));
      let addr = (route.params.address || '').trim().toLowerCase();
      const subParam = route.params.sub;
      let subs = [];
      try {
        if (!addr && subParam && U.isUuid(subParam)) { const sa = await A.subaccount(subParam, ctx); addr = sa.account; }
        if (!U.isAddress(addr)) { U.replace(page, h('div.card', h('div.error', 'Invalid address. Enter a 0x wallet address (40 hex characters) or a subaccount ID.'))); return; }
        subs = await A.subaccountsOf(addr, ctx);
      } catch (e) { if (isAbort(e)) return; U.replace(page, UI.error(e, () => MD.router.dispatch())); return; }
      if (!subs.length) {
        U.replace(page, h('div.card', h('div.empty', h('div', { style: { marginBottom: '8px' } }, 'No Meridian subaccounts are registered for ', h('span.addr', addr), '.'), h('div.small', 'Accounts appear here once the wallet has deposited on ', h('a', { href: A.APP_URL, target: '_blank', rel: 'noopener' }, 'app.meridian.xyz'), '. ', h('a', { href: U.explorerAddr(addr), target: '_blank', rel: 'noopener' }, 'View on explorer'))))); return;
      }
      const sa = subs.find((s) => s.id === subParam) || subs[0];
      const subName = U.decodeBytes32(sa.name);
      const fav = { address: addr, subaccountId: sa.id, name: subName };
      let ref;
      try { ref = await A.ref(ctx); } catch (e) { if (isAbort(e)) return; U.replace(page, UI.error(e, () => MD.router.dispatch())); return; }

      // ---- topbar header ----
      const subSel = h('select', { onchange: (e) => MD.router.navigate('/account', { address: addr, sub: e.target.value, tab: route.params.tab || 'overview' }) }, subs.map((s) => h('option', { value: s.id, selected: s.id === sa.id }, U.decodeBytes32(s.name))));
      MD.setTopbar(h('div.acct-head',
        h('span.addr-box', h('span', { title: addr }, U.shortAddr(addr, 6)), U.copyBtn(addr)),
        UI.starBtn(fav, 'btn icon'),
        h('span.subsel', 'sub:', subSel),
        h('a.btn.sm.ghost', { href: '#/tax?address=' + encodeURIComponent(addr) + '&sub=' + encodeURIComponent(sa.id), title: 'Tax center for this account' }, U.icon('receipt'), 'Tax'),
        h('a.btn.sm.ghost.explorer', { href: U.explorerAddr(addr), target: '_blank', rel: 'noopener', title: 'Robinhood Chain explorer' }, U.icon('external'), 'Explorer'),
        h('span.dim.small.nowrap.since', 'since ' + U.fmtDate(sa.createdAt))));

      // ---- tabs ----
      let tab = TABS.some((t) => t[0] === route.params.tab) ? route.params.tab : 'overview';
      const tabsEl = h('div.tabs', TABS.map(([v, label]) => h('button', { class: v === tab ? 'on' : '', dataset: { v }, onclick: () => show(v) }, label)));
      const tabBody = h('div', { style: { marginTop: '16px' } });
      U.replace(page, h('div.stack', tabsEl, tabBody));
      let tabCtx = null;
      const state = { addr, sa, subs, ref, fav, subName };
      function show(v) {
        tab = v; MD.router.setParams({ tab: v }, { silent: true });
        U.$$('button', tabsEl).forEach((b) => b.classList.toggle('on', b.dataset.v === v));
        if (tabCtx) tabCtx.abort();
        tabCtx = child(ctx);
        U.clear(tabBody);
        const fn = { overview: mountOverview, live: mountLive, performance: mountPerformance, rewards: mountRewards }[v];
        fn(tabBody, state, tabCtx).catch((e) => { if (!isAbort(e)) { console.error(e); U.replace(tabBody, UI.error(e, () => show(v))); } });
      }
      show(tab);
    },
  };

  // =====================================================================
  // Overview
  // =====================================================================
  async function mountOverview(el, st, cx) {
    const { sa, ref } = st;
    const sid = sa.id;
    let range = MD.router.parse().params.range || 'all';
    let metric = MD.router.parse().params.metric || 'pnl';
    let cumulative = U.storage.get('md.chart.cum', true);

    const stateCard = h('div.card.state-card', UI.loading('Loading account state…'));
    const chartCanvas = h('canvas');
    const chartBox = h('div.chart-box', h('div.watermark', 'MeridianData'), chartCanvas);
    const tiles = h('div.stats');
    const metricSeg = UI.seg(METRICS, metric, (v) => { metric = v; MD.router.setParams({ metric: v }, { silent: true }); drawChart(); }, 'sm');
    const cumBox = UI.checkbox('Cumulative', cumulative, (v) => { cumulative = v; U.storage.set('md.chart.cum', v); drawChart(); });
    const rangeSeg = UI.seg(RANGES, range, (v) => { range = v; MD.router.setParams({ range: v }, { silent: true }); loadRange(); }, 'sm');
    const chartCard = h('div.card', h('div.row.wrap', { style: { marginBottom: '12px' } }, metricSeg, cumBox, h('span.grow'), rangeSeg), chartBox, h('div', { style: { marginTop: '14px' } }, tiles));
    const tablesCard = h('div.card.tight');
    // auto-refresh of balances / positions / orders (like the reference site's "30s" control)
    const REFRESH = [{ v: 0, label: 'Off' }, { v: 15, label: '15s' }, { v: 30, label: '30s' }, { v: 60, label: '60s' }];
    let refreshSec = U.num(U.storage.get('md.refresh', 30)); let refreshT = null; let lastLoad = 0;
    const updLbl = h('span.dim.small');
    const refreshSeg = UI.seg(REFRESH, refreshSec, (v) => { refreshSec = v; U.storage.set('md.refresh', v); schedule(); }, 'sm');
    const refreshRow = h('div.row', { style: { justifyContent: 'flex-end' } }, updLbl, h('span.dim.small', 'Auto-refresh'), refreshSeg);
    U.replace(el, h('div.stack', refreshRow, h('div.overview', stateCard, chartCard), tablesCard));
    function schedule() {
      clearTimeout(refreshT);
      if (!refreshSec) return;
      refreshT = setTimeout(async () => { if (cx.signal.aborted) return; try { await loadBase(true); } catch (e) { if (isAbort(e)) return; } schedule(); }, refreshSec * 1000);
    }
    const updTick = setInterval(() => { if (lastLoad) updLbl.textContent = 'updated ' + U.fmtAgo(lastLoad); }, 5000);
    cx.onCleanup(() => { clearTimeout(refreshT); clearInterval(updTick); });

    // ---- state + tables (base data) ----
    let base = null;
    async function loadBase(refresh) {
      const [balances, positions, working, pending, vol] = await Promise.all([
        A.balances(sid, cx), A.openPositions(sid, cx), A.openOrders(sid, cx).catch(() => []), A.pendingOrders(sid, cx).catch(() => []), A.totalVolume(sid, { signal: cx.signal, ttl: 60000 }).catch(() => null),
      ]);
      const orders = working.concat(pending);
      const pids = Array.from(new Set(positions.map((p) => p.productId)));
      const prices = pids.length ? await A.marketPrices(pids, { signal: cx.signal, ttl: 3000 }) : {};
      const acct = AN.accountState({ balances, positions, ref, prices });
      AN.attachStops(acct.positions, orders);
      base = { balances, positions, orders, working, pending, acct, vol, prices };
      lastLoad = Date.now(); updLbl.textContent = 'updated just now';
      renderState();
      if (refresh) { if (tt === 'positions' || tt === 'orders') renderTT(); } else renderTables();
      drawChart();
    }
    function renderState() {
      const a = base.acct;
      const kv = (k, v, cls) => [h('span.k', k), h('span.v', { class: cls || '' }, v)];
      const pools = a.pools.map((p) => h('div.pool',
        h('div.name', h('span', p.name === 'USD' ? 'USD (cross)' : p.name + ' (isolated)'), h('span.num', U.fmtUsd(p.equity))),
        h('div.bar', h('i', { class: p.ratio != null && p.ratio < 1.5 ? 'bad' : p.ratio != null && p.ratio < 3 ? 'warn' : '', style: { width: U.clamp(p.balance > 0 ? (p.used / p.balance) * 100 : 0, 0, 100) + '%' } })),
        h('div.row.xs.dim', { style: { marginTop: '4px', justifyContent: 'space-between' } }, h('span', 'used ' + U.fmtUsd(p.used, { compact: true }) + ' / ' + U.fmtUsd(p.balance, { compact: true })), h('span', p.ratio != null ? 'margin ' + ratioTxt(p.ratio) + ' maint.' : 'no positions'))));
      U.replace(stateCard,
        h('div.k.dim.small', 'Equity'),
        h('div.big', { class: '' }, U.fmtUsd(a.equity)),
        h('div.small', { style: { marginBottom: '12px' } }, h('span.dim', 'Unrealized '), U.pnlEl(a.upnl)),
        h('div.kv',
          ...kv('Balance', U.fmtUsd(a.balance)),
          ...kv('Available', U.fmtUsd(a.available)),
          ...kv('Margin used', U.fmtUsd(a.used)),
          ...kv('Notional', U.fmtUsd(a.notional)),
          ...kv('Leverage', a.leverage != null ? U.fmtNum(a.leverage, 2) + '×' : '—'),
          ...kv('Open positions', String(a.positions.length)),
          ...kv('Open orders', String(base.working.length)),
          ...kv('Stop orders (TP/SL)', String(base.pending.length)),
          h('span.sep'),
          ...kv('Volume (all time)', base.vol == null ? '—' : U.fmtUsd(base.vol)),
          ...kv('Subaccount', st.subName)),
        pools.length ? h('div', { style: { marginTop: '6px' } }, pools) : h('div.empty.small', 'No balances'));
    }

    // ---- tables ----
    const TT = [['positions', 'Open positions'], ['orders', 'Open orders'], ['fills', 'Fills history'], ['history', 'Positions history'], ['transfers', 'Deposits & Withdrawals']];
    let tt = 'positions';
    const ttBody = h('div');
    function renderTables() {
      const tabs = h('div.tabs', { style: { padding: '0 8px' } }, TT.map(([v, l]) => h('button', { class: v === tt ? 'on' : '', dataset: { v }, onclick: () => { tt = v; U.$$('button', tabs).forEach((b) => b.classList.toggle('on', b.dataset.v === v)); renderTT(); } }, l)));
      U.replace(tablesCard, tabs, ttBody);
      renderTT();
    }
    function renderTT() {
      const a = base.acct;
      if (tt === 'positions') {
        U.replace(ttBody, UI.table({
          cols: [
            { key: 'm', label: 'Symbol', render: (r) => UI.marketCell(r.ticker, r.prod.marginMode === 'CROSS' ? 'cross' : 'isolated') },
            { key: 'side', label: 'Side', render: (r) => U.sideEl(r.long, true) },
            { key: 'size', label: 'Size', num: true, render: (r) => U.fmtQty(r.abs) },
            { key: 'entry', label: 'Entry price', num: true, render: (r) => U.fmtPrice(r.entry, r.prod.tickSize) },
            { key: 'mark', label: 'Mark', num: true, render: (r) => (r.mark ? U.fmtPrice(r.mark, r.prod.tickSize) : '—') },
            { key: 'cost', label: 'Notional', num: true, render: (r) => U.fmtUsd(r.notional) },
            { key: 'upnl', label: 'Unrealized PnL', num: true, render: (r) => h('span', U.pnlEl(r.net), r.roe != null ? h('span.dim.xs', ' (' + U.fmtPct(r.roe, { sign: true, dp: 1 }) + ')') : null) },
            { key: 'tp', label: 'Take profit', num: true, title: 'Nearest take-profit level from the account\'s stop / reduce-only orders', render: (r) => exitCell(r, r.tp) },
            { key: 'sl', label: 'Stop loss', num: true, title: 'Nearest stop-loss level from the account\'s stop / reduce-only orders', render: (r) => exitCell(r, r.sl) },
            { key: 'rpnl', label: 'Realized PnL', num: true, render: (r) => U.pnlEl(r.realized) },
            { key: 'fund', label: 'Funding', num: true, title: 'Unsettled funding (negative = paid)', render: (r) => U.pnlEl(-r.funding) },
            { key: 'liq', label: 'Liq. price', num: true, title: 'Estimated liquidation price (pool maintenance margin)', render: (r) => liqCell(r) },
            { key: 'upd', label: 'Updated', render: (r) => h('span.dim', U.fmtAgo(r.p.updatedAt)) },
          ], rows: a.positions, empty: 'No open positions',
        }));
      } else if (tt === 'orders') {
        U.replace(ttBody, UI.table({ cols: orderCols(ref), rows: U.sortBy(base.orders, (o) => o.createdAt, true), empty: 'No open orders' }));
      } else if (tt === 'fills') {
        U.replace(ttBody, cursorTable({
          fetchPage: (cursor, n) => A.fillsPage(sid, cursor, n, cx), empty: 'No fills yet',
          cols: [
            { key: 'm', label: 'Symbol', render: (r) => UI.marketCell(tickerOf(ref, r.productId)) },
            { key: 'side', label: 'Side', render: (r) => U.sideEl(r.side) },
            { key: 'filled', label: 'Filled', num: true, render: (r) => U.fmtQty(r.filled) },
            { key: 'price', label: 'Price', num: true, render: (r) => U.fmtPrice(r.price, tickOf(ref, r.productId)) },
            { key: 'cost', label: 'Cost', num: true, render: (r) => U.fmtUsd(U.num(r.filled) * U.num(r.price)) },
            { key: 'fee', label: 'Fee', num: true, render: (r) => U.fmtUsd(r.feeUsd) },
            { key: 'type', label: 'Type', render: (r) => r.type },
            { key: 'maker', label: 'Maker', render: (r) => (r.isMaker ? 'Yes' : 'No') },
            { key: 'ro', label: '', render: (r) => (r.reduceOnly ? UI.chip('RO') : '') },
            { key: 't', label: 'Time', render: (r) => h('span.dim', U.fmtDateTimeS(r.createdAt)) },
          ],
        }));
      } else if (tt === 'history') {
        U.replace(ttBody, cursorTable({
          fetchPage: (cursor, n) => A.positionsPage(sid, cursor, n, cx), empty: 'No positions yet',
          cols: [
            { key: 'm', label: 'Symbol', render: (r) => UI.marketCell(tickerOf(ref, r.productId)) },
            { key: 'side', label: 'Side', render: (r) => U.sideEl(r.side, true) },
            { key: 'status', label: 'Status', render: (r) => (U.num(r.size) !== 0 ? UI.chip('OPEN', 'accent') : r.isLiquidated ? UI.chip('LIQUIDATED', 'red') : r.wasDeleveraged ? UI.chip('ADL', 'amber') : UI.chip('CLOSED')) },
            { key: 'size', label: 'Max size', num: true, render: (r) => U.fmtQty(r.totalIncreaseQuantity) },
            { key: 'cost', label: 'Cost', num: true, title: 'Total notional opened', render: (r) => U.fmtUsd(r.totalIncreaseNotional) },
            { key: 'avg', label: 'Avg entry', num: true, render: (r) => (U.num(r.totalIncreaseQuantity) ? U.fmtPrice(U.num(r.totalIncreaseNotional) / U.num(r.totalIncreaseQuantity), tickOf(ref, r.productId)) : '—') },
            { key: 'rpnl', label: 'Realized PnL', num: true, title: 'Net of fees and funding', render: (r) => U.pnlEl(U.num(r.realizedPnl) - U.num(r.feesAccruedUsd) - U.num(r.fundingAccruedUsd) - U.num(r.positionFeeAccruedUsd)) },
            { key: 'fund', label: 'Funding', num: true, title: 'Settled funding (negative = paid)', render: (r) => U.pnlEl(-U.num(r.fundingAccruedUsd)) },
            { key: 'fees', label: 'Fees', num: true, render: (r) => U.fmtUsd(U.num(r.feesAccruedUsd) + U.num(r.positionFeeAccruedUsd)) },
            { key: 'created', label: 'Created', render: (r) => h('span.dim', U.fmtDateTimeS(r.createdAt)) },
            { key: 'closed', label: 'Closed', render: (r) => h('span.dim', U.num(r.size) !== 0 ? '—' : U.fmtDateTimeS(r.updatedAt)) },
          ],
        }));
      } else if (tt === 'transfers') {
        U.replace(ttBody, cursorTable({
          fetchPage: (cursor, n) => A.transfersPage(sid, cursor, n, cx), empty: 'No transfers yet',
          cols: [
            { key: 'type', label: 'Type', render: (r) => UI.chip(r.type, r.type === 'DEPOSIT' ? 'green' : r.type === 'WITHDRAW' ? 'red' : 'blue') },
            { key: 'token', label: 'Token', render: (r) => r.type === 'CONVERT' ? h('span', r.tokenName, h('span.dim', ' → '), r.toTokenName) : r.tokenName },
            { key: 'amt', label: 'Amount', num: true, render: (r) => U.fmtNum(r.amount, 2) },
            { key: 'fee', label: 'Fee', num: true, render: (r) => U.fmtNum(r.fee, 2) },
            { key: 'status', label: 'Status', render: (r) => UI.chip(r.status, r.status === 'COMPLETED' ? 'green' : r.status === 'REJECTED' ? 'red' : 'amber') },
            { key: 'tx', label: 'Tx', render: (r) => { const tx = r.finalizedTransactionHash || r.initiatedTransactionHash; return tx ? h('a.addr', { href: U.explorerTx(tx), target: '_blank', rel: 'noopener' }, U.shortAddr(tx, 6)) : '—'; } },
            { key: 't', label: 'Time', render: (r) => h('span.dim', U.fmtDateTimeS(r.createdAt)) },
          ],
        }));
      }
    }

    // ---- series / chart ----
    const seriesCache = new Map();
    let series = null, loadingRange = false;
    async function loadRange() {
      const res = AN.resFor(range);
      const start = AN.startFor(range, sa.createdAt);
      const key = range;
      if (seriesCache.has(key)) { series = seriesCache.get(key); drawChart(); return; }
      loadingRange = true; drawChart();
      try {
        const s = await AN.loadSeries(sid, { start, resolution: res, signal: cx.signal, ttl: 60000 });
        seriesCache.set(key, s); series = s;
      } catch (e) { if (isAbort(e)) return; series = null; chartBox.appendChild(h('div.overlay', 'History unavailable: ' + e.message)); loadingRange = false; return; }
      loadingRange = false; drawChart();
    }
    function drawChart() {
      U.$$('.overlay', chartBox).forEach((o) => o.remove());
      if (loadingRange || !series) { C.destroy(chartCanvas); chartBox.appendChild(h('div.overlay', h('span.loading', h('span.spinner'), 'Loading history…'))); return; }
      const res = A.RES[AN.resFor(range)];
      const start = AN.startFor(range, sa.createdAt);
      const live = base ? { upnl: base.acct.upnl, equity: base.acct.equity } : null;
      const stats = AN.intervalStats(series, start, live, res.ms);
      const rows = series.filter((b) => b.t >= start);
      const prev = series.filter((b) => b.t < start).pop();
      let prevUp = prev ? prev.upnl : 0;
      let acc = 0;
      const pts = [];
      const level = metric === 'balance' || metric === 'equity';
      for (const b of rows) {
        let v;
        if (metric === 'pnl') { v = b.pnl + (b.upnl - prevUp); prevUp = b.upnl; }
        else if (metric === 'volume') v = b.volume;
        else if (metric === 'balance') v = b.balance;
        else if (metric === 'equity') v = b.equity;
        else if (metric === 'funding') v = b.funding;
        else v = b.fee;
        if (!level && cumulative) { acc += v; v = acc; }
        pts.push({ x: b.t, y: v });
      }
      if (live && pts.length) { if (metric === 'equity') pts.push({ x: Date.now(), y: live.equity }); }
      const col = C.colors();
      const last = pts.length ? pts[pts.length - 1].y : 0;
      const color = metric === 'volume' ? col.blue : metric === 'fees' ? col.amber : metric === 'balance' || metric === 'equity' ? col.accent : last >= 0 ? col.green : col.red;
      const type = !level && !cumulative ? 'bar' : 'line';
      const label = METRICS.find((m) => m.v === metric).label + (level ? '' : cumulative ? ' (cumulative)' : '');
      cumBox.querySelector('input').disabled = level;
      C.timeSeries(chartCanvas, { points: pts, color, type, label, zero: true, xMin: rows.length ? Math.min(rows[0].t, start) : undefined, xMax: Date.now(), beginAtZero: metric === 'volume' || metric === 'fees' });
      const rl = RANGES.find((r) => r.v === range).label;
      U.replace(tiles,
        UI.stat('PnL (' + rl + ')', U.fmtUsd(stats.pnl, { sign: true }), stats.roi != null ? 'ROI ' + U.fmtPct(stats.roi, { sign: true, dp: 1 }) : null, U.pnlClass(stats.pnl)),
        UI.stat('Volume (' + rl + ')', U.fmtUsd(stats.volume)),
        UI.stat('Funding (' + rl + ')', U.fmtUsd(stats.funding, { sign: true }), null, U.pnlClass(stats.funding)),
        UI.stat('Fees (' + rl + ')', U.fmtUsd(stats.fees)),
        UI.stat('Max drawdown', U.fmtDd(stats.ddPct), stats.ddUsd ? U.fmtUsd(stats.ddUsd) : null),
        UI.stat('Sharpe', U.ratioFmt(stats.sharpe), 'annualized'));
    }

    await Promise.all([loadBase(), loadRange()]);
    schedule();
  }

  // =====================================================================
  // Live
  // =====================================================================
  async function mountLive(el, st, cx) {
    const { sa, ref } = st; const sid = sa.id;
    const status = h('span.status-dot');
    const statusTxt = h('span.dim.small', 'connecting');
    const posBody = h('div.scroll-y'), ordBody = h('div.scroll-y'), fillBody = h('div.feed'), book = h('div.book'), bookTitle = h('span.dim.small');
    const mkSel = h('select.input.sm', { style: { width: 'auto' }, onchange: (e) => selectMarket(e.target.value) }, ref.active.map((p) => h('option', { value: p.ticker }, p.displayTicker)));
    U.replace(el, h('div.live',
      h('div.stack',
        h('div.card.tight', h('div.card-head', h('h2', 'Open positions'), status, statusTxt), posBody),
        h('div.card.tight', h('div.card-head', h('h2', 'Open orders')), ordBody),
        h('div.card.tight', h('div.card-head', h('h2', 'Fills'), h('span.dim.small', 'live')), fillBody)),
      h('div.card.tight', h('div.card-head', h('h2', 'Order book'), mkSel), h('div', { style: { padding: '4px 0 6px' } }, h('div.center', bookTitle)), book)));

    const marks = {}; // ticker -> {mark, bid, ask}
    let positions = [], orders = [], fills = [];
    const prices = {};
    const renderPos = () => {
      const px = {};
      for (const p of positions) { const prod = ref.byId[p.productId]; const m = prod && marks[prod.ticker]; px[p.productId] = m ? { oraclePrice: m.mark } : prices[p.productId]; }
      const acct = AN.accountState({ balances: [], positions, ref, prices: px });
      AN.attachStops(acct.positions, orders);
      U.replace(posBody, UI.table({
        cols: [
          { key: 'm', label: 'Symbol', render: (r) => UI.marketCell(r.ticker) },
          { key: 'side', label: 'Side', render: (r) => U.sideEl(r.long, true) },
          { key: 'size', label: 'Size', num: true, render: (r) => U.fmtQty(r.abs) },
          { key: 'entry', label: 'Entry', num: true, render: (r) => U.fmtPrice(r.entry, r.prod.tickSize) },
          { key: 'mark', label: 'Mark', num: true, render: (r) => (r.mark ? U.fmtPrice(r.mark, r.prod.tickSize) : '—') },
          { key: 'notional', label: 'Notional', num: true, render: (r) => U.fmtUsd(r.notional) },
          { key: 'upnl', label: 'Unrealized PnL', num: true, render: (r) => U.pnlEl(r.net) },
          { key: 'tp', label: 'Take profit', num: true, render: (r) => exitCell(r, r.tp) },
          { key: 'sl', label: 'Stop loss', num: true, render: (r) => exitCell(r, r.sl) },
          { key: 'rpnl', label: 'Realized', num: true, render: (r) => U.pnlEl(r.realized) },
          { key: 'fund', label: 'Funding', num: true, render: (r) => U.pnlEl(-r.funding) },
          { key: 'upd', label: 'Updated', render: (r) => h('span.dim', U.fmtAgo(r.p.updatedAt)) },
        ], rows: acct.positions, empty: 'No open positions',
      }));
    };
    const renderOrd = () => U.replace(ordBody, UI.table({ cols: orderCols(ref), rows: U.sortBy(orders, (o) => o.createdAt, true), empty: 'No open orders' }));
    const fillRow = (f, flash) => h('div.it', { class: flash ? 'flash' : '' }, h('span.t', U.fmtTime(f.createdAt)), h('span.m', tickerOf(ref, f.productId)), U.sideEl(f.side), h('span.num', U.fmtQty(f.filled) + ' @ ' + U.fmtPrice(f.price, tickOf(ref, f.productId))), h('span.grow'), h('span.num.dim', U.fmtUsd(U.num(f.filled) * U.num(f.price))), h('span.xs.dim', f.isMaker ? 'maker' : 'taker'));
    const renderFills = () => U.replace(fillBody, fills.length ? fills.slice(0, 40).map((f, i) => fillRow(f, f._new && i < 5)) : UI.empty('No fills yet'));

    async function reload() {
      try {
        const [p, o] = await Promise.all([A.openPositions(sid, cx), A.activeOrders(sid, cx)]);
        positions = p; orders = o;
        const pids = Array.from(new Set(positions.map((x) => x.productId)));
        if (pids.length) Object.assign(prices, await A.marketPrices(pids, { signal: cx.signal, ttl: 3000 }));
        renderPos(); renderOrd();
      } catch (e) { if (!isAbort(e)) console.warn(e); }
    }
    const reloadDebounced = U.debounce(reload, 500);
    try { const f = await A.fillsPage(sid, null, 30, cx); fills = f.rows; } catch (_) {}
    renderFills();
    await reload();

    // WS subscriptions
    let curMarket = null, unsubBook = null;
    const throttledPos = U.throttle(renderPos, 1000);
    cx.onCleanup(A.ws.onStatus((s) => { status.className = 'status-dot ' + (s === 'open' ? 'ok' : s === 'connecting' ? 'warn' : 'bad'); statusTxt.textContent = s === 'open' ? 'live' : s; }));
    for (const p of ref.active) cx.onCleanup(A.ws.subscribe('Ticker', p.ticker, (m) => { const d = m.data; marks[d.s] = { mark: U.num(d.markPx), bid: U.num(d.bidPx), ask: U.num(d.askPx) }; if (positions.some((x) => ref.byId[x.productId] && ref.byId[x.productId].ticker === d.s)) throttledPos(); if (d.s === curMarket) renderBook(); }));
    cx.onCleanup(A.ws.subscribe('PositionUpdate', sid, () => reloadDebounced()));
    cx.onCleanup(A.ws.subscribe('OrderUpdate', sid, () => reloadDebounced()));
    cx.onCleanup(A.ws.subscribe('OrderFill', sid, (m) => {
      const d = m.data || {}; const items = Array.isArray(d.d) ? d.d : [];
      for (const it of items) {
        const prod = ref.byTicker[it.s];
        fills.unshift({ id: it.id, orderId: it.oid, productId: prod ? prod.id : it.s, side: it.sd, filled: it.sz, price: it.px, feeUsd: it.fee, isMaker: it.m, type: it.typ, createdAt: it.t || d.t, _new: true });
      }
      fills = fills.slice(0, 100); renderFills(); reloadDebounced();
    }));

    // order book
    const bids = new Map(), asks = new Map();
    function renderBook() {
      const prod = ref.byTicker[curMarket]; if (!prod) return;
      const tick = prod.tickSize;
      const a = Array.from(asks.entries()).filter(([, q]) => q > 0).sort((x, y) => x[0] - y[0]).slice(0, 12);
      const b = Array.from(bids.entries()).filter(([, q]) => q > 0).sort((x, y) => y[0] - x[0]).slice(0, 12);
      let ca = 0, cb = 0; const rowsA = a.map(([p, q]) => (ca += q, { p, q, c: ca })); const rowsB = b.map(([p, q]) => (cb += q, { p, q, c: cb }));
      const max = Math.max(ca, cb, 1e-9);
      const lvl = (r, cls) => h('div.lvl', { class: cls }, h('i', { style: { width: (r.c / max) * 100 + '%' } }), h('span', U.fmtPrice(r.p, tick)), h('span', U.fmtQty(r.q)), h('span', U.fmtUsd(r.c * r.p, { compact: true })));
      const m = marks[curMarket];
      const bestA = a.length ? a[0][0] : null, bestB = b.length ? b[0][0] : null;
      const spread = bestA && bestB ? ((bestA - bestB) / ((bestA + bestB) / 2)) * 100 : null;
      U.replace(book, h('div.hdr', h('span', 'Price'), h('span', 'Size'), h('span', 'Total')), rowsA.slice().reverse().map((r) => lvl(r, 'ask')),
        h('div.mid', h('span.bold', m && m.mark ? U.fmtPrice(m.mark, tick) : '—'), h('span.dim.xs', spread != null ? '  spread ' + U.fmtPct(spread, { dp: 3 }) : '')),
        rowsB.map((r) => lvl(r, 'bid')));
      bookTitle.textContent = prod.displayTicker + ' · mark ' + (m && m.mark ? U.fmtPrice(m.mark, tick) : '—');
    }
    function selectMarket(ticker) {
      if (unsubBook) unsubBook();
      curMarket = ticker; bids.clear(); asks.clear(); mkSel.value = ticker;
      U.replace(book, UI.loading('Loading order book…'));
      unsubBook = A.ws.subscribe('L2Book', ticker, (m) => {
        const d = m.data || {};
        for (const [p, q] of d.a || []) { const qq = U.num(q); if (qq === 0) asks.delete(U.num(p)); else asks.set(U.num(p), qq); }
        for (const [p, q] of d.b || []) { const qq = U.num(q); if (qq === 0) bids.delete(U.num(p)); else bids.set(U.num(p), qq); }
        renderBook();
      });
      cx.onCleanup(() => { if (unsubBook) unsubBook(); });
    }
    const biggest = positions.length ? U.sortBy(positions, (p) => Math.abs(U.num(p.cost)), true)[0] : null;
    selectMarket(biggest && ref.byId[biggest.productId] ? ref.byId[biggest.productId].ticker : (ref.active[0] && ref.active[0].ticker));
  }

  // =====================================================================
  // Performance
  // =====================================================================
  async function mountPerformance(el, st, cx) {
    const { sa, ref } = st; const sid = sa.id;
    U.replace(el, UI.loading('Crunching positions and history…'));
    const [positions, fills, series, balances, openPos] = await Promise.all([
      A.positions(sid, { maxPages: 10, signal: cx.signal, ttl: 60000 }),
      A.fills(sid, { maxPages: 5, signal: cx.signal }).catch(() => []),
      AN.loadSeries(sid, { start: AN.startFor('all', sa.createdAt), resolution: 'day1', signal: cx.signal, ttl: 60000 }),
      A.balances(sid, cx), A.openPositions(sid, cx),
    ]);
    const pids = Array.from(new Set(openPos.map((p) => p.productId)));
    const prices = pids.length ? await A.marketPrices(pids, cx) : {};
    const acct = AN.accountState({ balances, positions: openPos, ref, prices });
    const ps = AN.positionStats(positions, ref);
    const is = AN.intervalStats(series, AN.startFor('all', sa.createdAt), { upnl: acct.upnl, equity: acct.equity }, U.DAY);
    const makerN = fills.filter((f) => f.isMaker).length;
    const feesFills = U.sum(fills, (f) => U.num(f.feeUsd));
    const m = (k, v, s, cls) => UI.metric(k, v, s, cls);
    const grid = h('div.metric-list',
      m('Total PnL (all time)', U.fmtUsd(is.pnl, { sign: true }), 'incl. unrealized', U.pnlClass(is.pnl)),
      m('ROI', is.roi != null ? U.fmtPct(is.roi, { sign: true, dp: 1 }) : '—', 'on deposits + starting equity', U.pnlClass(is.roi)),
      m('Win rate', ps.winRate != null ? U.fmtPct(ps.winRate, { dp: 1 }) : '—', `${ps.wins}W / ${ps.losses}L of ${ps.closed.length} closed`),
      m('Profit factor', ps.profitFactor == null ? '—' : ps.profitFactor === Infinity ? '∞' : U.fmtNum(ps.profitFactor, 2), 'gross wins / gross losses'),
      m('Expectancy', ps.expectancy != null ? U.fmtUsd(ps.expectancy, { sign: true }) : '—', 'avg net per closed position', U.pnlClass(ps.expectancy)),
      m('Avg win / loss', (ps.avgWin != null ? U.fmtUsd(ps.avgWin) : '—') + ' / ' + (ps.avgLoss != null ? U.fmtUsd(ps.avgLoss) : '—')),
      m('Largest win / loss', (ps.largestWin != null ? U.fmtUsd(ps.largestWin) : '—') + ' / ' + (ps.largestLoss != null ? U.fmtUsd(ps.largestLoss) : '—')),
      m('Sharpe (daily, annualized)', U.ratioFmt(is.sharpe)),
      m('Max drawdown', U.fmtDd(is.ddPct), is.ddUsd ? U.fmtUsd(is.ddUsd) : null, is.ddPct > 30 ? 'neg' : ''),
      m('Trading style', ps.style, ps.avgDuration != null ? 'avg hold ' + U.fmtDuration(ps.avgDuration) : 'no closed positions'),
      m('Long / short', `${ps.longs} / ${ps.shorts}`, 'positions'),
      m('Positions', String(ps.count) + (positions.truncated ? '+' : ''), `${ps.open.length} open · ${ps.liquidated} liquidated`),
      m('Volume (all time)', U.fmtUsd(is.volume, { compact: true })),
      m('Fees paid', U.fmtUsd(is.fees), fills.length ? `${U.fmtPct(fills.length ? (makerN / fills.length) * 100 : 0, { dp: 0 })} maker of last ${fills.length} fills` : null),
      m('Funding (net)', U.fmtUsd(is.funding, { sign: true }), 'positive = received', U.pnlClass(is.funding)),
      m('Deposits / withdrawals', U.fmtUsd(is.deposits, { compact: true }) + ' / ' + U.fmtUsd(is.withdrawals, { compact: true })));

    const c1 = h('canvas'), c2 = h('canvas'), c3 = h('canvas');
    const perMarket = UI.table({
      cols: [
        { key: 'm', label: 'Market', render: (r) => UI.marketCell(r.ticker) },
        { key: 'count', label: 'Positions', num: true, render: (r) => String(r.count) },
        { key: 'closed', label: 'Closed', num: true, render: (r) => String(r.closed) },
        { key: 'wr', label: 'Win rate', num: true, render: (r) => (r.closed ? U.fmtPct((r.wins / r.closed) * 100, { dp: 0 }) : '—') },
        { key: 'pnl', label: 'Net PnL (closed)', num: true, render: (r) => U.pnlEl(r.pnl) },
        { key: 'vol', label: 'Volume', num: true, render: (r) => U.fmtUsd(r.vol, { compact: true }) },
        { key: 'ls', label: 'Long %', num: true, render: (r) => U.fmtPct((r.longs / r.count) * 100, { dp: 0 }) },
      ], rows: ps.byMarket, empty: 'No positions yet',
    });
    U.replace(el, h('div.stack', grid,
      h('div.grid.cols-2', h('div.card', h('h3', { style: { marginBottom: '10px' } }, 'Cumulative PnL'), h('div.chart-box.sm', c1)), h('div.card', h('h3', { style: { marginBottom: '10px' } }, 'Daily PnL'), h('div.chart-box.sm', c2))),
      h('div.grid.cols-2', UI.card('By market', perMarket), h('div.card', h('h3', { style: { marginBottom: '10px' } }, 'Net PnL by market (closed)'), h('div.chart-box.sm', c3))),
      positions.truncated ? h('div.notice', 'Only the most recent 2,000 positions were analysed.') : null));
    const start = AN.startFor('all', sa.createdAt);
    const rows = series.filter((b) => b.t >= start);
    let acc = 0, prevUp = 0; const cum = [], daily = [];
    for (const b of rows) { const v = b.pnl + (b.upnl - prevUp); prevUp = b.upnl; acc += v; cum.push({ x: b.t, y: acc }); daily.push({ x: b.t, y: v }); }
    const col = C.colors();
    C.timeSeries(c1, { points: cum, color: acc >= 0 ? col.green : col.red, label: 'PnL', xMax: Date.now() });
    C.timeSeries(c2, { points: daily, type: 'bar', color: col.accent, label: 'PnL', xMax: Date.now() });
    C.bars(c3, ps.byMarket.map((r) => r.ticker), ps.byMarket.map((r) => r.pnl), { horizontal: true });
  }

  // =====================================================================
  // Rewards
  // =====================================================================
  async function mountRewards(el, st, cx) {
    const { addr, sa } = st;
    U.replace(el, UI.loading('Loading points…'));
    const [summaries, total, signers] = await Promise.all([A.pointsSummary(addr, cx).catch(() => []), A.pointsTotal(cx).catch(() => null), A.signers(sa.id, cx).catch(() => [])]);
    const cards = [];
    const seasons = U.sortBy(summaries, (s) => s.season, true);
    if (!seasons.length) {
      cards.push(h('div.card', h('div.empty', h('div', { style: { marginBottom: '6px' } }, 'No points recorded for this address yet.'), h('div.small', 'Meridian distributes points per season and epoch; they show up here once the first epoch is settled.'))));
    }
    for (const s of seasons) {
      const share = total && U.num(total.totalPoints) > 0 ? (U.num(s.totalPoints) / U.num(total.totalPoints)) * 100 : null;
      const epochs = h('div.chart-box.sm'); const cv = h('canvas'); epochs.appendChild(cv);
      cards.push(h('div.card', h('div.row', { style: { marginBottom: '12px' } }, h('h2', 'Season ' + s.season), UI.chip('Tier ' + (s.tier != null ? s.tier : '—'), 'accent'), h('span.grow'), h('span.dim.small', 'updated ' + U.fmtAgo(s.updatedAt))),
        h('div.stats', UI.stat('Rank', s.rank != null ? '#' + s.rank : '—', s.previousRank != null ? 'was #' + s.previousRank : null), UI.stat('Total points', U.fmtNum(s.totalPoints, 0)), UI.stat('Referral points', U.fmtNum(s.referralPoints, 0)), UI.stat('Share of season', share != null ? U.fmtPct(share, { dp: 4 }) : '—', total ? 'of ' + U.fmtCompact(total.totalPoints) + ' distributed' : null)),
        h('h3', { style: { margin: '16px 0 8px' } }, 'Points by epoch'), epochs));
      // epoch history (probe epochs until two consecutive empties)
      (async () => {
        const pts = []; let misses = 0;
        for (let e = 1; e <= 24 && misses < 2; e++) {
          let rows = [];
          try { rows = await A.points(addr, s.season, e, cx); } catch (err) { if (isAbort(err)) return; break; }
          if (!rows.length) { misses++; continue; }
          misses = 0; for (const r of rows) pts.push({ epoch: e, name: r.name, points: U.num(r.points), ref: U.num(r.referralPoints), t: r.endedAt || r.startedAt });
        }
        if (!pts.length) { U.replace(epochs, UI.empty('No epoch breakdown available')); return; }
        C.bars(cv, pts.map((p) => 'E' + p.epoch), pts.map((p) => p.points), { fmt: (v) => U.fmtNum(v, 0) + ' pts' });
      })();
    }
    if (total) cards.push(h('div.card', h('div.row', h('h2', 'Exchange-wide points'), h('span.grow'), h('span.dim.small', 'updated ' + U.fmtAgo(total.updatedAt))), h('div.stats', { style: { marginTop: '10px' } }, UI.stat('Total distributed', U.fmtNum(total.totalPoints, 0)), UI.stat('Referral points', U.fmtNum(total.referralPoints, 0)))));
    cards.push(UI.card('Linked signers (API keys)', UI.table({
      cols: [
        { key: 'name', label: 'Name', render: (r) => r.name || '—' },
        { key: 'signer', label: 'Signer', render: (r) => h('span.addr', { title: r.signer }, U.shortAddr(r.signer, 6)) },
        { key: 'cat', label: 'Category', render: (r) => r.category || '—' },
        { key: 'status', label: 'Status', render: (r) => UI.chip(r.status, r.status === 'ACTIVE' ? 'green' : r.status === 'REVOKED' ? 'red' : '') },
        { key: 'linked', label: 'Linked', render: (r) => h('span.dim', U.fmtDate(r.linkedAt || r.createdAt)) },
        { key: 'exp', label: 'Expires', render: (r) => h('span.dim', r.expiresAt ? U.fmtDate(r.expiresAt) : '—') },
      ], rows: signers, empty: 'No linked signers',
    })));
    U.replace(el, h('div.stack', cards));
  }
})();
