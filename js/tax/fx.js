/* MeridianDataHub — Tax center exchange rates: every converted amount at the rate of its own local date, from the source
   and under the convention set for its currency, never one rate for a whole period. PLN: NBP table A, the last table
   published before the event's date (the convention of art. 11a of the Polish PIT Act). CAD: the Bank of Canada, that
   day or the closest day before (CRA Folio S5-F4-C1 ¶1.4). Every other currency: the ECB's euro reference rates,
   crossed through the euro at full precision, that day or the last ECB business day before. The deploy publishes the
   official series as data/fx/*.json (scripts/build-fx.mjs); frankfurter.dev (the ECB's rates) is the fallback. The
   USDe lots' market valuation (DefiLlama's daily USDe/USD price) is published there too, with DefiLlama itself as the
   fallback. The table, lookup and money parts are pure; only FX.load, FX.frankfurter and FX.usde read anything. */
(function () {
  const MD = window.MD; const U = MD.util; const T = MD.tax; const TZ = T.tz;
  const FX = (T.fx = {});
  const HOUR = 3600000, FRESH = 15 * 60000, LOOKBACK = 10;
  const FILES = 'data/fx/';
  const FRANKFURTER = 'https://api.frankfurter.dev/v1/';

  // conv: 'onOrBefore' (that date, else the last one before it) or 'before' (the last date strictly before it). pubBy: by
  // when (from 00:00 UTC of a date) that date's rate is out, so a file read later holds it (the ECB around 16:00 CET, NBP
  // around noon in Warsaw, the Bank of Canada by 16:30 in Ottawa).
  FX.SOURCES = {
    ecb: {
      id: 'ecb', short: 'ECB', who: 'the ECB', name: 'ECB euro foreign exchange reference rates', conv: 'onOrBefore', pubBy: 16 * HOUR,
      line: 'the ECB\'s euro reference rates, crossed through the euro', rule: 'each local date\'s rate, or the last ECB business day\'s before it',
      ruleLong: 'the ECB reference rate of each local date, or of the last ECB business day before it',
      cross: 'USD→X = (X per EUR) ÷ (USD per EUR) and USD→EUR = 1 ÷ (USD per EUR), from the ECB\'s quotes at full precision',
      holidays: 'weekends and ECB closing days (TARGET holidays: 1 Jan, Good Friday, Easter Monday, 1 May, 25–26 Dec) use the previous business day\'s rate',
      dateHead: 'Rate date (ECB)',
    },
    nbp: {
      id: 'nbp', short: 'NBP', who: 'NBP', name: 'NBP table A average exchange rates', conv: 'before', pubBy: 12 * HOUR,
      line: 'NBP table A average rates', rule: 'the table of the last business day before each local date',
      ruleLong: 'the average (mid) USD rate of the last table A that NBP published before each local date, i.e. of the last business day before it (the convention of art. 11a of the Polish PIT Act)',
      cross: null,
      holidays: 'after a weekend or a Polish public holiday that is the table of the last business day before it, so a Monday uses Friday\'s table',
      dateHead: 'Rate date (NBP table A)',
    },
    boc: {
      id: 'boc', short: 'Bank of Canada', who: 'the Bank of Canada', name: 'Bank of Canada daily exchange rates (FXUSDCAD)', conv: 'onOrBefore', pubBy: 22 * HOUR,
      line: 'the Bank of Canada\'s daily rates', rule: 'each local date\'s rate, or the closest preceding day\'s',
      ruleLong: 'the Bank of Canada USD/CAD rate of each local date, or of the closest preceding day it published one (CRA Folio S5-F4-C1 ¶1.4)',
      cross: null,
      holidays: 'weekends and Bank of Canada holidays use the closest preceding day\'s rate',
      dateHead: 'Rate date (Bank of Canada)',
    },
  };
  /** The source a currency is converted from: PLN → NBP, CAD → Bank of Canada, everything else → ECB; src 'ecb' (the
   *  link's src=) picks the ECB for PLN and CAD too. */
  FX.sourceFor = (ccy, src) => (src === 'ecb' ? 'ecb' : ccy === 'PLN' ? 'nbp' : ccy === 'CAD' ? 'boc' : 'ecb');
  /** The choice of source a currency offers (the Rate source select), or null. */
  FX.choices = (ccy) => (ccy === 'PLN' ? [{ v: 'nbp', label: 'NBP table A' }, { v: 'ecb', label: 'ECB (via EUR)' }] : ccy === 'CAD' ? [{ v: 'boc', label: 'Bank of Canada' }, { v: 'ecb', label: 'ECB (via EUR)' }] : null);
  /** Every source this page uses, in one sentence (the info card, the definitions, the currency select). */
  FX.MAP_TEXT = 'PLN at NBP table A average rates of the last business day before each date; CAD at the Bank of Canada\'s daily rate of that date or the closest day before; every other currency at the ECB\'s euro reference rates crossed through the euro, of that date or the last ECB business day before (the ECB can be chosen for PLN and CAD too)';
  FX.ONLY_TEXT = 'Only currencies the ECB, NBP or Bank of Canada publish are offered (not, for example, PKR or EGP); for others, use the USD columns in the exports.';

  // ---------- tables (pure) ----------
  /** USD→ccy from the ECB's EUR quotes: (ccy per EUR) ÷ (USD per EUR), and 1 ÷ (USD per EUR) for EUR, at full
   *  precision. ecb: {dates, rates: {CCY: [...]}}. Returns a table {source, ccy, d: [dates], r: [rates], ref: null}; a
   *  date without both quotes is left out. */
  FX.fromEcb = (ecb, ccy) => {
    const usd = ecb && ecb.rates && ecb.rates.USD, own = ccy === 'EUR' ? null : ecb && ecb.rates && ecb.rates[ccy];
    if (!usd || (ccy !== 'EUR' && !own)) throw new Error('the ECB series has no ' + (usd ? ccy : 'USD'));
    const d = [], r = [];
    for (let i = 0; i < ecb.dates.length; i++) {
      const u = usd[i], c = ccy === 'EUR' ? 1 : own[i];
      if (!(u > 0) || !(c > 0)) continue;
      d.push(ecb.dates[i]); r.push(c / u);
    }
    return { source: 'ecb', ccy, d, r, ref: null };
  };
  /** frankfurter.dev's answer (EUR base; a range, or /latest) in the ECB file's shape. */
  FX.fromFrankfurter = (raw) => {
    const by = raw && raw.rates ? (raw.date && !raw.start_date ? { [raw.date]: raw.rates } : raw.rates) : {};
    const dates = Object.keys(by).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
    const rates = {};
    dates.forEach((k, i) => { for (const [c, v] of Object.entries(by[k] || {})) (rates[c] || (rates[c] = dates.map(() => null)))[i] = v; });
    return { dates, rates };
  };
  /** A published file (data/fx/*.json) as a table for ccy. */
  FX.table = (json, ccy) => {
    if (!json || !Array.isArray(json.dates)) throw new Error('not a rate file');
    if (json.source === 'ecb') return FX.fromEcb(json, ccy);
    if ((json.source === 'nbp' || json.source === 'boc') && json.ccy === ccy && Array.isArray(json.rates) && json.rates.length === json.dates.length)
      return { source: json.source, ccy, d: json.dates.slice(), r: json.rates.slice(), ref: Array.isArray(json.tables) ? json.tables.slice() : null };
    throw new Error('not a ' + ccy + ' rate file');
  };
  /** Two tables of one source as one, by date; a's rows win. */
  FX.merge = (a, b) => {
    const m = new Map();
    for (const t of [b, a]) if (t) t.d.forEach((k, i) => m.set(k, [t.r[i], t.ref ? t.ref[i] : null]));
    const d = Array.from(m.keys()).sort();
    return { source: a.source, ccy: a.ccy, d, r: d.map((k) => m.get(k)[0]), ref: a.ref || (b && b.ref) ? d.map((k) => m.get(k)[1]) : null };
  };
  /** Index of the rate a date key takes under a convention, by binary search (-1: none that early). */
  FX.lookup = (table, key, conv) => {
    let lo = 0, hi = table.d.length - 1, r = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; const k = table.d[mid]; if (k < key || (conv !== 'before' && k === key)) { r = mid; lo = mid + 1; } else hi = mid - 1; }
    return r;
  };
  /**
   * Whether a file holds every rate a period needs. meta: {from, to, fetchedAt}; fromKey: the first local date with
   * possible activity; needTo: the last local date that needs a rate (the period's last, or today). A date's rate is in
   * the file when the file goes past it, or was read after that rate is published (pubBy). Returns {head, tail}: head
   * false when the file starts too late; tail 'ok', 'provisional' (read on the day the newest rate is due, before it was
   * out: until it comes, that day uses the rate before) or 'stale'.
   */
  FX.covers = (meta, id, fromKey, needTo) => {
    const S = FX.SOURCES[id];
    const head = !!meta && (S.conv === 'before' ? meta.from < fromKey : meta.from <= fromKey);
    const last = S.conv === 'before' ? TZ.addDays(needTo, -1) : needTo;   // the newest date a lookup can take
    const at = Date.parse(meta && meta.fetchedAt) || 0, due = TZ.keyMs(last);
    const tail = !meta ? 'stale' : meta.to >= last || at >= due + S.pubBy ? 'ok' : at >= due ? 'provisional' : 'stale';
    return { head, tail };
  };
  /** A rate as text: four decimals, two from 1,000 up (the CSV cells carry the full rate). */
  FX.rateText = (r) => (r >= 1000 ? r.toFixed(2) : r.toFixed(4));
  /** A rate as a CSV cell: twelve significant digits, so amount × rate reproduces the converted cell. */
  FX.rateCell = (r) => (r == null ? '' : String(+Number(r).toPrecision(12)));
  /** What a rate cell says on a date before the table's first rate. */
  FX.NO_RATE = 'no rate (before the first published rate)';
  /** A rate row as '1 USD = r CCY (its date)', or FX.NO_RATE when there is none. */
  FX.rateLine = (x, ccy) => (!x || x.none ? FX.NO_RATE : `1 USD = ${FX.rateText(x.r)} ${ccy} (${x.label})`);

  /**
   * The rates object FX.load returns. table: the lookup table; latest: overrides for the newest rate ({r, date, ref,
   * label} when it came from elsewhere; current false when it is not today's; inPeriod when it is the period's last).
   * on(t, tz) → {r, date, ref, label} by the event's local date (memoised per date): label is the rate's date, with
   * NBP's table number. A date before the table's first rate has none, never the first rate in its place: {r: null,
   * date: null, label: FX.NO_RATE, none: true}; early: those dates as asked (the Rate notes name them). first: the
   * table's first rate. The page loads rates from the wallet's first possible activity (FX.fromKey), so only a value
   * at an instant before it (holdings of zero), an empty month or a lot entered with an earlier date meets one.
   */
  FX.rates = ({ ccy, id, via, table, fetchedAt = null, notes = [], latest = null, tz = 'UTC' }) => {
    const S = FX.SOURCES[id];
    if (!table || !table.d.length) throw new Error('no ' + ccy + ' rates');
    const memo = new Map(), early = new Set();
    const row = (i) => { const ref = table.ref ? table.ref[i] || null : null; return { r: table.r[i], date: table.d[i], ref, label: table.d[i] + (ref ? ' (' + ref + ')' : '') }; };
    const none = { r: null, date: null, ref: null, label: FX.NO_RATE, none: true };
    const onKey = (key) => {
      let x = memo.get(key);
      if (!x) { const i = FX.lookup(table, key, S.conv); if (i < 0) early.add(key); x = i < 0 ? none : row(i); memo.set(key, x); }
      return x;
    };
    return {
      ccy, source: id, src: S, via, table, fetchedAt, notes, tz, early, first: row(0),
      onKey, on: (t, z) => onKey(TZ.dayKey(t, z || tz)), at: (t, z) => onKey(TZ.dayKey(t, z || tz)).r,
      latest: Object.assign({ current: true, inPeriod: false }, row(table.d.length - 1), latest || {}),
    };
  };
  /**
   * The first local date a report's rates must reach: the wallet's first possible activity (the subaccount's creation
   * or Meridian Predict's launch, whichever is first), whatever the period. The USDe lots and the Predict record convert
   * amounts dated before the period, so rates from the period's start would leave them without one. o: {createdAt
   * (ms; null: no subaccount), now, tz}.
   */
  FX.fromKey = (o) => TZ.dayKey(Math.min(U.num(o.createdAt) || o.now, T.LAUNCH()), o.tz || 'UTC');

  // ---------- money (pure) ----------
  /**
   * Amounts in the report currency. rates: FX.load's result, or null for USD.
   * fx(usd, t): a USD amount at instant t, at the rate of t's local date (null on a date before the first rate, unless
   *   the amount is 0); rate(t): that rate (1 for USD; null before the first rate); rateOf(t): its row {r, date, label,
   *   none} (null for USD).
   * fmt(v, {sign, compact, dp}): an amount already in the report currency, in cents like a statement; compact as
   *   U.fmtUsd (B, M and K steps, whole units from 1,000, a bare zero), an explicit dp still honoured.
   * now(v, o): a USD amount with no date of its own (claimable now, unrealized PnL now) at the latest rate, which
   *   nowTag() names.
   * cols(getUsd, getT, name): the CSV columns '<name> <CCY>', 'USD→<CCY> rate' and 'Rate date (<source>)' (none for USD;
   *   blank cells where the USD value is null; before the first rate the amount and rate cells are blank and the date
   *   cell says so).
   * line(P): the line under the tiles; describe(): [key, value] rows for the methodology.
   */
  FX.money = (rates, tz) => {
    const cur = rates ? rates.ccy : 'USD';
    const DP = T.dp(cur);
    const nfs = {};
    const nf = (dp) => nfs[dp] || (nfs[dp] = new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: dp, maximumFractionDigits: dp }));
    const on = (t) => rates.on(t, tz);
    const fmt = (v, opts = {}) => {
      v = U.num(v);
      const dp = opts.dp != null ? opts.dp : DP;
      if (!opts.compact && Math.abs(v) < Math.pow(10, -dp) / 2) v = 0;   // no "-$0.00"
      if (cur === 'USD') return U.fmtUsd(v, opts.compact ? opts : Object.assign({}, opts, { dp }));
      const s = v < 0 ? '-' : opts.sign && v > 0 ? '+' : ''; const a = Math.abs(v);
      if (opts.compact) {
        if (a === 0 && opts.dp == null) return nf(0).format(0);   // an empty market reads "€0", not "€0.00"
        return s + (a >= 1e9 ? nf(2).format(a / 1e9) + 'B' : a >= 1e6 ? nf(2).format(a / 1e6) + 'M' : a >= 1e4 ? nf(1).format(a / 1e3) + 'K' : nf(opts.dp != null ? opts.dp : a >= 1000 ? 0 : DP).format(a));
      }
      return s + nf(dp).format(a);
    };
    const S = rates ? rates.src : null;
    const via = () => (!rates ? '' : rates.via === 'frankfurter' ? ' (via frankfurter.dev)' : rates.via === 'file+frankfurter' ? ' (the newest days via frankfurter.dev)' : '');
    // a date before the first rate has none: its amount stays unconverted (null), never at the first rate
    const conv = (usd, t) => { if (!rates || !usd) return usd; const x = on(t); return x.none ? null : usd * x.r; };
    return {
      ccy: cur, rates, tz,
      fx: conv,
      rate: (t) => (rates ? on(t).r : 1),
      rateOf: (t) => (rates ? on(t) : null),
      fmt,
      now: (v, o) => fmt(rates ? U.num(v) * rates.latest.r : v, o),
      nowTag: () => {
        if (!rates) return '';
        const L = rates.latest;
        if (L.current) return ` · at the latest ${S.short} rate (${L.label})`;
        return L.inPeriod ? ' (at the last rate in the period)' : ` (at the last rate available, ${L.label})`;
      },
      cols: (getUsd, getT, name) => {
        if (!rates) return [];
        const val = (r) => { const u = getUsd(r); return u == null || u === '' || !Number.isFinite(+u) ? null : +u; };
        return [
          [name + ' ' + cur, (r) => { const u = val(r); if (u == null) return ''; const x = on(getT(r)); return x.none ? '' : T.n6(u * x.r); }],
          ['USD→' + cur + ' rate', (r) => (val(r) == null ? '' : FX.rateCell(on(getT(r)).r))],
          [S.dateHead, (r) => (val(r) == null ? '' : on(getT(r)).label)],
        ];
      },
      line: (P) => {
        if (!rates) return null;
        const past = !!P && P.end < (P.now != null ? P.now : Date.now());
        const x = past ? on(P.end - 1) : rates.latest;
        return `Reported in ${cur} at ${cur === 'EUR' && S.id === 'ecb' ? 'the ECB\'s euro reference rates (USD per EUR, inverted; nothing crossed)' : S.line}${via()}: ${S.rule}, in ${tz} · ${past ? 'last rate in period' : 'latest'}`
          + (x.none ? `: none, the period ends before the first published rate (${rates.first.label})` : ` 1 USD = ${FX.rateText(x.r)} ${cur} (${x.label})`)
          + (!past && !rates.latest.current ? ', not current' : '') + ' · USD figures in every export';
      },
      describe: () => {
        if (!rates) return [['Report currency', 'USD (USDe-settled amounts at 1 USDe = 1 USD)']];
        const read = rates.via === 'frankfurter' ? 'read from frankfurter.dev (a mirror of the ECB\'s rates) in the browser'
          : `published by this site from ${S.who} at deploy time (read ${rates.fetchedAt || '?'})` + (rates.via === 'file+frankfurter' ? ', the newest days from frankfurter.dev (a mirror of the ECB\'s rates)' : '');
        const early = Array.from(rates.early || []).sort(), notes = rates.notes.map((n) => n.text);
        if (early.length) notes.push(`${early.length} local date(s) before the first published rate (${rates.first.label}) were asked for one, ${early[0]}` + (early.length > 1 ? ' to ' + early[early.length - 1] : '') + ': nothing is converted there (the cells are blank and say so).');
        return [
          ['Report currency', cur + ' (USDe-settled amounts at 1 USDe = 1 USD, then converted)'],
          ['Rate source', S.name + ' · ' + read],
          ['Rate rule', S.ruleLong + (S.cross ? '; ' + S.cross : '') + '; ' + S.holidays + '; the date is the event\'s local date in ' + tz + '; closed positions convert at their close date; a date before the first published rate (' + rates.first.label + ') has none: an amount there is left unconverted, never taken at a later rate'],
          ['Latest rate', `1 USD = ${FX.rateCell(rates.latest.r)} ${cur} (${rates.latest.label})` + (rates.latest.current ? '' : ', not current')],
        ].concat(notes.length ? [['Rate notes', notes.join(' ')]] : []);
      },
    };
  };

  // ---------- USDe in USD (the USDe lots' market valuation; pure) ----------
  /** DefiLlama's daily USDe/USD price. The deploy publishes it as data/fx/usde-usd.json (scripts/build-fx.mjs); the
   *  page reads DefiLlama itself when the file is missing (it answers any origin). */
  FX.USDE = {
    id: 'usde', coin: 'ethereum:0x4c9EDD5852cd905f086C759E8383e09bff1E68B3', floor: '2026-06-01',
    name: 'DefiLlama USDe/USD daily price (USDe on Ethereum, 0x4c9e…68b3)', short: 'DefiLlama',
    rule: 'the price at 00:00 UTC of each local date, or of the last date before it',
  };
  /** DefiLlama's chart answer as {dates, prices}: each point dated by the UTC midnight it is nearest to (DefiLlama
   *  stamps them within minutes of it, either side), one per date, ascending. */
  FX.fromLlama = (raw) => {
    const coin = raw && raw.coins ? Object.values(raw.coins)[0] : null;
    const by = new Map();
    for (const p of (coin && coin.prices) || []) {
      const ts = Number(p.timestamp) * 1000, v = Number(p.price);
      if (!Number.isFinite(ts) || !(v > 0)) continue;
      by.set(new Date(Math.round(ts / 86400000) * 86400000).toISOString().slice(0, 10), v);
    }
    const dates = Array.from(by.keys()).sort();
    return { dates, prices: dates.map((d) => by.get(d)) };
  };
  /** The published file (or fromLlama's result) as a lookup table {source: 'usde', d, r}. */
  FX.usdeTable = (json) => {
    if (!json || !Array.isArray(json.dates) || !Array.isArray(json.prices) || json.dates.length !== json.prices.length) throw new Error('not a USDe price file');
    const d = [], r = [];
    json.dates.forEach((k, i) => { if (/^\d{4}-\d{2}-\d{2}$/.test(k) && json.prices[i] > 0) { d.push(k); r.push(+json.prices[i]); } });
    return { source: 'usde', ccy: 'USD', d, r, ref: null };
  };
  /** USD per USDe at instant t, by its local date in tz (that date's price, or the last one before; a date before the
   *  first takes the first), memoised per date: {table, via, fetchedAt, notes, on(t) → {r, date}, at(t) → r, latest}. */
  FX.usdePrices = (table, tz, o = {}) => {
    if (!table || !table.d.length) throw new Error('no USDe price');
    const memo = new Map();
    const onKey = (key) => { let x = memo.get(key); if (!x) { const i = Math.max(0, FX.lookup(table, key, 'onOrBefore')); x = { r: table.r[i], date: table.d[i] }; memo.set(key, x); } return x; };
    return { table, tz, via: o.via || 'file', fetchedAt: o.fetchedAt || null, notes: o.notes || [], source: FX.USDE, onKey, on: (t) => onKey(TZ.dayKey(t, tz)), at: (t) => onKey(TZ.dayKey(t, tz)).r, latest: { r: table.r[table.d.length - 1], date: table.d[table.d.length - 1] } };
  };

  // ---------- loading ----------
  const session = () => { try { return window.sessionStorage || null; } catch (_) { return null; } };
  const jsonOf = async (io, url, init) => {
    const r = await io.fetch(url, init);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    // Cloudflare answers a path it does not have with index.html (200): only JSON is a file
    if (!/json/i.test((r.headers && r.headers.get && r.headers.get('content-type')) || '')) throw new Error('not published');
    return r.json();
  };
  // The site's own files are small and shared by every load in the tab, so they are read without the caller's signal: a
  // report left half-way must not cancel the read the next one waits on.
  const indexOf = (io) => {
    const hit = T.cache.get('fx|index');
    if (hit && io.now - hit.at < 5 * 60000) return hit.p;   // the deploy replaces it every 30 minutes
    const p = jsonOf(io, FILES + 'index.json', { cache: 'no-cache' });
    T.cache.set('fx|index', { at: io.now, p });
    p.catch(() => { const x = T.cache.get('fx|index'); if (x && x.p === p) T.cache.delete('fx|index'); });
    return p;
  };
  const fileOf = (io, meta) => {
    const key = 'fx|file|' + meta.file + '|' + meta.fetchedAt;
    let p = T.cache.get(key);
    if (!p) { p = jsonOf(io, FILES + meta.file, { cache: 'no-cache' }); T.cache.set(key, p); p.catch(() => { if (T.cache.get(key) === p) T.cache.delete(key); }); }
    return p;
  };
  /**
   * frankfurter.dev (EUR base), cached in sessionStorage as {at, raw}. A request that reaches today and whose answer
   * lacks today's rate is made again after 15 minutes with cache 'no-cache' (frankfurter sends max-age=86400, and the
   * ECB publishes around 16:00 CET); an entry in an older format is read again. io: {fetch, storage, now, signal}.
   */
  FX.frankfurter = async (io, path, live) => {
    const key = 'md.fx2.' + path;
    const today = TZ.dayKey(io.now, 'UTC');
    let c = null; try { c = io.storage ? JSON.parse(io.storage.getItem(key) || 'null') : null; } catch (_) {}
    let raw = c && c.raw && typeof c.at === 'number' ? c.raw : null;
    if (raw && live && (raw.end_date || raw.date || '') < today && io.now - c.at >= FRESH) raw = null;
    if (!raw) {
      const r = await io.fetch(FRANKFURTER + path, { signal: io.signal, cache: live ? 'no-cache' : 'default' });
      if (!r.ok) throw new Error('frankfurter.dev answered ' + r.status);
      raw = await r.json();
      try { if (io.storage) io.storage.setItem(key, JSON.stringify({ at: io.now, raw })); } catch (_) {}
    }
    return raw;
  };
  const syms = (ccy) => (ccy === 'EUR' ? 'USD' : 'USD,' + ccy);

  /**
   * The rates for a report: {ccy, src, fromKey (the first local date with possible activity), toKey (the period's last
   * local date), tz, signal, now, fetch, storage}. Tries, in order: the file of the currency's own source (NBP for PLN,
   * the Bank of Canada for CAD), the ECB file (its newest days from frankfurter.dev when the file is older than the
   * period or today needs), frankfurter.dev alone. Each step down is named in notes[] (amber); when nothing can be read
   * it throws, and the page reports in USD with a red note. The latest rate (money.now) reaches today even for a past
   * period; when it cannot, latest.current is false. null for USD.
   */
  FX.load = async function (o) {
    const ccy = o.ccy; if (!ccy || ccy === 'USD') return null;
    const tz = o.tz || 'UTC';
    const io = { fetch: o.fetch || ((...a) => fetch(...a)), storage: o.storage !== undefined ? o.storage : session(), now: o.now != null ? o.now : Date.now(), signal: o.signal };
    const today = TZ.dayKey(io.now, tz), todayU = TZ.dayKey(io.now, 'UTC');
    const fromKey = o.fromKey, needTo = o.toKey < today ? o.toKey : today, past = o.toKey < today;
    const want = FX.sourceFor(ccy, o.src);
    const notes = [];
    const amber = (text) => notes.push({ level: 'amber', text });
    let index = null, indexErr = null;
    try { index = await indexOf(io); } catch (e) { indexErr = e; }
    const loadFile = async (id) => {
      const meta = (index && index.files && index.files[id]) || null;
      if (!meta) return { why: indexErr ? 'not published on this site' : 'not published by the last deploy' };
      if (id === 'ecb' && Array.isArray(meta.currencies) && !meta.currencies.includes(ccy)) return { why: 'no ' + ccy + ' in the file' };
      let table, json;
      try { json = await fileOf(io, meta); table = FX.table(json, ccy); } catch (e) { return { why: 'the file could not be read (' + e.message + ')' }; }
      if (!table.d.length) return { why: 'no ' + ccy + ' in the file' };
      const m = { from: table.d[0], to: table.d[table.d.length - 1], fetchedAt: json.fetchedAt || meta.fetchedAt };
      return { meta: m, table, period: FX.covers(m, id, fromKey, needTo), now: FX.covers(m, id, fromKey, today) };
    };

    // 1. the currency's own official source
    if (want !== 'ecb') {
      const S = FX.SOURCES[want];
      const f = await loadFile(want);
      const why = f.why || (!f.period.head ? `the file starts on ${f.meta.from}, after this period's first activity` : f.period.tail === 'stale' ? `the file ends on ${f.meta.to} (read ${f.meta.fetchedAt}), short of this period` : null);
      if (!why) return FX.rates({ ccy, id: want, via: 'file', table: f.table, fetchedAt: f.meta.fetchedAt, notes, tz, latest: { current: f.now.tail !== 'stale' } });
      amber(`${S.short} rates: ${why}; ${ccy} is converted at the ECB's euro reference rates instead.`);
    }

    // 2. the ECB file, its newest days from frankfurter when it is older than the period or today needs
    const e = await loadFile('ecb');
    if (!e.why && e.period.head) {
      let table = e.table, via = 'file', current = e.now.tail !== 'stale';
      if (e.now.tail !== 'ok') {
        const next = TZ.addDays(e.meta.to, 1), from = next < todayU ? next : todayU;
        try {
          const add = FX.fromEcb(FX.fromFrankfurter(await FX.frankfurter(io, `${from}..?symbols=${syms(ccy)}`, true)), ccy);
          if (add.d.some((k) => k > e.meta.to)) { table = FX.merge(table, add); via = 'file+frankfurter'; }
          current = true;
        } catch (err) {
          if (T.isAbort(err)) throw err;
          if (e.period.tail === 'stale') amber(`The ECB rates published after ${e.meta.to} could not be read (${err.message}); later dates use the rate of ${e.meta.to}.`);
        }
      }
      return FX.rates({ ccy, id: 'ecb', via, table, fetchedAt: e.meta.fetchedAt, notes, tz, latest: { current } });
    }
    if (want === 'ecb' && e.why && !indexErr) amber(`ECB rate file: ${e.why}; the rates come from frankfurter.dev instead.`);

    // 3. frankfurter.dev alone: the period (from a few days before its first date, for the rate it carries in), then the
    // latest rate when the period has ended
    const hi = needTo < todayU ? needTo : todayU, lo0 = TZ.addDays(fromKey, -LOOKBACK), lo = lo0 < hi ? lo0 : hi;
    const table = FX.fromEcb(FX.fromFrankfurter(await FX.frankfurter(io, `${lo}..${hi}?symbols=${syms(ccy)}`, hi >= todayU)), ccy);
    let latest = null;
    if (past) {
      try {
        const l = FX.fromEcb(FX.fromFrankfurter(await FX.frankfurter(io, `latest?symbols=${syms(ccy)}`, true)), ccy);
        if (!l.d.length) throw new Error('no rate');
        latest = { r: l.r[0], date: l.d[0], ref: null, label: l.d[0], current: true };
      } catch (err) { if (T.isAbort(err)) throw err; latest = { current: false, inPeriod: true }; }
    }
    return FX.rates({ ccy, id: 'ecb', via: 'frankfurter', table, notes, tz, latest });
  };

  /**
   * The USDe/USD daily price (the lots' market valuation): the file the deploy publishes (data/fx/usde-usd.json), else
   * DefiLlama read from the browser, cached in sessionStorage as {at, raw} for an hour (one small GET). o: {tz, now,
   * signal, fetch, storage}. Returns FX.usdePrices(…) with via 'file' or 'defillama'; throws when neither can be read
   * (the card then values at par and says so).
   */
  FX.usde = async function (o = {}) {
    const tz = o.tz || 'UTC';
    const io = { fetch: o.fetch || ((...a) => fetch(...a)), storage: o.storage !== undefined ? o.storage : session(), now: o.now != null ? o.now : Date.now(), signal: o.signal };
    const notes = [];
    let index = null;
    try { index = await indexOf(io); } catch (_) {}
    const meta = index && index.files && index.files.usde;
    if (meta) {
      try {
        const json = await fileOf(io, meta);
        const table = FX.usdeTable(json);
        if (table.d.length) return FX.usdePrices(table, tz, { via: 'file', fetchedAt: json.fetchedAt || meta.fetchedAt || null, notes });
      } catch (e) { if (T.isAbort(e)) throw e; notes.push('The published USDe price file could not be read (' + e.message + '); the price comes from DefiLlama directly.'); }
    }
    const S = FX.USDE, today = TZ.dayKey(io.now, 'UTC');
    const key = 'md.usde1.' + today;
    let raw = null;
    try { const c = io.storage ? JSON.parse(io.storage.getItem(key) || 'null') : null; if (c && c.raw && typeof c.at === 'number' && io.now - c.at < HOUR) raw = c.raw; } catch (_) {}
    if (!raw) {
      const span = Math.round((TZ.keyMs(today) - TZ.keyMs(S.floor)) / 86400000) + 2;
      const r = await io.fetch(`https://coins.llama.fi/chart/${S.coin}?start=${TZ.keyMs(S.floor) / 1000}&span=${span}&period=1d&searchWidth=600`, { signal: io.signal });
      if (!r.ok) throw new Error('DefiLlama answered ' + r.status);
      raw = await r.json();
      try { if (io.storage) io.storage.setItem(key, JSON.stringify({ at: io.now, raw })); } catch (_) {}
    }
    return FX.usdePrices(FX.usdeTable(FX.fromLlama(raw)), tz, { via: 'defillama', fetchedAt: new Date(io.now).toISOString(), notes });
  };
})();
