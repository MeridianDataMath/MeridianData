// The order book order by order (account page, Live): which working orders rest on the book, their quantity as the
// book shows it, and the check of every subaccount's orders against the live levels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_load.mjs';

const MD = load(['js/util.js', 'js/api.js', 'js/analytics.js']);
const AN = MD.analytics;
const BTC = 'p-btc', ETH = 'p-eth';
// an order row as GET /v1/order returns it (side 0 = BUY, 1 = SELL; quantities as decimal strings; expiresAt in seconds)
const o = (x) => Object.assign({ id: 'o' + Math.random().toString(36).slice(2, 8), type: 'LIMIT', status: 'NEW', triggered: 'TRIGGERED', side: 0, productId: BTC, subaccountId: 's1',
  price: '100', quantity: '1', availableQuantity: '1', filled: '0', createdAt: 1790000000000, expiresAt: 1793000000, postOnly: false, reduceOnly: false }, x);

test('resting orders: live limit orders with quantity left, at what the book shows; stops waiting for a trigger are not on the book', () => {
  const rows = [
    o({ id: 'a', side: 1, price: '101.5', availableQuantity: '0.25', subaccountId: 's2' }),
    o({ id: 'b', side: 0, price: '99', quantity: '2', availableQuantity: '2', filled: '0.5', status: 'FILLED_PARTIAL' }),   // half a unit filled: 1.5 rests
    o({ id: 'c', type: 'LIMIT', stopType: 1, triggered: 'NOT_TRIGGERED', status: 'PENDING' }),                                // a stop-limit not triggered yet
    o({ id: 'd', type: 'LIMIT', stopType: 0, triggered: 'STOP_ORDER_TRIGGERED' }),                                            // triggered: now a resting limit
    o({ id: 'e', type: 'MARKET' }),
    o({ id: 'f', status: 'FILLED' }), o({ id: 'g', status: 'CANCELED' }),
    o({ id: 'h', availableQuantity: '1', filled: '1', status: 'FILLED_PARTIAL' }),                                           // nothing left
    o({ id: 'i', price: '0' }),
  ];
  const owners = new Map([['s1', '0xaaa'], ['s2', '0xbbb']]);
  const r = AN.restingOrders(rows, (id) => owners.get(id));
  assert.deepEqual(r.map((x) => x.id), ['a', 'b', 'd']);
  assert.deepEqual([r[0].side, r[0].price, r[0].qty, r[0].account, r[0].sid], ['a', 101.5, 0.25, '0xbbb', 's2']);
  assert.deepEqual([r[1].side, r[1].qty], ['b', 1.5]);
  assert.equal(r[0].expiresAt, 1793000000 * 1000, 'expiry in ms');
  assert.equal(AN.restingOrders([o({ expiresAt: 0 })])[0].expiresAt, null, 'no expiry');
  assert.equal(AN.restingOrders([o({})])[0].account, null, 'no owner lookup: unknown');
  assert.deepEqual(AN.restingOrders(null), []);
});

test('levels: one product\'s orders summed per side and price', () => {
  const r = AN.restingOrders([o({ side: 1, price: '101', availableQuantity: '0.5' }), o({ side: 1, price: '101', availableQuantity: '0.25', subaccountId: 's2' }),
    o({ side: 0, price: '99', availableQuantity: '3' }), o({ productId: ETH, side: 0, price: '99', availableQuantity: '7' })]);
  const lv = AN.ordersAtLevels(r, BTC);
  assert.deepEqual([...lv.a.entries()], [[101, 0.75]]);
  assert.deepEqual([...lv.b.entries()], [[99, 3]], 'another market\'s order at the same price stays out');
});

test('the orders against the live book: every level that adds up, and each that does not, either way', () => {
  const r = AN.restingOrders([o({ side: 1, price: '101', availableQuantity: '0.1' }), o({ side: 1, price: '101', availableQuantity: '0.2', subaccountId: 's2' }),
    o({ side: 0, price: '99', availableQuantity: '1' }), o({ side: 0, price: '98', availableQuantity: '4' })]);
  // 0.1 + 0.2 is 0.30000000000000004 in floating point: still the book's 0.3
  const asks = new Map([[101, 0.3]]), bids = new Map([[99, 1], [98, 4]]);
  assert.deepEqual(AN.bookCheck(asks, bids, r, BTC), { matched: 3, differ: [] });
  // the book moved: 98 partly filled, a new bid at 97 from an account not read, the 101 ask gone
  const c = AN.bookCheck(new Map(), new Map([[99, 1], [98, 3.5], [97, 2]]), r, BTC);
  assert.equal(c.matched, 1);
  assert.deepEqual(c.differ.map((d) => [d.side, d.price, d.book, d.orders]).sort(), [['a', 101, 0, 0.30000000000000004], ['b', 97, 2, 0], ['b', 98, 3.5, 4]].sort());
  assert.deepEqual(AN.bookCheck(new Map(), new Map(), [], BTC), { matched: 0, differ: [] }, 'an empty book and no orders agree');
});

test('a request whose caller left is not handed to the next caller of the same URL (a tab switched mid-read)', async () => {
  const A = MD.api, fetch0 = globalThis.fetch; let n = 0;
  globalThis.fetch = (url, opts) => { n++; const s = opts && opts.signal; return new Promise((res, rej) => {
    if (s) s.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    setTimeout(() => res({ status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ data: [{ id: n }] }) }), 20);
  }); };
  try {
    const url = A.BASE + '/v1/order?subaccountId=x&isWorking=true';
    const c1 = new AbortController(), p1 = A.get(url, { signal: c1.signal });
    c1.abort();   // the Live tab leaves; the Overview asks for the same URL in the same tick
    const p2 = A.get(url, {});
    await assert.rejects(p1, { name: 'AbortError' });
    assert.deepEqual(await p2, { data: [{ id: 2 }] }, 'a fetch of its own');
    // a live request is still shared
    const q1 = A.get(url + '&s=1', {}), q2 = A.get(url + '&s=1', {});
    await Promise.all([q1, q2]); assert.equal(n, 3, 'one fetch for the two callers');
  } finally { globalThis.fetch = fetch0; }
});
