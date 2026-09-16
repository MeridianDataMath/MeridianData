/* MeridianData — Favorites page */
(function () {
  const MD = window.MD; const U = MD.util; const A = MD.api; const AN = MD.analytics; const UI = MD.ui; const h = U.h;
  MD.router.pages.favorites = {
    async mount(root, route, ctx) {
      const body = h('div');
      const page = h('div.page', h('div.stack', h('div.row', h('h2', 'Favorites'), h('span.grow'), h('button.btn.sm', { onclick: () => render(true) }, U.icon('refresh'), 'Refresh')), body));
      root.appendChild(page);
      const off = U.on('favorites', () => render(false));
      ctx.onCleanup(off);

      async function render(force) {
        const favs = U.favorites.list();
        if (!favs.length) {
          U.replace(body, h('div.card', h('div.empty', 'No favorites yet. Open an account and press the star to keep it here.')));
          return;
        }
        U.replace(body, h('div.card.tight', UI.loading('Loading favorite accounts…')));
        const LB = MD.router.pages.leaderboard;
        if (LB) await LB.loadRemote();
        const lb = LB && LB.cache();
        const lbBy = {}; if (lb && lb.rows) for (const r of lb.rows) lbBy[r.sid] = r;
        let ref, prices = {};
        try {
          ref = await A.ref({ signal: ctx.signal });
          prices = await A.marketPrices(ref.active.map((p) => p.id), { signal: ctx.signal, ttl: 10000 });
        } catch (e) { if (e.name === 'AbortError') return; U.replace(body, UI.error(e, () => render(true))); return; }
        const results = await U.pLimit(favs.map((f) => async () => {
          if (force) { A.clearCache(A.BASE + '/v1/subaccount/balance?subaccountId=' + f.subaccountId); }
          const [balances, positions, vol] = await Promise.all([
            A.balances(f.subaccountId, { signal: ctx.signal, ttl: force ? 0 : 30000 }),
            A.openPositions(f.subaccountId, { signal: ctx.signal, ttl: force ? 0 : 30000 }),
            A.totalVolume(f.subaccountId, { signal: ctx.signal, ttl: force ? 0 : 60000 }).catch(() => null),
          ]);
          const st = AN.accountState({ balances, positions, ref, prices });
          return { f, st, vol, lb: lbBy[f.subaccountId] };
        }), 4);
        if (ctx.signal.aborted) return;
        const rows = results.map((r, i) => (r.ok ? r.value : { f: favs[i], error: r.error }));
        const tbl = UI.table({
          cols: [
            { key: 'acct', label: 'Account', render: (r) => h('div.row', U.addrLink(r.f.address, r.f.subaccountId), U.copyBtn(r.f.address)) },
            { key: 'sub', label: 'Subaccount', render: (r) => h('span.dim', r.f.name || 'primary') },
            { key: 'equity', label: 'Equity', num: true, render: (r) => (r.error ? h('span.neg', 'error') : UI.usd(r.st.equity)) },
            { key: 'upnl', label: 'Unrealized PnL', num: true, render: (r) => (r.error ? '—' : U.pnlEl(r.st.upnl)) },
            { key: 'pos', label: 'Open positions', num: true, render: (r) => (r.error ? '—' : String(r.st.positions.length)) },
            { key: 'notional', label: 'Notional', num: true, render: (r) => (r.error ? '—' : UI.usd(r.st.notional, { compact: true })) },
            { key: 'vol', label: 'Volume (all)', num: true, render: (r) => (r.vol == null ? '—' : UI.usd(r.vol, { compact: true })) },
            { key: 'pnl30', label: 'PnL 30d', num: true, title: 'From the leaderboard snapshot', render: (r) => (r.lb && r.lb.stats && r.lb.stats['30d'] ? U.pnlEl(r.lb.stats['30d'].pnl) : h('span.dim', '—')) },
            { key: 'added', label: 'Added', render: (r) => h('span.dim', U.fmtAgo(r.f.addedAt)) },
            { key: 'rm', label: '', render: (r) => h('button.btn.sm.icon.ghost', { title: 'Remove', onclick: () => U.favorites.remove(r.f.subaccountId) }, U.icon('trash')) },
          ],
          rows,
          onRow: (r) => { location.hash = U.accountUrl(r.f.address, r.f.subaccountId).slice(1); },
        });
        U.replace(body, h('div.card.tight', tbl), h('div.footer-note', 'Favorites are stored in this browser only.'));
      }
      render(false);
    },
  };
})();
