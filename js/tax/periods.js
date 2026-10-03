/* MeridianDataHub — Tax center periods: fiscal years and custom ranges as exact instants of local midnight in the
   chosen zone, their months and quarters, and the UTC days the exchange's daily ledger must be split on. Pure: no DOM,
   no network. */
(function () {
  const MD = window.MD; const U = MD.util; const T = MD.tax; const TZ = T.tz;
  const PER = (T.periods = {});
  const DAY = 86400000;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');

  /** A real calendar day written YYYY-MM-DD: 2026-02-30 and 2026-9-1 are refused, not rolled over. */
  PER.okDay = (s) => {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const t = Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
  };
  const dayOf = (tz, key) => TZ.midnight(tz, +key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10));
  /** 'YYYY-MM-DD HH:MM UTC' */
  PER.utc = (t) => new Date(U.num(t)).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

  PER.preset = (key) => (T.PRESETS[key] ? key : 'cal');
  PER.fyStart = (preset, y, tz) => { const p = T.PRESETS[preset]; return TZ.midnight(tz, y, p.m, p.d); };
  /** The year's name as its country writes it: 2026 (calendar), 2026/27 (UK, Australia, India), 2027 for a year named by
   *  its end (South Africa, New Zealand, Pakistan). y is always the calendar year the period starts in. */
  PER.yearName = (preset, y) => (preset === 'cal' ? String(y) : T.PRESETS[preset] && T.PRESETS[preset].endName ? String(y + 1) : `${y}/${String(y + 1).slice(2)}`);
  PER.fyLabel = (preset, y) => 'Tax year ' + PER.yearName(preset, y);

  /** Fiscal years (start years, newest first) that overlap [firstT, now]. */
  PER.years = ({ preset, tz, firstT, now }) => {
    const out = [];
    const y1 = TZ.parts(now, tz).y, y0 = TZ.parts(Math.min(firstT, now), tz).y - 1;
    for (let y = y1; y >= y0; y--) { const s = PER.fyStart(preset, y, tz), e = PER.fyStart(preset, y + 1, tz); if (s <= now && e > firstT) out.push(y); }
    if (!out.length) for (let y = y1; y >= y1 - 1; y--) if (PER.fyStart(preset, y, tz) <= now) { out.push(y); break; }
    return out;
  };

  /**
   * The report period from the URL's params (fy, year, from, to, tz). firstT: the wallet's first possible activity (its
   * subaccount's creation; Meridian Predict's launch is the floor, as Predict activity can predate the subaccount).
   * Returns {mode, preset, year, years, tz, tzGiven, start, end, now, label, fromKey, toKey, badRange, from, to, reqYear,
   * yearMissing, startText, endText, ongoing}: start and end are instants (end exclusive), from local midnight; a year
   * still running ends now. A custom range is local dates in tz, both inclusive; one that is not a real, ordered pair of
   * days falls back to the year (badRange). A requested year with no activity is not invented: the newest year is shown
   * and yearMissing says so.
   */
  PER.resolve = (params, o = {}) => {
    params = params || {};
    const now = o.now != null ? o.now : Date.now();
    const preset = PER.preset(params.fy);
    const tzGiven = TZ.valid(params.tz);
    const tz = tzGiven ? params.tz : TZ.defaultFor(preset, o.browserZone);
    const firstT = Math.min(o.firstT != null ? o.firstT : now, T.LAUNCH());
    const years = PER.years({ preset, tz, firstT, now });
    const pf = params.from || null, pt = params.to || null;
    const badRange = !!(pf || pt) && !(PER.okDay(pf) && PER.okDay(pt) && pf <= pt);
    const reqYear = /^\d{4}$/.test(String(params.year == null ? '' : params.year)) ? +params.year : null;
    let mode, year = null, start, end, label, fromKey, toKey;
    if (!badRange && pf && pt) {
      mode = 'custom'; start = dayOf(tz, pf); end = dayOf(tz, TZ.addDays(pt, 1)); label = pf + ' → ' + pt; fromKey = pf; toKey = pt;
    } else {
      mode = 'year'; year = years.includes(reqYear) ? reqYear : years[0];
      start = PER.fyStart(preset, year, tz); end = Math.min(PER.fyStart(preset, year + 1, tz), now); label = PER.fyLabel(preset, year);
      fromKey = TZ.dayKey(start, tz); toKey = TZ.dayKey(Math.max(start, end - 1), tz);
    }
    const text = (t) => (tz === 'UTC' ? PER.utc(t) : `${TZ.fmt(t, tz, 'datetime')} ${tz} (${PER.utc(t)})`);
    return {
      mode, preset, year, years, tz, tzGiven, start, end, now, label, fromKey, toKey, badRange, from: pf, to: pt, reqYear,
      yearMissing: mode === 'year' && reqYear != null && !years.includes(reqYear),
      startText: text(start), endText: (mode === 'year' && end === now ? 'now, ' : '') + text(end), ongoing: end >= now,
    };
  };

  /** Local calendar months overlapping the period: [{key, label, t0, t1, cut}], t0/t1 clipped to the period; cut says
   *  when the period cuts the month ('from 6 Apr', 'to 3 Oct'). */
  PER.months = (P) => {
    const out = []; const { tz, start, end } = P;
    if (!(end > start)) return out;
    let { y, m } = TZ.parts(start, tz);
    for (;;) {
      const ms = TZ.midnight(tz, y, m - 1, 1), me = TZ.midnight(tz, y, m, 1);
      if (ms >= end) break;
      const t0 = Math.max(ms, start), t1 = Math.min(me, end);
      const cut = [t0 > ms ? 'from ' + TZ.fmt(t0, tz, 'dm') : null, t1 < me ? 'to ' + TZ.fmt(t1 - 1, tz, 'dm') : null].filter(Boolean).join(' · ') || null;
      out.push({ key: `${y}-${pad(m)}`, label: MON[m - 1] + ' ' + y, t0, t1, cut });
      if (++m > 12) { m = 1; y++; }
    }
    return out;
  };
  /** Quarters: a fiscal year's run from its first local day in three-month steps (UK: 6 Apr – 5 Jul, 6 Jul – 5 Oct, …); a
   *  custom range uses calendar quarters. [{key, label, t0, t1, q0, q1}], t0/t1 clipped to the period. */
  PER.quarters = (P) => {
    const out = []; const { tz, start, end } = P;
    if (!(end > start)) return out;
    if (P.mode === 'year') {
      const p = T.PRESETS[P.preset];
      for (let i = 0; i < 4; i++) {
        const q0 = TZ.midnight(tz, P.year, p.m + 3 * i, p.d), q1 = TZ.midnight(tz, P.year, p.m + 3 * i + 3, p.d);
        if (q0 >= end) break;
        out.push({ key: P.year + '-Q' + (i + 1), label: 'Q' + (i + 1) + ' ' + PER.yearName(P.preset, P.year), t0: Math.max(q0, start), t1: Math.min(q1, end), q0, q1 });
      }
      return out;
    }
    let { y, m } = TZ.parts(start, tz); let q = Math.floor((m - 1) / 3);
    for (;;) {
      const q0 = TZ.midnight(tz, y, 3 * q, 1), q1 = TZ.midnight(tz, y, 3 * q + 3, 1);
      if (q0 >= end) break;
      out.push({ key: y + '-Q' + (q + 1), label: 'Q' + (q + 1) + ' ' + y, t0: Math.max(q0, start), t1: Math.min(q1, end), q0, q1 });
      if (++q > 3) { q = 0; y++; }
    }
    return out;
  };
  /** t → {mi, qi}: the month and quarter an instant falls in (-1 outside the period), by binary search. */
  PER.bucketer = (P, months, quarters) => {
    months = months || PER.months(P); quarters = quarters || PER.quarters(P);
    const find = (list, t) => { let lo = 0, hi = list.length - 1, r = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (list[mid].t0 <= t) { r = mid; lo = mid + 1; } else hi = mid - 1; } return r >= 0 && t < list[r].t1 ? r : -1; };
    return (t) => ({ mi: find(months, t), qi: find(quarters, t) });
  };
  /** Every instant the period's figures are cut at: its start, the month and quarter starts inside it, and its end when
   *  that has passed (a period still running ends now, where the data ends anyway). Ascending. */
  PER.boundaries = (P) => {
    if (!(P.end > P.start)) return [];
    const now = P.now != null ? P.now : Date.now();
    const set = new Set([P.start]);
    for (const x of PER.months(P)) set.add(x.t0);
    for (const x of PER.quarters(P)) set.add(x.t0);
    if (P.end < now) set.add(P.end);
    return Array.from(set).sort((a, b) => a - b);
  };
  /** The UTC days (their 00:00Z) that a boundary cuts: the exchange's daily ledger is split hour by hour on these. */
  PER.splitDays = (P) => Array.from(new Set(PER.boundaries(P).filter((b) => b % DAY !== 0).map((b) => Math.floor(b / DAY) * DAY))).sort((a, b) => a - b);
  /** The URL params that reproduce the period. */
  PER.params = (P) => ({ fy: P.preset === 'cal' ? null : P.preset, year: P.mode === 'year' ? P.year : null, from: P.mode === 'custom' ? P.fromKey : null, to: P.mode === 'custom' ? P.toKey : null, tz: P.tz });
})();
