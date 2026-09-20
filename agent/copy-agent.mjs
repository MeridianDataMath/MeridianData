#!/usr/bin/env node
/**
 * MeridianDataHub copy agent — mirrors leaders' Meridian positions into your own subaccount.
 *
 *   node copy-agent.mjs keygen                 make a signer key (signer.key) and print its address
 *   node copy-agent.mjs link                   print the link request the site's Copy agent page needs (your wallet
 *                                              signs it there; the exchange then lets this key trade, never withdraw)
 *   node copy-agent.mjs run                    follow the leaders in config.json and mirror them
 *   node copy-agent.mjs run --dry              the same, but every order goes to the exchange's dry-run endpoint (margin
 *                                              check, nothing placed); no linked signer needed. Watch it on the site first.
 *   node copy-agent.mjs status                 what the running agent is doing (from its local status port)
 *
 * Non-custodial by construction: the signer key is a Meridian linked signer (submit / cancel orders only), generated
 * and kept on this machine; the owner wallet signs the link once in the browser. Public data only otherwise: leaders'
 * fills come from the exchange WebSocket, prices from the REST API. Every order is EIP-712 signed the way the exchange
 * documents (see js/copy/ and the SDK for the same maths on the site).
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Wallet, ethers } from 'ethers';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const cmd = args[0] || 'help';
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const API = 'https://api.meridian.xyz';
const WS_URL = 'wss://ws.meridian.xyz/v1/stream';
const SITE = 'https://meridian.thedatahub.xyz';
const num = (x) => { const n = typeof x === 'number' ? x : parseFloat(String(x)); return Number.isFinite(n) ? n : 0; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);

// ---------------------------------------------------------------- files
const configPath = path.resolve(here, opt('config', 'config.json'));
const readConfig = () => { if (!fs.existsSync(configPath)) throw new Error(`No ${configPath}. Build one on the site's Copy agent page (or copy config.example.json).`); return JSON.parse(fs.readFileSync(configPath, 'utf8')); };
const keyPath = (cfg) => path.resolve(here, (cfg && cfg.keyFile) || 'signer.key');
const readKey = (cfg) => { const p = keyPath(cfg); if (!fs.existsSync(p)) throw new Error(`No signer key at ${p}: run "node copy-agent.mjs keygen" first.`); return new Wallet(fs.readFileSync(p, 'utf8').trim()); };
const logDir = path.join(here, 'logs'); fs.mkdirSync(logDir, { recursive: true });
const log = (...a) => { const line = `${new Date().toISOString()} ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`; console.log(line); try { fs.appendFileSync(path.join(logDir, 'agent-' + new Date().toISOString().slice(0, 10) + '.log'), line + '\n'); } catch (_) {} };

// ---------------------------------------------------------------- exchange
async function api(pathname, { method = 'GET', body, params } = {}) {
  const url = new URL(API + pathname); if (params) for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, String(v));
  const r = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (_) {}
  if (!r.ok) { const e = new Error((j && (Array.isArray(j.message) ? j.message.join('; ') : j.message)) || `HTTP ${r.status}`); e.status = r.status; e.body = j; throw e; }
  return j;
}
const page = async (pathname, params, max = 10) => { const rows = []; let cursor = null; for (let i = 0; i < max; i++) { const r = await api(pathname, { params: Object.assign({}, params, { limit: 100, cursor }) }); rows.push(...(r.data || [])); if (!(r.hasNext && r.nextCursor)) break; cursor = r.nextCursor; } return rows; };
const nonce = (() => { let last = 0n; return () => { let n = BigInt(Date.now()) * 1000000n; if (n <= last) n = last + 1n; last = n; return n; }; })();
const typesOf = (rpc, primary) => ({ [primary]: rpc.signatureTypes[primary].split(',').map((f) => { const [type, name] = f.trim().split(' '); return { name, type }; }) });

/** EIP-712 signature of one message type, exactly as the exchange's /v1/rpc/config describes it. */
async function sign(wallet, rpc, primary, message) {
  const domain = { name: rpc.domain.name, version: rpc.domain.version, chainId: Number(rpc.domain.chainId), verifyingContract: rpc.domain.verifyingContract };
  return wallet.signTypedData(domain, typesOf(rpc, primary), message);
}

