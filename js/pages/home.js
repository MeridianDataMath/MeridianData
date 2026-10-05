/* MeridianDataHub — Home page */
(function () {
  const MD = window.MD; const U = MD.util; const A = MD.api; const h = U.h;
  MD.router.pages.home = {
    async mount(root, route, ctx) {
      const err = h('div.err');
      const input = h('input', { type: 'text', placeholder: window.innerWidth <= 480 ? 'Wallet address or subaccount ID' : 'Search by wallet address or subaccount ID', autocomplete: 'off', spellcheck: false });
      const form = h('form', { onsubmit: async (e) => { e.preventDefault(); err.textContent = ''; const r = await MD.search(input.value); if (r && r.error) err.textContent = r.error; } }, input, h('button', { type: 'submit', title: 'Search' }, U.icon('search')));
      const strip = h('div.strip');
      const foot = h('div.foot');
      const hero = h('div.hero',
        h('h1', 'Explore ', h('span', 'Meridian'), ' account performance'),
        h('div.sub', 'Public perps and Predict analytics, copy trading and tax records for every account on Meridian · Robinhood Chain'),
        form, err,
        h('div.quick',
          h('a.chipbtn', { href: '#/dashboard' }, U.icon('grid'), ' Markets dashboard'),
          h('a.chipbtn', { href: '#/leaderboard' }, U.icon('trophy'), ' Leaderboard'),
          h('a.chipbtn', { href: '#/favorites' }, U.icon('star'), ' Favorites'),
          h('a.chipbtn', { href: '#/predict' }, U.icon('target'), ' Predict'),
          h('a.chipbtn', { href: '#/copytrade' }, U.icon('users'), ' Copy trading'),
          h('a.chipbtn', { href: '#/tax' }, U.icon('receipt'), ' Tax center')),
        strip, foot);
      root.appendChild(h('div.page', hero));
      setTimeout(() => input.focus(), 50);

      // top accounts marquee from the leaderboard snapshot (published or locally built)
      const LB = MD.router.pages.leaderboard;
      if (LB) await LB.loadRemote();
      if (ctx.signal.aborted) return;
      const lb = LB && LB.cache();
      if (lb && lb.rows && lb.rows.length) {
        // ranked by all-time PnL as Meridian's app shows it (the rows' basis 'app': realized PnL, settled funding and trading
        // fees, plus unrealized PnL) → copy-trading candidates
        // copy-trade candidates must be traders: the fee collector (no trades) and the exchange's own account are left out
        const rows = lb.rows.filter((r) => !r.inactive && r.stats && r.stats.all && !MD.analytics.noTrades(r) && !MD.analytics.exchangeAccount(r));
        const ranked = U.sortBy(rows, (r) => r.stats.all.pnl, true);
        const winners = ranked.filter((r) => r.stats.all.pnl > 0).slice(0, 24);
        const items = winners.length >= 4 ? winners : ranked.slice(0, 12);
        if (items.length) {
          const track = h('div.track');
          // a row carried over from an earlier build (the snapshot could not rebuild it) says how old its figures are; the
          // site's own all-time figure follows
          const mk = (r, i) => h('a.item', { href: U.accountUrl(r.account, r.sid), title: [r.carried ? `Open account · these figures are from the build of ${U.fmtWhen(r.builtAt)} (${U.fmtAgo(r.builtAt)}): the latest snapshot could not rebuild this account` : 'Open account', MD.analytics.sitePnlTitle(r, 'all')].filter(Boolean).join('\n') },
            h('span.rank', { class: i < 3 ? 'top' : '', style: { width: 'auto' } }, '#' + (i + 1)),
            h('span.addr', U.shortAddr(r.account)), U.pnlEl(r.stats.all.pnl),
            // a big account's small percentage reads "+0.3%", not "+0%"
            r.stats.all.roi != null ? h('span.tag', U.fmtPct(r.stats.all.roi, { sign: true, dp: Math.abs(r.stats.all.roi) < 10 ? 1 : 0 }) + ' ROI') : null,
            r.style && r.style !== '—' ? h('span.tag', r.style) : null);
          items.forEach((r, i) => track.appendChild(mk(r, i)));
          items.forEach((r, i) => track.appendChild(mk(r, i)));
          strip.appendChild(track);
          // the ranking says, as the Leaderboard does, when accounts are missing from it or carried over, and when it is stale
          hero.insertBefore(h('div.strip-title', { title: 'All-time PnL as Meridian\'s app shows it (its Trade Stats): realized PnL, settled funding and trading fees, plus unrealized PnL; ROI on the deposits. Hover a wallet for the site\'s net figure' }, 'Top wallets by all-time PnL · ', h('a', { href: '#/copytrade' }, 'copyability scores'), LB.coverageNote(lb), MD.ui.staleNote(lb.builtAt, 'the publishing job may be down')), strip);
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
          h('span', { title: '24 h traded quantity × current oracle price, summed over markets' }, '24h volume ', h('b', U.fmtUsd(vol, { compact: true }))),
          h('span', { title: 'Long and short positions added together, as Meridian reports open interest; one side is half of it' }, 'Open interest (long + short) ', h('b', U.fmtUsd(oi, { compact: true }))),
          subs ? h('span', 'Accounts ', h('b', String(subs.length))) : null,
          h('span', h('a', { href: A.APP_URL, target: '_blank', rel: 'noopener' }, 'app.meridian.xyz')),
          h('span', h('a', { href: '#/status', title: 'How old the published snapshots are' }, 'Data updated ', lb && lb.builtAt ? U.fmtAgo(lb.builtAt) : '—')));
      } catch (e) { if (e.name !== 'AbortError') U.replace(foot, h('span.dim', 'Exchange stats unavailable')); }
    },
  };
})();
