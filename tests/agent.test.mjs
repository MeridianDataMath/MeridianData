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
const A = vm.runInNewContext(block + '\n;({ num, roundDown, roundTick, classify, sizeOrder, roomLeft, fitToRoom, reduceQty, defaultCap, MAX_SCALE, LIMITS, checkConfig, priceProblem, parseArgs, parseState, isClockReject, hostOk, dayBaseline, restorePeak, leaderRead, flatAction, resyncFlat, flowsForStops, closedByOrder, openingOrderQty })', { Math, Number, String, parseFloat, Infinity });
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

test('the day\'s loss baseline: the first reading of a UTC day, with deposits and withdrawals counted from it', () => {
  const t0 = Date.parse('2026-10-02T11:40:00Z');
  const fresh = plain(A.dayBaseline({ dayKey: '2026-10-01', equityDayStart: 900, dayBaseAt: t0 - 86400000 }, { day: '2026-10-02', readAt: t0, equity: 6203.07 }));
  assert.deepEqual(fresh, { dayKey: '2026-10-02', equityDayStart: 6203.07, dayBaseAt: t0, fresh: true }, 'a new UTC day starts at this reading');
  const kept = plain(A.dayBaseline({ dayKey: '2026-10-02', equityDayStart: 6203.07, dayBaseAt: t0 }, { day: '2026-10-02', readAt: t0 + 30000, equity: 6150 }));
  assert.deepEqual(kept, { dayKey: '2026-10-02', equityDayStart: 6203.07, dayBaseAt: t0, fresh: false }, 'the same day keeps it, a restart included');
  const old = plain(A.dayBaseline({ dayKey: '2026-10-02', equityDayStart: 1000 }, { day: '2026-10-02', readAt: t0, equity: 6203.07 }));
  assert.deepEqual(old, { dayKey: '2026-10-02', equityDayStart: 6203.07, dayBaseAt: t0, fresh: true }, 'a state file without dayBaseAt starts afresh, not from 00:00');
  // the audit's case: 6,190.28 deposited between 05:38 and 11:08 UTC, the agent started at 11:40 and read again 30 s later
  const transfers = [[Date.parse('2026-10-02T05:38:00Z'), 100], [Date.parse('2026-10-02T06:00:00Z'), 900], [Date.parse('2026-10-02T09:00:00Z'), 2029.94], [Date.parse('2026-10-02T11:08:00Z'), 3161.34]];
  const flowsSince = (since) => transfers.reduce((a, [t, v]) => a + (t > since ? v : 0), 0);
  const dayPnl = 6203.07 - kept.equityDayStart - flowsSince(kept.dayBaseAt);
  near(assert, dayPnl, 0, 1e-9, 'the deposits before the first reading are inside the baseline, not a loss');
});

test('the drawdown peak is restored only with the time its flows count from', () => {
  assert.deepEqual(plain(A.restorePeak({ equityPeak: 1000, peakSince: 1700 }, 5000)), { equityPeak: 1000, peakSince: 1700 }, 'kept across a restart');
  assert.deepEqual(plain(A.restorePeak({ equityPeak: 1000 }, 5000)), { equityPeak: null, peakSince: 5000 }, 'an older agent\'s peak is dropped: its flows are unknown');
  assert.deepEqual(plain(A.restorePeak({}, 5000)), { equityPeak: null, peakSince: 5000 }, 'a fresh start');
  assert.deepEqual(plain(A.restorePeak({ equityPeak: 0, peakSince: 1700 }, 5000)), { equityPeak: 0, peakSince: 1700 });
  // run 1: equity 1000, peak 1000, then 500 withdrawn; after a restart the withdrawal still counts from peakSince
  const p = A.restorePeak({ equityPeak: 1000, peakSince: 1700 }, 5000);
  const equity = 500, flowsSincePeak = -500, adjEquity = equity - flowsSincePeak;   // as refreshOwn takes them out
  near(assert, (p.equityPeak - adjEquity) / p.equityPeak, 0, 1e-12, 'no drawdown from a withdrawal');
  assert.ok(A.parseState('{"dayBaseAt":"today"}').error, 'a garbled dayBaseAt');
  assert.equal(A.parseState('{"peakSince":null,"equityPeak":5}').error, undefined, 'null is "not saved"');
  assert.ok(A.parseState('{"peakSince":"x"}').error, 'a garbled peakSince');
  assert.equal(A.parseState('{"dayBaseAt":1790000000000,"peakSince":1790000000000}').error, undefined);
});

