/* MeridianDataHub — Data status (#/status): are the published snapshots fresh, is the exchange answering, and how is it
   set up (its contract, tokens and rate limits)? The perps snapshot is built by GitHub Actions every 30 minutes, the
   Predict snapshot on a PC (the Predict API refuses datacenter IPs) and pushed to the "snapshots" branch; each carries
   its own build time, so their age is read from the files. */
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
  /** kv with its values beside their labels, for a card as wide as the page (in a narrow card they sit on the right) */
  const kvL = (pairs) => { const el = kv(pairs); el.classList.add('left'); return el; };

  // ---- the exchange's configuration (pure: tests/status.test.mjs) ----
  const ZERO = /^0x0{40}$/i;
  /** A token's kind, as Meridian's docs name them (Supported Tokens): virtual (a name with no address and no balance: a
   *  market's base asset), synthetic (an internal balance with a concrete backing token: an isolated margin pool) or
   *  concrete (an ERC-20 that can be deposited and withdrawn). */
  const tokenKind = (t) => (!t || !t.address || ZERO.test(t.address) ? 'virtual' : t.backingTokenId ? 'synthetic' : 'concrete');
  /** A route's cost in rate-limit points: "1", or "1 + 0.1 a row" for a paginated route. */
  const routeCost = (r) => (r.type === 'PAGINATED' ? String(U.num(r.basePoints)) + (U.num(r.pointsPerRow) ? ' + ' + U.num(r.pointsPerRow) + ' a row' : '') : String(U.num(r.fixedPoints)));

  MD.router.pages.status = {
    tokenKind, routeCost,
    async mount(root, route, ctx) {
      MD.setTopbar(h('span.title', 'Data status'));
      const perps = h('div.card', UI.loading('Reading the perps snapshot…'));
      const predict = h('div.card', UI.loading('Reading the Predict snapshot…'));
      const api = h('div.card', UI.loading('Pinging the exchange…'));
      const conf = h('div.card', UI.loading('Reading the exchange\'s configuration…'));
      U.replace(root, h('div.page', h('div.stack',
        h('div.card', h('h1', { style: { margin: '0 0 6px', fontSize: '20px' } }, 'Is the data current?'),
          h('p.muted', { style: { margin: 0, maxWidth: '820px' } }, 'Live pages (accounts, dashboard, order books) read the exchange directly. The leaderboard, copyability scores and the Predict section read published snapshots: the perps one is rebuilt by GitHub Actions every 30 minutes, the Predict one every 30 minutes on the site owner\'s PC (the Predict API refuses requests from datacenter addresses), and both are published with the site. This page shows how old each one is right now.')),
        h('div.grid.cols-3', perps, predict, api),
        conf,
        h('div.footer-note', 'Times in your local time zone. "Late" means the last build is older than 45 minutes, "stale" older than two hours. A stale snapshot is also flagged on the Leaderboard, Copy trading, the Predict Overview, Bettors, Questions, Market makers and Vig & edge pages, and on slip pages.'))));

      // ---- perps snapshot (data/leaderboard.json, already cached by the leaderboard page); its card is drawn again every
      // minute and the file read again every five, so a page left open turns "fresh" into "late" and "stale" on time
      const drawPerps = async (force) => {
        try {
          const LB = MD.router.pages.leaderboard; const s = !LB ? null : force || LB._remote === undefined ? await LB.loadRemote(true) : LB._remote;   // between reads: the one in memory
          if (ctx.signal.aborted) return;
          const [state, cls] = ageState(s && s.builtAt);
          U.replace(perps, h('div.row', { style: { marginBottom: '10px', gap: '8px' } }, h('h2', 'Perps snapshot'), UI.chip(state, cls)),
            s ? kv([
              ['Built', when(s.builtAt)],
              ['Builder', s.source === 'github-actions' ? 'GitHub Actions' : s.source === 'local' ? 'a local run' : s.source || '—'],
              // rows include the ones carried over from an earlier build (mergeRows in scripts/build-snapshot.mjs: carried,
              // missing; an older snapshot has neither and lists only what it built); failed is after the retries, with what
              // the exchange's API answered (failReasons, since 2026-10-16: the Action's log is for the repo's admin only)
              ['Accounts', `${U.fmtNum(s.rows.length - (s.carried || 0), 0)} of ${U.fmtNum(s.accounts || s.rows.length, 0)} built` + (s.carried ? ` · ${s.carried} carried over from an earlier build` : '') + (s.missing ? ` · ${s.missing} missing` : '') + (s.failed ? ` · ${s.failed} failed${s.retried ? ' after retrying' : ''}` + (s.failReasons && Object.keys(s.failReasons).length ? ' (' + Object.entries(s.failReasons).sort((a, b) => b[1] - a[1]).map(([w, n]) => w + (n > 1 ? ' ×' + n : '')).join('; ') + ')' : '') : '') + (s.skipped ? ` · ${s.skipped} not reached in the ${U.fmtDuration((s.budgetS || 0) * 1000)} budget` : '') + (s.partial ? ' · partial' : ''), s.failed || s.skipped || s.missing ? 'neg' : ''],
              ['Copy profiles', `${U.fmtNum(s.rows.filter((r) => r.copy && r.copy.driftN).length, 0)} accounts with their price move after a fill measured`],
              s.durationMs ? ['Build took', U.fmtDuration(s.durationMs)] : null,
            ]) : LB && LB._remoteErr ? UI.error(LB._remoteErr, () => drawPerps(true)) : h('div.empty', 'No published perps snapshot: the leaderboard is built in each visitor\'s browser instead.'),
            h('div.dim.xs', { style: { marginTop: '10px' } }, 'Used by: Leaderboard, Copy trading (scores, also in the simulator), Home (top wallets), Favorites (PnL 30d), Dashboard (stop map account list).'));
        } catch (e) { if (!isAbort(e)) U.replace(perps, UI.error(e)); }
      };
      drawPerps(true);

      // ---- Predict snapshot (data/predict-status.json, a few hundred bytes written next to the 1 MB snapshot): read again
      // every minute
      const drawPredict = async () => {
        try {
          let s = null;
          // (the host answers unknown paths with the app's index.html, status 200: only JSON counts)
          try { const r = await fetch('data/predict-status.json', { cache: 'no-cache', signal: ctx.signal }); if (r.ok && /json/i.test(r.headers.get('content-type') || '')) s = await r.json(); } catch (e) { if (isAbort(e)) return; }
          // a publish from before the status file existed: read the snapshot's own header (the 1 MB the Predict pages load anyway)
          if (!s) await MD.need('predict').catch(() => {});   // (P.loadSnapshot is in the Predict pages' scripts)
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
      };
      drawPredict();
      let ticks = 0;
      ctx.onCleanup(U.every(60000, () => { ticks++; drawPerps(ticks % 5 === 0); drawPredict(); }));

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

      // ---- the exchange's configuration: its contract and signing domain, its tokens, and the API's rate limits (what each
      // route costs, and this browser's budget from the headers of the exchange's last answers)
      (async () => {
        try {
          const [tokens, products, rpc, routes] = await Promise.all([A.tokens(ctx), A.products(ctx).catch(() => []), A.rpcConfig(ctx).catch(() => null), A.rateLimitConfig(ctx).catch(() => null)]);
          if (ctx.signal.aborted) return;
          const byId = {}; for (const t of tokens) byId[t.id] = t;
          const poolOf = {}; for (const p of products) poolOf[String(p.quoteTokenAddress).toLowerCase()] = p;   // a synthetic token is a market's quote token
          const units = (x, t) => U.fmtQty(x) + ' ' + (t.erc20Symbol || t.name);
          // a synthetic token's accounting address spells its name and ends in zeros ("XAUUSD" is 0x584155555344 and 28
          // zeros): shortened as usual, gold's and silver's would both read 0x5841…0000
          const addr = (a, link) => h('span', link ? h('a.addr', { href: U.explorerAddr(a), target: '_blank', rel: 'noopener', title: a }, U.shortAddr(a))
            : h('span.addr', { title: a }, /0{8}$/.test(a) ? a.replace(/(00)+$/, '') + '…' : U.shortAddr(a)), ' ', U.copyBtn(a));
          const kindEl = (t) => (tokenKind(t) === 'concrete'
            ? h('span', { title: 'An ERC-20 token: deposited and withdrawn while the exchange allows it' }, 'concrete')
            : h('span', { title: 'An internal balance with an accounting address, not an ERC-20: it cannot be deposited or withdrawn, and converts 1:1 with its backing token' }, 'synthetic'));
          const tokenSub = (t) => {
            if (t.erc20Symbol) return `${t.erc20Name} (${t.erc20Symbol}) · ${t.erc20Decimals} decimals`;
            const pool = poolOf[String(t.address).toLowerCase()], back = byId[t.backingTokenId];
            return (pool ? pool.displayTicker + '\'s isolated margin pool' : 'an isolated margin pool') + (back ? ', backed by ' + back.name : '');
          };
          const open = (on, rest) => (on ? h('span', h('span.pos', 'open'), rest ? h('span.dim', ' · ' + rest) : null) : h('span.dim', 'closed'));
          const order = { concrete: 0, synthetic: 1 };
          const listed = tokens.filter((t) => tokenKind(t) !== 'virtual').sort((a, b) => order[tokenKind(a)] - order[tokenKind(b)] || U.num(a.addedBlockNumber) - U.num(b.addedBlockNumber));
          const virt = tokens.filter((t) => tokenKind(t) === 'virtual').sort((a, b) => U.num(a.addedBlockNumber) - U.num(b.addedBlockNumber)).map((t) => t.name);
          // this browser's budget on each host, read from the headers of the exchange's last answer to this tab; once the
          // window has reset it is full again
          const hosts = [['Exchange API', A.BASE], ['Archive API', A.ARCHIVE]].map(([name, u]) => [name, new URL(u).host]);
          const budget = h('div');
          const drawBudget = () => U.replace(budget, kvL(hosts.map(([name, host]) => {
            const b = A.rateLimits[host]; if (!b) return [name, 'not asked yet from this tab', 'dim'];
            const left = b.reset - (Date.now() - b.at) / 1000;
            return [name, left <= 0 ? `${U.fmtNum(b.limit, 0)} points (the window has reset since its last answer)` : `${U.fmtNum(b.remaining, 0)} of ${U.fmtNum(b.limit, 0)} points left · the window resets in ${Math.ceil(left)} s`, b.remaining < b.limit * 0.1 && left > 0 ? 'neg' : ''];
          })));
          drawBudget(); const bt = setInterval(drawBudget, 1000); ctx.onCleanup(() => clearInterval(bt));
          const d = rpc && rpc.domain;
          U.replace(conf, h('div.row', { style: { marginBottom: '10px', gap: '8px' } }, h('h2', 'Exchange configuration'), h('span.dim.small', 'as Meridian\'s API reports it')),
            d ? kvL([
              ['Exchange contract', addr(d.verifyingContract, true)],
              ['Chain', (U.num(d.chainId) === 4663 ? 'Robinhood Chain · ' : '') + 'chain id ' + d.chainId],
              ['Signed actions', `EIP-712 domain "${d.name}", version ${d.version}: ` + Object.keys(rpc.signatureTypes || {}).join(', ')],
            ]) : null,
            h('h3', { style: { margin: '18px 0 8px' } }, 'Tokens'),
            UI.table({
              cols: [
                { key: 'n', label: 'Token', render: (t) => UI.marketCell(t.name, tokenSub(t)) },
                { key: 'k', label: 'Kind', render: kindEl },
                { key: 'a', label: 'Address', render: (t) => addr(t.address, tokenKind(t) === 'concrete') },
                { key: 'dep', label: 'Deposits', title: 'Whether new deposits are accepted, the smallest one and its fee', render: (t) => open(t.depositEnabled, 'min ' + units(t.minDeposit, t) + (U.num(t.depositFee) ? ' · fee ' + units(t.depositFee, t) : ' · no fee')) },
                { key: 'wd', label: 'Withdrawals', title: 'Whether withdrawals are accepted, and the fee each one pays', render: (t) => open(t.withdrawEnabled, U.num(t.withdrawFee) ? 'fee ' + units(t.withdrawFee, t) : 'no fee') },
                { key: 'oft', label: 'LayerZero', title: 'The LayerZero OFT or adapter contract that carries the token to and from other chains', render: (t) => (!t.lzOftAddress || ZERO.test(t.lzOftAddress) ? h('span.dim', '—') : addr(t.lzOftAddress, true)) },
                { key: 'add', label: 'Added', render: (t) => h('span', t.addedBlockNumber ? h('a', { href: U.explorerBlock(t.addedBlockNumber), target: '_blank', rel: 'noopener', title: 'Added in Robinhood Chain block ' + t.addedBlockNumber }, U.fmtDate(t.createdAt)) : U.fmtDate(t.createdAt), t.removedBlockNumber ? h('span.neg', ' · removed in block ' + t.removedBlockNumber) : null) },
              ], rows: listed, phone: { title: 'n', aside: 'k', wide: ['dep'] },
            }),
            virt.length ? h('div.dim.xs', { style: { marginTop: '8px' } }, `Virtual tokens, names with no address and no balance (the markets' base assets): ${virt.join(', ')}.`) : null,
            h('h3', { style: { margin: '18px 0 8px' } }, 'API rate limits'),
            budget,
            routes && routes.length ? h('details', { style: { marginTop: '10px' } }, h('summary.small', { style: { cursor: 'pointer', color: 'var(--text-2)' } }, `What each route costs, in points (${routes.length} routes)`),
              UI.table({ cols: [
                { key: 'm', label: 'Method', render: (r) => h('span.dim', r.method) },
                { key: 'p', label: 'Route', cls: 'wrap-any', render: (r) => h('span.addr', r.path.replace(/\/$/, '')) },
                { key: 'c', label: 'Points', num: true, title: 'A fixed cost, or a base cost plus a share of a point for each row a page returns', render: routeCost },
              ], rows: routes, phone: false })) : null,
            h('div.dim.xs', { style: { marginTop: '10px' } }, 'Meridian counts the points of every request against the address it comes from (each visitor\'s browser has its own budget) and, when the request is signed, against the account too; a request over the budget is refused until the window resets (', h('a', { href: 'https://docs.meridian.xyz/developer-guides/trading-api/system-limits', target: '_blank', rel: 'noopener' }, 'Meridian\'s docs: System Limits'), ').'));
        } catch (e) { if (!isAbort(e)) U.replace(conf, h('div.row', { style: { marginBottom: '10px', gap: '8px' } }, h('h2', 'Exchange configuration')), UI.error(e)); }
      })();
    },
  };
})();
