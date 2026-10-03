// The deploy-time rate builder (scripts/build-fx.mjs): its parsers on answers captured once from the ECB (SDMX csvdata,
// detail=dataonly), NBP (table A, USD), the Bank of Canada (Valet FXUSDCAD) and DefiLlama (USDe/USD), the series checks, NBP's 367-day
// chunks, and a whole run against a fake fetch: files written, a failing source left out while the others are written,
// the index naming only what was written. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { root } from './_load.mjs';
import { parseCsv, parseEcb, parseNbp, parseBoc, parseLlama, check, chunks, get, buildAll, ECB_URL, NBP_URL, BOC_URL, LLAMA_URL, LLAMA_COIN, FLOOR } from '../scripts/build-fx.mjs';

const fx = (f) => fs.readFileSync(path.join(root, 'tests/fixtures/fx', f), 'utf8');
const ECB = fx('ecb-2026-09-21_2026-10-02.csv'), EASTER = fx('ecb-usd-gbp-isk-2026-03-30_2026-04-08.csv');
const NBP = JSON.parse(fx('nbp-usd-2026-09-14_2026-10-02.json')), BOC = JSON.parse(fx('boc-usdcad-2026-09-14_2026-10-02.json')), LLAMA = JSON.parse(fx('defillama-usde-2026-09-14_2026-10-03.json'));

