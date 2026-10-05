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
  assert.equal(rec.luck, P.luckOf([norms[0].odds, norms[3].odds], 1), 'unrounded: the tiers compare it with their cutoffs');
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
  // the cutoff applies to the luck itself, not to a rounded one (0x7dbb…: 0.100174 is not good; it read as 0.1)
  const edge = P.ideas([], { bettors: rows([0.100174, 0.0999]), soldOf: () => null }, Date.now());
  assert.deepEqual(edge.bettors.map((b) => [b.luck, b.tier]), [[0.0999, 'good'], [0.100174, null]]);
});

test('top category: the most predictions; a tie goes to the larger stake, not the newest prediction (0xfdc7…: Crypto)', () => {
  // newest first, as the snapshot builder passes them: Geopolitics 2 ($1,102), Economy & Finance 2 ($1,116), Crypto 2 ($2,002)
  const cat = (id, stake, c) => Object.assign(pred(id, stake, stake, 'COUNTERPARTY_WINS', true), { cat: c });
  const norms = [cat('g1', 551, 'Geopolitics'), cat('e1', 558, 'Economy & Finance'), cat('c1', 1001, 'Crypto'), cat('g2', 551, 'Geopolitics'), cat('e2', 558, 'Economy & Finance'), cat('c2', 1001, 'Crypto')];
  const a = P.aggregate(norms);
  assert.equal(a.bettors[0].topCat, 'Crypto'); assert.equal(a.makers[0].topCat, 'Crypto', 'a maker by the collateral it committed');
  assert.equal('catW' in a.bettors[0], false, 'no new field on the snapshot row');
  assert.equal(P.aggregate(norms.concat([cat('g3', 1, 'Geopolitics')])).bettors[0].topCat, 'Geopolitics', 'the count comes first');
  assert.equal(P.topCategory({ Sports: 2, Crypto: 2 }, { Sports: 5, Crypto: 5 }), 'Crypto', 'then the name');
  assert.equal(P.topCategory({}, {}), null);
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
  // beside the record against the odds, the record the page shows: Meridian's app's, from the bettor's row (claimed only)
  assert.deepEqual([bettors[0].won, bettors[0].n, bettors[0].appWon, bettors[0].appLost, bettors[0].appWinRate], [7, 10, 7, 3, 70]);
  const unclaimed = norms.map((n) => (n.id === 'd0' || n.id === 'd9' ? pred(n.id, 10, 10, n.id === 'd0' ? 'PREDICTOR_WINS' : 'COUNTERPARTY_WINS', false) : n));
  const u = P.ideas(unclaimed, P.aggregate(unclaimed), now).bettors[0];
  assert.deepEqual([u.won, u.n, u.appWon, u.appLost, u.appWinRate], [7, 10, 6, 2, 75], 'a decided prediction nobody has claimed is in the record against the odds, pending in the app\'s');
  assert.deepEqual(P.ideas([], { bettors: [{ address: ME, pnl: 1, rec: { n: 10, won: 7, expected: 5, luck: 0.1, predictions: 10 } }], soldOf: () => null }).bettors.map((b) => b.appWon), [undefined], 'a row without the app\'s counts adds none');
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
  // the record is the app's (Positions Won / Lost: claimed only); the site's count at the verdict adds the unclaimed ones
  assert.equal(live.won, 1); assert.equal(live.lost, 1); assert.equal(live.vWon, 2); assert.equal(live.vLost, 2);
  assert.equal(live.open, 0); assert.equal(live.unclaimedWon, 1);
  near(assert, live.unclaimedPayout, 28.94, 1e-9, 'payout of the unclaimed win');
  // offline the history is rebuilt from claims, so the unclaimed results are added; the app's record from the API's flag
  const offline = P.bettorFigures({ mine, hist: P.historyFromPredictions(mine, ME, false), isMaker: false, live: false });
  near(assert, offline.pnl, verdictPnl, 1e-9, 'offline PnL agrees');
  assert.equal(offline.won, 1); assert.equal(offline.lost, 1); assert.equal(offline.vWon, 2); assert.equal(offline.vLost, 2);
  // the maker's side of the same predictions, turned round
  const mk = P.bettorFigures({ mine, hist: P.historyFromPredictions(mine, MAKER, true), isMaker: true, live: false });
  assert.equal(mk.won, 1); assert.equal(mk.lost, 1); assert.equal(mk.vWon, 2); assert.equal(mk.vLost, 2);
});