// ---------------------------------------------------------------- commands
async function keygen() {
  const cfg = fs.existsSync(configPath) ? readConfig() : null; const p = keyPath(cfg);
  if (fs.existsSync(p) && opt('force') == null) { const w = readKey(cfg); console.log(`A signer key already exists at ${p}\nAddress: ${w.address}\n(--force to replace it; the old address stays linked until you revoke it on the exchange)`); return; }
  const w = Wallet.createRandom();
  fs.writeFileSync(p, w.privateKey + '\n', { mode: 0o600 });
  console.log(`Signer key written to ${p}\nAddress: ${w.address}\n\nThis key can only submit and cancel orders once linked; it can never withdraw. Keep the file private anyway.\nNext: node copy-agent.mjs link`);
}

async function link() {
  const cfg = readConfig(); const w = readKey(cfg);
  if (!ethers.isAddress(cfg.owner)) throw new Error('config.owner must be your wallet address');
  const sa = await api('/v1/subaccount/' + cfg.subaccountId);
  if (String(sa.account).toLowerCase() !== cfg.owner.toLowerCase()) throw new Error(`Subaccount ${cfg.subaccountId} belongs to ${sa.account}, not config.owner`);
  const rpc = await api('/v1/rpc/config');
  const data = { sender: ethers.getAddress(cfg.owner), signer: w.address, subaccount: sa.name, subaccountId: sa.id, nonce: nonce().toString(), signedAt: Math.floor(Date.now() / 1000), category: 'API', name: 'MeridianDataHub copy agent' };
  const signerSignature = await sign(w, rpc, 'LinkSigner', { sender: data.sender, signer: data.signer, subaccount: data.subaccount, nonce: BigInt(data.nonce), signedAt: data.signedAt });
  const req = { data, signerSignature };
  fs.writeFileSync(path.join(here, 'link-request.json'), JSON.stringify(req, null, 2));
  console.log(`Link request written to link-request.json (valid for about an hour).\n\nPaste it on ${SITE}/#/copytrade/agent → "Link the signer"; your wallet signs it there and the site sends it to the exchange.\n\n` + JSON.stringify(req));
}

async function status() {
  const cfg = readConfig(); const port = (cfg.status && cfg.status.port) || 8790;
  try { const r = await fetch(`http://127.0.0.1:${port}/status`); console.log(JSON.stringify(await r.json(), null, 2)); }
  catch (e) { console.log(`No agent answering on port ${port} (${e.message}). Start it with: node copy-agent.mjs run`); }
}

