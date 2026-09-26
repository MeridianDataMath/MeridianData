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
const A = vm.runInNewContext(block + '\n;({ num, roundDown, roundTick, classify, sizeOrder, roomLeft, fitToRoom, reduceQty, defaultCap, MAX_SCALE, LIMITS, checkConfig, priceProblem, parseArgs, parseState, isClockReject, hostOk })', { Math, Number, String, parseFloat, Infinity });
const plain = (x) => JSON.parse(JSON.stringify(x));   // objects and arrays from the block's own context, compared as data

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
  assert.equal(A.defaultCap({ mode: 'ratio', ratio: 10 }, {}), null, 'ratio copies are not capped by size (the hard ceilings below hold instead)');
});

test('a leader fill is acted on only when it is priced, and priced near the mark', () => {
  assert.equal(A.priceProblem(84100, 84000, 3), null);
  assert.equal(A.priceProblem(84000 * 1.029, 84000, 3), null, 'inside the band');
  assert.match(A.priceProblem(84000 * 1.031, 84000, 3), /off the mark/);
  // the audit's case: the market maker pulls its quotes and a leader sells the minimum into a stub bid far below the mark
  assert.match(A.priceProblem(840, 84000, 3), /99\.0% off the mark/);
  for (const px of [0, NaN, undefined, -5, Infinity]) assert.match(A.priceProblem(px, 84000, 3), /missing or unusable/, String(px));
  assert.equal(A.priceProblem(84000, 0, 3), 'no mark price');
  assert.equal(A.priceProblem(84000, undefined, 3), 'no mark price');
});

test('sized at the mark, a fixed copy is its size whatever the leader paid', () => {
  // fixed $200 at a BTC mark of 84,000: the leader's own price never enters the quantity
  const r = A.sizeOrder({ mode: 'fixed', size: 200 }, { kind: 'open', leaderDelta: 0.01, px: 84000, orderQty: 0.01 });
  near(assert, r.q * 84000, 200, 1e-9);
  near(assert, A.sizeOrder({ mode: 'perfill', size: 200 }, { kind: 'open', leaderDelta: 0.01, px: 84000 }).q * 84000, 200, 1e-9);
});

test('the hard ceilings per order and per position hold in every mode, ratio included', () => {
  assert.ok(A.LIMITS.maxOrderUsd > 0 && A.LIMITS.maxPositionUsd > 0 && A.LIMITS.maxPriceDeviationPct > 0 && A.LIMITS.maxFillAgeMs > 0);
  assert.equal(A.roomLeft({ maxPosition: 5000, maxOrder: 1000 }), 1000, 'the order ceiling');
  assert.equal(A.roomLeft({ curNotional: 4500, maxPosition: 5000, maxOrder: 1000 }), 500, 'the position ceiling');
  assert.equal(A.roomLeft({ curNotional: 5200, maxPosition: 5000, maxOrder: 1000 }), -200, 'over it: no room');
  // 10% of a whale's 60 BTC with the per-market cap and the leverage limit both cleared: 6 BTC ≈ 504,000 USD asked
  const q = A.sizeOrder({ mode: 'ratio', ratio: 10 }, { kind: 'open', leaderDelta: 60, px: 84000 }).q;
  const fit = A.fitToRoom(q, 84000, A.roomLeft({ maxPerMarket: 0, maxLeverage: 0, maxPosition: 5000, maxOrder: 1000 }), 10);
  assert.equal(fit.cut, true); near(assert, fit.q * 84000, 1000, 1e-9, 'cut to the order ceiling');
  assert.equal(A.fitToRoom(q, 84000, A.roomLeft({ curNotional: 4995, maxPosition: 5000, maxOrder: 1000 }), 10).skip, true, 'a position at its ceiling takes nothing more');
});

