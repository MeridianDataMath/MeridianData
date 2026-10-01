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

  // big wins: net PnL (payout − stake) above P.BIG_WIN, latest verdict first; the tape keeps every leg
  const big = pred('big', 25, 943, 'PREDICTOR_WINS', true, T0), later = pred('later', 400, 600, 'PREDICTOR_WINS', false, T0 + 3 * DAY);
  const bigPayout = pred('bigPayout', 900, 27.4, 'PREDICTOR_WINS', true);   // $927 paid out, $27.40 made: not a big win
  const small = pred('small', 100, 399, 'PREDICTOR_WINS', true), exact = pred('exact', 250, 500, 'PREDICTOR_WINS', true), lost = pred('lost', 600, 900, 'COUNTERPARTY_WINS', true);
  const a = P.aggregate([big, later, bigPayout, small, exact, lost, combo]);
  assert.deepEqual(a.bigWins.map((s) => s.id), ['later', 'big'], 'net PnL over $500 (not the payout), wins only, newest verdict first');
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

test('big wins go by what the bettor made: a win sold for little is none, a partly sold one keeps its own result', () => {
  const BUYER = '0x00000000000000000000000000000000000000c1';
  // sold: $943 to win on $25, every token sold for $30 before the verdict (it made $5); part: 10% sold, the rest held
  const sold = pred('sold', 25, 943, 'PREDICTOR_WINS', false), part = pred('part', 25, 1500, 'PREDICTOR_WINS', false), kept = pred('kept', 25, 600, 'PREDICTOR_WINS', true);
  kept.decidedAt = T0 + DAY / 3;                    // the builder's date from Polymarket's resolution (attachDecidedAt)
  sold.pcTraded = true; part.pcTraded = true;       // the builder marks predictions whose tokens a trade carries (buildTrades)
  const trades = [
    { t: T0 + 60000, seller: ME, buyer: BUYER, tokens: 968, paid: 30, pc: 'pc-sold', side: 'P', vP: 1, vC: 0, dAt: T0 + DAY },
    { t: T0 + 60000, seller: ME, buyer: BUYER, tokens: 152.5, paid: 140, pc: 'pc-part', side: 'P', vP: 1, vC: 0, dAt: T0 + DAY },
  ];
  const a = P.aggregate([sold, part, kept], { trades });
  assert.deepEqual(a.bigWins.map((s) => s.id).sort(), ['kept', 'part'], 'the full sale made $5: not a big win');
  const p = P.full(JSON.parse(JSON.stringify(a.bigWins.find((s) => s.id === 'part'))));
  near(assert, p.held, 0.9, 1e-4); near(assert, p.tradedPnl, (140 - 2.5) + (1372.5 - 22.5), 1e-3, 'the sale plus the 90% held at the verdict');
  assert.equal(p.pcTraded, true);
  const k = P.full(JSON.parse(JSON.stringify(a.bigWins.find((s) => s.id === 'kept'))));
  assert.equal(k.held, null); assert.equal(k.tradedPnl, null); assert.equal(k.decidedAt, T0 + DAY / 3);
  // the sold one still shows as sold wherever it appears (the tape)
  const t = P.full(a.tape.find((s) => s.id === 'sold'));
  assert.equal(t.held, 0); near(assert, t.tradedPnl, 30 - 25, 1e-4);
  assert.equal(P.resultFor(t, false, t.held).label, 'won', 'nothing left for the seller to claim');
});

test('a slip copied to Meridian opens its shared-prediction page under the referral code; anything else is not a slip', () => {
  const id = '0x' + 'c0'.repeat(32);
  assert.equal(MD.api.REF, 'BJ9Y51H9XB1L');
  assert.equal(P.meridianSlipUrl(id), 'https://app.meridian.xyz/predict/p/' + id + '?ref=BJ9Y51H9XB1L');
  assert.equal(P.meridianSlipUrl('0x' + 'C0'.repeat(32)), P.meridianSlipUrl(id), 'lower-cased');
  for (const bad of ['0x12', id + '00', 'javascript:alert(1)', id.slice(2), null]) { assert.equal(P.isPredictionId(bad), false, String(bad)); assert.equal(P.meridianSlipUrl(bad), P.APP_URL); }
  assert.ok(P.APP_URL.endsWith('?ref=BJ9Y51H9XB1L') && P.CLAIM_URL.endsWith('?ref=BJ9Y51H9XB1L') && MD.api.APP_URL.endsWith('?ref=BJ9Y51H9XB1L'), 'every app link keeps the code');
});

