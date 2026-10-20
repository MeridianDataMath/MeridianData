/* MeridianDataHub — Exchange dashboard: markets, live trades, liquidations, closures, funding, stop map (closed until opened) */
(function () {
  const MD = window.MD; const U = MD.util; const A = MD.api; const AN = MD.analytics; const UI = MD.ui; const C = MD.charts; const h = U.h;
  const isAbort = (e) => e && e.name === 'AbortError';

  // ---- funding as Meridian's app shows it (pure: tests/dashboard.test.mjs holds them to the app) ----
  /** A funding rate (a fraction per hour; the API sends 9-decimal strings) × mult, in percent at 4 dp. Rounded half away
   *  from zero on the exact decimal, as the app does (it multiplies 9-decimal integers and lets Intl round): rate × 8760
   *  in floats can land a hair under a rounding edge and print the last digit one lower. */
  const ratePct = (rate, mult = 1) => { const n = Math.round(U.num(rate) * 1e9) * mult; const q = Math.floor((Math.abs(n) + 500) / 1000); return (n < 0 ? -q : q) / 1e4; };
  /** The mark-price gap an mPerp (isolated) market is inside at t, or null. The app pauses funding there ("Paused"):
   *  no funding row is charged inside the window, a position fee is charged instead. Cross markets never pause.
   *  Of overlapping gaps, the one that ends last, so "until" is when funding can resume. */
  const fundingGap = (p, gaps, t) => (p && p.marginMode === 'ISOLATED'
    ? (gaps || []).filter((g) => g.productId === p.id && g.startTime <= t && t < g.endTime).sort((a, b) => b.endTime - a.endTime)[0] || null : null);
  /** One market's funding: the projected rate for the next hourly charge from /v1/funding/projected-rate (the app's
   *  figure; the WebSocket's fr1h only stands in when REST has none, as it moves less often and drifts from it), the
   *  rate of the last hourly charge, and the app's 1y figure (projected × 24 × 365, not the last charge annualized). */
  const fundingOf = (p, { projected, live, gaps, t }) => {
    const pj = projected && projected[p.id], has = (v) => v != null && v !== '';
    const raw = pj && has(pj.fundingRateProjected1h) ? pj.fundingRateProjected1h : live && has(live.fr1h) ? live.fr1h : null;
    const gap = fundingGap(p, gaps, t);
    return { lastPct: ratePct(p.fundingRate1h), lastAprPct: ratePct(p.fundingRate1h, 24 * 365), projPct: raw == null ? null : ratePct(raw), aprPct: raw == null ? null : ratePct(raw, 24 * 365), paused: !!gap, until: gap ? gap.endTime : null };
  };
  // ---- mPerp position fees (Meridian's docs: Position Fees): charged on longs and shorts alike while the reference market
  // is closed (a mark-price gap), every few minutes (15 so far), by position size, paid to the exchange ----
  /** The last finished gap of a product at least minMs long (the weekend; gold and silver also close an hour each
   *  weekday evening, SPY and QQQ only at weekends, as of Oct 2026), or null. */
  const lastLongGap = (gaps, pid, t, minMs = 12 * 3600000) => (gaps || []).filter((g) => g.productId === pid && g.endTime <= t && g.endTime - g.startTime >= minMs).sort((a, b) => b.endTime - a.endTime)[0] || null;
  /** A window's applied charges added up: {n, rate (Σ of the per-charge rates: about the share of a position's value the
   *  window cost), perUnit (Σ USD per unit), maxRate, cadence}. */
  const chargesSum = (rows) => {
    const list = rows || []; let rate = 0, perUnit = 0, maxRate = 0;
    for (const r of list) { const x = U.num(r.positionFeeRate); rate += x; perUnit += U.num(r.chargePerUnitUsd); if (x > maxRate) maxRate = x; }
    return { n: list.length, rate, perUnit, maxRate, cadence: list.length ? U.num(list[0].cadenceMinutes) || null : null };
  };
  /** A decimal rate as a percent with the trailing zeros dropped: 0.00005 → "0.005%", 0.0025 → "0.25%", 0.02 → "2%". */
  const pctT = (x) => (+(U.num(x) * 100).toFixed(4)) + '%';
  // ---- trading fees: the REST history carries each fill's fees; the WebSocket sends none, so a live fill's are worked
  // out from the market's fee rates (marked ≈). Takers have paid 0.005% and makers nothing so far (Oct 2026) ----
  /** A tape row's fees in USD: {taker, maker, exact}. */
  const tradeFee = (t) => (t.takerFeeUsd != null
    ? { taker: U.num(t.takerFeeUsd), maker: U.num(t.makerFeeUsd), exact: true }
    : { taker: U.num(t.size) * U.num(t.price) * U.num(t.takerRate), maker: U.num(t.size) * U.num(t.price) * U.num(t.makerRate), exact: false });
  /** The last 24 hours' trading fees from the Markets rows: each market's 24h volume at the mark × its taker and its maker
   *  fee. Meridian's 24h volume counts each trade once (the REST trades of a day add up to it, checked Oct 21). */
  const fees24h = (rows) => { let taker = 0, maker = 0; for (const r of rows || []) { taker += r.volUsd * U.num(r.p.takerFee); maker += r.volUsd * U.num(r.p.makerFee); } return { taker, maker }; };
  /** A market's open interest against its cap. Meridian caps each side (maxOpenInterestUsd: the open interest of one side)
   *  while its openInterest counts both, so one side is half of it: {side, cap, share}, in USD at the mark; null without
   *  a cap. */
  const oiUse = (p, mark) => { const cap = U.num(p.maxOpenInterestUsd); if (!(cap > 0)) return null; const side = (U.num(p.openInterest) / 2) * U.num(mark); return { side, cap, share: side / cap }; };
  // live-feed rows from the REST history and from a WebSocket fill: the product's tick and lot ride along, so price and
  // size print at the app's decimals (a size at a fixed 4 dp showed a 1.19645 BTC fill as 1.1965, off the lot grid), and
  // its fee rates, for a fill the feed sends without its fees
  const restTrade = (p, r) => ({ id: r.id, t: r.createdAt, ticker: p.displayTicker, tick: p.tickSize, lot: p.lotSize, side: r.takerSide, size: r.filled, price: r.price, takerOrder: r.takerOrderId || null, makerOrder: r.makerOrderId || null,
    takerFeeUsd: r.takerFeeUsd ?? null, makerFeeUsd: r.makerFeeUsd ?? null, takerRate: p.takerFee, makerRate: p.makerFee });
  const wsTrades = (p, m) => { const d = m.data || {}; return (d.d || []).map((it) => ({ id: it.id, t: d.t || m.t, ticker: p.displayTicker, tick: p.tickSize, lot: p.lotSize, side: it.sd, size: it.sz, price: it.px, taker: it.sids && it.sids[0], maker: it.sids && it.sids[1], takerRate: p.takerFee, makerRate: p.makerFee, _new: true })); };

  MD.router.pages.dashboard = {
    ratePct, fundingGap, fundingOf, restTrade, wsTrades, lastLongGap, chargesSum, pctT, tradeFee, fees24h, oiUse,
    async mount(root, route, ctx) {
      MD.setTopbar(h('span.title', 'Dashboard'));
      const tiles = h('div.stats');
      const mktBody = h('div', UI.loading('Loading markets…'));
      const tradesBody = h('div.feed.pause-hover', UI.loading('Loading trades…'));
      const liqBody = h('div', UI.loading('Loading…'));
      const gapBody = h('div', UI.loading('Loading…'));
      const fundBody = h('div');
      const pfBody = h('div');   // the Funding card's mPerp position fees, under the funding table
      const status = h('span.status-dot'); const statusTxt = h('span.dim.small');
      const catSel = h('span.seg-box');   // the Markets' category buttons (renderCatSel); a phone scrolls them sideways
      // stop map and liquidation map elements: both cards are closed on every visit, so the page does not scan every account
      // on load; opening either starts the scan they share (user 10-18: "not load instantly by default … hidden by default")
      const smSummary = h('span.dim.small');
      const smSel = h('div.smap-sel');
      const smBands = h('div.smap-bands');   // stops that sell below and buy above the mark, within 1, 2 and 5%
      const smLadder = h('div.smap', UI.loading('Collecting stop orders and positions…'));
      const smTable = h('div');
      const smRescan = h('button.btn.sm', { disabled: true, onclick: () => scanStops() }, U.icon('refresh'), 'Rescan');   // on with the first scan
      const smBody = h('div.smap-body', { style: { display: 'none' } }, h('div.card-head', smSummary, h('span.grow'), smRescan), h('div.smap-wrap', h('div', smSel, smBands, smLadder), smTable));
      const stopCard = h('div.card.tight.collapsible');
      // the liquidation map (user 10-19: liquidations "a whole own field"): the scan's liquidation prices, apart from the
      // stops, with the liquidator's pool for each market and the jump that would drain it
      const lmSummary = h('span.dim.small');
      const lmSel = h('div.smap-sel');
      const lmBands = h('div.smap-bands.lm-bands');   // longs liquidated below and shorts above the mark, within 1, 2 and 5%
      const lmPool = h('div.smap-bands.lm-pool');      // the liquidator's pool for the market and the jump that drains it
      const lmLadder = h('div.smap.lm', UI.loading('Collecting positions…'));
      const lmTable = h('div');
      const lmRescan = h('button.btn.sm', { disabled: true, onclick: () => scanStops() }, U.icon('refresh'), 'Rescan');
      const lmBody = h('div.smap-body', { style: { display: 'none' } }, h('div.card-head', lmSummary, h('span.grow'), lmRescan), h('div.smap-wrap', h('div', lmSel, lmBands, lmPool, lmLadder), lmTable));
      const liqCard = h('div.card.tight.collapsible');
      let scanOpen = () => {};   // the scan needs the markets and accounts loaded below: until then opening only shows the card
      const toggleCard = (card, body, head) => { const open = !card.classList.contains('open'); card.classList.toggle('open', open); body.style.display = open ? '' : 'none'; head.setAttribute('aria-expanded', String(open)); scanOpen(); };
      const smHead = h('button.card-head.toggle-head', { type: 'button', 'aria-expanded': 'false', onclick: () => toggleCard(stopCard, smBody, smHead) },
        h('span.chev', U.icon('chevR')), h('h2', 'Stop map'), h('span.dim.small', 'every account\'s take-profit, stop-loss and entry stops, by price level · ▼ sells / ▲ buys into the order book when the price gets there · click a level for the accounts'), h('span.grow'), h('span.dim.small.toggle-hint'));
      const lmHead = h('button.card-head.toggle-head', { type: 'button', 'aria-expanded': 'false', onclick: () => toggleCard(liqCard, lmBody, lmHead) },
        h('span.chev', U.icon('chevR')), h('h2', 'Liquidation map'), h('span.dim.small', 'where every open position gets liquidated, by price level · Meridian\'s liquidator takes them over, not the order book · the jump that would drain its pool, after which winning positions are force-closed · click a level for the accounts'), h('span.grow'), h('span.dim.small.toggle-hint'));
      U.append(stopCard, [smHead, smBody]);
      U.append(liqCard, [lmHead, lmBody]);
      // market specs: each market's limits and settings as Meridian's product data has them; closed until opened, and the
      // choice is kept in this browser (it loads nothing of its own)
      const SPECS_KEY = 'md.dash.specsOpen';
      const specsBody = h('div', { style: { display: 'none' } }, UI.loading('Loading markets…'));
      const specsCard = h('div.card.tight.collapsible');
      let renderSpecs = () => {};   // set once the markets are loaded
      const setSpecs = (open) => { specsCard.classList.toggle('open', open); specsBody.style.display = open ? '' : 'none'; specsHead.setAttribute('aria-expanded', String(open)); U.storage.set(SPECS_KEY, open); if (open) renderSpecs(); };
      const specsHead = h('button.card-head.toggle-head', { type: 'button', 'aria-expanded': 'false', onclick: () => setSpecs(!specsCard.classList.contains('open')) },
        h('span.chev', U.icon('chevR')), h('h2', 'Market specs'), h('span.dim.small', 'leverage, margins, open-interest caps, order limits, fees and price feeds of every market, as Meridian\'s product data has them'), h('span.grow'), h('span.dim.small.toggle-hint'));
      U.append(specsCard, [specsHead, specsBody]);
      if (U.storage.get(SPECS_KEY, false) === true) setSpecs(true);
      U.replace(root, h('div.page', h('div.stack', tiles,
        h('div.card.tight', h('div.card-head', h('h2', 'Markets'), status, statusTxt, catSel, h('span.grow'), h('span.dim.small', 'prices via WebSocket · sparkline = 7d oracle price · click a column to sort')), mktBody),
        h('div.grid.cols-2',
          h('div.card.tight.feed-card', h('div.card-head', h('h2', 'Live trades'), h('span.dim.small', 'all markets · click a trade to open the account that took it')), h('div.feed-fill', tradesBody)),
          h('div.stack', h('div.card.tight', h('div.card-head', h('h2', 'Liquidations'), h('span.dim.small', 'latest 20')), liqBody), h('div.card.tight', h('div.card-head', h('h2', 'Market closures (mPerps)'), h('span.dim.small', 'next 7 days')), gapBody))),
        h('div.card.tight', h('div.card-head', h('h2', 'Funding'), h('span.dim.small', 'projected next charge, as Meridian\'s app shows it · last hourly charge · annualized from the projected rate · the largest asset first, as in Markets; click a column to sort')), fundBody, pfBody),
        specsCard, stopCard, liqCard)));

      const ref = await A.ref(ctx);
      const ids = ref.active.map((p) => p.id);
      let [prices, projected, subs, points] = await Promise.all([A.marketPrices(ids, ctx), A.projectedFunding(ids, ctx).catch(() => ({})), A.allSubaccounts(ctx).catch(() => null), A.pointsTotal(ctx).catch(() => null)]);
      const live = {}; // ticker -> ticker ws data
      const now = Date.now();
      // closures for the next 7 days; refreshRest reloads them, so a page left open keeps its Paused / closed states and
      // sees closures scheduled after it loaded
      let gaps = [], gapsBy = {};
      const setGaps = (list) => { gaps = list; gapsBy = U.groupBy(list, (g) => g.productId); };
      try { setGaps(await A.gaps(ids, now, now + 7 * U.DAY, ctx)); } catch (_) {}
      const closureNote = (p) => {
        const t = Date.now();   // the table re-renders on every ticker, so the countdown must read the clock, not the mount time
        const list = (gapsBy[p.id] || []).filter((g) => g.endTime > t).sort((a, b) => a.startTime - b.startTime);
        if (!list.length) return null;
        const g = list[0];
        if (g.startTime <= t) return h('span.closure', 'closed · reopens in ' + U.fmtCountdown(g.endTime - t));
        return h('span.closure', { style: { color: 'var(--text-3)' } }, 'closes in ' + U.fmtCountdown(g.startTime - t));
      };

      // ---- mPerp position fees, under the funding table: the next projected charge while a market is closed (the app's
      // "Next position fee"), the current or next closure, the last weekend's charges added up, and the per-unit total
      // since launch (the product's cumulativePositionFeeUsd). The rate is set per charge: last weekend (Oct 17-19) QQQ's
      // added up to 0.0045 %, gold's to 0 ----
      const iso = ref.active.filter((p) => p.marginMode === 'ISOLATED'), isoIds = iso.map((p) => p.id);
      let pfProj = {}; const pfLast = {};
      const pfRate = (x) => U.fmtPct(U.num(x) * 100, { dp: 4 });   // a decimal rate per charge, printed as the app does (4 dp)
      const nextFee = (p) => { const x = pfProj[p.id]; return x ? `${pfRate(x.positionFeeRate)} / ${x.cadenceMinutes}m at ${U.fmtHM(x.scheduledAt)}` : null; };
      function renderPf() {
        if (!iso.length) { U.clear(pfBody); return; }
        const t = Date.now();
        const rows = iso.map((p) => ({ p, gap: (gapsBy[p.id] || []).filter((g) => g.endTime > t).sort((a, b) => a.startTime - b.startTime)[0] || null, last: pfLast[p.id] || null }));
        const nowCell = (r) => { const g = r.gap; if (!g) return h('span.dim', 'open');
          return g.startTime <= t ? h('span.closure', 'closed · reopens ' + U.fmtWhen(g.endTime)) : h('span.dim', 'open · next closure ' + U.fmtWhen(g.startTime) + ' → ' + U.fmtWhen(g.endTime)); };
        // Meridian's estimate of the closure's move (the mark-price gap's sigmas): one standard deviation of the price's
        // return over the whole closure, the greater of the historic and the options-implied figure; the fee is set from it
        const sig = (x) => U.fmtPct(U.num(x) * 100, { dp: 2 });
        const sigmaNote = (g) => `one standard deviation of the price's move over the closure ±${sig(g.effectiveSigma)}, the greater of the figure from past closures (${sig(g.historicSigma)}) and the one implied by options volatility (${g.impliedSigma != null && g.impliedSigma !== '' ? sig(g.impliedSigma) : 'none for this closure'})`;
        const riskCell = (r) => { const g = r.gap; if (!g || g.effectiveSigma == null) return h('span.dim', '—');
          return h('span', { title: `${g.startTime <= t ? 'This closure' : 'The next closure'} (${U.fmtWhen(g.startTime)} → ${U.fmtWhen(g.endTime)}): Meridian puts ${sigmaNote(g)}, and works the position fee out with it` }, '±' + sig(g.effectiveSigma)); };
        const lastCell = (r) => { const s = r.last; if (!s) return h('span.dim', '—'); const base = r.p.baseTokenName || 'unit';
          return h('span', { title: `${U.fmtWhen(s.g.startTime)} → ${U.fmtWhen(s.g.endTime)}: ${s.n} charges${s.cadence ? ', every ' + s.cadence + ' min' : ''}, adding up to ${pfRate(s.rate)} of a position's value, long or short alike (${U.fmtUsd(s.perUnit, { dp: 4 })} per ${base}; the largest single charge ${U.fmtPct(s.maxRate * 100, { dp: 6 })})` + (s.g.effectiveSigma != null ? `; Meridian put ${sigmaNote(s.g)}` : '') + (s.truncated ? ' · more charges than were read' : '') },
            pfRate(s.rate), h('span.xs.dim', ' ≈ ' + U.fmtUsd(s.rate * 10000, { dp: 2 }) + ' per $10K')); };
        // the initial margin Meridian's product data sets while the market is open and while it is closed
        const imCell = (p) => { const o = U.num(p.openMarketInitialMargin), c = U.num(p.closedMarketInitialMargin);
          return h('span', { title: `The initial margin Meridian's product data sets for ${p.displayTicker}: ${pctT(o)} of a position's value while the market is open, ${pctT(c)} while it is closed (a mark-price gap); its maintenance margin is ${pctT(p.maintenanceMargin)}` },
            pctT(o), c !== o ? h('span', h('span.dim', ' → '), h('span', { class: c > o ? 'neg' : '' }, pctT(c))) : h('span.xs.dim', ' both')); };
        const cads = Array.from(new Set(Object.values(pfLast).map((s) => s.cadence).concat(Object.values(pfProj).map((x) => U.num(x.cadenceMinutes))).filter((x) => x > 0)));
        U.replaceLive(pfBody, h('div', { style: { borderTop: '1px solid var(--border-2)' } },
          h('div.card-head', h('h3', 'Position fees (mPerps)'), h('span.dim.small', 'charged instead of funding while the reference market is closed · the next charge as Meridian\'s app shows it · last weekend added up · Meridian\'s estimate of the move over a closure')),
          UI.table({ cols: [
            { key: 'm', label: 'Market', render: (r) => r.p.displayTicker },
            { key: 'now', label: 'Now', render: nowCell },
            { key: 'next', label: 'Next charge', num: true, title: 'The projected rate of the next position fee, as Meridian\'s app shows it (Next position fee): per charge, how often, and when; it can change before then. Only while the market is closed', render: (r) => { const x = nextFee(r.p); return x ? h('span', x) : h('span.dim', { title: 'Charged only while the market is closed' }, '—'); } },
            { key: 'risk', label: 'Typical closure move', num: true, title: 'Meridian\'s estimate of how far the price moves over the current closure, or the next one: one standard deviation (σ) of its return over the whole closure, from past closures or options volatility, whichever is greater. Meridian works the position fee out with it', render: riskCell },
            { key: 'wk', label: 'Last weekend', num: true, title: 'The charges of the last weekend closure added up: about the share of a position\'s value it cost, long or short alike; hover a figure for the window and the dollars per unit', render: lastCell },
            { key: 'im', label: 'Initial margin open → closed', num: true, title: 'The initial margin Meridian\'s product data sets while the market is open and while it is closed (a mark-price gap), as a share of a position\'s value', render: (r) => imCell(r.p) },
            { key: 'cum', label: 'Since launch / unit', num: true, title: 'Position fee paid by a one-unit position held through every closure since launch, long or short alike: the sum of the per-unit charges, as Meridian\'s product data reports it', render: (r) => h('span', { title: r.p.positionFeeUpdatedAt ? 'Last charged ' + U.fmtWhen(r.p.positionFeeUpdatedAt) : null }, U.fmtUsd(r.p.cumulativePositionFeeUsd, { dp: 4 }) + ' / ' + (r.p.baseTokenName || 'unit')) },
          ], rows, phone: { title: 'm', aside: 'wk', hide: ['cum'] } }),
          h('div.footer-note', 'Meridian charges a position fee on mPerp positions while their reference market is closed (the mark-price gaps listed under Market closures): ' + (cads.length === 1 ? 'every ' + cads[0] + ' minutes' : 'every few minutes') + ', on longs and shorts alike, by position size, paid to the exchange rather than between longs and shorts; funding is paused meanwhile. Each charge has its own rate, worked out with Meridian\'s estimate of the move over the closure (', h('a', { href: 'https://docs.meridian.xyz/trading/perpetual-futures/position-fees', target: '_blank', rel: 'noopener' }, 'Meridian\'s docs'), ').')));
      }
      const loadPf = async () => {
        if (!iso.length) return;
        try { pfProj = await A.projectedPositionFee(isoIds, ctx); } catch (e) { if (isAbort(e)) return; }
        try {
          const t = Date.now(); const past = await A.gaps(isoIds, t - 9 * U.DAY, t, ctx);
          // a weekend's charges are read once: the next weekend replaces them
          await Promise.all(iso.map(async (p) => {
            const g = lastLongGap(past, p.id, t); if (!g || (pfLast[p.id] && pfLast[p.id].g.endTime === g.endTime)) return;
            const rows = await A.positionFeeApplied(p.id, g.startTime, g.endTime, ctx);
            pfLast[p.id] = Object.assign({ g, truncated: !!rows.truncated }, chargesSum(rows));
          }));
        } catch (e) { if (isAbort(e)) return; }
        renderPf();
      };

      function renderTiles() {
        // summed from the Markets table's own rows, so the tiles always equal the column totals
        const rows = marketRows();
        let vol = 0, oi = 0;
        for (const r of rows) { vol += r.volUsd; oi += r.oiUsd; }
        // the fees those trades paid: each market's 24h volume × its taker fee (and maker fee, nothing so far)
        const fz = fees24h(rows), rates = (k) => Array.from(new Set(ref.active.map((p) => pctT(p[k])))).join(' / ');
        U.replaceLive(tiles, UI.stat('Active markets', String(ref.active.length), ref.products.length - ref.active.length ? (ref.products.length - ref.active.length) + ' pending/delisted' : null),
          UI.stat(h('span', { title: '24 h traded quantity (base units) × current mark price, summed over markets' }, '24h volume'), U.fmtUsd(vol, { compact: true })),
          UI.stat(h('span', { title: `The trading fees of the last 24 hours, worked out: each market's 24h volume × its taker fee (${rates('takerFee')}) and its maker fee (${rates('makerFee')}), summed over markets; one taker pays on each trade` }, 'Trading fees 24h'), '≈' + U.fmtUsd(fz.taker + fz.maker, { compact: true }), 'takers ' + rates('takerFee') + ' · makers ' + rates('makerFee')),
          UI.stat('Open interest', U.fmtUsd(oi, { compact: true }), 'long + short · one side ' + U.fmtUsd(oi / 2, { compact: true })),
          UI.stat('Accounts', subs ? String(subs.length) : '—', subs && subs.length ? 'newest ' + U.fmtAgo(Math.max(...subs.map((s) => s.createdAt))) : null), UI.stat('Points distributed', points ? U.fmtCompact(points.totalPoints) : '—', points ? 'updated ' + U.fmtAgo(points.updatedAt) : null));
      }
      const mark = (p) => { const l = live[p.ticker]; if (l && U.num(l.markPx)) return U.num(l.markPx); const px = prices[p.id]; return px ? U.num(px.oraclePrice) : 0; };
      const sparks = {};
      // one row per market, shared by the tiles and the Markets / Funding tables
      function marketRows() {
        return ref.active.map((p) => {
          const l = live[p.ticker] || {}; const px = prices[p.id] || {};
          const m = mark(p); const p24 = U.num(l.markPx24h || px.price24hAgo);
          const bid = U.num(l.bidPx || px.bestBidPrice), ask = U.num(l.askPx || px.bestAskPrice);
          // the quantity at the best bid and ask comes with the live feed only (REST sends the prices alone)
          const bidAmt = l.bidPx ? U.num(l.bidAmt) : 0, askAmt = l.askPx ? U.num(l.askAmt) : 0;
          // one source per field, shared by tiles and table: REST open interest matched the open positions
          // while the WebSocket oi lagged for minutes; volume takes the live figure when there is one
          const oiN = U.num(p.openInterest); const volN = U.num(l.vol24h || p.volume24h);
          // the clock, not the mount time: a closure that starts while the page is open pauses funding on the next render
          const f = fundingOf(p, { projected, live: l, gaps, t: Date.now() });
          return { p, cat: AN.marketCategory(p), size: AN.marketSize(p, caps, m), m, chg: p24 ? ((m - p24) / p24) * 100 : null, bid, ask, bidAmt, askAmt, spread: bid && ask ? ((ask - bid) / ((ask + bid) / 2)) * 100 : null, oiUsd: oiN * m, volUsd: volN * m, f };
        });
      }
      // funding cells: the app's format (4 dp, a minus but no plus), greyed "Paused" on an mPerp market inside a closure
      const pct4 = (x) => U.fmtPct(x, { dp: 4 });
      const pausedEl = (f, p) => h('span.dim', { title: `Funding is paused while this mPerp market is closed (until ${U.fmtWhen(f.until)}): no funding is charged in the window, a position fee is charged instead${p && nextFee(p) ? ' (next: ' + nextFee(p) + ')' : ''} · last charge ${pct4(f.lastPct)}` }, 'Paused');
      const rateEl = (x, title) => (x == null ? h('span.dim', { title: 'projected rate not available yet' }, '—') : h('span', { class: U.pnlClass(x), title: title || null }, pct4(x)));
      const projEl = (f, p) => (f.paused ? pausedEl(f, p) : rateEl(f.projPct, 'last hourly charge ' + pct4(f.lastPct)));
      // in a closure Meridian projects no funding (its projected rate is 0, the app's 1y figure paused): the last hourly
      // charge before the closure, annualized, says what the market was costing and will likely cost again once it reopens
      const lastAprEl = (f, p) => h('span', { title: `Funding is paused while this mPerp market is closed (until ${U.fmtWhen(f.until)}): Meridian projects none in the window, so its app's 1y figure is paused. This is the last hourly charge before the closure (${pct4(f.lastPct)}) × 24 × 365${p && nextFee(p) ? '; meanwhile a position fee is charged (next: ' + nextFee(p) + ')' : ''}` },
        h('span.dim', { class: U.pnlClass(f.lastAprPct) }, pct4(f.lastAprPct)), h('span.xs.dim', ' last'));
      // Markets by category, as Hyperliquid groups them (AN.MARKET_CATS: Crypto, Stocks, Indices, Commodities, FX, Pre-IPO),
      // each under a header with its count and totals (a category Meridian has no market in, one line saying so); the
      // buttons show one category (remembered in this browser), and a column header sorts the markets inside each category
      // (until one is clicked: the asset's size outside Meridian, the largest first: AN.marketSize, crypto by CoinGecko's
      // market cap, loaded below)
      const CAT_KEY = 'md.dash.mktCat';
      let mktCat = U.storage.get(CAT_KEY, 'all'); if (!AN.MARKET_CATS.some(([k]) => k === mktCat)) mktCat = 'all';
      let mktSort = { key: 'cap', desc: true }, catSeen = '', caps = null;
      const sizeOf = (r) => (r.size ? r.size.order || r.size.usd : null);
      const SORTS = { cap: sizeOf, m: (r) => r.p.displayTicker, px: (r) => r.m, chg: (r) => r.chg, fr: (r) => (r.f.paused ? null : r.f.projPct), oi: (r) => r.oiUsd, vol: (r) => r.volUsd };
      // the Funding table: the same categories (those with markets) in the same order, the largest asset first, until a
      // column is clicked; a paused market (an mPerp inside a closure) sorts last on the projected figures
      let fundSort = { key: 'cap', desc: true };
      const FUND_SORTS = { cap: sizeOf, m: (r) => r.p.displayTicker, proj: (r) => (r.f.paused ? null : r.f.projPct), fr: (r) => r.f.lastPct, apr: (r) => (r.f.paused ? r.f.lastAprPct : r.f.aprPct) };
      // both tables' size column: the figure for a coin (CoinGecko), a metal or an index fund (estimates, ≈); an order only
      // for the rest
      const SIZE_TIP = { coingecko: 'CoinGecko market cap', metal: 'Estimated: the metal above ground (World Gold Council and others) × the mark price', fund: 'Estimated: the fund\'s shares outstanding (October 2026) × the mark price, the value of all its shares' };
      const capCol = { key: 'cap', label: 'Market cap', num: true, sortVal: 1, title: 'How big the asset is outside Meridian: a coin\'s market cap (CoinGecko); at the mark price, the value of an index fund\'s shares (SPY, QQQ) or of all the gold, silver or platinum above ground; other markets are ordered by their usual size without a figure', render: (r) => (r.size && r.size.src !== 'hint' ? h('span', { title: SIZE_TIP[r.size.src] }, (r.size.src === 'coingecko' ? '' : '≈') + U.fmtUsd(r.size.usd, { compact: true })) : h('span.dim', '—')) };
      const catHead = (name, list, totals) => h('div.mkt-group', h('span.name', name),
        list.length ? h('span.dim', list.length + (list.length === 1 ? ' market' : ' markets')) : h('span.dim', 'none on Meridian yet'), list.length && totals ? h('span.dim', totals(list)) : null);
      // the Bid / Ask cell's tooltip: the quantity at the top of the book on each side (the live feed's bidAmt and askAmt)
      const baTitle = (r) => {
        const side = (name, px, qty) => (px ? `${name} ${U.fmtPrice(px, r.p.tickSize)}` + (qty ? ` for ${U.fmtQty(qty, r.p.lotSize)} ${r.p.baseTokenName || ''} (${U.fmtUsd(qty * px, { compact: true })})` : '') : `no ${name}`);
        return side('best bid', r.bid, r.bidAmt) + ' · ' + side('best ask', r.ask, r.askAmt) + (r.spread != null ? ' · spread ' + U.fmtPct(r.spread, { dp: 3 }) : '') + (r.bidAmt || r.askAmt ? '' : ' · the quantities come with the live feed');
      };
      const renderCatSel = (rows) => {
        const n = {}; for (const r of rows) n[r.cat] = (n[r.cat] || 0) + 1;
        const seen = JSON.stringify(n) + '|' + mktCat; if (seen === catSeen) return; catSeen = seen;
        const label = (name, k) => h('span', name, h('span.n', ' ' + k));
        U.replace(catSel, UI.seg([{ v: 'all', label: label('All', rows.length) }].concat(AN.MARKET_CATS.map(([k, name]) => ({ v: k, label: label(name, n[k] || 0), title: n[k] ? null : 'No ' + name + ' markets on Meridian yet' }))), mktCat,
          (v) => { mktCat = v; U.storage.set(CAT_KEY, v); renderMarkets(); }, 'sm'));
      };
      function renderMarkets() {
        const rows = marketRows();
        renderCatSel(rows);
        const groups = AN.MARKET_CATS.filter(([k]) => mktCat === 'all' || k === mktCat).map(([k, name]) => {
          const list = U.sortBy(rows.filter((r) => r.cat === k), SORTS[mktSort.key] || SORTS.cap, mktSort.desc);
          return { head: catHead(name, list, (l) => '24h volume ' + U.fmtUsd(U.sum(l, (r) => r.volUsd), { compact: true }) + ' · open interest ' + U.fmtUsd(U.sum(l, (r) => r.oiUsd), { compact: true })), rows: list };
        });
        U.replaceLive(mktBody, UI.table({
          cols: [
            // the taker fee as set (0.005% shows as 0.005%, not rounded up to 0.01%)
            { key: 'm', label: 'Market', sortVal: 1, render: (r) => UI.marketCell(r.p.displayTicker, (r.p.marginMode === 'CROSS' ? 'cross' : 'isolated') + ' · ' + r.p.maxLeverage + '× · taker fee ' + (+(U.num(r.p.takerFee) * 100).toFixed(4)) + '%') },
            capCol,
            { key: 'px', label: 'Mark price', num: true, sortVal: 1, title: 'live mark price; the oracle price is shown until the first live update arrives', render: (r) => U.fmtPrice(r.m, r.p.tickSize) },
            { key: 'chg', label: '24h', num: true, sortVal: 1, title: 'mark price now against the oracle price 24 hours ago', render: (r) => UI.pct(r.chg, { dp: 2 }) },
            { key: 'ba', label: 'Bid / Ask', num: true, title: 'Best bid and best ask, and the spread between them · hover a market\'s for the quantity waiting at each', render: (r) => h('span', { title: baTitle(r) }, h('span.pos', r.bid ? U.fmtPrice(r.bid, r.p.tickSize) : '—'), h('span.dim', ' / '), h('span.neg', r.ask ? U.fmtPrice(r.ask, r.p.tickSize) : '—'), r.spread != null ? h('span.xs.dim', ' ' + U.fmtPct(r.spread, { dp: 3 })) : null) },
            // the app's Funding column: the projected rate, not the last charge (they can differ in sign); Paused in a closure
            { key: 'fr', label: 'Funding 1h', num: true, sortVal: 1, title: 'Projected rate for the next hourly charge, as Meridian\'s app shows it · positive = longs pay · hover a rate for the last charge · Paused: an mPerp market inside a closure, when no funding is charged', render: (r) => projEl(r.f, r.p) },
            { key: 'oi', label: 'Open interest', num: true, sortVal: 1, title: 'Long and short positions added together, as Meridian reports open interest; one side is half of it', render: (r) => U.fmtUsd(r.oiUsd, { compact: true }) },
            { key: 'vol', label: '24h volume', num: true, sortVal: 1, title: '24 h traded quantity (base units) × current mark price', render: (r) => U.fmtUsd(r.volUsd, { compact: true }) },
            { key: 'spark', label: '7d', render: (r) => { const c = sparks[r.p.ticker] || (sparks[r.p.ticker] = h('canvas.spark', { width: 110, height: 30 })); return c; } },
            { key: 'note', label: 'Status', render: (r) => closureNote(r.p) || h('span.xs.dim', r.p.marginMode === 'CROSS' ? '24/7' : 'open') },
          ], groups, sort: mktSort,
          // a phone: the market and its price on the first line, the figures under them, no bid/ask or sparkline
          phone: { title: 'm', aside: 'px', hide: ['ba', 'spark'] },
          // a new column sorts the largest first (the market name A to Z); the same column again reverses it
          onSort: (k) => { mktSort = { key: k, desc: mktSort.key === k ? !mktSort.desc : k !== 'm' }; renderMarkets(); },
        }));
        const fundGroups = AN.MARKET_CATS.map(([k, name]) => ({ name, list: U.sortBy(rows.filter((r) => r.cat === k), FUND_SORTS[fundSort.key] || FUND_SORTS.cap, fundSort.desc) }))
          .filter((g) => g.list.length).map((g) => ({ head: catHead(g.name, g.list), rows: g.list }));
        U.replaceLive(fundBody, UI.table({
          groups: fundGroups, sort: fundSort,
          phone: { title: 'm', aside: 'apr', hide: ['base', 'cum', 'upd'] },   // a phone: the rates only
          onSort: (k) => { fundSort = { key: k, desc: fundSort.key === k ? !fundSort.desc : k !== 'm' }; renderMarkets(); },
          cols: [
            { key: 'm', label: 'Market', sortVal: 1, render: (r) => r.p.displayTicker },
            capCol,
            { key: 'proj', label: 'Projected 1h', num: true, sortVal: 1, title: 'Projected rate for the next hourly charge, the figure Meridian\'s app shows (refreshed every minute) · positive = longs pay', render: (r) => projEl(r.f, r.p) },
            // history, so it stands in a closure too: the charge taken before the market closed
            { key: 'fr', label: 'Last 1h', num: true, sortVal: 1, title: 'Rate charged at the last hourly funding · positive = longs paid', render: (r) => rateEl(r.f.lastPct) },
            { key: 'apr', label: 'Annualized', num: true, sortVal: 1, title: 'Projected 1h rate × 24 × 365, the app\'s 1y figure. While an mPerp market is closed (funding paused, Meridian projects none), its last hourly charge × 24 × 365 instead, marked "last"', render: (r) => (r.f.paused ? lastAprEl(r.f, r.p) : rateEl(r.f.aprPct)) },
            { key: 'base', label: 'Baseline / clamp / max APR', num: true, render: (r) => h('span.dim', U.fmtPct(U.num(r.p.fundingBaselineApr) * 100, { dp: 0 }) + ' / ' + U.fmtPct(U.num(r.p.fundingClampApr) * 100, { dp: 0 }) + ' / ' + U.fmtPct(U.num(r.p.fundingMaxApr) * 100, { dp: 0 })) },
            // a per-unit index (the sum of the hourly per-unit charges), not money paid on the market
            { key: 'cum', label: 'Cumulative funding / unit', num: true, title: 'Funding paid by a one-unit long held since funding began (negative = received); the sum of the hourly per-unit charges', render: (r) => U.fmtUsd(r.p.cumulativeFundingUsd) + ' / ' + (r.p.baseTokenName || 'unit') },
            { key: 'upd', label: 'Updated', render: (r) => h('span.dim', U.fmtAgo(r.p.fundingUpdatedAt)) },
          ],
        }));
        drawSparks();
      }
      const sparkData = {};
      async function loadSparks() {
        await Promise.all(ref.active.map(async (p) => { try { const c = await A.candles(p.ticker, '240', now - 7 * U.DAY, now, 42, ctx); sparkData[p.ticker] = c.map((x) => x.c); } catch (_) {} }));
        drawSparks();
      }
      function drawSparks() { for (const t of Object.keys(sparkData)) { const cv = sparks[t]; if (cv && cv.isConnected && !cv.__chart) C.sparkline(cv, sparkData[t]); } }
      const renderMarketsThrottled = U.throttle(() => { renderMarkets(); renderTiles(); }, 1500);
      renderTiles(); renderMarkets(); loadSparks(); loadPf();
      // products (last funding charge, cumulative funding, open interest, REST volume) and the projected rates
      // change on the exchange every hour or faster; refresh them every minute on a page left open
      const refreshRest = async () => {
        try {
          const r = await A.get(A.BASE + '/v1/product?limit=200', { signal: ctx.signal });   // no ttl: A.ref's 5-minute cache would hand back the same objects
          for (const p of (r && r.data) || []) if (ref.byId[p.id]) Object.assign(ref.byId[p.id], p);   // ref.active and ref.byId hold the same objects
          Object.assign(projected, await A.projectedFunding(ids, ctx));
          renderMarketsThrottled(); renderSpecs();
        } catch (_) {}
        try { const t = Date.now(); setGaps(await A.gaps(ids, t, t + 7 * U.DAY, ctx)); renderGaps(); renderMarketsThrottled(); } catch (_) {}
        loadPf();   // the next position fee changes every charge; the last weekend's figure only after a new weekend
      };
      const restT = setInterval(refreshRest, 60000); ctx.onCleanup(() => clearInterval(restT));

      // ---- the scan both maps share: TP / SL / entry stop levels and liquidation prices of every account, per market ----
      // What a level does to the market when the price reaches it (flow): closing a long (its TP, SL or liquidation) sells,
      // closing a short buys; an entry stop buys or sells as it opens. Stops that sell below the mark push a fall further,
      // those that buy above it a rise: the stop map's bands sum them near the mark, each position once (AN.stopFires,
      // AN.stopPressure). A liquidation goes to Meridian's liquidator, not the book: the liquidation map shows those.
      const flowOf = (kind, posSide) => (kind === 'ENTRY' ? (posSide === 'long' ? 'buy' : 'sell') : posSide === 'long' ? 'sell' : 'buy');
      const BANDS = [1, 2, 5];   // percent from the mark
      let sm = null, smMarket = null, lmMarket = null, smScanning = false;
      const scanUi = (busy, msg) => { smRescan.disabled = lmRescan.disabled = busy; if (msg) { U.replace(smSummary, msg()); U.replace(lmSummary, msg()); } };
      async function scanStops() {
        if (smScanning) return; smScanning = true;
        scanUi(true, () => h('span.loading', h('span.spinner'), 'Scanning accounts…'));
        try {
          const LB = MD.router.pages.leaderboard; if (LB) await LB.loadRemote();
          const snap = LB && LB.cache(); const known = {}; if (snap && snap.rows) for (const r of snap.rows) known[r.sid] = r;
          // a fresh list on every scan, so accounts opened after the page loaded are scanned too; the last good
          // list stands in when the refresh fails, and with no list at all the scan fails as before
          const accounts = await A.allSubaccounts({ signal: ctx.signal, ttl: 60000 }).catch((e) => { if (isAbort(e) || !subs) throw e; return subs; });
          if (accounts.length) subs = accounts;               // the Accounts tile follows on the next render
          const levels = []; let scanned = 0, skipped = 0;
          const tasks = accounts.map((sa) => async () => {
            const k = known[sa.id];
            if (k && k.inactive) { skipped++; return; }       // empty with no positions and no trading volume in the last snapshot → nothing to find
            const o = { signal: ctx.signal };
            let ok = true;
            const pending = await A.pendingOrders(sa.id, o).catch(() => { ok = false; return []; });
            if (ok) scanned++;                                 // "checked" counts only accounts whose orders were read
            let positions = [], working = [];
            if (!k || k.openCount > 0 || pending.length) [positions, working] = await Promise.all([A.openPositions(sa.id, o).catch(() => []), A.openOrders(sa.id, o).catch(() => [])]);
            if (!pending.length && !positions.length) return;
            // the balances give each position its liquidation price (its margin pool's equity against its maintenance margin)
            const balances = positions.length ? await A.balances(sa.id, o).catch(() => []) : [];
            const px = {}; for (const p of positions) { const prod = ref.byId[p.productId]; px[p.productId] = { oraclePrice: prod ? mark(prod) : 0 }; }
            const st = AN.accountState({ balances, positions, ref, prices: px });
            AN.attachStops(st.positions, working.concat(pending));
            const used = new Set();
            const add = (l) => levels.push(Object.assign(l, { flow: flowOf(l.kind, l.posSide), account: sa.account, sid: sa.id }));
            for (const r of st.positions) {
              const posSide = r.long ? 'long' : 'short';
              const pos = sa.id + '|' + r.p.productId, posQty = r.abs;   // its exits share it (AN.stopFires counts it once)
              for (const [kind, list] of [['TP', r.tp], ['SL', r.sl]]) for (const e of list) {
                used.add(e.order.id); const qty = e.qty == null ? r.abs : e.qty;
                add({ productId: r.p.productId, price: e.price, kind, posSide, qty, usd: qty * e.price, mech: e.kind, trigger: e.trigger, oco: e.oco, pos, posQty });
              }
              // where the exchange would close the whole position (read with its balances; none without them), and where its
              // margin is gone: the liquidator takes it over at that price (AN.bankruptcyPrice)
              if (balances.length && r.liqPrice > 0) add({ productId: r.p.productId, price: r.liqPrice, kind: 'LIQ', posSide, qty: r.abs, usd: r.abs * r.liqPrice, mech: 'liq', pos, posQty, bk: AN.bankruptcyPrice(r) });
            }
            for (const od of pending) {                          // stops that open or add to a position
              if (used.has(od.id) || od.reduceOnly || od.close) continue;
              const qty = U.num(od.quantity), price = U.num(od.stopPrice); if (!(qty > 0 && price > 0)) continue;
              add({ productId: od.productId, price, kind: 'ENTRY', posSide: String(od.side) === '0' ? 'long' : 'short', qty, usd: qty * price, mech: 'stop', trigger: AN.orderMeta(od).trigger, oco: false });
            }
          });
          await U.pLimit(tasks, 4);
          if (ctx.signal.aborted) return;
          // the liquidator's margin pools, by currency: what it can lose on the positions it takes over (null: unread)
          const lb = await A.balances(AN.LIQUIDATOR_SID, { signal: ctx.signal }).catch((e) => { if (isAbort(e)) throw e; return null; });
          const pools = lb ? Object.fromEntries(lb.map((b) => [String(b.tokenAddress).toLowerCase(), U.num(b.amount)])) : null;
          sm = { at: Date.now(), scanned, skipped, total: accounts.length, levels, pools };
          renderStopMap(); renderLiqMap();   // each falls back to its first market when the one shown has gone
        } catch (e) { if (!isAbort(e)) scanUi(false, () => h('span.neg', 'scan failed: ' + e.message)); }
        finally { smScanning = false; scanUi(false); }
      }
      // the markets in the Markets table's order: by category, as Hyperliquid groups them, then the largest asset outside
      // Meridian first (AN.marketSize; Meridian's 24h volume for one without a size)
      const sortMarkets = (list) => {
        const catIx = (p) => AN.MARKET_CATS.findIndex(([k]) => k === AN.marketCategory(p));
        const sz = (x) => { const z = AN.marketSize(x.p, caps, x.mark); return z ? z.order || z.usd : 0; };
        return list.sort((a, b) => catIx(a.p) - catIx(b.p) || sz(b) - sz(a) || U.num(b.p.volume24h) * b.mark - U.num(a.p.volume24h) * a.mark);
      };
      const usdC = (x) => U.fmtUsd(x, { compact: true });
      const nearest = (list, m) => list.reduce((a, l) => (!a || Math.abs(l.price - m) < Math.abs(a.price - m) ? l : a), null);
      const NB = String.fromCharCode(160);   // a no-break space: an arrow stays with its figure
      // a ladder's rows: the levels within WIN% of the mark, grouped by price (binned to 0.25% of the mark over 40 prices)
      // and by what keyOf returns; the rest are counted above and below
      const WIN = 20;
      const ladderRows = (levels, m, keyOf) => {
        const dense = new Set(levels.filter((l) => m > 0 && Math.abs(l.price - m) <= m * WIN / 100).map((l) => l.price)).size > 40;
        const bin = dense && m > 0 ? m * 0.0025 : 0;
        const level = (pr) => (bin ? Math.round(pr / bin) * bin : pr);
        const rows = {};
        for (const l of levels) {
          const k = level(l.price) + '|' + keyOf(l);
          const r = rows[k] || (rows[k] = { price: level(l.price), kind: l.kind, flow: l.flow, side: l.posSide, usd: 0, items: [] });
          r.usd += l.usd; r.items.push(l);
        }
        const all = Object.values(rows).sort((a, b) => b.price - a.price);
        const far = (r, up) => (m > 0 ? (up ? r.price > m * (1 + WIN / 100) : r.price < m * (1 - WIN / 100)) : false);
        return { bin, list: all.filter((r) => !far(r, true) && !far(r, false)), farUp: all.filter((r) => far(r, true)), farDown: all.filter((r) => far(r, false)) };
      };
      const farNote = (l, up) => (l.length ? h('div.xs.dim.center', { style: { padding: '6px' } }, `${l.length} more level${l.length === 1 ? '' : 's'} over ${WIN}% ${up ? 'above' : 'below'} the mark (${usdC(U.sum(l, (r) => r.usd))})`) : null);
      const ladderBody = (hdr, lad, m, cur, rowEl) => [hdr, farNote(lad.farUp, true), lad.list.filter((r) => r.price > m).map(rowEl),
        h('div.mid', h('span.bold', 'mark ' + U.fmtPrice(m, cur.p.tickSize)), h('span.dim.xs', '  ' + cur.p.displayTicker)),
        lad.list.filter((r) => r.price <= m).map(rowEl), farNote(lad.farDown, false),
        lad.bin ? h('div.xs.dim.center', { style: { padding: '6px' } }, 'levels binned to 0.25% of mark') : null];
      const nearCell = (l, r) => (l ? h('span', U.fmtPrice(l.price, r.p.tickSize), h('span.xs.dim', ' ' + U.fmtPct(((l.price - r.mark) / r.mark) * 100, { sign: true, dp: 1 }))) : h('span.dim', '—'));
      const toggleDetail = (detail) => () => { detail.style.display = detail.style.display === 'none' ? '' : 'none'; };

      // ---- stop map: the orders (TP / SL / entry stops); a stop fires as a market order into the order book ----
      function renderStopMap() {
        if (!sm) return;
        const L = sm.levels.filter((l) => !U.isExcluded(l.account));   // left-out wallets (U.EXCLUDED)
        const byMarket = U.groupBy(L, (l) => l.productId);
        // each market's liquidation prices stay in its levels, unlisted here: a stop behind its position's liquidation
        // never fires (AN.stopFires); the liquidation map lists them
        const markets = sortMarkets(Object.keys(byMarket).filter((pid) => ref.byId[pid] && byMarket[pid].some((l) => l.kind !== 'LIQ')).map((pid) => {
          const ls = byMarket[pid]; const p = ref.byId[pid]; const m = mark(p);
          const fires = AN.stopFires(ls, m);   // what of each level can fire, each position once
          const orders = ls.filter((l) => l.kind !== 'LIQ'), sl = orders.filter((l) => l.kind === 'SL');
          return { pid, p, mark: m, ls, fires, orders, tp: orders.filter((l) => l.kind === 'TP'), sl, en: orders.filter((l) => l.kind === 'ENTRY'),
            accounts: new Set(orders.map((l) => l.sid)).size, near2: AN.stopPressure(ls, m, 2, fires),
            nearSl: nearest(sl.filter((l) => fires.get(l) > 0), m) };   // one behind its position's liquidation never fires
        }));
        const O = L.filter((l) => l.kind !== 'LIQ');
        U.replace(smSummary, `${O.length} orders · ${new Set(O.map((l) => l.sid)).size} accounts · ${sm.scanned} of ${sm.total} accounts checked${sm.skipped ? ` (${sm.skipped} skipped: empty and never traded in the last snapshot)` : ''} · at ${U.fmtTime(sm.at)}`);
        if (!markets.length) { U.replace(smSel); U.replace(smBands); U.replace(smLadder, UI.empty('No stop orders on the exchange right now.')); U.replace(smTable); return; }
        const cur = markets.find((x) => x.pid === smMarket) || markets[0]; smMarket = cur.pid;
        U.replace(smSel, UI.seg(markets.map((x) => ({ v: x.pid, label: x.p.displayTicker })), smMarket, (v) => { smMarket = v; renderStopMap(); }, 'sm'));
        const { ls, fires } = cur, m = cur.mark, tick = cur.p.tickSize;
        // the stops that would sell into a fall and buy into a rise near the mark, each position once
        U.replace(smBands, BANDS.map((b) => { const pr = AN.stopPressure(ls, m, b, fires); return h('div.band', { title: `Within ${b}% of the mark: ${U.fmtUsd(pr.sells)} of stops below it would sell into the order book as the price falls to them (longs' stop-losses, sell entry stops) and ${U.fmtUsd(pr.buys)} above it would buy as it rises (shorts' stop-losses, buy entry stops); a stop fires as a market order. Each position counts once, at the exit the price reaches first, as if it moves there step by step; a stop behind its position's liquidation never fires (the liquidation map lists those). Take-profits trade against the move and are not counted.` },
          h('span.k', 'within ' + b + '%'), h('span.neg', '▼' + NB + usdC(pr.sells), h('span.w', ' sells')), h('span.pos', '▲' + NB + usdC(pr.buys), h('span.w', ' buys'))); }));
        // the ladder lists every order at its full size; one its position cannot reach is dimmed, with the reason
        const lad = ladderRows(cur.orders, m, (l) => l.kind + '|' + l.flow);
        const maxUsd = Math.max(1, ...lad.list.map((r) => r.usd));
        const KINDS = { TP: ['TP', 'green'], SL: ['SL', 'red'], ENTRY: ['entry', 'blue'] };
        // the exit of the same position the price reaches before an order that cannot happen (AN.stopFires)
        const blocker = (i) => nearest(ls.filter((l) => l.pos === i.pos && l !== i && fires.get(l) > 0 && (i.price > m ? l.price > m && l.price <= i.price : l.price <= m && l.price >= i.price)), i.price);
        const note = (i) => {
          const f = fires.get(i);
          if (f > 0) return f < i.qty * 0.999 ? ' · only ' + U.fmtQty(f, cur.p.lotSize) + ' left by then' : '';
          const b = blocker(i);
          return ' · won\'t happen: ' + (!b ? 'the position is closed by then' : b.kind === 'LIQ' ? 'liquidated first at ' + U.fmtPrice(b.price, tick) : 'closed first by its ' + (b.kind === 'TP' ? 'take-profit' : 'stop-loss') + ' at ' + U.fmtPrice(b.price, tick));
        };
        const rowEl = (r) => {
          const dist = m > 0 ? ((r.price - m) / m) * 100 : null;
          const accts = new Set(r.items.map((i) => i.sid)).size;
          const dead = !r.items.some((i) => fires.get(i) > 0);
          const detail = h('div.smap-detail', { style: { display: 'none' } }, r.items.map((i) => h('div.row.small',
            h('a.addr', { href: U.accountUrl(i.account, i.sid) }, U.shortAddr(i.account)),
            h('span.dim', (i.kind === 'ENTRY' ? 'opens ' : 'closes ') + i.posSide + ' · ' + (i.mech === 'limit' ? 'reduce-only limit' : 'stop' + (i.trigger === 'last' ? ' (last px)' : '')) + (i.oco ? ' · OCO' : '') + note(i)),
            h('span.grow'), h('span.num', U.fmtQty(i.qty, cur.p.lotSize) + ' · ' + U.fmtUsd(i.usd, { compact: true })))));
          const title = dead ? 'Won\'t happen: these positions are closed by then (a nearer exit, or their liquidation)' : r.flow === 'sell' ? 'Sells when the price gets here' : 'Buys when the price gets here';
          const el = h('div.lvl', { class: r.flow + (dead ? ' dead' : ''), title, onclick: toggleDetail(detail) },
            h('i', { style: { width: (r.usd / maxUsd) * 100 + '%' } }),
            h('span', (lad.bin ? '≈' : '') + U.fmtPrice(r.price, tick)),
            h('span', { class: dist == null ? '' : dist > 0 ? 'pos' : 'neg' }, dist == null ? '' : U.fmtPct(dist, { sign: true, dp: 1 })),
            h('span', UI.chip(KINDS[r.kind][0], KINDS[r.kind][1])),
            h('span', { class: r.flow === 'sell' ? 'neg' : 'pos' }, r.flow === 'sell' ? '▼ sell' : '▲ buy'),
            h('span.num', usdC(r.usd)),
            h('span.dim', accts + (accts === 1 ? ' acct' : ' accts')));
          return [el, detail];
        };
        U.replace(smLadder, ladderBody(h('div.hdr', h('span', 'Price'), h('span', 'vs mark'), h('span', 'Type'), h('span', 'Then'), h('span', 'Notional'), h('span', 'Accounts')), lad, m, cur, rowEl));
        U.replace(smTable, UI.table({
          cols: [
            { key: 'm', label: 'Market', render: (r) => UI.marketCell(r.p.displayTicker) },
            { key: 'n', label: 'TP / SL / entry', num: true, title: 'Take-profits, stop-losses and entry stops', render: (r) => h('span', h('span.pos', String(r.tp.length)), h('span.dim', ' / '), h('span.neg', String(r.sl.length)), h('span.dim', ' / '), String(r.en.length)) },
            { key: 'sells', label: '▼ Sells ≤2%', num: true, title: 'Stops within 2% below the mark that would sell into the order book in a fall, each position once', render: (r) => h('span.neg', usdC(r.near2.sells)) },
            { key: 'buys', label: '▲ Buys ≤2%', num: true, title: 'Stops within 2% above the mark that would buy into the order book in a rise, each position once', render: (r) => h('span.pos', usdC(r.near2.buys)) },
            { key: 'nsl', label: 'Nearest SL', num: true, title: 'The stop-loss closest to the mark that can fire (one behind its position\'s liquidation never does)', render: (r) => nearCell(r.nearSl, r) },
            { key: 'a', label: 'Accounts', num: true, render: (r) => String(r.accounts) },
          ], rows: markets, onRow: (r) => { smMarket = r.pid; renderStopMap(); }, rowClass: (r) => (r.pid === smMarket ? 'sel' : ''), phone: { title: 'm', aside: 'a' },
        }));
      }

      // ---- liquidation map: every open position's liquidation price, and Meridian's liquidator ----
      // A liquidated position goes to the liquidator account at its bankruptcy price, not into the order book. The
      // liquidator's pool in the market's currency pays for a jump past that price; when it cannot, Meridian force-closes
      // positions on the winning side (auto-deleveraging). The jump that would drain each pool: AN.liquidatorDrain.
      const jump = (x, up) => (x == null ? h('span.dim', (up ? '▲' : '▼') + NB + '>30%') : h(up ? 'span.pos' : 'span.neg', (up ? '▲' : '▼') + NB + x.toFixed(1) + '%'));
      function renderLiqMap() {
        if (!sm) return;
        const L = sm.levels.filter((l) => !U.isExcluded(l.account));   // left-out wallets (U.EXCLUDED) are not listed
        const byMarket = U.groupBy(L, (l) => l.productId);
        // the drain counts every account's positions, the left-out wallets' too: the liquidator takes those over as well
        const allLiq = U.groupBy(sm.levels.filter((l) => l.kind === 'LIQ'), (l) => l.productId);
        const markets = sortMarkets(Object.keys(byMarket).filter((pid) => ref.byId[pid] && byMarket[pid].some((l) => l.kind === 'LIQ')).map((pid) => {
          const ls = byMarket[pid]; const p = ref.byId[pid]; const m = mark(p);
          const fires = AN.stopFires(ls, m);   // a position whose stop-loss closes it first is not liquidated as the price moves there
          const lq = ls.filter((l) => l.kind === 'LIQ');
          const reached = (side) => lq.filter((l) => l.posSide === side && fires.get(l) > 0);
          const pool = sm.pools ? sm.pools[String(p.quoteTokenAddress).toLowerCase()] || 0 : null;
          return { pid, p, mark: m, ls, fires, lq, longs: lq.filter((l) => l.posSide === 'long').length, shorts: lq.filter((l) => l.posSide === 'short').length,
            near5: AN.stopPressure(ls, m, 5, fires), nearLong: nearest(reached('long'), m), nearShort: nearest(reached('short'), m),
            pool, drain: pool == null ? null : AN.liquidatorDrain(allLiq[pid] || [], m, pool), shared: AN.marketCategory(p) === 'crypto' };
        }));
        const LQ = L.filter((l) => l.kind === 'LIQ');
        U.replace(lmSummary, `${LQ.length} positions with a liquidation price · ${new Set(LQ.map((l) => l.sid)).size} accounts · ${sm.pools ? 'the liquidator\'s pools read' : 'the liquidator\'s pools could not be read'} · ${sm.scanned} of ${sm.total} accounts checked · at ${U.fmtTime(sm.at)}`);
        if (!markets.length) { U.replace(lmSel); U.replace(lmBands); U.replace(lmPool); U.replace(lmLadder, UI.empty('No open position has a liquidation price right now.')); U.replace(lmTable); return; }
        const cur = markets.find((x) => x.pid === lmMarket) || markets[0]; lmMarket = cur.pid;
        U.replace(lmSel, UI.seg(markets.map((x) => ({ v: x.pid, label: x.p.displayTicker })), lmMarket, (v) => { lmMarket = v; renderLiqMap(); }, 'sm'));
        const { ls, fires } = cur, m = cur.mark, tick = cur.p.tickSize, base = cur.p.baseTokenName;
        // the positions liquidated as the price moves within 1, 2 and 5% of the mark, each once
        U.replace(lmBands, BANDS.map((b) => { const pr = AN.stopPressure(ls, m, b, fires); return h('div.band', { title: `Within ${b}% of the mark: ${U.fmtUsd(pr.liqDown)} of longs below it and ${U.fmtUsd(pr.liqUp)} of shorts above it are liquidated as the price moves there, each position once (one whose stop-loss closes it first is left out, though a gap can jump past the stop). The liquidator takes them over; nothing is sold into the order book.` },
          h('span.k', 'within ' + b + '%'), h('span.neg', '▼' + NB + usdC(pr.liqDown), h('span.w', ' longs')), h('span.pos', '▲' + NB + usdC(pr.liqUp), h('span.w', ' shorts'))); }));
        // the liquidator's pool for the market, and the jump that would drain it
        U.replace(lmPool,
          h('div.band', { title: `What Meridian's liquidator account holds in the market's margin pool, read at the scan. It takes every liquidated position over at its bankruptcy price (where the trader's margin is gone) and pays for a jump past that price from this pool.${cur.shared ? ' Every crypto market shares it.' : ''}` },
            h('span.k', 'liquidator pool'), h('span', cur.pool == null ? '—' : U.fmtUsd(cur.pool)), h('span.xs.dim', cur.shared ? 'shared by every crypto market' : 'for ' + cur.p.displayTicker + ' only')),
          h('div.band', { title: `How far the price would have to jump from the mark in one go (a gap at a reopening) for the liquidator to lose more than its pool on the positions the jump liquidates, each counted whole (a gap passes their stops too). Then Meridian auto-deleverages: it force-closes winning positions on the other side outside the order book, ${base} shorts after a fall and ${base} longs after a rise.${cur.shared ? ' As if this market moved alone: a fall across the coins drains the shared pool sooner.' : ''}` },
            h('span.k', 'drained by a jump of'), cur.drain ? h('span', jump(cur.drain.down, false), ' ', jump(cur.drain.up, true)) : h('span.dim', '—'), h('span.xs.dim', 'then winning positions are force-closed')));
        // the ladder: every liquidation price by price and side; one its position's stop-loss comes before is dimmed
        const lad = ladderRows(cur.lq, m, (l) => l.posSide);
        const maxUsd = Math.max(1, ...lad.list.map((r) => r.usd));
        const stopFirst = (i) => nearest(ls.filter((l) => l.pos === i.pos && l.kind !== 'LIQ' && fires.get(l) > 0 && (i.posSide === 'long' ? l.price <= m && l.price >= i.price : l.price > m && l.price <= i.price)), i.price);
        const rowEl = (r) => {
          const dist = m > 0 ? ((r.price - m) / m) * 100 : null;
          const accts = new Set(r.items.map((i) => i.sid)).size;
          const dead = !r.items.some((i) => fires.get(i) > 0);
          const detail = h('div.smap-detail', { style: { display: 'none' } }, r.items.map((i) => {
            const f = fires.get(i), s = f >= i.qty * 0.999 ? null : stopFirst(i);
            return h('div.row.small',
              h('a.addr', { href: U.accountUrl(i.account, i.sid) }, U.shortAddr(i.account)),
              h('span.dim', i.posSide + (i.bk != null ? ' · margin gone at ' + U.fmtPrice(i.bk, tick) : '') + (s ? ' · its stop-loss at ' + U.fmtPrice(s.price, tick) + (f > 0 ? ' closes part of it first' : ' closes it first, unless a gap jumps past it') : '')),
              h('span.grow'), h('span.num', U.fmtQty(i.qty, cur.p.lotSize) + ' · ' + U.fmtUsd(i.usd, { compact: true })));
          }));
          const title = dead ? 'Their stop-losses close these positions first, unless a gap jumps past them' : (r.side === 'long' ? 'Longs liquidated when the price falls here' : 'Shorts liquidated when the price rises here') + ': the liquidator takes them over, nothing is sold into the order book';
          const el = h('div.lvl', { class: dead ? 'dead' : null, title, onclick: toggleDetail(detail) },
            h('i', { style: { width: (r.usd / maxUsd) * 100 + '%' } }),
            h('span', (lad.bin ? '≈' : '') + U.fmtPrice(r.price, tick)),
            h('span', { class: dist == null ? '' : dist > 0 ? 'pos' : 'neg' }, dist == null ? '' : U.fmtPct(dist, { sign: true, dp: 1 })),
            h('span', UI.chip(r.side, r.side === 'long' ? 'green' : 'red')),
            h('span.num', usdC(r.usd)),
            h('span.dim', accts + (accts === 1 ? ' acct' : ' accts')));
          return [el, detail];
        };
        U.replace(lmLadder, ladderBody(h('div.hdr', h('span', 'Liq. price'), h('span', 'vs mark'), h('span', 'Side'), h('span', 'Notional'), h('span', 'Accounts')), lad, m, cur, rowEl));
        // a liquidation over 100% away (a short with far more margin than it needs) is practically never: no figures
        const liqCell = (l, r) => (l && Math.abs(l.price / r.mark - 1) >= 1 ? h('span.dim', { title: U.fmtPrice(l.price, r.p.tickSize) }, '>+100%') : nearCell(l, r));
        U.replace(lmTable, UI.table({
          cols: [
            { key: 'm', label: 'Market', render: (r) => UI.marketCell(r.p.displayTicker) },
            { key: 'n', label: 'Longs / shorts', num: true, title: 'Open positions with a liquidation price', render: (r) => r.longs + ' / ' + r.shorts },
            { key: 'nl', label: 'Nearest long', num: true, title: 'The long liquidated first as the price falls (one whose stop-loss closes it before is left out)', render: (r) => liqCell(r.nearLong, r) },
            { key: 'ns', label: 'Nearest short', num: true, title: 'The short liquidated first as the price rises (one whose stop-loss closes it before is left out; over 100% away it practically never is)', render: (r) => liqCell(r.nearShort, r) },
            { key: 'w5', label: 'Liq. ≤5%', num: true, title: 'Positions liquidated within 5% of the mark, ▼ longs below it and ▲ shorts above it, each once', render: (r) => { const d = r.near5.liqDown, u = r.near5.liqUp; return d || u ? h('span', d ? h('span.neg', '▼' + NB + usdC(d)) : null, d && u ? ' ' : null, u ? h('span.pos', '▲' + NB + usdC(u)) : null) : h('span.dim', '—'); } },
            { key: 'pool', label: 'Liquidator pool', num: true, title: 'What Meridian\'s liquidator account holds in the market\'s margin pool (the crypto markets share one)', render: (r) => (r.pool == null ? h('span.dim', '—') : h('span', usdC(r.pool), r.shared ? h('span.xs.dim', ' shared') : null)) },
            { key: 'drain', label: 'Pool drained by', num: true, title: 'The jump of the price, in one go (a gap at a reopening), that would make the liquidator lose more than its pool; after that Meridian force-closes winning positions (auto-deleveraging)', render: (r) => (r.drain ? h('span', jump(r.drain.down, false), ' ', jump(r.drain.up, true)) : h('span.dim', '—')) },
          ], rows: markets, onRow: (r) => { lmMarket = r.pid; renderLiqMap(); }, rowClass: (r) => (r.pid === lmMarket ? 'sel' : ''), phone: { title: 'm', aside: 'drain' },
        }));
      }
      // scans only while the stop map or the liquidation map is open: at once on opening one (unless the last scan is under
      // 2 minutes old), then every 2 minutes; closing both stops the rescans and keeps what was found
      let smT = null;
      scanOpen = () => {
        clearInterval(smT); smT = null;
        if (!stopCard.classList.contains('open') && !liqCard.classList.contains('open')) return;
        if (!sm || Date.now() - sm.at >= 120000) scanStops();
        smT = setInterval(scanStops, 120000);
      };
      ctx.onCleanup(() => clearInterval(smT));
      scanOpen();   // one opened while the page was still loading

      // ---- market specs (the card under Funding): every market's limits and settings from its product data, by category
      // in the Markets table's order; redrawn with the products every minute while open ----
      renderSpecs = () => {
        if (!specsCard.classList.contains('open')) return;
        const list = sortMarkets(ref.active.map((p) => ({ p, mark: mark(p) })));
        const groups = AN.MARKET_CATS.map(([k, name]) => ({ name, rows: list.filter((r) => AN.marketCategory(r.p) === k) })).filter((g) => g.rows.length).map((g) => ({ head: catHead(g.name, g.rows), rows: g.rows }));
        const imS = (p) => { const o = U.num(p.openMarketInitialMargin), c = U.num(p.closedMarketInitialMargin);
          return c !== o ? h('span', pctT(o), h('span.xs.dim', ' open · '), h('span', { class: c > o ? 'neg' : '' }, pctT(c)), h('span.xs.dim', ' closed')) : h('span', pctT(o)); };
        const share = (x) => (x > 0 && x < 0.0005 ? '<0.1%' : U.fmtPct(x * 100, { dp: 1 }));
        const oiS = (r) => { const u = oiUse(r.p, r.mark); if (!u) return h('span.dim', '—');
          return h('span', { title: `Meridian caps the open interest of each side of ${r.p.displayTicker} at ${U.fmtUsd(u.cap, { dp: 0 })}: its longs (and as much in shorts) are worth ${U.fmtUsd(u.side, { dp: 0 })} at the mark price now, ${share(u.share)} of the cap` },
            usdC(u.side), h('span.dim', ' of '), usdC(u.cap), h('span.xs.dim', ' ' + share(u.share))); };
        const plain = (x) => U.fmtQty(x);   // up to 6 decimals, the trailing zeros dropped: "0.1 – 1,002,492"
        const impS = (p) => { const b = U.num(p.fundingBidImpactSizeUsd), a = U.num(p.fundingAskImpactSizeUsd); return b === a ? usdC(b) : usdC(b) + ' / ' + usdC(a); };
        const listedS = (p) => h('div.mkt-row', h('div', p.blockNumber ? h('a', { href: U.explorerBlock(p.blockNumber), target: '_blank', rel: 'noopener', title: 'Registered on Robinhood Chain in block ' + p.blockNumber }, U.fmtDate(p.createdAt)) : U.fmtDate(p.createdAt)),
          h('div.sub', 'on-chain #' + (p.onchainId != null ? p.onchainId : '—') + ' · engine ' + (p.engineType != null ? p.engineType : '—')));
        U.replaceLive(specsBody, h('div', UI.table({
          cols: [
            { key: 'm', label: 'Market', render: (r) => UI.marketCell(r.p.displayTicker, r.p.marginMode === 'CROSS' ? 'cross margin' : 'isolated margin') },
            { key: 'lev', label: 'Max leverage', num: true, title: 'The highest leverage Meridian\'s app offers on the market', render: (r) => r.p.maxLeverage + '×' },
            { key: 'im', label: 'Initial margin', num: true, title: 'The initial margin Meridian\'s product data sets, as a share of a position\'s value: while the market is open, and while it is closed (an mPerp\'s mark-price gap) where that differs', render: (r) => imS(r.p) },
            { key: 'mm', label: 'Maint. margin', num: true, title: 'The equity a margin pool must keep for a position, as a share of its value: below it the pool is liquidated. Meridian\'s docs put the base figure at 1 ÷ (2 × the max leverage)', render: (r) => pctT(r.p.maintenanceMargin) },
            { key: 'oi', label: 'Open interest / cap', num: true, title: 'Meridian caps the open interest of each side of a market: one side\'s positions at the mark price now, the cap, and how much of it they use', render: oiS },
            { key: 'pos', label: 'Max position', num: true, title: 'The largest position one account can hold in the market, by value', render: (r) => usdC(r.p.maxPositionNotionalUsd) },
            { key: 'qty', label: 'Order size', num: true, title: 'The smallest and the largest quantity one order can have', render: (r) => plain(r.p.minQuantity) + ' – ' + plain(r.p.maxQuantity) + ' ' + (r.p.baseTokenName || '') },
            { key: 'tl', label: 'Tick / lot', num: true, title: 'The step of an order\'s price and of its quantity', render: (r) => h('span', r.p.tickSize, h('span.dim', ' / '), r.p.lotSize) },
            { key: 'px', label: 'Price limits', num: true, title: 'The lowest and the highest price the product allows', render: (r) => plain(r.p.minPrice) + ' – ' + plain(r.p.maxPrice) },
            { key: 'fee', label: 'Taker / maker fee', num: true, title: 'The fee on each trade, as a share of its value: the taker\'s and the maker\'s', render: (r) => pctT(r.p.takerFee) + ' / ' + pctT(r.p.makerFee) },
            { key: 'imp', label: 'Funding impact size', num: true, title: 'The order size funding reads the order book at: the average price of selling (the impact bid) and of buying (the impact ask) this many dollars at once, against the mark price, sampled through the hour (Meridian\'s docs: Funding Rates)', render: (r) => impS(r.p) },
            { key: 'feed', label: 'Pyth feed', num: true, title: 'The id of the Pyth price feed the market\'s oracle price comes from', render: (r) => (r.p.pythFeedId != null ? '#' + r.p.pythFeedId : '—') },
            { key: 'listed', label: 'Listed', title: 'When the market was listed (a link to the Robinhood Chain block it was registered in), its id on-chain and the engine type it was registered with', render: (r) => listedS(r.p) },
          ], groups, phone: { title: 'm', aside: 'lev', hide: ['tl', 'px'], wide: ['oi'] },
        }), h('div.footer-note', 'From Meridian\'s product data, refreshed every minute; open interest at the mark price. Funding reads the order book at the impact size (', h('a', { href: 'https://docs.meridian.xyz/trading/perpetual-futures/funding-rates', target: '_blank', rel: 'noopener' }, 'Meridian\'s docs'), ').')));
      };
      renderSpecs();

      // the coins' market caps (CoinGecko, kept 12 hours in this browser) order the crypto markets; until they arrive, or
      // without them, each coin's last known size does (AN.marketSize)
      A.marketCaps(ref.active.filter((p) => AN.marketCategory(p) === 'crypto').map((p) => p.baseTokenName), ctx)
        .then((c) => { caps = c; renderMarketsThrottled(); renderStopMap(); renderLiqMap(); })
        .catch((e) => { if (!isAbort(e)) console.warn('market caps', e && e.message); });

      // ---- live trades ----
      // WebSocket fills carry both subaccount ids; the REST history only carries order ids, so those rows are
      // resolved to their taker / maker through the public order endpoint in the background (cached, a few at a time).
      let trades = [];
      const SHOW = 60;
      const openAccount = async (t, which) => {
        let sid = t[which];
        if (!sid && t[which + 'Order']) { try { sid = (await A.order(t[which + 'Order'], ctx)).subaccountId; t[which] = sid; } catch (_) {} }
        if (sid) MD.router.navigate('/account', { address: '', sub: sid }); else U.toast('Account not available for this trade');
      };
      // a fill's fees, on its notional: the REST history's own figures, a live fill's worked out from the fee rates (≈)
      const feeUsd = (x) => (x > 0 && x < 0.01 ? '$' + x.toPrecision(2) : U.fmtUsd(x, { dp: x > 0 && x < 1 ? 4 : 2 }));
      const feeTitle = (t) => {
        const f = tradeFee(t), n = U.num(t.size) * U.num(t.price), ap = f.exact ? '' : '≈';
        return `Notional ${U.fmtUsd(n)} · taker fee ${ap}${feeUsd(f.taker)}${n ? ' (' + pctT(f.taker / n) + ')' : ''} · maker fee ${f.maker ? ap + feeUsd(f.maker) : 'none'}` + (f.exact ? '' : ' · worked out from the market\'s fee rates: the live feed sends a fill without its fees');
      };
      const tradeRow = (t, flash) => {
        const link = (which, label) => { const sid = t[which]; return sid || t[which + 'Order'] ? h('a', { href: sid ? U.accountUrl('', sid) : '#', title: sid || 'resolving…', onclick: (e) => { e.preventDefault(); e.stopPropagation(); openAccount(t, which); } }, label) : h('span.dim', label); };
        const clickable = !!(t.taker || t.takerOrder);
        return h('div.it', { class: (flash ? 'flash ' : '') + (clickable ? 'click' : ''), title: clickable ? 'Open the account that took this trade' : undefined, onclick: clickable ? () => openAccount(t, 'taker') : undefined },
          h('span.t', U.fmtFeedTime(t.t)), h('span.m', t.ticker), U.sideEl(t.side), h('span.num', U.fmtQty(t.size, t.lot) + ' @ ' + U.fmtPrice(t.price, t.tick)), h('span.grow'), h('span.num.dim', { title: feeTitle(t) }, U.fmtUsd(U.num(t.size) * U.num(t.price))),
          h('span.xs', link('taker', 'taker'), h('span.dim', ' · '), link('maker', 'maker')));
      };
      const renderTrades = () => U.replaceLive(tradesBody, trades.length ? trades.slice(0, SHOW).map((t, i) => tradeRow(t, t._new && i < 5)) : UI.empty('No trades yet'));
      let resolving = false;
      const resolveVisible = async () => {
        if (resolving) return; resolving = true;
        try {
          const todo = trades.slice(0, SHOW).filter((t) => (!t.taker && t.takerOrder) || (!t.maker && t.makerOrder));
          let i = 0, changed = false;
          await Promise.all(Array.from({ length: 3 }, async () => {
            while (i < todo.length && !ctx.signal.aborted) {
              const t = todo[i++];
              for (const which of ['taker', 'maker']) {
                if (t[which] || !t[which + 'Order']) continue;
                try { t[which] = (await A.order(t[which + 'Order'], ctx)).subaccountId || null; changed = true; } catch (e) { if (e.name === 'AbortError') return; t[which + 'Order'] = null; }
              }
            }
          }));
          if (changed && !ctx.signal.aborted) renderTrades();
        } finally { resolving = false; }
      };
      (async () => {
        // SHOW rows per market: one market can fill at most SHOW rows, so the newest SHOW of the merged list are
        // exactly the newest SHOW trades (with fewer per market a busy market's older trades went missing)
        const seed = await Promise.all(ref.active.map((p) => A.trades(p.id, SHOW, ctx).then((rows) => rows.map((r) => restTrade(p, r))).catch(() => [])));
        trades = U.sortBy(seed.flat(), (t) => t.t, true);
        renderTrades();
        resolveVisible();
      })();
      for (const p of ref.active) {
        ctx.onCleanup(A.ws.subscribe('TradeFill', p.ticker, (m) => {
          for (const t of wsTrades(p, m)) trades.unshift(t);   // one at a time, as before: the last fill of a batch ends on top
          trades = trades.slice(0, 200); renderTrades();
        }));
        ctx.onCleanup(A.ws.subscribe('Ticker', p.ticker, (m) => { live[p.ticker] = m.data; renderMarketsThrottled(); }));
      }
      ctx.onCleanup(A.ws.onStatus((s) => { status.className = 'status-dot ' + (s === 'open' ? 'ok' : s === 'connecting' ? 'warn' : 'bad'); statusTxt.textContent = s === 'open' ? 'live' : s; }));

      // ---- liquidations ----
      // the API's cause (LiquidationCause) in plain words: what took the pool's equity below its maintenance margin
      const CAUSES = {
        MarkChanged: ['Price move', 'A mark price change took the margin pool\'s equity below its maintenance margin; in a cross pool the price that moved can be another market\'s. A liquidation closes every position in that pool.'],
        Funding: ['Funding', 'A funding payment took the pool\'s equity below the maintenance margin.'],
        PositionFee: ['Position fee', 'An mPerp position fee took the pool\'s equity below the maintenance margin; it can happen while the market is closed and the price is frozen.'],
      };
      const causeEl = (r) => {
        const c = CAUSES[r.cause]; if (!c) return UI.chip(r.cause || '—', 'red');
        const charge = r.cause === 'Funding' && U.num(r.fundingChargeUsd) ? ` Funding charged: ${U.fmtUsd(r.fundingChargeUsd)}.` : '';
        return h('span', { title: c[1] + charge + ` (API cause: ${r.cause})` }, UI.chip(c[0], 'red'));
      };
      async function loadLiq() {
        try {
          const rows = await A.liquidations(20, ctx);
          U.replace(liqBody, UI.table({
            cols: [
              { key: 't', label: 'Time', render: (r) => h('span.dim', U.fmtDateTimeS(r.createdAt)) },
              { key: 'acct', label: 'Account', render: (r) => h('a.addr', { href: U.accountUrl('', r.subaccountId) }, U.shortAddr(r.subaccountId, 4)) },
              { key: 'm', label: 'Market', render: (r) => (ref.byId[r.productId] ? ref.byId[r.productId].displayTicker : '—') },
              { key: 'side', label: 'Side', render: (r) => U.sideEl(r.positionSide, true) },
              { key: 'cost', label: 'Notional', num: true, title: 'USD value of the position closed by the liquidation (size × liquidation fill price), as the exchange reports it; not the trader\'s loss', render: (r) => U.fmtUsd(r.cost) },
              { key: 'px', label: 'Liq. price', num: true, render: (r) => U.fmtPrice(r.liquidationPrice, ref.byId[r.productId] && ref.byId[r.productId].tickSize) },
              { key: 'cause', label: 'Cause', title: 'What took the margin pool below its maintenance margin: a price move, a funding payment or an mPerp position fee', render: causeEl },
            ], rows, empty: 'No liquidations recorded', phone: { title: 'm', aside: 'cost' },
          }));
        } catch (e) { if (e.name !== 'AbortError') U.replace(liqBody, UI.error(e)); }
      }
      loadLiq();
      const liqT = setInterval(loadLiq, 30000); ctx.onCleanup(() => clearInterval(liqT));

      // ---- closures ----
      // a function so the minute refresh can redraw it: "closed now" is read against the clock at each render
      function renderGaps() {
        const t = Date.now();
        const upcoming = gaps.filter((g) => g.endTime > t).sort((a, b) => a.startTime - b.startTime).slice(0, 12);
        U.replace(gapBody, UI.table({
          cols: [
            { key: 'm', label: 'Market', render: (g) => (ref.byId[g.productId] ? ref.byId[g.productId].displayTicker : '—') },
            { key: 's', label: 'Closes', render: (g) => h('span', { class: g.startTime <= t ? 'neg' : '' }, g.startTime <= t ? 'closed now' : U.fmtWhen(g.startTime)) },
            { key: 'e', label: 'Reopens', render: (g) => U.fmtWhen(g.endTime) },
            { key: 'd', label: 'Duration', num: true, render: (g) => U.fmtDuration(g.endTime - g.startTime) },
          ], rows: upcoming, empty: 'No closures scheduled', phone: { title: 'm', aside: 'd' },
        }));
      }
      renderGaps();
    },
  };
})();