test('a claim pays every prediction the wallet holds on that token: the API flags one, the others count as claimed with it', () => {
  // position tokens are per pick configuration and side (the builder reads them from the API: predictorToken / counterpartyToken)
  const tok = (n, p, c) => Object.assign(n, { tokP: p, tokC: c });
  const claimed = tok(pred('a', 10, 30, 'PREDICTOR_WINS', true), '0xp1', '0xc1'); claimed.settledAt = T0 + 5 * DAY;
  const twin = tok(pred('b', 5, 15, 'PREDICTOR_WINS', false), '0xp1', '0xc1');
  const other = tok(pred('c', 5, 15, 'PREDICTOR_WINS', false), '0xp2', '0xc2');   // another pick configuration: its own token
  const voidPaid = tok(pred('d', 5, 15, 'NON_DECISIVE', true), '0xp3', '0xc3'), voidOpen = tok(pred('e', 5, 15, 'NON_DECISIVE', false), '0xp3', '0xc3');
  // the maker's side: a loss is the maker's to claim, on its token
  const lossPaid = tok(pred('f', 5, 15, 'COUNTERPARTY_WINS', true), '0xp4', '0xc4'), lossTwin = tok(pred('g', 5, 15, 'COUNTERPARTY_WINS', false), '0xp4', '0xc4');
  const norms = [claimed, twin, other, voidPaid, voidOpen, lossPaid, lossTwin];
  assert.equal(P.markTokenClaims(norms), 2);
  assert.equal(twin.settled, true); assert.equal(twin.unclaimed, false); assert.equal(twin.settledAt, T0 + 5 * DAY); assert.equal(twin.viaToken, true);
  assert.equal(lossTwin.settled, true); assert.equal(lossTwin.settledAt, lossPaid.settledAt);
  assert.equal(other.unclaimed, true, 'a win on another token is still to claim'); assert.equal(voidOpen.unclaimed, true, 'a void is left as it is');
  assert.equal(claimed.viaToken, undefined, 'the claimed one is the API\'s own');
  const s = JSON.parse(JSON.stringify(P.slim(twin))); assert.equal(s.st, 1); assert.equal(s.sa, T0 + 5 * DAY);
  // live, the exchange's won / pending follow the API's flag: the twin is still pending there, as in the app's record;
  // the site's count at the verdict adds it back
  const mine = [claimed, twin, other];
  const live = P.bettorFigures({ mine, hist: [{ t: T0, pnl: 30 + 15 + 15, won: 1, lost: 0, pending: 2, nonDecisive: 0 }], isMaker: false, live: true });
  assert.equal(live.won, 1); assert.equal(live.vWon, 3); assert.equal(live.open, 0); assert.equal(live.unclaimedWon, 1, 'only the win on its own token'); near(assert, live.unclaimedPayout, 20, 1e-9);
  // offline the history is rebuilt from claims, where the twin is now claimed: the same site count, and the app's record
  // from the API's own flag (the twin, viaToken, is pending there)
  const offline = P.bettorFigures({ mine, hist: P.historyFromPredictions(mine, ME, false), isMaker: false, live: false });
  assert.equal(offline.won, 1); assert.equal(offline.vWon, 3); assert.equal(offline.open, 0); assert.equal(offline.unclaimedWon, 1); near(assert, offline.pnl, 60, 1e-9);
  // the wallet files keep the mark (tk), so a page reading them counts the same
  const back = mine.map((n) => P.unslim(JSON.parse(JSON.stringify(P.slim(n, { stx: true })))));
  assert.deepEqual(back.map((n) => !!n.viaToken), [false, true, false]); assert.equal(JSON.parse(JSON.stringify(P.slim(claimed))).tk, undefined, 'only on a twin');
  assert.deepEqual(P.appRecord(back, false), { won: 1, lost: 0, winRate: 100 });
});

