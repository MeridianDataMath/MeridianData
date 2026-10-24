/* MeridianDataHub — Copy trading: leaders ranked by copyability, results first (PnL and ROI, as the large exchanges rank
   their lead traders), then risk and how much of it a follower would keep, with the full breakdown behind every score.
   Nothing here places orders; that is the copy agent (#/copytrade/agent). */
(function () {
  const MD = window.MD; const U = MD.util; const AN = MD.analytics; const UI = MD.ui; const AL = MD.alerts; const h = U.h;

  const VERDICT_CLS = { 'Copyable': 'green', 'Copy with care': 'amber', 'Hard to copy': 'red', 'Losing so far': 'red' };
  const PILLARS = [['results', 'Results', 'how much it made, and how efficiently'], ['risk', 'Risk', 'how deep it fell, how often it was liquidated, how steady its weeks are'], ['friction', 'Copy friction', 'how much of it survives being copied a minute later at this size']];
  // the PnL and ROI columns' window, as the exchanges offer it (the score itself reads all-time figures)
  const WINDOWS = [{ v: '7d', label: '7D' }, { v: '30d', label: '30D' }, { v: 'all', label: 'All' }];
  const WIN_TXT = { '7d': 'last 7 days', '30d': 'last 30 days', all: 'all-time' };
  const usd0 = (v) => U.fmtUsd(v || 0, { compact: true, dp: 0 });
  const bps = (v, opts) => (v == null ? h('span.dim', '—') : h('span', { class: 'num ' + (opts && opts.cost ? (v > 0 ? 'neg' : '') : U.pnlClass(v)) }, (opts && opts.sign && v > 0 ? '+' : '') + U.fmtNum(v, 1) + ' bps'));

  /** Follow / unfollow for alerts. */
  // the button shows what a click did (in the leader dialog and the simulator nothing else redraws it, so a second click
  // quietly unfollowed), says so in a toast, and its state is announced (aria-pressed)
  MD.bellBtn = (l, cls) => {
    const bb = h('button.star-btn.bell', { class: cls || '' });
    const paint = () => { const on = AL.isFollowed(l.sid); bb.classList.toggle('on', on); bb.title = on ? 'Alerts on · click to stop following' : 'Alert me when this account trades'; bb.setAttribute('aria-label', on ? 'Stop alerts for ' + U.shortAddr(l.address, 4) : 'Alert me when ' + U.shortAddr(l.address, 4) + ' trades'); bb.setAttribute('aria-pressed', String(on)); U.replace(bb, U.icon(on ? 'bellFill' : 'bell')); };
    bb.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); const was = AL.isFollowed(l.sid); AL.toggle(l); const on = AL.isFollowed(l.sid); paint(); if (on !== was) U.toast(on ? 'Alerts on for ' + U.shortAddr(l.address, 4) : 'Alerts off for ' + U.shortAddr(l.address, 4)); });
    paint();
    return bb;
  };

  /** The alerts card: who is followed, what to be told about, how, and what happened. */
  function alertsCard(ctx) {
    const card = h('div.card#leader-alerts');
    const render = () => {
      const ae = document.activeElement; if (ae && card.contains(ae) && /^(INPUT|SELECT)$/.test(ae.tagName) && ae.type !== 'checkbox') return;   // an alert arriving must not clobber a field being typed in
      // Android's browsers have the Notification API but cannot show one from a page (only a service worker, which the site
      // has not): said rather than "allowed" over notifications that never appear (AL.pageNotifications)
      const s = AL.state(); const has = AL.pageNotifications(); const perm = has ? Notification.permission : 'unsupported';
      const leaders = h('div.row.wrap', { style: { gap: '6px' } }, s.leaders.length ? s.leaders.map((l) => h('span.chip', { style: { gap: '6px', display: 'inline-flex', alignItems: 'center' } }, h('a', { href: U.accountUrl(l.address, l.sid) }, U.shortAddr(l.address, 4)), h('button.x', { title: 'Stop following', onclick: () => AL.unfollow(l.sid), style: { background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'inherit', display: 'inline-flex' } }, U.icon('x')))) : h('span.dim.small', 'No leader followed yet: press the bell on a row, in a leader\'s breakdown, or on the simulator.'));
      const ev = (k, label) => UI.checkbox(label, !!s.events[k], (v) => { s.events[k] = v; AL.save(); });
      const events = h('div.row.wrap', { style: { gap: '4px 14px' } }, ev('open', 'opens'), ev('add', 'adds'), ev('reduce', 'reduces'), ev('close', 'closes'), ev('reverse', 'reverses'), ev('liq', 'is liquidated'));
      const minIn = h('input.input.sm', { type: 'number', min: 0, step: 100, value: s.minNotional || '', placeholder: '0', style: { width: '100px' }, onchange: (e) => { s.minNotional = Math.max(0, U.num(e.target.value)); AL.save(); } });
      const browserRow = h('div.row.wrap', { style: { gap: '8px' } }, UI.checkbox('Browser notification', !!s.browser, (v) => { s.browser = v; AL.save(); }),
        perm === 'granted' ? h('span.chip.green', 'allowed') : perm === 'denied' ? h('span.chip.red', { title: 'Blocked for this site in the browser settings' }, 'blocked') : perm === 'unsupported' ? h('span.chip', { title: 'This browser shows notifications only to an installed app or a service worker: the ntfy push below reaches the phone instead' }, 'not available here · use ntfy') : h('button.btn.sm', { onclick: async () => { const r = await AL.askPermission(); U.toast(r === 'granted' ? 'Notifications allowed' : 'Notifications not allowed'); render(); } }, 'Allow notifications'));
      // the topic is the only secret (anyone who knows it reads the alerts and can post to it): offer one nobody can guess
      const topicWarn = h('span.small.neg');
      const showTopicWarn = () => { const w = AL.topicWarning(s.ntfy.topic); U.replace(topicWarn, w ? w + ': anyone who guesses it reads your alerts. Generate one instead.' : ''); };
      const topicIn = h('input.input.sm', { placeholder: 'ntfy topic (leave empty for none)', value: s.ntfy.topic || '', style: { width: '240px' }, spellcheck: false, onchange: (e) => { s.ntfy.topic = e.target.value.trim(); AL.save(); showTopicWarn(); } });
      const genBtn = h('button.btn.sm', { title: 'Fill in a long random topic nobody can guess; subscribe to the same name in the ntfy app', onclick: () => { topicIn.value = AL.newTopic(); topicIn.dispatchEvent(new Event('change')); } }, 'Generate');
      showTopicWarn();   // an existing weak topic is pointed out too
      const serverIn = h('input.input.sm', { placeholder: 'https://ntfy.sh', value: s.ntfy.server || 'https://ntfy.sh', title: 'https://ntfy.sh, or a ntfy on this machine (http://localhost:…): the site may reach no other server', style: { width: '170px' }, spellcheck: false, onchange: (e) => { const v = e.target.value.trim() || 'https://ntfy.sh'; if (!AL.pageServerOk(v)) { U.toast(AL.PAGE_SERVER_MSG.replace(/^t/, 'T')); e.target.value = s.ntfy.server || 'https://ntfy.sh'; return; } s.ntfy.server = v; AL.save(); } });
      const ntfyErr = s.ntfy.lastError ? h('span.small.neg', { title: U.fmtDateTime(s.ntfy.lastError.t) }, 'last push failed: ' + s.ntfy.lastError.msg) : null;
      const testBtn = h('button.btn.sm', { onclick: async () => { s.ntfy.topic = topicIn.value.trim(); s.ntfy.server = serverIn.value.trim() || 'https://ntfy.sh'; AL.save(); try { await AL.test(); U.toast('Test push sent'); } catch (e) { U.toast('Push failed: ' + e.message); } } }, 'Send a test');
      const status = h('span.dim.small', s.leaders.length ? (AL.isOwner() ? 'this tab is listening since ' + U.fmtTime(AL.since || Date.now()) : 'another tab of this browser is listening') + ' · ' + s.leaders.length + ' followed' : 'not listening');
      const hist = s.history.slice(0, 30);
      const feed = UI.table({ cols: [
        { key: 't', label: 'When', render: (a) => h('span.dim', U.fmtAgo(a.t)) },
        { key: 'w', label: 'Leader', render: (a) => h('a.addr', { href: U.accountUrl(a.address, a.sid) }, U.shortAddr(a.address, 4)) },
        { key: 'k', label: 'Event', render: (a) => UI.chip(a.kind === 'liq' ? 'liquidated' : a.kind, a.kind === 'liq' ? 'red' : a.kind === 'open' || a.kind === 'add' ? 'green' : a.kind === 'reverse' ? 'amber' : '') },
        { key: 'm', label: 'Market', render: (a) => (a.ticker ? UI.marketCell(a.ticker) : h('span.dim', '—')) },
        { key: 's', label: 'Side', render: (a) => (a.side ? U.sideEl(a.side === 'LONG', true) : h('span.dim', '—')) },
        { key: 'n', label: 'Size', num: true, render: (a) => (a.notional ? U.fmtUsd(a.notional, { compact: true, dp: 0 }) : h('span.dim', '—')) },
        { key: 'p', label: 'Price', num: true, render: (a) => (a.px ? U.fmtPrice(a.px, a.tick) : h('span.dim', '—')) },
        { key: 'go', label: '', render: (a) => h('a.btn.sm.ghost', { href: '#/copytrade/sim?address=' + a.address + '&sub=' + a.sid }, 'Simulate') },
      ], rows: hist, empty: s.leaders.length ? 'Nothing logged yet: no trade by a followed leader has matched the events and minimum size above since listening started or the log was last cleared' : 'Follow a leader to start' });
      U.replace(card,
        h('div.row.wrap', { style: { marginBottom: '8px', gap: '8px' } }, h('h2', 'Leader alerts'), UI.chip('live', 'blue'), status, h('span.grow'), hist.length ? h('button.btn.sm.ghost', { onclick: () => AL.clearHistory() }, 'Clear') : null),
        h('div.grid.cols-2',
          h('div.stack', { style: { gap: '10px' } },
            h('div', h('div.field-lbl', 'Following'), leaders),
            h('div', h('div.field-lbl', 'Tell me when a leader'), events),
            h('div.row.wrap', { style: { gap: '8px' } }, h('span.dim.small', 'Only orders of at least'), minIn, h('span.dim.small', 'USD notional (0 = everything; fills of one order are grouped)'))),
          h('div.stack', { style: { gap: '10px' } },
            h('div', h('div.field-lbl', 'Deliver as'), h('div.stack', { style: { gap: '6px' } }, h('div.dim.small', 'A toast on this site, always. And:'), browserRow,
              h('div.row.wrap', { style: { gap: '8px' } }, h('span.dim.small', 'Phone push via ntfy'), topicIn, genBtn, serverIn, testBtn, ntfyErr, topicWarn),
              h('div.dim.xs', 'Install the ntfy app, subscribe to a topic name nobody would guess, and put it here; the tab posts each alert to it (the topic is the only secret, so treat it like one). Alerts flow while a tab of this site is open in this browser; one tab listens, the others just show the log. A tab left in the background may deliver up to a minute late, as browsers slow its timers.'))))),
        h('div.card.tight', { style: { marginTop: '12px' } }, h('div.card-head', h('h3', 'Recent'), h('span.dim.small', 'newest first · kept in this browser')), feed));
    };
    render();
    ctx.onCleanup(U.on('alerts', render));
    return card;
  }

  /** The score as a pill: number + verdict; "—" with the reason when there is none. */
  const SMALL_SAMPLE = 10;
  function scorePill(sc, c) {
    if (!sc) return h('span.dim.small', { title: `Fewer than ${AN.COPY.minClosed} closed positions: nothing to score yet` }, c ? `${c.closed} closed · too few` : 'no profile');
    // a score that rests on few closed positions says so beside it (the verdict stays: results first, as ranked); fewer
    // than SMALL_SAMPLE is a sample where luck can carry it
    const few = c && c.closed < SMALL_SAMPLE ? h('span.xs', { style: { color: 'var(--amber)' }, title: `Scored on ${c.closed} closed positions only: a small sample, where one lucky or unlucky trade moves the score a lot` }, c.closed + ' closed') : null;
    return h('div.row', { style: { gap: '8px' }, title: sc.caps.length ? 'Capped: ' + sc.caps.map((x) => x.why).join(' · ') : `results ${sc.results} · risk ${sc.risk} · friction ${sc.friction}` }, h('span.score', { class: VERDICT_CLS[sc.verdict] || '' }, String(sc.total)), h('span.chip', { class: VERDICT_CLS[sc.verdict] || '' }, sc.verdict), few);
  }

  /** The "Copier keeps" cell: the share of the leader's result per position left after a copier's costs (AN.copyKeep),
   *  the figures in % of a position in its tooltip */
  function keepCell(c, r) {
    const K = AN.copyKeep(c), pc = (bps) => U.fmtPct(bps / 100, { dp: 2, sign: true });
    if (!c) return h('span.dim', { title: 'No copy profile for this account in the snapshot' }, '—');
    if (!K) return h('span.dim', { title: 'Not measured yet: too few fills with one-minute candles after them, or no order-book data' }, 'not measured');
    // under the share, what it is a share of: the leader's average result per closed position (user 10-23: "none" beside
    // +$6,422 read as a fault; that account's five closed trades averaged +0.02%, its dollars came from one big, long-held
    // position and an open one)
    const n = c.nTrim != null ? c.nTrim : c.closed;
    const cell = (cls, text, title, sub) => h('div', { title, style: { lineHeight: '1.25' } }, h('span', { class: cls }, text), h('div.xs.dim', sub || (K.kept == null ? '' : 'of ') + pc(K.lead) + ' a trade'));
    // its closed trades lose on average (or make nothing): no edge to keep (user 10-23: a word, not "—")
    if (K.kept == null) return cell('dim', 'no edge', `The leader's closed positions ${K.lead < 0 ? 'lose ' + pc(K.lead).replace('-', '').replace('−', '') + ' each on average' : 'make nothing on average'} after fees and funding (${n} of them): nothing for a copier to keep`);
    const title = `Per closed position, on average over ${n}: the leader makes ${pc(K.lead)} after its fees and funding; a copier's costs take ${pc(K.cost).replace('+', '')} (extra fees ${U.fmtNum(K.fees, 1)} bps, slippage ${U.fmtNum(K.slip, 1)} bps, a minute's delay ${U.fmtNum(K.drift, 1)} bps, in and out), leaving ${pc(K.copier)}. Each position counts once whatever its size, as for a copier copying every position at the same size; open positions are not in it` + (n < 10 ? ` · only ${n} positions, so one can move it` : '');
    // nothing left to keep: why, rather than "none" (user 10-23). Its profit is in its open positions; the minute's delay
    // costs more than it makes a trade; or its closed trades make less than a copier's costs
    if (K.kept <= 0) {
      const pnl = r && r.stats && r.stats.all ? U.num(r.stats.all.pnl) : 0, up = r ? U.num(r.upnl) : 0;
      if (pnl > 0 && up >= pnl / 2) return cell('caution', 'unrealized profit', `${usd0(up)} of its ${usd0(pnl)} all-time PnL is the unrealized result of its open positions, which this leaves out until they close. ${title}`, usd0(up) + ' in open positions');
      if (K.drift >= K.lead) return cell('caution', 'too fast to copy', `The price moves ${pc(K.drift / 2).replace('+', '')} against a copier in the minute after its fills, in and out: more than it makes a trade. ${title}`);
      return cell('caution', 'edge too thin', `Its closed trades make less than a copier's costs, so nothing would be left. ${title}`);
    }
    return cell('num ' + (K.kept >= 80 ? 'pos' : K.kept >= 40 ? '' : 'neg'), U.fmtPct(K.kept, { dp: 0 }), title);
  }

  /** The full story behind one leader's score. */
  function openLeader(r, sc) {
    const c = r.copy; const s = (r.stats && r.stats.all) || {};
    const barRow = (label, v, note) => h('div.score-part', h('div.row', { style: { gap: '8px' } }, h('span', label), h('span.grow'), h('span.dim.small', v == null ? 'not measured' : U.fmtPct(v * 100, { dp: 0 }))), h('div.bar', h('i', { class: v == null ? '' : v < 0.34 ? 'bad' : v < 0.67 ? 'warn' : '', style: { width: (v == null ? 0 : v * 100) + '%' } })), h('div.dim.xs', note));
    const pillars = h('div.grid.cols-3', PILLARS.map(([key, label, sub]) => h('div.card.tight', { style: { padding: '12px 14px' } },
      h('div.row', h('h3', label), h('span.grow'), h('span.score.sm', { class: sc[key] >= 67 ? 'green' : sc[key] >= 34 ? 'amber' : 'red' }, String(sc[key]))),
      h('div.dim.xs', { style: { marginBottom: '8px' } }, sub),
      h('div.stack', { style: { gap: '8px' } }, sc.parts.filter((p) => p.pillar === key).map((p) => barRow(p.label, p.v, p.note))))));
    // what is left for a copier, per position, in bps of entry notional (a profile from an older snapshot may lack the parts)
    // (each row's mean is taken on its own, so the first row's parts are stated as averages, not as a sum to its value)
    const nMean = c.nTrim != null ? c.nTrim : c.closed;
    const after = [`their trading fees (${U.fmtNum(c.feesBps, 1)} bps on average)`].concat(c.posFeeBps ? [`mPerp position fees (${U.fmtNum(c.posFeeBps, 1)} bps)`] : [], c.fundPosBps ? [`funding (${U.fmtNum(Math.abs(c.fundPosBps), 1)} bps ${c.fundPosBps > 0 ? 'received' : 'paid'} on average)`] : []);
    // a copier's costs (AN.copyKeep): what it pays beyond the leader, never a gain where prices or fees favoured it
    const K = AN.copyKeep(c), fn1 = (x) => U.fmtNum(x, 1);
    const wf = K ? [
      ['Leader, per position', K.lead, `each position's result after ${after.length > 1 ? after.slice(0, -1).join(', ') + ' and ' + after[after.length - 1] : after[0]}, ` + (nMean >= 10 ? 'a plain mean over positions with the most extreme 5% on each side (at least one position) winsorized, so one jackpot or blow-up cannot carry it' : `a plain mean over ${nMean} positions, too few to winsorize, so one position can move it`)],
      ['− Copier fees beyond theirs', -K.fees, `a copier pays ${fn1(c.feeBps)} bps taker fees in and out, ${fn1(2 * c.feeBps)} bps a position; the leader paid ${fn1(c.feesBps)} bps` + (2 * c.feeBps < c.feesBps ? ', more, which is not counted as a gain' : '') + '. Position fees and funding stay in the leader\'s result: a copier holding the same position pays or receives them too'],
      ['− Slippage for a copier', -K.slip, `${fn1(c.slipBps)} bps to fill ${usd0(c.copySize)} against today's books, in and out` + (c.slipOwnBps != null && c.slipOwnBps > c.slipBps ? ` · ${fn1(c.slipOwnBps)} bps at their own ${usd0(c.notMed)}` : '')],
      ['− A minute\'s delay', -K.drift, (c.drift1 > 0 ? `the price moved ${fn1(c.drift1)} bps against a copier in the minute after their fills, in and out` : c.drift1 < 0 ? `the price moved ${fn1(-c.drift1)} bps in a copier's favour in the minute after their fills: not counted, as a copier cannot count on it` : 'no move in the minute after their fills') + ` · measured over their latest ${U.fmtNum(c.driftN, 0)} fills (${fn1(c.drift5)} bps after five minutes)`],
      ['= Copier, per position', K.copier, K.kept == null ? 'the leader\'s positions do not make money after fees and funding, so there is nothing to keep' : K.kept <= 0 ? 'nothing survives: a copier\'s costs are more than the leader makes' : `a copier keeps ${U.fmtPct(K.kept, { dp: 0 })} of the leader's result`],
    ] : null;
    const wfTbl = wf ? UI.table({ cols: [
      { key: 'k', label: 'Per position, on entry notional', render: (x) => h('span', { class: /^=/.test(x[0]) ? 'bold' : '' }, x[0]) },
      { key: 'v', label: 'bps', num: true, render: (x) => { const v = x[1] || 0; return h('span', { class: 'num ' + (/^=|Leader/.test(x[0]) ? U.pnlClass(v) : v < 0 ? 'neg' : '') }, (v > 0 ? '+' : '') + U.fmtNum(v, 1)); } },
      { key: 'n', label: '', render: (x) => h('div.dim.small.wf-note', { style: { whiteSpace: 'normal', lineHeight: '1.35' } }, x[2]) },   // the explanations wrap rather than scroll the table sideways
    ], rows: wf }) : h('div.empty', 'The frictions are measured from the leader\'s fills against one-minute oracle candles and today\'s books; this account has too few fills for that yet.');
    const holdTotal = c.closed || 1;
    const holdBar = h('div.hold-bar', [['scalp', 'under 1h'], ['intra', '1h – 1d'], ['swing', '1 – 7d'], ['long', 'over 7d']].map(([k, label]) => { const n = c.hold[k]; return n ? h('span', { class: k, style: { flex: String(n) }, title: `${n} positions held ${label}` }, n / holdTotal > 0.12 ? U.fmtPct((n / holdTotal) * 100, { dp: 0 }) : '') : null; }));
    const kv = (pairs) => h('div.kv', { style: { marginTop: '8px' } }, pairs.map(([k, v]) => [h('span.k', k), h('div', v)]));
    const facts = h('div.grid.cols-2',
      h('div.card.tight', { style: { padding: '12px 14px' } }, h('h3', 'How they trade'), kv([
        ['Hold times', h('div', holdBar, h('div.dim.xs', { style: { marginTop: '4px' } }, 'scalps · intraday · swing · long · median ' + (c.holdMed == null ? '—' : U.fmtDuration(c.holdMed))))],
        ['Typical size', h('span', usd0(c.notMed), h('span.dim.small', ` median · ${usd0(c.notP90)} at the 90th percentile` + (c.lev ? ` · ${U.fmtNum(c.lev, 1)}× equity` : '')))],
        ['Markets', h('div', h('div.row.wrap', { style: { gap: '4px' } }, c.markets.map((m) => UI.chip(`${m.t} ${U.fmtPct(m.share, { dp: 0 })}`, ''))), h('div.dim.xs', { style: { marginTop: '4px' } }, 'share of positions, closed and open' + (c.nMarkets > c.markets.length ? ` · top ${c.markets.length} of ${c.nMarkets} markets` : '')))],
        ['Positions', h('span', `${c.closed} closed · ${c.open} open · ${c.closed30} closed in 30d` + (c.liq ? ` · ${c.liq} liquidated` : '') + (c.adl ? ` · ${c.adl} deleveraged` : ''))],
        ['Per position', h('span', bps(c.netTrimBps, { sign: true }), h('span.dim.small', ' after fees and funding · '), bps(c.grossMedBps, { sign: true }), h('span.dim.small', ' median gross' + (c.tStat != null ? ` · t = ${U.fmtNum(c.tStat, 1)}` : '')))]])),
      h('div.card.tight', { style: { padding: '12px 14px' } }, h('h3', 'Track record'), kv([
        // as Meridian's app (row basis 'app'), the site's net figure in the tooltip
        ['All-time PnL', h('span', { title: AN.sitePnlTitle(r, 'all') }, U.pnlEl(s.pnl, { dp: 0 }), h('span.dim.small', (s.roi == null ? '' : ` · ROI ${U.fmtPct(s.roi, { dp: 1, sign: true })}`) + (AN.isAppBasis(r) ? ' · as Meridian\'s app' : '')))],
        ['Win rate', h('span', r.winRate == null ? '—' : U.fmtPct(r.winRate, { dp: 0 }), h('span.dim.small', c.top == null ? '' : ` · largest win ${U.fmtPct(c.top, { dp: 0 })} of all wins`))],
        ['Consistency', h('span', c.weeksActive ? `${c.weeksPos} of ${c.weeksActive} active weeks profitable (weeks start Monday 00:00 UTC)` : '—')],
        ['Drawdown', h('span', s.ddPct == null || !(s.ddPct > 0) ? '—' : U.fmtDd(s.ddPct), h('span.dim.small', s.ddPct > 0 ? ' · on the site\'s net PnL' : ''))],
        // under a week old, perWeek is the plain count, not a weekly rate
        ['Activity', h('span', (c.lastAt ? 'last trade ' + U.fmtAgo(c.lastAt) : '—') + (c.tenureD != null ? (c.tenureD < 1 ? ' · less than a day on the exchange' : ` · ${U.fmtNum(c.tenureD, 0)} day${Math.round(c.tenureD) === 1 ? '' : 's'} on the exchange`) : '') + (c.perWeek != null ? (c.tenureD < 7 ? ` · ${c.closed} closed in its first ${U.fmtDuration(Date.now() - c.firstAt)}` : ` · ${U.fmtNum(c.perWeek, c.perWeek >= 10 ? 0 : 1)} closed / week`) : ''))]])));
    UI.modal({ wide: true,
      title: h('div.row.wrap', { style: { gap: '8px 10px' } }, UI.starBtn({ address: r.account, subaccountId: r.sid, name: r.name }), h('span', U.shortAddr(r.account, 6)), U.copyBtn(r.account), scorePill(sc, c), MD.router.pages.leaderboard ? MD.router.pages.leaderboard.carriedChip(r) : null, MD.bellBtn({ sid: r.sid, address: r.account, name: r.name }), h('span.grow'), h('a.btn.sm.primary', { href: '#/copytrade/sim?address=' + r.account + '&sub=' + r.sid }, 'Simulate'), h('a.btn.sm', { href: U.accountUrl(r.account, r.sid) }, 'Account page'), h('a.btn.sm.ghost', { href: '#/tax?address=' + r.account + '&sub=' + r.sid }, 'Tax')),
      body: h('div.stack',
        h('div.dim.small', `Copyability ${sc.total}. Before caps: 55% results (${sc.results}) + 25% risk (${sc.risk}) + 20% copy friction (${sc.friction}) = ${sc.raw}` + (sc.raw !== sc.total ? `, capped at ${sc.total} (reasons below)` : '') + `. Copyable from ${AN.COPY.copyableAt} with at least ${U.fmtUsd(AN.COPY.minPnl, { dp: 0 })} made all-time. Parts that cannot be measured are left out of their pillar, not counted as zero.`),
        sc.caps.length ? h('div.small', { style: { color: 'var(--amber)' } }, 'Capped: ', sc.caps.map((x, i) => [i ? ' · ' : null, `${x.at} — ${x.why}`])) : null,
        pillars,
        UI.card('What is left for a copier', wfTbl, h('span.dim.small', `the same moves one minute later, at taker fees, with a ${usd0(c.copySize || AN.COPY_SIZE)} position`)),
        facts,
        h('div.footer-note', { style: { textAlign: 'left', paddingBottom: 0 } }, 'From the public Meridian API: this account\'s positions and fills, one-minute oracle candles after its most recent fills (up to 400), and the order books as they were when the snapshot was built. Past results are not a promise of future returns. Copyability puts what an account made first, then the risk it took and how much of its result a copier could have kept; it does not say whether there will be a result.')) });
  }

  MD.router.pages.copytrade = {
    async mount(root, route, ctx) {
      if (route.path === '/copytrade/sim') return MD.copysimPage.mount(root, route, ctx);
      if (route.path === '/copytrade/agent') return MD.copyagentPage.mount(root, route, ctx);
      MD.setTopbar(h('span.title', 'Copy trading'));
      const LB = MD.router.pages.leaderboard;
      const tableWrap = h('div');
      const summary = h('span.dim.small');
      // 25 leaders a page, as the Leaderboard: every row at once was some 9,000 elements, about 40,000 px of a phone before
      // the alerts card; the page is kept in the link, so Back returns to it
      const PAGE = 25;
      const state = { filter: route.params.show || 'scored', win: WINDOWS.some((w) => w.v === route.params.window) ? route.params.window : 'all', sort: { key: 'score', desc: true }, page: Math.max(1, Math.floor(U.num(route.params.page)) || 1) };
      // Predict: open slips from winning bettors (js/pages/predict.js), under the perps leaders
      const ideas = MD.predict && MD.predict.ideasCard ? MD.predict.ideasCard(ctx) : null;
      const hero = h('div.card.ct-hero',
        h('h1', 'Copy trading on Meridian'),
        h('p', `Leaders are ranked the way the large exchanges rank their lead traders: by what they made first (all-time PnL and ROI), then by the risk they took (drawdown, liquidations, steady weeks), then by how much of it a follower would keep, entering a minute later at taker fees against today's order books with a position the size of the leader's median one but no more than $2,000. Copyable: a score of ${AN.COPY.copyableAt} or more and at least ${U.fmtUsd(AN.COPY.minPnl, { dp: 0 })} made all-time. Every wallet with at least ${AN.COPY.minClosed} closed positions is scored, and the numbers behind each score are one click away.`),
        h('p', 'Nothing on this page places orders. Copying itself is done by the copy agent, a program you run on your own machine with a Meridian linked signer (a key that can trade and never withdraw); this site is its control room.'),
        h('p', `Predict is copied by hand, one slip at a time: further down are open slips of bettors at least ${U.fmtUsd(MD.predict && MD.predict.IDEAS ? MD.predict.IDEAS.minPnl : 500, { dp: 0 })} in profit, the biggest winners first; each opens on Meridian Predict, where Add To Slip adds its picks to your slip.`),
        h('div.row.wrap', { style: { gap: '8px', marginTop: '4px' } }, h('a.btn.primary.sm', { href: '#/copytrade/agent' }, 'Set up the copy agent'), h('span.dim.small', 'simulate and paper-copy a leader first'), h('span.grow'),
          h('button.btn.sm', { type: 'button', onclick: () => { const a = U.$('#leader-alerts'); if (a) a.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, U.icon('bell'), 'Leader alerts'),
          ideas ? h('button.btn.sm', { type: 'button', onclick: () => ideas.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, U.icon('target'), 'Predict ideas') : null));
      const filterSeg = UI.seg([{ v: 'all', label: 'All traders' }, { v: 'scored', label: 'Scored' }, { v: 'copyable', label: 'Copyable' }], state.filter, (v) => { state.filter = v; state.page = 1; MD.router.setParams({ show: v === 'scored' ? null : v }, { silent: true }); render(); }, 'sm');
      const winSeg = UI.seg(WINDOWS, state.win, (v) => { state.win = v; MD.router.setParams({ window: v === 'all' ? null : v }, { silent: true }); render(); }, 'sm');
      winSeg.title = 'The window of the PnL and ROI columns (the score reads all-time figures)';
      const leaders = h('div.card.tight', h('div.card-head', h('h2', 'Leaders by copyability'), summary, h('span.grow'), winSeg, filterSeg, MD.defsLink()), tableWrap);
      U.replace(root, h('div.page', h('div.stack', hero, leaders, ideas, alertsCard(ctx), h('div.footer-note', 'Scores come from the published snapshot (rebuilt every 30 minutes): the same positions and PnL as the Leaderboard, plus each account\'s fills, one-minute oracle candles after them, and the order books at build time. Past performance is not a promise of future returns.'))));
      ctx.onCleanup(U.on('favorites', () => render()));
      ctx.onCleanup(U.on('alerts', () => render()));

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
        // Meridian's own accounts and the market maker are no traders to copy (as on the home page; the Leaderboard keeps them, labelled)
        const traders = data.rows.filter((r) => !r.inactive && r.stats && r.stats.all && !AN.noTrades(r) && !AN.exchangeAccount(r) && !AN.marketMaker(r));
        const scored = traders.map((r) => ({ r, sc: AN.copyScore(r), c: r.copy }));
        let rows = scored;
        if (state.filter === 'scored') rows = rows.filter((x) => x.sc);
        if (state.filter === 'copyable') rows = rows.filter((x) => x.sc && x.sc.verdict === 'Copyable');
        // the PnL and ROI columns' window (a row without that window's figures counts as none)
        const win = (x) => x.r.stats[state.win] || null;
        // a leader with nothing to keep (no result per position) sorts under one whose result a copier's costs take in full
        const val = (x, k) => { const s = x.r.stats.all, c = x.c || {}; switch (k) { case 'score': return x.sc ? x.sc.total : null; case 'edge': { const K = AN.copyKeep(x.c); return !K ? null : K.kept == null ? -1 : K.kept; } case 'pnl': return win(x) ? win(x).pnl : null; case 'roi': return win(x) ? win(x).roi : null; case 'winRate': return x.r.winRate; case 'closed': return c.closed != null ? c.closed : x.r.closedCount; case 'hold': return c.holdMed; case 'size': return c.notMed; case 'dd': return s.ddPct; case 'last': return c.lastAt; default: return null; } };
        rows = U.sortBy(rows, (x) => val(x, state.sort.key), state.sort.desc);
        if (state.sort.key === 'score') rows = rows.slice().sort((a, b) => { const d = (b.sc ? b.sc.total : -1) - (a.sc ? a.sc.total : -1); return (state.sort.desc ? d : -d) || (b.r.stats.all.pnl - a.r.stats.all.pnl); });
        const onSort = (k) => { if (state.sort.key === k) state.sort.desc = !state.sort.desc; else state.sort = { key: k, desc: true }; state.page = 1; render(); };
        const pages = Math.max(1, Math.ceil(rows.length / PAGE)); if (state.page > pages) state.page = pages;
        const slice = rows.slice((state.page - 1) * PAGE, state.page * PAGE);
        MD.router.setParams({ page: state.page > 1 ? state.page : null }, { silent: true });
        const noProfiles = !traders.some((r) => r.copy);
        U.replace(tableWrap,
          noProfiles ? h('div.small.muted', { style: { padding: '10px 14px', borderBottom: '1px solid var(--border-2)' } }, data.remote ? 'This snapshot predates copyability; the next one (within 30 minutes) will carry the profiles.' : 'A leaderboard built in the browser has no copy profiles; scores need the published snapshot.') : null,
          UI.table({
            sort: state.sort, onSort,
            cols: [
              { key: 'rank', label: '#', render: (x) => { const i = rows.indexOf(x) + 1; return UI.rank(i, !!(x.sc && x.sc.verdict === 'Copyable')); } },
              { key: 'w', label: 'Wallet', render: (x) => h('div.row', { style: { gap: '6px' } }, UI.starBtn({ address: x.r.account, subaccountId: x.r.sid, name: x.r.name }), MD.bellBtn({ sid: x.r.sid, address: x.r.account, name: x.r.name }), U.addrLink(x.r.account, x.r.sid), U.copyBtn(x.r.account), AN.known(x.r) ? h('span.chip.amber', { title: AN.known(x.r).title }, AN.known(x.r).label) : null, LB ? LB.carriedChip(x.r) : null) },
              { key: 'score', label: 'Copyability', sortVal: 1, title: `0–100: results (all-time PnL and ROI) 55%, risk 25%, copy friction 20%; Copyable from ${AN.COPY.copyableAt} with ${U.fmtUsd(AN.COPY.minPnl, { dp: 0 })}+ made all-time; click a row for the breakdown`, render: (x) => scorePill(x.sc, x.c) },
              { key: 'edge', label: 'Copier keeps', num: true, sortVal: 1, title: `How much of the leader's average result per position a copier keeps after its own costs: the trading fees it pays beyond the leader's, slippage at the leader's median position size (at most $2K) and the price move in the minute after the leader's fills (their latest, up to 400), in and out. A price move in the copier's favour is not counted, so it is never more than 100%. Hover a cell for the figures, click a row for the breakdown`, render: (x) => keepCell(x.c, x.r) },
              // PnL and ROI as Meridian's app (the Leaderboard's, row basis 'app'); the site's net figures in a cell's tooltip
              { key: 'pnl', label: state.win === 'all' ? 'All-time PnL' : `PnL ${WINDOWS.find((w) => w.v === state.win).label}`, num: true, sortVal: 1, title: `PnL over the ${WIN_TXT[state.win]}, as Meridian's Trade Stats: realized PnL, settled funding and trading fees, plus unrealized PnL; mPerp position fees are not in it. Hover a cell for the site's net figure`, render: (x) => (win(x) ? h('span', { title: AN.sitePnlTitle(x.r, state.win) }, U.pnlEl(win(x).pnl, { dp: 0 })) : h('span.dim', '—')) },
              { key: 'roi', label: state.win === 'all' ? 'ROI' : `ROI ${WINDOWS.find((w) => w.v === state.win).label}`, num: true, sortVal: 1, title: `PnL over the ${WIN_TXT[state.win]} (as Meridian's app) ÷ deposits`, render: (x) => (win(x) ? h('span', { title: AN.siteRowNote(x.r, state.win) }, UI.pct(win(x).roi, { dp: 1 })) : h('span.dim', '—')) },
              { key: 'winRate', label: 'Win rate', num: true, sortVal: 1, render: (x) => (x.r.winRate == null ? h('span.dim', '—') : U.fmtPct(x.r.winRate, { dp: 0 })) },
              { key: 'closed', label: 'Closed', num: true, sortVal: 1, title: 'Closed positions · last trade', render: (x) => h('div', { style: { lineHeight: '1.25' } }, String(val(x, 'closed') || 0), x.c && x.c.lastAt ? h('div.xs.dim', { style: { whiteSpace: 'nowrap' } }, U.fmtAgo(x.c.lastAt)) : null) },
              { key: 'hold', label: 'Median hold', num: true, sortVal: 1, render: (x) => (x.c && x.c.holdMed != null ? U.fmtDuration(x.c.holdMed) : h('span.dim', '—')) },
              { key: 'size', label: 'Typical size', num: true, sortVal: 1, title: 'Median entry notional per position', render: (x) => (x.c && x.c.notMed ? usd0(x.c.notMed) : h('span.dim', '—')) },
              // one line: the two main markets by share, the rest counted (chips stacked made every row three lines tall)
              { key: 'mk', label: 'Markets', title: 'Most-traded markets by number of positions (closed and open); hover a cell for each market\'s share', render: (x) => (x.c && x.c.markets.length ? h('span', { title: 'Share of positions (closed and open): ' + x.c.markets.map((m) => `${m.t} ${U.fmtPct(m.share, { dp: 0 })}`).join(' · ') }, x.c.markets.slice(0, 2).map((m) => m.t.replace(/-USD$/, '')).join(' · '), x.c.nMarkets > 2 ? h('span.dim', ' +' + (x.c.nMarkets - 2)) : null) : h('span.dim', '—')) },
              { key: 'dd', label: 'Max DD', num: true, sortVal: 1, title: 'All-time drawdown on the site\'s net PnL (funding and mPerp position fees as charged), deposits and withdrawals left out', render: (x) => { const v = x.r.stats.all.ddPct; return v == null || !(v > 0) ? h('span.dim', '—') : U.fmtDd(v); } },
              { key: 'go', label: '', render: (x) => h('div.row', { style: { gap: '6px' } }, h('a.btn.sm', { href: '#/copytrade/sim?address=' + x.r.account + '&sub=' + x.r.sid, onclick: (e) => e.stopPropagation(), title: 'Replay this account as a copier' }, 'Simulate'), h('a.btn.sm.ghost', { href: U.accountUrl(x.r.account, x.r.sid), onclick: (e) => e.stopPropagation(), title: 'Open the account page' }, 'Account')) },
            ],
            phone: { lead: 'rank', title: 'w', wide: ['score', 'go'] },   // a phone: the score badge and the buttons two thirds of their line
            rows: slice, empty: state.filter === 'copyable' ? `No wallet is copyable yet (a score of ${AN.COPY.copyableAt}+ with ${U.fmtUsd(AN.COPY.minPnl, { dp: 0 })}+ made all-time)` : state.filter === 'scored' ? `No wallet has ${AN.COPY.minClosed} closed positions yet` : 'No traders in the snapshot',
            onRow: (x) => { if (x.sc) openLeader(x.r, x.sc); else location.hash = U.accountUrl(x.r.account, x.r.sid).slice(1); },
          }),
          rows.length > PAGE ? UI.pager({ page: state.page, pageSize: PAGE, total: rows.length, onPage: (p) => { state.page = p; render(); tableWrap.scrollIntoView({ block: 'start' }); } }) : null);
        const copyable = scored.filter((x) => x.sc && x.sc.verdict === 'Copyable').length, nScored = scored.filter((x) => x.sc).length;
        // as the Leaderboard says it: accounts missing from the snapshot, rows carried over from an earlier build, staleness
        U.replace(summary, `${rows.length} of ${traders.length} traders · ${nScored} scored · ${copyable} copyable · snapshot `, U.agoEl(data.builtAt), LB ? LB.coverageNote(data) : null, UI.staleNote(data.builtAt, 'the publishing job may be down'));
      }
      render();
      // keep the page current with the published snapshot
      const tick = setInterval(async () => { if (ctx.signal.aborted) return; const d = await LB.loadRemote(); if (d && data && d.builtAt !== data.builtAt) { data = d; render(); } }, 60000);
      ctx.onCleanup(() => clearInterval(tick));
    },
  };
})();
