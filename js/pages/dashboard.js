/* MeridianDataHub — Exchange dashboard: markets, stop map, live trades, liquidations, closures */
(function () {
  const MD = window.MD; const U = MD.util; const A = MD.api; const AN = MD.analytics; const UI = MD.ui; const C = MD.charts; const h = U.h;
  const isAbort = (e) => e && e.name === 'AbortError';

  MD.router.pages.dashboard = {
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
        U.replaceLive(tiles, UI.stat('Active markets', String(ref.active.length), ref.products.length - ref.active.length ? (ref.products.length - ref.active.length) + ' pending/delisted' : null), UI.stat('24h volume', U.fmtUsd(vol, { compact: true })), UI.stat('Open interest', U.fmtUsd(oi, { compact: true })), UI.stat('Accounts', subs ? String(subs.length) : '—', subs && subs.length ? 'newest ' + U.fmtAgo(Math.max(...subs.map((s) => s.createdAt))) : null), UI.stat('Points distributed', points ? U.fmtCompact(points.totalPoints) : '—', points ? 'updated ' + U.fmtAgo(points.updatedAt) : null));
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
        U.replaceLive(mktBody, UI.table({
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
        U.replaceLive(fundBody, UI.table({
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

      // ---- stop map: TP / SL / entry stop levels of every account, per market ----
      let sm = null, smMarket = null, smScanning = false;
      async function scanStops() {
        if (smScanning) return; smScanning = true; smRescan.disabled = true;
        U.replace(smSummary, h('span.loading', h('span.spinner'), 'Scanning accounts…'));
        try {
          const LB = MD.router.pages.leaderboard; if (LB) await LB.loadRemote();
          const snap = LB && LB.cache(); const known = {}; if (snap && snap.rows) for (const r of snap.rows) known[r.sid] = r;
          const accounts = subs || (await A.allSubaccounts(ctx));
          const levels = []; let scanned = 0;
          const tasks = accounts.map((sa) => async () => {
            const k = known[sa.id];
            if (k && k.inactive) return;                       // never funded / traded → nothing to find
            const o = { signal: ctx.signal };
            const pending = await A.pendingOrders(sa.id, o).catch(() => []);
            let positions = [], working = [];
            if (!k || k.openCount > 0 || pending.length) [positions, working] = await Promise.all([A.openPositions(sa.id, o).catch(() => []), A.openOrders(sa.id, o).catch(() => [])]);
            scanned++;
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
          sm = { at: Date.now(), scanned, total: accounts.length, levels };
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
        U.replace(smSummary, `${L.length} levels · ${U.fmtUsd(U.sum(L, (l) => l.usd), { compact: true })} · ${new Set(L.map((l) => l.sid)).size} accounts · scanned ${sm.scanned}/${sm.total} · ${U.fmtAgo(sm.at)}`);
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
            h('span.grow'), h('span.num', U.fmtQty(i.qty) + ' · ' + U.fmtUsd(i.usd, { compact: true })))));
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
          h('span.t', U.fmtFeedTime(t.t)), h('span.m', t.ticker), U.sideEl(t.side), h('span.num', U.fmtQty(t.size) + ' @ ' + U.fmtPrice(t.price, t.tick)), h('span.grow'), h('span.num.dim', U.fmtUsd(U.num(t.size) * U.num(t.price))),
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
        const seed = await Promise.all(ref.active.map((p) => A.trades(p.id, 15, ctx).then((rows) => rows.map((r) => ({ id: r.id, t: r.createdAt, ticker: p.displayTicker, tick: p.tickSize, side: r.takerSide, size: r.filled, price: r.price, takerOrder: r.takerOrderId || null, makerOrder: r.makerOrderId || null }))).catch(() => [])));
        trades = U.sortBy(seed.flat(), (t) => t.t, true);
        renderTrades();
        resolveVisible();
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
