/* MeridianData — Exchange dashboard: markets, live trades, liquidations, closures */
(function () {
  const MD = window.MD; const U = MD.util; const A = MD.api; const UI = MD.ui; const C = MD.charts; const h = U.h;

  MD.router.pages.dashboard = {
    async mount(root, route, ctx) {
      MD.setTopbar(h('span.title', 'Dashboard'));
      const tiles = h('div.stats');
      const mktBody = h('div', UI.loading('Loading markets…'));
      const tradesBody = h('div.feed', UI.loading('Loading trades…'));
      const liqBody = h('div', UI.loading('Loading…'));
      const gapBody = h('div', UI.loading('Loading…'));
      const fundBody = h('div');
      const status = h('span.status-dot'); const statusTxt = h('span.dim.small');
      U.replace(root, h('div.page', h('div.stack', tiles,
        h('div.card.tight', h('div.card-head', h('h2', 'Markets'), status, statusTxt, h('span.grow'), h('span.dim.small', 'prices via WebSocket · sparkline = 7d oracle price')), mktBody),
        h('div.grid.cols-2',
          h('div.card.tight', h('div.card-head', h('h2', 'Live trades'), h('span.dim.small', 'all markets · click a side to open the account')), tradesBody),
          h('div.stack', h('div.card.tight', h('div.card-head', h('h2', 'Liquidations'), h('span.dim.small', 'latest 20')), liqBody), h('div.card.tight', h('div.card-head', h('h2', 'Market closures (mPerps)'), h('span.dim.small', 'next 7 days')), gapBody))),
        h('div.card.tight', h('div.card-head', h('h2', 'Funding'), h('span.dim.small', 'current 1h rate · projected · annualized')), fundBody))));

      const ref = await A.ref(ctx);
      const ids = ref.active.map((p) => p.id);
      const [prices, projected, subs, points] = await Promise.all([A.marketPrices(ids, ctx), A.projectedFunding(ids, ctx).catch(() => ({})), A.allSubaccounts(ctx).catch(() => null), A.pointsTotal(ctx).catch(() => null)]);
      const live = {}; // ticker -> ticker ws data
      const now = Date.now();
      let gaps = [];
      try { gaps = await A.gaps(ids, now, now + 7 * U.DAY, ctx); } catch (_) {}
      const gapsBy = U.groupBy(gaps, (g) => g.productId);
      const closureNote = (p) => {
        const list = (gapsBy[p.id] || []).filter((g) => g.endTime > now).sort((a, b) => a.startTime - b.startTime);
        if (!list.length) return null;
        const g = list[0];
        if (g.startTime <= now) return h('span.closure', 'closed · reopens in ' + U.fmtCountdown(g.endTime - now));
        return h('span.closure', { style: { color: 'var(--text-3)' } }, 'closes in ' + U.fmtCountdown(g.startTime - now));
      };

      function renderTiles() {
        let vol = 0, oi = 0;
        for (const p of ref.active) { const o = mark(p); vol += U.num(p.volume24h) * o; oi += U.num(p.openInterest) * o; }
        U.replace(tiles, UI.stat('Active markets', String(ref.active.length), ref.products.length - ref.active.length ? (ref.products.length - ref.active.length) + ' pending/delisted' : null), UI.stat('24h volume', U.fmtUsd(vol, { compact: true })), UI.stat('Open interest', U.fmtUsd(oi, { compact: true })), UI.stat('Accounts', subs ? String(subs.length) : '—', subs && subs.length ? 'newest ' + U.fmtAgo(Math.max(...subs.map((s) => s.createdAt))) : null), UI.stat('Points distributed', points ? U.fmtCompact(points.totalPoints) : '—', points ? 'updated ' + U.fmtAgo(points.updatedAt) : null));
      }
      const mark = (p) => { const l = live[p.ticker]; if (l && U.num(l.markPx)) return U.num(l.markPx); const px = prices[p.id]; return px ? U.num(px.oraclePrice) : 0; };
      const sparks = {};
      function renderMarkets() {
        const rows = ref.active.map((p) => {
          const l = live[p.ticker] || {}; const px = prices[p.id] || {};
          const m = mark(p); const p24 = U.num(l.markPx24h || px.price24hAgo);
          const bid = U.num(l.bidPx || px.bestBidPrice), ask = U.num(l.askPx || px.bestAskPrice);
          const oiN = U.num(l.oi || p.openInterest); const volN = U.num(l.vol24h || p.volume24h);
          const fr = U.num(l.fr1h || p.fundingRate1h); const proj = projected[p.id] ? U.num(projected[p.id].fundingRateProjected1h) : null;
          return { p, m, chg: p24 ? ((m - p24) / p24) * 100 : null, bid, ask, spread: bid && ask ? ((ask - bid) / ((ask + bid) / 2)) * 100 : null, oiUsd: oiN * m, volUsd: volN * m, fr, proj };
        });
        U.replace(mktBody, UI.table({
          cols: [
            { key: 'm', label: 'Market', render: (r) => UI.marketCell(r.p.displayTicker, (r.p.marginMode === 'CROSS' ? 'cross' : 'isolated') + ' · ' + r.p.maxLeverage + '× · fee ' + U.fmtPct(U.num(r.p.takerFee) * 100, { dp: 2 })) },
            { key: 'px', label: 'Mark price', num: true, render: (r) => U.fmtPrice(r.m, r.p.tickSize) },
            { key: 'chg', label: '24h', num: true, render: (r) => UI.pct(r.chg, { dp: 2 }) },
            { key: 'ba', label: 'Bid / Ask', num: true, render: (r) => h('span', h('span.pos', r.bid ? U.fmtPrice(r.bid, r.p.tickSize) : '—'), h('span.dim', ' / '), h('span.neg', r.ask ? U.fmtPrice(r.ask, r.p.tickSize) : '—'), r.spread != null ? h('span.xs.dim', ' ' + U.fmtPct(r.spread, { dp: 3 })) : null) },
            { key: 'fr', label: 'Funding 1h', num: true, title: 'positive = longs pay', render: (r) => h('span', { class: r.fr > 0 ? 'pos' : r.fr < 0 ? 'neg' : '' }, U.fmtPct(r.fr * 100, { dp: 4, sign: true })) },
            { key: 'oi', label: 'Open interest', num: true, render: (r) => U.fmtUsd(r.oiUsd, { compact: true }) },
            { key: 'vol', label: '24h volume', num: true, render: (r) => U.fmtUsd(r.volUsd, { compact: true }) },
            { key: 'spark', label: '7d', render: (r) => { const c = sparks[r.p.ticker] || (sparks[r.p.ticker] = h('canvas.spark', { width: 110, height: 30 })); return c; } },
            { key: 'note', label: 'Status', render: (r) => closureNote(r.p) || h('span.xs.dim', r.p.marginMode === 'CROSS' ? '24/7' : 'open') },
          ], rows,
        }));
        U.replace(fundBody, UI.table({
          cols: [
            { key: 'm', label: 'Market', render: (r) => r.p.displayTicker },
            { key: 'fr', label: 'Current 1h', num: true, render: (r) => h('span', { class: U.pnlClass(r.fr) }, U.fmtPct(r.fr * 100, { dp: 4, sign: true })) },
            { key: 'proj', label: 'Projected 1h', num: true, render: (r) => (r.proj == null ? '—' : h('span', { class: U.pnlClass(r.proj) }, U.fmtPct(r.proj * 100, { dp: 4, sign: true }))) },
            { key: 'apr', label: 'Annualized', num: true, render: (r) => U.fmtPct(r.fr * 24 * 365 * 100, { dp: 1, sign: true }) },
            { key: 'base', label: 'Baseline / clamp / max APR', num: true, render: (r) => h('span.dim', U.fmtPct(U.num(r.p.fundingBaselineApr) * 100, { dp: 0 }) + ' / ' + U.fmtPct(U.num(r.p.fundingClampApr) * 100, { dp: 0 }) + ' / ' + U.fmtPct(U.num(r.p.fundingMaxApr) * 100, { dp: 0 })) },
            { key: 'cum', label: 'Cumulative funding', num: true, render: (r) => U.fmtUsd(r.p.cumulativeFundingUsd) },
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

      // ---- live trades ----
      let trades = [];
      const tradeRow = (t, flash) => {
        const link = (sid, label) => (sid ? h('a', { href: U.accountUrl('', sid), title: sid, onclick: (e) => { e.stopPropagation(); } }, label) : h('span.dim', label));
        return h('div.it', { class: flash ? 'flash' : '' }, h('span.t', U.fmtTime(t.t)), h('span.m', t.ticker), U.sideEl(t.side), h('span.num', U.fmtQty(t.size) + ' @ ' + U.fmtPrice(t.price, t.tick)), h('span.grow'), h('span.num.dim', U.fmtUsd(U.num(t.size) * U.num(t.price))), t.taker || t.maker ? h('span.xs', link(t.taker, 'taker'), h('span.dim', ' · '), link(t.maker, 'maker')) : h('span.xs.dim', 'history'));
      };
      const renderTrades = () => U.replace(tradesBody, trades.length ? trades.slice(0, 40).map((t, i) => tradeRow(t, t._new && i < 5)) : UI.empty('No trades yet'));
      (async () => {
        const seed = await Promise.all(ref.active.map((p) => A.trades(p.id, 15, ctx).then((rows) => rows.map((r) => ({ id: r.id, t: r.createdAt, ticker: p.displayTicker, tick: p.tickSize, side: r.takerSide, size: r.filled, price: r.price }))).catch(() => [])));
        trades = U.sortBy(seed.flat(), (t) => t.t, true);
        renderTrades();
      })();
      for (const p of ref.active) {
        ctx.onCleanup(A.ws.subscribe('TradeFill', p.ticker, (m) => {
          const d = m.data || {};
          for (const it of d.d || []) trades.unshift({ id: it.id, t: d.t || m.t, ticker: p.displayTicker, tick: p.tickSize, side: it.sd, size: it.sz, price: it.px, taker: it.sids && it.sids[0], maker: it.sids && it.sids[1], _new: true });
          trades = trades.slice(0, 200); renderTrades();
        }));
        ctx.onCleanup(A.ws.subscribe('Ticker', p.ticker, (m) => { live[p.ticker] = m.data; renderMarketsThrottled(); }));
      }
      ctx.onCleanup(A.ws.onStatus((s) => { status.className = 'status-dot ' + (s === 'open' ? 'ok' : s === 'connecting' ? 'warn' : 'bad'); statusTxt.textContent = s === 'open' ? 'live' : s; }));

      // ---- liquidations ----
      async function loadLiq() {
        try {
          const rows = await A.liquidations(20, ctx);
          U.replace(liqBody, UI.table({
            cols: [
              { key: 't', label: 'Time', render: (r) => h('span.dim', U.fmtDateTimeS(r.createdAt)) },
              { key: 'acct', label: 'Account', render: (r) => h('a.addr', { href: U.accountUrl('', r.subaccountId) }, U.shortAddr(r.subaccountId, 4)) },
              { key: 'm', label: 'Market', render: (r) => (ref.byId[r.productId] ? ref.byId[r.productId].displayTicker : '—') },
              { key: 'side', label: 'Side', render: (r) => U.sideEl(r.positionSide, true) },
              { key: 'cost', label: 'Cost', num: true, render: (r) => U.fmtUsd(r.cost) },
              { key: 'px', label: 'Liq. price', num: true, render: (r) => U.fmtPrice(r.liquidationPrice, ref.byId[r.productId] && ref.byId[r.productId].tickSize) },
              { key: 'cause', label: 'Cause', render: (r) => UI.chip(r.cause || '—', 'red') },
            ], rows, empty: 'No liquidations recorded',
          }));
        } catch (e) { if (e.name !== 'AbortError') U.replace(liqBody, UI.error(e)); }
      }
      loadLiq();
      const liqT = setInterval(loadLiq, 30000); ctx.onCleanup(() => clearInterval(liqT));

      // ---- closures ----
      const upcoming = gaps.filter((g) => g.endTime > now).sort((a, b) => a.startTime - b.startTime).slice(0, 12);
      U.replace(gapBody, UI.table({
        cols: [
          { key: 'm', label: 'Market', render: (g) => (ref.byId[g.productId] ? ref.byId[g.productId].displayTicker : '—') },
          { key: 's', label: 'Closes', render: (g) => h('span', { class: g.startTime <= now ? 'neg' : '' }, g.startTime <= now ? 'now' : U.fmtDateTime(g.startTime)) },
          { key: 'e', label: 'Reopens', render: (g) => U.fmtDateTime(g.endTime) },
          { key: 'd', label: 'Duration', num: true, render: (g) => U.fmtDuration(g.endTime - g.startTime) },
        ], rows: upcoming, empty: 'No closures scheduled',
      }));
    },
  };
})();
