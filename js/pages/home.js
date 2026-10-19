/* MeridianDataHub — Home page: the search with its shortcuts, the exchange at a glance, the top wallets, the biggest open
   positions and the latest on Predict. The rows come from the deploy's summary (data/home.json, js/home-summary.js). */
(function () {
  const MD = window.MD; const U = MD.util; const A = MD.api; const UI = MD.ui; const h = U.h;
  const isAbort = (e) => e && e.name === 'AbortError';
  const ROWS = 5;   // rows per card
  const usd0 = (x, o) => U.fmtUsd(x, Object.assign({ dp: 0 }, o));
  const mult = (m) => (m == null || !Number.isFinite(m) ? '—' : U.fmtNum(m, m < 1.01 ? 4 : m >= 100 ? 0 : 2) + '×');
  const bettorUrl = (a) => '#/predict/bettor?address=' + encodeURIComponent(a);
  const slipUrl = (id) => '#/predict/p/' + id;

  /** The home page's summary: the deploy's data/home.json, else (a deploy from before it, a local copy) the same built here
   *  from the snapshots, which is the slow way (about 2.3 MB). */
  async function loadSummary(ctx) {
    try {
      const r = await fetch('data/home.json', { cache: 'no-cache', signal: ctx.signal });
      // an unknown path answers with index.html (the site's not-found handling), so only JSON counts
      if (r.ok && /json/.test(r.headers.get('content-type') || '')) { const j = await r.json(); if (j && (j.lb || j.predict)) return j; }
    } catch (e) { if (isAbort(e)) throw e; }
    const LB = MD.router.pages.leaderboard, P = MD.predict;
    const [lb, snap, status] = await Promise.all([
      LB ? LB.loadRemote().then(() => LB.cache()).catch(() => null) : null,
      P.loadSnapshot().catch(() => null),
      P.snapshotFile('predict-status.json', { signal: ctx.signal }).catch(() => null)]);
    return MD.homeSummary.build({ lb: lb && Array.isArray(lb.rows) ? lb : null, snap: snap && snap.agg ? snap : null, status });
  }

  MD.router.pages.home = {
    async mount(root, route, ctx) {
      const err = h('div.err');
      const input = h('input', { type: 'text', placeholder: window.innerWidth <= 480 ? 'Wallet address or subaccount ID' : 'Search by wallet address or subaccount ID', autocomplete: 'off', spellcheck: false });
      const search = async (v) => { err.textContent = ''; const r = await MD.search(v); if (r && r.error) err.textContent = r.error; };
      const form = h('form', { onsubmit: (e) => { e.preventDefault(); search(input.value); } }, input, h('button', { type: 'submit', title: 'Search' }, U.icon('search')));

      // shortcuts under the search: your favorites, then your last searches that found something (this browser only)
      const shortcuts = h('div.quick.shortcuts');
      const renderShortcuts = () => {
        const favs = U.favorites.list().slice(0, 3);
        const have = new Set(favs.map((f) => String(f.address || '').toLowerCase()));
        const recent = MD.recent.list().filter((v) => !have.has(v.toLowerCase())).slice(0, 3);
        U.replace(shortcuts,
          favs.map((f) => h('a.chipbtn.ic-gold', { href: U.accountUrl(f.address, f.subaccountId), title: 'Favorite · ' + f.address + (f.name && f.name !== 'primary' ? ' · ' + f.name : '') }, U.icon('starFill'), ' ' + U.shortAddr(f.address))),
          recent.map((v) => h('button.chipbtn.ic-blue', { type: 'button', title: 'Recent search · ' + v, onclick: () => search(v) }, U.icon('search'), ' ' + U.shortAddr(v))),
          recent.length ? h('button.chipbtn.icon', { type: 'button', title: 'Forget the recent searches', 'aria-label': 'Forget the recent searches', onclick: () => { MD.recent.clear(); renderShortcuts(); } }, U.icon('x')) : null);
      };
      renderShortcuts();
      ctx.onCleanup(U.on('favorites', renderShortcuts));

      // the sections, each with one live figure beside its name (filled as its source answers)
      const figs = {};
      const go = (key, href, icon, label, color) => { figs[key] = h('span.n'); return h('a.chipbtn', { href, class: 'ic-' + color }, U.icon(icon), ' ' + label, figs[key]); };
      const setFig = (key, text) => { if (figs[key]) figs[key].textContent = text ? ' · ' + text : ''; };
      const hero = h('div.hero',
        h('h1', 'Explore ', h('span', 'Meridian'), ' account performance'),
        h('div.sub', 'Public perps and Predict analytics, copy trading and tax records for every account on Meridian · Robinhood Chain'),
        form, err, shortcuts,
        h('div.quick',
          go('dash', '#/dashboard', 'grid', 'Markets dashboard', 'blue'), go('lb', '#/leaderboard', 'trophyFill', 'Leaderboard', 'gold'), go('fav', '#/favorites', 'starFill', 'Favorites', 'gold'),
          go('pred', '#/predict', 'target', 'Predict', 'orange'), go('copy', '#/copytrade', 'users', 'Copy trading', 'purple'), go('tax', '#/tax', 'receipt', 'Tax center', 'green')));
      const favCount = () => { const n = U.favorites.list().length; setFig('fav', n ? n + ' saved' : ''); };
      favCount(); ctx.onCleanup(U.on('favorites', favCount));
      if (MD.tax && MD.tax.CCY) setFig('tax', MD.tax.CCY.length + ' currencies');

      // the exchange at a glance: each tile fills in as its source answers ('—' until then, or when it fails)
      const tiles = h('div.stats');
      let ex = null, ps = null;   // perps figures, the Predict snapshot's status
      const renderTiles = () => U.replace(tiles,
        UI.stat(h('span', { title: '24 h traded quantity × current oracle price, summed over markets' }, '24h volume'), ex ? U.fmtUsd(ex.vol, { compact: true }) : '—', ex ? 'all markets' : null),
        UI.stat(h('span', { title: 'Long and short positions added together, as Meridian reports open interest' }, 'Open interest'), ex ? U.fmtUsd(ex.oi, { compact: true }) : '—', ex ? 'long + short · one side ' + U.fmtUsd(ex.oi / 2, { compact: true }) : null),
        UI.stat('Perps accounts', ex && ex.accounts != null ? U.fmtNum(ex.accounts, 0) : '—', ex && ex.newest ? 'newest ' + U.fmtAgo(ex.newest) : null),
        UI.stat('Predict bettors', ps ? U.fmtNum(ps.bettors, 0) : '—', ps ? U.fmtNum(ps.predictions, 0) + ' predictions' : null),
        UI.stat('Live questions', ps ? U.fmtNum(ps.questionsLive, 0) : '—', ps ? 'with money on them' : null));
      renderTiles();

      const card = (icon, color, title, note, href, linkText, body) => h('div.card.tight', h('div.card-head', h('span.card-ic', { class: 'ic-' + color }, U.icon(icon)), h('h2', title), note, h('span.grow'), h('a.small', { href }, linkText)), body);
      const topNote = h('span.dim.small'), topBody = h('div', UI.loading());
      const posNote = h('span.dim.small', 'live'), posBody = h('div', UI.loading());
      const winsNote = h('span.dim.small'), winsBody = h('div', UI.loading());
      const betsNote = h('span.dim.small'), betsBody = h('div', UI.loading());
      const foot = h('div.footer-note');
      root.appendChild(h('div.page', hero, h('div.home-body', h('div.stack', tiles,
        h('div.grid.cols-2', card('trophyFill', 'gold', 'Top wallets', topNote, '#/leaderboard', 'Leaderboard', topBody), card('activity', 'cyan', 'Biggest open positions', posNote, '#/dashboard', 'Dashboard', posBody)),
        h('div.grid.cols-2', card('target', 'green', 'Big Predict wins', winsNote, '#/predict', 'Predict', winsBody), card('ticket', 'pink', 'Latest big bets', betsNote, '#/predict', 'Predict', betsBody)),
        foot))));
      setTimeout(() => input.focus(), 50);

      // ---- perps, live: markets, volume and open interest at the oracle price, accounts ----
      const refP = A.ref({ signal: ctx.signal });
      const pricesP = refP.then((ref) => A.marketPrices(ref.active.map((p) => p.id), { signal: ctx.signal, ttl: 30000 }));
      pricesP.catch(() => {});   // each user of them reports its own failure
      (async () => {
        try {
          const [ref, prices, subs] = await Promise.all([refP, pricesP, A.allSubaccounts({ signal: ctx.signal }).catch(() => null)]);
          let vol = 0, oi = 0;
          for (const p of ref.active) { const px = prices[p.id]; const o = px ? U.num(px.oraclePrice) : 0; vol += U.num(p.volume24h) * o; oi += U.num(p.openInterest) * o; }
          ex = { vol, oi, accounts: subs ? subs.length : null, newest: subs && subs.length ? Math.max(...subs.map((s) => s.createdAt)) : null };
          renderTiles(); setFig('dash', ref.active.length + ' markets');
        } catch (e) { if (!isAbort(e)) console.warn('home: exchange figures', e); }
      })();

      let sum;
      try { sum = await loadSummary(ctx); } catch (e) { if (isAbort(e)) return; sum = {}; }
      if (ctx.signal.aborted) return;
      const lb = sum.lb, pr = sum.predict;
      if (sum.status) { ps = sum.status; renderTiles(); }
      if (lb) { setFig('lb', U.fmtNum(lb.accounts, 0) + ' accounts'); setFig('copy', U.fmtNum(lb.copyable, 0) + ' copyable'); }
      if (pr && pr.week && pr.week.wagered) setFig('pred', U.fmtUsd(pr.week.wagered, { compact: true }) + ' wagered in 7 days');

      // ---- top wallets: all-time PnL as Meridian's app shows it, traders only (js/home-summary.js) ----
      if (!lb) U.replace(topBody, UI.empty(h('span', h('a', { href: '#/leaderboard' }, 'Build the leaderboard'), h('span.dim', ' to see the top accounts here'))));
      else {
        const AN = MD.analytics, LB = MD.router.pages.leaderboard;
        // the ranking says, as the Leaderboard does, when accounts are missing from it or carried over, and when it is stale
        U.replace(topNote, h('span', { title: 'All-time PnL as Meridian\'s app shows it (its Trade Stats): realized PnL, settled funding and trading fees, plus unrealized PnL; ROI on the deposits. Hover a wallet for the site\'s net figure' }, 'by all-time PnL', LB ? LB.coverageNote(lb) : null, UI.staleNote(lb.builtAt, 'the publishing job may be down')));
        U.replace(topBody, UI.table({ cols: [
          { key: 'rk', label: '#', render: (r) => UI.rank(lb.top.indexOf(r) + 1) },
          // a row carried over from an earlier build (the snapshot could not rebuild it) says how old its figures are
          { key: 'w', label: 'Wallet', render: (r) => h('a.addr', { href: U.accountUrl(r.account, r.sid), title: [r.carried ? `These figures are from the build of ${U.fmtWhen(r.builtAt)} (${U.fmtAgo(r.builtAt)}): the latest snapshot could not rebuild this account` : null, AN.sitePnlTitle(r, 'all'), r.style && r.style !== '—' ? 'Style: ' + r.style : null].filter(Boolean).join('\n') }, U.shortAddr(r.account)) },
          { key: 'p', label: 'PnL', num: true, render: (r) => U.pnlEl(r.stats.all.pnl) },
          // a big account's small percentage reads "+0.3%", not "+0%"
          { key: 'roi', label: 'ROI', num: true, render: (r) => (r.stats.all.roi == null ? '—' : h('span', { class: U.pnlClass(r.stats.all.roi) }, U.fmtPct(r.stats.all.roi, { sign: true, dp: Math.abs(r.stats.all.roi) < 10 ? 1 : 0 }))) },
        ], rows: lb.top, empty: 'No traders in the snapshot yet', onRow: (r) => { location.hash = U.accountUrl(r.account, r.sid).slice(1); } }));
      }

      // ---- biggest open positions, live: the positions of the biggest books in the last snapshot, the largest first ----
      async function positions() {
        const books = (lb && lb.books) || [];
        if (!books.length) { U.replace(posBody, UI.empty(lb ? 'No open positions in the last snapshot' : 'Appears with the leaderboard snapshot')); return; }
        try {
          const [ref, prices] = await Promise.all([refP, pricesP]);
          const o = { signal: ctx.signal, ttl: 30000 };
          const per = await Promise.all(books.map((b) => Promise.all([A.openPositions(b.sid, o), A.balances(b.sid, o)])
            .then(([pos, bal]) => (pos.length ? MD.analytics.accountState({ balances: bal, positions: pos, ref, prices }).positions.map((r) => ({ b, r })) : []))
            .catch((e) => { if (isAbort(e)) throw e; return []; })));
          const rows = U.sortBy(per.flat(), (x) => x.r.notional, true).slice(0, ROWS);
          U.replace(posNote, `live · the ${books.length} biggest books in the last snapshot`);
          U.replace(posBody, UI.table({ cols: [
            { key: 'w', label: 'Wallet', render: (x) => h('a.addr', { href: U.accountUrl(x.b.account, x.b.sid) }, U.shortAddr(x.b.account)) },
            { key: 'm', label: 'Market', render: (x) => x.r.ticker },
            { key: 'side', label: 'Side', render: (x) => U.sideEl(x.r.long, true) },
            { key: 'n', label: 'Size', num: true, title: 'Notional at the oracle price', render: (x) => U.fmtUsd(x.r.notional, { compact: true }) },
            { key: 'u', label: 'uPnL', num: true, title: 'Unrealized PnL, as Meridian\'s app shows it: (oracle price − entry price) × size', render: (x) => U.pnlEl(x.r.upnl, { compact: true }) },
            { key: 'liq', label: 'To liq.', num: true, title: 'How far the price can move against the position before its margin pool is liquidated (in a cross pool, the other positions move it too)', render: (x) => (x.r.distPct == null ? '—' : h('span', { class: x.r.distPct < 5 ? 'neg' : '' }, U.fmtPct(x.r.distPct, { dp: 1 }))) },
          ], rows, empty: 'None of them has a position open right now', phone: { title: 'm', aside: 'u' }, onRow: (x) => { location.hash = U.accountUrl(x.b.account, x.b.sid).slice(1); } }));
        } catch (e) { if (!isAbort(e)) U.replace(posBody, UI.error(e)); }
      }
      positions();
      const posT = setInterval(positions, 60000); ctx.onCleanup(() => clearInterval(posT));

      // ---- big Predict wins and the latest big bets (as of the Predict snapshot); a row opens the slip ----
      const P = MD.predict;
      // the bettor's address opens its page (.opt: a narrow card leaves it out, the slip has it)
      const predRow = (n, at, ...cells) => h('div.it.click', { title: 'Open the slip', tabindex: 0, onclick: () => { location.hash = slipUrl(n.id); }, onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) location.hash = slipUrl(n.id); } },
        h('span.t', { title: U.fmtDateTime(at) }, U.fmtAgo(at)),
        h('a.addr.opt', { href: bettorUrl(n.predictor), title: n.predictor, onclick: (e) => e.stopPropagation() }, U.shortAddr(n.predictor, 4)),
        h('span.grow.ellipsis', { title: n.picks.map((k) => (k.yes === true ? 'YES · ' : k.yes === false ? 'NO · ' : '') + k.q).join('\n') }, n.picks[0] ? n.picks[0].q : '', n.legs > 1 ? h('span.dim.xs', ' +' + (n.legs - 1) + (n.legs === 2 ? ' leg' : ' legs')) : null),
        ...cells);
      if (!pr) { U.replace(winsBody, UI.empty('Appears with the Predict snapshot')); U.replace(betsBody, UI.empty('Appears with the Predict snapshot')); }
      else {
        const age = () => [' · snapshot ' + U.fmtAgo(pr.builtAt), UI.staleNote(pr.builtAt, 'the Predict publishing job may be down')];
        const wins = pr.wins.map(P.full);
        U.replace(winsNote, h('span', { title: 'Net PnL = payout − stake; a bettor who sold its position tokens before the verdict counts its own result, sales included' }, 'profit over ' + usd0(P.BIG_WIN), ...age()));
        U.replace(winsBody, wins.length ? h('div.feed', wins.map((n) => predRow(n, MD.homeSummary.winAt(n),
          P.fromSale(n) ? UI.chip('cashed out', 'amber') : null,
          h('span.num.fix', { class: U.pnlClass(P.bigPnl(n)) }, usd0(P.bigPnl(n), { sign: true }))))) : UI.empty(pr.hasWins ? 'No win over ' + usd0(P.BIG_WIN) + ' yet' : 'Big wins arrive with the next snapshot'));
        const bets = pr.bets.map(P.full);
        U.replace(betsNote, h('span', 'stakes of ' + usd0(P.BIG_BET) + ' or more', ...age()));
        U.replace(betsBody, bets.length ? h('div.feed', bets.map((n) => predRow(n, n.t,
          n.picks[0] && n.picks[0].yes != null ? UI.chip(n.picks[0].yes ? 'YES' : 'NO', n.picks[0].yes ? 'green' : 'red') : null,
          h('span.num.fix', usd0(n.stake)),
          h('span.num.dim.fix.opt', { title: 'Pays this many times the stake if it wins' }, mult(n.multiple))))) : UI.empty(pr.fullBets ? 'No bet of ' + usd0(P.BIG_BET) + ' or more yet' : 'No bet of ' + usd0(P.BIG_BET) + ' or more among the latest 25'));
      }

      U.replace(foot, h('a', { href: A.APP_URL, target: '_blank', rel: 'noopener' }, 'app.meridian.xyz'), ' · ', h('a', { href: '#/status', title: 'How old the published snapshots are' }, 'Data updated ', lb && lb.builtAt ? U.fmtAgo(lb.builtAt) : '—'));
    },
  };
})();
