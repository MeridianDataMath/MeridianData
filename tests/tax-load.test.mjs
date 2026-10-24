// Tax center loading (T.load): a read that failed is not kept for the tab as if the range were complete.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_load.mjs';

const MD = load(['js/util.js', 'js/api.js', 'js/predict/api.js', 'js/predict/analytics.js', 'js/tax/core.js', 'js/tax/tz.js', 'js/tax/periods.js', 'js/tax/fx.js', 'js/tax/ledger.js', 'js/tax/load.js', 'js/tax/fills.js', 'js/tax/funding.js', 'js/tax/exports.js']);
const A = MD.api, T = MD.tax;
const calls = { charges: 0, history: 0 };
let failCharges = true, failHour = true;
A.positions = async () => [{ id: 'p1', productId: 'btc', side: 0, size: '0', createdAt: Date.UTC(2026, 6, 1, 10), updatedAt: Date.UTC(2026, 6, 2, 10), totalIncreaseQuantity: '1', totalDecreaseQuantity: '1', totalIncreaseNotional: '100', realizedPnl: '10' }];
A.page = async (base, path) => { const rows = path === '/v1/order/fill' ? [
  { id: 'f1', productId: 'btc', side: 0, filled: '1', price: '100', feeUsd: '0.1', type: 'LIMIT', createdAt: Date.UTC(2026, 6, 1, 10) },
  { id: 'f2', productId: 'btc', side: 1, filled: '1', price: '110', feeUsd: '0.1', type: 'LIMIT', createdAt: Date.UTC(2026, 6, 2, 10) }] : []; rows.truncated = false; return rows; };
A.fundingCharges = async () => { calls.charges++; if (failCharges) throw new Error('archive answered 503'); return [{ positionId: 'p1', productId: 'btc', time: Date.UTC(2026, 6, 1, 12), fundingCharge: '0.5' }]; };
A.positionFills = async () => [];
A.history = async (kind, sid, o) => {
  calls.history++;
  if (o.resolution === 'hour1' && failHour) throw new Error('archive answered 502');
  // a day of movement on every split day, so its hours are read
  return [{ time: o.start, balance: [{ amount: '1' }], volume: '1' }, { time: o.start + 86400000, balance: [{ amount: '2' }], volume: '2' }];
};
const ref = { byId: { btc: { id: 'btc', displayTicker: 'BTC-USD', baseTokenName: 'BTC' } }, tokenById: {} };

test('trade detail: funding charges that failed are read again by the next load, not kept as missing for the tab', async () => {
  const start = Date.UTC(2026, 6, 1), end = Date.UTC(2026, 7, 1);   // a past period: closed
  const a = await T.load.events('sid', { start, end, ref, dayRows: [] });
  assert.equal(a.charges, null); assert.ok(a.failed.some((f) => /funding charges/.test(f)));
  failCharges = false;
  const b = await T.load.events('sid', { start, end, ref, dayRows: [] });
  assert.equal(calls.charges, 2, 'read again'); assert.equal(b.charges.length, 1); assert.deepEqual(b.failed, []);
  const c = await T.load.events('sid', { start, end, ref, dayRows: [] });
  assert.equal(calls.charges, 2, 'complete now: kept for the tab'); assert.equal(c, b);
});

test('archive: an hourly read that failed is read again, a complete archive is kept', async () => {
  const period = { start: Date.UTC(2026, 6, 1, 4), end: Date.UTC(2026, 7, 1, 4), tz: 'UTC' };   // boundaries inside UTC days: split days
  T.periods.splitDays = () => [Date.UTC(2026, 6, 1), Date.UTC(2026, 7, 1)];
  T.ledger.quietDays = () => [];
  const a = await T.load.archive('sid', period);
  assert.ok(a.failed > 0, 'the hourly reads failed');
  failHour = false; const n = calls.history;
  const b = await T.load.archive('sid', period);
  assert.ok(calls.history > n, 'read again'); assert.equal(b.failed, 0);
  const m = calls.history;
  const c = await T.load.archive('sid', period);
  assert.equal(calls.history, m, 'complete: kept for the tab'); assert.equal(c, b);
});

test('a custom range from long before the account read no archive before it existed, and no funding windows when nothing was held', async () => {
  T.cache.clear();
  const asked = []; const h0 = A.history;
  A.history = async (kind, sid, o) => { asked.push(o.start); return []; };
  try {
    const period = { start: Date.UTC(2020, 0, 1), end: Date.UTC(2026, 6, 1), tz: 'UTC' };
    await T.load.archive('sid3', period, { firstT: Date.UTC(2026, 5, 15) });
    assert.ok(asked.length && asked.every((t) => t >= Date.UTC(2026, 5, 14)), 'from the day before the account, not from 2020');
  } finally { A.history = h0; }
  const n = calls.charges;
  await T.load.events('sid4', { start: Date.UTC(2025, 0, 1), end: Date.UTC(2025, 6, 1), ref, dayRows: [] });   // before the only position
  assert.equal(calls.charges, n, 'no position touched: no funding window read');
});
