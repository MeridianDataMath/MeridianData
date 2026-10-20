// The account page's reading of the data it shows beside the app: why an order ended unfilled, and the Live tab's
// transfers and liquidations from the REST history and the WebSocket (Meridian's docs: WebSocket, Account Events).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_load.mjs';

const MD = load(['js/util.js', 'js/router.js', 'js/api.js', 'js/pages/account.js']);
const P = MD.router.pages.account, U = MD.util;

test('an order\'s reason in words where the name leaves no doubt, otherwise as Meridian names it', () => {
  // the reasons found on canceled orders of the 60 busiest accounts, Oct 21
  assert.equal(P.reasonTxt('UnfilledImmediateOrCancel'), 'immediate-or-cancel: the part not filled at once');
  assert.equal(P.reasonTxt('OrderIncreasesPosition'), 'reduce-only, and it would have added to the position');
  assert.equal(P.reasonTxt('MakerCanceledByTaker'), 'maker canceled by taker');
  assert.equal(P.reasonTxt('CloseOrder'), 'close order');
  assert.equal(P.reasonTxt(null), null);
});

test('transfers from REST and the WebSocket become one feed item; a status change updates it where it is', () => {
  const rest = P.transferItem({ id: 'w1', type: 'WITHDRAW', status: 'PENDING', amount: '100', fee: '1', tokenName: 'USD', lzDestinationEid: 30101, initiatedTransactionHash: '0xa', createdAt: 5 });
  assert.deepEqual(rest, { id: 'w1', kind: 'transfer', t: 5, typ: 'WITHDRAW', st: 'PENDING', amt: '100', fee: '1', token: 'USD', toToken: null, eid: 30101, tx: '0xa' });
  assert.equal(U.lzChainName(rest.eid), 'Ethereum');
  const ws = P.wsTransferItem({ e: 'TokenTransfer', t: 9, data: { id: 'w1', t: 8, typ: 'WITHDRAW', st: 'COMPLETED', amt: '100', fee: '1', tName: 'USD', iniTx: '0xa', finTx: '0xb', lzEid: 30101 } });
  assert.equal(ws.st, 'COMPLETED'); assert.equal(ws.tx, '0xb'); assert.equal(ws.t, 8);
  let list = [P.transferItem({ id: 'd0', type: 'DEPOSIT', status: 'COMPLETED', amount: '50', tokenName: 'USD', createdAt: 1 }), rest];
  list = P.pushEvent(list, ws);
  assert.equal(list.length, 2); assert.equal(list[1].id, 'w1'); assert.equal(list[1].st, 'COMPLETED'); assert.equal(list[1]._new, true);
  const conv = P.wsTransferItem({ data: { id: 'c1', t: 10, typ: 'CONVERT', st: 'COMPLETED', amt: '20', tName: 'USD', toTName: 'XAUUSD' } });
  list = P.pushEvent(list, conv);
  assert.equal(list[0].id, 'c1'); assert.equal(list[0].toToken, 'XAUUSD'); assert.equal(list.length, 3);
});

test('a liquidation lists the positions it closed, a short by its negative size', () => {
  const it = P.wsLiqItem({ e: 'SubaccountLiquidation', t: 11, data: { sid: 's', t: 10, d: [{ s: 'XAUUSD', px: '4100.5', sz: '-0.5' }, { s: 'XAGUSD', px: '48.1', sz: '10' }] } });
  assert.equal(it.kind, 'liq'); assert.equal(it.t, 10);
  assert.deepEqual(it.positions, [{ ticker: 'XAUUSD', px: '4100.5', sz: -0.5 }, { ticker: 'XAGUSD', px: '48.1', sz: 10 }]);
});

test('a LayerZero destination reads as the address in it', () => {
  assert.equal(U.lzAddress('0x0000000000000000000000002f46c3fce6bda596c2771bca618c4f69ae3e56b2'), '0x2f46c3fce6bda596c2771bca618c4f69ae3e56b2');
  assert.equal(U.lzAddress('0xabc'), '0xabc'); assert.equal(U.lzAddress(null), null);
  assert.equal(U.chainName(4663), 'Robinhood Chain'); assert.equal(U.lzChainName(30416), 'Robinhood Chain'); assert.equal(U.lzChainName(1), 'LayerZero endpoint 1');
  assert.equal(U.explorerTxOn(1, '0xh'), 'https://etherscan.io/tx/0xh'); assert.equal(U.explorerTxOn(999, '0xh'), null);
});
