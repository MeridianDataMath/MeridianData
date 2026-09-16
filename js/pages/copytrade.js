/* MeridianData — Copy trading (in development): leader scouting from the leaderboard snapshot + roadmap */
(function () {
  const MD = window.MD; const U = MD.util; const UI = MD.ui; const h = U.h;

  const ROADMAP = [
    { t: 'Leader scouting', d: 'Every wallet on Meridian ranked by all-time PnL, ROI, win rate and trading style.', s: 'live' },
    { t: 'Watchlist', d: 'Star a wallet to keep it on your Favorites page with live equity and open positions.', s: 'live' },
    { t: 'Leader activity alerts', d: 'Get notified when a leader opens, closes or gets liquidated, straight from the exchange WebSocket.', s: 'building' },
    { t: 'Mirror positions', d: 'Copy a leader\'s opens and closes into your own subaccount through a Meridian linked signer, sized by a ratio you choose.', s: 'planned' },
    { t: 'Risk controls', d: 'Max leverage, max notional per market, pause on drawdown, exclude markets.', s: 'planned' },
    { t: 'Copy history', d: 'PnL attribution per leader and your slippage versus the leader\'s fills.', s: 'planned' },
  ];
  const STATUS = { live: ['live', 'green'], building: ['being vibecoded', 'accent'], planned: ['planned', ''] };

  MD.router.pages.copytrade = {
    async mount(root, route, ctx) {
      MD.setTopbar(h('span.title', 'Copy trading'));
      const LB = MD.router.pages.leaderboard;
      const tableWrap = h('div');
      const summary = h('span.dim.small');
      let onlyProfit = true;
      const hero = h('div.card.ct-hero',
        h('div.row', { style: { marginBottom: '8px' } }, UI.chip('In development', 'accent'), h('span.dim.small', 'still being vibecoded')),
        h('h1', 'Copy trading on Meridian'),
        h('p', 'The idea: pick a leader wallet, choose a size ratio and risk limits, and MeridianData mirrors the leader\'s Meridian positions into your own subaccount. The plan is to sign with a Meridian linked signer in your own browser, so no exchange keys are handed to anyone.'),
        h('p', 'Nothing on this page places orders yet. What already works is the scouting below: every wallet on the exchange, ranked by profit since launch, straight from the public API. Star the ones you like to watch them on Favorites.'));
      const roadmap = h('div.card', h('h3', { style: { marginBottom: '10px' } }, 'Roadmap'),
        h('div.roadmap', ROADMAP.map((r) => h('div.it', h('div.row', h('span.t', r.t), h('span.grow'), UI.chip(STATUS[r.s][0], STATUS[r.s][1])), h('div.d', r.d)))));
      const leaders = h('div.card.tight', h('div.card-head', h('h2', 'Leaders by all-time PnL'), summary, h('span.grow'), UI.checkbox('Only profitable', onlyProfit, (v) => { onlyProfit = v; render(); })), tableWrap);
      U.replace(root, h('div.page', h('div.stack', hero, roadmap, leaders, h('div.footer-note', 'Ranking uses the same snapshot as the Leaderboard (realised + unrealised PnL since the exchange launched, net of fees and funding). Past performance is not a promise of future returns.'))));
      ctx.onCleanup(U.on('favorites', () => render()));

      if (LB) await LB.loadRemote();
      if (ctx.signal.aborted) return;
      function render() {
        const data = LB && LB.cache();
        if (!data || !data.rows) {
          U.replace(tableWrap, h('div.empty', h('div', { style: { marginBottom: '10px' } }, 'No leaderboard snapshot yet.'), h('a.btn.primary', { href: '#/leaderboard' }, 'Build the leaderboard')));
          U.replace(summary, ''); return;
        }
        let rows = data.rows.filter((r) => !r.inactive && r.stats && r.stats.all);
        rows = U.sortBy(rows, (r) => r.stats.all.pnl, true);
        if (onlyProfit) rows = rows.filter((r) => r.stats.all.pnl > 0);
        const s = (r, iv) => r.stats[iv] || {};
        U.replace(tableWrap, UI.table({
          cols: [
            { key: 'rank', label: '#', render: (r) => { const i = rows.indexOf(r) + 1; return h('span.rank', { class: i <= 3 ? 'top' : '' }, String(i)); } },
            { key: 'w', label: 'Wallet', render: (r) => h('div.row', { style: { gap: '6px' } }, UI.starBtn({ address: r.account, subaccountId: r.sid, name: r.name }), U.addrLink(r.account, r.sid), U.copyBtn(r.account)) },
            { key: 'pnl', label: 'All-time PnL', num: true, render: (r) => U.pnlEl(s(r, 'all').pnl) },
            { key: 'roi', label: 'ROI', num: true, render: (r) => UI.pct(s(r, 'all').roi) },
            { key: 'p30', label: '30d PnL', num: true, render: (r) => U.pnlEl(s(r, '30d').pnl) },
            { key: 'p7', label: '7d PnL', num: true, render: (r) => U.pnlEl(s(r, '7d').pnl) },
            { key: 'wr', label: 'Win rate', num: true, render: (r) => (r.winRate == null ? h('span.dim', '—') : U.fmtPct(r.winRate, { dp: 0 })) },
            { key: 'dd', label: 'Max DD', num: true, render: (r) => { const v = s(r, 'all').ddPct; return v == null || !(v > 0) ? h('span.dim', '—') : U.fmtDd(v); } },
            { key: 'style', label: 'Style', render: (r) => (r.style === '—' ? h('span.dim', '—') : r.style) },
            { key: 'pos', label: 'Positions', num: true, render: (r) => h('span', String(r.positionsCount), r.openCount ? h('span.dim.xs', ' (' + r.openCount + ' open)') : null) },
            { key: 'eq', label: 'Equity', num: true, render: (r) => U.fmtUsd(r.equity, { compact: true }) },
            { key: 'vol', label: 'Volume', num: true, render: (r) => U.fmtUsd(s(r, 'all').volume, { compact: true }) },
            { key: 'go', label: '', render: (r) => h('a.btn.sm', { href: U.accountUrl(r.account, r.sid) }, 'Scout') },
          ],
          rows, empty: onlyProfit ? 'No profitable wallets in the snapshot yet' : 'No wallets in the snapshot',
          onRow: (r) => { location.hash = U.accountUrl(r.account, r.sid).slice(1); },
        }));
        U.replace(summary, `${rows.length} wallets · snapshot ${U.fmtAgo(data.builtAt)}`);
      }
      render();
    },
  };
})();
