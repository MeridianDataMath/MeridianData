// The snapshot builder's pure helpers (scripts/build-snapshot.mjs; importing it builds nothing): perps rows carried over
// from an earlier snapshot when this run cannot build them, and the Predict claimable read (which wallets to ask, what
// counts as claimable, as the app's Claim card counts it). Then the Leaderboard's coverage of a snapshot, which the
// Leaderboard, Copy trading and Home pages say after its age. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_load.mjs';
import { mergeRows, CARRY_MAX_MS, claimCandidates, claimPlan, claimEntries, CLAIM_RECHECK_MS, CLAIM_REFRESH } from '../scripts/build-snapshot.mjs';

const MD = globalThis.MD;   // the builder loaded util, api, analytics and Predict into this process
MD.router = MD.router || { pages: {} }; MD.ui = MD.ui || {};
load(['js/pages/leaderboard.js']);
const LB = MD.router.pages.leaderboard;

const H = 3600000, NOW = Date.UTC(2026, 9, 5, 21, 0);
const row = (sid, o) => Object.assign({ sid, account: '0x' + sid.padStart(40, '0'), equity: 100, stats: { all: { pnl: 1 } } }, o);
const subs = (...ids) => ids.map((id) => ({ id }));

test('mergeRows: built rows in the account list\'s order; an account not built keeps its earlier row, marked carried with when it was built', () => {
  const prev = { builtAt: NOW - 2 * H, rows: [row('a', { equity: 50 }), row('b', { equity: 70 }), row('gone')] };
  const built = new Map([['a', row('a', { equity: 55 })], ['c', row('c')]]);
  const m = mergeRows(subs('a', 'b', 'c', 'd'), built, [prev], NOW);
  assert.deepEqual(m.rows.map((r) => r.sid), ['a', 'b', 'c']);   // 'gone' is no longer listed; 'd' has no row anywhere
  assert.equal(m.rows[0].equity, 55); assert.equal(m.rows[0].carried, undefined); assert.equal(m.rows[0].builtAt, undefined);
  assert.equal(m.rows[1].equity, 70); assert.equal(m.rows[1].carried, true); assert.equal(m.rows[1].builtAt, NOW - 2 * H);
  assert.equal(m.carried, 1); assert.equal(m.missing, 1);
  assert.equal(prev.rows[1].carried, undefined, 'the earlier snapshot\'s row is copied, not changed');
});

test('mergeRows: the newest row wins across the local and the published snapshot; a row carried twice keeps its first build time', () => {
  const local = { builtAt: NOW - 30 * 24 * H, rows: [row('a', { equity: 1 })] };                     // a weeks-old local file
  const published = { builtAt: NOW - H, rows: [row('a', { equity: 2, carried: true, builtAt: NOW - 5 * H }), row('b', { equity: 3 })] };
  const older = { builtAt: NOW - 3 * H, rows: [row('a', { equity: 4 })] };                          // built after the carried row's own build
  const m = mergeRows(subs('a', 'b'), new Map(), [local, published, older], NOW);
  assert.equal(m.rows[0].equity, 4); assert.equal(m.rows[0].builtAt, NOW - 3 * H);
  assert.equal(m.rows[1].equity, 3); assert.equal(m.rows[1].builtAt, NOW - H);
  const again = mergeRows(subs('a'), new Map(), [published], NOW);
  assert.equal(again.rows[0].builtAt, NOW - 5 * H, 'not the snapshot it was carried in');
});

test('mergeRows: a row older than CARRY_MAX_MS is not carried; missing or malformed earlier snapshots are no rows', () => {
  const stale = { builtAt: NOW - CARRY_MAX_MS - H, rows: [row('a')] };
  const m = mergeRows(subs('a', 'b'), new Map([['b', row('b')]]), [null, stale, { rows: 'x' }, { builtAt: NOW, rows: [null, { sid: 7 }] }], NOW);
  assert.deepEqual(m.rows.map((r) => r.sid), ['b']); assert.equal(m.carried, 0); assert.equal(m.missing, 1);
  assert.deepEqual(mergeRows(subs('a'), new Map([['a', row('a')]]), [], NOW), { rows: [row('a')], carried: 0, missing: 0 });
});

const W = (c) => '0x' + c.repeat(40);
const pos = (o) => Object.assign({ side: 'PREDICTOR', balance: '1055180000000000000000', pickConfigId: '0xpc1', prediction: { predictionId: '0xp1' }, pickConfig: { result: 'PREDICTOR_WINS' } }, o);

