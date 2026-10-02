// The Predict secondary-market ledger (P.ledger). The figures are the real cases checked against the exchange's own
// account PnL on 2026-09-22; a change that breaks them breaks agreement with the exchange.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, near } from './_load.mjs';

const MD = load(['js/util.js', 'js/api.js', 'js/predict/api.js', 'js/predict/analytics.js']);
const P = MD.predict;
const DAY = 86400000;
const T0 = Date.UTC(2026, 7, 1);
const wei = (x) => (BigInt(Math.round(x * 1e6)) * 1000000000000n).toString();
const BETTOR = '0x00000000000000000000000000000000000000b1', MAKER = '0x00000000000000000000000000000000000000a1', BUYER = '0x00000000000000000000000000000000000000c1';

/** a raw API prediction, through P.norm like the site does */
function pred({ id, pc = 'pc-' + id, stake, cp, t = T0, result = null, settled = false, settledAt = null, end = t + DAY, predictor = BETTOR, counterparty = MAKER }) {
  return P.norm({ predictionId: id, predictor, counterparty, predictorCollateral: wei(stake), counterpartyCollateral: wei(cp), predictorToken: 'tp-' + pc, counterpartyToken: 'tc-' + pc,
    settled, result: settled ? result : null, createdAt: new Date(t).toISOString(), settledAt: settledAt ? new Date(settledAt).toISOString() : null, createTxHash: null,
    pickConfig: { pickConfigId: pc, resolved: !!result, result, picks: [{ conditionId: 'c-' + id, predictedOutcome: 'YES', condition: { question: 'Q ' + id, endTime: Math.floor(end / 1000) } }] } });
}
/** a compact trade as the snapshot builder writes it */
const value = (result, n) => (result == null ? { vP: null, vC: null } : result === 'PREDICTOR_WINS' ? { vP: 1, vC: 0 } : result === 'COUNTERPARTY_WINS' ? { vP: 0, vC: 1 } : { vP: n.stake / n.pool, vC: n.cp / n.pool });
const trade = ({ t, seller, buyer, tokens, paid, n, side = 'P', result = n.result }) => Object.assign({ t, seller, buyer, tokens, paid, pc: n.pc, side, dAt: result ? P.decidedAt(n) : null, sa: n.settledAt, q: 'Q' }, value(result, n));

test('a sold position that lost: the sale price is all that is left of the stake (top bettor, $30.66 for a $100 stake)', () => {
  const n = pred({ id: 'a', stake: 100, cp: 800.8257727581745, result: 'COUNTERPARTY_WINS', settled: true, settledAt: T0 + 5 * DAY });
  const L = P.ledger([n], [trade({ t: T0 + DAY, seller: BETTOR, buyer: MAKER, tokens: n.pool, paid: 30.661966738594923, n })], BETTOR);
  near(assert, L.pnl, 30.661966738594923 - 100, 1e-9, 'ledger PnL');
  near(assert, L.replaced, -100, 1e-9, 'per-prediction result replaced');
  near(assert, L.adj, 30.661966738594923, 1e-9, 'adjustment = the sale price');
  assert.equal(L.byPrediction.a.held, 0);
  assert.deepEqual(L.events.map((e) => e.kind), ['sale']);
});

test('a sold position that won: the payout is the buyer\'s, the seller keeps the price (0x4400…: $25 for a $500 stake)', () => {
  const n = pred({ id: 'b', stake: 500, cp: 61.98, result: 'PREDICTOR_WINS' });
  const t = trade({ t: T0 + DAY, seller: BETTOR, buyer: BUYER, tokens: n.pool, paid: 25, n });
  const S = P.ledger([n], [t], BETTOR), B = P.ledger([], [t], BUYER);
  near(assert, S.pnl, -475, 1e-9, 'seller');
  near(assert, S.adj, -536.98, 1e-6, 'seller adjustment (as on the snapshot, −536.98)');
  near(assert, B.pnl, n.pool - 25, 1e-9, 'buyer: payout minus price');
  near(assert, S.adj + B.adj, 0, 1e-9, 'a decided trade moves money between the two, nothing else');
});

