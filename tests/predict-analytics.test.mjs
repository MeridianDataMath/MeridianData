// Predict: prediction semantics (decided vs settled), per-wallet files, result chips and a bettor page's headline figures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, near } from './_load.mjs';

const MD = load(['js/util.js', 'js/api.js', 'js/predict/api.js', 'js/predict/analytics.js']);
const P = MD.predict;
const DAY = 86400000, T0 = Date.UTC(2026, 7, 1);
const wei = (x) => (BigInt(Math.round(x * 1e6)) * 1000000000000n).toString();
const ME = '0x00000000000000000000000000000000000000b1', MAKER = '0x00000000000000000000000000000000000000a1';
// verdict: null (open), 'PREDICTOR_WINS' | 'COUNTERPARTY_WINS' | 'NON_DECISIVE'; claimed: settled on the exchange
const pred = (id, stake, cp, verdict, claimed, t = T0) => P.norm({ predictionId: id, predictor: ME, counterparty: MAKER, predictorCollateral: wei(stake), counterpartyCollateral: wei(cp),
  settled: !!claimed, result: claimed ? verdict : null, createdAt: new Date(t).toISOString(), settledAt: claimed ? new Date(t + DAY).toISOString() : null,
  pickConfig: { pickConfigId: 'pc-' + id, resolved: !!verdict, result: verdict, picks: [{ conditionId: 'c' + id, predictedOutcome: 'YES', condition: { question: 'Q', endTime: Math.floor((t + DAY / 2) / 1000) } }] } });

test('results count from the verdict; the claim is only the cash moving', () => {
  const won = pred('w', 10, 30, 'PREDICTOR_WINS', false), lost = pred('l', 10, 30, 'COUNTERPARTY_WINS', true), nd = pred('v', 10, 30, 'NON_DECISIVE', false), open = pred('o', 10, 30, null, false);
  assert.equal(won.decided, true); assert.equal(won.unclaimed, true); assert.equal(won.pnl, 30);
  assert.equal(lost.decided, true); assert.equal(lost.unclaimed, false); assert.equal(lost.pnl, -10);
  assert.equal(nd.nd, true); assert.equal(nd.pnl, 0);
  assert.equal(open.decided, false); assert.equal(open.pnl, 0);
  near(assert, won.odds, 0.25, 1e-12, 'locked odds = stake / pool');
});

test('a per-wallet file round-trips what the pages need (P.slim → P.unslim)', () => {
  for (const n of [pred('a', 5, 38.6136, 'COUNTERPARTY_WINS', true), pred('b', 10, 18.9358, 'PREDICTOR_WINS', false), pred('c', 3, 4, 'NON_DECISIVE', false), pred('d', 1, 2, null, false)]) {
    n.pcTraded = true;
    const u = P.unslim(JSON.parse(JSON.stringify(P.slim(n))));
    for (const k of ['decided', 'settled', 'unclaimed', 'won', 'lost', 'nd', 'pc']) assert.equal(u[k], n[k], `${n.id}.${k}`);
    near(assert, u.pnl, n.pnl, 1e-4, n.id + '.pnl');
  }
  const plain = P.slim(pred('e', 1, 1, null, false)); assert.equal('pc' in JSON.parse(JSON.stringify(plain)), false, 'pc only where traded');
});