// ---------------------------------------------------------------- the engine
async function run() {
  const cfg = readConfig(); const w = readKey(cfg);
  const DRY = args.includes('--dry') || !!(cfg.execution && cfg.execution.dryRun);
  const rpc = await api('/v1/rpc/config');
  const products = (await api('/v1/product?limit=200')).data || [];
  const byId = {}, byTicker = {}; for (const p of products) { byId[p.id] = p; byTicker[p.ticker] = p; }
  const sa = await api('/v1/subaccount/' + cfg.subaccountId);
  const sub = sa.name; const SID = sa.id;
  // is the key linked?
  let signer = null; try { signer = await api('/v1/linked-signer/address/' + w.address); } catch (e) { if (e.status !== 404) throw e; }
  if (!DRY && (!signer || signer.status !== 'ACTIVE')) throw new Error(`Signer ${w.address} is ${signer ? signer.status : 'not linked'} for this account: run "node copy-agent.mjs link" and finish it on the site (or run --dry).`);
  if (signer && signer.expiresAt && num(signer.expiresAt) * (num(signer.expiresAt) < 1e12 ? 1000 : 1) < Date.now() + 3 * 86400000) log('WARNING: the linked signer expires', new Date(num(signer.expiresAt) * (num(signer.expiresAt) < 1e12 ? 1000 : 1)).toISOString(), '- extend it from the site before then');
  const S = { dry: DRY, startedAt: Date.now(), paused: false, tripped: null, signer: w.address, owner: sa.account, subaccountId: SID, subaccountName: sub, leaders: cfg.leaders, sizing: cfg.sizing, risk: cfg.risk, execution: cfg.execution, books: {}, own: {}, equity: null, equityDayStart: null, equityPeak: null, dayKey: null, orders: [], events: [], errors: 0, lastError: null, ws: 'closed', leaderPos: {}, signerExpiresAt: signer && signer.expiresAt || null };
  const note = (kind, msg, extra) => { const e = Object.assign({ t: Date.now(), kind, msg }, extra || {}); S.events.unshift(e); if (S.events.length > 200) S.events.length = 200; log(kind, msg, extra || ''); };
  const push = async (title, msg) => { if (!(cfg.ntfy && cfg.ntfy.topic)) return; try { await fetch(((cfg.ntfy.server || 'https://ntfy.sh').replace(/\/+$/, '')) + '/' + encodeURIComponent(cfg.ntfy.topic), { method: 'POST', body: msg, headers: { Title: title, Tags: 'robot', Priority: '4' } }); } catch (_) {} };

  // ---- own account
  const refreshOwn = async () => {
    const [bal, pos, prices] = await Promise.all([api('/v1/subaccount/balance', { params: { subaccountId: SID, limit: 100 } }), api('/v1/position', { params: { subaccountId: SID, open: true, limit: 100 } }), api('/v1/product/market-price?' + products.filter((p) => p.status === 'ACTIVE').map((p) => 'productIds=' + p.id).join('&'))]);
    const mark = {}; for (const x of prices.data || []) mark[x.productId] = num(x.oraclePrice) || num(x.markPrice);
    const own = {}; let upnl = 0, notional = 0;
    if (DRY) { for (const [pid, o] of Object.entries(S.own || {})) { const m = mark[pid] || o.mark; const u = o.size * (m - o.entry); own[pid] = Object.assign({}, o, { mark: m, notional: Math.abs(o.size) * m, upnl: u }); upnl += u; notional += Math.abs(o.size) * m; } }   // the virtual book of a dry run
    else for (const p of pos.data || []) { const size = num(p.size); if (!size) continue; const m = mark[p.productId] || 0; const entry = Math.abs(size) ? num(p.cost) / Math.abs(size) : 0; const u = m && entry ? size * (m - entry) : num(p.unrealizedPnl); own[p.productId] = { size, entry, mark: m, notional: Math.abs(size) * m, upnl: u }; upnl += u; notional += Math.abs(size) * m; }
    const balance = (bal.data || []).reduce((a, b) => a + num(b.amount), 0);
    S.own = own; S.mark = mark; S.equity = balance + upnl; S.notional = notional; S.balance = balance;
    const day = new Date().toISOString().slice(0, 10);
    if (S.dayKey !== day) { S.dayKey = day; S.equityDayStart = S.equity; }
    if (S.equityPeak == null || S.equity > S.equityPeak) S.equityPeak = S.equity;
    // risk trips: a loss for the day, or a drawdown from the peak since start
    const r = cfg.risk || {};
    const dayLoss = S.equityDayStart - S.equity, dd = S.equityPeak > 0 ? ((S.equityPeak - S.equity) / S.equityPeak) * 100 : 0;
    if (!S.tripped && ((r.dailyLossStop && dayLoss >= r.dailyLossStop) || (r.drawdownStopPct && dd >= r.drawdownStopPct))) {
      S.tripped = { t: Date.now(), why: dayLoss >= (r.dailyLossStop || Infinity) ? `daily loss ${dayLoss.toFixed(2)} USD reached the stop of ${r.dailyLossStop}` : `drawdown ${dd.toFixed(1)}% reached the stop of ${r.drawdownStopPct}%` };
      note('trip', S.tripped.why); push('Copy agent stopped', S.tripped.why);
      if (r.onTrip === 'closeAll') await closeAll('risk stop');
    }
  };

  // ---- orders
  const dec = (s) => { const m = String(s).split('.'); return m[1] ? m[1].replace(/0+$/, '').length : 0; };
  const roundDown = (x, step) => { const d = dec(step); const st = num(step) || Math.pow(10, -d); return Number((Math.floor(x / st + 1e-9) * st).toFixed(d)); };
  const roundTick = (x, tick, up) => { const d = dec(tick); const st = num(tick) || 1; return Number(((up ? Math.ceil : Math.floor)(x / st) * st).toFixed(d)); };
  /** Sign and submit one order. side 0 buy / 1 sell. close: quantity 0 + reduceOnly closes the whole position. */
  async function place({ prod, side, qty, reduceOnly = false, close = false, why, leader }) {
    const ex = cfg.execution || {}; const mark = (S.mark && S.mark[prod.id]) || 0;
    let q = close ? 0 : roundDown(qty, prod.lotSize);
    if (!close && q < num(prod.minQuantity)) { note('skip', `${prod.displayTicker}: ${qty} is below the minimum ${prod.minQuantity}`, { leader }); return null; }
    if (!close && mark && q * mark < ((cfg.risk && cfg.risk.minOrderUsd) || 0)) { note('skip', `${prod.displayTicker}: ${(q * mark).toFixed(2)} USD is below minOrderUsd`, { leader }); return null; }
    const useLimit = !close && ex.type !== 'MARKET' && mark > 0;
    const px = useLimit ? roundTick(mark * (1 + (side === 0 ? 1 : -1) * ((ex.slippageBps || 15) / 1e4)), prod.tickSize, side === 0) : 0;
    const n = nonce(); const signedAt = Math.floor(Date.now() / 1000); const cid = randomUUID();
    const msg = { sender: w.address, subaccount: sub, quantity: BigInt(Math.round(q * 1e9)), price: BigInt(Math.round(px * 1e9)), reduceOnly: !!(reduceOnly || close), side, engineType: 0, productId: Number(prod.onchainId), nonce: n, signedAt };
    const signature = await sign(w, rpc, 'TradeOrder', msg);
    const data = { sender: w.address, subaccount: sub, quantity: String(q), side, engineType: 0, onchainId: Number(prod.onchainId), nonce: n.toString(), signedAt, type: useLimit ? 'LIMIT' : 'MARKET', reduceOnly: !!(reduceOnly || close), clientOrderId: cid };
    if (useLimit) { data.price = String(px); data.timeInForce = 'IOC'; }
    if (close) data.close = true;
    const rec = { t: Date.now(), leader, ticker: prod.displayTicker, side: side === 0 ? 'BUY' : 'SELL', qty: q, close, reduceOnly: data.reduceOnly, type: data.type, px: px || null, why, status: 'sent' };
    S.orders.unshift(rec); if (S.orders.length > 300) S.orders.length = 300;
    try {
      if (DRY) {   // the exchange checks margin and fields, places nothing
        const r = await api('/v1/order/dry-run', { method: 'POST', body: { data: Object.assign({}, data, { sender: sa.account }) } });
        rec.status = 'dry'; rec.margin = r && r.marginRequired != null ? num(r.marginRequired) : null;
        // as if filled at the limit (or the mark): the virtual book lets reductions and closes be seen too
        const fillPx = px || mark; const cur = S.own[prod.id]; const dq = close ? -(cur ? cur.size : 0) : (side === 0 ? q : -q);
        if (!cur) S.own[prod.id] = { size: dq, entry: fillPx, mark: fillPx, notional: Math.abs(dq) * fillPx, upnl: 0, virtual: true };
        else { const size = cur.size + dq; if (Math.abs(size) < 1e-12) delete S.own[prod.id]; else S.own[prod.id] = Object.assign(cur, { size, entry: Math.sign(size) === Math.sign(cur.size) && Math.abs(size) > Math.abs(cur.size) ? (cur.entry * Math.abs(cur.size) + fillPx * Math.abs(dq)) / Math.abs(size) : cur.entry }); }
        note('order', `DRY ${rec.side} ${close ? 'close' : q} ${prod.displayTicker} ${data.type}${px ? ' @ ' + px : ''} · ${why} · margin ${rec.margin}`);
      } else {
        const r = await api('/v1/order', { method: 'POST', body: { data, signature } });
        rec.status = 'accepted'; rec.id = r && r.id; rec.filled = r && r.filled != null ? num(r.filled) : null; rec.code = r && (r.resultCode || r.code);
        note('order', `${rec.side} ${close ? 'close' : q} ${prod.displayTicker} ${data.type}${px ? ' @ ' + px : ''} · ${why}`, { filled: rec.filled, id: rec.id });
      }
    } catch (e) {
      rec.status = 'rejected'; rec.error = e.message; S.errors++; S.lastError = { t: Date.now(), msg: e.message };
      note('error', `${prod.displayTicker} ${rec.side} rejected: ${e.message}`, { why }); push('Copy agent order rejected', `${prod.displayTicker} ${rec.side}: ${e.message}`);
    }
    await sleep(400); await refreshOwn().catch(() => {});
    return rec;
  }
  async function closeAll(why) { for (const [pid, o] of Object.entries(S.own)) { const prod = byId[pid]; if (prod && o.size) await place({ prod, side: o.size > 0 ? 1 : 0, qty: 0, close: true, why }); } }

  /** May a new or larger position be taken? The risk limits, in words when not. */
  const allowed = (prod, addNotional, leaderSid) => {
    const r = cfg.risk || {};
    if (S.paused) return 'paused';
    if (S.tripped) return 'risk stop is on (reduce-only)';
    if (r.markets && r.markets.deny && r.markets.deny.includes(prod.displayTicker)) return `${prod.displayTicker} is denied`;
    if (r.markets && r.markets.allow && r.markets.allow.length && !r.markets.allow.includes(prod.displayTicker)) return `${prod.displayTicker} is not in the allowed markets`;
    const cur = S.own[prod.id]; const curNotional = cur ? cur.notional : 0;
    if (r.maxNotionalPerMarket && curNotional + addNotional > r.maxNotionalPerMarket) return `would exceed ${r.maxNotionalPerMarket} USD in ${prod.displayTicker}`;
    if (r.maxOpenPositions && !cur && Object.keys(S.own).length >= r.maxOpenPositions) return `already ${r.maxOpenPositions} open positions`;
    if (r.maxLeverage && S.equity > 0 && (S.notional + addNotional) / S.equity > r.maxLeverage) return `would exceed ${r.maxLeverage}x leverage`;
    const owner = S.marketOwner[prod.id]; if (owner && owner !== leaderSid) return `${prod.displayTicker} is being copied from another leader`;
    return null;
  };

  // ---- leaders: books per leader and market, seeded from their open positions
  S.marketOwner = {};   // which leader our position in a market follows
  const seedLeader = async (l) => { const cur = {}; try { for (const p of (await api('/v1/position', { params: { subaccountId: l.sid, open: true, limit: 100 } })).data || []) cur[p.productId] = num(p.size); } catch (e) { note('warn', `could not read ${l.address.slice(0, 8)}'s positions: ${e.message}`); } S.leaderPos[l.sid] = cur; S.books[l.sid] = S.books[l.sid] || {}; };
  for (const l of cfg.leaders) await seedLeader(l);
  await refreshOwn();
  note('start', `copy agent up${DRY ? ' · DRY RUN, nothing is placed' : ''} · signer ${w.address} · ${cfg.leaders.length} leader(s) · equity ${S.equity.toFixed(2)} USD · sizing ${cfg.sizing.mode} ${cfg.sizing.mode === 'ratio' ? cfg.sizing.ratio + '%' : cfg.sizing.size + ' USD'}`);

  /** One leader order (its fills grouped): decide and place the mirror. */
  async function onLeaderOrder(l, prod, g) {
    const lp = S.leaderPos[l.sid] || (S.leaderPos[l.sid] = {}); const prev = lp[prod.id] || 0; const next = prev + g.q; lp[prod.id] = Math.abs(next) < 1e-12 ? 0 : next;
    const book = S.books[l.sid]; const px = g.notional / Math.abs(g.q);
    const own = S.own[prod.id]; const ownQty = own ? own.size : 0;
    const sz = cfg.sizing || { mode: 'fixed', size: 200 };
    const kind = !prev ? 'open' : !lp[prod.id] ? 'close' : Math.sign(next) !== Math.sign(prev) ? 'reverse' : Math.abs(next) > Math.abs(prev) ? 'add' : 'reduce';
    const who = l.name && l.name !== 'primary' ? l.name : l.address.slice(0, 6) + '…' + l.address.slice(-4);
    note('leader', `${who} ${kind} ${prod.displayTicker} ${g.q > 0 ? '+' : ''}${g.q} @ ${px}`);
    // what we hold in this market from this leader
    const mine = book[prod.id];
    const closeMine = async (why) => { if (ownQty && S.marketOwner[prod.id] === l.sid) { await place({ prod, side: ownQty > 0 ? 1 : 0, qty: 0, close: true, why, leader: who }); delete book[prod.id]; delete S.marketOwner[prod.id]; } };
    if (kind === 'close') return closeMine(`${who} closed`);
    if (kind === 'reduce') {
      if (!ownQty || S.marketOwner[prod.id] !== l.sid) return;
      const share = Math.abs(g.q) / Math.abs(prev); const q = Math.abs(ownQty) * share;
      return place({ prod, side: ownQty > 0 ? 1 : 0, qty: q, reduceOnly: true, why: `${who} reduced ${(share * 100).toFixed(0)}%`, leader: who });
    }
    if (kind === 'reverse') { await closeMine(`${who} reversed`); }
    // open, add, or the new leg of a reversal: size it
    const leaderDelta = kind === 'reverse' ? Math.abs(next) : Math.abs(g.q);
    let q;
    if (sz.mode === 'ratio') q = leaderDelta * (num(sz.ratio) / 100);
    else if (sz.mode === 'perfill') q = num(sz.size) / px;
    else {   // fixed: the opening order sets the scale, adds follow in proportion
      if (kind === 'open' || kind === 'reverse' || !mine) { const orderQty = g.orderQty && g.orderQty > leaderDelta ? g.orderQty : leaderDelta; const k = num(sz.size) / (orderQty * px); book[prod.id] = { k, openedAt: Date.now() }; q = leaderDelta * k; }
      else q = leaderDelta * mine.k;
    }
    const side = next > 0 ? 0 : 1; const addNotional = q * px;
    const no = allowed(prod, addNotional, l.sid);
    if (no) { note('skip', `${prod.displayTicker} ${kind}: ${no}`, { leader: who }); return; }
    if (!mine && !book[prod.id]) book[prod.id] = { k: q / leaderDelta, openedAt: Date.now() };
    S.marketOwner[prod.id] = l.sid;
    return place({ prod, side, qty: q, why: `${who} ${kind}`, leader: who });
  }

  // ---- socket: leaders' fills (grouped per order) and liquidations
  const pending = new Map(); const seen = new Set();
  const groupMs = (cfg.execution && cfg.execution.groupMs) || 1200;
  const onFill = (l, prod, f) => {
    const key = l.sid + '|' + prod.id + '|' + f.oid; const cur = pending.get(key);
    if (cur) { cur.q += f.q; cur.notional += Math.abs(f.q) * f.px; clearTimeout(cur.timer); cur.timer = setTimeout(() => flush(key), groupMs); return; }
    pending.set(key, { l, prod, q: f.q, notional: Math.abs(f.q) * f.px, oid: f.oid, timer: setTimeout(() => flush(key), groupMs) });
  };
  const flush = async (key) => {
    const g = pending.get(key); pending.delete(key); if (!g) return;
    if ((cfg.sizing || {}).mode === 'fixed' && g.oid) { try { const o = await api('/v1/order/' + g.oid); g.orderQty = num(o.quantity); } catch (_) {} }   // the whole order, not its first piece
    try { await onLeaderOrder(g.l, g.prod, g); } catch (e) { S.errors++; S.lastError = { t: Date.now(), msg: e.message }; note('error', e.message); }
  };
  let sock = null, retry = 0;
  const connect = () => {
    S.ws = 'connecting'; sock = new WebSocket(WS_URL);
    sock.onopen = () => { S.ws = 'open'; retry = 0; for (const l of cfg.leaders) { sock.send(JSON.stringify({ event: 'subscribe', data: { type: 'OrderFill', subaccountId: l.sid } })); sock.send(JSON.stringify({ event: 'subscribe', data: { type: 'SubaccountLiquidation', subaccountId: l.sid } })); } sock.send(JSON.stringify({ event: 'subscribe', data: { type: 'OrderFill', subaccountId: SID } })); };
    sock.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (_) { return; } S.lastMsg = Date.now(); route(m); };
    sock.onclose = () => { S.ws = 'closed'; setTimeout(connect, Math.min(15000, 500 * Math.pow(2, retry++))); };
    sock.onerror = () => {};
  };
  const route = (m) => {
    if (!m || !m.e) return; const d = m.data || {}; const items = Array.isArray(d.d) ? d.d : [d];
    for (const it of items) {
      const sid = it.sid || d.sid; const l = cfg.leaders.find((x) => x.sid === sid);
      if (m.e === 'OrderFill' && sid === SID) { refreshOwn().catch(() => {}); continue; }
      if (!l) continue;
      if (m.e === 'OrderFill') { const prod = byTicker[it.s]; if (!prod) continue; if (it.id) { if (seen.has(it.id)) continue; seen.add(it.id); if (seen.size > 5000) seen.delete(seen.values().next().value); } onFill(l, prod, { q: (String(it.sd) === '0' ? 1 : -1) * num(it.sz), px: num(it.px), oid: it.oid || it.id }); }
      else if (m.e === 'SubaccountLiquidation') { const prod = it.s ? byTicker[it.s] : null; note('leader', `${l.address.slice(0, 8)} was liquidated${prod ? ' on ' + prod.displayTicker : ''}`); push('Leader liquidated', `${l.address.slice(0, 8)}${prod ? ' on ' + prod.displayTicker : ''}`); if (prod && (cfg.execution || {}).onLeaderLiquidation !== 'hold') { S.leaderPos[l.sid][prod.id] = 0; const own = S.own[prod.id]; if (own && S.marketOwner[prod.id] === l.sid) place({ prod, side: own.size > 0 ? 1 : 0, qty: 0, close: true, why: 'leader liquidated', leader: l.address.slice(0, 8) }).then(() => { delete S.books[l.sid][prod.id]; delete S.marketOwner[prod.id]; }); } }
    }
  };
  connect();
  setInterval(() => { if (sock && sock.readyState === 1 && Date.now() - (S.lastMsg || S.startedAt) > 120000) { try { sock.close(); } catch (_) {} } }, 30000);   // a silent socket is a dead socket

  // ---- housekeeping: own account every 30 s, leaders' positions every 5 min (a fill missed over a reconnect, a leader gone flat)
  setInterval(() => refreshOwn().catch((e) => note('warn', 'own account: ' + e.message)), 30000);
  setInterval(async () => {
    for (const l of cfg.leaders) {
      const before = S.leaderPos[l.sid] || {}; await seedLeader(l); const after = S.leaderPos[l.sid];
      for (const pid of Object.keys(S.own)) {
        if (S.marketOwner[pid] !== l.sid) continue;
        if (!after[pid] && (cfg.execution || {}).onLeaderFlat !== 'hold') { const prod = byId[pid]; note('leader', `${l.address.slice(0, 8)} is flat in ${prod.displayTicker} (missed close or liquidation)`); await place({ prod, side: S.own[pid].size > 0 ? 1 : 0, qty: 0, close: true, why: 'leader flat', leader: l.address.slice(0, 8) }); delete S.books[l.sid][pid]; delete S.marketOwner[pid]; }
        else if (before[pid] && after[pid] && Math.sign(before[pid]) !== Math.sign(after[pid])) note('warn', `${byId[pid].displayTicker}: the leader's side changed while the socket was quiet; not mirrored`);
      }
    }
  }, 5 * 60000);

  // ---- local status port for the site's Copy agent page
  const port = (cfg.status && cfg.status.port) || 8790; const token = cfg.status && cfg.status.token;
  const okOrigin = (o) => !o || o === SITE || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  http.createServer(async (req, res) => {
    const origin = req.headers.origin; const cors = { 'Access-Control-Allow-Origin': okOrigin(origin) ? (origin || '*') : 'null', 'Access-Control-Allow-Headers': 'content-type, x-agent-token', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Content-Type': 'application/json' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (!okOrigin(origin)) { res.writeHead(403, cors); return res.end('{"error":"origin"}'); }
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/status') { res.writeHead(200, cors); return res.end(JSON.stringify(Object.assign({}, S, { uptime: Date.now() - S.startedAt, leaderPos: S.leaderPos, books: S.books, marketOwner: S.marketOwner, now: Date.now() }))); }
    if (req.method === 'POST') {
      if (token && req.headers['x-agent-token'] !== token) { res.writeHead(401, cors); return res.end('{"error":"token"}'); }
      if (url.pathname === '/pause') { S.paused = true; note('control', 'paused from the site'); }
      else if (url.pathname === '/resume') { S.paused = false; S.tripped = null; note('control', 'resumed from the site'); }
      else if (url.pathname === '/close-all') { note('control', 'close all from the site'); await closeAll('closed from the site'); }
      else if (url.pathname === '/simulate' && DRY) { let bodyTxt = ''; for await (const c of req) bodyTxt += c; const f = JSON.parse(bodyTxt || '{}'); const l = cfg.leaders[0]; const prod = Object.values(byId).find((p) => p.displayTicker === f.ticker); if (l && prod) { note('control', `simulated leader fill ${f.side} ${f.qty} ${f.ticker}`); route({ e: 'OrderFill', data: { sid: l.sid, d: [{ sid: l.sid, s: prod.ticker, sd: f.side === 'SELL' ? 1 : 0, sz: String(f.qty), px: String(f.px || (S.mark && S.mark[prod.id]) || 0), oid: 'sim-' + Date.now(), id: 'sim-' + Date.now() }] } }); } }
      else { res.writeHead(404, cors); return res.end('{"error":"unknown"}'); }
      res.writeHead(200, cors); return res.end('{"ok":true}');
    }
    res.writeHead(404, cors); res.end('{"error":"unknown"}');
  }).listen(port, '127.0.0.1', () => log(`status on http://127.0.0.1:${port}/status · open ${SITE}/#/copytrade/agent`));
  process.on('SIGINT', () => { note('stop', 'agent stopped (positions stay open)'); process.exit(0); });
}

// ---------------------------------------------------------------- main
const commands = { keygen, link, run, status, help: async () => console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?\s?/, '')) };
if (!commands[cmd]) { console.error('unknown command', cmd); process.exit(2); }
commands[cmd]().catch((e) => { console.error(e.message || e); process.exit(1); });