test('won / lost as Meridian\'s app counts them: claimed predictions only, by the API\'s flag (0x9c1c…: 4 / 0 in the app, 5 / 11 at the verdict)', () => {
  // claimed: a win and a loss; decided, nobody has claimed: a win and two losses (the maker has not collected); open; a void
  const mine = [pred('cw', 5, 10, 'PREDICTOR_WINS', true), pred('cl', 2, 3, 'COUNTERPARTY_WINS', true), pred('uw', 10, 20, 'PREDICTOR_WINS', false),
    pred('ul1', 4, 6, 'COUNTERPARTY_WINS', false), pred('ul2', 4, 6, 'COUNTERPARTY_WINS', false), pred('o', 1, 1, null, false), pred('v', 3, 4, 'NON_DECISIVE', true)];
  assert.deepEqual(P.appRecord(mine, false), { won: 1, lost: 1, winRate: 50 });
  assert.deepEqual(P.appRecord(mine, true), { won: 1, lost: 1, winRate: 50 }, 'the maker: the same claimed predictions turned round');
  assert.deepEqual(P.appRecord([pred('x', 1, 1, 'COUNTERPARTY_WINS', false)], false), { won: 0, lost: 0, winRate: null }, 'nothing claimed: no win rate');
  // the snapshot's rows carry both counts (additive: won / lost / winRate keep the site's count at the verdict)
  const a = P.aggregate(mine);
  const b = a.bettors[0], m = a.makers[0];
  assert.equal(b.won, 2); assert.equal(b.lost, 3); near(assert, b.winRate, 40, 1e-9);
  assert.equal(b.appWon, 1); assert.equal(b.appLost, 1); near(assert, b.appWinRate, 50, 1e-9);
  assert.equal(m.won, 3); assert.equal(m.lost, 2); assert.equal(m.appWon, 1); assert.equal(m.appLost, 1);
  assert.equal(a.totals.appWon, 1); assert.equal(a.totals.appLost, 1); near(assert, a.totals.appWinRate, 50, 1e-9); near(assert, a.totals.winRate, 40, 1e-9);
  // a row for display: the app's counts, or a row from an older snapshot, its own
  assert.deepEqual(P.rowRecord(b), { won: 1, lost: 1, winRate: 50, app: true });
  assert.deepEqual(P.rowRecord({ won: 2, lost: 3, winRate: 40 }), { won: 2, lost: 3, winRate: 40, app: false });
  assert.deepEqual(P.rowRecord({ appWon: 0, appLost: 0, appWinRate: null, won: 1, lost: 0, winRate: 100 }), { won: 0, lost: 0, winRate: null, app: true });
});