test('each leg keeps Meridian\'s result, and the tape and big wins keep every leg\'s question id', () => {
  // a 3-leg combo lost on its second leg (resolved NO against a YES pick), its third leg 50/50 and its first won
  const leg = (id, yes, cond) => ({ conditionId: id, predictedOutcome: yes ? 'YES' : 'NO', condition: Object.assign({ question: 'Q ' + id, endTime: Math.floor((T0 + DAY) / 1000) }, cond) });
  const combo = P.norm({ predictionId: 'k', predictor: ME, counterparty: MAKER, predictorCollateral: wei(10), counterpartyCollateral: wei(90), settled: true, result: 'COUNTERPARTY_WINS', createdAt: new Date(T0).toISOString(), settledAt: new Date(T0 + 2 * DAY).toISOString(),
    pickConfig: { pickConfigId: 'pc-k', resolved: true, result: 'COUNTERPARTY_WINS', picks: [leg('0xa', true, { settled: true, resolvedToYes: true }), leg('0xb', true, { settled: true, resolvedToYes: false }), leg('0xc', false, { settled: true, nonDecisive: true }), leg('0xd', true, {})] } });
  const round = (o) => P.unslim(JSON.parse(JSON.stringify(P.slim(combo, o))));
  for (const u of [round(), round({ ids: true })]) {
    assert.deepEqual(u.picks.map((k) => k.settled), [true, true, true, false]);
    assert.deepEqual(u.picks.map((k) => k.resolvedToYes), [true, false, null, null]);
    assert.deepEqual(u.picks.map((k) => k.nonDecisive), [false, false, true, false]);
  }
  assert.deepEqual(round().picks.map((k) => k.id), [null, null, null, null], 'a settled prediction\'s file drops the ids');
  assert.deepEqual(round({ ids: true }).picks.map((k) => k.id), ['0xa', '0xb', '0xc', '0xd'], 'unless every id is asked for');
  // a file written before the result was kept reads as unsettled legs
  const old = P.slim(combo); old.k = old.k.map((a) => a.slice(0, 5));
  assert.deepEqual(P.unslim(old).picks.map((k) => k.settled), [false, false, false, false]);

  // big wins: a payout (stake included) above P.BIG_WIN, latest verdict first; the tape keeps every leg
  const big = pred('big', 25, 943, 'PREDICTOR_WINS', true, T0), later = pred('later', 400, 150, 'PREDICTOR_WINS', false, T0 + 3 * DAY);
  const small = pred('small', 100, 399, 'PREDICTOR_WINS', true), exact = pred('exact', 250, 250, 'PREDICTOR_WINS', true), lost = pred('lost', 600, 900, 'COUNTERPARTY_WINS', true);
  const a = P.aggregate([big, later, small, exact, lost, combo]);
  assert.deepEqual(a.bigWins.map((s) => s.id), ['later', 'big'], 'over $500 paid out, wins only, newest verdict first');
  assert.equal(P.unslim(a.bigWins[1]).pool, 968);
  // the tape keeps the fields the Overview has always read (a site that has not reloaded still renders it) and adds the legs
  const row = a.tape.find((s) => s.id === 'k');
  for (const f of ['predictor', 'counterparty', 'stake', 'odds', 'legs', 'q', 'yes', 'decided', 'won', 'pnl']) assert.ok(f in row, 'tape row keeps ' + f);
  const full = P.full(JSON.parse(JSON.stringify(row)));
  assert.deepEqual(full.picks.map((k) => k.id), ['0xa', '0xb', '0xc', '0xd']);
  assert.deepEqual(full.picks.map((k) => k.resolvedToYes), [true, false, null, null]);
  for (const f of ['decided', 'settled', 'won', 'lost', 'nd', 'legs', 'predictor', 'counterparty', 'tx', 'settledAt']) assert.equal(full[f], combo[f], 'P.full(tape row).' + f);
  near(assert, full.pnl, combo.pnl, 1e-4, 'pnl'); near(assert, full.pool, combo.pool, 1e-4, 'pool');
  assert.equal(P.full(a.bigWins[0]).id, 'later', 'a big win (slim) too');
  // a tape row from before the legs were kept: the first leg, the real leg count, marked partial
  const oldRow = Object.assign({}, row); delete oldRow.k;
  const part = P.full(oldRow);
  assert.equal(part.partial, true); assert.equal(part.legs, 4); assert.equal(part.picks.length, 1); assert.equal(part.picks[0].q, 'Q 0xa'); assert.equal(part.lost, true);
  assert.equal(P.aggregate([big], { bigWins: false }).bigWins, undefined, 'a bettor\'s own summary skips the list');
});

test('a big win whose bettor sold the tokens carries what it still held and its own result (0x4400…: sold $562 of winning tokens for $25)', () => {
  const BUYER = '0x00000000000000000000000000000000000000c1';
  const won = pred('sold', 500, 61.98, 'PREDICTOR_WINS', false), kept = pred('kept', 900, 27.4, 'PREDICTOR_WINS', true);
  kept.decidedAt = T0 + DAY / 3;   // the builder's date from Polymarket's resolution (attachDecidedAt)
  won.pcTraded = true;             // the builder marks predictions whose tokens a trade carries (buildTrades)
  const trades = [{ t: T0 + 60000, seller: ME, buyer: BUYER, tokens: 561.98, paid: 25, pc: 'pc-sold', side: 'P', vP: 1, vC: 0, dAt: T0 + DAY }];
  const a = P.aggregate([won, kept], { trades });
  const row = JSON.parse(JSON.stringify(a.bigWins.find((s) => s.id === 'sold')));
  assert.equal(row.h, 0); near(assert, row.lp, 25 - 500, 1e-4, 'the sale less the stake');
  const n = P.full(row);
  assert.equal(n.held, 0); near(assert, n.tradedPnl, -475, 1e-4); assert.equal(n.pcTraded, true);
  assert.equal(P.resultFor(n, false, n.held).label, 'won', 'nothing left for the seller to claim');
  const k = P.full(JSON.parse(JSON.stringify(a.bigWins.find((s) => s.id === 'kept'))));
  assert.equal(k.held, null); assert.equal(k.tradedPnl, null); assert.equal(k.decidedAt, T0 + DAY / 3);
  assert.equal(P.full(a.tape.find((s) => s.id === 'sold')).held, 0, 'the tape row too');
});

