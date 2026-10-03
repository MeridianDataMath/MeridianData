/* MeridianDataHub — Tax center time zones: local dates, local midnights and formatting in any IANA zone, from the
   browser's own time-zone data (Intl), so DST rules are never hard-coded. Every instant stays UTC milliseconds; only
   the reading of it is local. Pure: no DOM, no network. */
(function () {
  const MD = window.MD; const T = MD.tax;
  const TZ = (T.tz = {});
  const DAY = 86400000, SLOT = 900000;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n, w = 2) => String(n).padStart(w, '0');

  TZ.valid = (tz) => {
    if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (_) { return false; }
  };
  TZ.browser = () => { try { const z = Intl.DateTimeFormat().resolvedOptions().timeZone; return TZ.valid(z) ? z : 'UTC'; } catch (_) { return 'UTC'; } };
  /** UTC first, then every zone this browser knows (its list leaves UTC out, and may spell India Asia/Calcutta). */
  TZ.list = () => { let l = []; try { l = Intl.supportedValuesOf('timeZone'); } catch (_) {} return ['UTC'].concat(l.filter((z) => z !== 'UTC')); };
  /** A preset's zone: the browser's own when it belongs to that country, else the country's main zone; the calendar
   *  year (no country) takes the browser's. */
  TZ.defaultFor = (preset, browserZone) => {
    const p = T.PRESETS[preset] || T.PRESETS.cal;
    const b = TZ.valid(browserZone) ? browserZone : null;
    if (!p.zone) return b || 'UTC';
    return b && p.zoneMatch && p.zoneMatch.test(b) ? b : p.zone;
  };

  // one formatter per zone (building one is slow), hourCycle h23 so midnight reads 00, never 24
  const fmts = new Map(), memo = new Map();
  const fmtOf = (tz) => {
    let f = fmts.get(tz);
    if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }); fmts.set(tz, f); }
    return f;
  };
  /** Offset (ms) of the zone at instant t: local wall time = t + offset. Offsets change only on a 15-minute UTC boundary,
   *  so one lookup per 15-minute slot serves every event in it (tens of thousands of fills share a few thousand slots). */
  TZ.offset = (t, tz) => {
    if (tz === 'UTC') return 0;
    let m = memo.get(tz); if (!m) { m = new Map(); memo.set(tz, m); }
    const slot = Math.floor(t / SLOT);
    let o = m.get(slot);
    if (o === undefined) {
      const s = slot * SLOT; const p = {};
      for (const x of fmtOf(tz).formatToParts(new Date(s))) p[x.type] = x.value;
      o = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - s;
      if (m.size > 200000) m.clear();
      m.set(slot, o);
    }
    return o;
  };
  /** Local calendar fields of instant t: {y, m (1-12), d, H, M, S, dow}. */
  TZ.parts = (t, tz) => {
    const w = new Date(t + TZ.offset(t, tz));
    return { y: w.getUTCFullYear(), m: w.getUTCMonth() + 1, d: w.getUTCDate(), H: w.getUTCHours(), M: w.getUTCMinutes(), S: w.getUTCSeconds(), dow: w.getUTCDay() };
  };
  TZ.dayKey = (t, tz) => new Date(t + TZ.offset(t, tz)).toISOString().slice(0, 10);   // 'YYYY-MM-DD' of the local date
  TZ.monthKey = (t, tz) => TZ.dayKey(t, tz).slice(0, 7);
  /** A date key as UTC midnight: the index FX tables are kept by. */
  TZ.keyMs = (key) => Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10));
  TZ.addDays = (key, n) => new Date(TZ.keyMs(key) + n * DAY).toISOString().slice(0, 10);

  /** The first instant of local day (y, m, d) in tz; m is a month index as in Date.UTC and may overflow (m 12 = next
   *  January). Usually 00:00 local. Where a DST change skips midnight (America/Santiago, America/Havana) the day starts at
   *  the change, 01:00 local; where it repeats midnight, at the first one. */
  TZ.midnight = (tz, y, m, d) => {
    const target = Date.UTC(y, m, d);   // local 00:00 of that day, written as if it were UTC
    if (tz === 'UTC') return target;
    const key = new Date(target).toISOString().slice(0, 10);
    const cands = [target - TZ.offset(target - DAY, tz), target - TZ.offset(target + DAY, tz)];   // the offsets either side of a change that day
    let best = null;
    for (const c of cands) if (c + TZ.offset(c, tz) === target && (best == null || c < best)) best = c;
    if (best != null) return best;
    // midnight does not exist that day: search the gap for the first instant already on it
    let lo = Math.min(cands[0], cands[1]), hi = Math.max(cands[0], cands[1]);
    if (lo === hi) return lo;
    while (hi - lo > 1000) { const mid = Math.floor((lo + hi) / 2000) * 1000; if (TZ.dayKey(mid, tz) >= key) hi = mid; else lo = mid; }
    return hi;
  };

  /** t in tz: 'iso' 2026-04-06 00:00:00 · 'date' 2026-04-06 · 'us' 04/06/2026 · 'short' 6 Apr 2026 · 'datetime' 6 Apr 2026 00:00 ·
   *  'dm' 6 Apr · 'hm' 00:00 */
  TZ.fmt = (t, tz, kind = 'iso') => {
    const p = TZ.parts(t, tz);
    const date = `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}`, hm = `${pad(p.H)}:${pad(p.M)}`;
    switch (kind) {
      case 'date': return date;
      case 'us': return `${pad(p.m)}/${pad(p.d)}/${pad(p.y, 4)}`;
      case 'short': return `${p.d} ${MON[p.m - 1]} ${p.y}`;
      case 'datetime': return `${p.d} ${MON[p.m - 1]} ${p.y} ${hm}`;
      case 'dm': return `${p.d} ${MON[p.m - 1]}`;
      case 'hm': return hm;
      default: return `${date} ${hm}:${pad(p.S)}`;
    }
  };
  TZ.offsetLabel = (ms) => { const a = Math.abs(ms) / 60000; return 'UTC' + (ms < 0 ? '-' : '+') + pad(Math.floor(a / 60)) + ':' + pad(Math.round(a % 60)); };
  /** 'Europe/London, UTC+01:00' at instant t (the offset changes with DST); plain 'UTC' for UTC. */
  TZ.zoneLabel = (tz, t) => (tz === 'UTC' ? 'UTC' : tz + ', ' + TZ.offsetLabel(TZ.offset(t == null ? Date.now() : t, tz)));

  /** Held more than a year, counted in local dates: sold on or after the day after the acquisition's anniversary. An
   *  anniversary that does not exist (29 Feb) is the last day of that month (28 Feb). rule 'us' (the Form 8949
   *  statement) also reads Rev. Rul. 66-7 for one year: an acquisition on the last day of a month is held more than a
   *  year only from the first day of the 13th month after it, so its anniversary is that month's last day a year later.
   *  That differs only for 28 Feb before a leap year: a sale on 29 Feb is then not yet over a year. */
  TZ.heldOverYear = (acqT, soldT, tz, rule) => {
    const a = TZ.parts(acqT, tz);
    const last = new Date(Date.UTC(a.y + 1, a.m, 0)).getUTCDate();   // days in that month a year later
    const monthEnd = a.d === new Date(Date.UTC(a.y, a.m, 0)).getUTCDate();
    const d = rule === 'us' && monthEnd ? last : Math.min(a.d, last);
    return TZ.dayKey(soldT, tz) > `${pad(a.y + 1, 4)}-${pad(a.m)}-${pad(d)}`;
  };
})();
