// The Leaderboard's read of the published snapshot (data/leaderboard.json): a file that failed to load is not a missing
// one. Only a missing one makes the page build the leaderboard in the visitor's browser (thousands of requests); a failed
// read is kept in P._remoteErr and offered as a Retry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_load.mjs';

globalThis.document = undefined;
const MD = load(['js/util.js', 'js/api.js', 'js/analytics.js', 'js/router.js', 'js/pages/leaderboard.js']);
const P = MD.router.pages.leaderboard;

const res = (status, body, type = 'application/json') => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? type : null) },
  json: async () => { if (body instanceof Error) throw body; return body; },
});
const read = (f) => { globalThis.fetch = f; return P.loadRemote(true); };
const fresh = () => { P._remote = undefined; P._remoteAt = 0; P._remoteErr = null; P._mem = undefined; };

test('absent: a 404, or the site page the host serves in its place', async () => {
  fresh();
  assert.equal(await read(async () => res(404, null)), null);
  assert.equal(P._remoteErr, null);
  fresh();
  assert.equal(await read(async () => res(200, null, 'text/html; charset=utf-8')), null);
  assert.equal(P._remoteErr, null);
});

test('a failed read is not absent: no answer, a 5xx, a cut-off body', async () => {
  const fails = [
    async () => { throw new TypeError('Failed to fetch'); },
    async () => res(503, null),
    async () => res(200, new SyntaxError('Unexpected end of JSON input')),
  ];
  for (const f of fails) {
    fresh();
    assert.equal(await read(f), null);
    assert.ok(P._remoteErr instanceof Error, 'the failure is kept for the Retry');
    assert.match(P._remoteErr.message, /published leaderboard/);
  }
});

test('a failed re-read keeps the snapshot read before; a good one clears the failure', async () => {
  fresh();
  await read(async () => res(200, { builtAt: 1000, rows: [{ sid: 'a', account: '0x' + '1'.repeat(40) }] }));
  assert.equal(P._remote.builtAt, 1000);
  assert.equal(P._remoteErr, null);
  await read(async () => res(502, null));
  assert.equal(P._remote.builtAt, 1000, 'the last snapshot stays in use');
  assert.ok(P._remoteErr);
  await read(async () => res(200, { builtAt: 2000, rows: [] }));
  assert.equal(P._remote.builtAt, 2000);
  assert.equal(P._remoteErr, null);
});
