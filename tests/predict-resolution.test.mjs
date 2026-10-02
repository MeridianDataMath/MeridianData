// Predict resolution tracker: where a question stands between Polymarket, the UMA oracle and Meridian. Real cases from
// 2026-09-23: the GTA VI "by September 30" market listed with a copied Sep 1 end date, the CPBL game postponed by a
// typhoon and still listed on its original date, unlisted questions Meridian's settlement bot never relays, 50/50 legs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_load.mjs';

const MD = load(['js/util.js', 'js/api.js', 'js/predict/api.js', 'js/predict/analytics.js', 'js/predict/resolution.js']);
const R = MD.predict.res;

// Gamma records served by a stubbed fetch, keyed by condition id; CLOB price histories keyed by token id
const GAMMA = {}, PRICES = {};
globalThis.fetch = async (url) => {
  if (/prices-history/.test(url)) { const tok = /market=([^&]+)/.exec(url)[1]; return { ok: true, json: async () => ({ history: PRICES[tok] || [] }) }; }
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
  // listed to end at 11:59 PM ET on Dec 31, 2026: the nearest Dec 31 is that one, not 2027's
  const hormuz = Date.parse('2027-01-01T04:59:00Z');
  assert.equal(R.titleDeadline('Strait of Hormuz traffic returns to normal by December 31?', hormuz), hormuz, 'the year nearest the listing');
});

test('neg-risk markets are read through negRiskRequestID; a proposal without the oracle states no time', async () => {
  const id = '0xnegrisk', plain = '0xplainq';
  market(id, { question: 'Will Germany win on 2026-10-01?', negRisk: true, questionID: '0xq', negRiskRequestID: '0xr', resolvedBy: '0x69c47de9', umaResolutionStatus: 'proposed', updatedAt: '2026-10-01T21:25:23.480605Z', endDate: '2026-10-01T20:00:00Z' });
  market(plain, { questionID: '0xq2', negRiskRequestID: '0xr2' });
  await R.load([id, plain], { deep: false });
  assert.equal(R.get(id).m.questionId, '0xr');
  assert.equal(R.get(plain).m.questionId, '0xq2', 'a standard market keeps its questionID');
  const s = R.state({ end: Date.parse('2026-10-01T20:00:00Z'), settled: false }, id, Date.parse('2026-10-01T21:30:00Z'));
  assert.equal(s.code, 'proposed'); assert.equal(s.main, 'Outcome proposed on UMA'); assert.equal(s.at, null);
  assert.equal(s.sub, 'challenge window 2 h from the proposal');
});

test('past its listed end but still trading with no outcome priced in: open, not "awaiting proposal"', async () => {
  const id = '0xbass', ended = '0xended';
  market(id, { question: 'Will Karen Bass win the 2026 Los Angeles mayoral election?', endDate: '2026-06-03T03:59:00Z', outcomePrices: '["0.395", "0.605"]', umaBond: '500' });
  market(ended, { question: 'Q', endDate: '2026-09-01T03:59:00Z', acceptingOrders: false });
  await R.load([id, ended], { deep: false });
  const now = Date.parse('2026-10-01T00:00:00Z');
  const s = R.state({ end: Date.parse('2026-06-03T03:59:00Z'), settled: false }, id, now);
  assert.equal(s.code, 'trading'); assert.equal(s.chip[0], 'open');
  assert.match(s.main, /^Still trading on Polymarket · its listed end date \(Jun [23], 2026\) has passed$/);
  assert.match(s.sub, /^no outcome priced in yet \(Yes 40% · No 61%\) · resolves as its rules state$/);
  // halted with no bond on record: no amount is invented
  const e = R.state({ end: Date.parse('2026-09-01T03:59:00Z'), settled: false }, ended, now);
  assert.equal(e.code, 'awaiting'); assert.match(e.sub, /a proposal opens a 2 h challenge window/); assert.doesNotMatch(e.sub, /\$/);
  assert.doesNotMatch(R.explainer(), /\$750/);
});

test('an open market names its date for what it is, not as a resolution time', async () => {
  const id = '0xfed';
  market(id, { question: 'Fed rate cut by October 2026 meeting?', endDate: '2027-01-29T04:59:00Z', outcomePrices: '["0.6", "0.4"]' });
  await R.load([id], { deep: false });
  const s = R.state({ end: Date.parse('2027-01-29T04:59:00Z'), settled: false }, id, Date.parse('2026-10-01T00:00:00Z'));
  assert.equal(s.code, 'trading'); assert.match(s.main, /^Polymarket end date Jan 2[89], 2027 /);
  assert.match(s.sub, /Polymarket resolves it once the outcome is known under its rules, which can be before or after this date · see rules$/);
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
  // Meridian's end time is a listed end, not a betting cutoff (Meridian has taken bets after it)
  assert.match(s.sub, /Meridian end time /); assert.doesNotMatch(s.sub, /bets close/);
  assert.match(s.sub, /earlier than the deadline in the question/);
  // past the real deadline with nothing proposed it is awaiting a proposal again
  assert.equal(R.state({ end: Date.parse('2026-09-02T03:59:00Z'), settled: false }, id, Date.parse('2026-10-02T00:00:00Z')).code, 'awaiting');
});