test('a partial sale: the sold share at its average cost, the held share at the verdict', () => {
  const n = pred({ id: 'c', stake: 100, cp: 100, result: 'PREDICTOR_WINS' });   // pool 200 tokens at 0.5 each
  const L = P.ledger([n], [trade({ t: T0 + DAY, seller: BETTOR, buyer: BUYER, tokens: 50, paid: 20, n })], BETTOR);
  const [sale, verdict] = L.events;
  near(assert, sale.pnl, 20 - 25, 1e-9, 'sale: price − 50 × 0.5');
  near(assert, verdict.pnl, 150 - 75, 1e-9, 'verdict on the 150 still held');
  near(assert, L.adj, 20 - 50, 1e-9, 'adjustment = price − tokens sold × 1');
  near(assert, L.byPrediction.c.held, 0.75, 1e-12, 'held share');
});

test('a sale before the verdict is realized at the sale (0x22f3…: −$44.88 while the prediction was open)', () => {
  const n = pred({ id: 'd', stake: 55.65, cp: 44.35 });   // undecided
  const L = P.ledger([n], [trade({ t: T0 + DAY, seller: BETTOR, buyer: MAKER, tokens: n.pool, paid: 10.77, n })], BETTOR);
  near(assert, L.pnl, -44.88, 1e-9, 'realized');
  near(assert, L.replaced, 0, 0, 'an open prediction replaces nothing');
  assert.equal(L.byPrediction.d.decided, false);
});

test('a maker buying back the bettor\'s side locks the result at the purchase (0x79cb…: $143.70)', () => {
  const n = pred({ id: 'e', stake: 150, cp: 58.51 });   // open; the maker is the counterparty
  const L = P.ledger([n], [trade({ t: T0 + DAY, seller: BETTOR, buyer: MAKER, tokens: n.pool, paid: 6.30, n })], MAKER);
  assert.deepEqual(L.events.map((e) => e.kind), ['set']);
  near(assert, L.pnl, 208.51 - 58.51 - 6.30, 1e-6, 'both sides held: they pay the pool whatever happens');
  assert.deepEqual(Object.keys(L.open), ['pc-e']);
  near(assert, L.open['pc-e'].tokens, 0, 1e-9, 'nothing left at risk');
  // the matched set still holds its tokens: nothing was sold (0x79cb…'s rows read "sold" for its buy-backs)
  assert.equal(L.byPrediction.e.held, 1); assert.equal(L.byPrediction.e.hedged, true);
});

test('a sale timestamped before its own prediction is covered by it (0xc1ce…: the clocks differ by seconds)', () => {
  const n = pred({ id: 'f', stake: 10.9, cp: 29.9, t: T0 + 5000, result: 'COUNTERPARTY_WINS', settled: true, settledAt: T0 + 3 * DAY });
  const L = P.ledger([n], [trade({ t: T0, seller: BETTOR, buyer: MAKER, tokens: 40, paid: 11.87, n })], BETTOR);
  near(assert, L.pnl, 11.87 - 10.9, 1e-9, 'price − stake, as the exchange books it');
  assert.equal(L.events.filter((e) => e.kind === 'sale').length, 1, 'the late cost joins the sale, no extra event');
});

test('a void question pays each side its collateral share per token', () => {
  const n = pred({ id: 'g', stake: 30, cp: 70, result: 'NON_DECISIVE' });
  const B = P.ledger([], [trade({ t: T0 + DAY, seller: BETTOR, buyer: BUYER, tokens: 50, paid: 12, n })], BUYER);
  near(assert, B.pnl, 50 * 0.3 - 12, 1e-9, 'buyer of half the bettor\'s tokens');
});

test('predictions sharing a pick configuration share its tokens: average cost, result split by pool', () => {
  const a = pred({ id: 'h1', pc: 'shared', stake: 10, cp: 30, result: 'COUNTERPARTY_WINS' });
  const b = pred({ id: 'h2', pc: 'shared', stake: 20, cp: 30, result: 'COUNTERPARTY_WINS' });
  const L = P.ledger([a, b], [trade({ t: T0 + DAY, seller: BETTOR, buyer: MAKER, tokens: 45, paid: 20, n: a })], BETTOR);
  near(assert, L.pnl, 20 - 30, 1e-9, 'sold half of 90 tokens that cost 30, lost the rest');
  near(assert, L.byPrediction.h1.held, 0.5, 1e-12); near(assert, L.byPrediction.h2.held, 0.5, 1e-12);
  near(assert, L.byPrediction.h1.pnl + L.byPrediction.h2.pnl, L.pnl, 1e-9, 'allocation adds up');
  near(assert, L.byPrediction.h1.pnl, -10 * (40 / 90), 1e-9, 'by pool share');
});

