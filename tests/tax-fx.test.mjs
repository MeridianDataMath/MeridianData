// Tax center exchange rates (MD.tax.fx): the files scripts/build-fx.mjs publishes (built here from answers captured once
// from the ECB, NBP and the Bank of Canada, through a fake network), each currency's source and convention, the
// fallbacks (NBP or Bank of Canada → ECB file → frankfurter.dev → USD), frankfurter's session cache with its 15-minute
// revalidation, and the money helpers: the rate and its date on every converted amount, compact amounts, the latest
// rate for figures with no date.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load, root, near } from './_load.mjs';
import { buildAll, parseEcb, ECB_URL, NBP_URL, BOC_URL } from '../scripts/build-fx.mjs';

const MD = load(['js/util.js', 'js/api.js', 'js/predict/api.js', 'js/predict/analytics.js', 'js/tax/core.js', 'js/tax/tz.js', 'js/tax/periods.js', 'js/tax/fx.js']);
const T = MD.tax, FX = T.fx, TZ = T.tz;
const fixture = (f) => fs.readFileSync(path.join(root, 'tests/fixtures/fx', f), 'utf8');
const NOW = Date.parse('2026-10-03T04:40:00Z');   // a Saturday morning: the newest rates are Friday's (2 Oct)

// the files a deploy at NOW publishes, from the captured answers
const PUBLISHED = await (async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-'));
  const bodies = {
    [ECB_URL('2026-09-14')]: fixture('ecb-2026-09-21_2026-10-02.csv'),
    [NBP_URL('2026-09-14', '2026-10-03')]: fixture('nbp-usd-2026-09-14_2026-10-02.json'),
    [BOC_URL('2026-09-14')]: fixture('boc-usdcad-2026-09-14_2026-10-02.json'),
  };
  await buildAll({ out, floor: '2026-09-14', today: '2026-10-03', now: NOW, fetchImpl: async (u) => ({ ok: !!bodies[u], status: bodies[u] ? 200 : 404, text: async () => bodies[u] }), wait: async () => {}, log: () => {}, warn: () => {} });
  const files = {}; for (const f of fs.readdirSync(out)) files[f] = JSON.parse(fs.readFileSync(path.join(out, f), 'utf8'));
  fs.rmSync(out, { recursive: true, force: true });
  return files;
})();
const FF = JSON.parse(fixture('frankfurter-usd-pln-2026-09-28_2026-10-03.json'));   // EUR base, USD and PLN, 28 Sep – 2 Oct

/** A fake network for the browser: data/fx/<file> from `files` (JSON), frankfurter.dev from `ff(path)`; anything else
 *  answers as Cloudflare does for a path it does not have: index.html with a 200. Records every request. */