test('luck: the exact chance of a record at least this good if every bet had exactly its locked odds', () => {
  near(assert, P.luckOf([0.5, 0.5], 2), 0.25, 1e-12);
  near(assert, P.luckOf(Array(10).fill(0.5), 7), 176 / 1024, 1e-12, 'binomial tail: 7+ of 10 coin flips');
  near(assert, P.luckOf([0.02], 1), 0.02, 1e-12, 'one long shot that hit: 1 in 50');
  assert.equal(P.luckOf([0.3, 0.4], 0), 1); assert.equal(P.luckOf([0.3], 2), 0);
  // exact at any size (the tail bin absorbs): against the full distribution, long shots included
  const ps = Array.from({ length: 400 }, (_, i) => [0.005, 0.02, 0.1, 0.5, 0.9][i % 5]);
  const full = (arr) => { let d = [1]; for (const p of arr) { const e = new Array(d.length + 1).fill(0); d.forEach((x, k) => { e[k] += x * (1 - p); e[k + 1] += x * p; }); d = e; } return d; };
  const dist = full(ps);
  for (const w of [1, 80, 110, 130, 160]) { const tail = dist.slice(w).reduce((a, x) => a + x, 0); near(assert, P.luckOf(ps, w), tail, Math.max(1e-15, tail * 1e-9), 'won ' + w); }
});

test('a record counts bets: predictions that share a question are one bet (0xec7a…: 11 predictions on 3 outcomes)', () => {
  // three predictions on the same 12% draw (all won) and six on the same 5.5% pick (all lost): 2 bets, 1 won
  const same = (id, cond, s, cp, verdict) => { const n = pred(id, s, cp, verdict, true); n.picks = [Object.assign({}, n.picks[0], { id: cond })]; return n; };
  const norms = [0, 1, 2].map((i) => same('a' + i, 'draw', 12, 88, 'PREDICTOR_WINS')).concat([0, 1, 2, 3, 4, 5].map((i) => same('b' + i, 'para', 5.5, 94.5, 'COUNTERPARTY_WINS')));
  const rec = P.aggregate(norms).bettors[0].rec;
  assert.equal(rec.n, 2); assert.equal(rec.predictions, 9); assert.equal(rec.won, 1);
  near(assert, rec.expected, 0.12 + 0.055, 1e-4);
  near(assert, rec.luck, P.luckOf([0.12, 0.055], 1), 1e-3, 'not 0.12³: the split draw is one win');
  // combos linked through a shared leg are one bet too: the largest-stake one, at its own odds and with its own result
  const combo = (id, legs, s, cp, verdict) => { const n = pred(id, s, cp, verdict, true); n.picks = legs.map((c) => Object.assign({}, n.picks[0], { id: c })); return n; };
  const linked = P.aggregate([combo('c1', ['m1', 'm2'], 30, 90, 'PREDICTOR_WINS'), combo('c2', ['m2', 'm3'], 10, 10, 'COUNTERPARTY_WINS'), combo('c3', ['m9'], 10, 30, 'COUNTERPARTY_WINS')]).bettors[0].rec;
  assert.equal(linked.n, 2); assert.equal(linked.won, 1, 'the $30 combo on m1–m2 won');
  near(assert, linked.expected, 0.25 + 0.25, 1e-9, 'its own 25%, not an average with the 50% one it is linked to');
  // every decided prediction counts, and a bettor page's own aggregate computes no record
  assert.equal(P.bettorSummary(norms).stats.rec, null);
});

