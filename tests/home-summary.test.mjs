// The home page's summary (js/home-summary.js, written to data/home.json at each deploy): which wallets its lists keep,
// the books it reads positions for, the Predict rows and figures it carries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_load.mjs';

const MD = load(['js/util.js', 'js/api.js', 'js/analytics.js', 'js/predict/api.js', 'js/predict/analytics.js', 'js/home-summary.js']);
const HS = MD.homeSummary, P = MD.predict, U = MD.util;
const DAY = 86400000, NOW = Date.UTC(2026, 9, 18, 12);
const addr = (n) => '0x' + String(n).padStart(40, '0');

test('top wallets and books: traders only, the biggest PnL and the biggest open books first', () => {
  const row = (n, pnl, o = {}) => Object.assign({ account: addr(n), sid: 's' + n, volumeAll: 1000, positionsCount: 3, openCount: 0, notional: 0, stats: { all: { pnl, roi: 10 } } }, o);
  const rows = [
    row(1, 500), row(2, 900, { openCount: 2, notional: 5000 }), row(3, 100, { openCount: 1, notional: 9000 }), row(4, 300), row(5, 700), row(6, 50, { openCount: 1, notional: 100 }),
    row(7, 99999, { inactive: true }),                                                        // inactive
    row(8, 88888, { volumeAll: 0, positionsCount: 0 }),                                       // no trades (the fee collector)
    Object.assign(row(9, 77777), { sid: '01a047c4-2be2-774c-ae58-1e45d2f2a99d' }),             // the exchange's own account
    Object.assign(row(10, 66666, { openCount: 13, notional: 1e6 }), { account: '0x2f46c3fce6bda596c2771bca618c4f69ae3e56b2' }),   // the market maker
    Object.assign(row(11, 55555, { openCount: 1, notional: 1e6 }), { account: '0x9ffea49e4dcedd6427c700c6a9d98faafc24790f' }),     // a wallet the site leaves out
  ];
  const s = HS.build({ lb: { builtAt: NOW - 600000, accounts: 11, rows }, now: NOW });
  assert.deepEqual(s.lb.top.map((r) => r.sid), ['s2', 's5', 's1', 's4', 's3'], 'five traders, the biggest PnL first');
  assert.deepEqual(s.lb.books.map((b) => b.sid), ['s3', 's2', 's6'], 'open books only, the biggest first, no market maker');
  assert.equal(s.lb.accounts, 11);
  assert.deepEqual(s.lb.cov, { accounts: 11, rows: 11, carried: 0, oldest: null, missing: 0, partial: false });
  assert.equal(s.lb.copyable, 0, 'no copy profiles, nothing copyable');
  // a top row keeps what the card and its tooltips read, nothing else
  assert.deepEqual(Object.keys(s.lb.top[0]).sort(), ['account', 'basis', 'builtAt', 'carried', 'name', 'sid', 'stats', 'style']);
  assert.equal(JSON.parse(JSON.stringify(s)).lb.top[0].stats.all.pnl, 900);
});

test('Predict: the latest big wins, the newest big bets (or the big ones among the tape), the week\'s stakes', () => {
  const ME = addr('b1'), MAKER = addr('a1');
  const wei = (x) => (BigInt(Math.round(x * 1e6)) * 1000000000000n).toString();
  const pred = (id, stake, cp, verdict, t) => P.norm({ predictionId: id, predictor: ME, counterparty: MAKER, predictorCollateral: wei(stake), counterpartyCollateral: wei(cp),
    settled: !!verdict, result: verdict, createdAt: new Date(t).toISOString(), settledAt: verdict ? new Date(t + DAY / 4).toISOString() : null,
    pickConfig: { pickConfigId: 'pc-' + id, resolved: !!verdict, result: verdict, picks: [{ conditionId: 'c' + id, predictedOutcome: 'YES', condition: { question: 'Q ' + id, endTime: Math.floor((t + DAY / 8) / 1000) } }] } });
  const norms = [
    pred('w1', 100, 900, 'PREDICTOR_WINS', NOW - 5 * DAY), pred('w2', 50, 1950, 'PREDICTOR_WINS', NOW - 2 * DAY), pred('w3', 10, 400, 'PREDICTOR_WINS', NOW - DAY),   // w3 made $400: not big
    pred('b1', 150, 150, null, NOW - 3 * 3600e3), pred('b2', 99, 99, null, NOW - 2 * 3600e3), pred('b3', 2000, 500, null, NOW - 3600e3),
    pred('old', 500, 500, null, NOW - 9 * DAY),   // staked 9 days ago: outside the week
  ];
  const snap = { builtAt: NOW - 300000, agg: P.aggregate(norms) };
  const s = HS.build({ snap, status: { builtAt: NOW, bettors: 1, predictions: 7, questionsLive: 4, requests: 99 }, now: NOW });
  assert.deepEqual(s.predict.wins.map((x) => P.full(x).id), ['w2', 'w1'], 'over $500 of profit, the latest verdict first');
  assert.deepEqual(s.predict.bets.map((x) => x.id), ['b3', 'b1', 'w1', 'old'], '$100 and up, the newest first');
  assert.equal(s.predict.fullBets, true);
  assert.equal(s.predict.week.n, 6, 'the last 7 UTC days, today included');
  assert.equal(s.predict.week.wagered, 100 + 50 + 10 + 150 + 99 + 2000);
  assert.deepEqual(s.status, { builtAt: NOW, bettors: 1, predictions: 7, questionsLive: 4 }, 'the status file\'s figures, nothing else');
  // a snapshot from before agg.bigBets: the big ones among its newest predictions (the tape)
  const old = { builtAt: snap.builtAt, agg: Object.assign({}, snap.agg, { bigBets: undefined }) };
  const s2 = HS.build({ snap: old, now: NOW });
  assert.equal(s2.predict.fullBets, false);
  assert.deepEqual(s2.predict.bets.map((x) => x.id), ['b3', 'b1', 'w1', 'old']);
  // nothing to summarise: no parts
  assert.deepEqual(Object.keys(HS.build({ now: NOW })), ['builtAt']);
});
