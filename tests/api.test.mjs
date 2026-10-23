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
