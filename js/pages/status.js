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
  const kv = (pairs) => h('div.kv', pairs.filter(Boolean).map(([k, v, cls]) => [h('span.k', k), h('span.v', { class: cls || '' }, v)]));
  const when = (t) => (t ? `${U.fmtAgo(t)} · ${U.fmtDateTime(t)}` : '—');

  MD.router.pages.status = {
    async mount(root, route, ctx) {
      MD.setTopbar(h('span.title', 'Data status'));
      const perps = h('div.card', UI.loading('Reading the perps snapshot…'));
      const predict = h('div.card', UI.loading('Reading the Predict snapshot…'));
      const api = h('div.card', UI.loading('Pinging the exchange…'));
      U.replace(root, h('div.page', h('div.stack',
        h('div.card', h('h1', { style: { margin: '0 0 6px', fontSize: '20px' } }, 'Is the data current?'),
          h('p.muted', { style: { margin: 0, maxWidth: '820px' } }, 'Live pages (accounts, dashboard, order books) read the exchange directly. The leaderboard, copyability scores and the Predict section read published snapshots: the perps one is rebuilt by a scheduled job every 30 minutes, the Predict one on a machine of the site owner (the Predict API refuses datacenter addresses) and published the same way. This page says how old each is right now.')),
        h('div.grid.cols-3', perps, predict, api),
        h('div.footer-note', 'Times in your local time zone. "Late" means the last build is older than 45 minutes; "stale" older than two hours, at which point the pages that use it say so too.'))));

      // ---- perps snapshot (data/leaderboard.json, ~30 KB, already cached by the leaderboard page)
      (async () => {
        try {
          const LB = MD.router.pages.leaderboard; const s = LB ? await LB.loadRemote(true) : null;
          if (ctx.signal.aborted) return;
          const [state, cls] = ageState(s && s.builtAt);
          U.replace(perps, h('div.row', { style: { marginBottom: '10px', gap: '8px' } }, h('h2', 'Perps snapshot'), UI.chip(state, cls)),
            s ? kv([
              ['Built', when(s.builtAt)],
              ['Builder', s.source === 'github-actions' ? 'GitHub Actions' : s.source || '—'],
              ['Accounts', `${U.fmtNum(s.rows.length, 0)} of ${U.fmtNum(s.accounts || s.rows.length, 0)}` + (s.failed ? ` · ${s.failed} failed` : '') + (s.skipped ? ` · ${s.skipped} not reached in the ${U.fmtDuration((s.budgetS || 0) * 1000)} budget` : '') + (s.partial ? ' · partial' : ''), s.failed || s.skipped ? 'neg' : ''],
              ['Copy profiles', `${U.fmtNum(s.rows.filter((r) => r.copy && r.copy.driftN).length, 0)} with fill drift`],
              s.durationMs ? ['Build took', U.fmtDuration(s.durationMs)] : null,
            ]) : h('div.empty', 'No published perps snapshot: the leaderboard is built in each visitor\'s browser instead.'),
            h('div.dim.xs', { style: { marginTop: '10px' } }, 'Used by: Leaderboard, Copy trading (scores), Home (top wallets), Dashboard (stop map account list).'));
        } catch (e) { if (!isAbort(e)) U.replace(perps, UI.error(e)); }
      })();

      // ---- Predict snapshot (data/predict-status.json, a few hundred bytes written next to the 1 MB snapshot)
      (async () => {
        try {
          let s = null;
          try { const r = await fetch('data/predict-status.json', { cache: 'no-cache', signal: ctx.signal }); if (r.ok) s = await r.json(); } catch (e) { if (isAbort(e)) return; }
          // a publish from before the status file existed: read the snapshot's own header (the 1 MB the Predict pages load anyway)
          if (!s && MD.predict && MD.predict.loadSnapshot) {
            U.replace(predict, UI.loading('No status file yet: reading the Predict snapshot itself…'));
            try { const p = await MD.predict.loadSnapshot({ signal: ctx.signal }); if (p && p.remote) s = { builtAt: p.builtAt, source: p.source, predictions: p.predictions, apiTotal: p.apiTotal, bettors: p.agg && p.agg.bettors.length, makers: p.agg && p.agg.makers.length, questions: p.questionsWithOi && p.questionsWithOi.length, requests: p.requests, retries: p.retries, durationMs: p.durationMs }; } catch (e) { if (isAbort(e)) return; }
          }
          if (ctx.signal.aborted) return;
          const [state, cls] = s && s.error ? ['failed', 'red'] : ageState(s && s.builtAt);
          U.replace(predict, h('div.row', { style: { marginBottom: '10px', gap: '8px' } }, h('h2', 'Predict snapshot'), UI.chip(state, cls)),
            s ? kv([
              ['Built', when(s.builtAt)],
              ['Builder', s.source === 'pc' ? 'site owner\'s PC → snapshots branch' : s.source === 'github-actions' ? 'GitHub Actions' : s.source || '—'],
              s.error ? ['Error', s.error, 'neg'] : null,
              s.predictions != null ? ['Predictions', `${U.fmtNum(s.predictions, 0)}` + (s.apiTotal ? ` of ${U.fmtNum(s.apiTotal, 0)} the API counts` : ''), s.apiTotal && s.predictions < s.apiTotal - 50 ? 'neg' : ''] : null,
              s.bettors != null ? ['Bettors · makers', `${U.fmtNum(s.bettors, 0)} · ${U.fmtNum(s.makers || 0, 0)}`] : null,
              s.questions != null ? ['Questions listed', U.fmtNum(s.questions, 0)] : null,
              s.vigCoverage != null ? ['Vig coverage', `${U.fmtNum(s.vigCoverage, 0)} with a source price at bet time`] : null,
              s.requests != null ? ['API requests', `${U.fmtNum(s.requests, 0)}` + (s.retries ? ` · ${s.retries} retried` : '')] : null,
              s.durationMs ? ['Build took', U.fmtDuration(s.durationMs)] : null,
            ]) : h('div.empty', 'No Predict snapshot published yet.'),
            h('div.dim.xs', { style: { marginTop: '10px' } }, 'Used by: every Predict page, the Predict tab of an account, the tax center\'s Predict ledger.'));
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
          const maint = m && m.isEnabled;
          U.replace(api, h('div.row', { style: { marginBottom: '10px', gap: '8px' } }, h('h2', 'Exchange API'), UI.chip(maint ? 'maintenance' : 'answering', maint ? 'amber' : 'green')),
            kv([
              ['Round trip', `${rtt} ms`],
              ['Your clock', Math.abs(offset) < 1000 ? 'in sync' : `${(Math.abs(offset) / 1000).toFixed(1)} s ${offset > 0 ? 'behind' : 'ahead of'} the exchange`, Math.abs(offset) > 5000 ? 'neg' : ''],
              ['Maintenance', maint ? 'on: data may be stale' : 'off', maint ? 'neg' : ''],
              ['WebSocket', ws],
            ]),
            h('div.dim.xs', { style: { marginTop: '10px' } }, 'The socket connects when a page needs it (dashboard, Live tab, alerts); "closed" here just means no page is using it.'));
        } catch (e) { if (!isAbort(e)) U.replace(api, h('div.row', { style: { marginBottom: '10px', gap: '8px' } }, h('h2', 'Exchange API'), UI.chip('unreachable', 'red')), h('div.neg.small', String(e.message || e))); }
      })();
    },
  };
})();
