// Predict: positions and payouts to claim as Meridian's app counts them (its Predict portfolio: Open Positions, Claimable
// Payout, the Open Positions cards), the launch-day tests the snapshot leaves out, and the order book's midpoints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, near } from './_load.mjs';

const MD = load(['js/util.js', 'js/api.js', 'js/predict/api.js', 'js/predict/analytics.js']);
const P = MD.predict;
const DAY = 86400000, T0 = Date.UTC(2026, 7, 1);
const wei = (x) => (BigInt(Math.round(x * 1e6)) * 1000000000000n).toString();
const ME = '0x00000000000000000000000000000000000000b1', MAKER = '0x00000000000000000000000000000000000000a1';
// verdict: null (open), 'PREDICTOR_WINS' | 'COUNTERPARTY_WINS'; claimed: the API's settled flag; pc: the pick configuration
const pred = (id, stake, cp, verdict, claimed, pc, o = {}) => P.norm({ predictionId: id, predictor: o.p || ME, counterparty: o.c || MAKER, predictorCollateral: wei(stake), counterpartyCollateral: wei(cp),
  settled: !!claimed, result: claimed ? verdict : null, createdAt: new Date(o.t || T0).toISOString(), settledAt: claimed ? new Date((o.t || T0) + DAY).toISOString() : null,
  pickConfig: { pickConfigId: pc, resolved: !!verdict, result: verdict, picks: (o.legs || [['c-' + pc, 'YES']]).map(([id2, out]) => ({ conditionId: id2, predictedOutcome: out, condition: { question: 'Q ' + id2, endTime: Math.floor(((o.t || T0) + DAY) / 1000) } })) } });
// a row of the API's positions(holder, claimable: true)
const apiPos = (pc, side, bal, result) => ({ side, balance: wei(bal), pickConfig: { pickConfigId: pc, result }, prediction: { predictionId: 'x' } });

test('claimable positions: a token on its winning side with a balance, from the API or a wallet file', () => {
  const rows = P.claimRows([apiPos('0xPC1', 'PREDICTOR', 1055.18, 'PREDICTOR_WINS'), apiPos('0xpc2', 'COUNTERPARTY', 5, 'PREDICTOR_WINS'), apiPos('0xpc3', 'COUNTERPARTY', 7, 'COUNTERPARTY_WINS'), apiPos('0xpc4', 'PREDICTOR', 0, 'PREDICTOR_WINS'), apiPos('0xpc5', 'PREDICTOR', 3, 'NON_DECISIVE')]);
  assert.deepEqual(rows.map((r) => [r.pc, r.side]), [['0xpc1', 'P'], ['0xpc3', 'C']], 'the losing side, a zero balance and a 50/50 pay nothing in the app');
  near(assert, rows[0].bal, 1055.18, 1e-9);
  assert.deepEqual(P.claimRows([{ pc: '0xAB', side: 'P', bal: 2.5 }, { pc: '0xcd', side: 'X', bal: 1 }, { pc: '0xef', side: 'C', bal: 0 }]), [{ pc: '0xab', side: 'P', bal: 2.5 }]);
  assert.deepEqual(P.claimRows(null), []);
});

test('to claim is the winner\'s token balance, not the API\'s settled flag (0x67b3…: $1,055.18; 0x44db…: $0; 0xc1ce…: $40)', () => {
  // settled on Meridian, the winning tokens never redeemed: the app's $1,055.18 to claim
  const settledHeld = pred('a', 1000, 55.18, 'PREDICTOR_WINS', true, '0xa8e7');
  // not flagged settled, but the tokens are gone: nothing to claim in the app
  const unflaggedGone = pred('b', 10, 28.87, 'PREDICTOR_WINS', false, '0xb0');
  // three wins on one pick configuration whose tokens were partly sold: the balance, 40, is what it pays
  const twins = [pred('c1', 20, 30, 'PREDICTOR_WINS', false, '0x76dc'), pred('c2', 20, 30, 'PREDICTOR_WINS', false, '0x76dc'), pred('c3', 8, 17.7, 'PREDICTOR_WINS', false, '0x76dc')];
  const lost = pred('d', 5, 10, 'COUNTERPARTY_WINS', false, '0xd0');
  const norms = [settledHeld, unflaggedGone, ...twins, lost];
  const C = P.applyClaims(norms, ME, [apiPos('0xa8e7', 'PREDICTOR', 1055.18, 'PREDICTOR_WINS'), apiPos('0x76dc', 'PREDICTOR', 40, 'PREDICTOR_WINS')]);
  near(assert, C.total, 1095.18, 1e-9, 'the app\'s Claimable Payout'); near(assert, C.payout, 1095.18, 1e-9);
  assert.equal(C.positions, 2); assert.equal(C.wonP, 4); assert.equal(C.wonC, 0);
  assert.equal(settledHeld.toClaim, true); assert.equal(unflaggedGone.toClaim, false); assert.deepEqual(twins.map((n) => n.toClaim), [true, true, true]);
  assert.equal(lost.toClaim, undefined, 'a loss is the maker\'s to claim: not this wallet\'s balance');
  // the result chips follow the balance where it is known, the flag elsewhere
  assert.equal(P.resultFor(settledHeld, false).label, 'won · unclaimed');
  assert.equal(P.resultFor(unflaggedGone, false).label, 'won');
  assert.equal(P.resultFor(pred('e', 1, 1, 'PREDICTOR_WINS', false, '0xe0'), false).label, 'won · unclaimed', 'no balance read: the flag');
  // the headline: the balances in place of the pots of the unflagged wins (which said $198.25 here, and $38.87 above)
  const F = P.bettorFigures({ mine: norms, hist: [{ t: T0, pnl: 0, won: 1, lost: 0, pending: 5, nonDecisive: 0 }], isMaker: false, live: true, claim: C });
  near(assert, F.unclaimedPayout, 1095.18, 1e-9); assert.equal(F.unclaimedWon, 4); assert.equal(F.claim, C);
  const old = P.bettorFigures({ mine: norms, hist: [{ t: T0, pnl: 0, won: 1, lost: 0, pending: 5, nonDecisive: 0 }], isMaker: false, live: true });
  near(assert, old.unclaimedPayout, 38.87 + 50 + 50 + 25.7, 1e-6, 'without the balances, the old way');
  assert.equal(F.won, old.won, 'the record still follows the exchange\'s counts');
});