test('combo legs on one match: a leg carries its match keys, and legs sharing any key are on one match', () => {
  const combo = (...evs) => { const n = pred('m', 10, 30, null, false); n.picks = evs.map((e, i) => Object.assign({}, n.picks[0], { id: 'c' + i, event: e })); return P.applyAtBet(n, evs.map(() => 0.5)); };
  assert.equal(combo('r1 g9', 'r2 g9').sameEvent, true, 'two events of one game (its gameId)');
  assert.equal(combo('r1', 'r2').sameEvent, false, 'different matches');
  assert.equal(combo('r5', 'r5 g3').sameEvent, true, 'a More Markets event under its main event (the root), only one carrying the gameId');
  assert.equal(combo('r1', null).sameEvent, null, 'a leg without an event: unknown');
  assert.equal(combo('787017', '787017').sameEvent, true, 'an older bare event id is a single key');
  assert.equal(combo('r1 g9').sameEvent, false, 'a single');
  // the keys survive the per-wallet files
  const u = P.unslim(JSON.parse(JSON.stringify(P.slim(combo('r1 sbitcoin|august-20', 'r2 sbitcoin|august-20')))));
  assert.equal(u.picks[0].event, 'r1 sbitcoin|august-20'); assert.equal(u.sameEvent, true, 'one asset at one date');
  // such a combo stays out of the averages, and each row says how many predictions its average covers
  const single = P.applyAtBet(pred('s', 10, 30, null, false), [0.2]);   // odds 25 % against 20 %: +5 pp
  const row = P.aggregate([single, combo('r1 g9', 'r2 g9')]).bettors[0];
  assert.equal(row.n, 2); assert.equal(row.vigN, 1); near(assert, row.avgVig, 0.05, 1e-9);
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
  assert.equal(P.isMarketMaker(P.MAKER_MIN), true); assert.equal(P.isMarketMaker(4), false); assert.equal(P.isMarketMaker(1), false);
});
test('open predictions: the loaded ones when they are all loaded, else the exchange\'s pending less the unclaimed and the self-matched', () => {
  // 0xf069…: the exchange's pending also counts its self-match until claimed (6), while the site leaves it out (3 open)
  const mine = [pred('o1', 1, 1, null, false), pred('o2', 1, 1, null, false), pred('o3', 1, 1, null, false), pred('u1', 1, 1, 'PREDICTOR_WINS', false), pred('u2', 1, 1, 'COUNTERPARTY_WINS', false)];
  const hist = [{ t: T0, pnl: 0, won: 0, lost: 0, pending: 6, nonDecisive: 0 }];
  assert.equal(P.bettorFigures({ mine, hist, isMaker: false, live: true }).open, 3, 'every prediction loaded: counted from them, whatever the exchange says');
  assert.equal(P.bettorFigures({ mine, hist, isMaker: false, live: true, truncated: true, selfPending: 1 }).open, 3, 'not all loaded: 6 pending − 2 unclaimed − 1 self-match');
  assert.equal(P.bettorFigures({ mine, hist, isMaker: false, live: true, truncated: true }).open, 4);
});
test('the realized interval allows for bets on the same question winning or losing together', () => {
  // 40 even-money singles on ONE question (they all win or all lose together) against 40 on 40 different questions
  const single = (id, q, won) => P.norm({ predictionId: id, predictor: ME, counterparty: MAKER, predictorCollateral: wei(10), counterpartyCollateral: wei(10), settled: true, result: won ? 'PREDICTOR_WINS' : 'COUNTERPARTY_WINS',
    createdAt: new Date(T0).toISOString(), settledAt: new Date(T0 + DAY).toISOString(),
    pickConfig: { pickConfigId: 'pc-' + id, resolved: true, result: won ? 'PREDICTOR_WINS' : 'COUNTERPARTY_WINS', picks: [{ conditionId: q, predictedOutcome: 'YES', condition: { question: q, endTime: Math.floor((T0 + DAY / 2) / 1000) } }] } });
  const same = Array.from({ length: 40 }, (_, i) => single('s' + i, 'cSAME', true));
  const apart = Array.from({ length: 40 }, (_, i) => single('d' + i, 'c' + i, i % 2 === 0));
  const rs = P.aggregate(same).vig.realized.overall, ra = P.aggregate(apart).vig.realized.overall;
  assert.equal(rs.ciKind, 'shared'); assert.equal(ra.ciKind, 'shared');
  assert.ok(rs.ci > 0.8, 'one question: the hit rate is 0 % or 100 %, so the interval spans nearly everything (' + rs.ci + ')');
  assert.ok(ra.ci > 0.1 && ra.ci < 0.25, '40 independent coin flips: about ±15 points (' + ra.ci + ')');
  // without the simulation (a wallet's own figures): the Wilson interval, with its bounds
  const w = P.aggregate(apart, { records: false }).vig.realized.overall;
  assert.equal(w.ciKind, 'wilson'); assert.ok(w.lo < w.hit && w.hit < w.hi);
});

test('a percentage rounded to zero carries no sign', () => {
  assert.equal(MD.util.fmtPct(-0.04, { sign: true, dp: 1 }), '0.0%');
  assert.equal(MD.util.fmtPct(-0.06, { sign: true, dp: 1 }), '-0.1%');
  assert.equal(MD.util.fmtPct(2.5, { sign: true, dp: 0 }), '+3%');
});
// ---- the tax center's additions to the wallet files (stx, vt, rows) ----
const sec = (ms) => Math.floor(ms / 1000);
/** a raw API prediction with its legs' Meridian settlement times (one leg per entry of legs: {yes, res ('Y' | 'N' |
 *  'V' | null), at (ms)}) and the claim's transaction */
const rawLegs = (id, { verdict = null, claimedAt = null, legs, predictor = ME, counterparty = MAKER, stake = 10, cp = 30, t = T0, pc = 'pc-' + id }) => ({
  predictionId: id, predictor, counterparty, predictorCollateral: wei(stake), counterpartyCollateral: wei(cp), predictorToken: 'tp-' + pc, counterpartyToken: 'tc-' + pc,
  settled: !!claimedAt, result: claimedAt ? verdict : null, createdAt: new Date(t).toISOString(), settledAt: claimedAt ? new Date(claimedAt).toISOString() : null, createTxHash: '0xp' + id, settleTxHash: claimedAt ? '0xs' + id : null,
  pickConfig: { pickConfigId: pc, resolved: !!verdict, result: verdict, picks: legs.map((l, i) => ({ conditionId: '0x' + id + i, predictedOutcome: l.yes === false ? 'NO' : 'YES', condition: { question: 'Q' + i, endTime: sec(t + 5 * DAY), settled: !!l.res, settledAt: l.res ? sec(l.at) : null, resolvedToYes: l.res === 'Y' ? true : l.res === 'N' ? false : null, nonDecisive: l.res === 'V' } })) } });

