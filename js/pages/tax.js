/* MeridianDataHub — Tax center: fiscal-year reports for one subaccount (and the wallet's Predict activity):
   summary, gains/losses, income vs expenses, monthly / quarterly / per-market breakdowns, a full transaction ledger,
   report currency at ECB daily rates, and exports for accountants and tax tools. Records only, not advice. */
(function () {
  const MD = window.MD; const U = MD.util; const A = MD.api; const AN = MD.analytics; const UI = MD.ui; const C = MD.charts; const h = U.h;
  const isAbort = (e) => e && e.name === 'AbortError';
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const isoTime = (ms) => new Date(U.num(ms)).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const isoDate = (ms) => new Date(U.num(ms)).toISOString().slice(0, 10);
  const utcDate = (ms, year = true) => { const d = new Date(U.num(ms)); return MON[d.getUTCMonth()] + ' ' + d.getUTCDate() + (year ? ', ' + d.getUTCFullYear() : ''); };   // the page is UTC throughout; U.fmtDate is local time
  const n6 = (x) => String(Math.round(U.num(x) * 1e6) / 1e6);
  const PAGE = 25;
  const YEAR_MS = 365 * U.DAY;

  // ---------- fiscal years ----------
  // key → first day of the fiscal year (UTC month index, day). The report year is the calendar year the period starts in.
  const FY = {
    cal: { label: 'Calendar year · Jan 1 – Dec 31 (US, EU, CA, JP, …)', m: 0, d: 1 },
    uk: { label: 'United Kingdom · 6 Apr – 5 Apr', m: 3, d: 6 },
    au: { label: 'Australia · 1 Jul – 30 Jun', m: 6, d: 1 },
    nz: { label: 'New Zealand · 1 Apr – 31 Mar', m: 3, d: 1 },
    in: { label: 'India · 1 Apr – 31 Mar', m: 3, d: 1 },
    za: { label: 'South Africa · 1 Mar – 28 Feb', m: 2, d: 1 },
    eg: { label: 'Egypt, Pakistan · 1 Jul – 30 Jun', m: 6, d: 1 },
  };
  const fyStart = (key, y) => Date.UTC(y, FY[key].m, FY[key].d);
  const fyLabel = (key, y) => (key === 'cal' ? 'Tax year ' + y : `Tax year ${y}/${String(y + 1).slice(2)}`);

  // ---------- report currency (ECB reference rates via frankfurter.dev, daily, carried over weekends) ----------
  const CCY = ['USD', 'EUR', 'GBP', 'CHF', 'CAD', 'AUD', 'NZD', 'JPY', 'SGD', 'HKD', 'INR', 'KRW', 'BRL', 'MXN', 'ZAR', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'TRY', 'ILS', 'PHP', 'THB', 'MYR', 'IDR', 'CNY'];
  async function loadRates(ccy, start, end, signal) {
    if (ccy === 'USD') return null;
    const from = isoDate(start - 10 * U.DAY), to = isoDate(Math.min(end - 1, Date.now()));
    const key = `md.fx.${ccy}.${from}.${to}`;
    let raw = null; try { raw = JSON.parse(sessionStorage.getItem(key) || 'null'); } catch (_) {}
    if (!raw) {
      const r = await fetch(`https://api.frankfurter.dev/v1/${from}..${to}?base=USD&symbols=${ccy}`, { signal });
      if (!r.ok) throw new Error('FX rates unavailable (' + r.status + ')');
      raw = await r.json();
      try { sessionStorage.setItem(key, JSON.stringify(raw)); } catch (_) {}
    }
    const days = Object.keys(raw.rates || {}).sort().map((d) => ({ t: Date.parse(d + 'T00:00:00Z'), r: raw.rates[d][ccy] })).filter((x) => x.r);
    if (!days.length) throw new Error('No ' + ccy + ' rates for the period');
    return { ccy, days, at(t) { let r = days[0].r; for (const d of days) { if (d.t <= t) r = d.r; else break; } return r; }, last: days[days.length - 1] };
  }

  // ---------- CSV ----------
  const cell = U.csvCell;   // quotes, and defuses text that a spreadsheet would run as a formula
  const toCsv = (cols, rows) => [cols.map((c) => cell(c[0])).join(',')].concat(rows.map((r) => cols.map((c) => cell(c[1](r))).join(','))).join('\r\n');
  const download = (name, text) => {
    const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name }); document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    U.toast('Downloaded ' + name);
  };
  const busyFn = (btn, fn) => async () => { btn.disabled = true; const old = Array.from(btn.childNodes); U.replace(btn, h('span.spinner'), ' Preparing…'); try { await fn(); } catch (e) { if (!isAbort(e)) U.toast('Export failed: ' + e.message); } btn.disabled = false; U.replace(btn, old); };
  const exBtn = (label, sub, fn, async) => { const b = h('button.btn', {}, U.icon('download'), label); b.addEventListener('click', async ? busyFn(b, fn) : fn); return h('div.metric', h('div', b), h('div.s', { style: { marginTop: '6px' } }, sub)); };

  /** Meridian Predict section: cash basis (booked when a prediction is settled, i.e. claimed), with the decided-but-
   *  unclaimed tail shown separately so the two never get confused. Built from the wallet's own predictions in both modes:
   *  the exchange's account stats book PnL at the verdict, not at the claim (checked: their cumulative PnL equals the sum
   *  of every decided prediction, claimed or not), so they serve only for the collateral figures of right now. */
  async function renderPredict(card, addr, start, end, fname, money, pnlEl) {
    const P = MD.predict;
    // the Meridian app places predictions from a smart account the address owns (its Predict wallet), not from the
    // address itself: everything below is that wallet's
    const pw = await P.wallets.predictAddress(addr);
    const perpsAddr = addr; addr = pw.address;
    const walletLink = (w) => h('a.addr', { href: '#/predict/bettor?address=' + w, title: w }, U.shortAddr(w, 4));
    const via = pw.error ? h('span.small', { style: { color: 'var(--amber)' } }, 'Could not look up the Predict wallet of this address (the Robinhood Chain RPC did not answer): these are only the predictions placed from the address itself. Reload to try again · ')
      : pw.via ? h('span.dim.small', 'Predict wallet ', walletLink(pw.via), ' (the smart account of ', U.shortAddr(perpsAddr, 4), ')', pw.also ? h('span', { style: { color: 'var(--amber)' } }, ' · the address itself has predictions of its own too, not in these figures: ', walletLink(pw.also)) : null, ' · ') : null;
    const live = await P.live();
    let history, snapNorms = null, builtAt = null, lastAll = null, truncated = false, trades = [];
    if (live) {
      const [acct, raw, tf] = await Promise.all([P.account(addr, { interval: 'DAY', fromSec: Math.floor(start / 1000) - 86400, toSec: Math.floor(end / 1000), ttl: 60000 }), P.predictionsOf(addr, { maxPages: 40 }), P.snapshotFile('bettors/' + addr + '.json').catch(() => null)]);
      lastAll = acct.history.length ? acct.history[acct.history.length - 1] : null;
      snapNorms = raw.map(P.norm).filter((n) => n.predictor === addr && !P.selfMatch(n));   // a bet against itself moves no money
      truncated = !!raw.truncated; trades = (tf && tf.trades) || [];
    } else {
      const f = await P.snapshotFile('bettors/' + addr + '.json');
      if (!f) { U.replace(card, h('div.row', h('h2', 'Meridian Predict'), UI.chip('prediction markets', 'accent'), h('span.grow'), via), h('div.empty', 'No Meridian Predict activity for this wallet (as of the last snapshot).')); return null; }
      snapNorms = f.predictions.map(P.unslim).filter((n) => n.predictor === addr && !P.selfMatch(n)); builtAt = f.builtAt; truncated = !!f.truncated; trades = f.trades || [];
    }
    // Secondary market (P.ledger, checked against the exchange for every trading wallet): a prediction whose tokens were
    // traded is booked through the ledger instead of on its own settlement. A sale is a disposal on its own date (its
    // price minus the tokens' cost), holding both sides books the amount they pay on the day both are held, and the verdict
    // on what was still held is booked when it is claimed (or shown as decided, not claimed, until then).
    const L = P.ledger(snapNorms, trades, addr);
    const heldOf = (n) => { const bp = L.byPrediction[n.id]; return bp ? bp.held : 1; };
    history = P.historyFromPredictions(snapNorms, addr, false);
    if (L.events.length || Object.keys(L.byPrediction).length) {
      const byDay = new Map(history.map((r) => [r.t, r]));
      const bucket = (t) => { const k = Math.floor(t / U.DAY) * U.DAY; let r = byDay.get(k); if (!r) { r = { t: k, pnl: 0, volume: 0, total: 0, won: 0, lost: 0, pending: 0, nonDecisive: 0, deployed: 0, claimable: 0 }; byDay.set(k, r); } return r; };
      for (const n of snapNorms) if (L.byPrediction[n.id] && n.settled && n.settledAt) bucket(n.settledAt).pnl -= n.pnl;
      for (const e of L.events) { const t = e.kind === 'verdict' ? e.claimAt : e.t; if (!t) continue; const r = bucket(t); r.pnl += e.pnl; if (e.kind !== 'verdict') r.secondary = (r.secondary || 0) + e.pnl; }
      history = Array.from(byDay.values()).sort((a, b) => a.t - b.t); let cum = 0; for (const r of history) { cum += r.pnl; r.cumPnl = cum; }
    }
    const sales = L.events.filter((e) => e.kind !== 'verdict' && e.t >= start && e.t < end);
    const rows = history.filter((x) => x.t >= start && x.t < end);
    const T = rows.reduce((a, x) => { a.pnl += x.pnl; a.pnlC += money.fx(x.pnl, x.t); a.volume += x.volume; a.won += x.won; a.lost += x.lost; a.nd += x.nonDecisive; a.total += x.total; return a; }, { pnl: 0, pnlC: 0, volume: 0, won: 0, lost: 0, nd: 0, total: 0 });
    if (!T.total && !T.volume && !T.pnl && !(lastAll && (lastAll.claimable || lastAll.deployed))) { U.replace(card, h('div.row', h('h2', 'Meridian Predict'), UI.chip('prediction markets', 'accent'), h('span.grow'), via), h('div.empty', 'No Meridian Predict activity for this wallet in the period.')); return null; }
    // decided but unclaimed: the verdict is in, no cash has moved. Decided when its last question ended (the API keeps no
    // decision timestamp), so the tail lands in the right year
    const decidedAt = (n) => Math.max(n.t, ...n.picks.map((k) => U.num(k.endTime) || 0));
    const inPeriod = (n) => { const t = decidedAt(n); return t >= start && t < end; };
    // traded predictions: only the share still held is this wallet's to claim (the ledger's unclaimed verdicts)
    const unclaimed = snapNorms.filter((n) => n.unclaimed && inPeriod(n) && !L.byPrediction[n.id]);
    const ledgerUnclaimed = L.events.filter((e) => e.kind === 'verdict' && !e.claimAt && e.t >= start && e.t < end);
    const unclaimedPnl = U.sum(unclaimed, (n) => n.pnl) + U.sum(ledgerUnclaimed, (e) => e.pnl);
    const unclaimedWon = unclaimed.filter((n) => n.won).concat(ledgerUnclaimed.filter((e) => e.cash > 0));
    const unclaimedN = unclaimed.length + ledgerUnclaimed.length;
    const months = {};
    for (const x of rows) { const d = new Date(x.t); const k = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); const m = months[k] || (months[k] = { key: k, label: MON[d.getUTCMonth()] + ' ' + d.getUTCFullYear(), pnl: 0, pnlC: 0, volume: 0, won: 0, lost: 0, total: 0 }); m.pnl += x.pnl; m.pnlC += money.fx(x.pnl, x.t); m.volume += x.volume; m.won += x.won; m.lost += x.lost; m.total += x.total; }
    const monthly = Object.values(months).sort((a, b) => (a.key < b.key ? -1 : 1));
    card.dataset.pnl = n6(T.pnl);
    const tiles = h('div.stats',
      UI.stat('Realized PnL', money.fmt(T.pnlC, { sign: true }), (sales.length ? 'settled (claimed) predictions and secondary-market sales' : 'settled (claimed) predictions') + ' in period · cash basis', U.pnlClass(T.pnl)),
      UI.stat('Wagered', money.usd(T.volume), 'stakes placed in period'),
      UI.stat('Predictions', String(T.total), `placed in period · settled in period: ${T.won} won · ${T.lost} lost` + (T.nd ? ` · ${T.nd} void` : '')),
      unclaimedN ? UI.stat('Decided, not claimed', money.usd(unclaimedPnl, { sign: true }), `${unclaimedWon.length} won · ${unclaimedN - unclaimedWon.length} lost · decided in period, not in the cash-basis total until claimed`, U.pnlClass(unclaimedPnl)) : null,
      sales.length ? UI.stat('Secondary market', money.fmt(U.sum(sales, (e) => money.fx(e.pnl, e.t)), { sign: true }), `${sales.filter((e) => e.kind === 'sale').length} sale${sales.filter((e) => e.kind === 'sale').length === 1 ? '' : 's'} · ${money.usd(U.sum(sales.filter((e) => e.kind === 'sale'), (e) => e.cash))} proceeds · in the realized total`, U.pnlClass(U.sum(sales, (e) => e.pnl))) : null,
      live ? UI.stat('Claimable now', money.usd(lastAll ? lastAll.claimable : 0), 'won, not yet redeemed') : UI.stat('Open stakes now', money.usd(U.sum(snapNorms.filter((n) => !n.decided), (n) => n.stake)), 'in undecided predictions'),
      live ? UI.stat('In open positions', money.usd(lastAll ? lastAll.deployed : 0), 'collateral deployed now') : UI.stat('Snapshot', U.fmtAgo(builtAt), 'live account stats need API access'));
    const tbl = UI.table({ cols: [
      { key: 'm', label: 'Month', render: (m) => m.label },
      { key: 'p', label: 'Realized PnL', num: true, render: (m) => pnlEl(m.pnlC, m.pnl) },
      { key: 'v', label: 'Wagered', num: true, render: (m) => money.usd(m.volume) },
      { key: 'n', label: 'Predictions', num: true, render: (m) => String(m.total) },
      { key: 'w', label: 'Won / lost', num: true, render: (m) => `${m.won} / ${m.lost}` },
    ], rows: monthly, empty: 'No activity in this period' });
    const exportDaily = () => download(fname('predict-daily-ledger'), toCsv([['Date (UTC)', (x) => isoDate(x.t)], ['Realized PnL USD', (x) => n6(x.pnl)], ...money.csvCol((x) => x.pnl, (x) => x.t, 'Realized PnL'), ['of which secondary market USD', (x) => n6(x.secondary || 0)], ['Cumulative PnL USD', (x) => n6(x.cumPnl)], ['Wagered USD', (x) => n6(x.volume)], ['Predictions placed', (x) => x.total], ['Settled won', (x) => x.won], ['Settled lost', (x) => x.lost], ['Settled void', (x) => x.nonDecisive]], rows));
    const exportBets = async () => {
      if (truncated) U.toast('Only the newest predictions could be read; the export may miss older ones');
      const norms = snapNorms.filter((n) => n.settled && n.settledAt && n.settledAt >= start && n.settledAt < end).sort((a, b) => b.settledAt - a.settledAt);
      // a prediction whose tokens were sold: the settlement concerns only the share still held (the sale is in the trades file)
      download(fname('predict-settled-bets'), toCsv([['Settled (UTC)', (n) => isoTime(n.settledAt)], ['Placed (UTC)', (n) => isoTime(n.t)], ['Picks', (n) => n.picks.map((k) => (k.yes ? 'YES: ' : 'NO: ') + k.q).join(' | ')], ['Legs', (n) => n.legs], ['Category', (n) => n.cat], ['Stake USD', (n) => n6(n.stake)], ['Maker collateral USD', (n) => n6(n.cp)], ['Locked odds', (n) => (n.odds == null ? '' : n6(n.odds))], ['Result', (n) => n.result], ['Share still held at settlement', (n) => n6(heldOf(n))], ['Realized PnL USD', (n) => n6(n.pnl * heldOf(n))], ...money.csvCol((n) => n.pnl * heldOf(n), (n) => n.settledAt, 'Realized PnL'), ['Market maker', (n) => n.counterparty], ['Prediction ID', (n) => n.id], ['Tx', (n) => n.tx || '']], norms));
    };
    const exportTrades = () => {
      const saleOf = new Map(L.events.filter((e) => e.kind === 'sale' && e.trade).map((e) => [e.trade, e]));
      const list = L.trades.filter((t) => t.t >= start && t.t < end).slice().sort((a, b) => a.t - b.t);
      const realized = (t) => { if (t.seller === addr) { const e = saleOf.get(t); return e ? e.pnl : null; } return null; };
      download(fname('predict-secondary-trades'), toCsv([['Time (UTC)', (t) => isoTime(t.t)], ['Trade', (t) => (t.seller === addr ? 'sold' : 'bought')], ['Prediction', (t) => (t.q || '') + (t.legs > 1 ? ` (+${t.legs - 1} legs)` : '')], ['Counterparty', (t) => (t.seller === addr ? t.buyer : t.seller)], ['Tokens (1 USDe each if the side wins)', (t) => n6(t.tokens)], ['Price per token', (t) => (t.tokens ? n6(t.paid / t.tokens) : '')], ['Amount USD', (t) => n6(t.paid)], ['Cost basis USD (sales)', (t) => { const e = t.seller === addr ? saleOf.get(t) : null; return e ? n6(e.cost) : ''; }], ['Realized PnL USD (sales)', (t) => { const r = realized(t); return r == null ? '' : n6(r); }], ...money.csvCol((t) => realized(t) || 0, (t) => t.t, 'Realized PnL'), ['Tx', (t) => t.tx || '']], list));
    };
    U.replace(card,
      h('div.row.wrap', { style: { marginBottom: '10px' } }, h('h2', 'Meridian Predict'), UI.chip('prediction markets', 'accent'), h('span.grow'), via, h('span.dim.small', (live ? 'from the wallet\'s predictions (collateral now from the exchange\'s account stats)' : 'from the wallet\'s predictions in the published snapshot') + ' · USDe')),
      truncated ? h('div.small', { style: { color: 'var(--amber)', marginBottom: '10px' } }, `Only the newest ${U.fmtNum(snapNorms.length, 0)} predictions of this wallet could be read${live ? '' : ' from the snapshot'}; settlements of older ones are missing from the figures below.`) : null,
      tiles,
      h('div', { style: { margin: '14px 0' } }, h('div.card.tight', tbl)),
      h('div.metric-list.no-print', exBtn('Predict daily ledger', 'One row per day: realized PnL (on settlement), wagered, predictions placed, and those settled won, lost or void.', exportDaily), exBtn('Predict settled bets', 'Every prediction settled in the period with picks, stake, odds, result and PnL.', exportBets, true), L.trades.length ? exBtn('Predict secondary-market trades', 'Every position sold or bought in the period: tokens, price, cost basis and realized PnL of each sale.', exportTrades) : null),
      h('div.footer-note', { style: { textAlign: 'left', paddingBottom: 0 } }, 'Predict PnL is booked here when a prediction is settled (claimed): a win pays the maker\'s collateral, a loss forfeits the stake. A position sold on the secondary market is a disposal on the day of the sale: its price minus what the tokens cost (the stake, in proportion); only the share still held settles later. Predictions the exchange has already decided but nobody has claimed are shown separately; whether they count in the year they were decided or the year they are claimed depends on your rules.'));
    return { pnl: T.pnl, pnlC: T.pnlC, unclaimedPnl };
  }

  MD.router.pages.tax = {
    async mount(root, route, ctx) {
      MD.setTopbar(h('span.title', 'Tax center'));
      const last = U.storage.get('md.lastAccount', null) || {};
      let addr = String(route.params.address || last.address || '').trim().toLowerCase();
      let subParam = route.params.sub || (addr && addr === String(last.address || '').toLowerCase() ? last.sub : null);

      // ---- account picker ----
      const input = h('input.input', { placeholder: 'Wallet address (0x…) or subaccount ID', value: addr, spellcheck: false });
      const subSel = h('select.input', { style: { display: 'none', width: 'auto' }, onchange: (e) => { MD.router.setParams({ sub: e.target.value }); } });
      const pickErr = h('div.small.neg', { style: { minHeight: '16px', marginTop: '6px' } });
      const picker = h('form.row.wrap', { onsubmit: async (e) => {
        e.preventDefault(); pickErr.textContent = '';
        const v = input.value.trim();
        if (U.isAddress(v)) { MD.router.setParams({ address: v.toLowerCase(), sub: null }); return; }
        if (U.isUuid(v)) { try { const sa = await A.subaccount(v); MD.router.setParams({ address: sa.account, sub: sa.id }); } catch (err) { pickErr.textContent = 'Subaccount not found'; } return; }
        pickErr.textContent = 'Enter a 0x wallet address or a subaccount ID';
      } }, h('div.grow', input), subSel, h('button.btn.primary', { type: 'submit' }, 'Load'));
      const head = h('div.card',
        h('div.row.wrap', { style: { marginBottom: '6px' } }, h('h2', 'Tax center'), UI.chip('records · not advice', ''), h('span.grow'), MD.defsLink(), h('button.btn.sm.ghost.no-print', { onclick: () => window.print() }, U.icon('printer'), 'Print / PDF')),
        h('p.muted', { style: { margin: '0 0 12px', maxWidth: '900px' } }, 'A complete tax report for a Meridian subaccount: gains and losses, income and expenses, monthly, quarterly and per-market breakdowns, every transaction, and exports for accountants and tax tools, for any fiscal year and in your reporting currency. All timestamps are UTC; everything settles in USDe (shown at 1 USDe = 1 USD).'),
        picker, pickErr);
      const body = h('div.stack');
      U.replace(root, h('div.page', h('div.stack', head, body)));

      if (!U.isAddress(addr)) { U.replace(body, h('div.card', h('div.empty', 'Enter a wallet address above, or open any account page and press "Tax" in its header.'))); return; }

      // ---- resolve subaccount ----
      let subs, sa, ref;
      try { [subs, ref] = await Promise.all([A.subaccountsOf(addr, ctx), A.ref(ctx)]); }
      catch (e) { if (isAbort(e)) return; U.replace(body, UI.error(e, () => MD.router.dispatch())); return; }
      sa = subs.length ? (subs.find((s) => s.id === subParam) || subs[0]) : null;
      if (subs.length > 1) { subSel.style.display = ''; U.replace(subSel, subs.map((s) => h('option', { value: s.id, selected: s.id === sa.id }, U.decodeBytes32(s.name)))); }
      const sid = sa ? sa.id : null;

      // ---- period: fiscal-year preset + year, or a custom range ----
      const fy = FY[route.params.fy] ? route.params.fy : 'cal';
      const now = Date.now();
      const firstT = sa ? (U.num(sa.createdAt) || now) : Date.UTC(2026, 5, 1);
      // fiscal years that overlap [first activity, now]
      const years = []; { const y0 = new Date(firstT).getUTCFullYear() - 1, y1 = new Date(now).getUTCFullYear(); for (let y = y1; y >= y0; y--) { const s = fyStart(fy, y), e = fyStart(fy, y + 1); if (s <= now && e > firstT) years.push(y); } }
      if (!years.length) years.push(new Date(now).getUTCFullYear());
      let start, end, label, mode, year = null;
      if (route.params.from && route.params.to) { mode = 'custom'; start = Date.parse(route.params.from + 'T00:00:00Z'); end = Date.parse(route.params.to + 'T00:00:00Z') + U.DAY; label = route.params.from + ' → ' + route.params.to; }
      else { mode = 'year'; year = years.includes(U.num(route.params.year)) ? U.num(route.params.year) : years[0]; start = fyStart(fy, year); end = Math.min(fyStart(fy, year + 1), now); label = fyLabel(fy, year); }
      if (!(end > start)) { U.replace(body, h('div.card', h('div.error', 'Invalid period.'))); return; }
      const ccy = CCY.includes(route.params.ccy) ? route.params.ccy : (U.storage.get('md.tax.ccy', 'USD') || 'USD');
      const fySel = h('select.input.sm', { style: { width: 'auto' }, onchange: (e) => MD.router.setParams({ fy: e.target.value === 'cal' ? null : e.target.value, from: null, to: null }) }, Object.entries(FY).map(([k, v]) => h('option', { value: k, selected: k === fy }, v.label)));
      const yearSeg = UI.seg(years.map((y) => ({ v: y, label: fy === 'cal' ? String(y) : `${y}/${String(y + 1).slice(2)}` })), mode === 'year' ? year : null, (y) => MD.router.setParams({ year: y, from: null, to: null }), 'sm');
      const fromIn = h('input.input.sm', { type: 'date', value: route.params.from || isoDate(start), style: { width: 'auto' } });
      const toIn = h('input.input.sm', { type: 'date', value: route.params.to || isoDate(end - 1), style: { width: 'auto' } });
      const ccySel = h('select.input.sm', { style: { width: 'auto' }, title: 'Reporting currency · ECB daily reference rates', onchange: (e) => { U.storage.set('md.tax.ccy', e.target.value); MD.router.setParams({ ccy: e.target.value === 'USD' ? null : e.target.value }); } }, CCY.map((c) => h('option', { value: c, selected: c === ccy }, c)));
      const controls = h('div.card.no-print', h('div.row.wrap', { style: { rowGap: '10px' } },
        h('span.dim.small', 'Fiscal year'), fySel, yearSeg, h('span.dim.small', 'or custom (UTC)'), fromIn, h('span.dim', '→'), toIn,
        h('button.btn.sm', { onclick: () => { if (fromIn.value && toIn.value && fromIn.value <= toIn.value) MD.router.setParams({ from: fromIn.value, to: toIn.value, year: null }); } }, 'Apply'),
        h('span.grow'), h('span.dim.small', 'Report in'), ccySel));
      const status = h('div.card', UI.loading('Collecting daily ledgers and position history…'));
      U.replace(body, controls, status);

      // ---- money: report currency at the day's rate; CSVs always carry USD and, when chosen, the converted column ----
      let rates = null, fxNote = null;
      if (ccy !== 'USD') { try { rates = await loadRates(ccy, start, end, ctx.signal); } catch (e) { if (isAbort(e)) return; fxNote = 'Rates for ' + ccy + ' could not be loaded (' + e.message + '); amounts are in USD.'; } }
      const cur = rates ? ccy : 'USD';
      const nf = (dp) => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: dp, maximumFractionDigits: dp });
      const DP = ['JPY', 'KRW', 'IDR'].includes(cur) ? 0 : 2;
      const money = {
        ccy: cur, rates,
        fx: (usd, t) => (rates ? usd * rates.at(t) : usd),                       // USD amount at time t → report currency
        fmt: (v, opts = {}) => {                                                   // format an amount already in the report currency: cents, like a statement
          const dp = opts.dp != null ? opts.dp : DP;
          if (!opts.compact && Math.abs(v) < Math.pow(10, -dp) / 2) v = 0;         // no "-$0.00"
          if (cur === 'USD') return U.fmtUsd(v, opts.compact ? opts : Object.assign({}, opts, { dp }));
          const s = v < 0 ? '-' : opts.sign && v > 0 ? '+' : ''; const a = Math.abs(v);
          if (opts.compact) return s + (a >= 1e6 ? nf(2).format(a / 1e6) + 'M' : a >= 1e4 ? nf(1).format(a / 1e3) + 'K' : nf(dp).format(a));
          return s + nf(dp).format(a);
        },
        usd: (v, opts) => (cur === 'USD' ? U.fmtUsd(v, opts) : money.fmt(rates ? v * rates.last.r : v, opts)),   // a USD amount with no date: today's rate
        csvCol: (getUsd, getT, name) => (rates ? [[name + ' ' + cur, (r) => n6(getUsd(r) * rates.at(getT(r)))]] : []),
      };
      const pnlEl = (vC, vUsd) => h('span', { class: 'num ' + U.pnlClass(vUsd != null ? vUsd : vC) }, money.fmt(vC, { sign: true }));
      const fname = (kind) => `meridian-${kind}-${U.shortAddr(addr, 4).replace('…', '-')}-${isoDate(start)}_${isoDate(end - 1)}.csv`;

      if (!sa) {
        // Predict-only wallet: no perps ledgers, but the prediction-market section still applies
        const predictOnly = h('div.card', h('div.row', h('h2', 'Meridian Predict'), UI.chip('prediction markets', 'accent')), h('div.empty', h('span.loading', h('span.spinner'), 'Loading Predict history…')));
        U.replace(body, controls, h('div.card', h('div.empty', 'This wallet has no Meridian perps subaccount, so there are no perps ledgers to report. Prediction-market activity is below.')), predictOnly);
        renderPredict(predictOnly, addr, start, end, fname, money, pnlEl).catch((e) => { if (!isAbort(e)) U.replace(predictOnly, h('div.row', h('h2', 'Meridian Predict')), UI.error(e)); });
        return;
      }

      // ---- data ----
      let series, positions, openNow = [], balRaw = [];
      try {
        const [bal, vol, pos] = await Promise.all([
          A.history('balance', sid, { start: start - U.DAY, end, resolution: 'day1', signal: ctx.signal, ttl: 5 * 60000 }),
          A.history('volume', sid, { start: start - U.DAY, end, resolution: 'day1', signal: ctx.signal, ttl: 5 * 60000 }),
          A.positions(sid, { maxPages: 25, signal: ctx.signal, ttl: 5 * 60000 }),
        ]);
        series = AN.buildSeries({ balance: bal, upnl: [], volume: vol });
        balRaw = bal;
        positions = pos;
        openNow = positions.filter((p) => U.num(p.size) !== 0);
      } catch (e) { if (isAbort(e)) return; U.replace(status, UI.error(e, () => MD.router.dispatch())); return; }
      const days = series.filter((b) => b.t >= start && b.t < end);
      // Position fees on mPerp markets are charged while a position is open and are missing from the exchange's daily fee
      // line, so they are taken from the positions and spread over each position's holding time. A position that spans
      // the period's start or end therefore contributes only the share that falls inside the period (attributing the whole
      // fee to the close would move it into the wrong year and break the balance reconciliation on both sides).
      const posFeeShare = (p, a, b) => { const pf = U.num(p.positionFeeAccruedUsd); if (!pf) return 0; const t0 = U.num(p.createdAt), t1 = U.num(p.size) !== 0 ? now : Math.max(U.num(p.updatedAt), t0); if (t1 - t0 < 1000) return t0 >= a && t0 < b ? pf : 0; const ov = Math.min(t1, b) - Math.max(t0, a); return ov > 0 ? pf * Math.min(1, ov / (t1 - t0)) : 0; };
      const pfPos = positions.filter((p) => U.num(p.positionFeeAccruedUsd) > 0 && U.num(p.createdAt) < end && (U.num(p.size) !== 0 || U.num(p.updatedAt) >= start));
      const spanning = pfPos.filter((p) => U.num(p.createdAt) < start || (U.num(p.size) !== 0 ? now : U.num(p.updatedAt)) >= end).length;
      for (const b of days) { b.pfees = U.sum(pfPos, (p) => posFeeShare(p, b.t, b.t + U.DAY)); b.net = b.realizedPnl - b.fee - b.pfees + b.funding; b.C = { realizedPnl: money.fx(b.realizedPnl, b.t), fee: money.fx(b.fee, b.t), pfees: money.fx(b.pfees, b.t), funding: money.fx(b.funding, b.t), deposit: money.fx(b.deposit, b.t), withdrawal: money.fx(b.withdrawal, b.t), wfee: money.fx(b.wfee || 0, b.t), volume: money.fx(b.volume, b.t), net: money.fx(b.net, b.t) }; }
      const sumU = (k) => U.sum(days, (b) => b[k]), sumC = (k) => U.sum(days, (b) => b.C[k]);
      const T = { realized: sumU('realizedPnl'), fees: sumU('fee'), posFees: sumU('pfees'), funding: sumU('funding'), deposits: sumU('deposit'), withdrawals: sumU('withdrawal'), wfee: U.sum(days, (b) => b.wfee || 0), volume: sumU('volume') };
      const TC = { realized: sumC('realizedPnl'), fees: sumC('fee'), posFees: sumC('pfees'), funding: sumC('funding'), deposits: sumC('deposit'), withdrawals: sumC('withdrawal'), wfee: sumC('wfee'), volume: sumC('volume') };
      T.net = T.realized - T.fees - T.posFees + T.funding;
      TC.net = TC.realized - TC.fees - TC.posFees + TC.funding;
      // funding received vs paid needs the sign per day (the ledger nets within a day, close enough for a split)
      const fundingIn = U.sum(days, (b) => Math.max(0, b.funding)), fundingOut = -U.sum(days, (b) => Math.min(0, b.funding));
      const fundingInC = U.sum(days, (b) => Math.max(0, b.C.funding)), fundingOutC = -U.sum(days, (b) => Math.min(0, b.C.funding));

      // monthly and fiscal quarters
      const months = {};
      for (const b of days) { const d = new Date(b.t); const k = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); const m = months[k] || (months[k] = { key: k, t: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), t0: b.t, t1: b.t, label: MON[d.getUTCMonth()] + ' ' + d.getUTCFullYear(), realized: 0, fees: 0, pfees: 0, funding: 0, deposits: 0, withdrawals: 0, volume: 0, net: 0, C: { realized: 0, fees: 0, pfees: 0, funding: 0, deposits: 0, withdrawals: 0, volume: 0, net: 0 }, days: 0 }); m.t0 = Math.min(m.t0, b.t); m.t1 = Math.max(m.t1, b.t); m.realized += b.realizedPnl; m.fees += b.fee; m.pfees += b.pfees; m.funding += b.funding; m.deposits += b.deposit; m.withdrawals += b.withdrawal; m.volume += b.volume; m.net += b.net; m.C.realized += b.C.realizedPnl; m.C.fees += b.C.fee; m.C.pfees += b.C.pfees; m.C.funding += b.C.funding; m.C.deposits += b.C.deposit; m.C.withdrawals += b.C.withdrawal; m.C.volume += b.C.volume; m.C.net += b.C.net; m.days++; }
      let monthly = Object.values(months).sort((a, b) => (a.key < b.key ? -1 : 1));
      const quiet = (m) => !m.realized && !m.fees && !m.pfees && !m.funding && !m.deposits && !m.withdrawals && !m.volume;
      while (monthly.length > 1 && quiet(monthly[0])) monthly = monthly.slice(1);
      // a month cut by the period (a fiscal year starting on the 6th, a custom range) says so
      const monthCut = (m) => { const d = new Date(m.t); const mEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); const from = m.t0 > m.t ? 'from ' + utcDate(m.t0, false) : null; const to = m.t1 + U.DAY < mEnd ? 'to ' + utcDate(m.t1, false) : null; return [from, to].filter(Boolean).join(' · ') || null; };
      // Quarters: a fiscal year's quarters run from its first day in three-month steps (UK: 6 Apr – 5 Jul, 6 Jul – 5 Oct, …),
      // so days are assigned by date and a year that starts mid-month has no orphan thirteenth month. A custom range uses
      // calendar quarters.
      const qStart = (i) => (mode === 'year' ? Date.UTC(year, FY[fy].m + 3 * i, FY[fy].d) : null);
      const quarterOf = (t) => {
        if (mode === 'year') { let i = 0; while (i < 3 && t >= qStart(i + 1)) i++; return { q: i, y: year, label: 'Q' + (i + 1) + ' ' + fyLabel(fy, year).replace('Tax year ', ''), from: qStart(i), to: Math.min(qStart(i + 1), end) - 1 }; }
        const d = new Date(t); const q = Math.floor(d.getUTCMonth() / 3), y = d.getUTCFullYear();
        return { q, y, label: 'Q' + (q + 1) + ' ' + y, from: Math.max(Date.UTC(y, 3 * q, 1), start), to: Math.min(Date.UTC(y, 3 * q + 3, 1), end) - 1 };
      };
      let quarters = [];
      for (const b of days) { const qi = quarterOf(b.t); let row = quarters.find((x) => x.q === qi.q && x.y === qi.y); if (!row) { row = Object.assign({ realized: 0, fees: 0, pfees: 0, funding: 0, net: 0, deposits: 0, withdrawals: 0, volume: 0, C: { realized: 0, fees: 0, pfees: 0, funding: 0, net: 0 } }, qi); quarters.push(row); } row.realized += b.realizedPnl; row.fees += b.fee; row.pfees += b.pfees; row.funding += b.funding; row.net += b.net; row.deposits += b.deposit; row.withdrawals += b.withdrawal; row.volume += b.volume; row.C.realized += b.C.realizedPnl; row.C.fees += b.C.fee; row.C.pfees += b.C.pfees; row.C.funding += b.C.funding; row.C.net += b.C.net; }
      while (quarters.length > 1 && quiet(quarters[0])) quarters = quarters.slice(1);

      // closed positions in period (attributed to the close date), with gains / losses, holding period and term
      const closed = positions.filter((p) => U.num(p.size) === 0 && U.num(p.totalDecreaseQuantity) > 0 && U.num(p.updatedAt) >= start && U.num(p.updatedAt) < end)
        .map((p) => { const prod = ref.byId[p.productId]; const incQ = U.num(p.totalIncreaseQuantity), decQ = U.num(p.totalDecreaseQuantity); const fees = U.num(p.feesAccruedUsd), pfees = U.num(p.positionFeeAccruedUsd), fund = -U.num(p.fundingAccruedUsd), gross = U.num(p.realizedPnl); const net = gross - fees - pfees + fund; const hold = U.num(p.updatedAt) - U.num(p.createdAt); const rate = rates ? rates.at(U.num(p.updatedAt)) : 1; return { p, t: U.num(p.updatedAt), rate, ticker: prod ? prod.displayTicker : p.productId, tick: prod && prod.tickSize, long: String(p.side) === '0', size: incQ, entry: incQ ? U.num(p.totalIncreaseNotional) / incQ : 0, exit: decQ ? U.num(p.totalDecreaseNotional) / decQ : 0, cost: U.num(p.totalIncreaseNotional), proceeds: U.num(p.totalDecreaseNotional), gross, fees, pfees, funding: fund, net, netC: money.fx(net, U.num(p.updatedAt)), grossC: money.fx(gross, U.num(p.updatedAt)), hold, longTerm: hold > YEAR_MS, liq: !!p.isLiquidated, adl: !!p.wasDeleveraged }; })
        .sort((a, b) => b.t - a.t);
      const wins = closed.filter((c) => c.net > 0), losses = closed.filter((c) => c.net < 0);
      // gains / losses on the booked (gross) result, so gains + losses + partial closes = the ledger's realized PnL; fees and funding are their own lines
      const gWins = closed.filter((c) => c.gross > 0), gLosses = closed.filter((c) => c.gross < 0);
      const gains = U.sum(gWins, (c) => c.gross), lossSum = U.sum(gLosses, (c) => c.gross), gainsC = U.sum(gWins, (c) => c.grossC), lossSumC = U.sum(gLosses, (c) => c.grossC);
      const liqCount = closed.filter((c) => c.liq).length;
      const longTerm = closed.filter((c) => c.longTerm); const longTermNet = U.sum(longTerm, (c) => c.net), longTermNetC = U.sum(longTerm, (c) => c.netC);
      const longestHold = closed.length ? Math.max(...closed.map((c) => c.hold)) : 0;
      const largestWin = wins.length ? wins.reduce((a, c) => (c.net > a.net ? c : a)) : null, largestLoss = losses.length ? losses.reduce((a, c) => (c.net < a.net ? c : a)) : null;
      const closedGross = U.sum(closed, (c) => c.gross); const unlisted = T.realized - closedGross;
      // per market (closed positions)
      const byMarket = Object.values(closed.reduce((acc, c) => { const m = acc[c.ticker] || (acc[c.ticker] = { ticker: c.ticker, n: 0, wins: 0, gross: 0, fees: 0, funding: 0, net: 0, volume: 0, C: { gross: 0, fees: 0, funding: 0, net: 0, volume: 0 } }); m.n++; if (c.net > 0) m.wins++; m.gross += c.gross; m.fees += c.fees + c.pfees; m.funding += c.funding; m.net += c.net; m.volume += c.cost + c.proceeds; m.C.gross += c.gross * c.rate; m.C.fees += (c.fees + c.pfees) * c.rate; m.C.funding += c.funding * c.rate; m.C.net += c.netC; m.C.volume += (c.cost + c.proceeds) * c.rate; return acc; }, {})).sort((a, b) => b.volume - a.volume);
      // open at period end (not taxable yet, but part of a complete picture); for a past period the positions are known,
      // their unrealized PnL at that date is not
      const current = end >= now - U.DAY;
      const openAtEnd = current ? openNow : positions.filter((p) => U.num(p.createdAt) < end && (U.num(p.size) !== 0 || U.num(p.updatedAt) >= end));
      const openUpnl = U.sum(openNow, (p) => U.num(p.unrealizedPnl));

      // ---- balance reconciliation (an accountant's first check): opening + deposits − withdrawals + result = closing ----
      const beforeRows = series.filter((x) => x.t < start);
      const opening = beforeRows.length ? beforeRows[beforeRows.length - 1].balance : 0;
      const closing = days.length ? days[days.length - 1].balance : opening;
      const expected = opening + T.deposits - T.withdrawals + T.net;   // T.net already carries position fees
      const reconDiff = closing - expected;
      const poolDiffs = (() => {
        const byTok = U.groupBy(balRaw, (r) => r.tokenId || 'x'); const out = [];
        const signed = (r) => ['deposit', 'withdrawal', 'withdrawalFee', 'depositFee', 'conversionIn', 'conversionOut', 'realizedPnl', 'tradingFee', 'realizedFunding'].reduce((a, k) => a + U.num(r[k]), 0);
        for (const [tok, rows] of Object.entries(byTok)) {
          rows.sort((a, b) => a.time - b.time);
          const inP = rows.filter((r) => r.time >= start && r.time < end); if (!inP.length) continue;
          const before = rows.filter((r) => r.time < start); const first = before.length ? before[before.length - 1] : null; const lastRow = inP[inP.length - 1];
          const dBal = U.num(lastRow.balance) - (first ? U.num(first.balance) : 0);
          const dFlows = signed(lastRow) - (first ? signed(first) : 0);
          // position fees of this pool's markets, attributed to their close inside the period
          const t = ref.tokenById[tok]; const addr = t ? String(t.address).toLowerCase() : null;
          const pf = U.sum(pfPos.filter((p) => { const prod = ref.byId[p.productId]; return prod && String(prod.quoteTokenAddress).toLowerCase() === addr; }), (p) => posFeeShare(p, start, end));
          const diff = dBal - (dFlows - pf);
          if (Math.abs(diff) >= 0.005) out.push({ pool: t ? t.name : tok.slice(0, 8), diff });
        }
        return out;
      })();
      const reconRows = [['Opening balance', opening], ['+ Deposits', T.deposits], ['− Withdrawals (incl. fees)', -T.withdrawals], ['+ Realized PnL', T.realized], ['− Trading fees', -T.fees], ['− Position fees (mPerps)', -T.posFees], ['+ Funding', T.funding], ['= Expected closing balance', expected], ['Closing balance (ledger)', closing], ['Difference', reconDiff]];
      const reconCard = h('details.recon', { style: { marginTop: '12px' } }, h('summary.small', { style: { cursor: 'pointer', color: 'var(--text-2)' } }, 'Balance reconciliation · ', h('span', { class: Math.abs(reconDiff) < 0.05 ? 'pos' : 'neg' }, Math.abs(reconDiff) < 0.005 ? 'exact' : 'difference ' + U.fmtUsd(reconDiff, { sign: true, dp: 2 })), h('span.dim', ' · opening + deposits − withdrawals + result = closing')),
        h('div.card.tight', { style: { marginTop: '8px', maxWidth: '520px' } }, UI.table({ cols: [{ key: 'k', label: 'Step', render: (r) => h('span', { class: /^=|Closing|Difference/.test(r[0]) ? 'bold' : '' }, r[0]) }, { key: 'v', label: 'USD', num: true, render: (r) => h('span', { class: r[0] === 'Difference' ? (Math.abs(r[1]) < 0.05 ? 'pos' : 'neg') : '' }, U.fmtUsd(r[1], { sign: r[0] === 'Difference' || /^[+−]/.test(r[0]), dp: 2 })) }], rows: reconRows })),
        poolDiffs.length ? h('div.small', { style: { marginTop: '8px', color: 'var(--amber)' } }, (spanning ? 'Not fully explained by the ledger: ' : 'Unexplained by the ledger: ') + poolDiffs.map((d) => `${d.pool} pool ${U.fmtUsd(d.diff, { sign: true, dp: 2 })}`).join(', ') + '. ' + (spanning ? `${spanning} position${spanning > 1 ? 's' : ''} with position fees span${spanning > 1 ? '' : 's'} the period's start or end; their fees are apportioned by holding time, and the exchange charged them at some other moment, so a small difference is expected. Anything beyond that is a change the exchange made to the pool without a deposit, trade, fee or funding entry.` : 'The exchange changed that pool\'s balance without a deposit, trade, fee or funding entry for it; it is left out of every figure above and noted here so the report stays honest.')) : null,
        h('div.dim.small', { style: { marginTop: '6px' } }, 'Balances are summed across the account\'s margin pools; conversions between pools cancel out. Position fees on mPerp markets are not in the exchange\'s daily fee line, so they are taken from the positions themselves, spread over each position\'s holding time.'));

      // ---- summary tiles ----
      const tiles = h('div.stats',
        UI.stat('Net result', money.fmt(TC.net, { sign: true }), 'realized PnL − fees − position fees + funding', U.pnlClass(T.net)),
        UI.stat('Realized PnL', money.fmt(TC.realized, { sign: true }), 'gross, from position closes', U.pnlClass(T.realized)),
        UI.stat('Gains', money.fmt(gainsC, { sign: true }), `${gWins.length} position${gWins.length === 1 ? '' : 's'} · before fees and funding`, 'pos'),
        UI.stat('Losses', money.fmt(lossSumC, { sign: true }), `${gLosses.length} position${gLosses.length === 1 ? '' : 's'}` + (liqCount ? ` · ${liqCount} liquidated` : '') + ' · before fees and funding', 'neg'),
        UI.stat('Fees', money.fmt(TC.fees + TC.posFees), `${money.fmt(TC.fees)} trading` + (T.posFees ? ` · ${money.fmt(TC.posFees)} position (mPerps)` : '') + (T.wfee ? ` · plus ${money.fmt(TC.wfee)} on withdrawals` : '')),
        UI.stat('Funding', money.fmt(TC.funding, { sign: true }), `${money.fmt(fundingInC)} received · ${money.fmt(fundingOutC)} paid`, U.pnlClass(T.funding)),
        UI.stat('Deposits', money.fmt(TC.deposits)),
        UI.stat('Withdrawals', money.fmt(TC.withdrawals), T.wfee ? 'incl. withdrawal fees' : null),
        UI.stat('Closed positions', String(closed.length), closed.length ? `win rate ${U.fmtPct((wins.length / closed.length) * 100, { dp: 0 })} · longest hold ${U.fmtDuration(longestHold)}` : null),
        UI.stat('Long-term', longTerm.length ? money.fmt(longTermNetC, { sign: true }) : '—', longTerm.length ? `${longTerm.length} position${longTerm.length > 1 ? 's' : ''} held over a year` : 'no position held over a year: everything is short-term'),
        UI.stat('Volume', money.fmt(TC.volume, { compact: true }), 'traded notional'),
        current
          ? UI.stat('Open at period end', String(openNow.length), openNow.length ? `${money.usd(openUpnl, { sign: true })} unrealized · not taxable until closed` : 'no open positions')
          : UI.stat('Open at period end', String(openAtEnd.length), openAtEnd.length ? 'carried into the next period · unrealized PnL at that date is not recorded' : 'nothing carried into the next period'));

      // ---- income vs expenses (classification hints only) ----
      const catRows = [
        { cat: 'Trading gains', kind: 'capital / trading income', usd: gains, c: gainsC, note: 'closed positions with a positive booked result, before fees and funding' },
        { cat: 'Trading losses', kind: 'capital / trading loss', usd: lossSum, c: lossSumC, note: 'closed positions with a negative booked result, before fees and funding' },
        Math.abs(unlisted) >= 0.01 ? { cat: 'Partial closes of open positions', kind: 'capital / trading', usd: unlisted, c: money.fx(unlisted, end - 1), note: 'realized PnL booked on positions still open at period end' } : null,
        { cat: 'Funding received', kind: 'income', usd: fundingIn, c: fundingInC, note: 'hourly funding payments received' },
        { cat: 'Funding paid', kind: 'expense', usd: -fundingOut, c: -fundingOutC, note: 'hourly funding payments paid' },
        { cat: 'Trading fees', kind: 'expense', usd: -T.fees, c: -TC.fees, note: 'taker / maker fees on every fill' },
        T.posFees ? { cat: 'Position fees (mPerps)', kind: 'expense', usd: -T.posFees, c: -TC.posFees, note: 'charged on XAU, XAG, SPY and QQQ positions while open; spread over each position\'s holding time' } : null,
        T.wfee ? { cat: 'Withdrawal & deposit fees', kind: 'expense', usd: -T.wfee, c: -TC.wfee, note: 'charged by the exchange on transfers' } : null,
        { cat: 'Deposits', kind: 'transfer · not income', usd: T.deposits, c: TC.deposits, note: 'USDe moved onto the exchange' },
        { cat: 'Withdrawals', kind: 'transfer · not income', usd: -(T.withdrawals - T.wfee), c: -(TC.withdrawals - TC.wfee), note: 'USDe moved off the exchange, net of the fees above' },
      ].filter(Boolean);
      const catTbl = UI.table({ cols: [
        { key: 'c', label: 'Category', render: (r) => r.cat },
        { key: 'k', label: 'Usual treatment', render: (r) => h('span.dim', r.kind) },
        { key: 'a', label: 'Amount', num: true, render: (r) => pnlEl(r.c, r.usd) },
        { key: 'n', label: '', render: (r) => h('span.dim.small', r.note) },
      ], rows: catRows });

      const mCanvas = h('canvas');
      const monthlyTbl = UI.table({ cols: [
        { key: 'm', label: 'Month', render: (m) => { const cut = monthCut(m); return h('span', m.label, cut ? h('span.dim.xs', ' ' + cut) : null); } },
        { key: 'r', label: 'Realized PnL', num: true, render: (m) => pnlEl(m.C.realized, m.realized) },
        { key: 'f', label: 'Fees', num: true, title: 'trading fees plus position fees', render: (m) => money.fmt(m.C.fees + (m.C.pfees || 0)) },
        { key: 'fu', label: 'Funding', num: true, render: (m) => pnlEl(m.C.funding, m.funding) },
        { key: 'n', label: 'Net', num: true, render: (m) => pnlEl(m.C.net, m.net) },
        { key: 'd', label: 'Deposits', num: true, render: (m) => money.fmt(m.C.deposits) },
        { key: 'w', label: 'Withdrawals', num: true, render: (m) => money.fmt(m.C.withdrawals) },
        { key: 'v', label: 'Volume', num: true, render: (m) => money.fmt(m.C.volume, { compact: true }) },
      ], rows: monthly, empty: 'No activity in this period' });
      const quarterTbl = UI.table({ cols: [
        { key: 'q', label: 'Quarter', render: (q) => h('div', q.label, h('div.dim.xs', utcDate(q.from) + ' – ' + utcDate(q.to))) },
        { key: 'r', label: 'Realized PnL', num: true, render: (q) => pnlEl(q.C.realized, q.realized) },
        { key: 'f', label: 'Fees', num: true, title: 'trading fees plus position fees', render: (q) => money.fmt(q.C.fees + (q.C.pfees || 0)) },
        { key: 'fu', label: 'Funding', num: true, render: (q) => pnlEl(q.C.funding, q.funding) },
        { key: 'n', label: 'Net', num: true, render: (q) => pnlEl(q.C.net, q.net) },
      ], rows: quarters, empty: 'No activity in this period' });
      const marketTbl = UI.table({ cols: [
        { key: 'm', label: 'Market', render: (r) => UI.marketCell(r.ticker) },
        { key: 'n', label: 'Closed', num: true, render: (r) => String(r.n) },
        { key: 'wr', label: 'Win rate', num: true, render: (r) => U.fmtPct((r.wins / r.n) * 100, { dp: 0 }) },
        { key: 'g', label: 'Realized PnL', num: true, render: (r) => pnlEl(r.C.gross, r.gross) },
        { key: 'f', label: 'Fees', num: true, render: (r) => money.fmt(r.C.fees) },
        { key: 'fu', label: 'Funding', num: true, render: (r) => pnlEl(r.C.funding, r.funding) },
        { key: 'net', label: 'Net', num: true, render: (r) => pnlEl(r.C.net, r.net) },
        { key: 'v', label: 'Volume', num: true, render: (r) => money.fmt(r.C.volume, { compact: true }) },
      ], rows: byMarket, empty: 'No positions closed in this period' });

      // ---- closed positions ledger ----
      const ledgerWrap = h('div'); let lpage = 1;
      const truncNote = positions.truncated ? h('div.small', { style: { padding: '10px 14px', borderBottom: '1px solid var(--border-2)', color: 'var(--amber)' } }, `The exchange returned only the newest ${U.fmtNum(positions.length, 0)} positions, so older ones are missing from the per-position tables and exports. The ledger totals above are complete.`) : null;
      const renderLedger = () => {
        const slice = closed.slice((lpage - 1) * PAGE, lpage * PAGE);
        U.replace(ledgerWrap, UI.table({ cols: [
          { key: 'closed', label: 'Closed (UTC)', render: (c) => h('span.dim', isoTime(c.t).slice(0, 16)) },
          { key: 'm', label: 'Market', render: (c) => UI.marketCell(c.ticker) },
          { key: 'side', label: 'Side', render: (c) => U.sideEl(c.long, true) },
          { key: 'size', label: 'Size', num: true, render: (c) => U.fmtQty(c.size) },
          { key: 'entry', label: 'Avg entry', num: true, render: (c) => U.fmtPrice(c.entry, c.tick) },
          { key: 'exit', label: 'Avg exit', num: true, render: (c) => U.fmtPrice(c.exit, c.tick) },
          { key: 'cost', label: 'Cost', num: true, render: (c) => money.fmt(c.cost * c.rate) },
          { key: 'gross', label: 'Realized PnL', num: true, render: (c) => pnlEl(c.grossC, c.gross) },
          { key: 'fees', label: 'Fees', num: true, render: (c) => money.fmt((c.fees + c.pfees) * c.rate) },
          { key: 'fund', label: 'Funding', num: true, render: (c) => money.fmt(c.funding * c.rate, { sign: true }) },
          { key: 'net', label: 'Net', num: true, render: (c) => pnlEl(c.netC, c.net) },
          { key: 'hold', label: 'Held', num: true, render: (c) => h('span', U.fmtDuration(c.hold), c.longTerm ? h('span.chip.blue', { style: { marginLeft: '6px' } }, 'long-term') : null) },
          { key: 'flag', label: '', render: (c) => (c.liq ? UI.chip('LIQ', 'red') : c.adl ? UI.chip('ADL', 'amber') : '') },
        ], rows: slice, empty: 'No positions closed in this period' }), closed.length > PAGE ? UI.pager({ page: lpage, pageSize: PAGE, total: closed.length, onPage: (p) => { lpage = p; renderLedger(); } }) : null);
      };
      renderLedger();

      // ---- all transactions: fills, transfers, position closes and daily funding, loaded on request ----
      let events = null, fillsRaw = null, transfersRaw = null;
      const txWrap = h('div'); let txType = 'all', txPage = 1;
      const TX_TYPES = [{ v: 'all', label: 'All' }, { v: 'trade', label: 'Trades' }, { v: 'close', label: 'Position closes' }, { v: 'funding', label: 'Funding' }, { v: 'transfer', label: 'Deposits & withdrawals' }];
      const txCount = h('span.dim.small');
      const txHead = h('div.row.wrap', { style: { gap: '8px' } }, UI.seg(TX_TYPES, txType, (v) => { txType = v; txPage = 1; renderTx(); }, 'sm'), h('span.grow'), txCount);
      async function loadEvents() {
        const [fills, tr] = await Promise.all([
          A.page(A.BASE, '/v1/order/fill', { subaccountId: sid, createdAfter: start, createdBefore: end }, { maxPages: 50, signal: ctx.signal }),
          A.page(A.BASE, '/v1/token/transfer', { subaccountId: sid, createdAfter: start, createdBefore: end }, { maxPages: 20, signal: ctx.signal }),
        ]);
        fillsRaw = fills; transfersRaw = tr;
        const ev = [];
        for (const f of fills) { const prod = ref.byId[f.productId]; const notional = U.num(f.filled) * U.num(f.price); ev.push({ t: U.num(f.createdAt), type: 'trade', what: (prod ? prod.displayTicker : f.productId) + ' · ' + U.sideName(f.side) + ' ' + U.fmtQty(f.filled) + ' @ ' + U.fmtPrice(f.price, prod && prod.tickSize), amount: -U.num(f.feeUsd), fee: U.num(f.feeUsd), notional, detail: (f.isMaker ? 'maker' : 'taker') + (f.reduceOnly ? ' · reduce-only' : ''), id: f.id }); }
        for (const t of tr) { const type = String(t.type || '').toUpperCase(); const isDep = /DEPOSIT/.test(type), isWd = /WITHDRAW/.test(type); ev.push({ t: U.num(t.createdAt), type: 'transfer', what: (isDep ? 'Deposit' : isWd ? 'Withdrawal' : 'Conversion') + (t.tokenName ? ' · ' + t.tokenName + (t.toTokenName ? ' → ' + t.toTokenName : '') : ''), amount: isWd ? -(U.num(t.amount) + U.num(t.fee)) : isDep ? U.num(t.amount) - U.num(t.fee) : 0, fee: U.num(t.fee), notional: U.num(t.amount), detail: String(t.status || '').toLowerCase() + (U.num(t.fee) ? ' · fee ' + U.fmtUsd(t.fee, { dp: 2 }) + (isWd ? ' on top' : ' deducted') : ''), id: t.id, tx: t.finalizedTransactionHash || t.initiatedTransactionHash || null }); }
        for (const c of closed) ev.push({ t: c.t, type: 'close', what: c.ticker + ' · ' + (c.long ? 'long' : 'short') + ' ' + U.fmtQty(c.size) + ' closed' + (c.liq ? ' (liquidated)' : c.adl ? ' (auto-deleveraged)' : ''), amount: c.gross - c.pfees, fee: c.pfees, notional: c.proceeds, detail: 'net ' + U.fmtUsd(c.net, { sign: true, dp: 2 }) + ' after ' + U.fmtUsd(c.fees, { dp: 2 }) + ' fill fees and ' + U.fmtUsd(c.funding, { sign: true, dp: 2 }) + ' funding' + (c.pfees ? ' · position fee ' + U.fmtUsd(c.pfees, { dp: 2 }) : ''), id: c.p.id });
        for (const b of days) if (Math.abs(b.funding) >= 0.000001) ev.push({ t: Math.min(b.t + U.DAY - 1, Date.now()), type: 'funding', what: 'Funding · daily net', amount: b.funding, fee: 0, notional: 0, detail: b.funding > 0 ? 'received' : 'paid', id: 'funding-' + isoDate(b.t) });
        ev.sort((a, b) => b.t - a.t);
        events = ev;
      }
      function renderTx() {
        if (!events) return;
        const rows = txType === 'all' ? events : events.filter((e) => e.type === txType);
        const slice = rows.slice((txPage - 1) * PAGE, txPage * PAGE);
        txCount.textContent = `${U.fmtNum(rows.length, 0)} of ${U.fmtNum(events.length, 0)} events` + (fillsRaw && fillsRaw.truncated ? ' · fills truncated at 10,000' : '');
        U.replace(txWrap, UI.table({ cols: [
          { key: 't', label: 'Time (UTC)', render: (e) => h('span.dim', isoTime(e.t).slice(0, 19)) },
          { key: 'ty', label: 'Type', render: (e) => UI.chip({ trade: 'trade', close: 'position close', funding: 'funding', transfer: 'transfer' }[e.type], { trade: '', close: 'accent', funding: 'blue', transfer: 'amber' }[e.type]) },
          { key: 'w', label: 'What', render: (e) => h('span', e.what) },
          { key: 'a', label: 'Cash effect', num: true, title: 'Money in (+) or out (−) of the account from this event: the fee of a fill, the realized PnL of a close less its position fee, the day\'s funding, a transfer net of its fee. Summed over the period it is the balance change.', render: (e) => (e.amount ? pnlEl(money.fx(e.amount, e.t), e.amount) : h('span.dim', '—')) },
          { key: 'f', label: 'Fee', num: true, title: 'the fee part of the cash effect', render: (e) => (e.fee ? money.fmt(money.fx(e.fee, e.t)) : h('span.dim', '—')) },
          { key: 'n', label: 'Notional', num: true, render: (e) => (e.notional ? money.fmt(money.fx(e.notional, e.t)) : h('span.dim', '—')) },
          { key: 'd', label: '', render: (e) => h('span.dim.small', e.detail, e.tx ? [' · ', h('a', { href: U.explorerTx(e.tx), target: '_blank', rel: 'noopener' }, 'tx')] : null) },
        ], rows: slice, empty: 'No events of this type in the period' }), rows.length > PAGE ? UI.pager({ page: txPage, pageSize: PAGE, total: rows.length, onPage: (p) => { txPage = p; renderTx(); } }) : null);
      }
      const txLoad = h('button.btn', {}, U.icon('activity'), 'Load every transaction in the period');
      txLoad.addEventListener('click', busyFn(txLoad, async () => { await loadEvents(); U.replace(txWrap); txCard.querySelector('.tx-intro').replaceWith(txHead); renderTx(); }));
      const txCard = h('div.card.tight', h('div.card-head', h('h2', 'All transactions'), h('span.dim.small', 'fills, deposits, withdrawals, conversions, position closes and daily funding, newest first')),
        h('div.tx-intro', { style: { padding: '14px 16px' } }, h('div.row.wrap', { style: { gap: '10px' } }, txLoad, h('span.dim.small', 'Every fill and transfer is fetched from the exchange (up to 10,000 fills); position closes and daily funding come from the report above. The cash-effect column sums to the period\'s balance change.'))), txWrap);

      // ---- exports ----
      const exportSummary = () => download(fname('summary'), toCsv([['Metric', (r) => r[0]], ['USD', (r) => r[1]], ...(rates ? [[cur, (r) => r[2]]] : [])],
        [['Period start (UTC)', isoDate(start), ''], ['Period end (UTC)', isoDate(end - 1), ''], ['Fiscal year', label, ''], ['Wallet', addr, ''], ['Subaccount', sid, ''], ['Report currency', cur, ''],
          ['Perps net result', n6(T.net), n6(TC.net)], ['Perps realized PnL', n6(T.realized), n6(TC.realized)], ['Perps gains (closed positions, gross)', n6(gains), n6(gainsC)], ['Perps losses (closed positions, gross)', n6(lossSum), n6(lossSumC)], ['Perps trading fees', n6(T.fees), n6(TC.fees)], ['Perps position fees (mPerps)', n6(T.posFees), n6(TC.posFees)], ['Perps withdrawal & deposit fees', n6(T.wfee), n6(TC.wfee)], ['Perps funding received', n6(fundingIn), n6(fundingInC)], ['Perps funding paid', n6(fundingOut), n6(fundingOutC)], ['Perps funding (net)', n6(T.funding), n6(TC.funding)], ['Perps deposits', n6(T.deposits), n6(TC.deposits)], ['Perps withdrawals', n6(T.withdrawals), n6(TC.withdrawals)], ['Perps volume', n6(T.volume), n6(TC.volume)], ['Closed positions', closed.length, ''], ['Winning positions', wins.length, ''], ['Losing positions', losses.length, ''], ['Liquidations', liqCount, ''], ['Long-term positions (held > 1 year)', longTerm.length, ''], ['Long-term net', n6(longTermNet), n6(longTermNetC)], ['Open positions at period end', openAtEnd.length, ''], ['Balance reconciliation difference', n6(reconDiff), ''], ['Unrealized PnL of open positions (now)', n6(openUpnl), ''], ['Predict realized PnL (cash basis)', predictCard.dataset.pnl != null ? predictCard.dataset.pnl : 'see Predict ledger export', '']])
        + '\r\n\r\n' + toCsv([['Month', (m) => m.label], ['Realized PnL USD', (m) => n6(m.realized)], ['Fees USD', (m) => n6(m.fees + (m.pfees || 0))], ['Funding USD', (m) => n6(m.funding)], ['Net USD', (m) => n6(m.net)], ['Deposits USD', (m) => n6(m.deposits)], ['Withdrawals USD', (m) => n6(m.withdrawals)], ['Volume USD', (m) => n6(m.volume)], ...(rates ? [['Net ' + cur, (m) => n6(m.C.net)]] : [])], monthly)
        + '\r\n\r\n' + toCsv([['Quarter', (q) => q.label], ['Realized PnL USD', (q) => n6(q.realized)], ['Fees USD', (q) => n6(q.fees + (q.pfees || 0))], ['Funding USD', (q) => n6(q.funding)], ['Net USD', (q) => n6(q.net)], ...(rates ? [['Net ' + cur, (q) => n6(q.C.net)]] : [])], quarters));
      const exportDaily = () => download(fname('daily-ledger'), toCsv([['Date (UTC)', (b) => isoDate(b.t)], ['Realized PnL USD', (b) => n6(b.realizedPnl)], ['Trading fees USD', (b) => n6(b.fee)], ['Funding USD', (b) => n6(b.funding)], ['Net USD', (b) => n6(b.net)], ['Position fees USD', (b) => n6(b.pfees)], ['Deposits USD', (b) => n6(b.deposit)], ['Withdrawals USD (incl. fees)', (b) => n6(b.withdrawal)], ['Withdrawal & deposit fees USD', (b) => n6(b.wfee || 0)], ['Volume USD', (b) => n6(b.volume)], ['Balance end of day USD', (b) => n6(b.balance)], ...(rates ? [['USD→' + cur + ' rate', (b) => rates.at(b.t)], ['Net ' + cur, (b) => n6(b.C.net)]] : [])], days));
      const exportPositions = () => download(fname('closed-positions'), toCsv([['Closed (UTC)', (c) => isoTime(c.t)], ['Opened (UTC)', (c) => isoTime(c.p.createdAt)], ['Market', (c) => c.ticker], ['Side', (c) => (c.long ? 'LONG' : 'SHORT')], ['Size', (c) => n6(c.size)], ['Avg entry', (c) => n6(c.entry)], ['Avg exit', (c) => n6(c.exit)], ['Cost USD', (c) => n6(c.cost)], ['Proceeds USD', (c) => n6(c.proceeds)], ['Realized PnL USD', (c) => n6(c.gross)], ['Trading fees USD', (c) => n6(c.fees)], ['Position fees USD', (c) => n6(c.pfees)], ['Funding USD', (c) => n6(c.funding)], ['Net USD', (c) => n6(c.net)], ...money.csvCol((c) => c.net, (c) => c.t, 'Net'), ['Held hours', (c) => (c.hold / U.HOUR).toFixed(2)], ['Term', (c) => (c.longTerm ? 'long-term' : 'short-term')], ['Liquidated', (c) => (c.liq ? 'yes' : 'no')], ['Deleveraged', (c) => (c.adl ? 'yes' : 'no')], ['Position ID', (c) => c.p.id]], closed));
      // Form 8949-style rows (one per closed position): a derivative has no purchase and sale of an asset, so the cost
      // basis is the entry notional and the proceeds are that notional plus the net result; the gain column is what matters
      const exportGains = () => download(fname('capital-gains'), toCsv([['Description', (c) => `${U.fmtQty(c.size)} ${c.ticker} perpetual (${c.long ? 'long' : 'short'})`], ['Date acquired', (c) => isoDate(c.p.createdAt)], ['Date sold', (c) => isoDate(c.t)], ['Proceeds USD', (c) => n6(c.cost + c.net)], ['Cost basis USD', (c) => n6(c.cost)], ['Gain or loss USD', (c) => n6(c.net)], ...money.csvCol((c) => c.net, (c) => c.t, 'Gain or loss'), ['Term', (c) => (c.longTerm ? 'long-term' : 'short-term')], ['Notes', (c) => (c.liq ? 'liquidated' : c.adl ? 'auto-deleveraged' : '')]], closed.slice().sort((a, b) => a.t - b.t)));
      const exportFills = async () => {
        const fills = fillsRaw || await A.page(A.BASE, '/v1/order/fill', { subaccountId: sid, createdAfter: start, createdBefore: end }, { maxPages: 50, signal: ctx.signal });
        if (fills.truncated) U.toast('More than 10,000 fills; export truncated');
        download(fname('fills'), toCsv([['Time (UTC)', (f) => isoTime(f.createdAt)], ['Market', (f) => (ref.byId[f.productId] ? ref.byId[f.productId].displayTicker : f.productId)], ['Side', (f) => U.sideName(f.side)], ['Order type', (f) => f.type], ['Quantity', (f) => n6(f.filled)], ['Price', (f) => n6(f.price)], ['Notional USD', (f) => n6(U.num(f.filled) * U.num(f.price))], ['Fee USD', (f) => n6(f.feeUsd)], ['Maker', (f) => (f.isMaker ? 'yes' : 'no')], ['Reduce only', (f) => (f.reduceOnly ? 'yes' : 'no')], ['Order ID', (f) => f.orderId], ['Fill ID', (f) => f.id]], fills));
      };
      const exportTransfers = async () => {
        const tr = transfersRaw || await A.page(A.BASE, '/v1/token/transfer', { subaccountId: sid, createdAfter: start, createdBefore: end }, { maxPages: 20, signal: ctx.signal });
        download(fname('transfers'), toCsv([['Time (UTC)', (t) => isoTime(t.createdAt)], ['Type', (t) => t.type], ['Token', (t) => t.tokenName], ['To token', (t) => t.toTokenName || ''], ['Amount', (t) => n6(t.amount)], ['Fee', (t) => n6(t.fee)], ['Status', (t) => t.status], ['Initiated tx', (t) => t.initiatedTransactionHash || ''], ['Finalized tx', (t) => t.finalizedTransactionHash || ''], ['Transfer ID', (t) => t.id]], tr));
      };
      const exportAll = async () => { if (!events) await loadEvents(); download(fname('all-transactions'), toCsv([['Time (UTC)', (e) => isoTime(e.t)], ['Type', (e) => e.type], ['What', (e) => e.what], ['Cash effect USD', (e) => (e.amount ? n6(e.amount) : '')], ['Fee USD', (e) => (e.fee ? n6(e.fee) : '')], ['Notional USD', (e) => (e.notional ? n6(e.notional) : '')], ...money.csvCol((e) => e.amount, (e) => e.t, 'Cash effect'), ['Detail', (e) => e.detail], ['Tx', (e) => e.tx || ''], ['ID', (e) => e.id]], events)); };
      const koinlyDate = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
      const exportKoinly = () => {
        // Koinly "universal" template: Date, Sent Amount, Sent Currency, Received Amount, Received Currency, Fee Amount, Fee Currency, Net Worth Amount, Net Worth Currency, Label, Description, TxHash
        const rows = [];
        for (const b of days) {
          if (Math.abs(b.realizedPnl) >= 0.000001) rows.push({ Date: koinlyDate(b.t), Sent: b.realizedPnl < 0 ? n6(-b.realizedPnl) : '', Received: b.realizedPnl > 0 ? n6(b.realizedPnl) : '', Label: 'realized gain', Description: 'Meridian perps realized PnL (daily total)' });
          if (b.fee > 0.000001) rows.push({ Date: koinlyDate(b.t), Sent: n6(b.fee), Received: '', Label: 'margin fee', Description: 'Meridian trading fees (daily total)' });
          if (b.pfees > 0.000001) rows.push({ Date: koinlyDate(b.t), Sent: n6(b.pfees), Received: '', Label: 'margin fee', Description: 'Meridian position fees, mPerps (daily share)' });
          if (Math.abs(b.funding) >= 0.000001) rows.push({ Date: koinlyDate(b.t), Sent: b.funding < 0 ? n6(-b.funding) : '', Received: b.funding > 0 ? n6(b.funding) : '', Label: b.funding > 0 ? 'realized gain' : 'margin fee', Description: 'Meridian funding payments (daily total)' });
          if (b.deposit > 0.000001) rows.push({ Date: koinlyDate(b.t), Sent: '', Received: n6(b.deposit), Label: '', Description: 'Deposit to Meridian' });
          if (b.withdrawal > 0.000001) rows.push({ Date: koinlyDate(b.t), Sent: n6(b.withdrawal - (b.wfee || 0)), Received: '', Fee: b.wfee > 0.000001 ? n6(b.wfee) : '', Label: '', Description: 'Withdrawal from Meridian' });
          else if (b.wfee > 0.000001) rows.push({ Date: koinlyDate(b.t), Sent: n6(b.wfee), Received: '', Label: 'margin fee', Description: 'Meridian transfer fee' });
        }
        download(fname('koinly'), toCsv([['Date', (r) => r.Date], ['Sent Amount', (r) => r.Sent], ['Sent Currency', (r) => (r.Sent ? 'USDe' : '')], ['Received Amount', (r) => r.Received], ['Received Currency', (r) => (r.Received ? 'USDe' : '')], ['Fee Amount', (r) => r.Fee || ''], ['Fee Currency', (r) => (r.Fee ? 'USDe' : '')], ['Net Worth Amount', () => ''], ['Net Worth Currency', () => ''], ['Label', (r) => r.Label], ['Description', (r) => r.Description], ['TxHash', () => '']], rows));
      };
      const exportCoinTracking = () => {
        // CoinTracking import: Type, Buy Amount, Buy Cur., Sell Amount, Sell Cur., Fee, Fee Cur., Exchange, Trade-Group, Comment, Date
        const ctDate = (t) => new Date(t).toISOString().slice(0, 19).replace('T', ' ');
        const rows = [];
        for (const b of days) {
          if (b.realizedPnl > 0.000001) rows.push(['Derivatives / Futures Profit', n6(b.realizedPnl), 'USDe', '', '', '', '', 'Meridian', 'Perps', 'Realized PnL (daily total)', ctDate(b.t)]);
          if (b.realizedPnl < -0.000001) rows.push(['Derivatives / Futures Loss', '', '', n6(-b.realizedPnl), 'USDe', '', '', 'Meridian', 'Perps', 'Realized PnL (daily total)', ctDate(b.t)]);
          if (b.fee > 0.000001) rows.push(['Derivatives / Futures Fee', '', '', n6(b.fee), 'USDe', '', '', 'Meridian', 'Perps', 'Trading fees (daily total)', ctDate(b.t)]);
          if (b.pfees > 0.000001) rows.push(['Derivatives / Futures Fee', '', '', n6(b.pfees), 'USDe', '', '', 'Meridian', 'Perps', 'Position fees, mPerps (daily share)', ctDate(b.t)]);
          if (b.funding > 0.000001) rows.push(['Derivatives / Futures Profit', n6(b.funding), 'USDe', '', '', '', '', 'Meridian', 'Perps', 'Funding received (daily total)', ctDate(b.t)]);
          if (b.funding < -0.000001) rows.push(['Derivatives / Futures Fee', '', '', n6(-b.funding), 'USDe', '', '', 'Meridian', 'Perps', 'Funding paid (daily total)', ctDate(b.t)]);
          if (b.deposit > 0.000001) rows.push(['Deposit', n6(b.deposit), 'USDe', '', '', '', '', 'Meridian', '', 'Deposit', ctDate(b.t)]);
          if (b.withdrawal > 0.000001) rows.push(['Withdrawal', '', '', n6(b.withdrawal - (b.wfee || 0)), 'USDe', b.wfee > 0.000001 ? n6(b.wfee) : '', b.wfee > 0.000001 ? 'USDe' : '', 'Meridian', '', 'Withdrawal', ctDate(b.t)]);
          else if (b.wfee > 0.000001) rows.push(['Other Fee', '', '', n6(b.wfee), 'USDe', '', '', 'Meridian', '', 'Transfer fee', ctDate(b.t)]);
        }
        download(fname('cointracking'), toCsv([['Type', (r) => r[0]], ['Buy Amount', (r) => r[1]], ['Buy Cur.', (r) => r[2]], ['Sell Amount', (r) => r[3]], ['Sell Cur.', (r) => r[4]], ['Fee', (r) => r[5]], ['Fee Cur.', (r) => r[6]], ['Exchange', (r) => r[7]], ['Trade-Group', (r) => r[8]], ['Comment', (r) => r[9]], ['Date', (r) => r[10]]], rows));
      };
      const exportsCard = h('div.card.no-print', h('h3', { style: { marginBottom: '4px' } }, 'Exports (CSV, UTC)'), h('p.dim.small', { style: { margin: '0 0 12px' } }, 'Amounts in USD' + (rates ? ' with a ' + cur + ' column at each day\'s ECB rate' : '') + '. Import the ones your tool understands; the tax-tool templates carry daily totals, the ledgers carry every event.'),
        h('div.metric-list',
          exBtn('Summary, monthly & quarterly', 'Totals for the period, then the month-by-month and quarter-by-quarter tables.', exportSummary),
          exBtn('Capital gains (8949-style)', 'One row per closed position: description, dates acquired and sold, proceeds, cost basis, gain or loss, term.', exportGains),
          exBtn('Closed positions', 'Every position closed in the period with entry, exit, PnL, fees, funding and holding period.', exportPositions),
          exBtn('Daily ledger', 'One row per day: realized PnL, trading and position fees, funding, deposits, withdrawals, balance' + (rates ? ', FX rate' : '') + '.', exportDaily),
          exBtn('All transactions', 'Fills, transfers, position closes and daily funding in one chronological file; the cash-effect column sums to the balance change.', exportAll, true),
          exBtn('Fills (trades)', 'Every fill in the period with price, quantity, fee and maker flag.', exportFills, true),
          exBtn('Deposits & withdrawals', 'Transfers and margin conversions with transaction hashes.', exportTransfers, true),
          exBtn('Koinly universal CSV', 'Daily PnL, fees and funding in Koinly\'s universal template (labels: realized gain / margin fee).', exportKoinly),
          exBtn('CoinTracking CSV', 'Daily totals as Derivatives / Futures Profit, Loss and Fee rows plus deposits and withdrawals.', exportCoinTracking)));

      const info = h('div.card', h('h3', { style: { marginBottom: '10px' } }, 'What counts on Meridian'),
        h('div.note-grid',
          h('div.it', h('div.t', 'Realized PnL'), h('div.d', 'Booked whenever a position is reduced or closed, including liquidations and auto-deleveraging. The period totals use the exchange\'s settled daily figures, so they include partial closes of positions you still hold; the per-position tables list only positions fully closed in the period, each with its whole result (a position partly closed before the period shows here in full, and the difference line goes the other way), and the difference is shown as its own line.')),
          h('div.it', h('div.t', 'Gains, losses and holding periods'), h('div.d', 'Each perpetual position is its own lot: it is opened, possibly added to, and closed, with one net result. There is no cost-basis method to choose (FIFO, LIFO, average) because nothing is carried between positions. Holding period runs from the first fill to the last; a position held over a year is flagged long-term.')),
          h('div.it', h('div.t', 'Funding'), h('div.d', 'Paid or received every hour while a position is open. The daily ledger nets it per day; received and paid are split by the sign of each day\'s total.')),
          h('div.it', h('div.t', 'Fees'), h('div.d', 'Taker / maker trading fees on every fill (the exchange\'s daily fee line); position fees on mPerp markets (XAU, XAG, SPY, QQQ), which the daily line leaves out and this report takes from each position, spread over its holding time so a position that straddles two years is split between them; and withdrawal / deposit fees, shown inside withdrawals and as their own expense line.')),
          h('div.it', h('div.t', 'Deposits, withdrawals, conversions'), h('div.d', 'USDe in and out of the exchange, and margin moved between the USD pool and an mPerp pool (1:1 between USD-equivalent tokens). Usually not taxable events themselves; they reconcile the balance.')),
          h('div.it', h('div.t', 'Currency and rates'), h('div.d', 'Everything settles in USDe, shown at 1 USDe = 1 USD. A reporting currency converts each day\'s figures at that day\'s ECB reference rate (via frankfurter.dev; weekends carry the previous rate); positions convert at the close date. If your rules require a specific rate source, use the USD columns in the exports.')),
          h('div.it', h('div.t', 'Timezone and quarters'), h('div.d', 'All dates are UTC, as the exchange keeps them. A fiscal year is taken from 00:00 UTC on its first day, and its quarters run from that day in three-month steps (6 Apr – 5 Jul for the UK); a custom range shows calendar quarters.'))),
        h('div.footer-note', { style: { textAlign: 'left', paddingBottom: 0 } }, 'MeridianDataHub is not a tax adviser. The "usual treatment" column is a hint, not a ruling: rules for perpetual futures, funding and prediction markets differ by country. Use these records with a professional or a tax tool.'));

      const predictCard = h('div.card', h('div.row', h('h2', 'Meridian Predict'), UI.chip('prediction markets', 'accent')), h('div.empty', h('span.loading', h('span.spinner'), 'Loading Predict history…')));
      const fxLine = rates ? h('div.small.dim', { style: { marginTop: '6px' } }, `Reported in ${cur} at ECB daily reference rates · latest ${rates.last.r.toFixed(4)} ${cur}/USD (${isoDate(rates.last.t)}) · USD figures in every export`) : fxNote ? h('div.small.neg', { style: { marginTop: '6px' } }, fxNote) : null;
      U.replace(body, controls,
        h('div.card', h('div.row', { style: { marginBottom: '12px' } }, h('h2', label), UI.chip('perps', 'accent'), h('span.grow'), h('span.dim.small', `${isoDate(start)} → ${isoDate(end - 1)}` + (firstT > start ? ` · account since ${utcDate(firstT)}` : '') + ` · ${days.length} ledger days · ${positions.length}${positions.truncated ? '+' : ''} positions on record`)), tiles, fxLine, reconCard),
        UI.card('Income and expenses', catTbl, h('span.dim.small', 'classification hints')),
        h('div.grid.cols-2', h('div.card.chart-fill', h('h3', { style: { marginBottom: '10px', flex: 'none' } }, 'Net result by month'), h('div.chart-box.sm', mCanvas)), UI.card('Quarterly breakdown', quarterTbl, h('span.dim.small', mode === 'year' ? 'fiscal quarters' : 'calendar quarters'))),
        UI.card('Monthly breakdown', monthlyTbl),
        UI.card('By market', marketTbl, h('span.dim.small', 'positions closed in the period')),
        UI.card('Closed positions', h('div', truncNote,
          Math.abs(unlisted) >= 0.01 ? h('div.small.muted', { style: { padding: '10px 14px', borderBottom: '1px solid var(--border-2)' } },
            'These are positions fully closed in the period. ', h('b', money.usd(closedGross, { sign: true })), ' of the period\'s ',
            h('b', money.usd(T.realized, { sign: true })), ' realized PnL comes from them; the remaining ', h('b', money.usd(unlisted, { sign: true })),
            ' was booked on partial closes of positions that are still open.') : null,
          ledgerWrap), h('span.dim.small', `${closed.length} in period` + (largestWin ? ` · best ${money.usd(largestWin.net, { sign: true })}` : '') + (largestLoss ? ` · worst ${money.usd(largestLoss.net, { sign: true })}` : ''))),
        txCard, exportsCard, predictCard, info);
      C.bars(mCanvas, monthly.map((m) => m.label), monthly.map((m) => m.C.net), rates ? { fmt: (v) => money.fmt(v) } : {});
      renderPredict(predictCard, addr, start, end, fname, money, pnlEl).catch((e) => { if (!isAbort(e)) U.replace(predictCard, h('div.row', h('h2', 'Meridian Predict')), UI.error(e)); });
    },
  };
})();