test('parseCsv: quoted fields, doubled quotes, CRLF and a byte-order mark', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x,1","say ""hi"""\n3,\n'), [['a', 'b'], ['x,1', 'say "hi"'], ['3', '']]);
});

test('parseEcb: every currency of the ECB answer, aligned by date, EUR base', () => {
  const e = parseEcb(ECB);
  assert.equal(Object.keys(e.rates).length, 29);   // with EUR itself, the 30 currencies the page offers besides USD's own
  for (const c of ['USD', 'PLN', 'CAD', 'GBP', 'JPY', 'RON', 'ISK', 'INR', 'IDR']) assert.ok(e.rates[c], c);
  assert.equal(e.dates[0], '2026-09-21'); assert.equal(e.dates.at(-1), '2026-10-02'); assert.equal(e.dates.length, 10);
  const i = e.dates.indexOf('2026-10-02');
  assert.equal(e.rates.USD[i], 1.1225); assert.equal(e.rates.PLN[i], 4.3775);
  for (const a of Object.values(e.rates)) assert.equal(a.length, e.dates.length);
  // Good Friday (3 Apr) and Easter Monday (6 Apr) 2026 are ECB closing days: no rows, so no dates
  const x = parseEcb(EASTER);
  assert.deepEqual(x.dates, ['2026-03-30', '2026-03-31', '2026-04-01', '2026-04-02', '2026-04-07', '2026-04-08']);
  assert.throws(() => parseEcb('A,B\n1,2\n'), /unexpected columns/);
  // an empty or NaN value is a day without a rate, not a zero
  const y = parseEcb('KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE\nk,D,USD,EUR,SP00,A,2026-09-01,1.1\nk,D,USD,EUR,SP00,A,2026-09-02,NaN\nk,D,JPY,EUR,SP00,A,2026-09-02,170\n');
  assert.deepEqual(y, { dates: ['2026-09-01', '2026-09-02'], rates: { JPY: [null, 170], USD: [1.1, null] } });
});

test('parseNbp keeps each table number; parseBoc has no row for 30 September (a Bank holiday)', () => {
  const n = parseNbp([NBP]);
  const i = n.dates.indexOf('2026-09-25');
  assert.equal(n.rates[i], 3.8404); assert.equal(n.tables[i], '187/A/NBP/2026');
  assert.equal(n.dates.length, 15); assert.equal(n.tables.at(-1), '192/A/NBP/2026');
  assert.throws(() => parseNbp([{ code: 'EUR', rates: [] }]), /not the USD series/);
  // two chunks that overlap give one row per date
  assert.equal(parseNbp([NBP, NBP]).dates.length, 15);
  const b = parseBoc(BOC);
  assert.ok(!b.dates.includes('2026-09-30'));
  assert.equal(b.rates[b.dates.indexOf('2026-09-29')], 1.4188);
  assert.equal(b.dates.length, 14);
});

test('parseLlama: DefiLlama\'s USDe points, one per UTC date (the midnight each is nearest to); the URL asks for daily points from the floor to today', () => {
  const u = parseLlama(LLAMA);
  assert.equal(u.symbol, 'USDe'); assert.equal(u.dates.length, 20);
  assert.deepEqual([u.dates[0], u.dates.at(-1)], ['2026-09-14', '2026-10-03']);
  for (const p of u.prices) assert.ok(p > 0.99 && p < 1.01);
  assert.deepEqual(check(u.dates, u.prices, { floor: '2026-09-14', today: '2026-10-03' }), []);
  assert.equal(parseLlama({ coins: { x: { prices: [{ timestamp: Date.UTC(2026, 5, 7, 23, 59, 59) / 1000, price: 1 }] } } }).dates[0], '2026-06-08');
  assert.throws(() => parseLlama({ coins: {} }), /no price series/);
  assert.equal(LLAMA_URL('2026-09-14', '2026-10-03'), 'https://coins.llama.fi/chart/' + LLAMA_COIN + '?start=1789344000&span=21&period=1d&searchWidth=600');
  assert.equal(LLAMA_COIN, 'ethereum:0x4c9EDD5852cd905f086C759E8383e09bff1E68B3');
});

test('check: the captured series pass; an implausible one is refused', () => {
  const opt = { floor: '2026-09-14', today: '2026-10-03' };
  const n = parseNbp([NBP]), b = parseBoc(BOC), e = parseEcb(ECB);
  assert.deepEqual(check(n.dates, n.rates, opt), []);
  assert.deepEqual(check(b.dates, b.rates, opt), []);
  for (const a of Object.values(e.rates)) assert.deepEqual(check(e.dates, a, { floor: '2026-09-21', today: '2026-10-03' }), []);
  const d = ['2026-09-01', '2026-09-02', '2026-09-03'];
  assert.match(check(d, [3.8, 3.8, 4.7], opt).join(), /moves 23\.7 %/);            // a 20 %+ day-to-day jump
  assert.match(check(d, [3.8, 0, 3.8], opt).join(), /not a positive number/);
  assert.match(check(d, [3.8, -1, 3.8], opt).join(), /not a positive number/);
  assert.match(check(['2026-09-02', '2026-09-01'], [1, 1], opt).join(), /not after/);
  assert.match(check(['2026-09-01', '2026-09-15'], [1, 1], opt).join(), /no rate for 14 days/);
  assert.match(check(['2026-09-14', '2026-09-15'], [1, 1], { floor: '2026-09-14', today: '2026-10-03' }).join(), /stale/);   // stopped publishing
  assert.match(check(['2026-09-30', '2026-10-01'], [1, 1], { floor: '2026-09-01', today: '2026-10-02' }).join(), /starts 2026-09-30/);
  assert.deepEqual(check([], [], opt), ['no observations']);
  assert.deepEqual(check(['2026-09-30', '2026-10-01', '2026-10-02'], [1, null, 1.1], { floor: '2026-09-28', today: '2026-10-02' }), []);   // a day the ECB did not publish that currency
});

test('chunks: NBP ranges of at most 367 days, both ends inclusive, covering the whole span', () => {
  assert.deepEqual(chunks('2026-06-01', '2026-10-03'), [['2026-06-01', '2026-10-03']]);
  const c = chunks('2026-06-01', '2028-01-10');
  assert.deepEqual(c, [['2026-06-01', '2027-06-02'], ['2027-06-03', '2028-01-10']]);
  for (const [a, b] of c) assert.ok((Date.parse(b) - Date.parse(a)) / 86400000 + 1 <= 367);
});

test('get: retries a 5xx and a network error, not a 4xx; a 404 can mean "no data"', async () => {
  const calls = [];
  const seq = (answers) => async (url) => { calls.push(url); const a = answers.shift(); if (a instanceof Error) throw a; return { ok: a.status === 200, status: a.status, text: async () => a.body }; };
  const wait = async () => {};
  assert.equal(await get('u', { fetchImpl: seq([{ status: 503 }, new Error('reset'), { status: 200, body: 'ok' }]), wait }), 'ok');
  assert.equal(calls.length, 3);
  calls.length = 0;
  await assert.rejects(get('u', { fetchImpl: seq([{ status: 400 }, { status: 200, body: 'x' }]), wait }), /HTTP 400/);
  assert.equal(calls.length, 1);
  assert.equal(await get('u', { fetchImpl: seq([{ status: 404 }]), wait, allow404: true }), null);
  await assert.rejects(get('u', { fetchImpl: seq([{ status: 500 }, { status: 500 }, { status: 500 }]), wait }), /HTTP 500/);
});

/** A fake network: the URL builders' exact URLs answer the fixtures (the NBP chunk ending today answers its file). */
function fakeNet(today, over = {}) {
  const answers = {
    [ECB_URL('2026-09-14')]: { status: 200, body: ECB },
    [NBP_URL('2026-09-14', today)]: { status: 200, body: JSON.stringify(NBP) },
    [BOC_URL('2026-09-14')]: { status: 200, body: JSON.stringify(BOC) },
    [LLAMA_URL('2026-09-14', today)]: { status: 200, body: JSON.stringify(LLAMA) },
    ...over,
  };
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); const a = answers[url] || { status: 404, body: '' }; return { ok: a.status === 200, status: a.status, text: async () => a.body }; };
  return { fetchImpl, seen };
}

test('buildAll: writes the four files and the index; GET only, with a user agent', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-'));
  const net = fakeNet('2026-10-03');
  const logs = [];
  const { index, failed } = await buildAll({ out, floor: '2026-09-14', today: '2026-10-03', now: Date.parse('2026-10-03T04:40:00Z'), fetchImpl: net.fetchImpl, wait: async () => {}, log: (s) => logs.push(s), warn: (s) => logs.push('W ' + s) });
  assert.deepEqual(failed, {});
  assert.deepEqual(Object.keys(index.files).sort(), ['boc', 'ecb', 'nbp', 'usde']);
  assert.equal(net.seen.length, 4);
  for (const s of net.seen) { assert.ok(!s.init.method || s.init.method === 'GET'); assert.match(s.init.headers['user-agent'], /MeridianDataHub/); }
  const files = fs.readdirSync(out).sort();
  assert.deepEqual(files, ['boc-usdcad.json', 'ecb.json', 'index.json', 'nbp-usd.json', 'usde-usd.json']);   // no temporary file left
  const usde = JSON.parse(fs.readFileSync(path.join(out, 'usde-usd.json'), 'utf8'));
  assert.equal(usde.source, 'defillama'); assert.equal(usde.coin, LLAMA_COIN); assert.equal(usde.prices.length, usde.dates.length);
  assert.deepEqual([index.files.usde.from, index.files.usde.to, index.files.usde.count, index.files.usde.coin], ['2026-09-14', '2026-10-03', 20, LLAMA_COIN]);
  const nbp = JSON.parse(fs.readFileSync(path.join(out, 'nbp-usd.json'), 'utf8'));
  assert.equal(nbp.source, 'nbp'); assert.equal(nbp.ccy, 'PLN'); assert.equal(nbp.fetchedAt, '2026-10-03T04:40:00.000Z');
  assert.equal(nbp.tables[nbp.dates.indexOf('2026-09-25')], '187/A/NBP/2026');
  const ecb = JSON.parse(fs.readFileSync(path.join(out, 'ecb.json'), 'utf8'));
  assert.equal(ecb.base, 'EUR'); assert.equal(ecb.rates.USD.length, ecb.dates.length);
  assert.equal(index.files.ecb.currencies.length, 30);
  assert.ok(index.files.ecb.currencies.includes('EUR') && index.files.ecb.currencies.includes('RON') && index.files.ecb.currencies.includes('ISK'));
  assert.deepEqual([index.files.boc.from, index.files.boc.to, index.files.boc.count], ['2026-09-14', '2026-10-02', 14]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'index.json'), 'utf8')), index);
  fs.rmSync(out, { recursive: true, force: true });
});

test('buildAll: a source that fails (or fails its checks) is left out; the others are still written', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-'));
  const broken = JSON.parse(JSON.stringify(BOC)); broken.observations[5].FXUSDCAD.v = '2.9';   // a 100 % jump
  const net = fakeNet('2026-10-03', { [NBP_URL('2026-09-14', '2026-10-03')]: { status: 500, body: '' }, [BOC_URL('2026-09-14')]: { status: 200, body: JSON.stringify(broken) } });
  const warns = [];
  const { index, failed } = await buildAll({ out, floor: '2026-09-14', today: '2026-10-03', fetchImpl: net.fetchImpl, wait: async () => {}, log: () => {}, warn: (s) => warns.push(s) });
  assert.deepEqual(Object.keys(index.files), ['ecb', 'usde']);
  assert.match(failed.nbp, /HTTP 500/); assert.match(failed.boc, /moves/);
  assert.deepEqual(index.failed, failed);
  assert.ok(!fs.existsSync(path.join(out, 'nbp-usd.json')) && !fs.existsSync(path.join(out, 'boc-usdcad.json')));
  assert.equal(warns.filter((w) => /left out/.test(w)).length, 2);
  // the ECB itself failing writes an index with no files: the page then reads frankfurter.dev
  const all = await buildAll({ out, floor: '2026-09-14', today: '2026-10-03', fetchImpl: async () => { throw new Error('offline'); }, wait: async () => {}, log: () => {}, warn: () => {} });
  assert.deepEqual(all.index.files, {});
  assert.deepEqual(Object.keys(all.failed).sort(), ['boc', 'ecb', 'nbp', 'usde']);
  // DefiLlama answering another coin is refused, the rates still written
  const other = JSON.parse(JSON.stringify(LLAMA)); Object.values(other.coins)[0].symbol = 'USDC';
  const o2 = await buildAll({ out, floor: '2026-09-14', today: '2026-10-03', fetchImpl: fakeNet('2026-10-03', { [LLAMA_URL('2026-09-14', '2026-10-03')]: { status: 200, body: JSON.stringify(other) } }).fetchImpl, wait: async () => {}, log: () => {}, warn: () => {} });
  assert.match(o2.failed.usde, /not USDe/); assert.deepEqual(Object.keys(o2.index.files).sort(), ['boc', 'ecb', 'nbp']);
  fs.rmSync(out, { recursive: true, force: true });
});

test('the default floor is a few weeks before Meridian Predict launched', () => {
  assert.equal(FLOOR, '2026-06-01');
});