test('a game long past its scheduled start with nothing proposed is flagged, not "market ended 67d ago"', async () => {
  const id = '0xrakuten';
  market(id, { question: 'Rakuten Monkeys vs. TSG Hawks', outcomes: '["Rakuten Monkeys", "TSG Hawks"]', sportsMarketType: 'moneyline', gameStartTime: '2026-07-10 10:35:00+00', endDate: '2026-07-17T10:35:00Z' });
  await R.load([id], { deep: false });
  const q = { end: Date.parse('2026-07-10T13:35:00Z'), settled: false };
  assert.equal(R.state(q, id, Date.parse('2026-07-09T00:00:00Z')).code, 'trading', 'before the game');
  const during = R.state(q, id, Date.parse('2026-07-10T12:00:00Z'));
  assert.equal(during.code, 'awaiting'); assert.match(during.main, /^Game started/);
  const late = R.state(q, id, Date.parse('2026-09-23T00:00:00Z'));
  assert.equal(late.code, 'noresult', 'without price history it is not called postponed');
  assert.equal(late.chip[0], 'no result · 74d');
  assert.match(late.sub, /postponed game stays open/);
});

// hourly prices of the first outcome: `pre` until the start, then `post` values in turn
const series = (gameAt, pre, post) => {
  const out = []; const g = Date.parse(gameAt) / 1000;
  for (let i = 12; i >= 0; i--) out.push({ t: g - i * 3600, p: pre });
  post.forEach((p, i) => out.push({ t: g + (i + 1) * 3600, p }));
  return out;
};

test('NPB Rakuten–SoftBank, Sep 21: rained out, still listed on its date, odds never moved → postponed', async () => {
  const id = '0xnpb';
  market(id, { question: 'Tohoku Rakuten Golden Eagles vs. Fukuoka SoftBank Hawks', outcomes: '["Tohoku Rakuten Golden Eagles", "Fukuoka SoftBank Hawks"]', outcomePrices: '["0.27", "0.73"]', bestBid: '0.02', bestAsk: '0.52',
    sportsMarketType: 'moneyline', gameStartTime: '2026-09-21 04:00:00+00', endDate: '2026-09-28T04:00:00Z', slug: 'npb-toh-fuk-2026-09-21', clobTokenIds: '["tokNpb", "tokNpb2"]',
    events: [{ slug: 'npb-toh-fuk-2026-09-21', period: 'NS', resolutionSource: 'https://npb.jp/' }] });
  // what the CLOB actually served: 40.5 % before the start, 24–52 % on a thin book over the next two and a half days
  PRICES.tokNpb = series('2026-09-21T04:00:00Z', 0.405, [0.41, 0.39, 0.4, 0.41, 0.395, 0.315, 0.41, 0.415, 0.41, 0.385, 0.38, 0.38, 0.24, 0.395, 0.425, 0.515, 0.51, 0.475, 0.505, 0.465, 0.315, 0.295, 0.28, 0.405, 0.38, 0.37, 0.395, 0.405, 0.46, 0.285, 0.27, 0.27]);
  const q = { end: Date.parse('2026-09-21T07:00:00Z'), settled: false, pub: true };
  await R.load([id], { deep: true, now: Date.parse('2026-09-23T20:00:00Z') });
  const early = R.state(q, id, Date.parse('2026-09-21T09:00:00Z'));
  assert.equal(early.code, 'awaiting', 'five hours in: just waiting');
  const s = R.state(q, id, Date.parse('2026-09-23T20:00:00Z'));
  assert.equal(s.code, 'postponed'); assert.equal(s.chip[0], 'postponed');
  assert.equal(s.main, 'Probably postponed · no sign it was played on Sep 21');
  // the window R.history asked for: from the start to "now", 2 days 16 hours later
  assert.match(s.sub, /in the first 2d 16h after it the median odds stayed within 10 points of the pre-game level \(41% before, 40% after\)/);
  assert.match(s.sub, /50-50, which Meridian settles as a loss for the bettor/);
  assert.equal(s.m.source, 'https://npb.jp/');
  assert.equal(R.oddsText(s.m), 'Tohoku Rakuten Golden Eagles 27% · Fukuoka SoftBank Hawks 73%');
});

