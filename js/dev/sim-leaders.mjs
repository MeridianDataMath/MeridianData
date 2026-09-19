#!/usr/bin/env node
/**
 * Development only: twenty synthetic traders with very different styles, run through the real copy-profile and
 * copyability pipeline (AN.buildCopyProfile → AN.fillDrift → AN.copyScore) so the score can be judged against what a
 * copier would actually want, instead of against whoever happens to be on the exchange this week.
 *
 *   node js/dev/sim-leaders.mjs            # table of all twenty, best first, with the expectation for each
 *   node js/dev/sim-leaders.mjs --json     # the rows as JSON (for the page: MDSim-style injection)
 *
 * Every account gets positions, fills, a daily ledger and "candles" consistent with its style; order books are today's
 * real ones, so slippage at each size is real.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
for (const f of ['js/util.js', 'js/api.js', 'js/analytics.js']) vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
const { MD } = globalThis; const A = MD.api, AN = MD.analytics, U = MD.util;
const DAY = 86400000, HOUR = 3600000, MIN = 60000;
const now = Date.now();

// ---- styles: what kind of trader, and what a copier should conclude
// edge: mean gross result per position in bps of entry notional (before fees); sd: its spread; hold: median holding time;
// drift1/drift5: price move in the leader's direction 1 / 5 minutes after each fill, bps (positive = a later copier pays it);
// fund: funding received per day held, bps of notional; liq: share of positions ending in liquidation; maker: share of
// maker fills; size: median entry notional; last: days since the last trade; tenure: days on the exchange
const STYLES = [
  { id: 'ideal-copy-target', expect: 'Copyable', n: 90, hold: 1.5 * DAY, edge: 45, sd: 50, size: 3000, markets: ['BTC-USD', 'ETH-USD'], drift1: 0.5, drift5: 1, tenure: 180, last: 0.3 },
  { id: 'swing-consistent', expect: 'Copyable', n: 45, hold: 3 * DAY, edge: 35, sd: 60, size: 6000, markets: ['BTC-USD', 'ETH-USD', 'SOL-USD'], drift1: 1, drift5: 1.5, tenure: 150, last: 1 },
  { id: 'steady-intraday', expect: 'Copyable', n: 120, hold: 6 * HOUR, edge: 25, sd: 40, size: 2500, markets: ['BTC-USD', 'ETH-USD'], drift1: 1.5, drift5: 2, tenure: 100, last: 0.5 },
  { id: 'contrarian-swing', expect: 'Copyable (edge grows after their fills)', n: 40, hold: 2 * DAY, edge: 25, sd: 45, size: 3000, markets: ['BTC-USD', 'ETH-USD'], drift1: -3, drift5: -4, tenure: 120, last: 2 },
  { id: 'long-term-position', expect: 'Copy with care (few positions)', n: 8, hold: 30 * DAY, edge: 400, sd: 500, size: 20000, markets: ['BTC-USD'], drift1: 0.5, drift5: 1, tenure: 300, last: 5 },
  { id: 'funding-harvester', expect: 'Copy with care (edge is funding)', n: 15, hold: 20 * DAY, edge: -5, sd: 30, size: 8000, markets: ['BTC-USD', 'ETH-USD'], drift1: 0.5, drift5: 0.5, fund: 4, tenure: 200, last: 3 },
  { id: 'whale-swing', expect: 'Copy with care (size vs depth)', n: 40, hold: 2 * DAY, edge: 40, sd: 60, size: 250000, markets: ['BTC-USD', 'ETH-USD'], drift1: 1, drift5: 2, tenure: 120, last: 1 },
  { id: 'illiquid-specialist', expect: 'Copy with care (thin books)', n: 50, hold: DAY, edge: 30, sd: 50, size: 15000, markets: ['HYPE-USD', 'XAG-USD'], drift1: 2, drift5: 3, tenure: 90, last: 1 },
  { id: 'inactive-star', expect: 'Copy with care (gone quiet)', n: 45, hold: 3 * DAY, edge: 35, sd: 60, size: 6000, markets: ['BTC-USD', 'ETH-USD'], drift1: 1, drift5: 1.5, tenure: 200, last: 45 },
  { id: 'dd-recovery', expect: 'Copy with care (deep drawdown)', n: 60, hold: 2 * DAY, edge: 60, sd: 900, size: 3000, markets: ['ETH-USD', 'SOL-USD'], drift1: 1, drift5: 1.5, tenure: 120, last: 1, streak: 'lossesFirst' },
  { id: 'degen-liquidated', expect: 'Copy with care at best (liquidations)', n: 50, hold: DAY, edge: 250, sd: 120, size: 3000, markets: ['BTC-USD', 'SOL-USD'], drift1: 2, drift5: 3, liq: 0.2, tenure: 60, last: 0.5 },
  { id: 'momentum-chaser', expect: 'Hard to copy (edge gone in a minute)', n: 80, hold: 4 * HOUR, edge: 16, sd: 30, size: 3000, markets: ['BTC-USD', 'SOL-USD'], drift1: 6, drift5: 8, tenure: 70, last: 0.5 },
  { id: 'scalper-bot-edge', expect: 'Hard to copy (profitable, uncopyable)', n: 600, hold: 40 * 1000, edge: 7, sd: 12, size: 3000, markets: ['BTC-USD', 'ETH-USD'], drift1: 5, drift5: 5, tenure: 40, last: 0.1 },
  { id: 'market-maker', expect: 'Hard to copy (maker edge, taker copier)', n: 1500, hold: 5 * MIN, edge: 1.5, sd: 6, size: 2000, markets: ['BTC-USD', 'ETH-USD', 'SOL-USD'], drift1: 1, drift5: 1, maker: 1, tenure: 90, last: 0.1 },
  { id: 'grid-bot', expect: 'Hard to copy (fees eat it)', n: 2000, hold: 20 * MIN, edge: 2, sd: 5, size: 500, markets: ['ETH-USD'], drift1: 0.5, drift5: 0.5, maker: 0.9, tenure: 60, last: 0.1 },
  { id: 'one-hit-wonder', expect: 'Hard to copy / with care (one big win)', n: 30, hold: DAY, edge: -20, sd: 30, size: 2500, markets: ['SOL-USD', 'HYPE-USD'], drift1: 1, drift5: 1, tenure: 90, last: 4, jackpot: 8000 },
  { id: 'random-gambler', expect: 'Hard to copy / losing', n: 100, hold: DAY, edge: 0, sd: 200, size: 5000, markets: ['BTC-USD', 'ETH-USD', 'HYPE-USD'], drift1: 0, drift5: 0, tenure: 80, last: 1 },
  { id: 'consistent-loser', expect: 'Losing so far', n: 80, hold: DAY, edge: -40, sd: 50, size: 3000, markets: ['ETH-USD'], drift1: 1, drift5: 1, tenure: 100, last: 0.5 },
  { id: 'scalper-bot-losing', expect: 'Losing so far (the button masher)', n: 300, hold: 15 * 1000, edge: -4, sd: 10, size: 800, markets: ['BTC-USD', 'ETH-USD', 'SPY-USD'], drift1: 0, drift5: 0, tenure: 5, last: 0.1 },
  { id: 'newbie', expect: 'no score (3 positions)', n: 3, hold: 2 * HOUR, edge: 50, sd: 50, size: 1000, markets: ['BTC-USD'], drift1: 1, drift5: 1, tenure: 2, last: 0.2 },
];

const rng = (seed) => { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; };
const gauss = (r) => { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

function simulate(st, ref, seed) {
  const r = rng(seed);
  const products = st.markets.map((t) => Object.values(ref.byId).find((p) => p.displayTicker === t)).filter(Boolean);
  const start = now - st.tenure * DAY, end = now - st.last * DAY;
  // per-position gross results, optionally shaped (a jackpot, or losses first for a drawdown)
  let results = Array.from({ length: st.n }, () => st.edge + gauss(r) * st.sd);
  if (st.jackpot) results[Math.floor(st.n / 2)] = st.jackpot;
  if (st.streak === 'lossesFirst') results.sort((a, b) => a - b);
  const positions = [], fills = [], candle = new Map();
  const opens = Array.from({ length: st.n }, () => start + r() * Math.max(DAY, end - start)).sort((a, b) => a - b);
  for (let i = 0; i < st.n; i++) {
    const p = products[Math.floor(r() * products.length)];
    const hold = st.hold * Math.exp(gauss(r) * 0.8);
    const open = opens[i] + i * 7; const close = Math.min(open + hold, end - (st.n - i) * 977);
    const px = { 'BTC-USD': 80000, 'ETH-USD': 2600, 'SOL-USD': 110, 'HYPE-USD': 90, 'XAU-USD': 4300, 'XAG-USD': 66, 'SPY-USD': 760, 'QQQ-USD': 716 }[p.displayTicker] || 100;
    const notional = st.size * Math.exp(gauss(r) * 0.5); const qty = notional / px;
    const long = r() < 0.55; const sign = long ? 1 : -1;
    const liq = r() < (st.liq || 0);
    const grossBps = liq ? -900 - r() * 300 : results[i];
    const entry = px * (0.9 + r() * 0.2); const exit = entry * (1 + (sign * grossBps) / 1e4);
    const gross = qty * (exit - entry) * sign;
    const takerFee = U.num(p.takerFee) || 0.0003; const makerFee = U.num(p.makerFee) || 0;
    const maker = r() < (st.maker || 0);
    const feeRate = maker ? makerFee : takerFee;
    const fees = notional * feeRate * 2;
    const fundingReceived = (st.fund || 0) / 1e4 * notional * ((close - open) / DAY);
    positions.push({ id: st.id + '-' + i, productId: p.id, side: long ? '0' : '1', size: '0', totalIncreaseQuantity: String(qty), totalDecreaseQuantity: String(qty), totalIncreaseNotional: String(notional), totalDecreaseNotional: String(qty * exit), feesAccruedUsd: String(fees), positionFeeAccruedUsd: '0', fundingAccruedUsd: String(-fundingReceived), realizedPnl: String(gross), createdAt: Math.round(open), updatedAt: Math.round(close), isLiquidated: liq, wasDeleveraged: false, gross, fees, fundingReceived });
    // two fills per position, and the "candles" a minute and five minutes after each, moving in the leader's direction
    for (const [t, price, side] of [[open, entry, long ? 0 : 1], [close, exit, long ? 1 : 0]]) {
      fills.push({ id: st.id + '-f' + fills.length, createdAt: Math.round(t), productId: p.id, side, filled: String(qty), price: String(price), feeUsd: String(notional * feeRate), isMaker: maker, reduceOnly: t === close });
      const s = side === 0 ? 1 : -1;
      candle.set(Math.round(t) + MIN, price * (1 + (s * (st.drift1 + gauss(r) * 2)) / 1e4));
      candle.set(Math.round(t) + 5 * MIN, price * (1 + (s * (st.drift5 + gauss(r) * 4)) / 1e4));
    }
  }
  // daily ledger: a deposit sized to the style, then each position's net result on its close day
  const deposit = Math.max(2000, st.size * 4);
  const daily = []; let balance = deposit;
  const byDay = {}; for (const p of positions) { const k = Math.floor(p.updatedAt / DAY) * DAY; (byDay[k] || (byDay[k] = [])).push(p); }
  for (let d = Math.floor(start / DAY) * DAY; d <= now; d += DAY) {
    const ps = byDay[d] || []; const pnl = U.sum(ps, (p) => p.gross - p.fees + p.fundingReceived); balance += pnl;
    daily.push({ t: d, balance, upnl: 0, equity: balance, realizedPnl: U.sum(ps, (p) => p.gross), fee: U.sum(ps, (p) => p.fees), funding: U.sum(ps, (p) => p.fundingReceived), pnl, deposit: d === Math.floor(start / DAY) * DAY ? deposit : 0, withdrawal: 0, volume: U.sum(ps, (p) => U.num(p.totalIncreaseNotional) * 2) });
  }
  const equity = balance;
  const candles = { at: async (ticker, t) => (candle.has(t) ? candle.get(t) : null) };
  return { positions, fills, daily, equity, candles, createdAt: start };
}

const ctx = { signal: new AbortController().signal };
const ref = await A.ref(ctx);
const copyCtx = await AN.copyContext(ref, ctx);
const rows = [];
let seed = process.argv.includes('--seed') ? Number(process.argv[process.argv.indexOf('--seed') + 1]) : 1;
for (const st of STYLES) {
  const sim = simulate(st, ref, seed++);
  const ps = AN.positionStats(sim.positions, ref);
  const decays = await AN.fillDrift(sim.fills, ref, sim.candles, 400);
  const copy = AN.buildCopyProfile({ positions: sim.positions, daily: sim.daily, equity: sim.equity, createdAt: sim.createdAt, ref, depth: copyCtx.depth, decays });
  const all = AN.intervalStats(sim.daily, sim.createdAt, { upnl: 0, equity: sim.equity }, DAY);
  const row = { sid: 'sim-' + st.id, account: '0x' + st.id.replace(/[^a-z0-9]/g, '').padEnd(40, '0').slice(0, 40), name: st.id, createdAt: sim.createdAt, equity: sim.equity, openCount: 0, volumeAll: all.volume, positionsCount: sim.positions.length, closedCount: ps.closed.length, liquidated: ps.liquidated, winRate: ps.winRate, style: ps.style, inactive: false,
    stats: { all: { pnl: all.pnl, volume: all.volume, roi: all.roi, sharpe: all.sharpe, ddPct: all.ddPct, fees: all.fees, funding: all.funding } }, copy, expect: st.expect };
  row.stats['30d'] = row.stats['7d'] = row.stats['24h'] = row.stats.all;
  row.score = AN.copyScore(row);
  rows.push(row);
}
if (process.argv.includes('--json')) { console.log(JSON.stringify({ builtAt: now, rows, remote: true, sim: true })); process.exit(0); }
rows.sort((a, b) => ((b.score ? b.score.total : -1) - (a.score ? a.score.total : -1)));
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const pad = (s, n, right) => { s = String(s); return right ? s.padStart(n) : s.padEnd(n); };
console.log(pad('style', 22) + pad('score', 6, 1) + pad('verdict', 18) + pad('T', 4, 1) + pad('F', 4, 1) + pad('A', 4, 1) + pad('edge', 7, 1) + pad('pnl', 9, 1) + pad('roi', 6, 1) + pad('dd', 6, 1) + pad('hold', 7, 1) + pad('slip', 6, 1) + pad('drift', 6, 1) + '  expected');
for (const r of rows) {
  if (only && r.name !== only) continue;
  const c = r.copy, s = r.score, st = r.stats.all;
  console.log(pad(r.name, 22) + pad(s ? s.total : '—', 6, 1) + '  ' + pad(s ? s.verdict : 'no score', 16) + pad(s ? s.track : '', 4, 1) + pad(s ? s.friction : '', 4, 1) + pad(s ? s.activity : '', 4, 1) + pad(c.edgeLeft == null ? '—' : c.edgeLeft + '%', 7, 1) + pad(Math.round(st.pnl), 9, 1) + pad(st.roi == null ? '—' : st.roi.toFixed(0) + '%', 6, 1) + pad(st.ddPct == null ? '—' : st.ddPct.toFixed(0) + '%', 6, 1) + pad(U.fmtDuration(c.holdMed || 0), 7, 1) + pad(c.slipBps == null ? '—' : c.slipBps, 6, 1) + pad(c.drift1 == null ? '—' : c.drift1, 6, 1) + '  ' + r.expect);
}
