// The Data status page's reading of the exchange's configuration: token kinds (Meridian's docs: Supported Tokens) and
// what a route costs in rate-limit points (System Limits).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_load.mjs';

const MD = load(['js/util.js', 'js/router.js', 'js/pages/status.js']);
const S = MD.router.pages.status;

test('token kinds as the docs name them: virtual, synthetic, concrete', () => {
  // Oct 21: BTC is a name only, XAUUSD the gold market's margin pool backed by USD, USD the merUSD ERC-20
  assert.equal(S.tokenKind({ name: 'BTC', address: '0x0000000000000000000000000000000000000000' }), 'virtual');
  assert.equal(S.tokenKind({ name: 'XAUUSD', address: '0x5841555553440000000000000000000000000000', backingTokenId: 'usd' }), 'synthetic');
  assert.equal(S.tokenKind({ name: 'USD', address: '0xad221259d4a1f2d7376dc1012c561bc86640f009', erc20Symbol: 'merUSD' }), 'concrete');
  assert.equal(S.tokenKind({ name: 'X' }), 'virtual');
});

test('a route costs its fixed points, or a base plus a share of a point a row', () => {
  assert.equal(S.routeCost({ type: 'FIXED', fixedPoints: 50 }), '50');
  assert.equal(S.routeCost({ type: 'PAGINATED', basePoints: 1, pointsPerRow: 0.1 }), '1 + 0.1 a row');
  assert.equal(S.routeCost({ type: 'PAGINATED', basePoints: 5, pointsPerRow: 0 }), '5');
});
