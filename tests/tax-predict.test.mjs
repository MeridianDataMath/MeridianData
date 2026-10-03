// Tax center, Meridian Predict (MD.tax.predict): both sides of every prediction, the three date bases, the gross split,
// the decided-not-claimed tail, live and snapshot data agreeing, and the compact rows of a truncated wallet file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, near } from './_load.mjs';

const MD = load(['js/util.js', 'js/api.js', 'js/predict/api.js', 'js/predict/analytics.js', 'js/tax/core.js', 'js/tax/tz.js', 'js/tax/periods.js', 'js/tax/fx.js', 'js/tax/predict.js']);
const P = MD.predict, T = MD.tax, PR = T.predict;
const DAY = 86400000, HOUR = 3600000;
const wei = (x) => (BigInt(Math.round(x * 1e6)) * 1000000000000n).toString();
const sec = (ms) => Math.floor(ms / 1000);
const W = '0x00000000000000000000000000000000000000a1';   // the wallet: a market maker, like 0x79cb…
const B = (i) => '0x' + (0xb00 + i).toString(16).padStart(40, '0');
const X = '0x00000000000000000000000000000000000000e1';   // another maker
const BUYER = '0x00000000000000000000000000000000000000c1';
const T0 = Date.UTC(2026, 7, 3);
const USD = T.fx.money(null, 'UTC');
// a report currency at a rate that moves every hour, so a wrong date shows
const CCY = { ccy: 'EUR', rates: {}, fx: (v, t) => (v ? v * (0.8 + ((Math.floor(t / HOUR) % 10) / 100)) : v) };
const per = (a, b, tz = 'UTC') => ({ start: a, end: b, tz });
const ALL = per(Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1));

/** a prediction as the API has it, through P.norm. verdict: null (open) | 'PREDICTOR_WINS' | 'COUNTERPARTY_WINS' |
 *  'NON_DECISIVE'; decidedAt: its leg's Meridian settlement; claimedAt: the claim (by whoever won) */
function mk({ id, predictor = B(1), counterparty = W, stake, cp, t, verdict = null, decidedAt = null, claimedAt = null, pc = 'pc-' + id, vt = null }) {
  const n = P.norm({ predictionId: id, predictor, counterparty, predictorCollateral: wei(stake), counterpartyCollateral: wei(cp), predictorToken: 'tp-' + pc, counterpartyToken: 'tc-' + pc,
    settled: !!claimedAt, result: claimedAt ? verdict : null, createdAt: new Date(t).toISOString(), settledAt: claimedAt ? new Date(claimedAt).toISOString() : null, createTxHash: '0xp' + id, settleTxHash: claimedAt ? '0xs' + id : null,
    pickConfig: { pickConfigId: pc, resolved: !!verdict, result: verdict, picks: [{ conditionId: 'c-' + id, predictedOutcome: 'YES', condition: { question: 'Q ' + id, endTime: sec(t + 2 * DAY), settled: !!verdict, settledAt: verdict ? sec(decidedAt) : null, resolvedToYes: verdict === 'PREDICTOR_WINS' ? true : verdict === 'COUNTERPARTY_WINS' ? false : null, nonDecisive: verdict === 'NON_DECISIVE' } }] } });
  if (vt) n.picks[0].verdictAt = vt;
  return n;
}
/** a compact trade as the snapshot builder writes it (buildTrades) */
const trade = ({ t, seller, buyer, tokens, paid, n, side = 'P' }) => Object.assign({ t, seller, buyer, tokens, paid, pc: n.pc, pid: n.id, side, q: 'Q', dAt: n.decided ? P.decidedAt(n) : null, sa: n.settledAt },
  !n.decided ? { vP: null, vC: null } : n.won ? { vP: 1, vC: 0 } : n.nd ? { vP: n.stake / n.pool, vC: n.cp / n.pool } : { vP: 0, vC: 1 });
const figs = (prep, mode, period = ALL, money = USD) => PR.figures(PR.book(prep, mode), PR.tail(prep, mode, period), period, money, period.tz || 'UTC');
const identity = (F) => F.winGain - F.lostStakes + F.ledgerGains + F.ledgerLosses - F.pnl;

// the market maker's book, shaped like 0x79cb…: it takes most bettors' predictions, buys some back, and bets once itself
function makerBook() {
  const p1 = mk({ id: 'p1', predictor: B(1), stake: 10, cp: 40, t: T0, verdict: 'COUNTERPARTY_WINS', decidedAt: T0 + DAY, claimedAt: T0 + DAY + HOUR });            // the bettor lost: the maker's win, claimed by it
  const p2 = mk({ id: 'p2', predictor: B(2), stake: 20, cp: 5, t: T0 + HOUR, verdict: 'PREDICTOR_WINS', decidedAt: T0 + DAY, claimedAt: T0 + 3 * DAY });          // the bettor won: the maker's loss, claimed by the bettor
  const p3 = mk({ id: 'p3', predictor: B(3), stake: 30, cp: 30, t: T0 + 2 * HOUR });                                                                              // open; the maker buys the bettor's side back
  const p4 = mk({ id: 'p4', predictor: B(4), stake: 5, cp: 15, t: T0 + 3 * HOUR, verdict: 'COUNTERPARTY_WINS', decidedAt: T0 + 2 * DAY });                       // the maker's win, not claimed yet
  const p5 = mk({ id: 'p5', predictor: W, counterparty: X, stake: 8, cp: 12, t: T0 + 4 * HOUR, verdict: 'PREDICTOR_WINS', decidedAt: T0 + DAY, claimedAt: T0 + 2 * DAY });   // the wallet as the bettor
  const p6 = mk({ id: 'p6', predictor: W, counterparty: W, stake: 1, cp: 1, t: T0 + 5 * HOUR });                                                                  // against itself: no money moves
  const trades = [trade({ t: T0 + 6 * HOUR, seller: B(3), buyer: W, tokens: 60, paid: 6, n: p3 })];
  return { norms: [p1, p2, p3, p4, p5, p6], trades };
}

test('both sides: a market maker\'s predictions count from its side, and its own bets as the bettor (0x79cb…, 0xea41…: not 0 predictions)', () => {
  const { norms, trades } = makerBook();
  const prep = PR.prepare({ norms, trades, addr: W });
  assert.equal(prep.mine.length, 5, 'both roles, the self-match left out');
  assert.deepEqual(prep.coverage.roles, { bettor: 1, maker: 4 });
  const x1 = prep.mine.find((x) => x.n.id === 'p1');
  assert.deepEqual([x1.role, x1.stakeW, x1.pnlW, x1.wonW], ['maker', 40, 10, true]);
  const x2 = prep.mine.find((x) => x.n.id === 'p2');
  assert.deepEqual([x2.role, x2.stakeW, x2.pnlW, x2.wonW, x2.lostW], ['maker', 5, -5, false, true]);
  assert.equal(prep.mine.find((x) => x.n.id === 'p3').traded, true, 'the bought-back prediction goes through the ledger');
  const F = figs(prep, 'claim');
  near(assert, F.pnl, 10 - 5 + 24 + 12, 1e-9, 'the maker\'s win and loss, the buy-back\'s set (60 − 6 − 30), the bet it won');
  near(assert, F.winGain, 22, 1e-9); near(assert, F.payouts, 50 + 20, 1e-9); near(assert, F.lostStakes, 5, 1e-9);
  near(assert, F.ledgerGains, 24, 1e-9); near(assert, F.secondary, 24, 1e-9);
  near(assert, F.wagered, 40 + 5 + 30 + 15 + 8, 1e-9, 'its own collateral: the maker\'s, or its stake as the bettor');
  assert.equal(F.placed, 5); assert.equal(F.won, 2); assert.equal(F.lost, 1);
  assert.deepEqual([F.tail.n, F.tail.won, F.tail.lost], [1, 1, 0], 'its unclaimed win (p4)'); near(assert, F.tail.pnl, 5, 1e-9);
  near(assert, figs(prep, 'claimable').pnl, F.pnl + 5, 1e-9, 'claimable books the unclaimed win too');
  near(assert, PR.openStakes(prep), 0, 1e-9, 'the bought-back prediction is a matched set: nothing at risk, its share sold none');
});

