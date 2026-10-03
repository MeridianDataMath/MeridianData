// Tax center periods (MD.tax.periods): fiscal years and custom ranges in local time, official year names, quarters
// in local dates, the UTC days a boundary cuts, and links that ask for something impossible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_load.mjs';

const MD = load(['js/util.js', 'js/api.js', 'js/predict/api.js', 'js/predict/analytics.js', 'js/tax/core.js', 'js/tax/tz.js', 'js/tax/periods.js']);
const PER = MD.tax.periods, TZ = MD.tax.tz;
const iso = (t) => new Date(t).toISOString().replace('.000Z', 'Z');
const LATER = Date.UTC(2030, 0, 1);   // a "now" after every period below, so years end at their next start

test('okDay: a real day written YYYY-MM-DD, nothing rolled over', () => {
  for (const s of ['2026-01-01', '2028-02-29', '2026-12-31']) assert.equal(PER.okDay(s), true, s);
  for (const s of ['2026-02-30', '2026-04-31', '2027-02-29', '2026-13-01', '2026-9-1', '2026-09-1', '', null, undefined, '20260101', '2026-01-01T00:00']) assert.equal(PER.okDay(s), false, String(s));
});

test('UK quarters run 6 Apr – 5 Jul … in local time, BST and GMT alike', () => {
  const P = PER.resolve({ fy: 'uk', year: '2026', tz: 'Europe/London' }, { now: LATER, firstT: Date.UTC(2026, 7, 1) });
  assert.equal(P.mode, 'year'); assert.equal(P.label, 'Tax year 2026/27');
  assert.equal(iso(P.start), '2026-04-05T23:00:00Z'); assert.equal(iso(P.end), '2027-04-05T23:00:00Z');
  assert.deepEqual(PER.quarters(P).map((q) => [q.label, iso(q.t0), iso(q.t1)]), [
    ['Q1 2026/27', '2026-04-05T23:00:00Z', '2026-07-05T23:00:00Z'],
    ['Q2 2026/27', '2026-07-05T23:00:00Z', '2026-10-05T23:00:00Z'],
    ['Q3 2026/27', '2026-10-05T23:00:00Z', '2027-01-06T00:00:00Z'],
    ['Q4 2026/27', '2027-01-06T00:00:00Z', '2027-04-05T23:00:00Z'],
  ]);
  assert.equal(TZ.fmt(PER.quarters(P)[0].t1 - 1, 'Europe/London', 'short'), '5 Jul 2026', 'the first quarter ends on 5 Jul');
  const months = PER.months(P);
  assert.equal(months.length, 13, 'April is cut in two by the 6th: Apr 2026 (from 6 Apr) … Apr 2027 (to 5 Apr)');
  assert.equal(months[0].label, 'Apr 2026'); assert.equal(months[0].cut, 'from 6 Apr');
  assert.equal(months[12].label, 'Apr 2027'); assert.equal(months[12].cut, 'to 5 Apr');
  assert.equal(iso(months[1].t0), '2026-04-30T23:00:00Z', 'May starts at local midnight');
  assert.equal(iso(months[7].t0), '2026-11-01T00:00:00Z', 'November is on GMT');
});

test('splitDays: the UTC days whose boundary is not at 00:00 UTC', () => {
  const P = PER.resolve({ fy: 'uk', year: '2026', tz: 'Europe/London' }, { now: LATER });
  assert.deepEqual(PER.splitDays(P).map((t) => iso(t).slice(0, 10)), [
    '2026-04-05', '2026-04-30', '2026-05-31', '2026-06-30', '2026-07-05', '2026-07-31', '2026-08-31', '2026-09-30', '2026-10-05',   // BST months and quarters
    '2027-03-31', '2027-04-05',   // BST again from 28 Mar 2027, and the end
  ]);
  assert.deepEqual(PER.splitDays(PER.resolve({ tz: 'UTC', year: '2026' }, { now: LATER })), [], 'UTC needs no split');
  // a year still running ends now, where the data ends: its end is no boundary
  const open = PER.resolve({ fy: 'cal', year: '2026', tz: 'Europe/Paris' }, { now: Date.UTC(2026, 9, 3, 4) });
  assert.equal(open.end, Date.UTC(2026, 9, 3, 4)); assert.equal(open.ongoing, true); assert.match(open.endText, /^now, /);
  assert.ok(!PER.boundaries(open).includes(open.end));
  assert.equal(iso(PER.boundaries(open)[0]), '2025-12-31T23:00:00Z');
});

