// Predict resolution tracker: where a question stands between Polymarket, the UMA oracle and Meridian. Real cases from
// 2026-09-23: the GTA VI "by September 30" market listed with a copied Sep 1 end date, the CPBL game postponed by a
// typhoon and still listed on its original date, unlisted questions Meridian's settlement bot never relays, 50/50 legs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_load.mjs';

const MD = load(['js/util.js', 'js/api.js', 'js/predict/api.js', 'js/predict/analytics.js', 'js/predict/resolution.js']);
const R = MD.predict.res;
const DAY = 86400000;

// Gamma records served by a stubbed fetch, keyed by condition id
const GAMMA = {};
globalThis.fetch = async (url) => {
  const ids = Array.from(String(url).matchAll(/condition_ids=([^&]+)/g)).map((x) => x[1]);
  const closedPass = /closed=true/.test(url);
  return { ok: true, json: async () => ids.map((id) => GAMMA[id]).filter((m) => m && !!m.closed === closedPass) };
};
const market = (id, o) => (GAMMA[id] = Object.assign({ conditionId: id, question: 'Q', outcomes: '["Yes", "No"]', outcomePrices: '["0.5", "0.5"]', closed: false, acceptingOrders: true, umaResolutionStatuses: '[]' }, o));

test('a deadline stated in the question: 11:59 PM US Eastern that day', () => {
  const sep1 = Date.parse('2026-09-01T03:59:00Z');
  assert.equal(R.titleDeadline('Another GTA VI trailer released by September 30?', sep1), Date.parse('2026-10-01T03:59:00Z'), 'EDT');
  assert.equal(R.titleDeadline('US ceasefire against Iran continues through Sept 30?', sep1), Date.parse('2026-10-01T03:59:00Z'));
  assert.equal(R.titleDeadline('Will X happen by December 31?', Date.parse('2026-12-01T00:00:00Z')), Date.parse('2027-01-01T04:59:00Z'), 'EST');
  assert.equal(R.titleDeadline('Released by January 15?', Date.parse('2026-12-20T00:00:00Z')), Date.parse('2027-01-16T04:59:00Z'), 'next year when the date has passed');
  assert.equal(R.titleDeadline('Launch before March 3, 2027?', sep1), Date.parse('2027-03-04T04:59:00Z'), 'explicit year');
  assert.equal(R.titleDeadline('Fed rate cut by October 2026 meeting?', sep1), null, 'a month without a day is no deadline');
  assert.equal(R.titleDeadline('Will the price of Bitcoin be above $60,000 on August 12?', sep1), null, '"on" dates are the market\'s own schedule');
  assert.equal(R.titleDeadline('Will Karen Bass win the 2026 Los Angeles mayoral election?', sep1), null);
});

test('GTA VI by September 30: listed as ending Sep 1, still trading → open until the deadline, not "awaiting proposal"', async () => {
  const id = '0xgta';
  market(id, { question: 'Another GTA VI trailer released by September 30?', endDate: '2026-09-01T03:59:00Z', outcomePrices: '["0.045", "0.955"]' });
  await R.load([id], { deep: false });
  const now = Date.parse('2026-09-23T00:00:00Z');
  const s = R.state({ end: Date.parse('2026-09-02T03:59:00Z'), settled: false }, id, now);
  assert.equal(s.code, 'trading');
  assert.equal(s.m.endAt, Date.parse('2026-10-01T03:59:00Z'));
  assert.equal(s.m.listedEnd, Date.parse('2026-09-01T03:59:00Z'));
  assert.match(s.sub, /Meridian bets closed/);
  assert.match(s.sub, /earlier than the deadline in the question/);
  // past the real deadline with nothing proposed it is awaiting a proposal again
  assert.equal(R.state({ end: Date.parse('2026-09-02T03:59:00Z'), settled: false }, id, Date.parse('2026-10-02T00:00:00Z')).code, 'awaiting');
});

test('a game long past its scheduled start with nothing proposed is flagged, not "market ended 67d ago"', async () => {
  const id = '0xrakuten';
  market(id, { question: 'Rakuten Monkeys vs. TSG Hawks', outcomes: '["Rakuten Monkeys", "TSG Hawks"]', gameStartTime: '2026-07-10 10:35:00+00', endDate: '2026-07-17T10:35:00Z' });
  await R.load([id], { deep: false });
  const q = { end: Date.parse('2026-07-10T13:35:00Z'), settled: false };
  assert.equal(R.state(q, id, Date.parse('2026-07-09T00:00:00Z')).code, 'trading', 'before the game');
  const during = R.state(q, id, Date.parse('2026-07-10T12:00:00Z'));
  assert.equal(during.code, 'awaiting'); assert.match(during.main, /^Game started/);
  const late = R.state(q, id, Date.parse('2026-09-23T00:00:00Z'));
  assert.equal(late.code, 'overdue');
  assert.equal(late.chip[0], 'no result · 74d');
  assert.match(late.sub, /postponed/);
});

test('an unlisted question resolved on Polymarket but never relayed to Meridian says why it is stuck', async () => {
  const id = '0xspain', other = '0xexact';
  market(id, { question: 'Spain vs. Austria: Spain O/U 1.5', closed: true, closedTime: '2026-07-02 21:38:00+00', umaEndDate: '2026-07-02T21:38:00Z', outcomes: '["Over", "Under"]', outcomePrices: '["1", "0"]' });
  market(other, { question: 'Exact Score: Spain 3 - 0 Austria?', closed: true, closedTime: '2026-07-02 21:38:00+00', umaEndDate: '2026-07-02T21:38:00Z', outcomePrices: '["1", "0"]' });
  await R.load([id, other], { deep: false });
  const now = Date.parse('2026-09-23T00:00:00Z');
  const op = [{ id: '0x75e3', s: 5, k: [[other, 1], [id, 1]] }];
  const s = R.state({ end: Date.parse('2026-07-02T21:59:00Z'), settled: false, pub: false, op }, id, now);
  assert.equal(s.code, 'resolved'); assert.equal(s.stuck, true); assert.equal(s.unlisted, true);
  assert.equal(s.chip[0], 'resolved · stuck 82d');
  assert.match(s.sub, /unlisted question/);
  const listed = R.state({ end: Date.parse('2026-07-02T21:59:00Z'), settled: false, pub: true, op }, id, now);
  assert.doesNotMatch(listed.sub, /unlisted/);
});

test('a leg resolved 50/50 loses the prediction on Meridian (no refund outcome)', async () => {
  const tie = '0xtie', won = '0xwon';
  market(tie, { closed: true, closedTime: '2026-08-01 00:00:00+00', outcomePrices: '["0.5", "0.5"]' });
  market(won, { closed: true, closedTime: '2026-08-01 00:00:00+00', outcomePrices: '["1", "0"]' });
  await R.load([tie, won], { deep: false });
  assert.deepEqual(R.predictionState([[won, true], [tie, true]]), { code: 'lost', void: true });
  assert.equal(R.predictionState([[won, true]]).code, 'won');
  assert.equal(R.pickLost({ yes: true }, tie), true);
  assert.equal(R.pickLost({ yes: false }, tie), true);
  assert.equal(R.state({ settled: true, nd: true }, tie).chip[0], '50/50');
});
