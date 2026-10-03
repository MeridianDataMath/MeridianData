/* MeridianDataHub — Tax center loading: what the reports read from the exchange, abortable, with progress, and kept for
   the tab (MD.tax.cache) once a range is closed. GET requests only, paced: A.page is sequential and the rest runs four at
   a time through U.pLimit (A.get waits out a 429). */
(function () {
  const MD = window.MD; const U = MD.util; const A = MD.api; const T = MD.tax;
  const LD = (T.load = {});
  const CLOSED = 5 * 60000;   // a range that ended this long ago no longer changes: kept for the tab

  /**
   * The archive for a period: daily balance and volume rows from the day before it starts (the running totals need the
   * row before), plus hourly rows for each UTC day a boundary cuts (T.periods.splitDays), each from the hour before that
   * day. That is about 14 split days a year per kind at most, never the whole year by the hour, and a split day on which
   * nothing moved (before the account existed, or a quiet day) is not read at all. o: {signal,
   * progress(stage, done, total)}. Returns {balance, volume, hour: Map(day → {balance, volume}), failed}: an hourly read
   * that fails leaves its day whole (T.ledger.build flags it) rather than failing the report.
   */
  LD.archive = async function (sid, period, o = {}) {
    const signal = o.signal, progress = o.progress || (() => {});
    const now = Date.now();
    const splits = T.periods.splitDays(period).filter((S) => S < now);
    const key = ['archive', sid, period.start, period.end, splits.join(',')].join('|');
    const hit = T.cache.get(key);
    if (hit && hit.closed) return hit.value;
    const from = Math.floor(period.start / U.DAY) * U.DAY - U.DAY, to = Math.min(period.end, now);
    let total = 2 + 2 * splits.length, done = 0;
    const tick = () => { done++; progress(done <= 2 ? 'daily' : 'hourly', done, total); };
    progress('daily', 0, total);
    const day = (kind) => A.history(kind, sid, { start: from, end: to, resolution: 'day1', signal, ttl: CLOSED }).then((r) => { tick(); return r; });
    const [balance, volume] = await Promise.all([day('balance'), day('volume')]);
    // a split day on which nothing moved (before the account existed, or a quiet day) has nothing to split
    const quiet = new Set(T.ledger.quietDays(balance, volume, splits));
    const busy = splits.filter((S) => !quiet.has(S));
    total = 2 + 2 * busy.length;
    const hour = new Map(); for (const S of busy) hour.set(S, { balance: null, volume: null });
    const tasks = [];
    for (const S of busy) for (const kind of ['balance', 'volume']) tasks.push(async () => {
      const rows = await A.history(kind, sid, { start: S - U.HOUR, end: Math.min(S + U.DAY, now), resolution: 'hour1', signal, ttl: CLOSED });
      hour.get(S)[kind] = rows; tick();
    });
    const res = await U.pLimit(tasks, 4);
    const ab = res.find((r) => !r.ok && T.isAbort(r.error)); if (ab) throw ab.error;
    const value = { balance, volume, hour, failed: res.filter((r) => !r.ok).length };
    T.cache.set(key, { closed: Math.ceil(period.end / U.HOUR) * U.HOUR < now - CLOSED, value });   // the hour the end cuts is over too
    return value;
  };

  /**
   * The archive's unrealized PnL per margin pool at the period's instants (the holdings at its start and end). specs:
   * T.holdings.archiveRow's {res, rowT, now}, one per instant; each is one small read of that bucket (for now the last
   * two hours, the newest bucket kept by T.holdings.upnlOf). Kept for the tab once the bucket is closed. o: {signal}.
   * Returns [{spec, rows} | {spec, error}] in the order given: a read that fails leaves its instant without the figure
   * (the card says so) rather than failing the others; an abort throws.
   */
  LD.upnl = async function (sid, specs, o = {}) {
    const now = Date.now();
    const read = async (s) => {
      const key = ['upnl', sid, s.res, s.now ? 'now' : s.rowT].join('|');
      const hit = T.cache.get(key);
      if (hit && (hit.closed || now - hit.at < 60000)) return hit.value;
      const ms = A.RES[s.res].ms;
      // the archive's endTime is inclusive: a read of one bucket also brings the next, which upnlOf leaves out
      const rows = s.now ? await A.history('unrealized-pnl', sid, { start: s.rowT - U.HOUR, resolution: 'hour1', signal: o.signal })
        : await A.history('unrealized-pnl', sid, { start: s.rowT, end: s.rowT + ms, resolution: s.res, signal: o.signal, ttl: CLOSED });
      T.cache.set(key, { closed: !s.now && s.rowT + ms < now - CLOSED, at: now, value: rows });
      return rows;
    };
    const res = await U.pLimit(specs.map((s) => () => read(s)), 4);
    const ab = res.find((r) => !r.ok && T.isAbort(r.error)); if (ab) throw ab.error;
    return res.map((r, i) => (r.ok ? { spec: specs[i], rows: r.value } : { spec: specs[i], error: r.error }));
  };

  const HOUR = U.HOUR, DAY = U.DAY;
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const byCreated = (x, y) => U.num(x.createdAt) - U.num(y.createdAt) || byId(x, y);
  /** rows of two reads as one, each row once (key(row)), ascending by createdAt */
  const merge = (a, b, key) => { const m = new Map(); for (const r of a.concat(b)) m.set(key(r), r); return Array.from(m.values()).sort(byCreated); };

  // the reads of a list by creation time this tab made, per list and subaccount, done or still running: [{a, b, p,
  // closed}] (in MD.tax.cache, so it goes with the rest of the tab's cache)
  const reads = (path, sid) => { const k = ['reads', path, sid].join('|'); let l = T.cache.get(k); if (!Array.isArray(l)) T.cache.set(k, (l = [])); return l; };
  const within = (rows, a, b) => rows.filter((r) => { const t = U.num(r.createdAt); return t >= a && t < b; });
  const aborted = (signal) => { if (signal && signal.aborted) throw T.isAbort(signal.reason) ? signal.reason : Object.assign(new Error('Aborted'), { name: 'AbortError' }); };

  /**
   * A list read by creation time over [a, b) (createdAfter a − 1, createdBefore b), reusing what this tab already read of
   * it: a read that overlaps [a, b) (done, or still running: it is awaited) gives its rows there, and only the parts
   * outside it are read, one after another, each reusing the same way. So the USDe lots' whole history reads only the
   * months before and after the period the trade detail already read, not every page again. A read that came back
   * truncated or failed is never reused; with o.closedOnly (transfers: a pending one can still complete) only a read of
   * a range that had closed when it was made is. A part whose range has closed goes through the request cache too
   * (ttl). o: {maxPages, signal, closedOnly, onPage(pages, rows) counted across the parts}. Returns the rows created in
   * [a, b), each once, with .truncated when any part was.
   */
  LD.span = async function (path, sid, a, b, o = {}) {
    const list = reads(path, sid), now = Date.now(), signal = o.signal;
    let pages = 0, rows = 0;
    const tell = () => { if (o.onPage) o.onPage(pages, rows); };
    const own = (x, y) => {
      const p0 = pages, r0 = rows, closed = y < now - CLOSED;
      const p = A.page(A.BASE, path, { subaccountId: sid, createdAfter: x - 1, createdBefore: y }, { maxPages: o.maxPages, signal, ttl: closed ? CLOSED : 0, onPage: (n, r) => { pages = p0 + n; rows = r0 + r; tell(); } });
      const e = { a: x, b: y, p, closed };
      const drop = () => { const i = list.indexOf(e); if (i >= 0) list.splice(i, 1); };
      list.push(e);
      p.then((r) => { if (!r || r.truncated) drop(); }, drop);
      return p;
    };
    // the earlier read that covers the most of [x, y), skipping those that already failed this call
    const best = (x, y, skip) => {
      let top = null, most = 0;
      for (const e of list) {
        if (skip.includes(e) || (o.closedOnly && !e.closed)) continue;
        const n = Math.min(y, e.b) - Math.max(x, e.a);
        if (n > most) { top = e; most = n; }
      }
      return top;
    };
    const part = async (x, y, skip) => {
      if (!(y > x)) return Object.assign([], { truncated: false });
      const e = best(x, y, skip);
      if (!e) { const r = await own(x, y); return Object.assign(within(r, x, y), { truncated: !!r.truncated }); }
      const lo = Math.max(x, e.a), hi = Math.min(y, e.b);
      const left = await part(x, lo, skip);
      let mid = null;
      // another load's read: its abort or failure is not this one's, which then reads that part itself
      try { const r = await e.p; if (r && !r.truncated) mid = within(r, lo, hi); } catch (err) { aborted(signal); }
      aborted(signal);
      if (mid) { rows += mid.length; tell(); mid.truncated = false; } else mid = await part(lo, hi, skip.concat([e]));
      const right = await part(hi, y, skip);
      return Object.assign(left.concat(mid, right).sort(byCreated), { truncated: left.truncated || mid.truncated || right.truncated });
    };
    return part(a, b, []);
  };
  /** The positions a period's disposals and settlements can come from: opened before its end, and open or changed since
   *  its start. */
  LD.touched = (positions, start, end) => positions.filter((p) => U.num(p.createdAt) < end && (U.num(p.size) !== 0 || U.num(p.updatedAt) >= start));

  /** The trade detail loads on its own up to this size (about what the largest account seen, 218 positions in a year,
   *  reads in a few seconds); above it the page asks first. */
  LD.AUTO = { positions: 250, days: 400 };
  /**
   * How big the period's trade detail is, from the positions already read: touched (the positions it replays), days
   * (from the opening of the earliest of them to the period's end, or now: how far back its fills and hourly funding
   * charges are read, one charges window per 71 hours) and auto (it loads on its own: at most LD.AUTO.positions
   * positions, at most LD.AUTO.days days, and a position list read whole). Above that, a 'Load trade detail' button
   * starts it, and so does any export that needs it.
   */
  LD.detailSize = (positions, start, end, now) => {
    const touched = LD.touched(positions || [], start, end);
    const from = touched.length ? Math.min(...touched.map((p) => U.num(p.createdAt))) : start;
    const days = Math.max(0, Math.ceil((Math.min(end, now != null ? now : Date.now()) - from) / U.DAY));
    const truncated = !!(positions && positions.truncated);
    return { auto: !truncated && touched.length <= LD.AUTO.positions && days <= LD.AUTO.days, touched: touched.length, days, truncated };
  };

  /**
   * Everything the per-disposal tables need, for one subaccount and period. GET only, paced: positions (up to 100
   * pages); every order fill from the opening of the earliest position the period touches to its end (up to 500 pages,
   * so each position replays from its first fill); the period's transfers (fills and transfers through LD.span: what
   * another range of this tab read is not read again); the hourly funding charges of the same range;
   * the position's own fills (/v1/position/fill, four at a time) for liquidated and deleveraged positions, whose
   * liquidation and deleverage fills are not order fills, and for any position whose replay does not reproduce the
   * exchange's totals; the daily ledger before the period when an mPerp position opened before it (its position fees),
   * and the hourly ledger of the UTC days on which two or more positions of one mPerp pool were filled (to tell their
   * fees apart). o: {start, end, ref, dayRows (load.archive's balance rows), signal, progress(state)}, state: {fillPages,
   * fillRows, posDone, posTotal, fundDone, fundTotal}. Kept for the tab: a range whose last hour ended more than 5
   * minutes ago is reused as it is; one still running is extended with what happened since the last read.
   * Returns {positions, touched, from, to (the data's end: the end of the hour the period ends in, or now), fills,
   * transfers (the period's, by exact instant), hourTransfers (with those of the hour its end cuts, for the per-day
   * checks), posFills: Map, charges (null: not readable), pre (daily rows, the period's included), resFrom (the first day
   * the mPerp residuals count from), pfHours: Map(day → hourly rows), truncated: {positions, fills, transfers, charges,
   * posFills: [ids]}, failed: [what could not be read]}.
   */
  LD.events = async function (sid, o) {
    const now = Date.now(), signal = o.signal, F = T.fills, FU = T.funding;
    const state = { fillPages: 0, fillRows: 0, posDone: 0, posTotal: 0, fundDone: 0, fundTotal: 0 };
    const tell = (x) => { Object.assign(state, x); if (o.progress) o.progress(Object.assign({}, state)); };
    // the ledger counts an hour a boundary cuts in its middle (India, Adelaide, Newfoundland) in the period it starts in:
    // fills, charges and transfers are read to the end of the hour the period ends in, so each UTC day's checks see what
    // the ledger counts there (the hour its start cuts is the previous period's); the period's own rows still cut at its
    // exact instants
    const endH = Math.ceil(o.end / HOUR) * HOUR, to = Math.min(endH, now);
    const key = ['events', sid, o.start, o.end].join('|');
    const hit = T.cache.get(key);
    if (hit && hit.closed) return hit.value;
    tell({});
    const positions = await A.positions(sid, { maxPages: 100, ttl: CLOSED, signal });
    const touched = LD.touched(positions, o.start, o.end);
    const from = touched.length ? Math.min(...touched.map((p) => U.num(p.createdAt))) : o.start;
    const prev = hit && hit.value && hit.value.from === from && hit.value.to <= to ? hit.value : null;   // a running range read before: only the tail is new
    const failed = [];
    const fillsFrom = prev ? prev.to : from;
    const [fillsNew, transfers, chargesNew] = await Promise.all([
      // createdAfter is exclusive: LD.span asks a millisecond earlier, which keeps a fill at the position's very opening;
      // what another range of this tab read (the period's trade detail, for the lifetime lots) is not read again
      LD.span('/v1/order/fill', sid, fillsFrom, to, { maxPages: 500, signal, onPage: (n, rows) => tell({ fillPages: n, fillRows: rows }) }),
      LD.span('/v1/token/transfer', sid, o.start, to, { maxPages: 20, signal, closedOnly: true }),
      A.fundingCharges(sid, prev ? prev.to - HOUR : from, { end: to, signal, ttl: CLOSED, onProgress: (d, n) => tell({ fundDone: d, fundTotal: n }) })
        .catch((e) => { if (T.isAbort(e)) throw e; failed.push('funding charges (' + e.message + ')'); return null; }),
    ]);
    const fills = (prev ? merge(prev.fills, fillsNew, (f) => f.id) : fillsNew.slice()).filter((f) => U.num(f.createdAt) >= from && U.num(f.createdAt) < to);
    const charges = chargesNew == null || (prev && prev.charges == null) ? null : prev ? merge(prev.charges, chargesNew, (c) => c.positionId + '|' + c.time).sort((a, b) => U.num(a.time) - U.num(b.time)) : chargesNew;
    const hourTransfers = transfers.filter((t) => U.num(t.createdAt) >= o.start && U.num(t.createdAt) < to);
    const tr = hourTransfers.filter((t) => U.num(t.createdAt) < o.end);
    const truncated = { positions: !!positions.truncated, fills: !!fillsNew.truncated || !!(prev && prev.truncated.fills), transfers: !!transfers.truncated, charges: charges == null, posFills: [] };

    // positions read from their own fill list: liquidated or deleveraged ones (their closing fill is no order fill), and
    // any whose replay from the order fills does not give the exchange's totals
    const complete = (p) => !truncated.fills && U.num(p.createdAt) >= from && U.num(p.updatedAt) < to;
    const A0 = F.assign(fills, null, positions);
    const want = touched.filter((p) => p.isLiquidated || p.wasDeleveraged || (complete(p) && F.replay(p, A0.byPos.get(p.id) || [], null, { complete: true }).check.ok === false));
    const posFills = new Map();
    // a position read before keeps its list while it has not changed since
    for (const p of want) if (prev && prev.posFills.has(p.id) && U.num(p.updatedAt) < prev.to) { posFills.set(p.id, prev.posFills.get(p.id)); if (prev.truncated.posFills.includes(p.id)) truncated.posFills.push(p.id); }
    if (prev) for (const f of prev.failed) if (/^the daily ledger before/.test(f)) failed.push(f);   // not read again: still missing
    const read = want.filter((p) => !posFills.has(p.id));
    tell({ posTotal: read.length, posDone: 0 });
    const res = await U.pLimit(read.map((p) => () => A.positionFills(p.id, { maxPages: 50, ttl: CLOSED, signal })), 4, (d) => tell({ posDone: d }));
    const ab = res.find((r) => !r.ok && T.isAbort(r.error)); if (ab) throw ab.error;
    res.forEach((r, i) => {
      if (!r.ok) { failed.push('fills of position ' + read[i].id.slice(0, 8) + ' (' + r.error.message + ')'); return; }
      if (r.value.truncated) truncated.posFills.push(read[i].id);
      posFills.set(read[i].id, r.value);
    });

    // position fees: the daily ledger from before the period when an mPerp position opened before it, then the hours of
    // the days on which two or more positions of one pool were filled
    const pools = FU.poolOf(o.ref), archFrom = o.dayRows && o.dayRows.length ? Math.min(...o.dayRows.map((r) => U.num(r.time))) : Math.floor(o.start / DAY) * DAY - DAY;
    // residuals count from resFrom: every pool needs a row before it as the starting point (the day before the earliest
    // position, read here, or the archive's first row)
    const fromDay = Math.floor(from / DAY) * DAY;
    let pre = prev ? prev.pre : [], resFrom = prev ? prev.resFrom : Math.max(fromDay, archFrom + DAY);
    if (!prev && touched.some((p) => pools.has(p.productId)) && fromDay <= archFrom) {
      try { pre = await A.history('balance', sid, { start: fromDay - DAY, end: archFrom, resolution: 'day1', signal, ttl: CLOSED }); resFrom = fromDay; }
      catch (e) { if (T.isAbort(e)) throw e; failed.push('the daily ledger before the period (' + e.message + ')'); }
    }
    const A1 = F.assign(fills, posFills, positions);
    const dayRows = pre.filter((r) => U.num(r.time) < archFrom).concat(o.dayRows || []);
    const days = FU.feeDays(T.ledger.residuals(dayRows, o.ref, DAY, resFrom), A1.byPos, positions, o.ref).filter((D) => D < now);
    const pfHours = new Map();
    const hres = await U.pLimit(days.map((D) => async () => { pfHours.set(D, await A.history('balance', sid, { start: D - HOUR, end: Math.min(D + DAY, now), resolution: 'hour1', signal, ttl: CLOSED })); }), 4);
    const hab = hres.find((r) => !r.ok && T.isAbort(r.error)); if (hab) throw hab.error;
    if (hres.some((r) => !r.ok)) failed.push('the hourly ledger of ' + hres.filter((r) => !r.ok).length + ' day(s) with position fees');

    const value = { positions, touched, from, to, fills, transfers: tr, hourTransfers, posFills, charges, pre: dayRows, resFrom, pfHours, truncated, failed, loadedAt: now };
    T.cache.set(key, { closed: endH < now - CLOSED, value });   // that hour over too: nothing more can come
    return value;
  };

  /**
   * The account's whole history for the USDe lots: from the subaccount's creation (its first possible event) to `end`
   * (the period's end plus the 30 days the UK rule looks ahead; the data stops at now). The daily balance rows of the
   * whole span (position fees, and funding per day when the charges cannot be read), then LD.events over it, with the
   * same pacing, progress and cache (a span whose end is past is kept for the tab; one still running is extended; the
   * fills and transfers the period's trade detail read, done or still running, are reused, so only the rest is read). o:
   * {first (ms), end (ms), ref, signal, progress(state)}: state as LD.events', plus {stage: 'ledger' | 'events'}.
   * Returns {ev, dayRows, start, end, D} where D is T.fills.disposals over the span (no period ledger: no day checks).
   */
  LD.lifetime = async function (sid, o) {
    const now = Date.now(), start = Math.floor(U.num(o.first) / DAY) * DAY;
    const tell = (x) => { if (o.progress) o.progress(x); };
    tell({ stage: 'ledger' });
    const dayRows = await A.history('balance', sid, { start: start - DAY, end: Math.min(o.end, now), resolution: 'day1', signal: o.signal, ttl: CLOSED });
    const ev = await LD.events(sid, { start, end: o.end, ref: o.ref, dayRows, signal: o.signal, progress: (s) => tell(Object.assign({ stage: 'events' }, s)) });
    // T.fills.disposals checks each UTC day against a period ledger; over the lifetime there is none, so none is checked
    const none = { days: [], totals: { realized: 0, C: { realized: 0 } } };
    const D = T.fills.disposals(ev, { ledger: none, period: { start, end: Math.min(o.end, now), tz: 'UTC' }, ref: o.ref, tz: 'UTC' });
    return { ev, dayRows, start, end: o.end, D };
  };
})();