test('the claim transaction and each leg\'s source-market resolution travel in the wallet files (stx, vt); older files read as before', () => {
  const n = P.norm(rawLegs('s1', { verdict: 'PREDICTOR_WINS', claimedAt: T0 + 3 * DAY, legs: [{ res: 'Y', at: T0 + 2 * DAY }] }));
  assert.equal(n.tx, '0xps1'); assert.equal(n.stx, '0xss1', 'P.norm: settleTxHash');
  n.picks[0].verdictAt = T0 + 2 * DAY - 3600000;   // the builder's Polymarket resolution time (attachDecidedAt)
  const w = JSON.parse(JSON.stringify(P.slim(n, { stx: true, vt: true })));
  assert.equal(w.stx, '0xss1'); assert.equal(w.k[0].length, 11); assert.equal(w.k[0][10], sec(T0 + 2 * DAY) - 3600);
  const u = P.unslim(w);
  assert.equal(u.stx, '0xss1'); assert.equal(u.picks[0].verdictAt, T0 + 2 * DAY - 3600000); assert.equal(u.picks[0].settledAt, T0 + 2 * DAY);
  // slips and question files carry neither, and read like a file written before them
  const s = JSON.parse(JSON.stringify(P.slim(n, { ids: true })));
  assert.equal('stx' in s, false); assert.equal(s.k[0].length, 10);
  const old = P.unslim(s); assert.equal(old.stx, null); assert.equal(old.picks[0].verdictAt, null); assert.equal(old.picks[0].settledAt, T0 + 2 * DAY);
  // the tape row (P.compact) keeps the claim transaction, and P.full passes it on
  assert.equal(P.full(JSON.parse(JSON.stringify(P.compact(n)))).stx, '0xss1');
  // a twin prediction paid by that claim takes its transaction too
  const a = P.norm(rawLegs('tw1', { verdict: 'PREDICTOR_WINS', claimedAt: T0 + 3 * DAY, legs: [{ res: 'Y', at: T0 + 2 * DAY }], pc: 'twin' }));
  const b = P.norm(rawLegs('tw2', { verdict: 'PREDICTOR_WINS', legs: [{ res: 'Y', at: T0 + 2 * DAY }], pc: 'twin' }));
  P.markTokenClaims([a, b]); assert.equal(b.settledAt, T0 + 3 * DAY); assert.equal(b.stx, '0xstw1');
});

test('P.sourceVerdictAt: a win when its last leg resolved on its source market, a loss when the first leg against the bettor did', () => {
  const won = P.norm(rawLegs('v1', { verdict: 'PREDICTOR_WINS', legs: [{ res: 'Y', at: T0 + DAY }, { res: 'Y', at: T0 + 2 * DAY }] }));
  assert.deepEqual(P.sourceVerdictAt(won), { t: T0 + 2 * DAY, exact: false }, 'no source times: the Meridian settlements');
  won.picks[0].verdictAt = T0 + DAY - 600000; won.picks[1].verdictAt = T0 + 2 * DAY - 900000;
  assert.deepEqual(P.sourceVerdictAt(won), { t: T0 + 2 * DAY - 900000, exact: true }, 'the last leg\'s source time');
  won.picks[1].verdictAt = null;
  assert.deepEqual(P.sourceVerdictAt(won), { t: T0 + 2 * DAY, exact: false }, 'a leg without one counts at its Meridian settlement');
  won.picks[1].verdictAt = T0 + 9 * DAY;
  assert.equal(P.sourceVerdictAt(won).t, P.decidedAt(won), 'never after Meridian settled it');
  won.picks[1].verdictAt = T0 - DAY;
  assert.equal(P.sourceVerdictAt(won).t, T0 + DAY - 600000, 'the max over the legs');
  // a combo lost on its second leg while the first won: the leg against the bettor, not the first to resolve
  const lost = P.norm(rawLegs('v2', { verdict: 'COUNTERPARTY_WINS', legs: [{ res: 'Y', at: T0 + DAY }, { res: 'N', at: T0 + 3 * DAY }, { res: null }] }));
  lost.picks[0].verdictAt = T0 + DAY - 1000; lost.picks[1].verdictAt = T0 + 3 * DAY - 5000;
  assert.deepEqual(P.sourceVerdictAt(lost), { t: T0 + 3 * DAY - 5000, exact: true });
  const early = P.norm(rawLegs('v3', { verdict: 'COUNTERPARTY_WINS', legs: [{ res: 'N', at: T0 + DAY }] }));
  early.picks[0].verdictAt = T0 - DAY;
  assert.equal(P.sourceVerdictAt(early).t, T0, 'never before the bet');
  assert.equal(P.sourceVerdictAt(P.norm(rawLegs('v4', { legs: [{ res: null }] }))), null, 'open: none');
  // a record from before the legs kept their times: the decision estimate, not exact
  const bare = pred('v5', 10, 30, 'COUNTERPARTY_WINS', true);
  assert.deepEqual(P.sourceVerdictAt(bare), { t: P.decidedAt(bare), exact: false });
});