test('a self-matched pot is set apart from a balance it shares (0xf069…: the app $1.66, the site $0.66)', () => {
  const win = pred('w', 0.4, 0.26, 'PREDICTOR_WINS', false, '0x2755');
  const self = pred('s', 0.5, 0.5, 'PREDICTOR_WINS', false, '0x2755', { c: ME });
  const C = P.applyClaims([win], ME, [{ pc: '0x2755', side: 'P', bal: 1.66 }], { self: [self] });
  near(assert, C.total, 1.66, 1e-9); near(assert, C.self, 1, 1e-9); near(assert, C.payout, 0.66, 1e-9); assert.equal(C.selfN, 1); assert.equal(C.positions, 1);
  // a balance that is all self-match counts no position
  const only = P.applyClaims([], ME, [{ pc: '0x2755', side: 'P', bal: 1 }], { self: [self] });
  near(assert, only.payout, 0, 1e-9); assert.equal(only.positions, 0);
});

test('offline, balances on predictions the snapshot leaves out are set apart (0xd461…: $9.88 in the app, $2.53 here)', () => {
  const win = pred('w', 1, 1.53, 'PREDICTOR_WINS', false, '0xfb89');
  const claim = [{ pc: '0xfb89', side: 'P', bal: 2.53 }, { pc: '0xpre1', side: 'P', bal: 1.02 }, { pc: '0xpre2', side: 'P', bal: 6.33 }, { pc: '0xbought', side: 'P', bal: 3 }];
  const C = P.applyClaims([win], ME, claim, { pcs: ['0xBOUGHT'], dropUnknown: true });
  near(assert, C.total, 12.88, 1e-9); near(assert, C.other, 7.35, 1e-9); assert.equal(C.otherN, 2);
  near(assert, C.payout, 5.53, 1e-9, 'its own win and the tokens it bought'); assert.equal(C.positions, 2);
  // live (or a truncated file, whose older predictions are not loaded) every balance is the wallet's
  near(assert, P.applyClaims([win], ME, claim).payout, 12.88, 1e-9);
  // the launch-day tests: a closed set of 15, every one against one counterparty
  const pre = Object.values(P.PRE_LAUNCH);
  assert.equal(pre.filter((x) => !x.maker).reduce((a, x) => a + x.n, 0), 15); assert.equal(pre.find((x) => x.maker).n, 15);
  assert.deepEqual(P.preLaunchOf('0xD4612BD63DBE6BEEA4A5C8FECB5011DDBD8FB976'), { n: 9, v: 9 }); assert.equal(P.preLaunchOf(ME), null);
  // the app's history starts a week before the launch: the tests are booked on 06-26 and 06-28
  assert.equal(new Date(P.EXCHANGE_START_SEC * 1000).toISOString(), '2026-06-22T00:00:00.000Z');
  assert.ok(P.EXCHANGE_START_SEC < P.LAUNCH_SEC);
});

