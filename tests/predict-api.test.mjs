// Predict API client: what it asks again (P.gql)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_load.mjs';

const MD = load(['js/util.js', 'js/api.js', 'js/predict/api.js']);
const P = MD.predict, U = MD.util;

/** P.gql against answers given in turn (each one a JSON body served with HTTP 200), no real waiting */
async function withAnswers(answers, fn) {
  const fetch0 = globalThis.fetch, sleep0 = U.sleep; let n = 0;
  globalThis.fetch = async () => { const a = answers[Math.min(n++, answers.length - 1)]; return { ok: true, status: 200, headers: { get: () => null }, json: async () => a }; };
  U.sleep = async () => {};
  try { return await fn(() => n); } finally { globalThis.fetch = fetch0; U.sleep = sleep0; }
}
const TIMEOUT = { errors: [{ message: 'Query timeout: raw.$queryRaw exceeded 8000ms', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] };

test('P.gql asks again after the API\'s query timeout (twice), other errors at once', async () => {
  await withAnswers([TIMEOUT, TIMEOUT, { data: { ok: 1 } }], async (calls) => {
    assert.deepEqual(await P.gql('{ ok }'), { ok: 1 }); assert.equal(calls(), 3);
  });
  await withAnswers([TIMEOUT, TIMEOUT, TIMEOUT, { data: { ok: 1 } }], async (calls) => {
    await assert.rejects(P.gql('{ ok }'), /Query timeout/); assert.equal(calls(), 3);
  });
  await withAnswers([TIMEOUT, { data: { ok: 1 } }], async (calls) => {
    await assert.rejects(P.gql('{ ok }', null, { retry: false }), /Query timeout/); assert.equal(calls(), 1);
  });
  await withAnswers([{ errors: [{ message: 'Cannot query field "x"' }] }, { data: { ok: 1 } }], async (calls) => {
    await assert.rejects(P.gql('{ x }'), /Cannot query field/); assert.equal(calls(), 1);
  });
});

test('P.gql in the snapshot builder (P.strict): a partial answer is asked twice more and then fails; the pages take it', async () => {
  const PARTIAL = { data: { a: 1, b: null }, errors: [{ message: 'b failed', path: ['b'] }] };
  await withAnswers([PARTIAL, { data: { a: 1, b: 2 } }], async (calls) => { assert.deepEqual(await P.gql('{ a b }'), { a: 1, b: null }, 'the pages: what came back'); assert.equal(calls(), 1); });
  P.strict = true;
  try {
    await withAnswers([PARTIAL, { data: { a: 1, b: 2 } }], async (calls) => { assert.deepEqual(await P.gql('{ a b }'), { a: 1, b: 2 }); assert.equal(calls(), 2); });
    await withAnswers([PARTIAL], async (calls) => { await assert.rejects(P.gql('{ a b }'), /Partial answer: b failed/); assert.equal(calls(), 3); });
  } finally { P.strict = false; }
});

test('a wallet, question or slip file without a build time of its own takes the snapshot\'s (predict-status.json)', async () => {
  const fetch0 = globalThis.fetch; const asked = [];
  globalThis.fetch = async (url) => { asked.push(url); const body = url.endsWith('predict-status.json') ? { builtAt: 1792800000000 } : url.includes('slips/') ? { slips: {} } : { builtAt: 5, x: 1 }; return { ok: true, status: 200, json: async () => body }; };
  try {
    assert.equal((await P.snapshotFile('slips/0a.json')).builtAt, 1792800000000);
    assert.equal((await P.snapshotFile('bettors/0x1.json')).builtAt, 5, 'a file with its own keeps it');
    await P.snapshotFile('questions/0x2.json');
    assert.equal(asked.filter((u) => u.endsWith('predict-status.json')).length, 1, 'the status is read once a minute at most');
  } finally { globalThis.fetch = fetch0; }
});
