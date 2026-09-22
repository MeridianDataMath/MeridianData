// Perps analytics: the archive's cumulative fields, interval stats (drawdown net of flows), book slippage, copyability caps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, near } from './_load.mjs';

const MD = load(['js/util.js', 'js/api.js', 'js/analytics.js']);
const AN = MD.analytics, U = MD.util;
const D = U.DAY, T0 = Date.UTC(2026, 8, 1);

test('the archive\'s flow fields are running totals per token: buckets are their differences', () => {
  // day 1: deposit 1,000, realized +50, fee −2 paid; day 2: realized −20 more, withdrawal 100 plus a 1 fee
  const bal = [
    { time: T0, tokenId: 'usd', balance: 1048, realizedPnl: 50, tradingFee: -2, realizedFunding: 0, deposit: 1000, withdrawal: 0, withdrawalFee: 0, depositFee: 0 },
    { time: T0 + D, tokenId: 'usd', balance: 927, realizedPnl: 30, tradingFee: -2, realizedFunding: 0, deposit: 1000, withdrawal: -100, withdrawalFee: -1, depositFee: 0 },
  ];
  const s = AN.buildSeries({ balance: bal, upnl: [{ time: T0, unrealizedPnl: 5 }, { time: T0 + D, unrealizedPnl: 0 }], volume: [] });
  near(assert, s[0].pnl, 48, 1e-9, 'day 1: realized − fee'); near(assert, s[0].deposit, 1000, 1e-9);
  near(assert, s[1].pnl, -20, 1e-9, 'day 2'); near(assert, s[1].withdrawal, 101, 1e-9, 'withdrawal includes its fee'); near(assert, s[1].wfee, 1, 1e-9);
  near(assert, s[0].equity, 1053, 1e-9, 'equity = balance + unrealized');
});

test('drawdown and PnL ignore deposits and withdrawals', () => {
  const row = (t, pnl, dep, wd, bal) => ({ t, pnl, deposit: dep, withdrawal: wd, balance: bal, upnl: 0, equity: bal, fee: 0, funding: 0, volume: 0 });
  // start 1,000; lose 100; deposit 500 (not a gain); lose 50; withdraw 400 (not a loss)
  const series = [row(T0, 0, 0, 0, 1000), row(T0 + D, -100, 0, 0, 900), row(T0 + 2 * D, 0, 500, 0, 1400), row(T0 + 3 * D, -50, 0, 0, 1350), row(T0 + 4 * D, 0, 0, 400, 950)];
  const st = AN.intervalStats(series, T0 + D, null, D);
  near(assert, st.pnl, -150, 1e-9, 'PnL = trading only');
  near(assert, st.ddUsd, 150, 1e-9, 'drawdown in USD = trading losses since the peak');
  near(assert, st.deposits, 500, 1e-9); near(assert, st.withdrawals, 400, 1e-9);
  near(assert, st.roi, (-150 / (1000 + 500)) * 100, 1e-9, 'ROI on starting equity + deposits');
});

test('book slippage walks the book from the mid; an order the book cannot absorb has no price', () => {
  const book = { asks: [[101, 10], [102, 10]], bids: [[99, 10], [98, 10]] };   // mid 100
  const buy = AN.bookSlippage(book, true, 1010 + 510);   // 10 @ 101, then 5 @ 102
  near(assert, buy.bps, ((1520 / 15 - 100) / 100) * 1e4, 1e-6, 'average price vs mid');
  const huge = AN.bookSlippage(book, true, 1e6);
  assert.equal(huge.bps, null); near(assert, huge.filled, 2030 / 1e6, 1e-9, 'share it could fill');
});

// a profile that is copyable on every count; each test breaks one thing and expects its cap
const good = () => ({ stats: { all: { pnl: 5000, roi: 25, ddPct: 8 } }, copy: { closed: 60, hold: { scalp: 2, intra: 10, swing: 40, long: 8 }, holdMed: 2 * D, tStat: 5, netTrimBps: 60, weeksActive: 12, weeksPos: 10, liq: 0, top: 12, edgeLeft: 85, slipBps: 2, copySize: 2000, notMed: 3000, slipOwnBps: 3, depthOk: 100, notP90: 6000, lastAt: Date.now() - D, perWeek: 5, tenureD: 120 } });
const with_ = (patch, stats) => { const r = good(); Object.assign(r.copy, patch); if (stats) Object.assign(r.stats.all, stats); return r; };

test('copyability: a steady, copyable account scores as Copyable', () => {
  const sc = AN.copyScore(good()); assert.equal(sc.verdict, 'Copyable'); assert.ok(sc.total >= 70, 'score ' + sc.total);
});

test('copyability caps: one disqualifier is never averaged away', () => {
  const cases = [
    [with_({}, { pnl: -10 }), 45, 'not profitable'],
    [with_({ edgeLeft: -20 }), 40, 'nothing survives copying'],
    [with_({ edgeLeft: 30 }), 30 + 0.7 * 30, 'graded by edge left'],
    [with_({ closed: 8 }), 55, 'fewer than 10 closed'],
    [with_({ closed: 15 }), 65, 'fewer than 20 closed'],
    [with_({ tStat: 1.2 }), 60, 'not clear of the noise'],
    [with_({ lastAt: Date.now() - 45 * D }), 60, 'quiet for 30+ days'],
    [with_({ lastAt: Date.now() - 90 * D }), 45, 'quiet for 60+ days'],
    [with_({ liq: 8 }), 55, 'a tenth liquidated'],
    [with_({ top: 70 }), 60, 'one jackpot'],
    [with_({}, { ddPct: 55 }), 60, 'deep drawdown'],
    [with_({ depthOk: 30 }), 60, 'sizes beyond the books'],
  ];
  for (const [row, cap, why] of cases) { const sc = AN.copyScore(row); assert.ok(sc.total <= Math.round(cap), `${why}: ${sc.total} > ${cap}`); }
  assert.equal(AN.copyScore(with_({}, { pnl: -10 })).verdict, 'Losing so far');
  assert.equal(AN.copyScore(with_({ closed: 4 })), null, 'fewer than 5 closed: no score');
});
