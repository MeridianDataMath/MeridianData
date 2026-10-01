/* MeridianDataHub — Predict section: overview, bettors, questions, market makers, vig & edge, bettor page */
(function () {
  const MD = window.MD; const U = MD.util; const UI = MD.ui; const C = MD.charts; const h = U.h; const P = MD.predict;
  const isAbort = (e) => e && e.name === 'AbortError';
  const DAY = U.DAY;
  const PAGE = 25;

  // ---------- formatting ----------
  const pct = (x, dp = 1) => (x == null || !Number.isFinite(x) ? '—' : U.fmtPct(x * 100, { dp }));
  const pp = (x, dp = 1) => (x == null || !Number.isFinite(x) ? '—' : (x > 0 ? '+' : '') + (x * 100).toFixed(dp) + ' pp');
  const mult = (m) => (m == null || !Number.isFinite(m) ? '—' : U.fmtNum(m, m >= 100 ? 0 : 2) + '×');
  // money on the Predict pages: whole dollars from $100 up (cents on a five-figure total are noise), cents only on small stakes
  const usd = (x, o) => U.fmtUsd(x, Math.abs(U.num(x)) >= 100 && !(o && o.dp != null) ? Object.assign({ dp: 0 }, o) : o);
  const pnlEl = (x) => h('span', { class: 'num ' + U.pnlClass(x) }, usd(x, { sign: true }));
  const bettorUrl = (a) => '#/predict/bettor?address=' + encodeURIComponent(a);
  const bettorLink = (a, n) => h('a.addr', { href: bettorUrl(a), title: a, onclick: (e) => e.stopPropagation() }, U.shortAddr(a, n || 4));
  const sideChip = (yes) => (yes == null ? h('span.dim', '—') : UI.chip(yes ? 'YES' : 'NO', yes ? 'green' : 'red'));
  /** A prediction's result from one side (the bettor's unless asMaker). "Unclaimed" is shown only where that side has
   *  something to collect (its win, or a void's refund): a loss is simply lost, whether or not the winner has claimed. */
  const resultChip = (n, asMaker, held = 1) => { const r = P.resultFor(n, asMaker, held); return h('span.chip', { class: r.tone, title: r.title || '' }, r.label); };
  const qCell = (q, legs, yes) => h('div', { style: { lineHeight: '1.25', maxWidth: '420px', whiteSpace: 'normal' } }, h('div.ellipsis', { title: q }, q), legs > 1 ? h('div.xs.dim', legs + '-leg combo') : null);
  const vigCell = (v, n) => (v == null ? h('span.dim', '—') : h('span', { class: v > 0.02 ? 'neg' : v < -0.02 ? 'pos' : '' }, pp(v), n && n.sameEvent ? h('span.dim.xs', { title: 'Legs on the same Polymarket event: fair assumes independence, so this includes correlation pricing' }, ' corr.') : null));
  const probBar = (p) => { const v = p == null ? null : U.clamp(Number(p), 0, 1); return h('div.prob', { title: v == null ? '' : 'source market: ' + pct(v) }, h('i', { style: { width: (v == null ? 0 : v * 100) + '%' } }), h('span', v == null ? '—' : pct(v, 1))); };
  // a question's source market is a link the API hands over: only a web address becomes a button
  const webUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
  const srcBtn = (u) => h('a.btn.sm.ghost', { href: u, target: '_blank', rel: 'noopener', title: u }, U.icon('external'), /polymarket/i.test(u) ? 'Polymarket' : 'Source');
  const sourceLink = (c) => { const m = webUrl(c.similarMarket && c.similarMarket.markets && c.similarMarket.markets[0]); return m ? srcBtn(m) : null; };

  // ---------- snapshot: the newest of data/predict.json (Pages) and the "snapshots" branch (pushed from a PC),
  //            else a recent-window build in the browser ----------
  P.SNAPSHOT_URLS = ['data/predict.json'];
  P._snap = undefined; P._snapAt = 0; P._building = null;
  /** Read a JSON response chunk by chunk so the caller can show download progress. The server sends the snapshot
   *  compressed and chunked (no Content-Length), so the total is the size seen on the previous visit. */
  async function readJson(r, onBytes) {
    if (!r.body || !onBytes) return r.json();
    const reader = r.body.getReader(); const chunks = []; let got = 0;
    const total = Number(r.headers.get('content-length')) || U.storage.get('md.predict.snapBytes', 0) || 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; onBytes(got, total); }
    const buf = new Uint8Array(got); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
    U.storage.set('md.predict.snapBytes', got);
    return JSON.parse(new TextDecoder().decode(buf));
  }
  let bytesListeners = [];
  P.loadSnapshot = async function ({ signal, onProgress, onBytes, force } = {}) {
    if (!force && P._snap && Date.now() - P._snapAt < 60000) return P._snap;
    if (onBytes) bytesListeners.push(onBytes);
    if (P._loading) return P._loading;   // a page that starts the download while another is in flight shares it
    P._loading = (async () => {
    // no abort signal on the shared download: a page change must not kill the fetch the next page is waiting for
    const tell = (got, total) => bytesListeners.forEach((f) => f(got, total));
    const found = await Promise.all(P.SNAPSHOT_URLS.map(async (u) => { try { const r = await fetch(u, { cache: 'no-cache' }); if (!r.ok) return null; const j = await readJson(r, tell); return j && j.agg ? j : null; } catch (e) { return null; } }));
    const best = found.filter(Boolean).sort((a, b) => b.builtAt - a.builtAt)[0];
    if (best && (!P._snap || best.builtAt >= P._snap.builtAt)) { P._snap = Object.assign(best, { remote: true }); P._snapAt = Date.now(); return P._snap; }
    if (P._snap && P._snap.builtAt > Date.now() - 15 * 60000) return P._snap;
    if (!P._building) {
      P._building = (async () => {
        const days = 14; const to = Math.floor(Date.now() / 1000); const from = to - days * 86400;
        const raw = await P.predictionsWindowed({ fromSec: from, toSec: to, windows: 7, concurrency: 7, signal, onProgress });
        const norms = raw.map(P.norm);
        const snap = { builtAt: Date.now(), source: 'browser', windowDays: days, fromSec: from, agg: P.aggregate(norms), remote: false };
        P._snap = snap; P._snapAt = Date.now();
        return snap;
      })().finally(() => { P._building = null; });
    }
    return P._building;
    })().finally(() => { P._loading = null; bytesListeners = []; });
    return P._loading;
  };
  const snapNote = (s) => (s.remote ? `snapshot ${U.fmtAgo(s.builtAt)} · all predictions since launch` : `built in this browser ${U.fmtAgo(s.builtAt)} · last ${s.windowDays} days only`);
  const offlineNote = 'live queries are not available from this domain (the Predict API only allows Meridian\'s own origins), so this shows the published snapshot';
  const loadingCard = (progress) => h('div.card', h('div.empty', h('span.loading', h('span.spinner'), progress)));
  async function withSnapshot(body, ctx, render) {
    const prog = h('span', 'Loading Predict data…');
    const meter = h('div.meter', h('i'));
    U.replace(body, h('div.card', h('div.empty', h('div.stack', { style: { alignItems: 'center', gap: '10px' } }, h('span.loading', h('span.spinner'), prog), meter))));
    UI.progress.start();
    let snap;
    try {
      snap = await P.loadSnapshot({ signal: ctx.signal,
        onBytes: (got, total) => { const f = total ? Math.min(1, got / total) : 0; if (total) { UI.progress.set(0.1 + 0.75 * f); meter.firstChild.style.width = (f * 100).toFixed(0) + '%'; } prog.textContent = 'Downloading snapshot… ' + (total ? Math.round(f * 100) + '%' : U.fmtCompact(got / 1024, 0) + ' KB'); },
        onProgress: (n) => { prog.textContent = `Collecting recent predictions… ${n}`; } });
    } catch (e) { UI.progress.done(); if (isAbort(e)) return; U.replace(body, UI.error(e, () => MD.router.dispatch())); return; }
    if (ctx.signal.aborted) { UI.progress.done(); return; }
    prog.textContent = 'Rendering…'; UI.progress.set(0.9);
    try { await render(snap); } catch (e) { if (!isAbort(e)) { console.error(e); U.replace(body, UI.error(e, () => MD.router.dispatch())); } }
    UI.progress.done();
    if (snap && snap.remote && Date.now() - snap.builtAt > UI.STALE_MS) {
      body.prepend(h('div.card', { style: { borderColor: 'var(--amber)', padding: '10px 14px' } }, h('div.row', { style: { gap: '8px', alignItems: 'baseline' } },
        UI.chip('stale snapshot', 'amber'), h('span.small', `This Predict snapshot was built ${U.fmtAgo(snap.builtAt)}. It is normally refreshed every 30 minutes, so the publishing job is probably down; figures below are as of ${U.fmtDateTime(snap.builtAt)}.`))));
    }
  }

  // ---------- section header (sub-nav across the Predict pages) ----------
  const SUB = [['/predict', 'Overview'], ['/predict/bettors', 'Bettors'], ['/predict/questions', 'Questions'], ['/predict/makers', 'Market makers'], ['/predict/vig', 'Vig & edge']];
  const subnav = (path) => h('div.tabs', SUB.map(([p, l]) => h('button', { class: p === path || (p === '/predict/bettors' && path === '/predict/bettor') ? 'on' : '', onclick: () => { location.hash = p; } }, l)));

  MD.router.pages.predict = {
    async mount(root, route, ctx) {
      const path = route.path;
      const body = h('div.stack');
      U.replace(root, h('div.page', h('div.stack', subnav(path), body)));
      // #/predict/p/<predictionId>: a slip, on the same path as Meridian's own shared-prediction page
      const fn = path === '/predict/p' || path.startsWith('/predict/p/') ? mountSlip : { '/predict': mountOverview, '/predict/bettors': mountBettors, '/predict/questions': mountQuestions, '/predict/makers': mountMakers, '/predict/vig': mountVig, '/predict/bettor': mountBettorPage }[path];
      if (!fn) { U.replace(body, h('div.card', h('div.empty', 'Unknown Predict page. ', h('a', { href: '#/predict' }, 'Overview')))); return; }
      await fn(body, route, ctx);
    },
  };

  // =====================================================================
  // Overview
  // =====================================================================
  async function mountOverview(body, route, ctx) {
    MD.setTopbar(h('span.title', 'Predict · Overview'));
    await withSnapshot(body, ctx, async (snap) => {
      const a = snap.agg; const T = a.totals; const MK = P.splitMakers(a.makers);
      const tiles = h('div.stats',
        UI.stat('Predictions', U.fmtNum(T.n, 0), T.decided != null ? `${U.fmtNum(T.open, 0)} open · ${U.fmtNum(T.decided, 0)} decided` : `${U.fmtNum(T.open, 0)} open · ${U.fmtNum(T.settled, 0)} settled`),
        UI.stat('Wagered', usd(T.wagered, { compact: true }), 'bettor stakes'),
        UI.stat('Maker collateral', usd(T.cpCommitted, { compact: true }), 'put up against those stakes'),
        UI.stat('Bettors', U.fmtNum(T.bettors, 0), `${MK.makers.length} market maker${MK.makers.length === 1 ? '' : 's'}`),
        UI.stat('Bettor win rate', T.winRate == null ? '—' : U.fmtPct(T.winRate, { dp: 1 }), 'of decided predictions'),
        UI.stat('Bettor net result', usd(T.bettorPnl, { sign: true }), 'decided, claimed or not · incl. positions sold on the secondary market', U.pnlClass(T.bettorPnl)),
        UI.stat('Combos', T.n ? U.fmtPct((T.combos / T.n) * 100, { dp: 0 }) : '—', 'of predictions are multi-leg'),
        UI.stat('Avg vig paid', a.vig.overall.avg == null ? '—' : pp(a.vig.overall.avg), 'odds vs Polymarket price at bet time'));
      // Claiming is only the cash step: every figure here counts a prediction at its verdict, so unclaimed wins (makers
      // leave hundreds uncollected) change none of them. They get a line under the tiles, not tiles of their own; the
      // questions stuck on Meridian's side live on the Questions page (Ended · unsettled).
      const cWager = h('canvas'), cCount = h('canvas');
      // the live tape and the big wins side by side (stacked where the page is too narrow for both); a row opens the prediction
      const tapeBody = h('div.feed.pause-hover');
      const tapeNote = h('span.dim.small', 'newest first · refreshes every 20 s');
      const tapeCard = h('div.card.tight.feed-card', h('div.card-head', h('h2', 'Live predictions'), tapeNote, h('span.grow'), h('a.btn.sm.ghost', { href: P.APP_URL, target: '_blank', rel: 'noopener' }, U.icon('external'), 'Predict app')), h('div.feed-fill', tapeBody));
      // Recent = the latest settlement first: when the win was decided, never when its payout was claimed, which can be
      // weeks later (0x4a72…: settled Sep 13, claimed Sep 29); a win counts from its settlement whether claimed or not
      const winTime = (n) => decidedTime(n) || n.t;
      const BW_SORTS = [
        { v: 'recent', label: 'Recent', title: 'Latest settlement first (claimed or not)', val: winTime },
        { v: 'pnl', label: 'PnL', title: 'Largest profit first: payout − stake (a bettor who sold its tokens: its own result)', val: (n) => bigPnl(n) },
        { v: 'mult', label: 'Multiplier', title: 'Highest payout ÷ stake first', val: (n) => n.multiple || 0 }];
      let bwSort = 'recent', bigWins = null, bigAt = 0;
      const bigPnl = (n) => (n.tradedPnl != null ? n.tradedPnl : n.pnl);
      const bwBody = h('div.feed.bigwins'), bwNote = h('span.dim.small');
      const bwCard = h('div.card.tight.feed-card', h('div.card-head', h('h2', 'Big wins'), bwNote, h('span.grow'), UI.seg(BW_SORTS, bwSort, (v) => { bwSort = v; renderBig(); bwBody.scrollTop = 0; }, 'sm')), h('div.feed-fill', bwBody));
      const catTbl = UI.table({ cols: [
        { key: 'c', label: 'Category', render: (r) => r.cat },
        { key: 'n', label: 'Predictions', num: true, render: (r) => U.fmtNum(r.n, 0) },
        { key: 'w', label: 'Wagered', num: true, render: (r) => usd(r.wagered, { compact: true }) },
        { key: 'wr', label: 'Bettor win rate', num: true, render: (r) => (r.winRate == null ? '—' : U.fmtPct(r.winRate, { dp: 0 })) },
        { key: 'p', label: 'Bettor PnL', num: true, render: (r) => pnlEl(r.pnl) },
        { key: 'v', label: 'Avg vig', num: true, render: (r) => vigCell(r.avgVig) },
      ], rows: a.categories });
      const comboTbl = UI.table({ cols: [
        { key: 'l', label: 'Legs', render: (r) => (r.legs === 1 ? 'Single' : r.legs + '-leg combo') },
        { key: 'n', label: 'Predictions', num: true, render: (r) => U.fmtNum(r.n, 0) },
        { key: 'w', label: 'Wagered', num: true, render: (r) => usd(r.wagered, { compact: true }) },
        { key: 'o', label: 'Avg odds', num: true, render: (r) => pct(r.avgOdds) },
        { key: 'm', label: 'Median payout', num: true, render: (r) => mult(r.medianMultiple) },
        { key: 'wr', label: 'Win rate', num: true, render: (r) => (r.winRate == null ? '—' : U.fmtPct(r.winRate, { dp: 0 })) },
        { key: 'p', label: 'Bettor PnL', num: true, render: (r) => pnlEl(r.pnl) },
      ], rows: a.combos });
      const makersTbl = UI.table({ cols: [
        { key: 'a', label: 'Market maker', render: (r) => bettorLink(r.address, 6) },
        { key: 'n', label: 'Taken', num: true, render: (r) => U.fmtNum(r.n, 0) },
        { key: 's', label: 'Share of flow', num: true, render: (r) => U.fmtPct((r.n / T.n) * 100, { dp: 0 }) },
        { key: 'c', label: 'Collateral committed', num: true, render: (r) => usd(r.wagered, { compact: true }) },
        { key: 'o', label: 'Open exposure', num: true, render: (r) => usd(r.openWagered, { compact: true }) },
        { key: 'p', label: 'Maker PnL', num: true, render: (r) => pnlEl(r.pnl) },
        { key: 'wr', label: 'Maker win rate', num: true, render: (r) => (r.winRate == null ? '—' : U.fmtPct(r.winRate, { dp: 0 })) },
        { key: 'v', label: 'Avg vig captured', num: true, render: (r) => vigCell(r.avgVig) },
        { key: 'f', label: 'Last active', render: (r) => h('span.dim', U.fmtAgo(r.last)) },
      ], rows: MK.makers.slice(0, 5), onRow: (r) => { location.hash = bettorUrl(r.address).slice(1); } });
      // secondary market: closed by default (few people need it); opening it loads the trades, and the choice is remembered
      const secBody = h('div', UI.loading('Loading secondary market…'));
      const SEC_KEY = 'md.predict.secOpen'; let secLoaded = false;
      const secTotal = snap.tradesTotal || (snap.trades || []).length;
      const secCard = h('div.card.tight.collapsible');
      const setSec = (open) => { secCard.classList.toggle('open', open); secBody.style.display = open ? '' : 'none'; secHead.setAttribute('aria-expanded', String(open)); if (open && !secLoaded) { secLoaded = true; loadSec(); } };
      const secHead = h('button.card-head.toggle-head', { type: 'button', onclick: () => { const open = !secCard.classList.contains('open'); U.storage.set(SEC_KEY, open); setSec(open); } },
        h('span.chev', U.icon('chevR')), h('h2', 'Secondary market'), h('span.dim.small', (secTotal ? U.fmtNum(secTotal, 0) + ' trades · ' : '') + 'positions sold before resolution'), h('span.grow'), h('span.dim.small.toggle-hint'));
      U.append(secCard, [secHead, secBody]);
      U.replace(body,
        h('div.row.wrap', h('span.dim.small', snapNote(snap)), h('span.grow'), h('span.dim.small', 'Meridian Predict runs on Sapience; questions mirror Polymarket markets, USDe collateral, RFQ auctions against market makers.')),
        tiles,
        h('div.grid.cols-2', h('div.card', h('h3', { style: { marginBottom: '10px' } }, 'Wagered per day'), h('div.chart-box.sm', cWager)), h('div.card', h('h3', { style: { marginBottom: '10px' } }, 'Predictions per day'), h('div.chart-box.sm', cCount))),
        h('div.pred-pair', h('div.grid.pred-grid', tapeCard, bwCard)),
        h('div.grid.cols-2', UI.card('By category', catTbl), UI.card('Singles vs combos', comboTbl)),
        h('div.card.tight', h('div.card-head', h('h2', 'Market makers'), h('span.dim.small', 'who takes the other side of the auctions · click a row for the maker'), h('span.grow'), h('a.small', { href: '#/predict/makers' }, 'all makers')), makersTbl),
        secCard,
        h('div.footer-note', 'Odds = stake ÷ (stake + maker collateral). Vig = those odds minus the source market\'s probability for the same picks; positive means the bettor paid above fair. Every figure counts a prediction at its verdict, claimed or not' + (T.unclaimed ? ` (${U.fmtNum(T.unclaimed, 0)} are not claimed yet, ${U.fmtNum(T.unclaimedLost || 0, 0)} of them maker wins)` : '') + ': claiming only moves the cash.'));
      const col = C.colors();
      C.timeSeries(cWager, { points: a.daily.map((d) => ({ x: d.t, y: d.wagered })), type: 'bar', color: col.accent, label: 'Wagered' });
      C.timeSeries(cCount, { points: a.daily.map((d) => ({ x: d.t, y: d.n })), type: 'bar', color: col.blue, label: 'Predictions', yFmt: (v) => U.fmtNum(v, 0), tipFmt: (v) => U.fmtNum(v, 0) });

      // A row of either list opens the prediction (its legs, both sides, the way to the bettor's account); the bettor's
      // and the maker's addresses keep their own links. Rows are reachable with Tab and open with Enter.
      // (dataset.focusKey: a dialog closing after a refresh replaced its row gives the focus to the row that replaced it)
      const predRow = (n, list, cls, ...cells) => h('div.it.click', { class: cls || '', title: 'Details', tabindex: 0, dataset: { focusKey: list + ':' + n.id }, onclick: () => openPrediction(n, ctx), onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) openPrediction(n, ctx); } }, ...cells);
      const picksCell = (n) => h('span.grow.ellipsis', { title: n.picks.map((k) => (k.yes === true ? 'YES · ' : k.yes === false ? 'NO · ' : '') + k.q).join('\n'), style: { minWidth: '120px' } }, n.picks[0] ? n.picks[0].q : '', n.legs > 1 ? h('span.dim.xs', ' +' + (n.legs - 1) + (n.legs === 2 ? ' leg' : ' legs')) : null);

      // big wins: every win whose net PnL is above P.BIG_WIN, as of the snapshot (a snapshot built before the list has none)
      // (filtered here too: a snapshot built before the list went by net PnL listed every payout above it)
      const setBigWins = (s) => { if (!s || !s.agg || s.builtAt === bigAt) return false; bigAt = s.builtAt; bigWins = s.agg.bigWins ? s.agg.bigWins.map(P.full).filter((n) => bigPnl(n) > P.BIG_WIN) : null; return true; };
      // stake, multiplier and PnL (the payout is stake + PnL; the dialog has it); the figure the list is sorted by is bold,
      // and a narrow card drops the stake (.opt). A bettor who sold part of its tokens before the verdict is marked, and
      // its PnL is its own result, the sale included.
      const bigRow = (n) => {
        const on = (k, opt) => (bwSort === k ? 'on' : opt ? 'opt' : ''); const at = winTime(n), paid = !!(n.settled && n.settledAt); const pl = bigPnl(n);
        const when = 'Settled ' + U.fmtDateTime(at) + (paid ? '\nPayout claimed ' + U.fmtDateTime(n.settledAt) : '\nPayout not claimed yet') + '\nPlaced ' + U.fmtDateTime(n.t);
        const sold = n.held != null && n.held < 0.999 ? h('span.chip.amber', { title: n.held < 1e-6 ? 'The bettor sold these position tokens before the verdict: the payout went to the buyer. PnL is the bettor\'s own result, the sale included.' : `The bettor sold ${U.fmtPct((1 - n.held) * 100, { dp: 0 })} of these position tokens before the verdict. PnL is its own result, the sale included.` }, n.held < 1e-6 ? 'sold' : U.fmtPct((1 - n.held) * 100, { dp: 0 }) + ' sold') : null;
        // settled in the bettor's favour, but nobody has collected the payout yet: listed all the same, marked
        const waiting = !paid && n.unclaimed ? h('span.chip.amber', { title: n.held != null && n.held < 1e-6 ? 'Settled as a win, not claimed yet: the payout is the token buyer\'s to collect' : 'Settled as a win, not claimed yet: the payout is waiting for the bettor' }, 'unclaimed') : null;
        return predRow(n, 'big', '',
          h('span.t', { title: when }, U.fmtFeedTime(at)), bettorLink(n.predictor), picksCell(n), waiting, sold,
          h('span.num.dim.fix.stk.opt', { title: 'Stake' }, usd(n.stake)),
          h('span.num.fix.mul', { class: on('mult'), title: 'Multiplier: payout ÷ stake (the payout, ' + usd(n.pool) + ', is in the dialog)' }, mult(n.multiple)),
          h('span.num.fix.pl', { class: on('pnl') + ' ' + U.pnlClass(pl), title: n.tradedPnl != null ? 'The bettor\'s PnL, the sale of its tokens included' : 'PnL: payout − stake' }, usd(pl, { sign: true })));
      };
      const renderBig = () => {
        const s = BW_SORTS.find((o) => o.v === bwSort) || BW_SORTS[0];
        const rows = bigWins ? U.sortBy(bigWins, s.val, true) : [];
        const waiting = bigWins ? bigWins.filter((n) => n.unclaimed).length : 0;
        U.replace(bwNote, h('span', { title: 'Net PnL = payout − stake; for a bettor who sold its position tokens before the verdict, its own result with the sale. A win counts from its verdict, claimed or not.' }, `net PnL over ${usd(P.BIG_WIN)}` + (bigWins && bigWins.length ? ` · ${U.fmtNum(bigWins.length, 0)} ${snap.remote ? 'since launch' : 'in the last ' + snap.windowDays + ' days'}` : '') + (waiting ? ` · ${U.fmtNum(waiting, 0)} not claimed yet` : '')));
        U.replace(bwBody, rows.length ? rows.map(bigRow) : UI.empty(bigWins ? `No win has made more than ${usd(P.BIG_WIN)} yet` : 'Big wins appear with the next snapshot (published every 30 minutes)'));
      };
      setBigWins(snap); renderBig();

      // live tape (falls back to re-reading the snapshot when the API refuses this origin)
      const live = await P.live();
      let tapeRows = a.tape.slice(0, 25).map(P.full);
      if (!live) { tapeNote.textContent = 'as of the snapshot · checked every minute'; tapeNote.title = offlineNote; }
      const tapeRow = (n, flash) => predRow(n, 'tape', flash ? 'flash' : '',
        h('span.t', U.fmtFeedTime(n.t)), bettorLink(n.predictor), sideChip(n.picks[0] ? n.picks[0].yes : null), picksCell(n),
        h('span.num', usd(n.stake)), h('span.num.dim.opt', '@ ' + pct(n.odds, 1)), h('span.num', mult(n.multiple)), h('span.dim.xs.opt2', 'vs ', h('a.addr', { href: bettorUrl(n.counterparty), title: 'Market maker ' + n.counterparty, onclick: (e) => e.stopPropagation() }, U.shortAddr(n.counterparty, 3))), resultChip(n, false, n.held == null ? 1 : n.held));
      const renderTape = (fresh) => U.replaceLive(tapeBody, tapeRows.length ? tapeRows.map((n) => tapeRow(n, fresh && fresh.has(n.id))) : UI.empty('No predictions yet'));
      renderTape();
      const pollTape = async () => {
        try {
          let norms;
          if (live) norms = (await P.tape(25, { signal: ctx.signal })).map(P.norm);
          else { const s = await P.loadSnapshot({ signal: ctx.signal, force: true }); norms = (s.agg.tape || []).slice(0, 25).map(P.full); if (setBigWins(s)) renderBig(); }
          const known = new Set(tapeRows.map((r) => r.id)); const fresh = new Set(norms.filter((n) => !known.has(n.id)).map((n) => n.id)); tapeRows = norms; renderTape(fresh);
        } catch (e) { if (!isAbort(e)) console.warn('tape', e); }
      };
      if (live) pollTape();
      const tT = setInterval(pollTape, live ? 20000 : 60000); ctx.onCleanup(() => clearInterval(tT));

      // secondary market (loaded the first time the card is opened)
      async function loadSec() {
        try {
          let rows, total;
          if (live) { const t = await P.trades({ first: 10, signal: ctx.signal, ttl: 60000 }); rows = t.nodes.map(P.compactTrade); total = t.totalCount; }
          else { rows = (snap.trades || []).slice(0, 10); total = snap.tradesTotal || rows.length; }
          // the snapshot ties each trade to its prediction (question, and its outcome once decided); live rows lack that
          const byTok = new Map((snap.trades || []).filter((x) => x.pc).map((x) => [x.token, x]));
          rows = rows.map((r) => { const m = byTok.get(r.token); return m && !r.pc ? Object.assign({}, r, { q: m.q, legs: m.legs, side: m.side, vP: m.vP, vC: m.vC }) : r; });
          const outcome = (r) => { const v = r.side === 'C' ? r.vC : r.vP; return v == null ? (r.side ? UI.chip('open', 'accent') : h('span.dim', '—')) : v >= 0.999 ? UI.chip('won', 'green') : v <= 1e-9 ? UI.chip('lost', 'red') : UI.chip('void', 'amber'); };
          U.replace(secBody, UI.table({ cols: [
            { key: 't', label: 'Time', render: (r) => h('span.dim', U.fmtDateTimeS(r.t)) },
            { key: 'q', label: 'Prediction', render: (r) => (r.q ? h('div', { style: { whiteSpace: 'normal', maxWidth: '340px', lineHeight: '1.3' } }, r.q, r.legs > 1 ? h('span.dim.xs', ' +' + (r.legs - 1) + (r.legs === 2 ? ' leg' : ' legs')) : null) : h('span.dim', '—')) },
            { key: 's', label: 'Seller', render: (r) => bettorLink(r.seller) },
            { key: 'b', label: 'Buyer', render: (r) => bettorLink(r.buyer) },
            { key: 'tk', label: 'Face value', num: true, title: 'Position tokens pay 1 USDe each if the prediction wins', render: (r) => usd(r.tokens) },
            { key: 'p', label: 'Paid', num: true, render: (r) => usd(r.paid) },
            { key: 'px', label: 'Price / token', num: true, title: 'Implied probability the buyer assigned', render: (r) => pct(r.px, 1) },
            { key: 'o', label: 'Outcome', title: 'How the traded position turned out: a won token paid the buyer $1', render: outcome },
            { key: 'x', label: '', render: (r) => (r.tx ? h('a.dim', { href: U.explorerTx(r.tx), target: '_blank', rel: 'noopener' }, U.icon('external')) : '') },
          ], rows, empty: 'No secondary-market trades' }), h('div.footer-note', `${U.fmtNum(total, 0)} trades in total`));
        } catch (e) { if (!isAbort(e)) U.replace(secBody, UI.error(e)); }
      }
      setSec(!!U.storage.get(SEC_KEY, false));
    });
  }

  // =====================================================================
  // Bettors leaderboard
  // =====================================================================
  async function mountBettors(body, route, ctx) {
    MD.setTopbar(h('span.title', 'Predict · Bettors'));
    await withSnapshot(body, ctx, (snap) => {
      const all = snap.agg.bettors;
      const st = { q: '', minN: 3, sort: { key: 'pnl', desc: true }, page: 1, cat: '' };
      const cats = Array.from(new Set(all.map((b) => b.topCat).filter(Boolean))).sort();
      const wrap = h('div');
      const summary = h('span.dim.small');
      const controls = h('div.card', h('div.row.wrap',
        h('input.input', { placeholder: 'Search address', style: { maxWidth: '260px' }, oninput: (e) => { st.q = e.target.value.trim().toLowerCase(); st.page = 1; render(); } }),
        h('span.dim.small', 'Min predictions'), UI.seg([{ v: 1, label: '1' }, { v: 3, label: '3' }, { v: 10, label: '10' }, { v: 25, label: '25' }], st.minN, (v) => { st.minN = v; st.page = 1; render(); }, 'sm'),
        h('span.dim.small', 'Top category'), h('select.input.sm', { style: { width: 'auto' }, onchange: (e) => { st.cat = e.target.value; st.page = 1; render(); } }, h('option', { value: '' }, 'All'), cats.map((c) => h('option', { value: c }, c))),
        h('span.grow'), summary));
      const val = (b, k) => ({ address: b.address, n: b.n, wagered: b.wagered, pnl: b.pnl, roi: b.roi, winRate: b.winRate, avgOdds: b.avgOdds, combos: b.n ? b.combos / b.n : 0, avgVig: b.avgVig, last: b.last, open: b.openWagered, biggestWin: b.biggestWin })[k];
      function render() {
        let rows = all.filter((b) => b.n >= st.minN);
        if (st.q) rows = rows.filter((b) => b.address.includes(st.q));
        if (st.cat) rows = rows.filter((b) => b.topCat === st.cat);
        rows = U.sortBy(rows, (b) => val(b, st.sort.key), st.sort.desc);
        const total = rows.length; const pages = Math.max(1, Math.ceil(total / PAGE)); if (st.page > pages) st.page = pages;
        const slice = rows.slice((st.page - 1) * PAGE, st.page * PAGE);
        const onSort = (k) => { if (st.sort.key === k) st.sort.desc = !st.sort.desc; else st.sort = { key: k, desc: k !== 'address' }; st.page = 1; render(); };
        U.replace(wrap, UI.table({ sort: st.sort, onSort, cols: [
          { key: 'rank', label: '#', render: (r) => { const i = rows.indexOf(r) + 1; return h('span.rank', { class: i <= 3 ? 'top' : '' }, String(i)); } },
          { key: 'address', label: 'Bettor', sortVal: 1, render: (r) => h('div.row', { style: { gap: '6px' } }, bettorLink(r.address, 5), U.copyBtn(r.address)) },
          { key: 'n', label: 'Predictions', num: true, sortVal: 1, render: (r) => h('span', U.fmtNum(r.n, 0), r.open ? h('span.dim.xs', ' (' + r.open + ' open)') : null) },
          { key: 'wagered', label: 'Wagered', num: true, sortVal: 1, render: (r) => usd(r.wagered, { compact: true }) },
          { key: 'pnl', label: 'Net PnL', num: true, sortVal: 1, render: (r) => pnlEl(r.pnl) },
          { key: 'roi', label: 'ROI', num: true, sortVal: 1, title: 'Net PnL ÷ settled stakes', render: (r) => UI.pct(r.roi, { dp: 0 }) },
          { key: 'winRate', label: 'Win rate', num: true, sortVal: 1, render: (r) => (r.winRate == null ? h('span.dim', '—') : U.fmtPct(r.winRate, { dp: 0 })) },
          { key: 'avgOdds', label: 'Avg odds', num: true, sortVal: 1, render: (r) => pct(r.avgOdds, 0) },
          { key: 'combos', label: 'Combos', num: true, sortVal: 1, render: (r) => U.fmtPct((r.combos / r.n) * 100, { dp: 0 }) },
          { key: 'avgVig', label: 'Avg vig paid', num: true, sortVal: 1, title: 'Locked odds minus the Polymarket price at the moment of the bet', render: (r) => vigCell(r.avgVig) },
          { key: 'biggestWin', label: 'Best win', num: true, sortVal: 1, render: (r) => usd(r.biggestWin) },
          { key: 'cat', label: 'Top category', render: (r) => r.topCat || '—' },
          { key: 'last', label: 'Last active', sortVal: 1, render: (r) => h('span.dim', U.fmtAgo(r.last)) },
        ], rows: slice, empty: 'No bettors match', onRow: (r) => { location.hash = bettorUrl(r.address).slice(1); } }),
          UI.pager({ page: st.page, pageSize: PAGE, total, onPage: (p) => { st.page = p; render(); wrap.scrollIntoView({ block: 'start' }); } }));
        U.replace(summary, `${total} bettors · ${snapNote(snap)}`);
      }
      U.replace(body, controls, h('div.card.tight', wrap), h('div.footer-note', 'Net PnL counts every decided prediction, claimed or not: a win earns the maker\'s collateral, a loss costs the stake, and a position sold on the secondary market counts at its sale. Open stakes are excluded.'));
      render();
    });
  }

  // =====================================================================
  // Questions explorer (server-side paged)
  // =====================================================================
  const R = P.res;
  const STATUS_OPTS = [{ v: 'open', label: 'Open' }, { v: 'ended', label: 'Ended · unsettled', title: 'Past their end time on Meridian but not settled yet — where is each one in the resolution pipeline?' }, { v: 'settled', label: 'Settled' }, { v: 'all', label: 'All' }];
  /** Meridian's view of a question as the resolution tracker wants it (live API row or snapshot row). */
  const qView = (c) => (c.conditionId
    ? { end: c.endTime ? c.endTime * 1000 : null, settled: !!c.settled, yes: c.resolvedToYes, nd: !!c.nonDecisive, pub: c.isPublic, question: c.question }
    : { end: c.end || null, settled: !!c.settled, yes: c.yes, nd: !!c.nd, pub: c.pub, question: c.q, op: c.op });   // op: open predictions with their legs (snapshot rows); pub false = unlisted
  const qId = (c) => c.conditionId || c.id;
  /** Every prediction on a question (from the snapshot's question file), each with all its legs: who bet, how much,
   *  at what odds, and where each leg stands, so a "won" leg can be read together with the rest of the combo. */
  async function openQuestion(c, ctx) {
    const id = qId(c); const view = qView(c);
    const body = h('div', UI.loading('Loading predictions…'));
    const modal = UI.modal({ title: view.question || 'Question', body, wide: true });
    let file = null;
    try { file = await P.snapshotFile('questions/' + id + '.json'); } catch (_) {}
    if (!file) { U.replace(body, h('div.empty', 'No prediction detail for this question in the snapshot yet (it is written by the next snapshot run).')); return; }
    const preds = file.predictions.map(P.unslim);
    const legIds = Array.from(new Set(preds.flatMap((n) => n.picks.map((k) => k.id)).filter(Boolean)));
    // each leg's own state, also on decided predictions: a combo lost on one leg still has legs that went the bettor's
    // way or are open (stamping every leg with the prediction's result made an open question read "lost")
    const legState = (k, n) => { const o = legOutcome(k, n); return o ? h('span.xs', { class: TONE_TEXT[o.tone] || 'dim', title: o.text }, o.label) : h('span.dim.xs', '—'); };
    const predState = (n) => {
      if (n.decided) return resultChip(n);
      const ps = R.predictionState(n.picks.map((k) => [k.id, k.yes]));
      return ps.code === 'won' ? UI.chip('won on Polymarket · awaiting settlement', 'green') : ps.code === 'lost' ? UI.chip('lost · awaiting settlement', 'red') : UI.chip('open', 'accent');
    };
    const render = () => { const st = R.state(view, id); U.replace(body,
      h('div.row.wrap', { style: { gap: '8px', marginBottom: st.sub ? '2px' : '10px' } }, R.chip(view, id), h('span.small', st.main || ''), h('span.grow'), h('span.dim.small', `${file.total} prediction${file.total > 1 ? 's' : ''} on this question${file.total > preds.length ? ' · newest ' + preds.length + ' shown' : ''}`)),
      st.sub ? h('div.xs.dim', { style: { marginBottom: '10px' } }, st.sub) : null,
      h('div.card.tight', UI.table({ cols: [
        { key: 'b', label: 'Bettor', render: (n) => bettorLink(n.predictor) },
        { key: 't', label: 'Placed', render: (n) => h('span.dim', U.fmtDateTimeS(n.t)) },
        { key: 'legs', label: 'Legs', render: (n) => h('div', { style: { whiteSpace: 'normal', minWidth: '260px', maxWidth: '460px', lineHeight: '1.35' } }, n.picks.map((k) => h('div', { class: k.id === id ? 'bold' : '' }, sideChip(k.yes), ' ', k.q, ' ', legState(k, n)))) },
        { key: 's', label: 'Stake', num: true, render: (n) => usd(n.stake) },
        { key: 'o', label: 'Odds', num: true, render: (n) => h('span', pct(n.odds, 1), h('span.dim.xs', ' ' + mult(n.multiple))) },
        { key: 'p', label: 'Pays', num: true, render: (n) => usd(n.pool) },
        { key: 'm', label: 'Maker', render: (n) => bettorLink(n.counterparty, 3) },
        { key: 'r', label: 'State', render: predState },
      ], rows: preds, empty: 'No predictions', onRow: (n) => openPrediction(n, ctx) })),
      h('div.footer-note', { style: { textAlign: 'left' } }, 'A combo pays only if every leg resolves in the bettor\x27s favour; one leg resolved against it loses the whole stake even while the others are still open. The bold leg is this question. Click a prediction for its details.')); };
    render();
    const open = () => !ctx.signal.aborted && document.body.contains(body);
    if (legIds.length) R.load(legIds, { signal: ctx.signal, deep: false }).then(() => { if (!open()) return; render(); return R.load(legIds, { signal: ctx.signal, deep: true }); }).then(() => { if (open()) render(); }).catch(() => {});
    return modal;
  }

  // ---------- one prediction ----------
  const TONE_TEXT = { green: 'pos', red: 'neg', amber: 'amb' };   // a chip's colour as plain text
  /** Where one leg of a prediction stands for the bettor: Meridian's own result once it has settled the question, else
   *  the verdict (every leg of a won prediction went the bettor's way), else the source market as far as it has loaded.
   *  { label, tone, text }, or null when nothing is known. */
  function legOutcome(k, n) {
    const res = (v, where) => (v === 'void'
      ? { label: '50/50 · a loss', tone: 'amber', text: 'resolved 50/50 ' + where + ': Meridian settles that as a loss for the bettor' }
      : { label: v === !!k.yes ? 'won' : 'lost', tone: v === !!k.yes ? 'green' : 'red', text: 'resolved ' + (v ? 'YES' : 'NO') + ' ' + where });
    if (k.settled && (k.nonDecisive || k.resolvedToYes === true || k.resolvedToYes === false)) return res(k.nonDecisive ? 'void' : k.resolvedToYes, 'on Meridian');
    if (n.won) return { label: 'won', tone: 'green', text: 'the prediction won, so every leg went the bettor\'s way' };
    if (!k.id) return null;
    const st = R.state({ end: k.endTime, settled: false, question: k.q }, k.id);
    if (st.code === 'resolved') { const y = R.resolvedYes(st.m); if (y === true || y === false || y === 'void') return res(y, 'on Polymarket, not settled on Meridian yet'); }
    if (n.decided && !st.m) return null;   // source market not loaded (yet)
    return { label: st.chip[0], tone: st.chip[1], text: st.main + (st.sub ? ' · ' + st.sub : '') };
  }
  /** A leg that went against the bettor (resolved against its pick, or 50/50): Meridian's result, else the source market's. */
  const legAgainst = (k) => {
    if (k.settled && (k.nonDecisive || k.resolvedToYes === true || k.resolvedToYes === false)) return k.nonDecisive || k.resolvedToYes !== !!k.yes;
    const m = k.id ? R.get(k.id).m : null; if (!m || !(m.closed || m.uma === 'resolved')) return false;
    const y = R.resolvedYes(m); return y === 'void' || ((y === true || y === false) && y !== !!k.yes);
  };
  /** When a leg was settled: Meridian's own settlement time, else its source market's resolution once loaded, else its
   *  listed end (which can be a day late: a price question about Sep 28 is listed to end on the 29th). */
  const legTime = (k) => { if (k.settledAt) return k.settledAt; const m = k.id ? R.get(k.id).m : null; return (m && (m.resolvedAt || m.closedAt)) || U.num(k.endTime) || null; };
  /** When a decided prediction was settled, for display, never when its payout was claimed; null when it cannot be told.
   *  Meridian's leg settlement times where the record has them (P.legVerdictAt), else the snapshot's time, else: a win
   *  dates from its last leg, a loss from the first leg that went against the bettor (its other legs may run for weeks),
   *  never after the claim. */
  const decidedTime = (n) => {
    if (!n.decided) return null;
    const exact = P.legVerdictAt(n) || n.decidedAt; if (exact) return exact;
    const times = (n.won ? n.picks : n.picks.filter(legAgainst)).map(legTime).filter(Boolean);
    if (!times.length) return null;
    return Math.max(U.num(n.t), Math.min(n.won ? Math.max(...times) : Math.min(...times), n.settledAt || Infinity, Date.now()));
  };
  /** The bettor's hold on its position tokens: the share it still held at the verdict and its own result with the sale,
   *  from the caller's ledger (opts.held / opts.ledgerPnl: a bettor page) or the record's (the snapshot's h / lp). */
  function ownership(n, opts = {}) {
    const held = opts.held != null ? opts.held : n.held != null ? n.held : 1;
    const soldAll = held < 1e-6;
    return { held, ownPnl: opts.ledgerPnl != null ? opts.ledgerPnl : n.tradedPnl, soldAll, soldPart: !soldAll && held < 0.999, soldPct: U.fmtPct((1 - held) * 100, { dp: 0 }) };
  }
  /** A question the snapshot has a file for (open interest, open predictions, settled in the last 30 days): its row. */
  const qRows = new WeakMap();
  const snapQuestion = (id) => { const s = P._snap; if (!id || !s || !s.questionsWithOi) return null; let m = qRows.get(s); if (!m) { m = new Map(s.questionsWithOi.map((q) => [q.id, q])); qRows.set(s, m); } return m.get(id) || null; };
  /**
   * One prediction in a dialog, opened from any list of predictions: the result, stake, odds and payout, both sides,
   * every leg and where it stands, and the way on to the bettor's account. opts.here: the wallet whose page this is
   * (no button back to it); opts.traded: the caller's ledger says its position tokens were traded (a live record carries
   * no such mark: its pick configuration id is always set, traded or not; a snapshot record's pcTraded is the mark).
   */
  function openPrediction(x, ctx, opts = {}) {
    let n = P.full(x);
    const body = h('div');
    const first = n.picks[0] ? n.picks[0].q : '';
    const modal = UI.modal({ title: n.legs > 1 ? `${n.legs}-leg combo` : first || 'Prediction', body, wide: true });
    const open = () => !ctx.signal.aborted && document.body.contains(body);
    const legView = (k) => { const q = snapQuestion(k.id); return q ? qView(q) : { end: k.endTime, settled: !!k.settled, yes: k.resolvedToYes, nd: !!k.nonDecisive, question: k.q }; };
    const render = () => {
      const payout = usd(n.pool), stake = usd(n.stake);
      // the bettor's position tokens: the share it still held at the verdict and its own result, the sale included (from
      // the caller's ledger, else the snapshot's); a bettor who sold them does not collect the payout
      const { held, ownPnl, soldAll, soldPart, soldPct } = ownership(n, opts);
      const what = !n.decided ? `pays ${payout} on a ${stake} stake if ${n.legs > 1 ? 'every leg wins' : 'it wins'}` + (soldAll ? ', to whoever holds its tokens: the bettor sold them' : soldPart ? ` · the bettor has sold ${soldPct} of its tokens` : '')
        : n.won ? `won ${payout} on a ${stake} stake` + (soldAll ? ', but the bettor had sold its tokens: the payout goes to the buyer' : soldPart ? ` · the bettor had sold ${soldPct} of its tokens` : '')
        : n.nd ? 'void: the stake goes back to the bettor' : `lost the ${stake} stake to the market maker`;
      const decidedAt = decidedTime(n);
      const kv = (k, v) => (v == null ? null : [h('div.k', k), h('div', v)]);
      const who = (a) => h('div.row', { style: { gap: '6px' } }, bettorLink(a, 6), U.copyBtn(a));
      const traded = opts.traded || n.pcTraded || opts.held != null || n.held != null;
      U.replace(body,
        h('div.row.wrap', { style: { gap: '8px', marginBottom: '12px' } }, resultChip(n, false, held), h('span', U.capitalize(what)), h('span.grow'),
          // an open slip can be copied: Meridian's page for it (Add To Slip), under the site's referral code
          slipOpen(n) ? h('a.btn.sm.primary', { href: P.meridianSlipUrl(n.id), target: '_blank', rel: 'noopener', title: 'Opens this slip on Meridian Predict: press Add To Slip there, choose your amount and place it' }, U.icon('external'), 'Copy slip to Meridian') : null,
          n.predictor && n.predictor !== opts.here ? h('a.btn.sm', { class: slipOpen(n) ? '' : 'primary', href: bettorUrl(n.predictor), title: 'Every prediction of this bettor, its PnL and open positions' }, U.icon('account'), 'Open bettor\'s account') : null,
          P.isPredictionId(n.id) && !n.partial ? h('button.btn.sm.ghost', { type: 'button', title: 'A link that shows this slip\'s card in Discord, X, Telegram…, and the card as an image', onclick: () => shareSlip(n) }, U.icon('share'), 'Share') : null,
          P.isPredictionId(n.id) ? h('a.btn.sm.ghost', { href: '#/predict/p/' + n.id.toLowerCase(), title: 'This prediction on its own slip page' }, U.icon('ticket'), 'Slip page') : null,
          n.tx ? h('a.btn.sm.ghost', { href: U.explorerTx(n.tx), target: '_blank', rel: 'noopener', title: 'The transaction that placed it' }, U.icon('external'), 'Transaction') : null),
        h('div.stats', { style: { marginBottom: '14px' } },
          UI.stat('Stake', stake),
          UI.stat('Payout', payout, n.decided ? (n.won ? (soldAll ? 'to the token buyer' : soldPart ? `${U.fmtPct(held * 100, { dp: 0 })} to the bettor` : 'to the bettor') : n.nd ? 'split back' : 'to the market maker') : 'if it wins'),
          UI.stat('Odds', pct(n.odds, 1), mult(n.multiple) + ' the stake'),
          ownPnl != null && (n.decided || soldAll) ? UI.stat(n.decided ? 'Bettor PnL' : 'Bettor PnL so far', usd(ownPnl, { sign: true }), 'incl. selling its tokens · ' + (n.decided ? usd(n.pnl, { sign: true }) + ' had it kept them' : usd(n.cp, { sign: true }) + ' had it kept them and won'), U.pnlClass(ownPnl))
            : n.decided ? UI.stat('Bettor PnL', usd(n.pnl, { sign: true }), n.won ? 'payout − stake' : null, U.pnlClass(n.pnl)) : UI.stat('To win', usd(n.cp * held, { sign: true }), held < 0.999 ? 'on the tokens it still holds' : 'the maker\'s collateral'),
          UI.stat('Vig', n.vig == null ? '—' : pp(n.vig), 'odds vs Polymarket at bet time' + (n.sameEvent ? ' · legs on one event' : ''))),
        h('div.kv', { style: { marginBottom: '14px' } },
          kv('Bettor', who(n.predictor)), kv('Market maker', n.counterparty ? who(n.counterparty) : null),
          kv('Placed', U.fmtDateTimeS(n.t) + ' · ' + U.fmtAgo(n.t)),
          kv('Settled', decidedAt ? h('span', { title: 'When the slip settled on Meridian, claimed or not: a win when its last leg settled, a loss when the first leg settled against the bettor (each leg at Meridian\'s own settlement time where known, else its Polymarket resolution or listed end)' }, U.fmtDateTime(decidedAt)) : null),
          n.won || n.nd ? kv('Paid out', n.settled && n.settledAt ? 'claimed ' + U.fmtDateTime(n.settledAt) : n.unclaimed ? (soldAll ? 'the buyer\'s to claim' : 'not claimed yet') : null) : kv('Claimed', n.settled && n.settledAt ? 'by the market maker, ' + U.fmtDateTime(n.settledAt) : null),
          kv('Category', n.cat || null),
          kv('Secondary market', soldAll ? 'the bettor sold all its position tokens before the verdict' : soldPart ? `the bettor sold ${soldPct} of its position tokens before the verdict` : traded ? 'position tokens on these picks changed hands before the verdict, so part of the payout may have gone to a buyer' : null)),
        h('div.card.tight', UI.table({ cols: [
          { key: 's', label: 'Pick', render: (k) => sideChip(k.yes) },
          { key: 'q', label: n.legs > 1 ? 'Leg' : 'Question', render: (k) => { const q = snapQuestion(k.id); return h('div', { style: { whiteSpace: 'normal', minWidth: '220px', maxWidth: '520px', lineHeight: '1.3' } },
            // a plain click opens the question's dialog; a new tab or a copied link opens the Questions page on it
            q ? h('a', { href: '#/predict/questions?status=all&q=' + encodeURIComponent(k.q || ''), title: 'Every prediction on this question', onclick: (e) => { if (e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; e.preventDefault(); openQuestion(q, ctx); } }, k.q) : k.q,
            k.endTime ? h('div.xs.dim', (k.endTime > Date.now() ? 'Meridian cutoff ' : 'ended ') + U.fmtDateTime(k.endTime)) : null); } },
          { key: 'c', label: 'Category', render: (k) => k.cat || '—' },
          { key: 'p', label: 'Polymarket at bet', num: true, title: 'The source market\'s probability for this pick when the bet was placed', render: (k) => pct(k.fairAtBet, 1) },
          { key: 'r', label: 'Result', title: 'Meridian\'s result once it has settled the question, before that the source market\'s', render: (k) => { const o = legOutcome(k, n); return h('div.row', { style: { gap: '4px', flexWrap: 'nowrap' } },
            o ? h('span.chip', { class: o.tone, title: o.text }, o.label) : h('span.dim', '—'),
            k.id ? h('button.btn.sm.icon.ghost', { title: 'Resolution details', onclick: (e) => { e.stopPropagation(); R.openDetails(legView(k), k.id, { appUrl: P.APP_URL }); } }, U.icon('info')) : null); } },
        ], rows: n.picks, empty: 'No legs' })),
        n.partial ? h('div.xs.dim', { style: { marginTop: '8px' } }, `Loading the other ${n.legs > 1 ? 'legs' : 'details'} from the snapshot…`) : n.firstLegOnly ? h('div.xs.dim', { style: { marginTop: '8px' } }, `Only the first of its ${n.legs} legs is in this snapshot.`) : null,
        h('div.footer-note', { style: { textAlign: 'left' } }, 'Odds = stake ÷ payout, and the payout is the stake plus the market maker\'s collateral. A combo pays only if every leg resolves in the bettor\'s favour; a leg that resolves 50/50 counts as a loss on Meridian.'));
    };
    // every leg's source market (details button, and the state of the legs Meridian has not settled yet)
    const loadLegs = () => {
      const ids = Array.from(new Set(n.picks.map((k) => k.id).filter(Boolean))); if (!ids.length) return;
      const deep = n.picks.filter((k) => k.id && !k.settled && !n.won).map((k) => k.id);
      R.load(ids, { signal: ctx.signal, deep: false }).then(() => { if (!open()) return; render(); return deep.length ? R.load(deep, { signal: ctx.signal, deep: true }) : null; }).then(() => { if (open()) render(); }).catch(() => {});
    };
    render(); loadLegs();
    if (n.partial) {
      // the bettor's file has the whole record; without it the dialog says what it lacks rather than loading forever
      const done = (s) => { n = s ? P.unslim(s) : Object.assign({}, n, { partial: false, firstLegOnly: n.legs > 1 }); if (open()) { render(); if (s) loadLegs(); } };
      if (!U.isAddress(n.predictor)) done(null);
      else P.snapshotFile('bettors/' + n.predictor + '.json', { signal: ctx.signal }).then((f) => done(f && (f.predictions || []).find((p) => p.id === n.id))).catch((e) => { if (!isAbort(e)) done(null); });
    }
    return modal;
  }
  P.openPrediction = openPrediction;

  // =====================================================================
  // Slip page: #/predict/p/<predictionId>, Meridian's own path (index.html sends /predict/p/<id> here, so a link from
  // the app works with the domain swapped). One prediction as a card, and a one-click way to copy it into Meridian
  // Predict under the site's referral code: Meridian's page for the prediction, whose Add To Slip adds the same picks
  // to the visitor's bet slip.
  // =====================================================================
  /** A leg that no longer takes bets: past its Meridian cutoff, settled on Meridian, or its source market closed. */
  const legClosed = (k, now) => (!!k.endTime && k.endTime <= now) || !!k.settled || !!(k.id && R.get(k.id).m && R.get(k.id).m.closed);
  /** Can the slip still be placed: undecided, with every leg still taking bets. */
  function slipOpen(n) { const now = Date.now(); return !!n && !n.decided && !n.partial && !!n.picks.length && !n.picks.some((k) => legClosed(k, now)); }
  /** One prediction by id: the snapshot's lists in memory while they are fresh (tape, big wins), else its file
   *  slips/<first two hex digits>.json. { n, builtAt, unavailable }: n null with a file read means it is not in the
   *  snapshot; unavailable means the file could not be read (not published yet, a network error). */
  async function findPrediction(id, signal) {
    id = String(id).toLowerCase();
    const a = P._snap && P._snap.agg;
    const row = a && [].concat(a.bigWins || [], a.tape || []).find((x) => String(x.id).toLowerCase() === id);
    const mem = row ? { n: P.full(row), builtAt: P._snap.builtAt } : null;
    if (mem && Date.now() - P._snapAt < 60000) return mem;
    let f = null;   // a missing file comes back as the SPA's index.html (status 200): not JSON, so unavailable as well
    try { const r = await fetch(P.SNAPSHOT_BASES[0] + 'slips/' + id.slice(2, 4) + '.json', { cache: 'no-cache', signal }); if (r.ok) f = await r.json(); } catch (e) { if (isAbort(e)) throw e; }
    if (!f || !f.slips || typeof f.slips !== 'object') return mem || { n: null, builtAt: null, unavailable: true };
    const rec = Object.prototype.hasOwnProperty.call(f.slips, id) ? f.slips[id] : null;
    return rec ? { n: P.full(rec), builtAt: f.builtAt } : mem || { n: null, builtAt: f.builtAt };
  }
  /** The pick's probability now: Polymarket's price once loaded, else the snapshot's source price. */
  const pickProb = (k) => { const m = k.id ? R.get(k.id).m : null; const yes = m && m.prices && m.prices.length && Number.isFinite(m.prices[0]) && !m.closed ? m.prices[0] : k.ep; return yes == null ? null : k.yes ? yes : 1 - yes; };
  const gauge = (p) => h('span.gauge-wrap', { title: 'Polymarket now: the chance of this pick' }, h('i.gauge', { style: { background: `conic-gradient(var(--green) ${Math.round(U.clamp(p, 0, 1) * 360)}deg, var(--bg-5) 0)` } }), pct(p, 0));
  const slipHowTo = () => h('div.slip-note', 'Copying opens this slip on Meridian Predict. Press ', h('b', 'Add To Slip'), ' there: its picks join whatever is already in your Meridian slip (clear that first to place exactly this one). Choose your amount and place it; Meridian\'s market makers quote fresh odds, so yours can differ from the ones locked here.');
  const slipBrand = () => h('span.slip-brand', 'Meridian', h('span', 'DataHub'));

  async function mountSlip(body, route, ctx) {
    MD.setTopbar(h('span.title', 'Predict · Slip'));
    const id = route.path.split('/')[3] || '';
    if (!id) { U.replace(body, slipForm()); return; }
    if (!P.isPredictionId(id)) { U.replace(body, h('div.card', h('div.error', 'That is not a prediction id. A slip link ends in 0x and 64 hex digits, as in app.meridian.xyz/predict/p/0x…')), slipForm()); return; }
    U.replace(body, loadingCard('Loading the slip…'));
    let found;
    try { found = await findPrediction(id, ctx.signal); } catch (e) { if (!isAbort(e)) U.replace(body, UI.error(e, () => MD.router.dispatch())); return; }
    if (ctx.signal.aborted) return;
    if (!found.n) {
      // not in the snapshot (placed since it was built), or the snapshot's slip file could not be read: Meridian's own
      // page can open it either way, if it is a real prediction
      U.replace(body, h('div.slip-wrap', h('div.slip',
        h('div.slip-head', slipBrand(), h('span.grow'), UI.chip(found.unavailable ? 'slip files unavailable' : 'not in the snapshot yet', 'amber')),
        h('p.muted', { style: { margin: 0 } }, found.unavailable
          ? 'The snapshot\'s slip files could not be read just now (they are published with the snapshot every 30 minutes). Try again in a moment, or open the slip on Meridian:'
          : `This prediction is not in the published snapshot${found.builtAt ? ' (built ' + U.fmtAgo(found.builtAt) + ', refreshed every 30 minutes)' : ''}. One placed since then appears with the next snapshot; Meridian has it already:`),
        h('a.btn.primary.slip-copy', { href: P.meridianSlipUrl(id), target: '_blank', rel: 'noopener' }, U.icon('external'), 'Open the slip on Meridian Predict'),
        found.unavailable ? h('div.slip-actions', h('button.btn.sm', { type: 'button', onclick: () => mountSlip(body, route, ctx) }, 'Try again')) : null,
        slipHowTo())));
      return;
    }
    renderSlip(body, found.n, found.builtAt, ctx);
  }

  /** The share dialog of a slip (js/flex.js FX.card): its card drawn here, and the /s/<id> link, which unfurls into the
   *  same card once the deploy has made it (js/cards.js slipCardWanted). */
  function shareSlip(n) {
    const K = MD.cards.make({ U, P }), st = K.slipState(n), id = String(n.id).toLowerCase();
    const combo = n.legs > 1 ? `${n.legs}-leg combo` : 'single';
    const post = st === 'won' ? `Won ${usd(n.pnl, { sign: true })} on a ${usd(n.stake)} ${combo} on Meridian Predict (${mult(n.multiple)})`
      : st === 'open' ? `${usd(n.stake)} to win ${usd(n.pool)} on a ${mult(n.multiple)} ${combo} on Meridian Predict`
        : `A ${mult(n.multiple)} ${combo} on Meridian Predict`;
    return MD.flex.card({ title: 'Share this slip', alt: K.slipText(n).title, draw: (fontCss) => K.slipSvg(n, { fontCss }), fname: `meridian-slip-${id.slice(2, 10)}.png`,
      shareUrl: MD.api.shareUrl('s', id), card: 'cards/s/' + id + '.png', expected: K.slipCardWanted(n), postText: post });
  }
  P.shareSlip = shareSlip;

  function renderSlip(body, n, builtAt, ctx) {
    const wrap = h('div.slip-wrap');
    U.replace(body, wrap);
    const render = () => {
      const now = Date.now(), open = slipOpen(n), own = ownership(n);
      const closed = n.picks.filter((k) => legClosed(k, now)).length;
      const kind = n.legs > 1 ? `${n.legs}-leg combo` : 'single';
      const state = n.decided ? (n.won ? UI.chip(own.soldAll ? 'won · sold' : 'won · ' + kind, 'green') : n.nd ? UI.chip('void', 'amber') : UI.chip('lost · ' + kind, 'red')) : UI.chip(open ? 'live · ' + kind : 'betting closed', open ? 'accent' : 'amber');
      // the result: what the bettor made once decided (its own, where it sold its position tokens), else what it pays
      const pnl = own.ownPnl != null ? own.ownPnl : n.pnl;
      const sold = own.soldAll ? (n.decided ? ' · the bettor had sold its tokens: the payout goes to the buyer' : ' · the bettor has sold its tokens') : own.soldPart ? ` · the bettor ${n.decided ? 'had' : 'has'} sold ${own.soldPct} of its tokens` : '';
      const [heroK, heroV, heroCls, heroS] = !n.decided ? ['Pays', usd(n.pool), '', `on a ${usd(n.stake)} stake, if ${n.legs > 1 ? 'every leg wins' : 'it wins'}` + sold]
        : n.won ? [own.ownPnl != null ? 'Won · the bettor\'s PnL, incl. selling its tokens' : 'Won', usd(pnl, { sign: true }), U.pnlClass(pnl), `${usd(n.pool)} paid on a ${usd(n.stake)} stake` + (n.unclaimed && !own.soldAll ? ' · not claimed yet' : '') + sold]
          : n.nd ? ['Void', usd(pnl, { sign: true }), '', 'the stake goes back to the bettor']
            : ['Lost', usd(pnl, { sign: true }), U.pnlClass(pnl), `the ${usd(n.stake)} stake went to the market maker · it would have paid ${usd(n.pool)}` + sold];
      // the whole slip's chance on Polymarket now (legs as independent), against the odds this bettor locked
      const probs = n.decided ? [] : n.picks.map(pickProb);
      const fairNow = probs.length && probs.every((p) => p != null) ? probs.reduce((a, p) => a * p, 1) : null;
      const decidedAt = decidedTime(n);
      const cell = (k, v, title) => h('div', { title: title || null }, h('div.k', k), h('div.v', v));
      const leg = (k) => {
        const o = legOutcome(k, n); const shut = legClosed(k, now); const p = shut || n.decided ? null : pickProb(k);
        const when = k.settled ? 'settled on Meridian' : !k.endTime ? null : k.endTime <= now ? (n.decided ? 'ended ' : 'betting closed ') + U.fmtDateTime(k.endTime) : n.decided ? 'listed to end ' + U.fmtWhen(k.endTime) : shut ? 'closed on Polymarket' : 'bets close ' + U.fmtWhen(k.endTime);
        const meta = [k.fairAtBet != null ? pct(k.fairAtBet, 0) + ' at bet' : null, when, k.cat || null].filter(Boolean).join(' · ');
        return h('div.slip-leg',
          h('div.side', sideChip(k.yes)),
          h('div.q', h('div', k.q), meta ? h('div.meta', meta) : null),
          h('div.end', p != null ? gauge(p) : null, o ? h('span.chip', { class: o.tone, title: o.text }, o.label) : null));
      };
      const btnShare = (primary) => h('button.btn', { type: 'button', class: primary ? 'primary slip-copy' : 'slip-share', dataset: { focusKey: 'slip:share' }, title: 'A link that shows this slip\'s card in Discord, X, Telegram…, and the card as an image', onclick: () => shareSlip(n) }, U.icon('share'), primary ? 'Share this slip' : 'Share');
      U.replace(wrap, h('div.slip', { class: 'is-' + (n.decided ? (n.won ? 'won' : n.nd ? 'void' : 'lost') : 'open') },
        h('div.slip-head', slipBrand(), h('span.grow'), state),
        h('div.slip-hero',
          h('div.k', heroK),
          h('div.v', { class: heroCls }, heroV),
          h('div.s', heroS)),
        h('div.slip-strip',
          cell('Stake', usd(n.stake)),
          cell('Multiplier', mult(n.multiple), 'Payout ÷ stake'),
          cell('Odds', n.odds == null ? '—' : pct(n.odds, n.odds < 0.1 ? 1 : 0), 'Locked odds: stake ÷ payout, the price of one USDe of payout'),
          n.decided ? cell('Settled', decidedAt ? U.fmtDate(decidedAt).replace(', ' + new Date().getFullYear(), '') : '—', decidedAt ? U.fmtDateTime(decidedAt) : null)
            : fairNow != null ? cell('Polymarket now', pct(fairNow, fairNow < 0.1 ? 1 : 0), 'The legs\' Polymarket prices now, multiplied (as if independent), against the ' + pct(n.odds, 1) + ' locked')
              : cell('Placed', U.fmtAgo(n.t))),
        h('div.slip-legs-head', h('span', n.legs > 1 ? `${n.legs} legs` : '1 leg'), h('span.grow'), n.legs > 1 ? h('span', 'every leg must win') : null),
        h('div.slip-legs', n.picks.map(leg)),
        // (data-focus-key: a keyboard user's focus comes back to the button after a refresh redrew the card)
        open ? h('div.slip-cta', h('a.btn.primary.slip-copy', { href: P.meridianSlipUrl(n.id), target: '_blank', rel: 'noopener' }, U.icon('external'), 'Copy slip to Meridian Predict'), btnShare(false))
          : h('div.slip-cta', btnShare(true)),
        !open && !n.decided ? h('div.slip-note', { style: { textAlign: 'center' } }, `Betting has closed on ${closed} of its ${n.legs} leg${n.legs > 1 ? 's' : ''}: it can no longer be copied.`) : null,
        open ? slipHowTo() : null,
        h('div.slip-actions',
          h('button.btn.sm.ghost', { type: 'button', dataset: { focusKey: 'slip:details' }, title: 'Stake, odds, both sides, every leg and its resolution', onclick: () => openPrediction(n, ctx) }, U.icon('info'), 'Details'),
          n.predictor ? h('a.btn.sm.ghost', { href: bettorUrl(n.predictor), title: 'Every prediction of this bettor, its PnL and open positions' }, U.icon('account'), 'Bettor ' + U.shortAddr(n.predictor, 4)) : null,
          open ? null : h('a.btn.sm.ghost', { href: P.meridianSlipUrl(n.id), target: '_blank', rel: 'noopener', title: 'Meridian\'s page for this prediction' }, U.icon('external'), 'View on Meridian')),
        h('div.slip-note', { style: { textAlign: 'center' } }, 'Placed ' + U.fmtDateTime(n.t) + (builtAt ? ' · as of the snapshot built ' + U.fmtAgo(builtAt) : ''), builtAt ? UI.staleNote(builtAt) : null, n.decided ? '' : ' · the chances are Polymarket\'s, live.')));
    };
    render();
    // Polymarket for the legs still open: their chances now, and where each one stands; the minute's redraw waits while
    // a button in the card has the keyboard focus
    const ids = Array.from(new Set(n.picks.filter((k) => k.id && !k.settled).map((k) => k.id)));
    const kbdInside = () => { const a = document.activeElement; return !!a && a !== wrap && wrap.contains(a) && a.matches(':focus-visible'); };
    const refresh = () => R.load(ids, { signal: ctx.signal, deep: false }).then(() => { if (!ctx.signal.aborted && !kbdInside()) render(); }).catch(() => {});
    if (ids.length) refresh();
    // a decided slip without the snapshot's settlement time: its legs' Polymarket resolutions date it (decidedTime), once
    const done = n.decided && !P.legVerdictAt(n) && !n.decidedAt ? Array.from(new Set(n.picks.filter((k) => k.id && k.settled).map((k) => k.id))) : [];
    if (done.length) R.load(done, { signal: ctx.signal, deep: false }).then(() => { if (!ctx.signal.aborted && !kbdInside()) render(); }).catch(() => {});
    const t = setInterval(() => { if (!ctx.signal.aborted && ids.length) refresh(); }, 60000);
    ctx.onCleanup(() => clearInterval(t));
  }

  /** No id: paste a Meridian link or an id (a link's id first; a bare id only as the whole input). */
  function slipForm() {
    const input = h('input.input', { placeholder: 'https://app.meridian.xyz/predict/p/0x… or 0x…', style: { flex: '1', minWidth: '0' } });
    const go = () => { const v = input.value; const m = /\/predict\/p\/(0x[0-9a-f]{64})(?![0-9a-f])/i.exec(v) || /^\s*(0x[0-9a-f]{64})\s*$/i.exec(v); if (!m) { U.toast('No Meridian prediction link or id in that'); return; } location.hash = '#/predict/p/' + m[1].toLowerCase(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    return h('div.slip-wrap', h('div.slip',
      h('h2', { style: { margin: 0 } }, 'Copy a slip into Meridian Predict'),
      h('p.muted', { style: { margin: 0 } }, 'Paste a Meridian prediction link (app.meridian.xyz/predict/p/0x…) or its id to see the slip here and copy it. Or open any prediction on the ', h('a', { href: '#/predict' }, 'Overview'), ' (Live predictions, Big wins) and press Copy slip.'),
      h('div.row', { style: { gap: '8px' } }, input, h('button.btn.primary', { type: 'button', onclick: go }, 'Show slip'))));
  }
  // =====================================================================
  // Ideas from winning bettors (mounted on the Copy trading page): slips that can still be placed, from bettors whose
  // record beats what their locked odds implied (P.IDEAS, P.ideas); each one click from Meridian. The snapshot writes
  // them to predict-ideas.json (a few KB, so the page does not load the Predict snapshot).
  // =====================================================================
  /** How often luck alone gives a record this good (b.luck = P.luckOf): "1 in 40" when rare, a percentage when not. */
  const luckText = (luck) => (luck == null ? '—' : luck < 1e-4 ? 'under 1 in 10,000' : luck < 0.2 ? '1 in ' + U.fmtNum(Math.floor(1 / luck + 1e-9), 0) : U.fmtPct(luck * 100, { dp: 0 }));   // rounded down: "1 in 10" means 1 in 10 or likelier to be luck
  const luckPhrase = (luck) => (luck < 1e-4 ? 'less than once in 10,000 times' : luck < 0.2 ? `about ${luckText(luck)} times` : `about ${luckText(luck)} of the time`);
  const recordText = (b) => `${U.fmtNum(b.n, 0)} decided bets${b.predictions > b.n ? ` (${U.fmtNum(b.predictions, 0)} predictions: those that share a question count as one bet)` : ''}, ${U.fmtNum(b.won, 0)} won where the locked odds implied ${U.fmtNum(b.expected, 1)}; ${usd(b.pnl, { sign: true })}${b.roi != null ? ' (ROI ' + U.fmtPct(b.roi, { sign: true, dp: 0 }) + ')' : ''}. If every bet had exactly the chance its odds priced, a record this good would come ${luckPhrase(b.luck)} by luck alone.`;
  // a tier where the record is rare enough by luck (P.ideas); below that the figure itself, in a neutral chip
  const recordChip = (b) => { const [label, tone] = b.tier === 'strong' ? ['strong record', 'green'] : b.tier === 'good' ? ['good record', 'blue'] : ['luck ' + luckText(b.luck), '']; return h('span.chip', { class: tone, title: recordText(b) }, label); };
  /** The whole slip's chance on Polymarket now (legs as independent), or null while a leg has none. */
  const slipChance = (n) => { const ps = n.picks.map(pickProb); return ps.length && ps.every((p) => p != null) ? ps.reduce((a, p) => a * p, 1) : null; };
  P.ideasCard = function (ctx) {
    const st = { view: 'slips', show: 'all', sort: 'newest' };
    const body = h('div', UI.loading('Loading ideas from winning bettors…'));
    const summary = h('span.dim.small'), controls = h('span.row.wrap', { style: { gap: '6px' } });
    const foot = h('div.footer-note', { style: { textAlign: 'left', padding: '10px 14px' } });
    const card = h('div.card.tight', { id: 'predict-ideas' }, h('div.card-head', h('h2', 'Predict ideas from winning bettors'), summary, h('span.grow'), controls), body, foot);
    const footText = (f) => [
      `Winning bettors: at least ${P.IDEAS.minDecided} decided bets, in profit, and more of them won than their locked odds implied. Predictions that share a question (the same pick placed again, combos on one match) count as one bet: the one with the largest stake, at its own odds and with its own result. Wins count, not money, so one long shot that hit does not make a record. `,
      `The chip says how rarely luck alone gives a record that good: strong at 1 in ${Math.round(1 / P.IDEAS.strongLuck)} or rarer, good at 1 in ${Math.round(1 / P.IDEAS.goodLuck)} (when no one reaches that, the best record counts as good); hover it for the numbers. `,
      'An idea is one of their predictions that can still be placed: Copy to Meridian opens it there, press Add To Slip and choose your amount. Meridian\'s makers quote fresh odds and their margin applies to you too; across all bettors, decided bets have returned less than they staked (', h('a', { href: '#/predict/vig' }, 'Vig & edge'), '). A record is no promise.'];
    let file = null, bettors = new Map(), ideas = [], ids = [];
    // the timed redraws wait while a keyboard user is in the card or a dialog is open (a row replaced under an open dialog
    // could not take the focus back)
    const quiet = () => { const a = document.activeElement; return (!!a && card.contains(a) && a.matches(':focus-visible')) || !!document.querySelector('.modal-bg'); };
    // the controls are built once and only switched (rebuilding them dropped a keyboard user's focus on every press)
    const segView = UI.seg([{ v: 'slips', label: 'Open slips' }, { v: 'bettors', label: 'Winning bettors' }], st.view, (v) => { st.view = v; render(); }, 'sm');
    const segShow = UI.seg([{ v: 'all', label: 'All', title: 'Every winning bettor' }, { v: 'good', label: 'Good record', title: 'Bettors whose record is good or strong' }], st.show, (v) => { st.show = v; render(); }, 'sm');
    const segSort = UI.seg([{ v: 'newest', label: 'Newest' }, { v: 'record', label: 'Best record' }, { v: 'closing', label: 'Closing soon' }], st.sort, (v) => { st.sort = v; render(); }, 'sm');
    U.append(controls, [segView, segShow, segSort]);
    const render = () => {
      segShow.style.display = segSort.style.display = st.view === 'slips' ? '' : 'none';
      if (!file) { U.replace(body, UI.empty('The first ideas arrive with the next Predict snapshot (published every 30 minutes).')); U.replace(summary, ''); U.replace(foot, footText(null)); return; }
      const now = Date.now();
      let rows = ideas.filter(slipOpen);
      const openCount = new Map(); for (const n of rows) openCount.set(n.predictor, (openCount.get(n.predictor) || 0) + 1);
      U.replace(summary, `${rows.length} open slip${rows.length === 1 ? '' : 's'} · ${bettors.size} winning bettor${bettors.size === 1 ? '' : 's'} · snapshot ${U.fmtAgo(file.builtAt)}`, UI.staleNote(file.builtAt, 'the Predict publishing job may be down'));
      U.replace(foot, footText(file));
      if (st.view === 'bettors') {
        U.replace(body, UI.table({ cols: [
          { key: 'b', label: 'Bettor', render: (b) => h('div.row', { style: { gap: '6px' } }, bettorLink(b.address, 5), recordChip(b)) },
          { key: 'r', label: 'Record', title: 'Decided bets won (predictions that share a question count as one), against the number their locked odds implied', render: (b) => h('span', { title: recordText(b) }, `${U.fmtNum(b.won, 0)} of ${U.fmtNum(b.n, 0)} bets won`, h('span.dim.xs', ' · odds implied ' + U.fmtNum(b.expected, 1))) },
          { key: 'z', label: 'By luck', num: true, title: 'How rarely a record this good comes about by luck alone, if every bet had exactly the chance its odds priced', render: (b) => luckText(b.luck) },
          { key: 'p', label: 'PnL', num: true, render: (b) => pnlEl(b.pnl) },
          { key: 'roi', label: 'ROI', num: true, render: (b) => UI.pct(b.roi, { dp: 0 }) },
          { key: 'w', label: 'Wagered', num: true, render: (b) => usd(b.wagered, { compact: true }) },
          { key: 'o', label: 'Open slips', num: true, title: 'Its predictions that can still be placed', render: (b) => { const k = openCount.get(b.address) || 0; return k ? h('b', String(k)) : h('span.dim', '0'); } },
          { key: 'l', label: 'Last bet', render: (b) => h('span.dim', U.fmtAgo(b.last)) },
        ], rows: Array.from(bettors.values()), empty: 'No bettor meets the bar yet', onRow: (b) => { location.hash = bettorUrl(b.address).slice(1); } }));
        return;
      }
      if (st.show === 'good') rows = rows.filter((n) => !!bettors.get(n.predictor).tier);
      const closesAt = (n) => Math.min(...n.picks.map((k) => k.endTime || Infinity));
      if (st.sort === 'closing') rows = U.sortBy(rows, closesAt, false);
      else if (st.sort === 'newest') rows = U.sortBy(rows, (n) => n.t, true);   // 'record': the file's order (best record, then newest)
      U.replace(body, rows.length ? UI.table({ cols: [
        { key: 'b', label: 'Bettor', render: (n) => { const b = bettors.get(n.predictor); return h('div', { style: { lineHeight: '1.3' } }, h('div.row', { style: { gap: '6px' } }, bettorLink(n.predictor, 4), recordChip(b)), h('div.xs.dim', { title: recordText(b) }, `${U.fmtNum(b.won, 0)} of ${U.fmtNum(b.n, 0)} bets won · ${usd(b.pnl, { sign: true, compact: true })}`)); } },
        { key: 's', label: 'Slip', render: (n) => h('div', { style: { whiteSpace: 'normal', minWidth: '220px', maxWidth: '400px', lineHeight: '1.3' } }, n.picks.slice(0, 2).map((k) => h('div', sideChip(k.yes), ' ', k.q)), n.legs > 2 ? h('div.xs.dim', '+' + (n.legs - 2) + (n.legs === 3 ? ' more leg' : ' more legs')) : null) },
        { key: 'c', label: 'Closes', title: 'The first leg\'s Meridian betting cutoff', render: (n) => { const t = closesAt(n); return h('span', { title: U.fmtDateTime(t) }, 'in ' + U.fmtCountdown(t - now)); } },
        { key: 'o', label: 'Their odds', num: true, title: 'The odds this bettor locked, and its stake (×: it placed this same slip more than once)', render: (n) => h('div', { style: { lineHeight: '1.3' } }, h('div', pct(n.odds, 1), h('span.dim.xs', ' ' + mult(n.multiple))), h('div.xs.dim', 'bet ' + usd(n.stake) + (n.times > 1 ? ' · ×' + n.times : ''))) },
        // against Polymarket's own chance when the bet was placed, not the locked odds (they include the maker's margin)
        { key: 'f', label: 'Chance now', num: true, title: 'Polymarket\'s chance for the whole slip now (legs taken as independent), and how far it has moved since the bettor placed it. Up: the market has come round to the pick, so a copier gets a shorter price than the bettor did (Meridian\'s makers quote near the market, plus their margin)', render: (n) => { const f = slipChance(n); if (f == null) return h('span.dim', '—'); const d = n.fairAtBet != null ? f - n.fairAtBet : null; return h('span', { title: n.sameEvent ? 'Some legs are on the same event: their real joint chance is higher than this product' : null }, (n.sameEvent ? '≈ ' : '') + pct(f, f < 0.1 ? 1 : 0), d != null && Math.abs(d) >= 0.0005 ? h('span.xs', { class: d > 0 ? 'pos' : 'neg' }, ' ' + pp(d, Math.abs(d) < 0.01 ? 1 : 0)) : null); } },
        { key: 'a', label: '', render: (n) => h('div.row', { style: { gap: '6px', flexWrap: 'nowrap' } },
          h('a.btn.sm.primary', { href: P.meridianSlipUrl(n.id), target: '_blank', rel: 'noopener', title: 'Opens the slip on Meridian Predict: press Add To Slip there' }, U.icon('external'), 'Copy to Meridian'),
          h('a.btn.sm.ghost', { href: '#/predict/p/' + String(n.id).toLowerCase(), title: 'The slip page, with a link to share' }, 'Slip')) },
      ], rows, onRow: (n) => openPrediction(n, ctx) })
        : !bettors.size ? UI.empty(`No bettor meets the bar right now (at least ${P.IDEAS.minDecided} decided bets, in profit, more wins than the odds implied).`)
        : h('div.empty', h('div', { style: { marginBottom: '10px' } }, st.show === 'good' && ideas.some(slipOpen) ? 'No open slip from a bettor with a good record right now.' : `No slip from a winning bettor can be placed right now. There ${bettors.size === 1 ? 'is 1 winning bettor' : 'are ' + bettors.size + ' winning bettors'}; their new slips appear here within 30 minutes of being placed.`),
          h('button.btn.sm', { type: 'button', onclick: () => { st.view = 'bettors'; segView.set('bettors'); render(); } }, 'See the winning bettors')));
    };
    // Polymarket for their legs: the chance now, and legs whose market has closed (no longer copyable); R keeps markets
    // five minutes, so asking every minute costs a request at most every five
    const refreshMarkets = () => { if (ids.length) R.load(ids, { signal: ctx.signal, deep: false }).then(() => { if (!ctx.signal.aborted && !quiet()) render(); }).catch(() => {}); };
    const load = async () => {
      let f = null; try { f = await P.snapshotFile('predict-ideas.json', { signal: ctx.signal }); } catch (e) { if (isAbort(e)) return; }
      if (ctx.signal.aborted || !f || !Array.isArray(f.bettors) || !Array.isArray(f.ideas)) { if (!file) render(); return; }
      if (file && f.builtAt === file.builtAt) return;
      file = f; bettors = new Map(f.bettors.map((b) => [b.address, b]));
      ideas = f.ideas.map((r) => Object.assign(P.full(r), { times: r.x > 1 ? r.x : 1 })).filter((n) => bettors.has(n.predictor));
      ids = Array.from(new Set(ideas.flatMap((n) => n.picks.map((k) => k.id)).filter(Boolean)));
      render(); refreshMarkets();
    };
    load();
    const t1 = setInterval(() => { if (ctx.signal.aborted || !file) return; if (!quiet()) render(); refreshMarkets(); }, 60000);   // countdowns, cutoffs, chances
    const t2 = setInterval(() => { if (!ctx.signal.aborted) load(); }, 5 * 60000);                                                     // a new snapshot
    ctx.onCleanup(() => { clearInterval(t1); clearInterval(t2); });
    return card;
  };

  let resLoading = 0;   // > 0 while Polymarket / oracle data for the visible rows is on its way (header shows a spinner)
  const resCols = (rows) => [
    { key: 'r', label: h('span', 'Resolution', resLoading ? h('span.spinner.sm', { title: 'loading Polymarket and oracle data' }) : null), title: 'When and how this question resolves — from Polymarket and the UMA oracle', render: (c) => R.cell(qView(c), qId(c), { appUrl: P.APP_URL }) },
    { key: 's', label: 'Status', render: (c) => R.chip(qView(c), qId(c)) },
  ];
  /** Pull Polymarket + oracle data for the rows on screen, re-rendering as each layer arrives; keeps countdowns fresh. */
  function trackResolution(rows, ctx, rerender, isCurrent) {
    const ids = rows.map(qId).filter(Boolean);
    if (!ids.length) return;
    (async () => {
      resLoading++;
      try { await R.load(ids, { signal: ctx.signal, deep: false }); if (!isCurrent()) return; rerender(); await R.load(ids, { signal: ctx.signal, deep: true }); }
      catch (e) { if (!isAbort(e)) console.warn('resolution tracker', e); }
      finally { resLoading--; }
      if (isCurrent()) rerender();
    })();
  }
  const resTicker = (ctx, fn) => { const t = setInterval(fn, 30000); ctx.signal.addEventListener('abort', () => clearInterval(t)); };
  /** "Ended · unsettled" order: the ones furthest along the pipeline first, then by end time. */
  const STAGE_RANK = { vote: 0, disputed: 1, proposed: 2, settling: 3, awaiting: 4, noresult: 4, resolved: 5, paused: 6, postponed: 7, unknown: 8, trading: 9, settled: 10 };
  const byStage = (rows) => U.sortBy(rows, (c) => { const st = R.state(qView(c), qId(c)); return (st.code === 'resolved' && st.stuck ? -1 : (STAGE_RANK[st.code] || 0)) * 1e13 + (st.stuck ? (st.at || 0) : (qView(c).end || 0)); });
  const resFootnote = () => h('div.footer-note', { style: { maxWidth: '980px', margin: '0 auto' } }, R.explainer() + ' Click ⓘ on a row for the exact timing, the proposal and dispute status, and the market\'s resolution rules.');

  /** Default view: only questions Meridian users have actually bet on (from the snapshot). With live API access,
   *  `all=1` switches to the server-side explorer over every question on the exchange. */
  async function mountQuestions(body, route, ctx) {
    MD.setTopbar(h('span.title', 'Predict · Questions'));
    const st = { search: route.params.q || '', cat: route.params.cat || '', status: route.params.status || 'open', sort: route.params.sort || 'OPEN_INTEREST', col: { key: route.params.col || 'sw', desc: route.params.dir !== 'asc' } };
    // The default view never waits for the API probe (a refused CORS preflight can take a second); only `all=1` needs it.
    const liveP = P.live();
    if (route.params.all !== '1') return mountQuestionsWithBets(body, route, ctx, st, liveP);
    if (!(await liveP)) return mountQuestionsWithBets(body, route, ctx, st, liveP);
    let cats = []; let counts = null;
    try { [cats, counts] = await Promise.all([P.categories(ctx), P.conditionCounts(ctx)]); } catch (e) { if (isAbort(e)) return; }
    const seenSlug = new Set(); cats = cats.filter((c) => (seenSlug.has(c.slug) ? false : seenSlug.add(c.slug)));
    const wrap = h('div');
    const summary = h('span.dim.small');
    const search = h('input.input', { placeholder: 'Search questions (e.g. Bitcoin, Berlin, Lakers)', value: st.search, style: { maxWidth: '360px' } });
    const debounced = U.debounce(() => { st.search = search.value.trim(); load(); }, 400);
    search.addEventListener('input', debounced);
    const catSel = h('select.input.sm', { style: { width: 'auto' }, onchange: (e) => { st.cat = e.target.value; load(); } }, h('option', { value: '' }, 'All categories'), cats.map((c) => h('option', { value: c.slug, selected: c.slug === st.cat }, c.name + (c.slug.startsWith('prices-') ? ' (prices)' : ''))));
    const controls = h('div.card', h('div.row.wrap', search, catSel,
      UI.seg(STATUS_OPTS, st.status, (v) => { st.status = v; load(); }, 'sm'),
      h('span.dim.small', 'Sort'), UI.seg([{ v: 'OPEN_INTEREST', label: 'Meridian OI' }, { v: 'END_TIME', label: 'Ending soon' }, { v: 'CREATED_AT', label: 'Newest' }], st.sort, (v) => { st.sort = v; load(); }, 'sm'),
      h('span.grow'), summary),
      h('div.row.wrap', { style: { marginTop: '8px' } }, h('span.dim.small', 'Every question on the exchange, including the ones nobody has bet on.'), h('a.small', { href: '#/predict/questions', onclick: (e) => { e.preventDefault(); MD.router.setParams({ all: null, q: null, cat: null, status: null, sort: null }); } }, 'Back to questions with Meridian bets')));
    U.replace(body, controls, h('div.card.tight', wrap), h('div.footer-note', counts ? `${U.fmtNum(counts.all.totalCount, 0)} questions on Meridian Predict · ${U.fmtNum(counts.open.totalCount, 0)} open · ${U.fmtNum(counts.settled.totalCount, 0)} settled. Meridian OI is collateral escrowed on Meridian; source volume is the mirrored market's.` : ''), resFootnote());
    let cursors = [null], page = 1, hasNext = false, rows = [], loading = false, reqId = 0;
    function renderRows() {
      if (st.status === 'ended') rows = byStage(rows);
      U.replace(wrap, UI.table({ cols: [
        { key: 'q', label: 'Question', render: (c) => h('div', { style: { whiteSpace: 'normal', minWidth: '240px', maxWidth: '520px', lineHeight: '1.3' } }, h('div', U.kid(c.question)), h('div.xs.dim', (c.tags || []).slice(0, 4).join(' · '))) },
        { key: 'c', label: 'Category', render: (c) => (c.category ? c.category.name : '—') },
        { key: 'p', label: 'Probability', num: true, title: 'Implied probability from the source market', render: (c) => probBar(c.estimatedPrice) },
        { key: 'oi', label: 'Meridian OI', num: true, render: (c) => { const v = P.usd(c.openInterest); return v ? usd(v, { compact: true }) : h('span.dim', '—'); } },
        { key: 'v24', label: 'Source vol 24h', num: true, render: (c) => (Number(c.similarMarketVolume24h) ? usd(Number(c.similarMarketVolume24h), { compact: true }) : h('span.dim', '—')) },
        { key: 'v7', label: 'Source vol 7d', num: true, render: (c) => (Number(c.similarMarketVolume7d) ? usd(Number(c.similarMarketVolume7d), { compact: true }) : h('span.dim', '—')) },
        ...resCols(rows),
        { key: 'l', label: '', render: (c) => h('div.row', { style: { gap: '4px' } }, sourceLink(c)) },
      ], rows, empty: loading ? 'Loading…' : st.status === 'ended' ? 'Nothing waiting for resolution' : 'No questions match' }),
        UI.cursorPager({ page, hasNext, count: rows.length, loading, onPrev: () => go(page - 1), onNext: () => go(page + 1) }));
    }
    async function go(p) {
      if (p < 1) return; loading = true; renderRows(); const my = ++reqId;
      try {
        // "Ended · unsettled": unsettled questions in end-time order start with the ended ones, so a page is cut off at the first still-running question
        const ended = st.status === 'ended';
        const res = await P.conditions({ search: st.search || undefined, categorySlug: st.cat || undefined, settled: st.status === 'all' ? null : st.status === 'settled', orderBy: ended ? 'END_TIME' : st.sort, dir: ended || st.sort === 'END_TIME' ? 'ASC' : 'DESC', first: PAGE, after: cursors[p - 1], signal: ctx.signal, ttl: 30000 });
        if (my !== reqId) return;
        const now = Date.now() / 1000;
        rows = ended ? res.nodes.filter((c) => c.endTime && c.endTime < now) : res.nodes;
        hasNext = res.pageInfo.hasNextPage && rows.length === res.nodes.length; page = p; if (hasNext && cursors.length === p) cursors.push(res.pageInfo.endCursor);
        U.replace(summary, ended ? `${rows.length} ended, unsettled on this page` : `${U.fmtNum(res.totalCount, 0)} questions`);
      } catch (e) { if (isAbort(e)) return; if (my !== reqId) return; rows = []; U.replace(wrap, UI.error(e, () => go(p))); loading = false; return; }
      loading = false; renderRows();
      trackResolution(rows, ctx, renderRows, () => my === reqId);
    }
    resTicker(ctx, () => { if (!loading) renderRows(); });
    function load() { cursors = [null]; MD.router.setParams({ all: '1', q: st.search || null, cat: st.cat || null, status: st.status !== 'open' ? st.status : null, sort: st.sort !== 'OPEN_INTEREST' ? st.sort : null }, { silent: true }); go(1); }
    load();
  }

  /** Questions people have actually bet on through Meridian (from the snapshot): open interest now, open predictions,
   *  and questions settled in the last 30 days. Rows carry n = predictions ever, b = open predictions, s = open stake. */
  const hasBets = (q) => q.oi > 0 || q.b > 0 || q.n > 0 || q.n == null;   // n == null: snapshot older than this field
  const betsNote = (c) => { const parts = []; if (c.b) parts.push(`${c.b} open bet${c.b > 1 ? 's' : ''}${c.s ? ' · ' + usd(c.s, { compact: true }) + ' staked' : ''}`); if (c.u) parts.push(`${c.u} decided, unclaimed`); return parts.length ? parts.join(' · ') : null; };
  async function mountQuestionsWithBets(body, route, ctx, st, liveP) {
    await withSnapshot(body, ctx, (snap) => {
      let live = false;
      const all = (snap.questionsWithOi || []).filter(hasBets);
      const cats = Array.from(new Map(all.filter((q) => q.slug).map((q) => [q.slug, q.cat])).entries()).sort((a, b) => a[1].localeCompare(b[1]));
      let page = 1; const wrap = h('div'); const summary = h('span.dim.small');
      const search = h('input.input', { placeholder: 'Search questions with Meridian bets', value: st.search, style: { maxWidth: '360px' }, oninput: U.debounce((e) => { st.search = e.target.value.trim().toLowerCase(); page = 1; render(); }, 250) });
      const now = Date.now();
      const exposure = (q) => !q.settled && (q.oi > 0 || q.b > 0 || q.b == null);   // money still riding on it (undecided)
      // ended but unsettled questions whose source market already resolved with nobody on the winning side are noise:
      // only the makers are waiting for the settlement. Their resolution state is loaded once so they can be dropped.
      const alive = (q) => !R.questionDead(q);
      // the ended questions plus every leg of the open predictions on them: a combo's fate depends on all its legs
      const endedQs = all.filter((q) => exposure(q) && q.end && q.end < now);
      const endedIds = Array.from(new Set(endedQs.flatMap((q) => [qId(q)].concat(R.legIds(q)))));
      const endedCountOf = () => all.filter((q) => exposure(q) && q.end && q.end < now && alive(q)).length;
      const endedCount = endedCountOf();
      if (!['open', 'ended', 'settled', 'all'].includes(st.status)) st.status = 'open';
      const controls = h('div.card', h('div.row.wrap', search,
        h('select.input.sm', { style: { width: 'auto' }, onchange: (e) => { st.cat = e.target.value; page = 1; render(); } }, h('option', { value: '' }, 'All categories'), cats.map(([slug, name]) => h('option', { value: slug, selected: slug === st.cat }, name + (slug.startsWith('prices-') ? ' (prices)' : '')))),
        h('span.status-seg', UI.seg(STATUS_OPTS.map((o) => (o.v === 'ended' ? Object.assign({}, o, { label: o.label + (endedCount ? ' (' + endedCount + ')' : '') }) : o)), st.status, (v) => { st.status = v; page = 1; headerSorted = false; render(); renderBacklog(); }, 'sm')),
        h('span.grow'), summary));
      // header sorting like the leaderboard; the Ended tab keeps its pipeline order unless a header is chosen
      const SORTS = { q: (q) => (q.q || '').toLowerCase(), c: (q) => (q.cat || '').toLowerCase(), p: (q) => (q.ep == null ? -1 : q.ep), sw: (q) => (q.sw || 0) * 1e9 + (q.s || 0), oi: (q) => (q.oi || 0) * 1e9 + (q.s || 0), b: (q) => (q.b || 0) * 1e9 + (q.s || 0), v7: (q) => q.v7 || 0, end: (q) => q.end || Infinity, l: (q) => q.l || 0 };
      let headerSorted = false;
      const onSort = (k) => { if (!SORTS[k]) return; if (st.col.key === k) st.col.desc = !st.col.desc; else st.col = { key: k, desc: !['q', 'c', 'end'].includes(k) }; headerSorted = true; page = 1; MD.router.setParams({ col: st.col.key === 'sw' ? null : st.col.key, dir: st.col.desc ? null : 'asc' }, { silent: true }); render(); };
      // the link to the full explorer appears once the API probe says this origin may query the exchange directly
      Promise.resolve(liveP).then((ok) => { live = !!ok; if (!live || ctx.signal.aborted) return; controls.appendChild(h('div.row.wrap', { style: { marginTop: '8px' } }, h('span.dim.small', 'Only questions with Meridian bets are listed.'), h('a.small', { href: '#/predict/questions?all=1', onclick: (e) => { e.preventDefault(); MD.router.setParams({ all: '1', q: st.search || null, cat: st.cat || null }); } }, 'Search all ' + (snap.questions ? U.fmtCompact(snap.questions.all, 0) + ' ' : '') + 'questions on the exchange'))); }).catch(() => {});
      const refreshEndedLabel = () => { const n = endedCountOf(); const btn = Array.from(controls.querySelectorAll('.status-seg button')).find((x) => x.textContent.startsWith('Ended')); if (btn) btn.textContent = 'Ended · unsettled' + (n ? ' (' + n + ')' : ''); };
      const backlog = h('div');
      const renderBacklog = () => {
        if (st.status !== 'ended') { U.clear(backlog); return; }
        const stuck = all.filter((q) => exposure(q) && alive(q) && R.state(q, qId(q)).stuck);
        if (!stuck.length) { U.clear(backlog); return; }
        // predictions, not questions: a combo touching several stuck questions is one payout
        const preds = new Map(); let oldest = 0;
        for (const q of stuck) for (const p of q.op || []) { const ps = R.predictionState(p.k); if (ps.code !== 'won') continue; const d = Math.floor((Date.now() - ps.at) / 86400000); if (d < R.STUCK_DAYS) continue; preds.set(p.id, p.s || 0); if (d > oldest) oldest = d; }
        const waiting = Array.from(preds.values()).reduce((a, x) => a + x, 0);
        // why: Meridian learns a result only when a relay transaction on Polygon sends it over LayerZero; the settlement
        // bot sends one for every listed question and skips unlisted ones (isPublic false)
        const unlisted = stuck.filter((q) => q.pub === false).length;
        const why = !unlisted ? '' : ` ${unlisted === stuck.length ? (stuck.length > 1 ? 'All of these questions are' : 'The question is') : unlisted + ' of these questions are'} unlisted on Meridian. Meridian learns a result only when a relay transaction on Polygon sends it over, and its settlement bot does not send one for unlisted questions. A single relay per question (by Meridian or anyone, about 3 POL in fees) would make the payout claimable.`;
        U.replace(backlog, h('div.card', { style: { borderColor: 'var(--amber)', padding: '10px 14px' } }, h('div.row.wrap', { style: { gap: '8px', alignItems: 'baseline' } }, UI.chip('unresolved on Meridian', 'amber'),
          h('span.small', `${preds.size} prediction${preds.size > 1 ? 's' : ''} whose legs have all resolved in the bettor's favour on Polymarket, the last one more than ${R.STUCK_DAYS} days ago (oldest ${oldest} days), cannot be claimed because Meridian has not settled the question yet: ${usd(waiting)} of stakes across ${stuck.length} question${stuck.length > 1 ? 's' : ''}.${why} (Decided predictions that simply have not been claimed are a different matter and are not listed here.) The questions are listed first; click one to see the predictions and their legs.`))));
      };
      let renderSeq = 0, endedPreloaded = false; const tracked = new Set();
      if (endedIds.length) R.load(endedIds, { signal: ctx.signal, deep: false }).then(() => { if (ctx.signal.aborted) return; endedPreloaded = true; refreshEndedLabel(); render(true); renderBacklog(); }).catch(() => {});
      function render(keepTracking) {
        let rows = all.filter(alive); const t = Date.now();
        if (st.search) { const s = st.search.toLowerCase(); rows = rows.filter((q) => (q.q + ' ' + (q.tags || []).join(' ')).toLowerCase().includes(s)); }   // a linked ?q= keeps its case
        if (st.cat) rows = rows.filter((q) => q.slug === st.cat);
        if (st.status === 'open') rows = rows.filter(exposure);
        else if (st.status === 'settled') rows = rows.filter((q) => q.settled);
        else if (st.status === 'ended') rows = rows.filter((q) => exposure(q) && q.end && q.end < t);
        rows = st.status === 'ended' && !headerSorted ? byStage(rows) : U.sortBy(rows, SORTS[st.col.key] || SORTS.sw, st.col.desc);
        const total = rows.length; const pages = Math.max(1, Math.ceil(total / PAGE)); if (page > pages) page = pages;
        const slice = rows.slice((page - 1) * PAGE, page * PAGE);
        U.replace(wrap, UI.table({ sort: st.status === 'ended' && !headerSorted ? null : st.col, onSort, cols: [
          { key: 'q', label: 'Question', sortVal: 1, render: (c) => h('div', { style: { whiteSpace: 'normal', minWidth: '240px', maxWidth: '520px', lineHeight: '1.3' } }, h('div', U.kid(c.q)), h('div.xs.dim', (c.tags || []).slice(0, 4).join(' · '))) },
          { key: 'c', label: 'Category', sortVal: 1, render: (c) => c.cat || '—' },
          { key: 'p', label: 'Probability', num: true, sortVal: 1, render: (c) => probBar(c.ep) },
          { key: 'sw', label: 'Staked on Meridian', num: true, sortVal: 1, title: 'Bettor stakes ever placed on this question · predictions', render: (c) => h('div', { style: { lineHeight: '1.25' } }, c.sw ? usd(c.sw, { compact: true }) : h('span.dim', '$0'), c.n ? h('div.xs.dim', { style: { whiteSpace: 'nowrap' } }, `${c.n} prediction${c.n > 1 ? 's' : ''}${c.l ? ' · last ' + U.fmtAgo(c.l) : ''}`) : null) },
          { key: 'oi', label: 'Meridian OI', num: true, sortVal: 1, title: 'Collateral escrowed on Meridian right now · open predictions and their bettor stakes', render: (c) => h('div', { style: { lineHeight: '1.25' } }, c.oi ? usd(c.oi, { compact: true }) : h('span.dim', '$0'), betsNote(c) ? h('div.xs.dim', { style: { whiteSpace: 'normal', maxWidth: '200px', marginLeft: 'auto' } }, betsNote(c)) : null) },
          { key: 'v7', label: 'Source vol 7d', num: true, sortVal: 1, title: 'Volume on the mirrored Polymarket market, last 7 days', render: (c) => (c.v7 ? usd(c.v7, { compact: true }) : h('span.dim', '—')) },
          ...resCols(slice),
          { key: 'l', label: '', render: (c) => (webUrl(c.src) ? srcBtn(c.src) : '') },
        ], rows: slice, empty: st.status === 'ended' ? 'Nothing waiting for resolution' : 'No questions match', onRow: (c) => openQuestion(c, ctx) }), UI.pager({ page, pageSize: PAGE, total, onPage: (p) => { page = p; render(); wrap.scrollIntoView({ block: 'start' }); } }));
        U.replace(summary, st.status === 'ended' ? `${U.fmtNum(total, 0)} ended, not settled yet` : `${U.fmtNum(total, 0)} questions with Meridian bets`);
        // rows that move onto the page once their state is known (the Ended tab re-sorts by stage) need their oracle and
        // price checks too, not only the ones visible on the first render
        if (!keepTracking || slice.some((q) => !tracked.has(qId(q)))) { slice.forEach((q) => tracked.add(qId(q))); const my = ++renderSeq; trackResolution(slice, ctx, () => render(true), () => my === renderSeq); }
      }
      U.replace(body, controls, backlog, h('div.card.tight', wrap), h('div.footer-note', 'Only questions people have bet on through Meridian: open interest now, open predictions, and questions settled in the last 30 days, as of the snapshot ' + U.fmtAgo(snap.builtAt) + (snap.questions ? ` (the exchange lists ${U.fmtNum(snap.questions.all, 0)} questions in total)` : '') + '.' + ' Searching every question on the exchange needs live API access (the Predict API only allows Meridian\'s own origins).'), resFootnote());
      render();
      resTicker(ctx, () => render(true));
    });
  }

  // =====================================================================
  // Market makers
  // =====================================================================
  async function mountMakers(body, route, ctx) {
    MD.setTopbar(h('span.title', 'Predict · Market makers'));
    await withSnapshot(body, ctx, (snap) => {
      const a = snap.agg; const T = a.totals; const cv = h('canvas'); const MK = P.splitMakers(a.makers);
      // every counterparty, one-off ones included (the bettors' net mirrors them all); bettors' net differs by what
      // secondary-market traders took
      const makerPnl = U.sum(a.makers, (m) => m.pnl || 0);
      const oneOffNote = MK.oneOff.length ? h('div.footer-note', { style: { textAlign: 'left', padding: '10px 14px' } },
        `Not market makers: ${MK.oneOff.length === 1 ? 'a wallet that' : MK.oneOff.length + ' wallets that'} took the other side of fewer than ${P.MAKER_MIN} predictions (a one-off or a test, not a market): `,
        ...MK.oneOff.flatMap((m, i) => [i ? ', ' : '', bettorLink(m.address, 4), ` (${U.fmtNum(m.n, 0)} prediction${m.n === 1 ? '' : 's'}, ${usd(m.wagered)}, ${usd(m.pnl || 0, { sign: true })})`]),
        '. Their results count in the Maker PnL total.') : null;
      const tbl = UI.table({ cols: [
        { key: 'a', label: 'Market maker', render: (r) => h('div.row', { style: { gap: '6px' } }, bettorLink(r.address, 6), U.copyBtn(r.address)) },
        { key: 'n', label: 'Predictions taken', num: true, render: (r) => U.fmtNum(r.n, 0) },
        { key: 's', label: 'Share of flow', num: true, render: (r) => U.fmtPct((r.n / T.n) * 100, { dp: 1 }) },
        { key: 'c', label: 'Collateral committed', num: true, title: 'Sum of collateral put up against bettors', render: (r) => usd(r.wagered, { compact: true }) },
        { key: 'o', label: 'Open exposure', num: true, render: (r) => usd(r.openWagered, { compact: true }) },
        { key: 'p', label: 'Maker PnL', num: true, title: 'Decided predictions, claimed or not: + the bettor\'s stake on wins, − own collateral on losses, plus secondary-market trades', render: (r) => pnlEl(r.pnl) },
        { key: 'wr', label: 'Maker win rate', num: true, render: (r) => (r.winRate == null ? '—' : U.fmtPct(r.winRate, { dp: 0 })) },
        { key: 'v', label: 'Avg vig captured', num: true, title: 'Bettor odds minus the Polymarket price at the moment of the bet', render: (r) => vigCell(r.avgVig) },
        { key: 'ao', label: 'Avg bettor odds', num: true, render: (r) => pct(r.avgOdds, 0) },
        { key: 'cat', label: 'Top category', render: (r) => r.topCat || '—' },
        { key: 'f', label: 'Active', render: (r) => h('span.dim', U.fmtDate(r.first) + ' → ' + U.fmtAgo(r.last)) },
      ], rows: MK.makers, onRow: (r) => { location.hash = bettorUrl(r.address).slice(1); } });
      U.replace(body,
        h('div.card', h('h2', { style: { marginBottom: '6px' } }, 'Who takes the other side'), h('p.muted', { style: { margin: 0, maxWidth: '860px' } }, 'Every Meridian prediction is an RFQ auction: the bettor broadcasts a stake, market makers compete to take the other side, and the winning quote locks the odds. The counterparty address is public on every prediction, so this page shows exactly who is making the market, how much they commit, and how it has gone for them.'), h('div.dim.small', { style: { marginTop: '8px' } }, snapNote(snap))),
        h('div.stats', UI.stat('Market makers', String(MK.makers.length), MK.oneOff.length ? `+ ${MK.oneOff.length} one-off counterpart${MK.oneOff.length === 1 ? 'y' : 'ies'}` : null), UI.stat('Maker collateral', usd(T.cpCommitted, { compact: true }), 'committed since launch'), UI.stat('Maker PnL', usd(makerPnl, { sign: true }), 'decided predictions, claimed or not' + (a.secondary && Math.abs(a.secondary.toOthers) >= 1 ? ' · ' + usd(a.secondary.toOthers, { sign: true, compact: true }) + ' went to secondary-market traders' : ''), U.pnlClass(makerPnl)), UI.stat('Maker win rate', T.winRate == null ? '—' : U.fmtPct(100 - T.winRate, { dp: 1 })), UI.stat('Avg vig captured', pp(a.vig.overall.avg)), UI.stat('Stake-weighted vig', pp(a.vig.weighted))),
        h('div.card.tight', tbl, oneOffNote),
        h('div.card', h('h3', { style: { marginBottom: '10px' } }, 'Maker PnL'), h('div.chart-box.sm', cv)));
      C.bars(cv, MK.makers.map((m) => U.shortAddr(m.address)), MK.makers.map((m) => m.pnl), { horizontal: true });
    });
  }

  // =====================================================================
  // Vig & edge
  // =====================================================================
  async function mountVig(body, route, ctx) {
    MD.setTopbar(h('span.title', 'Predict · Vig & edge'));
    await withSnapshot(body, ctx, (snap) => {
      const v = snap.agg.vig; const cv = h('canvas'); const cov = v.coverage || null;
      if (!cov || !cov.withAtBet) { U.replace(body, h('div.card', h('div.empty', 'No source prices at bet time in this snapshot yet. The snapshot builder fetches them from Polymarket\'s price history; the next published snapshot will have them.'))); return; }
      const sumTbl = (rows, labelKey, labelFn) => UI.table({ cols: [
        { key: 'k', label: labelKey, render: labelFn },
        { key: 'n', label: 'Predictions', num: true, render: (r) => U.fmtNum(r.n, 0) },
        { key: 'avg', label: 'Avg vig', num: true, render: (r) => vigCell(r.avg) },
        { key: 'med', label: 'Median vig', num: true, render: (r) => vigCell(r.median) },
        { key: 'sh', label: 'Above fair', num: true, title: 'Share of predictions where the bettor paid more than the source probability', render: (r) => (r.share == null ? '—' : U.fmtPct(r.share * 100, { dp: 0 })) },
      ], rows });
      // ---- ex-post: locked odds vs what actually happened, on settled bets ----
      const roiCell = (r) => (r.roi == null ? h('span.dim', '—') : h('span', { class: U.pnlClass(r.roi) }, U.fmtPct(r.roi * 100, { sign: true, dp: 1 })));
      const hitCell = (r) => (r.hit == null ? h('span.dim', '—') : h('span', U.fmtPct(r.hit * 100, { dp: 1 }), h('span.dim.xs', ' ±' + U.fmtNum(r.ci * 100, 1))));
      const gapCell = (r) => (r.gap == null ? h('span.dim', '—') : h('span', { class: Math.abs(r.gap) > (r.ci || 0) ? (r.gap > 0 ? 'neg' : 'pos') : 'dim', title: Math.abs(r.gap) > (r.ci || 0) ? 'Outside the 95% interval' : 'Within the 95% interval: could be luck' }, pp(r.gap)));
      const realTbl = (rows, labelKey, labelFn) => UI.table({ cols: [
        { key: 'k', label: labelKey, render: labelFn },
        { key: 'n', label: 'Decided', num: true, render: (r) => U.fmtNum(r.n, 0) },
        { key: 'imp', label: 'Implied', num: true, title: 'Average locked odds = the win probability the bettors paid for', render: (r) => (r.implied == null ? '—' : U.fmtPct(r.implied * 100, { dp: 1 })) },
        { key: 'hit', label: 'Realized', num: true, title: 'Share actually won, with the 95% interval', render: hitCell },
        { key: 'gap', label: 'Implied − realized', num: true, title: 'Positive = bettors won less often than they paid for', render: gapCell },
        { key: 'roi', label: 'Bettor ROI', num: true, title: 'Net result ÷ stake on these bets; the mirror image is the maker\'s realized take', render: roiCell },
      ], rows });
      const bucketLabel = (b) => pct(b.from, 0) + '–' + pct(b.to, 0);
      // plain-language card for bettors, written from the numbers so it stays true as the snapshot changes
      const bettorNote = (r) => {
        if (!r || !r.overall.n) return null;
        const o = r.overall; const roiTxt = (x) => U.fmtPct(x * 100, { sign: true, dp: 0 });
        // contiguous odds buckets with enough bets and a clearly negative / positive money result
        const runs = (pred) => { const out = []; for (const b of r.byOddsBucket) { if (b.n >= 100 && pred(b)) { const last = out[out.length - 1]; if (last && last.to === b.from) { last.to = b.to; last.stake += b.stake; last.pnl += b.pnl; } else out.push({ from: b.from, to: b.to, stake: b.stake, pnl: b.pnl }); } } return out.map((x) => Object.assign(x, { roi: x.pnl / x.stake })); };
        const bad = runs((b) => b.roi < -0.1), good = runs((b) => b.roi > 0.05);
        const types = [['singles', r.singles], ['combos across different events', r.combosOnly], ['combos on one event', r.combosSameEvent]].filter(([, x]) => x.n >= 100);
        const pos = types.filter(([, x]) => x.roi > 0), neg = types.filter(([, x]) => x.roi < 0);
        const list = (arr, f) => arr.map(f).join(arr.length > 2 ? ', ' : ' and ');
        const li = (t, ...c) => h('li', { style: { margin: '0 0 6px' } }, h('b', { style: { color: 'var(--text-1)' } }, t + ' '), ...c);
        return h('div.card', { style: { borderColor: 'var(--accent)' } }, h('h3', { style: { marginBottom: '8px' } }, 'How to read this if you bet'),
          h('ul.muted', { style: { margin: 0, paddingLeft: '18px', maxWidth: '900px' } },
            li('Two prices.', `The quoted cost (top of the page) is how far your odds sit from Polymarket's price at that moment, about ${pp(v.overall.avg)} on a typical bet. The realized cost (bottom) is what decided bets have actually returned, claimed or not: ${roiTxt(o.roi)} of stakes across every bettor so far. The second one is what a balance feels.`),
            bad.length || good.length ? li('Where the money goes.', bad.length ? `Bets at ${list(bad, bucketLabel)} odds have returned ${list(bad, (x) => roiTxt(x.roi))} of stakes: long shots pay out far less often than their odds say. ` : '', good.length ? `Bets at ${list(good, bucketLabel)} odds have returned ${list(good, (x) => roiTxt(x.roi))}.` : '') : null,
            types.length ? li('Bet type.', pos.length ? `${U.capitalize(list(pos, ([k, x]) => k + ' (' + roiTxt(x.roi) + ')'))} have been net positive for bettors so far` : '', pos.length && neg.length ? '; ' : '', neg.length ? `${pos.length ? '' : ''}${pos.length ? list(neg, ([k, x]) => k + ' (' + roiTxt(x.roi) + ')') : U.capitalize(list(neg, ([k, x]) => k + ' (' + roiTxt(x.roi) + ')'))} ${pos.length ? 'net negative' : 'have been net negative for bettors so far'}` : '', '. Adding a leg from another event is where the maker\'s margin compounds; legs on the same event are priced with their correlation.') : null,
            li('Read it right.', 'Look at Bettor ROI, not the hit-rate gap: a one-point shortfall at 3% odds is a third of the stake, at 60% it is nothing. A gap inside the ± could be luck. Results count from the exchange\x27s verdict, so unclaimed wins and losses are in. These are past results across all bettors, not a forecast and not advice; small buckets swing.')));
      };
      const realizedSection = (r) => {
        if (!r || !r.overall.n) return null;
        const o = r.overall; const cr = h('canvas');
        const buckets = r.byOddsBucket.filter((b) => b.n >= 30);
        // combos with a leg whose Polymarket event is unknown (a handful at most) stay in the overall figures, not as a row
        const splits = [{ k: 'Singles', ...r.singles }, { k: 'Combos · different events', ...r.combosOnly }, { k: 'Combos · same event', ...r.combosSameEvent }];
        const node = h('div.stack', { style: { marginTop: '8px' } },
          h('div.card', h('h2', { style: { marginBottom: '6px' } }, 'Quote-implied vs realized'), h('p.muted', { style: { margin: '0 0 6px', maxWidth: '900px' } }, 'The other way to measure the edge, needing no source price at all: on decided bets (the exchange\x27s verdict is in, claimed or not), the odds the bettors locked are the win probability they paid for; compare that with how often they actually won. Outcomes carry the real correlation between legs and any skill the bettors have, so this is the maker\'s realized edge rather than a quoted one. It costs waiting for the verdict and some luck: the ± is a 95% interval on the hit rate, and a gap inside it may be chance.'), h('p.muted.small', { style: { margin: 0 } }, 'Money matters more than counts here: a bet at 3% odds that hits 2% of the time loses a third of its stakes on average, while the same one-point gap at 60% odds is nothing. Bettor ROI is net result ÷ stake and is the number to read; the maker\'s take is its mirror image.')),
          h('div.stats', UI.stat('Decided bets', U.fmtNum(o.n, 0), U.fmtUsd(o.stake, { compact: true }) + ' staked · claimed or not'), UI.stat('Implied win rate', U.fmtPct(o.implied * 100, { dp: 1 }), 'avg locked odds'), UI.stat('Realized win rate', U.fmtPct(o.hit * 100, { dp: 1 }), '± ' + U.fmtNum(o.ci * 100, 1) + ' pp (95%)'), UI.stat('Bettor ROI', U.fmtPct(o.roi * 100, { sign: true, dp: 1 }), 'net result ÷ stake', U.pnlClass(o.roi)), UI.stat('Maker take', U.fmtPct(-o.roi * 100, { sign: true, dp: 1 }), 'of stakes, realized', U.pnlClass(-o.roi))),
          h('div.grid.cols-2', h('div.card', h('h3', { style: { marginBottom: '10px' } }, 'Implied vs realized by locked odds'), h('div.chart-box.sm', cr)), UI.card('By bet type', realTbl(splits, 'Type', (x) => x.k))),
          h('div.grid.cols-2', UI.card('By locked odds', realTbl(r.byOddsBucket.filter((b) => b.n), 'Bettor odds', bucketLabel)), UI.card('By category', realTbl(r.byCat.filter((c) => c.n >= 20), 'Category', (x) => x.cat))));
        requestAnimationFrame(() => C.pairedBars(cr, buckets.map(bucketLabel), buckets.map((b) => b.implied * 100), buckets.map((b) => b.hit * 100), { aLabel: 'Implied (locked odds)', bLabel: 'Realized (won)', max: 100 }));
        return node;
      };
      U.replace(body,
        h('div.card', h('h2', { style: { marginBottom: '6px' } }, 'What the auction costs'), h('p.muted', { style: { margin: '0 0 6px', maxWidth: '900px' } }, 'Every prediction locks odds = stake ÷ (stake + maker collateral). The fair price is what the mirrored Polymarket market showed at the moment the bet was placed, taken from Polymarket\'s own price history (1- to 15-minute samples, the last one at or before the bet). The difference is the vig: how much worse than the source the bettor\'s price was. Positive = bettor paid above fair, which is the market maker\'s margin.'), h('p.muted.small', { style: { margin: 0 } }, 'For combos the fair price is the product of the legs\' prices at bet time, which assumes the legs are independent. Legs on the same Polymarket event (one match, one asset at several strikes) are correlated, so for those the product understates fair and the gap includes what the maker charges for correlation, not only margin. They are shown separately and kept out of the headline figures' + (cov ? `. Included: ${U.fmtNum(cov.clean != null ? cov.clean : cov.withAtBet, 0)} of ${U.fmtNum(cov.total, 0)} predictions (${U.fmtNum(cov.total - cov.withAtBet, 0)} without Polymarket history${cov.sameEvent ? `, ${U.fmtNum(cov.sameEvent, 0)} same-event combos` : ''})` : '') + '.'), h('div.dim.small', { style: { marginTop: '8px' } }, snapNote(snap))),
        bettorNote(v.realized),
        h('div.stats', UI.stat('Avg vig', pp(v.overall.avg), 'odds vs source price at bet time'), UI.stat('Stake-weighted', pp(v.weighted), 'big bets count more'), UI.stat('Median', pp(v.overall.median)), UI.stat('Above fair', v.overall.share == null ? '—' : U.fmtPct(v.overall.share * 100, { dp: 0 }), 'of predictions'), UI.stat('Singles', pp(v.singles.avg), U.fmtNum(v.singles.n, 0) + ' predictions'), UI.stat('Combos · different events', pp(v.combosOnly.avg), U.fmtNum(v.combosOnly.n, 0) + ' predictions'), v.combosSameEvent && v.combosSameEvent.n ? UI.stat('Combos · same event', pp(v.combosSameEvent.avg), U.fmtNum(v.combosSameEvent.n, 0) + ' predictions · includes correlation pricing, not in the headline') : null),
        h('div.card', h('h3', { style: { marginBottom: '10px' } }, 'Average vig per week'), h('div.chart-box.sm', cv)),
        h('div.grid.cols-2', UI.card('By category', sumTbl(v.byCat, 'Category', (r) => r.cat)), UI.card('By odds', sumTbl(v.byOddsBucket.filter((b) => b.n), 'Bettor odds', (r) => pct(r.from, 0) + ' – ' + pct(r.to, 0)))),
        h('div.footer-note', 'A negative vig means the bettor locked better odds than Polymarket showed at that moment, which happens when makers compete hard on a question or the source printed a stale price. Polymarket samples are the last trade or midpoint in the bucket, so single values carry a little noise; averages are the meaningful part.'),
        realizedSection(v.realized));
      const col = C.colors();
      C.timeSeries(cv, { points: v.weekly.map((w) => ({ x: w.t, y: (w.avg || 0) * 100 })), color: col.amber, label: 'Avg vig', yFmt: (x) => x.toFixed(1) + ' pp', tipFmt: (x) => x.toFixed(2) + ' pp', zero: true });
    });
  }

  // =====================================================================
  // Bettor page (also used as the Predict tab on the perps account page)
  // =====================================================================
  async function mountBettorPage(body, route, ctx) {
    const addr = String(route.params.address || '').toLowerCase();
    // a Predict wallet is a smart account; the perps account belongs to its owner (js/predict/wallets.js)
    const perpsBtn = h('a.btn.sm.ghost', { href: U.accountUrl(addr), title: 'Perps account' }, U.icon('account'), 'Perps');
    if (U.isAddress(addr)) P.wallets.ownerOf(addr).then((o) => { if (o) { perpsBtn.href = U.accountUrl(o); perpsBtn.title = 'Perps account of the owner ' + o; } }).catch(() => {});
    const head = h('div.acct-head', h('span.addr-box', h('span', { title: addr }, U.shortAddr(addr, 6)), U.copyBtn(addr)), perpsBtn, h('button.btn.sm.ghost', { title: 'Copy a share link: Discord, X, Telegram and the like show this wallet\'s card with its result', onclick: () => { U.copyText(MD.api.shareUrl('p', addr)); U.toast('Share link copied · it shows a preview card'); } }, U.icon('copy'), 'Share'), h('a.btn.sm.ghost', { href: U.explorerAddr(addr), target: '_blank', rel: 'noopener' }, U.icon('external'), 'Explorer'));
    // phones: the header goes into the page (the topbar cannot fit it); same arrangement as the perps account page
    const headSlot = h('div.acct-head-slot'); if (body.parentElement) body.parentElement.prepend(headSlot); else body.prepend(headSlot);
    const narrow = window.matchMedia('(max-width: 720px)');
    const placeHead = () => { if (narrow.matches) { headSlot.appendChild(head); MD.setTopbar(h('span.title', 'Predict · Bettor')); } else { MD.setTopbar(head); } };
    placeHead(); narrow.addEventListener('change', placeHead); window.addEventListener('resize', placeHead); ctx.onCleanup(() => { narrow.removeEventListener('change', placeHead); window.removeEventListener('resize', placeHead); });
    if (!U.isAddress(addr)) { U.replace(body, h('div.card', h('div.error', 'Invalid address'))); return; }
    await P.renderBettor(body, addr, ctx);
  }
  /** Bettor model from live queries, or from the per-wallet snapshot file when the API refuses this origin. */
  async function loadBettor(addr, ctx) {
    const live = await P.live();
    if (live) {
      const [acct, raw, openPos, tf] = await Promise.all([
        P.account(addr, { interval: 'DAY', fromSec: P.LAUNCH_SEC, signal: ctx.signal, ttl: 60000 }),
        P.predictionsOf(addr, { maxPages: 12, signal: ctx.signal }),
        P.positionsOf(addr, { settled: false, signal: ctx.signal }).catch(() => ({ nodes: [], totalCount: 0 })),
        P.snapshotFile('bettors/' + addr + '.json', { signal: ctx.signal }).catch(() => null),   // the wallet's secondary-market trades, tied to their predictions by the snapshot builder
      ]);
      const norms = raw.map(P.norm).filter((n) => (n.predictor === addr || n.counterparty === addr) && !P.selfMatch(n));   // a bet against itself moves no money
      // decided-but-unclaimed positions are not open; a position whose tokens were all sold is not this wallet's any more
      const undecided = (openPos.nodes || []).filter((p) => !(p.pickConfig && p.pickConfig.resolved) && P.usd(p.balance) > 1e-9);
      const posRows = undecided.map((p) => { const stake = P.usd(p.userCollateral), payout = P.usd(p.totalPayout); const picks = ((p.pickConfig && p.pickConfig.picks) || []).map((k) => ({ id: k.conditionId || null, q: k.condition ? k.condition.question : k.conditionId, yes: String(k.predictedOutcome).toUpperCase() === 'YES', ep: k.condition ? k.condition.estimatedPrice : null, endTime: k.condition && k.condition.endTime ? k.condition.endTime * 1000 : null, settled: !!(k.condition && k.condition.settled), resolvedToYes: k.condition ? k.condition.resolvedToYes : null })); let fair = null; if (picks.length && picks.every((k) => k.ep != null)) { fair = 1; for (const k of picks) fair *= k.yes ? k.ep : 1 - k.ep; } return { id: (p.prediction && p.prediction.predictionId) || null, side: p.side, stake, payout, odds: payout > 0 ? stake / payout : null, picks, fair, t: P.ms(p.createdAt), ends: picks.reduce((m, k) => (k.endTime && (!m || k.endTime > m) ? k.endTime : m), null) }; });
      return { live: true, norms, truncated: !!raw.truncated, hist: acct.history, totalVolume: acct.totalVolume, balance: acct.balance, posRows, openCount: undecided.length, builtAt: Date.now(), trades: (tf && tf.trades) || [] };
    }
    const f = await P.snapshotFile('bettors/' + addr + '.json', { signal: ctx.signal });
    if (!f) return null;
    const norms = f.predictions.map(P.unslim).filter((n) => !P.selfMatch(n));
    const asMaker = norms.filter((n) => n.counterparty === addr).length > norms.filter((n) => n.predictor === addr).length;
    const mine = norms.filter((n) => (asMaker ? n.counterparty : n.predictor) === addr);
    const open = mine.filter((n) => !n.decided);
    const posRows = open.map((n) => ({ id: n.id, side: asMaker ? 'COUNTERPARTY' : 'PREDICTOR', stake: asMaker ? n.cp : n.stake, payout: n.pool, odds: asMaker ? (n.pool ? n.cp / n.pool : null) : n.odds, picks: n.picks.map((k) => ({ id: k.id, q: k.q, yes: k.yes, ep: k.ep, endTime: k.endTime, settled: false, resolvedToYes: null })), fair: asMaker ? (n.fair == null ? null : 1 - n.fair) : n.fair, t: n.t, ends: n.picks.reduce((m, k) => (k.endTime && (!m || k.endTime > m) ? k.endTime : m), null) }));
    return { live: false, norms, truncated: !!f.truncated, hist: P.historyFromPredictions(mine, addr, asMaker), totalVolume: U.sum(mine, (n) => (asMaker ? n.cp : n.stake)), balance: null, posRows, openCount: open.length, builtAt: f.builtAt, trades: f.trades || [] };
  }
  P.loadBettor = loadBettor;
  /** A wallet's role, token ledger and headline figures, exactly as its bettor page shows them, from loadBettor's model;
   *  null when there is nothing under the address. { asBettor, asMaker, isMaker, mine, L, agg, F } */
  async function headline(addr, m, signal) {
    const { norms, hist } = m;
    const asBettor = norms.filter((n) => n.predictor === addr), asMaker = norms.filter((n) => n.counterparty === addr);
    const isMaker = asMaker.length > asBettor.length;
    const mine = isMaker ? asMaker : asBettor;
    // the secondary market: PnL follows the position tokens, so a sold prediction's result is no longer (all) this wallet's
    const L = P.ledger(norms, m.trades || [], addr);
    if (!mine.length && !hist.some((x) => x.total) && !L.trades.length) return null;
    // The headline figures count from the verdict (claimed or not). The exchange's own history counts only claimed
    // predictions, so the decided-but-unclaimed ones come from the predictions loaded here, which is exact while they are
    // all loaded (up to 300 live, 600 in a snapshot file). A larger account (every market maker, heavy bettors) would
    // count only the unclaimed ones inside that window, so its figures come from the published snapshot's aggregate for
    // this wallet instead, which covers every prediction as of its build.
    const agg = m.truncated ? await (async () => { try { const snap = await P.loadSnapshot({ signal }); if (!snap || !snap.remote || !snap.agg) return null; const row = (isMaker ? snap.agg.makers : snap.agg.bettors).find((r) => r.address === addr); return row ? Object.assign({ at: snap.builtAt }, row) : null; } catch (e) { return null; } })() : null;
    // Checked against the exchange: its account history books PnL at the verdict (its cumulative PnL equals the sum of
    // every decided prediction's result, claimed or not), while its won / lost counts move only when a prediction is
    // claimed. So live, the PnL is the exchange's as it stands and only the counts need the unclaimed ones added; the
    // snapshot fallback rebuilds its history from claims, so there the unclaimed results are added to the PnL too.
    const totals = hist.reduce((a, x) => { a.won += x.won; a.lost += x.lost; a.pending += x.pending; a.nd += x.nonDecisive; a.pnl += x.pnl; return a; }, { won: 0, lost: 0, pending: 0, nd: 0, pnl: 0 });
    const F = agg
      ? { pnl: m.live ? totals.pnl : agg.pnl, pnlNote: m.live ? 'decided, claimed or not · exchange stats' : `decided, claimed or not · as of the snapshot ${U.fmtAgo(agg.at)}`, won: agg.won, lost: agg.lost, nd: agg.nd || 0, open: agg.open, unclaimedWon: agg.unclaimedWon, unclaimedPayout: agg.unclaimedPayout, roi: agg.roi, roiNote: 'on decided stakes · all predictions', avgOdds: agg.avgOdds, avgLegs: agg.avgLegs, fromSnap: true }
      : Object.assign(P.bettorFigures({ mine, hist, isMaker, live: m.live, ledger: L }), { pnlNote: (m.live ? 'decided, claimed or not · exchange stats' : 'decided, claimed or not · from predictions') + (L.trades.length ? ' · incl. the secondary market' : ''), roiNote: 'on decided stakes', fromSnap: false });
    return { asBettor, asMaker, isMaker, mine, L, agg, F };
  }
  /** Headline figures of a wallet for a summary elsewhere (the perps account's Overview): { m, isMaker, mine, L, F } or null. */
  P.walletHeadline = async (addr, ctx) => { const m = await loadBettor(addr, ctx); if (!m) return null; const x = await headline(addr, m, ctx.signal); return x ? Object.assign({ m }, x) : null; };
  /** opts.embedded: inside the perps account's Predict tab, which has already resolved the Predict wallet. */
  P.renderBettor = async function (el, addr, ctx, opts = {}) {
    U.replace(el, loadingCard('Loading bettor history…'));
    UI.progress.start();
    let m;
    try { m = await loadBettor(addr, ctx); } catch (e) { UI.progress.done(); if (isAbort(e)) return; U.replace(el, UI.error(e)); return; }
    UI.progress.done();
    if (ctx.signal.aborted) return;
    // nothing under this address: when it is a trader's own wallet, its predictions are in its Predict wallet (the
    // smart account the Meridian app places them from), so the stand-alone page moves there
    const noActivity = async (text) => {
      U.replace(el, h('div.card', h('div.empty', text)));
      if (opts.embedded) return;
      const r = await P.wallets.predictAddress(addr, { signal: ctx.signal }).catch(() => null);
      // only where there is something to see: an address with no activity anywhere may itself be a Predict wallet nobody
      // has deployed yet, and naming a "wallet" derived from it would be false
      if (ctx.signal.aborted || !r || !r.via || !r.active || r.address === addr) return;
      U.toast(U.shortAddr(addr, 4) + ' places its predictions from its Predict wallet ' + U.shortAddr(r.via, 4)); location.replace('#/predict/bettor?address=' + r.via);
    };
    if (!m) { noActivity('No Meridian Predict activity for this address (as of the last snapshot).'); return; }
    const x = await headline(addr, m, ctx.signal);
    if (ctx.signal.aborted) return;
    if (!x) { noActivity('No Meridian Predict activity for this address.'); return; }
    const { norms, hist } = m;
    const { asBettor, asMaker, isMaker, mine, L, agg, F } = x;
    const heldOf = (n) => { const bp = L.byPrediction[n.id]; return bp ? bp.held : 1; };
    // live positions already carry the balance the wallet holds; the snapshot's open predictions leave out what was sold
    const posRows = m.posRows.filter((r) => !r.id || m.live || heldOf(r) > 1e-6);
    // a row's dialog: this wallet's own ledger entry where it is the bettor (what it still held, its result with the sale)
    const openRow = (n) => { const bp = L.byPrediction[n.id]; openPrediction(n, ctx, bp && n.predictor === addr ? { here: addr, traded: true, held: bp.held, ledgerPnl: bp.pnl } : { here: addr, traded: !!bp }); };
    const last = hist.length ? hist[hist.length - 1] : null;
    const claimable = last ? last.claimable : 0;
    // offline: the cumulative result from the predictions themselves, each at its settlement (js/cards.js
    // curveFromPredictions). A wallet on both sides is drawn for the role the headline counts, and a curve that cannot
    // reach the headline (only the newest predictions loaded, or the other role left out) ends at it: { pts, anchored }
    const verdictCurve = () => {
      const both = !!(asBettor.length && asMaker.length);
      const c = MD.cards.make({ U, P }).curveFromPredictions(both ? mine : norms, m.trades || [], addr);
      if (!c || c.length < 2) return null;
      const shift = (m.truncated && agg) || both ? F.pnl - c[c.length - 1][1] : 0;
      return { pts: Math.abs(shift) > 0.005 ? c.map(([s, v]) => [s, Math.round((v + shift) * 100) / 100]) : c, anchored: Math.abs(shift) > 0.005 };
    };
    // Equity curve flex (js/flex.js): all time, from the exchange's own history when live, else from the predictions the
    // way the snapshot counts them (decided at the verdict, traded positions through the token ledger); a wallet whose
    // predictions are not all loaded gets its card without the curve rather than a partial one
    const openFlex = () => {
      const K = MD.cards.make({ U, P });
      MD.flex.open({ address: addr, what: 'wallet', periods: [{ v: 'all', label: 'All time' }], period: 'all', shareUrl: MD.api.shareUrl('p', addr), build: async () => {
        const act = hist.findIndex((x) => x.total || x.pnl);
        const curve = m.live ? (act >= 0 ? hist.slice(Math.max(0, act - 1)).map((x) => [Math.round(x.t / 1000), Math.round(x.cumPnl * 100) / 100]) : null) : !m.truncated ? (verdictCurve() || {}).pts || null : null;
        const cats = {}; for (const n of mine) cats[n.cat] = (cats[n.cat] || 0) + 1;
        const topCat = agg ? agg.topCat : Object.keys(cats).sort((x, y) => cats[y] - cats[x])[0];
        const decided = (F.won || 0) + (F.lost || 0);
        const row = { address: addr, pnl: F.pnl, roi: F.roi, won: F.won, lost: F.lost, winRate: decided ? (F.won / decided) * 100 : null, wagered: agg && !m.live ? agg.wagered : m.totalVolume, n: agg ? agg.n : mine.length, avgOdds: F.avgOdds, open: F.open, topCat, first: agg ? agg.first : mine.length ? Math.min(...mine.map((n) => n.t)) : null };
        return K.walletInput(row, curve && curve.length >= 2 ? curve : null, isMaker);
      } });
    };
    const tiles = h('div.stats',
      UI.stat(isMaker ? 'Maker PnL' : 'Net PnL', usd(F.pnl, { sign: true }), F.pnlNote, U.pnlClass(F.pnl)),
      UI.stat('Volume', usd(agg && !m.live ? agg.wagered : m.totalVolume, { compact: true }), 'all time'),   // a snapshot file holds only the newest predictions; the aggregate has them all
      // a decided loss is a loss whether or not the winner has claimed: only this side's own wins waiting to be collected are called out
      // (a maker's uncollected wins are its own business and change none of these figures: not called out)
      UI.stat('Record', `${U.fmtNum(F.won, 0)}W / ${U.fmtNum(F.lost, 0)}L`, [F.open ? U.fmtNum(F.open, 0) + ' open' : null, F.unclaimedWon && !isMaker ? U.fmtNum(F.unclaimedWon, 0) + ' won, not yet claimed' : null, F.nd ? F.nd + ' void' : null].filter(Boolean).join(' · ') || null),
      UI.stat('Win rate', F.won + F.lost ? U.fmtPct((F.won / (F.won + F.lost)) * 100, { dp: 0 }) : '—', 'of decided predictions'),
      UI.stat('ROI', F.roi == null ? '—' : U.fmtPct(F.roi, { sign: true, dp: 0 }), F.roiNote, U.pnlClass(F.roi)),
      UI.stat('Avg odds', pct(F.avgOdds, 0), F.avgLegs ? 'avg ' + U.fmtNum(F.avgLegs, 1) + ' legs' : null),
      m.balance == null ? UI.stat('Open stake', usd(U.sum(posRows, (r) => r.stake)), 'in open predictions') : UI.stat('Collateral', usd(m.balance), claimable ? usd(claimable) + ' claimable' : 'in Predict'),
      UI.stat('Open', U.fmtNum(F.open, 0), 'predictions, not yet decided'),
      // winnings are collected in the Meridian app (its Predict portfolio claims them all at once)
      F.unclaimedWon && !isMaker ? UI.stat('Unclaimed winnings', usd(F.unclaimedPayout), h('span', `${U.fmtNum(F.unclaimedWon, 0)} won prediction${F.unclaimedWon > 1 ? 's' : ''} to claim`,
        h('div', { style: { marginTop: '8px' } }, h('a.btn.sm', { href: P.CLAIM_URL, target: '_blank', rel: 'noopener', title: 'Opens the Predict portfolio in the Meridian app, where the wallet\'s owner claims every payout at once' }, U.icon('external'), 'Claim on Meridian'))), 'pos') : null);
    const cPnl = h('canvas'), cVol = h('canvas');
    // Cumulative PnL, every result at its settlement (the verdict), never at its claim. Live: the exchange's own daily
    // history, booked at the verdict. Offline that history is rebuilt from claims (the tax center's cash basis), which
    // lags every wallet that leaves wins uncollected, so the curve comes from the verdicts like the headline
    // (verdictCurve, above); a wallet on both sides is drawn for the role the headline counts.
    const firstAct = hist.findIndex((x) => x.total || x.volume);
    const h2 = firstAct >= 0 ? hist.slice(Math.max(0, firstAct - 1)) : hist;
    let pnlPts = h2.map((x) => ({ x: x.t, y: x.cumPnl })), anchored = false;
    const vc = m.live ? null : verdictCurve();
    if (vc) { anchored = vc.anchored; pnlPts = vc.pts.map(([s, v]) => ({ x: s * 1000, y: v })); }
    const pnlNote = !m.live && (m.truncated || anchored) ? (m.truncated ? `newest ${mine.length} predictions · ` : '') + (anchored ? 'ends at the all-time PnL' : 'at their settlement') : null;
    // Open positions: one resolution line per leg (Polymarket + UMA oracle), a combo settles once every leg has resolved
    const legView = (k) => ({ end: k.endTime, settled: !!k.settled, yes: k.resolvedToYes, nd: false, question: k.q });
    const legCell = (r) => h('div.legs', r.picks.map((k) => (k.id
      ? h('div', { style: { cursor: 'pointer' }, title: 'Resolution details', onclick: (e) => { e.stopPropagation(); R.openDetails(legView(k), k.id, { appUrl: P.APP_URL }); } }, R.line(legView(k), k.id))
      : h('div.res-line', h('span.dim.small', k.endTime ? (k.endTime > Date.now() ? 'in ' + U.fmtCountdown(k.endTime - Date.now()) : 'pending') : '—')))));
    const openWrap = h('div');
    // a row opens its prediction where it is among the loaded predictions (a live position names it too)
    const byId = new Map(posRows.some((r) => r.id) ? norms.map((n) => [n.id, n]) : []);
    // a position with a leg the source market already resolved against is lost, only the settlement is pending: it
    // leaves the table (nothing to watch) and is counted underneath instead
    const lostPos = (r) => r.side !== 'COUNTERPARTY' && r.picks.some((k) => R.pickLost(k, k.id));
    const renderOpen = () => { const lost = posRows.filter(lostPos); const rows = posRows.filter((r) => !lostPos(r)); U.replace(openWrap, UI.table({ cols: [
      { key: 'q', label: 'Prediction', render: (r) => h('div', { style: { whiteSpace: 'normal', maxWidth: '460px', lineHeight: '1.3' } }, r.picks.map((k, i) => h('div', sideChip(k.yes), ' ', k.q))) },
      { key: 'side', label: 'Role', render: (r) => (r.side === 'COUNTERPARTY' ? UI.chip('maker', 'blue') : UI.chip('bettor', '')) },
      { key: 's', label: 'Stake', num: true, render: (r) => usd(r.stake) },
      { key: 'o', label: 'Locked odds', num: true, render: (r) => pct(r.odds, 1) },
      { key: 'f', label: 'Source now', num: true, title: 'Current probability on the source market', render: (r) => pct(r.fair, 1) },
      { key: 'p', label: 'Pays', num: true, render: (r) => h('span', usd(r.payout), h('span.dim.xs', ' (' + mult(r.stake ? r.payout / r.stake : null) + ')')) },
      { key: 'e', label: 'Resolution', title: 'Where each leg is in the Polymarket / UMA resolution pipeline', render: legCell },
    ], rows, empty: lost.length ? 'Nothing still in play' : 'No open positions', onRow: byId.size ? (r) => { const n = r.id && byId.get(r.id); if (n) openRow(n); } : null }), lost.length ? h('div.footer-note', { style: { textAlign: 'left', padding: '10px 14px' } }, `${lost.length} position${lost.length > 1 ? 's' : ''} (${usd(U.sum(lost, (r) => r.stake))} staked) already resolved against this bettor on Polymarket and only await settlement on Meridian.`) : null); };
    renderOpen();
    const legIds = posRows.flatMap((r) => r.picks.map((k) => k.id)).filter(Boolean);
    if (legIds.length) (async () => { try { await R.load(legIds, { signal: ctx.signal, deep: false }); if (ctx.signal.aborted) return; renderOpen(); await R.load(legIds, { signal: ctx.signal, deep: true }); if (!ctx.signal.aborted) renderOpen(); } catch (e) { if (!isAbort(e)) console.warn('resolution tracker', e); } })();
    resTicker(ctx, renderOpen);
    let hpage = 1; const histWrap = h('div');
    const renderHist = () => { const slice = mine.slice((hpage - 1) * PAGE, hpage * PAGE); U.replace(histWrap, UI.table({ cols: [
      { key: 't', label: 'Placed', render: (n) => h('span.dim', U.fmtDateTimeS(n.t)) },
      { key: 'q', label: 'Prediction', render: (n) => h('div', { style: { whiteSpace: 'normal', maxWidth: '460px', lineHeight: '1.3' } }, n.picks.slice(0, 3).map((k) => h('div', sideChip(k.yes), ' ', k.q)), n.legs > 3 ? h('div.xs.dim', '+' + (n.legs - 3) + (n.legs === 4 ? ' more leg' : ' more legs')) : null) },
      { key: 'c', label: 'Category', render: (n) => n.cat },
      { key: 's', label: isMaker ? 'Bettor stake' : 'Stake', num: true, render: (n) => usd(n.stake) },
      { key: 'o', label: 'Odds', num: true, render: (n) => h('span', pct(n.odds, 1), h('span.dim.xs', ' ' + mult(n.multiple))) },
      { key: 'v', label: 'Vig', num: true, title: 'Locked odds minus the Polymarket price at the moment of the bet', render: (n) => vigCell(n.vig, n) },
      { key: 'cp', label: isMaker ? 'Bettor' : 'Maker', render: (n) => bettorLink(isMaker ? n.predictor : n.counterparty) },
      { key: 'r', label: 'Result', render: (n) => { const bp = L.byPrediction[n.id]; return h('span', resultChip(n, isMaker, bp ? bp.held : 1), bp && bp.held < 0.999 ? h('span.dim.xs', { title: 'Its tokens were sold on the secondary market: the result below is the sale plus whatever was still held at the verdict' }, bp.held < 1e-6 ? ' sold' : ` ${U.fmtPct((1 - bp.held) * 100, { dp: 0 })} sold`) : null); } },
      // a prediction whose tokens were traded shows its share of the ledger's result (the sale, and the verdict on what was still held)
      { key: 'p', label: 'PnL', num: true, render: (n) => { const bp = L.byPrediction[n.id]; return bp ? (n.decided || Math.abs(bp.pnl) > 0.005 ? pnlEl(bp.pnl) : h('span.dim', '—')) : pnlEl(isMaker ? -n.pnl : n.pnl); } },
    ], rows: slice, empty: 'No predictions', onRow: openRow }), mine.length > PAGE ? UI.pager({ page: hpage, pageSize: PAGE, total: mine.length, onPage: (p) => { hpage = p; renderHist(); } }) : null); };
    renderHist();
    // secondary-market trades of this wallet: what it sold or bought, at what price, and what that did
    const secWrap = h('div'); let spage = 1;
    const saleOf = new Map(L.events.filter((e) => e.kind === 'sale' && e.trade).map((e) => [e.trade, e]));
    const tokValue = (t) => (t.side === 'P' ? t.vP : t.vC);
    const renderSec = () => { const slice = L.trades.slice((spage - 1) * PAGE, spage * PAGE); U.replace(secWrap, UI.table({ cols: [
      { key: 't', label: 'When', render: (t) => h('span.dim', U.fmtDateTimeS(t.t)) },
      { key: 'q', label: 'Prediction', render: (t) => h('div', { style: { whiteSpace: 'normal', maxWidth: '420px', lineHeight: '1.3' } }, t.q || '—', t.legs > 1 ? h('span.dim.xs', ' +' + (t.legs - 1) + (t.legs === 2 ? ' leg' : ' legs')) : null) },
      { key: 'k', label: 'Trade', render: (t) => h('span', t.seller === addr ? UI.chip('sold', 'amber') : UI.chip('bought', 'blue'), h('span.dim.xs', t.seller === addr ? ' to ' : ' from '), bettorLink(t.seller === addr ? t.buyer : t.seller, 3)) },
      { key: 'n', label: 'Tokens', num: true, title: 'A token pays $1 if its side wins', render: (t) => U.fmtNum(t.tokens, 2) },
      { key: 'x', label: 'Price', num: true, title: 'Paid per token, i.e. per $1 of payout', render: (t) => (t.tokens ? U.fmtNum((t.paid / t.tokens) * 100, 1) + '¢' : '—') },
      { key: 'a', label: 'Amount', num: true, render: (t) => usd(t.paid) },
      { key: 'o', label: 'Outcome', render: (t) => { const v = tokValue(t); return v == null ? UI.chip('open', 'accent') : v >= 0.999 ? UI.chip('won', 'green') : v <= 1e-9 ? UI.chip('lost', 'red') : UI.chip('void', 'amber'); } },
      { key: 'r', label: 'Result', num: true, title: 'A sale: its price minus what the tokens cost this wallet. A purchase: the payout minus the price, once decided', render: (t) => { if (t.seller === addr) { const e = saleOf.get(t); return e ? h('span', { title: `sold for ${usd(e.cash)} · cost ${usd(e.cost)}` }, pnlEl(e.pnl)) : h('span.dim', '—'); } const v = tokValue(t); return v == null ? h('span.dim', 'open') : pnlEl(t.tokens * v - t.paid); } },
    ], rows: slice, empty: 'No trades' }), L.trades.length > PAGE ? UI.pager({ page: spage, pageSize: PAGE, total: L.trades.length, onPage: (p) => { spage = p; renderSec(); } }) : null); };
    if (L.trades.length) renderSec();
    // the breakdowns add up to the headline: a decided prediction whose tokens were traded counts its ledger result
    const sum = P.bettorSummary(mine.map((n) => { const bp = L.byPrediction[n.id]; return bp && n.decided ? Object.assign({}, n, { pnl: isMaker ? -bp.pnl : bp.pnl }) : n; }));
    const catTbl = UI.table({ cols: [{ key: 'c', label: 'Category', render: (r) => r.cat }, { key: 'n', label: 'Predictions', num: true, render: (r) => String(r.n) }, { key: 'w', label: 'Wagered', num: true, render: (r) => usd(r.wagered, { compact: true }) }, { key: 'wr', label: 'Win rate', num: true, render: (r) => (r.winRate == null ? '—' : U.fmtPct(r.winRate, { dp: 0 })) }, { key: 'p', label: 'PnL', num: true, render: (r) => pnlEl(isMaker ? -r.pnl : r.pnl) }], rows: sum.categories, empty: '—' });
    const comboTbl = UI.table({ cols: [{ key: 'l', label: 'Legs', render: (r) => (r.legs === 1 ? 'Single' : r.legs + '-leg') }, { key: 'n', label: 'Predictions', num: true, render: (r) => String(r.n) }, { key: 'o', label: 'Avg odds', num: true, render: (r) => pct(r.avgOdds, 0) }, { key: 'wr', label: 'Win rate', num: true, render: (r) => (r.winRate == null ? '—' : U.fmtPct(r.winRate, { dp: 0 })) }, { key: 'p', label: 'PnL', num: true, render: (r) => pnlEl(isMaker ? -r.pnl : r.pnl) }], rows: sum.combos, empty: '—' });
    // whose Predict wallet this is: the owner signs in to Meridian with it and holds the perps account (if any)
    const ownerEl = h('span.small');
    if (!opts.embedded) P.wallets.ownerOf(addr).then((o) => { if (o && !ctx.signal.aborted) U.replace(ownerEl, h('span.dim', 'Predict wallet of '), h('a.addr', { href: U.accountUrl(o, null, 'predict'), title: 'Owner ' + o + ' · its perps account' }, U.shortAddr(o, 4)), U.copyBtn(o)); }).catch(() => {});
    U.replace(el, h('div.stack',
      h('div.row.wrap', !mine.length && L.trades.length ? UI.chip('secondary-market trader', 'blue') : isMaker ? UI.chip('market maker', 'blue') : UI.chip('bettor', 'accent'), ownerEl, h('span.dim.small', F.fromSnap ? `${U.fmtNum(agg.n, 0)} predictions · the tables show the newest ${mine.length}; the figures above cover all of them, from the snapshot built ${U.fmtAgo(agg.at)}` : m.live ? `${mine.length} predictions · figures from Meridian's own account history` : `${mine.length} predictions · snapshot ${U.fmtAgo(m.builtAt)} · ${offlineNote}`), h('span.grow'), h('button.btn.sm', { title: 'This wallet\'s PnL card, to download, copy or post', onclick: openFlex }, U.icon('trophy'), 'Equity curve flex'), h('a.btn.sm.ghost', { href: P.APP_URL, target: '_blank', rel: 'noopener' }, U.icon('external'), 'Predict app')),
      tiles,
      // offline, the curves are rebuilt from the loaded predictions: say so when those are not all of them
      h('div.grid.cols-2', h('div.card', h('div.row', { style: { marginBottom: '10px' } }, h('h3', 'Cumulative PnL'), h('span.grow'), pnlNote ? h('span.dim.xs', pnlNote) : null), h('div.chart-box.sm', cPnl)), h('div.card', h('div.row', { style: { marginBottom: '10px' } }, h('h3', 'Daily volume'), h('span.grow'), !m.live && m.truncated ? h('span.dim.xs', `newest ${mine.length} predictions`) : null), h('div.chart-box.sm', cVol))),
      UI.card('Open positions', openWrap, h('span.dim.small', posRows.length < F.open ? `newest ${posRows.length} of ${U.fmtNum(F.open, 0)}` : String(posRows.length))),
      UI.card('Prediction history', histWrap, h('span.dim.small', 'newest first')),
      L.trades.length ? UI.card('Secondary market', secWrap, h('span.dim.small', `${L.trades.length} trade${L.trades.length > 1 ? 's' : ''} · positions sold or bought before the verdict · ${usd(L.pnl, { sign: true })} from traded positions`)) : null,
      h('div.grid.cols-2', UI.card('By category', catTbl), UI.card('Singles vs combos', comboTbl))));
    const col = C.colors();
    const endPnl = pnlPts.length ? pnlPts[pnlPts.length - 1].y : 0;
    C.timeSeries(cPnl, { points: pnlPts, color: endPnl >= 0 ? col.green : col.red, label: 'PnL' });
    C.timeSeries(cVol, { points: h2.map((x) => ({ x: x.t, y: x.volume })), type: 'bar', color: col.accent, label: 'Volume' });
  };
})();
