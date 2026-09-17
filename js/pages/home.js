/* MeridianDataHub — Home page */
(function () {
  const MD = window.MD; const U = MD.util; const A = MD.api; const h = U.h;
  MD.router.pages.home = {
    async mount(root, route, ctx) {
      const err = h('div.err');
      const input = h('input', { type: 'text', placeholder: 'Search by wallet address or subaccount ID', autocomplete: 'off', spellcheck: false });
      const form = h('form', { onsubmit: async (e) => { e.preventDefault(); err.textContent = ''; const r = await MD.search(input.value); if (r && r.error) err.textContent = r.error; } }, input, h('button', { type: 'submit', title: 'Search' }, U.icon('search')));
      const strip = h('div.strip');
      const foot = h('div.foot');
      const hero = h('div.hero',
        h('h1', 'Explore ', h('span', 'Meridian'), ' account performance'),
        h('div.sub', 'Public perps analytics for every account on Meridian · Robinhood Chain'),
        form, err,
        h('div.quick',
          h('a.chipbtn', { href: '#/leaderboard' }, U.icon('trophy'), ' Leaderboard'),
          h('a.chipbtn', { href: '#/dashboard' }, U.icon('grid'), ' Markets dashboard'),
          h('a.chipbtn', { href: '#/favorites' }, U.icon('star'), ' Favorites'),
          h('a.chipbtn', { href: '#/tax' }, U.icon('receipt'), ' Tax center'),
          h('a.chipbtn', { href: '#/predict' }, U.icon('target'), ' Predict'),
          h('a.chipbtn', { href: '#/copytrade' }, U.icon('users'), ' Copy trading', h('span.chip.accent', { style: { marginLeft: '6px' } }, 'soon'))),
        strip, foot);
      root.appendChild(h('div.page', hero));
      setTimeout(() => input.focus(), 50);

      // top accounts marquee from the leaderboard snapshot (published or locally built)
      const LB = MD.router.pages.leaderboard;
      if (LB) await LB.loadRemote();
      if (ctx.signal.aborted) return;
      const lb = LB && LB.cache();
      if (lb && lb.rows && lb.rows.length) {
        // ranked by all-time PnL (realised + unrealised since the exchange launched) → copy-trading candidates
        const rows = lb.rows.filter((r) => !r.inactive && r.stats && r.stats.all);
        const ranked = U.sortBy(rows, (r) => r.stats.all.pnl, true);
        const winners = ranked.filter((r) => r.stats.all.pnl > 0).slice(0, 24);
        const items = winners.length >= 4 ? winners : ranked.slice(0, 12);
        if (items.length) {
          const track = h('div.track');
          const mk = (r, i) => h('a.item', { href: U.accountUrl(r.account, r.sid), title: 'Open account' },
            h('span.rank', { class: i < 3 ? 'top' : '', style: { width: 'auto' } }, '#' + (i + 1)),
            h('span.addr', U.shortAddr(r.account)), U.pnlEl(r.stats.all.pnl),
            r.stats.all.roi != null ? h('span.tag', U.fmtPct(r.stats.all.roi, { sign: true, dp: 0 }) + ' ROI') : null,
            h('span.tag', r.style !== '—' ? r.style : 'all-time'));
          items.forEach((r, i) => track.appendChild(mk(r, i)));
          items.forEach((r, i) => track.appendChild(mk(r, i)));
          strip.appendChild(track);
          hero.insertBefore(h('div.strip-title', 'Top wallets by all-time PnL · ', h('a', { href: '#/copytrade' }, 'copy-trading candidates')), strip);
        }
      } else {
        strip.appendChild(h('div', { style: { textAlign: 'center', fontSize: '12.5px' } }, h('a', { href: '#/leaderboard' }, 'Build the leaderboard'), h('span.dim', ' to see the top accounts here')));
      }

      // exchange stats footer
      try {
        const ref = await A.ref({ signal: ctx.signal });
        const ids = ref.active.map((p) => p.id);
        const [prices, subs] = await Promise.all([A.marketPrices(ids, { signal: ctx.signal, ttl: 30000 }), A.allSubaccounts({ signal: ctx.signal }).catch(() => null)]);
        let vol = 0, oi = 0;
        for (const p of ref.active) { const px = prices[p.id]; const o = px ? U.num(px.oraclePrice) : 0; vol += U.num(p.volume24h) * o; oi += U.num(p.openInterest) * o; }
        U.replace(foot,
          h('span', 'Markets ', h('b', String(ref.active.length))),
          h('span', '24h volume ', h('b', U.fmtUsd(vol, { compact: true }))),
          h('span', 'Open interest ', h('b', U.fmtUsd(oi, { compact: true }))),
          subs ? h('span', 'Accounts ', h('b', String(subs.length))) : null,
          h('span', h('a', { href: A.APP_URL, target: '_blank', rel: 'noopener' }, 'app.meridian.xyz')));
      } catch (e) { if (e.name !== 'AbortError') U.replace(foot, h('span.dim', 'Exchange stats unavailable')); }
    },
  };
})();