test('open positions as Meridian counts them: one per pick configuration and side with tokens still held', () => {
  // 0xaedd…: six bets on one Clarity Act YES are one position, $138 paying $726.72
  const clarity = [[50, 193], [50, 221], [8, 36.74], [10, 46.28], [10, 46.28], [10, 46.28]].map(([s, p], i) => pred('cl' + i, s, p - s, null, false, '0x9cb2', { t: T0 + i * 1000 }));
  const other = pred('o', 5, 5, null, false, '0xother');
  const keyOf = (n) => P.posKey(n, 'P');
  assert.equal(new Set(clarity.map(keyOf)).size, 1); assert.notEqual(keyOf(other), keyOf(clarity[0]));
  assert.notEqual(P.posKey(clarity[0], 'P'), P.posKey(clarity[0], 'C'), 'the other side is another position');
  const rows = clarity.concat(other).map((n) => ({ id: n.id, key: keyOf(n), stake: n.stake, payout: n.pool, t: n.t }));
  const g = P.groupPositions(rows);
  assert.equal(g.length, 2);
  assert.equal(g[0].n, 6); near(assert, g[0].stake, 138, 1e-9); near(assert, g[0].payout, 589.58, 1e-6); assert.deepEqual(g[0].ids.length, 6);
  assert.equal(g[0].id, 'cl0', 'a click opens the largest bet (the first of equal ones)'); assert.equal(g[0].t, T0, 'the earliest bet');
  near(assert, g[0].odds, 138 / 589.58, 1e-9);
  // a record that does not carry its pick configuration (an older wallet file) goes by its picks, which are what one is
  const noPc = (n) => Object.assign({}, n, { pc: null, pk: null });
  assert.equal(P.posKey(noPc(clarity[0]), 'P'), P.posKey(noPc(clarity[3]), 'P'));
  assert.notEqual(P.posKey(noPc(clarity[0]), 'P'), P.posKey(noPc(other), 'P'));
  // the headline: 7 undecided predictions, 2 positions; sold out of one of them (0xaca4…: 7 open, all sold, 0 in the app)
  const mine = clarity.concat(other);
  const fig = P.bettorFigures({ mine, hist: [], isMaker: false, live: false });
  assert.equal(fig.open, 7); assert.equal(fig.openPos, 2);
  const ledger = { byPrediction: { o: { held: 0, pnl: 0 } }, adj: 0 };
  assert.equal(P.bettorFigures({ mine, hist: [], isMaker: false, live: false, ledger }).openPos, 1);
  assert.equal(P.bettorFigures({ mine, hist: [], isMaker: false, live: false, truncated: true }).openPos, null, 'not all loaded: unknown');
});

test('a maker that buys the bettor\'s side back holds no open position there: the pair is burned (0x79cb…: 33 such)', () => {
  const B2 = '0x00000000000000000000000000000000000000b2';
  const n = pred('x', 10, 30, null, false, '0xpcx', { p: B2 }), keep = pred('y', 10, 30, null, false, '0xpcy', { p: B2 });
  const trades = [{ t: T0 + 1000, seller: B2, buyer: MAKER, tokens: 40, paid: 20, pc: '0xpcx', side: 'P', vP: null, vC: null }];
  const L = P.ledger([n, keep], trades, MAKER);
  assert.equal(L.byPrediction.x.held, 1, 'the ledger still holds a matched set'); assert.equal(L.byPrediction.x.atRisk, 0, 'but nothing of it is at risk');
  const fig = P.bettorFigures({ mine: [n, keep], hist: [], isMaker: true, live: false, ledger: L });
  assert.equal(fig.open, 2); assert.equal(fig.openPos, 1);
  assert.equal(P.aggregate([n, keep], { trades }).makers[0].openPos, 1);
  assert.equal(P.riskOf({ held: 0.5 }), 0.5, 'an entry from before atRisk: its held share');
});