test('a config that must not trade is refused before anything starts', () => {
  assert.deepEqual(plain(A.checkConfig({})), [], 'left out: defaults');
  assert.deepEqual(plain(A.checkConfig({ risk: { maxOrderUsd: null, maxPositionUsd: null } })), [], 'null: defaults too');
  const example = JSON.parse(fs.readFileSync(path.join(root, 'agent/config.example.json'), 'utf8'));
  assert.deepEqual(plain(A.checkConfig(example)), [], 'the shipped example passes');
  const bad = (cfg, re) => { const e = plain(A.checkConfig(cfg)); assert.equal(e.length, 1, JSON.stringify(cfg) + ' → ' + JSON.stringify(e)); assert.match(e[0], re); };
  bad({ risk: { maxOrderUsd: 0 } }, /risk\.maxOrderUsd is 0: it must be a number above 0/);
  bad({ risk: { maxPositionUsd: -5 } }, /maxPositionUsd/);
  bad({ risk: { maxOrderUsd: '1000' } }, /maxOrderUsd is "1000"/);
  bad({ risk: { maxPriceDeviationPct: 80 } }, /at most 50/);
  bad({ risk: { maxLeverage: -1 } }, /maxLeverage/);
  bad({ sizing: { mode: 'ratoi' } }, /sizing\.mode/);
  bad({ sizing: { mode: 'fixed', size: 0 } }, /sizing\.size/);
  bad({ sizing: { mode: 'ratio', ratio: 0, size: 2000 } }, /sizing\.ratio/);
  bad({ ntfy: { server: 'http://ntfy.example.com', topic: 't' } }, /ntfy\.server .* https/);
  bad({ ntfy: { server: 'ftp://x' } }, /ntfy\.server/);
  for (const server of ['https://ntfy.sh', 'https://push.example.com/', 'http://localhost:8080', 'http://127.0.0.1', '']) assert.deepEqual(plain(A.checkConfig({ ntfy: { server } })), [], server || 'empty');
  assert.deepEqual(plain(A.checkConfig({ sizing: { mode: 'ratio', ratio: 10, size: 0 } })), [], 'the field the mode ignores may be 0 (the page writes 0 for an empty one)');
  assert.deepEqual(plain(A.checkConfig({ sizing: { mode: 'fixed', size: 2000, ratio: 0 } })), []);
  bad({ execution: { maxFillAgeMs: 0 } }, /maxFillAgeMs/);
  assert.equal(A.checkConfig({ risk: { maxLeverage: 0, maxNotionalPerMarket: 0 } }).length, 0, 'the soft limits may be 0 (off): the ceilings still hold');
});

test('the command line: an unknown argument stops the agent; dry comes from the flag, the environment or npm', () => {
  const p = (argv, env) => plain(A.parseArgs(argv, env || {}));
  assert.equal(p(['run']).dry, false); assert.equal(p(['run']).error, null);
  assert.equal(p(['run', '--dry']).dry, true);
  assert.equal(p(['run', '--dry-run']).dry, true);
  for (const typo of ['--dryrun', '—dry', '-dry', 'dry', '--DRY', '--dry=1', '--live']) assert.ok(p(['run', typo]).error, typo + ' must not start a live run');
  assert.equal(p(['run'], { COPY_AGENT_DRY: '1' }).dry, true);
  assert.equal(p(['run'], { COPY_AGENT_DRY: '0' }).dry, false);
  assert.ok(p(['run'], { COPY_AGENT_DRY: 'ture' }).error, 'neither on nor off');
  assert.equal(p(['run'], { npm_config_dry_run: 'true' }).dry, true, 'npm start --dry: npm keeps the flag and passes it on');
  assert.equal(p(['run'], { npm_config_dryrun: 'true' }).dry, true);
  assert.equal(p(['run', '--config', 'config.live.json']).config, 'config.live.json');
  assert.equal(p(['run', '--config=config.live.json', '--dry']).config, 'config.live.json');
  assert.ok(p(['run', '--config']).error); assert.ok(p(['run', '--config', '--dry']).error);
  assert.equal(p(['keygen', '--force']).force, true);
  assert.ok(p(['keygen', '--dry']).error); assert.ok(p(['status', '--force']).error);
  assert.equal(p(['keygen'], { COPY_AGENT_DRY: 'garbage' }).error, null, 'only run reads the environment');
  assert.equal(p([]).cmd, 'help'); assert.equal(p(['--help']).cmd, 'help');
  assert.ok(p(['start']).error);
});

test('a damaged state file is never taken for a fresh start', () => {
  const ok = plain(A.parseState('{"tripped":{"t":1,"why":"today\'s loss 150 USD reached the stop of 100"},"equityDayStart":10150,"dayKey":"2026-09-26","books":{},"orders":[]}'));
  assert.equal(ok.error, undefined); assert.equal(ok.state.tripped.why.slice(0, 11), 'today\'s los'); assert.equal(ok.state.equityDayStart, 10150);
  assert.deepEqual(plain(A.parseState('{}')), { state: {} });
  // cut short by a crash or a full disk, or garbled
  for (const text of ['', '{"tripped":{"t":1,"wh', '[]', 'null', '{"books":[]}', '{"orders":{}}', '{"tripped":true}', '{"equityDayStart":"x"}', '{"dayKey":"yesterday"}']) assert.ok(A.parseState(text).error, JSON.stringify(text));
});

test('a rejection about the time is retried once; the control port answers to its own name only', () => {
  assert.equal(A.isClockReject(400, 'signedAt is too old'), true);
  assert.equal(A.isClockReject(400, 'NonceAlreadyUsed'), true);
  assert.equal(A.isClockReject(400, 'InsufficientBalance'), false);
  assert.equal(A.isClockReject(401, 'signedAt'), false, 'an auth failure is not a clock problem');
  assert.equal(A.isClockReject(undefined, 'signedAt'), false, 'no answer at all: not retried');
  assert.equal(A.hostOk('127.0.0.1:8790', 8790), true);
  assert.equal(A.hostOk('localhost:8790', 8790), true);
  assert.equal(A.hostOk('LOCALHOST:8790', 8790), true);
  for (const h of ['attacker.example:8790', 'attacker.example', '127.0.0.1', '127.0.0.1:8791', '', undefined]) assert.equal(A.hostOk(h, 8790), false, String(h));
});
