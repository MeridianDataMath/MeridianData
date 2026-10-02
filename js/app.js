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

  /** "How is this number calculated?" — one modal, linked from the leaderboard, copy trading, the Performance tab and the tax center. */
  MD.DEFINITIONS = [
    ['PnL (interval)', 'Realized PnL − trading fees − mPerp position fees + funding over the interval, plus the change in unrealized PnL from the start of the interval to now. Funding counts when the exchange charges it each hour, including funding charged to open positions and not yet settled into the balance; unrealized PnL is net of that unsettled funding at both ends (and of unsettled position fees at the end). Position fees are not in the exchange\'s daily ledger: they are the balance change it records no deposit, withdrawal, conversion, trade, fee or funding entry for. An interval starts at the first archive bucket boundary at or after its nominal start (within 1 hour for 24h, 2 hours for 7d, 8 hours for 30d); all-time starts at the subaccount\'s creation. The leaderboard, home, favorites and copy trading read the leaderboard snapshot (published every 30 minutes, or rebuilt in your browser with Update).'],
    ['Equity', 'Sum of margin balances across pools (all pools are USD-equivalent tokens) + net unrealized PnL (unrealized − unsettled funding − unsettled position fees).'],
    ['ROI', 'PnL ÷ (equity at the start of the interval + deposits during it). "—" when there was nothing at risk.'],
    ['Max drawdown', 'Largest peak-to-trough decline inside the interval, in percent of a time-weighted return index: each bucket\'s gain or loss on the capital the account had in it (equity at its start plus deposits during it), compounded. Buckets are 1 hour for 24h, 2 hours for 7d, 8 hours for 30d and 1 day for all-time, on the leaderboard, the account page and the cards alike; finer buckets catch swings inside a day, so a shorter interval can show a deeper drawdown than a longer one. Deposits and withdrawals move neither the index nor the drawdown, so withdrawing does not count as a loss and a loss taken on small capital is not diluted by money added later. On the account page, the figure below it is the largest decline in dollars of cumulative PnL (deposits and withdrawals left out).'],
    ['Sharpe', 'Mean ÷ standard deviation of per-bucket returns (PnL over the previous bucket\'s equity), annualized. Buckets: 1 hour for 24h, 2 hours for 7d, 8 hours for 30d, 1 day for all-time, on the leaderboard and the account page alike. Shown only with at least 10 returns, at least 3 of them non-zero, since fewer make it noise; an account\'s first bucket has no prior equity, so its all-time Sharpe appears from its 11th day at the earliest.'],
    ['Win rate', 'Closed positions with a positive net result (realized − trading fees − position fees + funding received − funding paid) ÷ closed positions. On Predict: won ÷ (won + lost) over decided predictions. Meridian has no refund outcome: a leg that resolves 50/50 settles the prediction as a loss for the bettor.'],
    ['Settled vs claimed (Predict)', 'A prediction is settled (decided) once every leg has resolved on Meridian and the verdict is recorded (pickConfig.resolved). Results, win rates, PnL and their dates all count from that moment, across the site. It is paid out (claimed) only when the winner collects, which can be weeks later; "unclaimed" is money the winner has not collected yet, and a claim changes no figure (the tax center alone books Predict results on the claim date, when the cash arrives). "Unresolved on Meridian" is the small set of questions Meridian\x27s own resolver has not resolved although Polymarket has.'],
    ['Predict wallet', 'The Meridian app does not place predictions from the address a trader signs in with (the one that owns the perps account) but from a smart account it controls: a ZeroDev Kernel account on Robinhood Chain whose address follows from its owner. An account page\'s Predict tab, the tax center and the search use that wallet; a bettor page links back to its owner. Market makers and a few wallets that bet directly have no such account and show their own address.'],
    ['Profit factor', 'Sum of the net results (realized − trading fees − position fees + funding received − funding paid) of winning closed positions ÷ the absolute sum for losing ones; ∞ when there are wins and no losses. Above 1 means the wins outweigh the losses.'],
    ['Expectancy', 'Average net result per closed position.'],
    ['Trading style', 'Average holding time of closed positions: Scalper < 1 h, Intraday < 1 day, Swing < 7 days, otherwise Long-term.'],
    ['Copyability (Copy trading)', '0–100 for accounts with at least 5 closed positions: 35% track record (sample size, profitability, clear of noise: the t-statistic of the per-position result, share of profitable weeks (Monday to Sunday, UTC), drawdown, liquidations, how much of the wins is one position), 45% copy friction (edge left, hold times, slippage for a $2,000 position (or the account\'s median entry size when smaller) against today\'s books, the share of a 90th-percentile-size order today\'s books fill within 1% of the mid), 20% activity (recency, cadence, days on the exchange). Parts that cannot be measured are left out of their pillar rather than counted as zero. Caps then apply with their reason shown: a per-position result that is not positive after fees and funding, or nothing of it surviving copying → 40; less than all of it → 30 + 0.7 × edge left (57% left is the least that can be Copyable); fewer than 10 / 20 closed positions → 55 / 65; from 10 closed positions, the result not clear of the noise (t < 2) → 60; their sizes exceed today\'s books (under 50% of a 90th-percentile order fills within 1%) → 60; no trade for 30 / 60 days → 60 / 45; a tenth of positions liquidated → 55; one position 60% or more of all wins → 60; drawdown of 40% or more → 60; not profitable → scaled down by 40% and capped at 45. "Edge left" is the share of the leader\'s per-position result (plain mean over positions, from 10 positions on with the most extreme 5% on each side (at least one position) winsorized, after their trading and position fees and with funding) that survives a copier\'s taker fees, the price drift one minute after the leader\'s most recent fills (up to 400, on one-minute oracle candles; fills more than 5% from the oracle left out), and slippage for a $2,000 position (or the leader\'s median entry size when smaller), all counted in and out. It says how much of a result a copier could have kept, not whether there will be one.'],
    ['Funding', 'Shown with the trader\'s sign: positive = received, negative = paid. Meridian charges funding every hour but moves it into the balance only when the position is increased, reduced or closed; until then it is the position\'s unsettled funding, shown in the positions tables and included in net unrealized PnL. PnL and the Funding figures count funding when it is charged; a figure labelled "settled" counts it when it reaches the balance, and the Tax center books it as the exchange\'s daily ledger does, when it settles. The archive\'s realizedFunding already uses the trader\'s sign; the position endpoints (fundingUsd, fundingAccruedUsd) and the archive\'s funding history report the opposite, and the site flips them.'],
    ['Fees', 'Trading fees paid, plus mPerp position fees where an account paid them (the account page shows the split). Negative fees mean fees received — the exchange\'s fee-collector subaccount looks like that and is tagged "no trades".'],
    ['Liquidation price', 'An estimate from the app\'s pool maths: maintenance margin = notional × (1 / (2 × max leverage) + taker fee), solved per position with the equity left after the other positions\' maintenance margin, the other positions held at their marks. "none" when even a fall to zero would not liquidate a long; a liquidation more than 500% from the mark is tagged ">500%".'],
    ['Meridian OI (Predict)', 'Collateral still in escrow on Meridian for a question: bettor stakes plus the market makers\' matching collateral of every prediction on it that has not been claimed yet (open, or decided and unclaimed); a combo counts in full on each of its questions.'],
    ['Vig (Predict)', 'Locked odds (stake ÷ pool) minus the mirrored Polymarket market\'s price at the moment the bet was placed, from Polymarket\'s price history (last sample at or before the bet; combos multiply the legs, and combos with legs on the same match or asset are shown separately because that product ignores correlation). Positive = the bettor paid above the fair price; that margin is the market maker\'s quoted edge.'],
    ['Realized edge (Predict)', 'On decided bets (claimed or not): average locked odds (the win probability bettors paid for) versus the share they actually won, with a 95% interval that allows for bets on the same question winning or losing together, and bettor ROI = each bet\'s result (payout − stake, or the stake lost) ÷ stake, as if held to the verdict, before secondary-market trades. Outcomes include correlation and bettor skill, so this is the maker\'s realized take; a gap inside the interval could be luck.'],
  ];
  MD.openDefinitions = () => MD.ui.modal({ title: 'How the numbers are calculated', body: h('div', h('div.kv', MD.DEFINITIONS.flatMap(([k, v]) => [h('div.k', k), h('div', { style: { color: 'var(--text-2)' } }, v)])), h('p.muted.small', { style: { margin: '14px 0 0' } }, 'Perps figures are computed from Meridian\'s public API, archive and oracle price candles. Predict figures come from Meridian Predict\'s API, plus Polymarket\'s prices and resolutions and reads from Polygon and Robinhood Chain where a page or definition says so; values taken from a snapshot before Polymarket answers are marked as estimates. Some figures are the site\'s own calculations rather than values the exchange reports, and their definitions or tooltips say so: liquidation prices, the PnL a take-profit or stop-loss would book at its level (before fees), copyability\'s slippage and edge left, the copy simulator\'s and paper copy\'s fills, and the 24h volume (24h base volume at today\'s price). The Tax center adds two of its own: report-currency amounts at ECB daily reference rates (via frankfurter.dev), and mPerp position fees spread over each position\'s holding time. Amounts are USD-equivalent (USDe-settled) unless another report currency is chosen in the Tax center. Times are shown in your local time zone unless marked UTC; the Tax center, the per-day charts and the share cards use UTC days.')) });
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
