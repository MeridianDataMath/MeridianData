/* MeridianDataHub — Home page: the search with its shortcuts, the exchange at a glance, the top wallets, the biggest open
   positions and the latest on Predict. The rows come from the deploy's summary (data/home.json, js/home-summary.js). */
(function () {
  const MD = window.MD; const U = MD.util; const A = MD.api; const UI = MD.ui; const h = U.h;
  const isAbort = (e) => e && e.name === 'AbortError';
  const ROWS = 5;   // rows per card
  const usd0 = (x, o) => U.fmtUsd(x, Object.assign({ dp: 0 }, o));
  const mult = (m) => { if (m == null || !Number.isFinite(m)) return '—'; const r = Math.ceil(m * 100 - 1e-9) / 100; return (r >= 100 ? U.fmtNum(Math.ceil(r - 1e-9), 0) : U.fmtNum(r, 2)) + '×'; };
  const multExact = (m) => (+m.toFixed(4)).toLocaleString('en-US', { maximumFractionDigits: 4 }) + '×';
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
    await MD.need('predict');   // P.loadSnapshot is in the Predict pages' scripts
    const LB = MD.router.pages.leaderboard, P = MD.predict;
    const [lb, snap, status] = await Promise.all([
      LB ? LB.loadRemote().then(() => LB.cache()).catch(() => null) : null,
      P.loadSnapshot().catch(() => null),
      P.snapshotFile('predict-status.json', { signal: ctx.signal }).catch(() => null)]);
    return MD.homeSummary.build({ lb: lb && Array.isArray(lb.rows) ? lb : null, snap: snap && snap.agg ? snap : null, status });
  }

  MD.router.pages.home = {
    async mount(root, route, ctx) {
      const err = h('div.err', { role: 'status', 'aria-live': 'polite' });   // read out when a search finds nothing
      const input = h('input', { type: 'text', 'aria-label': 'Search by wallet address, subaccount ID or slip id', placeholder: window.innerWidth <= 480 ? 'Wallet address or subaccount ID' : 'Search by wallet address or subaccount ID', autocomplete: 'off', spellcheck: false });
      let busy = false;
      const search = async (v) => {
        if (busy) return; busy = true; err.textContent = ''; form.classList.add('busy'); form.setAttribute('aria-busy', 'true');
        try { const r = await MD.search(v); if (r && r.error) err.textContent = r.error; } finally { busy = false; form.classList.remove('busy'); form.removeAttribute('aria-busy'); }
      };
      const form = h('form', { onsubmit: (e) => { e.preventDefault(); search(input.value); } }, input, h('button', { type: 'submit', title: 'Search' }, U.icon('search')));

      // shortcuts under the search: your favorites (the first FAV_MAX, in your order, under the names you gave them), then
      // your last searches that found something, fewer the more favorites there are (this browser only)
      const FAV_MAX = 8;
      const shortcuts = h('div.quick.shortcuts');
      let refocus = null;   // a favorite moved from the keyboard keeps the focus through the re-render
      const favChip = (f) => {
        const a = h('a.chipbtn.ic-gold.fav', { href: U.accountUrl(f.address, f.subaccountId), dataset: { sid: f.subaccountId, focusKey: 'favchip:' + f.subaccountId },
          title: (f.label ? f.label + ' · ' : 'Favorite · ') + f.address + '\nDrag to move it · right-click or hold to name it' },
          U.icon('starFill'), h('span.lbl', f.label || U.shortAddr(f.address)));
        a.draggable = false;   // h() skips a false attribute; the browser's own link dragging would take over the move
        return a;
      };
      const subChecked = new Set();   // (a recent subaccount id's wallet, read once a visit)
      const renderShortcuts = () => {
        const all = U.favorites.list(), favs = all.slice(0, FAV_MAX);
        const have = new Set(favs.map((f) => String(f.address || '').toLowerCase()));
        const recent = MD.recent.list().filter((v) => !have.has(v.toLowerCase())).slice(0, Math.max(0, Math.min(3, 6 - favs.length)));
        for (const v of recent) if (U.isUuid(v) && !subChecked.has(v)) { subChecked.add(v); A.subaccount(v, { signal: ctx.signal }).then((sa) => { if (sa && U.isExcluded(sa.account) && !ctx.signal.aborted) { MD.recent.forget(v); renderShortcuts(); } }).catch(() => {}); }
        U.replace(shortcuts,
          favs.map(favChip),
          all.length > favs.length ? h('a.chipbtn', { href: '#/favorites', title: 'Every favorite' }, '+' + (all.length - favs.length)) : null,
          recent.map((v) => h('button.chipbtn.ic-blue', { type: 'button', title: 'Recent search · ' + v, onclick: () => search(v) }, U.icon('search'), ' ' + U.shortAddr(v))),
          recent.length ? h('button.chipbtn.icon', { type: 'button', title: 'Forget the recent searches', 'aria-label': 'Forget the recent searches', onclick: () => { MD.recent.clear(); renderShortcuts(); } }, U.icon('x')) : null);
        if (refocus) { const c = favChips().find((x) => x.dataset.sid === refocus); refocus = null; if (c) c.focus(); }
      };
      const favChips = () => Array.from(shortcuts.querySelectorAll('a.fav'));

      // naming a favorite: a small dialog (UI.nameFavorite; the name stays in this browser, as the favorites do)
      const nameFav = (sid) => UI.nameFavorite(sid);

      // Moving a favorite along the line. A mouse drags it straight away (a click still opens the account); a finger holds
      // it first (HOLD_MS, so a swipe still scrolls the page), then drags it, or lets go to name it. Right-click names it
      // too, and from the keyboard Shift+←/→ moves the focused one and the context-menu key names it. While it moves, a
      // copy follows the pointer and the favorite itself takes its place in the line; the new order is saved on the drop.
      const HOLD_MS = 450;
      let drag = null, hold = null, noClick = false, touchAt = 0, quiet = false;
      const startDrag = (chip, x, y) => {
        const r = chip.getBoundingClientRect();
        const ghost = chip.cloneNode(true); ghost.classList.remove('fav'); ghost.classList.add('fav-ghost'); ghost.removeAttribute('href'); ghost.setAttribute('aria-hidden', 'true');
        Object.assign(ghost.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px' });
        shortcuts.appendChild(ghost); chip.classList.add('fav-drag');
        drag = { chip, ghost, dx: x - r.left, dy: y - r.top, was: favChips().map((c) => c.dataset.sid).join() };
      };
      const moveDrag = (x, y) => {
        drag.ghost.style.left = (x - drag.dx) + 'px'; drag.ghost.style.top = (y - drag.dy) + 'px';
        const el = document.elementFromPoint(x, y), t = el && el.closest ? el.closest('a.fav') : null;
        if (!t || t === drag.chip || t.parentNode !== shortcuts) return;
        const r = t.getBoundingClientRect(), after = x > r.left + r.width / 2;
        const ref = after ? t.nextSibling : t;
        if (ref !== drag.chip && (after ? t.nextSibling !== drag.chip : t.previousSibling !== drag.chip)) shortcuts.insertBefore(drag.chip, ref);
      };
      const endDrag = (keep) => {
        const d = drag; drag = null; d.ghost.remove(); d.chip.classList.remove('fav-drag');
        const order = favChips().map((c) => c.dataset.sid);
        // the line already shows the new order: saved without a re-render, so the click that follows the drop still finds
        // the chip it was pressed on (and is held back)
        if (keep && order.join() !== d.was) { quiet = true; try { U.favorites.reorder(order); } finally { quiet = false; } }
        else if (!keep) renderShortcuts();
      };
      shortcuts.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'mouse' || e.button !== 0) return;
        const chip = e.target.closest && e.target.closest('a.fav'); if (!chip) return;
        const x0 = e.clientX, y0 = e.clientY;
        const mv = (ev) => {
          if (!drag) { if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return; startDrag(chip, x0, y0); }
          ev.preventDefault(); moveDrag(ev.clientX, ev.clientY);
        };
        const stop = (ev) => {
          window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop);
          // the click that follows the drop must not open the account (cleared after it, so the next click works)
          if (drag) { noClick = true; setTimeout(() => { noClick = false; }, 0); endDrag(ev.type === 'pointerup'); }
        };
        window.addEventListener('pointermove', mv); window.addEventListener('pointerup', stop); window.addEventListener('pointercancel', stop);
      });
      shortcuts.addEventListener('dragstart', (e) => { if (e.target.closest && e.target.closest('a.fav')) e.preventDefault(); });
      shortcuts.addEventListener('click', (e) => { if (noClick && e.target.closest && e.target.closest('a.fav')) { e.preventDefault(); e.stopPropagation(); } }, true);
      shortcuts.addEventListener('touchstart', (e) => {
        touchAt = Date.now(); if (hold) clearTimeout(hold.timer);
        const chip = e.touches.length === 1 && e.target.closest ? e.target.closest('a.fav') : null;
        if (!chip) { hold = null; return; }
        const p = e.touches[0];
        hold = { chip, x: p.clientX, y: p.clientY, armed: false };
        hold.timer = setTimeout(() => { if (!hold || hold.chip !== chip) return; hold.armed = true; chip.classList.add('fav-lift'); try { if (navigator.vibrate) navigator.vibrate(12); } catch (_) {} }, HOLD_MS);
      }, { passive: true });
      shortcuts.addEventListener('touchmove', (e) => {
        if (!hold) return; const p = e.touches[0];
        if (!hold.armed) { if (Math.hypot(p.clientX - hold.x, p.clientY - hold.y) > 10) { clearTimeout(hold.timer); hold = null; } return; }   // a swipe: the page scrolls
        if (e.cancelable) e.preventDefault();   // held: the finger moves the favorite, not the page
        if (!drag) { if (Math.hypot(p.clientX - hold.x, p.clientY - hold.y) < 6) return; hold.chip.classList.remove('fav-lift'); startDrag(hold.chip, hold.x, hold.y); }
        moveDrag(p.clientX, p.clientY);
      }, { passive: false });
      const touchEnd = (e) => {
        touchAt = Date.now(); if (!hold) return;
        const ho = hold; hold = null; clearTimeout(ho.timer); ho.chip.classList.remove('fav-lift');
        if (drag) { if (e.cancelable) e.preventDefault(); endDrag(e.type === 'touchend'); return; }
        // held and let go without moving: name it, no click (also when Android ends the hold with a touchcancel)
        if (ho.armed) { if (e.cancelable) e.preventDefault(); nameFav(ho.chip.dataset.sid); }
      };
      shortcuts.addEventListener('touchend', touchEnd);
      shortcuts.addEventListener('touchcancel', touchEnd);
      // right-click (or the context-menu key) names it; a finger's long press, which also fires this on Android, is the hold above
      shortcuts.addEventListener('contextmenu', (e) => {
        const chip = e.target.closest && e.target.closest('a.fav'); if (!chip) return;
        e.preventDefault();
        if (e.pointerType === 'touch' || Date.now() - touchAt < 1500) return;
        nameFav(chip.dataset.sid);
      });
      shortcuts.addEventListener('keydown', (e) => {
        const chip = e.target.closest && e.target.closest('a.fav');
        if (!chip || !e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
        e.preventDefault();
        const order = favChips().map((c) => c.dataset.sid), i = order.indexOf(chip.dataset.sid), j = i + (e.key === 'ArrowLeft' ? -1 : 1);
        if (i < 0 || j < 0 || j >= order.length) return;
        order.splice(j, 0, order.splice(i, 1)[0]); refocus = chip.dataset.sid; U.favorites.reorder(order);
      });
      renderShortcuts();
      ctx.onCleanup(U.on('favorites', () => { if (!drag && !quiet) renderShortcuts(); }));

      // the sections, each with one live figure beside its name (filled as its source answers)
      const figs = {};
      const go = (key, href, icon, label, color) => { figs[key] = h('span.n'); return h('a.chipbtn', { href, class: 'ic-' + color }, U.icon(icon), ' ' + label, figs[key]); };
      const setFig = (key, text) => { if (figs[key]) figs[key].textContent = text ? ' · ' + text : ''; };
      const hero = h('div.hero',
        h('h1', 'Explore ', h('span', 'Meridian'), ' account performance'),
        h('div.sub', 'Public perps and Predict analytics, copy trading and tax records for every account on Meridian · Robinhood Chain'),
        form, err, shortcuts,
        h('div.quick',
          go('dash', '#/dashboard', 'grid', 'Markets dashboard', 'blue'), go('fav', '#/favorites', 'starFill', 'Favorites', 'gold'), go('lb', '#/leaderboard', 'trophyFill', 'Leaderboard', 'gold'),
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
      // the search box takes the focus where there is a keyboard: on a phone it opened the on-screen keyboard over the page
      if (window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches) setTimeout(() => input.focus(), 50);

      // ---- perps, live: markets, volume and open interest at the oracle price, accounts; read again every minute (the
      // products and the account list from their caches), the prices each time, so a tab left open stays current ----
      const live = () => A.ref({ signal: ctx.signal }).then(async (ref) => ({ ref, prices: await A.marketPrices(ref.active.map((p) => p.id), { signal: ctx.signal, ttl: 30000 }) }));
      const exchange = async () => {
        try {
          const [{ ref, prices }, subs0] = await Promise.all([live(), A.allSubaccounts({ signal: ctx.signal, ttl: 300000 }).catch(() => null)]);
          let vol = 0, oi = 0;
          for (const p of ref.active) { const px = prices[p.id]; const o = px ? U.num(px.oraclePrice) : 0; vol += U.num(p.volume24h) * o; oi += U.num(p.openInterest) * o; }
          const subs = subs0 ? subs0.filter((s) => !U.isExcluded(s.account)) : null;   // counted as the Leaderboard counts them (U.EXCLUDED)
          ex = { vol, oi, accounts: subs ? subs.length : null, newest: subs && subs.length ? Math.max(...subs.map((s) => s.createdAt)) : null };
          renderTiles(); setFig('dash', ref.active.length + ' markets');
        } catch (e) { if (!isAbort(e)) console.warn('home: exchange figures', e); }
      };
      exchange();

      let sum;
      try { sum = await loadSummary(ctx); } catch (e) { if (isAbort(e)) return; sum = {}; }
      if (ctx.signal.aborted) return;
      // the summary's parts: drawn now, their ages again every minute, and again with a newer summary (read every five
      // minutes: a tab left open for hours said "snapshot 5m ago" and never "stale")
      const drawSummary = () => {
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

        // ---- big Predict wins and the latest big bets (as of the Predict snapshot); a row opens the slip ----
        const P = MD.predict;
        // the bettor's address opens its page (.opt: a narrow card leaves it out, the slip has it)
        const predRow = (n, at, ...cells) => h('div.it.click', { title: 'Open the slip', tabindex: 0, onclick: () => { location.hash = slipUrl(n.id); }, onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) location.hash = slipUrl(n.id); } },
          h('span.t', { title: U.fmtDateTime(at) }, U.fmtAgo(at)),
          h('a.addr.opt', { href: bettorUrl(n.predictor), title: n.predictor, onclick: (e) => e.stopPropagation() }, U.shortAddr(n.predictor, 4)),
          // (the question shortens, its "+N legs" stays: css .ellipsis.picks)
          h('span.grow.ellipsis.picks', { title: n.picks.map((k) => (k.yes === true ? 'YES · ' : k.yes === false ? 'NO · ' : '') + k.q).join('\n') }, h('span.q', n.picks[0] ? n.picks[0].q : ''), n.legs > 1 ? h('span.dim.xs.legs', '+' + (n.legs - 1) + (n.legs === 2 ? ' leg' : ' legs')) : null),
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
            h('span.num.dim.fix.opt', { title: Number.isFinite(n.multiple) ? 'Pays ' + multExact(n.multiple) + ' the stake if it wins' : 'Pays this many times the stake if it wins' }, mult(n.multiple))))) : UI.empty(pr.fullBets ? 'No bet of ' + usd0(P.BIG_BET) + ' or more yet' : 'No bet of ' + usd0(P.BIG_BET) + ' or more among the latest 25'));
        }

        U.replace(foot, h('a', { href: A.APP_URL, target: '_blank', rel: 'noopener' }, 'app.meridian.xyz'), ' · ', h('a', { href: '#/status', title: 'How old the published snapshots are' }, 'Data updated ', lb && lb.builtAt ? U.fmtAgo(lb.builtAt) : '—'));
      };
      drawSummary();

      // ---- biggest open positions, live: the positions of the biggest books in the last snapshot, the largest first ----
      let posAt = 0;   // when the table was last read: a refresh that fails keeps it, and says since when
      async function positions() {
        const lb = sum.lb, books = (lb && lb.books) || [];
        if (!books.length) { U.replace(posBody, UI.empty(lb ? 'No open positions in the last snapshot' : 'Appears with the leaderboard snapshot')); return; }
        try {
          const { ref, prices } = await live();   // the prices of now, not of the page's first minute
          const o = { signal: ctx.signal, ttl: 30000 };
          const per = await Promise.all(books.map((b) => Promise.all([A.openPositions(b.sid, o), A.balances(b.sid, o)])
            .then(([pos, bal]) => (pos.length ? MD.analytics.accountState({ balances: bal, positions: pos, ref, prices }).positions.map((r) => ({ b, r })) : []))
            .catch((e) => { if (isAbort(e)) throw e; return []; })));
          const rows = U.sortBy(per.flat(), (x) => x.r.notional, true).slice(0, ROWS);
          posAt = Date.now();
          U.replace(posNote, `live · the ${books.length} biggest books in the last snapshot`);
          U.replace(posBody, UI.table({ cols: [
            { key: 'w', label: 'Wallet', render: (x) => h('a.addr', { href: U.accountUrl(x.b.account, x.b.sid) }, U.shortAddr(x.b.account)) },
            { key: 'm', label: 'Market', render: (x) => x.r.ticker },
            { key: 'side', label: 'Side', render: (x) => U.sideEl(x.r.long, true) },
            { key: 'n', label: 'Size', num: true, title: 'Notional at the oracle price', render: (x) => U.fmtUsd(x.r.notional, { compact: true }) },
            { key: 'u', label: 'uPnL', num: true, title: 'Unrealized PnL, as Meridian\'s app shows it: (oracle price − entry price) × size', render: (x) => U.pnlEl(x.r.upnl, { compact: true }) },
            { key: 'liq', label: 'To liq.', num: true, title: 'How far the price can move against the position before its margin pool is liquidated (in a cross pool, the other positions move it too)', render: (x) => (x.r.distPct == null ? '—' : h('span', { class: x.r.distPct < 5 ? 'neg' : '' }, U.fmtPct(x.r.distPct, { dp: 1 }))) },
          ], rows, empty: 'None of them has a position open right now', phone: { title: 'm', aside: 'u' }, onRow: (x) => { location.hash = U.accountUrl(x.b.account, x.b.sid).slice(1); } }));
        } catch (e) {
          if (isAbort(e)) return;
          if (posAt) U.replace(posNote, 'live · as of ' + U.fmtHM(posAt) + ' (the last refresh failed)');
          else U.replace(posBody, UI.error(e, positions));
        }
      }
      positions();
      // the minute's reads, the summary's and the ages: none while the tab is hidden (U.every), at once when it shows again
      ctx.onCleanup(U.every(60000, () => { positions(); exchange(); }));
      const sumStop = U.every(5 * 60000, async () => {
        let next; try { next = await loadSummary(ctx); } catch (e) { return; }
        if (!ctx.signal.aborted && next && JSON.stringify(next) !== JSON.stringify(sum)) sum = next;
        if (!ctx.signal.aborted) { drawSummary(); positions(); }
      });
      ctx.onCleanup(sumStop); ctx.onCleanup(U.every(60000, drawSummary));
    },
  };
})();