test('the aggregate carries the adjustment to the bettor row and keeps a decided trade zero-sum', () => {
  const n = pred({ id: 'i', stake: 500, cp: 61.98, result: 'PREDICTOR_WINS' });
  const other = pred({ id: 'j', stake: 10, cp: 10, result: 'COUNTERPARTY_WINS' });
  const trades = [trade({ t: T0 + DAY, seller: BETTOR, buyer: BUYER, tokens: n.pool, paid: 25, n })];
  const plain = P.aggregate([n, other]), withT = P.aggregate([n, other], { trades });
  const row = (a) => a.bettors.find((r) => r.address === BETTOR);
  near(assert, row(plain).pnl, 61.98 - 10, 1e-6, 'per prediction');
  near(assert, row(withT).pnl, -475 - 10, 1e-6, 'with the sale');
  near(assert, withT.totals.bettorPnl - plain.totals.bettorPnl, -536.98, 1e-6, 'totals follow');
  near(assert, withT.secondary.toBettors + withT.secondary.toOthers, 0, 1e-9, 'the buyer (no row) got what the seller gave up');
  assert.equal(row(withT).unclaimedWon, 0, 'a sold winner is not the seller\'s to claim');
});

test('ROI: a sale out of an open prediction joins the base, on the Bettors row and the wallet page alike (0xc946…: −87%, not −102%)', () => {
  // two lost singles (−$10, −$19) and an open $5 combo whose whole pool was sold for $4.554509 (−$0.445491)
  const l1 = pred({ id: 'r1', stake: 10, cp: 12, result: 'COUNTERPARTY_WINS', settled: true, settledAt: T0 + 2 * DAY });
  const l2 = pred({ id: 'r2', stake: 19, cp: 25, result: 'COUNTERPARTY_WINS', settled: true, settledAt: T0 + 2 * DAY });
  const o = pred({ id: 'r3', stake: 5, cp: 34.918 });
  const mine = [l1, l2, o], trades = [trade({ t: T0 + DAY, seller: BETTOR, buyer: BUYER, tokens: o.pool, paid: 4.554509, n: o })];
  const row = P.aggregate(mine, { trades }).bettors.find((r) => r.address === BETTOR);
  near(assert, row.pnl, -29.445491, 1e-9, 'Net PnL');
  near(assert, row.roi, (-29.445491 / 34) * 100, 1e-9, 'over the $29 decided and the $5 sold');
  assert.equal('soldOpen' in row, false, 'no new field on the snapshot row');
  const F = P.bettorFigures({ mine, hist: P.historyFromPredictions(mine, BETTOR, false), isMaker: false, live: false, ledger: P.ledger(mine, trades, BETTOR) });
  near(assert, F.pnl, row.pnl, 1e-9, 'page PnL'); near(assert, F.roi, row.roi, 1e-9, 'page ROI = the row\'s');
  near(assert, F.soldOpen, 5, 1e-9);
  // its only prediction open and sold: a realized result has an ROI (0x22f3…: it showed '—')
  const d = pred({ id: 'r4', stake: 55.65, cp: 44.35 });
  const only = P.aggregate([d], { trades: [trade({ t: T0 + DAY, seller: BETTOR, buyer: BUYER, tokens: d.pool, paid: 10.77, n: d })] }).bettors[0];
  near(assert, only.roi, (-44.88 / 55.65) * 100, 1e-9);
  // open and still held: no ROI yet
  assert.equal(P.aggregate([pred({ id: 'r5', stake: 5, cp: 5 })]).bettors[0].roi, null);
});

