#!/usr/bin/env node
/**
 * Official exchange rates for the Tax center, read when the site is published (.github/workflows/pages.yml, step
 * "Official exchange rates (data/fx)") and served as static JSON next to the other snapshots:
 *   data/fx/ecb.json         — the ECB's euro foreign exchange reference rates, every currency it publishes (EUR base)
 *   data/fx/nbp-usd.json     — NBP table A average (mid) rate of USD in PLN, with each table's number
 *   data/fx/boc-usdcad.json  — the Bank of Canada's daily USD/CAD rate (Valet series FXUSDCAD)
 *   data/fx/usde-usd.json    — DefiLlama's daily USDe/USD price (the USDe lots' market valuation, not a rate)
 *   data/fx/index.json       — which of these this run wrote, their date range, source URL and fetch time
 * Most central banks cannot be read from a visitor's browser (no CORS), so the page (js/tax/fx.js) reads these files
 * and falls back to frankfurter.dev (the ECB's rates) when one is missing (and to DefiLlama itself for USDe). GET only:
 * one request per source (NBP: one per 367 days, its limit), each with a 15 s timeout and two retries, from a fixed
 * start date so the URLs stay the same from run to run (DefiLlama's names a span that grows by a day a day). Every
 * series is checked (positive, ascending dates, no gap over 10 days, no day-to-day move over
 * 20 %) and a source that fails is left out with a warning while the others are still written; files are written
 * atomically (a temporary file, then a rename). Exit code 0 unless --strict, so a central bank that is down never
 * blocks the deploy.
 *
 *   node scripts/build-fx.mjs --out data/fx [--strict]
 *
 * Node 22+ (global fetch), no dependencies. The parsers and checks are exported for tests/fx-build.test.mjs; importing
 * this file runs nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const V = 1;
/** The first date read: Meridian Predict launched on 29 Jun 2026 and the perps exchange later, so a few weeks before
 *  covers the lookback of a report's first day. */
export const FLOOR = '2026-06-01';
const UA = 'MeridianDataHub exchange rates (+https://meridian.thedatahub.xyz)';
const DAY = 86400000;
export const MAX_GAP_DAYS = 10;   // longer than any run of weekends and closing days (Christmas to the next business day)
export const MAX_JUMP = 0.2;      // a day-to-day move over 20 % is a broken series, not a market

export const ECB_URL = (from) => `https://data-api.ecb.europa.eu/service/data/EXR/D..EUR.SP00.A?startPeriod=${from}&format=csvdata&detail=dataonly`;
export const NBP_URL = (from, to) => `https://api.nbp.pl/api/exchangerates/rates/A/USD/${from}/${to}/?format=json`;
export const BOC_URL = (from) => `https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?start_date=${from}`;
/** USDe on Ethereum, the token DefiLlama prices (the same coin as FX.USDE in js/tax/fx.js) */
export const LLAMA_COIN = 'ethereum:0x4c9EDD5852cd905f086C759E8383e09bff1E68B3';
/** DefiLlama's daily chart from `from` to `today` (span: the number of daily points, two spare so today is in) */
export const LLAMA_URL = (from, today) => `https://coins.llama.fi/chart/${LLAMA_COIN}?start=${Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10)) / 1000}&span=${Math.round((Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10)) - Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10))) / 86400000) + 2}&period=1d&searchWidth=600`;

const dayMs = (k) => Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10));
const keyOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const okDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && keyOf(dayMs(s)) === s;
const num = (s) => { const n = typeof s === 'number' ? s : parseFloat(String(s == null ? '' : s).trim()); return Number.isFinite(n) ? n : null; };

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

/** The ECB's SDMX csvdata (detail=dataonly): one row per currency and day, the value in units of that currency per EUR.
 *  Returns {dates, rates: {CCY: [value or null per date]}}, dates ascending. Columns are found by name. */
