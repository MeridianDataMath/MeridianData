/* MeridianData — bootstrap: sidebar, topbar, global search, router */
(function () {
  const MD = window.MD; const U = MD.util; const A = MD.api; const h = U.h;

  const NAV = [
    { name: 'home', path: '/', icon: 'home', label: 'Home' },
    { name: 'account', path: '/account', icon: 'account', label: 'Account' },
    { name: 'favorites', path: '/favorites', icon: 'star', label: 'Favorites' },
    { name: 'leaderboard', path: '/leaderboard', icon: 'trophy', label: 'Leaderboard' },
    { name: 'dashboard', path: '/dashboard', icon: 'grid', label: 'Dashboard' },
  ];
  const TITLES = { home: 'Home', account: 'Account', favorites: 'Favorites', leaderboard: 'Leaderboard', dashboard: 'Dashboard' };

  MD.setTopbar = (node) => { const t = U.$('#topbar-title'); if (t) U.replace(t, node); };

  /** Resolve a search string to an account page. Returns {ok} or {error}. */
  MD.search = async (raw) => {
    const v = String(raw || '').trim();
    if (!v) return { error: 'Enter a wallet address or subaccount ID' };
    if (U.isAddress(v)) {
      let subs;
      try { subs = await A.subaccountsOf(v); } catch (e) { return { error: 'Lookup failed: ' + e.message }; }
      if (!subs.length) return { error: 'No Meridian subaccounts found for this address' };
      MD.router.navigate('/account', { address: v.toLowerCase(), sub: subs[0].id });
      return { ok: true };
    }
    if (U.isUuid(v)) {
      try { const sa = await A.subaccount(v); MD.router.navigate('/account', { address: sa.account, sub: sa.id }); return { ok: true }; }
      catch (e) { return { error: e.status === 404 ? 'Subaccount not found' : 'Lookup failed: ' + e.message }; }
    }
    return { error: 'Enter a 0x wallet address (40 hex chars) or a subaccount UUID' };
  };

  MD.router.pages.notfound = { async mount(root) { U.replace(root, h('div.page', h('div.card', h('div.empty', 'Page not found. ', h('a', { href: '#/' }, 'Go home'))))); } };

  function lastAccountHref() { const last = U.storage.get('md.lastAccount', null); return last ? U.accountUrl(last.address, last.sub) : '#/'; }

  function renderRail() {
    const rail = U.$('#rail');
    U.replace(rail,
      h('a.logo', { href: '#/', title: 'MeridianData' }, h('img', { src: 'assets/meridian-symbol.svg', alt: 'Meridian' })),
      NAV.map((n) => h('a.nav', { href: n.name === 'account' ? lastAccountHref() : '#' + n.path, dataset: { name: n.name } }, U.icon(n.icon), h('span.tip', n.label))),
      h('span.spacer'),
      h('a.nav.ext', { href: A.APP_URL, target: '_blank', rel: 'noopener' }, U.svg(U.icons.meridian), h('span.tip', 'Meridian app')),
      h('a.nav.ext', { href: 'https://docs.meridian.xyz', target: '_blank', rel: 'noopener' }, U.icon('book'), h('span.tip', 'Docs')),
      h('a.nav.ext', { href: 'https://x.com/meridian_xyz', target: '_blank', rel: 'noopener' }, U.icon('x'), h('span.tip', 'Meridian on X')));
  }

  function onRoute(route) {
    U.$$('#rail a.nav').forEach((a) => a.classList.toggle('active', a.dataset.name === route.name));
    MD.setTopbar(h('span.title', TITLES[route.name] || 'MeridianData'));
    const mini = U.$('#mini-search'); if (mini) mini.style.display = route.name === 'home' ? 'none' : '';
    if (route.name === 'account' && route.params.address) { U.storage.set('md.lastAccount', { address: route.params.address, sub: route.params.sub }); const a = U.$('#rail a.nav[data-name="account"]'); if (a) a.href = lastAccountHref(); }
    document.title = (TITLES[route.name] ? TITLES[route.name] + ' · ' : '') + 'MeridianData';
  }

  function boot() {
    renderRail();
    const input = U.$('#mini-search input');
    U.$('#mini-search').addEventListener('submit', async (e) => { e.preventDefault(); const r = await MD.search(input.value); if (r.error) U.toast(r.error); else input.value = ''; });
    MD.router.start(U.$('#main'), onRoute);
    A.maintenance().then((m) => { if (m && m.isEnabled) { const b = U.$('#banner'); if (b) { b.style.display = ''; U.replace(b, h('div.notice', 'Meridian is currently in maintenance mode; data may be stale.')); } } }).catch(() => {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