test('result chips: a loss is simply lost; "unclaimed" only where this side has something to collect', () => {
  const lostUnclaimed = pred('l', 5, 38.61, 'COUNTERPARTY_WINS', false);   // the report: a bettor's lost bet the maker had not collected
  assert.equal(P.resultFor(lostUnclaimed, false).label, 'lost');
  assert.equal(P.resultFor(lostUnclaimed, true).label, 'won · unclaimed', 'on the maker\'s page it is the maker\'s to collect');
  const wonUnclaimed = pred('w', 10, 18.94, 'PREDICTOR_WINS', false);
  assert.equal(P.resultFor(wonUnclaimed, false).label, 'won · unclaimed');
  assert.equal(P.resultFor(wonUnclaimed, false, 0).label, 'won', 'tokens sold: the buyer collects');
  assert.equal(P.resultFor(wonUnclaimed, true).label, 'lost');
  assert.equal(P.resultFor(pred('v', 3, 4, 'NON_DECISIVE', false), false).label, 'void · refund unclaimed');
  assert.equal(P.resultFor(pred('v2', 3, 4, 'NON_DECISIVE', true), false).label, 'void');
  assert.equal(P.resultFor(pred('o', 3, 4, null, false), false).label, 'open');
});

test('headline figures: the exchange\'s PnL already counts unclaimed results, so live nothing is added (0x86b0…: +$7.42, not +$22.35)', () => {
  // claimed: a win of +10 and a loss of −2; decided, unclaimed: a win of +18.94 and a loss of −4
  const mine = [pred('c1', 5, 10, 'PREDICTOR_WINS', true), pred('c2', 2, 3, 'COUNTERPARTY_WINS', true), pred('u1', 10, 18.94, 'PREDICTOR_WINS', false), pred('u2', 4, 6, 'COUNTERPARTY_WINS', false)];
  const verdictPnl = 10 - 2 + 18.94 - 4;
  // what P.account returns: PnL at the verdict, won / lost at the claim, the unclaimed ones still pending
  const exchange = [{ t: T0, pnl: verdictPnl, won: 1, lost: 1, pending: 2, nonDecisive: 0 }];
  const live = P.bettorFigures({ mine, hist: exchange, isMaker: false, live: true });
  near(assert, live.pnl, verdictPnl, 1e-9, 'live PnL');
  assert.equal(live.won, 2); assert.equal(live.lost, 2); assert.equal(live.open, 0); assert.equal(live.unclaimedWon, 1);
  near(assert, live.unclaimedPayout, 28.94, 1e-9, 'payout of the unclaimed win');
  // offline the history is rebuilt from claims, so the unclaimed results are added
  const offline = P.bettorFigures({ mine, hist: P.historyFromPredictions(mine, ME, false), isMaker: false, live: false });
  near(assert, offline.pnl, verdictPnl, 1e-9, 'offline PnL agrees');
  assert.equal(offline.won, 2); assert.equal(offline.lost, 2);
});

test('the aggregate mirrors bettors and makers without a secondary market', () => {
  const norms = [pred('a', 5, 10, 'PREDICTOR_WINS', true), pred('b', 2, 3, 'COUNTERPARTY_WINS', false), pred('c', 1, 1, null, false)];
  const a = P.aggregate(norms);
  near(assert, a.totals.bettorPnl, 10 - 2, 1e-9);
  near(assert, a.makers[0].pnl, -(10 - 2), 1e-9, 'maker = −bettors');
  assert.equal(a.totals.decided, 2); assert.equal(a.totals.unclaimed, 1); assert.equal(a.totals.open, 1);
  assert.equal(a.secondary, null);
});

test('a self-match is no bet: left out, so its wallet is no "market maker" (0xf069…: $0.50 against itself at launch)', () => {
  const self = P.norm({ predictionId: 's', predictor: ME, counterparty: ME, predictorCollateral: wei(0.5), counterpartyCollateral: wei(0.5), settled: false, result: null,
    createdAt: new Date(T0).toISOString(), settledAt: null, pickConfig: { pickConfigId: 'pc-s', resolved: true, result: 'PREDICTOR_WINS', picks: [{ conditionId: 'cs', predictedOutcome: 'YES', condition: { question: 'Q', endTime: Math.floor(T0 / 1000) } }] } });
  assert.equal(P.selfMatch(self), true); assert.equal(P.selfMatch(pred('x', 1, 1, null, false)), false);
  const a = P.aggregate([pred('a', 5, 10, 'PREDICTOR_WINS', true), self]);
  assert.deepEqual(a.makers.map((m) => m.address), [MAKER], 'only the real maker');
  assert.equal(a.totals.n, 1); assert.equal(a.totals.selfMatched, 1);
  near(assert, a.totals.bettorPnl, 10, 1e-9, 'the self-match adds nothing');
  assert.equal(a.bettors.find((b) => b.address === ME).n, 1);
});