export function parseEcb(csv) {
  const rows = parseCsv(csv);
  if (!rows.length) throw new Error('ECB: empty response');
  const head = rows[0].map((x) => x.trim().toUpperCase());
  const ci = head.indexOf('CURRENCY'), di = head.indexOf('TIME_PERIOD'), vi = head.indexOf('OBS_VALUE'), ki = head.indexOf('CURRENCY_DENOM');
  if (ci < 0 || di < 0 || vi < 0) throw new Error('ECB: unexpected columns ' + head.join(','));
  const by = new Map(), days = new Set();
  for (const r of rows.slice(1)) {
    if (ki >= 0 && r[ki] && r[ki].trim() !== 'EUR') continue;
    const ccy = String(r[ci] || '').trim(), d = String(r[di] || '').trim(), v = num(r[vi]);
    if (!/^[A-Z]{3}$/.test(ccy) || !okDay(d) || v == null) continue;   // an empty or NaN value is a day without a rate
    let m = by.get(ccy); if (!m) by.set(ccy, (m = new Map()));
    m.set(d, v); days.add(d);
  }
  const dates = Array.from(days).sort();
  const rates = {};
  for (const ccy of Array.from(by.keys()).sort()) { const m = by.get(ccy); rates[ccy] = dates.map((d) => (m.has(d) ? m.get(d) : null)); }
  return { dates, rates };
}

/** NBP table A responses for USD (one per chunk): {dates, rates (PLN per USD), tables (the table's number, e.g.
 *  187/A/NBP/2026)}. */
export function parseNbp(list) {
  const by = new Map();
  for (const j of [].concat(list || [])) {
    if (!j) continue;
    if (j.code && j.code !== 'USD') throw new Error('NBP: not the USD series (' + j.code + ')');
    for (const x of j.rates || []) {
      const d = String(x.effectiveDate || ''), v = num(x.mid);
      if (!okDay(d) || v == null) continue;
      by.set(d, { v, no: String(x.no || '') });
    }
  }
  const dates = Array.from(by.keys()).sort();
  return { dates, rates: dates.map((d) => by.get(d).v), tables: dates.map((d) => by.get(d).no) };
}

/** The Bank of Canada's Valet observations of FXUSDCAD (CAD per USD): {dates, rates}. A day without a rate (a weekend,
 *  a Bank holiday such as 30 September) has no observation. */
export function parseBoc(json) {
  const out = new Map();
  for (const o of (json && json.observations) || []) {
    const d = String(o.d || ''), v = num(o.FXUSDCAD && o.FXUSDCAD.v);
    if (okDay(d) && v != null) out.set(d, v);
  }
  const dates = Array.from(out.keys()).sort();
  return { dates, rates: dates.map((d) => out.get(d)) };
}

/** DefiLlama's chart answer for one coin: {dates, prices (USD per token)}, each point dated by the UTC midnight it is
 *  nearest to (DefiLlama stamps them within minutes of it, either side), one per date. Throws without that coin. */
export function parseLlama(json) {
  const coin = json && json.coins ? Object.values(json.coins)[0] : null;
  if (!coin || !Array.isArray(coin.prices)) throw new Error('DefiLlama: no price series in the answer');
  const by = new Map();
  for (const p of coin.prices) {
    const ts = num(p.timestamp), v = num(p.price);
    if (ts == null || v == null) continue;
    by.set(keyOf(Math.round((ts * 1000) / DAY) * DAY), v);
  }
  const dates = Array.from(by.keys()).sort();
  return { dates, prices: dates.map((d) => by.get(d)), symbol: coin.symbol || null };
}

/**
 * What is wrong with a daily series (an empty list when nothing is): dates real and strictly ascending, values positive,
 * no gap between two dates over MAX_GAP_DAYS calendar days, no move between two dates over MAX_JUMP, a start within
 * MAX_GAP_DAYS of `floor` and an end within MAX_GAP_DAYS of `today` (a source that stopped publishing is stale, not a
 * holiday). null values (a currency the ECB did not publish that day) are skipped.
 */
export function check(dates, values, { floor = FLOOR, today = keyOf(Date.now()) } = {}) {
  const bad = [];
  const pts = [];
  for (let i = 0; i < dates.length; i++) if (values[i] != null) pts.push([dates[i], values[i]]);
  if (!pts.length) return ['no observations'];
  for (let i = 0; i < pts.length; i++) {
    const [d, v] = pts[i];
    if (!okDay(d)) { bad.push(`${d}: not a date`); continue; }
    if (!(typeof v === 'number' && Number.isFinite(v) && v > 0)) bad.push(`${d}: ${v} is not a positive number`);
    if (i) {
      const [pd, pv] = pts[i - 1];
      if (!(d > pd)) bad.push(`${d}: not after ${pd}`);
      else if ((dayMs(d) - dayMs(pd)) / DAY > MAX_GAP_DAYS) bad.push(`${pd} → ${d}: no rate for ${(dayMs(d) - dayMs(pd)) / DAY} days`);
      if (pv > 0 && v > 0 && Math.abs(v / pv - 1) > MAX_JUMP) bad.push(`${pd} → ${d}: ${pv} → ${v} moves ${(Math.abs(v / pv - 1) * 100).toFixed(1)} %`);
    }
  }
  const first = pts[0][0], last = pts[pts.length - 1][0];
  if (okDay(first) && okDay(floor) && (dayMs(first) - dayMs(floor)) / DAY > MAX_GAP_DAYS) bad.push(`starts ${first}, not near ${floor}`);
  if (okDay(last) && okDay(today) && (dayMs(today) - dayMs(last)) / DAY > MAX_GAP_DAYS) bad.push(`ends ${last}: stale on ${today}`);
  return bad;
}

