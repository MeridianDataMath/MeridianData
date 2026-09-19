/* MeridianDataHub — Copy trading, phase 1: leaders ranked by copyability (what a follower would actually keep), with the
   full breakdown behind every score. Nothing here places orders; that is the copy agent of a later phase. */
(function () {
  const MD = window.MD; const U = MD.util; const AN = MD.analytics; const UI = MD.ui; const h = U.h;

  const ROADMAP = [
    { t: 'Leaders & copyability', d: 'Every wallet scored on track record, copy friction (fees, drift, slippage at its size) and activity, with the numbers behind each score.', s: 'live' },
    { t: 'Watchlist', d: 'Star a wallet to keep it on your Favorites page with live equity and open positions.', s: 'live' },
    { t: 'Copy simulator', d: 'Replay a leader\'s fills with your size, delay and slippage, or paper-copy them live for a week before risking anything.', s: 'building' },
    { t: 'Leader alerts', d: 'A push when a leader opens, closes or gets liquidated, straight from the exchange WebSocket.', s: 'planned' },
    { t: 'Copy agent', d: 'A local service with a Meridian linked signer (trade-only key, no withdrawals) mirroring leaders into your own subaccount with size and risk limits.', s: 'planned' },
    { t: 'Copy history', d: 'PnL attribution per leader and your realized slippage versus the leader\'s fills.', s: 'planned' },
  ];
  const STATUS = { live: ['live', 'green'], building: ['in progress', 'accent'], planned: ['planned', ''] };
  const VERDICT_CLS = { 'Copyable': 'green', 'Copy with care': 'amber', 'Hard to copy': 'red', 'Losing so far': 'red' };
  const PILLARS = [['track', 'Track record', 'is there an edge, and is it steady'], ['friction', 'Copy friction', 'how much of it survives being copied a minute later at this size'], ['activity', 'Activity', 'is the account still trading']];
  const usd0 = (v) => U.fmtUsd(v || 0, { compact: true, dp: 0 });
  const bps = (v, opts) => (v == null ? h('span.dim', '—') : h('span', { class: 'num ' + (opts && opts.cost ? (v > 0 ? 'neg' : '') : U.pnlClass(v)) }, (opts && opts.sign && v > 0 ? '+' : '') + U.fmtNum(v, 1) + ' bps'));

  /** The score as a pill: number + verdict; "—" with the reason when there is none. */
  function scorePill(sc, c) {
    if (!sc) return h('span.dim.small', { title: 'Fewer than 5 closed positions: nothing to score yet' }, c ? `${c.closed} closed · too few` : 'no profile');
    return h('div.row', { style: { gap: '8px' }, title: sc.caps.length ? 'Capped: ' + sc.caps.map((x) => x.why).join(' · ') : `track ${sc.track} · friction ${sc.friction} · activity ${sc.activity}` }, h('span.score', { class: VERDICT_CLS[sc.verdict] || '' }, String(sc.total)), h('span.chip', { class: VERDICT_CLS[sc.verdict] || '' }, sc.verdict));
  }

  /** The full story behind one leader's score. */
  function openLeader(r, sc) {
    const c = r.copy; const s = (r.stats && r.stats.all) || {};
    const barRow = (label, v, note) => h('div.score-part', h('div.row', { style: { gap: '8px' } }, h('span', label), h('span.grow'), h('span.dim.small', v == null ? 'not measured' : U.fmtPct(v * 100, { dp: 0 }))), h('div.bar', h('i', { class: v == null ? '' : v < 0.34 ? 'bad' : v < 0.67 ? 'warn' : '', style: { width: (v == null ? 0 : v * 100) + '%' } })), h('div.dim.xs', note));
    const pillars = h('div.grid.cols-3', PILLARS.map(([key, label, sub]) => h('div.card.tight', { style: { padding: '12px 14px' } },
      h('div.row', h('h3', label), h('span.grow'), h('span.score.sm', { class: sc[key] >= 67 ? 'green' : sc[key] >= 34 ? 'amber' : 'red' }, String(sc[key]))),
      h('div.dim.xs', { style: { marginBottom: '8px' } }, sub),
      h('div.stack', { style: { gap: '8px' } }, sc.parts.filter((p) => p.pillar === key).map((p) => barRow(p.label, p.v, p.note))))));
    // what is left for a copier, per position, in bps of entry notional
    const wf = c.copyBps != null ? [
      ['Leader, per position', c.netTrimBps, `${U.fmtNum(c.grossTrimBps, 1)} bps gross − ${U.fmtNum(c.feesBps, 1)} their fees` + (c.fundPosBps ? ` ${c.fundPosBps > 0 ? '+' : '−'} ${U.fmtNum(Math.abs(c.fundPosBps), 1)} funding` : '') + ' · plain mean over positions, both tails winsorized at 5% / 95% so one jackpot or blow-up cannot carry it'],
      ['+ Their fees back', c.feesBps, 'a copier pays its own fees instead'],
      ['− Copier taker fees', -2 * c.feeBps, `${U.fmtNum(c.feeBps, 1)} bps in and out`],
      ['− Price drift after their fills', -2 * c.drift1, `${U.fmtNum(c.drift1, 1)} bps per fill one minute later, in and out · measured over ${U.fmtNum(c.driftN, 0)} fills (${U.fmtNum(c.drift5, 1)} bps after five minutes)`],
      ['− Slippage for a copier', -2 * c.slipBps, `${U.fmtNum(c.slipBps, 1)} bps to fill ${usd0(c.copySize)} against today's books, in and out` + (c.slipOwnBps != null && c.slipOwnBps > c.slipBps ? ` · ${U.fmtNum(c.slipOwnBps, 1)} bps at their own ${usd0(c.notMed)}` : '')],
      ['= Copier, per position', c.copyBps, c.netTrimBps <= 0 ? 'the leader\'s positions lose after fees, so there is no edge to keep' : c.edgeLeft <= 0 ? 'nothing survives: the copier\'s costs exceed the leader\'s result' : `${U.fmtPct(c.edgeLeft, { dp: 0 })} of the leader's result survives`],
    ] : null;
    const wfTbl = wf ? UI.table({ cols: [
      { key: 'k', label: 'Per position, on entry notional', render: (x) => h('span', { class: /^=/.test(x[0]) ? 'bold' : '' }, x[0]) },
      { key: 'v', label: 'bps', num: true, render: (x) => h('span', { class: 'num ' + (/^=|Leader/.test(x[0]) ? U.pnlClass(x[1]) : x[1] < 0 ? 'neg' : '') }, (x[1] > 0 ? '+' : '') + U.fmtNum(x[1], 1)) },
      { key: 'n', label: '', render: (x) => h('span.dim.small', x[2]) },
    ], rows: wf }) : h('div.empty', 'The frictions are measured from the leader\'s fills against one-minute oracle candles and today\'s books; this account has too few fills for that yet.');
    const holdTotal = c.closed || 1;
    const holdBar = h('div.hold-bar', [['scalp', 'under 1h'], ['intra', '1h – 1d'], ['swing', '1 – 7d'], ['long', 'over 7d']].map(([k, label]) => { const n = c.hold[k]; return n ? h('span', { class: k, style: { flex: String(n) }, title: `${n} positions held ${label}` }, n / holdTotal > 0.12 ? U.fmtPct((n / holdTotal) * 100, { dp: 0 }) : '') : null; }));
    const kv = (pairs) => h('div.kv', { style: { marginTop: '8px' } }, pairs.map(([k, v]) => [h('span.k', k), h('div', v)]));
    const facts = h('div.grid.cols-2',
      h('div.card.tight', { style: { padding: '12px 14px' } }, h('h3', 'How they trade'), kv([
        ['Hold times', h('div', holdBar, h('div.dim.xs', { style: { marginTop: '4px' } }, 'scalps · intraday · swing · long · median ' + (c.holdMed == null ? '—' : U.fmtDuration(c.holdMed))))],
        ['Typical size', h('span', usd0(c.notMed), h('span.dim.small', ` median · ${usd0(c.notP90)} at the 90th percentile` + (c.lev ? ` · ${U.fmtNum(c.lev, 1)}× equity` : '')))],
        ['Markets', h('div.row.wrap', { style: { gap: '4px' } }, c.markets.map((m) => UI.chip(`${m.t} ${U.fmtPct(m.share, { dp: 0 })}`, '')))],
        ['Positions', h('span', `${c.closed} closed · ${c.open} open · ${c.closed30} closed in 30d` + (c.liq ? ` · ${c.liq} liquidated` : '') + (c.adl ? ` · ${c.adl} deleveraged` : ''))],
        ['Per position', h('span', bps(c.netTrimBps, { sign: true }), h('span.dim.small', ' after fees and funding · '), bps(c.grossMedBps, { sign: true }), h('span.dim.small', ' median gross' + (c.tStat != null ? ` · t = ${U.fmtNum(c.tStat, 1)}` : '')))]])),
      h('div.card.tight', { style: { padding: '12px 14px' } }, h('h3', 'Track record'), kv([
        ['All-time PnL', h('span', U.pnlEl(s.pnl, { dp: 0 }), h('span.dim.small', s.roi == null ? '' : ` · ROI ${U.fmtPct(s.roi, { dp: 1, sign: true })}`))],
        ['Win rate', h('span', r.winRate == null ? '—' : U.fmtPct(r.winRate, { dp: 0 }), h('span.dim.small', c.top == null ? '' : ` · largest win ${U.fmtPct(c.top, { dp: 0 })} of all wins`))],
        ['Consistency', h('span', c.weeksActive ? `${c.weeksPos} of ${c.weeksActive} active weeks profitable` : '—')],
        ['Drawdown', h('span', s.ddPct == null || !(s.ddPct > 0) ? '—' : U.fmtDd(s.ddPct))],
        ['Activity', h('span', (c.lastAt ? 'last trade ' + U.fmtAgo(c.lastAt) : '—') + (c.tenureD != null ? ` · ${U.fmtNum(c.tenureD, 0)} days on the exchange` : '') + (c.perWeek != null ? ` · ${U.fmtNum(c.perWeek, c.perWeek >= 10 ? 0 : 1)} closed / week` : ''))]])));
    UI.modal({ wide: true,
      title: h('div.row', { style: { gap: '10px' } }, UI.starBtn({ address: r.account, subaccountId: r.sid, name: r.name }), h('span', U.shortAddr(r.account, 6)), U.copyBtn(r.account), scorePill(sc, c), h('span.grow'), h('a.btn.sm', { href: U.accountUrl(r.account, r.sid) }, 'Account page'), h('a.btn.sm.ghost', { href: '#/tax?address=' + r.account + '&sub=' + r.sid }, 'Tax')),
      body: h('div.stack',
        h('div.dim.small', 'Copyability ' + sc.total + ' = 35% track record (' + sc.track + ') + 45% copy friction (' + sc.friction + ') + 20% activity (' + sc.activity + ')' + (sc.losing ? ', scaled down and capped at 45 while the account is not profitable' : '') + '. Parts that cannot be measured are left out of their pillar, not counted as zero.'),
        sc.caps.length ? h('div.small', { style: { color: 'var(--amber)' } }, 'Capped: ', sc.caps.map((x, i) => [i ? ' · ' : null, `${x.at} — ${x.why}`])) : null,
        pillars,
        UI.card('What is left for a copier', wfTbl, h('span.dim.small', `the same moves one minute later, at taker fees, with a ${usd0(c.copySize)} position`)),
        facts,
        h('div.footer-note', { style: { textAlign: 'left', paddingBottom: 0 } }, 'From the public Meridian API: this account\'s positions and fills, one-minute oracle candles after each fill, and the order books as they were when the snapshot was built. Past results are not a promise of future returns; copyability says how much of a result a copier could have kept, not whether there will be one.')) });
  }

  MD.router.pages.copytrade = {
    async mount(root, route, ctx) {
      MD.setTopbar(h('span.title', 'Copy trading'));
      const LB = MD.router.pages.leaderboard;
      const tableWrap = h('div');
      const summary = h('span.dim.small');
      const state = { filter: route.params.show || 'scored', sort: { key: 'score', desc: true } };
      const hero = h('div.card.ct-hero',
        h('div.row', { style: { marginBottom: '8px' } }, UI.chip('Phase 1 · leaders', 'accent'), h('span.dim.small', 'scouting and scoring; the copy agent comes next')),
        h('h1', 'Copy trading on Meridian'),
        h('p', 'A leaderboard tells you who made money. Copying needs a different question: what would a follower have kept, entering a minute later, at taker fees, at that size, against these books? Every wallet below is scored on exactly that, and the numbers behind each score are one click away.'),
        h('p', 'Nothing on this page places orders. The plan stays non-custodial: a copy agent you run yourself with a Meridian linked signer (a trade-only key that cannot withdraw), with this page as its control room.'));
      const roadmap = h('div.card', h('h3', { style: { marginBottom: '10px' } }, 'Roadmap'),
        h('div.roadmap', ROADMAP.map((r) => h('div.it', h('div.row', h('span.t', r.t), h('span.grow'), UI.chip(STATUS[r.s][0], STATUS[r.s][1])), h('div.d', r.d)))));
      const filterSeg = UI.seg([{ v: 'all', label: 'All traders' }, { v: 'scored', label: 'Scored' }, { v: 'copyable', label: 'Copyable' }], state.filter, (v) => { state.filter = v; MD.router.setParams({ show: v === 'scored' ? null : v }, { silent: true }); render(); }, 'sm');
      const leaders = h('div.card.tight', h('div.card-head', h('h2', 'Leaders by copyability'), summary, h('span.grow'), filterSeg, MD.defsLink()), tableWrap);
      U.replace(root, h('div.page', h('div.stack', hero, leaders, roadmap, h('div.footer-note', 'Scores come from the published snapshot (rebuilt every 30 minutes): the same positions and PnL as the Leaderboard, plus each account\'s fills, one-minute oracle candles after them, and the order books at build time. Past performance is not a promise of future returns.'))));
      ctx.onCleanup(U.on('favorites', () => render()));

      let data = null;
      try { data = LB ? await LB.loadRemote() : null; } catch (_) {}
      if (ctx.signal.aborted) return;
      const local = LB && LB.cache();
      if (!data && local) data = local;   // a browser-built leaderboard has no copy profiles, but it is better than nothing

      function render() {
        if (!data || !data.rows) {
          U.replace(tableWrap, h('div.empty', h('div', { style: { marginBottom: '10px' } }, 'No leaderboard snapshot yet.'), h('a.btn.primary', { href: '#/leaderboard' }, 'Open the leaderboard')));
          U.replace(summary, ''); return;
        }
        const traders = data.rows.filter((r) => !r.inactive && r.stats && r.stats.all && !AN.noTrades(r));
        const scored = traders.map((r) => ({ r, sc: AN.copyScore(r), c: r.copy }));
        let rows = scored;
        if (state.filter === 'scored') rows = rows.filter((x) => x.sc);
        if (state.filter === 'copyable') rows = rows.filter((x) => x.sc && x.sc.total >= 70);
        const val = (x, k) => { const s = x.r.stats.all, c = x.c || {}; switch (k) { case 'score': return x.sc ? x.sc.total : null; case 'edge': return c.edgeLeft; case 'pnl': return s.pnl; case 'roi': return s.roi; case 'winRate': return x.r.winRate; case 'closed': return c.closed != null ? c.closed : x.r.closedCount; case 'hold': return c.holdMed; case 'size': return c.notMed; case 'dd': return s.ddPct; case 'last': return c.lastAt; default: return null; } };
        rows = U.sortBy(rows, (x) => val(x, state.sort.key), state.sort.desc);
        if (state.sort.key === 'score') rows = rows.slice().sort((a, b) => { const d = (b.sc ? b.sc.total : -1) - (a.sc ? a.sc.total : -1); return (state.sort.desc ? d : -d) || (b.r.stats.all.pnl - a.r.stats.all.pnl); });
        const onSort = (k) => { if (state.sort.key === k) state.sort.desc = !state.sort.desc; else state.sort = { key: k, desc: true }; render(); };
        const noProfiles = !traders.some((r) => r.copy);
        U.replace(tableWrap,
          noProfiles ? h('div.small.muted', { style: { padding: '10px 14px', borderBottom: '1px solid var(--border-2)' } }, data.remote ? 'This snapshot predates copyability; the next one (within 30 minutes) will carry the profiles.' : 'A leaderboard built in the browser has no copy profiles; scores need the published snapshot.') : null,
          UI.table({
            sort: state.sort, onSort,
            cols: [
              { key: 'rank', label: '#', render: (x) => { const i = rows.indexOf(x) + 1; return h('span.rank', { class: i <= 3 && x.sc && x.sc.total >= 70 ? 'top' : '' }, String(i)); } },
              { key: 'w', label: 'Wallet', render: (x) => h('div.row', { style: { gap: '6px' } }, UI.starBtn({ address: x.r.account, subaccountId: x.r.sid, name: x.r.name }), U.addrLink(x.r.account, x.r.sid), U.copyBtn(x.r.account)) },
              { key: 'score', label: 'Copyability', sortVal: 1, title: '0–100: track record, copy friction and activity; click a row for the breakdown', render: (x) => scorePill(x.sc, x.c) },
              { key: 'edge', label: 'Edge left', num: true, sortVal: 1, title: 'Share of the leader\'s per-position result (after fees and funding) that survives a copier\'s taker fees, the one-minute drift after their fills and slippage for a $2K position', render: (x) => (x.c && x.c.edgeLeft != null ? h('span', { class: 'num ' + (x.c.edgeLeft >= 50 ? 'pos' : x.c.edgeLeft > 0 ? '' : 'neg') }, U.fmtPct(x.c.edgeLeft, { dp: 0 })) : h('span.dim', '—')) },
              { key: 'pnl', label: 'All-time PnL', num: true, sortVal: 1, render: (x) => U.pnlEl(x.r.stats.all.pnl, { dp: 0 }) },
              { key: 'roi', label: 'ROI', num: true, sortVal: 1, render: (x) => UI.pct(x.r.stats.all.roi, { dp: 1 }) },
              { key: 'winRate', label: 'Win rate', num: true, sortVal: 1, render: (x) => (x.r.winRate == null ? h('span.dim', '—') : U.fmtPct(x.r.winRate, { dp: 0 })) },
              { key: 'closed', label: 'Closed', num: true, sortVal: 1, title: 'Closed positions · last trade', render: (x) => h('div', { style: { lineHeight: '1.25' } }, String(val(x, 'closed') || 0), x.c && x.c.lastAt ? h('div.xs.dim', { style: { whiteSpace: 'nowrap' } }, U.fmtAgo(x.c.lastAt)) : null) },
              { key: 'hold', label: 'Median hold', num: true, sortVal: 1, render: (x) => (x.c && x.c.holdMed != null ? U.fmtDuration(x.c.holdMed) : h('span.dim', '—')) },
              { key: 'size', label: 'Typical size', num: true, sortVal: 1, title: 'Median entry notional per position', render: (x) => (x.c && x.c.notMed ? usd0(x.c.notMed) : h('span.dim', '—')) },
              { key: 'mk', label: 'Markets', render: (x) => (x.c && x.c.markets.length ? h('div.row.wrap', { style: { gap: '4px' } }, x.c.markets.slice(0, 2).map((m) => UI.chip(m.t, '')), x.c.nMarkets > 2 ? h('span.dim.xs', '+' + (x.c.nMarkets - 2)) : null) : h('span.dim', '—')) },
              { key: 'dd', label: 'Max DD', num: true, sortVal: 1, render: (x) => { const v = x.r.stats.all.ddPct; return v == null || !(v > 0) ? h('span.dim', '—') : U.fmtDd(v); } },
              { key: 'go', label: '', render: (x) => h('a.btn.sm', { href: U.accountUrl(x.r.account, x.r.sid), onclick: (e) => e.stopPropagation() }, 'Scout') },
            ],
            rows, empty: state.filter === 'copyable' ? 'No wallet scores 70 or more yet' : state.filter === 'scored' ? 'No wallet has 5 closed positions yet' : 'No traders in the snapshot',
            onRow: (x) => { if (x.sc) openLeader(x.r, x.sc); else location.hash = U.accountUrl(x.r.account, x.r.sid).slice(1); },
          }));
        const copyable = scored.filter((x) => x.sc && x.sc.total >= 70).length, nScored = scored.filter((x) => x.sc).length;
        U.replace(summary, `${rows.length} of ${traders.length} traders · ${nScored} scored · ${copyable} copyable · snapshot ${U.fmtAgo(data.builtAt)}`, UI.staleNote(data.builtAt, 'the publishing job may be down'));
      }
      render();
      // keep the page current with the published snapshot
      const tick = setInterval(async () => { if (ctx.signal.aborted) return; const d = await LB.loadRemote(); if (d && data && d.builtAt !== data.builtAt) { data = d; render(); } }, 60000);
      ctx.onCleanup(() => clearInterval(tick));
    },
  };
})();