test('every basis: winnings − lost stakes + ledger gains + ledger losses = the realized PnL, in USD and in the report currency', () => {
  // a mixed book: both roles, sales before the verdict, buy-backs, held shares, unclaimed results and a void
  const norms = [], trades = [];
  for (let i = 0; i < 120; i++) {
    const maker = i % 3 !== 0, t = T0 + i * 5 * HOUR;
    const verdict = i % 11 === 5 ? null : i % 13 === 0 ? 'NON_DECISIVE' : i % 2 ? 'PREDICTOR_WINS' : 'COUNTERPARTY_WINS';
    const n = mk({ id: 'm' + i, predictor: maker ? B(i % 7) : W, counterparty: maker ? W : X, stake: 5 + (i % 9), cp: 3 + (i % 5) * 2.5, t, verdict, decidedAt: t + 30 * HOUR, claimedAt: verdict && i % 4 ? t + 30 * HOUR + (i % 5) * 7 * HOUR : null, vt: verdict && i % 3 ? t + 29 * HOUR : null });
    norms.push(n);
    if (i % 6 === 1) trades.push(trade({ t: t + HOUR, seller: maker ? n.predictor : W, buyer: maker ? W : BUYER, tokens: n.pool * (i % 12 === 1 ? 1 : 0.4), paid: 2 + (i % 4), n }));
  }
  const prep = PR.prepare({ norms, trades, addr: W });
  assert.ok(prep.L.events.length > 10, 'the ledger books sales, sets and held verdicts');
  for (const period of [ALL, per(T0 + 5 * DAY, T0 + 12 * DAY), per(T0 + 9 * DAY + 7 * HOUR, T0 + 20 * DAY, 'Asia/Kolkata')]) {
    for (const m of PR.MODES) {
      for (const money of [USD, CCY]) {
        const F = figs(prep, m, period, money);
        near(assert, identity(F), 0, 1e-9, `${m} identity in USD`);
        near(assert, F.winGainC - F.lostStakesC + F.ledgerGainsC + F.ledgerLossesC - F.pnlC, 0, 1e-9, `${m} identity in ${money.ccy}`);
        near(assert, F.pnl, PR.compare(prep, period, money)[m].pnl, 1e-9, 'the comparison line agrees');
        near(assert, F.pnl, F.months.reduce((a, x) => a + x.pnl, 0), 1e-9, 'months add up');
        near(assert, F.days.length ? F.days[F.days.length - 1].cumPnl : 0, F.pnl, 1e-9, 'the cumulative ends at the total');
      }
    }
  }
});

test('the date bases: a loss decided 2026-09-30 22:19:05 UTC and claimed by the maker 2026-10-01 00:49 is Q3 when claimable or at the verdict, Q4 at the claim', () => {
  const me = B(9);
  const n = mk({ id: 'q', predictor: me, counterparty: W, stake: 23, cp: 40, t: Date.UTC(2026, 8, 29, 12), verdict: 'COUNTERPARTY_WINS', decidedAt: Date.parse('2026-09-30T22:19:05Z'), claimedAt: Date.parse('2026-10-01T00:49:00Z'), vt: Date.parse('2026-09-30T21:58:00Z') });
  const prep = PR.prepare({ norms: [n], trades: [], addr: me });
  const Q3 = per(Date.UTC(2026, 6, 1), Date.UTC(2026, 9, 1)), Q4 = per(Date.UTC(2026, 9, 1), Date.UTC(2027, 0, 1));
  const at = (mode, q) => figs(prep, mode, q).pnl;
  assert.deepEqual(PR.MODES.map((m) => [at(m, Q3), at(m, Q4)]), [[0, -23], [-23, 0], [-23, 0]], 'claim, claimable, verdict');
  assert.equal(PR.tail(prep, 'claim', Q3).items.length, 1, 'at the end of Q3 it was decided and not claimed: the tail of Q3 under the claim basis');
  assert.equal(PR.tail(prep, 'claim', Q4).items.length, 0, 'decided in Q3: not Q4\'s tail');
  const d = PR.dates(prep.mine[0]);
  assert.deepEqual(d.claim, { t: Date.parse('2026-10-01T00:49:00Z'), by: 'counterparty' }, 'the claim that books a loss is the other side\'s');
  assert.deepEqual(d.claimable, { t: Date.parse('2026-09-30T22:19:05Z'), exact: true });
  assert.deepEqual(d.verdict, { t: Date.parse('2026-09-30T21:58:00Z'), exact: true });
  // in Sydney the decision is already 1 October: a local quarter follows the local date
  const syd = (a, b) => per(a, b, 'Australia/Sydney');
  const Q3s = syd(Date.parse('2026-06-30T14:00:00Z'), Date.parse('2026-09-30T14:00:00Z'));
  assert.equal(figs(prep, 'claimable', Q3s).pnl, 0);
});

test('live and snapshot agree on the claim basis: a loss the maker claimed through another bettor\'s twin prediction (0x9382…)', () => {
  const me = B(5), other = B(6);
  const mine = () => mk({ id: 'l1', predictor: me, counterparty: W, stake: 10, cp: 10, t: T0, verdict: 'COUNTERPARTY_WINS', decidedAt: T0 + DAY, pc: 'shared' });
  const twin = mk({ id: 'l2', predictor: other, counterparty: W, stake: 50, cp: 50, t: T0 + HOUR, verdict: 'COUNTERPARTY_WINS', decidedAt: T0 + DAY, claimedAt: T0 + 2 * DAY, pc: 'shared' });
  // the snapshot builder sees every wallet: the maker's claim on l2 redeemed its whole balance of the token, l1 too
  const snap = [mine(), twin]; P.markTokenClaims(snap);
  const file = JSON.parse(JSON.stringify({ predictions: [P.slim(snap[0], { stx: true, vt: true })] }));
  const fileNorms = file.predictions.map(P.unslim);
  const S = figs(PR.prepare({ norms: fileNorms, trades: [], addr: me }), 'claim');
  // live sees only this wallet's predictions: unmarked until the file's claims are merged in
  const live = [mine()]; P.markTokenClaims(live);
  assert.equal(figs(PR.prepare({ norms: live, trades: [], addr: me, live: true }), 'claim').pnl, 0, 'unmarked: still in the tail');
  assert.equal(PR.mergeSnapshot(live, fileNorms), 1);
  const L = figs(PR.prepare({ norms: live, trades: [], addr: me, live: true }), 'claim');
  assert.equal(S.pnl, -10); assert.equal(L.pnl, S.pnl, 'the same claim-basis total'); assert.equal(L.tail.n, 0);
  assert.equal(live[0].settledAt, T0 + 2 * DAY); assert.equal(live[0].stx, '0xsl2', 'with the claim\'s transaction');
});