/** [from, to] in pieces of at most `max` days, both ends inclusive (NBP answers at most 367 days per request). */
export function chunks(from, to, max = 367) {
  const out = [];
  for (let a = dayMs(from), z = dayMs(to); a <= z; a += max * DAY) out.push([keyOf(a), keyOf(Math.min(a + (max - 1) * DAY, z))]);
  return out;
}

/** A GET with a timeout and retries (a network error, a 5xx or a 429; a 4xx will not change on a retry). Returns the
 *  body text, or null for a 404 when `allow404` (NBP's answer to a range with no table in it). */
export async function get(url, { fetchImpl = globalThis.fetch, timeout = 15000, retries = 2, wait = (ms) => new Promise((r) => setTimeout(r, ms)), accept = '*/*', allow404 = false } = {}) {
  let last = null;
  for (let i = 0; i <= retries; i++) {
    if (i) await wait(1000 * 2 ** i);   // 2 s, then 4 s
    try {
      const r = await fetchImpl(url, { headers: { 'user-agent': UA, accept }, signal: AbortSignal.timeout(timeout) });
      if (r.ok) return await r.text();
      if (r.status === 404 && allow404) return null;
      last = new Error(`HTTP ${r.status} from ${url}`);
      if (r.status < 500 && r.status !== 429) break;
    } catch (e) { last = e; }
  }
  throw last || new Error('no answer from ' + url);
}

/** The sources (three central banks and DefiLlama's USDe price): each reads its series and returns the file it publishes, or throws. */
export const SOURCES = [
  {
    id: 'ecb', file: 'ecb.json',
    async build({ get: g, floor, today }) {
      const url = ECB_URL(floor);
      const { dates, rates } = parseEcb(await g(url, { accept: 'text/csv' }));
      const dropped = {};
      for (const ccy of Object.keys(rates)) { const bad = check(dates, rates[ccy], { floor, today }); if (bad.length) { dropped[ccy] = bad.slice(0, 3).join('; '); delete rates[ccy]; } }
      if (!rates.USD) throw new Error('ECB: the USD series is missing or fails its checks' + (dropped.USD ? ` (${dropped.USD})` : ''));
      const used = dates.map((d, i) => Object.values(rates).some((a) => a[i] != null));
      const keep = (a) => a.filter((_, i) => used[i]);
      const out = { dates: keep(dates), rates: {} };
      for (const [ccy, a] of Object.entries(rates)) out.rates[ccy] = keep(a);
      return { data: { source: 'ecb', name: 'ECB euro foreign exchange reference rates', base: 'EUR', url, ...out }, extra: { currencies: Object.keys(out.rates).concat('EUR').sort() }, dropped };
    },
  },
  {
    id: 'nbp', file: 'nbp-usd.json',
    async build({ get: g, floor, today }) {
      const parts = [];
      for (const [a, b] of chunks(floor, today)) { const t = await g(NBP_URL(a, b), { accept: 'application/json', allow404: true }); if (t != null) parts.push(JSON.parse(t)); }
      const s = parseNbp(parts);
      const bad = check(s.dates, s.rates, { floor, today });
      if (bad.length) throw new Error('NBP: ' + bad.slice(0, 3).join('; '));
      if (s.tables.some((t) => !/^\d+\/A\/NBP\/\d{4}$/.test(t))) throw new Error('NBP: a table without its number');
      return { data: { source: 'nbp', name: 'NBP table A average exchange rates', pair: 'USD/PLN', ccy: 'PLN', url: NBP_URL(floor, today), ...s }, extra: { ccy: 'PLN' } };
    },
  },
  {
    id: 'boc', file: 'boc-usdcad.json',
    async build({ get: g, floor, today }) {
      const url = BOC_URL(floor);
      const s = parseBoc(JSON.parse(await g(url, { accept: 'application/json' })));
      const bad = check(s.dates, s.rates, { floor, today });
      if (bad.length) throw new Error('Bank of Canada: ' + bad.slice(0, 3).join('; '));
      return { data: { source: 'boc', name: 'Bank of Canada daily exchange rates (FXUSDCAD)', pair: 'USD/CAD', ccy: 'CAD', url, ...s }, extra: { ccy: 'CAD' } };
    },
  },
  {
    // not an exchange rate: the USDe lots' market valuation (a page that cannot read it values USDe at par)
    id: 'usde', file: 'usde-usd.json',
    async build({ get: g, floor, today }) {
      const url = LLAMA_URL(floor, today);
      const s = parseLlama(JSON.parse(await g(url, { accept: 'application/json' })));
      if (s.symbol && s.symbol !== 'USDe') throw new Error('DefiLlama: not USDe (' + s.symbol + ')');
      const bad = check(s.dates, s.prices, { floor, today });
      if (bad.length) throw new Error('DefiLlama: ' + bad.slice(0, 3).join('; '));
      return { data: { source: 'defillama', name: 'DefiLlama USDe/USD daily price (USDe on Ethereum)', coin: LLAMA_COIN, pair: 'USDe/USD', url, dates: s.dates, prices: s.prices }, extra: { coin: LLAMA_COIN } };
    },
  },
];