test('year names: each country\'s own (B38 / G20); the URL year stays the start year', () => {
  const name = (fy, y) => [PER.fyLabel(fy, y), PER.yearName(fy, y)];
  assert.deepEqual(name('cal', 2026), ['Tax year 2026', '2026']);
  assert.deepEqual(name('uk', 2026), ['Tax year 2026/27', '2026/27']);
  assert.deepEqual(name('au', 2026), ['Tax year 2026/27', '2026/27']);
  assert.deepEqual(name('in', 2026), ['Tax year 2026/27', '2026/27']);
  assert.deepEqual(name('za', 2026), ['Tax year 2027', '2027'], 'SARS: the 2027 year of assessment runs 1 Mar 2026 – 28 Feb 2027');
  assert.deepEqual(name('nz', 2026), ['Tax year 2027', '2027']);
  assert.deepEqual(name('pk', 2026), ['Tax year 2027', '2027'], 'ITO 2001 s74: named by the year 30 June falls in');
  const za = PER.resolve({ fy: 'za', year: '2026' }, { now: LATER, browserZone: 'Europe/Berlin' });
  assert.equal(za.year, 2026); assert.equal(za.label, 'Tax year 2027'); assert.equal(za.tz, 'Africa/Johannesburg');
  assert.equal(iso(za.start), '2026-02-28T22:00:00Z');
  assert.deepEqual(PER.quarters(za).map((q) => q.label), ['Q1 2027', 'Q2 2027', 'Q3 2027', 'Q4 2027']);
  assert.deepEqual(PER.params(za), { fy: 'za', year: 2026, from: null, to: null, tz: 'Africa/Johannesburg' });
  assert.equal(PER.resolve({ fy: 'eg' }, { now: LATER, browserZone: 'UTC' }).preset, 'cal', 'old fy=eg links get the calendar year');
});

test('a claim at 2026-06-30T19:51 UTC is in the Australian and Pakistani year that starts on 1 July (G20)', () => {
  const now = Date.UTC(2026, 9, 3);
  const claims = [Date.parse('2026-06-30T19:51:32Z'), Date.parse('2026-06-30T19:51:34Z')];   // 0x0dc63a9b… and 0x131e278c…
  const firstT = Date.parse('2026-09-15T18:12:57Z');   // the owner's perps subaccount came later
  const within = (P) => claims.map((t) => t >= P.start && t < P.end);
  const au = PER.resolve({ fy: 'au', year: '2026', tz: 'Australia/Sydney' }, { now, firstT });
  assert.equal(au.label, 'Tax year 2026/27'); assert.deepEqual(within(au), [true, true]);
  const au25 = PER.resolve({ fy: 'au', year: '2025', tz: 'Australia/Sydney' }, { now, firstT });
  assert.equal(au25.year, 2025, 'the year before the subaccount is still offered: Predict launched first (B13)');
  assert.equal(au25.yearMissing, false); assert.deepEqual(within(au25), [false, false]);
  const pk = PER.resolve({ fy: 'pk', year: '2026', tz: 'Asia/Karachi' }, { now, firstT });
  assert.equal(pk.label, 'Tax year 2027'); assert.deepEqual(within(pk), [true, true]);
  assert.deepEqual(within(PER.resolve({ fy: 'pk', year: '2025', tz: 'Asia/Karachi' }, { now, firstT })), [false, false]);
  // in UTC the same claims are on 30 June: the year before
  assert.deepEqual(within(PER.resolve({ fy: 'au', year: '2025', tz: 'UTC' }, { now, firstT })), [true, true]);
});

test('the year list starts at Meridian Predict\'s launch at the latest; a year with no activity is not invented (B13)', () => {
  const now = Date.UTC(2026, 9, 3), firstT = Date.parse('2026-09-15T18:12:57Z');
  assert.deepEqual(PER.resolve({ fy: 'au', tz: 'Australia/Sydney' }, { now, firstT }).years, [2026, 2025]);
  assert.deepEqual(PER.resolve({ fy: 'cal', tz: 'UTC' }, { now, firstT }).years, [2026]);
  const old = PER.resolve({ fy: 'au', year: '2019', tz: 'Australia/Sydney' }, { now, firstT });
  assert.equal(old.yearMissing, true); assert.equal(old.reqYear, 2019); assert.equal(old.year, 2026, 'shows the newest year');
  const future = PER.resolve({ year: '2031', tz: 'UTC' }, { now, firstT });
  assert.equal(future.yearMissing, true); assert.equal(future.year, 2026);
  assert.equal(PER.resolve({ year: 'abc', tz: 'UTC' }, { now, firstT }).yearMissing, false, 'garbage is ignored, not reported as a year');
  assert.equal(PER.resolve({ year: '2026', tz: 'UTC' }, { now, firstT }).yearMissing, false);
});

