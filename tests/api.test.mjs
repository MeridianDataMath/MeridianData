// The site's API client (js/api.js), the one the pages and the snapshot builder share: every GET has a time limit, and
// no answer, a 5xx or a 429 is tried again (a 429 after what Retry-After asks); any other 4xx is final, and the caller's
// abort stops it at once. Against a fake fetch; the pauses between tries are skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_load.mjs';

const MD = load(['js/util.js', 'js/api.js']);
const A = MD.api, U = MD.util;
const answer = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, statusText: 'HTTP ' + status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => (body == null ? '' : JSON.stringify(body)) });
async function withFetch(steps, fn) {
  const f0 = globalThis.fetch, s0 = U.sleep, t0 = A.TIMEOUT_MS; const calls = [], waits = [];
  globalThis.fetch = async (url, opt) => { const s = steps[Math.min(calls.length, steps.length - 1)]; calls.push(url); return typeof s === 'function' ? s(opt) : s; };
  U.sleep = async (ms) => { waits.push(ms); };
  try { return await fn(calls, waits); } finally { globalThis.fetch = f0; U.sleep = s0; A.TIMEOUT_MS = t0; }
}

test('a 5xx or no answer is tried again; the third failure is the answer', async () => {
  await withFetch([answer(503), answer(200, { x: 1 })], async (calls) => { assert.deepEqual(await A.get('https://api.test/a'), { x: 1 }); assert.equal(calls.length, 2); });
  await withFetch([() => { throw new TypeError('fetch failed'); }, answer(200, { y: 2 })], async (calls) => { assert.deepEqual(await A.get('https://api.test/b'), { y: 2 }); assert.equal(calls.length, 2); });
  await withFetch([answer(500, { message: 'boom' })], async (calls) => {
    await assert.rejects(A.get('https://api.test/c'), (e) => e.status === 500 && e.message === 'boom');
    assert.equal(calls.length, 3);
  });
});

test('a 429 waits what Retry-After asks (1 to 10 s, 3 s when it says nothing); a 404 is final at once', async () => {
  await withFetch([answer(429, null, { 'retry-after': '4' }), answer(200, { ok: 1 })], async (calls, waits) => { await A.get('https://api.test/d'); assert.deepEqual(waits, [4000]); });
  await withFetch([answer(429), answer(429, null, { 'retry-after': '120' }), answer(200, { ok: 1 })], async (calls, waits) => { await A.get('https://api.test/e'); assert.deepEqual(waits, [3000, 10000]); });
  await withFetch([answer(404, { message: 'Not found' })], async (calls) => { await assert.rejects(A.get('https://api.test/f'), (e) => e.status === 404); assert.equal(calls.length, 1); });
});

test("the caller's abort ends a 429's wait at once (the snapshot build's deadline does not wait out a minute)", async () => {
  const f0 = globalThis.fetch, w0 = A.RETRY_WAIT_MAX_MS;
  globalThis.fetch = async () => answer(429, null, { 'retry-after': '30' });
  A.RETRY_WAIT_MAX_MS = 60000;
  try {
    const ctl = new AbortController(); setTimeout(() => ctl.abort(), 30);
    const t0 = Date.now();
    await assert.rejects(A.get('https://api.test/wait', { signal: ctl.signal, ttl: 0 }), (e) => e.name === 'AbortError');
    assert.ok(Date.now() - t0 < 2000, 'ended at the abort, not after the 30 s wait');
  } finally { globalThis.fetch = f0; A.RETRY_WAIT_MAX_MS = w0; }
  // and a pause given no signal still just waits
  const t1 = Date.now(); await U.sleep(20); assert.ok(Date.now() - t1 >= 15);
});

