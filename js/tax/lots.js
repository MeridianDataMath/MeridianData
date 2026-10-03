/* MeridianDataHub — Tax center USDe lots: every USDe (and MeridianUSD) unit that comes into or leaves this wallet's
   Meridian activity, matched to the lots it came from by the method and scope the reader picks (FIFO, LIFO, a moving
   average, or the UK's same-day, 30-day and s104 pooling; per margin pool, per wallet, or one pool), so that a change in
   USDe's own value in the report currency between receiving and spending it shows as a gain or loss: a figure for the
   reading that treats USDe as a cryptoasset rather than money. The page names no reading, method or scope as the one
   that applies.
   It sees Meridian activity and the opening lots the reader enters only. Records, not advice: no tax is computed.
   Pure: no DOM, no network (the card that loads the data and draws this is view-lots). */
(function () {
  const MD = window.MD; const U = MD.util; const T = MD.tax; const TZ = T.tz;
  const LO = (T.lots = {});
  const EPS = 1e-9, DUST = 1e-6, DAY = 86400000, HOUR = 3600000;

  // ---------- choices (none of them preselected: the card asks for a method and a scope) ----------
  LO.METHODS = ['fifo', 'lifo', 'average', 'uk'];
  LO.METHOD_LABEL = { fifo: 'FIFO: first in, first out', lifo: 'LIFO: last in, first out', average: 'Moving average', uk: 'UK pooling: same day, 30 days, s104' };
  LO.METHOD_TEXT = {
    fifo: 'FIFO: each disposal takes the earliest acquired units still held in its scope',
    lifo: 'LIFO: each disposal takes the latest acquired units still held in its scope',
    average: 'moving average: each disposal costs the average cost of the units held in its scope at that moment (holding periods count first in, first out)',
    uk: 'UK share pooling: acquisitions on the same local day first (s105), then acquisitions in the 30 days after, earliest first (s106A), then the s104 pool at its average cost',
  };
  LO.SCOPES = ['pool', 'wallet', 'global'];
  LO.SCOPE_LABEL = { pool: 'Per pool', wallet: 'Per wallet', global: 'One pool for everything' };
  LO.SCOPE_TEXT = {
    pool: 'per pool: each margin pool of the perps subaccount (USD and every mPerp pool), the Predict wallet and the wallet outside Meridian keep their own lots',
    wallet: 'per wallet: the perps subaccount (all its pools together), the Predict wallet and the wallet outside Meridian keep their own lots',
    global: 'one pool: every unit, wherever it is held, in a single set of lots',
  };
  LO.READINGS = ['transfer', 'disposal'];
  LO.READING_LABEL = { transfer: 'Deposits as transfers', disposal: 'Wrapping as a disposal' };
  LO.READING_TEXT = {
    transfer: 'if deposits and withdrawals are transfers: units move in and out with their lots at no gain',
    disposal: 'if wrapping USDe into MeridianUSD (a deposit) and unwrapping it (a withdrawal) counts as a disposal plus an acquisition',
  };
  LO.VALUATIONS = ['par', 'market'];
  LO.VALUATION_LABEL = { par: 'At par: 1 USDe = 1 USD', market: 'At market: USDe/USD daily price' };
  LO.methodOf = (v) => (LO.METHODS.includes(v) ? v : null);
  LO.scopeOf = (v) => (LO.SCOPES.includes(v) ? v : null);
  // UK pooling as this page reads it: one s104 pool per person for each asset, not one per wallet or margin pool, so it
  // is offered with the one-pool scope only (a per-pool or per-wallet choice gives way to it)
  LO.SCOPES_FOR = { uk: ['global'] };
  LO.scopesFor = (method) => LO.SCOPES_FOR[method] || LO.SCOPES;
  /** The scope a method runs with: the one chosen when the method is offered with it, the method's only scope when it
   *  has one (UK pooling: one pool), else none (still to choose). */
  LO.scopeFor = (method, scope) => { const ok = LO.scopesFor(method); return ok.includes(scope) ? scope : ok.length === 1 ? ok[0] : null; };
  LO.SCOPE_NOTE = { uk: 'UK pooling runs with one pool for everything only: this page reads the s104 pool as one per person for each asset, not one per wallet or margin pool' };
  LO.readingOf = (v) => (LO.READINGS.includes(v) ? v : 'transfer');
  LO.valuationOf = (v) => (LO.VALUATIONS.includes(v) ? v : 'par');

  // ---------- where units are held ----------
  // 'out': the wallet's own USDe outside Meridian (what deposits draw on); 'pool:<token address>': a margin pool of the
  // perps subaccount (MeridianUSD; mPerp pools are internal balances of it); 'predict': the Predict wallet (USDe)
  LO.OUT = 'out'; LO.PREDICT = 'predict';
  LO.poolLoc = (addr) => 'pool:' + String(addr || '').toLowerCase();
  /** The set of lots a location's units belong to under a scope. */
  LO.keyOf = (scope, loc) => (scope === 'global' ? 'all' : scope === 'wallet' && /^pool:/.test(loc) ? 'perps' : loc);
  /** A location's or a scope key's name. names: {loc: pool name} (usdeEvents' names). */
  LO.keyLabel = (key, names) => {
    if (key === 'all') return 'All USDe (one pool)';
    if (key === 'perps') return 'Perps subaccount';
    if (key === LO.PREDICT) return 'Predict wallet';
    if (key === LO.OUT) return 'Wallet, outside Meridian';
    const n = names && names[key];
    return 'Perps · ' + (n || String(key).slice(5, 13)) + ' pool';
  };
  LO.KIND = {
    gain: 'realized gain', loss: 'realized loss', fee: 'trading fee', rebate: 'fee rebate', funding: 'funding', posfee: 'position fee',
    tfee: 'transfer fee', deposit: 'deposit (wraps USDe into MeridianUSD)', withdraw: 'withdrawal (unwraps MeridianUSD)', convert: 'conversion between pools',
    stake: 'Predict stake or collateral', payout: 'Predict payout', refund: 'Predict refund', sale: 'Predict token sale', buy: 'Predict token purchase',
    redeem: 'Predict tokens redeemed', set: 'Predict matched set redeemed', opening: 'opening lot (entered)', topup: 'from outside Meridian',
  };
  // what is spent on fees: the US fact line counts these apart
  const FEES = new Set(['fee', 'posfee', 'tfee']);

  // ---------- opening lots (entered by the reader) ----------
  /** A lot as entered: {at: 'out' | 'predict', date 'YYYY-MM-DD', units, cost, ccy}; null when it is not one. */
  LO.cleanLot = (x) => {
    if (!x || typeof x !== 'object') return null;
    const units = Number(x.units), cost = Number(x.cost);
    if (!T.periods.okDay(x.date) || !(units > 0) || !(cost >= 0) || !Number.isFinite(units) || !Number.isFinite(cost)) return null;
    return { at: x.at === LO.PREDICT ? LO.PREDICT : LO.OUT, date: x.date, units, cost, ccy: T.CCY.includes(x.ccy) ? x.ccy : 'USD' };
  };
  LO.lotText = (x) => `${x.at === LO.PREDICT ? 'Predict wallet' : 'outside Meridian'} ${x.date}: ${T.n6(x.units)} USDe, cost ${T.n6(x.cost)} ${x.ccy}`;
  /** An opening lot dated before the first published rate (usdeEvents' early), in words: its cost's other currency is at
   *  that first rate. ccy: the report currency. */
  LO.earlyText = (ccy) => (x) => LO.lotText(x) + ': dated before the first published rate, so its cost in ' + (x.ccy === 'USD' ? ccy : 'USD') + ' is at the first rate there is (' + x.rate + '), not at its own date\'s';

  // ---------- the events ----------
  /**
   * Every unit in and out, in time order, valued. o: {perps: {D (T.fills.disposals over the account's whole history),
   * ev (T.load.events), ref, dayRows (the daily balance rows, for funding when the charges could not be read)} or null;
   * cash (T.predict.cash of the Predict record) or null; opening (entered lots); tz; price(t) (USD per USDe: 1 at par);
   * money (T.fx.money); cutoff (ms: events before it)}.
   * Perps, in the pool of each market's quote token: the gross of every disposal fill (+ a gain, − a loss), every fill's
   * fee (−), funding settlements (±; each UTC day's net from the ledger when the charges could not be read), position-fee
   * settlements (−), transfer fees (−); deposits, withdrawals and conversions between pools as moves. Predict, in the
   * Predict wallet: placements (−), payouts and refunds this wallet claimed (+), token sales (+) and purchases (−), and
   * tokens redeemed (+). Opening lots at local midnight of their date, at their entered cost.
   * Returns {events [{t, dir 'in' | 'out' | 'move', loc | from / to, units, usd, c, px, kind, what, src, id, tx}], names
   * (pool names), skipped (lots entered in another currency than the report's), early (lots dated before the first
   * published rate: their cost's other currency at the first rate, {rate (its date)} added), check (per pool: the events'
   * net against the ledger's last balance), notes}.
   */
  LO.usdeEvents = (o) => {
    const tz = o.tz || 'UTC', money = o.money || T.fx.money(null, tz), price = o.price || (() => 1), cutoff = o.cutoff != null ? o.cutoff : Infinity;
    const events = [], names = {}, notes = [], skipped = [];
    let n = 0;
    const val = (units, t) => { const px = price(t); const usd = units * px; return { usd, c: money.fx(usd, t), px }; };
    const push = (e) => { if (!(e.t < cutoff) || !(e.units > DUST)) return; e.n = n++; events.push(e); };
    const flow = (t, loc, amount, kind, what, src, extra) => {
      if (!(Math.abs(amount) > DUST)) return;
      const units = Math.abs(amount);
      push(Object.assign({ t, dir: amount > 0 ? 'in' : 'out', loc, units, kind, what, src }, val(units, t), extra || {}));
    };
    const P = o.perps;
    if (P && P.D && P.ev) {
      const ref = P.ref || {}, D = P.D, ev = P.ev;
      const tokById = ref.tokenById || {};
      const toks = Object.values(tokById);
      for (const t of toks) if (t.address) names[LO.poolLoc(t.address)] = t.name;
      const main = toks.find((t) => t.depositEnabled) || null;
      const mainLoc = main ? LO.poolLoc(main.address) : 'pool:usd';
      if (!main) names[mainLoc] = 'USD';
      const poolOf = (pid) => { const p = ref.byId ? ref.byId[pid] : null; return p && p.quoteTokenAddress ? LO.poolLoc(p.quoteTokenAddress) : mainLoc; };
      const tokLoc = (id) => (tokById[id] && tokById[id].address ? LO.poolLoc(tokById[id].address) : mainLoc);
      const pos = new Map((ev.positions || []).map((p) => [p.id, p]));
      const tick = (pid) => { const p = ref.byId ? ref.byId[pid] : null; return p ? p.displayTicker : String(pid || '').slice(0, 8); };
      const posName = (pid) => { const p = pos.get(pid); return p ? tick(p.productId) + ' ' + (String(p.side) === '0' ? 'long' : 'short') : String(pid || '').slice(0, 8); };
      // every fill's fee, opening fills included (a negative fee is a rebate)
      for (const [pid, fs] of D.byPos || []) {
        const p = pos.get(pid); if (!p) continue;
        const loc = poolOf(p.productId);
        for (const f of fs) if (f.qty > 0 && f.fee) flow(f.t, loc, -f.fee, f.fee > 0 ? 'fee' : 'rebate', posName(pid) + ' fill', 'perps', { id: f.id || pid });
      }
      for (const f of D.unassigned || []) if (f.fee) flow(f.t, poolOf(f.productId), -f.fee, f.fee > 0 ? 'fee' : 'rebate', tick(f.productId) + ' fill (no position found)', 'perps', { id: f.id || '' });
      // the gross of every reduction, partial close, liquidation or auto-deleverage
      for (const r of D.rows || []) flow(r.t, poolOf(r.productId), r.gross, r.gross > 0 ? 'gain' : 'loss', `${r.ticker} ${r.long ? 'long' : 'short'} reduced${r.liq ? ' (liquidation)' : r.adl ? ' (auto-deleverage)' : ''}`, 'perps', { id: r.positionId });
      // funding: one amount per position per settlement; without the charges, each UTC day's net from the ledger
      const S = D.funding && D.funding.S;
      if (S) { for (const s of S.list) flow(s.t, poolOf(s.productId || (pos.get(s.positionId) || {}).productId), s.amount, 'funding', posName(s.positionId) + (s.amount > 0 ? ' funding received' : ' funding paid'), 'perps', { id: s.positionId }); }
      else {
        notes.push('The hourly funding charges could not be read: funding counts as each UTC day\'s net per pool, at 10:00 UTC.');
        for (const [tok, rows] of Object.entries(U.groupBy(P.dayRows || [], (r) => r.tokenId || r.tokenAddress || 'x'))) {
          rows.sort((a, b) => U.num(a.time) - U.num(b.time));
          let prev = 0;
          for (const r of rows) { const v = U.num(r.realizedFunding), d = v - prev; prev = v; flow(U.num(r.time) + 10 * HOUR, tokLoc(tok), d, 'funding', 'funding, daily net (settlement detail unavailable)', 'perps'); }
        }
      }
      // mPerp position fees, settled at a fill of the position; a day's residual no fill explains, at 10:00 UTC
      const F = D.fees || {};
      for (const s of F.list || []) flow(s.t, poolOf(s.productId || (pos.get(s.positionId) || {}).productId), -s.amount, 'posfee', posName(s.positionId) + ' position fee', 'perps', { id: s.positionId });
      for (const b of F.unmatched || []) flow(b.t1 - b.t0 >= DAY ? b.t0 + 10 * HOUR : b.t0, tokLoc(b.tokenId), -b.amount, 'posfee', 'position fees not matched to a fill', 'perps');
      // transfers: a deposit wraps USDe into MeridianUSD (its fee comes out of the pool), a withdrawal unwraps it (its fee
      // on top), a conversion moves margin between pools 1:1
      for (const x of ev.transfers || []) {
        const st = String(x.status || 'COMPLETED').toUpperCase(); if (st !== 'COMPLETED') continue;
        const type = String(x.type || '').toUpperCase(), t = U.num(x.createdAt), amt = U.num(x.amount), fee = U.num(x.fee);
        const from = LO.poolLoc(x.tokenAddress), tx = x.finalizedTransactionHash || x.initiatedTransactionHash || '';
        if (x.tokenName && x.tokenAddress) names[from] = names[from] || x.tokenName;
        const mv = (a, b, kind, what) => { if (amt > DUST) push(Object.assign({ t, dir: 'move', from: a, to: b, units: amt, kind, what, src: 'perps', id: x.id, tx }, val(amt, t))); };
        if (/DEPOSIT/.test(type)) mv(LO.OUT, from, 'deposit', 'deposit of ' + T.n6(amt) + ' USDe');
        else if (/WITHDRAW/.test(type)) mv(from, LO.OUT, 'withdraw', 'withdrawal of ' + T.n6(amt) + ' USDe');
        else if (x.toTokenAddress) { const to = LO.poolLoc(x.toTokenAddress); if (x.toTokenName) names[to] = names[to] || x.toTokenName; mv(from, to, 'convert', (x.tokenName || '?') + ' → ' + (x.toTokenName || '?')); }
        if (fee > DUST) flow(t, from, -fee, 'tfee', (/WITHDRAW/.test(type) ? 'withdrawal' : /DEPOSIT/.test(type) ? 'deposit' : 'conversion') + ' fee', 'perps', { id: x.id, tx });
      }
    }
    // Meridian Predict: the wallet's own USDe
    for (const x of o.cash || []) flow(x.t, LO.PREDICT, x.amount, x.kind, x.what || LO.KIND[x.kind] || x.kind, 'predict', { id: x.id || '', tx: x.tx || '' });
    // opening lots: at their entered cost, from local midnight of their date
    const early = [];
    for (const raw of o.opening || []) {
      const x = LO.cleanLot(raw); if (!x) continue;
      const t = TZ.midnight(tz, +x.date.slice(0, 4), +x.date.slice(5, 7) - 1, +x.date.slice(8, 10));
      if (x.ccy !== money.ccy && x.ccy !== 'USD') { skipped.push(x); continue; }
      // a lot dated before the first published rate has none on its own date: the cost's other currency then takes the
      // first rate there is, and the lot is named (early) wherever the lots are shown, never silently
      let k = money.rates ? money.rate(t) : 1;
      if (k == null) { k = money.rates.first.r; early.push(Object.assign({ rate: money.rates.first.label }, x)); }
      const usd = x.ccy === money.ccy ? x.cost / k : x.cost, c = x.ccy === money.ccy ? x.cost : x.cost * k;
      push({ t, dir: 'in', loc: x.at, units: x.units, usd, c, px: x.units ? usd / x.units : 1, kind: 'opening', what: LO.lotText(x), src: 'entered' });
    }
    events.sort(LO.order);
    // each pool's events against the ledger's balance of it: the newest row (the level now) when the events run to now,
    // else the row of the last whole UTC day before the cutoff, against the events before that day's end
    const check = [];
    if (P && P.dayRows && P.dayRows.length) {
      const now = o.now != null ? o.now : Date.now(), live = !(cutoff < now - 10 * 60000);
      const until = live ? Infinity : Math.floor(cutoff / DAY) * DAY;
      const net = new Map(); const add = (l, v) => net.set(l, (net.get(l) || 0) + v);
      for (const e of events) { if (!(e.t < until)) break; if (e.dir === 'move') { add(e.from, -e.units); add(e.to, e.units); } else if (e.loc !== LO.PREDICT && e.loc !== LO.OUT) add(e.loc, e.dir === 'in' ? e.units : -e.units); }
      const last = new Map();
      for (const r of P.dayRows) {
        const tm = U.num(r.time); if (!live && tm + DAY > until) continue;
        const tok = (P.ref && P.ref.tokenById && P.ref.tokenById[r.tokenId]) || null; const l = tok ? LO.poolLoc(tok.address) : null; if (!l) continue;
        const x = last.get(l); if (!x || tm >= x.t) last.set(l, { t: tm, v: U.num(r.balance) });
      }
      for (const [l, x] of last) check.push({ loc: l, name: names[l] || l, events: net.get(l) || 0, ledger: x.v, diff: (net.get(l) || 0) - x.v, at: live ? null : until });
    }
    return { events, names, skipped, early, check, notes };
  };
  const DIR = { in: 0, move: 1, out: 2 };
  /** Time order; at one instant what comes in first, then moves, then what goes out (a fill's gain pays its fee). */
  LO.order = (a, b) => a.t - b.t || DIR[a.dir] - DIR[b.dir] || (a.n || 0) - (b.n || 0);

  // ---------- readings and scopes: the flows as acquisitions, disposals and moves of lots ----------
  /**
   * The events under a scope and a deposit reading, as what the lot methods work on: [{op 'acq' | 'disp' | 'mv', key
   * (scope key; a move: from / to), t, units, usd, c, ev, uncovered}]. Units are counted per location: a move or a
   * spend that a location does not hold enough units for draws the rest from outside Meridian ('out', where the opening
   * lots sit), and what that does not cover enters at its value at that moment (uncovered: its cost is not known here).
   * A deposit or withdrawal is a move of lots ('transfer') or a disposal plus an acquisition at its value ('disposal'); a
   * conversion between pools is a move of lots under both readings and in every scope (no token moves on chain: the
   * pools are internal balances of the same MeridianUSD), so its lots keep their dates and cost and it is nothing where
   * both pools share a scope key; drawing on outside USDe for the Predict wallet is always a move (the same token).
   */
  LO.expand = (events, o) => {
    const scope = o.scope || 'global', reading = LO.readingOf(o.reading);
    const held = new Map(); const get = (l) => held.get(l) || 0; const add = (l, u) => held.set(l, get(l) + u);
    const K = (loc) => LO.keyOf(scope, loc);
    const ops = [];
    const part = (ev, u) => ({ usd: ev.units ? ev.usd * u / ev.units : 0, c: ev.units ? ev.c * u / ev.units : 0 });
    const move = (ev, how) => {
      const covered = Math.min(ev.units, Math.max(0, get(ev.from))), unc = ev.units - covered;
      add(ev.from, -covered); add(ev.to, ev.units);
      const kf = K(ev.from), kt = K(ev.to);
      if (covered > EPS) {
        // only wrapping read as a disposal disposes and acquires; a transfer or a conversion moves the lots as they are
        if (how === 'wrap') { ops.push(Object.assign({ op: 'disp', key: kf, t: ev.t, units: covered, ev, leg: 'out' }, part(ev, covered))); ops.push(Object.assign({ op: 'acq', key: kt, t: ev.t, units: covered, ev, leg: 'in' }, part(ev, covered))); }
        else if (kf !== kt) ops.push(Object.assign({ op: 'mv', from: kf, to: kt, t: ev.t, units: covered, ev }, part(ev, covered)));
      }
      if (unc > DUST) ops.push(Object.assign({ op: 'acq', key: kt, t: ev.t, units: unc, ev, uncovered: true }, part(ev, unc)));
    };
    for (const ev of events) {
      if (ev.dir === 'in') { add(ev.loc, ev.units); ops.push({ op: 'acq', key: K(ev.loc), t: ev.t, units: ev.units, usd: ev.usd, c: ev.c, ev }); continue; }
      if (ev.dir === 'out') {
        const short = ev.units - Math.max(0, get(ev.loc));
        if (short > DUST && ev.loc !== LO.OUT) move(Object.assign({ t: ev.t, dir: 'move', from: LO.OUT, to: ev.loc, units: short, kind: 'topup', what: 'drawn from outside Meridian', src: ev.src }, part(ev, short)), 'transfer');
        add(ev.loc, -ev.units);
        ops.push({ op: 'disp', key: K(ev.loc), t: ev.t, units: ev.units, usd: ev.usd, c: ev.c, ev });
        continue;
      }
      move(ev, ev.kind === 'convert' || ev.kind === 'topup' || reading === 'transfer' ? 'transfer' : 'wrap');
    }
    return ops;
  };

  // ---------- the methods ----------
  // A binary heap: the lot a method takes next on top (FIFO: the earliest acquired; LIFO: the latest), O(log n) a step,
  // so lots moved in with older dates (a deposit of opening lots) find their place without a sort
  function Heap(before) { this.a = []; this.before = before; }
  Heap.prototype.push = function (x) { const a = this.a; a.push(x); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (!this.before(a[i], a[p])) break; const s = a[i]; a[i] = a[p]; a[p] = s; i = p; } };
  Heap.prototype.top = function () { return this.a[0]; };
  Heap.prototype.pop = function () {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && this.before(a[l], a[m])) m = l; if (r < a.length && this.before(a[r], a[m])) m = r; if (m === i) break; const s = a[i]; a[i] = a[m]; a[m] = s; i = m; }
    }
    return top;
  };
  const EARLIEST = (x, y) => x.acqT < y.acqT || (x.acqT === y.acqT && x.seq < y.seq);
  const LATEST = (x, y) => x.acqT > y.acqT || (x.acqT === y.acqT && x.seq > y.seq);
  let SEQ = 0;
  /** Takes up to `units` from a heap of lots, the top first: pieces [{acqT, units, usd, c}]. */
  const takeHeap = (heap, units) => {
    const out = []; let need = units;
    while (need > EPS && heap.a.length) {
      const l = heap.top(), q = Math.min(l.units, need), f = q / l.units;
      out.push({ acqT: l.acqT, units: q, usd: l.usd * f, c: l.c * f });
      if (l.units - q <= EPS) heap.pop(); else { l.units -= q; l.usd -= l.usd * f; l.c -= l.c * f; }
      need -= q;
    }
    return out;
  };
  const METHODS = {
    // FIFO and LIFO: one heap of lots per scope key
    fifo: { pool: () => ({ heap: new Heap(EARLIEST) }), add: (p, x) => p.heap.push(Object.assign({ seq: SEQ++ }, x)), take: (p, u) => takeHeap(p.heap, u), rule: 'FIFO' },
    lifo: { pool: () => ({ heap: new Heap(LATEST) }), add: (p, x) => p.heap.push(Object.assign({ seq: SEQ++ }, x)), take: (p, u) => takeHeap(p.heap, u), rule: 'LIFO' },
    // a moving average: the pool's cost per unit sets every disposal's cost; the acquisition dates (first in, first out)
    // only give the holding period
    average: {
      pool: () => ({ units: 0, usd: 0, c: 0, dates: new Heap(EARLIEST) }),
      add: (p, x) => { p.units += x.units; p.usd += x.usd; p.c += x.c; p.dates.push({ acqT: x.acqT, units: x.units, usd: 0, c: 0, seq: SEQ++ }); },
      take: (p, u) => {
        const q = Math.min(u, p.units); if (!(q > EPS)) return [];
        const f = q / p.units, usd = p.usd * f, c = p.c * f;
        p.units -= q; p.usd -= usd; p.c -= c; if (p.units <= EPS) { p.units = 0; p.usd = 0; p.c = 0; }
        const ds = takeHeap(p.dates, q), sum = U.sum(ds, (d) => d.units) || q;
        return ds.length ? ds.map((d) => ({ acqT: d.acqT, units: d.units, usd: usd * d.units / sum, c: c * d.units / sum })) : [{ acqT: null, units: q, usd, c }];
      },
      rule: 'average',
    },
    // the UK's s104 pool (what the same-day and 30-day rules leave): one average cost, no dates
    uk: {
      pool: () => ({ units: 0, usd: 0, c: 0 }),
      add: (p, x) => { p.units += x.units; p.usd += x.usd; p.c += x.c; },
      take: (p, u) => {
        const q = Math.min(u, p.units); if (!(q > EPS)) return [];
        const f = q / p.units, usd = p.usd * f, c = p.c * f;
        p.units -= q; p.usd -= usd; p.c -= c; if (p.units <= EPS) { p.units = 0; p.usd = 0; p.c = 0; }
        return [{ acqT: null, units: q, usd, c, rule: 's104 pool' }];
      },
      rule: 's104 pool',
    },
  };

  /**
   * The UK matching before the pool, per scope key and local day (UK pooling runs with one pool only, so there are no
   * moves between keys; a move would be neither an acquisition nor a disposal): a
   * day's acquisitions and disposals are each one (s105) and match each other first, at the day's average acquisition
   * cost; what a day still disposes of then matches the acquisitions of the next 30 days (s106A), the earliest disposal
   * first and, for each, the earliest acquisition first (one pointer per key, never a rescan); the rest goes to and from
   * the s104 pool. Each op gets its share: an acquisition the part of it that enters the pool, a disposal its day.
   */
  const ukPlan = (ops, tz) => {
    const byKey = new Map();
    for (const op of ops) {
      if (op.op === 'mv') continue;
      const day = TZ.dayKey(op.t, tz);
      let K = byKey.get(op.key); if (!K) byKey.set(op.key, (K = new Map()));
      let d = K.get(day); if (!d) K.set(day, (d = { day, aU: 0, aUsd: 0, aC: 0, dU: 0, t0: op.t, acq: [], disp: [] }));
      if (op.op === 'acq') { d.aU += op.units; d.aUsd += op.usd; d.aC += op.c; d.acq.push(op); } else { d.dU += op.units; d.disp.push(op); }
    }
    for (const K of byKey.values()) {
      const days = Array.from(K.values()).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
      for (const d of days) { d.same = Math.min(d.aU, d.dU); d.aLeft = d.aU - d.same; d.dLeft = d.dU - d.same; d.thirty = []; d.acqT = d.acq.length ? d.acq[0].t : d.t0; }
      const acqDays = days.filter((d) => d.aLeft > EPS);
      let j = 0;
      for (const d of days) {
        if (!(d.dLeft > EPS)) continue;
        const last = TZ.addDays(d.day, 30);
        while (j < acqDays.length && (acqDays[j].day <= d.day || acqDays[j].aLeft <= EPS)) j++;
        for (let k = j; k < acqDays.length && acqDays[k].day <= last && d.dLeft > EPS; k++) {
          const a = acqDays[k]; if (a.aLeft <= EPS) continue;
          const x = Math.min(a.aLeft, d.dLeft);
          d.thirty.push({ acqT: a.acqT, units: x, usd: a.aUsd * x / a.aU, c: a.aC * x / a.aU });
          a.aLeft -= x; d.dLeft -= x;
        }
      }
      for (const d of days) {
        for (const op of d.acq) op.uk = { pool: d.aU > EPS ? Math.max(0, d.aLeft) / d.aU : 0 };
        for (const op of d.disp) op.uk = { f: d.dU > EPS ? op.units / d.dU : 0, d };
      }
    }
  };

  const daysBetween = (a, b, tz) => Math.round((TZ.keyMs(TZ.dayKey(b, tz)) - TZ.keyMs(TZ.dayKey(a, tz))) / DAY);

  /**
   * The lots. events: usdeEvents' list; o: {method, scope, reading, tz, cutoff (ms: the data's end; a UK disposal whose
   * 30 days run past it is provisional), at ([instants]: the pools are noted as they stand there)}.
   * Returns {method, scope, reading, disposals [{t, key, loc, kind, what, src, units, proceedsUsd, proceedsC, costUsd,
   * costC, gainUsd, gainC, rule, pieces [{acqT, units, usd, c, days, overYear, rule}], short (units no lot covered: cost
   * = proceeds), provisional, leg, ev}], pools (at the end: [{key, units, usd, c}]), at ([{t, pools}]), uncovered {n,
   * units} (acquired at their value for want of a lot: deposits and spending not covered by opening lots), short {n,
   * units}}. Every step is a heap operation or a pointer move: n log n at most.
   */
  LO.run = (events, o) => {
    // UK pooling runs with one pool only (LO.scopeFor): its same-day and 30-day matches never compete with moves
    const method = LO.methodOf(o.method) || 'fifo', scope = LO.scopeFor(method, LO.scopeOf(o.scope)) || 'global', tz = o.tz || 'UTC';
    const M = METHODS[method];
    const ops = LO.expand(events, { scope, reading: o.reading });
    if (method === 'uk') ukPlan(ops, tz);
    const cut = o.cutoff != null ? TZ.dayKey(o.cutoff - 1, tz) : null;
    const pools = new Map(), tot = new Map();
    const poolOf = (k) => { let p = pools.get(k); if (!p) { pools.set(k, (p = M.pool())); tot.set(k, { key: k, units: 0, usd: 0, c: 0 }); } return p; };
    const bump = (k, u, usd, c) => { const x = tot.get(k); x.units += u; x.usd += usd; x.c += c; };
    const add = (k, x) => { const p = poolOf(k); M.add(p, x); bump(k, x.units, x.usd, x.c); };
    const take = (k, u) => { const p = poolOf(k); const ps = M.take(p, u); for (const x of ps) bump(k, -x.units, -x.usd, -x.c); return ps; };
    const at = (o.at || []).slice().sort((a, b) => a - b), snaps = []; let ai = 0;
    const snap = (t) => ({ t, pools: Array.from(tot.values()).map((x) => Object.assign({}, x)) });
    const disposals = [], uncovered = { n: 0, units: 0 }, short = { n: 0, units: 0 };
    for (const op of ops) {
      while (ai < at.length && op.t >= at[ai]) snaps.push(snap(at[ai++]));
      if (op.uncovered) { uncovered.n++; uncovered.units += op.units; }
      if (op.op === 'acq') {
        const f = method === 'uk' ? op.uk.pool : 1;
        if (f > EPS) add(op.key, { acqT: op.t, units: op.units * f, usd: op.usd * f, c: op.c * f });
        else poolOf(op.key);
        continue;
      }
      if (op.op === 'mv') {
        const ps = take(op.from, op.units);
        for (const x of ps) add(op.to, { acqT: x.acqT != null ? x.acqT : op.t, units: x.units, usd: x.usd, c: x.c });
        const got = U.sum(ps, (x) => x.units);
        // the scope key held fewer units than its location: the rest arrives at its value
        if (op.units - got > DUST) { const u = op.units - got; add(op.to, { acqT: op.t, units: u, usd: op.usd * u / op.units, c: op.c * u / op.units }); short.n++; short.units += u; }
        continue;
      }
      // a disposal
      let pieces = [];
      let left = op.units;
      if (method === 'uk') {
        const { f, d } = op.uk;
        if (d.same > EPS) { const u = f * d.same; pieces.push({ acqT: d.acqT, units: u, usd: d.aUsd * u / d.aU, c: d.aC * u / d.aU, rule: 'same day' }); left -= u; }
        for (const x of d.thirty) { pieces.push({ acqT: x.acqT, units: x.units * f, usd: x.usd * f, c: x.c * f, rule: '30 days' }); left -= x.units * f; }
      }
      if (left > EPS) { const ps = take(op.key, left); for (const x of ps) { pieces.push(Object.assign({ rule: M.rule }, x)); left -= x.units; } }
      let shortU = 0;
      if (left > DUST) { shortU = left; pieces.push({ acqT: null, units: left, usd: op.usd * left / op.units, c: op.c * left / op.units, rule: 'not covered' }); short.n++; short.units += left; }
      for (const x of pieces) {
        if (x.acqT != null) { x.days = daysBetween(x.acqT, op.t, tz); x.overYear = x.acqT <= op.t && TZ.heldOverYear(x.acqT, op.t, tz); }
        else { x.days = null; x.overYear = false; }
      }
      const costUsd = U.sum(pieces, (x) => x.usd), costC = U.sum(pieces, (x) => x.c);
      const rules = Array.from(new Set(pieces.map((x) => x.rule)));
      disposals.push({
        t: op.t, key: op.key, loc: op.ev.loc || (op.leg === 'out' ? op.ev.from : op.ev.to), kind: op.ev.kind, what: op.ev.what, src: op.ev.src, units: op.units,
        proceedsUsd: op.usd, proceedsC: op.c, costUsd, costC, gainUsd: op.usd - costUsd, gainC: op.c - costC,
        rule: rules.join(' + '), pieces, short: shortU, leg: op.leg || null, ev: op.ev,
        // a disposal the same day's acquisitions cover whole cannot change; any other part can, until its 30 days are over
        provisional: method === 'uk' && cut != null && op.uk.d.dU - op.uk.d.same > EPS && TZ.addDays(op.uk.d.day, 30) > cut,
      });
    }
    while (ai < at.length) snaps.push(snap(at[ai++]));
    return { method, scope, reading: LO.readingOf(o.reading), tz, disposals, pools: Array.from(tot.values()), at: snaps, uncovered, short, ops: ops.length };
  };

  // ---------- figures ----------
  const blank = () => ({ n: 0, fees: 0, proceedsUsd: 0, costUsd: 0, gainsUsd: 0, lossesUsd: 0, netUsd: 0, proceedsC: 0, costC: 0, gainsC: 0, lossesC: 0, netC: 0, units: 0 });
  const addTo = (x, d) => {
    x.n++; if (FEES.has(d.kind)) x.fees++; x.units += d.units;
    x.proceedsUsd += d.proceedsUsd; x.costUsd += d.costUsd; x.netUsd += d.gainUsd; if (d.gainUsd > 0) x.gainsUsd += d.gainUsd; else x.lossesUsd += d.gainUsd;
    x.proceedsC += d.proceedsC; x.costC += d.costC; x.netC += d.gainC; if (d.gainC > 0) x.gainsC += d.gainC; else x.lossesC += d.gainC;
    return x;
  };
  /** The disposals in [a, b): {n, fees, units, proceeds, cost, gains (sum of the positive), losses (of the negative),
   *  net, each in USD and the report currency (…Usd, …C)}. */
  LO.totals = (disposals, a, b) => { const x = blank(); for (const d of disposals) if (d.t >= a && d.t < b) addTo(x, d); return x; };
  /** The fiscal year (its start year under the preset, in local dates) of an instant. */
  LO.yearOf = (t, preset, tz) => { const PER = T.periods; let y = TZ.parts(t, tz).y; if (t < PER.fyStart(preset, y, tz)) y--; else if (t >= PER.fyStart(preset, y + 1, tz)) y++; return y; };
  /** Per fiscal year and scope key, newest year first, each year's keys in name order: [{year, label, key, …totals}]. */
  LO.byYear = (disposals, { preset = 'cal', tz = 'UTC', names } = {}) => {
    const m = new Map(), memo = new Map();
    for (const d of disposals) {
      const dk = TZ.dayKey(d.t, tz); let y = memo.get(dk); if (y == null) { y = LO.yearOf(d.t, preset, tz); memo.set(dk, y); }
      const k = y + '|' + d.key; let x = m.get(k);
      if (!x) m.set(k, (x = Object.assign({ year: y, label: T.periods.fyLabel(preset, y), key: d.key, scope: LO.keyLabel(d.key, names) }, blank())));
      addTo(x, d);
    }
    return Array.from(m.values()).sort((a, b) => b.year - a.year || (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0));
  };
  /** The US fact: was any USDe disposed of in [a, b), and how (fee payments apart; deposits and withdrawals counted on
   *  their own: they are disposals only if wrapping counts as one). */
  LO.facts = (events, a, b) => {
    const o = { fees: 0, other: 0, wraps: 0, any: false };
    for (const e of events) {
      if (!(e.t >= a && e.t < b)) continue;
      if (e.dir === 'move') { if (e.kind === 'deposit' || e.kind === 'withdraw') o.wraps++; continue; }
      if (e.dir !== 'out') continue;
      if (FEES.has(e.kind)) o.fees++; else o.other++;
    }
    o.any = o.fees + o.other > 0;
    return o;
  };
  LO.FACT_KEY = 'USDe disposed of in the period';
  /** The fact without its key (a file's value cell): 'yes (N fee payments, M other)' or 'no', and the deposits and
   *  withdrawals apart. */
  LO.factValue = (f) => (f.any ? `yes (${U.fmtNum(f.fees, 0)} fee payment${f.fees === 1 ? '' : 's'}, ${U.fmtNum(f.other, 0)} other)` : 'no')
    + (f.wraps ? `; plus ${U.fmtNum(f.wraps, 0)} deposit${f.wraps === 1 ? '' : 's'} or withdrawal${f.wraps === 1 ? '' : 's'}, a disposal only if wrapping USDe into MeridianUSD counts as one` : '');
  LO.factText = (f) => LO.FACT_KEY + ': ' + LO.factValue(f);
  /** The fact as a file's [key, value] row (the lots' methodology, the summary): what the US Form 1040 digital-asset
   *  question asks about, stated as a fact of the data, never as the answer. */
  LO.FACT_ROW_KEY = LO.FACT_KEY + ' (Meridian activity only; a fact, not an answer to the US Form 1040 digital-asset question)';
  LO.factRow = (f) => [LO.FACT_ROW_KEY, LO.factValue(f)];

  // ---------- methodology and files (pure: the card downloads them through MD.tax.exports) ----------
  /**
   * The record of how the lots were built, as [key, value] rows (the files' first rows, the card's notes). ctx: {res
   * (the run shown), events (usdeEvents': the period's fact line), period, tz, money, addr, sid, pw (the Predict wallet),
   * valuation {kind, name, rule, fetchedAt}, opening (entered lots), skipped, cutoff, dataNotes, now}.
   */
  LO.describe = (ctx) => {
    const r = ctx.res, P = ctx.period, tz = ctx.tz || P.tz, v = ctx.valuation || { kind: 'par' };
    const lots = (ctx.opening || []).map(LO.cleanLot).filter(Boolean);
    const rows = [
      ['Report', 'USDe lots: Meridian activity and the opening lots entered on the page'],
      ['Disclaimer', T.DISCLAIMER],
      ['Wallet', ctx.addr || ''], ...(ctx.sid ? [['Subaccount', ctx.sid]] : []), ...(ctx.pw ? [['Predict wallet', ctx.pw]] : []),
      ['Period', P.startText + ' → ' + P.endText], ['Time zone', tz],
      // the fact line heads both lots files (deposits and withdrawals counted apart: a disposal only under one reading)
      ...(ctx.events ? [LO.factRow(LO.facts(ctx.events, P.start, P.end))] : []),
      // the page's own currency row assumes par; here the Valuation row below says what USDe is worth
      ...ctx.money.describe().map(([k, x]) => (k === 'Report currency' ? [k, ctx.money.ccy + ' (USDe valued as in the Valuation row, then converted)'] : [k, x])),
      ['Lot method', LO.METHOD_TEXT[r.method]], ['Scope', LO.SCOPE_TEXT[r.scope] + (LO.SCOPE_NOTE[r.method] ? ' (' + LO.SCOPE_NOTE[r.method] + ')' : '')],
      ['Deposits and withdrawals', 'this file: ' + LO.READING_TEXT[r.reading] + '; the other reading (' + LO.READING_TEXT[r.reading === 'transfer' ? 'disposal' : 'transfer'] + ') is computed beside it on the page; neither is marked as the one that applies'],
      ['Conversions between pools', 'read as a move, never a disposal, under both readings: a conversion moves no token on chain (the pools are internal balances of the same MeridianUSD), so its units keep their lots, acquisition dates and cost (in the per-pool scope they move to the other pool; in the other scopes both pools share one set of lots)'],
      ['Valuation', v.kind === 'market' ? `${v.name}: ${v.rule}` + (v.fetchedAt ? ` (read ${v.fetchedAt})` : '') + ', then converted at the report currency\'s rate of the local date' : '1 USDe = 1 USD (par), then converted at the report currency\'s rate of the local date'],
      ['Opening lots', lots.length ? lots.map(LO.lotText).join('; ') : 'none entered'],
      ...(ctx.skipped && ctx.skipped.length ? [['Opening lots not used', ctx.skipped.map(LO.lotText).join('; ') + ' (entered in another currency than this report\'s)']] : []),
      ...(ctx.early && ctx.early.length ? [['Opening lots before the first rate', ctx.early.map(LO.earlyText(ctx.money.ccy)).join('; ')]] : []),
      ['Not covered by a lot', r.uncovered.n ? `${U.fmtNum(r.uncovered.n, 0)} arrival(s), ${T.n6(r.uncovered.units)} units, entered at their value at that moment (no opening lot covered them: what they cost is not known here)` : 'none'],
      ...(r.short.n ? [['Disposals without lots', `${U.fmtNum(r.short.n, 0)}, ${T.n6(r.short.units)} units: the lots of their scope held fewer units than its flows put there (a gap in the matching, not in the data); cost taken as their value at that moment`]] : []),
      ...(r.method === 'uk' ? [['UK 30-day rule', 'events read to ' + (ctx.cutoff ? TZ.fmt(ctx.cutoff, tz, 'datetime') + ' ' + tz : '?') + (ctx.res.disposals.some((d) => d.provisional) ? '; disposals whose 30 days run past that can still match later acquisitions (marked provisional)' : '; every 30-day window is complete')]] : []),
      ['Scope of the data', 'this wallet\'s Meridian perps subaccount (fills, funding and position-fee settlements, transfers) from its first event, and its Predict wallet; USDe held or spent elsewhere is not seen'],
      ...(ctx.dataNotes || []).map((t) => ['Completeness', t]),
      ['Generated (UTC)', new Date(ctx.now != null ? ctx.now : Date.now()).toISOString().replace('T', ' ').slice(0, 19)], ['Site version', T.VERSION],
    ];
    return rows;
  };

  const iso = (t) => (t == null ? '' : new Date(U.num(t)).toISOString().replace('T', ' ').slice(0, 19) + ' UTC');
  const loc = (tz, name, get) => (tz === 'UTC' ? [] : [[name + ' (' + tz + ')', (r) => { const t = get(r); return t == null ? '' : TZ.fmt(t, tz, 'iso'); }]]);
  const yn = (b) => (b ? 'yes' : 'no');
  const acquired = (d, tz) => { const ds = Array.from(new Set(d.pieces.filter((x) => x.acqT != null).map((x) => TZ.dayKey(x.acqT, tz)))); return ds.length === 1 ? ds[0] : ds.length ? 'VARIOUS' : ''; };
  const heldDays = (d) => { const ds = d.pieces.filter((x) => x.days != null).map((x) => x.days); if (!ds.length) return ''; const a = Math.min(...ds), b = Math.max(...ds); return a === b ? String(a) : a + ' to ' + b; };
  const overYear = (d) => { const p = d.pieces.filter((x) => x.acqT != null); if (!p.length) return ''; const n = p.filter((x) => x.overYear).length; return n === p.length ? 'yes' : n ? 'part' : 'no'; };
  /** a reading's name in a file */
  const readingCell = (r) => LO.READING_LABEL[r.reading];

  /**
   * 'USDe disposals (lots)': the period's disposals under the reading shown (one row each, with the rule and the dates
   * of what it was matched with), the pieces they were matched with, the totals per fiscal year and scope under both
   * readings, and the pools at the period's end. ctx: {res, alt (the other reading's run), period, tz, money, fname,
   * names, preset}.
   */
  LO.disposalsFile = (ctx) => {
    const { res, alt, period, tz, money } = ctx, n6 = T.n6, C = money.rates ? money.ccy : null, names = ctx.names || {};
    const inP = res.disposals.filter((d) => d.t >= period.start && d.t < period.end);
    const cc = (name, get) => (C ? [[name + ' ' + C, (r) => n6(get(r))]] : []);
    const rate = C ? [['USD→' + C + ' rate at the disposal', (r) => T.fx.rateCell(money.rate(r.t))], [money.rates.src.dateHead + ' at the disposal', (r) => money.rates.on(r.t, tz).label]] : [];
    const disp = {
      title: 'Disposals in the period (' + LO.READING_LABEL[res.reading].toLowerCase() + ')',
      columns: [
        ['Time (UTC)', (r) => iso(r.t)], ...loc(tz, 'Time', (r) => r.t), ['Scope', (r) => LO.keyLabel(r.key, names)], ['Held at', (r) => LO.keyLabel(r.loc, names)],
        ['Kind', (r) => LO.KIND[r.kind] || r.kind], ['What', (r) => r.what || ''], ['Units (USDe)', (r) => n6(r.units)],
        ['Proceeds USD', (r) => n6(r.proceedsUsd)], ['Cost USD', (r) => n6(r.costUsd)], ['Gain or loss USD', (r) => n6(r.gainUsd)],
        ...cc('Proceeds', (r) => r.proceedsC), ...cc('Cost', (r) => r.costC), ...cc('Gain or loss', (r) => r.gainC), ...rate,
        ['Matched by', (r) => r.rule], [`Acquired (${tz})`, (r) => acquired(r, tz)], ['Holding days (negative: acquired after, under the 30-day rule)', (r) => heldDays(r)], [`Held over a year (calendar dates, ${tz})`, (r) => overYear(r)],
        ['Units without a lot (cost = value)', (r) => (r.short ? n6(r.short) : '')], ...(res.method === 'uk' ? [['Provisional (30 days not over)', (r) => yn(r.provisional)]] : []),
        ['Deposits and withdrawals', () => readingCell(res)], ['ID', (r) => (r.ev && r.ev.id) || ''], ['Tx', (r) => (r.ev && r.ev.tx) || ''],
      ],
      rows: inP,
    };
    const pieces = [];
    inP.forEach((d, i) => d.pieces.forEach((x) => pieces.push({ i: i + 1, d, x })));
    const pc = {
      title: 'Matched pieces',
      columns: [['Disposal no.', (r) => r.i], ['Disposal time (UTC)', (r) => iso(r.d.t)], ['Scope', (r) => LO.keyLabel(r.d.key, names)], ['Rule', (r) => r.x.rule],
        ['Acquired (UTC)', (r) => iso(r.x.acqT)], ...loc(tz, 'Acquired', (r) => r.x.acqT), ['Units', (r) => n6(r.x.units)], ['Cost USD', (r) => n6(r.x.usd)], ...cc('Cost', (r) => r.x.c),
        ['Holding days (negative: acquired after)', (r) => (r.x.days == null ? '' : r.x.days)], ['Held over a year', (r) => (r.x.acqT == null ? '' : yn(r.x.overYear))]],
      rows: pieces,
    };
    const yrs = [];
    for (const [r, which] of [[res, true], [alt, false]]) if (r) for (const y of LO.byYear(r.disposals, { preset: ctx.preset || period.preset, tz, names })) yrs.push(Object.assign({ reading: LO.READING_LABEL[r.reading], shown: which }, y));
    const yr = {
      title: 'Per fiscal year and scope, both readings (every year of the data)',
      columns: [['Deposits and withdrawals', (r) => r.reading], ['Year', (r) => r.label], ['Scope', (r) => r.scope], ['Disposals', (r) => r.n], ['of which fee payments', (r) => r.fees],
        ['Proceeds USD', (r) => n6(r.proceedsUsd)], ['Cost USD', (r) => n6(r.costUsd)], ['Gains USD', (r) => n6(r.gainsUsd)], ['Losses USD', (r) => n6(r.lossesUsd)], ['Net USD', (r) => n6(r.netUsd)],
        ...cc('Proceeds', (r) => r.proceedsC), ...cc('Cost', (r) => r.costC), ...cc('Gains', (r) => r.gainsC), ...cc('Losses', (r) => r.lossesC), ...cc('Net', (r) => r.netC)],
      rows: yrs,
    };
    const end = res.at.find((s) => s.t === period.end);
    const pools = {
      title: 'Pools at the period end (' + LO.READING_LABEL[res.reading].toLowerCase() + ')',
      columns: [['Scope', (r) => LO.keyLabel(r.key, names)], ['Units', (r) => n6(r.units)], ['Cost USD', (r) => n6(r.usd)], ...cc('Cost', (r) => r.c)],
      rows: end ? end.pools.filter((p) => Math.abs(p.units) > DUST) : [],
    };
    const warnings = (ctx.warnings || []).slice();
    return { name: ctx.fname('usde-lots-' + res.method + '-' + res.scope + (res.reading === 'transfer' ? '' : '-wrap-disposal')), sections: [disp, pc, yr, pools], warnings };
  };

  /**
   * 'USDe flows': every unit in and out, and every move between where it is held, from the account's first event to the
   * period's end, each with its value at its own date, for tools that keep a whole portfolio. ctx: {events, period, tz,
   * money, fname, names, valuation}.
   */
  LO.flowsFile = (ctx) => {
    const { period, tz, money } = ctx, n6 = T.n6, names = ctx.names || {};
    const rows = (ctx.events || []).filter((e) => e.t < period.end);
    const columns = [
      ['Time (UTC)', (r) => iso(r.t)], ...loc(tz, 'Time', (r) => r.t), ['In period', (r) => yn(r.t >= period.start)],
      ['Direction', (r) => r.dir], ['Held at', (r) => LO.keyLabel(r.dir === 'move' ? r.from : r.loc, names)], ['Moved to', (r) => (r.dir === 'move' ? LO.keyLabel(r.to, names) : '')],
      ['Kind', (r) => LO.KIND[r.kind] || r.kind], ['What', (r) => r.what || ''], ['Units (USDe)', (r) => n6(r.units)],
      ['USD per USDe', (r) => (r.px == null ? '' : T.fx.rateCell(r.px))], ['Value USD', (r) => n6(r.usd)], ...money.cols((r) => r.usd, (r) => r.t, 'Value'),
      ['Source', (r) => (r.src === 'entered' ? 'entered on the page' : r.src === 'predict' ? 'Meridian Predict' : 'Meridian perps')], ['ID', (r) => r.id || ''], ['Tx', (r) => r.tx || ''],
    ];
    return { name: ctx.fname('usde-flows'), columns, rows, warnings: (ctx.warnings || []).slice() };
  };
})();