test('P.taxRows: a compact row per prediction of the wallet in either role, signed for it, that P.fromTaxRow reads back (rowsFmt 1)', () => {
  const B2 = '0x00000000000000000000000000000000000000b2';
  const won = P.norm(rawLegs('r1', { verdict: 'PREDICTOR_WINS', claimedAt: T0 + 3 * DAY, legs: [{ res: 'Y', at: T0 + 2 * DAY }], t: T0 }));
  won.picks[0].verdictAt = T0 + 2 * DAY - 60000;
  const lostUnclaimed = P.norm(rawLegs('r2', { verdict: 'COUNTERPARTY_WINS', legs: [{ res: 'N', at: T0 + DAY }], t: T0 + 1000 }));
  const open = P.norm(rawLegs('r3', { legs: [{ res: null }], t: T0 + 2000 }));
  const asMaker = P.norm(rawLegs('r4', { verdict: 'PREDICTOR_WINS', claimedAt: T0 + 4 * DAY, legs: [{ res: 'Y', at: T0 + 2 * DAY }], t: T0 + 3000, predictor: B2, counterparty: ME, stake: 7, cp: 21 }));
  const self = P.norm(rawLegs('r5', { legs: [{ res: null }], predictor: ME, counterparty: ME }));
  const other = P.norm(rawLegs('r6', { legs: [{ res: null }], predictor: B2 }));
  const rows = P.taxRows([won, lostUnclaimed, open, asMaker, self, other], ME, (n) => n.id === 'r2');
  assert.equal(P.ROWS_FMT, 1); assert.equal(rows.length, 4, 'both roles; a self-match and other wallets\' predictions left out');
  assert.deepEqual(rows.map((r) => r[0]), [T0 + 3000, T0 + 2000, T0 + 1000, T0], 'newest first');
  const [m, o, l, w] = rows.map(P.fromTaxRow);
  assert.deepEqual(w, { t: T0, stakeW: 10, pnlW: 30, res: 'won', maker: false, claimable: { t: T0 + 2 * DAY, exact: true }, verdict: { t: T0 + 2 * DAY - 60000, exact: true }, claim: T0 + 3 * DAY, traded: false });
  assert.deepEqual(l, { t: T0 + 1000, stakeW: 10, pnlW: -10, res: 'lost', maker: false, claimable: { t: T0 + DAY, exact: true }, verdict: { t: T0 + DAY, exact: false }, claim: null, traded: true });
  assert.deepEqual(o, { t: T0 + 2000, stakeW: 10, pnlW: 0, res: 'open', maker: false, claimable: null, verdict: null, claim: null, traded: false });
  assert.equal(m.maker, true); assert.equal(m.res, 'lost', 'the bettor won: the maker lost'); assert.equal(m.stakeW, 21); assert.equal(m.pnlW, -21); assert.equal(m.claim, T0 + 4 * DAY);
  // an estimated decision time (legs without times) is flagged
  const est = P.fromTaxRow(P.taxRows([pred('r7', 5, 5, 'PREDICTOR_WINS', false)], ME)[0]);
  assert.equal(est.claimable.exact, false); assert.equal(est.verdict.exact, false);
});

