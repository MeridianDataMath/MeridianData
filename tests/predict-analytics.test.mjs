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