test('a request that hangs is given up at the time limit (and tried again); the caller\'s abort is never retried', async () => {
  const hang = (opt) => new Promise((resolve, reject) => opt.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
  await withFetch([hang], async (calls) => {
    A.TIMEOUT_MS = 20;
    await assert.rejects(A.get('https://api.test/g'), (e) => e.status === 0 && /No answer within 0\.02 s/.test(e.message));
    assert.equal(calls.length, 3);
  });
  await withFetch([hang], async (calls) => {
    const ctl = new AbortController(); setTimeout(() => ctl.abort(), 10);
    await assert.rejects(A.get('https://api.test/h', { signal: ctl.signal }), (e) => e.name === 'AbortError');
    assert.equal(calls.length, 1);
  });
});

test('funding charges: with the snapshot build\'s cache, only the windows after the kept ones are read', async () => {
  const H = 3600000, now = Date.now(), start = now - 10 * 24 * H;
  const asked = [];
  const charge = (t, f) => ({ positionId: 'p', time: t, fundingCharge: String(f) });
  // every window answers its own hour-aligned charges: one per 6 hours, 1 USD each
  globalThis.fetch0 = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url); const from = Number(u.searchParams.get('startTime')), to = Number(u.searchParams.get('endTime')) || now; asked.push([from, to]);
    const rows = []; for (let t = Math.ceil(from / (6 * H)) * 6 * H; t <= to; t += 6 * H) if (t < now) rows.push(charge(t, 1));
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: rows }) };
  };
  try {
    const store = {}; const cache = { get: (sid) => store[sid] || null, set: (sid, e) => { store[sid] = e; } };
    const a = await A.fundingCharges('s', start, { cache });
    const windows = asked.length; asked.length = 0;
    assert.ok(windows >= 4, 'ten days: four windows or more'); assert.ok(store.s && store.s.until <= now - 6 * H && store.s.rows.length > 30);
    const b = await A.fundingCharges('s', start, { cache });
    assert.equal(asked.length, 1, 'the second read asks only the window after the kept charges');
    // (a read without the cache also returns what its first window holds before `start`; the kept ones start there)
    const from = (rows) => rows.filter((r) => Number(r.time) >= start).map((r) => [Number(r.time), Number(r.fundingCharge)]);
    assert.deepEqual(from(b), from(a), 'the same charges from the start on, once each');
    assert.equal((await A.fundingCharges('s', start - 30 * 24 * H, { cache })).length > a.length, true, 'an earlier start than kept reads everything again');
  } finally { globalThis.fetch = globalThis.fetch0; delete globalThis.fetch0; }
});

test('position fees: with the snapshot build\'s cache, only the windows after the kept ones are read, one sum per charge time', async () => {
  const H = 3600000, now = Date.now(), start = now - 2 * 24 * H;
  const asked = [];
  // two positions charged every 15 minutes, 0.5 USD each; both ends of a window are inclusive (a shared bucket twice)
  globalThis.fetch0 = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url); const from = Number(u.searchParams.get('startTime')), to = Number(u.searchParams.get('endTime')) || now; asked.push([from, to]);
    const rows = []; for (let t = Math.ceil(from / (15 * 60000)) * 15 * 60000; t <= to; t += 15 * 60000) if (t < now) for (const p of ['p1', 'p2']) rows.push({ positionId: p, time: t, positionFeeCharge: '0.5' });
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: rows }) };
  };
  try {
    const store = {}; const cache = { get: (sid) => store[sid] || null, set: (sid, e) => { store[sid] = e; } };
    const a = await A.positionFeeCharges('s', start, { cache });
    const windows = asked.length; asked.length = 0;
    assert.ok(windows >= 9, 'two days of 5-hour windows'); assert.ok(store.s && store.s.until <= now - 6 * H);
    assert.ok(store.s.rows.every((x) => x[1] === 1), 'kept: one sum per charge time (both positions)');
    const b = await A.positionFeeCharges('s', start, { cache });
    assert.ok(asked.length <= 2, 'the second read asks only the windows after the kept charges (' + asked.length + ')');
    const sum = (rows) => rows.filter((r) => Number(r.time) >= start).reduce((t, r) => t + Number(r.positionFeeCharge), 0);
    assert.equal(sum(b), sum(a), 'the same charges from the start on');
    const c = await A.positionFeeCharges('s', start, {});
    assert.equal(sum(c), sum(a), 'and the same as without a cache');
  } finally { globalThis.fetch = globalThis.fetch0; delete globalThis.fetch0; }
});