test('a cash-out with a profit over $500 is a big win whatever the verdict, from its sale', () => {
  const BUYER = '0x00000000000000000000000000000000000000c1', H = 3600000;
  const mk = (id, stake, cp, verdict) => Object.assign(pred(id, stake, cp, verdict, false), { pcTraded: true });
  // sold before a loss: 2,000 tokens for $800 on a $100 stake (+$700); sold out of an open bet (+$600); a sale of a
  // tenth of an open bet (+$80); a cash-out of +$300
  const ls = mk('ls', 100, 1900, 'COUNTERPARTY_WINS'), os = mk('os', 100, 900, null), oh = mk('oh', 100, 900, null), sm = mk('sm', 100, 900, 'PREDICTOR_WINS');
  const sale = (n, t, tokens, paid, v) => Object.assign({ t, seller: ME, buyer: BUYER, tokens, paid, pc: n.pc, side: 'P' }, v == null ? { vP: null, vC: null } : { vP: v, vC: 1 - v, dAt: T0 + DAY });
  const trades = [sale(ls, T0 + H, 2000, 800, 0), sale(os, T0 + 2 * H, 1000, 700), sale(oh, T0 + 3 * H, 100, 90), sale(sm, T0 + 4 * H, 1000, 400, 1)];
  const a = P.aggregate([ls, os, oh, sm], { trades });
  assert.deepEqual(a.bigWins.map((s) => s.id), ['os', 'ls'], 'newest sale first; the small ones are not big wins');
  const l = P.full(JSON.parse(JSON.stringify(a.bigWins[1])));
  assert.equal(l.won, false); assert.equal(l.held, 0); near(assert, l.tradedPnl, 700, 1e-6);
  assert.deepEqual(l.cashOut, { t: T0 + H, cash: 800, cost: 100, tok: 2000 });
  assert.deepEqual(l.group, { n: 1, s: 100, pool: 2000, in: 100, lp: 700, h: 0 }, 'one bet: the position is the slip');
  assert.equal(P.full(a.bigWins[0]).decided, false, 'an open bet sold out: listed from its sale');
});

test('a bettor\'s bets on the same picks count once, together, at the largest of them', () => {
  const BUYER = '0x00000000000000000000000000000000000000c1', H = 3600000;
  // three bets on the Rams (one position token): $250, $500 and $500 staked for 6,847.24 tokens, all sold before they won
  const rams = (id, stake, cp, t) => Object.assign(pred(id, stake, cp, 'PREDICTOR_WINS', false, t), { pc: 'pc-rams', pcTraded: true });
  const bets = () => [rams('r1', 250, 3321.28, T0), rams('r2', 500, 1305.41, T0 + H), rams('r3', 500, 970.55, T0 + 2 * H)];
  const sold = (paid) => [{ t: T0 + 3 * H, seller: ME, buyer: BUYER, tokens: 6847.24, paid, pc: 'pc-rams', side: 'P', vP: 1, vC: 0, dAt: T0 + DAY }];
  // for $1,371.59: +$121.59 over the three, none a big win (each slip won over $500 on its own)
  assert.deepEqual(P.aggregate(bets(), { trades: sold(1371.59) }).bigWins, []);
  // for $2,000: +$750, listed once, at the largest bet (the earlier of the two $500s)
  const a = P.aggregate(bets(), { trades: sold(2000) });
  assert.deepEqual(a.bigWins.map((s) => s.id), ['r2']);
  const n = P.full(JSON.parse(JSON.stringify(a.bigWins[0])));
  assert.equal(n.held, 0);
  assert.deepEqual(n.group, { n: 3, s: 1250, pool: 6847.24, in: 1250, lp: 750, h: 0 });
  // the slip keeps its own share (as its page, its file and its card have it): 1,805.41 of the 6,847.24 tokens
  near(assert, n.tradedPnl, 750 * 1805.41 / 6847.24, 1e-3);
  assert.deepEqual(n.cashOut, { t: T0 + 3 * H, cash: 2000, cost: 1250, tok: 6847.24 });
});

