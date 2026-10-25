/* MeridianDataHub — Favorites page */
(function () {
  const MD = window.MD; const U = MD.util; const A = MD.api; const AN = MD.analytics; const UI = MD.ui; const h = U.h;
  MD.router.pages.favorites = {
    async mount(root, route, ctx) {
      const body = h('div');
      const page = h('div.page', h('div.stack', h('div.row', h('h2', 'Favorites'), h('span.grow'), h('button.btn.sm', { onclick: () => render(true) }, U.icon('refresh'), 'Refresh')), body));
      root.appendChild(page);
      const off = U.on('favorites', () => render(false));
      ctx.onCleanup(off);

      // each account's figures as last read: a rename, a removal or a reorder redraws from them at once, and only an account
      // not read yet (or Refresh) is read; gen: a later render wins, so a slow earlier one cannot bring back a removed row
      // (the leaderboard page's helpers, for render() and draw() both: draw() used a name declared in render() only, and a
      // carried row threw, leaving the page on its loading line)
      const LB = MD.router.pages.leaderboard;
      const last = new Map(); let gen = 0, lbBy = {};
      async function render(force) {
        const my = ++gen;
        const favs = U.favorites.list();
        if (!favs.length) {
          U.replace(body, h('div.card', h('div.empty', h('div', { style: { marginBottom: '10px' } }, 'No favorites yet. Open an account and press the star to keep it here.'),
            h('div.row.wrap', { style: { justifyContent: 'center', gap: '6px' } }, h('a.btn.sm', { href: '#/leaderboard' }, U.icon('trophy'), 'Browse the leaderboard'), h('a.btn.sm', { href: '#/copytrade' }, U.icon('users'), 'Copyable leaders'), h('a.btn.sm', { href: '#/account' }, U.icon('search'), 'Open an account')),
            h('div.xs.dim', { style: { marginTop: '12px' } }, 'Favorites are stored in this browser only.'))));
          return;
        }
        const need = force ? favs : favs.filter((f) => !last.has(f.subaccountId));
        if (!need.length) { draw(favs); return; }
        if (!body.querySelector('table')) U.replace(body, h('div.card.tight', UI.loading('Loading favorite accounts…')));
        if (LB) await LB.loadRemote();
        if (my !== gen || ctx.signal.aborted) return;
        const lb = LB && LB.cache();
        lbBy = {}; if (lb && lb.rows) for (const r of lb.rows) lbBy[r.sid] = r;
        let ref, prices = {};
        try {
          ref = await A.ref({ signal: ctx.signal });
          prices = await A.marketPrices(ref.active.map((p) => p.id), { signal: ctx.signal, ttl: 10000 });
        } catch (e) { if (e.name === 'AbortError' || my !== gen) return; U.replace(body, UI.error(e, () => render(true))); return; }
        const results = await U.pLimit(need.map((f) => async () => {
          if (force) { A.clearCache(A.BASE + '/v1/subaccount/balance?subaccountId=' + f.subaccountId); }
          const [balances, positions, vol] = await Promise.all([
            A.balances(f.subaccountId, { signal: ctx.signal, ttl: force ? 0 : 30000 }),
            A.openPositions(f.subaccountId, { signal: ctx.signal, ttl: force ? 0 : 30000 }),
            A.totalVolume(f.subaccountId, { signal: ctx.signal, ttl: force ? 0 : 60000 }).catch(() => null),
          ]);
          const st = AN.accountState({ balances, positions, ref, prices });
          return { f, st, vol, lb: lbBy[f.subaccountId] };
        }), 4);
        if (ctx.signal.aborted || my !== gen) return;
        results.forEach((r, i) => last.set(need[i].subaccountId, r.ok ? r.value : { f: need[i], error: r.error }));
        draw(U.favorites.list());
      }
      // (a removal from the keyboard: the focus goes on to the next row's trash button, else the one before)
      function removeFav(sid, btn) {
        const had = document.activeElement === btn;
        const ids = U.favorites.list().map((f) => f.subaccountId); const i = ids.indexOf(sid); const next = ids[i + 1] || ids[i - 1];
        U.favorites.remove(sid);
        if (!had || !next || !(window.CSS && CSS.escape)) return;
        const to = body.querySelector('[data-focus-key="' + CSS.escape('fav:rm:' + next) + '"]');
        if (to) to.focus({ preventScroll: true });
      }
      function draw(favs) {
        // the favorite as it is now (its name), with the figures last read for it
        const rows = favs.filter((f) => last.has(f.subaccountId)).map((f) => Object.assign({}, last.get(f.subaccountId), { f, lb: lbBy[f.subaccountId] }));
        if (!rows.length) return;
        const tbl = UI.table({
          cols: [
            // the name the user gave the wallet (the home page's favorites, or the pencil here), then its address
            { key: 'acct', label: 'Account', render: (r) => h('div.row', r.f.label ? h('b.fav-label', { title: 'Your name for this wallet' }, r.f.label) : null, U.addrLink(r.f.address, r.f.subaccountId), U.copyBtn(r.f.address)) },
            { key: 'equity', label: 'Equity', num: true, render: (r) => (r.error ? h('span.neg', 'error') : UI.usd(r.st.equity)) },
            // Meridian's Unrealized P&L (gross); the site's net figure, what equity counts, in the cell's tooltip
            { key: 'upnl', label: 'Unrealized PnL', num: true, title: 'As Meridian\'s app (Unrealized P&L): the open positions\' (oracle price − entry) × size, before funding and fees. Hover a cell for the site\'s net figure, the unsettled funding and mPerp position fees counted too (the amount that counts in equity)', render: (r) => (r.error ? '—' : h('span', { title: 'Site\'s net figure incl. unsettled funding and position fees: ' + U.fmtUsd(r.st.upnl, { sign: true }) }, U.pnlEl(r.st.grossUpnl))) },
            { key: 'pos', label: 'Open positions', num: true, render: (r) => (r.error ? '—' : String(r.st.positions.length)) },
            { key: 'notional', label: 'Notional', num: true, render: (r) => (r.error ? '—' : UI.usd(r.st.notional, { compact: true })) },
            { key: 'vol', label: 'Volume (all)', num: true, render: (r) => (r.vol == null ? '—' : UI.usd(r.vol, { compact: true })) },
            // a row the snapshot carried over from an earlier build is marked "older", as on the Leaderboard
            { key: 'pnl30', label: 'PnL 30d', num: true, title: 'From the leaderboard snapshot, as Meridian\'s Trade Stats 30D: from the end of the UTC day 30 days back. Hover a cell for the site\'s net figure', render: (r) => (r.lb && r.lb.stats && r.lb.stats['30d'] ? h('span', { title: AN.sitePnlTitle(r.lb, '30d') }, U.pnlEl(r.lb.stats['30d'].pnl), r.lb.carried && LB ? [' ', LB.carriedChip(r.lb)] : null) : h('span.dim', '—')) },
            { key: 'added', label: 'Added', render: (r) => h('span.dim', U.fmtAgo(r.f.addedAt)) },
            { key: 'rm', label: '', render: (r) => h('div.row', { style: { gap: '2px', flexWrap: 'nowrap' } },
              h('button.btn.sm.icon.ghost', { title: r.f.label ? 'Rename' : 'Give it a name', 'aria-label': (r.f.label ? 'Rename ' : 'Name ') + (r.f.label || U.shortAddr(r.f.address, 4)), dataset: { focusKey: 'fav:name:' + r.f.subaccountId }, onclick: (e) => { e.stopPropagation(); UI.nameFavorite(r.f.subaccountId); } }, U.icon('pencil')),
              h('button.btn.sm.icon.ghost', { title: 'Remove', 'aria-label': 'Remove ' + (r.f.label || U.shortAddr(r.f.address, 4)) + ' from favorites', dataset: { focusKey: 'fav:rm:' + r.f.subaccountId }, onclick: (e) => { e.stopPropagation(); removeFav(r.f.subaccountId, e.currentTarget); } }, U.icon('trash'))) },
          ],
          rows, rowKey: (r) => r.f.subaccountId,
          onRow: (r) => { location.hash = U.accountUrl(r.f.address, r.f.subaccountId).slice(1); },
        });
        U.replace(body, h('div.card.tight', tbl), h('div.footer-note', 'Favorites are stored in this browser only.'));
      }
      render(false);
    },
  };
})();