test('a traded loss held to the verdict: the sale on its own date, the rest at the claim, the settlement or the verdict', () => {
  const me = B(7);
  const n = mk({ id: 'h', predictor: me, counterparty: W, stake: 10, cp: 30, t: T0, verdict: 'COUNTERPARTY_WINS', decidedAt: T0 + 3 * DAY, claimedAt: T0 + 5 * DAY, vt: T0 + 3 * DAY - 2 * HOUR });
  // sells half its 40 tokens for $3 on day 1; the other 20 (cost $5) are lost at the verdict
  const prep = PR.prepare({ norms: [n], trades: [trade({ t: T0 + DAY, seller: me, buyer: BUYER, tokens: 20, paid: 3, n })], addr: me });
  for (const [mode, when] of [['claim', T0 + 5 * DAY], ['claimable', T0 + 3 * DAY], ['verdict', T0 + 3 * DAY - 2 * HOUR]]) {
    const ev = PR.book(prep, mode);
    const sale = ev.find((e) => e.kind === 'sale'), held = ev.find((e) => e.kind === 'held-verdict'), counted = ev.find((e) => e.kind === 'lost');
    assert.equal(sale.t, T0 + DAY, mode + ': the sale on its own date'); near(assert, sale.pnl, 3 - 5, 1e-9);
    assert.equal(held.t, when, mode + ': the tokens held'); near(assert, held.pnl, -5, 1e-9);
    assert.equal(counted.t, when); assert.equal(counted.ledger, true, 'counted once, its money in the ledger\'s events');
    const F = figs(prep, mode);
    near(assert, F.pnl, -7, 1e-9); near(assert, F.ledgerLosses, -7, 1e-9); near(assert, F.lostStakes, 0, 1e-9); near(assert, identity(F), 0, 1e-12);
    assert.equal(F.lost, 1);
  }
});

test('never an empty card: a period whose only event is an unclaimed win, or a void (0x65a2…: September)', () => {
  const me = B(8);
  const sep = per(Date.UTC(2026, 8, 1), Date.UTC(2026, 9, 1));
  const win = mk({ id: 'u', predictor: me, counterparty: W, stake: 5, cp: 16.1157, t: Date.UTC(2026, 7, 27, 14, 30), verdict: 'PREDICTOR_WINS', decidedAt: Date.UTC(2026, 8, 14, 1, 13) });
  const prep = PR.prepare({ norms: [win], trades: [], addr: me });
  assert.equal(PR.hasActivity(prep, sep), true);
  const F = figs(prep, 'claim', sep);
  assert.equal(F.pnl, 0); assert.equal(F.placed, 0);
  assert.deepEqual([F.tail.n, F.tail.won, F.tail.title, F.tail.booked], [1, 1, 'Decided, not claimed', false]); near(assert, F.tail.pnl, 16.1157, 1e-4);
  const G = figs(prep, 'claimable', sep);
  near(assert, G.pnl, 16.1157, 1e-4); assert.deepEqual([G.tail.title, G.tail.booked], ['Booked, not yet claimed', true]);
  assert.equal(PR.hasActivity(prep, per(Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1))), false, 'nothing in October');
  // a void, refunded (claimed) in September: no PnL, still a settlement to show
  const v = mk({ id: 'v', predictor: me, counterparty: W, stake: 5, cp: 5, t: Date.UTC(2026, 7, 20), verdict: 'NON_DECISIVE', decidedAt: Date.UTC(2026, 8, 3), claimedAt: Date.UTC(2026, 8, 4) });
  const pv = PR.prepare({ norms: [v], trades: [], addr: me });
  assert.equal(PR.hasActivity(pv, sep), true);
  const V = figs(pv, 'claim', sep);
  assert.equal(V.void, 1); assert.equal(V.pnl, 0); near(assert, V.refunds, 5, 1e-9);
  // and a void not refunded yet is in the tail, as a void
  const v2 = mk({ id: 'v2', predictor: me, counterparty: W, stake: 5, cp: 5, t: Date.UTC(2026, 7, 20), verdict: 'NON_DECISIVE', decidedAt: Date.UTC(2026, 8, 3) });
  const T2 = figs(PR.prepare({ norms: [v2], trades: [], addr: me }), 'claim', sep).tail;
  assert.deepEqual([T2.n, T2.void, T2.won, T2.lost], [1, 1, 0, 0]);
});