test('claimEntries: only the side the verdict pays, with a balance and its prediction, as the app\'s Claim card counts it', () => {
  assert.deepEqual(claimEntries([pos()]), [{ pc: '0xpc1', side: 'P', bal: 1055.18 }]);
  assert.deepEqual(claimEntries([pos({ side: 'COUNTERPARTY', pickConfig: { result: 'COUNTERPARTY_WINS' }, balance: '40000000000000000000', pickConfigId: '0xpc2' })]), [{ pc: '0xpc2', side: 'C', bal: 40 }]);
  assert.deepEqual(claimEntries([
    pos({ side: 'COUNTERPARTY' }),                                          // the losing side of a predictor win
    pos({ balance: '0' }),                                                  // redeemed
    pos({ prediction: null }),                                              // the app keeps a row only with its prediction
    pos({ pickConfig: { result: 'NON_DECISIVE' } }),                       // pays nothing in the app
    pos({ balance: 'not a number' }), null,
  ]), []);
  assert.equal(claimEntries([pos({ balance: '255944457987075770000' })])[0].bal, 255.944458);   // to a millionth
  assert.deepEqual(claimEntries(null), []);
});

test('claimCandidates: the winner of each decided prediction and each buyer once its pick configuration is decided', () => {
  const a = W('a'), b = W('b'), c = W('c'), d = W('d');
  const norms = [
    { decided: true, won: true, nd: false, predictor: a, counterparty: b },    // a won
    { decided: true, won: false, nd: false, predictor: a, counterparty: b },   // the maker b won
    { decided: true, won: true, nd: false, predictor: a, counterparty: b },
    { decided: false, won: false, nd: false, predictor: c, counterparty: b },  // open: nobody holds a paying token yet
    { decided: true, won: false, nd: true, predictor: c, counterparty: b },    // void: pays nothing in the app
    { decided: true, won: true, nd: false, predictor: 'nope', counterparty: b },
  ];
  const trades = [{ pc: '0xpc', vP: 1, vC: 0, buyer: d, seller: a }, { pc: '0xpc2', vP: null, vC: null, buyer: c, seller: a }, { pc: null, vP: 1, buyer: c }];
  assert.deepEqual(Object.assign({}, claimCandidates(norms, trades)), { [a]: 2, [b]: 1, [d]: 1 });
});

test('claimPlan: new wallets, wallets with something to claim and wallets with a new win are asked; the rest only when their answer is old, a few a run', () => {
  const now = NOW;
  const cand = { [W('1')]: 1, [W('2')]: 3, [W('3')]: 2, [W('4')]: 1, [W('5')]: 1, [W('6')]: 1 };
  const seen = {
    [W('2')]: { at: now - H, k: 3, n: 2 },                         // still has winnings to claim
    [W('3')]: { at: now - H, k: 1, n: 0 },                         // won again since
    [W('4')]: { at: now - H, k: 1, n: 0 },                         // nothing since, recent: skipped
    [W('5')]: { at: now - CLAIM_RECHECK_MS - 2 * H, k: 1, n: 0 },  // old answers: refreshed, the oldest first
    [W('6')]: { at: now - CLAIM_RECHECK_MS - 5 * H, k: 1, n: 0 },
    [W('9')]: { at: now, k: 1, n: 0 },                              // no longer a candidate
  };
  assert.deepEqual(claimPlan(cand, seen, now), [W('1'), W('2'), W('3'), W('6'), W('5')]);
  assert.deepEqual(claimPlan(cand, seen, now, { refresh: 1 }), [W('1'), W('2'), W('3'), W('6')]);
  assert.ok(CLAIM_REFRESH > 0);
});

test('Leaderboard coverage: carried rows and missing accounts of a new snapshot; an older snapshot counts accounts short of its list', () => {
  const lb = { builtAt: NOW, accounts: 5, missing: 1, partial: true, rows: [row('a'), row('b', { carried: true, builtAt: NOW - 3 * H }), row('c', { carried: true, builtAt: NOW - H }), row('d')] };
  assert.deepEqual(LB.coverage(lb), { accounts: 5, rows: 4, carried: 2, oldest: NOW - 3 * H, missing: 1, partial: true });
  // the published file the audit read: 219 rows of 222 accounts, 3 failed, no carried rows yet
  const old = { builtAt: NOW, accounts: 222, failed: 3, partial: true, rows: Array.from({ length: 219 }, (_, i) => row('s' + i)) };
  assert.deepEqual(LB.coverage(old), { accounts: 222, rows: 219, carried: 0, oldest: null, missing: 3, partial: true });
  // a browser build from before it counted its accounts: partial, nothing to count
  assert.deepEqual(LB.coverage({ builtAt: NOW, partial: true, rows: [row('a')] }), { accounts: null, rows: 1, carried: 0, oldest: null, missing: 0, partial: true });
  // whole: nothing to say
  const whole = { builtAt: NOW, accounts: 2, partial: false, rows: [row('a'), row('b')] };
  assert.equal(LB.coverage(whole).missing, 0); assert.equal(LB.coverageNote(whole), null); assert.equal(LB.carriedChip(row('a')), null);
  assert.equal(LB.coverage(null), null); assert.equal(LB.coverageNote({}), null);
});
