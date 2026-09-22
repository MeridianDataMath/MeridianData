// The copy agent's decisions: the lines between @pure-begin and @pure-end in agent/copy-agent.mjs, loaded on their own
// (the agent itself needs ethers, a key and the exchange). Cases are the ones checked in dry runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { root, near } from './_load.mjs';

const src = fs.readFileSync(path.join(root, 'agent/copy-agent.mjs'), 'utf8');
const block = src.slice(src.indexOf('// @pure-begin'), src.indexOf('// @pure-end'));
assert.ok(block.length > 100, 'the pure block is marked in agent/copy-agent.mjs');
const A = vm.runInNewContext(block + '\n;({ num, roundDown, roundTick, classify, sizeOrder, roomLeft, fitToRoom, reduceQty, defaultCap, MAX_SCALE })', { Math, Number, String, parseFloat, Infinity });

test('quantities round down to the lot, limits to the tick in the direction that never tightens the cap', () => {
  assert.equal(A.roundDown(0.0905, '0.001'), 0.09);
  assert.equal(A.roundDown(0.3, '0.1'), 0.3, 'no float drift below an exact multiple');
  assert.equal(A.roundDown(1.23999, '0.01'), 1.23);
  assert.equal(A.roundTick(110.43123, '0.01', true), 110.44, 'a buy rounds up');
  assert.equal(A.roundTick(110.43923, '0.01', false), 110.43, 'a sell rounds down');
  assert.equal(A.roundTick(81237.8, '10', true), 81240);
});

test('a leader order is an open, add, reduce, close or reverse', () => {
  assert.equal(A.classify(0, 0.1), 'open');
  assert.equal(A.classify(0.1, 0.2), 'add');
  assert.equal(A.classify(0.2, 0.1), 'reduce');
  assert.equal(A.classify(0.2, 0), 'close');
  assert.equal(A.classify(0.2, -0.1), 'reverse');
  assert.equal(A.classify(-0.2, -0.3), 'add');
});

test('fixed size: the leader\'s whole opening order becomes the size, not its first piece', () => {
  // the leader's order is 0.03 BTC at 80,000; the first group of fills is 0.01
  const r = A.sizeOrder({ mode: 'fixed', size: 20 }, { kind: 'open', leaderDelta: 0.01, px: 80000, orderQty: 0.03 });
  near(assert, r.q * 80000, 20 / 3, 1e-9, 'a third of the size for a third of the order');
  near(assert, r.k, 20 / (0.03 * 80000), 1e-15, 'copy ratio kept for the adds');
});

test('an add scales with what is held, less a reduction still owed', () => {
  // SOL dry run: held 0.18, 0.09 of an earlier reduction still owed, leader had 0.05 and adds 0.1
  const r = A.sizeOrder({ mode: 'fixed', size: 20 }, { kind: 'add', leaderDelta: 0.1, px: 110, followed: true, ownNow: 0.18, prev: 0.05, owed: 0.09 });
  near(assert, r.q, 0.1 * (0.09 / 0.05), 1e-12); assert.equal(r.k, null);
});

test('per-fill and ratio sizing', () => {
  near(assert, A.sizeOrder({ mode: 'perfill', size: 20 }, { kind: 'add', leaderDelta: 5, px: 100 }).q, 0.2, 1e-12);
  near(assert, A.sizeOrder({ mode: 'ratio', ratio: 10 }, { kind: 'open', leaderDelta: 5, px: 100 }).q, 0.5, 1e-12);
});

test('the size limits cut an order to the room left, or skip it below the smallest order', () => {
  // dry run: $100 cap per market, $20 held, the leader adds 100x → a $1,995 add is cut to $80
  const room = A.roomLeft({ curNotional: 20, maxPerMarket: 100 });
  assert.equal(room, 80);
  const cut = A.fitToRoom(1995 / 110, 110, room, 10);
  assert.equal(cut.cut, true); near(assert, cut.q * 110, 80, 1e-9);
  const inside = A.fitToRoom(0.5, 100, 80, 10);   // (an object from the loaded block's own context: compare fields)
  assert.equal(inside.q, 0.5, 'inside the room: unchanged'); assert.equal(inside.cut, false); assert.equal(inside.skip, false);
  assert.equal(A.fitToRoom(1, 100, 5, 10).skip, true, 'room below the minimum order');
  assert.equal(A.roomLeft({ curNotional: 0, maxLeverage: 3, equity: 100, totalNotional: 250 }), 50, 'leverage room');
  assert.equal(A.roomLeft({}), Infinity);
});

test('a reduction takes the leader\'s share of what should be held, plus what is still owed', () => {
  near(assert, A.reduceQty(0.18, 0.5, 0.09), 0.135, 1e-12, 'SOL dry run: 0.09 owed + half of the rest');
  near(assert, A.reduceQty(-0.18, 0.5, 0), 0.09, 1e-12, 'a short reduces by the same size');
  near(assert, A.reduceQty(0.1, 0.5, 0.5), 0.1, 1e-12, 'never more than held');
});

test('the per-market cap defaults to five times the size in the fixed modes', () => {
  assert.equal(A.MAX_SCALE, 5);
  assert.equal(A.defaultCap({ mode: 'fixed', size: 20 }, { maxNotionalPerMarket: 0 }), 100);
  assert.equal(A.defaultCap({ mode: 'perfill', size: 50 }, {}), 250);
  assert.equal(A.defaultCap({ mode: 'fixed', size: 20 }, { maxNotionalPerMarket: 40 }), null, 'a configured cap is kept');
  assert.equal(A.defaultCap({ mode: 'ratio', ratio: 10 }, {}), null, 'ratio copies are not capped by size');
});
