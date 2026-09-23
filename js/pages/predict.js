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
  const sourceLink = (c) => { const m = c.similarMarket && c.similarMarket.markets && c.similarMarket.markets[0]; return m ? h('a.btn.sm.ghost', { href: m, target: '_blank', rel: 'noopener', title: m }, U.icon('external'), /polymarket/i.test(m) ? 'Polymarket' : 'Source') : null; };

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
      const fn = { '/predict': mountOverview, '/predict/bettors': mountBettors, '/predict/questions': mountQuestions, '/predict/makers': mountMakers, '/predict/vig': mountVig, '/predict/bettor': mountBettorPage }[path];
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
      const a = snap.agg; const T = a.totals;
      const tiles = h('div.stats',
        UI.stat('Predictions', U.fmtNum(T.n, 0), T.decided != null ? `${U.fmtNum(T.open, 0)} open · ${U.fmtNum(T.decided, 0)} decided · ${U.fmtNum(T.settled, 0)} claimed` : `${U.fmtNum(T.open, 0)} open · ${U.fmtNum(T.settled, 0)} settled`),
        UI.stat('Wagered', usd(T.wagered, { compact: true }), 'bettor stakes'),
        UI.stat('Maker collateral', usd(T.cpCommitted, { compact: true }), 'put up against those stakes'),
        UI.stat('Bettors', U.fmtNum(T.bettors, 0), `${T.makers} market makers`),
        UI.stat('Bettor win rate', T.winRate == null ? '—' : U.fmtPct(T.winRate, { dp: 1 }), 'of decided predictions'),
        UI.stat('Bettor net result', usd(T.bettorPnl, { sign: true }), 'decided, claimed or not · incl. positions sold on the secondary market', U.pnlClass(T.bettorPnl)),
        T.unclaimedWon ? h('a', { href: '#/predict/questions?status=settled', style: { display: 'contents' } }, UI.stat('Unclaimed winnings', U.fmtNum(T.unclaimedWon, 0), `won predictions not yet claimed · ${usd(T.unclaimedWonPayout, { compact: true })} of payouts · ${U.fmtNum(T.unclaimedLost, 0)} lost ones unclaimed by makers`, 'pos')) : null,
        UI.stat('Combos', T.n ? U.fmtPct((T.combos / T.n) * 100, { dp: 0 }) : '—', 'of predictions are multi-leg'),
        UI.stat('Avg vig paid', a.vig.overall.avg == null ? '—' : pp(a.vig.overall.avg), 'odds vs Polymarket price at bet time'));
      // settlement backlog: ended questions resolved on the source market a week or more ago and still unsettled
      (async () => {
        try {
          const now = Date.now();
          const ended = (snap.questionsWithOi || []).filter((q) => !q.settled && q.end && q.end < now && (q.oi > 0 || q.b > 0));
          if (!ended.length) return;
          await R.load(Array.from(new Set(ended.flatMap((q) => [q.id].concat(R.legIds(q))))), { signal: ctx.signal, deep: false });
          if (ctx.signal.aborted) return;
          // fully won predictions (every leg resolved for the bettor) waiting STUCK_DAYS+ for their payout
          const preds = new Map(); let oldest = 0;
          for (const q of ended) for (const p of q.op || []) { const ps = R.predictionState(p.k); if (ps.code !== 'won') continue; const d = Math.floor((Date.now() - ps.at) / 86400000); if (d < R.STUCK_DAYS) continue; preds.set(p.id, p.s || 0); if (d > oldest) oldest = d; }
          if (!preds.size) return;
          tiles.appendChild(h('a', { href: '#/predict/questions?status=ended', style: { display: 'contents' } }, UI.stat('Unresolved on Meridian', String(preds.size), `won prediction${preds.size > 1 ? 's' : ''} whose legs Polymarket resolved ${R.STUCK_DAYS}+ days ago, still unresolved on Meridian · oldest ${oldest}d · ${usd(Array.from(preds.values()).reduce((a, x) => a + x, 0))} of stakes`, 'neg')));
        } catch (e) { if (!isAbort(e)) console.warn('backlog tile', e); }
      })();
      const cWager = h('canvas'), cCount = h('canvas');
      const tapeBody = h('div.feed.pause-hover');
      const tapeCard = h('div.card.tight', h('div.card-head', h('h2', 'Live predictions'), h('span.dim.small', 'newest first · refreshes every 20 s'), h('span.grow'), h('a.btn.sm.ghost', { href: P.APP_URL, target: '_blank', rel: 'noopener' }, U.icon('external'), 'Predict app')), tapeBody);
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
      ], rows: a.makers.slice(0, 5), onRow: (r) => { location.hash = bettorUrl(r.address).slice(1); } });
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
        tapeCard,
        h('div.grid.cols-2', UI.card('By category', catTbl), UI.card('Singles vs combos', comboTbl)),
        h('div.card.tight', h('div.card-head', h('h2', 'Market makers'), h('span.dim.small', 'who takes the other side of the auctions · click a row for the maker'), h('span.grow'), h('a.small', { href: '#/predict/makers' }, 'all makers')), makersTbl),
        secCard,
        h('div.footer-note', 'Odds = stake ÷ (stake + maker collateral). Vig = those odds minus the source market\'s probability for the same picks; positive means the bettor paid above fair. Bettor PnL is realized on settled predictions only.'));
      const col = C.colors();
      C.timeSeries(cWager, { points: a.daily.map((d) => ({ x: d.t, y: d.wagered })), type: 'bar', color: col.accent, label: 'Wagered' });
      C.timeSeries(cCount, { points: a.daily.map((d) => ({ x: d.t, y: d.n })), type: 'bar', color: col.blue, label: 'Predictions', yFmt: (v) => U.fmtNum(v, 0), tipFmt: (v) => U.fmtNum(v, 0) });

      // live tape (falls back to re-reading the snapshot when the API refuses this origin)
      const live = await P.live();
      let tapeRows = a.tape.slice(0, 25);
      const tapeHead = tapeCard.querySelector('.card-head .dim.small');
      if (!live && tapeHead) tapeHead.textContent = 'as of the snapshot · ' + offlineNote;
      // the whole row opens the bettor; the maker keeps its own link on the right
      const tapeRow = (n, flash) => h('div.it.click', { class: flash ? 'flash' : '', title: 'Open this bettor', onclick: () => { location.hash = bettorUrl(n.predictor).slice(1); } },
        h('span.t', U.fmtFeedTime(n.t)), bettorLink(n.predictor), sideChip(n.yes), h('span.grow.ellipsis', { title: n.q, style: { minWidth: '120px' } }, n.q, n.legs > 1 ? h('span.dim.xs', ' +' + (n.legs - 1) + ' legs') : null),
        h('span.num', usd(n.stake)), h('span.num.dim', '@ ' + pct(n.odds, 1)), h('span.num', mult(n.odds ? 1 / n.odds : null)), h('span.dim.xs', 'vs ', h('a.addr', { href: bettorUrl(n.counterparty), title: 'Market maker ' + n.counterparty, onclick: (e) => e.stopPropagation() }, U.shortAddr(n.counterparty, 3))), resultChip(n));
      const renderTape = (fresh) => U.replaceLive(tapeBody, tapeRows.length ? tapeRows.map((n) => tapeRow(n, fresh && fresh.has(n.id))) : UI.empty('No predictions yet'));
      renderTape();
      const pollTape = async () => {
        try {
          let norms;
          if (live) norms = (await P.tape(25, { signal: ctx.signal })).map(P.norm).map(P.compact);
          else { const s = await P.loadSnapshot({ signal: ctx.signal, force: true }); norms = (s.agg.tape || []).slice(0, 25); }
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
            { key: 'q', label: 'Prediction', render: (r) => (r.q ? h('div', { style: { whiteSpace: 'normal', maxWidth: '340px', lineHeight: '1.3' } }, r.q, r.legs > 1 ? h('span.dim.xs', ' +' + (r.legs - 1) + ' legs') : null) : h('span.dim', '—')) },
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
      U.replace(body, controls, h('div.card.tight', wrap), h('div.footer-note', 'Net PnL counts settled predictions only: a win pays the maker\'s collateral, a loss costs the stake. Open stakes are excluded.'));
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
    const legState = (k, n) => {
      if (n.decided) return h('span.dim.xs', n.won ? 'won' : n.nd ? 'void' : 'lost');
      if (!k.id) return h('span.dim.xs', '—');
      const st = R.state({ end: k.endTime, settled: false, question: k.q }, k.id);
      if (st.code === 'resolved') { const y = R.resolvedYes(st.m); const forBettor = y === true || y === false ? y === !!k.yes : y === 'void' ? false : null; return h('span.xs', { class: forBettor === true ? 'pos' : forBettor === false ? 'neg' : 'dim' }, forBettor === true ? 'resolved for' : y === 'void' ? 'resolved 50/50 (a loss on Meridian)' : forBettor === false ? 'resolved against' : 'resolved · ' + (st.outcome || 'unclear')); }
      return h('span.xs.dim', st.chip ? st.chip[0] : st.code);
    };
    const predState = (n) => {
      if (n.decided) return resultChip(n);
      const ps = R.predictionState(n.picks.map((k) => [k.id, k.yes]));
      return ps.code === 'won' ? UI.chip('won · awaiting payout', 'green') : ps.code === 'lost' ? UI.chip('lost · awaiting settlement', 'red') : UI.chip('open', 'accent');
    };
    const render = () => U.replace(body,
      h('div.row.wrap', { style: { gap: '8px', marginBottom: '10px' } }, R.chip(view, id), h('span.dim.small', R.state(view, id).main || ''), h('span.grow'), h('span.dim.small', `${file.total} prediction${file.total > 1 ? 's' : ''} on this question${file.total > preds.length ? ' · newest ' + preds.length + ' shown' : ''}`)),
      h('div.card.tight', UI.table({ cols: [
        { key: 'b', label: 'Bettor', render: (n) => bettorLink(n.predictor) },
        { key: 't', label: 'Placed', render: (n) => h('span.dim', U.fmtDateTimeS(n.t)) },
        { key: 'legs', label: 'Legs', render: (n) => h('div', { style: { whiteSpace: 'normal', minWidth: '260px', maxWidth: '460px', lineHeight: '1.35' } }, n.picks.map((k) => h('div', { class: k.id === id ? 'bold' : '' }, sideChip(k.yes), ' ', k.q, ' ', legState(k, n)))) },
        { key: 's', label: 'Stake', num: true, render: (n) => usd(n.stake) },
        { key: 'o', label: 'Odds', num: true, render: (n) => h('span', pct(n.odds, 1), h('span.dim.xs', ' ' + mult(n.multiple))) },
        { key: 'p', label: 'Pays', num: true, render: (n) => usd(n.pool) },
        { key: 'm', label: 'Maker', render: (n) => bettorLink(n.counterparty, 3) },
        { key: 'r', label: 'State', render: predState },
      ], rows: preds, empty: 'No predictions' })),
      h('div.footer-note', { style: { textAlign: 'left' } }, 'A combo pays only if every leg resolves in the bettor\x27s favour; one leg resolved against it loses the whole stake even while the others are still open. The bold leg is this question.'));
    render();
    if (legIds.length) R.load(legIds, { signal: ctx.signal, deep: false }).then(() => { if (!ctx.signal.aborted && document.body.contains(body)) render(); }).catch(() => {});
    return modal;
  }
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
  const STAGE_RANK = { vote: 0, disputed: 1, proposed: 2, settling: 3, awaiting: 4, overdue: 4, resolved: 5, paused: 6, unknown: 7, trading: 8, settled: 9 };
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
        { key: 'q', label: 'Question', render: (c) => h('div', { style: { whiteSpace: 'normal', minWidth: '240px', maxWidth: '520px', lineHeight: '1.3' } }, h('div', c.question), h('div.xs.dim', (c.tags || []).slice(0, 4).join(' · '))) },
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
      let renderSeq = 0, endedPreloaded = false;
      if (endedIds.length) R.load(endedIds, { signal: ctx.signal, deep: false }).then(() => { if (ctx.signal.aborted) return; endedPreloaded = true; refreshEndedLabel(); render(true); renderBacklog(); }).catch(() => {});
      function render(keepTracking) {
        let rows = all.filter(alive); const t = Date.now();
        if (st.search) rows = rows.filter((q) => (q.q + ' ' + (q.tags || []).join(' ')).toLowerCase().includes(st.search));
        if (st.cat) rows = rows.filter((q) => q.slug === st.cat);
        if (st.status === 'open') rows = rows.filter(exposure);
        else if (st.status === 'settled') rows = rows.filter((q) => q.settled);
        else if (st.status === 'ended') rows = rows.filter((q) => exposure(q) && q.end && q.end < t);
        rows = st.status === 'ended' && !headerSorted ? byStage(rows) : U.sortBy(rows, SORTS[st.col.key] || SORTS.sw, st.col.desc);
        const total = rows.length; const pages = Math.max(1, Math.ceil(total / PAGE)); if (page > pages) page = pages;
        const slice = rows.slice((page - 1) * PAGE, page * PAGE);
        U.replace(wrap, UI.table({ sort: st.status === 'ended' && !headerSorted ? null : st.col, onSort, cols: [
          { key: 'q', label: 'Question', sortVal: 1, render: (c) => h('div', { style: { whiteSpace: 'normal', minWidth: '240px', maxWidth: '520px', lineHeight: '1.3' } }, h('div', c.q), h('div.xs.dim', (c.tags || []).slice(0, 4).join(' · '))) },
          { key: 'c', label: 'Category', sortVal: 1, render: (c) => c.cat || '—' },
          { key: 'p', label: 'Probability', num: true, sortVal: 1, render: (c) => probBar(c.ep) },
          { key: 'sw', label: 'Staked on Meridian', num: true, sortVal: 1, title: 'Bettor stakes ever placed on this question · predictions', render: (c) => h('div', { style: { lineHeight: '1.25' } }, c.sw ? usd(c.sw, { compact: true }) : h('span.dim', '$0'), c.n ? h('div.xs.dim', { style: { whiteSpace: 'nowrap' } }, `${c.n} prediction${c.n > 1 ? 's' : ''}${c.l ? ' · last ' + U.fmtAgo(c.l) : ''}`) : null) },
          { key: 'oi', label: 'Meridian OI', num: true, sortVal: 1, title: 'Collateral escrowed on Meridian right now · open predictions and their bettor stakes', render: (c) => h('div', { style: { lineHeight: '1.25' } }, c.oi ? usd(c.oi, { compact: true }) : h('span.dim', '$0'), betsNote(c) ? h('div.xs.dim', { style: { whiteSpace: 'normal', maxWidth: '200px', marginLeft: 'auto' } }, betsNote(c)) : null) },
          { key: 'v7', label: 'Source vol 7d', num: true, sortVal: 1, title: 'Volume on the mirrored Polymarket market, last 7 days', render: (c) => (c.v7 ? usd(c.v7, { compact: true }) : h('span.dim', '—')) },
          ...resCols(slice),
          { key: 'l', label: '', render: (c) => (c.src ? h('a.btn.sm.ghost', { href: c.src, target: '_blank', rel: 'noopener', title: c.src }, U.icon('external'), /polymarket/i.test(c.src) ? 'Polymarket' : 'Source') : '') },
        ], rows: slice, empty: st.status === 'ended' ? 'Nothing waiting for resolution' : 'No questions match', onRow: (c) => openQuestion(c, ctx) }), UI.pager({ page, pageSize: PAGE, total, onPage: (p) => { page = p; render(); wrap.scrollIntoView({ block: 'start' }); } }));
        U.replace(summary, st.status === 'ended' ? `${U.fmtNum(total, 0)} ended, not settled yet` : `${U.fmtNum(total, 0)} questions with Meridian bets`);
        if (!keepTracking) { const my = ++renderSeq; trackResolution(slice, ctx, () => render(true), () => my === renderSeq); }
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
      const a = snap.agg; const T = a.totals; const cv = h('canvas');
      const tbl = UI.table({ cols: [
        { key: 'a', label: 'Market maker', render: (r) => h('div.row', { style: { gap: '6px' } }, bettorLink(r.address, 6), U.copyBtn(r.address)) },
        { key: 'n', label: 'Predictions taken', num: true, render: (r) => U.fmtNum(r.n, 0) },
        { key: 's', label: 'Share of flow', num: true, render: (r) => U.fmtPct((r.n / T.n) * 100, { dp: 1 }) },
        { key: 'c', label: 'Collateral committed', num: true, title: 'Sum of collateral put up against bettors', render: (r) => usd(r.wagered, { compact: true }) },
        { key: 'o', label: 'Open exposure', num: true, render: (r) => usd(r.openWagered, { compact: true }) },
        { key: 'p', label: 'Maker PnL', num: true, title: 'Settled: + bettor stake on wins, − own collateral on losses', render: (r) => pnlEl(r.pnl) },
        { key: 'wr', label: 'Maker win rate', num: true, render: (r) => (r.winRate == null ? '—' : U.fmtPct(r.winRate, { dp: 0 })) },
        { key: 'v', label: 'Avg vig captured', num: true, title: 'Bettor odds minus the Polymarket price at the moment of the bet', render: (r) => vigCell(r.avgVig) },
        { key: 'ao', label: 'Avg bettor odds', num: true, render: (r) => pct(r.avgOdds, 0) },
        { key: 'cat', label: 'Top category', render: (r) => r.topCat || '—' },
        { key: 'f', label: 'Active', render: (r) => h('span.dim', U.fmtDate(r.first) + ' → ' + U.fmtAgo(r.last)) },
      ], rows: a.makers, onRow: (r) => { location.hash = bettorUrl(r.address).slice(1); } });
      U.replace(body,
        h('div.card', h('h2', { style: { marginBottom: '6px' } }, 'Who takes the other side'), h('p.muted', { style: { margin: 0, maxWidth: '860px' } }, 'Every Meridian prediction is an RFQ auction: the bettor broadcasts a stake, market makers compete to take the other side, and the winning quote locks the odds. The counterparty address is public on every prediction, so this page shows exactly who is making the market, how much they commit, and how it has gone for them.'), h('div.dim.small', { style: { marginTop: '8px' } }, snapNote(snap))),
        h('div.stats', UI.stat('Market makers', String(a.makers.length)), UI.stat('Maker collateral', usd(T.cpCommitted, { compact: true }), 'committed since launch'), UI.stat('Maker PnL', usd(-T.bettorPnl, { sign: true }), 'decided predictions, claimed or not', U.pnlClass(-T.bettorPnl)), UI.stat('Maker win rate', T.winRate == null ? '—' : U.fmtPct(100 - T.winRate, { dp: 1 })), UI.stat('Avg vig captured', pp(a.vig.overall.avg)), UI.stat('Stake-weighted vig', pp(a.vig.weighted))),
        h('div.card.tight', tbl),
        h('div.card', h('h3', { style: { marginBottom: '10px' } }, 'Maker PnL'), h('div.chart-box.sm', cv)));
      C.bars(cv, a.makers.map((m) => U.shortAddr(m.address)), a.makers.map((m) => m.pnl), { horizontal: true });
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
            types.length ? li('Bet type.', pos.length ? `${U.capitalize(list(pos, ([k, x]) => k + ' (' + roiTxt(x.roi) + ')'))} ${pos.length > 1 ? 'have' : 'has'} been net positive for bettors so far` : '', pos.length && neg.length ? '; ' : '', neg.length ? `${pos.length ? '' : ''}${pos.length ? list(neg, ([k, x]) => k + ' (' + roiTxt(x.roi) + ')') : U.capitalize(list(neg, ([k, x]) => k + ' (' + roiTxt(x.roi) + ')'))} ${pos.length ? 'net negative' : (neg.length > 1 ? 'have' : 'has') + ' been net negative for bettors so far'}` : '', '. Adding a leg from another event is where the maker\'s margin compounds; legs on the same event are priced with their correlation.') : null,
            li('Read it right.', 'Look at Bettor ROI, not the hit-rate gap: a one-point shortfall at 3% odds is a third of the stake, at 60% it is nothing. A gap inside the ± could be luck. Results count from the exchange\x27s verdict, so unclaimed wins and losses are in. These are past results across all bettors, not a forecast and not advice; small buckets swing.')));
      };
      const realizedSection = (r) => {
        if (!r || !r.overall.n) return null;
        const o = r.overall; const cr = h('canvas');
        const buckets = r.byOddsBucket.filter((b) => b.n >= 30);
        const splits = [{ k: 'Singles', ...r.singles }, { k: 'Combos · different events', ...r.combosOnly }, { k: 'Combos · same event', ...r.combosSameEvent }, r.combosUnknown.n ? { k: 'Combos · event unknown', ...r.combosUnknown } : null].filter(Boolean);
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
    const head = h('div.acct-head', h('span.addr-box', h('span', { title: addr }, U.shortAddr(addr, 6)), U.copyBtn(addr)), h('a.btn.sm.ghost', { href: U.accountUrl(addr), title: 'Perps account' }, U.icon('account'), 'Perps'), h('a.btn.sm.ghost', { href: U.explorerAddr(addr), target: '_blank', rel: 'noopener' }, U.icon('external'), 'Explorer'));
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
      const norms = raw.map(P.norm).filter((n) => n.predictor === addr || n.counterparty === addr);
      // decided-but-unclaimed positions are not open; a position whose tokens were all sold is not this wallet's any more
      const undecided = (openPos.nodes || []).filter((p) => !(p.pickConfig && p.pickConfig.resolved) && P.usd(p.balance) > 1e-9);
      const posRows = undecided.map((p) => { const stake = P.usd(p.userCollateral), payout = P.usd(p.totalPayout); const picks = ((p.pickConfig && p.pickConfig.picks) || []).map((k) => ({ id: k.conditionId || null, q: k.condition ? k.condition.question : k.conditionId, yes: String(k.predictedOutcome).toUpperCase() === 'YES', ep: k.condition ? k.condition.estimatedPrice : null, endTime: k.condition && k.condition.endTime ? k.condition.endTime * 1000 : null, settled: !!(k.condition && k.condition.settled), resolvedToYes: k.condition ? k.condition.resolvedToYes : null })); let fair = null; if (picks.length && picks.every((k) => k.ep != null)) { fair = 1; for (const k of picks) fair *= k.yes ? k.ep : 1 - k.ep; } return { side: p.side, stake, payout, odds: payout > 0 ? stake / payout : null, picks, fair, t: P.ms(p.createdAt), ends: picks.reduce((m, k) => (k.endTime && (!m || k.endTime > m) ? k.endTime : m), null) }; });
      return { live: true, norms, truncated: !!raw.truncated, hist: acct.history, totalVolume: acct.totalVolume, balance: acct.balance, posRows, openCount: undecided.length, builtAt: Date.now(), trades: (tf && tf.trades) || [] };
    }
    const f = await P.snapshotFile('bettors/' + addr + '.json', { signal: ctx.signal });
    if (!f) return null;
    const norms = f.predictions.map(P.unslim);
    const asMaker = norms.filter((n) => n.counterparty === addr).length > norms.filter((n) => n.predictor === addr).length;
    const mine = norms.filter((n) => (asMaker ? n.counterparty : n.predictor) === addr);
    const open = mine.filter((n) => !n.decided);
    const posRows = open.map((n) => ({ id: n.id, side: asMaker ? 'COUNTERPARTY' : 'PREDICTOR', stake: asMaker ? n.cp : n.stake, payout: n.pool, odds: asMaker ? (n.pool ? n.cp / n.pool : null) : n.odds, picks: n.picks.map((k) => ({ id: k.id, q: k.q, yes: k.yes, ep: k.ep, endTime: k.endTime, settled: false, resolvedToYes: null })), fair: asMaker ? (n.fair == null ? null : 1 - n.fair) : n.fair, t: n.t, ends: n.picks.reduce((m, k) => (k.endTime && (!m || k.endTime > m) ? k.endTime : m), null) }));
    return { live: false, norms, truncated: !!f.truncated, hist: P.historyFromPredictions(mine, addr, asMaker), totalVolume: U.sum(mine, (n) => (asMaker ? n.cp : n.stake)), balance: null, posRows, openCount: open.length, builtAt: f.builtAt, trades: f.trades || [] };
  }
  P.loadBettor = loadBettor;
  P.renderBettor = async function (el, addr, ctx) {
    U.replace(el, loadingCard('Loading bettor history…'));
    UI.progress.start();
    let m;
    try { m = await loadBettor(addr, ctx); } catch (e) { UI.progress.done(); if (isAbort(e)) return; U.replace(el, UI.error(e)); return; }
    UI.progress.done();
    if (ctx.signal.aborted) return;
    if (!m) { U.replace(el, h('div.card', h('div.empty', 'No Meridian Predict activity for this address (as of the last snapshot).'))); return; }
    const { norms, hist } = m;
    const asBettor = norms.filter((n) => n.predictor === addr), asMaker = norms.filter((n) => n.counterparty === addr);
    const isMaker = asMaker.length > asBettor.length;
    const mine = isMaker ? asMaker : asBettor;
    // the secondary market: PnL follows the position tokens, so a sold prediction's result is no longer (all) this wallet's
    const L = P.ledger(norms, m.trades || [], addr);
    const heldOf = (n) => { const bp = L.byPrediction[n.id]; return bp ? bp.held : 1; };
    const posRows = m.posRows.filter((r) => !r.id || heldOf(r) > 1e-6);
    if (!mine.length && !hist.some((x) => x.total) && !L.trades.length) { U.replace(el, h('div.card', h('div.empty', 'No Meridian Predict activity for this address.'))); return; }
    const last = hist.length ? hist[hist.length - 1] : null;
    const claimable = last ? last.claimable : 0;
    // The headline figures count from the verdict (claimed or not). The exchange's own history counts only claimed
    // predictions, so the decided-but-unclaimed ones come from the predictions loaded here, which is exact while they are
    // all loaded (up to 300 live, 600 in a snapshot file). A larger account (every market maker, heavy bettors) would
    // count only the unclaimed ones inside that window, so its figures come from the published snapshot's aggregate for
    // this wallet instead, which covers every prediction as of its build.
    let F;
    const agg = m.truncated ? await (async () => { try { const snap = await P.loadSnapshot({ signal: ctx.signal }); if (!snap || !snap.remote || !snap.agg) return null; const row = (isMaker ? snap.agg.makers : snap.agg.bettors).find((r) => r.address === addr); return row ? Object.assign({ at: snap.builtAt }, row) : null; } catch (e) { return null; } })() : null;
    if (ctx.signal.aborted) return;
    // Checked against the exchange: its account history books PnL at the verdict (its cumulative PnL equals the sum of
    // every decided prediction's result, claimed or not), while its won / lost counts move only when a prediction is
    // claimed. So live, the PnL is the exchange's as it stands and only the counts need the unclaimed ones added; the
    // snapshot fallback rebuilds its history from claims, so there the unclaimed results are added to the PnL too.
    const totals = hist.reduce((a, x) => { a.won += x.won; a.lost += x.lost; a.pending += x.pending; a.nd += x.nonDecisive; a.pnl += x.pnl; return a; }, { won: 0, lost: 0, pending: 0, nd: 0, pnl: 0 });
    if (agg) {
      F = { pnl: m.live ? totals.pnl : agg.pnl, pnlNote: m.live ? 'decided, claimed or not · exchange stats' : `decided, claimed or not · as of the snapshot ${U.fmtAgo(agg.at)}`, won: agg.won, lost: agg.lost, nd: agg.nd || 0, open: agg.open, unclaimedWon: agg.unclaimedWon, unclaimedPayout: agg.unclaimedPayout, roi: agg.roi, roiNote: 'on decided stakes · all predictions', avgOdds: agg.avgOdds, avgLegs: agg.avgLegs, fromSnap: true };
    } else {
      F = Object.assign(P.bettorFigures({ mine, hist, isMaker, live: m.live, ledger: L }), { pnlNote: (m.live ? 'decided, claimed or not · exchange stats' : 'decided, claimed or not · from predictions') + (L.trades.length ? ' · incl. the secondary market' : ''), roiNote: 'on decided stakes', fromSnap: false });
    }
    const tiles = h('div.stats',
      UI.stat(isMaker ? 'Maker PnL' : 'Net PnL', usd(F.pnl, { sign: true }), F.pnlNote, U.pnlClass(F.pnl)),
      UI.stat('Volume', usd(agg && !m.live ? agg.wagered : m.totalVolume, { compact: true }), 'all time'),   // a snapshot file holds only the newest predictions; the aggregate has them all
      // a decided loss is a loss whether or not the winner has claimed: only this side's own wins waiting to be collected are called out
      UI.stat('Record', `${U.fmtNum(F.won, 0)}W / ${U.fmtNum(F.lost, 0)}L`, [F.open ? U.fmtNum(F.open, 0) + ' open' : null, F.unclaimedWon ? U.fmtNum(F.unclaimedWon, 0) + ' won, not yet claimed' : null, F.nd ? F.nd + ' void' : null].filter(Boolean).join(' · ') || null),
      UI.stat('Win rate', F.won + F.lost ? U.fmtPct((F.won / (F.won + F.lost)) * 100, { dp: 0 }) : '—', 'of decided predictions'),
      UI.stat('ROI', F.roi == null ? '—' : U.fmtPct(F.roi, { sign: true, dp: 0 }), F.roiNote, U.pnlClass(F.roi)),
      UI.stat('Avg odds', pct(F.avgOdds, 0), F.avgLegs ? 'avg ' + U.fmtNum(F.avgLegs, 1) + ' legs' : null),
      m.balance == null ? UI.stat('Open stake', usd(U.sum(posRows, (r) => r.stake)), 'in open predictions') : UI.stat('Collateral', usd(m.balance), claimable ? usd(claimable) + ' claimable' : 'in Predict'),
      UI.stat('Open', U.fmtNum(F.open, 0), 'predictions, not yet decided'),
      F.unclaimedWon ? UI.stat('Unclaimed winnings', usd(F.unclaimedPayout), `${U.fmtNum(F.unclaimedWon, 0)} won prediction${F.unclaimedWon > 1 ? 's' : ''} to claim`, 'pos') : null);
    const cPnl = h('canvas'), cVol = h('canvas');
    // Open positions: one resolution line per leg (Polymarket + UMA oracle), a combo settles once every leg has resolved
    const legView = (k) => ({ end: k.endTime, settled: !!k.settled, yes: k.resolvedToYes, nd: false, question: k.q });
    const legCell = (r) => h('div.legs', r.picks.map((k) => (k.id
      ? h('div', { style: { cursor: 'pointer' }, title: 'Resolution details', onclick: (e) => { e.stopPropagation(); R.openDetails(legView(k), k.id, { appUrl: P.APP_URL }); } }, R.line(legView(k), k.id))
      : h('div.res-line', h('span.dim.small', k.endTime ? (k.endTime > Date.now() ? 'in ' + U.fmtCountdown(k.endTime - Date.now()) : 'pending') : '—')))));
    const openWrap = h('div');
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
    ], rows, empty: lost.length ? 'Nothing still in play' : 'No open positions' }), lost.length ? h('div.footer-note', { style: { textAlign: 'left', padding: '10px 14px' } }, `${lost.length} position${lost.length > 1 ? 's' : ''} (${usd(U.sum(lost, (r) => r.stake))} staked) already resolved against this bettor on Polymarket and only await settlement on Meridian.`) : null); };
    renderOpen();
    const legIds = posRows.flatMap((r) => r.picks.map((k) => k.id)).filter(Boolean);
    if (legIds.length) (async () => { try { await R.load(legIds, { signal: ctx.signal, deep: false }); if (ctx.signal.aborted) return; renderOpen(); await R.load(legIds, { signal: ctx.signal, deep: true }); if (!ctx.signal.aborted) renderOpen(); } catch (e) { if (!isAbort(e)) console.warn('resolution tracker', e); } })();
    resTicker(ctx, renderOpen);
    let hpage = 1; const histWrap = h('div');
    const renderHist = () => { const slice = mine.slice((hpage - 1) * PAGE, hpage * PAGE); U.replace(histWrap, UI.table({ cols: [
      { key: 't', label: 'Placed', render: (n) => h('span.dim', U.fmtDateTimeS(n.t)) },
      { key: 'q', label: 'Prediction', render: (n) => h('div', { style: { whiteSpace: 'normal', maxWidth: '460px', lineHeight: '1.3' } }, n.picks.slice(0, 3).map((k) => h('div', sideChip(k.yes), ' ', k.q)), n.legs > 3 ? h('div.xs.dim', '+' + (n.legs - 3) + ' more legs') : null) },
      { key: 'c', label: 'Category', render: (n) => n.cat },
      { key: 's', label: isMaker ? 'Bettor stake' : 'Stake', num: true, render: (n) => usd(n.stake) },
      { key: 'o', label: 'Odds', num: true, render: (n) => h('span', pct(n.odds, 1), h('span.dim.xs', ' ' + mult(n.multiple))) },
      { key: 'v', label: 'Vig', num: true, title: 'Locked odds minus the Polymarket price at the moment of the bet', render: (n) => vigCell(n.vig, n) },
      { key: 'cp', label: isMaker ? 'Bettor' : 'Maker', render: (n) => bettorLink(isMaker ? n.predictor : n.counterparty) },
      { key: 'r', label: 'Result', render: (n) => { const bp = L.byPrediction[n.id]; return h('span', resultChip(n, isMaker, bp ? bp.held : 1), bp && bp.held < 0.999 ? h('span.dim.xs', { title: 'Its tokens were sold on the secondary market: the result below is the sale plus whatever was still held at the verdict' }, bp.held < 1e-6 ? ' sold' : ` ${U.fmtPct((1 - bp.held) * 100, { dp: 0 })} sold`) : null); } },
      // a prediction whose tokens were traded shows its share of the ledger's result (the sale, and the verdict on what was still held)
      { key: 'p', label: 'PnL', num: true, render: (n) => { const bp = L.byPrediction[n.id]; return bp ? (n.decided || Math.abs(bp.pnl) > 0.005 ? pnlEl(bp.pnl) : h('span.dim', '—')) : pnlEl(isMaker ? -n.pnl : n.pnl); } },
    ], rows: slice, empty: 'No predictions' }), mine.length > PAGE ? UI.pager({ page: hpage, pageSize: PAGE, total: mine.length, onPage: (p) => { hpage = p; renderHist(); } }) : null); };
    renderHist();
    // secondary-market trades of this wallet: what it sold or bought, at what price, and what that did
    const secWrap = h('div'); let spage = 1;
    const saleOf = new Map(L.events.filter((e) => e.kind === 'sale' && e.trade).map((e) => [e.trade, e]));
    const tokValue = (t) => (t.side === 'P' ? t.vP : t.vC);
    const renderSec = () => { const slice = L.trades.slice((spage - 1) * PAGE, spage * PAGE); U.replace(secWrap, UI.table({ cols: [
      { key: 't', label: 'When', render: (t) => h('span.dim', U.fmtDateTimeS(t.t)) },
      { key: 'q', label: 'Prediction', render: (t) => h('div', { style: { whiteSpace: 'normal', maxWidth: '420px', lineHeight: '1.3' } }, t.q || '—', t.legs > 1 ? h('span.dim.xs', ' +' + (t.legs - 1) + ' legs') : null) },
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
    U.replace(el, h('div.stack',
      h('div.row.wrap', !mine.length && L.trades.length ? UI.chip('secondary-market trader', 'blue') : isMaker ? UI.chip('market maker', 'blue') : UI.chip('bettor', 'accent'), h('span.dim.small', F.fromSnap ? `${U.fmtNum(agg.n, 0)} predictions · the tables show the newest ${mine.length}; the figures above cover all of them, from the snapshot built ${U.fmtAgo(agg.at)}` : m.live ? `${mine.length} predictions · figures from Meridian's own account history` : `${mine.length} predictions · snapshot ${U.fmtAgo(m.builtAt)} · ${offlineNote}`), h('span.grow'), h('a.btn.sm.ghost', { href: P.APP_URL, target: '_blank', rel: 'noopener' }, U.icon('external'), 'Predict app')),
      tiles,
      // offline, the curves are rebuilt from the loaded predictions (PnL booked when claimed): say so when those are not all of them
      h('div.grid.cols-2', h('div.card', h('div.row', { style: { marginBottom: '10px' } }, h('h3', 'Cumulative PnL'), h('span.grow'), !m.live && m.truncated ? h('span.dim.xs', `newest ${mine.length} predictions · booked when claimed`) : null), h('div.chart-box.sm', cPnl)), h('div.card', h('div.row', { style: { marginBottom: '10px' } }, h('h3', 'Daily volume'), h('span.grow'), !m.live && m.truncated ? h('span.dim.xs', `newest ${mine.length} predictions`) : null), h('div.chart-box.sm', cVol))),
      UI.card('Open positions', openWrap, h('span.dim.small', posRows.length < F.open ? `newest ${posRows.length} of ${U.fmtNum(F.open, 0)}` : String(posRows.length))),
      UI.card('Prediction history', histWrap, h('span.dim.small', 'newest first')),
      L.trades.length ? UI.card('Secondary market', secWrap, h('span.dim.small', `${L.trades.length} trade${L.trades.length > 1 ? 's' : ''} · positions sold or bought before the verdict · ${usd(L.pnl, { sign: true })} from traded positions`)) : null,
      h('div.grid.cols-2', UI.card('By category', catTbl), UI.card('Singles vs combos', comboTbl))));
    const col = C.colors();
    const firstAct = hist.findIndex((x) => x.total || x.volume);
    const h2 = firstAct >= 0 ? hist.slice(Math.max(0, firstAct - 1)) : hist;
    C.timeSeries(cPnl, { points: h2.map((x) => ({ x: x.t, y: x.cumPnl })), color: (last && last.cumPnl >= 0) ? col.green : col.red, label: 'PnL' });
    C.timeSeries(cVol, { points: h2.map((x) => ({ x: x.t, y: x.volume })), type: 'bar', color: col.accent, label: 'Volume' });
  };
})();