test('record tiers: strong at 1 in 50 by luck, good at 1 in 10, and the best record is good when none reaches that', () => {
  const rows = (lucks) => lucks.map((luck, i) => ({ address: '0x' + String(i).padStart(40, '0'), pnl: 10, roi: 5, wagered: 100, last: T0, topCat: 'Sports', rec: { n: 12, won: 7, expected: 5, luck, predictions: 12 } }));
  const out = P.ideas([], { bettors: rows([0.001, 0.02, 0.03, 0.08, 0.3, 0.9]), soldOf: () => null }, Date.now());
  assert.deepEqual(out.bettors.map((b) => b.tier), ['strong', 'strong', 'good', 'good', null, null]);
  assert.equal(out.tested, 6);
  const none = P.ideas([], { bettors: rows([0.5, 0.25, 0.4]), soldOf: () => null }, Date.now());
  assert.deepEqual(none.bettors.map((b) => [b.luck, b.tier]), [[0.25, 'good'], [0.4, null], [0.5, null]], 'the best record counts as good');
  assert.deepEqual(P.ideas([], { bettors: [], soldOf: () => null }).bettors, []);
});

test('the record against the odds, and the ideas from winning bettors: slips that can still be placed', () => {
  const OTHER = '0x00000000000000000000000000000000000000b2';
  // ME: 10 decided at even odds (stake 10 to win 10), 7 won where 5 were expected: +$40, luck 176 / 1024
  const decided = Array.from({ length: 10 }, (_, i) => pred('d' + i, 10, 10, i < 7 ? 'PREDICTOR_WINS' : 'COUNTERPARTY_WINS', true));
  // OTHER: one 49× long shot that hit and nine even-money losses: +$390, yet 1 win where 4.5 were expected: no record
  // (money-weighted, this looked like a 5-sigma record; counted in wins it is what it is: a lucky hit)
  const lucky = [pred('x0', 10, 480, 'PREDICTOR_WINS', true)].concat(Array.from({ length: 9 }, (_, i) => pred('x' + (i + 1), 10, 10, 'COUNTERPARTY_WINS', true))).map((n) => Object.assign(n, { predictor: OTHER }));
  const now = Date.now();
  const openNow = pred('open', 5, 20, null, false, now), closed = pred('closed', 5, 20, null, false, T0), othersOpen = Object.assign(pred('oo', 5, 20, null, false, now), { predictor: OTHER });
  const norms = decided.concat(lucky, [openNow, closed, othersOpen]);
  const a = P.aggregate(norms);
  const me = a.bettors.find((b) => b.address === ME).rec, other = a.bettors.find((b) => b.address === OTHER).rec;
  assert.equal(me.n, 10); assert.equal(me.won, 7); near(assert, me.expected, 5, 1e-9); near(assert, me.luck, 176 / 1024, 1e-3);
  assert.equal(other.won, 1); near(assert, other.expected, 10 / 490 + 4.5, 1e-4); assert.ok(other.luck > 0.9, String(other.luck));
  assert.equal(a.makers[0].rec, null, 'makers carry no record');
  const { bettors, ideas } = P.ideas(norms, a, now);
  assert.deepEqual(bettors.map((b) => b.address), [ME], 'in profit with 10 decided and more wins than the odds implied; the lucky hit is not a record');
  assert.equal(bettors[0].ideas, 1);
  assert.deepEqual(ideas.map((x) => x.id), ['open'], 'only slips still before their cutoff, from winning bettors');
  // the same picks placed again are one idea, the newest, with the count
  const again = pred('again', 5, 20, null, false, now + 1000);
  again.picks = openNow.picks.map((k) => Object.assign({}, k));   // the same question and side as 'open'
  const twice = P.ideas(norms.concat([again]), P.aggregate(norms.concat([again])), now);
  assert.deepEqual(twice.ideas.map((x) => [x.id, x.x]), [['again', 2]]); assert.equal(twice.bettors[0].ideas, 1);
  assert.equal(P.full(ideas[0]).picks[0].id, 'copen', 'ideas keep their legs\' question ids');
  // nine decided is not a record yet; a bettor out of profit is not a winning one
  assert.equal(P.ideas(norms.filter((n) => n.id !== 'd0'), P.aggregate(norms.filter((n) => n.id !== 'd0')), now).bettors.some((b) => b.address === ME), false);
  const losing = decided.map((n, i) => (i < 7 ? pred('l' + i, 10, 10, 'COUNTERPARTY_WINS', true) : n));
  assert.equal(P.ideas(losing, P.aggregate(losing), now).bettors.length, 0);
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

// a prediction whose legs carry Meridian's settlement times (condition.settledAt, unix seconds)
const legsPred = (id, verdict, claimedAt, legs) => P.norm({ predictionId: id, predictor: ME, counterparty: MAKER, predictorCollateral: wei(25), counterpartyCollateral: wei(1165),
  settled: !!claimedAt, result: claimedAt ? verdict : null, createdAt: new Date(T0).toISOString(), settledAt: claimedAt ? new Date(claimedAt).toISOString() : null,
  pickConfig: { pickConfigId: 'pc-' + id, resolved: !!verdict, result: verdict, picks: legs.map(([yes, settledAt, resYes], i) => ({ conditionId: 'c' + id + i, predictedOutcome: yes ? 'YES' : 'NO',
    condition: { question: 'Q' + i, endTime: Math.floor((T0 + 90 * DAY) / 1000), settled: settledAt != null, settledAt: settledAt == null ? null : Math.floor(settledAt / 1000), resolvedToYes: settledAt == null ? null : resYes } })) } });

test('a result is dated when it settled on Meridian, never when its payout was claimed', () => {
  // the user's case: both legs settled by Sep 13, the payout claimed Sep 29 (legs listed to end months later)
  const s1 = T0 + 41 * DAY, s2 = T0 + 43 * DAY, claim = T0 + 59 * DAY;
  const win = legsPred('w', 'PREDICTOR_WINS', claim, [[false, s1, false], [true, s2, true]]);
  assert.equal(P.legVerdictAt(win), s2, 'a win: when its last leg settled');
  assert.equal(P.decidedAt(win), s2);
  const unclaimed = legsPred('u', 'PREDICTOR_WINS', null, [[true, s1, true], [true, s2, true]]);
  assert.equal(P.decidedAt(unclaimed), s2, 'unclaimed: dated all the same');
  // a combo lost on its first leg: decided then, although its other leg is open for months
  const lost = legsPred('l', 'COUNTERPARTY_WINS', claim, [[true, s1, false], [true, null, null]]);
  assert.equal(P.decidedAt(lost), s1, 'a loss: when the first leg settled against the bettor');
  // never after the claim (a settlement time cannot be later), and old records without leg times keep the estimate
  const odd = legsPred('o', 'PREDICTOR_WINS', s1, [[true, s2, true]]);
  assert.equal(P.decidedAt(odd), s1);
  // the time survives the snapshot's compact records, and a record from before leg times were kept falls back
  const round = P.unslim(JSON.parse(JSON.stringify(P.slim(win))));
  assert.equal(round.picks[1].settledAt, s2); assert.equal(P.decidedAt(round), s2);
  const old = P.unslim(Object.assign(JSON.parse(JSON.stringify(P.slim(win))), { k: P.slim(win).k.map((k) => k.slice(0, 9)) }));
  assert.equal(P.legVerdictAt(old), null); assert.ok(P.decidedAt(old) <= claim, 'an estimate, never after the claim');
  // a snapshot's own time (da) is used when the legs carry none
  assert.equal(P.decidedAt(Object.assign({}, old, { decidedAt: s2 })), s2);
  // the tape's compact rows keep it too
  assert.equal(P.full(Object.assign(P.compact(Object.assign({}, win, { decidedAt: s2 })), { k: undefined })).decidedAt, s2);
});

test('a one-off counterparty is not a market maker', () => {
  const { makers, oneOff } = P.splitMakers([{ address: 'a', n: 5558 }, { address: 'b', n: 16 }, { address: 'c', n: 1 }]);
  assert.deepEqual(makers.map((m) => m.address), ['a', 'b']); assert.deepEqual(oneOff.map((m) => m.address), ['c']);
});