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
        mode: route.params.mode === 'ratio' ? 'ratio' : 'fixed',
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
        UI.starBtn({ address: sa.account, subaccountId: sid, name: U.decodeBytes32(sa.name) }), h('h2', U.shortAddr(sa.account, 6)), U.copyBtn(sa.account),
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
      const modeSeg = UI.seg([{ v: 'fixed', label: 'Fixed $ per position' }, { v: 'ratio', label: '% of the leader\'s size' }], st.mode, (v) => { st.mode = v; sizeIn.style.display = v === 'fixed' ? '' : 'none'; ratioIn.parentElement.style.display = v === 'ratio' ? '' : 'none'; }, 'sm');
      const ratioWrap = h('span.row', { style: { gap: '4px', display: st.mode === 'ratio' ? '' : 'none' } }, ratioIn, h('span.dim.small', '%'));
      sizeIn.style.display = st.mode === 'fixed' ? '' : 'none';
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
        MD.router.setParams({ address: addr, sub: sid, since: st.since, mode: st.mode === 'ratio' ? 'ratio' : null, size: st.mode === 'fixed' && st.size !== AN.COPY_SIZE ? st.size : null, ratio: st.mode === 'ratio' ? st.ratio : null, delay: st.delay !== 30 ? st.delay : null, slip: st.slip === 'auto' ? null : st.slip, markets: st.markets ? Array.from(st.markets).join(',') : null }, { silent: true });
        U.replace(results, h('div.card', UI.loading('Replaying fills against one-minute candles…')));
        try {
          const since = Date.parse(st.since + 'T00:00:00Z');
          const copyNotional = st.mode === 'fixed' ? st.size : null;
          const slipAuto = S.slippageFor(depth, ref, copyNotional || AN.COPY_SIZE);
          const feeRate = {}; for (const p of ref.active) feeRate[p.id] = U.num(p.takerFee) || 0.0003;
          const base = { mode: st.mode, size: st.size, ratio: st.ratio / 100, slipBps: st.slip === 'auto' ? slipAuto : st.slip, feeRate, priceAt: S.priceAtFactory(candles, ref), markets: st.markets };
          const runs = {};
          for (const d of DELAYS) runs[d] = await S.replay({ episodes, settings: Object.assign({}, base, { delaySec: d }), marks, since, ref });
          if (ctx.signal.aborted) return;
          renderResults(runs, base, slipAuto);
        } catch (e) { if (!isAbort(e)) U.replace(results, UI.error(e, () => run())); }
        runBtn.disabled = false;
      }

      function renderResults(runs, base, slipAuto) {
        const R = runs[st.delay]; const T = R.T; const R0 = runs[0].T;
        if (!R.rows.length) { U.replace(results, h('div.card', h('div.empty', 'No positions opened since ' + st.since + (st.markets ? ' in the chosen markets' : '') + '. Move the start date back.'))); return; }
        const sizeLabel = st.mode === 'fixed' ? usd0(st.size) + ' per position' : U.fmtNum(st.ratio, 1) + '% of the leader\'s size';
        const perPos = T.n ? T.copierNet / T.n : 0, perPosL = T.n ? T.leaderNet / T.n : 0;
        const avgEntry = T.n ? U.sum(R.rows, (r) => r.C.entryNotional) / T.n : 0, avgEntryL = T.n ? U.sum(R.rows, (r) => r.L.entryNotional) / T.n : 0;
        const tiles = h('div.stats',
          UI.stat('Copier net', usd0(T.copierNet, { sign: true }), `${sizeLabel} · ${st.delay ? st.delay + ' s' : 'instant'} delay` + (T.edgeKept != null ? ` · ${U.fmtPct(T.edgeKept, { dp: 0 })} of the leader's result` : ''), U.pnlClass(T.copierNet)),
          UI.stat('Leader net', usd0(T.leaderNet, { sign: true }), 'same positions, their fills, fees and funding', U.pnlClass(T.leaderNet)),
          UI.stat('Per position', (perPos > 0 ? '+' : '') + U.fmtNum(avgEntry ? (perPos / avgEntry) * 1e4 : 0, 0) + ' bps', `${usd0(perPos, { sign: true })} on ${usd0(avgEntry)} · leader ${avgEntryL ? (perPosL > 0 ? '+' : '') + U.fmtNum((perPosL / avgEntryL) * 1e4, 0) : '—'} bps`, U.pnlClass(perPos)),
          UI.stat('Positions', String(T.n), `${U.fmtPct(T.winRate || 0, { dp: 0 })} profitable for the copier` + (T.open ? ` · ${T.open} still open (marked)` : '') + (T.liq ? ` · ${T.liq} liquidated` : '')),
          UI.stat('Costs', usd0(T.fees + T.drift + T.slip + T.posFee), `${usd0(T.fees)} fees · ${usd0(T.drift, { sign: true })} drift · ${usd0(T.slip)} slippage` + (T.posFee ? ` · ${usd0(T.posFee)} position fees` : ''), 'neg'),
          UI.stat('Funding', usd0(T.funding, { sign: true }), 'the leader\'s, scaled to your size', U.pnlClass(T.funding)),
          UI.stat('Max drawdown', usd0(T.maxDd), st.mode === 'fixed' && st.size ? `${U.fmtNum(T.maxDd / st.size, 1)}× one position's size · on the copier's cumulative result` : 'on the copier\'s cumulative result', T.maxDd > 0 ? 'neg' : ''),
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
          h('div.it', h('div.t', 'Sizing'), h('div.d', st.mode === 'fixed' ? `Your first fill of each position is ${usd0(st.size)}; later increases and reductions follow the leader in proportion.` : `Every fill is ${U.fmtNum(st.ratio, 1)}% of the leader's quantity.`)),
          h('div.it', h('div.t', 'Liquidations and open positions'), h('div.d', 'A position the leader was liquidated out of is closed at the leader\'s exit price; whether you would have been liquidated depends on your own margin. Positions still open are marked at the current oracle price.')),
          h('div.it', h('div.t', 'Books'), h('div.d', slipNote + '. Unfillable sizes count as 60 bps.')),
          h('div.it', h('div.t', 'Not modelled'), h('div.d', 'Your own market impact on top of the leader\'s, rejected or partially filled orders, and the leader trading in more than one subaccount.'))));
        U.replace(results, tiles, h('div.grid.cols-2', chartCard, sensCard), UI.card('Positions', wrap, h('span.dim.small', `${T.n} since ${st.since}, newest first`)), notes);
        C.timeSeries(canvas, { series: [{ points: R.curveL, color: col.blue, label: 'Leader' }, { points: R.curve, color: col.accent, label: 'Copier' }], yFmt: (v) => U.fmtUsd(v, { compact: true }), tipFmt: (v) => U.fmtUsd(v, { dp: 0, sign: true }) });
      }
      await run();
    },
  };
})();