test('a truncated maker file: the rows give the whole period, the same as every prediction loaded; without rows the figures say they are incomplete', () => {
  // 300 predictions of the maker, a few bought back; the file keeps the newest 100 and the traded ones (as the builder does)
  const norms = [], trades = [];
  for (let i = 0; i < 300; i++) {
    const t = T0 + i * 3 * HOUR, verdict = i > 280 ? null : i % 3 ? 'COUNTERPARTY_WINS' : 'PREDICTOR_WINS';
    const n = mk({ id: 'r' + i, predictor: B(i % 9), stake: 4 + (i % 5), cp: 6 + (i % 3), t, verdict, decidedAt: t + 20 * HOUR, claimedAt: verdict && i % 7 ? t + 26 * HOUR : null, vt: verdict && i % 2 ? t + 19 * HOUR : null });
    norms.push(n);
    if (i % 40 === 3) { trades.push(trade({ t: t + HOUR, seller: n.predictor, buyer: W, tokens: n.pool / 2, paid: 1.5, n })); n.pcTraded = true; }
  }
  const tradedPc = new Set(trades.map((t) => t.pc));
  const rows = JSON.parse(JSON.stringify(P.taxRows(norms, W, (n) => tradedPc.has(n.pc))));
  const newest = norms.slice().sort((a, b) => b.t - a.t);
  const kept = newest.slice(0, 100).concat(newest.slice(100).filter((n) => tradedPc.has(n.pc)));
  const fileNorms = kept.map((n) => P.unslim(JSON.parse(JSON.stringify(P.slim(n, { stx: true, vt: true })))));
  const full = PR.prepare({ norms, trades, addr: W });
  const withRows = PR.prepare({ norms: fileNorms, trades, rows, rowsFmt: 1, truncated: true, total: 300, newest: 100, addr: W });
  const without = PR.prepare({ norms: fileNorms, trades, truncated: true, total: 300, newest: 100, addr: W });
  assert.equal(withRows.coverage.rows, true); assert.equal(without.coverage.rows, false);
  for (const period of [ALL, per(T0 + 10 * DAY, T0 + 20 * DAY), per(T0 + 30 * DAY + 5 * HOUR, T0 + 34 * DAY, 'America/New_York')]) {
    for (const m of PR.MODES) {
      const a = figs(withRows, m, period), b = figs(full, m, period);
      for (const k of ['pnl', 'winGain', 'payouts', 'lostStakes', 'ledgerGains', 'ledgerLosses', 'wagered', 'placed', 'won', 'lost', 'void']) near(assert, a[k], b[k], 1e-3, `${m} ${k}`);
      near(assert, a.tail.pnl, b.tail.pnl, 1e-3, m + ' tail'); assert.equal(a.tail.n, b.tail.n);
    }
  }
  near(assert, PR.openStakes(withRows), PR.openStakes(full), 1e-3);
  assert.ok(Math.abs(figs(without, 'claim').pnl - figs(full, 'claim').pnl) > 1, 'without the rows only the loaded predictions count');
  const note = PR.coverageNote(without);
  assert.equal(note.blocking, true);
  assert.equal(note.text, 'This wallet is the market maker on 300 predictions; the snapshot keeps only the newest 100 of 300, so the period figures are incomplete.');
  assert.equal(PR.fileNote(without), note.text, 'every Predict file carries it');
  assert.equal(PR.coverageNote(withRows).blocking, false);
  assert.match(PR.fileNote(withRows), /lists the newest .* of the wallet's 300 predictions only/);
  assert.equal(PR.coverageNote(full), null);
  // an unknown rows format is not read (an older page meeting a newer file falls back to the note)
  assert.equal(PR.prepare({ norms: fileNorms, trades, rows, rowsFmt: 2, truncated: true, total: 300, newest: 100, addr: W }).coverage.rows, false);
  // live: the API's newest predictions from the cutoff, the snapshot's rows before it
  const cut = newest[150].t;
  const liveNorms = norms.filter((n) => n.t >= cut).concat(fileNorms.filter((n) => n.t < cut));
  const liveP = PR.prepare({ norms: liveNorms, trades, rows, rowsFmt: 1, truncated: true, total: 300, newest: 150, cutoff: cut, addr: W, live: true });
  for (const m of PR.MODES) near(assert, figs(liveP, m).pnl, figs(full, m).pnl, 1e-3, 'live ' + m);
});

// ---------- the files (batch 5) ----------
const ctxOf = (mode, period = ALL, money = USD, tz = 'UTC') => ({ tz, money, mode, period, fname: (k) => k + '.csv' });
const col = (f, name) => { const c = f.columns.find((x) => x[0] === name); assert.ok(c, 'no column ' + name); return c[1]; };
const cells = (f, name) => f.rows.map(col(f, name));
/** a report currency whose rate changes every day, as the ECB's: amounts booked on the wrong day show */
const eur = (tz = 'UTC') => {
  const d = [], r = [];
  for (let t = Date.UTC(2026, 5, 1), i = 0; t < Date.UTC(2027, 1, 1); t += DAY, i++) { d.push(new Date(t).toISOString().slice(0, 10)); r.push(0.8 + (i % 17) / 100); }
  return T.fx.money(T.fx.rates({ ccy: 'EUR', id: 'ecb', via: 'file', table: { source: 'ecb', ccy: 'EUR', d, r, ref: null }, tz }), tz);
};
/** what the record (its Net counted in the period) and the secondary-market file (its realized PnL) add up to, read
 *  from their cells as a spreadsheet would: [USD, report currency] */
const fromFiles = (prep, mode, period, money) => {
  const ctx = ctxOf(mode, period, money, period.tz || 'UTC');
  const rec = PR.recordFile(prep, ctx), tr = PR.tradesFile(prep, ctx);
  const at = { claim: 'Net at the claim', claimable: 'Net at the decision', verdict: 'Net at the source resolution' }[mode];
  const counted = cells(rec, 'Net in this period\'s realized PnL');
  const num = (list, keep) => list.reduce((a, v, i) => a + (keep(i) && v !== '' ? Number(v) : 0), 0);
  const usd = num(cells(rec, 'Net USD (± PnL × share held)'), (i) => counted[i] === 'yes') + num(cells(tr, 'Realized PnL USD'), () => true);
  const ccy = money.rates ? num(cells(rec, at + ' ' + money.ccy), (i) => counted[i] === 'yes') + num(cells(tr, 'Realized PnL ' + money.ccy), () => true) : usd;
  return { usd, ccy, rows: rec.rows.length + tr.rows.length };
};

const makerPrep = () => { const { norms, trades } = makerBook(); return PR.prepare({ norms, trades, addr: W }); };

// a wallet that only buys position tokens (0xba3b…): one held to a win and redeemed, one open, one worthless, one won
// and not redeemed yet
function buyerBook() {
  const q1 = mk({ id: 'q1', predictor: B(1), counterparty: X, stake: 10, cp: 30, t: T0, verdict: 'PREDICTOR_WINS', decidedAt: T0 + DAY, claimedAt: T0 + 2 * DAY });
  const q2 = mk({ id: 'q2', predictor: B(2), counterparty: X, stake: 10, cp: 10, t: T0 });
  const q3 = mk({ id: 'q3', predictor: B(3), counterparty: X, stake: 10, cp: 10, t: T0, verdict: 'COUNTERPARTY_WINS', decidedAt: T0 + DAY, claimedAt: T0 + 30 * HOUR });
  const q4 = mk({ id: 'q4', predictor: B(4), counterparty: X, stake: 10, cp: 10, t: T0, verdict: 'PREDICTOR_WINS', decidedAt: T0 + 2 * DAY });
  const trades = [
    trade({ t: T0 + HOUR, seller: B(1), buyer: W, tokens: 20, paid: 5, n: q1 }), trade({ t: T0 + 2 * HOUR, seller: B(2), buyer: W, tokens: 10, paid: 4, n: q2 }),
    trade({ t: T0 + 3 * HOUR, seller: B(3), buyer: W, tokens: 5, paid: 2, n: q3 }), trade({ t: T0 + 4 * HOUR, seller: B(4), buyer: W, tokens: 10, paid: 3, n: q4 })];
  // its own burns (the snapshot's rd): q1's tokens redeemed on day 4; q4's not yet
  return PR.prepare({ norms: [q1, q2, q3, q4], trades, rd: { 'pc-q1|P': T0 + 4 * DAY }, addr: W });
}

test('the record (all statuses): both roles, the status at the period end, all three dates, who claimed', () => {
  const prep = makerPrep();
  const A = per(T0, T0 + 36 * HOUR, 'UTC'), Bp = per(T0 + 60 * HOUR, T0 + 10 * DAY, 'UTC');
  const f = PR.recordFile(prep, ctxOf('claim', A, USD, 'Europe/London'));
  const head = f.columns.map((c) => c[0]);
  for (const c of ['Side', 'Placed (UTC)', 'Placed (Europe/London)', 'Decided: settled on Meridian, claimable from (UTC)', 'Decided time', 'Source market resolved (UTC)', 'Source resolution time', 'Claimed, paid out (UTC)', 'Claimed by', 'Booked (UTC)', 'Booked (Europe/London)', 'Date basis', 'Status at period end', 'Picks', 'Legs', 'Category',
    'Own stake or collateral USD', 'Counterparty', 'Counterparty collateral USD', 'Locked odds (bettor)', 'Result (this wallet\'s side)', 'Share still held at the verdict', 'Cost USD (own stake or collateral × share held)', 'Net USD (± PnL × share held)', 'PnL booked in', 'Prediction ID', 'Pick configuration ID', 'Placement tx', 'Claim tx']) assert.ok(head.includes(c), c);
  assert.equal(head.some((c) => /\bsettled\b(?! on Meridian)/i.test(c)), false, 'no bare "settled": decided or claimed');
  assert.equal(f.name, 'predict-record.csv');
  const row = (id) => f.rows.find((r) => r.n.id === id);
  const get = (id, names) => names.map((nm) => col(f, nm)(row(id)));
  const C = ['Side', 'Status at period end', 'Result (this wallet\'s side)', 'Own stake or collateral USD', 'Counterparty', 'Counterparty collateral USD', 'Claimed by', 'Payout USD (claimed win: pool × share held; claimed void: the refund; loss: 0)', 'Net USD (± PnL × share held)', 'PnL booked in', 'Net in this period\'s realized PnL'];
  assert.deepEqual(f.rows.map((r) => r.n.id), ['p1', 'p2', 'p3', 'p4', 'p5'], 'all placed in it; the self-match left out');
  assert.deepEqual(get('p1', C), ['market maker', 'claimed', 'won', '40', B(1), '10', 'this wallet', '50', '10', 'this file', 'yes']);
  assert.deepEqual(get('p2', C), ['market maker', 'decided, not claimed', 'lost', '5', B(2), '20', 'the counterparty', '0', '-5', 'this file', 'no'], 'claimed by the bettor after the period');
  assert.deepEqual(get('p3', C), ['market maker', 'open', 'open', '30', B(3), '30', '', '', '', '', 'no'], 'undecided, its tokens matched by the set: its result is the set\'s, in the secondary-market file');
  assert.deepEqual(get('p4', C), ['market maker', 'open', 'won', '15', B(4), '5', '', '', '5', 'this file', 'no'], 'decided after the period: open at its end');
  assert.deepEqual(get('p5', C), ['bettor', 'decided, not claimed', 'won', '8', X, '12', 'this wallet', '20', '12', 'this file', 'no']);
  assert.deepEqual(get('p1', ['Placed (UTC)', 'Decided: settled on Meridian, claimable from (UTC)', 'Decided time', 'Source market resolved (UTC)', 'Source resolution time', 'Claimed, paid out (UTC)', 'Booked (UTC)', 'Placed (Europe/London)', 'Placement tx', 'Claim tx', 'Prediction ID']),
    ['2026-08-03 00:00:00 UTC', '2026-08-04 00:00:00 UTC', 'exact', '2026-08-04 00:00:00 UTC', 'not known: when decided on Meridian or earlier', '2026-08-04 01:00:00 UTC', '2026-08-04 01:00:00 UTC', '2026-08-03 01:00:00', '0xpp1', '0xsp1', 'p1']);
  // a later period: what was claimed in it, and what is still open at its end
  const g = PR.recordFile(prep, ctxOf('claim', Bp));
  assert.deepEqual(g.rows.map((r) => [r.n.id, r.status]), [['p2', 'claimed'], ['p3', 'open']]);
  assert.equal(col(g, 'Net in this period\'s realized PnL')(g.rows[0]), 'yes');
  // under the decision basis p2 and p5 are booked in A, and p4 (decided on day 2) in neither
  const c = PR.recordFile(prep, ctxOf('claimable', A));
  assert.deepEqual(c.rows.filter(c.counted).map((r) => r.n.id), ['p1', 'p2', 'p5']);
  assert.equal(c.name, 'predict-record-claimable.csv', 'another basis says so in the file name');
});

test('the record: a prediction sold in full reads sold after the sale, its PnL in the secondary-market file', () => {
  const me = B(7);
  const n = mk({ id: 's', predictor: me, counterparty: W, stake: 10, cp: 30, t: T0, verdict: 'COUNTERPARTY_WINS', decidedAt: T0 + 3 * DAY, claimedAt: T0 + 5 * DAY });
  const prep = PR.prepare({ norms: [n], trades: [trade({ t: T0 + DAY, seller: me, buyer: BUYER, tokens: 40, paid: 3, n })], addr: me });
  const status = (a, b) => PR.recordFile(prep, ctxOf('claim', per(a, b))).rows.map((r) => r.status);
  assert.deepEqual(status(T0, T0 + 12 * HOUR), ['open'], 'not sold yet at the end');
  assert.deepEqual(status(T0 + 2 * DAY, T0 + 10 * DAY), ['sold']);
  const f = PR.recordFile(prep, ctxOf('claim', per(T0, T0 + 10 * DAY)));
  assert.deepEqual(['Net USD (± PnL × share held)', 'PnL booked in', 'Share still held at the verdict', 'Net in this period\'s realized PnL'].map((c) => col(f, c)(f.rows[0])), ['', 'secondary-market file (average cost)', '0', 'no']);
  const tr = PR.tradesFile(prep, ctxOf('claim', per(T0, T0 + 10 * DAY)));
  assert.deepEqual(tr.rows.map((r) => [r.kind, r.pnl]), [['sold', -7]]);
  assert.equal(col(tr, 'Prediction ID')(tr.rows[0]), 's', 'the trade links to the record');
  near(assert, figs(prep, 'claim', per(T0, T0 + 10 * DAY)).pnl, -7, 1e-9);
});

test('the secondary-market file itemises what the tile books: purchases, sales, matched sets and tokens held to the verdict, dated by the basis (0xba3b…)', () => {
  const prep = buyerBook(), money = eur();
  const f = PR.tradesFile(prep, ctxOf('claim', ALL, money));
  assert.deepEqual(f.rows.map((r) => [r.kind, r.pid, r.t]), [['bought', 'q1', T0 + HOUR], ['bought', 'q2', T0 + 2 * HOUR], ['bought', 'q3', T0 + 3 * HOUR], ['bought', 'q4', T0 + 4 * HOUR], ['held to verdict', 'q3', T0 + 30 * HOUR], ['held to verdict', 'q1', T0 + 4 * DAY]],
    'the worthless tokens when the winners claimed; the winning ones at this wallet\'s own burn; q4 not redeemed: not yet booked');
  const q1 = f.rows[5];
  assert.deepEqual(['Kind', 'Dated by', 'Side of the tokens', 'Tokens (1 USDe each if the side wins)', 'Price per token', 'Amount USD (paid or received; held to verdict: what the tokens pay)', 'Cost basis USD (average cost)', 'Realized PnL USD', 'Prediction ID', 'Pick configuration ID'].map((c) => col(f, c)(q1)),
    ['held to verdict', 'claim (when claimed, paid out)', 'bettor side', '20', '1', '20', '5', '15', 'q1', 'pc-q1']);
  // a purchase books nothing: its PnL cells are blank in USD and in the report currency, not 0 (B31)
  assert.deepEqual(['Realized PnL USD', 'Realized PnL EUR', 'USD→EUR rate', 'Rate date (ECB)', 'Cost basis USD (average cost)'].map((c) => col(f, c)(f.rows[0])), ['', '', '', '', '']);
  assert.notEqual(col(f, 'Realized PnL EUR')(q1), '', 'a booked row converts');
  const F = figs(prep, 'claim', ALL, money);
  near(assert, F.pnl, 13, 1e-9); near(assert, fromFiles(prep, 'claim', ALL, money).usd, F.pnl, 1e-6); near(assert, fromFiles(prep, 'claim', ALL, money).ccy, F.pnlC, 1e-6);
  // decided and claimable: every verdict at its decision, the unredeemed one too
  const g = PR.tradesFile(prep, ctxOf('claimable', ALL, money));
  assert.deepEqual(g.rows.filter((r) => r.kind === 'held to verdict').map((r) => [r.pid, r.t]), [['q1', T0 + DAY], ['q3', T0 + DAY], ['q4', T0 + 2 * DAY]]);
  assert.equal(g.name, 'predict-secondary-market-claimable.csv');
  for (const m of PR.MODES) { const G = figs(prep, m, ALL, money), x = fromFiles(prep, m, ALL, money); near(assert, x.usd, G.pnl, 1e-6, m); near(assert, x.ccy, G.pnlC, 1e-6, m); }
});

test('the record plus the secondary-market file add up to the Realized PnL tile, every basis, any period and zone, USD and the report currency', () => {
  // the mixed book of the identity test: both roles, sales before the verdict, buy-backs, held shares, unclaimed results
  // and voids
  const norms = [], trades = [];
  for (let i = 0; i < 120; i++) {
    const maker = i % 3 !== 0, t = T0 + i * 5 * HOUR;
    const verdict = i % 11 === 5 ? null : i % 13 === 0 ? 'NON_DECISIVE' : i % 2 ? 'PREDICTOR_WINS' : 'COUNTERPARTY_WINS';
    const n = mk({ id: 'm' + i, predictor: maker ? B(i % 7) : W, counterparty: maker ? W : X, stake: 5 + (i % 9), cp: 3 + (i % 5) * 2.5, t, verdict, decidedAt: t + 30 * HOUR, claimedAt: verdict && i % 4 ? t + 30 * HOUR + (i % 5) * 7 * HOUR : null, vt: verdict && i % 3 ? t + 29 * HOUR : null });
    norms.push(n);
    if (i % 6 === 1) trades.push(trade({ t: t + HOUR, seller: maker ? n.predictor : W, buyer: maker ? W : BUYER, tokens: n.pool * (i % 12 === 1 ? 1 : 0.4), paid: 2 + (i % 4), n }));
    if (i % 10 === 7) trades.push(trade({ t: t + 2 * HOUR, seller: B(5), buyer: W, tokens: 4, paid: 1.5, n, side: 'C' }));
  }
  const prep = PR.prepare({ norms, trades, addr: W });
  for (const period of [ALL, per(T0 + 5 * DAY, T0 + 12 * DAY), per(T0 + 9 * DAY + 7 * HOUR, T0 + 20 * DAY, 'Asia/Kolkata')]) {
    const money = eur(period.tz);
    for (const m of PR.MODES) {
      const F = figs(prep, m, period, money), x = fromFiles(prep, m, period, money);
      assert.ok(x.rows > 0);
      near(assert, x.usd, F.pnl, x.rows * 1e-6, `${m} USD`);
      near(assert, x.ccy, F.pnlC, x.rows * 1e-6, `${m} EUR`);
    }
  }
});

test('decided, not claimed: one row per result, own predictions and tokens held alike, titled by the basis (B28)', () => {
  const prep = buyerBook(), mb = makerPrep();
  const f = PR.unclaimedFile(prep, ctxOf('claim'));
  assert.equal(f.name, 'predict-decided-not-claimed.csv');
  assert.deepEqual(['Decided: settled on Meridian (UTC)', 'Decided time', 'Placed (UTC)', 'Picks', 'Source', 'Side', 'Tokens', 'Cost USD', 'Claimable USD', 'Result (this wallet\'s side)', 'PnL at the decision USD', 'In this period\'s realized PnL', 'ID (prediction, or pick configuration for tokens)'].map((c) => col(f, c)(f.rows[0])),
    ['2026-08-05 00:00:00 UTC', 'exact', '', 'Q', 'position tokens held (secondary market)', 'bettor side', '10', '3', '10', 'won', '7', 'no', 'pc-q4']);
  const g = PR.unclaimedFile(mb, ctxOf('claim'));
  assert.deepEqual(['Placed (UTC)', 'Picks', 'Source', 'Side', 'Tokens', 'Cost USD', 'Claimable USD', 'Result (this wallet\'s side)', 'PnL at the decision USD', 'ID (prediction, or pick configuration for tokens)'].map((c) => col(g, c)(g.rows[0])),
    ['2026-08-03 03:00:00 UTC', 'YES: Q p4', 'own prediction', 'market maker', '', '15', '20', 'won', '5', 'p4']);
  const c = PR.unclaimedFile(mb, ctxOf('claimable'));
  assert.equal(c.name, 'predict-booked-not-yet-claimed-claimable.csv'); assert.equal(c.title, 'Booked, not yet claimed');
  assert.equal(col(c, 'In this period\'s realized PnL')(c.rows[0]), 'yes');
  near(assert, figs(mb, 'claim').tail.pnl, 5, 1e-9);
  assert.equal(f.columns.some((x) => /year/i.test(x[0])), false, 'it states dates, not which year to use');
});

test('the daily ledger: local days, booked counts, the cumulative in the period ending at the tile, in USD and the report currency (B31)', () => {
  const prep = buyerBook(), money = eur('Asia/Tokyo'), period = per(T0, T0 + 10 * DAY, 'Asia/Tokyo');
  const F = figs(prep, 'claim', period, money);
  const d = PR.dailyFile(F, ctxOf('claim', period, money, 'Asia/Tokyo'));
  const head = d.columns.map((c) => c[0]);
  for (const c of ['Date (Asia/Tokyo)', 'Won (booked)', 'Lost (booked)', 'Void (booked)', 'Token positions held to the verdict (booked)', 'Cumulative PnL in period USD', 'Cumulative PnL in period EUR (each day at its own rate)', 'Winnings USD (payout − stake of won predictions)', 'Payouts of won predictions USD', 'Lost stakes USD']) assert.ok(head.includes(c), c);
  assert.deepEqual(cells(d, 'Date (Asia/Tokyo)'), ['2026-08-03', '2026-08-04', '2026-08-07'], 'the buys, the worthless tokens (06:00 UTC = 15:00 in Tokyo), the redemption');
  assert.deepEqual(cells(d, 'Token positions held to the verdict (booked)'), [0, 1, 1]);
  const last = d.rows[d.rows.length - 1];
  assert.equal(col(d, 'Cumulative PnL in period USD')(last), T.n6(F.pnl)); assert.equal(col(d, 'Cumulative PnL in period EUR (each day at its own rate)')(last), T.n6(F.pnlC));
  // the cumulative starts in the period: a period starting after the first booking does not carry it
  const later = per(T0 + 2 * DAY, T0 + 10 * DAY, 'UTC'), G = figs(prep, 'claim', later);
  assert.equal(col(PR.dailyFile(G, ctxOf('claim', later)), 'Cumulative PnL in period USD')(G.days[0]), '15');
});

test('what the realized total is made of, the secondary market tile and open stakes for a wallet that only buys tokens (B26)', () => {
  const prep = buyerBook();
  const parts = (m, p = ALL) => PR.madeOf(PR.book(prep, m), prep, m, p);
  assert.deepEqual(parts('claim'), ['bought position tokens redeemed'], 'not "claimed predictions": it made none');
  assert.deepEqual(parts('claimable'), ['bought position tokens decided']);
  assert.equal(PR.madeOfText(parts('claim', per(T0 + 20 * DAY, T0 + 30 * DAY)), 'claim'), 'claimed (paid out) predictions', 'nothing booked: the basis\'s own words');
  const S = PR.secondary(PR.book(prep, 'claim'), ALL, USD);
  assert.deepEqual([S.sales, S.sets, S.buys], [0, 0, 4]); near(assert, S.paid, 14, 1e-9); near(assert, S.pnl, 0, 1e-12);
  near(assert, PR.openStakes(prep), 4, 1e-9, 'the open bought tokens at cost');
  // the maker's book: its own predictions, a matched set; then a bettor that sold
  const mb = makerPrep();
  assert.deepEqual(PR.madeOf(PR.book(mb, 'claim'), mb, 'claim', ALL), ['claimed (paid out) predictions', 'matched sets (both sides held)']);
  assert.equal(PR.madeOfText(['a', 'b', 'c'], 'claim'), 'a, b and c');
  const S2 = PR.secondary(PR.book(mb, 'claim'), ALL, USD);
  assert.deepEqual([S2.sales, S2.sets, S2.buys], [0, 1, 1]); near(assert, S2.pnl, 24, 1e-9); near(assert, S2.pnl, figs(mb, 'claim').secondary, 1e-9);
});

test('the words: decided (settled on Meridian), claimed (paid out), never a bare "settled"; a note per basis, bought tokens included (B25)', () => {
  const bare = /\bsettled\b(?! on Meridian)/i;
  for (const m of PR.MODES) {
    for (const s of [PR.MODE_LABEL[m], PR.MODE_TEXT[m], PR.MODE_FILE[m], PR.countsLabel(m), PR.pnlLabel(m), PR.footnote(m), PR.madeOfText([], m)]) assert.equal(bare.test(s), false, s);
    assert.match(PR.footnote(m), /Position tokens bought on the secondary market/);
  }
  assert.equal(PR.countsLabel('claim'), 'claimed in period'); assert.equal(PR.countsLabel('verdict'), 'booked in period');
  assert.match(PR.footnote('claim'), /moves none of this wallet's money/);
  assert.match(PR.footnote('claimable'), /when decided \(settled on Meridian\)/);
  assert.doesNotMatch(PR.footnote('claim') + PR.footnote('verdict'), /\b(must|should|taxable|you owe)\b/i, 'factual: no basis is named as the one that applies');
});

test('the date basis in the link: claim by default, the others by name', () => {
  assert.deepEqual(PR.MODES, ['claim', 'claimable', 'verdict']);
  assert.equal(PR.modeOf(undefined), 'claim'); assert.equal(PR.modeOf('verdict'), 'verdict'); assert.equal(PR.modeOf('nonsense'), 'claim');
  for (const m of PR.MODES) assert.ok(PR.MODE_LABEL[m] && PR.MODE_TEXT[m]);
});

// ---------- batch 1 of the review fixes: the tail by booking date, the traded record's status, the claim-basis words ----------
test('the tail at a period boundary: resolved at the source just before it, decided on Meridian just after; a booked basis lists what it books', () => {
  // a win resolved at the source 30 Sep 23:50 UTC and decided on Meridian 1 Oct 00:30, not claimed; and position
  // tokens bought on another pick configuration with the same two times, not redeemed
  const me = B(10), vt = Date.parse('2026-09-30T23:50:00Z'), dec = Date.parse('2026-10-01T00:30:00Z');
  const n = mk({ id: 'bd', predictor: me, counterparty: W, stake: 10, cp: 15, t: Date.UTC(2026, 8, 20), verdict: 'PREDICTOR_WINS', decidedAt: dec, vt });
  const o = mk({ id: 'bo', predictor: B(11), counterparty: X, stake: 5, cp: 5, t: Date.UTC(2026, 8, 20), verdict: 'PREDICTOR_WINS', decidedAt: dec, vt });
  const buy = Object.assign(trade({ t: Date.UTC(2026, 8, 21), seller: B(11), buyer: me, tokens: 10, paid: 6, n: o }), { vt });
  const prep = PR.prepare({ norms: [n, o], trades: [buy], addr: me });
  const Q3 = per(Date.UTC(2026, 6, 1), Date.UTC(2026, 9, 1)), Q4 = per(Date.UTC(2026, 9, 1), Date.UTC(2027, 0, 1));
  const tail = (m, q) => PR.tail(prep, m, q).items.map((x) => [x.kind, x.t, x.booked]);
  // verdict: booked in Q3 (the source time), listed at its decision; Q4 lists neither
  assert.deepEqual(tail('verdict', Q3), [['won', dec, vt], ['held-verdict', dec, vt]]);
  assert.deepEqual(tail('verdict', Q4), [], 'decided on Meridian in Q4, but booked in Q3 under the verdict basis');
  near(assert, figs(prep, 'verdict', Q3).pnl, 15 + 4, 1e-9, 'Q3\'s total has both'); near(assert, figs(prep, 'verdict', Q3).tail.pnl, 19, 1e-9, 'and its list says the same');
  assert.equal(figs(prep, 'verdict', Q4).pnl, 0);
  // in the report currency the list converts at the booking, as the total does: the source time, not the decision
  const fq = figs(prep, 'verdict', Q3, CCY);
  near(assert, fq.tail.pnlC, CCY.fx(19, vt), 1e-9); near(assert, fq.tail.pnlC, fq.pnlC, 1e-9, 'the list and the total agree');
  assert.notEqual(CCY.fx(19, vt), CCY.fx(19, dec), 'the two dates take different rates here');
  // claimable: both in Q4; claim: decided in Q4, outside its total
  assert.deepEqual(tail('claimable', Q4), [['won', dec, dec], ['held-verdict', dec, dec]]); assert.deepEqual(tail('claimable', Q3), []);
  assert.deepEqual(tail('claim', Q4).map((x) => x[0]), ['won', 'held-verdict']); assert.deepEqual(tail('claim', Q3), []);
  // the file under the verdict basis gives the booking beside the decision
  const f = PR.unclaimedFile(prep, ctxOf('verdict', Q3));
  assert.deepEqual(['Decided: settled on Meridian (UTC)', 'Booked (UTC)', 'In this period\'s realized PnL'].map((c) => col(f, c)(f.rows[0])), ['2026-10-01 00:30:00 UTC', '2026-09-30 23:50:00 UTC', 'yes']);
  assert.equal(PR.unclaimedFile(prep, ctxOf('claim', Q4)).columns.some((c) => c[0] === 'Booked (UTC)'), false, 'the claim basis books none of them: no booked column');
});

test('a traded prediction\'s status follows its tokens, as its Booked date does (0xc1ce…: never "decided, not claimed" while booked)', () => {
  // the wallet bets 10 against 30 (40 tokens), sells 10 of them, wins; it never claims; another wallet's claim on the
  // pick configuration is at day 4 (the trades' sa)
  const me = B(12), dec = T0 + 3 * DAY, end = T0 + 10 * DAY, P10 = per(T0, end);
  const n = mk({ id: 'tr', predictor: me, counterparty: W, stake: 10, cp: 30, t: T0, verdict: 'PREDICTOR_WINS', decidedAt: dec });
  const sale = Object.assign(trade({ t: T0 + DAY, seller: me, buyer: BUYER, tokens: 10, paid: 4, n }), { sa: T0 + 4 * DAY });
  const rec = (rd, nn = n) => { const prep = PR.prepare({ norms: [nn], trades: [sale], rd, addr: me }); const f = PR.recordFile(prep, ctxOf('claim', P10)); return { prep, row: f.rows[0], f }; };
  // no redemption times: booked at the other wallet's claim, and the status says the redemption is not confirmed
  const a = rec(undefined);
  assert.equal(a.row.booked, T0 + 4 * DAY); assert.equal(a.row.status, 'decided, redemption not confirmed');
  assert.equal(PR.redeemedBy(a.prep, a.prep.L.events.find((e) => e.kind === 'verdict')), 'any');
  // read to the head, no burn: not redeemed, not booked
  const b = rec({});
  assert.equal(b.row.booked, null); assert.equal(b.row.status, 'decided, tokens not redeemed');
  // its own burn on day 5
  const c = rec({ ['pc-tr|P']: T0 + 5 * DAY });
  assert.equal(c.row.booked, T0 + 5 * DAY); assert.equal(c.row.status, 'tokens redeemed');
  assert.equal(PR.recordFile(c.prep, ctxOf('claim', per(T0, T0 + 5 * DAY - 1))).rows[0].status, 'decided, tokens not redeemed', 'before the burn');
  // its own claim on day 6, without redemption times: that claim redeemed the balance
  const own = mk({ id: 'tr', predictor: me, counterparty: W, stake: 10, cp: 30, t: T0, verdict: 'PREDICTOR_WINS', decidedAt: dec, claimedAt: T0 + 6 * DAY });
  const d = rec(undefined, own);
  assert.equal(d.row.booked, T0 + 6 * DAY); assert.equal(d.row.status, 'tokens redeemed');
  // a traded loss: worthless tokens, claimed by the winners
  const lost = mk({ id: 'tl', predictor: me, counterparty: W, stake: 10, cp: 30, t: T0, verdict: 'COUNTERPARTY_WINS', decidedAt: dec, claimedAt: T0 + 5 * DAY });
  const sl = trade({ t: T0 + DAY, seller: me, buyer: BUYER, tokens: 10, paid: 2, n: lost });
  const e = PR.recordFile(PR.prepare({ norms: [lost], trades: [sl], addr: me }), ctxOf('claim', P10)).rows[0];
  assert.deepEqual([e.status, e.booked], ['claimed', T0 + 5 * DAY]);
  // under every basis the status is the claim's, the Booked date the basis's
  assert.equal(PR.recordFile(a.prep, ctxOf('claimable', P10)).rows[0].status, 'decided, redemption not confirmed');
});

test('without redemption times the claim basis says held tokens are dated by any wallet\'s latest claim; with them it does not', () => {
  const me = B(12);
  const n = mk({ id: 'tr', predictor: me, counterparty: W, stake: 10, cp: 30, t: T0, verdict: 'PREDICTOR_WINS', decidedAt: T0 + 3 * DAY });
  const sale = trade({ t: T0 + DAY, seller: me, buyer: BUYER, tokens: 10, paid: 4, n });
  const without = PR.prepare({ norms: [n], trades: [sale], addr: me }), withRd = PR.prepare({ norms: [n], trades: [sale], rd: {}, addr: me });
  const any = /latest claim on that pick configuration by any wallet \(the snapshot has no redemption times for this wallet yet\)/;
  assert.match(PR.modeText('claim', without), any); assert.match(PR.footnote('claim', without), any); assert.match(PR.heldClaimText(without), any);
  assert.doesNotMatch(PR.modeText('claim', withRd), any); assert.doesNotMatch(PR.footnote('claim', withRd), any);
  assert.match(PR.heldClaimText(withRd), /own redemption \(its burn of the tokens/);
  assert.equal(PR.modeText('claimable', without), PR.MODE_TEXT.claimable, 'the other bases do not depend on it');
  assert.equal(PR.footnote('claim'), PR.footnote('claim', withRd), 'no record: the words as before');
  assert.equal(PR.heldClaimText(null), null);
  const bare = /\bsettled\b(?! on Meridian)/i;
  for (const s of [PR.modeText('claim', without), PR.footnote('claim', without)]) { assert.equal(bare.test(s), false); assert.doesNotMatch(s, /\b(must|should|taxable|you owe)\b/i); }
});

test('a wallet holding no tokens to a paying verdict is not told how held tokens are dated', () => {
  // never traded: its own wins, losses and voids only
  const { norms } = makerBook(), plain = PR.prepare({ norms: norms.filter((n) => n.id !== 'p3'), trades: [], addr: W });
  assert.equal(plain.L.events.some((e) => e.kind === 'verdict'), false);
  assert.equal(PR.modeText('claim', plain), PR.MODE_TEXT.claim);
  assert.equal(PR.heldClaimText(plain), null);
  assert.doesNotMatch(PR.footnote('claim', plain), /latest claim on that pick configuration by any wallet/);
  // it held tokens only to a losing verdict: worthless, nothing of its own to date
  const me = B(14), n = mk({ id: 'lv', predictor: me, counterparty: W, stake: 10, cp: 30, t: T0, verdict: 'COUNTERPARTY_WINS', decidedAt: T0 + 3 * DAY });
  const lost = PR.prepare({ norms: [n], trades: [trade({ t: T0 + DAY, seller: me, buyer: BUYER, tokens: 10, paid: 4, n })], addr: me });
  assert.ok(lost.L.events.some((e) => e.kind === 'verdict'), 'a verdict on the 30 tokens kept');
  assert.equal(PR.heldClaimText(lost), null);
});

test('a remainder below the files\' precision held to the verdict is no result: not listed, not held, the prediction sold', () => {
  // 40 tokens, 39.99996 sold: 0.00004 left to a winning verdict nobody claims
  const me = B(15), dec = T0 + 3 * DAY;
  const n = mk({ id: 'du', predictor: me, counterparty: W, stake: 10, cp: 30, t: T0, verdict: 'PREDICTOR_WINS', decidedAt: dec });
  const prep = PR.prepare({ norms: [n], trades: [trade({ t: T0 + DAY, seller: me, buyer: BUYER, tokens: 39.99996, paid: 16, n })], addr: me });
  const v = prep.L.events.find((e) => e.kind === 'verdict');
  assert.ok(v && v.cash > 0 && v.cash < 1e-3, 'the ledger has the dust verdict');
  for (const m of PR.MODES) assert.deepEqual(PR.tail(prep, m, ALL).items, [], m + ': nothing listed as not claimed');
  const h = PR.holdingsAt(prep, dec + DAY).unclaimed;
  assert.deepEqual([h.held, h.heldLost, h.heldValue], [0, 0, 0]);
  assert.equal(PR.tokenStatus(prep, v, ALL.end), 'decided, not claimed', 'pays nothing redeemable: not "tokens not redeemed"');
  const row = PR.recordFile(prep, ctxOf('claim')).rows[0];
  assert.equal(row.status, 'sold');
  assert.equal(figs(prep, 'claimable').held, 0, 'not counted as a position held to the verdict');
  assert.equal(PR.heldClaimText(prep), null, 'nothing that pays is held');
  // the sale's gain is the result: 16 for 39.99996 of 40 tokens that cost 10
  near(assert, figs(prep, 'claim').pnl, 16 - 10 * 39.99996 / 40, 1e-3);
});