test('a maker page reads the maker\'s own row: ROI and avg odds are not its best bettor\'s (0x3106…: −100%, not +100%)', () => {
  const ONE = '0x00000000000000000000000000000000000000d1';
  const n = pred({ id: 'm1', stake: 1, cp: 1, result: 'PREDICTOR_WINS', settled: true, settledAt: T0 + DAY, counterparty: ONE });
  const F = P.bettorFigures({ mine: [n], hist: P.historyFromPredictions([n], ONE, true), isMaker: true, live: false, ledger: P.ledger([n], [], ONE) });
  near(assert, F.pnl, -1, 1e-9); assert.equal(F.roi, -100); assert.equal(F.avgOdds, 0.5);
  // two bettors: A at 25 % won $3, B at 75 % lost $3; the maker's odds are the mean over both, not A's
  const B2 = '0x00000000000000000000000000000000000000b2';
  const a = pred({ id: 'm2', stake: 1, cp: 3, result: 'PREDICTOR_WINS', settled: true, settledAt: T0 + DAY, counterparty: ONE });
  const b = pred({ id: 'm3', stake: 3, cp: 1, result: 'COUNTERPARTY_WINS', settled: true, settledAt: T0 + DAY, counterparty: ONE, predictor: B2 });
  const G = P.bettorFigures({ mine: [a, b], hist: P.historyFromPredictions([a, b], ONE, true), isMaker: true, live: false, ledger: P.ledger([a, b], [], ONE) });
  near(assert, G.avgOdds, 0.5, 1e-9, 'its bettors\' odds, as on the Market makers page'); near(assert, G.roi, 0, 1e-9, '−$3 + $3 on $4 committed');
});

test('best win is the bettor\'s own result where it traded the tokens (0x4400…: $20.13, not the $61.98 it sold for $25)', () => {
  const sold = pred({ id: 'w1', stake: 500, cp: 61.98, result: 'PREDICTOR_WINS' }), kept = pred({ id: 'w2', stake: 100, cp: 20.13, result: 'PREDICTOR_WINS' });
  const trades = [trade({ t: T0 + DAY, seller: BETTOR, buyer: BUYER, tokens: sold.pool, paid: 25, n: sold })];
  const row = (a) => a.bettors.find((r) => r.address === BETTOR);
  near(assert, row(P.aggregate([sold, kept])).biggestWin, 61.98, 1e-6, 'without the trades: the payout − stake');
  near(assert, row(P.aggregate([sold, kept], { trades })).biggestWin, 20.13, 1e-6, 'with them: the sold win made −$475');
  assert.equal(row(P.aggregate([pred({ id: 'w3', stake: 5, cp: 5, result: 'COUNTERPARTY_WINS' })])).biggestWin, 0, 'no win: 0 (the page shows —)');
});

test('trades without a pick configuration (not yet mapped) change nothing', () => {
  const n = pred({ id: 'k', stake: 100, cp: 100, result: 'PREDICTOR_WINS' });
  const L = P.ledger([n], [{ t: T0, seller: BETTOR, buyer: BUYER, tokens: 200, paid: 90 }], BETTOR);
  assert.equal(L.events.length, 0); assert.equal(L.adj, 0);
});

test('a bettor that buys the other side holds a matched set: still held, but the verdict settles only the unmatched share', () => {
  // stake 10 against 30 (pool 40); the bettor buys 20 of the maker-side tokens for $2, then wins
  const n = pred({ id: 'h', stake: 10, cp: 30, result: 'PREDICTOR_WINS' });
  const L = P.ledger([n], [trade({ t: T0 + DAY, seller: MAKER, buyer: BETTOR, tokens: 20, paid: 2, n, side: 'C' })], BETTOR);
  assert.equal(L.byPrediction.h.held, 1, 'nothing sold');
  near(assert, L.byPrediction.h.atRisk, 0.5, 1e-9, 'half the tokens are in the set, whose result was booked at the set');
  // what the tax export books at the verdict (result × atRisk) plus the set's own event equals the ledger total
  const setEv = L.events.filter((e) => e.kind === 'set').reduce((a, e) => a + e.pnl, 0);
  near(assert, n.pnl * L.byPrediction.h.atRisk + setEv, L.pnl, 1e-6);
});

test('a twin prediction paid by a claim on the same token is dated to the claim that redeemed the balance (the earliest)', () => {
  const tok = 'pc-twin';
  const a = pred({ id: 'ta', pc: tok, stake: 5, cp: 5, result: 'PREDICTOR_WINS', settled: true, settledAt: T0 + 3 * DAY });
  const b = pred({ id: 'tb', pc: tok, stake: 5, cp: 5, result: 'PREDICTOR_WINS', settled: true, settledAt: T0 + 9 * DAY });   // a later claim: redeemed nothing
  const c = pred({ id: 'tc', pc: tok, stake: 5, cp: 5, result: 'PREDICTOR_WINS' });                                            // decided, never claimed itself
  assert.equal(c.unclaimed, true);
  assert.equal(P.markTokenClaims([a, b, c]), 1);
  assert.equal(c.unclaimed, false); assert.equal(c.settledAt, T0 + 3 * DAY); assert.equal(c.viaToken, true);
});