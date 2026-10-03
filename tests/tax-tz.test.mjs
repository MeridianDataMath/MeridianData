// Tax center time zones (MD.tax.tz): local midnights as exact UTC instants, DST on both sides, zones whose DST change
// skips midnight, 45-minute offsets, local dates and the one-year holding test. The instants are the ones the audit
// computed with Intl for each fiscal-year start; a change that moves one moves a tax year.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { load, root } from './_load.mjs';

const TAX = fs.readdirSync(path.join(root, 'js/tax')).filter((f) => f.endsWith('.js'));
const ORDER = ['core.js', 'tz.js', 'periods.js', 'fx.js', 'ledger.js', 'load.js', 'fills.js', 'funding.js', 'predict.js', 'lots.js', 'holdings.js', 'summary.js', 'methodology.js', 'zip.js', 'exports.js', 'ui.js'];
const MD = load(['js/util.js', 'js/api.js', 'js/predict/api.js', 'js/predict/analytics.js', ...ORDER.filter((f) => TAX.includes(f)).map((f) => 'js/tax/' + f)]);
const TZ = MD.tax.tz;
const iso = (t) => new Date(t).toISOString().replace('.000Z', 'Z');

test('every js/tax module loads in Node without a DOM, in the order index.html loads them', () => {
  // the view-* modules build the page; the rest must stay loadable here (they are what the tests exercise)
  const pure = TAX.filter((f) => !/^view-/.test(f));
  assert.deepEqual(pure.filter((f) => !ORDER.includes(f)), [], 'a new js/tax module is missing from the load order above');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const tags = [...html.matchAll(/<script defer src="js\/tax\/([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(tags.filter((f) => ORDER.includes(f)), ORDER.filter((f) => TAX.includes(f)), 'index.html loads the tax modules in this order');
  assert.ok(html.indexOf('js/tax/core.js') < html.indexOf('js/pages/tax.js'), 'before the page');
  for (const k of ['tz', 'periods', 'ledger', 'load', 'ui']) assert.equal(typeof MD.tax[k], 'object', 'MD.tax.' + k);
  assert.equal(typeof MD.tax.DISCLAIMER, 'string');
  assert.match(MD.tax.DISCLAIMER, /not a tax adviser/);
});

test('fiscal-year starts at local midnight, as exact UTC instants', () => {
  const cases = [
    ['Europe/London', 2027, 3, 6, '2027-04-05T23:00:00Z'],
    ['Australia/Sydney', 2026, 6, 1, '2026-06-30T14:00:00Z'],
    ['Pacific/Auckland', 2027, 3, 1, '2027-03-31T11:00:00Z'],
    ['Asia/Kolkata', 2027, 3, 1, '2027-03-31T18:30:00Z'],
    ['Africa/Johannesburg', 2027, 2, 1, '2027-02-28T22:00:00Z'],
    ['Asia/Karachi', 2026, 6, 1, '2026-06-30T19:00:00Z'],
    ['Europe/Paris', 2027, 0, 1, '2026-12-31T23:00:00Z'],
    ['America/New_York', 2027, 0, 1, '2027-01-01T05:00:00Z'],
    ['America/St_Johns', 2027, 0, 1, '2027-01-01T03:30:00Z'],
    ['Asia/Tokyo', 2027, 0, 1, '2026-12-31T15:00:00Z'],
    ['UTC', 2027, 0, 1, '2027-01-01T00:00:00Z'],
  ];
  for (const [tz, y, m, d, want] of cases) assert.equal(iso(TZ.midnight(tz, y, m, d)), want, tz);
  assert.equal(iso(TZ.midnight('Europe/London', 2026, 12, 6)), '2027-01-06T00:00:00Z', 'month 12 is the next January');
});

test('both DST transition days: the day is 23 hours in spring and 25 in autumn', () => {
  const H = 3600000;
  const spring = TZ.midnight('Europe/London', 2027, 2, 28), afterSpring = TZ.midnight('Europe/London', 2027, 2, 29);
  assert.equal(iso(spring), '2027-03-28T00:00:00Z'); assert.equal(iso(afterSpring), '2027-03-28T23:00:00Z');
  assert.equal(afterSpring - spring, 23 * H);
  const autumn = TZ.midnight('Europe/London', 2026, 9, 25), afterAutumn = TZ.midnight('Europe/London', 2026, 9, 26);
  assert.equal(iso(autumn), '2026-10-24T23:00:00Z'); assert.equal(iso(afterAutumn), '2026-10-26T00:00:00Z');
  assert.equal(afterAutumn - autumn, 25 * H);
  // New York, the other way round
  assert.equal(TZ.midnight('America/New_York', 2027, 2, 15) - TZ.midnight('America/New_York', 2027, 2, 14), 23 * H);
  assert.equal(TZ.midnight('America/New_York', 2026, 10, 2) - TZ.midnight('America/New_York', 2026, 10, 1), 25 * H);
});

test('a DST change at midnight: the day starts at the change (01:00 local), or at the first of two midnights', () => {
  // Chile springs forward at 00:00 → 01:00 on 6 Sep 2026, Cuba on 14 Mar 2027: no 00:00 that day
  const cl = TZ.midnight('America/Santiago', 2026, 8, 6);
  assert.equal(iso(cl), '2026-09-06T04:00:00Z'); assert.equal(TZ.fmt(cl, 'America/Santiago'), '2026-09-06 01:00:00');
  assert.equal(TZ.dayKey(cl - 1000, 'America/Santiago'), '2026-09-05', 'a second earlier is still the day before');
  const cu = TZ.midnight('America/Havana', 2027, 2, 14);
  assert.equal(iso(cu), '2027-03-14T05:00:00Z'); assert.equal(TZ.fmt(cu, 'America/Havana', 'hm'), '01:00');
  // Cuba falls back at 01:00 → 00:00 on 1 Nov 2026: midnight happens twice, the day starts at the first
  assert.equal(iso(TZ.midnight('America/Havana', 2026, 10, 1)), '2026-11-01T04:00:00Z');
});

test('Chatham: +12:45 in winter, +13:45 in summer', () => {
  assert.equal(iso(TZ.midnight('Pacific/Chatham', 2026, 6, 1)), '2026-06-30T11:15:00Z');
  assert.equal(iso(TZ.midnight('Pacific/Chatham', 2027, 3, 1)), '2027-03-31T10:15:00Z');
  assert.equal(TZ.zoneLabel('Pacific/Chatham', Date.UTC(2026, 6, 1)), 'Pacific/Chatham, UTC+12:45');
  assert.equal(TZ.zoneLabel('Pacific/Chatham', Date.UTC(2027, 0, 1)), 'Pacific/Chatham, UTC+13:45');
  assert.equal(TZ.zoneLabel('America/St_Johns', Date.UTC(2027, 0, 1)), 'America/St_Johns, UTC-03:30');
  assert.equal(TZ.zoneLabel('UTC', 0), 'UTC');
});

test('local dates across DST, and month keys', () => {
  assert.equal(TZ.dayKey(Date.UTC(2026, 9, 25, 23, 30), 'Europe/London'), '2026-10-25', 'GMT again: 23:30 the same day');
  assert.equal(TZ.dayKey(Date.UTC(2026, 9, 24, 23, 30), 'Europe/London'), '2026-10-25', 'still BST: 00:30 the next day');
  assert.equal(TZ.dayKey(Date.UTC(2026, 2, 29, 23, 30), 'Europe/London'), '2026-03-30', 'BST: 00:30 the next day');
  assert.equal(TZ.dayKey(Date.UTC(2026, 2, 28, 23, 30), 'Europe/London'), '2026-03-28', 'GMT: the same day');
  assert.equal(TZ.dayKey(Date.UTC(2026, 11, 31, 23, 30), 'Europe/Paris'), '2027-01-01');
  assert.equal(TZ.monthKey(Date.UTC(2026, 11, 31, 23, 30), 'Europe/Paris'), '2027-01');
  assert.equal(TZ.dayKey(Date.UTC(2027, 0, 1, 3), 'America/New_York'), '2026-12-31');
  // the real claim the audit found: a loss claimed 2026-06-30T19:51:32Z is on 1 July in Sydney and in Karachi
  const claim = Date.parse('2026-06-30T19:51:32Z');
  assert.equal(TZ.dayKey(claim, 'Australia/Sydney'), '2026-07-01'); assert.equal(TZ.dayKey(claim, 'Asia/Karachi'), '2026-07-01');
  assert.equal(TZ.dayKey(claim, 'UTC'), '2026-06-30');
  assert.equal(TZ.addDays('2026-12-31', 1), '2027-01-01'); assert.equal(TZ.addDays('2028-03-01', -1), '2028-02-29');
  assert.equal(TZ.keyMs('2026-04-06'), Date.UTC(2026, 3, 6));
});

test('offsets are memoised per 15 minutes without crossing a change', () => {
  const tz = 'Europe/London', change = Date.UTC(2027, 2, 28, 1);   // 01:00 GMT → 02:00 BST
  assert.equal(TZ.offset(change - 1, tz), 0); assert.equal(TZ.offset(change, tz), 3600000);
  assert.equal(TZ.offset(change - 1, tz), 0, 'still right on a second look');
  assert.equal(TZ.offset(Date.UTC(2026, 6, 1), 'Asia/Kolkata'), 5.5 * 3600000);
  assert.equal(TZ.offset(Date.UTC(2026, 6, 1), 'UTC'), 0);
});

test('formats: ISO, MM/DD/YYYY for Form 8949, and readable dates', () => {
  const t = Date.UTC(2027, 0, 1, 3, 4, 5);
  assert.equal(TZ.fmt(t, 'America/New_York', 'us'), '12/31/2026');
  assert.equal(TZ.fmt(t, 'UTC', 'us'), '01/01/2027');
  assert.equal(TZ.fmt(t, 'America/New_York'), '2026-12-31 22:04:05');
  assert.equal(TZ.fmt(t, 'Europe/Paris', 'date'), '2027-01-01');
  assert.equal(TZ.fmt(t, 'Europe/Paris', 'short'), '1 Jan 2027');
  assert.equal(TZ.fmt(t, 'Europe/Paris', 'datetime'), '1 Jan 2027 04:04');
  assert.equal(TZ.fmt(t, 'Europe/Paris', 'dm'), '1 Jan');
  assert.equal(TZ.fmt(Date.UTC(2026, 3, 5, 23), 'Europe/London', 'hm'), '00:00', 'midnight reads 00, never 24');
});

test('held over a year: sold on or after the day after the anniversary, in local dates; 29 Feb ends on 28 Feb', () => {
  const at = (s) => Date.parse(s);
  assert.equal(TZ.heldOverYear(at('2026-01-15T12:00:00Z'), at('2027-01-15T12:00:00Z'), 'UTC'), false, 'the anniversary itself is not over a year');
  assert.equal(TZ.heldOverYear(at('2026-01-15T12:00:00Z'), at('2027-01-16T00:00:00Z'), 'UTC'), true);
  assert.equal(TZ.heldOverYear(at('2028-02-29T12:00:00Z'), at('2029-02-28T12:00:00Z'), 'UTC'), false);
  assert.equal(TZ.heldOverYear(at('2028-02-29T12:00:00Z'), at('2029-03-01T12:00:00Z'), 'UTC'), true);
  // the zone decides the dates: bought late on 15 Jan UTC is 16 Jan in Tokyo
  const buy = at('2026-01-15T23:30:00Z'), sell = at('2027-01-16T10:00:00Z');
  assert.equal(TZ.heldOverYear(buy, sell, 'UTC'), true);
  assert.equal(TZ.heldOverYear(buy, sell, 'Asia/Tokyo'), false);
});

test('held over a year, US reading (Form 8949): an acquisition on a month\'s last day is over a year only from the first day of the 13th month (Rev. Rul. 66-7)', () => {
  const at = (s) => Date.parse(s), held = (a, b, tz, rule) => TZ.heldOverYear(at(a), at(b), tz, rule);
  // 28 Feb 2027 is February's last day, and 2028 is a leap year: the only case where the two readings part
  assert.equal(held('2027-02-28T12:00:00Z', '2028-02-29T12:00:00Z', 'UTC'), true, 'the anniversary rule: 29 Feb 2028 is after 28 Feb');
  assert.equal(held('2027-02-28T12:00:00Z', '2028-02-29T12:00:00Z', 'UTC', 'us'), false, 'the US reading: not before 1 Mar 2028');
  assert.equal(held('2027-02-28T12:00:00Z', '2028-03-01T00:00:00Z', 'UTC', 'us'), true);
  // the ruling's own example, read for a year: acquired 30 Apr, over a year from 1 May
  assert.equal(held('2026-04-30T12:00:00Z', '2027-04-30T23:00:00Z', 'UTC', 'us'), false);
  assert.equal(held('2026-04-30T12:00:00Z', '2027-05-01T00:00:00Z', 'UTC', 'us'), true);
  // 29 Feb of a leap year is a month's last day too: over a year from 1 Mar under both
  for (const rule of [undefined, 'us']) {
    assert.equal(held('2028-02-29T12:00:00Z', '2029-02-28T12:00:00Z', 'UTC', rule), false, String(rule));
    assert.equal(held('2028-02-29T12:00:00Z', '2029-03-01T12:00:00Z', 'UTC', rule), true, String(rule));
    // 28 Feb of a leap year is not its month's last day: the anniversary is 28 Feb under both
    assert.equal(held('2028-02-28T12:00:00Z', '2029-02-28T12:00:00Z', 'UTC', rule), false, String(rule));
    assert.equal(held('2028-02-28T12:00:00Z', '2029-03-01T00:00:00Z', 'UTC', rule), true, String(rule));
    // a day that is not a month's last: the same under both
    assert.equal(held('2026-01-15T12:00:00Z', '2027-01-15T12:00:00Z', 'UTC', rule), false, String(rule));
    assert.equal(held('2026-01-15T12:00:00Z', '2027-01-16T00:00:00Z', 'UTC', rule), true, String(rule));
  }
  // local dates decide whether it is a month's last day: 1 Mar 2027 04:30 UTC is 28 Feb 23:30 in New York
  assert.equal(held('2027-03-01T04:30:00Z', '2028-03-01T12:00:00Z', 'America/New_York', 'us'), true, 'acquired 28 Feb (local), sold 1 Mar 2028');
  assert.equal(held('2027-03-01T04:30:00Z', '2028-03-01T03:00:00Z', 'America/New_York', 'us'), false, 'sold 29 Feb 2028 22:00 local');
  assert.equal(held('2027-03-01T04:30:00Z', '2028-03-01T12:00:00Z', 'UTC', 'us'), false, 'in UTC: acquired and sold on 1 Mar');
});

test('zones: validation, the browser list, and each preset\'s default', () => {
  assert.equal(TZ.valid('Europe/London'), true); assert.equal(TZ.valid('UTC'), true);
  assert.equal(TZ.valid('Mars/Olympus'), false); assert.equal(TZ.valid(''), false); assert.equal(TZ.valid(null), false);
  const l = TZ.list(); assert.equal(l[0], 'UTC'); assert.ok(l.includes('Europe/London')); assert.equal(l.filter((z) => z === 'UTC').length, 1);
  assert.equal(TZ.defaultFor('uk', 'America/New_York'), 'Europe/London');
  assert.equal(TZ.defaultFor('au', 'Australia/Perth'), 'Australia/Perth', 'Perth is 2 hours behind Sydney: the reader\'s own zone wins');
  assert.equal(TZ.defaultFor('au', 'Europe/Berlin'), 'Australia/Sydney');
  assert.equal(TZ.defaultFor('nz', 'Pacific/Chatham'), 'Pacific/Chatham');
  assert.equal(TZ.defaultFor('in', 'Asia/Calcutta'), 'Asia/Calcutta');
  assert.equal(TZ.defaultFor('za', 'Europe/London'), 'Africa/Johannesburg');
  assert.equal(TZ.defaultFor('pk', 'Asia/Karachi'), 'Asia/Karachi');
  assert.equal(TZ.defaultFor('cal', 'America/Chicago'), 'America/Chicago');
  assert.equal(TZ.defaultFor('cal', 'Nowhere/Land'), 'UTC');
});