test('a position ends where a sale leaves the bettor holding nothing: a later bet on the same picks is a new one', () => {
  const BUYER = '0x00000000000000000000000000000000000000c1', H = 3600000;
  const on = (id, stake, cp, verdict, t) => Object.assign(pred(id, stake, cp, verdict, false, t), { pc: 'pc-x', pcTraded: true });
  // A: $100 for 1,000 tokens, all sold for $800 (+$700); B: $300 on the same picks after that, lost (−$300)
  const A = on('A', 100, 900, 'COUNTERPARTY_WINS', T0), B = on('B', 300, 300, 'COUNTERPARTY_WINS', T0 + 5 * H);
  const trades = [{ t: T0 + H, seller: ME, buyer: BUYER, tokens: 1000, paid: 800, pc: 'pc-x', side: 'P', vP: 0, vC: 1, dAt: T0 + DAY }];
  const L = P.ledger([A, B], trades, ME), pos = P.positions([A, B], L, ME);
  assert.deepEqual(pos.map((p) => [p.bets.map((n) => n.id).join(), p.out, Math.round(p.pnl)]), [['A', true, 700], ['B', false, -300]]);
  const a = P.aggregate([A, B], { trades });
  assert.deepEqual(a.bigWins.map((s) => s.id), ['A'], 'the +$700 cash-out, not netted with the later loss');
  assert.equal(P.full(a.bigWins[0]).group.lp, 700);
});

test('no sale and no win: a hedge\'s profit on a lost bet is no big win; bought tokens count in what went in', () => {
  const BUYER = '0x00000000000000000000000000000000000000c1', SELLER = '0x00000000000000000000000000000000000000c2', H = 3600000;
  // a $100 bet that lost, hedged with 1,000 maker-side tokens bought for $150 (+$850 on them)
  const lost = Object.assign(pred('h', 100, 900, 'COUNTERPARTY_WINS', false), { pcTraded: true });
  assert.deepEqual(P.aggregate([lost], { trades: [{ t: T0 + H, seller: SELLER, buyer: ME, tokens: 1000, paid: 150, pc: lost.pc, side: 'C', vP: 0, vC: 1, dAt: T0 + DAY }] }).bigWins, []);
  // a $100 bet that won (1,000 tokens), plus 4,000 more of its tokens bought for $1,000: in $1,100, back $5,000
  const won = Object.assign(pred('w', 100, 900, 'PREDICTOR_WINS', false), { pcTraded: true });
  const a = P.aggregate([won], { trades: [{ t: T0 + H, seller: SELLER, buyer: ME, tokens: 4000, paid: 1000, pc: won.pc, side: 'P', vP: 1, vC: 0, dAt: T0 + DAY }] });
  const g = P.full(a.bigWins[0]).group;
  assert.deepEqual([g.in, g.lp, g.s], [1100, 3900, 100]);
  assert.equal(P.full(a.bigWins[0]).cashOut, null, 'it sold nothing');
});

test('question volume as Meridian\'s app shows it: all time on its page, the Filtered windows on its list cards (Flávio Bolsonaro: $16.98M, $2.72M)', () => {
  // the live API's row (USD floats, not wei) and the snapshot's compact row carry the same figures
  const api = { conditionId: '0xq', question: 'Will Flávio Bolsonaro win the 2026 Brazilian presidential election?', openInterest: '0', similarMarketVolume: 16981737.2, similarMarketVolume24h: 1280881.67, similarMarketVolume7d: 4792126, similarMarketVolumeFiltered24h: 2310277.44, similarMarketVolumeFiltered7d: 2718695 };
  const row = P.compactQuestion(api);
  const want = { all: 16981737.2, d24: 2310277.44, d7: 2718695, raw24: 1280881.67, raw7: 4792126 };
  assert.deepEqual(P.questionVolume(api), want); assert.deepEqual(P.questionVolume(row), want);
  assert.equal(P.fmtVol(want.d7), '$2.72M'); assert.equal(P.fmtVol(want.all), '$16.98M'); assert.equal(P.fmtVol(want.raw7), '$4.79M');
  // an older snapshot's row (only the unfiltered windows) and one added from open predictions (none)
  assert.deepEqual(P.questionVolume({ id: '0xq', v24: 5, v7: 7 }), { all: null, d24: null, d7: null, raw24: 5, raw7: 7 });
  assert.deepEqual(P.questionVolume({ id: '0xq', v24: 0, v7: 0 }), { all: null, d24: null, d7: null, raw24: 0, raw7: 0 });
  // the app's format: to the cent below $10,000, else two decimals and k / M / B / T
  assert.deepEqual([12345.6, 9999.99, 950, 0, 1.2e9, 3.4e12].map(P.fmtVol), ['$12.35k', '$9,999.99', '$950.00', '$0.00', '$1.20B', '$3.40T']);
  assert.equal(P.fmtVol(null), '—');
});