test('custom ranges are local dates; an invalid or reversed one falls back to the year (B32)', () => {
  const now = Date.UTC(2026, 9, 3);
  const c = PER.resolve({ from: '2026-09-01', to: '2026-09-30', tz: 'America/New_York' }, { now });
  assert.equal(c.mode, 'custom'); assert.equal(c.badRange, false); assert.equal(c.label, '2026-09-01 → 2026-09-30');
  assert.equal(iso(c.start), '2026-09-01T04:00:00Z'); assert.equal(iso(c.end), '2026-10-01T04:00:00Z');
  assert.equal(c.fromKey, '2026-09-01'); assert.equal(c.toKey, '2026-09-30');
  assert.deepEqual(PER.quarters(c).map((q) => q.label), ['Q3 2026'], 'a custom range uses calendar quarters');
  for (const [from, to] of [['2026-09-10', '2026-09-01'], ['2026-02-30', '2026-03-05'], ['2026-09-01', null], [null, '2026-09-01'], ['2026-9-1', '2026-09-30']]) {
    const P = PER.resolve({ from, to, fy: 'uk', tz: 'Europe/London' }, { now });
    assert.equal(P.badRange, true, from + ' → ' + to); assert.equal(P.mode, 'year'); assert.equal(P.label, 'Tax year 2026/27');
    assert.ok(P.end > P.start); assert.equal(P.fromKey, '2026-04-06', 'the inputs show the year, never the rejected range');
  }
  const one = PER.resolve({ from: '2026-10-25', to: '2026-10-25', tz: 'Europe/London' }, { now: LATER });
  assert.equal(one.end - one.start, 25 * 3600000, 'a single day: the 25-hour one when the clocks go back');
});

test('the zone: the URL\'s when valid, else the preset\'s default for this browser', () => {
  const now = Date.UTC(2026, 9, 3);
  const a = PER.resolve({ fy: 'uk' }, { now, browserZone: 'America/New_York' });
  assert.equal(a.tz, 'Europe/London'); assert.equal(a.tzGiven, false);
  const b = PER.resolve({ fy: 'uk', tz: 'Mars/Base' }, { now, browserZone: 'America/New_York' });
  assert.equal(b.tz, 'Europe/London', 'an invalid zone in a link is replaced');
  const c = PER.resolve({ fy: 'uk', tz: 'UTC' }, { now, browserZone: 'Europe/London' });
  assert.equal(c.tz, 'UTC'); assert.equal(c.tzGiven, true); assert.equal(iso(c.start), '2026-04-06T00:00:00Z');
  assert.match(a.startText, /^6 Apr 2026 00:00 Europe\/London \(2026-04-05 23:00 UTC\)$/);
  assert.equal(c.startText, '2026-04-06 00:00 UTC');
});

test('bucketer: months and quarters by binary search over local boundaries', () => {
  const P = PER.resolve({ fy: 'in', year: '2026', tz: 'Asia/Kolkata' }, { now: LATER });
  const b = PER.bucketer(P);
  const months = PER.months(P);
  assert.equal(months.length, 12); assert.equal(months[0].cut, null, 'India\'s year starts on the 1st: no cut month');
  assert.deepEqual(b(Date.parse('2026-04-30T18:29:59Z')), { mi: 0, qi: 0 }, 'still 30 Apr 23:59 in India');
  assert.deepEqual(b(Date.parse('2026-04-30T18:30:00Z')), { mi: 1, qi: 0 }, '1 May 00:00 in India');
  assert.deepEqual(b(Date.parse('2026-06-30T18:30:00Z')), { mi: 3, qi: 1 }, 'the second quarter');
  assert.deepEqual(b(Date.parse('2027-03-31T18:29:59Z')), { mi: 11, qi: 3 });
  assert.deepEqual(b(Date.parse('2027-03-31T18:30:00Z')), { mi: -1, qi: -1 }, 'the next year');
  assert.deepEqual(b(P.start - 1), { mi: -1, qi: -1 });
  assert.equal(PER.boundaries(P).filter((t) => t % 3600000).length, 13, 'every boundary sits at :30 UTC: start, 11 more months, end');
});
