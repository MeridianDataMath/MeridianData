/* MeridianDataHub — Tax center exports: one registry of the files the page offers, each with its section, its kind (one
   of the site's own reports, or a tax tool's import file), what it needs loaded and how it is built, so the buttons and
   the ZIP of everything come from one list. A report file starts with the methodology rows (MD.tax.methodology), a blank
   line, then its tables; a tool file is exactly the tool's own header and rows, since a tool reads its first row as the
   header (its methodology is in the import notes and the ZIP). Pure: no DOM, no network. */
(function () {
  const MD = window.MD; const U = MD.util; const T = MD.tax; const TZ = T.tz;
  const EX = (T.exports = {});
  const defs = [];
  const HOUR = 3600000, EPS = 1e-6, DUST = 5e-7;   // DUST: what rounds to 0 at six decimals

  /** d: {section, kind: 'report' | 'tool', label, sub (one line for the button; either may be a function of ctx, for a
   *  file whose name follows a choice on the page), when(ctx) (offered only when it holds; always when absent), needs
   *  (['events']: the per-fill data, awaited before building; ['events?']: awaited, but the file is built without it
   *  when it fails), grain ('event' | 'day' | 'position' | 'period': what a row is), ccy ('all': every amount also in the
   *  report currency; 'net': the net only; 'none'), build(ctx) → {name, columns, rows} or {name, sections: [{title,
   *  columns, rows}]}, plus warnings: [text] when the file is incomplete, and extra: [[key, value]] (its own methodology
   *  rows)} */
  EX.define = (id, d) => {
    const def = Object.assign({ id, kind: 'report', needs: [] }, d);
    const i = defs.findIndex((x) => x.id === id);
    if (i >= 0) defs[i] = def; else defs.push(def);
    return def;
  };
  EX.get = (id) => defs.find((d) => d.id === id) || null;
  EX.list = (section) => defs.filter((d) => !section || d.section === section);
  /** A definition's label or sub for ctx (text as it is, a function called with ctx). */
  EX.text = (v, ctx) => (typeof v === 'function' ? v(ctx) : v || '');
  /** The files of a section offered for ctx (their when() holds). */
  EX.offered = (section, ctx) => EX.list(section).filter((d) => !d.when || d.when(ctx));
  /** A built file: {id, kind, label, warnings, …what build returned}. */
  EX.build = (id, ctx) => { const d = EX.get(id); if (!d) throw new Error('no export ' + id); return Object.assign({ id, kind: d.kind, label: EX.text(d.label, ctx), warnings: [] }, d.build(ctx)); };
  /** The file's name: '-INCOMPLETE' before the extension when it carries warnings. */
  EX.fileName = (file) => (file.warnings && file.warnings.length && !/-INCOMPLETE(\.[a-z0-9]+)?$/i.test(String(file.name)) ? String(file.name).replace(/(\.[a-z0-9]+)?$/i, (m) => '-INCOMPLETE' + (m || '')) : file.name);
  /** A built file as CSV text. A report gets its methodology rows (key, value) and a blank line first, when given; its
   *  sections are separated by a blank line. A tool file gets nothing but its table. */
  EX.render = (file, methodology) => {
    const tables = file.sections || [{ columns: file.columns, rows: file.rows }];
    const body = tables.map((s) => (s.title ? T.cell(s.title) + '\r\n' : '') + T.toCsv(s.columns, s.rows)).join('\r\n\r\n');
    if (file.kind === 'tool' || !methodology || !methodology.length) return body;
    return methodology.map(([k, v]) => T.cell(k) + ',' + T.cell(v)).join('\r\n') + '\r\n\r\n' + body;
  };

  // ---------- shared columns ----------
  EX.iso = (t) => new Date(U.num(t)).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  /** '<name> (<zone>)' beside a UTC column; none when the report is in UTC (it would repeat it) */
  EX.loc = (tz, name, get) => (tz === 'UTC' ? [] : [[name + ' (' + tz + ')', (r) => TZ.fmt(get(r), tz, 'iso')]]);
  const yn = (b) => (b ? 'yes' : 'no');
  const n6 = (v) => T.n6(v);
  const m6 = (v) => (v == null ? '' : T.n6(v));
  const dayText = (seg) => new Date(seg.day).toISOString().slice(0, 10) + (seg.part ? ' ' + seg.part + ' UTC' : '');
  /** Report-currency columns for several USD amounts of one row, all at its date's rate: '<name> <CCY>' each, then the
   *  rate and the rate's date once. list: [[name, row → USD, row → report currency (optional: an amount already
   *  converted part by part at the dates of its parts, as a disposal's)]]; the first is at the row's date. None for USD;
   *  a blank cell where there is no rate. */
  EX.ccyCols = (money, getT, list) => {
    if (!money || !money.rates) return [];
    const base = money.cols(list[0][1], getT, list[0][0]);
    const cell = (v) => (v == null || !Number.isFinite(+v) ? '' : T.n6(v));
    const conv = ([n, g, gc]) => [n + ' ' + money.ccy, (r) => { const v = g(r); return v == null ? '' : cell(gc ? gc(r) : money.fx(v, getT(r))); }];
    return [list[0][2] ? conv(list[0]) : base[0], ...list.slice(1).map(conv), base[1], base[2]];
  };
  /** The perps daily ledger's rows from the first one with a balance or any flow on: the archive answers a range that
   *  starts before the account existed with all-zero days from its own chunk's start, so how many there are depends on
   *  where a 120-day chunk falls. None when no day has anything. Never cut by the creation time: it can be missing. */
  EX.fromFirstActive = (days) => {
    const i = (days || []).findIndex((b) => b.balance || b.realizedPnl || b.fee || b.pfees || b.funding || b.deposit || b.withdrawal || b.wfee || b.volume);
    return i < 0 ? [] : days.slice(i);
  };
  /** What makes the per-fill files incomplete, in words (empty when nothing does). ctx: {ev (load.events), D (F.disposals)}. */
  EX.eventWarnings = (ctx) => {
    const ev = ctx.ev || {}, D = ctx.D, tr = ev.truncated || {}, out = [];
    if (tr.positions) out.push('the exchange returned only the newest positions');
    if (tr.fills) out.push('more order fills than could be read (500 pages)');
    if (tr.posFills && tr.posFills.length) out.push(tr.posFills.length + ' position(s) with more fills than could be read');
    for (const f of ev.failed || []) out.push('could not read ' + f);
    if (D) {
      if (D.failed.length) out.push(D.failed.length + ' position(s) whose fills do not reproduce the exchange\'s totals');
      if (D.day.bad.length) out.push(D.day.bad.length + ' UTC day(s) whose disposals do not add up to the exchange\'s realized PnL');
      if (D.unassigned.length) out.push(D.unassigned.length + ' fill(s) no position holds');
    }
    return out;
  };
  EX.NO_DETAIL = 'the trade detail did not load: gains, losses and disposals are missing, and funding received and paid are each day\'s net';
  /** How a disposal is converted to the report currency, for the Rate rule and the files that list disposals: each part
   *  at its own local date (as UK CG78310 and German §20 Abs. 4 S. 1 EStG read it), the notional legs at the disposal's. */
  EX.DISPOSAL_RATE_TEXT = 'a perps disposal\'s result, closing fee and notional legs convert at the disposal date (the rate and rate date columns); its opening-fee share (the fees of the increases still open, each at the date paid) and the funding and position fees carried into it (each settlement at its own date) convert at the dates they were paid, and its nets, proceeds and cost are built from those parts, so they are not the USD amount × the disposal date\'s rate';
  /** The perps files' warnings: the trade detail's, or that it did not load. */
  const perpsWarnings = (c) => (c.D ? EX.eventWarnings(c) : [EX.NO_DETAIL]);

  // ---------- the perps fills, each with what it did ----------
  /**
   * Every fill piece of the positions (F.assign's map), in time order, each with its disposal row when it reduced the
   * position: kind 'disposal' (its row), 'increase', 'reduce' (a reduction with nothing open: no row) or 'unassigned' (a
   * fill in the period no position holds). positions: Map(id → position) or a list.
   */
  EX.fillPieces = (D, positions) => {
    const pos = positions instanceof Map ? positions : new Map((positions || []).map((p) => [p.id, p]));
    const rowAt = new Map(); for (const r of D.rows) rowAt.set(r.positionId + '|' + r.n, r);
    const out = [];
    for (const [pid, fs] of D.byPos) {
      const p = pos.get(pid), side = p ? String(p.side) : null;
      fs.forEach((f, i) => {
        if (!(f.qty > 0) && !f.fee) return;
        const row = rowAt.get(pid + '|' + (i + 1)) || null;
        out.push({ t: f.t, fee: f.fee, qty: f.qty, price: f.price, side: f.side, positionId: pid, productId: p ? p.productId : f.productId, f, row, kind: row ? 'disposal' : f.side === side ? 'increase' : 'reduce' });
      });
    }
    for (const f of D.unassigned || []) out.push({ t: f.t, fee: f.fee, qty: f.qty, price: f.price, side: f.side, positionId: null, productId: f.productId, f, row: null, kind: 'unassigned' });
    return out.sort((a, b) => a.t - b.t);
  };
  /** The opening fees on positions open at instant T0 (the fees of the increases still open: paid, not yet part of any
   *  disposal), from each position's fills before T0. */
  EX.openFeesAt = (D, positions, T0) => {
    const pos = positions instanceof Map ? positions : new Map((positions || []).map((p) => [p.id, p]));
    let sum = 0;
    for (const [pid, fs] of D.byPos) {
      const p = pos.get(pid); if (!p) continue;
      let of = 0, q = 0;
      for (const x of fs) {
        if (x.t >= T0) break;
        if (!(x.qty > 0)) continue;
        if (x.side === String(p.side)) { of += x.fee; q += x.qty; } else if (q > 0) { const c = Math.min(x.qty, q); of -= of * c / q; q -= c; if (q <= 1e-8) { q = 0; of = 0; } }
      }
      if (q > 1e-8) sum += of;
    }
    return sum;
  };

  // ---------- every transaction (the All transactions card and file) ----------
  /**
   * The period's fills (liquidation and deleverage fills included), funding and position-fee settlements, transfers and
   * position closes, newest first: [{t, type: 'trade' | 'funding' | 'posfee' | 'transfer' | 'close', what, amount (the
   * cash effect), fee, notional, realized, detail, id, tx}]. A UTC day whose funding settlements do not add up to the
   * ledger has its net instead of them (never both); a day whose position fees are not all matched to fills has the
   * rest as one line. ctx: {ev, D, ref, period, tz, closed (the closed positions), now}.
   */
  EX.transactions = (c) => {
    const { ev, D, ref, period: P, tz } = c, start = P.start, end = P.end, now = c.now != null ? c.now : Date.now(), out = [];
    const loc = (t) => TZ.fmt(t, tz, 'iso');
    const plural = (n, w) => `${U.fmtNum(n, 0)} ${w}${n === 1 ? '' : 's'}`;
    const prodOf = (pid) => (ref && ref.byId ? ref.byId[pid] : null) || null;
    const tickerOf = (pid) => { const p = prodOf(pid); return p ? p.displayTicker : pid; };
    const rowAt = new Map(); for (const r of D.rows) rowAt.set(r.positionId + '|' + r.n, r);
    for (const p of ev.touched) {
      const fs = D.byPos.get(p.id) || [];
      fs.forEach((f, i) => {
        if (f.t < start || f.t >= end || !(f.qty > 0)) return;
        const r = rowAt.get(p.id + '|' + (i + 1));
        const prod = prodOf(p.productId);
        const kind = f.type === 'LIQUIDATION' ? 'liquidation' : f.type === 'DELEVERAGE' ? 'auto-deleverage' : (f.isMaker == null ? '' : f.isMaker ? 'maker' : 'taker') + (f.reduceOnly ? ' · reduce-only' : '');
        out.push({ t: f.t, type: 'trade', what: tickerOf(p.productId) + ' · ' + U.sideName(f.side) + ' ' + U.fmtQty(f.qty) + ' @ ' + U.fmtPrice(f.price, prod && prod.tickSize) + (r ? (r.partial ? ' · partial close' : ' · close') : ' · opens or adds'),
          amount: (r ? r.gross : 0) - f.fee, fee: f.fee, notional: f.qty * f.price, realized: r ? r.gross : null,
          detail: [kind, r ? 'realized ' + U.fmtUsd(r.gross, { sign: true, dp: 2 }) : null, f.split ? 'part of a fill that also closed or opened the neighbouring position' : null].filter(Boolean).join(' · '), id: f.id || p.id + ':' + f.t });
      });
    }
    for (const f of D.unassigned) out.push({ t: f.t, type: 'trade', what: tickerOf(f.productId) + ' · ' + U.sideName(f.side) + ' ' + U.fmtQty(f.qty) + ' @ ' + U.fmtPrice(f.price), amount: -f.fee, fee: f.fee, notional: f.qty * f.price, detail: 'no position found for this fill', id: f.id });
    const posOf = new Map(ev.positions.map((p) => [p.id, p]));
    const what = (s, kind) => { const p = posOf.get(s.positionId); return kind + ' · ' + (p ? tickerOf(p.productId) + ' ' + (String(p.side) === '0' ? 'long' : 'short') : String(s.positionId).slice(0, 8)); };
    const segs = c.led ? c.led.segments : null, at = segs ? T.fills.segmentOf(segs) : null;
    const netted = new Set(); if (at) D.funding.fig.bySeg.forEach((b, i) => { if (b.fallback) netted.add(i); });
    for (const s of D.funding.inP) { if (at && netted.has(at(s.t))) continue; out.push({ t: s.t, type: 'funding', what: what(s, 'Funding'), amount: s.amount, fee: 0, notional: 0, detail: (s.amount > 0 ? 'received' : 'paid') + ` · ${plural(s.n, 'hourly charge')} from ${loc(s.from).slice(0, 16)} to ${loc(s.to).slice(0, 16)}`, id: 'funding-' + s.positionId + '-' + s.t }); }
    for (const seg of D.funding.fig.fallback) if (Math.abs(seg.funding) >= 1e-6) out.push({ t: Math.min(seg.t1 - 1, now), type: 'funding', what: 'Funding · ' + (seg.part ? 'net ' + seg.part + ' UTC' : 'daily net'), amount: seg.funding, fee: 0, notional: 0, detail: (seg.funding > 0 ? 'received' : 'paid') + ' · netted per day: settlement detail unavailable', id: 'funding-' + new Date(seg.t0).toISOString().slice(0, 10) + (seg.part ? '-' + seg.part.replace(/[^0-9]/g, '') : '') });
    for (const s of D.fees.inP) out.push({ t: s.t, type: 'posfee', what: what(s, 'Position fee'), amount: -s.amount, fee: s.amount, notional: 0, detail: 'mPerp position fee settled at this fill', id: 'posfee-' + s.positionId + '-' + s.t });
    for (const b of D.fees.bad) out.push({ t: Math.min(b.seg.t1 - 1, now), type: 'posfee', what: 'Position fees · ' + dayText(b.seg), amount: -b.diff, fee: b.diff, notional: 0, detail: 'the mPerp pools\' residual that day not matched to a fill', id: 'posfee-' + new Date(b.seg.t0).toISOString().slice(0, 10) });
    for (const t of ev.transfers) { const type = String(t.type || '').toUpperCase(); const isDep = /DEPOSIT/.test(type), isWd = /WITHDRAW/.test(type); out.push({ t: U.num(t.createdAt), type: 'transfer', what: (isDep ? 'Deposit' : isWd ? 'Withdrawal' : 'Conversion') + (t.tokenName ? ' · ' + t.tokenName + (t.toTokenName ? ' → ' + t.toTokenName : '') : ''), amount: isWd ? -(U.num(t.amount) + U.num(t.fee)) : isDep ? U.num(t.amount) - U.num(t.fee) : 0, fee: U.num(t.fee), notional: U.num(t.amount), detail: String(t.status || '').toLowerCase() + (U.num(t.fee) ? ' · fee ' + U.fmtUsd(t.fee, { dp: 2 }) + (isWd ? ' on top' : ' deducted') : ''), id: t.id, tx: t.finalizedTransactionHash || t.initiatedTransactionHash || null }); }
    for (const x of c.closed || []) out.push({ t: x.t, type: 'close', what: x.ticker + ' · ' + (x.long ? 'long' : 'short') + ' ' + U.fmtQty(x.size) + ' closed' + (x.liq ? ' (liquidated)' : x.adl ? ' (auto-deleveraged)' : ''), amount: 0, fee: 0, notional: 0, detail: 'marker, no cash effect · whole result ' + U.fmtUsd(x.net, { sign: true, dp: 2 }) + ' (Closed positions)', id: x.p.id });
    return out.sort((a, b) => b.t - a.t);
  };

  // ---------- tax-tool rows ----------
  /** 'YYYY-MM-DD HH:mm:ss' in UTC: Koinly reads a time with no zone as UTC (support.koinly.io 9490014) */
  EX.utcStamp = (t) => new Date(U.num(t)).toISOString().slice(0, 19).replace('T', ' ');
  /** The instant a daily row is stamped at: 10:00 UTC of its UTC day keeps that date in every zone from UTC−10 to
   *  UTC+13 (12:00 would move 31 Mar into New Zealand's next tax year), kept inside its segment and the period. */
  EX.dailyAt = (seg, P) => {
    const lo = Math.max(seg.t0, P ? P.start : -Infinity), hi = Math.min(seg.t1, P ? P.end : Infinity) - 1000;
    return Math.floor(Math.max(lo, Math.min(seg.day + 10 * HOUR, hi)) / 1000) * 1000;
  };
  const ORDER = { deposit: 0, pnl: 1, fee: 2, posfee: 3, funding: 4, predict: 5, tfee: 6, withdrawal: 7 };
  const sideWord = (long) => (long ? 'long' : 'short');

  /**
   * The perps events a tax tool imports, one per disposal fill, fee of a fill that closes nothing, funding and
   * position-fee settlement and transfer, in the period by exact instant: [{t, kind: 'pnl' | 'fee' | 'posfee' |
   * 'funding' | 'deposit' | 'withdrawal' | 'tfee', amount (+ in, − out), fee (a disposal's closing fee; a withdrawal's
   * fee), what, tx, daily}], oldest first (a deposit before results at the same instant). Each kind is checked UTC day
   * by UTC day against the exchange's ledger (by the hour rule of F.segmentOf); a day that does not add up, or every day
   * without the trade detail, becomes that day's ledger total stamped 10:00 UTC (EX.dailyAt). ctx: {period, led, ev,
   * D, ref}. Returns {events, fallback: {trade, funding, posfee, transfer} (segments), warnings}.
   */
  EX.perpsTool = (c) => {
    const P = c.period, segs = c.led ? c.led.segments : [], D = c.D, ev = c.ev || {}, ref = c.ref || {};
    const out = [], fb = { trade: [], funding: [], posfee: [], transfer: [] };
    const inP = (t) => t >= P.start && t < P.end;
    const push = (e) => { if (Math.abs(e.amount) >= DUST || Math.abs(e.fee || 0) >= DUST) out.push(Object.assign({ fee: 0, tx: '', daily: false }, e)); };
    const daily = (seg, kind, amount, what, extra) => push(Object.assign({ t: EX.dailyAt(seg, P), kind, amount, what: 'Meridian perps: ' + what + ', UTC day ' + dayText(seg) + ' (total: per-event detail unavailable)', daily: true }, extra));
    const dailyTransfers = (s) => {
      daily(s, 'deposit', s.deposit, 'deposits');
      if (s.withdrawal - s.wfee >= DUST) daily(s, 'withdrawal', -(s.withdrawal - s.wfee), 'withdrawals', { fee: s.wfee });
      else if (s.wfee >= DUST) daily(s, 'tfee', -s.wfee, 'transfer fees');
    };
    const tickerOf = (pid) => { const p = ref.byId ? ref.byId[pid] : null; return p ? p.displayTicker : pid || '?'; };
    if (!D) {
      for (const s of segs) {
        daily(s, 'pnl', s.realizedPnl, 'realized PnL'); daily(s, 'fee', -s.fee, 'trading fees'); daily(s, 'posfee', -s.pfees, 'mPerp position fees'); daily(s, 'funding', s.funding, 'funding (net)'); dailyTransfers(s);
        for (const k of Object.keys(fb)) fb[k].push(s);
      }
      out.sort((a, b) => a.t - b.t || ORDER[a.kind] - ORDER[b.kind]);
      return { events: out, fallback: fb, warnings: [EX.NO_DETAIL.replace(/:.*$/, '') + ': every UTC day is one row per kind of that day\'s ledger total, stamped 10:00 UTC'] };
    }
    const at = T.fills.segmentOf(segs);
    const pos = new Map((ev.positions || []).map((p) => [p.id, p]));
    // trades: each segment's disposals and fill fees against the ledger's realized PnL and trading fees (all the fills,
    // not only the period's: the ledger counts an hour a boundary cuts in the period it starts in)
    const pieces = EX.fillPieces(D, pos);
    const sumG = new Float64Array(segs.length), sumF = new Float64Array(segs.length);
    for (const r of D.rows) { const i = at(r.t); if (i >= 0) sumG[i] += r.gross; }
    for (const x of pieces) { const i = at(x.t); if (i >= 0) sumF[i] += x.fee; }
    const badT = new Set(); segs.forEach((s, i) => { if (Math.abs(s.realizedPnl - sumG[i]) > EPS || Math.abs(s.fee - sumF[i]) > EPS) badT.add(i); });
    for (const x of pieces) {
      if (!inP(x.t) || badT.has(at(x.t))) continue;
      const r = x.row, tk = tickerOf(x.productId);
      if (r && Math.abs(r.gross) >= DUST) push({ t: x.t, kind: 'pnl', amount: r.gross, fee: x.fee, what: `Meridian perps: ${tk} ${sideWord(r.long)} ${n6(r.qty)} closed at ${n6(r.exit)}` + (r.partial ? ', partial' : '') + (r.liq ? ', liquidation' : r.adl ? ', auto-deleverage' : '') + ` · position ${r.positionId} · fill ${r.n}` });
      else push({ t: x.t, kind: 'fee', amount: -x.fee, what: `Meridian perps: trading fee · ${tk} ${U.sideName(x.side)} ${n6(x.qty)} at ${n6(x.price)}` + (x.positionId ? ' · position ' + x.positionId : ' · no position found') });
    }
    for (const i of badT) { const s = segs[i]; fb.trade.push(s); daily(s, 'pnl', s.realizedPnl, 'realized PnL'); daily(s, 'fee', -s.fee, 'trading fees'); }
    const what = (s, kind) => { const p = pos.get(s.positionId); return `Meridian perps: ${kind} · ` + (p ? tickerOf(p.productId) + ' ' + sideWord(String(p.side) === '0') : 'a position') + ' · position ' + s.positionId; };
    // funding: the days the page nets (their settlements do not add up to the ledger) are their net, never both
    const netted = new Set(); D.funding.fig.bySeg.forEach((b, i) => { if (b.fallback) netted.add(i); });
    for (const s of D.funding.inP) if (!netted.has(at(s.t))) push({ t: s.t, kind: 'funding', amount: s.amount, what: what(s, 'funding ' + (s.amount > 0 ? 'received' : 'paid')) + ` · ${s.n} hourly charge${s.n === 1 ? '' : 's'}` });
    for (const i of netted) { fb.funding.push(segs[i]); daily(segs[i], 'funding', segs[i].funding, 'funding (net)'); }
    // position fees: the settlements, and a day's residual not matched to a fill as one row of its own
    for (const s of D.fees.inP) push({ t: s.t, kind: 'posfee', amount: -s.amount, what: what(s, 'mPerp position fee settled') });
    for (const b of D.fees.bad) { fb.posfee.push(b.seg); daily(b.seg, 'posfee', -b.diff, 'mPerp position fees not matched to a fill'); }
    // transfers: completed deposits and withdrawals (a conversion between pools moves no token and is left out)
    const kindOf = (t) => { const ty = String(t.type || '').toUpperCase(); return /DEPOSIT/.test(ty) ? 'deposit' : /WITHDRAW/.test(ty) ? 'withdrawal' : null; };
    // with those of the hours a boundary cuts, which the ledger counts in the period they start in (only the period's go out)
    const trs = (ev.hourTransfers || ev.transfers || []).filter((t) => kindOf(t) && (!t.status || String(t.status).toUpperCase() === 'COMPLETED'));
    const cash = (t) => (kindOf(t) === 'deposit' ? U.num(t.amount) - U.num(t.fee) : -(U.num(t.amount) + U.num(t.fee)));
    const sumX = new Float64Array(segs.length);
    for (const t of trs) { const i = at(U.num(t.createdAt)); if (i >= 0) sumX[i] += cash(t); }
    const badX = new Set(); segs.forEach((s, i) => { if (Math.abs(s.deposit - s.withdrawal - sumX[i]) > EPS) badX.add(i); });
    for (const t of trs) {
      const tm = U.num(t.createdAt); if (!inP(tm) || badX.has(at(tm))) continue;
      const amt = U.num(t.amount), fee = U.num(t.fee), id = ' · transfer ' + t.id;
      if (kindOf(t) === 'deposit') {
        // the deposit's finalized transaction is the exchange's relayer transaction, not the wallet's own send: a
        // different hash would make Koinly refuse to match the transfer, so none is given
        if (amt - fee >= DUST) push({ t: tm, kind: 'deposit', amount: amt - fee, what: 'Meridian perps: deposit, USDe wrapped into MeridianUSD 1:1' + (fee ? ' (net of a ' + n6(fee) + ' fee)' : '') + id });
        else if (fee >= DUST) push({ t: tm, kind: 'tfee', amount: -fee, what: 'Meridian perps: deposit fee' + id });
      } else if (amt >= DUST) push({ t: tm, kind: 'withdrawal', amount: -amt, fee, tx: t.finalizedTransactionHash || '', what: 'Meridian perps: withdrawal, MeridianUSD unwrapped into USDe 1:1' + id });
      else if (fee >= DUST) push({ t: tm, kind: 'tfee', amount: -fee, tx: t.finalizedTransactionHash || '', what: 'Meridian perps: withdrawal fee' + id });
    }
    for (const i of badX) { fb.transfer.push(segs[i]); dailyTransfers(segs[i]); }
    out.sort((a, b) => a.t - b.t || ORDER[a.kind] - ORDER[b.kind]);
    const warnings = EX.eventWarnings(c);
    if (ev.truncated && ev.truncated.transfers) warnings.push('more transfers than could be read');
    const words = { trade: 'realized PnL and trading fees', funding: 'funding', posfee: 'position fees', transfer: 'deposits and withdrawals' };
    for (const k of Object.keys(fb)) if (fb[k].length) warnings.push(`${fb[k].length} UTC day(s) of ${words[k]} as one daily total stamped 10:00 UTC (the per-event detail does not add up to the exchange's ledger there)`);
    return { events: out, fallback: fb, warnings };
  };

  /**
   * Meridian Predict's results booked in the period under the report's date basis (T.predict.book), one per result,
   * sale, matched set or tokens held to the verdict, as tax-tool events: [{t, kind: 'predict', amount (the result),
   * what, tx (the wallet's own claim transaction, or the trade's)}], oldest first; they add up to the Realized PnL tile.
   * ctx: {prep, mode, period}.
   */
  EX.predictToolEvents = (c) => {
    const PR = T.predict, P = c.period, mode = PR.modeOf(c.mode), out = [];
    const words = { won: 'won', lost: 'lost', void: 'void', sale: 'position tokens sold', set: 'both sides held (matched set)', 'held-verdict': 'position tokens held to the verdict' };
    for (const e of PR.book(c.prep, mode)) {
      if (!(e.t >= P.start && e.t < P.end) || e.ledger || !words[e.kind] || Math.abs(e.pnl) < DUST) continue;
      const it = e.kind === 'won' || e.kind === 'lost' || e.kind === 'void' ? e.ref : null, n = it && it.x ? it.x.n : null;
      let q = n ? (n.picks || []).map((k) => (k.yes ? 'YES ' : 'NO ') + k.q).join(' | ') : e.ref && e.ref.q ? e.ref.q : '';
      if (q.length > 160) q = q.slice(0, 157) + '…';
      const tx = it ? (it.claim && it.claim.by === 'self' && n && n.stx ? n.stx : '') : e.kind === 'sale' && e.ref && e.ref.trade ? e.ref.trade.tx || '' : '';
      out.push({ t: e.t, kind: 'predict', amount: e.pnl, fee: 0, tx, daily: false,
        what: 'Meridian Predict: ' + words[e.kind] + (it ? ' as ' + (it.maker ? 'market maker' : 'bettor') : '') + (q ? ' · ' + q : '') + (n ? ' · prediction ' + n.id : e.ref && e.ref.pc ? ' · pick configuration ' + e.ref.pc : '') });
    }
    return out.sort((a, b) => a.t - b.t);
  };

  // merges rows a tool would take for exact duplicates (it skips them: support.koinly.io 9789363) into one, amounts added
  const dedupe = (rows, key, add) => {
    const seen = new Map(), out = [];
    for (const r of rows) { const k = key(r); const x = seen.get(k); if (x) { add(x, r); x.merged = (x.merged || 1) + 1; } else { seen.set(k, r); out.push(r); } }
    for (const r of out) if (r.merged > 1) r.what += ` (and ${r.merged - 1} more of the same second and amount added into this row: a tax tool skips exact duplicates)`;
    return out;
  };
  /** Koinly's universal template (support.koinly.io/en/articles/9489976, updated 2026-06-03): this header, in this order. */
  EX.KOINLY = ['Date', 'Sent Amount', 'Sent Currency', 'Received Amount', 'Received Currency', 'Fee Amount', 'Fee Currency', 'Net Worth Amount', 'Net Worth Currency', 'Tag', 'Description', 'TxHash'];
  // tags (9490023, 9490027): realized gain, futures fee and funding fee count in Koinly's other gains; other fee is a cost
  const K_TAG = { pnl: 'realized gain', fee: 'futures fee', posfee: 'futures fee', funding: 'funding fee', deposit: '', withdrawal: '', tfee: 'other fee', predict: 'realized gain' };
  /** Tax-tool events (EX.perpsTool's or EX.predictToolEvents') as Koinly rows: amounts in USDe, positive, Sent or Received. */
  EX.koinlyRows = (events) => {
    const rows = [];
    const row = (e, signed, tag, fee, what) => ({ t: e.t, date: EX.utcStamp(e.t), sent: signed < 0 ? -signed : 0, received: signed > 0 ? signed : 0, fee: fee > 0 ? fee : 0, tag, what, tx: e.tx || '' });
    for (const e of events) {
      rows.push(row(e, e.amount, K_TAG[e.kind], e.kind === 'pnl' || e.kind === 'withdrawal' ? e.fee : 0, e.what));
      // a closing fee that is a credit (a rebate) is a futures fee received of its own
      if (e.kind === 'pnl' && e.fee < -DUST) rows.push(row(e, -e.fee, 'futures fee', 0, e.what.replace(/^Meridian perps: /, 'Meridian perps: fee rebate · ')));
    }
    const ok = rows.filter((r) => r.sent >= DUST || r.received >= DUST || r.fee >= DUST);
    return dedupe(ok, (r) => [r.date, n6(r.sent), n6(r.received), n6(r.fee), r.tag, r.tx].join('|'), (a, b) => { a.sent += b.sent; a.received += b.received; a.fee += b.fee; });
  };
  const amt = (v) => (v >= DUST ? n6(v) : '');
  EX.koinlyColumns = () => [
    ['Date', (r) => r.date], ['Sent Amount', (r) => amt(r.sent)], ['Sent Currency', (r) => (r.sent >= DUST ? 'USDe' : '')], ['Received Amount', (r) => amt(r.received)], ['Received Currency', (r) => (r.received >= DUST ? 'USDe' : '')],
    ['Fee Amount', (r) => amt(r.fee)], ['Fee Currency', (r) => (r.fee >= DUST ? 'USDe' : '')], ['Net Worth Amount', () => ''], ['Net Worth Currency', () => ''], ['Tag', (r) => r.tag], ['Description', (r) => r.what], ['TxHash', (r) => r.tx],
  ];
  /** CoinTracking's CSV import columns, as this site has written them (Type … Date); the README asks the owner to
   *  test-import one file. Types and the Funding Rate group from cointracking.freshdesk.com 29000042783 and 29000051068. */
  EX.COINTRACKING = ['Type', 'Buy Amount', 'Buy Cur.', 'Sell Amount', 'Sell Cur.', 'Fee', 'Fee Cur.', 'Exchange', 'Trade-Group', 'Comment', 'Date'];
  /** Tax-tool events as CoinTracking rows: amounts in USDe, Buy (in) or Sell (out). */
  EX.ctRows = (events) => {
    const rows = [];
    const row = (e, type, signed, fee, group, what) => ({ t: e.t, type, buy: signed > 0 ? signed : 0, sell: signed < 0 ? -signed : 0, fee: fee > 0 ? fee : 0, group, what: what + (e.tx ? ' · tx ' + e.tx : ''), date: EX.utcStamp(e.t) });
    for (const e of events) {
      const a = e.amount;
      if (e.kind === 'pnl' || e.kind === 'predict') {
        rows.push(row(e, a >= 0 ? 'Derivatives / Futures Profit' : 'Derivatives / Futures Loss', a, e.fee, e.kind === 'predict' ? 'Predict' : 'Perps', e.what));
        if (e.fee < -DUST) rows.push(row(e, 'Other Income', -e.fee, 0, 'Perps', 'fee rebate · ' + e.what));
      } else if (e.kind === 'fee' || e.kind === 'posfee') rows.push(row(e, a <= 0 ? 'Margin Fee' : 'Other Income', a, 0, 'Perps', e.what));
      else if (e.kind === 'funding') rows.push(row(e, a >= 0 ? 'Other Income' : 'Other Fee', a, 0, 'Funding Rate', e.what));
      else if (e.kind === 'deposit') rows.push(row(e, 'Deposit', a, 0, '', e.what));
      else if (e.kind === 'withdrawal') rows.push(row(e, 'Withdrawal', a, e.fee, '', e.what));
      else if (e.kind === 'tfee') rows.push(row(e, 'Other Fee', a, 0, '', e.what));
    }
    const ok = rows.filter((r) => r.buy >= DUST || r.sell >= DUST || r.fee >= DUST);
    return dedupe(ok, (r) => [r.type, n6(r.buy), n6(r.sell), n6(r.fee), r.group, r.date].join('|'), (a, b) => { a.buy += b.buy; a.sell += b.sell; a.fee += b.fee; });
  };
  EX.ctColumns = () => [
    ['Type', (r) => r.type], ['Buy Amount', (r) => amt(r.buy)], ['Buy Cur.', (r) => (r.buy >= DUST ? 'USDe' : '')], ['Sell Amount', (r) => amt(r.sell)], ['Sell Cur.', (r) => (r.sell >= DUST ? 'USDe' : '')],
    ['Fee', (r) => amt(r.fee)], ['Fee Cur.', (r) => (r.fee >= DUST ? 'USDe' : '')], ['Exchange', () => 'Meridian'], ['Trade-Group', (r) => r.group], ['Comment', (r) => r.what], ['Date', (r) => r.date],
  ];

  // ---------- Form 8949 ----------
  /** What the Form 8949 statement assumes, said on its button, in its methodology row and in the README: a reading,
   *  not the law (no IRS guidance names how a perpetual future is reported). */
  EX.F8949_READING = 'for the reading that reports each perp disposal as a capital gain or loss on Form 8949 and Schedule D; the IRS has issued no guidance on perpetual futures, and other readings (a swap / notional principal contract, a trader\'s mark-to-market election) report them elsewhere';
  // 'YYYY-MM-DD' (or VARIOUS) as MM/DD/YYYY, the form's own convention
  const usDate = (key) => (/^\d{4}-\d{2}-\d{2}$/.test(String(key)) ? key.slice(5, 7) + '/' + key.slice(8, 10) + '/' + key.slice(0, 4) : String(key || ''));
  const PART = { I: { name: 'I (short-term)', di: 'I', nd: 'C', line: 'Schedule D line 3 (box C or I)' }, II: { name: 'II (long-term)', di: 'L', nd: 'F', line: 'Schedule D line 10 (box F or L)' } };
  /**
   * The Form 8949 statement: one row per disposal in the period (columns (a) to (h), dates MM/DD/YYYY in the report's
   * zone, Part I or II by the anniversary rule), the totals per Part under both readings of funding and position fees,
   * the summary rows an Exception 2 statement goes with, and a check against the exchange's ledger. Whether a perpetual
   * is a digital asset (boxes I and L) or not (C and F) is not settled, so both boxes are given side by side. ctx:
   * {period, tz, money, fname, ev, D, led}.
   */
  EX.form8949 = (c) => {
    const { tz, money, D } = c, P = c.period, C = money && money.rates ? money.ccy : null;
    const rows = D.inP.filter((r) => r.t >= P.start && r.t < P.end).map((r) => {
      const adj = r.fundingIn - r.posFeeIn, adjC = r.fundingInC - r.posFeeInC;
      // in the report currency each part at its own date (T.fills.replay); the inside reading puts funding received in
      // (d) and paid in (e) by the USD sign, so a disposal sits on the same side in both currencies
      // Part II by the US reading of the holding period (Rev. Rul. 66-7 at a month's end: T.tz.heldOverYear)
      return { r, part: (r.longTermUS != null ? r.longTermUS : r.longTerm) ? 'II' : 'I', d: r.proceeds, e: r.cost, h: r.net, adj, dIn: r.proceeds + Math.max(adj, 0), eIn: r.cost + Math.max(-adj, 0), hIn: r.netAll,
        dC: r.proceedsC, eC: r.costC, hC: r.netC, dInC: r.proceedsC + (adj > 0 ? adjC : 0), eInC: r.costC + (adj < 0 ? -adjC : 0), hInC: r.netAllC };
    });
    const statement = {
      title: 'Form 8949 statement: one row per disposal',
      columns: [
        ['Part', (x) => PART[x.part].name], ['Box if a digital asset (no Form 1099-DA)', (x) => PART[x.part].di], ['Box if not a digital asset (no Form 1099-B)', (x) => PART[x.part].nd],
        ['(a) Description of property', (x) => `${n6(x.r.qty)} ${x.r.ticker} perpetual ${sideWord(x.r.long)} · position ${x.r.positionId} · fill ${x.r.n}`],
        [`(b) Date acquired (${tz})`, (x) => usDate(x.r.acquired)], [`(c) Date sold or disposed of (${tz})`, (x) => TZ.fmt(x.r.t, tz, 'us')],
        ['(d) Proceeds USD', (x) => n6(x.d)], ['(e) Cost or other basis USD', (x) => n6(x.e)], ['(f) Code(s)', () => ''], ['(g) Amount of adjustment', () => ''], ['(h) Gain or (loss) USD', (x) => n6(x.h)],
        ['Funding and position fees inside the result USD (that reading: settled since the position opened, by quantity closed)', (x) => n6(x.adj)],
        ['(h) Gain or (loss) USD, funding and position fees inside', (x) => n6(x.hIn)],
        ...EX.ccyCols(money, (x) => x.r.t, [['(d) Proceeds', (x) => x.d, (x) => x.dC], ['(e) Cost or other basis', (x) => x.e, (x) => x.eC], ['(h) Gain or (loss)', (x) => x.h, (x) => x.hC], ['(h) Gain or (loss), funding and position fees inside', (x) => x.hIn, (x) => x.hInC]]),
        ['Time sold (UTC)', (x) => EX.iso(x.r.t)],
      ],
      rows,
    };
    const tot = [];
    for (const part of ['I', 'II']) {
      const xs = rows.filter((x) => x.part === part); if (!xs.length) continue;
      for (const inside of [false, true]) tot.push({ part, inside, n: xs.length,
        d: U.sum(xs, (x) => (inside ? x.dIn : x.d)), e: U.sum(xs, (x) => (inside ? x.eIn : x.e)), h: U.sum(xs, (x) => (inside ? x.hIn : x.h)),
        dC: U.sum(xs, (x) => (inside ? x.dInC : x.dC)), eC: U.sum(xs, (x) => (inside ? x.eInC : x.eC)), hC: U.sum(xs, (x) => (inside ? x.hInC : x.hC)) });
    }
    const reading = (x) => (x.inside ? 'funding and position fees inside the result (funding received in (d), paid and position fees in (e))' : 'funding and position fees as separate items');
    const totals = {
      title: 'Totals per Part, both readings (neither marked as the one that applies)',
      columns: [['Schedule D', (x) => PART[x.part].line], ['Part', (x) => PART[x.part].name], ['Reading', reading], ['Disposals', (x) => x.n],
        ['(d) Proceeds USD', (x) => n6(x.d)], ['(e) Cost or other basis USD', (x) => n6(x.e)], ['(g) Adjustments USD', () => '0'], ['(h) Gain or (loss) USD', (x) => n6(x.h)],
        ...(C ? [['(d) Proceeds ' + C, (x) => n6(x.dC)], ['(e) Cost or other basis ' + C, (x) => n6(x.eC)], ['(h) Gain or (loss) ' + C, (x) => n6(x.hC)]] : [])],
      rows: tot,
    };
    const summary = {
      title: 'Form 8949 summary row with an attached statement (Exception 2, code M)',
      columns: [['Part', (x) => PART[x.part].name], ['Box if a digital asset', (x) => PART[x.part].di], ['Box if not', (x) => PART[x.part].nd], ['Reading', reading],
        ['(a) Description of property', () => 'Meridian perpetuals – see attached statement'], ['(b) Date acquired', () => ''], ['(c) Date sold or disposed of', () => ''],
        ['(d) Proceeds USD', (x) => n6(x.d)], ['(e) Cost or other basis USD', (x) => n6(x.e)], ['(f) Code(s)', () => 'M'], ['(g) Amount of adjustment', () => ''], ['(h) Gain or (loss) USD', (x) => n6(x.h)]],
      rows: tot,
    };
    // the check: Σ(h) against the ledger's realized PnL − trading fees, item by item
    const pos = new Map(((c.ev && c.ev.positions) || []).map((p) => [p.id, p]));
    const LT = c.led ? c.led.totals : { realized: 0, fees: 0 };
    const all = EX.fillPieces(D, pos), pieces = all.filter((x) => x.t >= P.start && x.t < P.end);
    const feeOther = U.sum(pieces.filter((x) => x.kind === 'unassigned' || x.kind === 'reduce'), (x) => x.fee);
    // the ledger counts an hour a boundary cuts in its middle (India, Adelaide) in the period it starts in; the
    // disposals count by the exact instant: the fees of such fills move between the two
    const at = c.led ? T.fills.segmentOf(c.led.segments) : null;
    const feeShift = at ? U.sum(pieces, (x) => x.fee) - U.sum(all.filter((x) => at(x.t) >= 0), (x) => x.fee) : 0;
    const openStart = EX.openFeesAt(D, pos, P.start), openEnd = EX.openFeesAt(D, pos, P.end);
    const sumH = U.sum(rows, (x) => x.h), sumHIn = U.sum(rows, (x) => x.hIn);
    const expected = LT.realized - D.outside.usd - (LT.fees + feeShift - feeOther + openStart - openEnd);
    const check = {
      title: 'Check against the exchange\'s ledger (USD)',
      columns: [['Item', (x) => x[0]], ['USD', (x) => n6(x[1])]],
      rows: [
        ['Ledger realized PnL in the period', LT.realized], ['Ledger trading fees in the period', LT.fees], ['Ledger realized PnL − trading fees', LT.realized - LT.fees],
        ['less: realized PnL outside the disposals (the ledger less the disposals listed)', D.outside.usd],
        ['less: trading fees of fills in an hour a period boundary cuts in its middle (the ledger counts that hour in the period it starts in; the disposals by the exact instant)', feeShift],
        ['plus: fees of fills in no disposal and no open position (fills no position holds, reductions with nothing open)', feeOther],
        ['less: opening fees paid before the period on positions reduced in it (in its disposals)', openStart],
        ['plus: opening fees on positions open at the period end (paid, not yet in a disposal)', openEnd],
        ['Σ(h) expected, funding and position fees as separate items', expected], ['Σ(h) of the statement', sumH], ['Difference', Math.abs(sumH - expected) < 1e-9 ? 0 : sumH - expected],
        ['Σ(h) with funding and position fees inside', sumHIn], ['of which funding and position fees inside', sumHIn - sumH],
      ],
    };
    const warnings = EX.eventWarnings(c);
    if (c.led && c.led.fallbackDays.length) warnings.push(c.led.fallbackDays.length + ' UTC day(s) the period\'s boundaries cut counted whole (their hourly ledger could not be read): the check differs by that day\'s activity on the other side of the boundary');
    return { name: c.fname('form-8949-statement'), sections: [statement, totals, summary, check], warnings, check: { expected, sumH, sumHIn, openStart, openEnd, feeOther, feeShift },
      extra: [['Form 8949', EX.F8949_READING + '; one row per disposal (each reducing fill), Part I or II by the anniversary rule in ' + tz + ', read with Rev. Rul. 66-7 (an increase on the last day of a month is held more than a year only from the first day of the 13th month after it); Part II only when the last increase the disposal is averaged over is more than a year old, which is stricter than counting from the position\'s opening; (d) and (e) follow the notional convention with fees inside, so (f) and (g) are blank; both boxes are given side by side, as whether a perpetual is a digital asset (I, L) or not (C, F) is not settled; (b) is VARIOUS when the increases a disposal is averaged over fall on different local dates; the totals per Part are what Schedule D lines 3 and 10 take for the box used; no tax, limit or netting is computed']].concat(C ? [['Form 8949 in ' + C, EX.DISPOSAL_RATE_TEXT]] : []) };
  };

  // ---------- the summary section (period totals; the page assembles its context: js/tax/summary.js) ----------
  EX.define('summary', {
    section: 'summary', kind: 'report', needs: ['summary'], grain: 'period', ccy: 'all', label: 'Summary',
    sub: 'The period (local and UTC), every perps total with funding received and paid, the holdings at the period\'s start and end, Meridian Predict under every date basis with the results decided and not claimed, the USDe lots; then gains and losses by class, the monthly and quarterly tables.',
    build: (c) => T.summary.summaryFile(c),
  });
  EX.define('by-class', {
    section: 'summary', kind: 'report', needs: ['summary'], grain: 'period', ccy: 'all', label: 'Gains and losses by class',
    sub: 'Per class (crypto perps, commodity mPerps, equity-ETF mPerps): disposals, proceeds, costs, gains, losses and net, under both readings of funding and position fees; Meridian Predict under every date basis; the USDe lots. Never summed together.',
    build: (c) => T.summary.classFile(c),
  });

  // ---------- perps ----------
  // ctx: {period, tz, money, fname, ev, D, ref, led, closed, sid, now}
  EX.define('perps-disposals', {
    section: 'perps', kind: 'report', needs: ['events'], grain: 'event', ccy: 'all', label: 'Disposals',
    sub: (c) => 'One row per reduction, partial close, liquidation or auto-deleverage, on its own date: quantity, average entry, exit, gross, fee shares and net, funding and position fees as separate items and inside the result, proceeds and cost, date acquired' + (c.money && c.money.rates ? `; in ${c.money.ccy} the result and the notional legs at the disposal date's rate, the opening-fee share and the funding and position fees carried in at the dates they were paid` : '') + '.',
    build(ctx) {
      const { tz, money } = ctx, P = ctx.period;
      const label = (r) => `${r.ticker} ${r.long ? 'long' : 'short'} opened ${TZ.dayKey(r.opened, tz)}`;
      const columns = [
        ['Position', label], ['Market', (r) => r.ticker], ['Class', (r) => r.cls], ['Side', (r) => (r.long ? 'LONG' : 'SHORT')], ['Fill no. in position', (r) => r.n],
        ['Time (UTC)', (r) => EX.iso(r.t)], ...EX.loc(tz, 'Time', (r) => r.t),
        ['Quantity', (r) => T.n6(r.qty)], ['Average entry', (r) => T.n6(r.avgEntry)], ['Exit price', (r) => T.n6(r.exit)],
        ['Entry notional USD', (r) => T.n6(r.entryNotional)], ['Exit notional USD', (r) => T.n6(r.exitNotional)],
        ['Realized PnL (gross) USD', (r) => T.n6(r.gross)], ['Opening fee share USD', (r) => T.n6(r.openFee)], ['Closing fee USD', (r) => T.n6(r.closeFee)],
        ['Net USD (funding and position fees as separate items)', (r) => T.n6(r.net)],
        ['Funding settled at this fill USD (+ received)', (r) => T.n6(r.fundingAt)], ['Position fees settled at this fill USD', (r) => T.n6(r.posFeeAt)],
        ['Funding carried in USD (inside the result)', (r) => T.n6(r.fundingIn)], ['Position fees carried in USD (inside the result)', (r) => T.n6(r.posFeeIn)],
        ['Net USD (funding and position fees inside the result)', (r) => T.n6(r.netAll)],
        ['Proceeds USD (notional convention)', (r) => T.n6(r.proceeds)], ['Cost USD (notional convention)', (r) => T.n6(r.cost)],
        [`Date acquired (${tz})`, (r) => r.acquired], [`Held over a year (calendar dates, ${tz})`, (r) => yn(r.longTerm)],
        ['Partial (position still open)', (r) => yn(r.partial)], ['Liquidation', (r) => yn(r.liq)], ['Auto-deleverage', (r) => yn(r.adl)], ['Position ID', (r) => r.positionId],
        // the result, the closing fee and the notional legs at the disposal date (the rate column); the opening-fee share
        // and the funding and position fees carried in each at the date it was paid, and the nets, proceeds and cost
        // built from those parts
        ...EX.ccyCols(money, (r) => r.t, [['Realized PnL (gross)', (r) => r.gross], ['Opening fee share (each at the date paid)', (r) => r.openFee, (r) => r.openFeeC], ['Closing fee', (r) => r.closeFee, (r) => r.closeFeeC],
          ['Net (separate)', (r) => r.net, (r) => r.netC], ['Funding carried in (each at its settlement date)', (r) => r.fundingIn, (r) => r.fundingInC], ['Position fees carried in (each at its settlement date)', (r) => r.posFeeIn, (r) => r.posFeeInC],
          ['Net (inside)', (r) => r.netAll, (r) => r.netAllC], ['Proceeds', (r) => r.proceeds, (r) => r.proceedsC], ['Cost', (r) => r.cost, (r) => r.costC]]),
      ];
      const rows = ctx.D.inP.filter((r) => r.t >= P.start && r.t < P.end);
      return { name: ctx.fname('disposals'), columns, rows, warnings: EX.eventWarnings(ctx), extra: money && money.rates ? [['Disposals in ' + money.ccy, EX.DISPOSAL_RATE_TEXT]] : [] };
    },
  });

  EX.define('perps-funding', {
    section: 'perps', kind: 'report', needs: ['events'], grain: 'event', ccy: 'all', label: 'Funding settlements',
    sub: 'One row per position per settlement (the hourly charges between two of its fills settle as one amount): settled time, charged from / to, received or paid; then what was charged and not settled by the period end.',
    build(ctx) {
      const { tz, money } = ctx, P = ctx.period, D = ctx.D, ref = ctx.ref || {};
      const pos = new Map((ctx.ev && ctx.ev.positions || []).map((p) => [p.id, p]));
      const market = (r) => { const p = pos.get(r.positionId); const prod = p && ref.byId ? ref.byId[p.productId] : null; return prod ? prod.displayTicker : (p ? p.productId : r.productId || ''); };
      const side = (r) => { const p = pos.get(r.positionId); return p ? (String(p.side) === '0' ? 'LONG' : 'SHORT') : ''; };
      const rows = [];
      const F = D.funding;
      for (const s of F.inP) rows.push({ t: s.t, status: 'settled', positionId: s.positionId, from: s.from, to: s.to, n: s.n, amount: s.amount });
      for (const seg of F.fig.fallback) if (Math.abs(seg.funding) >= 1e-9) rows.push({ t: seg.tm, status: 'netted per UTC day: settlement detail unavailable', day: seg, amount: seg.funding });
      if (F.unsettledEnd) for (const x of F.unsettledEnd.byPos.values()) if (Math.abs(x.amount) >= 1e-9) rows.push({ t: null, status: 'charged, not settled by period end', positionId: x.positionId, from: x.from, to: x.to, n: x.n, amount: x.amount });
      const tOf = (r) => (r.t != null ? r.t : P.end - 1);
      const columns = [
        ['Status', (r) => r.status], ['Settled (UTC)', (r) => (r.t != null && !r.day ? EX.iso(r.t) : '')], ...(tz === 'UTC' ? [] : [[`Settled (${tz})`, (r) => (r.t != null && !r.day ? TZ.fmt(r.t, tz, 'iso') : '')]]),
        ['UTC day', (r) => (r.day ? new Date(r.day.day).toISOString().slice(0, 10) + (r.day.part ? ' ' + r.day.part : '') : '')],
        ['Market', (r) => (r.positionId ? market(r) : '')], ['Side', (r) => (r.positionId ? side(r) : '')], ['Position ID', (r) => r.positionId || ''],
        ['Charged from (UTC)', (r) => (r.from != null ? EX.iso(r.from) : '')], ['Charged to (UTC)', (r) => (r.to != null ? EX.iso(r.to) : '')], ['Hourly charges', (r) => (r.n != null ? r.n : '')],
        ['Received USD', (r) => (r.amount > 0 ? T.n6(r.amount) : '')], ['Paid USD', (r) => (r.amount < 0 ? T.n6(-r.amount) : '')],
        ...EX.ccyCols(money, tOf, [['Funding (+ received)', (r) => r.amount]]),
      ];
      const w = EX.eventWarnings(ctx);
      if (!F.S) w.push('the hourly funding charges could not be read: every day is netted');
      else if (F.fig.fallback.length) w.push(F.fig.fallback.length + ' UTC day(s) netted per day: settlement detail unavailable');
      return { name: ctx.fname('funding-settlements'), columns, rows, warnings: w };
    },
  });

  EX.define('perps-8949', {
    section: 'perps', kind: 'report', needs: ['events'], grain: 'event', ccy: 'all', label: 'Form 8949 statement',
    sub: (c) => 'F' + EX.F8949_READING.slice(1) + `. One row per disposal in the period: Part I or II (anniversary rule in ${c.tz}, Rev. Rul. 66-7 at a month's end, from the last increase), the box if a digital asset (I, L) and if not (C, F) side by side, (a) to (h) with dates MM/DD/YYYY, (h) with funding and position fees inside too` + (c.money && c.money.rates ? `, (d), (e) and (h) in ${c.money.ccy}: the notional legs at the disposal date's rate, the opening-fee share and the funding and position fees carried in at the dates they were paid` : '') + '; totals per Part for Schedule D lines 3 and 10 under both readings, the Exception 2 summary row (code M) and a check against the ledger.',
    build: (c) => EX.form8949(c),
  });

  /** The Closed positions file's own methodology row: what a row is, and why it is not the period's figure. */
  EX.CLOSED_ROW = ['Closed positions', 'one row per position fully closed in the period, with its whole-life result dated at the final close: its PnL, fees and funding include those booked on earlier partial closes, before the period too, so a row is not the period\'s figure; the period\'s disposals are in the Disposals and Form 8949 files, and the two are not added together'];
  EX.define('perps-closed', {
    section: 'perps', kind: 'report', needs: ['events?'], grain: 'position', ccy: 'all', label: 'Closed positions',
    sub: (c) => 'Every position fully closed in the period with entry and exit notional, PnL, fees, funding (net, received and paid), net and holding period, each its whole-life result dated at the close (partial closes before the period included: not the period\'s figure, which is in Disposals)' + (c.money && c.money.rates ? `; each amount also in ${c.money.ccy} at the close date's rate, with the rate and its date (the notional is never converted at the open date)` : '') + '.',
    build(c) {
      const { tz, money, D } = c;
      const fb = (x) => (D ? D.funding.byPos.get(x.p.id) || { received: 0, paid: 0 } : { received: null, paid: null });
      const columns = [['Closed (UTC)', (x) => EX.iso(x.t)], ...EX.loc(tz, 'Closed', (x) => x.t), ['Opened (UTC)', (x) => EX.iso(x.p.createdAt)], ...EX.loc(tz, 'Opened', (x) => U.num(x.p.createdAt)),
        ['Market', (x) => x.ticker], ['Side', (x) => (x.long ? 'LONG' : 'SHORT')], ['Size', (x) => n6(x.size)], ['Avg entry', (x) => n6(x.entry)], ['Avg exit', (x) => n6(x.exit)],
        ['Entry notional USD', (x) => n6(x.cost)], ['Exit notional USD', (x) => n6(x.proceeds)], ['Realized PnL USD', (x) => n6(x.gross)], ['Trading fees USD', (x) => n6(x.fees)], ['Position fees USD', (x) => n6(x.pfees)],
        ['Funding USD', (x) => n6(x.funding)], ['Funding received USD', (x) => m6(fb(x).received)], ['Funding paid USD', (x) => m6(fb(x).paid)], ['Net USD', (x) => n6(x.net)],
        // every amount at the close date's rate: converting the notional at the open date would invent an FX result on it
        ...EX.ccyCols(money, (x) => x.t, [['Entry notional', (x) => x.cost], ['Exit notional', (x) => x.proceeds], ['Realized PnL', (x) => x.gross], ['Trading fees', (x) => x.fees], ['Position fees', (x) => x.pfees], ['Funding', (x) => x.funding], ['Net', (x) => x.net]]),
        ['Held hours', (x) => (x.hold / HOUR).toFixed(2)], [`Held more than one year (calendar dates, ${tz})`, (x) => yn(x.longTerm)], ['Liquidated', (x) => yn(x.liq)], ['Deleveraged', (x) => yn(x.adl)], ['Position ID', (x) => x.p.id]];
      // the file travels without the page's note: it says itself that a row is a whole-life result, not the period's
      return { name: c.fname('closed-positions'), columns, rows: c.closed || [], warnings: perpsWarnings(c), extra: [EX.CLOSED_ROW] };
    },
  });

  EX.define('perps-daily', {
    section: 'perps', kind: 'report', needs: ['events?'], grain: 'day', ccy: 'net', label: 'Daily ledger',
    sub: (c) => 'One row per UTC day (a day the period\'s boundaries cut, in parts): realized PnL, trading and position fees, funding (net, received and paid), deposits, withdrawals, balance' + (c.money && c.money.rates ? ', the net in ' + c.money.ccy + ' at the rate of the local date holding the day\'s middle (with that rate and its date) and as the totals have it (' + (c.led && c.led.basisC && c.led.basisC.events ? 'each event at its own local date' : 'the trade detail is not loaded: the day whole') + ')' : '') + '.',
    build(c) {
      const days = c.led.segments, money = c.money;
      const bs = (c.D ? c.D.funding.fig : T.funding.figures(null, days, money.fx)).bySeg, ix = new Map(days.map((b, i) => [b, i]));
      const columns = [['Date (UTC day)', (b) => new Date(b.day).toISOString().slice(0, 10)], ['Part (UTC)', (b) => b.part || ''], ['Realized PnL USD', (b) => n6(b.realizedPnl)], ['Trading fees USD', (b) => n6(b.fee)], ['Funding USD', (b) => n6(b.funding)],
        ['Funding received USD', (b) => n6(bs[ix.get(b)].received)], ['Funding paid USD', (b) => n6(bs[ix.get(b)].paid)], ['Funding detail', (b) => (bs[ix.get(b)].fallback && b.funding ? 'netted per day: settlement detail unavailable' : '')],
        ['Net USD', (b) => n6(b.net)], ['Position fees USD', (b) => n6(b.pfees)], ['Deposits USD', (b) => n6(b.deposit)], ['Withdrawals USD (incl. fees)', (b) => n6(b.withdrawal)], ['Withdrawal & deposit fees USD', (b) => n6(b.wfee)],
        ['Volume USD', (b) => n6(b.volume)], ['Balance at end USD', (b) => n6(b.balance)], ...money.cols((b) => b.net, (b) => b.tm, 'Net'),
        // the same day's net as the totals have it: each fill, settlement and transfer at its own local date
        // (T.ledger.recast), the day whole where its detail does not add up; these add up to the summary's net
        // before the recast (no trade detail) the totals convert each UTC day whole too: the column says so rather than claim events
        ...(money.rates ? [[c.led.basisC && c.led.basisC.events ? 'Net ' + money.ccy + ', each event at its own local date (as the totals)' : 'Net ' + money.ccy + ' as the totals have it (trade detail not loaded: the UTC day whole)', (b) => (b.C && b.C.net != null ? n6(b.C.net) : '')]] : [])];
      const w = c.D ? [] : ['the trade detail did not load: funding received and paid are each day\'s net'];
      if (c.led.fallbackDays.length) w.push(c.led.fallbackDays.length + ' UTC day(s) the period\'s boundaries cut whose hourly ledger could not be read: counted whole');
      return { name: c.fname('daily-ledger'), columns, rows: EX.fromFirstActive(days), warnings: w };
    },
  });

  EX.define('perps-all', {
    section: 'perps', kind: 'report', needs: ['events'], grain: 'event', ccy: 'all', label: 'All transactions',
    sub: 'Fills (liquidation and auto-deleverage fills included), funding and position-fee settlements, transfers and position closes in one chronological file (oldest first); the cash effects add up to the balance change.',
    build(c) {
      const { tz, money } = c;
      const rows = (c.events || EX.transactions(c)).slice().sort((a, b) => a.t - b.t);
      const columns = [['Time (UTC)', (e) => EX.iso(e.t)], ...EX.loc(tz, 'Time', (e) => e.t), ['Type', (e) => (e.type === 'trade' ? 'fill' : e.type === 'posfee' ? 'position fee' : e.type)], ['What', (e) => e.what],
        ['Cash effect USD', (e) => (e.amount ? n6(e.amount) : '')], ['Fee USD', (e) => (e.fee ? n6(e.fee) : '')], ['Notional USD', (e) => (e.notional ? n6(e.notional) : '')], ['Realized PnL USD', (e) => (e.realized != null ? n6(e.realized) : '')],
        ...money.cols((e) => (e.amount ? e.amount : null), (e) => e.t, 'Cash effect'), ['Detail', (e) => e.detail], ['Tx', (e) => e.tx || ''], ['ID', (e) => e.id]];
      const w = EX.eventWarnings(c);
      if (c.ev.truncated && c.ev.truncated.transfers) w.push('more transfers than could be read');
      return { name: c.fname('all-transactions'), columns, rows, warnings: w };
    },
  });

  EX.define('perps-fills', {
    section: 'perps', kind: 'report', needs: ['events'], grain: 'event', ccy: 'none', label: 'Fills (trades)',
    sub: 'Every order fill in the period, plus liquidation and auto-deleveraging fills, with price, quantity, fee, maker flag (order fills), position, and the realized PnL of every reducing fill.',
    build(c) {
      const { tz, ev, D, ref } = c, start = c.period.start, end = c.period.end;
      // every order fill of the period once (a fill split between two positions is one row), plus the liquidation and
      // deleverage fills read from their positions; the realized PnL of each reducing fill from the replay
      const byId = new Map(), byKey = new Map(), key = (t, pid, side) => t + '|' + pid + '|' + side;
      const add = (m, k, r) => { const x = m.get(k) || { pnl: 0, ids: new Set(), n: 0 }; x.pnl += r.gross; x.ids.add(r.positionId); x.n++; m.set(k, x); };
      for (const r of D.rows) { if (r.fillId) add(byId, r.fillId, r); else if (r.src === 'position') add(byKey, key(r.t, r.productId, r.long ? '1' : '0'), r); }
      const pidOf = new Map(); for (const [pid, fs] of D.byPos) for (const f of fs) if (f.id) { const s = pidOf.get(f.id) || new Set(); s.add(pid); pidOf.set(f.id, s); }
      const posById = new Map(ev.positions.map((p) => [p.id, p]));
      const list = ev.fills.filter((f) => U.num(f.createdAt) >= start && U.num(f.createdAt) < end).map((f) => Object.assign({}, f));
      for (const [pid, fs] of ev.posFills) {
        const p = posById.get(pid); if (!p) continue;
        for (const f of fs) if ((f.type === 'LIQUIDATION' || f.type === 'DELEVERAGE') && U.num(f.createdAt) >= start && U.num(f.createdAt) < end) list.push(Object.assign({}, f, { productId: p.productId, isMaker: null, orderId: '', id: '', positionId: pid }));
      }
      list.sort((a, b) => U.num(a.createdAt) - U.num(b.createdAt));
      const pnlOf = (f) => { const a = f.id ? byId.get(f.id) : null, b = byKey.get(key(U.num(f.createdAt), f.productId, String(f.side))); return a || b ? (a ? a.pnl : 0) + (b ? b.pnl : 0) : null; };
      const columns = [['Time (UTC)', (f) => EX.iso(f.createdAt)], ...EX.loc(tz, 'Time', (f) => U.num(f.createdAt)), ['Market', (f) => (ref.byId[f.productId] ? ref.byId[f.productId].displayTicker : f.productId)], ['Side', (f) => U.sideName(f.side)], ['Order type', (f) => f.type],
        ['Quantity', (f) => n6(f.filled)], ['Price', (f) => n6(f.price)], ['Notional USD', (f) => n6(U.num(f.filled) * U.num(f.price))], ['Fee USD', (f) => n6(f.feeUsd)], ['Realized PnL USD', (f) => { const v = pnlOf(f); return v == null ? '' : n6(v); }],
        ['Maker', (f) => (f.isMaker == null ? '' : f.isMaker ? 'yes' : 'no')], ['Reduce only', (f) => (f.reduceOnly ? 'yes' : 'no')],
        ['Position ID', (f) => (f.positionId || Array.from(new Set([...(pidOf.get(f.id) || []), ...((byKey.get(key(U.num(f.createdAt), f.productId, String(f.side))) || {}).ids || [])])).join(' + '))], ['Order ID', (f) => f.orderId || ''], ['Fill ID', (f) => f.id || '']];
      return { name: c.fname('fills'), columns, rows: list, warnings: EX.eventWarnings(c) };
    },
  });

  EX.define('perps-transfers', {
    section: 'perps', kind: 'report', needs: ['events'], grain: 'event', ccy: 'none', label: 'Deposits, withdrawals & conversions',
    sub: 'Transfers and margin conversions with transaction hashes; amounts in token units.',
    build(c) {
      const { tz, ev } = c;
      const columns = [['Time (UTC)', (t) => EX.iso(t.createdAt)], ...EX.loc(tz, 'Time', (t) => U.num(t.createdAt)), ['Type', (t) => t.type], ['Token', (t) => t.tokenName], ['To token', (t) => t.toTokenName || ''], ['Amount', (t) => n6(t.amount)], ['Fee', (t) => n6(t.fee)], ['Status', (t) => t.status],
        ['Initiated tx', (t) => t.initiatedTransactionHash || ''], ['Finalized tx', (t) => t.finalizedTransactionHash || ''], ['Transfer ID', (t) => t.id]];
      return { name: c.fname('transfers'), columns, rows: ev.transfers.slice().sort((a, b) => U.num(a.createdAt) - U.num(b.createdAt)), warnings: ev.truncated && ev.truncated.transfers ? ['more transfers than could be read'] : [] };
    },
  });

  const toolSub = (c, tool) => {
    const x = c.D ? EX.perpsTool(c) : null, fbDays = x ? new Set([].concat(...Object.values(x.fallback)).map((s) => s.t0)).size : null;
    return `Perps: one row per disposal fill, fee, funding and position-fee settlement and transfer, in UTC (import as UTC), oldest first (${tool}).`
      + (!c.D ? ' Until the trade detail is in (or when it fails), every UTC day is one row per kind of its total, stamped 10:00 UTC.' : fbDays ? ` ${fbDays} UTC day(s) whose detail does not add up to the ledger: daily totals stamped 10:00 UTC.` : '');
  };
  EX.define('perps-koinly', {
    section: 'perps', kind: 'tool', needs: ['events?'], grain: 'event', ccy: 'none', label: 'Perps: Koinly universal CSV',
    sub: (c) => toolSub(c, 'tags: realized gain, futures fee, funding fee, other fee; deposits and withdrawals untagged'),
    build(c) { const x = EX.perpsTool(c); return { name: c.fname('koinly'), columns: EX.koinlyColumns(), rows: EX.koinlyRows(x.events), warnings: x.warnings, events: x.events }; },
  });
  EX.define('perps-cointracking', {
    section: 'perps', kind: 'tool', needs: ['events?'], grain: 'event', ccy: 'none', label: 'Perps: CoinTracking CSV',
    sub: (c) => toolSub(c, 'Derivatives / Futures Profit and Loss, Margin Fee, funding as Other Income / Other Fee in group Funding Rate, Deposit, Withdrawal'),
    build(c) { const x = EX.perpsTool(c); return { name: c.fname('cointracking'), columns: EX.ctColumns(), rows: EX.ctRows(x.events), warnings: x.warnings, events: x.events }; },
  });

  /**
   * The exports card's text (B29): which files carry report-currency columns, which have none, and what one row is in
   * each, from the registry's own entries. ctx: {money, tz, sections (default ['summary', 'perps'])}.
   */
  EX.cardText = (c) => {
    const list = [].concat(...(c.sections || ['summary', 'perps']).map((s) => EX.list(s)));
    const names = (f) => { const l = list.filter(f).map((d) => EX.text(d.label, c)); return l.length < 2 ? l.join('') : l.slice(0, -1).join(', ') + ' and ' + l[l.length - 1]; };
    const C = c.money && c.money.rates ? c.money.ccy : null, src = C ? c.money.rates.src : null;
    const parts = [];
    // a group with no file of this card is left out
    const groups = (list2) => list2.map(([lead, f, tail]) => { const n = names(f); return n ? lead + n + (tail || '') : null; }).filter(Boolean).join('; ');
    const cc = C ? groups([['', (d) => d.ccy === 'all', ` add ${C} beside each amount, at the rate of its own date with the rate and the rate's date (${C === 'EUR' && src.id === 'ecb' ? 'the ECB\'s euro reference rates, USD per EUR inverted' : src.line}: ${src.rule})`], ['', (d) => d.ccy === 'net', ` adds the net in ${C}`], ['', (d) => d.ccy === 'none', ` have no ${C} column`]]) : '';
    parts.push('Amounts in USD' + (list.some((d) => d.ccy === 'none') ? ' (transfer amounts in token units, the tax-tool files in USDe)' : '') + (cc ? '; ' + cc : '') + '.');
    const gr = groups([['one row per event: ', (d) => d.grain === 'event'], ['per UTC day: ', (d) => d.grain === 'day'], ['per position: ', (d) => d.grain === 'position'], ['period totals: ', (d) => d.grain === 'period']]);
    if (gr) parts.push(gr.charAt(0).toUpperCase() + gr.slice(1) + '.');
    const perps = list.some((d) => d.section === 'perps');
    if (perps) parts.push('Event times in UTC' + (c.tz && c.tz !== 'UTC' ? ' and in ' + c.tz : '') + '; the daily ledger keeps the exchange\'s UTC days; the tax-tool files are in UTC (import them as UTC), a UTC day whose detail is unavailable as one daily total at 10:00 UTC.');
    parts.push('Report files start with the methodology (one key and value per row), a blank line, then the table' + (perps ? '; the tax-tool files start with the tool\'s own header and hold nothing else (their methodology: Import notes, and the ZIP)' : '') + '. A file whose detail is incomplete says so in its name (-INCOMPLETE) and its Completeness row.');
    if (perps) parts.push('Meridian Predict has its own Koinly and CoinTracking files in the Predict section; import both.');
    return parts.join(' ');
  };

  // ---------- Meridian Predict ----------
  // ctx: {prep (T.predict.prepare), fig (T.predict.figures under mode), mode, period, tz, money, fname, notes: {totals
  // (the period figures are incomplete), file (the per-prediction files list only the loaded predictions)}}. Every file
  // follows the date basis chosen on the card; the record plus the secondary-market file add up to the Realized PnL tile.
  const PR = () => T.predict;
  const warn = (file, note) => Object.assign(file, { warnings: note ? [note] : [] });
  const booked = (c) => ({ claim: 'claimed (paid out)', claimable: 'decided (settled on Meridian)', verdict: 'resolved on the source market' }[PR().modeOf(c.mode)]);
  const sfx = (c) => (PR().modeOf(c.mode) === PR().DEFAULT ? '' : '-' + PR().modeOf(c.mode));
  EX.define('predict-daily', {
    section: 'predict', kind: 'report', grain: 'day', ccy: 'all', label: 'Predict daily ledger',
    sub: (c) => `One row per local day (${c.tz}): realized PnL with winnings, payouts, lost stakes and the ledger's gains and losses, its cumulative in the period (the last row is the Realized PnL tile), wagered, predictions placed, and results won, lost or void as ${booked(c)} that day.`,
    build: (c) => warn(PR().dailyFile(c.fig, c), c.notes && c.notes.totals),
  });
  EX.define('predict-record', {
    section: 'predict', kind: 'report', grain: 'event', ccy: 'all', label: 'Predict record (all statuses)',
    sub: () => 'Every prediction of this wallet, as bettor or market maker, placed, decided or claimed in the period, or still open at its end: when placed, decided (settled on Meridian), resolved on the source market, claimed (and by whom) and booked, its status at the period end, picks, both collaterals, odds, result, payout, cost and net, the placement and claim transactions.',
    build: (c) => warn(PR().recordFile(c.prep, c), c.notes && c.notes.file),
  });
  EX.define('predict-secondary', {
    section: 'predict', kind: 'report', grain: 'event', ccy: 'all', label: 'Predict secondary market',
    when: (c) => c.prep.L.trades.length > 0 || c.prep.L.events.length > 0,
    sub: (c) => 'Every position token bought or sold in the period (a sale with its average cost and realized PnL), matched sets (both sides held), and tokens held to the verdict, booked when ' + booked(c) + '. With the record\'s counted net it adds up to the Realized PnL tile.',
    build: (c) => warn(PR().tradesFile(c.prep, c), c.notes && c.notes.totals),
  });
  EX.define('predict-unclaimed', {
    section: 'predict', kind: 'report', grain: 'event', ccy: 'all',
    label: (c) => (c.fig.tail.booked ? 'Predict booked, not yet claimed' : 'Predict decided, not claimed'),
    when: (c) => c.fig.tail.n > 0,
    sub: (c) => 'Every result decided (settled on Meridian) in the period and not claimed (paid out) by its end, own predictions and token positions held to the verdict: picks, cost, the amount claimable and the PnL at the decision. ' + (c.fig.tail.booked ? 'Already in the realized figures above under this basis.' : 'Not in the realized figures above under this basis.'),
    build: (c) => warn(PR().unclaimedFile(c.prep, c, c.fig.tail), c.notes && c.notes.totals),
  });
  const predictSub = (c, tool) => `One row per result booked in the period under this card's date basis (${booked(c)}), sale and matched set, in UTC (import as UTC), adding up to the Realized PnL tile; USDe; ${tool}. Separate from the perps files: import both.`;
  EX.define('predict-koinly', {
    section: 'predict', kind: 'tool', grain: 'event', ccy: 'none', label: 'Predict · Koinly universal CSV',
    sub: (c) => predictSub(c, 'tag realized gain, the claim or trade transaction as TxHash'),
    build: (c) => warn({ name: c.fname('predict-koinly' + sfx(c)), columns: EX.koinlyColumns(), rows: EX.koinlyRows(EX.predictToolEvents(c)) }, c.notes && c.notes.totals),
  });
  EX.define('predict-cointracking', {
    section: 'predict', kind: 'tool', grain: 'event', ccy: 'none', label: 'Predict · CoinTracking CSV',
    sub: (c) => predictSub(c, 'Derivatives / Futures Profit or Loss in Trade-Group Predict'),
    build: (c) => warn({ name: c.fname('predict-cointracking' + sfx(c)), columns: EX.ctColumns(), rows: EX.ctRows(EX.predictToolEvents(c)) }, c.notes && c.notes.totals),
  });

  // ---------- holdings at the period's start and end ----------
  // ctx: {H (T.holdings.build), period, tz, money, fname, lotsInfo, warnings}; the card puts T.holdings.describe first
  EX.define('holdings', {
    section: 'holdings', kind: 'report', grain: 'period', ccy: 'all', label: 'Holdings at period start and end',
    sub: (c) => 'Values at the period\'s start and ' + (c.H && c.H.instants[1].now ? 'now' : 'end') + ': ' + (!c.H || c.H.perps ? 'perps cash, unrealized PnL (price only), funding charged and not settled and equity per margin pool, the positions open, ' : '') + 'Meridian Predict at cost (open predictions, position tokens, decided and not claimed)' + (c.lotsInfo ? ', the USDe lots held' : '') + (!c.H || c.H.perps ? ', and the change in equity with deposits and withdrawals taken out' : '') + '; each in USD' + (c.money && c.money.rates ? ' and ' + c.money.ccy + ' at the rate of the local day before the instant' : '') + '.',
    build: (c) => T.holdings.file(c),
  });

  // ---------- USDe lots ----------
  // ctx: {res (T.lots.run under the deposit reading shown), alt (the other reading's), events (T.lots.usdeEvents'),
  // names, period, tz, money, fname, preset, warnings}. Site reports: the lots' methodology (T.lots.describe) goes first.
  EX.define('lots-disposals', {
    section: 'lots', kind: 'report', grain: 'event', ccy: 'all', label: 'USDe disposals (lots)',
    sub: (c) => `Every USDe disposal in the period under the method and scope chosen (${c.res ? T.lots.METHOD_LABEL[c.res.method] + ', ' + T.lots.SCOPE_LABEL[c.res.scope].toLowerCase() : '…'}): units, proceeds, cost and gain or loss in USD` + (c.money && c.money.rates ? ' and ' + c.money.ccy : '') + ', the rule that matched it, the dates acquired and holding days; the matched pieces; totals per fiscal year and scope under both deposit readings; the pools at the period end.',
    build: (c) => T.lots.disposalsFile(c),
  });
  EX.define('lots-flows', {
    section: 'lots', kind: 'report', grain: 'event', ccy: 'all', label: 'USDe flows',
    sub: 'Every USDe unit in and out (and every move between the wallet, the perps pools and the Predict wallet) from the account\'s first event to the period end, each with its value at its own date, for tools that keep a whole portfolio.',
    build: (c) => T.lots.flowsFile(c),
  });

  // ---------- the ZIP of everything ----------
  /**
   * The ZIP's entries: every built file as CSV (a report with its methodology rows first and a byte-order mark, so a
   * spreadsheet reads it as UTF-8; a tool file exactly as the tool takes it), then methodology.txt and methodology.json
   * (the record, the list of files and what each is missing, the tax-tool notes). items: [{file, meth (its methodology
   * rows; none for a tool file)}]; record: T.methodology.build's rows; o: {skipped (files not included, in words)}.
   * Returns [{name, data}] for T.zip.build.
   */
  EX.bundle = (items, record, o = {}) => {
    const M = T.methodology, out = [], files = [];
    for (const { file, meth } of items) {
      const name = EX.fileName(file);
      out.push({ name, data: (file.kind === 'tool' ? '' : '﻿') + EX.render(file, file.kind === 'tool' ? null : meth) });
      files.push({ name, kind: file.kind, warnings: file.warnings || [] });
    }
    const x = { files, skipped: o.skipped || [], notes: M.toolNotes() };
    out.push({ name: 'methodology.txt', data: M.text(record, x) }, { name: 'methodology.json', data: M.json(record, x) });
    return out;
  };
})();
