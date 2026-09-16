/* MeridianData — Leaderboard: every subaccount, ranked, with a client-side build engine + cache */
(function () {
  const MD = window.MD; const U = MD.util; const A = MD.api; const AN = MD.analytics; const UI = MD.ui; const h = U.h;
  const KEY = 'md.lb.v3';
  const INTERVALS = [{ v: '24h', label: '24h' }, { v: '7d', label: '7d' }, { v: '30d', label: '30d' }, { v: 'all', label: 'All' }];
  const STYLES = ['Scalper', 'Intraday', 'Swing', 'Long-term'];
  const PAGE = 25;
  let building = null;

  const P = (MD.router.pages.leaderboard = {
    _remote: undefined, _remoteAt: 0,
    /** newest of: local build (localStorage / memory) and the published snapshot (data/leaderboard.json) */
    cache() {
      const all = [U.storage.get(KEY, null), P._mem, P._remote].filter((c) => c && Array.isArray(c.rows));
      return all.sort((a, b) => b.builtAt - a.builtAt)[0] || null;
    },
    /** Fetch the snapshot published next to the site (built by GitHub Actions); resolves null if absent. Re-checks at most once a minute unless forced. */
    async loadRemote(force) {
      if (!force && P._remote !== undefined && Date.now() - P._remoteAt < 60000) return P._remote;
      try {
        const r = await fetch('data/leaderboard.json', { cache: 'no-cache' });
        const j = r.ok ? await r.json() : null;
        if (j && Array.isArray(j.rows)) P._remote = Object.assign(j, { remote: true });
        else if (P._remote === undefined) P._remote = null;
      } catch (_) { if (P._remote === undefined) P._remote = null; }
      P._remoteAt = Date.now();
      return P._remote;
    },
    async mount(root, route, ctx) {
      MD.setTopbar(h('span.title', 'Leaderboard'));
      await P.loadRemote();
      const state = { interval: route.params.interval || '30d', sort: { key: 'pnl', desc: true }, page: 1, q: '', favOnly: false, style: '', min: {}, max: {} };
      const tableWrap = h('div');
      const progress = h('div');
      const filters = h('div');
      const summary = h('span.dim.small');
      const updateBtn = h('button.btn.sm', { onclick: () => build(true) }, U.icon('refresh'), 'Update');
      U.replace(root, h('div.page', h('div.lb', h('div.stack', h('div.row', summary, h('span.grow'), h('span.dim.small', 'PnL, ROI, Sharpe and drawdown follow the selected interval'), updateBtn), progress, h('div.card.tight', tableWrap)), h('div.card.filters', filters))));
      ctx.onCleanup(U.on('favorites', () => renderTable()));

      const numInput = (k, which, ph) => h('input.input.sm', { type: 'number', placeholder: ph || which, value: state[which][k] ?? '', oninput: (e) => { const v = e.target.value; if (v === '') delete state[which][k]; else state[which][k] = U.num(v); state.page = 1; renderTable(); } });
      const minmax = (k, unit) => h('div.minmax', h('div.row', numInput(k, 'min', 'Min'), h('span.dim.xs', unit)), h('div.row', numInput(k, 'max', 'Max'), h('span.dim.xs', unit)));
      const fld = (label, el) => h('div', { style: { marginBottom: '10px' } }, h('label.lbl', label), el);
      function renderFilters() {
        U.replace(filters,
          h('div.row', h('h2', 'Filters'), h('span.grow'), h('button.btn.sm.ghost', { onclick: () => { state.q = ''; state.favOnly = false; state.style = ''; state.min = {}; state.max = {}; state.page = 1; renderFilters(); renderTable(); } }, 'Reset all')),
          h('div', { style: { marginTop: '10px' } }, h('input.input', { placeholder: 'Search by address', value: state.q, oninput: (e) => { state.q = e.target.value.trim().toLowerCase(); state.page = 1; renderTable(); } })),
          h('div', { style: { marginTop: '10px' } }, UI.seg([{ v: 'all', label: 'All' }, { v: 'fav', label: '★ Favorites' }], state.favOnly ? 'fav' : 'all', (v) => { state.favOnly = v === 'fav'; state.page = 1; renderTable(); })),
          h('div.sec', h('h3', 'Interval'), UI.seg(INTERVALS, state.interval, (v) => { state.interval = v; state.page = 1; MD.router.setParams({ interval: v }, { silent: true }); renderTable(); })),
          h('div.sec', h('h3', 'Account metrics'), fld('Equity', minmax('equity', '$')), fld('Volume', minmax('volume', '$')), fld('PnL', minmax('pnl', '$')),
            fld('Trading style', h('select.input.sm', { onchange: (e) => { state.style = e.target.value; state.page = 1; renderTable(); } }, h('option', { value: '' }, 'All'), STYLES.map((s) => h('option', { value: s, selected: state.style === s }, s))))),
          h('div.sec', h('h3', 'Performance metrics'), fld('ROI', minmax('roi', '%')), fld('Win rate', minmax('winRate', '%')), fld('Sharpe ratio', minmax('sharpe', '')), fld('Max drawdown', minmax('ddPct', '%'))),
          h('div.sec.small.dim', 'Built in your browser from the public Meridian API. Snapshots are cached locally; press Update to rebuild.'));
      }
      renderFilters();

      function rowsFiltered(data) {
        const iv = state.interval;
        const favs = new Set(U.favorites.list().map((f) => f.subaccountId));
        const val = (r, k) => { const s = r.stats && r.stats[iv]; switch (k) { case 'equity': return r.equity; case 'volume': return s ? s.volume : 0; case 'pnl': return s ? s.pnl : 0; case 'roi': return s ? s.roi : null; case 'sharpe': return s ? s.sharpe : null; case 'ddPct': return s ? s.ddPct : null; case 'winRate': return r.winRate; case 'positions': return r.positionsCount; case 'style': return STYLES.indexOf(r.style); case 'account': return r.account; default: return null; } };
        let rows = data.rows.slice();
        if (state.q) rows = rows.filter((r) => r.account.includes(state.q) || r.sid.includes(state.q));
        if (state.favOnly) rows = rows.filter((r) => favs.has(r.sid));
        if (state.style) rows = rows.filter((r) => r.style === state.style);
        for (const k of Object.keys(state.min)) rows = rows.filter((r) => { const v = val(r, k); return v != null && v >= state.min[k]; });
        for (const k of Object.keys(state.max)) rows = rows.filter((r) => { const v = val(r, k); return v != null && v <= state.max[k]; });
        rows = U.sortBy(rows, (r) => val(r, state.sort.key), state.sort.desc);
        return { rows, val };
      }

      function renderTable() {
        const data = P.cache();
        if (!data || !data.rows) { U.replace(tableWrap, h('div.empty', h('div', { style: { marginBottom: '10px' } }, 'The leaderboard has not been built yet.'), h('button.btn.primary', { onclick: () => build(true) }, 'Build leaderboard'))); U.replace(summary, ''); return; }
        const { rows, val } = rowsFiltered(data);
        const total = rows.length; const pages = Math.max(1, Math.ceil(total / PAGE)); if (state.page > pages) state.page = pages;
        const slice = rows.slice((state.page - 1) * PAGE, state.page * PAGE);
        const iv = state.interval;
        const s = (r) => r.stats && r.stats[iv];
        const onSort = (k) => { if (state.sort.key === k) state.sort.desc = !state.sort.desc; else state.sort = { key: k, desc: k !== 'account' && k !== 'style' }; state.page = 1; renderTable(); };
        const tbl = UI.table({
          sort: state.sort, onSort,
          cols: [
            { key: 'rank', label: '#', render: (r) => { const i = rows.indexOf(r) + 1; return h('span.rank', { class: i <= 3 ? 'top' : '' }, String(i)); } },
            { key: 'account', label: 'Account', sortVal: 1, render: (r) => h('div.row', { style: { gap: '6px' } }, UI.starBtn({ address: r.account, subaccountId: r.sid, name: r.name }), U.addrLink(r.account, r.sid), U.copyBtn(r.account), r.name && r.name !== 'primary' ? h('span.chip', r.name) : null, r.inactive ? h('span.xs.dim', 'inactive') : null) },
            { key: 'equity', label: 'Equity', num: true, sortVal: 1, render: (r) => U.fmtUsd(r.equity) },
            { key: 'pnl', label: 'PnL', num: true, sortVal: 1, render: (r) => (s(r) ? U.pnlEl(s(r).pnl) : '—') },
            { key: 'volume', label: 'Volume', num: true, sortVal: 1, render: (r) => (s(r) ? U.fmtUsd(s(r).volume) : '—') },
            { key: 'roi', label: 'ROI', num: true, sortVal: 1, render: (r) => UI.pct(s(r) ? s(r).roi : null) },
            { key: 'positions', label: 'Positions', num: true, sortVal: 1, title: 'Total positions (open in brackets)', render: (r) => h('span', String(r.positionsCount), r.openCount ? h('span.dim.xs', ' (' + r.openCount + ')') : null) },
            { key: 'winRate', label: 'Winrate', num: true, sortVal: 1, render: (r) => (r.winRate == null ? h('span.dim', '—') : U.fmtPct(r.winRate, { dp: 1 })) },
            { key: 'sharpe', label: 'Sharpe', num: true, sortVal: 1, render: (r) => { const v = s(r) ? s(r).sharpe : null; return v == null ? h('span.dim', '—') : h('span', { class: U.pnlClass(v) }, U.fmtNum(v, 2)); } },
            { key: 'ddPct', label: 'Max DD', num: true, sortVal: 1, render: (r) => { const v = s(r) ? s(r).ddPct : null; return v == null || !(v > 0) ? h('span.dim', '—') : U.fmtDd(v); } },
            { key: 'style', label: 'Trading style', sortVal: 1, render: (r) => (r.style === '—' ? h('span.dim', '—') : r.style) },
          ],
          rows: slice, empty: 'No accounts match the filters',
          onRow: (r) => { location.hash = U.accountUrl(r.account, r.sid).slice(1); },
        });
        U.replace(tableWrap, tbl, UI.pager({ page: state.page, pageSize: PAGE, total, onPage: (p) => { state.page = p; renderTable(); tableWrap.scrollIntoView({ block: 'start' }); } }));
        shownBuiltAt = data.builtAt;
        renderSummary(data);
      }
      function renderSummary(data) {
        if (!data) return;
        U.replace(summary, `${data.rows.length} accounts · snapshot ${U.fmtAgo(data.builtAt)}`, data.remote ? h('span.dim', ' · published snapshot') : h('span.dim', ' · built in this browser'), data.partial ? h('span.neg', ' · partial build') : null);
      }
      // keep the page current: re-check the published snapshot every minute, tick the age label every 30 s
      let shownBuiltAt = 0;
      const tick = setInterval(async () => {
        if (ctx.signal.aborted) return;
        await P.loadRemote();
        const c = P.cache();
        if (c && c.builtAt !== shownBuiltAt && !building) renderTable(); else renderSummary(c);
      }, 30000);
      ctx.onCleanup(() => clearInterval(tick));

      async function build(force) {
        if (building) return;
        building = true; updateBtn.disabled = true;
        const bar = h('i', { style: { width: '0%' } });
        const txt = h('span.dim.small', 'Listing accounts…');
        U.replace(progress, h('div.stack', { style: { gap: '6px' } }, h('div.row', txt, h('span.grow'), h('button.btn.sm.ghost', { onclick: () => { cancel = true; } }, 'Cancel')), h('div.progress', bar)));
        let cancel = false;
        try {
          const ref = await A.ref(ctx);
          const subs = await A.allSubaccounts({ signal: ctx.signal, ttl: force ? 0 : 60000 });
          const ids = ref.active.map((p) => p.id);
          const prices = await A.marketPrices(ids, { signal: ctx.signal, ttl: 10000 });
          const rows = new Array(subs.length); let done = 0;
          const tasks = subs.map((sa, i) => async () => {
            if (cancel || ctx.signal.aborted) return;
            try { rows[i] = await AN.buildLeaderboardRow(sa, ref, prices, ctx); }
            catch (e) { if (e.name === 'AbortError') throw e; console.warn('leaderboard row failed', sa.id, e); rows[i] = null; }
            done++; bar.style.width = ((done / subs.length) * 100).toFixed(1) + '%'; txt.textContent = `Analysing accounts… ${done}/${subs.length}`;
          });
          await U.pLimit(tasks, 4);
          if (ctx.signal.aborted) return;
          const ok = rows.filter(Boolean);
          const snapshot = { builtAt: Date.now(), rows: ok, partial: cancel || ok.length < subs.length };
          if (!U.storage.set(KEY, snapshot)) U.toast('Snapshot too large for local storage; shown for this session only');
          P._mem = snapshot;
          U.replace(progress);
          renderTable();
        } catch (e) {
          if (e.name !== 'AbortError') U.replace(progress, UI.error(e, () => build(true)));
        } finally { building = false; updateBtn.disabled = false; }
      }
      renderTable();
      const c = P.cache();
      if (!c || Date.now() - c.builtAt > 30 * 60000) build(false);
    },
  });

})();
