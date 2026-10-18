/* MeridianDataHub — Home page: the search, the exchange at a glance, the top wallets and the latest on perps and Predict */
(function () {
  const MD = window.MD; const U = MD.util; const A = MD.api; const UI = MD.ui; const h = U.h;
  const isAbort = (e) => e && e.name === 'AbortError';
  const ROWS = 5;   // rows per card
  const usd0 = (x, o) => U.fmtUsd(x, Object.assign({ dp: 0 }, o));
  const mult = (m) => (m == null || !Number.isFinite(m) ? '—' : U.fmtNum(m, m < 1.01 ? 4 : m >= 100 ? 0 : 2) + '×');
  const bettorUrl = (a) => '#/predict/bettor?address=' + encodeURIComponent(a);
  const slipUrl = (id) => '#/predict/p/' + id;

  MD.router.pages.home = {
    async mount(root, route, ctx) {
      const err = h('div.err');
      const input = h('input', { type: 'text', placeholder: window.innerWidth <= 480 ? 'Wallet address or subaccount ID' : 'Search by wallet address or subaccount ID', autocomplete: 'off', spellcheck: false });
      const form = h('form', { onsubmit: async (e) => { e.preventDefault(); err.textContent = ''; const r = await MD.search(input.value); if (r && r.error) err.textContent = r.error; } }, input, h('button', { type: 'submit', title: 'Search' }, U.icon('search')));
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
          h('a.chipbtn', { href: '#/tax' }, U.icon('receipt'), ' Tax center')));

      // the exchange at a glance: each tile fills in as its source answers ('—' until then, or when it fails)
      const tiles = h('div.stats');
      let ex = null, ps = null;   // perps figures, the Predict snapshot's status file
      const renderTiles = () => U.replace(tiles,
        UI.stat(h('span', { title: '24 h traded quantity × current oracle price, summed over markets' }, '24h volume'), ex ? U.fmtUsd(ex.vol, { compact: true }) : '—', ex ? ex.markets + ' markets' : null),
        UI.stat(h('span', { title: 'Long and short positions added together, as Meridian reports open interest' }, 'Open interest'), ex ? U.fmtUsd(ex.oi, { compact: true }) : '—', ex ? 'long + short · one side ' + U.fmtUsd(ex.oi / 2, { compact: true }) : null),
        UI.stat('Perps accounts', ex && ex.accounts != null ? U.fmtNum(ex.accounts, 0) : '—', ex && ex.newest ? 'newest ' + U.fmtAgo(ex.newest) : null),
        UI.stat('Predict bettors', ps ? U.fmtNum(ps.bettors, 0) : '—', ps ? U.fmtNum(ps.predictions, 0) + ' predictions' : null),
        UI.stat('Live questions', ps ? U.fmtNum(ps.questionsLive, 0) : '—', ps ? 'with money on them' : null));
      renderTiles();

      const card = (title, note, href, linkText, body) => h('div.card.tight', h('div.card-head', h('h2', title), note, h('span.grow'), h('a.small', { href }, linkText)), body);
      const topNote = h('span.dim.small'), topBody = h('div', UI.loading());
      const liqBody = h('div', UI.loading());
      const winsNote = h('span.dim.small'), winsBody = h('div', UI.loading('Loading Predict data…'));
      const betsNote = h('span.dim.small'), betsBody = h('div', UI.loading('Loading Predict data…'));
      const foot = h('div.footer-note');
      root.appendChild(h('div.page', hero, h('div.home-body', h('div.stack', tiles,
        h('div.grid.cols-2', card('Top wallets', topNote, '#/leaderboard', 'Leaderboard', topBody), card('Recent liquidations', h('span.dim.small', 'perps · newest first'), '#/dashboard', 'Dashboard', liqBody)),
        h('div.grid.cols-2', card('Big Predict wins', winsNote, '#/predict', 'Predict', winsBody), card('Latest big bets', betsNote, '#/predict', 'Predict', betsBody)),
        foot))));
      setTimeout(() => input.focus(), 50);

      // ---- top wallets, from the leaderboard snapshot (published or built in this browser) ----
      // ranked by all-time PnL as Meridian's app shows it (the rows' basis 'app': realized PnL, settled funding and trading
      // fees, plus unrealized PnL). These are traders to copy, so the fee collector (no trades), the exchange's own account
      // and the market makers are left out
      async function topWallets() {
        const LB = MD.router.pages.leaderboard; const AN = MD.analytics;
        if (LB) await LB.loadRemote();
        if (ctx.signal.aborted) return null;
        const lb = LB && LB.cache();
        if (!lb || !lb.rows || !lb.rows.length) { U.replace(topBody, UI.empty(h('span', h('a', { href: '#/leaderboard' }, 'Build the leaderboard'), h('span.dim', ' to see the top accounts here')))); return lb; }
        const rows = lb.rows.filter((r) => !r.inactive && r.stats && r.stats.all && !AN.noTrades(r) && !AN.exchangeAccount(r) && !AN.marketMaker(r));
        const top = U.sortBy(rows, (r) => r.stats.all.pnl, true).slice(0, ROWS);
        // the ranking says, as the Leaderboard does, when accounts are missing from it or carried over, and when it is stale
        U.replace(topNote, h('span', { title: 'All-time PnL as Meridian\'s app shows it (its Trade Stats): realized PnL, settled funding and trading fees, plus unrealized PnL; ROI on the deposits. Hover a wallet for the site\'s net figure' }, 'by all-time PnL', LB.coverageNote(lb), UI.staleNote(lb.builtAt, 'the publishing job may be down')));
        U.replace(topBody, UI.table({ cols: [
          { key: 'rk', label: '#', render: (r) => { const i = top.indexOf(r); return h('span.rank', { class: i < 3 ? 'top' : '' }, String(i + 1)); } },
          // a row carried over from an earlier build (the snapshot could not rebuild it) says how old its figures are
          { key: 'w', label: 'Wallet', render: (r) => h('a.addr', { href: U.accountUrl(r.account, r.sid), title: [r.carried ? `These figures are from the build of ${U.fmtWhen(r.builtAt)} (${U.fmtAgo(r.builtAt)}): the latest snapshot could not rebuild this account` : null, AN.sitePnlTitle(r, 'all'), r.style && r.style !== '—' ? 'Style: ' + r.style : null].filter(Boolean).join('\n') }, U.shortAddr(r.account)) },
          { key: 'p', label: 'PnL', num: true, render: (r) => U.pnlEl(r.stats.all.pnl) },
          // a big account's small percentage reads "+0.3%", not "+0%"
          { key: 'roi', label: 'ROI', num: true, render: (r) => (r.stats.all.roi == null ? '—' : h('span', { class: U.pnlClass(r.stats.all.roi) }, U.fmtPct(r.stats.all.roi, { sign: true, dp: Math.abs(r.stats.all.roi) < 10 ? 1 : 0 }))) },
        ], rows: top, empty: 'No traders in the snapshot yet', onRow: (r) => { location.hash = U.accountUrl(r.account, r.sid).slice(1); } }));
        return lb;
      }

      // ---- the perps tiles: markets, volume and open interest at the oracle price, accounts ----
      const refP = A.ref({ signal: ctx.signal });
      refP.catch(() => {});   // each user of it reports its own failure
      async function exchange() {
        try {
          const ref = await refP;
          const ids = ref.active.map((p) => p.id);
          const [prices, subs] = await Promise.all([A.marketPrices(ids, { signal: ctx.signal, ttl: 30000 }), A.allSubaccounts({ signal: ctx.signal }).catch(() => null)]);
          let vol = 0, oi = 0;
          for (const p of ref.active) { const px = prices[p.id]; const o = px ? U.num(px.oraclePrice) : 0; vol += U.num(p.volume24h) * o; oi += U.num(p.openInterest) * o; }
          ex = { markets: ref.active.length, vol, oi, accounts: subs ? subs.length : null, newest: subs && subs.length ? Math.max(...subs.map((s) => s.createdAt)) : null };
          renderTiles();
        } catch (e) { if (!isAbort(e)) console.warn('home: exchange stats', e); }
      }

      // ---- the Predict tiles: the snapshot's small status file, so they do not wait for the snapshot itself ----
      async function predictStatus() {
        try { ps = await MD.predict.snapshotFile('predict-status.json', { signal: ctx.signal }); if (ps) renderTiles(); } catch (e) { if (!isAbort(e)) console.warn('home: predict status', e); }
      }

      // ---- recent liquidations (as on the Dashboard, the newest few) ----
      async function liquidations() {
        try {
          const [rows, ref] = await Promise.all([A.liquidations(ROWS, ctx), refP.catch(() => null)]);
          const prod = (r) => ref && ref.byId[r.productId];
          U.replace(liqBody, UI.table({ cols: [
            // the row opens the liquidated account
            { key: 't', label: 'When', render: (r) => h('span.dim', { title: U.fmtDateTimeS(r.createdAt) + ' · account ' + r.subaccountId }, U.fmtAgo(r.createdAt)) },
            { key: 'm', label: 'Market', render: (r) => (prod(r) ? prod(r).displayTicker : '—') },
            { key: 'side', label: 'Side', render: (r) => U.sideEl(r.positionSide, true) },
            { key: 'cost', label: 'Notional', num: true, title: 'USD value of the position closed by the liquidation (size × liquidation fill price), as the exchange reports it; not the trader\'s loss', render: (r) => U.fmtUsd(r.cost) },
          ], rows: rows.slice(0, ROWS), empty: 'No liquidations recorded', onRow: (r) => { location.hash = U.accountUrl('', r.subaccountId).slice(1); } }));
        } catch (e) { if (!isAbort(e)) U.replace(liqBody, UI.error(e)); }
      }

      // ---- big wins and big bets, from the Predict snapshot (the download the Predict pages share) ----
      // a row opens the slip; the bettor's address opens its page (.opt: a narrow card leaves it out, the slip has it)
      const predRow = (n, at, ...cells) => h('div.it.click', { title: 'Open the slip', tabindex: 0, onclick: () => { location.hash = slipUrl(n.id); }, onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) location.hash = slipUrl(n.id); } },
        h('span.t', { title: U.fmtDateTime(at) }, U.fmtAgo(at)),
        h('a.addr.opt', { href: bettorUrl(n.predictor), title: n.predictor, onclick: (e) => e.stopPropagation() }, U.shortAddr(n.predictor, 4)),
        h('span.grow.ellipsis', { title: n.picks.map((k) => (k.yes === true ? 'YES · ' : k.yes === false ? 'NO · ' : '') + k.q).join('\n') }, n.picks[0] ? n.picks[0].q : '', n.legs > 1 ? h('span.dim.xs', ' +' + (n.legs - 1) + (n.legs === 2 ? ' leg' : ' legs')) : null),
        ...cells);
      async function predict() {
        const P = MD.predict;
        let snap;
        try { snap = await P.loadSnapshot(); } catch (e) { if (!isAbort(e)) { U.replace(winsBody, UI.error(e)); U.replace(betsBody, UI.error(e)); } return; }
        if (ctx.signal.aborted || !snap || !snap.agg) return;
        const a = snap.agg;
        const age = () => [' · snapshot ' + U.fmtAgo(snap.builtAt), UI.staleNote(snap.builtAt, 'the Predict publishing job may be down')];
        // big wins, the latest first: a win from its settlement, a cash-out from its last sale (as the Overview's Recent)
        const winAt = (n) => (P.fromSale(n) ? n.cashOut.t : P.decidedAt(n));
        const wins = U.sortBy((a.bigWins || []).map(P.full).filter((n) => P.bigPnl(n) > P.BIG_WIN), winAt, true).slice(0, ROWS);
        U.replace(winsNote, h('span', { title: 'Net PnL = payout − stake; a bettor who sold its position tokens before the verdict counts its own result, sales included' }, 'profit over ' + usd0(P.BIG_WIN), ...age()));
        U.replace(winsBody, wins.length ? h('div.feed', wins.map((n) => predRow(n, winAt(n),
          P.fromSale(n) ? UI.chip('cashed out', 'amber') : null,
          h('span.num.fix', { class: U.pnlClass(P.bigPnl(n)) }, usd0(P.bigPnl(n), { sign: true }))))) : UI.empty(a.bigWins ? 'No win over ' + usd0(P.BIG_WIN) + ' yet' : 'Big wins arrive with the next snapshot'));
        // big bets, the newest first (a snapshot from before agg.bigBets: the big ones among its newest 25)
        const bets = (a.bigBets || (a.tape || []).filter((x) => x.stake >= P.BIG_BET)).slice(0, ROWS).map(P.full);
        U.replace(betsNote, h('span', 'stakes of ' + usd0(P.BIG_BET) + ' or more', ...age()));
        U.replace(betsBody, bets.length ? h('div.feed', bets.map((n) => predRow(n, n.t,
          n.picks[0] && n.picks[0].yes != null ? UI.chip(n.picks[0].yes ? 'YES' : 'NO', n.picks[0].yes ? 'green' : 'red') : null,
          h('span.num.fix', usd0(n.stake)),
          h('span.num.dim.fix.opt', { title: 'Pays this many times the stake if it wins' }, mult(n.multiple))))) : UI.empty(a.bigBets ? 'No bet of ' + usd0(P.BIG_BET) + ' or more yet' : 'No bet of ' + usd0(P.BIG_BET) + ' or more among the latest 25'));
      }

      exchange(); predictStatus(); liquidations();
      predict().catch((e) => { if (!isAbort(e)) { console.error(e); U.replace(winsBody, UI.error(e)); U.replace(betsBody, UI.error(e)); } });
      const lb = await topWallets().catch((e) => { if (!isAbort(e)) U.replace(topBody, UI.error(e)); return null; });
      if (ctx.signal.aborted) return;
      U.replace(foot, h('a', { href: A.APP_URL, target: '_blank', rel: 'noopener' }, 'app.meridian.xyz'), ' · ', h('a', { href: '#/status', title: 'How old the published snapshots are' }, 'Data updated ', lb && lb.builtAt ? U.fmtAgo(lb.builtAt) : '—'));
    },
  };
})();
