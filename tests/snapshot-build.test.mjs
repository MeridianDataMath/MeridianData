// The snapshot builder's pure helpers (scripts/build-snapshot.mjs; importing it builds nothing): perps rows carried over
// from an earlier snapshot when this run cannot build them, and the Predict claimable read (which wallets to ask, what
// counts as claimable, as the app's Claim card counts it). Then the Leaderboard's coverage of a snapshot, which the
// Leaderboard, Copy trading and Home pages say after its age. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_load.mjs';
import { mergeRows, CARRY_MAX_MS, claimCandidates, claimPlan, claimEntries, claimReads, balanceCall, capClaims, escrowReads, escrowSum, CLAIM_RECHECK_MS, CLAIM_REFRESH, compactCompetition, COMP_STANDINGS, rankMap, compactMatch, hotRows, cashPlan, cashTransfers, cashBalances, cashFrom, CASH_STALE_MS } from '../scripts/build-snapshot.mjs';

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

test('claimReads / capClaims: each claimable position is read on-chain; the lower balance counts and an empty one is dropped (the API listed 40 tokens 0xc1ce… no longer held)', () => {
  const a = W('a'), b = W('b'), tokP = W('1'), tokC = W('2'), tok2 = W('3');
  const norms = [{ pc: '0xPC1', tokP, tokC }, { pc: '0xpc2', tokP: tok2, tokC: W('4') }, { pc: null, tokP: W('5') }];
  const of = { [a]: [{ pc: '0xpc1', side: 'P', bal: 40 }, { pc: '0xpc2', side: 'P', bal: 12.5 }, { pc: '0xunknown', side: 'P', bal: 3 }], [b]: [{ pc: '0xpc1', side: 'C', bal: 7 }], nope: [{ pc: '0xpc1', side: 'P', bal: 1 }] };
  const reads = claimReads(of, norms);
  // a position whose token no prediction carries, and a wallet that is not an address, are not read
  assert.deepEqual(reads.map((r) => [r.a, r.tok]), [[a, tokP], [a, tok2], [b, tokC]]);
  assert.deepEqual(balanceCall(reads[0]), { method: 'eth_call', params: [{ to: tokP, data: '0x70a08231' + a.slice(2).padStart(64, '0') }, 'latest'] });
  const hex = (usde) => '0x' + (BigInt(Math.round(usde * 1e6)) * 1000000000000n).toString(16);
  // the chain: a holds none of the first (sold and redeemed), less of the second; b's answer is missing
  const r = capClaims(of, reads, [{ result: '0x0' }, { result: hex(10.25) }, { error: { message: 'no answer' } }]);
  assert.deepEqual(r, { read: 2, lowered: 2, dropped: 1, unread: 1 });
  assert.deepEqual(of[a], [{ pc: '0xpc2', side: 'P', bal: 10.25 }, { pc: '0xunknown', side: 'P', bal: 3 }]);
  assert.deepEqual(of[b], [{ pc: '0xpc1', side: 'C', bal: 7 }]);   // unread: the API's balance stands
  // more on-chain than the API lists (tokens sent from outside the market): the API's figure stays, as the app shows it
  const of2 = { [a]: [{ pc: '0xpc1', side: 'P', bal: 5 }] };
  assert.deepEqual(capClaims(of2, claimReads(of2, norms), [{ result: hex(9) }]), { read: 1, lowered: 0, dropped: 0, unread: 0 });
  assert.equal(of2[a][0].bal, 5);
  // the same balance on both sides, however its last wei round, is not lower (claimEntries rounds the API's to a millionth)
  const of4 = { [a]: [{ pc: '0xpc1', side: 'P', bal: 255.944458 }] };
  assert.equal(capClaims(of4, claimReads(of4, norms), [{ result: '0x' + (255944457987075770000n).toString(16) }]).lowered, 0);
  // an empty answer ("0x": no contract there) is no balance
  const of3 = { [a]: [{ pc: '0xpc1', side: 'P', bal: 5 }] };
  assert.equal(capClaims(of3, claimReads(of3, norms), [{ result: '0x' }]).unread, 1);
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

test('escrowReads / escrowSum: Meridian OI per question from the position tokens still out (undecided: the bettor side; decided: the winner\'s), drained decided ones never read again', () => {
  const n = (pc, ids, o) => Object.assign({ pc, picks: ids.map((id) => ({ id })), tokP: pc + '-P', tokC: pc + '-C', decided: false, won: false, nd: false }, o);
  const norms = [
    n('pc1', ['qa']),                                     // a single, open
    n('pc1', ['qa']),                                     // the same picks again: one pick configuration
    n('pc2', ['qa', 'qb']),                               // a combo, open: counts in full on both questions
    n('pc3', ['qb'], { decided: true, won: false }),      // the maker won: its token is what is still to redeem
    n('pc4', ['qb'], { decided: true, won: true }),       // the bettor won, already drained (cached)
    n('pc5', ['qz']),                                     // a question not asked about
    n(null, ['qa']),                                      // no pick configuration
  ];
  const reads = escrowReads(norms, new Set(['qa', 'qb']), { pc4: 1 });
  assert.deepEqual(reads.map((r) => [r.pc, r.tok, r.decided, r.ids.join()]), [['pc1', 'pc1-P', false, 'qa'], ['pc2', 'pc2-P', false, 'qa,qb'], ['pc3', 'pc3-C', true, 'qb']]);
  const hex = (usde) => '0x' + (BigInt(Math.round(usde * 1e6)) * 1000000000000n).toString(16);
  // pc1 holds 100 (both bets' pools, less any merged), pc2 25, pc3 drained
  const s = escrowSum(reads, [{ result: hex(100) }, { result: hex(25) }, { result: '0x0' }]);
  assert.deepEqual(s.per, { qa: 125, qb: 25 });
  assert.deepEqual(s.drained, ['pc3']);
  assert.equal(s.unread, 0);
  assert.equal(escrowSum(reads, [{ result: hex(1) }, { error: { message: 'x' } }, { result: '0x' }]).unread, 2);
});

// Meridian's own lists the snapshot carries (the shapes read on 2026-10-21); `out` stands in for the left-out wallets
const WL = (k) => '0x' + String(k).repeat(40).slice(0, 40);
const wei = (usde) => (BigInt(Math.round(usde * 1e6)) * 1000000000000n).toString();
const out = (a) => a === WL('d');

test('compactCompetition: window, prizes, rules, market counts and the standings best first, a left-out wallet not listed', () => {
  const c = { slug: 'nfl-week-4', title: 'NFL Week 4', label: 'NFL', startsAt: '2026-09-30T04:00:00.000Z', endsAt: '2026-10-06T13:00:00.000Z', payouts: ['200', '75', '50'], prizeUnit: 'USDe', minStake: '10', minLegs: 2, rankBy: 'MULTIPLIER', disqualifyEarlySales: true, eligibleMarketKinds: { gameEventIds: ['885112', '909431'], groupIds: [], conditionIds: [] } };
  const st = [{ rank: 2, account: WL('B'), multiplier: 8.761949443, predictionId: '0x2', payout: wei(87.62), stake: wei(10) }, { rank: 1, account: WL('a'), multiplier: 15.588582223, predictionId: '0x1', payout: wei(210.45), stake: wei(13.5) }, { rank: 3, account: WL('d'), multiplier: 5, payout: wei(50), stake: wei(10) }];
  const x = compactCompetition(c, st, 36, out);
  assert.equal(x.start, Date.UTC(2026, 8, 30, 4)); assert.equal(x.end, Date.UTC(2026, 9, 6, 13));
  assert.deepEqual(x.payouts, [200, 75, 50]); assert.equal(x.minStake, 10); assert.equal(x.minLegs, 2); assert.equal(x.rankBy, 'MULTIPLIER'); assert.equal(x.noEarlySales, true);
  assert.deepEqual(x.markets, { games: 2, groups: 0, questions: 0, eligible: 36 });
  assert.equal(x.entries, 2);
  assert.deepEqual(x.standings, [{ r: 1, a: WL('a'), m: 15.5886, p: 210.45, s: 13.5, id: '0x1' }, { r: 2, a: WL('b'), m: 8.7619, p: 87.62, s: 10, id: '0x2' }]);
  assert.equal(compactCompetition(c, Array.from({ length: 40 }, (_, i) => ({ rank: i + 1, account: WL(i % 9 + 1), payout: wei(1), stake: wei(1) })), null, out).standings.length, COMP_STANDINGS);
});

test('rankMap: Meridian\'s own rank and PnL by wallet; compactMatch: a match\'s name, start, league and volume windows', () => {
  const m = rankMap([{ rank: 1, pnl: wei(18810.12), account: { address: WL('A') } }, { rank: 2, pnl: wei(100), account: { address: WL('d') } }, { rank: 3, pnl: '-' + wei(5), account: { address: WL('c') } }], out);
  assert.deepEqual(Object.assign({}, m), { [WL('a')]: [1, 18810.12], [WL('c')]: [3, -5] });   // rank 3 stays Meridian's 3
  const x = compactMatch({ externalEventId: '909431', name: 'Colts vs. Commanders', startTime: '2026-10-04T13:30:00.000Z', teams: [{ league: 'nfl' }, { league: 'nfl' }], d1: 4810386.74, d7: '5000000' });
  assert.deepEqual(x, { n: 'Colts vs. Commanders', t: Date.UTC(2026, 9, 4, 13, 30), lg: 'nfl', v: { d1: 4810386.74, d7: 5000000 } });
});

test('hotRows: Meridian\'s Hot list in its order, a group\'s questions added up', () => {
  const edges = [
    { node: { __typename: 'Condition', conditionId: '0xc1', question: 'San Francisco wins', similarMarketVolumeFiltered1h: 120.5, similarMarketVolumeFiltered24h: 77379023.32, category: { name: 'Sports' }, conditionGroup: { externalEventId: 'KXNFLGAME-26OCT19WASSF' } } },
    { node: { __typename: 'ConditionGroup', groupId: 960, name: 'World Cup Winner', externalEventId: '30615', category: { name: 'Sports' }, conditions: { nodes: [{ similarMarketVolumeFiltered24h: 10 }, { similarMarketVolumeFiltered24h: 5.5 }] } } },
    { node: { __typename: 'ConditionGroupCluster' } },
  ];
  assert.deepEqual(hotRows(edges, 'd1'), [{ k: 'c', id: '0xc1', q: 'San Francisco wins', cat: 'Sports', ev: 'KXNFLGAME-26OCT19WASSF', v: 77379023.32 }, { k: 'g', id: '960', q: 'World Cup Winner', cat: 'Sports', ev: '30615', v: 15.5, n: 2 }]);
  assert.equal(hotRows(edges, 'h1')[0].v, 120.5);
});

test('cashPlan: wallets never read first, then active since their last read, then a week unread, each the most recently active first', () => {
  const now = Date.UTC(2026, 9, 21), H = 3600000;
  const active = { [WL(1)]: now - 5 * H, [WL(2)]: now - H, [WL(3)]: now - 2 * H, [WL(4)]: now - 30 * 24 * H, [WL(5)]: now - 3 * H };
  const cache = { [WL(3)]: { at: now - 10 * H }, [WL(4)]: { at: now - CASH_STALE_MS - H }, [WL(5)]: { at: now - H } };
  assert.deepEqual(cashPlan(active, cache, now, 10), [WL(2), WL(1), WL(3), WL(4)]);   // WL(5): read since its last activity
  assert.deepEqual(cashPlan(active, cache, now, 1), [WL(2)]);
  // a wallet's transfers: in +, out − with the other address, newest first; its balance oldest first
  const me = WL('e');
  const xf = cashTransfers([{ from: WL('F'), to: me, timestamp: '2026-10-20T14:15:00.000Z', transactionHash: '0xa', value: wei(84.5) }, { from: me, to: WL('f'), timestamp: '2026-10-20T14:41:59.000Z', transactionHash: '0xb', value: wei(1256.34) }, { from: WL('f'), to: me, timestamp: '2026-10-19T00:00:00.000Z', value: '0' }], me);
  assert.deepEqual(xf, [[Date.UTC(2026, 9, 20, 14, 41, 59), -1256.34, WL('f'), '0xb'], [Date.UTC(2026, 9, 20, 14, 15), 84.5, WL('f'), '0xa']]);
  assert.deepEqual(cashBalances([{ timestamp: '2026-10-20T22:25:48.141Z', amount: wei(0.66) }, { timestamp: '2026-10-19T22:25:48.141Z', amount: wei(0.36) }]), [[Date.UTC(2026, 9, 19, 22, 25, 48, 141), 0.36], [Date.UTC(2026, 9, 20, 22, 25, 48, 141), 0.66]]);
  // the history runs back at 0 as far as it is paged: kept from `from` on, from the day before the first balance not 0
  const day = (d) => ({ timestamp: new Date(Date.UTC(2026, 9, d, 22)).toISOString(), amount: d >= 10 ? wei(d) : '0' });
  assert.deepEqual(cashBalances([12, 11, 10, 9, 8, 3].map(day), Date.UTC(2026, 9, 5)).map((x) => x[1]), [0, 10, 11, 12]);
  assert.deepEqual(cashBalances([2, 1].map(day)), []);
  // two days before its first activity or transfer, never before the exchange's start
  assert.equal(cashFrom(Date.UTC(2026, 9, 10), [[Date.UTC(2026, 9, 12), 5]]), Date.UTC(2026, 9, 8));
  assert.equal(cashFrom(Date.UTC(2026, 9, 10), [[Date.UTC(2026, 9, 3), 5]]), Date.UTC(2026, 9, 1));
  assert.equal(cashFrom(null, []), MD.predict.EXCHANGE_START_SEC * 1000);
});