test('the aggregate counts open positions per row, and with the balances whether each win is still to claim', () => {
  const B2 = '0x00000000000000000000000000000000000000b2';
  const norms = [
    ...[0, 1, 2].map((i) => pred('cl' + i, 10, 40, null, false, '0x9cb2', { t: T0 + i })),   // one position, three bets
    pred('o', 5, 5, null, false, '0xother'),
    pred('held', 1000, 55.18, 'PREDICTOR_WINS', true, '0xa8e7', { p: B2 }),    // settled, tokens still held: to claim
    pred('gone', 10, 28.87, 'PREDICTOR_WINS', false, '0xb0', { p: B2 }),      // unflagged, tokens gone: claimed
    pred('mk', 5, 10, 'COUNTERPARTY_WINS', false, '0xd0', { p: B2 }),          // the maker's win, its tokens still held
  ];
  const plain = P.aggregate(norms.map((n) => Object.assign({}, n)));
  const me = plain.bettors.find((b) => b.address === ME), b2 = plain.bettors.find((b) => b.address === B2);
  assert.equal(me.open, 4); assert.equal(me.openPos, 2);
  assert.equal(b2.unclaimedWon, 1); near(assert, b2.unclaimedPayout, 38.87, 1e-6, 'the flag: the unflagged win');
  assert.equal(plain.totals.unclaimed, 2); assert.equal(plain.totals.unclaimedLost, 1);
  const a = P.aggregate(norms, { claims: { [B2]: [apiPos('0xa8e7', 'PREDICTOR', 1055.18, 'PREDICTOR_WINS')], [MAKER]: [{ pc: '0xd0', side: 'C', bal: 15 }] } });
  const b2c = a.bettors.find((b) => b.address === B2);
  assert.equal(b2c.unclaimedWon, 1); near(assert, b2c.unclaimedPayout, 1055.18, 1e-6, 'its balance');
  assert.equal(a.totals.unclaimed, 2); assert.equal(a.totals.unclaimedWon, 1); assert.equal(a.totals.unclaimedLost, 1); near(assert, a.totals.unclaimedWonPayout, 1055.18, 1e-6);
  near(assert, a.makers[0].unclaimedPayout, 15, 1e-9, 'the maker\'s balance');
  assert.equal(a.totals.fromBalances, true); assert.equal(plain.totals.fromBalances, undefined, 'a page says the counts follow the balances only when they do');
  // the records say so (tc), and read back
  const rec = (id) => P.full(a.tape.find((x) => x.id === id));
  assert.equal(rec('held').toClaim, true); assert.equal(rec('gone').toClaim, false); assert.equal(rec('cl0').toClaim, null, 'open: nothing to claim');
  assert.equal(P.resultFor(rec('held'), false).label, 'won · unclaimed'); assert.equal(P.resultFor(rec('gone'), false).label, 'won');
  assert.equal(P.unslim(JSON.parse(JSON.stringify(P.slim(norms.find((n) => n.id === 'held'))))).toClaim, true);
  assert.equal(P.full(plain.tape.find((x) => x.id === 'held')).toClaim, null, 'a snapshot without the balances: unknown');
});

test('a wallet file names an untraded prediction\'s pick configuration (pk); pc stays the mark of a traded one', () => {
  const n = pred('a', 10, 30, null, false, '0xpc');
  const file = JSON.parse(JSON.stringify(P.slim(n, { stx: true, vt: true })));
  assert.equal(file.pk, '0xpc'); assert.equal('pc' in file, false);
  const u = P.unslim(file);
  assert.equal(u.pk, '0xpc'); assert.equal(u.pc, null); assert.equal(u.pcTraded, false);
  assert.equal(P.posKey(u, 'P'), '0xpc|P');
  assert.equal('pk' in JSON.parse(JSON.stringify(P.slim(n))), false, 'slips and question files stay small');
  n.pcTraded = true;
  const traded = JSON.parse(JSON.stringify(P.slim(n, { stx: true })));
  assert.equal(traded.pc, '0xpc'); assert.equal('pk' in traded, false);
  // an older file without pk reads as before
  const older = P.unslim(Object.assign({}, file, { pk: undefined }));
  assert.equal(older.pk, null); assert.equal(older.toClaim, null);
});

test('midpoints: Polymarket\'s order book, 100 tokens a request, unknown tokens and odd values left out', async () => {
  const calls = []; const real = globalThis.fetch;
  globalThis.fetch = async (url, o) => { const body = JSON.parse(o.body); calls.push(body.length); const out = {}; for (const { token_id: t } of body) if (t !== 'gone') out[t] = t === 'odd' ? '1.7' : '0.225'; return { ok: true, json: async () => out }; };
  try {
    const toks = Array.from({ length: 150 }, (_, i) => 't' + i).concat(['gone', 'odd', 't1']);
    const m = await P.midpoints(toks);
    assert.deepEqual(calls, [100, 52], 'deduplicated, in chunks of 100');
    assert.equal(m.t0, 0.225); assert.equal(m.t149, 0.225); assert.equal('gone' in m, false); assert.equal('odd' in m, false);
    assert.deepEqual(await P.midpoints([]), {});
  } finally { globalThis.fetch = real; }
});

test('claimable positions are read page by page', async () => {
  const real = P.gql; const seen = [];
  P.gql = async (q, v) => { seen.push(v.after); const page = v.after ? 2 : 1; return { positions: { totalCount: 2, pageInfo: { hasNextPage: page === 1, endCursor: 'c1' }, nodes: [apiPos('0xp' + page, 'PREDICTOR', page, 'PREDICTOR_WINS')] } }; };
  try {
    const rows = await P.claimableOf('0xABC');
    assert.deepEqual(seen, [null, 'c1']); assert.equal(rows.length, 2); assert.equal(rows.truncated, false);
    assert.deepEqual(P.claimRows(rows).map((r) => r.bal), [1, 2]);
    const capped = await P.claimableOf('0xabc', { maxPages: 1 });
    assert.equal(capped.truncated, true, 'a list cut short says so (the page then keeps the old way)');
  } finally { P.gql = real; }
});
