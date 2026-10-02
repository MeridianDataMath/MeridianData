/* MeridianDataHub — Data status (#/status): are the published snapshots fresh, and is the exchange answering? The perps
   snapshot is built by GitHub Actions every 30 minutes, the Predict snapshot on a PC (the Predict API refuses datacenter
   IPs) and pushed to the "snapshots" branch; each carries its own build time, so their age is read from the files. */
(function () {
  const MD = window.MD; const U = MD.util; const A = MD.api; const UI = MD.ui; const h = U.h;
  const isAbort = (e) => e && e.name === 'AbortError';
  const LATE_MS = 45 * 60000;   // a build every 30 minutes that GitHub often starts late

  /** fresh / late / stale / missing, with the colour the chip takes */
  const ageState = (builtAt) => {
    if (!builtAt) return ['not published', 'red'];
    const age = Date.now() - builtAt;
    return age > UI.STALE_MS ? ['stale', 'red'] : age > LATE_MS ? ['late', 'amber'] : ['fresh', 'green'];
  };
  const kv = (pairs) => h('div.kv.wrap-v', pairs.filter(Boolean).map(([k, v, cls]) => [h('span.k', k), h('span.v', { class: cls || '' }, v)]));
  const when = (t) => (t ? `${U.fmtAgo(t)} · ${U.fmtDateTime(t)}` : '—');

  MD.router.pages.status = {
    async mount(root, route, ctx) {
      MD.setTopbar(h('span.title', 'Data status'));
      const perps = h('div.card', UI.loading('Reading the perps snapshot…'));
      const predict = h('div.card', UI.loading('Reading the Predict snapshot…'));
      const api = h('div.card', UI.loading('Pinging the exchange…'));
      U.replace(root, h('div.page', h('div.stack',
        h('div.card', h('h1', { style: { margin: '0 0 6px', fontSize: '20px' } }, 'Is the data current?'),
          h('p.muted', { style: { margin: 0, maxWidth: '820px' } }, 'Live pages (accounts, dashboard, order books) read the exchange directly. The leaderboard, copyability scores and the Predict section read published snapshots: the perps one is rebuilt by GitHub Actions every 30 minutes, the Predict one every 30 minutes on the site owner\'s PC (the Predict API refuses requests from datacenter addresses), and both are published with the site. This page shows how old each one is right now.')),
        h('div.grid.cols-3', perps, predict, api),
        h('div.footer-note', 'Times in your local time zone. "Late" means the last build is older than 45 minutes, "stale" older than two hours. A stale snapshot is also flagged on the Leaderboard, Copy trading, the Predict Overview, Bettors, Questions, Market makers and Vig & edge pages, and on slip pages.'))));

      // ---- perps snapshot (data/leaderboard.json, ~30 KB, already cached by the leaderboard page)
      (async () => {
        try {
          const LB = MD.router.pages.leaderboard; const s = LB ? await LB.loadRemote(true) : null;
          if (ctx.signal.aborted) return;
          const [state, cls] = ageState(s && s.builtAt);
          U.replace(perps, h('div.row', { style: { marginBottom: '10px', gap: '8px' } }, h('h2', 'Perps snapshot'), UI.chip(state, cls)),
            s ? kv([
              ['Built', when(s.builtAt)],
              ['Builder', s.source === 'github-actions' ? 'GitHub Actions' : s.source === 'local' ? 'a local run' : s.source || '—'],
              ['Accounts', `${U.fmtNum(s.rows.length, 0)} of ${U.fmtNum(s.accounts || s.rows.length, 0)}` + (s.failed ? ` · ${s.failed} failed` : '') + (s.skipped ? ` · ${s.skipped} not reached in the ${U.fmtDuration((s.budgetS || 0) * 1000)} budget` : '') + (s.partial ? ' · partial' : ''), s.failed || s.skipped ? 'neg' : ''],
              ['Copy profiles', `${U.fmtNum(s.rows.filter((r) => r.copy && r.copy.driftN).length, 0)} accounts with their price move after a fill measured`],
              s.durationMs ? ['Build took', U.fmtDuration(s.durationMs)] : null,
            ]) : h('div.empty', 'No published perps snapshot: the leaderboard is built in each visitor\'s browser instead.'),
            h('div.dim.xs', { style: { marginTop: '10px' } }, 'Used by: Leaderboard, Copy trading (scores, also in the simulator), Home (top wallets), Favorites (PnL 30d), Dashboard (stop map account list).'));
        } catch (e) { if (!isAbort(e)) U.replace(perps, UI.error(e)); }
      })();

      // ---- Predict snapshot (data/predict-status.json, a few hundred bytes written next to the 1 MB snapshot)
      (async () => {
        try {
          let s = null;
          // (the host answers unknown paths with the app's index.html, status 200: only JSON counts)
          try { const r = await fetch('data/predict-status.json', { cache: 'no-cache', signal: ctx.signal }); if (r.ok && /json/i.test(r.headers.get('content-type') || '')) s = await r.json(); } catch (e) { if (isAbort(e)) return; }
          // a publish from before the status file existed: read the snapshot's own header (the 1 MB the Predict pages load anyway)
          if (!s && MD.predict && MD.predict.loadSnapshot) {
            U.replace(predict, UI.loading('No status file yet: reading the Predict snapshot itself…'));
            try { const p = await MD.predict.loadSnapshot({ signal: ctx.signal }); const cov = p && p.agg && p.agg.vig ? p.agg.vig.coverage : null; if (p && p.remote) s = { builtAt: p.builtAt, source: p.source, predictions: p.predictions, apiTotal: p.apiTotal, preLaunch: p.preLaunch, bettors: p.agg && p.agg.bettors.length, makers: p.agg && MD.predict.splitMakers(p.agg.makers).makers.length, questions: p.questionsWithOi && p.questionsWithOi.length, recentFrom: p.recentFrom, selfMatched: p.agg && p.agg.totals.selfMatched, vigCoverage: cov ? cov.withAtBet : null, vigTotal: cov ? cov.total : null, vigClean: cov ? cov.clean : null, vigSameEvent: cov ? cov.sameEvent : null, requests: p.requests, retries: p.retries, durationMs: p.durationMs }; } catch (e) { if (isAbort(e)) return; }
          }
          if (ctx.signal.aborted) return;
          const [state, cls] = s && s.error ? ['failed', 'red'] : ageState(s && s.builtAt);
          U.replace(predict, h('div.row', { style: { marginBottom: '10px', gap: '8px' } }, h('h2', 'Predict snapshot'), UI.chip(state, cls)),
            s ? kv([
              ['Built', when(s.builtAt)],
              ['Builder', s.source === 'pc' ? 'the site owner\'s PC' : s.source === 'github-actions' ? 'GitHub Actions' : s.source || '—'],
              s.error ? ['Error', s.error, 'neg'] : null,
              s.predictions != null ? ['Predictions', `${U.fmtNum(s.predictions, 0)}` + (s.apiTotal ? ` of ${U.fmtNum(s.apiTotal, 0)} the API counts` : '') + (s.preLaunch ? ` · ${s.preLaunch} dated before launch (29 Jun 2026) left out` : '') + (s.selfMatched ? ` · ${s.selfMatched} self-matched (one wallet on both sides) left out of the Predict figures` : ''), s.apiTotal && s.predictions < s.apiTotal - (s.preLaunch || 0) - 50 ? 'neg' : ''] : null,
              s.bettors != null ? ['Bettors · market makers', `${U.fmtNum(s.bettors, 0)} · ${U.fmtNum(s.makers || 0, 0)}`] : null,
              // the tail is the questions of recently settled predictions (a lost combo's other legs may not be settled yet), not recently settled questions
              s.questions != null ? ['Questions page list', (s.questionsLive != null ? `${U.fmtNum(s.questions, 0)}: ${U.fmtNum(s.questionsLive, 0)} with money on them, then the ${U.fmtNum(s.questions - s.questionsLive, 0)} other questions of the most recently settled predictions` : `${U.fmtNum(s.questions, 0)}: the questions with money on them, then those of the most recently settled predictions`) + (s.recentFrom ? ` (settled since ${U.fmtDateTime(s.recentFrom)})` : '')] : null,
              // predictions with the source market's price at the moment of the bet (the vig needs it), on the base the Vig & edge page uses
              s.vigCoverage != null ? ['Priced at bet time', `${U.fmtNum(s.vigCoverage, 0)} of ${U.fmtNum(s.vigTotal != null ? s.vigTotal : s.predictions - (s.selfMatched || 0), 0)}` + (s.vigClean != null ? ` · ${U.fmtNum(s.vigClean, 0)} in the vig figures, ${U.fmtNum(s.vigSameEvent || 0, 0)} combos with legs on one match or asset shown apart` : '')] : null,
              s.requests != null ? ['API requests', `${U.fmtNum(s.requests, 0)}` + (s.retries ? ` · ${s.retries} retried` : '')] : null,
              s.durationMs ? ['Build took', U.fmtDuration(s.durationMs)] : null,
            ]) : h('div.empty', 'No Predict snapshot published yet.'),
            h('div.dim.xs', { style: { marginTop: '10px' } }, 'Used by: every Predict page, the Predict tab of an account, the tax center\'s Predict ledger, and the Predict ideas on Copy trading.'));
        } catch (e) { if (!isAbort(e)) U.replace(predict, UI.error(e)); }
      })();

      // ---- the exchange itself: round trip to /v1/time, clock offset, maintenance flag, WebSocket state
      (async () => {
        try {
          const t0 = Date.now(); const t = await A.serverTime({ signal: ctx.signal }); const rtt = Date.now() - t0;
          const offset = U.num(t && t.time) - (t0 + rtt / 2);
          const m = await A.maintenance({ signal: ctx.signal }).catch(() => null);
          if (ctx.signal.aborted) return;
          const ws = h('span');
          ctx.onCleanup(A.ws.onStatus((s) => { ws.textContent = s === 'open' ? 'connected' : s; }));
          // the flag is known only when the exchange answered with one; a failed check says so instead of "off"
          const known = !!m && typeof m.isEnabled === 'boolean'; const maint = known && m.isEnabled;
          const alerting = !!(MD.alerts && MD.alerts.isOwner && MD.alerts.isOwner() && (MD.alerts.state().leaders || []).length);
          U.replace(api, h('div.row', { style: { marginBottom: '10px', gap: '8px' } }, h('h2', 'Exchange API'), UI.chip(maint ? 'maintenance' : 'answering', maint ? 'amber' : 'green')),
            kv([
              ['Round trip', `${rtt} ms`],
              ['Your clock', Math.abs(offset) < 1000 ? 'within 1 s of the exchange' : `${(Math.abs(offset) / 1000).toFixed(1)} s ${offset > 0 ? 'behind' : 'ahead of'} the exchange`, Math.abs(offset) > 5000 ? 'neg' : ''],
              ['Maintenance', !known ? 'unknown (the maintenance check did not answer)' : maint ? 'on (the exchange reports maintenance mode)' : 'off', maint ? 'neg' : !known ? 'dim' : ''],
              ['WebSocket (this tab)', ws],
            ]),
            h('div.dim.xs', { style: { marginTop: '10px' } }, alerting
              ? 'This tab is listening for leader alerts on this socket, so "closed" or "connecting" means the connection dropped and is being retried.'
              : 'This is this browser tab\'s own connection, not the exchange\'s service. It opens only while something uses it (the dashboard, an account\'s Live tab, a paper copy in the copy simulator, leader alerts) and closes 20 seconds after the last one stops, so "closed" here is normal.'));
        } catch (e) { if (!isAbort(e)) U.replace(api, h('div.row', { style: { marginBottom: '10px', gap: '8px' } }, h('h2', 'Exchange API'), UI.chip('unreachable', 'red')), h('div.neg.small', String(e.message || e))); }
      })();
    },
  };
})();