test('a leader\'s re-read says, per market, whether its last record there was a liquidation', () => {
  const open = [{ productId: 'btc', size: '0.5', updatedAt: 100 }];
  const recent = [
    { productId: 'eth', size: '0', isLiquidated: true, updatedAt: 200 }, { productId: 'eth', size: '0', isLiquidated: false, updatedAt: 150 },
    { productId: 'btc', size: '0', isLiquidated: true, updatedAt: 90 },
    { productId: 'sol', size: '0', isLiquidated: false, updatedAt: 300 }, { productId: 'sol', size: '0', isLiquidated: true, updatedAt: 250 },
  ];
  const r = plain(A.leaderRead(open, recent));
  assert.deepEqual(r.pos, { btc: 0.5 });
  assert.equal(r.at.eth, 200); assert.equal(r.at.btc, 100);
  assert.equal(r.liq.eth, true, 'the newest record ended in a liquidation');
  assert.equal(r.liq.btc, false, 'an open position: not liquidated, whatever an older record says');
  assert.equal(r.liq.sol, false, 'an older liquidation does not count when a normal close came after it');
  assert.deepEqual(plain(A.leaderRead(null, undefined)), { pos: {}, at: {}, liq: {} });
});

test('leader flat → the flat option; leader liquidated → the liquidation option, on every re-read', () => {
  const flatHold = { onLeaderFlat: 'hold', onLeaderLiquidation: 'close' }, liqHold = { onLeaderFlat: 'close', onLeaderLiquidation: 'hold' };
  assert.equal(A.flatAction(flatHold, true), 'close', 'flat hold + liquidated close: a liquidation closes the copy');
  assert.equal(A.flatAction(flatHold, false), 'hold');
  assert.equal(A.flatAction(liqHold, true), 'hold', 'liquidated hold: a periodic re-read that finds the liquidation holds too');
  assert.equal(A.flatAction(liqHold, false), 'close');
  assert.equal(A.flatAction({}, true), 'close', 'left out: close'); assert.equal(A.flatAction({}, false), 'close');
});

test('a reversal\'s new side is sized on the rest of the leader\'s order, over all its groups of fills', () => {
  // as onLeaderOrder does: classify each group, add up the part of the order that closed the old position, size the opening
  const copy = (start, groups, orderQty, px = 100000) => {
    let pos = start, closed = 0, out = null;
    for (const q of groups) {
      const prev = pos, next = prev + q, kind = A.classify(prev, next); closed += A.closedByOrder(prev, q); pos = next;
      if (kind === 'open' || kind === 'reverse') out = A.sizeOrder({ mode: 'fixed', size: 200 }, { kind, leaderDelta: kind === 'reverse' ? Math.abs(next) : Math.abs(q), px, orderQty: A.openingOrderQty(orderQty, closed) });
    }
    return out.q * px;
  };
  near(assert, copy(1, [-3], 3), 200, 1e-9, 'long 1, sells 3 in one group: a $200 short, not $133.33');
  near(assert, copy(1, [-1, -2], 3), 200, 1e-9, 'close 1, then open 2 in a later group of the same order');
  near(assert, copy(1, [-0.5, -2.5], 3), 200, 1e-9, 'reduce 0.5, then reverse with 2.5');
  near(assert, copy(0, [1], 3), 200 / 3, 1e-9, 'an opening from flat is still sized on the whole order');
  assert.equal(A.closedByOrder(0, -2), 0); assert.equal(A.closedByOrder(1, 0.5), 0, 'an add closes nothing'); assert.equal(A.closedByOrder(-2, 0.5), 0.5);
  assert.equal(A.openingOrderQty(undefined, 1), undefined, 'no order quantity (ratio / per-fill): unchanged');
  assert.equal(A.openingOrderQty(3, 5), 0, 'nothing left: sizeOrder falls back to the leader\'s change');
});

test('a resync in a flat market: close or hold, and a held liquidation is no longer followed', () => {
  assert.deepEqual(plain(A.resyncFlat({ onLeaderFlat: 'close', onLeaderLiquidation: 'close' }, false)), { action: 'close', unfollow: false });
  // a config that sets only onLeaderFlat: 'hold' keeps the default onLeaderLiquidation 'close': a liquidation closes the copy
  assert.deepEqual(plain(A.resyncFlat({ onLeaderFlat: 'hold', onLeaderLiquidation: 'close' }, true)), { action: 'close', unfollow: false });
  assert.deepEqual(plain(A.resyncFlat({ onLeaderFlat: 'hold', onLeaderLiquidation: 'close' }, false)), { action: 'hold', unfollow: false });
  assert.deepEqual(plain(A.resyncFlat({ onLeaderFlat: 'close', onLeaderLiquidation: 'hold' }, true)), { action: 'hold', unfollow: true });
});

test('the risk stops keep running when the transfer list cannot be read', () => {
  const last = { day: -50, peak: -200, dayKey: '2026-10-02' };
  assert.deepEqual(plain(A.flowsForStops({ day: 10, peak: 30 }, last, '2026-10-02')), { day: 10, peak: 30, stale: false });
  // unreadable: the last full read stands in (the day's only on the same UTC day), never "skip the stops"
  assert.deepEqual(plain(A.flowsForStops({ day: null, peak: null }, last, '2026-10-02')), { day: -50, peak: -200, stale: true });
  assert.deepEqual(plain(A.flowsForStops({ day: null, peak: 30 }, last, '2026-10-03')), { day: 0, peak: 30, stale: true });
  assert.deepEqual(plain(A.flowsForStops({ day: null, peak: null }, null, '2026-10-02')), { day: 0, peak: 0, stale: true });
});