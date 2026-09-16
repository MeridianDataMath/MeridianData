/* MeridianData — bootstrap: sidebar, topbar, global search, router */
(function () {
  const MD = window.MD; const U = MD.util; const A = MD.api; const h = U.h;

  const NAV = [
    { name: 'home', path: '/', icon: 'home', label: 'Home' },
    { name: 'account', path: '/account', icon: 'account', label: 'Account' },
    { name: 'favorites', path: '/favorites', icon: 'star', label: 'Favorites' },
    { name: 'leaderboard', path: '/leaderboard', icon: 'trophy', label: 'Leaderboard' },
    { name: 'dashboard', path: '/dashboard', icon: 'grid', label: 'Dashboard' },
    { name: 'copytrade', path: '/copytrade', icon: 'users', label: 'Copy trading', badge: 'soon' },
  ];
  const TITLES = { home: 'Home', account: 'Account', favorites: 'Favorites', leaderboard: 'Leaderboard', dashboard: 'Dashboard', copytrade: 'Copy trading' };
  const X_URL = 'https://x.com/meridiandotxyz';

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

  // ---- sidebar (expanded with labels by default on desktop; collapsible to icons, remembered) ----
  const RAIL_KEY = 'md.rail.collapsed';
  const railCollapsed = () => { const v = U.storage.get(RAIL_KEY, null); return v === null ? window.innerWidth < 1024 : !!v; };
  function applyRail(collapsed) {
    const app = U.$('.app'); if (!app) return;
    app.classList.toggle('rail-collapsed', collapsed);
    const t = U.$('#rail .toggle');
    // exactly one label is ever visible: the inline text while expanded, the hover tooltip while collapsed
    const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    if (t) { U.replace(t, U.icon(collapsed ? 'panelOpen' : 'panelClose'), h('span.lbl', label), h('span.tip', label)); t.title = label; t.setAttribute('aria-label', label); }
  }
  function renderRail() {
    const rail = U.$('#rail');
    const navLink = (n) => h('a.nav', { href: n.name === 'account' ? lastAccountHref() : '#' + n.path, dataset: { name: n.name } },
      U.icon(n.icon), h('span.lbl', n.label, n.badge ? h('span.chip.accent', { style: { marginLeft: '8px' } }, n.badge) : null), h('span.tip', n.label));
    const ext = (href, icon, label) => h('a.nav.ext', { href, target: '_blank', rel: 'noopener' }, icon, h('span.lbl', label), h('span.ext-ico', U.icon('external')), h('span.tip', label));
    U.replace(rail,
      h('a.logo', { href: '#/', title: 'MeridianData' }, h('img', { src: 'assets/meridian-symbol.svg', alt: 'Meridian' }), h('span.word', 'Meridian', h('span', 'Data'))),
      h('div.sec', 'Explore'),
      NAV.map(navLink),
      h('span.spacer'),
      h('div.sec', 'Meridian'),
      ext(A.APP_URL, U.svg(U.icons.meridian), 'Trade on Meridian'),
      ext('https://docs.meridian.xyz', U.icon('book'), 'Docs'),
      ext(X_URL, U.icon('x'), 'Meridian on X'),
      h('button.toggle', { type: 'button', onclick: () => { const c = !U.$('.app').classList.contains('rail-collapsed'); U.storage.set(RAIL_KEY, c); applyRail(c); } }));
    applyRail(railCollapsed());
  }

  function onRoute(route) {
    U.$$('#rail a.nav').forEach((a) => a.classList.toggle('active', a.dataset.name === route.name));
    MD.setTopbar(h('span.title', TITLES[route.name] || 'MeridianData'));
    const mini = U.$('#mini-search'); if (mini) mini.style.display = route.name === 'home' ? 'none' : '';
    const main = U.$('#main'); if (main) main.classList.toggle('home', route.name === 'home');
    if (route.name === 'account' && route.params.address) { U.storage.set('md.lastAccount', { address: route.params.address, sub: route.params.sub }); const a = U.$('#rail a.nav[data-name="account"]'); if (a) a.href = lastAccountHref(); }
    document.title = (TITLES[route.name] ? TITLES[route.name] + ' · ' : '') + 'MeridianData';
  }

  function boot() {
    renderRail();
    const input = U.$('#mini-search input');
    U.$('#mini-search').addEventListener('submit', async (e) => { e.preventDefault(); const r = await MD.search(input.value); if (r.error) U.toast(r.error); else input.value = ''; });
    // "/" focuses the search box (desktop shortcut)
    document.addEventListener('keydown', (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const mini = U.$('#mini-search'); const target = mini && mini.style.display !== 'none' ? input : U.$('.hero form input');
      if (target) { e.preventDefault(); target.focus(); target.select(); }
    });
    MD.router.start(U.$('#main'), onRoute);
    A.maintenance().then((m) => { if (m && m.isEnabled) { const b = U.$('#banner'); if (b) { b.style.display = ''; U.replace(b, h('div.notice', 'Meridian is currently in maintenance mode; data may be stale.')); } } }).catch(() => {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