function net({ files = PUBLISHED, ff = () => null } = {}) {
  const seen = [];
  const res = (status, type, body) => ({ ok: status === 200, status, headers: { get: (k) => (k.toLowerCase() === 'content-type' ? type : null) }, json: async () => JSON.parse(body) });
  const fetch = async (url, init = {}) => {
    seen.push({ url, cache: init.cache });
    if (url.startsWith('data/fx/')) { const f = files && files[url.slice(8)]; return f ? res(200, 'application/json; charset=utf-8', JSON.stringify(f)) : res(200, 'text/html; charset=utf-8', '<!doctype html>'); }
    if (url.startsWith('https://api.frankfurter.dev/v1/')) { const b = ff(url.slice(31)); return b ? res(200, 'application/json', JSON.stringify(b)) : res(404, 'application/json', '{"message":"not found"}'); }
    throw new Error('unexpected request ' + url);
  };
  return { fetch, seen };
}
const store = () => { const m = new Map(); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
const opts = (o) => Object.assign({ tz: 'Europe/Warsaw', fromKey: '2026-09-22', toKey: '2026-10-03', now: NOW, storage: store() }, o);
const at = (s) => Date.parse(s);

test('currencies: the 30 the sources publish (RON and ISK added), ISK without decimals; the source map', () => {
  assert.equal(T.CCY.length, 30);
  for (const c of ['RON', 'ISK', 'PLN', 'CAD', 'EUR']) assert.ok(T.CCY.includes(c), c);
  for (const c of ['PKR', 'EGP']) assert.ok(!T.CCY.includes(c), c);
  assert.equal(T.dp('ISK'), 0); assert.equal(T.dp('RON'), 2); assert.equal(T.dp('JPY'), 0);
  assert.equal(FX.sourceFor('PLN'), 'nbp'); assert.equal(FX.sourceFor('CAD'), 'boc'); assert.equal(FX.sourceFor('EUR'), 'ecb'); assert.equal(FX.sourceFor('GBP'), 'ecb');
  assert.equal(FX.sourceFor('PLN', 'ecb'), 'ecb'); assert.equal(FX.sourceFor('CAD', 'ecb'), 'ecb'); assert.equal(FX.sourceFor('EUR', 'nbp'), 'ecb');
  assert.deepEqual(FX.choices('PLN').map((x) => x.v), ['nbp', 'ecb']); assert.deepEqual(FX.choices('CAD').map((x) => x.v), ['boc', 'ecb']); assert.equal(FX.choices('EUR'), null);
});

test('ECB cross rates: (X per EUR) ÷ (USD per EUR) at full precision, 1 ÷ (USD per EUR) for EUR', () => {
  const e = PUBLISHED['ecb.json'];
  const eur = FX.fromEcb(e, 'EUR'), pln = FX.fromEcb(e, 'PLN'), jpy = FX.fromEcb(e, 'JPY');
  const i = eur.d.indexOf('2026-10-02');
  assert.equal(eur.r[i], 1 / 1.1225); assert.equal(pln.r[i], 4.3775 / 1.1225);
  assert.equal(jpy.r[i], e.rates.JPY[e.dates.indexOf('2026-10-02')] / 1.1225);
  assert.throws(() => FX.fromEcb(e, 'PKR'), /no PKR/);
  // frankfurter's answer (EUR base) gives the same table as the ECB file
  const ff = FX.fromEcb(FX.fromFrankfurter(FF), 'PLN');
  assert.deepEqual(ff.d, ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  ff.d.forEach((k, j) => assert.equal(ff.r[j], pln.r[pln.d.indexOf(k)]));
  assert.deepEqual(FX.fromFrankfurter({ base: 'EUR', date: '2026-10-02', rates: { USD: 1.1225, ISK: 137 } }), { dates: ['2026-10-02'], rates: { USD: [1.1225], ISK: [137] } });
});

test('NBP (PLN): the last table published before the event\'s local date, with its number', () => {
  const r = FX.rates({ ccy: 'PLN', id: 'nbp', via: 'file', table: FX.table(PUBLISHED['nbp-usd.json'], 'PLN'), tz: 'Europe/Warsaw' });
  // Monday 28 Sep: Friday 25 Sep's table
  assert.deepEqual(r.on(at('2026-09-28T10:00:00Z')), { r: 3.8404, date: '2026-09-25', ref: '187/A/NBP/2026', label: '2026-09-25 (187/A/NBP/2026)' });
  assert.equal(r.on(at('2026-09-28T10:00:00Z'), 'UTC').ref, '187/A/NBP/2026');
  // the same UTC day, either side of midnight in Warsaw (UTC+2): Friday 23:30 takes Thursday's table, Saturday 00:30 Friday's
  assert.equal(r.on(at('2026-09-25T21:30:00Z')).ref, '186/A/NBP/2026');
  assert.equal(r.on(at('2026-09-25T22:30:00Z')).ref, '187/A/NBP/2026');
  assert.equal(r.on(at('2026-09-25T22:30:00Z'), 'UTC').ref, '186/A/NBP/2026');   // the date is the zone's, not UTC's
  // a date that has its own table still takes the one before
  assert.equal(r.onKey('2026-10-02').ref, '191/A/NBP/2026');
  assert.equal(r.at(at('2026-10-02T12:00:00Z')), 3.8762);
  assert.equal(r.latest.ref, '192/A/NBP/2026'); assert.equal(r.latest.label, '2026-10-02 (192/A/NBP/2026)');
});

test('Bank of Canada (CAD): that day or the closest preceding one; 30 Sep (no rate) takes 29 Sep', () => {
  const r = FX.rates({ ccy: 'CAD', id: 'boc', via: 'file', table: FX.table(PUBLISHED['boc-usdcad.json'], 'CAD'), tz: 'America/Toronto' });
  assert.deepEqual(r.on(at('2026-09-30T15:00:00Z')), { r: 1.4188, date: '2026-09-29', ref: null, label: '2026-09-29' });
  assert.equal(r.on(at('2026-10-01T15:00:00Z')).r, 1.4243);
  assert.equal(r.on(at('2026-09-29T15:00:00Z')).r, 1.4188);
  // 30 Sep 23:30 in Toronto is 1 Oct in UTC: the local date decides
  assert.equal(r.on(at('2026-10-01T03:30:00Z')).date, '2026-09-29');
  assert.throws(() => FX.table(PUBLISHED['boc-usdcad.json'], 'PLN'), /not a PLN rate file/);
});

test('ECB: weekends and TARGET closing days (Good Friday, Easter Monday) use the previous business day\'s rate', () => {
  const e = parseEcb(fixture('ecb-usd-gbp-isk-2026-03-30_2026-04-08.csv'));
  const r = FX.rates({ ccy: 'GBP', id: 'ecb', via: 'file', table: FX.fromEcb(e, 'GBP'), tz: 'Europe/London' });
  for (const d of ['2026-04-02', '2026-04-03', '2026-04-04', '2026-04-05', '2026-04-06']) assert.deepEqual([d, r.onKey(d).date, r.onKey(d).r], [d, '2026-04-02', 0.87253 / 1.1525]);
  assert.equal(r.onKey('2026-04-07').date, '2026-04-07');
  // before the first rate: none, never the first one in its place (B2: no silent clamp)
  assert.deepEqual(r.onKey('2026-03-01'), { r: null, date: null, ref: null, label: FX.NO_RATE, none: true });
  assert.equal(r.first.date, '2026-03-30'); assert.deepEqual(Array.from(r.early), ['2026-03-01']);
  const isk = FX.rates({ ccy: 'ISK', id: 'ecb', via: 'file', table: FX.fromEcb(e, 'ISK') });
  assert.equal(isk.onKey('2026-04-06').r, 144.4 / 1.1525);
});

test('covers: a file holds a date\'s rate when it goes past it or was read after the rate is out', () => {
  const m = { from: '2026-06-01', to: '2026-10-02', fetchedAt: '2026-10-03T04:40:00.000Z' };
  assert.deepEqual(FX.covers(m, 'ecb', '2026-09-22', '2026-10-02'), { head: true, tail: 'ok' });
  assert.deepEqual(FX.covers(m, 'ecb', '2026-09-22', '2026-10-03'), { head: true, tail: 'provisional' });   // Saturday's rate is not out (nor will it be)
  assert.deepEqual(FX.covers(m, 'nbp', '2026-09-22', '2026-10-03'), { head: true, tail: 'ok' });   // NBP needs only the table before
  assert.deepEqual(FX.covers(m, 'ecb', '2026-09-22', '2026-10-05'), { head: true, tail: 'stale' });
  assert.deepEqual(FX.covers({ from: '2026-06-01', to: '2026-10-01', fetchedAt: '2026-10-02T15:00:00Z' }, 'ecb', '2026-09-22', '2026-10-02'), { head: true, tail: 'provisional' });
  assert.deepEqual(FX.covers({ from: '2026-06-01', to: '2026-10-01', fetchedAt: '2026-10-02T16:30:00Z' }, 'ecb', '2026-09-22', '2026-10-02'), { head: true, tail: 'ok' });   // no rate for 2 Oct by then: a closing day
  assert.deepEqual(FX.covers({ from: '2026-06-01', to: '2026-10-01', fetchedAt: '2026-10-02T16:30:00Z' }, 'boc', '2026-09-22', '2026-10-02'), { head: true, tail: 'provisional' });   // the Bank of Canada publishes later
  assert.equal(FX.covers(m, 'nbp', '2026-06-01', '2026-10-02').head, false);   // NBP needs a table before the first date
  assert.equal(FX.covers(m, 'ecb', '2026-06-01', '2026-10-02').head, true);
});

test('load: PLN from the published NBP file; CAD from the Bank of Canada; src=ecb and other currencies from the ECB file', async () => {
  T.cache.clear();
  const n = net();
  const pln = await FX.load(opts({ ccy: 'PLN', fetch: n.fetch }));
  assert.equal(pln.source, 'nbp'); assert.equal(pln.via, 'file'); assert.deepEqual(pln.notes, []);
  assert.equal(pln.on(at('2026-09-28T08:00:00Z')).label, '2026-09-25 (187/A/NBP/2026)');
  assert.equal(pln.latest.current, true); assert.equal(pln.fetchedAt, '2026-10-03T04:40:00.000Z');
  assert.deepEqual(n.seen.map((x) => x.url), ['data/fx/index.json', 'data/fx/nbp-usd.json']);
  assert.ok(n.seen.every((x) => x.cache === 'no-cache'));
  const cad = await FX.load(opts({ ccy: 'CAD', tz: 'America/Toronto', fetch: n.fetch }));
  assert.equal(cad.source, 'boc'); assert.equal(cad.on(at('2026-09-30T15:00:00Z')).r, 1.4188);
  // the index is read once per tab for a few minutes, each file once per deploy
  assert.equal(n.seen.filter((x) => x.url === 'data/fx/index.json').length, 1);
  const ecbPln = await FX.load(opts({ ccy: 'PLN', src: 'ecb', fetch: n.fetch, toKey: '2026-10-02', now: at('2026-10-02T18:00:00Z') }));
  assert.equal(ecbPln.source, 'ecb'); assert.equal(ecbPln.via, 'file');
  assert.equal(ecbPln.onKey('2026-10-02').r, 4.3775 / 1.1225);
  // 2 Oct 18:00 UTC: the file (read 3 Oct) holds that day's rate, so no request to frankfurter
  assert.ok(!n.seen.some((x) => /frankfurter/.test(x.url)));
  const eur = await FX.load(opts({ ccy: 'EUR', tz: 'Europe/Berlin', fetch: n.fetch, toKey: '2026-09-30' }));
  assert.equal(eur.onKey('2026-09-30').r, 1 / 1.1355);
  assert.equal(eur.latest.date, '2026-10-02'); assert.equal(eur.latest.current, true);   // the file reaches today: no extra request
  assert.equal(await FX.load(opts({ ccy: 'USD', fetch: n.fetch })), null);
});

test('load: NBP or Bank of Canada missing → the ECB file, with a note; a stale NBP file too', async () => {
  T.cache.clear();
  const files = Object.assign({}, PUBLISHED, { 'index.json': Object.assign({}, PUBLISHED['index.json'], { files: { ecb: PUBLISHED['index.json'].files.ecb } }) });
  const pln = await FX.load(opts({ ccy: 'PLN', fetch: net({ files }).fetch }));
  assert.equal(pln.source, 'ecb'); assert.equal(pln.via, 'file');
  assert.deepEqual(pln.notes.map((x) => x.text), ['NBP rates: not published by the last deploy; PLN is converted at the ECB\'s euro reference rates instead.']);
  assert.equal(pln.onKey('2026-09-28').r, 4.373 / 1.1378);   // same-day ECB, not NBP's day before
  // an NBP file read four days ago no longer covers a period that runs to today
  T.cache.clear();
  const old = JSON.parse(JSON.stringify(PUBLISHED));
  old['index.json'].files.nbp.fetchedAt = old['nbp-usd.json'].fetchedAt = '2026-09-29T04:40:00.000Z';
  old['nbp-usd.json'].dates = old['nbp-usd.json'].dates.slice(0, -4); old['nbp-usd.json'].rates = old['nbp-usd.json'].rates.slice(0, -4); old['nbp-usd.json'].tables = old['nbp-usd.json'].tables.slice(0, -4);
  const st = await FX.load(opts({ ccy: 'PLN', fetch: net({ files: old }).fetch }));
  assert.equal(st.source, 'ecb'); assert.equal(st.notes[0].text, 'NBP rates: the file ends on 2026-09-28 (read 2026-09-29T04:40:00.000Z), short of this period; PLN is converted at the ECB\'s euro reference rates instead.');
  // … but still covers a period that ended before it was read, and then its latest rate is not today's
  T.cache.clear();
  const ok = await FX.load(opts({ ccy: 'PLN', fetch: net({ files: old }).fetch, toKey: '2026-09-27' }));
  assert.equal(ok.source, 'nbp'); assert.equal(ok.latest.current, false);
  assert.equal(FX.money(ok, 'Europe/Warsaw').nowTag(), ' (at the last rate available, 2026-09-28 (188/A/NBP/2026))');
});

test('load: a period wholly before any activity (its first possible date after its last) needs no earlier rates', async () => {
  T.cache.clear();
  const r = await FX.load(opts({ ccy: 'PLN', fetch: net().fetch, fromKey: '2026-09-22', toKey: '2026-09-10' }));
  assert.equal(r.source, 'nbp'); assert.deepEqual(r.notes, []);
  assert.equal(r.onKey('2026-09-10').none, true, 'before the file\'s first table: no rate (nothing to convert on such a date), never the first table');
  T.cache.clear();
  const n = net({ files: null, ff: (p) => (p === '2026-09-10..2026-09-10?symbols=USD,PLN' ? { base: 'EUR', start_date: '2026-09-10', end_date: '2026-09-10', rates: { '2026-09-10': { USD: 1.17, PLN: 4.25 } } } : p === 'latest?symbols=USD,PLN' ? { base: 'EUR', date: '2026-10-02', rates: FF.rates['2026-10-02'] } : null) });
  const f = await FX.load(opts({ ccy: 'PLN', src: 'ecb', fetch: n.fetch, fromKey: '2026-09-22', toKey: '2026-09-10', storage: store() }));
  assert.equal(f.onKey('2026-09-10').r, 4.25 / 1.17); assert.equal(f.latest.date, '2026-10-02');
});

test('load: no published files (a local copy, or Cloudflare\'s index.html) → frankfurter.dev, EUR base, at full precision', async () => {
  T.cache.clear();
  const ff = (p) => (p.startsWith('2026-09-12..2026-10-03?symbols=USD,PLN') ? FF : null);
  const n = net({ files: null, ff });
  const r = await FX.load(opts({ ccy: 'PLN', fetch: n.fetch }));
  assert.equal(r.source, 'ecb'); assert.equal(r.via, 'frankfurter');
  assert.deepEqual(r.notes.map((x) => x.text), ['NBP rates: not published on this site; PLN is converted at the ECB\'s euro reference rates instead.']);
  assert.equal(r.onKey('2026-10-02').r, 4.3775 / 1.1225);
  assert.deepEqual(n.seen.map((x) => x.url), ['data/fx/index.json', 'https://api.frankfurter.dev/v1/2026-09-12..2026-10-03?symbols=USD,PLN']);
  assert.equal(n.seen[1].cache, 'no-cache');   // the range reaches today
  // the published ECB file without the currency: frankfurter, with a note
  T.cache.clear();
  const files = JSON.parse(JSON.stringify(PUBLISHED)); files['index.json'].files.ecb.currencies = ['USD', 'EUR']; delete files['index.json'].files.nbp;
  const r2 = await FX.load(opts({ ccy: 'PLN', src: 'ecb', fetch: net({ files, ff }).fetch, storage: store() }));
  assert.equal(r2.via, 'frankfurter'); assert.deepEqual(r2.notes.map((x) => x.text), ['ECB rate file: no PLN in the file; the rates come from frankfurter.dev instead.']);
  // after NBP's own note, the step from the ECB file to frankfurter (the same ECB rates) needs none
  T.cache.clear();
  const r4 = await FX.load(opts({ ccy: 'PLN', fetch: net({ files, ff }).fetch, storage: store() }));
  assert.equal(r4.via, 'frankfurter'); assert.deepEqual(r4.notes.map((x) => x.text), ['NBP rates: not published by the last deploy; PLN is converted at the ECB\'s euro reference rates instead.']);
  // EUR with nothing published (a local copy): no note, the line names frankfurter.dev
  T.cache.clear();
  const r3 = await FX.load(opts({ ccy: 'EUR', fetch: net({ files: null, ff: (p) => (p.startsWith('2026-09-12..2026-10-03?symbols=USD') ? FF : null) }).fetch, storage: store() }));
  assert.deepEqual(r3.notes, []); assert.equal(r3.onKey('2026-10-02').r, 1 / 1.1225);
  // nothing at all: the page reports in USD with a red note
  T.cache.clear();
  await assert.rejects(FX.load(opts({ ccy: 'PLN', fetch: net({ files: null }).fetch, storage: store() })), /frankfurter.dev answered 404/);
});

test('load: an ECB file older than the period needs gets its newest days from frankfurter', async () => {
  T.cache.clear();
  const old = JSON.parse(JSON.stringify(PUBLISHED));
  const cut = (a) => a.slice(0, -2);   // the file ends 30 Sep, read on 1 Oct
  old['ecb.json'].dates = cut(old['ecb.json'].dates); for (const c of Object.keys(old['ecb.json'].rates)) old['ecb.json'].rates[c] = cut(old['ecb.json'].rates[c]);
  old['ecb.json'].fetchedAt = old['index.json'].files.ecb.fetchedAt = '2026-10-01T04:00:00.000Z';
  const n = net({ files: old, ff: (p) => (p === '2026-10-01..?symbols=USD,PLN' ? { base: 'EUR', start_date: '2026-10-01', end_date: '2026-10-02', rates: { '2026-10-01': FF.rates['2026-10-01'], '2026-10-02': FF.rates['2026-10-02'] } } : null) });
  const r = await FX.load(opts({ ccy: 'PLN', src: 'ecb', fetch: n.fetch }));
  assert.equal(r.via, 'file+frankfurter'); assert.deepEqual(r.notes, []);
  assert.equal(r.onKey('2026-10-02').r, 4.3775 / 1.1225); assert.equal(r.onKey('2026-09-30').r, 4.369 / 1.1355);
  assert.equal(r.latest.date, '2026-10-02');
  // frankfurter down too: the file's last rate carries on, and the page says so
  T.cache.clear();
  const r2 = await FX.load(opts({ ccy: 'PLN', src: 'ecb', fetch: net({ files: old }).fetch, storage: store() }));
  assert.equal(r2.via, 'file'); assert.equal(r2.latest.current, false);
  assert.match(r2.notes[0].text, /published after 2026-09-30 could not be read/);
});

test('frankfurter cache (sessionStorage): {at, raw}; a range reaching today without today\'s rate is read again after 15 minutes', async () => {
  const s = store();
  let calls = [];
  const answer = (end) => ({ base: 'EUR', start_date: '2026-09-28', end_date: end, rates: {} });
  let end = '2026-10-01';
  const io = (now) => ({ now, storage: s, fetch: async (url, init) => { calls.push(init.cache); return { ok: true, status: 200, json: async () => answer(end) }; } });
  const t0 = at('2026-10-02T09:00:00Z');   // before the ECB publishes 2 Oct
  await FX.frankfurter(io(t0), '2026-09-28..2026-10-02?symbols=USD,PLN', true);
  assert.deepEqual(calls, ['no-cache']);
  const saved = JSON.parse(s.getItem('md.fx2.2026-09-28..2026-10-02?symbols=USD,PLN'));
  assert.equal(saved.at, t0); assert.equal(saved.raw.end_date, '2026-10-01');
  await FX.frankfurter(io(t0 + 14 * 60000), '2026-09-28..2026-10-02?symbols=USD,PLN', true);
  assert.equal(calls.length, 1);   // within 15 minutes: reused
  end = '2026-10-02';
  const raw = await FX.frankfurter(io(t0 + 15 * 60000), '2026-09-28..2026-10-02?symbols=USD,PLN', true);
  assert.deepEqual(calls, ['no-cache', 'no-cache']); assert.equal(raw.end_date, '2026-10-02');
  await FX.frankfurter(io(t0 + 120 * 60000), '2026-09-28..2026-10-02?symbols=USD,PLN', true);
  assert.equal(calls.length, 2);   // has today's rate now: kept
  // a past range is never read again, and asks the browser's cache first
  calls = [];
  await FX.frankfurter(io(t0), '2026-09-01..2026-09-30?symbols=USD,PLN', false);
  await FX.frankfurter(io(t0 + 86400000), '2026-09-01..2026-09-30?symbols=USD,PLN', false);
  assert.deepEqual(calls, ['default']);
  // an entry in the old format (the bare answer, no {at, raw}) is read again
  s.setItem('md.fx2.2026-08-01..2026-08-31?symbols=USD,PLN', JSON.stringify(answer('2026-08-31')));
  await FX.frankfurter(io(t0), '2026-08-01..2026-08-31?symbols=USD,PLN', false);
  assert.equal(calls.length, 2);
  assert.ok(JSON.parse(s.getItem('md.fx2.2026-08-01..2026-08-31?symbols=USD,PLN')).at === t0);
  // no storage (blocked): still works
  assert.equal((await FX.frankfurter({ now: t0, storage: null, fetch: io(t0).fetch }, 'x', true)).end_date, '2026-10-02');
});

test('load: a past period reads the latest rate on its own; when that fails, "now" figures use the period\'s last rate, said so', async () => {
  T.cache.clear();
  const aug = { base: 'EUR', start_date: '2026-08-21', end_date: '2026-08-31', rates: { '2026-08-28': { USD: 1.16, PLN: 4.26 }, '2026-08-31': { USD: 1.17, PLN: 4.27 } } };
  const ff = (p) => (p === '2026-08-21..2026-08-31?symbols=USD,PLN' ? aug : p === 'latest?symbols=USD,PLN' ? { base: 'EUR', date: '2026-10-02', rates: FF.rates['2026-10-02'] } : null);
  const n = net({ files: null, ff });
  const r = await FX.load(opts({ ccy: 'PLN', fetch: n.fetch, fromKey: '2026-08-31', toKey: '2026-08-31' }));
  assert.equal(r.onKey('2026-08-31').r, 4.27 / 1.17);
  assert.deepEqual([r.latest.date, r.latest.r, r.latest.current], ['2026-10-02', 4.3775 / 1.1225, true]);
  assert.deepEqual(n.seen.slice(1).map((x) => x.cache), ['default', 'no-cache']);
  const m = FX.money(r, 'Europe/Warsaw');
  assert.equal(m.now(100), m.fmt(100 * 4.3775 / 1.1225));
  assert.equal(m.nowTag(), ' · at the latest ECB rate (2026-10-02)');
  T.cache.clear();
  const r2 = await FX.load(opts({ ccy: 'PLN', fetch: net({ files: null, ff: (p) => (p.startsWith('2026-08-21') ? aug : null) }).fetch, fromKey: '2026-08-31', toKey: '2026-08-31', storage: store() }));
  assert.deepEqual([r2.latest.date, r2.latest.current, r2.latest.inPeriod], ['2026-08-31', false, true]);
  assert.equal(FX.money(r2, 'Europe/Warsaw').nowTag(), ' (at the last rate in the period)');
});

test('money.fmt compact: B, M and K steps, whole units from 1,000, a bare zero, an explicit dp honoured (USD, EUR, JPY, ISK)', () => {
  const R = (ccy) => FX.rates({ ccy, id: 'ecb', via: 'file', table: { d: ['2026-10-02'], r: [1], ref: null } });
  const usd = FX.money(null, 'UTC'), eur = FX.money(R('EUR'), 'UTC'), jpy = FX.money(R('JPY'), 'UTC'), isk = FX.money(R('ISK'), 'UTC');
  const c = { compact: true };
  const sp = (s) => s.replace(/\u00a0/g, ' ');   // Intl puts a no-break space after a code like ISK
  assert.deepEqual([3.47e9, 61467.58e6, 27700, 8498.05, 999.5, 0].map((v) => usd.fmt(v, c)), ['$3.47B', '$61.47B', '$27.7K', '$8,498', '$999.50', '$0']);
  assert.deepEqual([1.2e9, 3.47e6, 27700, 8498.05, 999.5, 0, -8498.05].map((v) => eur.fmt(v, c)), ['€1.20B', '€3.47M', '€27.7K', '€8,498', '€999.50', '€0', '-€8,498']);
  assert.deepEqual([1.5e9, 8498.05, 999.5, 0].map((v) => jpy.fmt(v, c)), ['¥1.50B', '¥8,498', '¥1,000', '¥0']);
  assert.deepEqual([4.858e9, 8498.05, 999.4, 0].map((v) => sp(isk.fmt(v, c))), ['ISK 4.86B', 'ISK 8,498', 'ISK 999', 'ISK 0']);
  assert.equal(eur.fmt(8498.05, { compact: true, dp: 2 }), '€8,498.05');   // the chart axis passes its own dp
  assert.equal(eur.fmt(0, { compact: true, dp: 2 }), '€0.00');
  assert.equal(eur.fmt(25, { compact: true, sign: true }), '+€25.00');
  // statements: cents (none for ISK and JPY), no "-€0.00"
  assert.equal(eur.fmt(-0.004), '€0.00'); assert.equal(eur.fmt(1234.567, { sign: true }), '+€1,234.57');
  assert.equal(sp(isk.fmt(1234.567)), 'ISK 1,235'); assert.equal(sp(isk.fmt(-0.4)), 'ISK 0');
  assert.equal(usd.fmt(1234.567), '$1,234.57');
});

test('money: every converted amount carries its rate and the rate\'s date; fx at the local date; the line names source and rule', async () => {
  const pln = FX.rates({ ccy: 'PLN', id: 'nbp', via: 'file', table: FX.table(PUBLISHED['nbp-usd.json'], 'PLN'), fetchedAt: '2026-10-03T04:40:00.000Z', tz: 'Europe/Warsaw' });
  const m = FX.money(pln, 'Europe/Warsaw');
  const cols = m.cols((r) => r.usd, (r) => r.t, 'Net');
  assert.deepEqual(cols.map((c) => c[0]), ['Net PLN', 'USD→PLN rate', 'Rate date (NBP table A)']);
  const row = { usd: 100, t: at('2026-09-28T10:00:00Z') };
  assert.deepEqual(cols.map((c) => c[1](row)), ['384.04', '3.8404', '2026-09-25 (187/A/NBP/2026)']);
  assert.deepEqual(cols.map((c) => c[1]({ usd: null, t: row.t })), ['', '', '']);
  assert.deepEqual(cols.map((c) => c[1]({ usd: -2.5, t: row.t }))[0], '-9.601');
  near(assert, m.fx(100, row.t), 384.04, 1e-9); assert.equal(m.fx(0, row.t), 0); assert.equal(m.rate(row.t), 3.8404);
  assert.equal(m.now(10), m.fmt(38.881));
  assert.equal(m.nowTag(), ' · at the latest NBP rate (2026-10-02 (192/A/NBP/2026))');
  const running = { start: at('2026-09-21T22:00:00Z'), end: NOW, now: NOW };
  assert.equal(m.line(running), 'Reported in PLN at NBP table A average rates: the table of the last business day before each local date, in Europe/Warsaw · latest 1 USD = 3.8881 PLN (2026-10-02 (192/A/NBP/2026)) · USD figures in every export');
  assert.match(m.line({ start: running.start, end: at('2026-09-27T22:00:00Z'), now: NOW }), /last rate in period 1 USD = 3\.8404 PLN \(2026-09-25 \(187\/A\/NBP\/2026\)\)/);
  const d = Object.fromEntries(m.describe());
  assert.match(d['Rate source'], /NBP table A average exchange rates · published by this site from NBP at deploy time \(read 2026-10-03T04:40:00.000Z\)/);
  assert.match(d['Rate rule'], /art\. 11a of the Polish PIT Act.*a Monday uses Friday's table.*local date in Europe\/Warsaw/);
  // the ECB's rule names the cross and the closing days; a high rate prints in full in the CSV
  const jpy = FX.rates({ ccy: 'JPY', id: 'ecb', via: 'frankfurter', table: FX.fromEcb(PUBLISHED['ecb.json'], 'JPY'), tz: 'Asia/Tokyo' });
  const mj = FX.money(jpy, 'Asia/Tokyo');
  assert.equal(mj.cols((r) => r, () => at('2026-10-02T03:00:00Z'), 'Net')[1][1](1), FX.rateCell(PUBLISHED['ecb.json'].rates.JPY.at(-1) / 1.1225));
  assert.match(Object.fromEntries(mj.describe())['Rate rule'], /\(X per EUR\) ÷ \(USD per EUR\).*TARGET holidays: 1 Jan, Good Friday, Easter Monday, 1 May, 25–26 Dec/);
  assert.match(mj.line(running), /^Reported in JPY at the ECB's euro reference rates, crossed through the euro \(via frankfurter\.dev\): each local date's rate, or the last ECB business day's before it/);
  // USD: no extra columns, amounts unchanged
  const usd = FX.money(null, 'UTC');
  assert.deepEqual(usd.cols((r) => r, (r) => r, 'Net'), []); assert.equal(usd.fx(5, 0), 5); assert.equal(usd.now(5), '$5.00'); assert.equal(usd.line(running), null); assert.equal(usd.nowTag(), '');
  assert.equal(FX.rateCell(4.3775 / 1.1225), '3.89977728285'); assert.equal(FX.rateText(16523.456), '16523.46');
});

test('a date before the first published rate has none: the amount stays unconverted, its cells blank and saying so, the Rate notes name the dates, never the first rate in its place (B2)', () => {
  const pln = FX.rates({ ccy: 'PLN', id: 'nbp', via: 'file', table: FX.table(PUBLISHED['nbp-usd.json'], 'PLN'), fetchedAt: '2026-10-03T04:40:00.000Z', tz: 'Europe/Warsaw' });
  const m = FX.money(pln, 'Europe/Warsaw'), early = at('2026-09-10T10:00:00Z'), first = pln.first;
  assert.equal(first.date, PUBLISHED['nbp-usd.json'].dates[0]);
  assert.equal(m.fx(100, early), null, 'no amount at a later rate'); assert.equal(m.fx(0, early), 0); assert.equal(m.rate(early), null);
  assert.deepEqual(m.rateOf(early), { r: null, date: null, ref: null, label: FX.NO_RATE, none: true });
  const cols = m.cols((r) => r.usd, (r) => r.t, 'Net');
  assert.deepEqual(cols.map((c) => c[1]({ usd: 100, t: early })), ['', '', FX.NO_RATE], 'blank amount and rate, the date cell says why');
  assert.deepEqual(cols.map((c) => c[1]({ usd: null, t: early })), ['', '', ''], 'a blank USD value stays blank');
  // NBP takes the table before the date: the first table's own date has none either, the next one has it
  assert.equal(m.rateOf(Date.parse(first.date + 'T10:00:00Z')).none, true);
  assert.equal(m.rateOf(Date.parse(TZ.addDays(first.date, 1) + 'T10:00:00Z')).date, first.date);
  assert.equal(FX.rateLine(m.rateOf(early), 'PLN'), FX.NO_RATE);
  assert.equal(FX.rateLine(m.rateOf(at('2026-09-28T08:00:00Z')), 'PLN'), '1 USD = 3.8404 PLN (2026-09-25 (187/A/NBP/2026))');
  // a period that ends before the first rate: the line says there is none
  assert.match(m.line({ start: at('2026-08-31T22:00:00Z'), end: at('2026-09-11T22:00:00Z'), now: NOW }), /· last rate in period: none, the period ends before the first published rate \(2026-09-1\d \(\d+\/A\/NBP\/2026\)\) · USD figures in every export$/);
  const d = Object.fromEntries(m.describe()), keys = Array.from(pln.early).sort();
  assert.match(d['Rate rule'], /a date before the first published rate \(.+\) has none: an amount there is left unconverted, never taken at a later rate$/);
  assert.equal(d['Rate notes'], `${keys.length} local date(s) before the first published rate (${first.label}) were asked for one, ${keys[0]} to ${keys[keys.length - 1]}: nothing is converted there (the cells are blank and say so).`);
  assert.ok(keys.includes('2026-09-10'));
  // nothing asked before it: no note
  const fresh = FX.money(FX.rates({ ccy: 'PLN', id: 'nbp', via: 'file', table: FX.table(PUBLISHED['nbp-usd.json'], 'PLN'), fetchedAt: 'x', tz: 'Europe/Warsaw' }), 'Europe/Warsaw');
  assert.equal(Object.fromEntries(fresh.describe())['Rate notes'], undefined);
});

test('rates reach back to the wallet\'s first possible activity, whatever the period: a July stake in an October report converts at July\'s rate (B2)', async () => {
  // Meridian Predict launched on 29 Jun 2026; a subaccount created after it, or none, starts there; one created before
  // it starts at its creation, in local dates
  assert.equal(FX.fromKey({ createdAt: Date.UTC(2026, 8, 21, 19), now: NOW, tz: 'UTC' }), '2026-06-29');
  assert.equal(FX.fromKey({ createdAt: null, now: NOW, tz: 'Europe/Berlin' }), '2026-06-29');
  assert.equal(FX.fromKey({ createdAt: Date.UTC(2026, 5, 20, 23), now: NOW, tz: 'Asia/Tokyo' }), '2026-06-21');
  // the reviewer's case: nothing published (a local copy), a report of 1–2 Oct in EUR. frankfurter is asked from ten days
  // before the launch, so the 26 Jul stake takes 24 Jul's rate (a Sunday: Friday's), not the period's first
  T.cache.clear();
  const span = { base: 'EUR', start_date: '2026-06-19', end_date: '2026-10-02', rates: { '2026-06-19': { USD: 1.15 }, '2026-07-24': { USD: 1.16 }, '2026-07-27': { USD: 1.17 }, '2026-09-21': { USD: 1.18 }, '2026-10-01': { USD: 1.19 }, '2026-10-02': { USD: 1.1225 } } };
  const n = net({ files: null, ff: (p) => (p === '2026-06-19..2026-10-02?symbols=USD' ? span : null) });
  const r = await FX.load(opts({ ccy: 'EUR', tz: 'UTC', fetch: n.fetch, fromKey: FX.fromKey({ createdAt: null, now: NOW, tz: 'UTC' }), toKey: '2026-10-02', storage: store() }));
  assert.equal(n.seen[1].url, 'https://api.frankfurter.dev/v1/2026-06-19..2026-10-02?symbols=USD');
  const stake = Date.parse('2026-07-26T08:03:50Z');
  assert.deepEqual([r.on(stake).date, r.on(stake).r], ['2026-07-24', 1 / 1.16]);
  assert.equal(FX.money(r, 'UTC').fx(25, stake), 25 / 1.16);
  assert.deepEqual(Array.from(r.early), [], 'nothing from the first activity on lacks a rate');
});
