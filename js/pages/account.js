/* MeridianDataHub — Account page: Overview / Live / Performance / Rewards */
(function () {
  const MD = window.MD; const U = MD.util; const A = MD.api; const AN = MD.analytics; const UI = MD.ui; const C = MD.charts; const h = U.h;

  const TABS = [['overview', 'Overview'], ['live', 'Live'], ['performance', 'Performance'], ['rewards', 'Rewards'], ['predict', 'Predict']];
  const RANGES = [{ v: '24h', label: '24h' }, { v: '7d', label: '7d' }, { v: '30d', label: '30d' }, { v: 'all', label: 'All time' }];

  // Equity curve flex (js/flex.js): the account's card for a period, from the same series and figures as the Overview tab
  const FLEX_PERIODS = [{ v: '24h', label: '24 hours' }, { v: '7d', label: '7 days' }, { v: '30d', label: '30 days' }, { v: 'all', label: 'All time' }];
  const BUCKET = { '24h': U.HOUR, '7d': 2 * U.HOUR, '30d': 8 * U.HOUR };   // AN.resFor's resolutions
  function openFlex(addr, sa, ref) {
    const sid = sa.id; const K = MD.cards.make({ U, P: MD.predict }); let posP = null;
    MD.flex.open({
      address: addr, what: 'account', periods: FLEX_PERIODS, period: 'all', shareUrl: A.shareUrl('a', addr),
      build: async (p) => {
        const start = AN.startFor(p, sa.createdAt);
        posP = posP || A.positions(sid, { maxPages: 10, ttl: 60000 });
        const [series, balances, open, positions] = await Promise.all([AN.loadSeries(sid, { start, resolution: AN.resFor(p), ttl: 60000, charges: true, positions: posP }), A.balances(sid), A.openPositions(sid), posP]);
        const pids = Array.from(new Set(open.map((x) => x.productId)));
        const prices = pids.length ? await A.marketPrices(pids) : {};
        const acct = AN.accountState({ balances, positions: open, ref, prices });
        const ser = AN.netLive(series, acct, BUCKET[p] || U.DAY);   // every bucket on the live figures' basis (funding and position fees as charged)
        const is = AN.intervalStats(ser, start, { upnl: acct.upnl, equity: acct.equity }, BUCKET[p] || U.DAY);
        const base = is.curve.length ? is.curve[0].v : 0;
        const curve = is.curve.map((c) => [Math.round(c.t / 1000), Math.round((c.v - base) * 100) / 100]);
        // positions of the period: those still open or updated since its start (a close is the last update)
        const ps = AN.positionStats(p === 'all' ? positions : positions.filter((x) => U.num(x.size) !== 0 || U.num(x.updatedAt) >= start), ref);
        const wr = ps.winRate == null ? '—' : U.fmtPct(ps.winRate, { dp: 0 }), dd = U.fmtDd(is.ddPct);
        const style = ps.style && ps.style !== '—' ? ps.style : null;
        return {
          kind: 'perps', address: addr, period: FLEX_PERIODS.find((x) => x.v === p).label, pnl: is.pnl, roi: is.roi, curve: curve.length >= 2 ? curve : null,
          periodRange: curve.length >= 2 ? K.range(curve[0][0] * 1000, curve[curve.length - 1][0] * 1000) : null,
          stats: [['Win rate', wr], ['Max drawdown', dd], ['Volume', U.fmtUsd(is.volume, { compact: true })], ['Positions', U.fmtNum(ps.count, 0)]],
          statsHidden: [['Win rate', wr], ['Max drawdown', dd], ['Positions', U.fmtNum(ps.count, 0)], ['Style', style || '—']],
          // the exchange's own account (AN.EXCHANGE) is not a trader, as on the share card
          footRight: (AN.exchangeAccount({ sid }) ? 'Exchange account · ' : style ? style + ' trader · ' : '') + 'since ' + K.date(sa.createdAt),
        };
      },
    });
  }
  const METRICS = [{ v: 'pnl', label: 'PnL' }, { v: 'volume', label: 'Volume' }, { v: 'balance', label: 'Balance' }, { v: 'equity', label: 'Equity' }, { v: 'funding', label: 'Funding' }, { v: 'fees', label: 'Fees' }];

  const child = (ctx) => { const ac = new AbortController(); const c = { signal: ac.signal, cleanup: [], onCleanup(f) { this.cleanup.push(f); }, abort() { ac.abort(); this.cleanup.forEach((f) => { try { f(); } catch (_) {} }); this.cleanup = []; } }; ctx.onCleanup(() => c.abort()); ctx.signal.addEventListener('abort', () => ac.abort()); return c; };
  const isAbort = (e) => e && e.name === 'AbortError';
  /** "#/account" with nothing selected yet: search box, favorites, and pointers to the places that list accounts. */
  function pickAccountCard() {
    const input = h('input.input', { placeholder: 'Wallet address (0x…) or subaccount ID', autocomplete: 'off', spellcheck: 'false', style: { flex: '1', minWidth: '240px' } });
    const err = h('div.small.neg', { style: { minHeight: '18px', marginTop: '6px' } });
    const btn = h('button.btn', { type: 'submit' }, U.icon('search'), 'Open');
    const form = h('form', { onsubmit: async (e) => { e.preventDefault(); err.textContent = ''; btn.disabled = true; const r = await MD.search(input.value); btn.disabled = false; if (r.error) err.textContent = r.error; } }, h('div.row.wrap', { style: { gap: '8px' } }, input, btn));
    const favs = U.favorites.list();
    return h('div.stack',
      h('div.card', h('h2', { style: { marginBottom: '6px' } }, 'Open an account'), h('p.muted', { style: { margin: '0 0 12px', maxWidth: '640px' } }, 'Every Meridian account is public. Paste a wallet address or a subaccount ID to see its equity, positions, orders, fills, performance and rewards.'), form, err),
      favs.length ? h('div.card.tight', h('div.card-head', h('h2', 'Favorites')), h('div', { style: { padding: '6px 8px' } }, favs.slice(0, 12).map((f) => h('a.btn.sm.ghost', { href: U.accountUrl(f.address, f.subaccountId), style: { margin: '2px' } }, U.icon('star'), f.name || U.shortAddr(f.address, 4))))) : null,
      h('div.card', h('h3', { style: { marginBottom: '8px' } }, 'Find accounts'), h('div.row.wrap', { style: { gap: '6px' } },
        h('a.btn.sm', { href: '#/leaderboard' }, U.icon('trophy'), 'Leaderboard'), h('a.btn.sm', { href: '#/copytrade' }, U.icon('users'), 'Copyable leaders'), h('a.btn.sm', { href: '#/dashboard' }, U.icon('grid'), 'Dashboard trade tape'))));
  }
  const tickerOf = (ref, pid) => (ref.byId[pid] ? ref.byId[pid].displayTicker : U.shortAddr(pid, 4));
  const tickOf = (ref, pid) => (ref.byId[pid] ? ref.byId[pid].tickSize : null);
  // sizes at the market's lot-size decimals, padded, as Meridian's app shows them (U.fmtQty)
  const lotOf = (ref, pid) => (ref.byId[pid] ? ref.byId[pid].lotSize : null);
  const baseOf = (prod) => prod.baseTokenName || String(prod.displayTicker || '').split('-')[0];
  /** Meridian's margin ratio (AN.marginRatio) as its app prints it */
  const mrTxt = (x) => (x == null ? '—' : x >= 1 ? '100%+' : U.fmtPct(x * 100, { dp: 2 }));

  // The interval tiles' window, and how Meridian's app draws its own (its Trade Stats): the site's windows roll with the
  // clock, in the buckets AN.resFor gives each range, from the first bucket that starts inside the window
  const WINDOW_NOTE = {
    '24h': 'The last 24 hours, in the hourly buckets that start inside them (23 to 24 hours), up to now. Meridian\'s app counts its 24h from the start of the hour 24 hours ago: up to an hour more.',
    '7d': 'The last 7 × 24 hours, in the 2-hour buckets that start inside them (6 days 22 hours to 7 days), up to now. Meridian\'s app reads 7D in whole UTC days: its volume from the start of the UTC day 7 days back, its P&L from that day\'s end, so either can differ by up to a day\'s trading.',
    '30d': 'The last 30 × 24 hours, in the 8-hour buckets that start inside them (29 days 16 hours to 30 days), up to now. Meridian\'s app reads 30D in whole UTC days: its volume from the start of the UTC day 30 days back, its P&L from that day\'s end, so either can differ by up to a day\'s trading.',
    all: 'Since the subaccount was created, up to now.',
  };
  const withTitle = (el, title) => { if (title) el.title = title; return el; };

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

  // column tooltips shared by the Overview's and the Live tab's open positions
  const UPNL_TITLE = 'Price PnL at the mark, plus the funding charged since the position\'s last fill and not settled yet (received +, paid −; the unsettled part of the Funding column), minus unsettled mPerp position fees: the amount that counts in equity. Funding settled at earlier fills is already in the balance. Meridian\'s app and API show unrealized PnL without these.';
  const RPNL_TITLE = 'Gross PnL booked on partial closes of this position, before fees and funding (Positions history shows the net)';
  const FUND_TITLE = 'Funding since the position opened (received +, paid −), as Meridian\'s app shows it: settled into the balance at its fills, plus charged every hour since its last fill and not settled yet. Only the unsettled part is in Net unrealized PnL. Hover a cell for the split';
  // an open position's funding since it opened: settled at its fills (fundingAccruedUsd) and charged since its last fill,
  // not settled yet (fundingUsd, the row's funding); both fields are positive when paid
  const fundCell = (r) => {
    const settled = -U.num(r.p.fundingAccruedUsd), unsettled = -U.num(r.funding);
    return h('span', { title: `Settled into the balance at its fills: ${U.fmtUsd(settled, { sign: true, dp: 2 })}\nSince its last fill, not settled yet: ${U.fmtUsd(unsettled, { sign: true, dp: 2 })} (in Net unrealized PnL)` }, U.pnlEl(settled + unsettled));
  };
  /** liquidation price cell — / none: no price, or a long the pool keeps above maintenance even at zero */
  const liqCell = (r) => {
    if (r.liqPrice == null) return '—';
    if (r.long && r.liqPrice <= 0) return h('span.dim', { title: 'The pool stays above its maintenance margin even at a price of zero' }, 'none');
    const cls = r.distPct < 5 ? 'neg' : r.distPct < 15 ? '' : 'dim';
    return h('span', U.fmtPrice(r.liqPrice, r.prod.tickSize), h('span.xs', { class: cls, style: r.distPct >= 5 && r.distPct < 15 ? { color: 'var(--amber)' } : null }, ' ' + (r.distPct > 500 ? '>500%' : U.fmtPct(r.distPct, { dp: 1 }))));
  };
  const flags = (o, tick) => {
    const f = []; const m = AN.orderMeta(o);
    if (m.stop) f.push(m.kind + ' @' + U.fmtPrice(o.stopPrice, tick) + (m.trigger === 'last' ? ' (last)' : ''));
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
    if (e.qty != null) tags.push(U.fmtQty(e.qty, r.prod.lotSize));
    return h('div', { style: { lineHeight: '1.25' }, title: (e.kind === 'stop' ? 'Stop order on the exchange' : 'Reduce-only limit order') + ' · PnL at this level before fees' },
      h('div', U.fmtPrice(e.price, r.prod.tickSize), tags.length ? h('span.xs.dim', ' ' + tags.join(' · ')) : null),
      h('div.xs', e.distPct == null ? null : h('span.dim', U.fmtPct(e.distPct, { sign: true, dp: 1 }) + ' · '), h('span', { class: U.pnlClass(e.pnl) }, U.fmtUsd(e.pnl, { sign: true })), list.length > 1 ? h('span.dim', ' · +' + (list.length - 1) + ' more') : null));
  };
  const orderCols = (ref) => [
    { key: 'm', label: 'Symbol', render: (r) => UI.marketCell(tickerOf(ref, r.productId)) },
    { key: 'side', label: 'Side', render: (r) => U.sideEl(r.side) },
    { key: 'type', label: 'Type', render: (r) => { const m = AN.orderMeta(r); return m.stop ? h('span', m.kind, h('span.dim.xs', ' ' + r.type.toLowerCase())) : r.type; } },
    { key: 'price', label: 'Price', num: true, render: (r) => { const m = AN.orderMeta(r); if (m.stop) return h('span', U.fmtPrice(r.stopPrice, tickOf(ref, r.productId)), h('span.dim.xs', ' trigger')); return U.num(r.price) ? U.fmtPrice(r.price, tickOf(ref, r.productId)) : 'MKT'; } },
    { key: 'qty', label: 'Quantity', num: true, render: (r) => (AN.orderMeta(r).whole ? h('span.dim', 'all') : U.fmtQty(r.quantity, lotOf(ref, r.productId))) },
    { key: 'filled', label: 'Filled', num: true, render: (r) => U.fmtQty(r.filled, lotOf(ref, r.productId)) },
    { key: 'value', label: 'Value', num: true, title: 'Limit price × order quantity', render: (r) => { const v = U.num(r.price) * U.num(r.quantity); return v > 0 ? U.fmtUsd(v) : h('span.dim', '—'); } },
    { key: 'status', label: 'Status', render: (r) => UI.chip(r.status, r.status === 'NEW' ? 'accent' : r.status === 'PENDING' ? 'amber' : r.status === 'FILLED_PARTIAL' ? 'blue' : '') },
    { key: 'flags', label: 'Flags', render: (r) => h('span.dim.small', flags(r, tickOf(ref, r.productId))) },
    { key: 'created', label: 'Created', render: (r) => h('span.dim', U.fmtDateTimeS(r.createdAt)) },
  ];

  MD.router.pages.account = {
    async mount(root, route, ctx) {
      const page = h('div.page');
      root.appendChild(page);
      MD.setTopbar(h('span.title', 'Account'));
      let addr = (route.params.address || '').trim().toLowerCase();
      const subParam = route.params.sub;
      if (!addr && !subParam) {
        // nothing asked for: reopen the last account seen in this browser, else offer a way to pick one
        const last = U.storage.get('md.lastAccount', null);
        if (last && U.isAddress(last.address)) { location.replace(U.accountUrl(last.address, last.sub)); return; }
        U.replace(page, pickAccountCard());
        return;
      }
      let subs = [];
      try {
        if (!addr && subParam && U.isUuid(subParam)) { const sa = await A.subaccount(subParam, ctx); addr = sa.account; }
        if (!U.isAddress(addr)) { U.replace(page, h('div.card', h('div.error', 'Invalid address. Enter a 0x wallet address (40 hex characters) or a subaccount ID.'))); return; }
        subs = await A.subaccountsOf(addr, ctx);
      } catch (e) { if (isAbort(e)) return; U.replace(page, UI.error(e, () => MD.router.dispatch())); return; }
      if (!subs.length) {
        const predictLine = h('div.small', { style: { marginTop: '8px' } });
        U.replace(page, h('div.card', h('div.empty', h('div', { style: { marginBottom: '8px' } }, 'No Meridian perps subaccounts are registered for ', h('span.addr', addr), '.'), h('div.small', 'Perps accounts appear here once the wallet has deposited on ', h('a', { href: A.APP_URL, target: '_blank', rel: 'noopener' }, 'app.meridian.xyz'), '. ', h('a', { href: U.explorerAddr(addr), target: '_blank', rel: 'noopener' }, 'View on explorer')), predictLine)));
        // Predict has wallets of its own: this address may be one (a smart account; its owner holds the perps account),
        // or own one with predictions, or bet directly
        (async () => {
          const W = MD.predict.wallets; const a = addr.toLowerCase();
          const r = await W.resolve(a).catch(() => ({ owner: null, wallet: null, isWallet: false }));
          if (ctx.signal.aborted) return;
          const btn = (w) => h('a.btn.sm', { href: '#/predict/bettor?address=' + w, style: { marginLeft: '4px' } }, U.icon('target'), 'Open the bettor page');
          if (r.isWallet) { U.replace(predictLine, 'This is a Meridian Predict wallet: the smart account the Meridian app places predictions from, owned by ', h('a.addr', { href: U.accountUrl(r.owner, null, 'predict'), title: r.owner }, U.shortAddr(r.owner, 6)), ' (its perps account, if it has one, is under that address).', btn(a)); return; }
          for (const w of [r.wallet, a].filter(Boolean)) {
            if (!(await W.hasActivity(w, { signal: ctx.signal }).catch(() => false)) || ctx.signal.aborted) continue;
            U.replace(predictLine, w === a ? 'It does have Meridian Predict activity.' : h('span', 'It has Meridian Predict activity through its Predict wallet ', h('span.addr', { title: w }, U.shortAddr(w, 6)), '.'), btn(w));
            return;
          }
        })().catch(() => {});
        return;
      }
      const sa = subs.find((s) => s.id === subParam) || subs[0];
      const subName = U.decodeBytes32(sa.name);
      const fav = { address: addr, subaccountId: sa.id, name: subName };
      let ref;
      try { ref = await A.ref(ctx); } catch (e) { if (isAbort(e)) return; U.replace(page, UI.error(e, () => MD.router.dispatch())); return; }

      // ---- topbar header ----
      const subSel = h('select', { onchange: (e) => MD.router.navigate('/account', { address: addr, sub: e.target.value, tab: route.params.tab || 'overview' }) }, subs.map((s) => h('option', { value: s.id, selected: s.id === sa.id }, U.decodeBytes32(s.name))));
      const head = h('div.acct-head',
        h('span.addr-box', h('span', { title: addr }, U.shortAddr(addr, 6)), U.copyBtn(addr)),
        UI.starBtn(fav, 'btn icon'),
        h('span.subsel', 'sub:', subSel),
        h('a.btn.sm.ghost', { href: '#/tax?address=' + encodeURIComponent(addr) + '&sub=' + encodeURIComponent(sa.id), title: 'Tax center for this account' }, U.icon('receipt'), 'Tax'),
        h('a.btn.sm.ghost.explorer', { href: U.explorerAddr(addr), target: '_blank', rel: 'noopener', title: 'Robinhood Chain explorer' }, U.icon('external'), 'Explorer'),
        h('button.btn.sm.ghost.explorer', { title: 'Copy a share link: Discord, X, Telegram and the like show this account\'s card with its PnL', onclick: () => { U.copyText(A.shareUrl('a', addr)); U.toast('Share link copied · it shows a preview card'); } }, U.icon('copy'), 'Share'),
        h('button.btn.sm.ghost.explorer', { title: 'Equity curve flex: this account\'s PnL card, to download, copy or post', onclick: () => openFlex(addr, sa, ref) }, U.icon('trophy'), 'Flex'),
        // the UTC day, like the flex card, the share card and the all-time curve's first day
        h('span.dim.small.nowrap.since', { title: 'Subaccount created ' + new Date(U.num(sa.createdAt)).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' }, 'since ' + U.fmtDayUTC(sa.createdAt).replace(' (UTC day)', '')));
      // phones: the topbar has no room for the header's controls, so the header sits in the page above the tabs instead
      const headSlot = h('div.acct-head-slot');
      const narrow = window.matchMedia('(max-width: 720px)');
      const placeHead = () => { if (narrow.matches) { headSlot.appendChild(head); MD.setTopbar(h('span.title', 'Account')); } else { MD.setTopbar(head); } };
      placeHead(); narrow.addEventListener('change', placeHead); window.addEventListener('resize', placeHead); ctx.onCleanup(() => { narrow.removeEventListener('change', placeHead); window.removeEventListener('resize', placeHead); });

      // ---- tabs ----
      let tab = TABS.some((t) => t[0] === route.params.tab) ? route.params.tab : 'overview';
      const tabsEl = h('div.tabs', TABS.map(([v, label]) => h('button', { class: v === tab ? 'on' : '', dataset: { v }, onclick: () => show(v) }, label)));
      const tabBody = h('div', { style: { marginTop: '16px' } });
      U.replace(page, h('div.stack', headSlot, tabsEl, tabBody));
      let tabCtx = null;
      const state = { addr, sa, subs, ref, fav, subName };
      function show(v) {
        tab = v; MD.router.setParams({ tab: v }, { silent: true });
        U.$$('button', tabsEl).forEach((b) => b.classList.toggle('on', b.dataset.v === v));
        if (tabCtx) tabCtx.abort();
        tabCtx = child(ctx);
        U.clear(tabBody);
        const fn = { overview: mountOverview, live: mountLive, performance: mountPerformance, rewards: mountRewards, predict: mountPredict }[v];
        fn(tabBody, state, tabCtx).catch((e) => { if (!isAbort(e)) { console.error(e); U.replace(tabBody, UI.error(e, () => show(v))); } });
      }
      state.showTab = show;   // lets a tab switch to another one without reloading the page
      show(tab);
    },
  };

  // =====================================================================
  // Overview
  // =====================================================================
  async function mountOverview(el, st, cx) {
    const { sa, ref } = st;
    const sid = sa.id;
    const q = MD.router.parse().params;   // a hand-edited link with an unknown range or metric falls back rather than failing the tab
    let range = RANGES.some((r) => r.v === q.range) ? q.range : 'all';
    let metric = METRICS.some((m) => m.v === q.metric) ? q.metric : 'pnl';
    let cumulative = U.storage.get('md.chart.cum', true);

    const stateCard = h('div.card.state-card', UI.loading('Loading account state…'));
    const chartCanvas = h('canvas');
    const chartBox = h('div.chart-box', h('div.watermark', 'MeridianDataHub'), chartCanvas);
    const tiles = h('div.stats.three');   // six interval stats: two rows of three, no orphans
    const metricSeg = UI.seg(METRICS, metric, (v) => { metric = v; MD.router.setParams({ metric: v }, { silent: true }); drawChart(); }, 'sm');
    const cumBox = UI.checkbox('Cumulative', cumulative, (v) => { cumulative = v; U.storage.set('md.chart.cum', v); drawChart(); });
    const rangeSeg = UI.seg(RANGES, range, (v) => { range = v; MD.router.setParams({ range: v }, { silent: true }); loadRange(); }, 'sm');
    const chartCard = h('div.card.chart-fill', h('div.row.wrap', { style: { marginBottom: '12px', flex: 'none' } }, metricSeg, cumBox, h('span.grow'), rangeSeg), chartBox, h('div', { style: { marginTop: '14px', flex: 'none' } }, tiles));
    const tablesCard = h('div.card.tight');
    // auto-refresh of balances / positions / orders (like the reference site's "30s" control), and of the archive series
    // once a balance has moved (reloadSeries)
    const REFRESH = [{ v: 0, label: 'Off' }, { v: 15, label: '15s' }, { v: 30, label: '30s' }, { v: 60, label: '60s' }];
    let refreshSec = U.num(U.storage.get('md.refresh', 30)); let refreshT = null; let lastLoad = 0;
    const updLbl = h('span.dim.small');
    const refreshSeg = UI.seg(REFRESH, refreshSec, (v) => { refreshSec = v; U.storage.set('md.refresh', v); schedule(); }, 'sm');
    const glance = h('div.row.wrap', { style: { gap: '6px', alignItems: 'center' } });   // Predict at a glance (predictGlance)
    // the refresh controls stay together on the right, also when a narrow screen wraps them under the Predict line
    const refreshRow = h('div.row.wrap', { style: { gap: '8px' } }, glance, h('div.row', { style: { gap: '8px', marginLeft: 'auto' } }, updLbl, h('span.dim.small', 'Auto-refresh'), refreshSeg));
    U.replace(el, h('div.stack', refreshRow, h('div.overview', stateCard, chartCard), tablesCard));
    predictGlance(glance, st, cx).catch((e) => { if (!isAbort(e)) console.warn('predict glance', e); });
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
      const sig = balances.map((b) => String(b.tokenAddress).toLowerCase() + ':' + b.amount).sort().join('|');
      if (balSig != null && sig !== balSig) { seriesStale = true; trailTries = 0; }   // a close, partial close, funding settlement, fee or transfer moved a balance
      balSig = sig;
      base = { balances, positions, orders, working, pending, acct, vol, prices };
      lastLoad = Date.now(); updLbl.textContent = 'updated just now';
      renderState();
      if (refresh) { if (tt === 'positions' || tt === 'orders') renderTT(); } else renderTables();
      drawChart();
      if (refresh && seriesStale) reloadSeries().catch((e) => { if (!isAbort(e)) console.warn('series reload', e); });
    }
    function renderState() {
      const a = base.acct;
      const kv = (k, v, cls, title) => [h('span.k', { title: title || null }, k), h('span.v', { class: cls || '', title: title || null }, v)];
      // a pool's figure is its equity (balance + its positions' net uPnL); Meridian's Balances table calls the balance alone
      // "Equity", so the balance stands on the line under it. The ratio is Meridian's: maintenance margin ÷ pool equity
      const pools = a.pools.map((p) => h('div.pool',
        h('div.name', h('span', p.name === 'USD' ? 'USD (cross)' : p.name + ' (isolated)'),
          h('span.num', { title: `Pool equity: its balance ${U.fmtUsd(p.balance)} plus its positions' net unrealized PnL ${U.fmtUsd(p.upnl, { sign: true })} (after the funding and position fees not settled yet). Meridian's Balances table shows the balance alone, as "Equity".` }, U.fmtUsd(p.equity))),
        h('div.bar', h('i', { class: p.marginRatio != null && p.marginRatio > 2 / 3 ? 'bad' : p.marginRatio != null && p.marginRatio > 1 / 3 ? 'warn' : '', style: { width: U.clamp(p.balance > 0 ? (p.used / p.balance) * 100 : 0, 0, 100) + '%' } })),
        h('div.row.xs.dim', { style: { marginTop: '4px', justifyContent: 'space-between' } },
          h('span', { title: 'As Meridian\'s Balances table: the pool\'s balance (its "Equity" column, unrealized PnL left out) and the margin in use (the bar: in use ÷ balance)' }, 'balance ' + U.fmtUsd(p.balance, { compact: true }) + ' · in use ' + U.fmtUsd(p.used, { compact: true })),
          p.marginRatio != null ? h('span', { title: `Margin ratio, as Meridian's app: maintenance margin ${U.fmtUsd(p.mm)} ÷ pool equity ${U.fmtUsd(p.equity)}. The pool is liquidated at 100%.` }, 'margin ratio ' + mrTxt(p.marginRatio)) : h('span', 'no positions'))));
      const cross = a.pools.find((p) => p.name === 'USD');
      U.replace(stateCard,
        h('div.k.dim.small', 'Equity'),
        h('div.big', { class: '' }, U.fmtUsd(a.equity)),
        h('div.small', { style: { marginBottom: '12px' } }, h('span.dim', { title: 'Price PnL of the open positions, plus unsettled funding received (minus paid), minus unsettled mPerp position fees' }, 'Net unrealized '), U.pnlEl(a.upnl)),
        h('div.kv',
          ...kv('Balance', U.fmtUsd(a.balance)),
          ...kv('Available', U.fmtUsd(a.available), '', 'Margin free for new orders, summed over the pools with each pool counted from 0, as Meridian\'s app does: a pool whose losses exceed its free margin reports less than 0, and nothing is available from it'),
          ...kv('Margin used', U.fmtUsd(a.used)),
          ...kv('Notional', U.fmtUsd(a.notional)),
          ...kv('Leverage', a.leverage != null ? U.fmtNum(a.leverage, 2) + '×' : '—', '', 'Notional ÷ balance, as Meridian\'s app shows the account\'s leverage' + (a.leverageEquity != null ? `. Notional ÷ equity (net unrealized PnL counted): ${U.fmtNum(a.leverageEquity, 2)}×` : '')),
          ...kv('Margin ratio', mrTxt(a.marginRatio), a.marginRatio != null && a.marginRatio > 2 / 3 ? 'neg' : '', 'Maintenance margin ' + U.fmtUsd(a.mm) + ' ÷ equity, over every pool, as Meridian\'s app shows it on the trade page: a pool is liquidated when its own reaches 100%'
            + (cross && cross.marginRatio != null && a.pools.some((p) => p !== cross && p.marginRatio != null) ? `. The cross pool alone (the app's Trade Stats "Cross Margin Ratio"): ${mrTxt(cross.marginRatio)}` : '')),
          ...kv('Open positions', String(a.positions.length)),
          ...kv('Open orders', String(base.working.length)),
          ...kv('Stop orders (TP/SL)', String(base.pending.length)),
          h('span.sep'),
          ...kv('Volume (all time)', base.vol == null ? '—' : U.fmtUsd(base.vol)),
          ...kv('Subaccount', st.subName)),
        pools.length ? h('div', { style: { marginTop: '6px' } }, pools) : h('div.empty.small', 'No balances'));
    }

    // ---- tables ----
    const TT = [['positions', 'Open positions'], ['orders', 'Orders & stops'], ['fills', 'Fills history'], ['history', 'Positions history'], ['transfers', 'Deposits, withdrawals & conversions']];
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
            { key: 'size', label: 'Size', num: true, render: (r) => U.fmtQty(r.abs, r.prod.lotSize) },
            { key: 'entry', label: 'Entry price', num: true, render: (r) => U.fmtPrice(r.entry, r.prod.tickSize) },
            { key: 'mark', label: 'Mark', num: true, render: (r) => (r.mark ? U.fmtPrice(r.mark, r.prod.tickSize) : '—') },
            { key: 'cost', label: 'Notional', num: true, render: (r) => U.fmtUsd(r.notional) },
            { key: 'upnl', label: 'Net unrealized PnL', num: true, title: UPNL_TITLE + ' In brackets: the return on initial margin (notional at the mark ÷ the market\'s max leverage, the margin the exchange holds for the position), not on the pool\'s equity.', render: (r) => h('span', U.pnlEl(r.net), r.roe != null ? h('span.dim.xs', { title: 'Return on initial margin: ' + U.fmtUsd(r.net) + ' ÷ (' + U.fmtUsd(r.notional) + ' ÷ ' + r.maxLev + '×)' }, ' (' + U.fmtPct(r.roe, { sign: true, dp: 1 }) + ')') : null) },
            { key: 'tp', label: 'Take profit', num: true, title: 'Nearest take-profit level from the account\'s stop / reduce-only orders', render: (r) => exitCell(r, r.tp) },
            { key: 'sl', label: 'Stop loss', num: true, title: 'Nearest stop-loss level from the account\'s stop / reduce-only orders', render: (r) => exitCell(r, r.sl) },
            { key: 'rpnl', label: 'Realized PnL', num: true, title: RPNL_TITLE, render: (r) => U.pnlEl(r.realized) },
            { key: 'fund', label: 'Funding', num: true, title: FUND_TITLE, render: fundCell },
            { key: 'liq', label: 'Liq. price', num: true, title: 'Estimated liquidation price (pool maintenance margin)', render: (r) => liqCell(r) },
            { key: 'upd', label: 'Updated', render: (r) => h('span.dim', U.fmtAgo(r.p.updatedAt)) },
          ], rows: a.positions, empty: 'No open positions',
        }));
      } else if (tt === 'orders') {
        U.replace(ttBody, UI.table({ cols: orderCols(ref), rows: U.sortBy(base.orders, (o) => o.createdAt, true), empty: 'No open orders or stops' }));
      } else if (tt === 'fills') {
        U.replace(ttBody, cursorTable({
          fetchPage: (cursor, n) => A.fillsPage(sid, cursor, n, cx), empty: 'No fills yet',
          cols: [
            { key: 'm', label: 'Symbol', render: (r) => UI.marketCell(tickerOf(ref, r.productId)) },
            { key: 'side', label: 'Side', render: (r) => U.sideEl(r.side) },
            { key: 'filled', label: 'Filled', num: true, render: (r) => U.fmtQty(r.filled, lotOf(ref, r.productId)) },
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
            { key: 'size', label: 'Qty opened', num: true, title: 'Total quantity opened over the position\'s life; adding again after a partial close counts again, so this can exceed the largest size the position reached', render: (r) => U.fmtQty(r.totalIncreaseQuantity, lotOf(ref, r.productId)) },
            { key: 'cost', label: 'Cost', num: true, title: 'Total notional opened', render: (r) => U.fmtUsd(r.totalIncreaseNotional) },
            { key: 'avg', label: 'Avg entry', num: true, title: 'Average price of all fills that opened or added to the position (Cost ÷ Qty opened). For an open position that was partly closed and then added to, this differs from the Entry price under Open positions, which is the average entry of the size still open', render: (r) => (U.num(r.totalIncreaseQuantity) ? U.fmtPrice(U.num(r.totalIncreaseNotional) / U.num(r.totalIncreaseQuantity), tickOf(ref, r.productId)) : '—') },
            { key: 'rpnl', label: 'Net PnL', num: true, title: 'Realized PnL less trading and position fees, plus settled funding (minus if paid)', render: (r) => U.pnlEl(U.num(r.realizedPnl) - U.num(r.feesAccruedUsd) - U.num(r.fundingAccruedUsd) - U.num(r.positionFeeAccruedUsd)) },
            { key: 'fund', label: 'Funding', num: true, title: 'Settled funding (negative = paid)', render: (r) => U.pnlEl(-U.num(r.fundingAccruedUsd)) },
            // trading fees alone, as Meridian's app shows Fees; the mPerp position fees in a column of their own
            { key: 'fees', label: 'Fees', num: true, title: 'Trading fees paid on the position\'s fills', render: (r) => U.fmtUsd(r.feesAccruedUsd) },
            { key: 'pfee', label: 'Position fee', num: true, title: 'mPerp position fees settled into the balance (the isolated markets charge them; Meridian\'s app has no column for them on closed positions). An open position\'s unsettled ones are in Net unrealized PnL under Open positions', render: (r) => (U.num(r.positionFeeAccruedUsd) ? U.fmtUsd(r.positionFeeAccruedUsd) : h('span.dim', '—')) },
            { key: 'created', label: 'Created', render: (r) => h('span.dim', U.fmtDateTimeS(r.createdAt)) },
            { key: 'closed', label: 'Closed', render: (r) => h('span.dim', U.num(r.size) !== 0 ? '—' : U.fmtDateTimeS(r.updatedAt)) },
          ],
        }));
      } else if (tt === 'transfers') {
        U.replace(ttBody, cursorTable({
          fetchPage: (cursor, n) => A.transfersPage(sid, cursor, n, cx), empty: 'No transfers yet',
          cols: [
            { key: 'type', label: 'Type', render: (r) => UI.chip(r.type, r.type === 'DEPOSIT' ? 'green' : r.type === 'WITHDRAW' ? 'red' : 'blue') },
            { key: 'token', label: 'Token', render: (r) => r.type === 'CONVERT' ? h('span', String(r.tokenName || ''), h('span.dim', ' → '), r.toTokenName) : r.tokenName },   // as text: an object in h()'s second place would be read as attributes
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
    let balSig = null, seriesStale = false, seriesGen = 0, reloadAt = 0, trailTries = 0;
    // the archive can trail the live balance briefly (or a range comes from the 60 s request cache): such a series is
    // reloaded on a later refresh, at most once a minute and three times per balance change (an account whose archive
    // never catches up, such as the exchange's fee account, would otherwise reload the whole range on every refresh)
    const trails = (s) => { const last = s.length ? s[s.length - 1] : null; return !last || !base || Math.abs(last.balance - base.acct.balance) > 0.01; };
    // every position of the account (A.positions): where a range's mPerp position-fee charges begin (AN.positionFeeFrom).
    // Read once, and again with a reloaded series (a close settles fees); a failed read is not kept
    let posList = null;
    const positionsList = (fresh) => {
      if (posList && !fresh) return posList;
      const p = (posList = A.positions(sid, { maxPages: 10, signal: cx.signal, ttl: fresh ? 0 : 60000 }));
      p.catch(() => { if (posList === p) posList = null; });
      return p;
    };
    async function reloadSeries() {
      if (Date.now() - reloadAt < 60000) return;
      reloadAt = Date.now();
      const r = range, gen = ++seriesGen;
      const s = await AN.loadSeries(sid, { start: AN.startFor(r, sa.createdAt), resolution: AN.resFor(r), signal: cx.signal, ttl: 0, charges: true, positions: positionsList(true) });
      if (cx.signal.aborted || gen !== seriesGen || r !== range) return;   // the range was switched meanwhile
      seriesCache.clear(); seriesCache.set(r, s); series = s;
      seriesStale = trails(s) && ++trailTries < 3;
      drawChart();
    }
    async function loadRange() {
      const res = AN.resFor(range);
      const start = AN.startFor(range, sa.createdAt);
      const key = range;
      if (seriesCache.has(key)) { series = seriesCache.get(key); loadingRange = false; drawChart(); return; }   // (a load still running for another range then ends without drawing)
      loadingRange = true; drawChart();
      let s;
      try {
        s = await AN.loadSeries(sid, { start, resolution: res, signal: cx.signal, ttl: 60000, charges: true, positions: positionsList() });
        seriesCache.set(key, s);
      } catch (e) { if (isAbort(e) || key !== range) return; series = null; chartBox.appendChild(h('div.overlay', 'History unavailable: ' + e.message)); loadingRange = false; return; }
      if (key !== range) return;   // another range was picked meanwhile: its own load draws the chart
      series = s;
      if (base && s.length && trails(s) && trailTries < 3) seriesStale = true;
      loadingRange = false; drawChart();
    }
    function drawChart() {
      U.$$('.overlay', chartBox).forEach((o) => o.remove());
      if (loadingRange || !series) { C.destroy(chartCanvas); chartBox.appendChild(h('div.overlay', h('span.loading', h('span.spinner'), 'Loading history…'))); return; }
      const res = A.RES[AN.resFor(range)];
      const start = AN.startFor(range, sa.createdAt);
      const nowT = Date.now();
      const live = base ? { upnl: base.acct.upnl, equity: base.acct.equity } : null;
      const ser = base ? AN.netLive(series, base.acct, res.ms) : series;   // every bucket on the live figures' basis (funding and position fees as charged)
      const stats = AN.intervalStats(ser, start, live, res.ms);
      const rows = ser.filter((b) => b.t >= start);
      const prev = ser.filter((b) => b.t < start).pop();
      const level = metric === 'balance' || metric === 'equity';
      const line = level || cumulative;
      let prevUp = prev ? prev.upnl : 0, acc = 0;
      // archive rows hold end-of-bucket values under the bucket's start: lines plot them at the bucket's end; bars keep
      // the start, they stand for the whole bucket
      const pts = line && (rows.length || prev) ? [{ x: prev ? Math.max(start, prev.t + res.ms) : start, y: level ? (prev ? prev[metric] : 0) : 0 }] : [];
      for (const b of rows) {
        let v;
        if (metric === 'pnl') { v = b.pnl + (b.upnl - prevUp); prevUp = b.upnl; }
        else if (metric === 'volume') v = b.volume;
        else if (metric === 'balance') v = b.balance;
        else if (metric === 'equity') v = b.equity;
        else if (metric === 'funding') v = b.fundingCharged != null ? b.fundingCharged : b.funding;
        else v = b.fee + (ser.posNetted ? b.posFeeCharged : b.posFee || 0);   // position fees as charged, as the PnL books them
        if (!level && cumulative) { acc += v; v = acc; }
        pts.push({ x: line ? Math.min(b.t + res.ms, nowT) : b.t, y: v });
      }
      const lastB = rows[rows.length - 1];
      const inProgress = !!lastB && lastB.t + res.ms > nowT;
      if (live && pts.length) {
        if (metric === 'equity') { if (inProgress) pts.pop(); pts.push({ x: nowT, y: live.equity }); }
        else if (metric === 'pnl') {
          const d = live.upnl - prevUp;   // the live net uPnL against the last bucket's: the line ends at the PnL tile, the bars add up to it
          if (cumulative) { if (inProgress) pts[pts.length - 1].y = acc + d; else pts.push({ x: nowT, y: acc + d }); }
          else if (inProgress) pts[pts.length - 1].y += d; else pts.push({ x: Math.floor(nowT / res.ms) * res.ms, y: d });
        }
      }
      const col = C.colors();
      const last = pts.length ? pts[pts.length - 1].y : 0;
      const color = metric === 'volume' ? col.blue : metric === 'fees' ? col.amber : metric === 'balance' || metric === 'equity' ? col.accent : last >= 0 ? col.green : col.red;
      const type = !level && !cumulative ? 'bar' : 'line';
      // without the funding history (unreadable) the funding figures are those settled into the balance
      const mLabel = metric === 'funding' && !ser.netted ? 'Funding settled' : METRICS.find((m) => m.v === metric).label;
      // the PnL line starts from 0 at the period's start (Meridian's P&L chart plots the running total since the account
      // opened, so its axis reads differently while the changes agree)
      const label = metric === 'pnl' && cumulative ? (range === 'all' ? 'PnL since the account opened' : 'PnL since the start of the period') : mLabel + (level ? '' : cumulative ? ' (cumulative)' : '');
      // the equity line is net of what was owed at each moment (AN.netLive), as the live equity; Meridian's chart is not
      const owedParts = [ser.netted ? 'funding' : null, ser.posNetted ? 'mPerp position fees' : null].filter(Boolean);
      const tooltipLabel = metric === 'equity' && owedParts.length ? (r) => ['Equity ' + U.fmtUsd(r.y), 'net of the ' + owedParts.join(' and '), 'charged and not settled then'] : undefined;
      cumBox.querySelector('input').disabled = level;
      // day bars are UTC days; line points are real instants and keep the local date and time
      C.timeSeries(chartCanvas, { points: pts, color, type, label, tooltipLabel, zero: true, signColors: metric === 'pnl' || metric === 'funding', xMin: rows.length ? Math.min(rows[0].t, start) : undefined, xMax: nowT, beginAtZero: metric === 'volume' || metric === 'fees', titleFmt: range === 'all' && !line ? U.fmtDayUTC : undefined });
      const rl = RANGES.find((r) => r.v === range).label;
      const fund = stats.fundingCharged != null ? stats.fundingCharged : stats.funding;
      // position fees as the PnL books them: charged in the period (settled or still owed) once their charges are read
      const pfee = stats.posFeesCharged != null ? stats.posFeesCharged : stats.posFees || 0;
      const win = WINDOW_NOTE[range];
      // what the PnL books, on the basis the charges allowed (unreadable charges leave that part as settled, and all of it
      // still owed falls on the period's end)
      const posBasis = ser.posNetted || !(Math.abs(stats.posFees || 0) > 0.005 || (base && base.acct.unsettledPositionFee > 0.005)) ? 'as charged' : 'as settled (all still owed counted at the end)';
      const pnlTip = `${win} Realized PnL less trading fees, plus funding ${ser.netted ? 'as charged' : 'as settled (all still owed counted at the end)'}, less mPerp position fees ${posBasis}, plus the change in price PnL of the open positions.`;
      U.replace(tiles,
        withTitle(UI.stat('PnL (' + rl + ')', U.fmtUsd(stats.pnl, { sign: true }), stats.roi != null ? 'ROI ' + U.fmtPct(stats.roi, { sign: true, dp: 1 }) : null, U.pnlClass(stats.pnl)), pnlTip),
        withTitle(UI.stat('Volume (' + rl + ')', U.fmtUsd(stats.volume)), win),
        UI.stat((stats.fundingCharged != null ? 'Funding (' : 'Funding settled (') + rl + ')', U.fmtUsd(fund, { sign: true }), null, U.pnlClass(fund)),
        withTitle(UI.stat('Fees (' + rl + ')', U.fmtUsd(stats.fees + pfee), Math.abs(pfee) > 0.005 ? U.fmtUsd(stats.fees) + ' trading · ' + U.fmtUsd(pfee) + ' position (mPerps)' : null),
          Math.abs(pfee) > 0.005 ? 'Trading fees, and the mPerp position fees ' + (stats.posFeesCharged != null ? 'charged in the period (settled into the balance or still owed)' : 'settled into the balance in the period') : null),
        UI.stat('Max drawdown (' + rl + ')', U.fmtDd(stats.ddPct), stats.ddUsd ? U.fmtUsd(stats.ddUsd) : null),
        UI.stat('Sharpe (' + rl + ')', U.ratioFmt(stats.sharpe), 'annualized · ' + ({ '24h': 'hourly', '7d': '2-hourly', '30d': '8-hourly', all: 'daily' })[range] + ' returns'));
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
    const posBody = h('div.scroll-y'), ordBody = h('div.scroll-y'), fillBody = h('div.feed.pause-hover'), book = h('div.book'), bookTitle = h('span.dim.small');
    const mktTrades = h('div.feed.pause-hover', UI.loading('Loading trades…')), mktTitle = h('span.dim.small');
    const mktFill = h('div.feed-fill', mktTrades);   // the market's trade tape fills whatever height the position / order / fill cards leave beside the book
    const mkSel = h('select.input.sm', { style: { width: 'auto' }, onchange: (e) => selectMarket(e.target.value) }, ref.active.map((p) => h('option', { value: p.ticker }, p.displayTicker)));
    // the book: the levels nearest the touch (top), every level (all), or every resting limit order with the account
    // that placed it (orders); the choice is this viewer's, remembered in this browser
    const BOOK_TOP = 12, BOOK_MODES = ['top', 'all', 'orders'];
    let bookMode = BOOK_MODES.includes(U.storage.get('md.book.mode', 'top')) ? U.storage.get('md.book.mode', 'top') : 'top';
    const bookSeg = UI.seg([
      { v: 'top', label: 'Top ' + BOOK_TOP, title: 'The ' + BOOK_TOP + ' price levels nearest the spread on each side' },
      { v: 'all', label: 'All levels', title: 'Every price level with a resting limit order, on both sides' },
      { v: 'orders', label: 'Orders', title: 'Every resting limit order on its own row, with the account that placed it' },
    ], bookMode, (v) => setBookMode(v), 'sm');
    // the note under the book: its text, and the Orders view's button, made once (a button made again on every tick
    // loses a click or the keyboard focus)
    const noteText = h('span'), again = h('button.btn.ghost.sm', { hidden: true, onclick: () => readOrders(true) }, 'Read all again');
    const bookNote = h('div.book-note.dim.xs', noteText, ' ', again);
    let bookHook = null;   // the book's render, once the book below is set up (the first reload runs before it)
    U.replace(el, h('div.live',
      h('div.stack',
        h('div.card.tight', h('div.card-head', h('h2', 'Open positions'), status, statusTxt), posBody),
        h('div.card.tight', h('div.card-head', h('h2', 'Orders & stops')), ordBody),
        h('div.card.tight', h('div.card-head', h('h2', 'Fills'), h('span.dim.small', 'live')), fillBody)),
      h('div.card.tight.feed-card', h('div.card-head', h('h2', 'Order book'), mkSel), h('div.book-bar', h('div.center', bookTitle), bookSeg, h('div.paused.hover', 'paused while hovering'), h('div.paused.focus', 'paused while a row has the focus')), h('div', { style: { flex: 'none' } }, book), bookNote,
        h('div.card-head', { style: { borderTop: '1px solid var(--border-2)', flex: 'none' } }, h('h2', 'Market trades'), mktTitle), mktFill)));

    const marks = {}; // ticker -> {mark, bid, ask}
    let positions = [], orders = [], fills = [];
    const prices = {};
    const renderPos = () => {
      const px = {};
      for (const p of positions) { const prod = ref.byId[p.productId]; const m = prod && marks[prod.ticker]; px[p.productId] = m ? { oraclePrice: m.mark } : prices[p.productId]; }
      const acct = AN.accountState({ balances: [], positions, ref, prices: px });
      AN.attachStops(acct.positions, orders);
      U.replaceLive(posBody, UI.table({
        cols: [
          { key: 'm', label: 'Symbol', render: (r) => UI.marketCell(r.ticker) },
          { key: 'side', label: 'Side', render: (r) => U.sideEl(r.long, true) },
          { key: 'size', label: 'Size', num: true, render: (r) => U.fmtQty(r.abs, r.prod.lotSize) },
          { key: 'entry', label: 'Entry', num: true, render: (r) => U.fmtPrice(r.entry, r.prod.tickSize) },
          { key: 'mark', label: 'Mark', num: true, render: (r) => (r.mark ? U.fmtPrice(r.mark, r.prod.tickSize) : '—') },
          { key: 'notional', label: 'Notional', num: true, render: (r) => U.fmtUsd(r.notional) },
          { key: 'upnl', label: 'Net unrealized PnL', num: true, title: UPNL_TITLE, render: (r) => U.pnlEl(r.net) },
          { key: 'tp', label: 'Take profit', num: true, render: (r) => exitCell(r, r.tp) },
          { key: 'sl', label: 'Stop loss', num: true, render: (r) => exitCell(r, r.sl) },
          { key: 'rpnl', label: 'Realized', num: true, title: RPNL_TITLE, render: (r) => U.pnlEl(r.realized) },
          { key: 'fund', label: 'Funding', num: true, title: FUND_TITLE, render: fundCell },
          { key: 'upd', label: 'Updated', render: (r) => h('span.dim', U.fmtAgo(r.p.updatedAt)) },
        ], rows: acct.positions, empty: 'No open positions',
      }));
    };
    const renderOrd = () => U.replaceLive(ordBody, UI.table({ cols: orderCols(ref), rows: U.sortBy(orders, (o) => o.createdAt, true), empty: 'No open orders or stops' }));
    const fillRow = (f, flash) => h('div.it', { class: flash ? 'flash' : '' }, h('span.t', U.fmtFeedTime(f.createdAt)), h('span.m', tickerOf(ref, f.productId)), U.sideEl(f.side), h('span.num', U.fmtQty(f.filled, lotOf(ref, f.productId)) + ' @ ' + U.fmtPrice(f.price, tickOf(ref, f.productId))), h('span.grow'), h('span.num.dim', U.fmtUsd(U.num(f.filled) * U.num(f.price))), h('span.xs.dim', f.isMaker ? 'maker' : 'taker'));
    const renderFills = () => U.replaceLive(fillBody, fills.length ? fills.slice(0, 40).map((f, i) => fillRow(f, f._new && i < 5)) : UI.empty('No fills yet'));

    async function reload() {
      try {
        const [p, o] = await Promise.all([A.openPositions(sid, cx), A.activeOrders(sid, cx)]);
        positions = p; orders = o;
        const pids = Array.from(new Set(positions.map((x) => x.productId)));
        if (pids.length) Object.assign(prices, await A.marketPrices(pids, { signal: cx.signal, ttl: 3000 }));
        renderPos(); renderOrd(); if (bookHook) bookHook();   // the book marks this account's own resting orders
      } catch (e) { if (!isAbort(e)) console.warn(e); }
    }
    // a busy account's events rarely leave a 500 ms lull, which a debounce waited for (20 s and more); a throttle reloads
    // at most every 3 s and still applies the last event
    const reloadThrottled = U.throttle(reload, 3000);
    try { const f = await A.fillsPage(sid, null, 30, cx); fills = f.rows; } catch (_) {}
    if (cx.signal.aborted) return;
    renderFills();
    await reload();
    if (cx.signal.aborted) return;   // the viewer left during the first loads: no subscription would ever be cleaned up

    // WS subscriptions
    let curMarket = null, unsubBook = null;
    const throttledPos = U.throttle(renderPos, 1000);
    cx.onCleanup(A.ws.onStatus((s) => { status.className = 'status-dot ' + (s === 'open' ? 'ok' : s === 'connecting' ? 'warn' : 'bad'); statusTxt.textContent = s === 'open' ? 'live' : s; }));
    for (const p of ref.active) cx.onCleanup(A.ws.subscribe('Ticker', p.ticker, (m) => { const d = m.data; marks[d.s] = { mark: U.num(d.markPx), bid: U.num(d.bidPx), ask: U.num(d.askPx) }; if (positions.some((x) => ref.byId[x.productId] && ref.byId[x.productId].ticker === d.s)) throttledPos(); if (d.s === curMarket) renderBook(); }));
    cx.onCleanup(A.ws.subscribe('PositionUpdate', sid, () => reloadThrottled()));
    cx.onCleanup(A.ws.subscribe('OrderUpdate', sid, () => reloadThrottled()));
    cx.onCleanup(A.ws.subscribe('OrderFill', sid, (m) => {
      const d = m.data || {}; const items = Array.isArray(d.d) ? d.d : [];
      for (const it of items) {
        const prod = ref.byTicker[it.s];
        fills.unshift({ id: it.id, orderId: it.oid, productId: prod ? prod.id : it.s, side: it.sd, filled: it.sz, price: it.px, feeUsd: it.fee, isMaker: it.m, type: it.typ, createdAt: it.t || d.t, _new: true });
      }
      fills = fills.slice(0, 100); renderFills(); reloadThrottled();
    }));

    // order book
    const bids = new Map(), asks = new Map();
    let lastBookT = null;
    // a socket that (re)opens re-subscribes, and the book's next message is a full snapshot. It carries the latest
    // update's pt and t, so after a gap of exactly one update it would still chain: start the chain afresh here
    cx.onCleanup(A.ws.onStatus((s) => { if (s === 'open') lastBookT = null; }));
    let bookLoaded = false;   // the current market's first L2Book message arrived (until then the book shows its loader)
    let centerNext = true;    // the next render of a full book scrolls the spread into the middle of its box
    // every resting limit order of every account (AN.restingOrders), read on request: the public book has no owners.
    // A full read asks every subaccount (one request each); a quick read asks again only the subaccounts that had orders
    // resting (a market maker re-quoting moves the book every few seconds)
    let l3 = null, l3Busy = null, l3Err = null, l3Progress = null, l3Tried = 0, l3FullTried = 0, l3WantFull = false;
    const L3_QUICK_MS = 5000, L3_FULL_MS = 60000;
    function readOrders(full = true) {
      // a full read asked for during another read runs after it
      if (l3Busy) { if (full) l3WantFull = true; return l3Busy; }
      if (!l3) full = true;
      l3Err = null; l3Tried = Date.now(); if (full) { l3WantFull = false; l3FullTried = l3Tried; l3Progress = [0, 0]; }
      again.disabled = true;
      l3Busy = (async () => {
        const subs = full ? await A.allSubaccounts({ signal: cx.signal }) : null;
        const owner = full ? new Map(subs.map((s) => [s.id, s.account])) : l3.owner;
        const ids = full ? subs.map((s) => s.id) : Array.from(new Set([sid, ...l3.orders.map((o) => o.sid), ...l3.failedIds]));
        if (full) { l3Progress = [0, ids.length]; renderNote(); }
        const res = await U.pLimit(ids.map((id) => () => A.openOrders(id, { signal: cx.signal })), 8, full ? (n) => { l3Progress = [n, ids.length]; renderNote(); } : null);
        if (cx.signal.aborted) return;
        const rows = [], failedIds = new Set(); let truncated = 0;
        res.forEach((r, i) => { if (!r.ok) { failedIds.add(ids[i]); return; } if (r.value.truncated) truncated++; rows.push(...r.value); });
        if (failedIds.size === ids.length && ids.length) throw new Error('no account\'s orders could be read');
        const fresh = AN.restingOrders(rows, (id) => owner.get(id)), now = Date.now();
        // the orders last known of the subaccounts it could not read stay (named in the note), and a quick read keeps
        // those of the subaccounts it did not ask
        const asked = new Set(ids);
        const kept = l3 ? l3.orders.filter((o) => failedIds.has(o.sid) || (!full && !asked.has(o.sid))) : [];
        l3 = full ? { at: now, fullAt: now, orders: kept.concat(fresh), owner, accounts: ids.length, failedIds, truncated, listCut: !!subs.truncated }
          : Object.assign({}, l3, { at: now, orders: kept.concat(fresh), failedIds, truncated: Math.max(l3.truncated, truncated) });
      })().catch((e) => { if (!isAbort(e)) l3Err = e; }).finally(() => {
        l3Busy = null; l3Progress = null; if (cx.signal.aborted) return;
        if (l3WantFull) readOrders(true); else renderBook();
      });
      return l3Busy;
    }
    function setBookMode(v) {
      if (!BOOK_MODES.includes(v)) return;
      bookMode = v; U.storage.set('md.book.mode', v); bookSeg.set(v);
      if (!bookHook) return;   // still loading: the book starts in this mode
      centerNext = true;
      if (v === 'orders' && (!l3 || Date.now() - l3.fullAt > L3_FULL_MS)) readOrders(true);
      renderBook();
    }
    const sideWord = (s) => (s === 'a' ? 'sell' : 'buy');
    // this account's resting orders as of its last reload (OrderUpdate), in place of the read's: they are fresher
    const ordersNow = () => (l3 ? l3.orders.filter((o) => o.sid !== sid).concat(AN.restingOrders(orders, () => sa.account || st.addr)) : []);
    const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
    const setNote = (text, button) => { noteText.textContent = text; again.hidden = !button; again.disabled = !!l3Busy; };
    function renderNote() {
      const prod = ref.byTicker[curMarket];
      if (!prod || !bookLoaded) { setNote('', false); return; }
      const na = Array.from(asks.values()).filter((q) => q > 0).length, nb = Array.from(bids.values()).filter((q) => q > 0).length;
      if (bookMode === 'top') {
        setNote(na > BOOK_TOP || nb > BOOK_TOP ? `The ${BOOK_TOP} levels nearest the spread on each side, of ${plural(na, 'ask', 'asks')} and ${plural(nb, 'bid', 'bids')}` : `Every level: ${plural(na, 'ask', 'asks')} and ${plural(nb, 'bid', 'bids')}`, false);
        return;
      }
      if (bookMode === 'all') { setNote(`Every price level with a resting limit order: ${plural(na, 'ask', 'asks')} and ${plural(nb, 'bid', 'bids')}`, false); return; }
      // the page opened on Orders (the remembered choice): the first read starts with the first book the viewer sees
      if (!l3 && !l3Busy && !l3FullTried && !document.hidden) readOrders(true);
      const reading = l3Progress ? `${l3 ? 'reading all subaccounts again' : 'Reading every account\'s working orders'}… ${l3Progress[0]} of ${l3Progress[1] || '?'}` : null;
      if (reading && !l3) { setNote(reading, false); return; }
      if (!l3) { setNote(l3Err ? 'The orders could not be read (' + (l3Err.message || l3Err) + ').' : l3Busy ? 'Reading every account\'s working orders…' : '', !!l3Err || !l3Busy); return; }
      const list = ordersNow(), here = list.filter((o) => o.productId === prod.id);
      const owners = new Set(here.map((o) => o.account || o.sid)).size, nf = l3.failedIds.size;
      const ck = AN.bookCheck(asks, bids, list, prod.id), live = na + nb;
      const parts = [`${plural(here.length, 'resting limit order', 'resting limit orders')} from ${plural(owners, 'account', 'accounts')}: `
        + `${nf ? (l3.accounts - nf) + ' of ' + l3.accounts : 'all ' + l3.accounts} subaccounts read at ${U.fmtTime(l3.fullAt)}`
        + (l3.at > l3.fullAt ? `, those with orders again at ${U.fmtTime(l3.at)}` : '')];
      parts.push(!live && !here.length ? 'the live book is empty'
        : !ck.differ.length ? `they add up to the live book at ${live === 1 ? 'its one level' : 'all ' + live + ' levels'}`
        : `${plural(ck.differ.length, 'price level differs', 'price levels differ')} from the live book (orders placed, changed, filled or canceled since)`);
      if (nf) parts.push(`${plural(nf, 'subaccount', 'subaccounts')} could not be read: ${nf === 1 ? 'its' : 'their'} orders as last read`);
      if (l3.truncated) parts.push(`${l3.truncated === 1 ? '1 subaccount has' : l3.truncated + ' subaccounts have'} more than 1,000 working orders: only the first 1,000 are here`);
      if (l3.listCut) parts.push('the subaccount list was cut short');
      if (l3Err) parts.push('the last read failed (' + (l3Err.message || l3Err) + ')');
      if (reading) parts.push(reading);
      setNote(parts.join(' · ') + '.', true);
      // the book moved on: ask the subaccounts with orders again (every 5 s at most), and every subaccount once a minute
      // at most (a new account's orders); never while the tab is hidden. A failed read counts as a read
      if (ck.differ.length && !l3Busy && !document.hidden) {
        const now = Date.now();
        if (now - Math.max(l3.fullAt, l3FullTried) > L3_FULL_MS) readOrders(true);
        else if (now - Math.max(l3.at, l3Tried) > L3_QUICK_MS) readOrders(false);
      }
    }
    function renderBook() {
      const prod = ref.byTicker[curMarket]; if (!prod || !bookLoaded) return;
      const tick = prod.tickSize, lot = prod.lotSize, unit = baseOf(prod), full = bookMode !== 'top', byOrder = bookMode === 'orders' && !!l3;
      book.classList.toggle('full', full); book.classList.toggle('pause-hover', byOrder);
      const all = (m, asc) => Array.from(m.entries()).filter(([, q]) => q > 0).sort((x, y) => (asc ? x[0] - y[0] : y[0] - x[0]));
      const a = all(asks, true), b = all(bids, false);
      // this account's own resting orders, by side and price (marked on their levels)
      const own = AN.ordersAtLevels(AN.restingOrders(orders), prod.id);
      const m = marks[curMarket];
      // the centre as Meridian's book shows it: the mid price, the mark (its oracle price) beside it, the spread at 2 dp
      const bm = AN.bookMid(a.length ? a[0][0] : null, b.length ? b[0][0] : null);
      const mid = h('div.mid', h('span.bold', { title: 'Mid price: (best bid + best ask) ÷ 2, the centre of Meridian\'s order book' }, bm.mid != null ? U.fmtPrice(bm.mid, tick) : '—'),
        m && m.mark ? h('span.dim.xs', { title: 'Mark price (the oracle price Meridian\'s app shows beside the mid), which open positions are valued at' }, '  mark ' + U.fmtPrice(m.mark, tick)) : null,
        h('span.dim.xs', bm.spreadPct != null ? '  spread ' + U.fmtPct(bm.spreadPct, { dp: 2 }) : ''));
      let head, upper, lower;
      if (byOrder) {
        // one row per order; within a price the oldest sits nearest the spread. The bar is the order's USD value
        // against the largest order on this market
        const list = ordersNow().filter((o) => o.productId === prod.id);
        const sellO = list.filter((o) => o.side === 'a').sort((x, y) => y.price - x.price || y.createdAt - x.createdAt);
        const buyO = list.filter((o) => o.side === 'b').sort((x, y) => y.price - x.price || x.createdAt - y.createdAt);
        const maxUsd = Math.max(1e-9, ...list.map((o) => o.qty * o.price));
        const tip = (o) => `${sideWord(o.side)} ${U.fmtQty(o.qty, lot)} ${unit} at ${U.fmtPrice(o.price, tick)} (${U.fmtUsd(o.qty * o.price)})`
          + (o.createdAt ? ' · placed ' + U.fmtDateTime(o.createdAt) : '') + (o.expiresAt ? ' · expires ' + U.fmtDateTime(o.expiresAt) : '')
          + (o.postOnly ? ' · post-only' : '') + (o.reduceOnly ? ' · reduce-only' : '') + (o.account ? ' · account ' + o.account : '') + ' · subaccount ' + o.sid;
        const who = (o) => (o.sid === sid ? h('span.own', 'this account') : o.account ? h('a', { href: U.accountUrl(o.account, o.sid, 'live') }, U.shortAddr(o.account, 4)) : h('span.dim', '—'));
        const row = (o) => h('div.lvl.ord', { class: (o.side === 'a' ? 'ask' : 'bid') + (o.sid === sid ? ' mine' : ''), title: tip(o) },
          h('i', { style: { width: ((o.qty * o.price) / maxUsd) * 100 + '%' } }), h('span', U.fmtPrice(o.price, tick)), h('span', U.fmtQty(o.qty, lot)), h('span', who(o)), h('span', o.createdAt ? U.fmtAgo(o.createdAt).replace(' ago', '') : '—'));
        head = h('div.hdr.ord', h('span', 'Price'), h('span', 'Size (' + unit + ')'), h('span', 'Account'), h('span', 'Age'));
        upper = sellO.length ? sellO.map(row) : [h('div.book-empty', 'No resting sell orders')];
        lower = buyO.length ? buyO.map(row) : [h('div.book-empty', 'No resting buy orders')];
      } else {
        const ta = full ? a : a.slice(0, BOOK_TOP), tb = full ? b : b.slice(0, BOOK_TOP);
        // Total as Meridian's book shows it by default: the size from the touch out to this level, in the base asset, at
        // its lot size; the levels' USD value (each at its own price) is the row's tooltip, and the bars follow the size
        const rowsA = AN.bookDepth(ta).map((r) => Object.assign(r, { side: 'a' })), rowsB = AN.bookDepth(tb).map((r) => Object.assign(r, { side: 'b' }));
        const max = Math.max(rowsA.length ? rowsA[rowsA.length - 1].c : 0, rowsB.length ? rowsB[rowsB.length - 1].c : 0, 1e-9);
        const lvl = (r) => {
          const mineQ = own[r.side].get(r.p);
          return h('div.lvl', { class: (r.side === 'a' ? 'ask' : 'bid') + (mineQ ? ' mine' : ''), title: `From the touch to this level: ${U.fmtQty(r.c, lot)} ${unit}, worth ${U.fmtUsd(r.usd)} (each level at its own price)` + (mineQ ? `\nThis account: ${U.fmtQty(mineQ, lot)} of the ${U.fmtQty(r.q, lot)} at this price` : '') },
            h('i', { style: { width: (r.c / max) * 100 + '%' } }), h('span', U.fmtPrice(r.p, tick)), h('span', U.fmtQty(r.q, lot)), h('span', U.fmtQty(r.c, lot)));
        };
        head = h('div.hdr', h('span', 'Price'), h('span', 'Size (' + unit + ')'), h('span', { title: 'The size from the touch out to the level, as Meridian\'s order book shows it; hover a level for its USD value' }, 'Total (' + unit + ')'));
        upper = rowsA.length ? rowsA.slice().reverse().map(lvl) : [h('div.book-empty', 'No asks')];
        lower = rowsB.length ? rowsB.map(lvl) : [h('div.book-empty', 'No bids')];
      }
      // a full book scrolls in its own box: keep the spread where the viewer left it while levels come and go above it
      const oldMid = full && !centerNext ? book.querySelector('.mid') : null;
      const off = oldMid ? oldMid.offsetTop - book.scrollTop : null;
      U.replaceLive(book, head, upper, mid, lower);
      if (full && book.contains(mid)) {
        if (centerNext) { book.scrollTop = Math.max(0, mid.offsetTop - (book.clientHeight - mid.offsetHeight) / 2); centerNext = false; }
        else if (off != null) book.scrollTop = Math.max(0, mid.offsetTop - off);
      }
      bookTitle.textContent = prod.displayTicker + ' · mid ' + (bm.mid != null ? U.fmtPrice(bm.mid, tick) : '—') + ' · mark ' + (m && m.mark ? U.fmtPrice(m.mark, tick) : '—');
      renderNote();
    }
    bookHook = renderBook;
    const onShow = () => { if (!document.hidden && bookMode === 'orders') renderBook(); };
    document.addEventListener('visibilitychange', onShow);
    cx.onCleanup(() => document.removeEventListener('visibilitychange', onShow));
    let unsubTrades = null, mktRows = [];
    const mktRow = (t, flash) => h('div.it', { class: (flash ? 'flash ' : '') + (t.mine ? 'mine' : '') }, h('span.t', U.fmtFeedTime(t.t)), U.sideEl(t.side), h('span.num', U.fmtQty(t.size, t.lot) + ' @ ' + U.fmtPrice(t.price, t.tick)), h('span.grow'), h('span.num.dim', U.fmtUsd(U.num(t.size) * U.num(t.price))), t.mine ? UI.chip(t.mine, 'accent') : null);
    const renderMkt = () => U.replaceLive(mktTrades, mktRows.length ? mktRows.slice(0, 80).map((t, i) => mktRow(t, t._new && i < 5)) : UI.empty('No trades yet'));
    function selectMarket(ticker) {
      if (unsubBook) unsubBook();
      if (unsubTrades) unsubTrades();
      curMarket = ticker; bids.clear(); asks.clear(); lastBookT = null; mkSel.value = ticker; bookLoaded = false; centerNext = true;
      book.classList.remove('full', 'pause-hover'); U.replace(book, UI.loading('Loading order book…')); noteText.textContent = ''; again.hidden = true;
      const prod = ref.byTicker[ticker];
      mktRows = []; U.replace(mktTrades, UI.loading('Loading trades…')); mktTitle.textContent = prod ? prod.displayTicker + ' · all accounts' : '';
      if (prod) {
        A.trades(prod.id, 40, cx).then((rows) => { if (curMarket !== ticker) return; mktRows = U.sortBy(rows.map((r) => ({ id: r.id, t: r.createdAt, tick: prod.tickSize, lot: prod.lotSize, side: r.takerSide, size: r.filled, price: r.price })).concat(mktRows.filter((x) => !rows.some((r) => r.id === x.id))), (t) => t.t, true); renderMkt(); }).catch(() => { if (curMarket === ticker) renderMkt(); });
        unsubTrades = A.ws.subscribe('TradeFill', ticker, (m) => {
          const d = m.data || {};
          for (const it of d.d || []) { const sids = it.sids || []; const mine = sids[0] === sa.id ? 'this account · taker' : sids[1] === sa.id ? 'this account · maker' : null; mktRows.unshift({ id: it.id, t: d.t || m.t, tick: prod.tickSize, lot: prod.lotSize, side: it.sd, size: it.sz, price: it.px, mine, _new: true }); }
          mktRows = mktRows.slice(0, 200); renderMkt();
        });
      }
      unsubBook = A.ws.subscribe('L2Book', ticker, (m) => {
        const d = m.data || {};
        // each delta's pt is the previous message's t; one that does not chain is the full snapshot sent on (re)subscribe,
        // e.g. after a reconnect: drop the old levels first
        if (d.pt !== lastBookT) { bids.clear(); asks.clear(); }
        lastBookT = d.t;
        for (const [p, q] of d.a || []) { const qq = U.num(q); if (qq === 0) asks.delete(U.num(p)); else asks.set(U.num(p), qq); }
        for (const [p, q] of d.b || []) { const qq = U.num(q); if (qq === 0) bids.delete(U.num(p)); else bids.set(U.num(p), qq); }
        bookLoaded = true; renderBook();
      });
      cx.onCleanup(() => { if (unsubBook) unsubBook(); if (unsubTrades) unsubTrades(); });
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
    const posP = A.positions(sid, { maxPages: 10, signal: cx.signal, ttl: 60000 });   // also where the position-fee charges begin
    const [positions, fills, series, balances, openPos] = await Promise.all([
      posP,
      A.fills(sid, { maxPages: 5, signal: cx.signal }).catch(() => []),
      AN.loadSeries(sid, { start: AN.startFor('all', sa.createdAt), resolution: 'day1', signal: cx.signal, ttl: 60000, charges: true, positions: posP }),
      A.balances(sid, cx), A.openPositions(sid, cx),
    ]);
    const pids = Array.from(new Set(openPos.map((p) => p.productId)));
    const prices = pids.length ? await A.marketPrices(pids, cx) : {};
    const acct = AN.accountState({ balances, positions: openPos, ref, prices });
    const ps = AN.positionStats(positions, ref);
    const ser = AN.netLive(series, acct, U.DAY);   // every day on the live figures' basis (funding and position fees as charged)
    const is = AN.intervalStats(ser, AN.startFor('all', sa.createdAt), { upnl: acct.upnl, equity: acct.equity }, U.DAY);
    const fundAll = is.fundingCharged != null ? is.fundingCharged : is.funding - acct.unsettledFunding;   // settled + still unsettled on open positions, + = received
    // as charged (settled or still owed), as the Overview's Fees tile and this tab's PnL have them; settled only where the
    // charges could not be read
    const posFees = is.posFeesCharged != null ? is.posFeesCharged : is.posFees || 0;
    const dwDp = Math.max(is.deposits, is.withdrawals) >= 1000 ? 0 : 2;   // one precision for both numbers in the tile
    const makerN = fills.filter((f) => f.isMaker).length;
    const m = (k, v, s, cls) => UI.metric(k, v, s, cls);
    const grid = h('div.metric-list',
      m('Total PnL (all time)', U.fmtUsd(is.pnl, { sign: true }), 'incl. unrealized', U.pnlClass(is.pnl)),
      m('ROI', is.roi != null ? U.fmtPct(is.roi, { sign: true, dp: 1 }) : '—', 'on deposits + starting equity', U.pnlClass(is.roi)),
      m('Win rate', ps.winRate != null ? U.fmtPct(ps.winRate, { dp: 1 }) : '—', `${ps.wins}W / ${ps.losses}L of ${ps.closed.length} closed`),
      m('Profit factor', ps.profitFactor == null ? '—' : ps.profitFactor === Infinity ? '∞' : U.fmtNum(ps.profitFactor, 2), 'net wins ÷ net losses'),
      m('Expectancy', ps.expectancy != null ? U.fmtUsd(ps.expectancy, { sign: true }) : '—', 'avg net per closed position', U.pnlClass(ps.expectancy)),
      m('Avg win / loss', (ps.avgWin != null ? U.fmtUsd(ps.avgWin) : '—') + ' / ' + (ps.avgLoss != null ? U.fmtUsd(ps.avgLoss) : '—')),
      m('Largest win / loss', (ps.largestWin != null ? U.fmtUsd(ps.largestWin) : '—') + ' / ' + (ps.largestLoss != null ? U.fmtUsd(ps.largestLoss) : '—')),
      m('Sharpe (daily, annualized)', U.ratioFmt(is.sharpe)),
      m('Max drawdown (all time)', U.fmtDd(is.ddPct), is.ddUsd ? U.fmtUsd(is.ddUsd) : null, is.ddPct > 30 ? 'neg' : ''),
      m('Trading style', ps.style, ps.avgDuration != null ? 'avg hold ' + U.fmtDuration(ps.avgDuration) : 'no closed positions'),
      m('Long / short', `${ps.longs} / ${ps.shorts}`, 'positions'),
      m('Positions', String(ps.count) + (positions.truncated ? '+' : ''), `${ps.open.length} open · ${ps.liquidated} liquidated`),
      m('Volume (all time)', U.fmtUsd(is.volume, { compact: true })),
      m('Fees paid', U.fmtUsd(is.fees + posFees), (Math.abs(posFees) > 0.005 ? 'incl. ' + U.fmtUsd(posFees) + (is.posFeesCharged != null ? ' position fees charged (settled or still owed)' : ' position fees') + (fills.length ? ' · ' : '') : '') + (fills.length ? `${U.fmtPct((makerN / fills.length) * 100, { dp: 0 })} maker of last ${fills.length} fills` : '') || null),
      m('Funding (net)', U.fmtUsd(fundAll, { sign: true }), 'positive = received · incl. unsettled on open positions', U.pnlClass(fundAll)),
      m('Deposits / withdrawals', U.fmtUsd(is.deposits, { compact: true, dp: dwDp }) + ' / ' + U.fmtUsd(is.withdrawals, { compact: true, dp: dwDp }), is.withdrawals ? 'withdrawals incl. fees' : null));

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
    // what a day's bar holds, on the basis the charges allowed, and how Meridian's P&L calendar differs
    const posCharged = ser.posNetted || !(Math.abs(is.posFees || 0) > 0.005 || acct.unsettledPositionFee > 0.005);   // (none at all reads the same)
    const dayNote = 'UTC days: realized PnL less trading fees, '
      + (ser.netted && posCharged ? 'funding and mPerp position fees on the day they are charged' : `funding on the day it ${ser.netted ? 'is charged' : 'settles'}, mPerp position fees on the day they ${posCharged ? 'are charged' : 'settle'}`)
      + ', plus the change in price PnL; today\'s bar ends at the live figures. Meridian\'s P&L calendar dates each day in your local time, counts funding when it settles and leaves position fees out.';
    U.replace(el, h('div.stack', grid, h('div.row', { style: { marginTop: '-8px' } }, h('span.grow'), MD.defsLink()),
      h('div.grid.cols-2', h('div.card', h('h3', { style: { marginBottom: '10px' } }, 'Cumulative PnL'), h('div.chart-box.sm', c1)), h('div.card', h('h3', { style: { marginBottom: '10px' } }, 'Daily PnL'), h('div.chart-box.sm', c2), h('div.chart-note', dayNote))),
      h('div.grid.cols-2.wl', UI.card('By market', perMarket), h('div.card.chart-fill', h('h3', { style: { marginBottom: '10px', flex: 'none' } }, 'Net PnL by market (closed)'), h('div.chart-box.sm', c3))),
      positions.truncated ? h('div.notice', 'Only the most recent 2,000 positions were analysed.') : null));
    const start = AN.startFor('all', sa.createdAt);
    const rows = ser.filter((b) => b.t >= start);
    const prevB = ser.filter((b) => b.t < start).pop(); const nowT = Date.now();
    // each day's value is reached at its end (the line plots it there); the daily bars stand for the whole UTC day
    let acc = 0, prevUp = prevB ? prevB.upnl : 0; const cum = [{ x: start, y: 0 }], daily = [];
    for (const b of rows) { const v = b.pnl + (b.upnl - prevUp); prevUp = b.upnl; acc += v; cum.push({ x: Math.min(b.t + U.DAY, nowT), y: acc }); daily.push({ x: b.t, y: v }); }
    const dLive = acct.upnl - prevUp; acc += dLive;   // the line ends at Total PnL (all time) and the bars add up to it
    const lastB = rows[rows.length - 1];
    if (lastB && lastB.t + U.DAY > nowT) { cum[cum.length - 1].y = acc; daily[daily.length - 1].y += dLive; } else { cum.push({ x: nowT, y: acc }); daily.push({ x: Math.floor(nowT / U.DAY) * U.DAY, y: dLive }); }
    const col = C.colors();
    C.timeSeries(c1, { points: cum, color: acc >= 0 ? col.green : col.red, label: 'PnL', xMax: nowT });   // real instants: local date and time
    C.timeSeries(c2, { points: daily, type: 'bar', color: col.accent, signColors: true, label: 'PnL', xMax: nowT, titleFmt: U.fmtDayUTC });
    const closedMk = ps.byMarket.filter((r) => r.closed > 0);   // a market with only an open position has no closed result to show
    C.bars(c3, closedMk.map((r) => r.ticker), closedMk.map((r) => r.pnl), { horizontal: true });
  }

  /** One line on the Overview: the account's Predict result, the same figures as its Predict tab, loaded after the page.
   *  Nothing when the account has no Predict activity or its Predict wallet cannot be looked up. */
  async function predictGlance(slot, st, cx) {
    const P = MD.predict;
    const r = await P.wallets.predictAddress(st.addr, { signal: cx.signal });
    if (cx.signal.aborted || r.error || r.active === false) return;
    const x = await P.walletHeadline(r.address, cx);
    if (cx.signal.aborted || !x) return;
    const F = x.F; const n = x.agg ? x.agg.n : x.mine.length;
    const sep = () => h('span.dim.small', '·');
    const dp = (v) => (Math.abs(U.num(v)) >= 100 ? { dp: 0 } : {});   // as on the Predict tab: whole dollars from $100
    const toTab = h('a.small', { href: U.accountUrl(st.addr, st.sa.id, 'predict'), title: 'Open the Predict tab', onclick: (e) => { if (st.showTab) { e.preventDefault(); st.showTab('predict'); } } }, 'Predict tab →');
    U.replace(slot, UI.chip('Predict', 'accent'),
      h('span.small', h('span.dim', x.isMaker ? (x.marketMaker ? 'Maker PnL ' : 'Counterparty PnL ') : 'Net PnL '), U.pnlEl(F.pnl, dp(F.pnl))), sep(),
      h('span.small', `${U.fmtNum(n, 0)} prediction${n === 1 ? '' : 's'} · ${U.fmtNum(F.won || 0, 0)}W / ${U.fmtNum(F.lost || 0, 0)}L` + (F.open ? ` · ${U.fmtNum(F.open, 0)} open` : '')),
      F.unclaimedWon && !x.isMaker ? [sep(), h('span.small.pos', `${U.fmtUsd(F.unclaimedPayout, dp(F.unclaimedPayout))} to claim`)] : null,
      sep(), toTab);
    slot.title = 'Meridian Predict, from ' + (r.via ? 'this account\'s Predict wallet ' + r.via + ' (the smart account the Meridian app places its predictions from)' : r.address);
  }

  // =====================================================================
  // Predict (same view as #/predict/bettor, inline)
  // =====================================================================
  // Predictions are not placed from the perps address: the Meridian app places them through a smart account the
  // address owns (its Predict wallet, js/predict/wallets.js), so the tab shows that wallet.
  async function mountPredict(el, st, cx) {
    const wrap = h('div', UI.loading('Finding this account\'s Predict wallet…'));
    const who = h('span.dim.small');
    const openBtn = h('a.btn.sm.ghost', { href: '#/predict/bettor?address=' + encodeURIComponent(st.addr) }, U.icon('external'), 'Open in Predict section');
    U.replace(el, h('div.stack', h('div.row.wrap', { style: { gap: '6px' } }, who, h('span.grow'), openBtn), wrap));
    const r = await MD.predict.wallets.predictAddress(st.addr, { signal: cx.signal });
    if (cx.signal.aborted) return;
    openBtn.href = '#/predict/bettor?address=' + encodeURIComponent(r.address);
    if (r.error) U.replace(who, h('span.small', { style: { color: 'var(--amber)' } }, 'Could not look up this account\'s Predict wallet (the Robinhood Chain RPC did not answer): showing predictions placed from the address itself.'));
    else if (r.via) U.replace(who, 'Predict wallet ', h('a.addr', { href: '#/predict/bettor?address=' + r.via, title: r.via }, U.shortAddr(r.via, 6)), U.copyBtn(r.via), ' · the smart account this address controls; the Meridian app places its predictions from it',
      r.also ? h('span', { style: { color: 'var(--amber)' } }, ' · the address itself has predictions of its own too: ', h('a.addr', { href: '#/predict/bettor?address=' + r.also, title: r.also }, U.shortAddr(r.also, 4))) : null);
    else U.replace(who, 'Meridian Predict activity of this address');
    await MD.predict.renderBettor(wrap, r.address, cx, { embedded: true });
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
      // Total points as Meridian's points page: trading plus referral points (the API keeps them apart), the split under it
      const tp = U.num(s.totalPoints), rp = U.num(s.referralPoints);
      cards.push(h('div.card', h('div.row', { style: { marginBottom: '12px' } }, h('h2', 'Season ' + s.season), UI.chip('Tier ' + (s.tier != null ? s.tier : '—'), 'accent'), h('span.grow'), h('span.dim.small', 'updated ' + U.fmtAgo(s.updatedAt))),
        h('div.stats', UI.stat('Rank', s.rank ? '#' + s.rank : '—', s.previousRank > 0 && s.previousRank !== s.rank ? 'was #' + s.previousRank : null),
          withTitle(UI.stat('Total points', U.fmtNum(tp + rp, 0), U.fmtNum(tp, 0) + ' trading · ' + U.fmtNum(rp, 0) + ' referral'), 'Trading points plus referral points, as Meridian\'s points page shows the total'),
          withTitle(UI.stat('Share of season', share != null ? U.fmtPct(share, { dp: 4 }) : '—', total ? 'of ' + U.fmtCompact(total.totalPoints) + ' distributed' : null), 'This address\'s trading points ÷ all trading points distributed in the season (referral points left out of both)')),
        h('h3', { style: { margin: '16px 0 8px' } }, 'Points by epoch'), epochs, h('div.chart-note', 'Trading plus referral points per epoch, as Meridian\'s points history shows them')));
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
        C.bars(cv, pts.map((p) => 'E' + p.epoch), pts.map((p) => p.points + p.ref), { fmt: (v) => U.fmtNum(v, 0) + ' pts', axisFmt: (v) => U.fmtCompact(v) });
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
