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
        maxPos: U.num(route.params.max) > 0 ? U.num(route.params.max) : null,   // null = five times the size (S.MAX_SCALE)
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
        h('p.muted', { style: { margin: '8px 0 0', maxWidth: '900px' } }, 'What a follower would have kept copying this account: every position it opened since the start date is replayed with your size, entered and exited a set number of seconds after each of its fills at the oracle price of that moment, at taker fees, with slippage from today\'s order books at your size (' + usd0(AN.COPY_SIZE) + ' in % of leader mode). Funding and mPerp position fees follow the leader\'s, scaled to your size.'));
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
      const maxIn = h('input.input.sm', { type: 'number', min: 10, step: 100, placeholder: String(S.MAX_SCALE) + '× size', value: st.maxPos || '', style: { width: '110px' }, title: 'The most one position may grow to when the leader adds to it (empty = ' + S.MAX_SCALE + ' times the size)' });
      const ratioIn = h('input.input.sm', { type: 'number', min: 0.1, step: 1, value: st.ratio, style: { width: '90px' } });
      const maxWrap = h('span.row', { style: { gap: '4px' } }, h('span.dim.small', 'max'), maxIn);
      const modeSeg = UI.seg([{ v: 'fixed', label: '$ per position', title: 'the leader\'s opening order becomes this much; adds follow in proportion up to the maximum, reductions cut the same share' }, { v: 'perfill', label: '$ per fill', title: 'every entry fill becomes this much, up to the maximum per position; reductions cut the same share' }, { v: 'ratio', label: '% of leader', title: 'every fill is this share of the leader\'s quantity' }], st.mode, (v) => { st.mode = v; sizeIn.style.display = maxWrap.style.display = v === 'ratio' ? 'none' : ''; ratioIn.parentElement.style.display = v === 'ratio' ? '' : 'none'; }, 'sm');
      const ratioWrap = h('span.row', { style: { gap: '4px', display: st.mode === 'ratio' ? '' : 'none' } }, ratioIn, h('span.dim.small', '%'));
      sizeIn.style.display = maxWrap.style.display = st.mode === 'ratio' ? 'none' : '';
      const delaySeg = UI.seg(DELAYS.map((d) => ({ v: d, label: d ? d + ' s' : 'instant' })), st.delay, (v) => { st.delay = v; if (!paper) renderPaper(); }, 'sm');   // the paper card's text names the delay
      const slipIn = h('input.input.sm', { type: 'number', min: 0, step: 0.5, placeholder: 'auto', value: st.slip === 'auto' ? '' : st.slip, style: { width: '80px' }, title: 'Leave empty to take today\'s books at your size (' + usd0(AN.COPY_SIZE) + ' in % of leader mode)' });
      const mkWrap = h('div.row.wrap', { style: { gap: '4px' } });
      const renderMarkets = () => U.replace(mkWrap, traded.map((p) => { const on = !st.markets || st.markets.has(p.id); return h('button.chip', { class: on ? 'green' : '', style: { cursor: 'pointer' }, onclick: () => { if (!st.markets) st.markets = new Set(traded.map((x) => x.id)); if (st.markets.has(p.id)) st.markets.delete(p.id); else st.markets.add(p.id); if (st.markets.size === traded.length) st.markets = null; renderMarkets(); } }, p.displayTicker); }));
      renderMarkets();
      const runBtn = h('button.btn.primary.sm', { onclick: () => run() }, 'Run');
      const settings = h('div.card.no-print', h('div.stack', { style: { gap: '10px' } },
        h('div.row.wrap', { style: { gap: '10px', rowGap: '10px' } }, h('span.dim.small', 'Copy since (UTC)'), sinceIn, h('span.dim.small', 'Size'), modeSeg, sizeIn, maxWrap, ratioWrap, h('span.dim.small', 'Delay'), delaySeg),
        h('div.row.wrap', { style: { gap: '10px', rowGap: '10px' } }, h('span.dim.small', 'Slippage'), slipIn, h('span.dim.small', 'bps each way (empty = from today\'s books at your size; ' + usd0(AN.COPY_SIZE) + ' in % of leader mode)'), h('span.dim.small', { style: { marginLeft: '8px' } }, 'Markets'), mkWrap, h('span.grow'), runBtn)));
      const results = h('div.stack');
      U.replace(body, head, settings, results);

      // the form's size, maximum, ratio and slippage, read when they are used, so an edited field counts (Run and Start following)
      function readInputs() {
        st.since = sinceIn.value || st.since; st.size = Math.max(10, U.num(sizeIn.value) || AN.COPY_SIZE); st.ratio = Math.max(0.1, U.num(ratioIn.value) || 10);
        st.maxPos = U.num(maxIn.value) >= st.size ? U.num(maxIn.value) : null; maxIn.value = st.maxPos || '';
        st.slip = slipIn.value === '' ? 'auto' : Math.max(0, U.num(slipIn.value));
      }
      async function run() {
        runBtn.disabled = true;
        readInputs();
        MD.router.setParams({ address: addr, sub: sid, since: st.since, mode: st.mode !== 'fixed' ? st.mode : null, size: st.mode !== 'ratio' && st.size !== AN.COPY_SIZE ? st.size : null, max: st.mode !== 'ratio' && st.maxPos ? st.maxPos : null, ratio: st.mode === 'ratio' ? st.ratio : null, delay: st.delay !== 30 ? st.delay : null, slip: st.slip === 'auto' ? null : st.slip, markets: st.markets ? Array.from(st.markets).join(',') : null }, { silent: true });
        U.replace(results, h('div.card', UI.loading('Replaying fills against one-minute candles…')));
        try {
          const since = Date.parse(st.since + 'T00:00:00Z');
          const copyNotional = st.mode !== 'ratio' ? st.size : null;
          const slipAuto = S.slippageFor(depth, ref, copyNotional || AN.COPY_SIZE);
          const feeRate = {}; for (const p of ref.active) feeRate[p.id] = U.num(p.takerFee) || 0.0003;
          const base = { mode: st.mode, size: st.size, maxPos: st.maxPos, ratio: st.ratio / 100, slipBps: st.slip === 'auto' ? slipAuto : st.slip, feeRate, markets: st.markets };
          const runs = {};
          // a pricer per delay, so each run counts its own fills without a candle (the candle cache is shared: no extra requests)
          for (const d of DELAYS) { const priceAt = S.priceAtFactory(candles, ref); runs[d] = await S.replay({ episodes, settings: Object.assign({}, base, { delaySec: d, priceAt }), marks, since, ref }); runs[d].candleStats = priceAt.stats; }
          if (ctx.signal.aborted) return;
          renderResults(runs, base, slipAuto, runs[st.delay].candleStats);
        } catch (e) { if (!isAbort(e)) U.replace(results, UI.error(e, () => run())); }
        runBtn.disabled = false;
      }

      function renderResults(runs, base, slipAuto, candleStats) {
        const R = runs[st.delay]; const T = R.T; const R0 = runs[0].T;
        if (!R.rows.length) { U.replace(results, h('div.card', h('div.empty', 'No positions opened since ' + st.since + ' (UTC)' + (st.markets ? ' in the chosen markets' : '') + '. Move the start date back.'))); return; }
        const maxPos = S.maxPosition(base);
        const sizeLabel = st.mode === 'fixed' ? usd0(st.size) + ' per position (the opening order)' : st.mode === 'perfill' ? usd0(st.size) + ' per entry fill' : U.fmtNum(st.ratio, 1) + '% of the leader\'s size';
        const perPos = T.n ? T.copierNet / T.n : 0, perPosL = T.n ? T.leaderNet / T.n : 0;
        const avgEntry = T.n ? U.sum(R.rows, (r) => r.C.entryNotional) / T.n : 0, avgEntryL = T.n ? U.sum(R.rows, (r) => r.L.entryNotional) / T.n : 0;
        const tiles = h('div.stats',
          UI.stat('Copier net', usd0(T.copierNet, { sign: true }), `${sizeLabel} · ${st.delay ? st.delay + ' s' : 'instant'} delay` + (T.edgeKept != null ? ` · ${U.fmtPct(T.edgeKept, { dp: 0 })} of the leader's result at your size` : ''), U.pnlClass(T.copierNet)),
          UI.stat('Leader net', usd0(T.leaderNet, { sign: true }), 'same positions, their fills, fees and funding', U.pnlClass(T.leaderNet)),
          UI.stat('Per position', (perPos > 0 ? '+' : '') + U.fmtNum(avgEntry ? (perPos / avgEntry) * 1e4 : 0, 0) + ' bps', `${usd0(perPos, { sign: true })} on ${usd0(avgEntry)} average entry` + (st.mode === 'fixed' && avgEntry > st.size * 1.3 ? ' (the leader adds to positions)' : '') + ` · leader ${avgEntryL ? (perPosL > 0 ? '+' : '') + U.fmtNum((perPosL / avgEntryL) * 1e4, 0) : '—'} bps`, U.pnlClass(perPos)),
          UI.stat('Positions', String(T.n), `${U.fmtPct(T.winRate || 0, { dp: 0 })} profitable for the copier` + (T.open ? ` · ${T.open} still open (marked)` : '') + (T.liq ? ` · ${T.liq} liquidated` : '') + (T.capped ? ` · ${T.capped} capped at ${usd0(maxPos)}` : '')),
          UI.stat('Costs', usd0(T.fees + T.drift + T.slip + T.posFee), `${usd0(T.fees)} fees · ${usd0(T.drift, { sign: true })} drift · ${usd0(T.slip)} slippage` + (T.posFee ? ` · ${usd0(T.posFee)} position fees` : ''), 'neg'),
          UI.stat('Funding', usd0(T.funding, { sign: true }), 'the leader\'s, scaled to your size', U.pnlClass(T.funding)),
          UI.stat('Max drawdown', usd0(T.maxDd), avgEntry ? `${U.fmtNum(T.maxDd / avgEntry, 1)}× an average position · on the copier's cumulative result` : 'on the copier\'s cumulative result', T.maxDd > 0 ? 'neg' : ''),
          UI.stat('If instant', usd0(R0.copierNet, { sign: true }), 'the same copy with zero delay: what latency costs is the gap', U.pnlClass(R0.copierNet)));
        const canvas = h('canvas');
        const col = C.colors();
        const chartCard = h('div.card.chart-fill', h('div.row', { style: { marginBottom: '6px', flex: 'none' } }, h('h3', 'Cumulative result'), h('span.grow'), h('span.dim.small', 'by position close · the leader\'s result scaled to your size, position by position')), h('div.chart-box', canvas));
        // delay sensitivity
        const sens = UI.table({ cols: [
          { key: 'd', label: 'Delay', render: (d) => h('span', { class: d === st.delay ? 'bold' : '' }, d ? d + ' s' : 'instant') },
          { key: 'net', label: 'Copier net', num: true, render: (d) => U.pnlEl(runs[d].T.copierNet, { dp: 0 }) },
          { key: 'kept', label: 'Of the leader\'s', num: true, title: 'The copier\'s net as a share of the leader\'s result on the same positions, scaled to the copier\'s size per position', render: (d) => (runs[d].T.edgeKept == null ? h('span.dim', '—') : h('span', { class: 'num ' + (runs[d].T.edgeKept >= 50 ? 'pos' : runs[d].T.edgeKept > 0 ? '' : 'neg') }, U.fmtPct(runs[d].T.edgeKept, { dp: 0 }))) },
          { key: 'drift', label: 'Drift cost', num: true, render: (d) => usd0(runs[d].T.drift, { sign: true }) },
          { key: 'wr', label: 'Profitable', num: true, render: (d) => U.fmtPct(runs[d].T.winRate || 0, { dp: 0 }) },
        ], rows: DELAYS });
        const sensCard = UI.card('Latency sensitivity', sens, h('span.dim.small', 'the same copy, acting later after each fill'));
        // per-position table
        const wrap = h('div'); let page = 1;
        const renderTbl = () => {
          const rows = R.rows.slice().sort((a, b) => b.t0 - a.t0); const slice = rows.slice((page - 1) * PAGE, page * PAGE);   // newest opened first, as the first column reads
          U.replace(wrap, UI.table({ cols: [
            { key: 't', label: 'Opened (UTC)', render: (r) => h('span.dim', new Date(r.t0).toISOString().replace('T', ' ').slice(0, 16)) },
            { key: 'm', label: 'Market', render: (r) => UI.marketCell(r.ticker) },
            { key: 's', label: 'Side', render: (r) => U.sideEl(r.long, true) },
            { key: 'h', label: 'Held', num: true, render: (r) => h('span', U.fmtDuration(r.hold), r.open ? UI.chip('open', 'blue') : r.liq ? UI.chip('LIQ', 'red') : null) },
            { key: 'ls', label: 'Leader size', num: true, title: 'Everything the leader put into the position: the opening order plus every add, at its fill prices', render: (r) => usd0(r.L.entryNotional) },
            { key: 'ln', label: 'Leader net', num: true, render: (r) => h('span', U.pnlEl(r.L.net, { dp: 2 }), bpsEl(r.leaderBps)) },
            { key: 'cs', label: 'Copier size', num: true, title: 'Everything the copier would have put in: the opening order plus every add. The maximum per position limits what is held at once, so a position trimmed and added to again can total more than it', render: (r) => h('span', usd0(r.C.entryNotional), r.C.capped ? h('span.dim.xs', { title: 'the leader added beyond the maximum per position; the copier stopped adding' }, ' capped') : null) },
            { key: 'cn', label: 'Copier net', num: true, render: (r) => h('span', U.pnlEl(r.C.net, { dp: 2 }), bpsEl(r.copierBps)) },
            { key: 'dr', label: 'Drift cost', num: true, title: 'What the price move between each of the leader\'s fills and the copier\'s fill cost the copier (+ = a worse price, − = a better one)', render: (r) => (Math.abs(r.C.driftCost) < 0.005 ? h('span.dim', '—') : h('span', { class: r.C.driftCost > 0 ? 'neg' : 'pos' }, U.fmtUsd(r.C.driftCost, { sign: true, dp: 2 }))) },
            { key: 'sl', label: 'Slippage', num: true, render: (r) => (r.C.slipCost ? U.fmtUsd(r.C.slipCost, { dp: 2 }) : h('span.dim', '—')) },
            { key: 'fe', label: 'Fees', num: true, render: (r) => U.fmtUsd(r.C.fees, { dp: 2 }) },
            { key: 'fu', label: 'Funding', num: true, render: (r) => (Math.abs(r.C.funding) < 0.005 ? h('span.dim', '—') : U.pnlEl(r.C.funding, { dp: 2 })) },
          ], rows: slice }), rows.length > PAGE ? UI.pager({ page, pageSize: PAGE, total: rows.length, onPage: (p) => { page = p; renderTbl(); } }) : null);
        };
        renderTbl();
        // a market whose book did not load gets no entry from S.slippageFor, and the replay then uses 0 bps for it: say so
        const slipNote = st.slip === 'auto' ? 'Slippage from today\'s books at ' + usd0(base.mode !== 'ratio' ? st.size : AN.COPY_SIZE) + ': ' + traded.map((p) => `${p.displayTicker} ${slipAuto[p.id] == null ? 'no book loaded, 0 bps used' : U.fmtNum(slipAuto[p.id], 1) + ' bps'}`).join(' · ') + '. A size the book cannot fill, or one costing more than 60 bps, counts as 60 bps.' : `Slippage set to ${U.fmtNum(st.slip, 1)} bps each way.`;
        const notes = h('div.card', h('h3', { style: { marginBottom: '8px' } }, 'What this assumes'), h('div.note-grid',
          h('div.it', h('div.t', 'Prices'), h('div.d', (st.delay ? 'Each of the leader\'s fills is copied at the estimated oracle price ' + st.delay + ' seconds later: a straight line between the nearest known prices on either side of that moment (the fill itself and the end of its minute while still inside the fill\'s minute; after that, the one-minute closes before and after it)' : 'Each of the leader\'s fills is copied at the leader\'s own fill price') + ', then moved against you by the slippage. The leader\'s own fills are what it actually paid.')),
          h('div.it', h('div.t', 'Fees, funding, position fees'), h('div.d', 'You pay the taker fee of each market on every fill. Funding and mPerp position fees are the leader\'s for the same position, scaled to your size: you would hold it over the same hours.')),
          h('div.it', h('div.t', 'Sizing'), h('div.d', st.mode === 'fixed' ? `The leader's opening order (all of its fills, not just the first piece) becomes ${usd0(st.size)} for you; later adds follow the leader in proportion until the position reaches ${usd0(maxPos)}, the most one position may hold (a leader who opens small and scales in would otherwise make yours any multiple of ${usd0(st.size)}). A reduction cuts your position by the same share as the leader's.` : st.mode === 'perfill' ? `Every entry fill becomes ${usd0(st.size)} for you, until the position reaches ${usd0(maxPos)}, the most one position may hold; a reduction cuts your position by the same share as the leader's.` : `Every fill is ${U.fmtNum(st.ratio, 1)}% of the leader's quantity.`)),
          h('div.it', h('div.t', 'Liquidations and open positions'), h('div.d', 'A position the leader was liquidated out of is closed at the leader\'s exit price; whether you would have been liquidated depends on your own margin. Positions still open are marked at the current oracle price.')),
          h('div.it', h('div.t', 'Books'), h('div.d', slipNote)),
          h('div.it', h('div.t', 'Not modelled'), h('div.d', 'Your own market impact on top of the leader\'s, rejected or partially filled orders, and the leader trading in more than one subaccount.')),
          (data.truncated || T.partial || T.noFunding || (candleStats && candleStats.noCandle)) ? h('div.it', h('div.t', 'Data limits'), h('div.d',
            (data.truncated ? `The exchange returned the newest ${U.fmtNum(data.fills.length, 0)} fills (back to ${U.fmtDateTime(data.oldestFill)}); older positions are not replayed. ` : '') +
            (T.partial ? `${T.partial} position${T.partial > 1 ? 's' : ''} whose opening lies before that window ${T.partial > 1 ? 'were' : 'was'} left out. ` : '') +
            (T.noFunding ? `${T.noFunding} position${T.noFunding > 1 ? 's have' : ' has'} no position record from the exchange, so ${T.noFunding > 1 ? 'their' : 'its'} funding and liquidation status are unknown (counted as zero). ` : '') +
            (candleStats && candleStats.noCandle ? `${U.fmtNum(candleStats.noCandle, 0)} of ${U.fmtNum(candleStats.fills, 0)} delayed fills had no candle and were priced at the leader's fill (no drift).` : ''))) : null));
        U.replace(results, tiles, h('div.grid.cols-2', chartCard, sensCard), UI.card('Positions', wrap, h('span.dim.small', `${T.n} opened since ${st.since} (UTC), newest first`)), notes);
        C.timeSeries(canvas, { series: [{ points: R.curveL, color: col.blue, label: 'Leader (at your size)' }, { points: R.curve, color: col.accent, label: 'Copier' }], yFmt: C.axisUsd, tipFmt: (v) => U.fmtUsd(v, { dp: 0, sign: true }) });
      }

      // ---- paper copy: the same copier, live, in a virtual account kept in this browser
      // The exchange's fill history is the record (js/copy/paper.js): a live fill message only says when to look, so every
      // fill is applied once, under its own id, with the leader's real quantity, and after each sync the copy is lined up
      // with the leader's actual positions. A position the leader already held when following started is not the copy's:
      // cutting or closing it later is not a new position. Times are the exchange's (clockOffset), not this machine's.
      const PP = MD.paper;
      const paperCard = h('div.card'); body.appendChild(paperCard);
      let paper = PP.load(sid); const live = {}, liveT = {}; let unsubs = []; let fundingTimer = null;
      let syncTimer = null, syncAt = 0, syncing = null, syncAgain = false, pending = 0, rebuilding = false;
      const announced = new Map();   // fill id → { t, tries }: fills the stream announced, looked for again until the history has them
      const recentFill = {};         // productId → the newest leader fill the stream announced there
      let clockOffset = 0; const serverNow = () => Date.now() + clockOffset;
      async function syncClock() { try { const t0 = Date.now(); const r = await A.serverTime({ signal: ctx.signal }); const t1 = Date.now(); if (r && U.num(r.time)) clockOffset = U.num(r.time) - (t0 + t1) / 2; } catch (e) { if (isAbort(e)) throw e; } }
      // markets as an array: the settings are saved as JSON, where a Set would become {}
      const paperSettings = () => { const feeRate = {}; for (const p of ref.active) feeRate[p.id] = U.num(p.takerFee) || 0.0003; return { mode: st.mode, size: st.size, maxPos: st.maxPos, ratio: st.ratio / 100, delay: st.delay, slipBps: st.slip === 'auto' ? S.slippageFor(depth, ref, st.mode !== 'ratio' ? st.size : AN.COPY_SIZE) : st.slip, feeRate, markets: st.markets ? Array.from(st.markets) : null }; };
      // detach: the stream and the timers of following; stopAll also drops a sync waiting for a fill's delay
      const detach = () => { for (const u of unsubs) { try { u(); } catch (_) {} } unsubs = []; if (fundingTimer) clearInterval(fundingTimer); fundingTimer = null; };
      const stopAll = () => { detach(); clearTimeout(syncTimer); syncTimer = null; syncAt = 0; };
      ctx.onCleanup(stopAll);
      const markOf = (pid) => (live[pid] != null && Date.now() - (liveT[pid] || 0) < 15000 ? live[pid] : null);   // the stream's mark while it is fresh
      const marksNow = () => { const m = {}; for (const p of ref.active) { const v = markOf(p.id) || marks[p.id]; if (v) m[p.id] = v; } return m; };
      /** Prices to act on now: the stream's while fresh, else the exchange's market price; nothing when neither answers. */
      async function freshMarks(pids) {
        const out = {}; const ask = pids.filter((pid) => { const m = markOf(pid); if (m) out[pid] = m; return !m; });
        if (ask.length) { try { const pm = await A.marketPrices(ask, { signal: ctx.signal, ttl: 3000 }); for (const pid of ask) { const x = pm[pid]; const v = x && U.num(x.oraclePrice); if (v) out[pid] = v; } } catch (e) { if (isAbort(e)) throw e; } }   // the market price endpoint has no markPrice: its oracle price is the mark
        return out;
      }
      /** An order's size for a fixed-size copy: what filled once it is done, else what was asked (a working order, not cached). */
      async function orderQty(id) {
        try { const o = await A.order(id, { signal: ctx.signal, ttl: 0 }); if (!o) return null; const done = /^(FILLED|CANCELED|CANCELLED|EXPIRED|REJECTED)$/i.test(String(o.status || '')); return (done ? U.num(o.filled) : U.num(o.quantity)) || null; }
        catch (e) { if (isAbort(e)) throw e; return null; }
      }
      // another tab of this page may be following too: the newer copy of the same account wins (paper.rev counts writes)
      const sameAcct = (a, b) => a && b && a.startedAt === b.startedAt;
      const savePaper = (acct = paper) => { if (!acct || paper !== acct) return false; const cur = PP.load(sid); if (sameAcct(cur, acct) && (cur.rev || 0) > (acct.rev || 0)) { paper = cur; return false; } PP.save(acct); return true; };
      const onStorage = (e) => { if (e.key !== PP.key(sid)) return; const cur = PP.load(sid); if (!cur) { stopAll(); paper = null; renderPaper(); return; } if (!paper || !sameAcct(cur, paper) || (cur.rev || 0) > (paper.rev || 0)) { paper = cur; if (!unsubs.length) attach(); renderPaper(); } };
      window.addEventListener('storage', onStorage); ctx.onCleanup(() => window.removeEventListener('storage', onStorage));
      /** Apply the leader's fills from the history that are due (their delay has passed), then line the copy up with the
       *  leader's positions. On time (within 20 s of when the copier would act) a fill is priced at the live mark, measured;
       *  found later, at the candle price of that moment. Returns the number of rows written. */
      function sync() { if (syncing || rebuilding) { syncAgain = true; return syncing || Promise.resolve(0); } syncing = doSync().finally(() => { syncing = null; if (syncAgain && !rebuilding) { syncAgain = false; scheduleSync(0); } }); return syncing; }
      /** Sync in `ms`, unless one is already due sooner. */
      function scheduleSync(ms) {
        const at = Date.now() + Math.max(0, ms);
        if (syncTimer && syncAt <= at) return;
        clearTimeout(syncTimer); syncAt = at;
        syncTimer = setTimeout(() => { syncTimer = null; syncAt = 0; sync().then((n) => { if (n) renderPaper(); }).catch((e) => { if (!isAbort(e)) console.warn('paper sync', e); }); }, Math.max(0, ms));
      }
      async function doSync() {
        const acct = paper; if (!acct) return 0;
        const delayMs = acct.settings.delay * 1000;
        // the leader's positions first: any fill after this snapshot is in the history read next, so a market with one is
        // left out of the lining up (a fill between the two reads must not look like a change without a fill)
        const snapAt = serverNow();
        let book = null; try { book = PP.leaderBook(await A.openPositions(sid, { signal: ctx.signal })); } catch (e) { if (isAbort(e)) throw e; }
        // from the newest fill applied (an account kept by an earlier version of this page: from its last visit); oldest
        // first, so when the page cap cuts the list it cuts the newest, which the next sync picks up
        const from = (acct.fillT != null ? acct.fillT : (acct.v || 0) >= 3 ? acct.startedAt : acct.lastSeen) - 1000;
        const fills = await A.page(A.BASE, '/v1/order/fill', { subaccountId: sid, createdAfter: from, order: 'asc' }, { maxPages: 10, signal: ctx.signal });
        if (paper !== acct) { syncAgain = true; return 0; }   // the account changed meanwhile (another tab, a rebuild, a discard)
        const now = serverNow(); const due = [], later = [];
        for (const f of fills) { if (acct.seen[f.id]) continue; (U.num(f.createdAt) + delayMs <= now + 500 ? due : later).push(f); }
        // order sizes only for markets the copy follows (P.apply discards the rest without using them)
        const follows = (f) => !acct.settings.markets || acct.settings.markets.includes(f.productId);
        const oq = {}; if (acct.settings.mode === 'fixed') for (const f of due) if (follows(f) && oq[f.orderId] == null) oq[f.orderId] = await orderQty(f.orderId);
        const priceAt = S.priceAtFactory(AN.candleCache({ signal: ctx.signal }), ref);   // a fresh cache: one read earlier may end before these fills
        if (paper !== acct) { syncAgain = true; return 0; }
        const rows = await PP.applyFills(acct, due, ref, async (f) => {
          const t = U.num(f.createdAt), dueAt = t + delayMs;
          if (serverNow() - dueAt < 20000) { const px = (await freshMarks([f.productId]))[f.productId]; if (px) return { px, live: true, at: Math.max(serverNow(), dueAt) }; }
          return { px: await priceAt(f.productId, t, U.num(f.price), acct.settings.delay), live: false, at: dueAt };
        }, oq);
        if (paper !== acct) { syncAgain = true; return 0; }
        if (acct.fillT == null) acct.fillT = from;   // an account from an earlier version: from here on, by fill time
        pending = later.length;
        if (later.length) scheduleSync(Math.min(...later.map((f) => U.num(f.createdAt))) + delayMs - serverNow() + 300);
        // fills the stream announced that the history does not show yet: look again shortly, a few times
        for (const [id, a] of announced) { if (acct.seen[id]) { announced.delete(id); continue; } if (a.t + delayMs > serverNow()) continue; if (++a.tries > 5) announced.delete(id); else scheduleSync(3000); }
        if (fills.truncated) { scheduleSync(0); acct.lastSeen = Date.now(); savePaper(acct); return rows.length; }   // not caught up yet: no lining up
        if (book) {
          const skip = new Set(later.map((f) => f.productId));
          for (const f of fills) if (U.num(f.createdAt) > snapAt - 2000) skip.add(f.productId);
          for (const [pid, t] of Object.entries(recentFill)) if (t > snapAt - 60000) skip.add(pid);
          for (const a of announced.values()) skip.add(a.pid);
          const act = PP.needsReconcile(acct, book).filter((pid) => !skip.has(pid));
          if (act.length) {
            const px = await freshMarks(act);
            if (paper !== acct) { syncAgain = true; return 0; }
            rows.push(...PP.reconcile(acct, book, (pid) => (act.includes(pid) ? px[pid] || null : null), serverNow()));
          }
        }
        acct.lastSeen = Date.now(); savePaper(acct); return rows.length;
      }
      /** Recompute the account from the exchange's fills since it started, at candle prices, from the leader's positions at
       *  that moment. Mends an account an earlier version of this page kept wrong (a leader's sell of a position opened
       *  before following, mirrored as a new short). Funding carries over only for positions open in both. */
      async function rebuild() {
        const old = paper; const t0 = old.startedAt;
        // the leader's positions when following started: recorded then (pre0), or for an older account rebuilt from each
        // position's own fills up to that moment (a position's fills split a reversal between the two positions)
        let pre = old.pre0;
        if (!pre) {
          pre = {};
          const positions = await A.positions(sid, { maxPages: 5, signal: ctx.signal });
          for (const p of positions) {
            if (U.num(p.createdAt) >= t0 || (U.num(p.size) === 0 && U.num(p.updatedAt) < t0)) continue;
            const fs = await A.positionFills(p.id, { signal: ctx.signal });
            const q = U.sum(fs.filter((f) => U.num(f.createdAt) < t0), (f) => (U.sideName(f.side) === 'BUY' ? 1 : -1) * U.num(f.filled));
            if (Math.abs(q) > 1e-9) pre[p.productId] = (pre[p.productId] || 0) + q;
          }
        }
        const fresh = PP.fresh(old, pre);
        const snapAt = serverNow();
        const book = PP.leaderBook(await A.openPositions(sid, { signal: ctx.signal }));
        // every fill since the start, oldest first, page by page until the history is exhausted
        const fills = []; let after = t0 - 1000;
        for (let round = 0; ; round++) {
          const part = await A.page(A.BASE, '/v1/order/fill', { subaccountId: sid, createdAfter: after, order: 'asc' }, { maxPages: 20, signal: ctx.signal });
          fills.push(...part);
          if (!part.truncated || !part.length) break;
          if (round >= 24) throw new Error('the leader has too many fills since then to rebuild here');
          after = U.num(part[part.length - 1].createdAt) - 1;   // a millisecond of overlap: the ids keep each fill once
        }
        const oq = {}; if (fresh.settings.mode === 'fixed') for (const f of fills) if (oq[f.orderId] == null && U.num(f.createdAt) >= t0) oq[f.orderId] = await orderQty(f.orderId);
        const priceAt = S.priceAtFactory(AN.candleCache({ signal: ctx.signal }), ref);
        await PP.applyFills(fresh, fills, ref, async (f) => ({ px: await priceAt(f.productId, U.num(f.createdAt), U.num(f.price), fresh.settings.delay), live: false, at: U.num(f.createdAt) + fresh.settings.delay * 1000 }), oq);
        const skip = new Set(fills.filter((f) => U.num(f.createdAt) > snapAt - 2000).map((f) => f.productId));
        const act = PP.needsReconcile(fresh, book).filter((pid) => !skip.has(pid));
        if (act.length) { const px = await freshMarks(act); PP.reconcile(fresh, book, (pid) => (act.includes(pid) ? px[pid] || null : null), serverNow()); }
        // funding accrued while a tab followed: kept for the positions open in both, in proportion to their size
        for (const [pid, pos] of Object.entries(fresh.open)) { const o = old.open[pid]; if (!o || Math.sign(o.qty) !== Math.sign(pos.qty) || !o.qty) continue; const f = o.funding * Math.min(1, Math.abs(pos.qty) / Math.abs(o.qty)); pos.funding += f; fresh.totals.funding += f; }
        if (paper !== old || !sameAcct(PP.load(sid), old)) return null;   // stopped or replaced meanwhile: leave it be
        fresh.rev = Math.max(fresh.rev || 0, (PP.load(sid) || {}).rev || 0); fresh.fundingAt = Date.now(); fresh.lastSeen = Date.now();
        paper = fresh; PP.save(paper);
        return fills.filter((f) => U.num(f.createdAt) >= t0).length;
      }
      function attach() {
        detach();
        if (paper && !paper.fundingAt) paper.fundingAt = Date.now();
        for (const p of ref.active) unsubs.push(A.ws.subscribe('Ticker', p.ticker, (m) => { const d = m.data || {}; const prod = ref.byTicker[d.s]; if (prod && U.num(d.markPx)) { live[prod.id] = U.num(d.markPx); liveT[prod.id] = Date.now(); } }));
        unsubs.push(A.ws.subscribe('OrderFill', sid, (m) => {
          const d = m.data || {}; const items = Array.isArray(d.d) ? d.d : [];
          let first = null;
          for (const it of items) {
            const prod = ref.byTicker[it.s]; if (!prod || !paper) continue;
            const t = U.num(it.t || d.t) || serverNow(); recentFill[prod.id] = Math.max(recentFill[prod.id] || 0, t);
            if (it.id && !paper.seen[it.id]) { announced.set(it.id, { t, tries: 0, pid: prod.id }); pending++; }
            first = first == null ? t : Math.min(first, t);
          }
          // act `delay` seconds after the fill, at the mark of that moment: the wait is measured on the real tape
          if (first != null && paper) { renderPaper(); scheduleSync(first + paper.settings.delay * 1000 - serverNow() + 300); }
        }));
        // funding while a tab follows, for the time since the account's last accrual (another tab's included), at most two
        // minutes at a time: a laptop asleep follows nothing
        // each market's latest hourly rate: `ref` from page load would keep accruing at the rate of that hour
        fundingTimer = setInterval(async () => {
          let r = ref; try { r = await A.ref({ signal: ctx.signal }); } catch (e) { if (isAbort(e)) return; }   // cached 5 min
          if (!paper || rebuilding || ctx.signal.aborted) return;   // read after the wait: a rebuild or a discard may have landed meanwhile
          const cur = PP.load(sid); if (sameAcct(cur, paper) && (cur.rev || 0) > (paper.rev || 0)) paper = cur;
          const now = Date.now(); const hours = Math.min(120000, Math.max(0, now - (paper.fundingAt || now))) / 3600000;
          if (hours > 0) PP.accrueFunding(paper, r, marksNow(), hours);
          paper.fundingAt = now; savePaper(); renderPaper();
        }, 60000);
        // a fill whose message the stream lost (a reconnect, a sleeping laptop) is found by the next look at the history
        const poll = setInterval(() => { if (paper && !document.hidden) scheduleSync(0); }, 120000);
        const tick = setInterval(() => { if (paper && Object.keys(paper.open).length && !document.hidden) renderPaper(); }, 10000);   // unrealized follows the mark
        unsubs.push(() => clearInterval(tick), () => clearInterval(poll));
      }
      async function startPaper() {
        // the leader's positions right now are not the copy's: record them, so cutting them later is not a new position.
        // Without them following cannot start safely.
        let book;
        try { await syncClock(); book = PP.leaderBook(await A.openPositions(sid, { signal: ctx.signal })); }
        catch (e) { if (isAbort(e)) return; U.toast('Could not read the leader\'s open positions, so following did not start: ' + (e.message || e)); return; }
        readInputs();   // exactly what the form shows, Run pressed or not
        paper = PP.start(sid, sa.account, paperSettings(), book, serverNow()); attach(); renderPaper();
      }
      function renderPaper() {
        if (!paper) {
          U.replace(paperCard, h('div.row', { style: { marginBottom: '8px' } }, h('h2', 'Paper copy'), UI.chip('live', 'blue'), h('span.grow'), h('button.btn.primary.sm', { onclick: startPaper }, 'Start following')),
            h('p.muted', { style: { margin: 0, maxWidth: '900px' } }, 'Follow this account in a virtual account with the settings above (size, delay, slippage and markets as set when you start). Each of its fills is mirrored ' + (st.delay ? st.delay + ' seconds later' : 'as soon as the page sees it') + ' at the mark price of that moment, so the delay cost is measured on the real tape rather than modelled. The account lives in this browser: it follows while a tab with this page is open, and fills that happen while it is closed are caught up from the exchange\'s fill history at candle prices when you come back.'));
          return;
        }
        const mk = marksNow(); const unreal = PP.unrealized(paper, mk); const T = paper.totals;
        const openRows = Object.values(paper.open);
        // positions kept before the cost basis existed cannot split partial closes from what is open: until Rebuild,
        // the open tile is their result so far
        const legacy = openRows.some((p) => p.basis == null);
        const realized = T.realized + PP.bookedOpen(paper);
        const delay = T.driftLive + T.driftModeled;   // + = a cost, as in the simulator
        const tiles = h('div.stats',
          UI.stat('Realized', usd0(realized, { sign: true }), `${paper.closed.length} closed position${paper.closed.length === 1 ? '' : 's'}` + (openRows.some((p) => p.basis != null) ? ' · incl. partial closes, fees and funding of open ones' : ''), U.pnlClass(realized)),
          legacy ? UI.stat('Result so far', usd0(unreal, { sign: true }), `${openRows.length} open · at the live mark, incl. partial closes, fees and funding · Rebuild to split it`, U.pnlClass(unreal))
            : UI.stat('Unrealized', usd0(unreal, { sign: true }), `${openRows.length} open · at the live mark, before fees`, U.pnlClass(unreal)),
          UI.stat('Delay cost', usd0(delay, { sign: true }), `${usd0(T.driftLive, { sign: true })} measured on ${T.liveFills} live fill${T.liveFills === 1 ? '' : 's'} · ${usd0(T.driftModeled, { sign: true })} modelled on ${T.caughtUp} caught up`, delay > 0 ? 'neg' : delay < 0 ? 'pos' : ''),
          UI.stat('Fees & slippage', usd0(T.fees + T.slip), `${usd0(T.fees)} fees · ${usd0(T.slip)} slippage`, 'neg'),
          UI.stat('Funding', usd0(T.funding, { sign: true }), 'accrued each minute at each market\'s latest hourly rate while a tab follows', U.pnlClass(T.funding)));
        const tickOf = (pid) => (ref.byId[pid] || {}).tickSize;
        const openTbl = UI.table({ cols: [
          { key: 'm', label: 'Market', render: (p) => UI.marketCell(p.ticker) },
          { key: 's', label: 'Side', render: (p) => U.sideEl(p.qty > 0, true) },
          { key: 'q', label: 'Size', num: true, render: (p) => h('span', U.fmtQty(Math.abs(p.qty)), p.basis != null ? h('span.dim.xs', { title: 'what the position now held cost at its entry prices' }, ' · ' + usd0(Math.abs(p.basis))) : null) },
          { key: 'e', label: 'Avg entry', num: true, render: (p) => (p.basis != null && p.qty ? U.fmtPrice(Math.abs(p.basis / p.qty), tickOf(p.pid)) : h('span.dim', '—')) },
          { key: 'mk', label: 'Mark', num: true, render: (p) => (mk[p.pid] ? U.fmtPrice(mk[p.pid], tickOf(p.pid)) : h('span.dim', '—')) },
          { key: 'u', label: 'Unrealized', num: true, render: (p) => (!mk[p.pid] ? h('span.dim', '—') : p.basis != null ? U.pnlEl(p.qty * mk[p.pid] - p.basis, { dp: 2 }) : h('span', { title: 'kept before this page split them: incl. partial closes, fees and funding (Rebuild to split it)' }, U.pnlEl(p.cash + p.qty * mk[p.pid] - p.fees + p.funding, { dp: 2 }))) },
          { key: 't', label: 'Since', render: (p) => h('span.dim', U.fmtAgo(p.openedAt)) },
        ], rows: openRows, empty: 'No open virtual position' });
        const tickOfT = (t) => (ref.products.find((p) => p.displayTicker === t) || {}).tickSize;   // log rows hold display tickers; ref.byTicker is keyed by the raw ones
        const logTbl = UI.table({ cols: [
          { key: 't', label: 'Time', render: (r) => h('span.dim', U.fmtFeedTime ? U.fmtFeedTime(r.t) : U.fmtAgo(r.t)) },
          { key: 'm', label: 'Market', render: (r) => UI.marketCell(r.ticker) },
          { key: 's', label: 'Side', render: (r) => U.sideEl(r.side === 'BUY') },
          { key: 'q', label: 'Size', num: true, render: (r) => U.fmtQty(r.qty) },
          { key: 'lp', label: 'Leader px', num: true, render: (r) => U.fmtPrice(r.leaderPx, tickOfT(r.ticker)) },
          { key: 'cp', label: 'Copier px', num: true, render: (r) => U.fmtPrice(r.px, tickOfT(r.ticker)) },
          { key: 'd', label: 'Wait cost', num: true, title: 'What the price move between the leader\'s fill and the copy cost the copier (+ = a worse price, − = a better one)', render: (r) => (Math.abs(r.drift) < 0.005 ? h('span.dim', '—') : h('span', { class: r.drift > 0 ? 'neg' : 'pos' }, U.fmtUsd(r.drift, { sign: true, dp: 2 }))) },
          { key: 'f', label: 'Fee', num: true, render: (r) => U.fmtUsd(r.fee, { dp: 2 }) },
          { key: 'k', label: '', render: (r) => h('span', r.why ? UI.chip(r.closed ? 'closed at mark' : 'cut at mark', 'amber') : r.live ? UI.chip('live', 'blue') : UI.chip('caught up', ''), r.closed ? h('span.dim.xs', ' closed ' + U.fmtUsd(r.closed.net, { sign: true, dp: 2 })) : null, r.why ? h('span.dim.xs', { title: r.why }, ' ⓘ') : null) },
        ], rows: paper.log.slice(0, 30), empty: 'No fills mirrored yet' });
        const rebuildBtn = h('button.btn.sm.ghost', { title: 'Recompute this account from the exchange\'s fills since it started, at candle prices, from the leader\'s positions at that moment', onclick: async () => {
          if (rebuilding || !confirm('Recompute this paper account from the exchange\'s fills since ' + U.fmtDateTime(paper.startedAt) + '? Fills mirrored live are recomputed at candle prices, and funding is kept only for positions still open.')) return;
          rebuilding = true; renderPaper();
          try { const n = await rebuild(); if (n != null) U.toast(`Rebuilt from ${n} fill${n === 1 ? '' : 's'} of the leader`); } catch (e) { if (!isAbort(e)) U.toast('Rebuild failed: ' + (e.message || e)); }
          finally { rebuilding = false; }
          renderPaper(); if (paper) scheduleSync(0);
        } }, rebuilding ? [h('span.spinner.sm'), ' Rebuilding…'] : [U.icon('refresh'), 'Rebuild']);
        rebuildBtn.disabled = rebuilding;
        // an account kept by an earlier version of this page could have mirrored a leader's sell of a position opened
        // before following as a new short (and closed it at the mark later): offer to recompute it
        const oldNote = (paper.v || 0) < PP.V ? h('div.small', { style: { color: 'var(--amber)', margin: '0 0 10px' } }, 'This paper account was kept by an earlier version of this page, which mirrored the leader cutting or closing a position it already held when you started following as a new position of yours. ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); rebuildBtn.click(); } }, 'Rebuild it'), ' from the exchange\'s fills to correct that.') : null;
        U.replace(paperCard,
          h('div.row.wrap', { style: { marginBottom: '8px', gap: '8px' } }, h('h2', 'Paper copy'), UI.chip(unsubs.length ? 'following' : 'paused', unsubs.length ? 'green' : 'amber'), h('span.dim.small', `since ${U.fmtDateTime(paper.startedAt)} · ${paper.settings.mode === 'fixed' ? usd0(paper.settings.size) + ' per position' : paper.settings.mode === 'perfill' ? usd0(paper.settings.size) + ' per fill' : U.fmtNum(paper.settings.ratio * 100, 1) + '% of the leader'} · ${paper.settings.delay ? paper.settings.delay + ' s' : 'no'} delay` + (paper.settings.markets ? ' · ' + paper.settings.markets.map((id) => (ref.byId[id] || {}).displayTicker || id).join(', ') + ' only' : '') + (pending ? ` · ${pending} fill${pending > 1 ? 's' : ''} waiting` : '')), h('span.grow'),
            rebuildBtn,
            h('button.btn.sm.ghost', { disabled: rebuilding, onclick: () => { if (confirm('Stop following and discard this paper account?')) { stopAll(); PP.clear(sid); paper = null; announced.clear(); pending = 0; renderPaper(); } } }, 'Stop & discard')),
          oldNote,
          tiles,
          h('div.grid.cols-2', { style: { marginTop: '12px' } }, UI.card('Open virtual positions', openTbl), UI.card('Mirrored fills', logTbl, h('span.dim.small', 'newest first'))),
          h('div.footer-note', { style: { textAlign: 'left', paddingBottom: 0 } }, 'A paper account shows what following would have done from the moment it started, by this page\'s rules; it is not the exchange, so partial fills, rejections and your own market impact are not in it. Funding is accrued only while a tab follows.'));
      }
      // the exchange's clock and the stream first, then the catch-up: a fill during the catch-up is announced, not lost
      if (paper) { renderPaper(); try { await syncClock(); attach(); const n = await sync(); if (n) U.toast(`Caught up ${n} fill${n > 1 ? 's' : ''} from the exchange`); } catch (e) { if (isAbort(e)) return; } renderPaper(); }
      else renderPaper();
      await run();
    },
  };
})();
