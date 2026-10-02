/* MeridianDataHub — bootstrap: sidebar, topbar, global search, router */
(function () {
  const MD = window.MD; const U = MD.util; const A = MD.api; const h = U.h;

  const SECTIONS = [
    { title: 'Perps', items: [
      { name: 'home', path: '/', icon: 'home', label: 'Home' },
      { name: 'dashboard', path: '/dashboard', icon: 'grid', label: 'Dashboard' },
      { name: 'account', path: '/account', icon: 'account', label: 'Account' },
      { name: 'favorites', path: '/favorites', icon: 'star', label: 'Favorites' },
      { name: 'leaderboard', path: '/leaderboard', icon: 'trophy', label: 'Leaderboard' },
    ] },
    // tools that span perps and Predict sit between the two, ruled off above and below
    { title: null, rule: true, items: [
      { name: 'copytrade', path: '/copytrade', icon: 'users', label: 'Copy trading' },
      { name: 'tax', path: '/tax', icon: 'receipt', label: 'Tax center' },
    ] },
    { title: 'Predict', items: [
      { name: 'predict', path: '/predict', icon: 'target', label: 'Overview' },
      { name: 'predict', path: '/predict/bettors', icon: 'ticket', label: 'Bettors', prefix: '/predict/bettor' },
      { name: 'predict', path: '/predict/questions', icon: 'help', label: 'Questions' },
      { name: 'predict', path: '/predict/makers', icon: 'layers', label: 'Market makers' },
      { name: 'predict', path: '/predict/vig', icon: 'scale', label: 'Vig & edge' },
    ] },
  ];
  const TITLES = { home: 'Home', account: 'Account', favorites: 'Favorites', leaderboard: 'Leaderboard', dashboard: 'Dashboard', tax: 'Tax center', copytrade: 'Copy trading', predict: 'Predict', status: 'Data status' };
  const PATH_TITLES = { '/predict': 'Predict · Overview', '/predict/bettors': 'Predict · Bettors', '/predict/questions': 'Predict · Questions', '/predict/makers': 'Predict · Market makers', '/predict/vig': 'Predict · Vig & edge', '/predict/bettor': 'Predict · Bettor' };
  const X_URL = 'https://x.com/meridiandotxyz';

  MD.setTopbar = (node) => { const t = U.$('#topbar-title'); if (t) U.replace(t, node); };

  /** Resolve a search string to an account page. Returns {ok} or {error}. */
  MD.search = async (raw) => {
    const v = String(raw || '').trim();
    if (!v) return { error: 'Enter a wallet address or subaccount ID' };
    if (U.isAddress(v)) {
      let subs;
      try { subs = await A.subaccountsOf(v); } catch (e) { return { error: 'Lookup failed: ' + e.message }; }
      if (subs.length) { MD.router.navigate('/account', { address: v.toLowerCase(), sub: subs[0].id }); return { ok: true }; }
      // no perps account: a Predict wallet (the smart account the Meridian app places predictions from) opens its
      // owner's Predict tab when the owner trades perps, else its bettor page; an owner without perps its Predict wallet
      const W = MD.predict.wallets;
      const r = await W.predictAddress(v);
      if (r.error) {
        // the wallet lookup failed: the address may still have predictions of its own
        if (await W.hasActivity(v).catch(() => false)) { MD.router.navigate('/predict/bettor', { address: v.toLowerCase() }); return { ok: true }; }
        return { error: 'No perps account for this address, and its Predict wallet could not be looked up (Robinhood Chain RPC): try again' };
      }
      if (r.owner && r.owner !== v.toLowerCase()) { const os = await A.subaccountsOf(r.owner).catch(() => []); if (os.length) { MD.router.navigate('/account', { address: r.owner, sub: os[0].id, tab: 'predict' }); return { ok: true }; } }
      if (r.active !== false) { MD.router.navigate('/predict/bettor', { address: r.address }); return { ok: true }; }
      return { error: 'No Meridian perps account or Predict activity found for this address' };
    }
    if (U.isUuid(v)) {
      try { const sa = await A.subaccount(v); MD.router.navigate('/account', { address: sa.account, sub: sa.id }); return { ok: true }; }
      catch (e) { return { error: e.status === 404 ? 'Subaccount not found' : 'Lookup failed: ' + e.message }; }
    }
    return { error: 'Enter a 0x wallet address (40 hex chars) or a subaccount UUID' };
  };

  /** "How is this number calculated?" — one modal, linked from the leaderboard, the performance tab and the tax center. */
  MD.DEFINITIONS = [
    ['PnL (interval)', 'Realized PnL + trading fees + realized funding over the interval, plus the change in unrealized PnL between the start of the interval and now. All-time starts at the subaccount\'s creation.'],
    ['Equity', 'Sum of margin balances across pools (all pools are USD-equivalent tokens) + net unrealized PnL (unrealized − unsettled funding − unsettled position fees).'],
    ['ROI', 'PnL ÷ (equity at the start of the interval + deposits during it). "—" when there was nothing at risk.'],
    ['Max drawdown', 'Largest peak-to-trough decline inside the interval, in percent of a time-weighted return index: each day\'s gain or loss on the capital the account had that day, compounded. Deposits and withdrawals move neither the index nor the drawdown, so withdrawing does not count as a loss and a loss taken on small capital is not diluted by money added later. Below it, the same decline in dollars.'],
    ['Sharpe', 'Mean ÷ standard deviation of per-bucket returns (PnL over the previous bucket\'s equity), annualized. Hourly buckets for 24h, daily for 30d and all-time. Shown only with at least 10 buckets, since fewer make it noise; the 7-day interval therefore has none, and young accounts none until day 10.'],
    ['Win rate', 'Closed positions with a positive net result (realized − fees − funding) ÷ closed positions. On Predict: won ÷ (won + lost) over decided predictions. Meridian has no refund outcome: a leg that resolves 50/50 settles the prediction as a loss for the bettor.'],
    ['Settled vs claimed (Predict)', 'A prediction is settled (decided) once every leg has resolved on Meridian and the verdict is recorded (pickConfig.resolved). Results, win rates, PnL and their dates all count from that moment, across the site. It is paid out (claimed) only when the winner collects, which can be weeks later; "unclaimed" is money the winner has not collected yet, and a claim changes no figure (the tax center alone books Predict results on the claim date, when the cash arrives). "Unresolved on Meridian" is the small set of questions Meridian\x27s own resolver has not resolved although Polymarket has.'],
    ['Predict wallet', 'The Meridian app does not place predictions from the address a trader signs in with (the one that owns the perps account) but from a smart account it controls: a ZeroDev Kernel account on Robinhood Chain whose address follows from its owner. An account page\'s Predict tab, the tax center and the search use that wallet; a bettor page links back to its owner. Market makers and a few wallets that bet directly have no such account and show their own address.'],
    ['Profit factor', 'Gross profit of winning closed positions ÷ gross loss of losing ones. Above 1 means the wins outweigh the losses.'],
    ['Expectancy', 'Average net result per closed position.'],
    ['Trading style', 'Average holding time of closed positions: Scalper < 1 h, Intraday < 1 day, Swing < 7 days, otherwise Long-term.'],
    ['Copyability (Copy trading)', '0–100 for accounts with at least 5 closed positions: 35% track record (sample size, profitability, skill-not-luck: the t-statistic of the per-position result, share of profitable weeks, drawdown, liquidations, how much of the wins is one position), 45% copy friction (edge left, hold times, slippage for a $2,000 position against today\'s books, depth for the account\'s largest sizes), 20% activity (recency, cadence, days on the exchange). Parts that cannot be measured are left out of their pillar rather than counted as zero. Caps then apply with their reason shown: nothing survives copying → 40; less than all of it → 30 + 0.7 × edge left (57% left is the least that can be Copyable); fewer than 10 / 20 closed positions → 55 / 65; the result not clear of the noise (t < 2) → 60; no trade for 30 / 60 days → 60 / 45; a tenth of positions liquidated → 55; one position over 60% of all wins → 60; drawdown over 40% → 60; not profitable → scaled down and capped at 45. "Edge left" is the share of the leader\'s per-position result (plain mean over positions, both tails winsorized at 5% / 95%, after their fees and with funding) that survives a copier\'s taker fees, the price drift measured one minute after each of the leader\'s fills (one-minute oracle candles), and slippage for a $2,000 position, all counted in and out. It says how much of a result a copier could have kept, not whether there will be one.'],
    ['Funding', 'Shown with the trader\'s sign: positive = received, negative = paid (the exchange API reports the opposite).'],
    ['Fees', 'Trading fees paid. Negative fees mean fees received — the exchange\'s fee-collector subaccount looks like that and is tagged "no trades".'],
    ['Liquidation price', 'Uses the app\'s pool maths: maintenance margin = notional × (1 / (2 × max leverage) + taker fee), solved per position with the equity left after the other positions\' maintenance margin. "none" when pool equity is far above it.'],
    ['Meridian OI (Predict)', 'Collateral still in escrow on Meridian for a question: bettor stakes plus the market makers\' matching collateral of every prediction on it that has not been claimed yet (open, or decided and unclaimed); a combo counts in full on each of its questions.'],
    ['Vig (Predict)', 'Locked odds (stake ÷ pool) minus the mirrored Polymarket market\'s price at the moment the bet was placed, from Polymarket\'s price history (last sample at or before the bet; combos multiply the legs, and combos with legs on the same match or asset are shown separately because that product ignores correlation). Positive = the bettor paid above the fair price; that margin is the market maker\'s quoted edge.'],
    ['Realized edge (Predict)', 'On decided bets (claimed or not): average locked odds (the win probability bettors paid for) versus the share they actually won, with a 95% interval that allows for bets on the same question winning or losing together, and bettor ROI = each bet\'s result (payout − stake, or the stake lost) ÷ stake, as if held to the verdict, before secondary-market trades. Outcomes include correlation and bettor skill, so this is the maker\'s realized take; a gap inside the interval could be luck.'],
  ];
  MD.openDefinitions = () => MD.ui.modal({ title: 'How the numbers are calculated', body: h('div', h('div.kv', MD.DEFINITIONS.flatMap(([k, v]) => [h('div.k', k), h('div', { style: { color: 'var(--text-2)' } }, v)])), h('p.muted.small', { style: { margin: '14px 0 0' } }, 'All figures come from Meridian\'s public API and archive; nothing is estimated. Amounts are USD-equivalent (USDe-settled). Times are shown in your local time zone, except the Tax center and the per-day charts, which use UTC days.')) });
  MD.defsLink = () => h('a.defs.small', { href: '#', onclick: (e) => { e.preventDefault(); MD.openDefinitions(); } }, U.icon('help'), 'How are these calculated?');

  MD.router.pages.notfound = { async mount(root) {
    MD.setTopbar(h('span.title', 'Page not found')); document.title = 'Page not found · MeridianDataHub';
    const go = (href, icon, label) => h('a.btn.sm', { href }, U.icon(icon), label);
    U.replace(root, h('div.page', h('div.card', h('div.empty', h('div', { style: { fontSize: '15px', color: 'var(--text-1)', marginBottom: '6px' } }, 'There is no page at this address.'), h('div', { style: { marginBottom: '14px' } }, 'The link may be mistyped or from an older version of the site.'),
      h('div.row.wrap', { style: { justifyContent: 'center', gap: '6px' } }, go('#/', 'home', 'Home'), go('#/dashboard', 'grid', 'Dashboard'), go('#/leaderboard', 'trophy', 'Leaderboard'), go('#/copytrade', 'users', 'Copy trading'), go('#/predict', 'target', 'Predict'))))));
  } };

  // Account / Tax center reopen the last viewed account; before any has been viewed in this browser they open the
  // pages' own "pick an account" screens (a bare "#/" made the buttons look dead on a fresh domain).
  function lastAccountHref() { const last = U.storage.get('md.lastAccount', null); return last ? U.accountUrl(last.address, last.sub) : '#/account'; }

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
    const navLink = (n) => h('a.nav', { href: n.name === 'account' ? lastAccountHref() : n.name === 'tax' ? lastAccountHref().replace('#/account', '#/tax') : '#' + n.path, dataset: { name: n.name, path: n.path, prefix: n.prefix || '' } },
      U.icon(n.icon), h('span.lbl', n.label, n.badge ? h('span.chip.accent', { style: { marginLeft: '8px' } }, n.badge) : null), h('span.tip', n.label));
    const ext = (href, icon, label) => h('a.nav.ext', { href, target: '_blank', rel: 'noopener' }, icon, h('span.lbl', label), h('span.ext-ico', U.icon('external')), h('span.tip', label));
    U.replace(rail,
      h('a.logo', { href: '#/', title: 'MeridianDataHub' }, h('img', { src: 'assets/meridian-symbol.svg', alt: 'Meridian' }), h('span.word', 'Meridian', h('span', 'DataHub'))),
      SECTIONS.map((s) => [s.rule ? h('div.rule') : h('div.sec', s.title), s.items.map(navLink), s.rule ? h('div.rule') : null]),
      h('span.spacer'),
      navLink({ name: 'status', path: '/status', icon: 'pulse', label: 'Data status' }),
      h('div.sec', 'Meridian'),
      ext(A.APP_URL, U.svg(U.icons.meridian), 'Trade on Meridian'),
      ext('https://docs.meridian.xyz', U.icon('book'), 'Docs'),
      ext(X_URL, U.icon('x'), 'Meridian on X'),
      h('button.toggle', { type: 'button', onclick: () => { const c = !U.$('.app').classList.contains('rail-collapsed'); U.storage.set(RAIL_KEY, c); applyRail(c); } }));
    applyRail(railCollapsed());
    // collapsed rail: the hover label sits just right of the row it names (fixed, so the rail's overflow cannot clip it)
    if (!rail.__tips) { rail.__tips = true; rail.addEventListener('mouseover', (e) => { const row = e.target.closest('a.nav, .toggle'); const tip = row && row.querySelector('.tip'); if (!tip) return; const r = row.getBoundingClientRect(); tip.style.top = (r.top + r.height / 2) + 'px'; tip.style.left = (r.right + 10) + 'px'; }); }
  }

  function onRoute(route) {
    U.$$('#rail a.nav').forEach((a) => {
      const p = a.dataset.path;
      const on = p === route.path || (a.dataset.prefix && route.path.startsWith(a.dataset.prefix)) || (route.name !== 'predict' && p !== undefined && a.dataset.name === route.name);
      a.classList.toggle('active', !!on);
    });
    MD.setTopbar(h('span.title', PATH_TITLES[route.path] || TITLES[route.name] || 'MeridianDataHub'));
    const mini = U.$('#mini-search'); if (mini) mini.style.display = route.name === 'home' ? 'none' : '';
    const main = U.$('#main'); if (main) main.classList.toggle('home', route.name === 'home');
    if (route.name === 'account' && route.params.address) {
      U.storage.set('md.lastAccount', { address: route.params.address, sub: route.params.sub });
      const a = U.$('#rail a.nav[data-name="account"]'); if (a) a.href = lastAccountHref();
      const t = U.$('#rail a.nav[data-name="tax"]'); if (t) t.href = lastAccountHref().replace('#/account', '#/tax');
    }
    document.title = ((PATH_TITLES[route.path] || TITLES[route.name]) ? (PATH_TITLES[route.path] || TITLES[route.name]) + ' · ' : '') + 'MeridianDataHub';
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
    // leader alerts follow their accounts on every page, from whichever tab of this browser owns the job
    if (MD.alerts && MD.alerts.state().leaders.length) MD.alerts.start();
    A.maintenance().then((m) => { if (m && m.isEnabled) { const b = U.$('#banner'); if (b) { b.style.display = ''; U.replace(b, h('div.notice', 'Meridian is currently in maintenance mode; data may be stale.')); } } }).catch(() => {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
