/* MeridianData — Home page */
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
          h('a.chipbtn', { href: '#/favorites' }, U.icon('star'), ' Favorites')),
        strip, foot);
      root.appendChild(h('div.page', hero));
      setTimeout(() => input.focus(), 50);

      // top accounts marquee from the leaderboard snapshot (published or locally built)
      const LB = MD.router.pages.leaderboard;
      if (LB) await LB.loadRemote();
      if (ctx.signal.aborted) return;
      const lb = LB && LB.cache();
      if (lb && lb.rows && lb.rows.length) {
        const rows = lb.rows.filter((r) => !r.inactive);
        const pick = (iv) => U.sortBy(rows, (r) => (r.stats && r.stats[iv] ? r.stats[iv].pnl : -Infinity), true).slice(0, 12).map((r) => ({ r, iv }));
        const items = pick('30d').concat(pick('7d')).filter((x) => x.r.stats && x.r.stats[x.iv] && x.r.stats[x.iv].pnl !== 0);
        if (items.length) {
          const track = h('div.track');
          const mk = (x) => h('a.item', { href: U.accountUrl(x.r.account, x.r.sid) }, h('span.addr', U.shortAddr(x.r.account)), U.pnlEl(x.r.stats[x.iv].pnl), h('span.tag', x.iv));
          items.forEach((x) => track.appendChild(mk(x)));
          items.forEach((x) => track.appendChild(mk(x)));
          strip.appendChild(track);
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