test('a played game: the odds go to 99 % → the leader is shown, and odds that moved without a winner → "no result"', async () => {
  const played = '0xplayed', abandoned = '0xcricket';
  market(played, { outcomes: '["Tohoku Rakuten Golden Eagles", "Fukuoka SoftBank Hawks"]', outcomePrices: '["0.998", "0.002"]', sportsMarketType: 'moneyline', gameStartTime: '2026-09-20 05:00:00+00', clobTokenIds: '["tokPlayed", "x"]' });
  market(abandoned, { outcomes: '["Nigeria", "Sierra Leone"]', outcomePrices: '["0.685", "0.315"]', sportsMarketType: 'moneyline', gameStartTime: '2026-09-23 09:00:00+00', clobTokenIds: '["tokCricket", "x"]', slug: 'crint-nga-sle-2026-09-23' });
  PRICES.tokCricket = series('2026-09-23T09:00:00Z', 0.905, [0.915, 0.735, 0.7, 0.615, 0.58, 0.555, 0.6, 0.605, 0.59, 0.58, 0.745, 0.635]);
  const now = Date.parse('2026-09-23T21:30:00Z');
  await R.load([played, abandoned], { deep: true, now });
  const p = R.state({ end: Date.parse('2026-09-20T08:00:00Z') }, played, now);
  assert.equal(p.code, 'awaiting'); assert.match(p.main, /^Game started .+ · Polymarket prices Tohoku Rakuten Golden Eagles at 99\.8%$/);
  const c = R.state({ end: Date.parse('2026-09-23T17:07:00Z') }, abandoned, now);
  assert.equal(c.code, 'noresult'); assert.equal(c.chip[0], 'no result · 12h');
  assert.match(c.sub, /the odds moved after the start, but no winner is priced in \(Nigeria 69% · Sierra Leone 32%\)/);
});

test('re-dated fixtures and Polymarket\'s own "postponed" read as postponed, with the new date', async () => {
  const rsl = '0xrsl', levante = '0xlev';
  market(rsl, { question: 'Will Real Salt Lake win on 2026-04-12?', sportsMarketType: 'moneyline', gameStartTime: '2026-09-24 01:30:00+00', endDate: '2026-09-24T01:30:00Z', slug: 'mls-sea-rsl-2026-04-12-rsl',
    events: [{ slug: 'mls-sea-rsl-2026-04-12', eventDate: '2026-09-23' }] });
  market(levante, { question: 'Will Athletic Club win on 2026-09-16?', sportsMarketType: 'moneyline', gameStartTime: '2026-10-21 18:00:00+00', endDate: '2026-10-21T18:00:00Z', slug: 'lal-lev-bil-2026-09-16-bil',
    events: [{ slug: 'lal-lev-bil-2026-09-16', period: 'POST', resolutionSource: 'javascript:alert(1)' }] });
  await R.load([rsl, levante], { deep: false });
  const now = Date.parse('2026-09-23T20:00:00Z');
  const a = R.state({ end: Date.parse('2026-04-12T23:59:00Z') }, rsl, now);
  assert.equal(a.code, 'postponed'); assert.match(a.main, /^Postponed from Apr 12 · now Sep 2[34], /);
  assert.equal(a.orig, Date.UTC(2026, 3, 12, 12));
  const b = R.state({ end: Date.parse('2026-09-16T22:30:00Z') }, levante, now);
  assert.equal(b.code, 'postponed'); assert.equal(b.feed, 'postponed'); assert.match(b.main, /^Postponed from Sep 16 · now Oct 21, /);
  assert.equal(b.m.source, null, 'only http(s) sources become links');
  // the make-up game itself, once under way
  const later = R.state({ end: Date.parse('2026-04-12T23:59:00Z') }, rsl, Date.parse('2026-09-24T02:30:00Z'));
  assert.equal(later.code, 'awaiting'); assert.match(later.main, /^Make-up game started .* \(postponed from Apr 12\)$/);
  // a fixture that is simply later than its listing day but matches Meridian's cutoff is not a postponement
  assert.equal(R.state({ end: Date.parse('2026-09-24T04:30:00Z') }, rsl, now).code, 'trading');
});

