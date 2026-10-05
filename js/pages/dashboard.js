/* MeridianDataHub — Exchange dashboard: markets, stop map, live trades, liquidations, closures */
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
    return { lastPct: ratePct(p.fundingRate1h), projPct: raw == null ? null : ratePct(raw), aprPct: raw == null ? null : ratePct(raw, 24 * 365), paused: !!gap, until: gap ? gap.endTime : null };
  };
  // live-feed rows from the REST history and from a WebSocket fill: the product's tick and lot ride along, so price and
  // size print at the app's decimals (a size at a fixed 4 dp showed a 1.19645 BTC fill as 1.1965, off the lot grid)
  const restTrade = (p, r) => ({ id: r.id, t: r.createdAt, ticker: p.displayTicker, tick: p.tickSize, lot: p.lotSize, side: r.takerSide, size: r.filled, price: r.price, takerOrder: r.takerOrderId || null, makerOrder: r.makerOrderId || null });
  const wsTrades = (p, m) => { const d = m.data || {}; return (d.d || []).map((it) => ({ id: it.id, t: d.t || m.t, ticker: p.displayTicker, tick: p.tickSize, lot: p.lotSize, side: it.sd, size: it.sz, price: it.px, taker: it.sids && it.sids[0], maker: it.sids && it.sids[1], _new: true })); };

  MD.router.pages.dashboard = {
    ratePct, fundingGap, fundingOf, restTrade, wsTrades,
    async mount(root, route, ctx) {
      MD.setTopbar(h('span.title', 'Dashboard'));
      const tiles = h('div.stats');
      const mktBody = h('div', UI.loading('Loading markets…'));
      const tradesBody = h('div.feed.pause-hover', UI.loading('Loading trades…'));
      const liqBody = h('div', UI.loading('Loading…'));
      const gapBody = h('div', UI.loading('Loading…'));
      const fundBody = h('div');
      const status = h('span.status-dot'); const statusTxt = h('span.dim.small');
      // stop map elements
      const smSummary = h('span.dim.small', h('span.loading', h('span.spinner'), 'Scanning accounts…'));
      const smSel = h('div.smap-sel');
      const smLadder = h('div.smap', UI.loading('Collecting stop orders…'));
      const smTable = h('div');
      const smRescan = h('button.btn.sm', { onclick: () => scanStops() }, U.icon('refresh'), 'Rescan');
      const stopCard = h('div.card.tight',
        h('div.card-head', h('h2', 'Stop map'), smSummary, h('span.grow'), h('span.dim.small', 'take-profit, stop-loss and entry stops of every account, by price level · click a level for the accounts'), smRescan),
        h('div.smap-wrap', h('div', smSel, smLadder), smTable));
      U.replace(root, h('div.page', h('div.stack', tiles,
        h('div.card.tight', h('div.card-head', h('h2', 'Markets'), status, statusTxt, h('span.grow'), h('span.dim.small', 'prices via WebSocket · sparkline = 7d oracle price')), mktBody),
        stopCard,
        h('div.grid.cols-2',
          h('div.card.tight.feed-card', h('div.card-head', h('h2', 'Live trades'), h('span.dim.small', 'all markets · click a trade to open the account that took it')), h('div.feed-fill', tradesBody)),
          h('div.stack', h('div.card.tight', h('div.card-head', h('h2', 'Liquidations'), h('span.dim.small', 'latest 20')), liqBody), h('div.card.tight', h('div.card-head', h('h2', 'Market closures (mPerps)'), h('span.dim.small', 'next 7 days')), gapBody))),
        h('div.card.tight', h('div.card-head', h('h2', 'Funding'), h('span.dim.small', 'projected next charge, as Meridian\'s app shows it · last hourly charge · annualized from the projected rate')), fundBody))));

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

      function renderTiles() {
        // summed from the Markets table's own rows, so the tiles always equal the column totals
        let vol = 0, oi = 0;
        for (const r of marketRows()) { vol += r.volUsd; oi += r.oiUsd; }
        U.replaceLive(tiles, UI.stat('Active markets', String(ref.active.length), ref.products.length - ref.active.length ? (ref.products.length - ref.active.length) + ' pending/delisted' : null),
          UI.stat(h('span', { title: '24 h traded quantity (base units) × current mark price, summed over markets' }, '24h volume'), U.fmtUsd(vol, { compact: true })),
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
          // one source per field, shared by tiles and table: REST open interest matched the open positions
          // while the WebSocket oi lagged for minutes; volume takes the live figure when there is one
          const oiN = U.num(p.openInterest); const volN = U.num(l.vol24h || p.volume24h);
          // the clock, not the mount time: a closure that starts while the page is open pauses funding on the next render
          const f = fundingOf(p, { projected, live: l, gaps, t: Date.now() });
          return { p, m, chg: p24 ? ((m - p24) / p24) * 100 : null, bid, ask, spread: bid && ask ? ((ask - bid) / ((ask + bid) / 2)) * 100 : null, oiUsd: oiN * m, volUsd: volN * m, f };
        });
      }
      // funding cells: the app's format (4 dp, a minus but no plus), greyed "Paused" on an mPerp market inside a closure
      const pct4 = (x) => U.fmtPct(x, { dp: 4 });
      const pausedEl = (f) => h('span.dim', { title: `Funding is paused while this mPerp market is closed (until ${U.fmtWhen(f.until)}): no funding is charged in the window, a position fee is charged instead · last charge ${pct4(f.lastPct)}` }, 'Paused');
      const rateEl = (x, title) => (x == null ? h('span.dim', { title: 'projected rate not available yet' }, '—') : h('span', { class: U.pnlClass(x), title: title || null }, pct4(x)));
      const projEl = (f) => (f.paused ? pausedEl(f) : rateEl(f.projPct, 'last hourly charge ' + pct4(f.lastPct)));
      function renderMarkets() {
        const rows = marketRows();
        U.replaceLive(mktBody, UI.table({
          cols: [
            // the taker fee as set (0.005% shows as 0.005%, not rounded up to 0.01%)
            { key: 'm', label: 'Market', render: (r) => UI.marketCell(r.p.displayTicker, (r.p.marginMode === 'CROSS' ? 'cross' : 'isolated') + ' · ' + r.p.maxLeverage + '× · taker fee ' + (+(U.num(r.p.takerFee) * 100).toFixed(4)) + '%') },
            { key: 'px', label: 'Mark price', num: true, title: 'live mark price; the oracle price is shown until the first live update arrives', render: (r) => U.fmtPrice(r.m, r.p.tickSize) },
            { key: 'chg', label: '24h', num: true, title: 'mark price now against the oracle price 24 hours ago', render: (r) => UI.pct(r.chg, { dp: 2 }) },
            { key: 'ba', label: 'Bid / Ask', num: true, render: (r) => h('span', h('span.pos', r.bid ? U.fmtPrice(r.bid, r.p.tickSize) : '—'), h('span.dim', ' / '), h('span.neg', r.ask ? U.fmtPrice(r.ask, r.p.tickSize) : '—'), r.spread != null ? h('span.xs.dim', ' ' + U.fmtPct(r.spread, { dp: 3 })) : null) },
            // the app's Funding column: the projected rate, not the last charge (they can differ in sign); Paused in a closure
            { key: 'fr', label: 'Funding 1h', num: true, title: 'Projected rate for the next hourly charge, as Meridian\'s app shows it · positive = longs pay · hover a rate for the last charge · Paused: an mPerp market inside a closure, when no funding is charged', render: (r) => projEl(r.f) },
            { key: 'oi', label: 'Open interest', num: true, title: 'Long and short positions added together, as Meridian reports open interest; one side is half of it', render: (r) => U.fmtUsd(r.oiUsd, { compact: true }) },
            { key: 'vol', label: '24h volume', num: true, title: '24 h traded quantity (base units) × current mark price', render: (r) => U.fmtUsd(r.volUsd, { compact: true }) },
            { key: 'spark', label: '7d', render: (r) => { const c = sparks[r.p.ticker] || (sparks[r.p.ticker] = h('canvas.spark', { width: 110, height: 30 })); return c; } },
            { key: 'note', label: 'Status', render: (r) => closureNote(r.p) || h('span.xs.dim', r.p.marginMode === 'CROSS' ? '24/7' : 'open') },
          ], rows,
        }));
        U.replaceLive(fundBody, UI.table({
          cols: [
            { key: 'm', label: 'Market', render: (r) => r.p.displayTicker },
            { key: 'proj', label: 'Projected 1h', num: true, title: 'Projected rate for the next hourly charge, the figure Meridian\'s app shows (refreshed every minute) · positive = longs pay', render: (r) => projEl(r.f) },
            // history, so it stands in a closure too: the charge taken before the market closed
            { key: 'fr', label: 'Last 1h', num: true, title: 'Rate charged at the last hourly funding · positive = longs paid', render: (r) => rateEl(r.f.lastPct) },
            { key: 'apr', label: 'Annualized', num: true, title: 'Projected 1h rate × 24 × 365, the app\'s 1y figure', render: (r) => (r.f.paused ? pausedEl(r.f) : rateEl(r.f.aprPct)) },
            { key: 'base', label: 'Baseline / clamp / max APR', num: true, render: (r) => h('span.dim', U.fmtPct(U.num(r.p.fundingBaselineApr) * 100, { dp: 0 }) + ' / ' + U.fmtPct(U.num(r.p.fundingClampApr) * 100, { dp: 0 }) + ' / ' + U.fmtPct(U.num(r.p.fundingMaxApr) * 100, { dp: 0 })) },
            // a per-unit index (the sum of the hourly per-unit charges), not money paid on the market
            { key: 'cum', label: 'Cumulative funding / unit', num: true, title: 'Funding paid by a one-unit long held since funding began (negative = received); the sum of the hourly per-unit charges', render: (r) => U.fmtUsd(r.p.cumulativeFundingUsd) + ' / ' + (r.p.baseTokenName || 'unit') },
            { key: 'upd', label: 'Updated', render: (r) => h('span.dim', U.fmtAgo(r.p.fundingUpdatedAt)) },
          ], rows,
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
      renderTiles(); renderMarkets(); loadSparks();
      // products (last funding charge, cumulative funding, open interest, REST volume) and the projected rates
      // change on the exchange every hour or faster; refresh them every minute on a page left open
      const refreshRest = async () => {
        try {
          const r = await A.get(A.BASE + '/v1/product?limit=200', { signal: ctx.signal });   // no ttl: A.ref's 5-minute cache would hand back the same objects
          for (const p of (r && r.data) || []) if (ref.byId[p.id]) Object.assign(ref.byId[p.id], p);   // ref.active and ref.byId hold the same objects
          Object.assign(projected, await A.projectedFunding(ids, ctx));
          renderMarketsThrottled();
        } catch (_) {}
        try { const t = Date.now(); setGaps(await A.gaps(ids, t, t + 7 * U.DAY, ctx)); renderGaps(); renderMarketsThrottled(); } catch (_) {}
      };
      const restT = setInterval(refreshRest, 60000); ctx.onCleanup(() => clearInterval(restT));

      // ---- stop map: TP / SL / entry stop levels of every account, per market ----
      let sm = null, smMarket = null, smScanning = false;
      async function scanStops() {
        if (smScanning) return; smScanning = true; smRescan.disabled = true;
        U.replace(smSummary, h('span.loading', h('span.spinner'), 'Scanning accounts…'));
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
            const px = {}; for (const p of positions) { const prod = ref.byId[p.productId]; px[p.productId] = { oraclePrice: prod ? mark(prod) : 0 }; }
            const st = AN.accountState({ balances: [], positions, ref, prices: px });
            AN.attachStops(st.positions, working.concat(pending));
            const used = new Set();
            for (const r of st.positions) for (const [kind, list] of [['TP', r.tp], ['SL', r.sl]]) for (const e of list) {
              used.add(e.order.id); const qty = e.qty == null ? r.abs : e.qty;
              levels.push({ productId: r.p.productId, price: e.price, kind, posSide: r.long ? 'long' : 'short', qty, usd: qty * e.price, mech: e.kind, trigger: e.trigger, oco: e.oco, account: sa.account, sid: sa.id });
            }
            for (const od of pending) {                          // stops that open or add to a position
              if (used.has(od.id) || od.reduceOnly || od.close) continue;
              const qty = U.num(od.quantity), price = U.num(od.stopPrice); if (!(qty > 0 && price > 0)) continue;
              levels.push({ productId: od.productId, price, kind: 'ENTRY', posSide: String(od.side) === '0' ? 'long' : 'short', qty, usd: qty * price, mech: 'stop', trigger: AN.orderMeta(od).trigger, oco: false, account: sa.account, sid: sa.id });
            }
          });
          await U.pLimit(tasks, 4);
          if (ctx.signal.aborted) return;
          sm = { at: Date.now(), scanned, skipped, total: accounts.length, levels };
          if (!smMarket || !levels.some((l) => l.productId === smMarket)) { const by = {}; for (const l of levels) by[l.productId] = (by[l.productId] || 0) + l.usd; smMarket = Object.keys(by).sort((a, b) => by[b] - by[a])[0] || null; }
          renderStopMap();
        } catch (e) { if (!isAbort(e)) U.replace(smSummary, h('span.neg', 'scan failed: ' + e.message)); }
        finally { smScanning = false; smRescan.disabled = false; }
      }
      function renderStopMap() {
        if (!sm) return;
        const L = sm.levels;
        const byMarket = U.groupBy(L, (l) => l.productId);
        const markets = Object.keys(byMarket).filter((pid) => ref.byId[pid]).map((pid) => {
          const ls = byMarket[pid]; const p = ref.byId[pid]; const m = mark(p);
          const agg = { pid, p, mark: m, n: ls.length, tp: ls.filter((l) => l.kind === 'TP'), sl: ls.filter((l) => l.kind === 'SL'), en: ls.filter((l) => l.kind === 'ENTRY'), usd: U.sum(ls, (l) => l.usd), accounts: new Set(ls.map((l) => l.sid)).size };
          const near = (list) => (list.length ? list.reduce((a, l) => (Math.abs(l.price - m) < Math.abs(a.price - m) ? l : a)) : null);
          agg.nearSl = near(agg.sl); agg.nearTp = near(agg.tp); return agg;
        }).sort((a, b) => b.usd - a.usd);
        // a protected position counts in both its TP and its SL, so the dollar figure is order notional, not exposure
        U.replace(smSummary, `${L.length} orders · ${U.fmtUsd(U.sum(L, (l) => l.usd), { compact: true })} order notional (TP + SL + entry) · ${new Set(L.map((l) => l.sid)).size} accounts · ${sm.scanned} of ${sm.total} accounts checked${sm.skipped ? ` (${sm.skipped} skipped: empty and never traded in the last snapshot)` : ''} · at ${U.fmtTime(sm.at)}`);
        if (!markets.length) { U.replace(smSel); U.replace(smLadder, UI.empty('No stop orders on the exchange right now.')); U.replace(smTable); return; }
        const cur = markets.find((x) => x.pid === smMarket) || markets[0]; smMarket = cur.pid;
        U.replace(smSel, UI.seg(markets.map((x) => ({ v: x.pid, label: x.p.displayTicker })), smMarket, (v) => { smMarket = v; renderStopMap(); }, 'sm'));
        const ls = byMarket[cur.pid]; const m = cur.mark; const tick = cur.p.tickSize;
        const dense = new Set(ls.map((l) => l.price)).size > 40;
        const bin = dense && m > 0 ? m * 0.0025 : 0;
        const level = (pr) => (bin ? Math.round(pr / bin) * bin : pr);
        const rows = {};
        for (const l of ls) { const k = level(l.price) + '|' + l.kind; const r = rows[k] || (rows[k] = { price: level(l.price), kind: l.kind, usd: 0, qty: 0, items: [] }); r.usd += l.usd; r.qty += l.qty; r.items.push(l); }
        const list = Object.values(rows).sort((a, b) => b.price - a.price);
        const maxUsd = Math.max(1, ...list.map((r) => r.usd));
        const rowEl = (r) => {
          const cls = r.kind === 'TP' ? 'tp' : r.kind === 'SL' ? 'sl' : 'en';
          const dist = m > 0 ? ((r.price - m) / m) * 100 : null;
          const accts = new Set(r.items.map((i) => i.sid)).size;
          const detail = h('div.smap-detail', { style: { display: 'none' } }, r.items.map((i) => h('div.row.small',
            h('a.addr', { href: U.accountUrl(i.account, i.sid) }, U.shortAddr(i.account)),
            h('span.dim', (i.kind === 'ENTRY' ? 'opens ' + i.posSide : 'closes ' + i.posSide) + ' · ' + (i.mech === 'limit' ? 'reduce-only limit' : 'stop' + (i.trigger === 'last' ? ' (last px)' : '')) + (i.oco ? ' · OCO' : '')),
            h('span.grow'), h('span.num', U.fmtQty(i.qty, cur.p.lotSize) + ' · ' + U.fmtUsd(i.usd, { compact: true })))));
          const el = h('div.lvl', { class: cls, onclick: () => { detail.style.display = detail.style.display === 'none' ? '' : 'none'; } },
            h('i', { style: { width: (r.usd / maxUsd) * 100 + '%' } }),
            h('span', (bin ? '≈' : '') + U.fmtPrice(r.price, tick)),
            h('span', { class: dist == null ? '' : dist > 0 ? 'pos' : 'neg' }, dist == null ? '' : U.fmtPct(dist, { sign: true, dp: 1 })),
            h('span', UI.chip(r.kind === 'ENTRY' ? 'entry' : r.kind, r.kind === 'TP' ? 'green' : r.kind === 'SL' ? 'red' : 'blue')),
            h('span.num', U.fmtUsd(r.usd, { compact: true })),
            h('span.dim', accts + (accts === 1 ? ' acct' : ' accts')));
          return [el, detail];
        };
        U.replace(smLadder,
          h('div.hdr', h('span', 'Price'), h('span', 'vs mark'), h('span', 'Type'), h('span', 'Notional'), h('span', 'Accounts')),
          list.filter((r) => r.price > m).map(rowEl),
          h('div.mid', h('span.bold', 'mark ' + U.fmtPrice(m, tick)), h('span.dim.xs', '  ' + cur.p.displayTicker)),
          list.filter((r) => r.price <= m).map(rowEl),
          dense ? h('div.xs.dim.center', { style: { padding: '6px' } }, 'levels binned to 0.25% of mark') : null);
        const nearCell = (l, r) => (l ? h('span', U.fmtPrice(l.price, r.p.tickSize), h('span.xs.dim', ' ' + U.fmtPct(((l.price - r.mark) / r.mark) * 100, { sign: true, dp: 1 }))) : h('span.dim', '—'));
        U.replace(smTable, UI.table({
          cols: [
            { key: 'm', label: 'Market', render: (r) => UI.marketCell(r.p.displayTicker) },
            { key: 'n', label: 'TP / SL / entry', num: true, render: (r) => h('span', h('span.pos', String(r.tp.length)), h('span.dim', ' / '), h('span.neg', String(r.sl.length)), h('span.dim', ' / '), String(r.en.length)) },
            { key: 'tpu', label: 'TP notional', num: true, render: (r) => U.fmtUsd(U.sum(r.tp, (l) => l.usd), { compact: true }) },
            { key: 'slu', label: 'SL notional', num: true, render: (r) => U.fmtUsd(U.sum(r.sl, (l) => l.usd), { compact: true }) },
            { key: 'nsl', label: 'Nearest SL', num: true, title: 'Stop-loss closest to the mark price', render: (r) => nearCell(r.nearSl, r) },
            { key: 'ntp', label: 'Nearest TP', num: true, title: 'Take-profit closest to the mark price', render: (r) => nearCell(r.nearTp, r) },
            { key: 'a', label: 'Accounts', num: true, render: (r) => String(r.accounts) },
          ], rows: markets, onRow: (r) => { smMarket = r.pid; renderStopMap(); }, rowClass: (r) => (r.pid === smMarket ? 'sel' : ''),
        }));
      }
      scanStops();
      const smT = setInterval(scanStops, 120000); ctx.onCleanup(() => clearInterval(smT));

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
      const tradeRow = (t, flash) => {
        const link = (which, label) => { const sid = t[which]; return sid || t[which + 'Order'] ? h('a', { href: sid ? U.accountUrl('', sid) : '#', title: sid || 'resolving…', onclick: (e) => { e.preventDefault(); e.stopPropagation(); openAccount(t, which); } }, label) : h('span.dim', label); };
        const clickable = !!(t.taker || t.takerOrder);
        return h('div.it', { class: (flash ? 'flash ' : '') + (clickable ? 'click' : ''), title: clickable ? 'Open the account that took this trade' : undefined, onclick: clickable ? () => openAccount(t, 'taker') : undefined },
          h('span.t', U.fmtFeedTime(t.t)), h('span.m', t.ticker), U.sideEl(t.side), h('span.num', U.fmtQty(t.size, t.lot) + ' @ ' + U.fmtPrice(t.price, t.tick)), h('span.grow'), h('span.num.dim', U.fmtUsd(U.num(t.size) * U.num(t.price))),
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
            ], rows, empty: 'No liquidations recorded',
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
          ], rows: upcoming, empty: 'No closures scheduled',
        }));
      }
      renderGaps();
    },
  };
})();
