// Formatting and routing helpers every page relies on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_load.mjs';

const MD = load(['js/util.js', 'js/router.js']);
const U = MD.util, R = MD.router;

test('money: two decimals everywhere, dust without a sign, compact columns without cents from $1,000', () => {
  assert.equal(U.fmtUsd(1234.5), '$1,234.50');
  assert.equal(U.fmtUsd(-0.0738), '-$0.07');
  assert.equal(U.fmtUsd(0.000716, { sign: true }), '<$0.01');
  assert.equal(U.fmtUsd(-0.004), '<$0.01');
  assert.equal(U.fmtUsd(0), '$0.00');
  assert.equal(U.fmtUsd(12.3, { sign: true }), '+$12.30');
  assert.equal(U.fmtUsd(9159.76, { compact: true }), '$9,160');
  assert.equal(U.fmtUsd(10234, { compact: true }), '$10.2K');
  assert.equal(U.fmtUsd(536.18, { compact: true }), '$536.18');
  assert.equal(U.fmtUsd(2.5e6, { compact: true }), '$2.50M');
  assert.equal(U.fmtUsd(-1532.1, { dp: 0 }), '-$1,532');
});

test('percent, drawdown and durations', () => {
  assert.equal(U.fmtPct(-12.345), '-12.35%');
  assert.equal(U.fmtPct(3, { sign: true, dp: 1 }), '+3.0%');
  assert.equal(U.fmtDd(0.004), '<0.01%');
  assert.equal(U.fmtDd(null), '—');
  assert.equal(U.fmtDuration(90 * 1000), '2m');
  assert.equal(U.fmtDuration(3 * 3600000), '3.0h');
  assert.equal(U.fmtCountdown(26 * 3600000 + 5 * 60000), '1d 2h');
});

test('dates: schedules drop the current year', () => {
  const now = new Date();
  const t = new Date(now.getFullYear(), 8, 22, 23, 0).getTime();
  assert.equal(U.fmtWhen(t), 'Sep 22, 23:00');
  assert.match(U.fmtWhen(new Date(now.getFullYear() - 1, 0, 2, 3, 4).getTime()), /^Jan 2, \d{4} 03:04$/);
});

test('addresses and ids', () => {
  assert.equal(U.isAddress('0x2f46c3fce6bda596c2771bca618c4f69ae3e56b2'), true);
  assert.equal(U.isAddress('0x2f46'), false);
  assert.equal(U.isUuid('01a06b74-185a-765c-8593-c1e044cf79e0'), true);
  assert.equal(U.shortAddr('0x2f46c3fce6bda596c2771bca618c4f69ae3e56b2'), '0x2f46…56b2');
  assert.equal(U.decodeBytes32('0x7072696d61727900000000000000000000000000000000000000000000000000'), 'primary');
});

test('router: paths, params, and a stray "%" in a pasted link does not throw', () => {
  const r = R.parse('#/account?address=0xabc&sub=1&tab=live');
  assert.equal(r.name, 'account'); assert.equal(r.path, '/account'); assert.deepEqual(r.params, { address: '0xabc', sub: '1', tab: 'live' });
  assert.equal(R.parse('#/copytrade/sim/').path, '/copytrade/sim');
  assert.equal(R.parse('#/').name, 'home');
  assert.deepEqual(R.parse('#/tax?note=100%').params, { note: '100%' });
  assert.equal(R.url('/leaderboard', { interval: '7d', empty: '', none: null }), '#/leaderboard?interval=7d');
});