test('Polymarket\'s feed codes: POST = postponed, CAN = cancelled (resolves 50-50, a loss for the bettor on Meridian)', async () => {
  assert.equal(R.feedStatus('POST'), 'postponed'); assert.equal(R.feedStatus('CAN'), 'cancelled'); assert.equal(R.feedStatus('Canceled'), 'cancelled');
  assert.equal(R.feedStatus('NS'), null); assert.equal(R.feedStatus('VFT'), null); assert.equal(R.feedStatus('3/3'), null);
  // WTA Monterrey, Aug 26: the match was never played; before Polymarket resolved it 50-50 the question read "cancelled"
  const id = '0xwta';
  market(id, { question: 'Monterrey Open: Nikola Bartunkova vs Anastasia Potapova', outcomes: '["Nikola Bartunkova", "Anastasia Potapova"]', sportsMarketType: 'moneyline', gameStartTime: '2026-08-26 03:30:00+00', slug: 'wta-bartunk-potapov-2026-08-26', events: [{ slug: 'wta-bartunk-potapov-2026-08-26', period: 'CAN', score: '0-0' }] });
  await R.load([id], { deep: false });
  const s = R.state({ end: Date.parse('2026-09-10T03:59:00Z') }, id, Date.parse('2026-08-26T12:00:00Z'));
  assert.equal(s.code, 'postponed'); assert.equal(s.chip[0], 'cancelled'); assert.match(s.sub, /50-50, which Meridian settles as a loss for the bettor/);
});

test('the played check: median odds before vs after the start', () => {
  const g = Date.parse('2026-09-20T05:00:00Z');
  assert.equal(R.playedCheck(series('2026-09-20T05:00:00Z', 0.375, [0.38, 0.605, 0.9995, 0.9955, 0.9955]), g).moved, true, 'went to 99 %');
  assert.equal(R.playedCheck(series('2026-09-20T05:00:00Z', 0.375, [0.38, 0.5, 0.5, 0.5, 0.5]), g).moved, true, 'a tie: 50-50');
  assert.equal(R.playedCheck(series('2026-09-20T05:00:00Z', 0.47, [0.55, 0.3, 0.62, 0.5, 0.5, 0.5]), g).moved, true, 'a tie from even odds still swung during the game');
  assert.equal(R.playedCheck(series('2026-09-20T05:00:00Z', 0.47, [0.46, 0.48, 0.47, 0.5, 0.45, 0.47]), g).moved, false, 'flat: not played');
  assert.equal(R.playedCheck(series('2026-09-20T05:00:00Z', 0.375, [0.38, 0.37]), g), null, 'too little trading to tell');
  assert.equal(R.playedCheck([], g), null);
  // the CLOB appends its latest price even when the window asked for ended long before: it is not counted
  const pts = series('2026-09-20T05:00:00Z', 0.47, [0.46, 0.48, 0.47, 0.5, 0.45, 0.47]);
  const end = g + 6 * 3600000;
  const hv = R.playedCheck(pts.concat({ t: g / 1000 + 30 * 86400, p: 0.2 }), g, end);
  assert.equal(hv.n, 5); assert.equal(hv.to, end); assert.equal(hv.moved, false);
  assert.equal(R.playedCheck(pts.concat({ t: g / 1000 + 30 * 86400, p: 0.2 }), g).n, 6, 'without an end every point counts');
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
  // the chip carries no age (the main line dates the question, the sub-line the won prediction)
  assert.equal(s.chip[0], 'resolved · stuck');
  assert.match(s.sub, /^1 won prediction \(\$5(\.00)?\) waiting for settlement · the oldest has been fully won on Polymarket for 82 days/);
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

test('a finished game is marked from Polymarket\'s game feed, while its market still trades (Greece–Netherlands, Oct 1)', async () => {
  // Gamma's event said ended (VFT, 2-2) at 20:42 UTC; the market stayed open, accepting orders, until 22:52
  const greece = '0xgreece', live = '0xsteelers', plain = '0xplain';
  market(greece, { question: 'Will Greece win on 2026-10-01?', events: [{ slug: 'uefa-nl-gre-ned-2026-10-01', gameId: 1, ended: true, period: 'VFT' }], outcomePrices: '["0.0005", "0.9995"]' });
  market(live, { question: 'Steelers beats Browns?', events: [{ slug: 'nfl-pit-cle-2026-10-01', gameId: 2, ended: false, period: 'Q2' }] });
  market(plain, { question: 'Will Renan Santos win?', events: [{ slug: 'brazil-election' }] });
  await R.load([greece, live, plain], { deep: false });
  assert.equal(R.get(greece).m.ended, true);
  assert.equal(R.get(greece).m.closed, false, 'still trading on Polymarket');
  assert.equal(R.get(live).m.ended, false, 'a game in progress');
  assert.equal(R.get(plain).m.ended, false, 'not a game: no such field');
});
