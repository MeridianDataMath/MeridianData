/* MeridianDataHub — Predict section: overview, bettors, questions, market makers, vig & edge, bettor page */
(function () {
  const MD = window.MD; const U = MD.util; const UI = MD.ui; const C = MD.charts; const h = U.h; const P = MD.predict;
  const isAbort = (e) => e && e.name === 'AbortError';
  const PAGE = 25;

  // ---------- formatting ----------
  const pct = (x, dp = 1) => (x == null || !Number.isFinite(x) ? '—' : U.fmtPct(x * 100, { dp }));
  // locked odds below 1 never read 100% (as the resolution tracker's prices), and neither does a slip's chance before
  // every leg has resolved
  const oddsPct = (o, dp = 1) => (o == null || !Number.isFinite(o) ? '—' : o > 0.99 && o < 1 ? (Math.floor(o * 1000 + 1e-6) / 10).toFixed(1) + '%' : pct(o, o < 0.1 ? 1 : dp));
  const pp = (x, dp = 1) => (x == null || !Number.isFinite(x) ? '—' : (x > 0 ? '+' : '') + (x * 100).toFixed(dp) + ' pp');
  // a near-certain slip keeps the digits that show it pays more than its stake (1.000076 reads 1.0001×, not 1.00×)
  const mult = (m) => (m == null || !Number.isFinite(m) ? '—' : U.fmtNum(m, m < 1.01 ? 4 : m >= 100 ? 0 : 2) + '×');
  // money on the Predict pages: whole dollars from $100 up (cents on a five-figure total are noise), cents only on small stakes
  const usd = (x, o) => U.fmtUsd(x, Math.abs(U.num(x)) >= 100 && !(o && o.dp != null) ? Object.assign({ dp: 0 }, o) : o);
  // one slip's stake, payout and result keep their cents, as Meridian's own slip shows them ($150.41 paying $151.97, not
  // $150 paying $152, which also hid what it pays over the stake)
  const cents = (x, o) => usd(x, Object.assign({ dp: 2 }, o));
  // win rates to two decimals, as Meridian's app shows them (24.01 %)
  const winPct = (x) => (x == null || !Number.isFinite(x) ? '—' : U.fmtPct(x, { dp: 2 }));
  // Records and win rates are Meridian's app's (its Positions Won / Lost and Win Rate, P.appRecord): a prediction counts
  // once it is claimed and stays pending until then. The site's own count, every decided prediction at its verdict,
  // claimed or not, goes in the title. app false: a snapshot from before its rows kept the app's counts, whose figure is
  // the site's count.
  const recTitle = (app, vWon, vLost) => (app
    ? `As Meridian's app counts them (Positions Won / Lost, Win Rate): a prediction counts once it is claimed and stays pending until then. Site's figure, every decided prediction at its verdict, claimed or not: ${U.fmtNum(vWon, 0)}W / ${U.fmtNum(vLost, 0)}L, ${winPct(vWon + vLost ? (vWon / (vWon + vLost)) * 100 : null)}`
    : 'Every decided prediction at its verdict, claimed or not (this snapshot predates the app\'s counts, which take a prediction only once it is claimed)');
  /** A row's win rate as the app counts it (P.rowRecord: a bettor's or a maker's row, from its own side), the site's count in its title. */
  const winCell = (r) => { const rec = P.rowRecord(r); return h(rec.winRate == null ? 'span.dim' : 'span', { title: recTitle(rec.app, r.won || 0, r.lost || 0) }, winPct(rec.winRate)); };
  const WIN_COL_TITLE = 'Won ÷ (won + lost) as Meridian\'s app counts them (its Win Rate): only claimed predictions count, and one decided but not yet claimed is still pending there. A figure\'s tooltip has the site\'s own count, every decided prediction at its verdict';
  // a breakdown by category or legs has no counterpart in the app: it counts every decided prediction at its verdict
  const BREAKDOWN_WIN_TITLE = 'Won ÷ (won + lost) over the decided predictions in this row, claimed or not, each at its verdict. Meridian\'s app has no such breakdown; its Win Rate, which counts only claimed predictions, is the one the win-rate tiles and the wallets\' rows show';
  // the launch (P.LAUNCH_SEC) as its UTC day: what the snapshot starts from
  const LAUNCH_DAY = new Date(P.LAUNCH_SEC * 1000).toISOString().slice(0, 10);
  const pnlEl = (x) => h('span', { class: 'num ' + U.pnlClass(x) }, usd(x, { sign: true }));
  const bettorUrl = (a) => '#/predict/bettor?address=' + encodeURIComponent(a);
  const bettorLink = (a, n) => h('a.addr', { href: bettorUrl(a), title: a, onclick: (e) => e.stopPropagation() }, U.shortAddr(a, n || 4));
  const sideChip = (yes) => (yes == null ? h('span.dim', '—') : UI.chip(yes ? 'YES' : 'NO', yes ? 'green' : 'red'));
  /** A prediction's result from one side (the bettor's unless asMaker). "Unclaimed" is shown only where that side has
   *  something to collect (its win, or a void's refund): a loss is simply lost, whether or not the winner has claimed. */
  const resultChip = (n, asMaker, held = 1, claims = true) => { const r = P.resultFor(n, asMaker, held, claims); return h('span.chip', { class: r.tone, title: r.title || '' }, r.label); };
  const vigCell = (v, n) => (v == null ? h('span.dim', '—') : h('span', { class: v > 0.02 ? 'neg' : v < -0.02 ? 'pos' : '' }, pp(v), n && n.sameEvent ? h('span.dim.xs', { title: 'Legs on the same match or asset: fair assumes independence, so this includes correlation pricing' }, ' corr.') : null));
  const probBar = (p, label, dp = 1) => { const v = p == null ? null : U.clamp(Number(p), 0, 1); return h('div.prob', { title: v == null ? '' : (label || 'YES: ') + pct(v) }, h('i', { style: { width: (v == null ? 0 : v * 100) + '%' } }), h('span', v == null ? '—' : pct(v, dp))); };
  // a question's source market is a link the API hands over: only a web address becomes a button
  const webUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
  const srcBtn = (u) => h('a.btn.sm.ghost', { href: u, target: '_blank', rel: 'noopener', title: u }, U.icon('external'), /polymarket/i.test(u) ? 'Polymarket' : 'Source');
  const sourceLink = (c) => { const m = webUrl(c.similarMarket && c.similarMarket.markets && c.similarMarket.markets[0]); return m ? srcBtn(m) : null; };
  /** The market-maker columns the Overview and the Market makers page share (written twice, they drifted apart). T: totals; a: the aggregate. */
  const makerCols = (T, a) => ({
    share: { key: 's', label: 'Share of predictions', num: true, title: 'Predictions taken ÷ all predictions, by count (not by stake or collateral)', render: (r) => U.fmtPct((r.n / T.n) * 100, { dp: 1 }) },
    committed: { key: 'c', label: 'Collateral committed', num: true, title: 'Sum of collateral put up against bettors', render: (r) => usd(r.wagered, { compact: true }) },
    open: { key: 'o', label: 'Open collateral', num: true, title: 'Maker collateral in predictions not decided yet. It includes predictions whose bettor-side tokens the maker has since bought: holding both sides, it is paid stake + collateral whatever the result, so that part is not at risk.', render: (r) => usd(r.openWagered, { compact: true }) },
    pnl: { key: 'p', label: 'Maker PnL', num: true, title: 'Decided predictions, claimed or not: + the bettor\'s stake on wins, − own collateral on losses' + (a.secondary ? ', plus secondary-market trades' : ''), render: (r) => pnlEl(r.pnl) },
    winRate: { key: 'wr', label: 'Maker win rate', num: true, title: WIN_COL_TITLE + ', from the maker\'s side', render: winCell },
    vig: { key: 'v', label: 'Avg vig quoted', num: true, title: 'Locked odds minus the Polymarket price at the moment of the bet (quoted, not what the maker realized), averaged over the singles and the combos with every leg on a different match that this maker took. Combos with legs on the same match or asset are left out: those legs are correlated, so the product of their prices is not a fair price (see Vig & edge).', render: (r) => vigCell(r.avgVig) },
    odds: { key: 'ao', label: 'Avg bettor odds', num: true, title: 'Average locked odds of the bettors it took: stake ÷ (stake + collateral)', render: (r) => pct(r.avgOdds, 0) },
    topCat: { key: 'cat', label: 'Top category', title: 'The category with the most predictions taken (a tie goes to the larger stake). Mixed: a combo with legs in more than one category.', render: (r) => r.topCat || '—' },
  });

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
        const norms = raw.map(P.norm); P.markTokenClaims(norms);   // as the snapshot builder does
        const snap = { builtAt: Date.now(), source: 'browser', windowDays: days, fromSec: from, agg: P.aggregate(norms), remote: false };
        P._snap = snap; P._snapAt = Date.now();
        return snap;
      })().finally(() => { P._building = null; });
    }
    return P._building;
    })().finally(() => { P._loading = null; bytesListeners = []; });
    return P._loading;
  };
  const snapNote = (s) => (s.remote ? `snapshot ${U.fmtAgo(s.builtAt)} · all predictions since launch` : `built in this browser ${U.fmtAgo(s.builtAt)} · predictions placed in the last ${s.windowDays} days only`);
  const offlineNote = 'live queries are not available from this domain (the Predict API does not accept browser requests from it), so this shows the published snapshot';
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
    } catch (e) { UI.progress.done(); if (isAbort(e)) return; U.replace(body, UI.error(e, () => MD.router.reload())); return; }
    if (ctx.signal.aborted) { UI.progress.done(); return; }
    prog.textContent = 'Rendering…'; UI.progress.set(0.9);
    try { await render(snap); } catch (e) { if (!isAbort(e)) { console.error(e); U.replace(body, UI.error(e, () => MD.router.reload())); } }
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
      const a = snap.agg; const T = a.totals; const MK = P.splitMakers(a.makers); const M = makerCols(T, a);
      const withSec = !!a.secondary;   // no secondary-market trades in this aggregate (the browser build, or a failed trades fetch)
      const tiles = h('div.stats',
        UI.stat('Predictions', U.fmtNum(T.n, 0), T.decided != null ? `${U.fmtNum(T.open, 0)} open · ${U.fmtNum(T.decided, 0)} decided` : `${U.fmtNum(T.open, 0)} open · ${U.fmtNum(T.settled, 0)} settled`),
        UI.stat('Wagered', usd(T.wagered, { compact: true }), 'bettor stakes'),
        UI.stat('Maker collateral', usd(T.cpCommitted, { compact: true }), 'put up against those stakes'),
        UI.stat('Bettors', U.fmtNum(T.bettors, 0), `${MK.makers.length} market maker${MK.makers.length === 1 ? '' : 's'}`),
        // every bettor's record as Meridian's app counts it, added up (the rows' appWon / appLost)
        UI.stat('Bettor win rate', h('span', { title: recTitle(T.appWon != null, T.won || 0, T.lost || 0) }, winPct(T.appWon != null ? T.appWinRate : T.winRate)), T.appWon != null ? 'of claimed predictions, as Meridian\'s app counts them' : 'of decided predictions'),
        UI.stat('Bettor net result', usd(T.bettorPnl, { sign: true }), withSec ? 'decided, claimed or not · incl. positions sold on the secondary market' : 'decided, claimed or not · secondary-market sales not counted', U.pnlClass(T.bettorPnl)),
        UI.stat('Combos', T.n ? U.fmtPct((T.combos / T.n) * 100, { dp: 0 }) : '—', 'of predictions are multi-leg'),
        UI.stat('Avg vig paid', a.vig.overall.avg == null ? '—' : pp(a.vig.overall.avg), a.vig.overall.avg == null ? 'odds vs Polymarket price at bet time' : `odds vs Polymarket price at bet time · ${U.fmtNum(a.vig.overall.n, 0)} of ${U.fmtNum((a.vig.coverage || {}).total || T.n, 0)} predictions; combos with legs on the same match or asset left out`));
      // Claiming is only the cash step: PnL and the category and combo win rates count a prediction at its verdict, so
      // unclaimed wins change none of them; the Bettor win rate is the app's (claimed predictions only, recTitle). They get
      // a line under the tiles, not tiles of their own; the questions stuck on Meridian's side live on the Questions page
      // (Ended · unsettled).
      const cWager = h('canvas'), cCount = h('canvas');
      // the live tape and the big wins side by side (stacked where the page is too narrow for both); a row opens the prediction
      const tapeBody = h('div.feed.pause-hover');
      const tapeNote = h('span.dim.small', 'newest first · refreshes every 20 s');
      const tapeCard = h('div.card.tight.feed-card', h('div.card-head', h('h2', 'Live predictions'), tapeNote, h('span.grow'), h('a.btn.sm.ghost', { href: P.APP_URL, target: '_blank', rel: 'noopener' }, U.icon('external'), 'Predict app')), h('div.feed-fill', tapeBody));
      // Recent = the latest settlement first: when the win was decided, never when its payout was claimed, which can be
      // weeks later (0x4a72…: settled Sep 13, claimed Sep 29); a win counts from its settlement whether claimed or not.
      // A cash-out counts from its last sale when the bettor sold everything or nothing is decided yet (the profit was
      // made then)
      // a row on picks whose tokens the bettor traded is its position there (n.group, P.positions): its bets counted
      // together, its result (sales included) and the share of its tokens it still held; an older snapshot's rows have
      // the slip's own figures only
      const soldOut = (n) => (n.group ? n.group.h < 1e-6 : n.held != null && n.held < 1e-6);
      const fromSale = (n) => !!(n.cashOut && (soldOut(n) || !n.decided));
      const winTime = (n) => (fromSale(n) ? n.cashOut.t : decidedTime(n) || n.t);
      const bigStake = (n) => (n.group ? n.group.s : n.stake);
      // what came back for what went in (stakes and tokens bought); a part cash-out on open picks: what its sales fetched
      // for what the tokens sold had cost (the rest is still at stake)
      const bigMult = (n) => { const g = n.group; if (!g) return n.tradedPnl != null ? (n.stake > 0 ? (n.stake + n.tradedPnl) / n.stake : null) : n.multiple;
        if (n.cashOut && !n.decided && !soldOut(n)) return n.cashOut.cost > 0 ? n.cashOut.cash / n.cashOut.cost : null;
        return g.in > 0 ? (g.in + g.lp) / g.in : null; };
      const BW_SORTS = [
        { v: 'recent', label: 'Recent', title: 'Latest settlement first (claimed or not); a cash-out from its last sale when it sold everything or the picks are still open', val: winTime },
        { v: 'pnl', label: 'PnL', title: withSec ? 'Largest profit first: payout − stake (a bettor who traded its tokens: its own result, sales included)' : 'Largest profit first: payout − stake', val: (n) => bigPnl(n) },
        { v: 'mult', label: 'Multiplier', title: 'Highest return on the stake first: payout ÷ stake (a bettor who traded its tokens: what came back ÷ what it staked)', val: (n) => bigMult(n) || 0 }];
      let bwSort = 'recent', bigWins = null, bigAt = 0;
      const bigPnl = (n) => (n.group ? n.group.lp : n.tradedPnl != null ? n.tradedPnl : n.pnl);
      // a win still to claim: where the snapshot read the balances (tc, agg.claimAt), the bettor still holds its winning
      // tokens, as Meridian's app counts a payout to claim; an older snapshot, the API's settled flag (which anyone's
      // settlement sets, and a claim through a twin prediction leaves unset)
      const toClaim = (n) => (n.toClaim != null ? n.won && n.toClaim : !(n.settled && n.settledAt) && n.unclaimed && n.won && !soldOut(n));
      const bwBody = h('div.feed.bigwins'), bwNote = h('span.dim.small');
      const bwCard = h('div.card.tight.feed-card', h('div.card-head', h('h2', 'Big wins'), bwNote, h('span.grow'), UI.seg(BW_SORTS, bwSort, (v) => { bwSort = v; renderBig(); bwBody.scrollTop = 0; }, 'sm')), h('div.feed-fill', bwBody));
      // the tables count each prediction's own result; only the Bettor net result tile adds the secondary-market trades
      const tblPnlTitle = 'Payout − stake on decided predictions (claimed or not), as if every position was held to the verdict' + (withSec ? '; the Bettor net result tile adds secondary-market trades' : '');
      const catTbl = UI.table({ cols: [
        { key: 'c', label: 'Category', title: 'Mixed: a combo with legs in more than one category', render: (r) => r.cat },
        { key: 'n', label: 'Predictions', num: true, render: (r) => U.fmtNum(r.n, 0) },
        { key: 'w', label: 'Wagered', num: true, render: (r) => usd(r.wagered, { compact: true }) },
        { key: 'wr', label: 'Bettor win rate', num: true, title: BREAKDOWN_WIN_TITLE, render: (r) => (r.winRate == null ? '—' : U.fmtPct(r.winRate, { dp: 0 })) },
        { key: 'p', label: 'Bettor PnL', num: true, title: tblPnlTitle, render: (r) => pnlEl(r.pnl) },
        { key: 'v', label: 'Avg vig', num: true, title: 'Average of locked odds − Polymarket price at bet time, over this category\'s predictions that have that price. Combos with legs on the same match or asset are left out: for those, the product of the legs\' prices is not a fair price.', render: (r) => vigCell(r.avgVig) },
      ], rows: a.categories });
      const comboTbl = UI.table({ cols: [
        { key: 'l', label: 'Legs', render: (r) => (r.legs === 1 ? 'Single' : r.legs + '-leg combo') },
        { key: 'n', label: 'Predictions', num: true, render: (r) => U.fmtNum(r.n, 0) },
        { key: 'w', label: 'Wagered', num: true, render: (r) => usd(r.wagered, { compact: true }) },
        { key: 'o', label: 'Avg odds', num: true, render: (r) => pct(r.avgOdds) },
        { key: 'm', label: 'Median multiplier', num: true, title: 'Median of payout ÷ stake across these predictions, open and settled (the payout is stake + maker collateral)', render: (r) => mult(r.medianMultiple) },
        { key: 'wr', label: 'Win rate', num: true, title: BREAKDOWN_WIN_TITLE, render: (r) => (r.winRate == null ? '—' : U.fmtPct(r.winRate, { dp: 0 })) },
        { key: 'p', label: 'Bettor PnL', num: true, title: tblPnlTitle, render: (r) => pnlEl(r.pnl) },
      ], rows: a.combos });
      const makersTbl = UI.table({ cols: [
        { key: 'a', label: 'Market maker', render: (r) => bettorLink(r.address, 6) },
        { key: 'n', label: 'Taken', num: true, render: (r) => U.fmtNum(r.n, 0) },
        M.share, M.committed, M.open, M.pnl, M.winRate, M.vig,
        { key: 'f', label: 'Last taken', title: 'When this maker last took the other side of a prediction', render: (r) => h('span.dim', U.fmtAgo(r.last)) },
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
      // the snapshot's age, kept current while the page stays open (everything here is from this one snapshot)
      const snapEl = h('span.dim.small', snapNote(snap));
      const tAgo = setInterval(() => { snapEl.textContent = snapNote(snap); }, 30000); ctx.onCleanup(() => clearInterval(tAgo));
      U.replace(body,
        h('div.row.wrap', snapEl, h('span.grow'), h('span.dim.small', 'Meridian Predict runs on Sapience; questions mirror Polymarket markets, USDe collateral, RFQ auctions against market makers.')),
        tiles,
        h('div.grid.cols-2', h('div.card', h('h3', { style: { marginBottom: '10px' } }, 'Wagered per day (UTC)'), h('div.chart-box.sm', cWager)), h('div.card', h('h3', { style: { marginBottom: '10px' } }, 'Predictions per day (UTC)'), h('div.chart-box.sm', cCount))),
        h('div.pred-pair', h('div.grid.pred-grid', tapeCard, bwCard)),
        h('div.grid.cols-2', UI.card('By category', catTbl), UI.card('Singles vs combos', comboTbl)),
        h('div.card.tight', h('div.card-head', h('h2', 'Market makers'), h('span.dim.small', 'who takes the other side of the auctions · click a row for the maker'), h('span.grow'), h('a.small', { href: '#/predict/makers' }, 'all makers')), makersTbl),
        secCard,
        h('div.footer-note', 'Odds = stake ÷ (stake + maker collateral). Vig = those odds minus the Polymarket price for the same picks at the moment of the bet (a combo multiplies its legs); positive means the bettor paid above fair' + (a.vig.coverage && a.vig.coverage.sameEvent ? `; the vig averages leave out the ${U.fmtNum(a.vig.coverage.sameEvent, 0)} combos with legs on the same match or asset` : '') + '. Predictions, stakes and the per-day charts count at placement; PnL and the category and singles-vs-combos win rates count a prediction at its verdict, claimed or not' + (T.unclaimed ? ` (${U.fmtNum(T.unclaimed, 0)} are not claimed yet${T.fromBalances && a.claimAt ? ': their winners still held the winning tokens when the snapshot read them, ' + U.fmtDateTime(a.claimAt) : ''}; ${U.fmtNum(T.unclaimedLost || 0, 0)} of them maker wins)` : '') + ': claiming only moves the cash.' + (T.appWon != null ? ' The Bettor win rate and the makers\' win rates are Meridian\'s app\'s Win Rate, which counts a prediction only once it is claimed; their tooltips have the count at the verdict.' : '') + (withSec ? ` The bettor net result and maker PnL also count position tokens traded on the secondary market (a sale when it happens, tokens still held at the verdict): ${usd(a.secondary.toBettors, { sign: true })} for bettors. The category and singles-vs-combos tables count each prediction's own result without those trades, so their Bettor PnL adds up to ${usd(T.bettorPnl - a.secondary.toBettors, { sign: true })}.` : '')));
      const col = C.colors();
      // a.daily is keyed by UTC day: the tooltip names that day, not a local clock time
      C.timeSeries(cWager, { points: a.daily.map((d) => ({ x: d.t, y: d.wagered })), type: 'bar', color: col.accent, label: 'Wagered', titleFmt: U.fmtDayUTC });
      C.timeSeries(cCount, { points: a.daily.map((d) => ({ x: d.t, y: d.n })), type: 'bar', color: col.blue, label: 'Predictions', yFmt: (v) => U.fmtNum(v, 0), tipFmt: (v) => U.fmtNum(v, 0), titleFmt: U.fmtDayUTC });

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
        const co = n.cashOut, g = n.group, dec = decidedTime(n), lost = n.decided && !n.won && !n.nd;
        const when = (co ? 'Cashed out ' + U.fmtDateTime(co.t) + '\n' + (n.decided ? 'Settled ' + U.fmtDateTime(dec || n.t) : 'Not settled yet') : 'Settled ' + U.fmtDateTime(at))
          + (n.won && !soldOut(n) ? (toClaim(n) ? '\nPayout not claimed yet' : paid ? '\nPayout claimed ' + U.fmtDateTime(n.settledAt) : '\nPayout claimed') : '') + '\nPlaced ' + U.fmtDateTime(n.t);
        // tokens sold before the verdict: what they fetched and cost, from how many bets, and how the picks then went
        const coTitle = co ? `The bettor sold ${U.fmtNum(co.tok, 2)} position tokens before the verdict for ${usd(co.cash)} (they cost ${usd(co.cost)})`
          + (g && g.n > 1 ? `. From ${g.n} bets on these picks, ${usd(g.s)} staked (the row opens the largest)` : '') + (soldOut(n) ? '' : n.decided ? '; the rest it held to the verdict' : '; it still holds the rest')
          + (!n.decided ? '. The picks are not decided yet.' : n.won ? (soldOut(n) ? '. The picks won: the payout went to the buyer.' : '. The picks won.') : lost ? (soldOut(n) ? '. The picks lost: it sold before they did.' : '. The picks lost, and with them what it still held.') : '.')
          + ' PnL is its own result, sales included.' : null;
        const sold = co ? h('span.chip.amber', { title: coTitle }, soldOut(n) ? 'cashed out' : 'part cashed out')
          : n.held != null && n.held < 0.999 ? h('span.chip.amber', { title: soldOut(n) ? 'The bettor sold these position tokens before the verdict: the payout went to the buyer. PnL is the bettor\'s own result, the sale included.' : `The bettor sold ${U.fmtPct((1 - n.held) * 100, { dp: 0 })} of these position tokens before the verdict. PnL is its own result, the sale included.` }, soldOut(n) ? 'sold' : U.fmtPct((1 - n.held) * 100, { dp: 0 }) + ' sold') : null;
        // a win not claimed yet is listed like any other (its time's tooltip says so; no mark on the row)
        const bets = g && g.n > 1 ? h('span.dim.xs', { title: `${g.n} bets by this bettor on the same picks, counted together (they share one position token)` }, g.n + ' bets') : null;
        return predRow(n, 'big', '',
          h('span.t', { title: when }, U.fmtFeedTime(at)), bettorLink(n.predictor), picksCell(n), bets, sold,
          h('span.num.dim.fix.stk.opt', { title: g && g.n > 1 ? `Staked on these picks (${g.n} bets)` : 'Stake' }, usd(bigStake(n))),
          h('span.num.fix.mul', { class: on('mult'), title: g ? (n.cashOut && !n.decided && !soldOut(n) ? 'What its sales fetched ÷ what the tokens sold had cost (the rest is still at stake)' : 'What came back ÷ what went in (stakes and tokens bought), sales included') : n.tradedPnl != null ? 'What came back ÷ what was staked, sales included' : 'Multiplier: payout ÷ stake (the payout, ' + usd(n.pool) + ', is in the dialog)' }, mult(bigMult(n))),
          h('span.num.fix.pl', { class: on('pnl') + ' ' + U.pnlClass(pl), title: g ? 'The bettor\'s PnL on these picks, the sale of its tokens included' + (g.n > 1 ? ' (all ' + g.n + ' bets; the opened slip shows its own share)' : n.tradedPnl != null && Math.abs(n.tradedPnl - g.lp) > 0.005 ? ' (the opened slip shows its share of everything this bettor did on these picks, later bets included)' : '') : n.tradedPnl != null ? 'The bettor\'s PnL, the sale of its tokens included' : 'PnL: payout − stake' }, usd(pl, { sign: true })));
      };
      const renderBig = () => {
        const s = BW_SORTS.find((o) => o.v === bwSort) || BW_SORTS[0];
        const rows = bigWins ? U.sortBy(bigWins, s.val, true) : [];
        U.replace(bwNote, h('span', { title: (withSec ? 'Net PnL = payout − stake. A bettor who traded its position tokens counts its own result over its bets on the same picks, sales included; a cash-out (tokens sold before the verdict) is listed when that profit is over ' + usd(P.BIG_WIN) + ', whatever the verdict, from its last sale when it sold everything or the picks are still open.' : 'Net PnL = payout − stake (no secondary-market trades in this snapshot).') + ' A win counts from its settlement, claimed or not.' }, `net PnL over ${usd(P.BIG_WIN)}` + (bigWins && bigWins.length ? ` · ${U.fmtNum(bigWins.length, 0)} ${snap.remote ? 'since launch' : 'on bets placed in the last ' + snap.windowDays + ' days'}` : '')));
        U.replace(bwBody, rows.length ? rows.map(bigRow) : UI.empty(bigWins ? `No win has made more than ${usd(P.BIG_WIN)} yet` : 'Big wins appear with the next snapshot (published every 30 minutes)'));
      };
      setBigWins(snap); renderBig();

      // live tape (where the API refuses this origin, the snapshot's tape, and the snapshot is re-read to notice a newer one)
      const live = await P.live();
      let tapeRows = a.tape.slice(0, 25).map(P.full);
      if (!live) { tapeNote.textContent = 'as of the snapshot · checked every minute'; tapeNote.title = offlineNote; }
      const tapeRow = (n, flash) => predRow(n, 'tape', flash ? 'flash' : '',
        h('span.t', U.fmtFeedTime(n.t)), bettorLink(n.predictor), sideChip(n.picks[0] ? n.picks[0].yes : null), picksCell(n),
        h('span.num', usd(n.stake)), h('span.num.dim.opt', '@ ' + oddsPct(n.odds)), h('span.num', mult(n.multiple)), h('span.dim.xs.opt2', 'vs ', h('a.addr', { href: bettorUrl(n.counterparty), title: (MK.oneOff.some((x) => x.address === n.counterparty) ? 'One-off counterparty ' : 'Market maker ') + n.counterparty, onclick: (e) => e.stopPropagation() }, U.shortAddr(n.counterparty, 3))), resultChip(n, false, n.held == null ? 1 : n.held, false));
      const renderTape = (fresh) => U.replaceLive(tapeBody, tapeRows.length ? tapeRows.map((n) => tapeRow(n, fresh && fresh.has(n.id))) : UI.empty('No predictions yet'));
      renderTape();
      let tT = null;
      const pollTape = async () => {
        try {
          let norms;
          if (live) norms = (await P.tape(25, { signal: ctx.signal })).map(P.norm);
          else {
            const s = await P.loadSnapshot({ force: true });
            // a newer snapshot: everything here is from the one the page was built with, so offer the new one instead of mixing them
            if (s.builtAt > snap.builtAt) { clearInterval(tT); U.replace(tapeNote, h('a', { href: '#/predict', title: 'Everything on this page is from the snapshot built ' + U.fmtDateTime(snap.builtAt), onclick: (e) => { e.preventDefault(); MD.router.reload(); } }, 'newer snapshot published · show it')); }
            return;
          }
          const known = new Set(tapeRows.map((r) => r.id)); const fresh = new Set(norms.filter((n) => !known.has(n.id)).map((n) => n.id)); tapeRows = norms; renderTape(fresh);
        } catch (e) { if (!isAbort(e)) console.warn('tape', e); }
      };
      if (live) pollTape();
      tT = setInterval(pollTape, live ? 20000 : 60000); ctx.onCleanup(() => clearInterval(tT));

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
            { key: 'px', label: 'Price / token', num: true, title: 'Paid ÷ face value: the price of a token that pays 1 USDe if its side wins, i.e. the win chance implied by the trade price', render: (r) => pct(r.px, 1) },
            { key: 'o', label: 'Outcome', title: 'How the traded picks were settled on Meridian: won = each token is worth 1 USDe, lost = nothing, void = its share of the stakes back; open = not settled yet. It shows what the seller gave up, not what the buyer collected: a market maker that buys back the bettor\'s side usually burns those tokens at once with its own opposite-side tokens and takes its collateral back before the verdict', render: outcome },
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
      // (win rate: the app's, as the column shows it)
      const val = (b, k) => ({ address: b.address, n: b.n, wagered: b.wagered, pnl: b.pnl, roi: b.roi, winRate: P.rowRecord(b).winRate, avgOdds: b.avgOdds, combos: b.n ? b.combos / b.n : 0, avgVig: b.avgVig, last: b.last, open: b.openWagered, biggestWin: b.biggestWin })[k];
      function render() {
        let rows = all.filter((b) => b.n >= st.minN);
        if (st.cat) rows = rows.filter((b) => b.topCat === st.cat);
        rows = U.sortBy(rows, (b) => val(b, st.sort.key), st.sort.desc);
        const rank = new Map(rows.map((b, i) => [b, i + 1]));   // the place on the board as filtered and sorted, before the address search
        const full = U.isAddress(st.q);
        if (full) rows = all.filter((b) => b.address === st.q);   // a full address is found whatever the filters
        else if (st.q) rows = rows.filter((b) => b.address.includes(st.q));
        const total = rows.length; const pages = Math.max(1, Math.ceil(total / PAGE)); if (st.page > pages) st.page = pages;
        const slice = rows.slice((st.page - 1) * PAGE, st.page * PAGE);
        const onSort = (k) => { if (st.sort.key === k) st.sort.desc = !st.sort.desc; else st.sort = { key: k, desc: k !== 'address' }; st.page = 1; render(); };
        U.replace(wrap, UI.table({ sort: st.sort, onSort, cols: [
          { key: 'rank', label: '#', render: (r) => { const i = rank.get(r); return i ? h('span.rank', { class: i <= 3 ? 'top' : '' }, String(i)) : h('span.dim', { title: 'Below the Min predictions or Top category filter' }, '—'); } },
          { key: 'address', label: 'Bettor', sortVal: 1, render: (r) => h('div.row', { style: { gap: '6px' } }, bettorLink(r.address, 5), U.copyBtn(r.address)) },
          // open: Meridian's Open Positions where the snapshot counts them (one per pick configuration and side with tokens
          // still held), else (an older snapshot) the undecided predictions
          { key: 'n', label: 'Predictions', num: true, sortVal: 1, render: (r) => { const o = r.openPos != null ? r.openPos : r.open; return h('span', U.fmtNum(r.n, 0), o ? h('span.dim.xs', { title: r.openPos != null ? `${o} open position${o === 1 ? '' : 's'} as Meridian counts them: one per pick configuration and side with tokens still held (bets on the same picks share one; a position sold out is none)` + (r.open !== r.openPos ? ` · ${r.open} undecided prediction${r.open === 1 ? '' : 's'}` : '') : 'Undecided predictions' }, ' (' + o + ' open)') : null); } },
          { key: 'wagered', label: 'Wagered', num: true, sortVal: 1, render: (r) => usd(r.wagered, { compact: true }) },
          { key: 'pnl', label: 'Net PnL', num: true, sortVal: 1, render: (r) => pnlEl(r.pnl) },
          { key: 'roi', label: 'ROI', num: true, sortVal: 1, title: 'Net PnL ÷ the stakes of decided predictions (claimed or not), plus the sold share of open predictions\' stakes', render: (r) => UI.pct(r.roi, { dp: 0 }) },
          // (by result, whoever claimed: a prediction whose tokens it sold before the verdict counts too, its sale in Net PnL)
          { key: 'winRate', label: 'Win rate', num: true, sortVal: 1, title: WIN_COL_TITLE + '. Predictions whose tokens it sold before the verdict count by their result (the sale is in Net PnL)', render: winCell },
          { key: 'avgOdds', label: 'Avg odds', num: true, sortVal: 1, title: 'Average locked odds, stake ÷ (stake + maker collateral), over all its predictions, open ones included', render: (r) => pct(r.avgOdds, 0) },
          { key: 'combos', label: 'Combos', num: true, sortVal: 1, title: 'Share of its predictions with two or more legs', render: (r) => U.fmtPct((r.combos / r.n) * 100, { dp: 0 }) },
          // vigN: how many predictions the average covers (older snapshots have none: no title)
          { key: 'avgVig', label: 'Avg vig paid', num: true, sortVal: 1, title: 'Locked odds minus the Polymarket price at the moment of the bet, averaged over this bettor\'s singles and its combos with every leg on a different match', render: (r) => h('span', { title: r.vigN != null ? `Average of ${r.vigN} of ${r.n} predictions: those with a Polymarket price at bet time for every leg; combos with legs on the same match or asset left out` : null }, vigCell(r.avgVig)) },
          { key: 'biggestWin', label: 'Best win', num: true, sortVal: 1, title: 'Largest net result on one decided prediction, claimed or not: payout − stake, or for a position traded on the secondary market, the bettor\'s own result with the sale', render: (r) => (r.biggestWin > 0 ? usd(r.biggestWin) : h('span.dim', '—')) },
          { key: 'cat', label: 'Top category', title: 'The category with the most predictions (a tie goes to the larger stake). Mixed: a combo with legs in more than one category.', render: (r) => r.topCat || '—' },
          { key: 'last', label: 'Last bet', sortVal: 1, title: 'When this wallet last placed a prediction', render: (r) => h('span.dim', U.fmtAgo(r.last)) },
        ], rows: slice, empty: 'No bettors match', onRow: (r) => { location.hash = bettorUrl(r.address).slice(1); } }),
          UI.pager({ page: st.page, pageSize: PAGE, total, onPage: (p) => { st.page = p; render(); wrap.scrollIntoView({ block: 'start' }); } }));
        // "364 of 733 bettors · 3+ predictions": the count is of the filtered board, and the filters say so (a full address ignores them)
        const filt = full ? [] : [st.minN > 1 ? `${st.minN}+ predictions` : '', st.cat ? 'top category ' + st.cat : '', st.q ? 'address search' : ''].filter(Boolean);
        U.replace(summary, `${U.fmtNum(total, 0)} of ${U.fmtNum(all.length, 0)} bettors` + (filt.length ? ' · ' + filt.join(' · ') : '') + ' · ' + snapNote(snap));
      }
      U.replace(body, controls, h('div.card.tight', wrap), h('div.footer-note', 'Net PnL counts every decided prediction, claimed or not: a win earns the maker\'s collateral, a loss costs the stake' + (snap.agg.secondary ? ', and a position sold on the secondary market counts at its sale' : '; secondary-market sales are not counted in this view') + '. Open positions still held are excluded.'));
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
  // Polymarket's order book: the chance Meridian's app shows for a question is the midpoint of its YES token on
  // Polymarket's CLOB while no older than two minutes (Gamma's outcome price, which the resolution tracker loads, is the
  // last trade and can sit points away in a live match: 36.5 % against the app's 39 %). Kept per token; asked again
  // after a minute at most, by whichever list is on screen.
  const MID_FRESH_MS = 2 * 60000, MID_ASK_MS = 60000;
  const mids = new Map();   // YES token → { p, at }
  const yesToken = (id) => { const m = id ? R.get(id).m : null; return m && !m.closed && m.tokens && m.tokens[0] ? String(m.tokens[0]) : null; };
  const midNow = (id) => { const t = yesToken(id); const x = t && mids.get(t); return x && x.p != null && Date.now() - x.at <= MID_FRESH_MS ? x.p : null; };
  /** Ask the midpoints of these questions' YES tokens (their Polymarket markets loaded first, R.load); true when any came. */
  async function loadMids(ids, signal) {
    const now = Date.now();
    const want = Array.from(new Set((ids || []).map(yesToken).filter(Boolean))).filter((t) => { const x = mids.get(t); return !x || now - x.asked > MID_ASK_MS; });
    if (!want.length) return false;
    for (const t of want) mids.set(t, Object.assign(mids.get(t) || { p: null, at: 0 }, { asked: now }));
    let got = {}; try { got = await P.midpoints(want, { signal }); } catch (e) { if (isAbort(e)) throw e; return false; }
    for (const [t, p] of Object.entries(got)) mids.set(t, { p, at: Date.now(), asked: now });
    return Object.keys(got).length > 0;
  }
  // YES now: the CLOB midpoint (as the app), else Polymarket's last price (Gamma), else the estimatedPrice Meridian's API
  // reported, which stops following the market once a game starts
  const probNow = (c) => { const mid = midNow(qId(c)); if (mid != null) return { p: mid, live: true }; const m = R.get(qId(c)).m; if (m && m.prices && m.prices.length && Number.isFinite(m.prices[0])) return { p: m.prices[0], live: true }; const ep = c.ep != null ? c.ep : c.estimatedPrice; return ep == null ? null : { p: Number(ep), live: false }; };
  // a settled question shows its result, not a price; a price in whole percent, as Meridian's app rounds it
  const probCell = (c) => { const v = qView(c); if (v.settled) return h('span.dim', v.nd ? 'resolved 50/50' : v.yes === true ? 'resolved YES' : v.yes === false ? 'resolved NO' : 'settled'); const x = probNow(c); return probBar(x && x.p, x && (x.live ? 'Polymarket now: ' : 'Meridian estimate (may lag): '), 0); };
  /** A question's volume over a window ('24h' / '7d') as Meridian's app shows it on its list cards sorted Hot / Top (the
   *  Filtered window: low-odds trading left out, its lists' default; P.questionVolume), in its format (P.fmtVol); every
   *  trade (the site's figure) and the all-time volume in the title. A row from an older snapshot has only every trade. */
  const volCell = (c, win) => {
    const v = P.questionVolume(c), app = win === '24h' ? v.d24 : v.d7, raw = win === '24h' ? v.raw24 : v.raw7, x = app != null ? app : raw;
    if (!x) return h('span.dim', '—');
    return h('span', { title: app != null ? `As Meridian's app shows it on a list card sorted ${win === '24h' ? 'Hot' : 'Top'}: the mirrored Polymarket market's volume over the last ${winText(win)}, low-odds trading left out. Site's figure, every trade: ${P.fmtVol(raw)}` + (v.all != null ? ` · all time ${P.fmtVol(v.all)} (the app's question page)` : '')
      : `Every trade on the mirrored Polymarket market over the last ${winText(win)} (this snapshot predates the figure Meridian's app shows)` }, P.fmtVol(x));
  };
  const winText = (win) => (win === '24h' ? '24 hours' : '7 days');
  const volColTitle = (win) => `Volume on the mirrored Polymarket market over the last ${winText(win)}, as Meridian's app shows it on its list cards sorted ${win === '24h' ? 'Hot' : 'Top'}: low-odds trading left out. A figure's tooltip has every trade, and the all-time volume`;
  const PROB_TITLE = 'The chance of YES now as Meridian\'s app shows it: the midpoint of Polymarket\'s order book, rounded to a whole percent; until that has loaded, Polymarket\'s last price, else Meridian\'s own estimate, which stops moving once a game starts. Settled questions show their result';
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
      // the bettor's side, as it stood: a bettor who sold its position tokens has no payout of its own to claim (h in the file)
      if (n.decided) { const held = n.held == null ? 1 : n.held; if (!(held < 0.999)) return resultChip(n, false, held); const all = held < 1e-6, pays = n.won || n.nd; return h('span', resultChip(n, false, held), ' ', h('span.chip.amber', { title: (all ? 'The bettor sold its position tokens before the verdict' : `The bettor sold ${U.fmtPct((1 - held) * 100, { dp: 0 })} of its position tokens before the verdict`) + (pays ? (all ? ': the payout is the buyer\'s to claim' : ': that share of the payout is the buyer\'s') : '') }, all ? 'sold' : U.fmtPct((1 - held) * 100, { dp: 0 }) + ' sold')); }
      // undecided: as Meridian's app shows it, open until Meridian settles its legs, the source markets' verdict in the title
      return undecidedChip(n, false) || UI.chip('open', 'accent');
    };
    // the mirrored Polymarket market's all-time volume, as the question's page in Meridian's app shows it ("$16.99M Vol";
    // a snapshot row from before it, or one the snapshot added from open predictions, has none)
    const vAll = P.questionVolume(c).all;
    const volEl = vAll ? h('span.small', { title: 'All-time volume on the mirrored Polymarket market, as the question\'s page in Meridian\'s app shows it' }, P.fmtVol(vAll) + ' Vol') : null;
    const render = () => { const st = R.state(view, id); U.replace(body,
      h('div.row.wrap', { style: { gap: '8px', marginBottom: st.sub ? '2px' : '10px' } }, R.chip(view, id), h('span.small', st.main || ''), h('span.grow'), volEl, h('span.dim.small', `${file.total} prediction${file.total > 1 ? 's' : ''} on this question${file.total > preds.length ? ' · newest ' + preds.length + ' shown' : ''}`)),
      st.sub ? h('div.xs.dim', { style: { marginBottom: '10px' } }, st.sub) : null,
      h('div.card.tight', UI.table({ cols: [
        { key: 'b', label: 'Bettor', render: (n) => bettorLink(n.predictor) },
        { key: 't', label: 'Placed', render: (n) => h('span.dim', U.fmtDateTimeS(n.t)) },
        { key: 'legs', label: 'Legs', render: (n) => h('div', { style: { whiteSpace: 'normal', minWidth: '260px', maxWidth: '460px', lineHeight: '1.35' } }, n.picks.map((k) => h('div', { class: k.id === id ? 'bold' : '' }, sideChip(k.yes), ' ', k.q, ' ', legState(k, n)))) },
        { key: 's', label: 'Stake', num: true, render: (n) => usd(n.stake) },
        { key: 'o', label: 'Odds', num: true, render: (n) => h('span', oddsPct(n.odds), h('span.dim.xs', ' ' + mult(n.multiple))) },
        // a loss pays the bettor nothing, as Meridian's app shows it ($0.00), the pool it missed in the tooltip
        { key: 'p', label: 'Pays', num: true, render: (n) => ((n.decided && !n.won && !n.nd) || appPending(n) === 'lost' ? h('span', { title: `Missed payout ${cents(n.pool)}: the stake plus the maker's collateral, which goes to the market maker` }, cents(0)) : usd(n.pool)) },
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
    // a win whose question Meridian has not settled (0x73f05a88…, the $1 test against 0x3106…: Flamengo's league title,
    // paid ten minutes after the bet while the market runs to December): paid, but no result for the leg itself
    if (n.won && !k.settled && !n.partial) return { label: 'paid as won', tone: 'green', text: 'Meridian resolved and paid this prediction as won, but has not settled this question' };
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
  /** Where an undecided prediction stands from its legs: 'lost' once any leg went against the bettor (Meridian's result,
   *  else the source market's, 50/50 included), 'won' once every leg went its way, else null. Not Meridian's app's status
   *  (appPending: Meridian's own legs only), so it is said in titles only (sourceNote). */
  const pendingVerdict = (n) => {
    if (!n || n.decided || !n.picks.length) return null;
    if (n.picks.some(legAgainst)) return 'lost';
    if (n.partial || n.firstLegOnly || n.picks.length < n.legs) return null;   // a record holding only its first leg cannot show every leg won
    const legWon = (k) => {
      if (k.settled && !k.nonDecisive && (k.resolvedToYes === true || k.resolvedToYes === false)) return k.resolvedToYes === !!k.yes;
      const m = k.id ? R.get(k.id).m : null; if (!m || !(m.closed || m.uma === 'resolved')) return false;
      const y = R.resolvedYes(m); return (y === true || y === false) && y === !!k.yes;
    };
    return n.picks.every(legWon) ? 'won' : null;
  };
  /** Where an undecided prediction stands as Meridian's app shows it: its status comes from the legs Meridian has settled
   *  only ('lost' once one went against the bettor, 50/50 included; 'won' once every leg settled its way), else it is
   *  Open (a "Live" slip) whatever the source markets say. */
  const appPending = (n) => {
    if (!n || n.decided || !n.picks.length) return null;
    const onMeridian = (k) => k.settled && (k.nonDecisive || k.resolvedToYes === true || k.resolvedToYes === false);
    if (n.picks.some((k) => onMeridian(k) && (k.nonDecisive || k.resolvedToYes !== !!k.yes))) return 'lost';
    if (n.partial || n.firstLegOnly || n.picks.length < n.legs) return null;
    return n.picks.every((k) => onMeridian(k) && !k.nonDecisive && k.resolvedToYes === !!k.yes) ? 'won' : null;
  };
  /** Its chip (pv from appPending: Meridian's own legs); asMaker: from the maker's side, whose result is the bettor's turned round. */
  const pendingChip = (pv, asMaker) => ((pv === 'lost') !== !!asMaker ? h('span.chip.red', { title: 'A leg has settled against the bettor on Meridian; the prediction itself is not settled yet' }, 'lost · awaiting settlement') : h('span.chip.green', { title: 'Every leg has settled in the bettor\'s favour on Meridian; the prediction itself is not settled yet' }, 'won · awaiting settlement'));
  /** What the source markets already say about an undecided prediction Meridian still shows as open (pendingVerdict where
   *  appPending has nothing), from one side, for a title: the site no longer shows it as lost or won (the app does not). */
  const sourceNote = (pv, n, asMaker) => (pv === 'lost'
    ? `On Polymarket a leg has already resolved against the bettor's pick (50/50 counts as a loss on Meridian), so ${asMaker ? 'the market maker wins' : 'the bettor loses the stake'} once Meridian settles that leg. Until then Meridian's app shows the prediction as open.`
    : `Every leg has resolved in the bettor's favour on Polymarket, so it pays ${cents(n.pool)} ${asMaker ? 'to the bettor ' : ''}once Meridian settles them. Until then Meridian's app shows the prediction as open.`);
  /** An undecided prediction's chip as Meridian's app shows it: Meridian's own legs' verdict (pendingChip), else open, with
   *  the source markets' verdict, if any, in its title; null when there is neither (the caller's own open chip). */
  const undecidedChip = (n, asMaker) => { const av = appPending(n); if (av) return pendingChip(av, asMaker); const pv = pendingVerdict(n); return pv ? h('span.chip.accent', { title: sourceNote(pv, n, asMaker) }, 'open') : null; };
  /** When a leg was settled: Meridian's own settlement time, else its source market's resolution once loaded, else its
   *  listed end (which can be a day late: a price question about Sep 28 is listed to end on the 29th). */
  const legTime = (k) => { if (k.settledAt) return k.settledAt; const m = k.id ? R.get(k.id).m : null; return (m && (m.resolvedAt || m.closedAt)) || U.num(k.endTime) || null; };
  /** When a decided prediction was settled, for display, never when its payout was claimed; null when it cannot be told.
   *  Meridian's leg settlement times where the record has them (P.legVerdictAt), else the snapshot's time, else: a win
   *  dates from its last leg, a loss from the first leg that went against the bettor (its other legs may run for weeks),
   *  never after the claim. An estimate before the bet (a listed end from before it, as on 0x73f05a88…) dates nothing. */
  const decidedTime = (n) => {
    if (!n.decided) return null;
    const exact = P.legVerdictAt(n) || n.decidedAt; if (exact) return exact;
    const times = (n.won ? n.picks : n.picks.filter(legAgainst)).map(legTime).filter(Boolean);
    if (!times.length) return null;
    const at = n.won ? Math.max(...times) : Math.min(...times);
    if (at < U.num(n.t)) return null;   // only a listed end from before the bet: nothing dates the verdict
    return Math.min(at, n.settledAt || Infinity, Date.now());
  };
  /** The bettor's hold on its position tokens: the share it still held at the verdict and its own result with the sale,
   *  from the caller's ledger (opts.held / opts.ledgerPnl: a bettor page) or the record's (the snapshot's h / lp). */
  function ownership(n, opts = {}) {
    const held = opts.held != null ? opts.held : n.held != null ? n.held : 1;
    const soldAll = held < 1e-6;
    return { held, ownPnl: opts.ledgerPnl != null ? opts.ledgerPnl : n.tradedPnl, soldAll, soldPart: !soldAll && held < 0.999, soldPct: U.fmtPct((1 - held) * 100, { dp: 0 }) };
  }
  /** A question the snapshot has a file for (money still on it, then the questions of the most recently settled
   *  predictions, about 1,200 in all): its row. */
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
      const payout = cents(n.pool), stake = cents(n.stake);
      // the bettor's position tokens: the share it still held at the verdict and its own result, the sale included (from
      // the caller's ledger, else the snapshot's); a bettor who sold them does not collect the payout
      const { held, ownPnl, soldAll, soldPart, soldPct } = ownership(n, opts);
      // undecided, but the legs Meridian has settled already tell (a leg went against the bettor, or every leg its way), as
      // Meridian's app reads them (appPending); a verdict on the source markets alone leaves it open, as in the app, and
      // is said in the chip's title (undecidedChip)
      const pv = appPending(n);
      const lostNow = (n.decided && !n.won && !n.nd) || pv === 'lost';   // the bettor's, as the app shows it: Loss
      // one wallet on both sides: it nets to zero and is left out of every Predict figure (P.selfMatch)
      const self = P.selfMatch(n);
      // the result chip says won or lost; the sentence says what was paid, never "won <payout>" (the slip page and the
      // cards call the net result "won")
      const what = !n.decided
        ? (pv === 'lost' ? 'lost: a leg has settled against the bettor\'s pick on Meridian; the prediction itself is not settled yet'
          : pv === 'won' ? `every leg has settled in the bettor's favour on Meridian: it pays ${payout} on a ${stake} stake once the prediction is settled`
            : `pays ${payout} on a ${stake} stake if ${n.legs > 1 ? 'every leg wins' : 'it wins'}`)
          + (soldAll ? (pv === 'lost' ? ' · the bettor has sold its tokens' : ', to whoever holds its tokens: the bettor sold them') : soldPart ? ` · the bettor has sold ${soldPct} of its tokens` : '')
        : n.won ? `${payout} paid on a ${stake} stake` + (soldAll ? ' · the bettor had sold its tokens: the payout goes to the buyer' : soldPart ? ` · the bettor had sold ${soldPct} of its tokens` : '')
          : n.nd ? 'void: the stake goes back to the bettor'
            : `lost the ${stake} stake to the market maker` + (soldAll ? ' · the bettor had sold its tokens before the verdict' : soldPart ? ` · the bettor had sold ${soldPct} of its tokens` : '');
      const decidedAt = decidedTime(n);
      const kv = (k, v) => (v == null ? null : [h('div.k', k), h('div', v)]);
      const who = (a) => h('div.row', { style: { gap: '6px' } }, bettorLink(a, 6), U.copyBtn(a));
      const traded = opts.traded || n.pcTraded || opts.held != null || n.held != null;
      // the bettor made no sale of its own: its ledger share is known and whole, or it has no ledger entry on these picks
      // (its own bettor page found none; a snapshot record carries h whenever the bettor traded, in the question and
      // wallet files too)
      const keptAll = traded && !soldAll && !soldPart && (opts.held != null || n.held != null || (opts.here ? opts.here === n.predictor : true));
      // a one-off counterparty (P.MAKER_MIN) is no market maker; without the snapshot (a slip page opened directly) the
      // plain 'Counterparty' is never wrong
      const makerRow = P._snap && P._snap.agg ? P._snap.agg.makers.find((r) => r.address === n.counterparty) : null;
      // claimed or not: where the winner's token balance is known (n.toClaim: its own wallet page, or a snapshot that read
      // the balances), by that, as Meridian's app counts a payout to claim (0x67b3…: settled on Meridian, its 1,055.18
      // winning tokens still held: not claimed); else by the API's settled flag
      const tc = n.toClaim != null && !n.nd ? n.toClaim : null;
      const claimedAt = n.settled && n.settledAt ? U.fmtDateTime(n.settledAt) : null;
      U.replace(body,
        h('div.row.wrap', { style: { gap: '8px', marginBottom: '12px' } }, (!n.decided && undecidedChip(n, false)) || resultChip(n, false, held), h('span', U.capitalize(what)), h('span.grow'),
          // an open slip can be copied: Meridian's page for it (Add To Slip), under the site's referral code
          slipOpen(n) ? h('a.btn.sm.primary', { href: P.meridianSlipUrl(n.id), target: '_blank', rel: 'noopener', title: 'Opens this slip on Meridian Predict: press Add To Slip there, choose your amount and place it' }, U.icon('external'), 'Copy slip to Meridian') : null,
          n.predictor && n.predictor !== opts.here ? h('a.btn.sm', { class: slipOpen(n) ? '' : 'primary', href: bettorUrl(n.predictor), title: 'Every prediction of this bettor, its PnL and open positions' }, U.icon('account'), 'Open bettor\'s account') : null,
          P.isPredictionId(n.id) && !n.partial ? h('button.btn.sm.ghost', { type: 'button', title: 'A link that shows this slip\'s card in Discord, X, Telegram…, and the card as an image', onclick: () => shareSlip(n) }, U.icon('share'), 'Share') : null,
          P.isPredictionId(n.id) ? h('a.btn.sm.ghost', { href: '#/predict/p/' + n.id.toLowerCase(), title: 'This prediction on its own slip page' }, U.icon('ticket'), 'Slip page') : null,
          n.tx ? h('a.btn.sm.ghost', { href: U.explorerTx(n.tx), target: '_blank', rel: 'noopener', title: 'The transaction that placed it' }, U.icon('external'), 'Transaction') : null),
        h('div.stats', { style: { marginBottom: '14px' } },
          UI.stat('Stake', stake),
          // a loss pays the bettor nothing: $0.00, as Meridian's app shows a lost prediction's payout, the pool it missed in
          // the tooltip (decided, or lost on a leg Meridian has settled)
          lostNow ? UI.stat('Payout', h('span', { title: `Missed payout ${payout}: the stake plus the maker's collateral, which ${n.decided ? 'went' : 'goes'} to the market maker` }, cents(0)), n.decided ? 'the pool went to the market maker' : 'the pool goes to the market maker')
            : UI.stat('Payout', payout, n.decided ? (n.won ? (soldAll ? 'to the token buyer' : soldPart ? `${U.fmtPct(held * 100, { dp: 0 })} to the bettor` : 'to the bettor') : 'split back') : 'if it wins'),
          UI.stat('Odds', oddsPct(n.odds), mult(n.multiple) + ' the stake'),
          // a self-match moves no money: the wallet's two sides cancel out
          self ? UI.stat('Wallet PnL', cents(0), n.decided ? 'bettor ' + cents(n.pnl, { sign: true }) + ', maker ' + cents(-n.pnl, { sign: true }) + ': the same wallet' : 'the same wallet on both sides')
            : ownPnl != null && (n.decided || soldAll || soldPart) ? UI.stat(n.decided ? 'Bettor PnL' : 'Bettor PnL so far', cents(ownPnl, { sign: true }), 'incl. selling its tokens · ' + (n.decided ? cents(n.pnl, { sign: true }) + ' had it kept them' : pv === 'lost' ? cents(-n.stake, { sign: true }) + ' had it kept them' : cents(n.cp, { sign: true }) + ' had it kept them and won'), U.pnlClass(ownPnl))
              : n.decided ? UI.stat('Bettor PnL', cents(n.pnl, { sign: true }), n.won ? 'payout − stake' : null, U.pnlClass(n.pnl))
                // lost on its legs, only the settlement pending: what the bettor stands to lose, not what it could win
                : pv === 'lost' ? UI.stat('Bettor PnL', cents(-n.stake * held || 0, { sign: true }), (held < 0.999 ? 'on the tokens it still holds, ' : '') + 'once the prediction is settled', 'neg')
                  : UI.stat('To win', cents(n.cp * held, { sign: true }), held < 0.999 ? 'on the tokens it still holds' : 'the maker\'s collateral'),
          UI.stat('Vig', n.vig == null || self ? '—' : pp(n.vig), self ? 'not counted: one wallet on both sides' : 'odds vs Polymarket at bet time' + (n.sameEvent ? ' · some legs on one match or asset' : ''))),
        h('div.kv', { style: { marginBottom: '14px' } },
          kv('Bettor', who(n.predictor)), kv(makerRow && P.isMarketMaker(makerRow.n) ? 'Market maker' : 'Counterparty', n.counterparty ? who(n.counterparty) : null),
          kv('Note', self ? 'Self-matched: the same wallet is the bettor and the market maker, so it nets to zero. It is left out of the Predict figures (totals, leaderboards, vig, the wallet\'s own page and the Questions page).' : null),
          kv('Placed', U.fmtDateTimeS(n.t) + ' · ' + U.fmtAgo(n.t)),
          kv('Settled', decidedAt ? h('span', { title: 'When the slip settled on Meridian, claimed or not: a win when its last leg settled, a loss when the first leg settled against the bettor (each leg at Meridian\'s own settlement time where known, else its Polymarket resolution or listed end)' }, U.fmtDateTime(decidedAt)) : null),
          n.won || n.nd ? kv('Paid out', tc === true ? 'not claimed yet' + (claimedAt ? ` (settled on Meridian ${claimedAt}, the winning tokens still held)` : '')
            : tc === false ? (claimedAt ? 'claimed ' + claimedAt : soldAll ? 'the buyer\'s to claim' : 'claimed: the bettor no longer holds the winning tokens')
              : claimedAt ? 'claimed ' + claimedAt : n.unclaimed ? (soldAll ? 'the buyer\'s to claim' : 'not claimed yet') : null)
            : kv('Claimed', tc === true ? 'not yet by the market maker' : claimedAt ? 'by the market maker, ' + claimedAt : tc === false ? 'by the market maker' : null),
          kv('Category', n.cat || null),
          kv('Secondary market', soldAll ? 'the bettor sold all its position tokens before the verdict' : soldPart ? `the bettor sold ${soldPct} of its position tokens before the verdict`
            : !traded ? null
              : keptAll ? 'other wallets traded position tokens on these picks; this bettor sold none of its own'
                // the bettor's own trading is not known here (a maker's page): a lost prediction has no payout to share
                : n.decided && !n.won ? 'position tokens on these picks changed hands before the verdict'
                  : 'position tokens on these picks changed hands before the verdict, so part of the payout may have gone to a buyer')),
        h('div.card.tight', UI.table({ cols: [
          { key: 's', label: 'Pick', render: (k) => sideChip(k.yes) },
          { key: 'q', label: n.legs > 1 ? 'Leg' : 'Question', render: (k) => { const q = snapQuestion(k.id); return h('div', { style: { whiteSpace: 'normal', minWidth: '220px', maxWidth: '520px', lineHeight: '1.3' } },
            // a plain click opens the question's dialog; a new tab or a copied link opens the Questions page on it
            q ? h('a', { href: '#/predict/questions?status=all&q=' + encodeURIComponent(k.q || ''), title: 'Every prediction on this question', onclick: (e) => { if (e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; e.preventDefault(); openQuestion(q, ctx); } }, k.q) : k.q,
            // a settled leg dates from its settlement; an open one shows the end Meridian lists, which is no betting
            // cutoff (Meridian has taken bets after it) and can be long before the question resolves
            k.settled ? h('div.xs.dim', 'settled on Meridian' + (k.settledAt ? ' ' + U.fmtDateTime(k.settledAt) : '')) : k.endTime ? h('div.xs.dim', 'listed end ' + U.fmtDateTime(k.endTime)) : null); } },
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
  // the app works with the domain swapped). One prediction as a card, and a way to copy it into Meridian Predict under
  // the site's referral code: Meridian's page for the prediction, whose Add To Slip adds the same picks to the
  // visitor's bet slip.
  // =====================================================================
  /** A leg this page no longer offers to copy: past the end time Meridian lists for it (no betting cutoff: Meridian has
   *  taken bets after it, but the page stops there), settled on Meridian, or its source market closed. */
  const legClosed = (k, now) => (!!k.endTime && k.endTime <= now) || !!k.settled || !!(k.id && R.get(k.id).m && R.get(k.id).m.closed);
  /** Does this page still offer to copy the slip: undecided, with no leg past its listed end time, settled or closed. */
  function slipOpen(n) { const now = Date.now(); return !!n && !n.decided && !n.partial && !!n.picks.length && !n.picks.some((k) => legClosed(k, now)); }
  /** A leg whose game has finished (Polymarket's game feed): its result is known though Meridian may still take bets. */
  const gameOver = (k) => { const m = k.id ? R.get(k.id).m : null; return !!(m && m.ended); };
  /** An idea worth showing: the slip is still offered and none of its games has finished. */
  const ideaOpen = (n) => slipOpen(n) && !n.picks.some(gameOver);
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
  /** The pick's chance now, { p, live }: 1 or 0 once its question is settled on Meridian (a 50/50 is a loss) or resolved
   *  on Polymarket; else the order book's midpoint as Meridian's app shows it (midNow, while fresh), else Polymarket's
   *  last price once loaded and open; else (live false) the snapshot's estimate (k.ep, Meridian's estimatedPrice, which
   *  freezes once a game starts). */
  const pickNow = (k) => {
    if (k.settled && (k.nonDecisive || k.resolvedToYes === true || k.resolvedToYes === false)) return { p: !k.nonDecisive && k.resolvedToYes === !!k.yes ? 1 : 0, live: true };
    const m = k.id ? R.get(k.id).m : null;
    if (m && (m.closed || m.uma === 'resolved')) { const y = R.resolvedYes(m); if (y === 'void') return { p: 0, live: true }; if (y === true || y === false) return { p: y === !!k.yes ? 1 : 0, live: true }; }
    const mid = midNow(k.id);
    const live = mid != null || !!(m && m.prices && m.prices.length && Number.isFinite(m.prices[0]) && !m.closed);
    const yes = mid != null ? mid : live ? m.prices[0] : k.ep;
    return { p: yes == null ? null : k.yes ? yes : 1 - yes, live };
  };
  const pickProb = (k) => pickNow(k).p;
  /** Whether pickProb has the leg's result or Polymarket's live price, not the snapshot's estimate. */
  const pickLive = (k) => pickNow(k).live;
  /** A position's chance from its legs' stored estimates, a settled leg counting as won or lost; null while a leg has none. */
  const legNow = (k) => (k.settled ? (!k.nonDecisive && k.resolvedToYes === !!k.yes ? 1 : 0) : k.ep == null ? null : k.yes ? k.ep : 1 - k.ep);
  const winProb = (picks) => (picks.length && picks.every((k) => legNow(k) != null) ? picks.reduce((p, k) => p * legNow(k), 1) : null);
  // live false: Polymarket has not answered (yet), so the chance is Meridian's estimate from the snapshot (pickNow)
  const gauge = (p, live) => h('span.gauge-wrap', { title: live ? 'Polymarket now: the chance of this pick (its order book\'s midpoint, as Meridian\'s app shows it, once loaded)' : 'Meridian\'s estimate from the snapshot (Polymarket not loaded)' }, h('i.gauge', { style: { background: `conic-gradient(var(--green) ${Math.round(U.clamp(p, 0, 1) * 360)}deg, var(--bg-5) 0)` } }), pct(p, 0));
  const slipHowTo = () => h('div.slip-note', 'Copying opens this slip on Meridian Predict. Press ', h('b', 'Add To Slip'), ' there: its picks join whatever is already in your Meridian slip (clear that first to place exactly this one). Choose your amount and place it; Meridian\'s market makers quote fresh odds, so yours can differ from the ones locked here.');
  const slipBrand = () => h('span.slip-brand', 'Meridian', h('span', 'DataHub'));

  async function mountSlip(body, route, ctx) {
    MD.setTopbar(h('span.title', 'Predict · Slip'));
    const id = route.path.split('/')[3] || '';
    if (!id) { U.replace(body, slipForm()); return; }
    if (!P.isPredictionId(id)) { U.replace(body, h('div.card', h('div.error', 'That is not a prediction id. A slip link ends in 0x and 64 hex digits, as in app.meridian.xyz/predict/p/0x…')), slipForm()); return; }
    U.replace(body, loadingCard('Loading the slip…'));
    let found;
    try { found = await findPrediction(id, ctx.signal); } catch (e) { if (!isAbort(e)) U.replace(body, UI.error(e, () => MD.router.reload())); return; }
    if (ctx.signal.aborted) return;
    if (!found.n) {
      // not in the snapshot (placed since it was built, a launch-day test the builder leaves out, or no prediction at
      // all: nothing here checks that the id exists), or the snapshot's slip file could not be read: Meridian's own
      // page can open it either way, if it is a real prediction
      U.replace(body, h('div.slip-wrap', h('div.slip',
        h('div.slip-head', slipBrand(), h('span.grow'), UI.chip(found.unavailable ? 'slip files unavailable' : 'not in the snapshot', 'amber')),
        h('p.muted', { style: { margin: 0 } }, found.unavailable
          ? 'The snapshot\'s slip files could not be read just now (they are published with the snapshot every 30 minutes). Try again in a moment, or open the slip on Meridian:'
          : `This prediction id is not in the published snapshot${found.builtAt ? ' (built ' + U.fmtAgo(found.builtAt) + ', refreshed every 30 minutes)' : ''}. A prediction placed since then appears with the next snapshot (launch-day test predictions are left out). If the id is a real prediction, Meridian's own page shows it:`),
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
    // a bettor who traded its tokens did not make payout − stake (the card shows its own result), and a self-match made
    // nothing; "pays", not "to win": the dialog's "To win" is the profit, this is the payout
    const post = P.selfMatch(n) ? `A ${mult(n.multiple)} ${combo} on Meridian Predict, self-matched (one wallet on both sides)`
      : st === 'won' ? (n.tradedPnl != null ? `A ${mult(n.multiple)} ${combo} that won on Meridian Predict` : `Won ${usd(n.pnl, { sign: true })} on a ${usd(n.stake)} ${combo} on Meridian Predict (${mult(n.multiple)})`)
        : st === 'open' ? `A ${usd(n.stake)} ${combo} at ${mult(n.multiple)} on Meridian Predict: pays ${usd(n.pool)} if ${n.legs > 1 ? 'every leg wins' : 'it wins'}`
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
      // undecided, but the legs Meridian has settled already tell (a leg went against the bettor, or every leg its way), as
      // Meridian's app reads them (appPending); a verdict on the source markets alone leaves the slip live, as in the app
      // (its "Live Combo"), and is said in the titles (src); one wallet on both sides (P.selfMatch)
      const pv = appPending(n), self = P.selfMatch(n);
      const src = !n.decided && !pv ? pendingVerdict(n) : null, srcTitle = src ? sourceNote(src, n, false) : null;
      // a slip past a leg's listed end is no longer offered here, but nothing says Meridian stopped taking bets on it:
      // it awaits its result, it is not "closed"
      const state = n.decided ? (n.won ? UI.chip(own.soldAll ? 'won · sold' : 'won · ' + kind, 'green') : n.nd ? UI.chip('void', 'amber') : UI.chip(own.soldAll ? 'lost · sold' : 'lost · ' + kind, 'red'))
        : pv ? pendingChip(pv) : src ? h('span.chip.accent', { title: srcTitle }, 'live · ' + kind)   // the app's "Live Combo"
          : UI.chip(open ? 'live · ' + kind : 'awaiting result · ' + kind, open ? 'accent' : 'amber');
      // the result: what the bettor made once decided (its own, where it sold its position tokens), else what it pays
      const pnl = own.ownPnl != null ? own.ownPnl : n.pnl;
      // only a win has a payout for the token buyer (on a loss nobody is paid on the bettor's side; who bought the tokens,
      // often the maker itself, is not said)
      const sold = own.soldAll ? (!n.decided ? ' · the bettor has sold its tokens' : n.won ? ' · the bettor had sold its tokens: the payout goes to the buyer' : ' · the bettor had sold its tokens before the verdict')
        : own.soldPart ? ` · the bettor ${n.decided ? 'had' : 'has'} sold ${own.soldPct} of its tokens` : '';
      const selfNote = !self ? '' : n.decided ? ' · self-matched: the same wallet was the market maker, so it nets to $0 and is left out of the Predict figures' : ' · self-matched: the same wallet is the market maker';
      const ownLabel = own.ownPnl != null ? ' · the bettor\'s PnL, incl. selling its tokens' : '';
      // not claimed: the bettor still holds its winning tokens where the snapshot read them (tc), else the API's flag
      const unclaimedWin = n.toClaim != null ? n.toClaim : n.unclaimed && !own.soldAll;
      const [heroK, heroV, heroCls, heroS] = !n.decided
        // lost on its legs, only the settlement pending: what the bettor loses (its own result where it sold them all)
        ? (pv === 'lost' ? (own.soldAll && own.ownPnl != null ? ['Lost' + ownLabel, cents(own.ownPnl, { sign: true }), U.pnlClass(own.ownPnl)] : [own.soldPart ? 'Lost · on the tokens it still holds' : 'Lost', cents(-n.stake * own.held || 0, { sign: true }), 'neg'])
          .concat(`a leg settled against the bettor on Meridian; the prediction itself is not settled yet · it would have paid ${cents(n.pool)}` + sold)
          : ['Pays', cents(n.pool), '', (pv === 'won' ? 'every leg has settled in the bettor\'s favour on Meridian · the prediction itself is not settled yet' : `on a ${cents(n.stake)} stake, if ${n.legs > 1 ? 'every leg wins' : 'it wins'}`) + sold])
        : n.won ? [self ? 'Won · bettor side' : 'Won' + ownLabel, cents(pnl, { sign: true }), U.pnlClass(pnl), `${cents(n.pool)} paid on a ${cents(n.stake)} stake` + (unclaimedWin ? ' · not claimed yet' : '') + sold]
          : n.nd ? ['Void', cents(pnl, { sign: true }), '', 'the stake goes back to the bettor']
            : [self ? 'Lost · bettor side' : 'Lost' + ownLabel, cents(pnl, { sign: true }), U.pnlClass(pnl), `the ${cents(n.stake)} stake went to the market maker · it would have paid ${cents(n.pool)}` + sold];
      // the whole slip's chance on Polymarket now (legs as independent), against the odds this bettor locked; until
      // Polymarket answers, Meridian's estimates from the snapshot, and the labels say so
      const probs = n.decided ? [] : n.picks.map(pickProb);
      const fairNow = probs.length && probs.every((p) => p != null) ? probs.reduce((a, p) => a * p, 1) : null;
      const allLive = n.picks.filter((k) => !k.settled).every(pickLive);
      const decidedAt = decidedTime(n);
      const cell = (k, v, title) => h('div', { title: title || null }, h('div.k', k), h('div.v', v));
      const leg = (k) => {
        const o = legOutcome(k, n); const shut = legClosed(k, now); const p = shut || n.decided ? null : pickProb(k);
        // Meridian's end time is a listed end, not a cutoff (it has taken bets after it)
        const when = k.settled ? 'settled on Meridian' + (k.settledAt ? ' ' + U.fmtWhen(k.settledAt) : '') : !k.endTime ? null : k.endTime <= now ? 'listed end ' + U.fmtDateTime(k.endTime) : n.decided ? 'listed to end ' + U.fmtWhen(k.endTime) : shut ? 'closed on Polymarket' : 'listed end ' + U.fmtWhen(k.endTime);
        const meta = [k.fairAtBet != null ? pct(k.fairAtBet, 0) + ' at bet' : null, when, k.cat || null].filter(Boolean).join(' · ');
        return h('div.slip-leg',
          h('div.side', sideChip(k.yes)),
          h('div.q', h('div', k.q), meta ? h('div.meta', meta) : null),
          h('div.end', p != null ? gauge(p, pickLive(k)) : null, o ? h('span.chip', { class: o.tone, title: o.text }, o.label) : null));
      };
      const btnShare = (primary) => h('button.btn', { type: 'button', class: primary ? 'primary slip-copy' : 'slip-share', dataset: { focusKey: 'slip:share' }, title: 'A link that shows this slip\'s card in Discord, X, Telegram…, and the card as an image', onclick: () => shareSlip(n) }, U.icon('share'), primary ? 'Share this slip' : 'Share');
      U.replace(wrap, h('div.slip', { class: 'is-' + (n.decided ? (n.won ? 'won' : n.nd ? 'void' : 'lost') : 'open') },
        h('div.slip-head', slipBrand(), h('span.grow'), state),
        h('div.slip-hero', { title: srcTitle },
          h('div.k', heroK),
          h('div.v', { class: heroCls }, heroV),
          h('div.s', heroS + selfNote)),
        h('div.slip-strip',
          cell('Stake', cents(n.stake)),
          cell('Multiplier', mult(n.multiple), 'Payout ÷ stake'),
          cell('Odds', oddsPct(n.odds, 0), 'Locked odds: stake ÷ payout, the price of one USDe of payout'),
          n.decided ? cell('Settled', decidedAt ? U.fmtDate(decidedAt).replace(', ' + new Date().getFullYear(), '') : '—', decidedAt ? U.fmtDateTime(decidedAt) : null)
            : fairNow != null ? cell(allLive ? 'Polymarket now' : 'Estimate (snapshot)', oddsPct(fairNow, 0), (allLive ? 'The legs\' Polymarket prices now' : 'Meridian\'s estimated prices from the snapshot (Polymarket has not loaded)') + ', multiplied (as if independent), against the ' + oddsPct(n.odds) + ' locked')
              : cell('Placed', U.fmtAgo(n.t))),
        h('div.slip-legs-head', h('span', n.legs > 1 ? `${n.legs} legs` : '1 leg'), h('span.grow'), n.legs > 1 ? h('span', 'every leg must win') : null),
        h('div.slip-legs', n.picks.map(leg)),
        // (data-focus-key: a keyboard user's focus comes back to the button after a refresh redrew the card)
        open ? h('div.slip-cta', h('a.btn.primary.slip-copy', { href: P.meridianSlipUrl(n.id), target: '_blank', rel: 'noopener' }, U.icon('external'), 'Copy slip to Meridian Predict'), btnShare(false))
          : h('div.slip-cta', btnShare(true)),
        !open && !n.decided ? h('div.slip-note', { style: { textAlign: 'center' } }, `${closed} of its ${n.legs} leg${n.legs > 1 ? 's' : ''} ${closed === 1 ? 'has' : 'have'} passed Meridian's listed end time, settled on Meridian or closed on Polymarket, so this page no longer offers to copy it.`) : null,
        open ? slipHowTo() : null,
        h('div.slip-actions',
          h('button.btn.sm.ghost', { type: 'button', dataset: { focusKey: 'slip:details' }, title: 'Stake, odds, both sides, every leg and its resolution', onclick: () => openPrediction(n, ctx) }, U.icon('info'), 'Details'),
          n.predictor ? h('a.btn.sm.ghost', { href: bettorUrl(n.predictor), title: 'Every prediction of this bettor, its PnL and open positions' }, U.icon('account'), 'Bettor ' + U.shortAddr(n.predictor, 4)) : null,
          open ? null : h('a.btn.sm.ghost', { href: P.meridianSlipUrl(n.id), target: '_blank', rel: 'noopener', title: 'Meridian\'s page for this prediction' }, U.icon('external'), 'View on Meridian')),
        h('div.slip-note', { style: { textAlign: 'center' } }, 'Placed ' + U.fmtDateTime(n.t) + (builtAt ? ' · as of the snapshot built ' + U.fmtAgo(builtAt) : ''), builtAt ? UI.staleNote(builtAt) : null, n.decided ? '' : allLive ? ' · the chances are Polymarket\'s, live.' : ' · Polymarket has not loaded: the chances are Meridian\'s snapshot estimates.')));
    };
    render();
    // Polymarket for the legs still open: their chances now, and where each one stands; the minute's redraw waits while
    // a button in the card has the keyboard focus
    const ids = Array.from(new Set(n.picks.filter((k) => k.id && !k.settled).map((k) => k.id)));
    const kbdInside = () => { const a = document.activeElement; return !!a && a !== wrap && wrap.contains(a) && a.matches(':focus-visible'); };
    // (the markets, then their order books' midpoints: the chance as Meridian's app shows it)
    const refresh = () => R.load(ids, { signal: ctx.signal, deep: false }).then(() => { if (!ctx.signal.aborted && !kbdInside()) render(); return loadMids(ids, ctx.signal); }).then((ok) => { if (ok && !ctx.signal.aborted && !kbdInside()) render(); }).catch(() => {});
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
      // (Big wins are all decided: none of them can be copied)
      h('p.muted', { style: { margin: 0 } }, 'Paste a Meridian prediction link (app.meridian.xyz/predict/p/0x…) or its id to see the slip here and copy it. Or open a prediction under Live predictions on the ', h('a', { href: '#/predict' }, 'Overview'), ' whose legs are all still open and press Copy slip to Meridian; the ', h('a', { href: '#/copytrade' }, 'Copy trading'), ' page lists ideas from winning bettors this site still offers to copy.'),
      h('div.row', { style: { gap: '8px' } }, input, h('button.btn.primary', { type: 'button', onclick: go }, 'Show slip'))));
  }
  // =====================================================================
  // Ideas from winning bettors (mounted on the Copy trading page): slips this page still offers to copy, from bettors
  // whose record beats what their locked odds implied (P.IDEAS, P.ideas); each opens on Meridian. The snapshot writes
  // them to predict-ideas.json (a few KB, so the page does not load the Predict snapshot).
  // =====================================================================
  /** How often luck alone gives a record this good (b.luck = P.luckOf): "1 in 40" when rare, a percentage when not. */
  const luckText = (luck) => (luck == null ? '—' : luck < 1e-4 ? 'under 1 in 10,000' : luck < 0.2 ? '1 in ' + U.fmtNum(Math.floor(1 / luck + 1e-9), 0) : U.fmtPct(luck * 100, { dp: 0 }));   // rounded down: "1 in 10" means 1 in 10 or likelier to be luck
  const luckPhrase = (luck) => (luck < 1e-4 ? 'less than once in 10,000 times' : luck < 0.2 ? `about ${luckText(luck)} times` : `about ${luckText(luck)} of the time`);
  // the record's bets are clusters (P.aggregate's recordOf links predictions through shared questions, so a chain of
  // combos can make one bet); the PnL is something else, the bettor's over all its predictions, token trades included
  const recordText = (b) => `${U.fmtNum(b.n, 0)} decided bets${b.predictions > b.n ? ` (${U.fmtNum(b.predictions, 0)} predictions: those linked by a shared question, directly or through others, count as one bet)` : ''}, ${U.fmtNum(b.won, 0)} won where the locked odds implied ${U.fmtNum(b.expected, 1)}. PnL over all its predictions, position-token trades included: ${usd(b.pnl, { sign: true })}${b.roi != null ? ' (ROI ' + U.fmtPct(b.roi, { sign: true, dp: 0 }) + ' on its decided stake)' : ''}. If every bet had exactly the chance its odds priced, a record this good would come ${luckPhrase(b.luck)} by luck alone.`;
  // the record the cells show is Meridian's app's (P.ideas' appWon / appLost / appWinRate: its Positions Won / Lost and
  // Win Rate, each prediction once it is claimed); the record against the odds, which the chip and By luck rest on, goes
  // in the title. An ideas file from before the app's counts shows the record against the odds, as it did.
  const ideaApp = (b) => b.appWon != null;
  const ideaRecord = (b) => (ideaApp(b) ? `${U.fmtNum(b.appWon, 0)}W / ${U.fmtNum(b.appLost || 0, 0)}L · ${winPct(b.appWinRate)}` : `${U.fmtNum(b.won, 0)} of ${U.fmtNum(b.n, 0)} bets won`);
  const ideaTitle = (b) => (ideaApp(b) ? `Won / lost and win rate as Meridian's app counts them (Positions Won / Lost, Win Rate): every prediction, each once it is claimed; one decided but not claimed is still pending there. Site's record, which the chip and By luck rest on: ` : '') + recordText(b);
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
    // f.tested: the bettors with a record at all; luck alone, with every bet at exactly its priced chance, gives each of
    // them a record at goodLuck or rarer with a chance of at most goodLuck, so the expected count is at most tested ×
    // goodLuck (a bound, not a forecast: the count itself can be higher)
    const footText = (f) => [
      `Winning bettors: at least ${P.IDEAS.minDecided} decided bets, in profit, and more of them won than their locked odds implied. Predictions that share a question, directly or through a chain of other predictions that do (the same pick placed again, overlapping combos on one match or one round of fixtures), count as one bet, so one bet can span many predictions and several days: it counts as its largest-stake prediction, at that prediction's own odds and with its own result. Wins count, not money: a long shot that hit counts as one win, however much it paid. `,
      `The chip says how rarely luck alone would give one bettor a record that good: strong at 1 in ${Math.round(1 / P.IDEAS.strongLuck)} or rarer, good at 1 in ${Math.round(1 / P.IDEAS.goodLuck)} or rarer (when no one reaches that, the best record counts as good); hover it for the numbers. `,
      f && f.bettors && f.bettors.some(ideaApp) ? 'The record shown beside it is Meridian\'s app\'s (its Positions Won / Lost and Win Rate): every prediction on its own, each once it is claimed, so it can read very differently from the record against the odds; hover it for both. ' : '',
      f && f.tested ? `These are thresholds for one bettor, not a test across all of them: ${U.fmtNum(f.tested, 0)} bettors have at least ${P.IDEAS.minDecided} decided bets, and if every bet had exactly the chance its odds priced, luck alone would on average give at most about ${Math.max(1, Math.round(f.tested * P.IDEAS.goodLuck))} of them a record at 1 in ${Math.round(1 / P.IDEAS.goodLuck)} or rarer and at most about ${Math.max(1, Math.round(f.tested * P.IDEAS.strongLuck))} a record at 1 in ${Math.round(1 / P.IDEAS.strongLuck)} or rarer. A tier ranks records; on its own it does not show skill. ` : '',
      'An idea is one of their predictions this page still offers to copy: undecided, with no leg past the end time Meridian lists, settled or closed on Polymarket. A slip on a game that has finished is left out, even while Meridian still takes bets on it. Copy to Meridian opens it there, press Add To Slip and choose your amount. ',
      'Meridian\'s makers quote fresh odds and their margin applies to you too; across all bettors, decided bets have returned less than they staked (', h('a', { href: '#/predict/vig' }, 'Vig & edge'), '). A record is no promise.'];
    let file = null, bettors = new Map(), ideas = [], ids = [];
    // the timed redraws wait while a keyboard user is in the card or a dialog is open (a row replaced under an open dialog
    // could not take the focus back)
    const quiet = () => { const a = document.activeElement; return (!!a && card.contains(a) && a.matches(':focus-visible')) || !!document.querySelector('.modal-bg'); };
    // the controls are built once and only switched (rebuilding them dropped a keyboard user's focus on every press)
    const segView = UI.seg([{ v: 'slips', label: 'Open slips' }, { v: 'bettors', label: 'Winning bettors' }], st.view, (v) => { st.view = v; render(); }, 'sm');
    const segShow = UI.seg([{ v: 'all', label: 'All', title: 'Every winning bettor' }, { v: 'good', label: 'Good record', title: 'Bettors whose record is good or strong' }], st.show, (v) => { st.show = v; render(); }, 'sm');
    const segSort = UI.seg([{ v: 'newest', label: 'Newest' }, { v: 'record', label: 'Best record' }, { v: 'closing', label: 'Ending soon' }], st.sort, (v) => { st.sort = v; render(); }, 'sm');
    U.append(controls, [segView, segShow, segSort]);
    const render = () => {
      segShow.style.display = segSort.style.display = st.view === 'slips' ? '' : 'none';
      if (!file) { U.replace(body, UI.empty('The first ideas arrive with the next Predict snapshot (published every 30 minutes).')); U.replace(summary, ''); U.replace(foot, footText(null)); return; }
      const now = Date.now();
      const appRec = Array.from(bettors.values()).some(ideaApp);   // the file has the app's records (P.ideas)
      let rows = ideas.filter(ideaOpen);
      const openCount = new Map(); for (const n of rows) openCount.set(n.predictor, (openCount.get(n.predictor) || 0) + 1);
      U.replace(summary, `${rows.length} open slip${rows.length === 1 ? '' : 's'} · ${bettors.size} winning bettor${bettors.size === 1 ? '' : 's'} · snapshot ${U.fmtAgo(file.builtAt)}`, UI.staleNote(file.builtAt, 'the Predict publishing job may be down'));
      U.replace(foot, footText(file));
      if (st.view === 'bettors') {
        U.replace(body, UI.table({ cols: [
          { key: 'b', label: 'Bettor', render: (b) => h('div.row', { style: { gap: '6px' } }, bettorLink(b.address, 5), recordChip(b)) },
          { key: 'r', label: 'Record', title: appRec ? 'Won / lost and win rate as Meridian\'s app counts them (its Positions Won / Lost and Win Rate: every prediction, each once it is claimed). The chip and By luck rest on the site\'s record, decided bets (predictions linked by a shared question, directly or through others, count as one) against the number their locked odds implied: hover a cell for it' : 'Decided bets won (predictions linked by a shared question, directly or through others, count as one), against the number their locked odds implied', render: (b) => h('span', { title: ideaTitle(b) }, ideaRecord(b), ideaApp(b) ? null : h('span.dim.xs', ' · odds implied ' + U.fmtNum(b.expected, 1))) },
          { key: 'z', label: 'By luck', num: true, title: 'How rarely a record this good comes about by luck alone, if every bet had exactly the chance its odds priced', render: (b) => luckText(b.luck) },
          { key: 'p', label: 'PnL', num: true, render: (b) => pnlEl(b.pnl) },
          { key: 'roi', label: 'ROI', num: true, render: (b) => UI.pct(b.roi, { dp: 0 }) },
          { key: 'w', label: 'Wagered', num: true, render: (b) => usd(b.wagered, { compact: true }) },
          { key: 'o', label: 'Open slips', num: true, title: 'Its open predictions this page still offers to copy, on games that have not finished', render: (b) => { const k = openCount.get(b.address) || 0; return k ? h('b', String(k)) : h('span.dim', '0'); } },
          { key: 'l', label: 'Last bet', render: (b) => h('span.dim', U.fmtAgo(b.last)) },
        ], rows: Array.from(bettors.values()), empty: 'No bettor meets the bar yet', onRow: (b) => { location.hash = bettorUrl(b.address).slice(1); } }));
        return;
      }
      if (st.show === 'good') rows = rows.filter((n) => !!bettors.get(n.predictor).tier);
      const closesAt = (n) => Math.min(...n.picks.map((k) => k.endTime || Infinity));
      if (st.sort === 'closing') rows = U.sortBy(rows, closesAt, false);
      else if (st.sort === 'newest') rows = U.sortBy(rows, (n) => n.t, true);   // 'record': the file's order (best record, then newest)
      U.replace(body, rows.length ? UI.table({ cols: [
        { key: 'b', label: 'Bettor', render: (n) => { const b = bettors.get(n.predictor); return h('div', { style: { lineHeight: '1.3' } }, h('div.row', { style: { gap: '6px' } }, bettorLink(n.predictor, 4), recordChip(b)), h('div.xs.dim', { title: ideaTitle(b) }, `${ideaRecord(b)} · PnL ${usd(b.pnl, { sign: true, compact: true })}`)); } },
        { key: 's', label: 'Slip', render: (n) => h('div', { style: { whiteSpace: 'normal', minWidth: '220px', maxWidth: '400px', lineHeight: '1.3' } }, n.picks.slice(0, 2).map((k) => h('div', sideChip(k.yes), ' ', k.q)), n.legs > 2 ? h('div.xs.dim', '+' + (n.legs - 2) + (n.legs === 3 ? ' more leg' : ' more legs')) : null) },
        { key: 'c', label: 'Ends', title: 'The earliest end time Meridian lists among its legs; Meridian has taken bets after it, but this page stops offering a slip once a leg passes it', render: (n) => { const t = closesAt(n); return h('span', { title: U.fmtDateTime(t) }, 'in ' + U.fmtCountdown(t - now)); } },
        { key: 'o', label: 'Their odds', num: true, title: 'The odds this bettor locked, and its stake (×: it placed this same slip more than once)', render: (n) => h('div', { style: { lineHeight: '1.3' } }, h('div', oddsPct(n.odds), h('span.dim.xs', ' ' + mult(n.multiple))), h('div.xs.dim', 'bet ' + usd(n.stake) + (n.times > 1 ? ' · ×' + n.times : ''))) },
        // against Polymarket's own chance when the bet was placed, not the locked odds (they include the maker's margin);
        // until Polymarket answers (or when it fails), Meridian's estimates from the snapshot, marked
        { key: 'f', label: 'Chance now', num: true, title: 'Polymarket\'s chance for the whole slip now (legs taken as independent), and how far it has moved since the bettor placed it. Up: the market has come round to the pick, so a copier gets a shorter price than the bettor did (Meridian\'s makers quote near the market, plus their margin)', render: (n) => {
          const f = slipChance(n); if (f == null) return h('span.dim', '—');
          const live = n.picks.every(pickLive); const d = n.fairAtBet != null ? f - n.fairAtBet : null;
          const tip = [live ? null : `Polymarket's prices have not loaded: this uses Meridian's estimated prices from the snapshot built ${U.fmtAgo(file.builtAt)}, which can lag Polymarket`, n.sameEvent ? 'Some legs are on the same match or asset, so this product of independent chances is only approximate: their real joint chance can be higher or lower' : null].filter(Boolean).join('. ');
          return h(live ? 'span' : 'span.dim', { title: tip || null }, (n.sameEvent ? '≈ ' : '') + oddsPct(f, 0), live ? null : h('span.xs', ' (snapshot)'), d != null && Math.abs(d) >= 0.0005 ? h('span.xs', { class: d > 0 ? 'pos' : 'neg' }, ' ' + pp(d, Math.abs(d) < 0.01 ? 1 : 0)) : null); } },
        { key: 'a', label: '', render: (n) => h('div.row', { style: { gap: '6px', flexWrap: 'nowrap' } },
          h('a.btn.sm.primary', { href: P.meridianSlipUrl(n.id), target: '_blank', rel: 'noopener', title: 'Opens the slip on Meridian Predict: press Add To Slip there' }, U.icon('external'), 'Copy to Meridian'),
          h('a.btn.sm.ghost', { href: '#/predict/p/' + String(n.id).toLowerCase(), title: 'The slip page, with a link to share' }, 'Slip')) },
      ], rows, onRow: (n) => openPrediction(n, ctx) })
        : !bettors.size ? UI.empty(`No bettor meets the bar right now (at least ${P.IDEAS.minDecided} decided bets, in profit, more wins than the odds implied).`)
        : h('div.empty', h('div', { style: { marginBottom: '10px' } }, st.show === 'good' && ideas.some(ideaOpen) ? 'No open slip from a bettor with a good record right now.' : `No slip from a winning bettor is open to copy right now. There ${bettors.size === 1 ? 'is 1 winning bettor' : 'are ' + bettors.size + ' winning bettors'}; their new slips appear here with the first Predict snapshot built after they are placed (published every 30 minutes).`),
          h('button.btn.sm', { type: 'button', onclick: () => { st.view = 'bettors'; segView.set('bettors'); render(); } }, 'See the winning bettors')));
    };
    // Polymarket for their legs: the chance now, and legs whose market has closed or whose game has finished (no longer
    // shown); R keeps markets five minutes, so asking every minute costs a request at most every five
    const refreshMarkets = () => { if (ids.length) R.load(ids, { signal: ctx.signal, deep: false }).then(() => { if (!ctx.signal.aborted && !quiet()) render(); return loadMids(ids, ctx.signal); }).then((ok) => { if (ok && !ctx.signal.aborted && !quiet()) render(); }).catch(() => {}); };
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
    const t1 = setInterval(() => { if (ctx.signal.aborted || !file) return; if (!quiet()) render(); refreshMarkets(); }, 60000);   // countdowns, listed ends, chances
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
      // the markets first (each row's state and its YES token), then the order book's midpoints (the chance as the app shows it), then the oracle
      try { await R.load(ids, { signal: ctx.signal, deep: false }); if (!isCurrent()) return; rerender(); if (await loadMids(ids, ctx.signal) && isCurrent()) rerender(); await R.load(ids, { signal: ctx.signal, deep: true }); }
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
    U.replace(body, controls, h('div.card.tight', wrap), h('div.footer-note', counts ? `${U.fmtNum(counts.all.totalCount, 0)} questions on Meridian Predict · ${U.fmtNum(counts.open.totalCount, 0)} open · ${U.fmtNum(counts.settled.totalCount, 0)} settled. Meridian OI is the exchange's open-interest figure (0 for unlisted questions). Vol 24h and 7d are the mirrored Polymarket market's volume as Meridian's app shows it on its list cards, low-odds trading left out; a question's dialog has its all-time volume, as on its page in the app.` : ''), resFootnote());
    let cursors = [null], page = 1, hasNext = false, rows = [], loading = false, reqId = 0;
    function renderRows() {
      if (st.status === 'ended') rows = byStage(rows);
      U.replace(wrap, UI.table({ cols: [
        { key: 'q', label: 'Question', render: (c) => h('div', { style: { whiteSpace: 'normal', minWidth: '240px', maxWidth: '520px', lineHeight: '1.3' } }, h('div', U.kid(c.question)), h('div.xs.dim', (c.tags || []).slice(0, 4).join(' · '))) },
        { key: 'c', label: 'Category', render: (c) => (c.category ? c.category.name : '—') },
        { key: 'p', label: 'Probability', num: true, title: PROB_TITLE, render: probCell },
        { key: 'oi', label: 'Meridian OI', num: true, render: (c) => { const v = P.usd(c.openInterest); return v ? usd(v, { compact: true }) : h('span.dim', '—'); } },
        { key: 'v24', label: 'Vol 24h', num: true, title: volColTitle('24h'), render: (c) => volCell(c, '24h') },
        { key: 'v7', label: 'Vol 7d', num: true, title: volColTitle('7d'), render: (c) => volCell(c, '7d') },
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
    // the countdowns, and the midpoints of the rows on screen (asked again once a minute is up)
    resTicker(ctx, () => { if (loading) return; renderRows(); loadMids(rows.map(qId), ctx.signal).then((ok) => { if (ok && !loading) renderRows(); }).catch(() => {}); });
    function load() { cursors = [null]; MD.router.setParams({ all: '1', q: st.search || null, cat: st.cat || null, status: st.status !== 'open' ? st.status : null, sort: st.sort !== 'OPEN_INTEREST' ? st.sort : null }, { silent: true }); go(1); }
    load();
  }

  /** Questions people have actually bet on through Meridian (from the snapshot): those with money still on them (open
   *  predictions, or decided ones not yet claimed), then the questions of the most recently settled predictions, about
   *  1,200 in all. Rows carry n = predictions ever, b = open predictions, s = open stake. */
  const hasBets = (q) => q.oi > 0 || q.b > 0 || q.n > 0 || q.n == null;   // n == null: snapshot older than this field
  const betsNote = (c) => { const parts = []; if (c.b) parts.push(`${c.b} open bet${c.b > 1 ? 's' : ''}${c.s ? ' · ' + usd(c.s, { compact: true }) + ' staked' : ''}`); if (c.u) parts.push(`${c.u} decided, unclaimed`); return parts.length ? parts.join(' · ') : null; };
  async function mountQuestionsWithBets(body, route, ctx, st, liveP) {
    await withSnapshot(body, ctx, (snap) => {
      let live = false;
      const all = (snap.questionsWithOi || []).filter(hasBets);
      const cats = Array.from(new Map(all.filter((q) => q.slug).map((q) => [q.slug, q.cat])).entries()).sort((a, b) => a[1].localeCompare(b[1]));
      let page = 1; const wrap = h('div'); const summary = h('span.dim.small');
      const search = h('input.input', { placeholder: 'Search questions with Meridian bets', value: st.search, style: { maxWidth: '360px' }, oninput: U.debounce((e) => { st.search = e.target.value.trim().toLowerCase(); page = 1; render(); }, 250) });
      const exposure = (q) => !q.settled && (q.oi > 0 || q.b > 0 || q.b == null);   // money still riding on it (not settled: open bets or escrow not yet claimed)
      // on the Ended tab only: an ended but unsettled question whose open predictions have all lost on Polymarket (a leg
      // resolved against the bettor, or 50/50) is noise, only the makers are waiting for the settlement. It is left out
      // there and counted under the list; the other tabs list every question.
      const alive = (q) => !R.questionDead(q);
      // ended questions plus every leg of their open predictions (a combo's fate depends on all its legs); re-checked on
      // every tick, so questions that pass their end while the page is open get loaded too
      const loadedEnded = new Set();
      const endedCountOf = () => { const t = Date.now(); return all.filter((q) => exposure(q) && q.end && q.end < t && alive(q)).length; };
      const endedCount = endedCountOf();
      if (!['open', 'ended', 'settled', 'all'].includes(st.status)) st.status = 'open';
      const controls = h('div.card', h('div.row.wrap', search,
        h('select.input.sm', { style: { width: 'auto' }, onchange: (e) => { st.cat = e.target.value; page = 1; render(); } }, h('option', { value: '' }, 'All categories'), cats.map(([slug, name]) => h('option', { value: slug, selected: slug === st.cat }, name + (slug.startsWith('prices-') ? ' (prices)' : '')))),
        h('span.status-seg', UI.seg(STATUS_OPTS.map((o) => (o.v === 'ended' ? Object.assign({}, o, { label: o.label + (endedCount ? ' (' + endedCount + ')' : '') }) : o)), st.status, (v) => { st.status = v; page = 1; headerSorted = false; render(); renderBacklog(); }, 'sm')),
        h('span.grow'), summary));
      // header sorting like the leaderboard; the Ended tab keeps its pipeline order unless a header is chosen
      const SORTS = { q: (q) => (q.q || '').toLowerCase(), c: (q) => (q.cat || '').toLowerCase(), p: (q) => { if (q.settled) return -1; const x = probNow(q); return x ? x.p : -1; }, sw: (q) => (q.sw || 0) * 1e9 + (q.s || 0), oi: (q) => (q.oi || 0) * 1e9 + (q.s || 0), b: (q) => (q.b || 0) * 1e9 + (q.s || 0), v7: (q) => { const v = P.questionVolume(q); return (v.d7 != null ? v.d7 : v.raw7) || 0; }, end: (q) => q.end || Infinity, l: (q) => q.l || 0 };
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
      let renderSeq = 0, shown = []; const tracked = new Set();
      const loadEnded = () => {
        const t = Date.now();
        const ids = Array.from(new Set(all.filter((q) => exposure(q) && q.end && q.end < t).flatMap((q) => [qId(q)].concat(R.legIds(q))))).filter((id) => !loadedEnded.has(id));
        if (!ids.length) return;
        ids.forEach((id) => loadedEnded.add(id));
        R.load(ids, { signal: ctx.signal, deep: false }).then(() => { if (ctx.signal.aborted) return; refreshEndedLabel(); render(true); renderBacklog(); }).catch(() => {});
      };
      loadEnded();
      function render(keepTracking) {
        let rows = all.slice(); const t = Date.now();
        if (st.search) { const s = st.search.toLowerCase(); rows = rows.filter((q) => (q.q + ' ' + (q.tags || []).join(' ')).toLowerCase().includes(s)); }   // a linked ?q= keeps its case
        if (st.cat) rows = rows.filter((q) => q.slug === st.cat);
        if (st.status === 'open') rows = rows.filter(exposure);
        else if (st.status === 'settled') rows = rows.filter((q) => q.settled);
        else if (st.status === 'ended') rows = rows.filter((q) => exposure(q) && q.end && q.end < t);
        // after the search and category filters, so the count of the ones left out follows them too
        const deadN = st.status === 'ended' ? rows.filter((q) => !alive(q)).length : 0;
        if (st.status === 'ended') rows = rows.filter(alive);
        rows = st.status === 'ended' && !headerSorted ? byStage(rows) : U.sortBy(rows, SORTS[st.col.key] || SORTS.sw, st.col.desc);
        const total = rows.length; const pages = Math.max(1, Math.ceil(total / PAGE)); if (page > pages) page = pages;
        const slice = rows.slice((page - 1) * PAGE, page * PAGE); shown = slice;
        U.replace(wrap, UI.table({ sort: st.status === 'ended' && !headerSorted ? null : st.col, onSort, cols: [
          { key: 'q', label: 'Question', sortVal: 1, render: (c) => h('div', { style: { whiteSpace: 'normal', minWidth: '240px', maxWidth: '520px', lineHeight: '1.3' } }, h('div', U.kid(c.q)), h('div.xs.dim', (c.tags || []).slice(0, 4).join(' · '))) },
          { key: 'c', label: 'Category', sortVal: 1, render: (c) => c.cat || '—' },
          { key: 'p', label: 'Probability', num: true, sortVal: 1, title: PROB_TITLE, render: probCell },
          { key: 'sw', label: 'Staked on Meridian', num: true, sortVal: 1, title: 'Bettor stakes of every prediction that includes this question (a combo\'s whole stake counts on each of its questions) · predictions', render: (c) => h('div', { style: { lineHeight: '1.25' } }, c.sw ? usd(c.sw, { compact: true }) : h('span.dim', '$0'), c.n ? h('div.xs.dim', { style: { whiteSpace: 'nowrap' } }, `${c.n} prediction${c.n > 1 ? 's' : ''}${c.l ? ' · last ' + U.fmtAgo(c.l) : ''}`) : null) },
          { key: 'oi', label: 'Meridian OI', num: true, sortVal: 1, title: 'Collateral still in escrow on this question as of the snapshot: stake + maker collateral of every prediction on it not yet claimed (a combo counts in full on each of its questions) · open predictions and their bettor stakes', render: (c) => h('div', { style: { lineHeight: '1.25' } }, c.oi ? usd(c.oi, { compact: true }) : h('span.dim', '$0'), betsNote(c) ? h('div.xs.dim', { style: { whiteSpace: 'normal', maxWidth: '200px', marginLeft: 'auto' } }, betsNote(c)) : null) },
          { key: 'v7', label: 'Vol 7d', num: true, sortVal: 1, title: volColTitle('7d'), render: (c) => volCell(c, '7d') },
          ...resCols(slice),
          { key: 'l', label: '', render: (c) => (webUrl(c.src) ? srcBtn(c.src) : '') },
        ], rows: slice, empty: st.status === 'ended' ? 'Nothing waiting for resolution' : 'No questions match', onRow: (c) => openQuestion(c, ctx) }), UI.pager({ page, pageSize: PAGE, total, onPage: (p) => { page = p; render(); wrap.scrollIntoView({ block: 'start' }); } }));
        U.replace(summary, st.status === 'ended' ? `${U.fmtNum(total, 0)} ended, not settled yet` + (deadN ? ` · ${U.fmtNum(deadN, 0)} more not listed: every open prediction on ${deadN === 1 ? 'it' : 'them'} already has a leg resolved against the bettor (or 50/50) on Polymarket` : '') : `${U.fmtNum(total, 0)} questions with Meridian bets`);
        // rows that move onto the page once their state is known (the Ended tab re-sorts by stage) need their oracle and
        // price checks too, not only the ones visible on the first render
        if (!keepTracking || slice.some((q) => !tracked.has(qId(q)))) { slice.forEach((q) => tracked.add(qId(q))); const my = ++renderSeq; trackResolution(slice, ctx, () => render(true), () => my === renderSeq); }
      }
      U.replace(body, controls, backlog, h('div.card.tight', wrap), h('div.footer-note', 'Only questions people have bet on through Meridian: those with money still on them (open predictions, or decided ones not yet claimed), then the questions of the most recently settled predictions' + (snap.recentFrom ? ', back to those settled ' + U.fmtDateTime(snap.recentFrom) : '') + ', ' + U.fmtNum(all.length, 0) + ' questions in all, as of the snapshot ' + U.fmtAgo(snap.builtAt) + (snap.questions ? ` (the exchange lists ${U.fmtNum(snap.questions.all, 0)} questions in total)` : '') + '. A combo counts in full on every question it includes, so stakes and open interest overlap across rows and do not add up to a total.' + (live ? '' : ' Searching every question on the exchange needs live API access, which the Predict API does not grant to this domain.')), resFootnote());
      render();
      // (shown: the rows on screen, whose midpoints are asked again once a minute is up)
      resTicker(ctx, () => { loadEnded(); refreshEndedLabel(); render(true); loadMids(shown.map(qId), ctx.signal).then((ok) => { if (ok && !ctx.signal.aborted) render(true); }).catch(() => {}); });
    });
  }

  // =====================================================================
  // Market makers
  // =====================================================================
  async function mountMakers(body, route, ctx) {
    MD.setTopbar(h('span.title', 'Predict · Market makers'));
    await withSnapshot(body, ctx, (snap) => {
      const a = snap.agg; const T = a.totals; const cv = h('canvas'); const MK = P.splitMakers(a.makers); const M = makerCols(T, a);
      // every counterparty, one-off ones included (each prediction's result mirrors the bettor's); the bettors' net
      // differs from it by the secondary market: what wallets that never bet made there, and results booked before the
      // verdict (sales, both sides held), which the note under the table works out
      const makerPnl = U.sum(a.makers, (m) => m.pnl || 0);
      const oneOffNote = MK.oneOff.length ? h('div.footer-note', { style: { textAlign: 'left', padding: '10px 14px' } },
        `Not market makers: ${MK.oneOff.length === 1 ? 'a wallet that' : MK.oneOff.length + ' wallets that'} took the other side of fewer than ${P.MAKER_MIN} predictions (a one-off or a test, not a market): `,
        ...MK.oneOff.flatMap((m, i) => [i ? ', ' : '', bettorLink(m.address, 4), ` (${U.fmtNum(m.n, 0)} prediction${m.n === 1 ? '' : 's'}, ${usd(m.wagered)} collateral, ${usd(m.pnl || 0, { sign: true })} PnL)`]),
        `. ${MK.oneOff.length === 1 ? 'It is' : 'They are'} left out of the table and the chart but counted in the tiles above (collateral, PnL, win rate and vig).`) : null;
      const tbl = UI.table({ cols: [
        { key: 'a', label: 'Market maker', render: (r) => h('div.row', { style: { gap: '6px' } }, bettorLink(r.address, 6), U.copyBtn(r.address)) },
        { key: 'n', label: 'Predictions taken', num: true, render: (r) => U.fmtNum(r.n, 0) },
        M.share, M.committed, M.open, M.pnl, M.winRate, M.vig, M.odds, M.topCat,
        { key: 'f', label: 'Active', render: (r) => h('span.dim', U.fmtDate(r.first) + ' → ' + U.fmtAgo(r.last)) },
      ], rows: MK.makers, onRow: (r) => { location.hash = bettorUrl(r.address).slice(1); } });
      // the Overview's bettor net result against the Maker PnL, from the aggregate: the secondary market is where they part
      const reconcile = (() => {
        if (!a.secondary) return null;
        const others = a.secondary.toOthers || 0, early = T.bettorPnl + makerPnl + others;
        return h('div.footer-note', `Each prediction's result is zero-sum between the bettor and the counterparty. The Overview's bettor net result (${usd(T.bettorPnl, { sign: true })}) is the Maker PnL (${usd(makerPnl, { sign: true })}) with the sign reversed`
          + (Math.abs(others) >= 1 ? `, minus ${usd(others, { sign: true })} made on the secondary market by wallets that bought position tokens without ever betting or taking a bet` : '')
          + (Math.abs(early) >= 1 ? `, plus ${usd(early, { sign: true })} booked on predictions not decided yet (a token sale counts when it is made, and a wallet that holds both sides of a pick books the sure payout when it has both; tokens still held count at the verdict)` : '') + '.');
      })();
      U.replace(body,
        h('div.card', h('h2', { style: { marginBottom: '6px' } }, 'Who takes the other side'), h('p.muted', { style: { margin: 0, maxWidth: '860px' } }, 'Every Meridian prediction is an RFQ auction: the bettor broadcasts a stake, market makers compete to take the other side, and the winning quote locks the odds. The counterparty address is public on every prediction, so this page shows exactly who is making the market, how much they commit, and how it has gone for them.'), h('div.dim.small', { style: { marginTop: '8px' } }, snapNote(snap))),
        h('div.stats', UI.stat('Market makers', String(MK.makers.length), MK.oneOff.length ? `+ ${MK.oneOff.length} one-off counterpart${MK.oneOff.length === 1 ? 'y' : 'ies'}` : null),
          UI.stat('Maker collateral', usd(T.cpCommitted, { compact: true }), snap.remote ? 'committed since launch' : `on predictions placed in the last ${snap.windowDays} days`),
          UI.stat('Maker PnL', usd(makerPnl, { sign: true }), 'decided predictions, claimed or not' + (a.secondary && Math.abs(a.secondary.toMakers) >= 1 ? ' · incl. ' + usd(a.secondary.toMakers, { sign: true, compact: true }) + ' from secondary-market trades' : ''), U.pnlClass(makerPnl)),
          // the counterparties' records as Meridian's app counts them, added up: the bettors' turned round
          UI.stat('Maker win rate', h('span', { title: recTitle(T.appWon != null, T.lost || 0, T.won || 0) }, ((r) => (r == null ? '—' : winPct(100 - r)))(T.appWon != null ? T.appWinRate : T.winRate)), T.appWon != null ? 'of claimed predictions, as Meridian\'s app counts them' : null),
          UI.stat('Avg vig quoted', pp(a.vig.overall.avg), a.vig.coverage ? `locked odds vs Polymarket at bet time · ${U.fmtNum(a.vig.coverage.clean, 0)} of ${U.fmtNum(a.vig.coverage.total, 0)} predictions; combos with legs on the same match or asset left out` : 'locked odds vs Polymarket at bet time'),
          UI.stat('Stake-weighted vig', pp(a.vig.weighted), 'same predictions · big bets count more')),
        h('div.card.tight', tbl, oneOffNote),
        reconcile,
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
      // The 95% interval on the hit rate. 'shared' (the snapshot simulates bets on one question winning or losing together):
      // ± around the hit rate, and the gap is outside it when |gap| > ±. Older snapshots carry a Wilson half-width, which is
      // centred off the raw hit rate: its bounds are worked out here and the implied rate is tested against them.
      const range = (r) => {
        if (r.ciKind === 'shared') return { lo: Math.max(0, r.hit - r.ci), hi: Math.min(1, r.hit + r.ci) };
        if (r.lo != null) return { lo: r.lo, hi: r.hi };
        const z = 1.96, c = (r.hit + (z * z) / (2 * r.n)) / (1 + (z * z) / r.n); return { lo: Math.max(0, c - r.ci), hi: Math.min(1, c + r.ci) };
      };
      const outside = (r) => { if (r.ci == null) return false; if (r.ciKind === 'shared') return Math.abs(r.gap) > r.ci; const b = range(r); return r.implied < b.lo || r.implied > b.hi; };
      const hitCell = (r) => (r.hit == null ? h('span.dim', '—') : h('span', U.fmtPct(r.hit * 100, { dp: 1 }), r.ci == null ? null : r.ciKind === 'shared' ? h('span.dim.xs', ' ±' + U.fmtNum(r.ci * 100, 1)) : h('span.dim.xs', ' (' + U.fmtNum(range(r).lo * 100, 1) + '–' + U.fmtNum(range(r).hi * 100, 1) + ')')));
      const gapCell = (r) => (r.gap == null ? h('span.dim', '—') : h('span', { class: outside(r) ? (r.gap > 0 ? 'neg' : 'pos') : 'dim', title: outside(r) ? 'The implied rate is outside the 95% interval of the realized one' : 'Within the 95% interval: could be luck' }, pp(r.gap)));
      const realTbl = (rows, labelKey, labelFn) => UI.table({ cols: [
        { key: 'k', label: labelKey, render: labelFn },
        { key: 'n', label: 'Decided', num: true, render: (r) => U.fmtNum(r.n, 0) },
        { key: 'imp', label: 'Implied', num: true, title: 'Average locked odds = the win probability the bettors paid for', render: (r) => (r.implied == null ? '—' : U.fmtPct(r.implied * 100, { dp: 1 })) },
        { key: 'hit', label: 'Realized', num: true, title: 'Share actually won, with its 95% interval (bets on the same question counted as winning or losing together)', render: hitCell },
        { key: 'gap', label: 'Implied − realized', num: true, title: 'Positive = bettors won less often than they paid for; coloured when the implied rate is outside the 95% interval', render: gapCell },
        { key: 'roi', label: 'Bettor ROI', num: true, title: 'Each bet\'s result (payout − stake, or the stake lost) ÷ stake, as if every position was held to the verdict, before secondary-market trades; the maker side is its mirror image', render: roiCell },
      ], rows });
      const bucketLabel = (b) => pct(b.from, 0) + '–' + pct(b.to, 0);
      // plain-language card for bettors, written from the numbers so it stays true as the snapshot changes
      const bettorNote = (r) => {
        if (!r || !r.overall.n) return null;
        const o = r.overall; const roiTxt = (x) => U.fmtPct(x * 100, { sign: true, dp: 1 });
        // contiguous odds buckets with enough bets and a clearly negative money result, with their wins against the wins
        // their locked odds implied (only these are stated: a positive run can rest on one wallet, which a pooled figure hides)
        const runs = (pred) => { const out = []; for (const b of r.byOddsBucket) { if (b.n >= 100 && pred(b)) { const w = b.hit * b.n, e = b.implied * b.n; const last = out[out.length - 1]; if (last && last.to === b.from) { last.to = b.to; last.stake += b.stake; last.pnl += b.pnl; last.wins += w; last.exp += e; } else out.push({ from: b.from, to: b.to, stake: b.stake, pnl: b.pnl, wins: w, exp: e }); } } return out.map((x) => Object.assign(x, { roi: x.pnl / x.stake })); };
        const bad = runs((b) => b.roi < -0.1);
        const list = (arr, f) => { const s = arr.map(f); return s.length > 2 ? s.slice(0, -1).join(', ') + ' and ' + s[s.length - 1] : s.join(' and '); };
        const runTxt = (x) => `${bucketLabel(x)} odds have returned ${roiTxt(x.roi)} of their stakes, winning ${U.fmtNum(x.wins, 0)} times where their odds implied ${U.fmtNum(x.exp, 0)}`;
        const types = [['singles', r.singles], ['combos with every leg on a different match', r.combosOnly], ['combos with legs on one match or asset', r.combosSameEvent]].filter(([, x]) => x.n >= 100);
        const li = (t, ...c) => h('li', { style: { margin: '0 0 6px' } }, h('b', { style: { color: 'var(--text-1)' } }, t + ' '), ...c);
        return h('div.card', { style: { borderColor: 'var(--accent)' } }, h('h3', { style: { marginBottom: '8px' } }, 'How to read this if you bet'),
          h('ul.muted', { style: { margin: 0, paddingLeft: '18px', maxWidth: '900px' } },
            li('Two measures.', `Quoted (top of the page): how far the locked odds sat from Polymarket's price at that moment, ${pp(v.overall.avg)} on average (median ${pp(v.overall.median)}), on singles and on combos with every leg on a different match. Realized (bottom): decided bets, claimed or not, have returned ${roiTxt(o.roi)} of their ${U.fmtUsd(o.stake, { compact: true })} in stakes, pooled over all bettors and every bet type. They cover different bets and use different units, so they do not compare directly: the same gap in points costs a larger share of the stake the lower the odds.`),
            bad.length ? li('Where the money goes.', `Bets at ${list(bad, runTxt)}.`) : null,
            types.length ? li('Bet type.', `Returned so far, pooled: ${list(types, ([k, x]) => k + ' ' + roiTxt(x.roi))} of stakes.`) : null,
            li('Read it right.', 'Look at Bettor ROI, not the hit-rate gap: a one-point shortfall at 3% odds costs a third of the stake, at 60% odds about 1.7% of it. A gap inside the 95% interval could be luck. Results count from the exchange\x27s verdict, so unclaimed wins and losses are in. These are pooled past results, not a forecast and not advice: a few large bets or a small sample can swing a bucket, and a single bettor\x27s own result can differ widely from the pool, in either direction.')));
      };
      const realizedSection = (r) => {
        if (!r || !r.overall.n) return null;
        const o = r.overall; const cr = h('canvas');
        const buckets = r.byOddsBucket.filter((b) => b.n >= 30);
        // combos with a leg whose Polymarket event is unknown (a handful at most) stay in the overall figures, not as a row
        const splits = [{ k: 'Singles', ...r.singles }, { k: 'Combos · different matches', ...r.combosOnly }, { k: 'Combos · legs on one match or asset', ...r.combosSameEvent }];
        const sec = snap.agg.secondary;
        const node = h('div.stack', { style: { marginTop: '8px' } },
          h('div.card', h('h2', { style: { marginBottom: '6px' } }, 'Quote-implied vs realized'), h('p.muted', { style: { margin: '0 0 6px', maxWidth: '900px' } }, 'The other way to measure the edge, needing no source price at all: on decided bets (the exchange\x27s verdict is in, claimed or not), the odds the bettors locked are the win probability they paid for; compare that with how often they actually won. Outcomes carry the real correlation between legs and any skill the bettors have, so this is the maker\'s realized edge rather than a quoted one. It costs waiting for the verdict and some luck: the interval shown is a 95% interval on the hit rate that allows for bets on the same question winning or losing together, and a gap inside it may be chance.'), h('p.muted.small', { style: { margin: 0 } }, 'Money matters more than counts here: a bet at 3% odds that hits 2% of the time loses a third of its stakes on average, while the same one-point gap at 60% odds costs about 1.7% (59 ÷ 60 − 1). Bettor ROI is each bet\'s result (payout − stake, or the stake lost) ÷ stake, as if every position was held to the verdict, and is the number to read; the maker side is its mirror image.' + (sec && Math.abs(sec.toBettors) >= 1 ? ` The Overview\'s bettor net result also counts the secondary-market trades between wallets (${U.fmtUsd(sec.toBettors, { sign: true, compact: true })} to bettors), so it differs from ROI × stake by that much.` : ''))),
          h('div.stats', UI.stat('Decided bets', U.fmtNum(o.n, 0), U.fmtUsd(o.stake, { compact: true }) + ' staked · claimed or not'), UI.stat('Implied win rate', U.fmtPct(o.implied * 100, { dp: 1 }), 'avg locked odds'), UI.stat('Realized win rate', U.fmtPct(o.hit * 100, { dp: 1 }), o.ciKind === 'shared' ? '± ' + U.fmtNum(o.ci * 100, 1) + ' pp (95%, bets on one question together)' : U.fmtNum(range(o).lo * 100, 1) + '–' + U.fmtNum(range(o).hi * 100, 1) + '% (95%)'), UI.stat('Bettor ROI', U.fmtPct(o.roi * 100, { sign: true, dp: 1 }), 'bet result ÷ stake · before secondary-market trades', U.pnlClass(o.roi)), UI.stat('Maker take', U.fmtPct(-o.roi * 100, { sign: true, dp: 1 }), 'of stakes · the other side of the same bets', U.pnlClass(-o.roi))),
          h('div.grid.cols-2', h('div.card', h('h3', { style: { marginBottom: '10px' } }, 'Implied vs realized by locked odds'), h('div.chart-box.sm', cr)), UI.card('By bet type', realTbl(splits, 'Type', (x) => x.k))),
          h('div.grid.cols-2', UI.card('By locked odds', realTbl(r.byOddsBucket.filter((b) => b.n), 'Bettor odds', bucketLabel)), UI.card('By category', realTbl(r.byCat.filter((c) => c.n >= 20), 'Category', (x) => x.cat))));
        requestAnimationFrame(() => C.pairedBars(cr, buckets.map(bucketLabel), buckets.map((b) => b.implied * 100), buckets.map((b) => b.hit * 100), { aLabel: 'Implied (locked odds)', bLabel: 'Realized (won)', max: 100 }));
        return node;
      };
      U.replace(body,
        h('div.card', h('h2', { style: { marginBottom: '6px' } }, 'What the auction costs'), h('p.muted', { style: { margin: '0 0 6px', maxWidth: '900px' } }, 'Every prediction locks odds = stake ÷ (stake + maker collateral). The fair price is what the mirrored Polymarket market showed at the moment the bet was placed, taken from Polymarket\'s own price history (1- or 5-minute samples, the last one at or before the bet). The difference is the vig: how much worse than the source the bettor\'s price was. Positive = bettor paid above fair, which is the market maker\'s margin.'), h('p.muted.small', { style: { margin: 0 } }, 'For combos the fair price is the product of the legs\' prices at bet time, which assumes the legs are independent. Legs on the same match (a game\'s main market and its More Markets, Exact Score or player-prop markets) or on one asset at one date and several strikes are correlated, so for those the product is not the fair price: it understates it when the legs go together (a team to win and to cover, two strikes above the same price) and overstates it for a range (above one strike but not above a higher one), and the gap mixes the maker\'s margin with its pricing of that correlation. Combos with legs on one match or asset are shown separately and kept out of the headline figures' + (cov ? `. Included: ${U.fmtNum(cov.clean != null ? cov.clean : cov.withAtBet, 0)} of ${U.fmtNum(cov.total, 0)} predictions` + ((parts) => (parts.length ? ' (' + parts.join(', ') + ')' : ''))([cov.total > cov.withAtBet ? `${U.fmtNum(cov.total - cov.withAtBet, 0)} without a Polymarket price at bet time` : null, cov.sameEvent ? `${U.fmtNum(cov.sameEvent, 0)} combos with legs on one match or asset left out` : null].filter(Boolean)) : '') + '.'), h('div.dim.small', { style: { marginTop: '8px' } }, snapNote(snap))),
        bettorNote(v.realized),
        h('div.stats', UI.stat('Avg vig', pp(v.overall.avg), 'odds vs source price at bet time'), UI.stat('Stake-weighted', pp(v.weighted), 'big bets count more'), UI.stat('Median', pp(v.overall.median)), UI.stat('Above fair', v.overall.share == null ? '—' : U.fmtPct(v.overall.share * 100, { dp: 0 }), 'of predictions'), UI.stat('Singles', pp(v.singles.avg), U.fmtNum(v.singles.n, 0) + ' predictions'), UI.stat('Combos · different matches', pp(v.combosOnly.avg), U.fmtNum(v.combosOnly.n, 0) + ' predictions'), v.combosSameEvent && v.combosSameEvent.n ? UI.stat('Combos · legs on one match or asset', pp(v.combosSameEvent.avg), U.fmtNum(v.combosSameEvent.n, 0) + ' predictions · includes correlation pricing, not in the headline') : null),
        h('div.card', h('h3', { style: { marginBottom: '10px' } }, 'Average vig per week'), h('div.chart-box.sm', cv)),
        h('div.grid.cols-2', UI.card('By category', sumTbl(v.byCat, 'Category', (r) => r.cat)), UI.card('By odds', sumTbl(v.byOddsBucket.filter((b) => b.n), 'Bettor odds', (r) => pct(r.from, 0) + ' – ' + pct(r.to, 0)))),
        h('div.footer-note', 'A negative vig means the bettor locked better odds than Polymarket showed at that moment. Most are in-play bets: the game had already started, Polymarket\'s price was moving fast, and the maker\'s quote still matched where it had been minutes earlier. Polymarket samples are the last trade or midpoint in the 1- or 5-minute bucket, so a single value can be a few minutes off; averages are the meaningful part.'),
        realizedSection(v.realized));
      const col = C.colors();
      // weeks start on a Monday, 00:00 UTC
      C.timeSeries(cv, { points: v.weekly.map((w) => ({ x: w.t, y: (w.avg || 0) * 100 })), color: col.amber, label: 'Avg vig', yFmt: (x) => x.toFixed(1) + ' pp', tipFmt: (x) => x.toFixed(2) + ' pp', zero: true, titleFmt: (x) => 'Week of ' + U.fmtDayUTC(x).replace(' (UTC day)', '') + ' (Monday, UTC)' });
    });
  }

  // =====================================================================
  // Bettor page (also used as the Predict tab on the perps account page)
  // =====================================================================
  async function mountBettorPage(body, route, ctx) {
    const addr = String(route.params.address || '').toLowerCase();
    // a Predict wallet is a smart account; the perps account belongs to its owner (js/predict/wallets.js)
    // (most wallets' owners have no perps account: the account page says so and links back)
    const perpsBtn = h('a.btn.sm.ghost', { href: U.accountUrl(addr), title: 'Account page of this address (its perps account, if it has one)' }, U.icon('account'), 'Perps');
    if (U.isAddress(addr)) P.wallets.ownerOf(addr).then((o) => { if (o) { perpsBtn.href = U.accountUrl(o); perpsBtn.title = 'Account page of the owner ' + o + ' (its perps account, if it has one)'; } }).catch(() => {});
    const head = h('div.acct-head', h('span.addr-box', h('span', { title: addr }, U.shortAddr(addr, 6)), U.copyBtn(addr)), perpsBtn, h('button.btn.sm.ghost', { title: 'Copy a share link: Discord, X, Telegram and the like show this wallet\'s card with its result (every wallet that placed or took a prediction by the last snapshot; any other address gets the site\'s card)', onclick: () => { U.copyText(MD.api.shareUrl('p', addr)); U.toast('Share link copied · it shows a preview card'); } }, U.icon('copy'), 'Share'), h('a.btn.sm.ghost', { href: U.explorerAddr(addr), target: '_blank', rel: 'noopener' }, U.icon('external'), 'Explorer'));
    // phones: the header goes into the page (the topbar cannot fit it); same arrangement as the perps account page
    const headSlot = h('div.acct-head-slot'); if (body.parentElement) body.parentElement.prepend(headSlot); else body.prepend(headSlot);
    const narrow = window.matchMedia('(max-width: 720px)');
    const placeHead = () => { if (narrow.matches) { headSlot.appendChild(head); MD.setTopbar(h('span.title', 'Predict · Bettor')); } else { MD.setTopbar(head); } };
    placeHead(); narrow.addEventListener('change', placeHead); window.addEventListener('resize', placeHead); ctx.onCleanup(() => { narrow.removeEventListener('change', placeHead); window.removeEventListener('resize', placeHead); });
    if (!U.isAddress(addr)) { U.replace(body, h('div.card', h('div.error', 'Invalid address'))); return; }
    await P.renderBettor(body, addr, ctx);
  }
  /** Bettor model from live queries, or from the per-wallet snapshot file when the API refuses this origin. Besides the
   *  predictions and history: claim, the winning position tokens the wallet still holds (P.claimRows; live the API's
   *  claimable positions, offline the file's claim where the snapshot read them; null when unknown), selfNorms / selfN /
   *  selfVol, its self-matched predictions (left out of every figure; the app counts them, both sides in its volume), and
   *  pre, its launch-day tests where the figures leave them out (offline: P.PRE_LAUNCH; live they are in, as in the app). */
  async function loadBettor(addr, ctx) {
    const live = await P.live();
    if (live) {
      const [acct, raw, openPos, tf, claimRaw] = await Promise.all([
        // from the exchange's start, as the app's all-time figures: the launch-day tests are booked before the launch
        P.account(addr, { interval: 'DAY', fromSec: P.EXCHANGE_START_SEC, signal: ctx.signal, ttl: 60000 }),
        P.predictionsOf(addr, { maxPages: 12, signal: ctx.signal }),
        P.positionsOf(addr, { settled: false, signal: ctx.signal }).catch(() => ({ nodes: [], totalCount: null })),
        P.snapshotFile('bettors/' + addr + '.json', { signal: ctx.signal }).catch(() => null),   // the wallet's secondary-market trades, tied to their predictions by the snapshot builder
        // its Claimable Payout as the app reads it (a list cut short would understate it: then the old way)
        P.claimableOf(addr, { signal: ctx.signal, maxPages: 40 }).then((r) => (r.truncated ? null : r)).catch((e) => { if (isAbort(e)) throw e; return null; }),
      ]);
      const all = raw.map(P.norm);
      const norms = all.filter((n) => (n.predictor === addr || n.counterparty === addr) && !P.selfMatch(n));   // a bet against itself moves no money
      P.markTokenClaims(norms);   // decided predictions a claim on the same token already paid (P.bettorFigures still counts them as the exchange does)
      // the exchange's figures count a self-match (both sides of its volume, pending until claimed); the site leaves it out
      const self = all.filter((n) => n.predictor === addr && P.selfMatch(n));
      const day = (t) => Math.floor(t / 86400000) * 86400000;
      const hist = self.length ? acct.history.map((x) => { const s = self.filter((n) => day(n.t) === x.t); return s.length ? Object.assign({}, x, { volume: Math.max(0, x.volume - U.sum(s, (n) => n.stake + n.cp)), total: Math.max(0, x.total - s.length) }) : x; }) : acct.history;
      // decided-but-unclaimed positions are not open; a position whose tokens were all sold is not this wallet's any more
      const undecided = (openPos.nodes || []).filter((p) => !(p.pickConfig && p.pickConfig.resolved) && P.usd(p.balance) > 1e-9);
      // the API's picks are the bettor's on either side, so a maker's position wins when they do not all win
      const posRows = undecided.map((p) => { const stake = P.usd(p.userCollateral), payout = P.usd(p.totalPayout); const picks = ((p.pickConfig && p.pickConfig.picks) || []).map((k) => ({ id: k.conditionId || null, q: k.condition ? k.condition.question : k.conditionId, yes: String(k.predictedOutcome).toUpperCase() === 'YES', ep: k.condition ? k.condition.estimatedPrice : null, endTime: k.condition && k.condition.endTime ? k.condition.endTime * 1000 : null, settled: !!(k.condition && k.condition.settled), resolvedToYes: k.condition ? k.condition.resolvedToYes : null, nonDecisive: !!(k.condition && k.condition.nonDecisive) })); const f = winProb(picks); const fair = f == null ? null : p.side === 'COUNTERPARTY' ? 1 - f : f; return { id: (p.prediction && p.prediction.predictionId) || null, side: p.side, stake, payout, odds: payout > 0 ? stake / payout : null, picks, fair, t: P.ms(p.createdAt), ends: picks.reduce((m, k) => (k.endTime && (!m || k.endTime > m) ? k.endTime : m), null) }; });
      // openPosTotal: Meridian's Open Positions, the API's own count (positions with a balance, undecided)
      return { live: true, norms, truncated: !!raw.truncated, hist, totalVolume: Math.max(0, acct.totalVolume - U.sum(self, (n) => n.stake + n.cp)), selfPending: self.filter((n) => !n.settled).length, balance: acct.balance, posRows, openCount: undecided.length, openPosTotal: openPos.totalCount != null ? openPos.totalCount : null, posCapped: (openPos.totalCount || 0) > (openPos.nodes || []).length, builtAt: Date.now(), trades: (tf && tf.trades) || [], curve: null, daily: null, older: null, windowFrom: null,
        claim: claimRaw ? P.claimRows(claimRaw) : null, selfNorms: self, selfN: self.length, selfVol: U.sum(self, (n) => n.stake + n.cp), pre: null };
    }
    const f = await P.snapshotFile('bettors/' + addr + '.json', { signal: ctx.signal });
    if (!f) return null;
    const every = f.predictions.map(P.unslim);
    // (a self-match is filed under both of its sides, the same wallet: once here)
    const self = Array.from(new Map(every.filter((n) => n.predictor === addr && P.selfMatch(n)).map((n) => [n.id, n])).values());
    const norms = every.filter((n) => !P.selfMatch(n));
    const asMaker = norms.filter((n) => n.counterparty === addr).length > norms.filter((n) => n.predictor === addr).length;
    const mine = norms.filter((n) => (asMaker ? n.counterparty : n.predictor) === addr);
    const open = mine.filter((n) => !n.decided);
    // an open prediction's legs keep Meridian's result where it has settled the question (P.unslim), and a settled leg
    // counts as won or lost in its chance: its estimatedPrice froze before the settlement; key: the position it belongs
    // to (P.posKey), so the page can show them as Meridian's positions
    const posRows = open.map((n) => ({ id: n.id, key: P.posKey(n, asMaker ? 'C' : 'P'), side: asMaker ? 'COUNTERPARTY' : 'PREDICTOR', stake: asMaker ? n.cp : n.stake, payout: n.pool, odds: asMaker ? (n.pool ? n.cp / n.pool : null) : n.odds, picks: n.picks.map((k) => ({ id: k.id, q: k.q, yes: k.yes, ep: k.ep, endTime: k.endTime, settled: !!k.settled, resolvedToYes: k.settled ? k.resolvedToYes : null, nonDecisive: !!k.nonDecisive })), fair: ((p) => (p == null ? null : asMaker ? 1 - p : p))(winProb(n.picks)), t: n.t, ends: n.picks.reduce((m, k) => (k.endTime && (!m || k.endTime > m) ? k.endTime : m), null) }));
    // build-snapshot.mjs keeps the newest f.newest predictions, then every older one on a pick configuration the wallet
    // traded; a truncated file also carries the curve and the stake per UTC day from every prediction (older files: neither)
    const nHead = f.newest != null ? f.newest : f.truncated ? Math.min(600, f.predictions.length) : f.predictions.length;
    return { live: false, norms, truncated: !!f.truncated, hist: P.historyFromPredictions(mine, addr, asMaker), totalVolume: U.sum(mine, (n) => (asMaker ? n.cp : n.stake)), balance: null, posRows, openCount: open.length, builtAt: f.builtAt, trades: f.trades || [],
      // the snapshot's read of the wallet's winning tokens still held (an older file has none: then the old way)
      claim: Array.isArray(f.claim) ? P.claimRows(f.claim) : null, selfNorms: self, selfN: self.length, selfVol: U.sum(self, (n) => n.stake + n.cp), pre: P.preLaunchOf(addr),
      curve: Array.isArray(f.curve) && f.curve.length >= 2 ? f.curve : null, daily: Array.isArray(f.daily) ? f.daily : null,
      older: f.truncated ? new Set(f.predictions.slice(nHead).map((p) => p.id)) : null, windowFrom: f.truncated && nHead ? f.predictions[nHead - 1].t : null };
  }
  P.loadBettor = loadBettor;
  /** A wallet's role, token ledger and headline figures, exactly as its bettor page shows them, from loadBettor's model;
   *  null when there is nothing under the address. { asBettor, asMaker, isMaker, marketMaker (a maker that took at least
   *  P.MAKER_MIN predictions; fewer is a one-off counterparty), mine, L, agg, F } */
  async function headline(addr, m, signal) {
    const { norms, hist } = m;
    const asBettor = norms.filter((n) => n.predictor === addr), asMaker = norms.filter((n) => n.counterparty === addr);
    const isMaker = asMaker.length > asBettor.length;
    const mine = isMaker ? asMaker : asBettor;
    // the secondary market: PnL follows the position tokens, so a sold prediction's result is no longer (all) this wallet's
    const L = P.ledger(norms, m.trades || [], addr);
    if (!mine.length && !hist.some((x) => x.total) && !L.trades.length) return null;
    // the winnings to claim from the wallet's winning tokens still held, where read (P.applyClaims; it also marks each won
    // prediction n.toClaim for the chips and the dialog): a self-matched prediction's pot is set apart, and offline a
    // balance on none of the file's predictions or trades too where the snapshot leaves out the wallet's launch-day tests
    // (only where every record names its pick configuration: a file from before pk could not tell its own balances apart)
    const claim = m.claim ? P.applyClaims(norms, addr, m.claim, { self: m.selfNorms || [], pcs: L.trades.map((t) => t.pc).filter(Boolean), dropUnknown: !m.live && !m.truncated && !!m.pre && norms.every((n) => n.pc || n.pk) }) : null;
    // a truncated file counts only its newest won predictions: the positions to claim stand for them
    const claimWon = (c) => (m.truncated ? c.positions : (isMaker ? c.wonC : c.wonP) || (c.payout > 0.005 ? c.positions : 0));
    // The headline figures count from the verdict (claimed or not), the record as the app does (claimed only). The
    // exchange's own history counts only claimed predictions, so the decided-but-unclaimed ones (the PnL offline, the
    // site's record in the tooltips) come from the predictions loaded here, which is exact while they are
    // all loaded (up to 300 live, 600 in a snapshot file). A larger account (every market maker, heavy bettors) would
    // count only the unclaimed ones inside that window, so its figures come from the published snapshot's aggregate for
    // this wallet instead, which covers every prediction as of its build.
    const agg = m.truncated ? await (async () => { try { const snap = await P.loadSnapshot({ signal }); if (!snap || !snap.remote || !snap.agg) return null; const row = (isMaker ? snap.agg.makers : snap.agg.bettors).find((r) => r.address === addr); return row ? Object.assign({ at: snap.builtAt }, row) : null; } catch (e) { return null; } })() : null;
    // Checked against the exchange: its account history books PnL at the verdict (its cumulative PnL equals the sum of
    // every decided prediction's result, claimed or not), while its won / lost counts move only when a prediction is
    // claimed. So live, the PnL is the exchange's as it stands, and so is the record, which is the app's (its Positions
    // Won / Lost); the site's count at the verdict adds the unclaimed ones, for the tooltips. The snapshot fallback
    // rebuilds its history from claims, so there the unclaimed results are added to the PnL too.
    const totals = hist.reduce((a, x) => { a.won += x.won; a.lost += x.lost; a.pending += x.pending; a.nd += x.nonDecisive; a.pnl += x.pnl; return a; }, { won: 0, lost: 0, pending: 0, nd: 0, pnl: 0 });
    const marketMaker = isMaker && P.isMarketMaker(agg ? agg.n : asMaker.length);   // a one-off counterparty (P.MAKER_MIN) is not a market maker, as on the Market makers page
    const fig = agg ? null : P.bettorFigures({ mine, hist, isMaker, live: m.live, ledger: L, truncated: m.truncated, selfPending: m.selfPending || 0, claim });
    // the record is Meridian's app's (claimed predictions only): live the exchange's own counts, else the snapshot row's
    // (P.rowRecord; a snapshot from before it kept them: its verdict count, appBasis false); vWon / vLost the site's
    // count at the verdict, for the tooltips
    const aRec = agg ? (m.live ? { won: totals.won, lost: totals.lost, app: true } : P.rowRecord(agg)) : null;
    const F = agg
      ? { pnl: m.live ? totals.pnl : agg.pnl, pnlNote: m.live ? 'decided, claimed or not · exchange stats' : `decided, claimed or not · as of the snapshot ${U.fmtAgo(agg.at)}`, won: aRec.won, lost: aRec.lost, vWon: agg.won, vLost: agg.lost, appBasis: aRec.app, nd: agg.nd || 0, open: agg.open, unclaimedWon: claim ? claimWon(claim) : agg.unclaimedWon, unclaimedPayout: claim ? claim.payout : agg.unclaimedPayout, claim, roi: agg.roi, roiNote: 'on decided stakes and any sold share of open ones · all predictions', avgOdds: agg.avgOdds, avgLegs: agg.avgLegs, fromSnap: true }
      : Object.assign(fig, { appBasis: true, pnlNote: (m.live ? 'decided, claimed or not · exchange stats' : 'decided, claimed or not · from predictions') + (L.trades.length ? ' · incl. the secondary market' : ''),
        roiNote: 'on decided stakes' + (fig.soldOpen > 0.005 ? ' and the sold share of open ones' : '') + (L.trades.length ? ' · incl. the secondary market' : ''), fromSnap: false });
    // Open as Meridian's Open Positions (one per pick configuration and side with tokens still held): live the API's own
    // count, else from the loaded predictions, or the snapshot's row where they are not all loaded (an older snapshot has
    // none: then undecided predictions, as before). openPreds keeps the undecided predictions (the share card counts them).
    const openPos = m.live && m.openPosTotal != null ? m.openPosTotal : agg ? (agg.openPos != null ? agg.openPos : null) : fig.openPos;
    F.openPreds = F.open; F.openIsPos = openPos != null; if (openPos != null) F.open = openPos;
    // the record's tooltip, the site's count at the verdict beside the app's (a summary elsewhere can carry it too)
    F.recordTitle = recTitle(F.appBasis, F.vWon != null ? F.vWon : F.won, F.vLost != null ? F.vLost : F.lost);
    return { asBettor, asMaker, isMaker, marketMaker, mine, L, agg, F };
  }
  /** Headline figures of a wallet for a summary elsewhere (the perps account's Overview): { m, isMaker, marketMaker, mine, L, F } or null.
   *  F.won / F.lost are the record as Meridian's app counts it (claimed predictions only; F.appBasis false: an older
   *  snapshot's count at the verdict), F.vWon / F.vLost the site's count at the verdict, F.recordTitle the tooltip saying both. */
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
    // a wallet whose only predictions are launch-day tests has no file: say so rather than "no activity" (the app counts them)
    const preOnly = P.preLaunchOf(addr);
    if (!m) { noActivity(preOnly ? `Only ${preOnly.n} launch-day test prediction${preOnly.n === 1 ? '' : 's'}, dated before ${LAUNCH_DAY}: the snapshot leaves those out (Meridian's app counts them).` : 'No Meridian Predict activity for this address (as of the last snapshot).'); return; }
    const x = await headline(addr, m, ctx.signal);
    if (ctx.signal.aborted) return;
    if (!x) { noActivity('No Meridian Predict activity for this address.'); return; }
    const { norms, hist } = m;
    const { asBettor, asMaker, isMaker, marketMaker, mine, L, agg, F } = x;
    const heldOf = (n) => { const bp = L.byPrediction[n.id]; return bp ? bp.held : 1; };
    // live positions already carry the balance the wallet holds; the snapshot's open predictions leave out what was sold,
    // and become Meridian's positions (P.groupPositions: one per pick configuration and side, its bets' stakes and pots
    // summed: 0xaedd…'s six bets on one Clarity Act YES are one position, $138 paying $726.72)
    // (a position matched in full with the other side's tokens it bought back pays the same whatever the verdict and
    // holds no balance on Meridian, which burns the pair: like one sold out, it is not open; P.riskOf)
    const riskOf = (r) => { const bp = L.byPrediction[r.id]; return bp ? P.riskOf(bp) : 1; };
    const heldRows = m.posRows.filter((r) => !r.id || m.live || riskOf(r) > 1e-6);
    const posRows = m.live ? heldRows : P.groupPositions(heldRows);
    // open positions missing from the table: sold out or bought back on the secondary market, or (a truncated file)
    // older than its newest predictions (F.open counts positions held where it can, else undecided predictions, sold
    // ones included)
    const soldOut = m.live ? 0 : P.groupPositions(m.posRows.filter((r) => r.id && heldOf(r) <= 1e-6)).length;
    const matched = m.live ? 0 : P.groupPositions(m.posRows).length - posRows.length - soldOut;
    const older = !m.live && m.truncated ? Math.max(0, F.open - (F.openIsPos ? posRows.length : m.posRows.length)) : 0;
    const openNote = [posRows.length >= F.open ? String(posRows.length) : `${posRows.length} of ${U.fmtNum(F.open, 0)} open`, soldOut ? `${U.fmtNum(soldOut, 0)} sold on the secondary market` : null, matched > 0 ? `${U.fmtNum(matched, 0)} closed by buying the other side back` : null, older ? `${U.fmtNum(older, 0)} older ones not loaded` : null, m.live && m.posCapped ? `the newest ${P.PAGE} positions` : null].filter(Boolean).join(' · ');
    // a truncated file holds its newest predictions and the older ones on positions it traded (loadBettor: older)
    const nOlder = m.older ? mine.filter((n) => m.older.has(n.id)).length : 0, nNewest = mine.length - nOlder;
    const loaded = 'newest ' + U.fmtNum(nNewest, 0) + (nOlder ? ` and ${U.fmtNum(nOlder, 0)} older ones on positions it traded on the secondary market` : '');
    // a row's dialog: this wallet's own ledger entry where it is the bettor (what it still held, its result with the sale)
    const openRow = (n) => { const bp = L.byPrediction[n.id]; openPrediction(n, ctx, bp && n.predictor === addr ? { here: addr, traded: true, held: bp.held, ledgerPnl: bp.pnl } : { here: addr, traded: !!bp }); };
    // what the site leaves out of a wallet's figures, said on each figure it changes (the app counts them): its
    // self-matched predictions (one wallet on both sides: no money moves) and, offline, its launch-day tests (P.PRE_LAUNCH)
    const selfN = m.selfN || 0, pre = m.live ? null : m.pre;
    const leftN = selfN + (pre ? pre.n : 0);
    const exclText = leftN ? 'excl. ' + [selfN ? selfN + ' self-matched' : null, pre ? pre.n + ' pre-launch' : null].filter(Boolean).join(' and ') + ' prediction' + (leftN === 1 ? '' : 's') : '';
    const exclTitle = [selfN ? `${selfN} self-matched prediction${selfN === 1 ? '' : 's'}: this wallet on both sides, which moves no money, so the site leaves ${selfN === 1 ? 'it' : 'them'} out of every figure` : null,
      pre ? `${pre.n} launch-day test prediction${pre.n === 1 ? '' : 's'}, dated on-chain before ${LAUNCH_DAY}, which the snapshot leaves out` : null].filter(Boolean).join('; ') + '. Meridian\'s app counts them.';
    const exclEl = (extra) => (exclText ? h('span', { title: exclTitle + (extra || '') }, exclText) : null);
    // the app's Claimable Payout and the site's share of it (P.applyClaims), where the balances were read
    const CL = F.claim || null;
    // offline: the cumulative result from the predictions themselves, each at its settlement (js/cards.js
    // curveFromPredictions). A truncated file's curve is the one the snapshot built from every prediction; a file built
    // before it carried one gets none (its loaded predictions are not the whole history). A wallet on both sides is drawn
    // for the role the headline counts, ending at the headline: { pts, anchored }
    const verdictCurve = () => {
      if (m.curve) return { pts: m.curve, anchored: false };   // built by the snapshot from every prediction
      if (m.truncated) return null;   // the loaded predictions cannot draw a truncated wallet's whole curve
      const both = !!(asBettor.length && asMaker.length);
      const c = MD.cards.make({ U, P }).curveFromPredictions(both ? mine : norms, m.trades || [], addr);
      if (!c || c.length < 2) return null;
      const shift = both ? F.pnl - c[c.length - 1][1] : 0;
      return { pts: Math.abs(shift) > 0.005 ? c.map(([s, v]) => [s, Math.round((v + shift) * 100) / 100]) : c, anchored: Math.abs(shift) > 0.005 };
    };
    // Equity curve flex (js/flex.js): all time, from the exchange's own history when live, else from the predictions the
    // way the snapshot counts them (decided at the verdict, traded positions through the token ledger); a wallet whose
    // whole curve is not at hand gets its card without one rather than a partial one. A wallet without predictions of its
    // own (it only trades tokens) has no card behind a share link.
    const openFlex = () => {
      const K = MD.cards.make({ U, P });
      MD.flex.open({ address: addr, what: 'wallet', periods: [{ v: 'all', label: 'All time' }], period: 'all', shareUrl: mine.length ? MD.api.shareUrl('p', addr) : null, build: async () => {
        const act = hist.findIndex((x) => x.total || x.pnl);
        const curve = m.live ? (act >= 0 ? hist.slice(Math.max(0, act - 1)).map((x) => [Math.round(x.t / 1000), Math.round(x.cumPnl * 100) / 100]) : null) : (verdictCurve() || {}).pts || null;
        const cats = {}, catW = {}; for (const n of mine) { cats[n.cat] = (cats[n.cat] || 0) + 1; catW[n.cat] = (catW[n.cat] || 0) + (isMaker ? n.cp : n.stake); }
        const topCat = agg ? agg.topCat : P.topCategory(cats, catW);
        const decided = (F.won || 0) + (F.lost || 0);
        // open: undecided predictions, as the cards the snapshot draws count them; the record is the headline's, the
        // app's where F has it (appWon…, as the snapshot's rows carry it: P.rowRecord)
        const row = { address: addr, pnl: F.pnl, roi: F.roi, won: F.won, lost: F.lost, winRate: decided ? (F.won / decided) * 100 : null,
          appWon: F.appBasis ? F.won : undefined, appLost: F.appBasis ? F.lost : undefined, appWinRate: F.appBasis ? (decided ? (F.won / decided) * 100 : null) : undefined, wagered: agg && !m.live ? agg.wagered : m.totalVolume, n: agg ? agg.n : mine.length, avgOdds: F.avgOdds, open: F.openPreds != null ? F.openPreds : F.open, topCat, first: agg ? agg.first : mine.length ? Math.min(...mine.map((n) => n.t)) : null };
        const inp = K.walletInput(row, curve && curve.length >= 2 ? curve : null, isMaker);
        if (!inp.curve && !m.live && m.truncated) inp.noCurveText = 'Curve not drawn: over 600 predictions';
        return inp;
      } });
    };
    // the Volume tile and Meridian's Volume, which also counts both sides of a self-match and the launch-day tests
    const volume = agg && !m.live ? agg.wagered : m.totalVolume;   // a snapshot file holds only the newest predictions; the aggregate has them all
    const appVolume = volume + (m.selfVol || 0) + (pre ? pre.v : 0);
    // the open stake held, and Meridian's Active Stake (its deployed collateral), which still counts open positions whose
    // tokens were sold (0xaca4…: $0 held, $182 in the app); a truncated file still holds every prediction on a pick
    // configuration the wallet traded, so the aggregate's open stake less the open ones it sold out of is exact
    const openAll = m.truncated && agg && !m.live ? agg.openWagered : U.sum(m.posRows, (r) => r.stake);
    const openHeld = m.truncated && agg && !m.live ? agg.openWagered - U.sum(m.posRows.filter((r) => r.id && riskOf(r) <= 1e-6), (r) => r.stake) : U.sum(posRows, (r) => r.stake);
    const nPos = (k) => `${U.fmtNum(k, 0)} position${k === 1 ? '' : 's'}`;
    const tiles = h('div.stats',
      // (the exchange's PnL live, from its start: launch-day tests included, as in the app)
      UI.stat(isMaker ? (marketMaker ? 'Maker PnL' : 'Counterparty PnL') : 'Net PnL', usd(F.pnl, { sign: true }), pre ? h('span', F.pnlNote + ' · ', exclEl()) : F.pnlNote, U.pnlClass(F.pnl)),
      // a wallet that only trades tokens has placed nothing: what it paid and was paid on the secondary market instead
      !mine.length && L.trades.length ? UI.stat('Traded', usd(U.sum(L.trades, (t) => t.paid), { compact: true }), 'on the secondary market · no predictions placed')
        : UI.stat('Volume', usd(volume, { compact: true }), exclText ? h('span', 'all time · ', exclEl(` Meridian's Volume, with them: ${cents(appVolume)}.`)) : 'all time'),
      // a decided loss is a loss whether or not the winner has claimed: only this side's own wins waiting to be collected are called out
      // (a maker's uncollected wins are its own business and change none of these figures: not called out)
      // the record and win rate as Meridian's app counts them (claimed only), the site's count at the verdict in the tooltip
      UI.stat('Record', h('span', { title: F.recordTitle }, `${U.fmtNum(F.won, 0)}W / ${U.fmtNum(F.lost, 0)}L`), ((s) => (s || exclText ? h('span', s, exclText ? [s ? ' · ' : '', exclEl()] : null) : null))([F.open ? (F.openIsPos ? nPos(F.open) : U.fmtNum(F.open, 0)) + ' open' : null, F.unclaimedWon && !isMaker ? U.fmtNum(F.unclaimedWon, 0) + ' won, not yet claimed' : null, F.nd ? F.nd + ' void' : null].filter(Boolean).join(' · '))),
      UI.stat('Win rate', h('span', { title: F.recordTitle }, F.won + F.lost ? winPct((F.won / (F.won + F.lost)) * 100) : '—'), F.appBasis ? 'of claimed predictions, as in Meridian\'s app' : 'of decided predictions'),
      UI.stat('ROI', F.roi == null ? '—' : U.fmtPct(F.roi, { sign: true, dp: 0 }), F.roiNote, U.pnlClass(F.roi)),
      UI.stat(isMaker ? 'Avg bettor odds' : 'Avg odds', pct(F.avgOdds, 0), F.avgLegs ? 'avg ' + U.fmtNum(F.avgLegs, 1) + ' legs' : null),
      m.balance == null ? UI.stat('Open stake', usd(openHeld), h('span', { title: 'The stakes of its open positions it still holds. Meridian\'s Active Stake (its deployed collateral) also counts open positions whose tokens were sold, or matched with the other side bought back, on the secondary market' + (openAll - openHeld > 0.005 ? `: ${cents(openAll)}` : '') + '.' },
        (m.truncated && !agg && !m.live ? 'in open positions held · among the predictions loaded' : 'in open positions held') + (openAll - openHeld > 0.005 ? ` · Meridian's Active Stake ${usd(openAll)} counts sold ones too` : '')))
        // the claimable part is the app's Claimable Payout (its winning tokens still held, read now), not the daily
        // history's claimable collateral (0x21a6…: $11,582 there, nothing left to claim)
        : UI.stat('Collateral', usd(m.balance), CL && CL.total > 0.005 ? h('span', { title: 'Meridian\'s Claimable Payout: the winning position tokens this wallet still holds' }, cents(CL.total) + ' claimable') : 'in Predict'),
      UI.stat('Open', U.fmtNum(F.open, 0), F.openIsPos
        ? h('span', { title: 'Meridian\'s Open Positions: one per pick configuration and side with tokens still held. Bets on the same picks share one position, and a position whose tokens were all sold is none.' }, `position${F.open === 1 ? '' : 's'} held, not yet decided` + (F.openPreds != null && F.openPreds !== F.open ? ` · ${U.fmtNum(F.openPreds, 0)} undecided prediction${F.openPreds === 1 ? '' : 's'}` : ''))
        : F.open === 1 ? 'prediction, not yet decided' : 'predictions, not yet decided'),
      // winnings are collected in the Meridian app (its Predict portfolio claims them all at once). With the balances
      // (CL) it is the app's Claimable Payout, less a self-matched prediction's pot and, offline, the launch-day tests',
      // which the site leaves out and names with the app's figure; to the cent, as the app shows what there is to claim
      !isMaker && (CL ? CL.total > 0.005 : F.unclaimedWon) ? UI.stat('Unclaimed winnings', CL ? cents(F.unclaimedPayout) : usd(F.unclaimedPayout), h('span',
        CL ? h('span', { title: 'The winning position tokens this wallet still holds: one per pick configuration and side, each pays $1' + (m.live ? '' : `, as the snapshot read them ${U.fmtAgo(m.builtAt)}`) }, `${nPos(CL.positions)} to claim`) : `${U.fmtNum(F.unclaimedWon, 0)} won prediction${F.unclaimedWon > 1 ? 's' : ''} to claim`,
        CL && (CL.self > 0.005 || CL.other > 0.005) ? h('div.xs', { title: exclTitle }, [CL.self > 0.005 ? `excl. ${cents(CL.self)} on ${CL.selfN === 1 ? 'a self-matched prediction' : CL.selfN + ' self-matched predictions'}` : null, CL.other > 0.005 ? `excl. ${cents(CL.other)} on pre-launch predictions` : null].filter(Boolean).join(' · ') + ` · Meridian's Claimable Payout ${cents(CL.total)}`) : null,
        h('div', { style: { marginTop: '8px' } }, h('a.btn.sm', { href: P.CLAIM_URL, target: '_blank', rel: 'noopener', title: 'Opens the Predict portfolio in the Meridian app, where the wallet\'s owner claims every payout at once' }, U.icon('external'), 'Claim on Meridian'))), 'pos') : null);
    const cPnl = h('canvas'), cVol = h('canvas');
    // Cumulative PnL, every result at its settlement (the verdict), never at its claim. Live: the exchange's own daily
    // history, booked at the verdict. Offline that history is rebuilt from claims (the tax center's cash basis), which
    // lags every wallet that leaves wins uncollected, so the curve comes from the verdicts like the headline
    // (verdictCurve, above); a wallet on both sides is drawn for the role the headline counts. A truncated file without
    // the snapshot's curve gets none: the claim-based history of its loaded predictions is not the wallet's.
    const firstAct = hist.findIndex((x) => x.total || x.volume);
    const h2 = firstAct >= 0 ? hist.slice(Math.max(0, firstAct - 1)) : hist;
    let pnlPts = h2.map((x) => ({ x: x.t, y: x.cumPnl })), anchored = false;
    const vc = m.live ? null : verdictCurve();
    if (vc) { anchored = vc.anchored; pnlPts = vc.pts.map(([s, v]) => ({ x: s * 1000, y: v })); }
    const noCurve = !m.live && m.truncated && !vc;
    const pnlNote = !m.live && anchored ? 'ends at the all-time PnL' : null;
    // Daily volume: offline, a truncated file's stake per UTC day from the snapshot (a file built before it carried them:
    // the history of its newest predictions, from the first full day they cover). Live, the exchange's daily volume also
    // counts the wallet's secondary-market trades (every sale and purchase, checked 2026-10-02) while the Volume tile
    // counts predictions only: they are taken out so the bars add up to the tile, as offline.
    const tradeDay = {}; if (m.live) for (const t of m.trades || []) if (t.seller === addr || t.buyer === addr) { const k = Math.floor(t.t / 86400000) * 86400000; tradeDay[k] = (tradeDay[k] || 0) + t.paid; }
    const windowDay = m.windowFrom ? Math.floor(m.windowFrom / 864e5) * 864e5 + 864e5 : null;   // the first full UTC day of the newest predictions
    const volPts = m.daily ? m.daily.map(([t, v]) => ({ x: t, y: v }))
      : m.live ? h2.map((x) => ({ x: x.t, y: Math.max(0, x.volume - (tradeDay[x.t] || 0)) }))
        : (windowDay ? h2.filter((x) => x.t >= windowDay) : h2).map((x) => ({ x: x.t, y: x.volume }));
    const volNote = !m.live && m.truncated && !m.daily && windowDay ? 'since ' + U.fmtDayUTC(windowDay) + ' · newest ' + U.fmtNum(nNewest, 0) + ' predictions' : null;
    // Meridian's Volume bars are its daily account volume, the wallet's token sales and purchases included (0xc1ce…, Jul
    // 16: $369.07 there, $170.61 of stakes): the chart says it shows stakes, and how much trading it leaves out
    const tradedAll = U.sum(L.trades, (t) => t.paid);
    const volTitle = 'The stakes this wallet placed each UTC day' + (isMaker ? ' (its collateral, as the maker)' : '') + '. Meridian\'s Volume bars also count its sales and purchases of position tokens on the secondary market' + (tradedAll > 0.005 ? ` (${usd(tradedAll)} in all)` : ' (none here)') + '; they are left out so the bars add up to the Volume tile.';
    // Open positions: one resolution line per leg (Polymarket + UMA oracle), a combo settles once every leg has resolved
    const legView = (k) => ({ end: k.endTime, settled: !!k.settled, yes: k.resolvedToYes, nd: !!k.nonDecisive, question: k.q });
    const legCell = (r) => h('div.legs', r.picks.map((k) => (k.id
      ? h('div', { style: { cursor: 'pointer' }, title: 'Resolution details', onclick: (e) => { e.stopPropagation(); R.openDetails(legView(k), k.id, { appUrl: P.APP_URL }); } }, R.line(legView(k), k.id))
      : h('div.res-line', h('span.dim.small', k.endTime ? (k.endTime > Date.now() ? 'in ' + U.fmtCountdown(k.endTime - Date.now()) : 'pending') : '—')))));
    const openWrap = h('div');
    // a row opens its prediction where it is among the loaded predictions (a live position names it too)
    const byId = new Map(posRows.some((r) => r.id) ? norms.map((n) => [n.id, n]) : []);
    // a position with a leg the source market already resolved against is lost, only the settlement is pending: it
    // leaves the table (nothing to watch) and is counted underneath instead
    // (a leg Meridian has settled is decided: R.pickLost looks at the source market only)
    const lostPos = (r) => r.side !== 'COUNTERPARTY' && r.picks.some((k) => (k.settled ? k.nonDecisive || k.resolvedToYes !== !!k.yes : R.pickLost(k, k.id)));
    // the chance now: the legs' results and Polymarket's prices once loaded (pickProb), else the row's stored chance
    const fairNow = (r) => { const ps = r.picks.map(pickProb); if (!ps.length || ps.some((p) => p == null)) return r.fair; const f = ps.reduce((a, p) => a * p, 1); return r.side === 'COUNTERPARTY' ? 1 - f : f; };
    const renderOpen = () => { const lost = posRows.filter(lostPos); const rows = posRows.filter((r) => !lostPos(r)); U.replace(openWrap, UI.table({ cols: [
      // a position holding several bets on the same picks says so (the row opens the largest of them)
      { key: 'q', label: 'Prediction', render: (r) => h('div', { style: { whiteSpace: 'normal', maxWidth: '460px', lineHeight: '1.3' } }, r.picks.map((k, i) => h('div', sideChip(k.yes), ' ', k.q)), r.n > 1 ? h('div.xs.dim', { title: 'Bets on the same picks and side share one position token: Meridian shows them as one position, their stakes and payouts summed. A click opens the largest.' }, `${r.n} bets, one position`) : null) },
      { key: 'side', label: 'Role', render: (r) => (r.side === 'COUNTERPARTY' ? UI.chip(marketMaker ? 'maker' : 'counterparty', 'blue') : UI.chip('bettor', '')) },
      // one position each: its stake and what it pays to the cent, as Meridian's position cards show them ($138 paying $726.72)
      { key: 's', label: 'Stake', num: true, render: (r) => cents(r.stake) },
      { key: 'o', label: 'Locked odds', num: true, render: (r) => oddsPct(r.odds) },
      { key: 'f', label: 'Chance now', num: true, title: 'This position\'s chance to win now: its legs multiplied, taken as independent. A leg Meridian has settled counts as won or lost, an open one at Polymarket\'s price; until Polymarket has loaded, Meridian\'s estimate' + (m.live ? '' : ' from the snapshot') + ' (marked), which stops moving once a game starts',
        render: (r) => { const f = fairNow(r); if (f == null) return h('span.dim', '—'); const live = r.picks.every(pickLive); return h(live ? 'span' : 'span.dim', pct(f, 1), live ? null : h('span.xs', m.live ? ' (estimate)' : ' (snapshot)')); } },
      { key: 'p', label: 'Pays', num: true, render: (r) => h('span', cents(r.payout), h('span.dim.xs', ' (' + mult(r.stake ? r.payout / r.stake : null) + ')')) },
      { key: 'e', label: 'Resolution', title: 'Where each leg is in the Polymarket / UMA resolution pipeline', render: legCell },
    ], rows, empty: lost.length ? 'Nothing still in play' : soldOut ? 'No open position still held: sold on the secondary market' : 'No open positions', onRow: byId.size ? (r) => { const n = r.id && byId.get(r.id); if (n) openRow(n); } : null }), lost.length ? h('div.footer-note', { style: { textAlign: 'left', padding: '10px 14px' } }, `${lost.length} position${lost.length > 1 ? 's' : ''} (${usd(U.sum(lost, (r) => r.stake))} staked) with a leg already resolved against this bettor (settled on Meridian, or resolved on Polymarket) only await the prediction's settlement on Meridian.`) : null); };
    renderOpen();
    // the open positions' legs (their oracle too), and the legs of open predictions no longer held (sold), whose history
    // row's chip says in its title whether a leg already decided it on the source market (pendingVerdict)
    const legIds = posRows.flatMap((r) => r.picks.map((k) => k.id)).filter(Boolean);
    const allIds = Array.from(new Set(legIds.concat(mine.filter((n) => !n.decided).flatMap((n) => n.picks.map((k) => k.id)).filter(Boolean))));
    // (then the open legs' order-book midpoints, for the chance now as Meridian's app shows it, asked again each minute)
    const openLegIds = Array.from(new Set(legIds));
    if (allIds.length) (async () => { try { await R.load(allIds, { signal: ctx.signal, deep: false }); if (ctx.signal.aborted) return; renderOpen(); if (mine.some((n) => !n.decided && pendingVerdict(n))) renderHist(); if (await loadMids(openLegIds, ctx.signal) && !ctx.signal.aborted) renderOpen(); if (legIds.length) { await R.load(legIds, { signal: ctx.signal, deep: true }); if (!ctx.signal.aborted) renderOpen(); } } catch (e) { if (!isAbort(e)) console.warn('resolution tracker', e); } })();
    resTicker(ctx, () => { renderOpen(); if (openLegIds.length) loadMids(openLegIds, ctx.signal).then((ok) => { if (ok && !ctx.signal.aborted) renderOpen(); }).catch(() => {}); });
    let hpage = 1; const histWrap = h('div');
    const renderHist = () => { const slice = mine.slice((hpage - 1) * PAGE, hpage * PAGE); U.replace(histWrap, UI.table({ cols: [
      { key: 't', label: 'Placed', render: (n) => h('span.dim', U.fmtDateTimeS(n.t)) },
      { key: 'q', label: 'Prediction', render: (n) => h('div', { style: { whiteSpace: 'normal', maxWidth: '460px', lineHeight: '1.3' } }, n.picks.slice(0, 3).map((k) => h('div', sideChip(k.yes), ' ', k.q)), n.legs > 3 ? h('div.xs.dim', '+' + (n.legs - 3) + (n.legs === 4 ? ' more leg' : ' more legs')) : null) },
      { key: 'c', label: 'Category', render: (n) => n.cat },
      { key: 's', label: isMaker ? 'Bettor stake' : 'Stake', num: true, render: (n) => usd(n.stake) },
      { key: 'o', label: isMaker ? 'Bettor odds' : 'Odds', num: true, render: (n) => h('span', oddsPct(n.odds), h('span.dim.xs', ' ' + mult(n.multiple))) },
      { key: 'v', label: 'Vig', num: true, title: 'Locked odds minus the Polymarket price at the moment of the bet', render: (n) => vigCell(n.vig, n) },
      { key: 'cp', label: isMaker ? 'Bettor' : 'Maker', render: (n) => bettorLink(isMaker ? n.predictor : n.counterparty) },
      // 'sold' only for a sale (only a sale lowers held); 'hedged' where the wallet also bought the other side, whose
      // matched amount books its result before the verdict. An undecided prediction is shown as Meridian's app shows it,
      // from this wallet's side: lost or won once the legs Meridian has settled tell, else open, with what the source
      // markets already say in the chip's title (undecidedChip)
      { key: 'r', label: 'Result', render: (n) => { const bp = L.byPrediction[n.id]; return h('span', (!n.decided && undecidedChip(n, isMaker)) || resultChip(n, isMaker, bp ? bp.held : 1),
        bp && bp.held < 0.999 ? h('span.dim.xs', { title: 'This wallet sold these position tokens on the secondary market: its PnL is the sale plus whatever it still held at the verdict' }, bp.held < 1e-6 ? ' sold' : ` ${U.fmtPct((1 - bp.held) * 100, { dp: 0 })} sold`) : null,
        bp && bp.hedged && bp.held >= 0.999 ? h('span.dim.xs', { title: 'This wallet also bought the other side\'s position tokens: the matched amount pays out whatever the verdict, and its result is booked when it held both sides' }, ' hedged') : null); } },
      // a prediction whose tokens were traded shows its share of the ledger's result (the sale, and the verdict on what was
      // still held); an open one without such a result has none yet
      { key: 'p', label: 'PnL', num: true, render: (n) => { const bp = L.byPrediction[n.id]; if (bp) return n.decided || Math.abs(bp.pnl) > 0.005 ? pnlEl(bp.pnl) : h('span.dim', '—'); return n.decided ? pnlEl(isMaker ? -n.pnl : n.pnl) : h('span.dim', '—'); } },
    ], rows: slice, empty: 'No predictions', onRow: openRow }), mine.length > PAGE ? UI.pager({ page: hpage, pageSize: PAGE, total: mine.length, onPage: (p) => { hpage = p; renderHist(); } }) : null); };
    renderHist();
    // secondary-market trades of this wallet: what it sold or bought, at what price, and what that did
    const secWrap = h('div'); let spage = 1;
    const saleOf = new Map(L.events.filter((e) => e.kind === 'sale' && e.trade).map((e) => [e.trade, e]));
    const tokValue = (t) => (t.side === 'P' ? t.vP : t.vC);
    // the bets behind a sale: those of its position (P.positions: this wallet's bets on the picks and side, which share
    // one token, until a sale leaves it holding nothing), never a bet placed after that
    const positions = L.trades.length ? P.positions(norms, L, addr, 'P').concat(P.positions(norms, L, addr, 'C')) : [];
    // (and placed by the time of the sale: a minute's grace for the trade clock running ahead of the bet's)
    const ownBets = (t) => { const e = saleOf.get(t); const p = e && positions.find((x) => x.sales.includes(e)); return p ? p.bets.filter((n) => n.t <= t.t + 60000) : []; };
    const betsNote = (t) => { const b = ownBets(t); if (!b.length) return null; const s = U.sum(b, (n) => (t.side === 'C' ? n.cp : n.stake));
      return h('div.dim.xs', { title: 'This wallet\'s bets on these picks and side: they share one position token, which is what it sold' }, `from ${b.length} bet${b.length === 1 ? '' : 's'} · ${usd(s)} ${t.side === 'C' ? 'collateral' : 'staked'}`); };
    const renderSec = () => { const slice = L.trades.slice((spage - 1) * PAGE, spage * PAGE); U.replace(secWrap, UI.table({ cols: [
      { key: 't', label: 'When', render: (t) => h('span.dim', U.fmtDateTimeS(t.t)) },
      { key: 'q', label: 'Prediction', render: (t) => h('div', { style: { whiteSpace: 'normal', maxWidth: '420px', lineHeight: '1.3' } }, t.q || '—', t.legs > 1 ? h('span.dim.xs', ' +' + (t.legs - 1) + (t.legs === 2 ? ' leg' : ' legs')) : null, t.seller === addr ? betsNote(t) : null) },
      { key: 'k', label: 'Trade', render: (t) => h('span', t.seller === addr ? UI.chip('sold', 'amber') : UI.chip('bought', 'blue'), h('span.dim.xs', t.seller === addr ? ' to ' : ' from '), bettorLink(t.seller === addr ? t.buyer : t.seller, 3)) },
      { key: 'n', label: 'Tokens', num: true, title: 'A token pays $1 if its side wins', render: (t) => U.fmtNum(t.tokens, 2) },
      { key: 'x', label: 'Price', num: true, title: 'Paid per token, i.e. per $1 of payout', render: (t) => (t.tokens ? U.fmtNum((t.paid / t.tokens) * 100, 1) + '¢' : '—') },
      { key: 'a', label: 'Amount', num: true, title: 'A sale: what the buyer paid for the tokens. A purchase: what this wallet paid', render: (t) => usd(t.paid) },
      // what the tokens sold had cost: the stakes behind them, at this wallet's average cost per token on these picks
      { key: 'c', label: 'Cost', num: true, title: 'A sale: what the tokens sold had cost this wallet (its stakes on these picks, or what it paid for tokens it bought, at its average cost per token). The result is the amount minus this', render: (t) => { if (t.seller !== addr) return h('span.dim', '—'); const e = saleOf.get(t); return e ? usd(e.cost) : h('span.dim', '—'); } },
      { key: 'o', label: 'Outcome', render: (t) => { const v = tokValue(t); return v == null ? UI.chip('open', 'accent') : v >= 0.999 ? UI.chip('won', 'green') : v <= 1e-9 ? UI.chip('lost', 'red') : UI.chip('void', 'amber'); } },
      { key: 'r', label: 'Result', num: true, title: 'A sale: its price minus what the tokens cost this wallet. A purchase: the payout minus the price, once decided', render: (t) => { if (t.seller === addr) { const e = saleOf.get(t); return e ? h('span', { title: `sold for ${usd(e.cash)} · cost ${usd(e.cost)}` }, pnlEl(e.pnl)) : h('span.dim', '—'); } const v = tokValue(t); return v == null ? h('span.dim', 'open') : pnlEl(t.tokens * v - t.paid); } },
    ], rows: slice, empty: 'No trades' }), L.trades.length > PAGE ? UI.pager({ page: spage, pageSize: PAGE, total: L.trades.length, onPage: (p) => { spage = p; renderSec(); } }) : null); };
    if (L.trades.length) renderSec();
    // the breakdowns from this wallet's side, adding up to the headline: a prediction whose tokens were traded counts its
    // ledger result (the History PnL column), a sale out of a still-open one included; win rate is this side's, odds stay
    // the bettors' (as on the Market makers page)
    const rowPnl = (n) => { const bp = L.byPrediction[n.id]; return bp ? (n.decided || Math.abs(bp.pnl) > 0.005 ? bp.pnl : 0) : n.decided ? (isMaker ? -n.pnl : n.pnl) : 0; };
    const breakdown = (key) => {
      const g = new Map();
      for (const n of mine) {
        const k = key(n); const r = g.get(k) || { k, n: 0, wagered: 0, oddsSum: 0, oddsN: 0, decided: 0, won: 0, pnl: 0, booked: false };
        r.n++; r.wagered += isMaker ? n.cp : n.stake;
        if (n.odds != null) { r.oddsSum += n.odds; r.oddsN++; }
        if (n.decided && !n.nd) { r.decided++; if (isMaker ? n.lost : n.won) r.won++; }
        const bp = L.byPrediction[n.id]; if (n.decided || (bp && Math.abs(bp.pnl) > 0.005)) r.booked = true;   // only open predictions without a sale: no PnL yet
        r.pnl += rowPnl(n); g.set(k, r);
      }
      return Array.from(g.values()).map((r) => Object.assign(r, { winRate: r.decided ? (r.won / r.decided) * 100 : null, avgOdds: r.oddsN ? r.oddsSum / r.oddsN : null }));
    };
    const catRows = breakdown((n) => n.cat).sort((a, b) => b.wagered - a.wagered), legRows = breakdown((n) => n.legs).sort((a, b) => a.k - b.k);
    const sideLabel = isMaker ? (marketMaker ? 'Maker ' : 'Counterparty ') : '';   // a one-off counterparty is no market maker (headline)
    const winCol = { key: 'wr', label: sideLabel ? sideLabel + 'win rate' : 'Win rate', num: true, title: BREAKDOWN_WIN_TITLE, render: (r) => (r.winRate == null ? '—' : U.fmtPct(r.winRate, { dp: 0 })) };
    const pnlCol = { key: 'p', label: sideLabel + 'PnL', num: true, render: (r) => (r.booked ? pnlEl(r.pnl) : h('span.dim', '—')) };
    const catTbl = UI.table({ cols: [{ key: 'c', label: 'Category', title: 'Mixed: a combo with legs in more than one category', render: (r) => r.k }, { key: 'n', label: 'Predictions', num: true, render: (r) => String(r.n) }, { key: 'w', label: isMaker ? 'Collateral committed' : 'Wagered', num: true, render: (r) => usd(r.wagered, { compact: true }) }, winCol, pnlCol], rows: catRows, empty: '—' });
    const comboTbl = UI.table({ cols: [{ key: 'l', label: 'Legs', render: (r) => (r.k === 1 ? 'Single' : r.k + '-leg') }, { key: 'n', label: 'Predictions', num: true, render: (r) => String(r.n) }, { key: 'o', label: isMaker ? 'Avg bettor odds' : 'Avg odds', num: true, render: (r) => pct(r.avgOdds, 0) }, winCol, pnlCol], rows: legRows, empty: '—' });
    // whose Predict wallet this is: the owner signs in to Meridian with it and holds the perps account (if any)
    const ownerEl = h('span.small');
    if (!opts.embedded) P.wallets.ownerOf(addr).then((o) => { if (o && !ctx.signal.aborted) U.replace(ownerEl, h('span.dim', 'Predict wallet of '), h('a.addr', { href: U.accountUrl(o, null, 'predict'), title: 'Owner ' + o + ' · its account page (its perps account, if it has one)' }, U.shortAddr(o, 4)), U.copyBtn(o)); }).catch(() => {});
    const nPred = (k) => `${U.fmtNum(k, 0)} prediction${k === 1 ? '' : 's'}`;
    U.replace(el, h('div.stack',
      h('div.row.wrap', !mine.length && L.trades.length ? UI.chip('secondary-market trader', 'blue') : isMaker ? UI.chip(marketMaker ? 'market maker' : 'one-off counterparty', 'blue') : UI.chip('bettor', 'accent'), ownerEl, h('span.dim.small', F.fromSnap ? `${nPred(agg.n)} · the tables show the ${loaded}; the figures below cover all of them, from the snapshot built ${U.fmtAgo(agg.at)}` : m.live ? `${nPred(mine.length)} · figures from Meridian's own account history` : `${nPred(mine.length)} · snapshot ${U.fmtAgo(m.builtAt)} · ${offlineNote}`, exclText ? [' · ', exclEl()] : null), h('span.grow'), h('button.btn.sm', { title: 'This wallet\'s PnL card, to download, copy or post', onclick: openFlex }, U.icon('trophy'), 'Equity curve flex'), h('a.btn.sm.ghost', { href: P.APP_URL, target: '_blank', rel: 'noopener' }, U.icon('external'), 'Predict app')),
      tiles,
      // offline, a truncated file's curve and daily volume are the snapshot's, from every prediction; say what is shown when they are not
      h('div.grid.cols-2', h('div.card', h('div.row', { style: { marginBottom: '10px' } }, h('h3', 'Cumulative PnL'), h('span.grow'), pnlNote ? h('span.dim.xs', pnlNote) : null), noCurve ? h('div.empty.small', 'This wallet has more predictions than its file holds; its curve comes with the next snapshot') : h('div.chart-box.sm', cPnl)), h('div.card', h('div.row', { style: { marginBottom: '10px' } }, h('h3', { title: volTitle }, 'Stakes per day (UTC)'), h('span.grow'), h('span.dim.xs', { title: volTitle }, (volNote ? volNote + ' · ' : '') + 'excl. token trades')), h('div.chart-box.sm', cVol))),
      UI.card('Open positions', openWrap, h('span.dim.small', openNote)),
      UI.card('Prediction history', histWrap, h('span.dim.small', 'newest first')),
      L.trades.length ? UI.card('Secondary market', secWrap, h('span.dim.small', `${L.trades.length} trade${L.trades.length > 1 ? 's' : ''} · positions sold or bought before the verdict · ${usd(L.pnl, { sign: true })} from traded positions`)) : null,
      h('div.grid.cols-2', UI.card('By category', catTbl), UI.card('Singles vs combos', comboTbl))));
    const col = C.colors();
    const endPnl = pnlPts.length ? pnlPts[pnlPts.length - 1].y : 0;
    // the daily history (live: statsHistory; offline without a verdict curve: rebuilt per day) is in UTC days, a verdict
    // curve in exact settlement times
    if (!noCurve) C.timeSeries(cPnl, { points: pnlPts, color: endPnl >= 0 ? col.green : col.red, label: 'PnL', titleFmt: vc ? undefined : U.fmtDayUTC });
    C.timeSeries(cVol, { points: volPts, type: 'bar', color: col.accent, label: isMaker ? 'Collateral' : 'Stakes', titleFmt: U.fmtDayUTC });
  };
})();
