/* MeridianDataHub — Copy simulator page (#/copytrade/sim): replay a leader's positions as a follower with a chosen size,
   delay and slippage, against the real fills, one-minute oracle candles and today's books. */
(function () {
  const MD = window.MD; const U = MD.util; const A = MD.api; const AN = MD.analytics; const UI = MD.ui; const C = MD.charts; const S = MD.copysim; const h = U.h;
  const isAbort = (e) => e && e.name === 'AbortError';
  const DELAYS = [0, 5, 15, 30, 60, 120];
  const PAGE = 25;
  const isoDate = (ms) => new Date(U.num(ms)).toISOString().slice(0, 10);
  const usd0 = (v, o) => U.fmtUsd(v, Object.assign({ dp: 0 }, o));
  const bpsEl = (v) => (v == null ? h('span.dim', '—') : h('span.dim.xs', ' ' + (v > 0 ? '+' : '') + U.fmtNum(v, 0) + ' bps'));

  MD.copysimPage = {
    async mount(root, route, ctx) {
      MD.setTopbar(h('span.title', 'Copy trading · Simulator'));
      const addr = String(route.params.address || '').toLowerCase();
      let sid = route.params.sub || null;
      const st = {
        since: route.params.since || null,
        mode: ['ratio', 'perfill'].includes(route.params.mode) ? route.params.mode : 'fixed',
        size: Math.max(10, U.num(route.params.size) || AN.COPY_SIZE),
        ratio: Math.max(0.1, U.num(route.params.ratio) || 10),
        delay: route.params.delay != null && DELAYS.includes(U.num(route.params.delay)) ? U.num(route.params.delay) : 30,
        slip: route.params.slip === 'auto' || route.params.slip == null ? 'auto' : U.num(route.params.slip),
        markets: route.params.markets ? new Set(route.params.markets.split(',')) : null,
      };
      const body = h('div.stack');
      U.replace(root, h('div.page', h('div.stack', h('div.row.wrap', { style: { gap: '8px' } }, h('a.btn.sm.ghost', { href: '#/copytrade' }, '← Leaders'), h('span.dim.small', 'Copy simulator · nothing here places orders')), body)));
      if (!U.isAddress(addr)) { U.replace(body, h('div.card', h('div.empty', 'Pick a leader on the ', h('a', { href: '#/copytrade' }, 'Leaders'), ' page and press Simulate.'))); return; }

      // ---- resolve the leader
      let sa = null;
      try {
        const subs = await A.subaccountsOf(addr, ctx);
        sa = subs.find((s) => s.id === sid) || subs[0] || null;
      } catch (e) { if (isAbort(e)) return; U.replace(body, UI.error(e, () => MD.router.dispatch())); return; }
      if (!sa) { U.replace(body, h('div.card', h('div.empty', 'This wallet has no Meridian perps subaccount.'))); return; }
      sid = sa.id;
      const LB = MD.router.pages.leaderboard; let lbRow = null;
      try { const snap = LB && (await LB.loadRemote()); lbRow = snap && snap.rows ? snap.rows.find((r) => r.sid === sid) : null; } catch (_) {}
      const sc = lbRow ? AN.copyScore(lbRow) : null;

      const head = h('div.card', h('div.row.wrap', { style: { gap: '10px' } },
        UI.starBtn({ address: sa.account, subaccountId: sid, name: U.decodeBytes32(sa.name) }), MD.bellBtn({ sid, address: sa.account, name: U.decodeBytes32(sa.name) }), h('h2', U.shortAddr(sa.account, 6)), U.copyBtn(sa.account),
        sc ? h('span.chip', { class: { 'Copyable': 'green', 'Copy with care': 'amber' }[sc.verdict] || 'red' }, `copyability ${sc.total} · ${sc.verdict}`) : null,
        h('span.grow'), h('a.btn.sm', { href: U.accountUrl(sa.account, sid) }, 'Account page')),
        h('p.muted', { style: { margin: '8px 0 0', maxWidth: '900px' } }, 'What a follower would have kept copying this account: every position it opened since the start date is replayed with your size, entered and exited a set number of seconds after each of its fills at the oracle price of that moment, at taker fees, with slippage for your size against today\'s order books. Funding and mPerp position fees follow the leader\'s, scaled to your size.'));
      const status = h('div.card', UI.loading('Loading fills, positions and books…'));
      U.replace(body, head, status);

      let data;
      try { data = await S.load(sid, { signal: ctx.signal }); }
      catch (e) { if (isAbort(e)) return; U.replace(status, UI.error(e, () => MD.router.dispatch())); return; }
      const { ref, episodes, depth, marks, candles } = data;
      if (!episodes.length) { U.replace(status, h('div.card', h('div.empty', 'No fills on record for this subaccount, so there is nothing to replay.'))); return; }
      const firstT = episodes[0].start;
      if (!st.since) st.since = isoDate(Math.max(firstT, Date.now() - 90 * U.DAY));
      const traded = Array.from(new Set(episodes.map((e) => e.pid))).map((pid) => ref.byId[pid]).filter(Boolean);

      // ---- settings
      const sinceIn = h('input.input.sm', { type: 'date', value: st.since, min: isoDate(firstT), max: isoDate(Date.now()), style: { width: 'auto' } });
      const sizeIn = h('input.input.sm', { type: 'number', min: 10, step: 100, value: st.size, style: { width: '110px' } });
      const ratioIn = h('input.input.sm', { type: 'number', min: 0.1, step: 1, value: st.ratio, style: { width: '90px' } });
      const modeSeg = UI.seg([{ v: 'fixed', label: 'Fixed $ per position', title: 'the leader\'s opening order becomes this much; adds and reductions follow in proportion' }, { v: 'perfill', label: 'Fixed $ per fill', title: 'every entry fill becomes this much; reductions cut the same share' }, { v: 'ratio', label: '% of the leader\'s size' }], st.mode, (v) => { st.mode = v; sizeIn.style.display = v === 'ratio' ? 'none' : ''; ratioIn.parentElement.style.display = v === 'ratio' ? '' : 'none'; }, 'sm');
      const ratioWrap = h('span.row', { style: { gap: '4px', display: st.mode === 'ratio' ? '' : 'none' } }, ratioIn, h('span.dim.small', '%'));
      sizeIn.style.display = st.mode === 'ratio' ? 'none' : '';
      const delaySeg = UI.seg(DELAYS.map((d) => ({ v: d, label: d ? d + ' s' : 'instant' })), st.delay, (v) => { st.delay = v; }, 'sm');
      const slipIn = h('input.input.sm', { type: 'number', min: 0, step: 0.5, placeholder: 'auto', value: st.slip === 'auto' ? '' : st.slip, style: { width: '80px' }, title: 'Leave empty to take today\'s books at your size' });
      const mkWrap = h('div.row.wrap', { style: { gap: '4px' } });
      const renderMarkets = () => U.replace(mkWrap, traded.map((p) => { const on = !st.markets || st.markets.has(p.id); return h('button.chip', { class: on ? 'green' : '', style: { cursor: 'pointer' }, onclick: () => { if (!st.markets) st.markets = new Set(traded.map((x) => x.id)); if (st.markets.has(p.id)) st.markets.delete(p.id); else st.markets.add(p.id); if (st.markets.size === traded.length) st.markets = null; renderMarkets(); } }, p.displayTicker); }));
      renderMarkets();
      const runBtn = h('button.btn.primary.sm', { onclick: () => run() }, 'Run');
      const settings = h('div.card.no-print', h('div.stack', { style: { gap: '10px' } },
        h('div.row.wrap', { style: { gap: '10px', rowGap: '10px' } }, h('span.dim.small', 'Copy since'), sinceIn, h('span.dim.small', 'Size'), modeSeg, sizeIn, ratioWrap, h('span.dim.small', 'Delay'), delaySeg),
        h('div.row.wrap', { style: { gap: '10px', rowGap: '10px' } }, h('span.dim.small', 'Slippage'), slipIn, h('span.dim.small', 'bps each way (empty = from today\'s books at your size)'), h('span.dim.small', { style: { marginLeft: '8px' } }, 'Markets'), mkWrap, h('span.grow'), runBtn)));
      const results = h('div.stack');
      U.replace(body, head, settings, results);

      async function run() {
        runBtn.disabled = true;
        st.since = sinceIn.value || st.since; st.size = Math.max(10, U.num(sizeIn.value) || AN.COPY_SIZE); st.ratio = Math.max(0.1, U.num(ratioIn.value) || 10);
        st.slip = slipIn.value === '' ? 'auto' : Math.max(0, U.num(slipIn.value));
        MD.router.setParams({ address: addr, sub: sid, since: st.since, mode: st.mode !== 'fixed' ? st.mode : null, size: st.mode !== 'ratio' && st.size !== AN.COPY_SIZE ? st.size : null, ratio: st.mode === 'ratio' ? st.ratio : null, delay: st.delay !== 30 ? st.delay : null, slip: st.slip === 'auto' ? null : st.slip, markets: st.markets ? Array.from(st.markets).join(',') : null }, { silent: true });
        U.replace(results, h('div.card', UI.loading('Replaying fills against one-minute candles…')));
        try {
          const since = Date.parse(st.since + 'T00:00:00Z');
          const copyNotional = st.mode !== 'ratio' ? st.size : null;
          const slipAuto = S.slippageFor(depth, ref, copyNotional || AN.COPY_SIZE);
          const feeRate = {}; for (const p of ref.active) feeRate[p.id] = U.num(p.takerFee) || 0.0003;
          const base = { mode: st.mode, size: st.size, ratio: st.ratio / 100, slipBps: st.slip === 'auto' ? slipAuto : st.slip, feeRate, priceAt: S.priceAtFactory(candles, ref), markets: st.markets };
          const runs = {};
          for (const d of DELAYS) runs[d] = await S.replay({ episodes, settings: Object.assign({}, base, { delaySec: d }), marks, since, ref });
          if (ctx.signal.aborted) return;
          renderResults(runs, base, slipAuto, base.priceAt.stats);
        } catch (e) { if (!isAbort(e)) U.replace(results, UI.error(e, () => run())); }
        runBtn.disabled = false;
      }

      function renderResults(runs, base, slipAuto, candleStats) {
        const R = runs[st.delay]; const T = R.T; const R0 = runs[0].T;
        if (!R.rows.length) { U.replace(results, h('div.card', h('div.empty', 'No positions opened since ' + st.since + (st.markets ? ' in the chosen markets' : '') + '. Move the start date back.'))); return; }
        const sizeLabel = st.mode === 'fixed' ? usd0(st.size) + ' per position (the opening order)' : st.mode === 'perfill' ? usd0(st.size) + ' per entry fill' : U.fmtNum(st.ratio, 1) + '% of the leader\'s size';
        const perPos = T.n ? T.copierNet / T.n : 0, perPosL = T.n ? T.leaderNet / T.n : 0;
        const avgEntry = T.n ? U.sum(R.rows, (r) => r.C.entryNotional) / T.n : 0, avgEntryL = T.n ? U.sum(R.rows, (r) => r.L.entryNotional) / T.n : 0;
        const tiles = h('div.stats',
          UI.stat('Copier net', usd0(T.copierNet, { sign: true }), `${sizeLabel} · ${st.delay ? st.delay + ' s' : 'instant'} delay` + (T.edgeKept != null ? ` · ${U.fmtPct(T.edgeKept, { dp: 0 })} of the leader's result` : ''), U.pnlClass(T.copierNet)),
          UI.stat('Leader net', usd0(T.leaderNet, { sign: true }), 'same positions, their fills, fees and funding', U.pnlClass(T.leaderNet)),
          UI.stat('Per position', (perPos > 0 ? '+' : '') + U.fmtNum(avgEntry ? (perPos / avgEntry) * 1e4 : 0, 0) + ' bps', `${usd0(perPos, { sign: true })} on ${usd0(avgEntry)} average entry` + (st.mode === 'fixed' && avgEntry > st.size * 1.3 ? ' (the leader adds to positions)' : '') + ` · leader ${avgEntryL ? (perPosL > 0 ? '+' : '') + U.fmtNum((perPosL / avgEntryL) * 1e4, 0) : '—'} bps`, U.pnlClass(perPos)),
          UI.stat('Positions', String(T.n), `${U.fmtPct(T.winRate || 0, { dp: 0 })} profitable for the copier` + (T.open ? ` · ${T.open} still open (marked)` : '') + (T.liq ? ` · ${T.liq} liquidated` : '')),
          UI.stat('Costs', usd0(T.fees + T.drift + T.slip + T.posFee), `${usd0(T.fees)} fees · ${usd0(T.drift, { sign: true })} drift · ${usd0(T.slip)} slippage` + (T.posFee ? ` · ${usd0(T.posFee)} position fees` : ''), 'neg'),
          UI.stat('Funding', usd0(T.funding, { sign: true }), 'the leader\'s, scaled to your size', U.pnlClass(T.funding)),
          UI.stat('Max drawdown', usd0(T.maxDd), avgEntry ? `${U.fmtNum(T.maxDd / avgEntry, 1)}× an average position · on the copier's cumulative result` : 'on the copier\'s cumulative result', T.maxDd > 0 ? 'neg' : ''),
          UI.stat('If instant', usd0(R0.copierNet, { sign: true }), 'the same copy with zero delay: what latency costs is the gap', U.pnlClass(R0.copierNet)));
        const canvas = h('canvas');
        const col = C.colors();
        const chartCard = h('div.card.chart-fill', h('div.row', { style: { marginBottom: '6px', flex: 'none' } }, h('h3', 'Cumulative result'), h('span.grow'), h('span.dim.small', 'by position close · both at the copier\'s size' + (st.mode === 'fixed' ? '' : ' ratio'))), h('div.chart-box', canvas));
        // delay sensitivity
        const sens = UI.table({ cols: [
          { key: 'd', label: 'Delay', render: (d) => h('span', { class: d === st.delay ? 'bold' : '' }, d ? d + ' s' : 'instant') },
          { key: 'net', label: 'Copier net', num: true, render: (d) => U.pnlEl(runs[d].T.copierNet, { dp: 0 }) },
          { key: 'kept', label: 'Of the leader\'s', num: true, render: (d) => (runs[d].T.edgeKept == null ? h('span.dim', '—') : h('span', { class: 'num ' + (runs[d].T.edgeKept >= 50 ? 'pos' : runs[d].T.edgeKept > 0 ? '' : 'neg') }, U.fmtPct(runs[d].T.edgeKept, { dp: 0 }))) },
          { key: 'drift', label: 'Drift cost', num: true, render: (d) => usd0(runs[d].T.drift, { sign: true }) },
          { key: 'wr', label: 'Profitable', num: true, render: (d) => U.fmtPct(runs[d].T.winRate || 0, { dp: 0 }) },
        ], rows: DELAYS });
        const sensCard = UI.card('Latency sensitivity', sens, h('span.dim.small', 'the same copy, acting later after each fill'));
        // per-position table
        const wrap = h('div'); let page = 1;
        const renderTbl = () => {
          const rows = R.rows.slice().reverse(); const slice = rows.slice((page - 1) * PAGE, page * PAGE);
          U.replace(wrap, UI.table({ cols: [
            { key: 't', label: 'Opened (UTC)', render: (r) => h('span.dim', new Date(r.t0).toISOString().replace('T', ' ').slice(0, 16)) },
            { key: 'm', label: 'Market', render: (r) => UI.marketCell(r.ticker) },
            { key: 's', label: 'Side', render: (r) => U.sideEl(r.long, true) },
            { key: 'h', label: 'Held', num: true, render: (r) => h('span', U.fmtDuration(r.hold), r.open ? UI.chip('open', 'blue') : r.liq ? UI.chip('LIQ', 'red') : null) },
            { key: 'ls', label: 'Leader size', num: true, render: (r) => usd0(r.L.entryNotional) },
            { key: 'ln', label: 'Leader net', num: true, render: (r) => h('span', U.pnlEl(r.L.net, { dp: 2 }), bpsEl(r.leaderBps)) },
            { key: 'cs', label: 'Copier size', num: true, render: (r) => usd0(r.C.entryNotional) },
            { key: 'cn', label: 'Copier net', num: true, render: (r) => h('span', U.pnlEl(r.C.net, { dp: 2 }), bpsEl(r.copierBps)) },
            { key: 'dr', label: 'Drift', num: true, title: 'what the price move between the leader\'s fills and the copier\'s cost', render: (r) => (Math.abs(r.C.driftCost) < 0.005 ? h('span.dim', '—') : h('span', { class: r.C.driftCost > 0 ? 'neg' : 'pos' }, U.fmtUsd(-r.C.driftCost, { sign: true, dp: 2 }))) },
            { key: 'sl', label: 'Slippage', num: true, render: (r) => (r.C.slipCost ? U.fmtUsd(r.C.slipCost, { dp: 2 }) : h('span.dim', '—')) },
            { key: 'fe', label: 'Fees', num: true, render: (r) => U.fmtUsd(r.C.fees, { dp: 2 }) },
            { key: 'fu', label: 'Funding', num: true, render: (r) => (Math.abs(r.C.funding) < 0.005 ? h('span.dim', '—') : U.pnlEl(r.C.funding, { dp: 2 })) },
          ], rows: slice }), rows.length > PAGE ? UI.pager({ page, pageSize: PAGE, total: rows.length, onPage: (p) => { page = p; renderTbl(); } }) : null);
        };
        renderTbl();
        const slipNote = st.slip === 'auto' ? 'Slippage from today\'s books at ' + usd0(base.mode === 'fixed' ? st.size : AN.COPY_SIZE) + ': ' + traded.map((p) => `${p.displayTicker} ${U.fmtNum(slipAuto[p.id] == null ? 0 : slipAuto[p.id], 1)} bps`).join(' · ') : `Slippage set to ${U.fmtNum(st.slip, 1)} bps each way.`;
        const notes = h('div.card', h('h3', { style: { marginBottom: '8px' } }, 'What this assumes'), h('div.roadmap',
          h('div.it', h('div.t', 'Prices'), h('div.d', 'Each of the leader\'s fills is copied at the one-minute oracle close ' + (st.delay ? st.delay + ' seconds' : '0 seconds') + ' later (interpolated inside the fill\'s minute), then moved against you by the slippage. The leader\'s own fills are what it actually paid.')),
          h('div.it', h('div.t', 'Fees, funding, position fees'), h('div.d', 'You pay the taker fee of each market on every fill. Funding and mPerp position fees are the leader\'s for the same position, scaled to your size: you would hold it over the same hours.')),
          h('div.it', h('div.t', 'Sizing'), h('div.d', st.mode === 'fixed' ? `The leader's opening order (all of its fills, not just the first piece) becomes ${usd0(st.size)} for you; later adds and reductions follow the leader in proportion, so a leader who scales in makes your position bigger than ${usd0(st.size)}.` : st.mode === 'perfill' ? `Every entry fill becomes ${usd0(st.size)} for you; a reduction cuts your position by the same share as the leader's.` : `Every fill is ${U.fmtNum(st.ratio, 1)}% of the leader's quantity.`)),
          h('div.it', h('div.t', 'Liquidations and open positions'), h('div.d', 'A position the leader was liquidated out of is closed at the leader\'s exit price; whether you would have been liquidated depends on your own margin. Positions still open are marked at the current oracle price.')),
          h('div.it', h('div.t', 'Books'), h('div.d', slipNote + '. Unfillable sizes count as 60 bps.')),
          h('div.it', h('div.t', 'Not modelled'), h('div.d', 'Your own market impact on top of the leader\'s, rejected or partially filled orders, and the leader trading in more than one subaccount.')),
          (data.truncated || T.partial || T.noFunding || (candleStats && candleStats.noCandle)) ? h('div.it', h('div.t', 'Data limits'), h('div.d',
            (data.truncated ? `The exchange returned the newest ${U.fmtNum(data.fills.length, 0)} fills (back to ${U.fmtDateTime(data.oldestFill)}); older positions are not replayed. ` : '') +
            (T.partial ? `${T.partial} position${T.partial > 1 ? 's' : ''} whose opening lies before that window ${T.partial > 1 ? 'were' : 'was'} left out. ` : '') +
            (T.noFunding ? `${T.noFunding} position${T.noFunding > 1 ? 's have' : ' has'} no position record from the exchange, so ${T.noFunding > 1 ? 'their' : 'its'} funding and liquidation status are unknown (counted as zero). ` : '') +
            (candleStats && candleStats.noCandle ? `${U.fmtNum(candleStats.noCandle, 0)} of ${U.fmtNum(candleStats.fills, 0)} delayed fills had no candle and were priced at the leader's fill (no drift).` : ''))) : null));
        U.replace(results, tiles, h('div.grid.cols-2', chartCard, sensCard), UI.card('Positions', wrap, h('span.dim.small', `${T.n} since ${st.since}, newest first`)), notes);
        C.timeSeries(canvas, { series: [{ points: R.curveL, color: col.blue, label: 'Leader' }, { points: R.curve, color: col.accent, label: 'Copier' }], yFmt: (v) => U.fmtUsd(v, { compact: true }), tipFmt: (v) => U.fmtUsd(v, { dp: 0, sign: true }) });
      }

      // ---- paper copy: the same copier, live, in a virtual account kept in this browser
      const PP = MD.paper;
      const paperCard = h('div.card'); body.appendChild(paperCard);
      let paper = PP.load(sid); const live = {}; let unsubs = []; let fundingTimer = null; let pending = 0;
      const paperSettings = () => { const feeRate = {}; for (const p of ref.active) feeRate[p.id] = U.num(p.takerFee) || 0.0003; return { mode: st.mode, size: st.size, ratio: st.ratio / 100, delay: st.delay, slipBps: st.slip === 'auto' ? S.slippageFor(depth, ref, st.mode !== 'ratio' ? st.size : AN.COPY_SIZE) : st.slip, feeRate }; };
      const detach = () => { for (const u of unsubs) { try { u(); } catch (_) {} } unsubs = []; if (fundingTimer) clearInterval(fundingTimer); fundingTimer = null; };
      ctx.onCleanup(detach);
      const markOf = (pid) => (live[pid] != null ? live[pid] : marks[pid]);
      const marksNow = () => { const m = {}; for (const p of ref.active) { const v = markOf(p.id); if (v) m[p.id] = v; } return m; };
      async function catchUp() {
        // fills that happened while no tab was following: priced from candles, like the simulator
        const fills = await A.page(A.BASE, '/v1/order/fill', { subaccountId: sid, createdAfter: paper.lastSeen - 1000 }, { maxPages: 5, signal: ctx.signal });
        const priceAt = S.priceAtFactory(candles, ref); let n = 0;
        const orderQty = {}; for (const f of fills) orderQty[f.orderId] = (orderQty[f.orderId] || 0) + U.num(f.filled);   // an order's whole size, for fixed-size copies
        for (const f of fills.slice().sort((a, b) => (U.num(a.createdAt) - U.num(b.createdAt)) || (String(a.id) < String(b.id) ? -1 : 1))) {
          if (paper.seen[f.id] || U.num(f.createdAt) < paper.startedAt) continue;
          const prod = ref.byId[f.productId]; if (!prod) continue;
          const px = await priceAt(f.productId, U.num(f.createdAt), U.num(f.price), paper.settings.delay);
          if (PP.apply(paper, { id: f.id, t: U.num(f.createdAt), pid: f.productId, ticker: prod.displayTicker, side: U.sideName(f.side), qty: U.num(f.filled), px: U.num(f.price), orderQty: orderQty[f.orderId] }, { px, live: false, at: U.num(f.createdAt) + paper.settings.delay * 1000 })) n++;
        }
        // a virtual position whose market the leader has left without a fill in the history (a liquidation, an ADL) is closed at the mark
        try {
          const openNow = await A.openPositions(sid, { signal: ctx.signal }); const has = new Set(openNow.map((p) => p.productId));
          for (const pid of Object.keys(paper.open)) if (!has.has(pid)) { const mk = markOf(pid); if (mk) { PP.closeAt(paper, pid, mk, Date.now(), 'the leader is flat here without a fill in the history (liquidation or deleveraging)'); n++; } }
        } catch (e) { if (isAbort(e)) throw e; }
        paper.lastSeen = Date.now(); PP.save(paper); return n;
      }
      function attach() {
        detach();
        for (const p of ref.active) unsubs.push(A.ws.subscribe('Ticker', p.ticker, (m) => { const d = m.data || {}; const prod = ref.byTicker[d.s]; if (prod && U.num(d.markPx)) live[prod.id] = U.num(d.markPx); }));
        unsubs.push(A.ws.subscribe('OrderFill', sid, (m) => {
          const d = m.data || {}; const items = Array.isArray(d.d) ? d.d : [];
          for (const it of items) {
            const prod = ref.byTicker[it.s]; if (!prod || !paper) continue;
            const fill = { id: it.id, t: U.num(it.t || d.t) || Date.now(), pid: prod.id, ticker: prod.displayTicker, side: U.sideName(it.sd), qty: U.num(it.sz), px: U.num(it.px) };
            pending++; renderPaper();
            // the whole order's size, so a fixed-size copy is sized on the order and not on its first piece
            const orderP = paper.settings.mode === 'fixed' && it.oid ? A.order(it.oid, { signal: ctx.signal }).then((o) => U.num(o && o.quantity) || null).catch(() => null) : Promise.resolve(null);
            // act `delay` seconds later at the mark of that moment: the wait is measured on the real tape
            setTimeout(async () => { pending--; if (!paper || ctx.signal.aborted) return; fill.orderQty = await orderP; const px = markOf(prod.id) || fill.px; PP.apply(paper, fill, { px, live: true, at: Date.now() }); paper.lastSeen = Date.now(); PP.save(paper); renderPaper(); }, paper.settings.delay * 1000);
          }
        }));
        fundingTimer = setInterval(() => { if (!paper) return; PP.accrueFunding(paper, ref, marksNow(), 1 / 60); PP.save(paper); renderPaper(); }, 60000);
        const tick = setInterval(() => { if (paper && Object.keys(paper.open).length && !document.hidden) renderPaper(); }, 10000);   // unrealized follows the mark
        unsubs.push(() => clearInterval(tick));
      }
      async function startPaper() {
        paper = PP.start(sid, sa.account, paperSettings()); attach(); renderPaper();
      }
      function renderPaper() {
        if (!paper) {
          U.replace(paperCard, h('div.row', { style: { marginBottom: '8px' } }, h('h2', 'Paper copy'), UI.chip('live', 'blue'), h('span.grow'), h('button.btn.primary.sm', { onclick: startPaper }, 'Start following')),
            h('p.muted', { style: { margin: 0, maxWidth: '900px' } }, 'Follow this account in a virtual account with the settings above. Each of its fills is mirrored ' + (st.delay ? st.delay + ' seconds' : 'immediately') + ' later at the mark price of that moment, so the delay cost is measured on the real tape rather than modelled. The account lives in this browser: it follows while a tab with this page is open, and fills that happen while it is closed are caught up from the exchange\'s fill history at candle prices when you come back.'));
          return;
        }
        const mk = marksNow(); const unreal = PP.unrealized(paper, mk); const T = paper.totals;
        const openRows = Object.values(paper.open);
        const tiles = h('div.stats',
          UI.stat('Realized', usd0(T.realized, { sign: true }), `${paper.closed.length} closed position${paper.closed.length === 1 ? '' : 's'}`, U.pnlClass(T.realized)),
          UI.stat('Unrealized', usd0(unreal, { sign: true }), `${openRows.length} open · at the live mark`, U.pnlClass(unreal)),
          UI.stat('Delay cost', usd0(-(T.driftLive + T.driftModeled), { sign: true }), `${usd0(-T.driftLive, { sign: true })} measured on ${T.liveFills} live fill${T.liveFills === 1 ? '' : 's'} · ${usd0(-T.driftModeled, { sign: true })} modelled on ${T.caughtUp} caught up`, T.driftLive + T.driftModeled > 0 ? 'neg' : T.driftLive + T.driftModeled < 0 ? 'pos' : ''),
          UI.stat('Fees & slippage', usd0(T.fees + T.slip), `${usd0(T.fees)} fees · ${usd0(T.slip)} slippage`, 'neg'),
          UI.stat('Funding', usd0(T.funding, { sign: true }), 'accrued hourly from each market\'s current rate while a tab follows', U.pnlClass(T.funding)));
        const openTbl = UI.table({ cols: [
          { key: 'm', label: 'Market', render: (p) => UI.marketCell(p.ticker) },
          { key: 's', label: 'Side', render: (p) => U.sideEl(p.qty > 0, true) },
          { key: 'q', label: 'Size', num: true, render: (p) => h('span', U.fmtQty(Math.abs(p.qty)), h('span.dim.xs', ' · ' + usd0(p.entryNotional))) },
          { key: 'e', label: 'Avg entry', num: true, render: (p) => U.fmtPrice(Math.abs(p.cash / p.qty), (ref.byId[p.pid] || {}).tickSize) },
          { key: 'mk', label: 'Mark', num: true, render: (p) => (mk[p.pid] ? U.fmtPrice(mk[p.pid], (ref.byId[p.pid] || {}).tickSize) : h('span.dim', '—')) },
          { key: 'u', label: 'Unrealized', num: true, render: (p) => (mk[p.pid] ? U.pnlEl(p.cash + p.qty * mk[p.pid] - p.fees + p.funding, { dp: 2 }) : h('span.dim', '—')) },
          { key: 't', label: 'Since', render: (p) => h('span.dim', U.fmtAgo(p.openedAt)) },
        ], rows: openRows, empty: 'No open virtual position' });
        const logTbl = UI.table({ cols: [
          { key: 't', label: 'Time', render: (r) => h('span.dim', U.fmtFeedTime ? U.fmtFeedTime(r.t) : U.fmtAgo(r.t)) },
          { key: 'm', label: 'Market', render: (r) => UI.marketCell(r.ticker) },
          { key: 's', label: 'Side', render: (r) => U.sideEl(r.side === 'BUY') },
          { key: 'q', label: 'Size', num: true, render: (r) => U.fmtQty(r.qty) },
          { key: 'lp', label: 'Leader px', num: true, render: (r) => U.fmtPrice(r.leaderPx, (ref.byTicker[r.ticker] || {}).tickSize) },
          { key: 'cp', label: 'Copier px', num: true, render: (r) => U.fmtPrice(r.px, (ref.byTicker[r.ticker] || {}).tickSize) },
          { key: 'd', label: 'Wait cost', num: true, render: (r) => (Math.abs(r.drift) < 0.005 ? h('span.dim', '—') : h('span', { class: r.drift > 0 ? 'neg' : 'pos' }, U.fmtUsd(-r.drift, { sign: true, dp: 2 }))) },
          { key: 'f', label: 'Fee', num: true, render: (r) => U.fmtUsd(r.fee, { dp: 2 }) },
          { key: 'k', label: '', render: (r) => h('span', r.why ? UI.chip('closed at mark', 'amber') : r.live ? UI.chip('live', 'blue') : UI.chip('caught up', ''), r.closed ? h('span.dim.xs', ' closed ' + U.fmtUsd(r.closed.net, { sign: true, dp: 2 })) : null, r.why ? h('span.dim.xs', { title: r.why }, ' ⓘ') : null) },
        ], rows: paper.log.slice(0, 30), empty: 'No fills mirrored yet' });
        U.replace(paperCard,
          h('div.row.wrap', { style: { marginBottom: '8px', gap: '8px' } }, h('h2', 'Paper copy'), UI.chip(unsubs.length ? 'following' : 'paused', unsubs.length ? 'green' : 'amber'), h('span.dim.small', `since ${U.fmtDateTime(paper.startedAt)} · ${paper.settings.mode === 'fixed' ? usd0(paper.settings.size) + ' per position' : paper.settings.mode === 'perfill' ? usd0(paper.settings.size) + ' per fill' : U.fmtNum(paper.settings.ratio * 100, 1) + '% of the leader'} · ${paper.settings.delay ? paper.settings.delay + ' s' : 'no'} delay` + (pending ? ` · ${pending} fill${pending > 1 ? 's' : ''} waiting` : '')), h('span.grow'),
            h('button.btn.sm.ghost', { onclick: () => { if (confirm('Stop following and discard this paper account?')) { detach(); PP.clear(sid); paper = null; renderPaper(); } } }, 'Stop & discard')),
          tiles,
          h('div.grid.cols-2', { style: { marginTop: '12px' } }, UI.card('Open virtual positions', openTbl), UI.card('Mirrored fills', logTbl, h('span.dim.small', 'newest first'))),
          h('div.footer-note', { style: { textAlign: 'left', paddingBottom: 0 } }, 'A paper account only proves what following would have done from here on; it is not the exchange, so partial fills, rejections and your own market impact are not in it. Funding is accrued only while a tab follows.'));
      }
      if (paper) { renderPaper(); try { const n = await catchUp(); if (n) U.toast(`Caught up ${n} fill${n > 1 ? 's' : ''} from the exchange`); } catch (e) { if (isAbort(e)) return; } attach(); renderPaper(); }
      else renderPaper();
      await run();
    },
  };
})();
