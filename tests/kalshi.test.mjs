// Kalshi questions (Meridian mirrors some from Kalshi since 13 Oct): the snapshot builder reads each listed one's market
// (scripts/build-snapshot.mjs kalshiTicker, kalshiRow; a browser on the site cannot ask Kalshi) and the resolution
// tracker shows where it stands (js/predict/resolution.js R.kalshi, R.state). Real records from 2026-10-25. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_load.mjs';
import { kalshiTicker, kalshiRow, KALSHI } from '../scripts/build-snapshot.mjs';

const MD = globalThis.MD.predict && globalThis.MD.predict.res ? globalThis.MD : load(['js/util.js', 'js/api.js', 'js/predict/api.js', 'js/predict/analytics.js', 'js/predict/resolution.js']);
const R = MD.predict.res;

test('the market ticker comes from the question\'s source link; the record keeps what the page uses', () => {
  assert.equal(kalshiTicker('https://kalshi.com/markets/kxnflgame/nfl-game/kxnflgame-26oct25kcsea?op_market_ticker=KXNFLGAME-26OCT25KCSEA-KC&op_order_side=yes'), 'KXNFLGAME-26OCT25KCSEA-KC');
  assert.equal(kalshiTicker('https://kalshi.com/markets/kxnflspread/x?op_order_side=yes&op_market_ticker=kxnflspread-26oct25gbdet-det14'), 'KXNFLSPREAD-26OCT25GBDET-DET14', 'anywhere in the query, in capitals');
  assert.equal(kalshiTicker('https://polymarket.com/event/x'), null); assert.equal(kalshiTicker(null), null);
  assert.match(KALSHI, /^https:\/\/api\.elections\.kalshi\.com\/trade-api\/v2\/markets$/);
  const k = kalshiRow({ ticker: 'KXNFLGAME-26OCT25CLETEN-CLE', status: 'finalized', result: 'yes', settlement_value_dollars: '1.0000', last_price_dollars: '0.9900', yes_bid_dollars: '0.0000', yes_ask_dollars: '1.0000',
    occurrence_datetime: '2026-10-25T20:00:00Z', expected_expiration_time: '2026-10-25T20:00:00Z', close_time: '2026-10-25T20:09:13Z', settlement_ts: '2026-10-25T20:10:17.583814Z', rules_primary: 'If Cleveland wins the Cleveland vs Tennessee Pro Football game originally scheduled for Oct 25, 2026, then the market resolves to Yes.', expiration_value: 'Cleveland' });
  assert.deepEqual(Object.keys(k).sort(), ['a', 'b', 'c', 'o', 'p', 'r', 'ru', 's', 'st', 'sv', 't', 'x'].sort());
  assert.equal(k.sv, 1); assert.equal(k.s, Date.parse('2026-10-25T20:10:17.583Z'));
  const open = kalshiRow({ ticker: 'T', status: 'active', result: '', last_price_dollars: '0.4200', rules_primary: 'x'.repeat(500) });
  assert.equal(open.r, undefined, 'an empty result is left out'); assert.equal(open.ru.length, 300);
});

test('R.state reads a Kalshi question\'s market from the snapshot: open, in play, resolved, a fair price, settled', () => {
  const H = 3600000, start = Date.parse('2026-10-26T00:20:00Z'), end = Date.parse('2026-10-26T03:20:00Z'), at = Date.parse('2026-10-25T21:40:00Z');
  const src = (t) => 'https://kalshi.com/markets/x?op_market_ticker=' + t;
  R.kalshi([
    { id: '0xKC', src: src('KC'), ev: 'KXNFLGAME-26OCT25KCSEA', k: { t: 'KC', st: 'active', p: 0.42, b: 0.41, a: 0.42, o: end, x: end, c: end + 45 * H } },
    { id: '0xCLE', src: src('CLE'), k: { t: 'CLE', st: 'finalized', r: 'yes', sv: 1, o: start - 8 * H, c: start - 7 * H, s: start - 7 * H + 60000 } },
    { id: '0xLOVE', src: src('LOVE'), k: { t: 'LOVE', st: 'finalized', r: 'scalar', sv: 0.42, s: start - 200 * H } },
    { id: '0xCLOSED', src: src('C'), k: { t: 'C', st: 'closed', c: start - H } },
    { id: '0xNOK' },
  ], at, { 'KXNFLGAME-26OCT25KCSEA': { n: 'Kansas City vs Seattle', t: start } });
  const q = (o) => Object.assign({ end: start, settled: false }, o);
  // before the game, during it (the start from the match: Kalshi's occurrence time is the expected end), long after
  const before = R.state(q({}), '0xKC', start - 2 * H);
  assert.equal(before.code, 'trading'); assert.match(before.main, /^Starts /); assert.match(before.sub, /Kalshi as of /);
  const during = R.state(q({}), '0xKC', start + H);
  assert.equal(during.code, 'inplay'); assert.equal(during.chip[0], 'in play'); assert.match(during.main, /^Started .+ · trading on Kalshi$/);   // (a past time reads against the clock, as the other states') assert.match(during.sub, /expected to end in 2h/);
  assert.equal(R.state(q({}), '0xKC', end + 4 * H).code, 'awaiting', 'past its expected end and still trading');
  // the chance: the middle of the bid and ask
  assert.equal(R.get('0xKC').m.prices[0], 0.415); assert.ok(R.get('0xKC').m.kalshi);
  // resolved on Kalshi, not settled on Meridian yet; a fair price counts as 50/50
  const won = R.state(q({}), '0xCLE', start);
  assert.equal(won.code, 'resolved'); assert.match(won.main, /^Resolved YES on Kalshi /); assert.equal(won.chip[0], 'resolved · settling');
  assert.equal(R.resolvedYes(R.get('0xCLE').m), true);
  const fair = R.state(q({}), '0xLOVE', start);
  assert.match(fair.main, /^Resolved a fair price \(\$0\.42\) on Kalshi/); assert.match(fair.sub, /50\/50 settles as a loss for the bettor/);
  assert.equal(R.resolvedYes(R.get('0xLOVE').m), 'void');
  assert.equal(R.pickLost({ yes: true }, '0xLOVE'), true, 'a 50/50 leg is lost'); assert.equal(R.pickLost({ yes: true }, '0xCLE'), false); assert.equal(R.pickLost({ yes: false }, '0xCLE'), true);
  assert.equal(R.state(q({}), '0xCLOSED', start).code, 'awaiting');
  // settled on Meridian: its own result, Kalshi's settlement time in the sub-line
  const settled = R.state(q({ settled: true, yes: true }), '0xCLE', start);
  assert.equal(settled.code, 'settled'); assert.match(settled.sub, /^Kalshi settled /);
  // a row without a Kalshi record is not registered
  assert.equal(R.get('0xNOK').m, undefined);
});