/** Writes a file in one step: a reader (or a deploy copying the folder) sees the old file or the new one, never half. */
export function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Reads every source (in parallel: different hosts), writes the files of those that pass their checks and then the
 * index. o: {out, today ('YYYY-MM-DD', UTC), floor, fetchImpl, wait, log, warn}. Returns {index, failed: {id: reason}}.
 */
export async function buildAll(o = {}) {
  const out = o.out || 'data/fx', floor = o.floor || FLOOR;
  const now = o.now != null ? o.now : Date.now();
  const today = o.today || keyOf(now);
  const log = o.log || ((s) => console.log(s)), warn = o.warn || ((s) => console.warn(s));
  const g = (url, opt) => get(url, Object.assign({ fetchImpl: o.fetchImpl || globalThis.fetch, wait: o.wait }, opt));
  fs.mkdirSync(out, { recursive: true });
  const index = { v: V, builtAt: new Date(now).toISOString(), floor, files: {} };
  const failed = {};
  const results = await Promise.all(SOURCES.map(async (s) => {
    const fetchedAt = new Date(o.now != null ? o.now : Date.now()).toISOString();
    try { return { s, fetchedAt, r: await s.build({ get: g, floor, today }) }; } catch (e) { return { s, error: e }; }
  }));
  for (const { s, fetchedAt, r, error } of results) {
    if (error) { failed[s.id] = String(error.message || error); warn(`${s.id}: left out (${failed[s.id]}); ` + (s.id === 'usde' ? 'the page reads DefiLlama itself, or values USDe at par' : 'the page falls back to the ECB\'s rates')); continue; }
    const data = Object.assign({ v: V, fetchedAt }, r.data);
    writeAtomic(path.join(out, s.file), JSON.stringify(data));
    const n = data.dates.length;
    index.files[s.id] = Object.assign({ file: s.file, from: data.dates[0], to: data.dates[n - 1], count: n, url: data.url, fetchedAt }, r.extra || {});
    for (const [ccy, why] of Object.entries(r.dropped || {})) warn(`${s.id}: ${ccy} left out (${why})`);
    log(`${s.id}: ${n} days, ${data.dates[0]} → ${data.dates[n - 1]}` + (r.extra && r.extra.currencies ? `, ${r.extra.currencies.length} currencies` : ''));
  }
  if (Object.keys(failed).length) index.failed = failed;
  writeAtomic(path.join(out, 'index.json'), JSON.stringify(index));
  return { index, failed };
}

async function main(argv) {
  const at = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
  const strict = argv.includes('--strict');
  const gh = !!process.env.GITHUB_ACTIONS;   // warnings show on the run's summary page
  const { failed } = await buildAll({ out: path.resolve(at('--out') || 'data/fx'), warn: (s) => console.warn((gh ? '::warning::' : '') + 'exchange rates: ' + s) });
  if (strict && Object.keys(failed).length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(e); if (process.argv.includes('--strict')) process.exitCode = 1; });
}
