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
 * documents, with the domain and type strings from /v1/rpc/config (the same maths as the official SDK).
 *
 * Facts this code relies on, each checked against the exchange (see README):
 *   - a position's `size` is signed (long > 0); its `fundingAccruedUsd` is positive when PAID (the ledger says so)
 *   - the order submission response's `filled` is deprecated and always 0: fills are read back from GET /v1/order/{id}
 *   - a close order is quantity "0" + reduceOnly + close (dry-run: Ok); an IOC limit fills what it can and cancels the rest
 *   - signedAt must be within the exchange's clock tolerance: the clock offset to /v1/time is measured and applied
 *   - a signer's expiresAt is in milliseconds; a revoked signer makes every order fail with SignerRevoked
 *   - a position record's updatedAt is the time of its last fill, which tells a fill already inside a freshly read
 *     position size from one that still has to be added (a resync and the socket must not count a fill twice)
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
const FINAL = new Set(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);

// ---------------------------------------------------------------- files
const configPath = path.resolve(here, opt('config', 'config.json'));
const readConfig = () => { if (!fs.existsSync(configPath)) throw new Error(`No ${configPath}. Build one on the site's Copy agent page (or copy config.example.json).`); return JSON.parse(fs.readFileSync(configPath, 'utf8')); };
const keyPath = (cfg) => path.resolve(here, (cfg && cfg.keyFile) || 'signer.key');
const readKey = (cfg) => { const p = keyPath(cfg); if (!fs.existsSync(p)) throw new Error(`No signer key at ${p}: run "node copy-agent.mjs keygen" first.`); return new Wallet(fs.readFileSync(p, 'utf8').trim()); };
const statePath = path.join(here, 'state.json');
const logDir = path.join(here, 'logs'); fs.mkdirSync(logDir, { recursive: true });
const log = (...a) => { const line = `${new Date().toISOString()} ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`; console.log(line); try { fs.appendFileSync(path.join(logDir, 'agent-' + new Date().toISOString().slice(0, 10) + '.log'), line + '\n'); } catch (_) {} };

// ---------------------------------------------------------------- exchange
let clockOffset = 0;   // server time − local time, ms
const serverNow = () => Date.now() + clockOffset;
async function api(pathname, { method = 'GET', body, params } = {}) {
  const url = new URL(API + pathname); if (params) for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, String(v));
  const r = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (_) {}
  if (!r.ok) { const e = new Error((j && (Array.isArray(j.message) ? j.message.join('; ') : j.message)) || `HTTP ${r.status}`); e.status = r.status; e.body = j; throw e; }
  return j;
}
const nonce = (() => { let last = 0n; return () => { let n = BigInt(serverNow()) * 1000000n; if (n <= last) n = last + 1n; last = n; return n; }; })();
const typesOf = (rpc, primary) => ({ [primary]: rpc.signatureTypes[primary].split(',').map((f) => { const [type, name] = f.trim().split(' '); return { name, type }; }) });
async function sign(wallet, rpc, primary, message) {
  const domain = { name: rpc.domain.name, version: rpc.domain.version, chainId: Number(rpc.domain.chainId), verifyingContract: rpc.domain.verifyingContract };
  return wallet.signTypedData(domain, typesOf(rpc, primary), message);
}
async function syncClock() { try { const t = await api('/v1/time'); clockOffset = num(t.time) - Date.now(); } catch (_) {} return clockOffset; }

// ---------------------------------------------------------------- commands
async function keygen() {
  const cfg = fs.existsSync(configPath) ? readConfig() : null; const p = keyPath(cfg);
  if (fs.existsSync(p) && opt('force') == null) { const w = readKey(cfg); console.log(`A signer key already exists at ${p}\nAddress: ${w.address}\n(--force to replace it; the old address stays linked until you revoke it on the exchange)`); return; }
  const w = Wallet.createRandom();
  fs.writeFileSync(p, w.privateKey + '\n', { mode: 0o600 });
  console.log(`Signer key written to ${p}\nAddress: ${w.address}\n\nThis key can only submit and cancel orders once linked; it can never withdraw. Keep the file private anyway.\nNext: node copy-agent.mjs link`);
}

async function link() {
  const cfg = readConfig(); const w = readKey(cfg); await syncClock();
  if (!ethers.isAddress(cfg.owner)) throw new Error('config.owner must be your wallet address');
  const sa = await api('/v1/subaccount/' + cfg.subaccountId);
  if (String(sa.account).toLowerCase() !== cfg.owner.toLowerCase()) throw new Error(`Subaccount ${cfg.subaccountId} belongs to ${sa.account}, not config.owner`);
  const rpc = await api('/v1/rpc/config');
  const data = { sender: ethers.getAddress(cfg.owner), signer: w.address, subaccount: sa.name, subaccountId: sa.id, nonce: nonce().toString(), signedAt: Math.floor(serverNow() / 1000), category: 'API', name: 'MeridianDataHub copy agent' };
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
  const ex = Object.assign({ type: 'IOC', slippageBps: 15, groupMs: 1200, onLeaderFlat: 'close', onLeaderLiquidation: 'close', onOrphan: 'hold' }, cfg.execution || {});
  const risk = Object.assign({ maxNotionalPerMarket: 0, maxOpenPositions: 0, maxLeverage: 0, dailyLossStop: 0, drawdownStopPct: 0, minOrderUsd: 0, markets: {}, onTrip: 'reduceOnly' }, cfg.risk || {});
  const sizing = Object.assign({ mode: 'fixed', size: 200, ratio: 10 }, cfg.sizing || {});
  // a fixed-size copy follows the leader's adds in proportion, so a leader who opens small and scales in would make a
  // position any multiple of `size`; without a per-market cap of your own, five times the size is the most one gets
  const MAX_SCALE = 5; let capDerived = false;
  if (sizing.mode !== 'ratio' && !(num(risk.maxNotionalPerMarket) > 0)) { risk.maxNotionalPerMarket = MAX_SCALE * num(sizing.size); capDerived = true; }
  const offset = await syncClock();
  const rpc = await api('/v1/rpc/config');
  const products = (await api('/v1/product?limit=200')).data || [];
  const byId = {}, byTicker = {}; for (const p of products) { byId[p.id] = p; byTicker[p.ticker] = p; }
  const sa = await api('/v1/subaccount/' + cfg.subaccountId);
  const sub = sa.name; const SID = sa.id;
  if (String(sa.account).toLowerCase() !== String(cfg.owner || '').toLowerCase()) throw new Error(`Subaccount ${SID} belongs to ${sa.account}, not config.owner ${cfg.owner}`);
  let signer = null; try { signer = await api('/v1/linked-signer/address/' + w.address); } catch (e) { if (e.status !== 404) throw e; }
  if (!DRY && (!signer || signer.status !== 'ACTIVE')) throw new Error(`Signer ${w.address} is ${signer ? signer.status : 'not linked'} for this account: run "node copy-agent.mjs link" and finish it on the site (or run --dry).`);

  // persisted state: what we follow from whom, so a restart does not orphan positions
  let saved = {}; try { saved = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (_) {}
  const S = { dry: DRY, startedAt: Date.now(), paused: !!saved.paused, tripped: saved.tripped || null, signer: w.address, owner: sa.account, subaccountId: SID, subaccountName: sub, leaders: cfg.leaders, sizing, risk, execution: ex,
    books: saved.books || {}, marketOwner: saved.marketOwner || {}, own: {}, mark: {}, equity: null, balance: 0, notional: 0, ownAt: 0, equityDayStart: saved.equityDayStart || null, dayKey: saved.dayKey || null, equityPeak: saved.equityPeak || null, flowsDay: 0, flowsSinceStart: 0, orders: (saved.orders || []).slice(0, 1000), events: [], errors: 0, lastError: null, ws: 'closed', leaderPos: {}, leaderPosAt: {}, resyncAt: {}, leaderSeeded: {}, signerExpiresAt: signer ? num(signer.expiresAt) : null, clockOffset: offset, orphans: [] };
  const persist = () => { try { fs.writeFileSync(statePath, JSON.stringify({ paused: S.paused, tripped: S.tripped, books: S.books, marketOwner: S.marketOwner, equityDayStart: S.equityDayStart, dayKey: S.dayKey, equityPeak: S.equityPeak, orders: S.orders.slice(0, 1000), savedAt: Date.now() })); } catch (_) {} };
  const note = (kind, msg, extra) => { const e = Object.assign({ t: Date.now(), kind, msg }, extra || {}); S.events.unshift(e); if (S.events.length > 300) S.events.length = 300; log(kind, msg, extra || ''); };
  const push = async (title, msg) => { if (!(cfg.ntfy && cfg.ntfy.topic)) return; try { await fetch(((cfg.ntfy.server || 'https://ntfy.sh').replace(/\/+$/, '')) + '/' + encodeURIComponent(cfg.ntfy.topic), { method: 'POST', body: msg, headers: { Title: title, Tags: 'robot', Priority: '4' } }); } catch (_) {} };
  const who = (l) => (l.name && l.name !== 'primary' ? l.name : l.address.slice(0, 6) + '…' + l.address.slice(-4));

  // ---- one thing at a time: every decision and order goes through this queue, so two leader orders arriving
  //      together cannot both size against the same stale position
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  // ---- own account: balances, positions, marks, and the deposits / withdrawals that must not count as PnL
  const dayKeyOf = (t) => new Date(t).toISOString().slice(0, 10);
  const dayStartMs = () => Date.parse(dayKeyOf(serverNow()) + 'T00:00:00Z');
  const flows = async (since) => { try { const rows = (await api('/v1/token/transfer', { params: { subaccountId: SID, createdAfter: since, limit: 100 } })).data || []; return rows.reduce((a, t) => { const ty = String(t.type || '').toUpperCase(); const amt = num(t.amount); return a + (/DEPOSIT/.test(ty) ? amt - num(t.fee) : /WITHDRAW/.test(ty) ? -(amt + num(t.fee)) : 0); }, 0); } catch (_) { return 0; } };
  const refreshOwn = async () => {
    const [bal, pos, prices] = await Promise.all([api('/v1/subaccount/balance', { params: { subaccountId: SID, limit: 100 } }), api('/v1/position', { params: { subaccountId: SID, open: true, limit: 100 } }), api('/v1/product/market-price?' + products.filter((p) => p.status === 'ACTIVE').map((p) => 'productIds=' + p.id).join('&'))]);
    const mark = {}; for (const x of prices.data || []) mark[x.productId] = num(x.oraclePrice) || num(x.markPrice);
    const own = {}; let upnl = 0, notional = 0;
    if (DRY) { for (const [pid, o] of Object.entries(S.own || {})) { const m = mark[pid] || o.mark; const u = o.size * (m - o.entry); own[pid] = Object.assign({}, o, { mark: m, notional: Math.abs(o.size) * m, upnl: u }); upnl += u; notional += Math.abs(o.size) * m; } }   // the virtual book of a dry run
    else for (const p of pos.data || []) { const size = num(p.size); if (!size) continue; const m = mark[p.productId] || 0; const entry = Math.abs(size) ? num(p.cost) / Math.abs(size) : 0; const u = m && entry ? size * (m - entry) : num(p.unrealizedPnl); own[p.productId] = { size, entry, mark: m, notional: Math.abs(size) * m, upnl: u }; upnl += u; notional += Math.abs(size) * m; }
    const balance = (bal.data || []).reduce((a, b) => a + num(b.amount), 0);
    S.own = own; S.mark = mark; S.equity = balance + upnl; S.notional = notional; S.balance = balance; S.ownAt = Date.now();
    const day = dayKeyOf(serverNow());
    if (S.dayKey !== day) { S.dayKey = day; S.equityDayStart = S.equity; S.flowsDay = 0; }
    else S.flowsDay = await flows(dayStartMs());
    S.flowsSinceStart = await flows(S.startedAt);
    if (S.equityPeak == null) S.equityPeak = S.equity;
    const adjEquity = S.equity - S.flowsSinceStart;   // deposits since start do not raise the peak, withdrawals do not count as loss
    if (adjEquity > S.equityPeak) S.equityPeak = adjEquity;
    S.dayPnl = S.equity - S.equityDayStart - S.flowsDay;
    S.ddPct = S.equityPeak > 0 ? ((S.equityPeak - adjEquity) / S.equityPeak) * 100 : 0;
    if (!S.tripped && ((risk.dailyLossStop && -S.dayPnl >= risk.dailyLossStop) || (risk.drawdownStopPct && S.ddPct >= risk.drawdownStopPct))) {
      S.tripped = { t: Date.now(), why: -S.dayPnl >= (risk.dailyLossStop || Infinity) ? `today's loss ${(-S.dayPnl).toFixed(2)} USD reached the stop of ${risk.dailyLossStop}` : `drawdown ${S.ddPct.toFixed(1)}% reached the stop of ${risk.drawdownStopPct}%` };
      note('trip', S.tripped.why); push('Copy agent stopped', S.tripped.why); persist();
      if (risk.onTrip === 'closeAll') await closeAll('risk stop');
    }
    persist();
  };
  /** Positions read again until the exchange shows the order's effect (or three tries), then the book is refreshed. */
  const settle = async (pid, before) => { for (let i = 0; i < 4; i++) { await sleep(i ? 700 : 300); await refreshOwn().catch(() => {}); const now = S.own[pid] ? S.own[pid].size : 0; if (Math.abs(now - before) > 1e-12 || i === 3) return now; } return S.own[pid] ? S.own[pid].size : 0; };

  // ---- orders
  const dec = (s) => { const m = String(s).split('.'); return m[1] ? m[1].replace(/0+$/, '').length : 0; };
  const roundDown = (x, step) => { const d = dec(step); const st = num(step) || Math.pow(10, -d); return Number((Math.floor(x / st + 1e-9) * st).toFixed(d)); };
  const roundTick = (x, tick, up) => { const d = dec(tick); const st = num(tick) || 1; return Number(((up ? Math.ceil : Math.floor)(x / st) * st).toFixed(d)); };
  /** Sign, submit and read back one order. side 0 buy / 1 sell. close: quantity 0 + reduceOnly closes the whole position. */
  async function place({ prod, side, qty, reduceOnly = false, close = false, why, leader, leaderSid, leaderPx, leaderT, kind, resync = false }) {
    const mark = S.mark[prod.id] || 0;
    let q = close ? 0 : roundDown(Math.min(qty, num(prod.maxQuantity) || Infinity), prod.lotSize);
    if (!close && q < num(prod.minQuantity)) { note('skip', `${prod.displayTicker}: ${qty} is below the minimum ${prod.minQuantity}`, { leader }); return null; }
    if (!close && mark && q * mark < (risk.minOrderUsd || 0)) { note('skip', `${prod.displayTicker}: ${(q * mark).toFixed(2)} USD is below minOrderUsd`, { leader }); return null; }
    if (!close && !mark) { note('skip', `${prod.displayTicker}: no mark price, not trading blind`, { leader }); return null; }
    const useLimit = !close && ex.type !== 'MARKET';
    const px = useLimit ? roundTick(mark * (1 + (side === 0 ? 1 : -1) * ((ex.slippageBps || 15) / 1e4)), prod.tickSize, side === 0) : 0;
    const n = nonce(); const signedAt = Math.floor(serverNow() / 1000); const cid = randomUUID();
    const msg = { sender: w.address, subaccount: sub, quantity: BigInt(Math.round(q * 1e9)), price: BigInt(Math.round(px * 1e9)), reduceOnly: !!(reduceOnly || close), side, engineType: 0, productId: Number(prod.onchainId), nonce: n, signedAt };
    const signature = await sign(w, rpc, 'TradeOrder', msg);
    const data = { sender: w.address, subaccount: sub, quantity: String(q), side, engineType: 0, onchainId: Number(prod.onchainId), nonce: n.toString(), signedAt, type: useLimit ? 'LIMIT' : 'MARKET', reduceOnly: !!(reduceOnly || close), clientOrderId: cid };
    if (useLimit) { data.price = String(px); data.timeInForce = 'IOC'; }
    if (close) data.close = true;
    const before = S.own[prod.id] ? S.own[prod.id].size : 0;
    const rec = { t: Date.now(), leader, leaderSid: leaderSid || null, leaderPx: leaderPx || null, leaderT: leaderT || null, kind: kind || (close ? 'close' : reduceOnly ? 'reduce' : 'open'), cid, pid: prod.id, ticker: prod.displayTicker, side: side === 0 ? 'BUY' : 'SELL', qty: q, close, reduceOnly: data.reduceOnly, type: data.type, px: px || null, mark, why, status: 'sent', before, fills: [], resync: !!resync };
    S.orders.unshift(rec); if (S.orders.length > 1000) S.orders.length = 1000;
    try {
      if (DRY) {   // the exchange checks margin and fields, places nothing; a virtual book stands in for the fill
        const r = await api('/v1/order/dry-run', { method: 'POST', body: { data: Object.assign({}, data, { sender: sa.account }) } });
        rec.status = 'dry'; rec.margin = r && r.marginRequired != null ? num(r.marginRequired) : null; rec.code = r && r.code;
        const fillPx = px || mark; const cur = S.own[prod.id]; const dq = close ? -(cur ? cur.size : 0) : (side === 0 ? q : -q);
        if (!cur) { if (dq) S.own[prod.id] = { size: dq, entry: fillPx, mark: fillPx, notional: Math.abs(dq) * fillPx, upnl: 0, virtual: true }; }
        else { const size = cur.size + dq; if (Math.abs(size) < 1e-12) delete S.own[prod.id]; else S.own[prod.id] = Object.assign(cur, { size, entry: Math.sign(size) === Math.sign(cur.size) && Math.abs(size) > Math.abs(cur.size) ? (cur.entry * Math.abs(cur.size) + fillPx * Math.abs(dq)) / Math.abs(size) : cur.entry }); }
        rec.filled = close ? Math.abs(before) : q; rec.after = S.own[prod.id] ? S.own[prod.id].size : 0; rec.id = 'dry-' + cid.slice(0, 8);
        if (rec.filled) rec.fills.push({ id: 'dry-' + cid, t: Date.now(), px: fillPx, qty: rec.filled, fee: rec.filled * fillPx * (num(prod.takerFee) || 0.0003), maker: false, virtual: true });
        note('order', `DRY ${rec.side} ${close ? 'close' : q} ${prod.displayTicker} ${data.type}${px ? ' @ ' + px : ''} · ${why} · margin ${rec.margin} · ${rec.code}`);
      } else {
        const r = await api('/v1/order', { method: 'POST', body: { data, signature } });
        rec.id = r && r.id; rec.code = r && r.result; rec.status = 'accepted';
        // the submission response's `filled` is deprecated (always 0): read the order back until it is final
        let o = null; for (let i = 0; i < 8; i++) { await sleep(i ? 500 : 250); try { o = await api('/v1/order/' + rec.id); } catch (_) {} if (o && FINAL.has(o.status)) break; }
        if (o) { rec.orderStatus = o.status; rec.filled = num(o.filled); rec.reason = o.rejectedReason || null; }
        rec.after = await settle(prod.id, before);
        const got = close ? Math.abs(before - rec.after) : Math.abs(rec.after - before);
        rec.status = rec.orderStatus === 'REJECTED' ? 'rejected' : got < 1e-12 ? 'unfilled' : Math.abs(got - (close ? Math.abs(before) : q)) > num(prod.lotSize) ? 'partial' : 'filled';
        note(rec.status === 'filled' ? 'order' : 'warn', `${rec.side} ${close ? 'close' : q} ${prod.displayTicker} ${data.type}${px ? ' @ ' + px : ''} · ${why} · ${rec.status}${rec.filled != null ? ' ' + rec.filled : ''}${rec.reason ? ' · ' + rec.reason : ''}`, { id: rec.id });
        if (rec.reason === 'SignerRevoked' || rec.code === 'SignerRevoked') { S.paused = true; note('error', 'the signer was revoked: paused; link a new one on the site'); push('Copy agent paused', 'signer revoked'); }
      }
    } catch (e) {
      rec.status = 'rejected'; rec.error = e.message; S.errors++; S.lastError = { t: Date.now(), msg: e.message };
      note('error', `${prod.displayTicker} ${rec.side} rejected: ${e.message}`, { why }); push('Copy agent order rejected', `${prod.displayTicker} ${rec.side}: ${e.message}`);
      if (/SignerRevoked|Unauthorized/i.test(e.message) || e.status === 401) { S.paused = true; note('error', 'the exchange no longer accepts this signer: paused'); }
    }
    if (DRY) await refreshOwn().catch(() => {});
    persist();
    return rec;
  }
  async function closeAll(why) { for (const [pid, o] of Object.entries(S.own)) { const prod = byId[pid]; if (prod && o.size) await place({ prod, side: o.size > 0 ? 1 : 0, qty: 0, close: true, why }); } }
  const closeMarket = async (pid, why, leaderName, ctxL) => { const o = S.own[pid]; const prod = byId[pid]; if (!o || !o.size || !prod) return null; const r = await place(Object.assign({ prod, side: o.size > 0 ? 1 : 0, qty: 0, close: true, why, leader: leaderName }, ctxL || {}, { kind: 'close' })); if (!S.own[pid]) { for (const b of Object.values(S.books)) delete b[pid]; delete S.marketOwner[pid]; } return r; };

  /** May a new or larger position be taken? The reason, in words, when not. */
  const allowed = (prod, addNotional, leaderSid) => {
    if (S.paused) return 'paused';
    if (S.tripped) return 'risk stop is on (reduce-only)';
    if (Date.now() - S.ownAt > 120000) return 'own account data is stale (exchange unreachable?)';
    if (!S.leaderSeeded[leaderSid]) return 'leader positions not read yet';
    if (risk.markets && risk.markets.deny && risk.markets.deny.includes(prod.displayTicker)) return `${prod.displayTicker} is denied`;
    if (risk.markets && risk.markets.allow && risk.markets.allow.length && !risk.markets.allow.includes(prod.displayTicker)) return `${prod.displayTicker} is not in the allowed markets`;
    const cur = S.own[prod.id]; const curNotional = cur ? cur.notional : 0;
    if (risk.maxNotionalPerMarket && curNotional + addNotional > risk.maxNotionalPerMarket) return `would exceed ${risk.maxNotionalPerMarket} USD in ${prod.displayTicker}`;
    if (num(prod.maxPositionNotionalUsd) && curNotional + addNotional > num(prod.maxPositionNotionalUsd)) return `would exceed the market's position cap`;
    if (risk.maxOpenPositions && !cur && Object.keys(S.own).length >= risk.maxOpenPositions) return `already ${risk.maxOpenPositions} open positions`;
    if (risk.maxLeverage && S.equity > 0 && (S.notional + addNotional) / S.equity > risk.maxLeverage) return `would exceed ${risk.maxLeverage}x leverage`;
    if (S.equity <= 0) return 'no equity';
    const owner = S.marketOwner[prod.id]; if (owner && owner !== leaderSid) return `${prod.displayTicker} is being copied from another leader`;
    return null;
  };
  /** How much notional may still be added in a market under the per-market cap, the market's own cap and the leverage
   *  limit: an order that would overshoot is cut to this rather than dropped, so the copy stays as close as the limits allow. */
  const roomFor = (prod) => {
    const cur = S.own[prod.id]; const curNotional = cur ? cur.notional : 0; let room = Infinity;
    if (risk.maxNotionalPerMarket) room = Math.min(room, risk.maxNotionalPerMarket - curNotional);
    if (num(prod.maxPositionNotionalUsd)) room = Math.min(room, num(prod.maxPositionNotionalUsd) - curNotional);
    if (risk.maxLeverage && S.equity > 0) room = Math.min(room, risk.maxLeverage * S.equity - S.notional);
    return room;
  };

  // ---- leaders: positions seeded from the exchange, resynced on every hint and every five minutes
  // A position record's updatedAt is the time of the last fill in it, so a fill whose time is at or before the record's
  // updatedAt is already inside the size that was read; the socket's copy of that fill must not be added on top
  // (a resync landing while an order's fills are still being grouped would otherwise count them twice and, say, take
  // a close for a reversal). Open records carry the sizes; the newest records carry the updatedAt of recent closes.
  const readLeader = async (l) => {
    const [openR, recentR] = await Promise.all([api('/v1/position', { params: { subaccountId: l.sid, open: true, limit: 100 } }), api('/v1/position', { params: { subaccountId: l.sid, limit: 50 } })]);
    const pos = {}, at = {};
    for (const p of (openR.data || []).concat(recentR.data || [])) { const t = num(p.updatedAt) || num(p.createdAt); if (t > (at[p.productId] || 0)) at[p.productId] = t; }
    for (const p of openR.data || []) if (num(p.size)) pos[p.productId] = num(p.size);
    return { pos, at };
  };
  const seedLeader = async (l) => { try { const r = await readLeader(l); S.leaderPos[l.sid] = r.pos; S.leaderPosAt[l.sid] = r.at; S.leaderSeeded[l.sid] = true; } catch (e) { S.leaderSeeded[l.sid] = false; note('warn', `could not read ${who(l)}'s positions: ${e.message}; not copying its openings until it can be read`); } S.books[l.sid] = S.books[l.sid] || {}; };
  for (const l of cfg.leaders) await seedLeader(l);
  await refreshOwn();

  // ---- preflight: what would make an order fail or a result mislead
  if (Math.abs(offset) > 5000) note('warn', `this machine's clock is ${(offset / 1000).toFixed(1)} s off the exchange's; corrected for signing`);
  if (!DRY && signer && num(signer.expiresAt) && num(signer.expiresAt) < Date.now() + 3 * 86400000) { note('warn', `the linked signer expires ${new Date(num(signer.expiresAt)).toISOString()}: extend it before then`); push('Copy agent signer expiring', new Date(num(signer.expiresAt)).toISOString()); }
  if (S.equity <= 0) note('warn', 'the copy account has no equity; nothing can be opened');
  if (ex.type === 'MARKET') note('warn', 'execution.type is MARKET: the only slippage protection is the exchange\'s own cap (MarketOrderReachedMaxSlippage); IOC with a bps cap is safer');
  if (sizing.mode !== 'ratio' && num(sizing.size) < (risk.minOrderUsd || 0)) note('warn', `sizing.size ${sizing.size} is below risk.minOrderUsd ${risk.minOrderUsd}: every order would be skipped`);
  if (capDerived) note('start', `risk.maxNotionalPerMarket is not set: using ${MAX_SCALE} × sizing.size = ${risk.maxNotionalPerMarket} USD per market, the most a position may grow to when a leader adds to it`);
  if (sizing.mode !== 'ratio' && num(risk.maxNotionalPerMarket) < num(sizing.size)) note('warn', `risk.maxNotionalPerMarket ${risk.maxNotionalPerMarket} is below sizing.size ${sizing.size}: every opening is cut to the cap`);
  // what the last run followed in markets we no longer hold is forgotten (a close while the agent was down)
  for (const pid of Object.keys(S.marketOwner)) if (!S.own[pid]) { delete S.marketOwner[pid]; for (const bk of Object.values(S.books)) delete bk[pid]; }
  // positions already open on the copy account: adopt the ones a leader also holds, flag the rest
  for (const [pid, o] of Object.entries(S.own)) {
    if (S.marketOwner[pid] && cfg.leaders.some((l) => l.sid === S.marketOwner[pid])) continue;   // remembered from the last run
    const l = cfg.leaders.find((l) => (S.leaderPos[l.sid] || {})[pid] && Math.sign(S.leaderPos[l.sid][pid]) === Math.sign(o.size));
    if (l) { S.marketOwner[pid] = l.sid; S.books[l.sid][pid] = { k: Math.abs(o.size / S.leaderPos[l.sid][pid]), openedAt: Date.now(), adopted: true }; note('start', `${byId[pid].displayTicker}: adopted the open position as a copy of ${who(l)}`); }
    else { S.orphans.push(pid); note('warn', `${byId[pid].displayTicker}: an open position no leader holds (orphan); ${ex.onOrphan === 'close' ? 'closing it' : 'left alone — close it yourself or set execution.onOrphan to "close"'}`); if (ex.onOrphan === 'close') await closeMarket(pid, 'orphan on start'); }
  }
  persist();
  note('start', `copy agent up${DRY ? ' · DRY RUN, nothing is placed' : ''} · signer ${w.address} · ${cfg.leaders.length} leader(s) · equity ${S.equity.toFixed(2)} USD · sizing ${sizing.mode} ${sizing.mode === 'ratio' ? sizing.ratio + '%' : sizing.size + ' USD'} · ${ex.type}${ex.type === 'IOC' ? ' ±' + ex.slippageBps + ' bps' : ''}`);

  /** One leader order (its fills grouped): decide and place the mirror. Runs inside the serial queue. */
  async function onLeaderOrder(l, prod, g) {
    const lp = S.leaderPos[l.sid] || (S.leaderPos[l.sid] = {}); const at = (S.leaderPosAt[l.sid] || {})[prod.id] || 0;
    // fills at or before the last read of the leader's positions are already inside that size: classify from it, do not add
    const qIn = (g.parts || []).reduce((a, p) => a + (p.t > 0 && p.t <= at ? p.q : 0), 0);
    const prev = (lp[prod.id] || 0) - qIn;
    const next = prev + g.q; lp[prod.id] = Math.abs(next) < 1e-12 ? 0 : next;
    const book = S.books[l.sid] || (S.books[l.sid] = {}); const px = g.notional / Math.abs(g.q);
    const own = S.own[prod.id]; const ownQty = own ? own.size : 0; const followed = S.marketOwner[prod.id] === l.sid;
    const kind = !prev ? 'open' : !lp[prod.id] ? 'close' : Math.sign(next) !== Math.sign(prev) ? 'reverse' : Math.abs(next) > Math.abs(prev) ? 'add' : 'reduce';
    const name = who(l);
    note('leader', `${name} ${kind} ${prod.displayTicker} ${g.q > 0 ? '+' : ''}${g.q} @ ${px}`);
    const ctxL = { leaderSid: l.sid, leaderPx: px, leaderT: g.t || Date.now(), kind };
    if (kind === 'close') { if (followed && ownQty) await closeMarket(prod.id, `${name} closed`, name, ctxL); return; }
    if (kind === 'reduce') {
      if (!followed || !ownQty) return;
      // a resync that read the position after every fill of this order already mirrored the reduction
      const r = S.resyncAt[prod.id]; if (r && (g.parts || []).every((p) => p.t > 0 && p.t <= r)) { note('leader', `${prod.displayTicker} reduce: already mirrored by the resync`); return; }
      const share = Math.abs(g.q) / Math.abs(prev); const q = Math.abs(ownQty) * share;
      await place(Object.assign({ prod, side: ownQty > 0 ? 1 : 0, qty: q, reduceOnly: true, why: `${name} reduced ${(share * 100).toFixed(0)}%`, leader: name }, ctxL));
      return;
    }
    if (kind === 'reverse' && followed && ownQty) await closeMarket(prod.id, `${name} reversed`, name, ctxL);
    const ownNow = S.own[prod.id] ? S.own[prod.id].size : 0;
    // open, add, or the new leg of a reversal
    const leaderDelta = kind === 'reverse' ? Math.abs(next) : Math.abs(g.q);
    let q;
    if (sizing.mode === 'ratio') q = leaderDelta * (num(sizing.ratio) / 100);
    else if (sizing.mode === 'perfill') q = num(sizing.size) / px;
    else if (kind === 'add' && followed && ownNow && prev) q = leaderDelta * Math.abs(ownNow / prev);   // in proportion to what we actually hold
    else { const orderQty = g.orderQty && g.orderQty > leaderDelta ? g.orderQty : leaderDelta; const k = num(sizing.size) / (orderQty * px); book[prod.id] = { k, openedAt: Date.now() }; q = leaderDelta * k; }
    if (kind === 'add' && !followed && ownNow) { note('skip', `${prod.displayTicker} add: we hold a position here that is not a copy of ${name}`); return; }
    const side = next > 0 ? 0 : 1;
    // the size limits cut the order to what they allow (a leader scaling in beyond the cap is followed up to it);
    // everything else (paused, stopped, stale data, denied market, another leader's market, no equity) skips it
    const room = roomFor(prod); let why = `${name} ${kind}`;
    if (q * px > room) {
      const mkt = S.own[prod.id] ? S.own[prod.id].notional : 0;
      const minUsd = Math.max(num(prod.minQuantity) * px, risk.minOrderUsd || 0);
      if (room < minUsd) { note('skip', `${prod.displayTicker} ${kind}: ${allowed(prod, q * px, l.sid) || 'at the size limit'} (${mkt.toFixed(0)} USD held)`, { leader: name }); return; }
      note('leader', `${prod.displayTicker} ${kind}: ${(q * px).toFixed(0)} USD cut to ${room.toFixed(0)} USD by the size limits`, { leader: name });
      q = room / px; why += ' (cut to the size limit)';
    }
    const no = allowed(prod, q * px, l.sid);
    if (no) { note('skip', `${prod.displayTicker} ${kind}: ${no}`, { leader: name }); return; }
    const r = await place(Object.assign({ prod, side, qty: q, why, leader: name }, ctxL, { kind: kind === 'reverse' ? 'open' : kind }));
    if (r && S.own[prod.id] && Math.sign(S.own[prod.id].size) === (side === 0 ? 1 : -1)) { S.marketOwner[prod.id] = l.sid; book[prod.id] = book[prod.id] || { k: q / leaderDelta, openedAt: Date.now() }; }
    persist();
  }

  /** Compare a leader's positions with what we last knew and mirror what the socket may have missed. */
  async function resync(l, why) {
    let read; try { read = await readLeader(l); } catch (e) { note('warn', `resync ${who(l)}: ${e.message}`); return; }
    const after = read.pos; const before = S.leaderPos[l.sid] || {}; S.leaderPos[l.sid] = after; S.leaderPosAt[l.sid] = read.at; S.leaderSeeded[l.sid] = true;
    for (const pid of Object.keys(S.own)) {
      if (S.marketOwner[pid] !== l.sid) continue;
      // fills of this market still being grouped: the flush mirrors them with the read just taken, so nothing is done twice
      if (Array.from(pending.keys()).some((k) => k.startsWith(l.sid + '|' + pid + '|'))) continue;
      const prod = byId[pid]; const b = before[pid] || 0, a = after[pid] || 0; const ownQty = S.own[pid].size;
      const ctxL = { leaderSid: l.sid, leaderPx: S.mark[pid] || null, leaderT: Date.now() };   // the leader's own price is unknown here: the mark stands in, flagged
      const acted = () => { S.resyncAt[pid] = read.at[pid] || Date.now(); };   // a fill of that time or earlier is covered by this
      if (!a) { if (ex.onLeaderFlat !== 'hold' && (why !== 'liquidation' || ex.onLeaderLiquidation !== 'hold')) { note('leader', `${who(l)} is flat in ${prod.displayTicker} (${why})`); acted(); await closeMarket(pid, `leader flat (${why})`, who(l), Object.assign({ resync: true }, ctxL)); } }
      else if (Math.sign(a) !== Math.sign(ownQty)) { note('leader', `${who(l)} is on the other side in ${prod.displayTicker} (${why}); closing ours, not chasing`); acted(); await closeMarket(pid, `leader reversed (${why})`, who(l), Object.assign({ resync: true }, ctxL)); }
      else if (b && Math.abs(a) < Math.abs(b) - 1e-12) { const share = 1 - Math.abs(a) / Math.abs(b); note('leader', `${who(l)} reduced ${prod.displayTicker} by ${(share * 100).toFixed(0)}% while the socket was quiet`); acted(); await place(Object.assign({ prod, side: ownQty > 0 ? 1 : 0, qty: Math.abs(ownQty) * share, reduceOnly: true, why: `${who(l)} reduced (${why})`, leader: who(l), kind: 'reduce', resync: true }, ctxL)); }
    }
    persist();
  }

  // ---- socket: leaders' fills (grouped per order), anything else about a leader triggers a resync
  const attachFill = (fl) => { if (!fl.orderId) return; const rec = S.orders.find((r) => r.id === fl.orderId); if (!rec) return; if (rec.fills.some((x) => x.id === fl.id)) return; rec.fills.push({ id: fl.id, t: fl.t, px: fl.px, qty: fl.qty, fee: fl.fee, maker: fl.maker }); persist(); };
  // fills that arrived while the agent was down: read back for every recorded order that has fewer fills than its size
  const backfillFills = async () => { try { const rows = (await api('/v1/order/fill', { params: { subaccountId: SID, limit: 100 } })).data || []; for (const f of rows) attachFill({ id: f.id, orderId: f.orderId, t: num(f.createdAt), px: num(f.price), qty: num(f.filled), fee: num(f.feeUsd), maker: !!f.isMaker }); } catch (_) {} };
  if (!DRY) await backfillFills();
  const pending = new Map(); const seen = new Set();
  const onFill = (l, prod, f) => {
    const key = l.sid + '|' + prod.id + '|' + f.oid; const cur = pending.get(key);
    if (cur) { cur.q += f.q; cur.notional += Math.abs(f.q) * f.px; cur.t = Math.max(cur.t, f.t); cur.parts.push({ q: f.q, t: f.t }); clearTimeout(cur.timer); cur.timer = setTimeout(() => flush(key), ex.groupMs); return; }
    pending.set(key, { l, prod, q: f.q, notional: Math.abs(f.q) * f.px, oid: f.oid, t: f.t, parts: [{ q: f.q, t: f.t }], timer: setTimeout(() => flush(key), ex.groupMs) });
  };
  const flush = (key) => serial(async () => {
    const g = pending.get(key); pending.delete(key); if (!g) return;
    if (sizing.mode === 'fixed' && g.oid && !/^sim-/.test(g.oid)) { try { const o = await api('/v1/order/' + g.oid); g.orderQty = num(o.quantity); } catch (_) {} }   // the whole order, not its first piece
    try { await onLeaderOrder(g.l, g.prod, g); } catch (e) { S.errors++; S.lastError = { t: Date.now(), msg: e.message }; note('error', e.message); }
  });
  let sock = null, retry = 0;
  const connect = () => {
    S.ws = 'connecting'; sock = new WebSocket(WS_URL);
    sock.onopen = () => { S.ws = 'open'; retry = 0; for (const l of cfg.leaders) for (const type of ['OrderFill', 'PositionUpdate', 'SubaccountLiquidation']) sock.send(JSON.stringify({ event: 'subscribe', data: { type, subaccountId: l.sid } })); sock.send(JSON.stringify({ event: 'subscribe', data: { type: 'OrderFill', subaccountId: SID } })); if (S.lastMsg) for (const l of cfg.leaders) serial(() => resync(l, 'reconnect')); };
    sock.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (_) { return; } S.lastMsg = Date.now(); route(m); };
    sock.onclose = () => { S.ws = 'closed'; setTimeout(connect, Math.min(15000, 500 * Math.pow(2, retry++))); };
    sock.onerror = () => {};
  };
  const route = (m) => {
    if (!m || !m.e) return; const d = m.data || {}; const items = Array.isArray(d.d) ? d.d : [d];
    for (const it of items) {
      const sid = it.sid || d.sid; const l = cfg.leaders.find((x) => x.sid === sid);
      if (m.e === 'OrderFill' && sid === SID) { attachFill({ id: it.id, orderId: it.oid, t: num(it.t || d.t) || Date.now(), px: num(it.px), qty: num(it.sz), fee: num(it.fee), maker: !!it.m }); serial(() => refreshOwn().catch(() => {})); continue; }
      if (!l) continue;
      if (m.e === 'OrderFill') { const prod = byTicker[it.s]; if (!prod) continue; if (it.id) { if (seen.has(it.id)) continue; seen.add(it.id); if (seen.size > 5000) seen.delete(seen.values().next().value); } onFill(l, prod, { q: (String(it.sd) === '0' ? 1 : -1) * num(it.sz), px: num(it.px), oid: it.oid || it.id, t: num(it.t || d.t) || Date.now() }); }
      else if (m.e === 'SubaccountLiquidation') { note('leader', `${who(l)}: liquidation event`); push('Leader liquidated', who(l)); setTimeout(() => serial(() => resync(l, 'liquidation')), 1500); }
      else if (m.e === 'PositionUpdate') { clearTimeout(S._pu); S._pu = setTimeout(() => serial(() => resync(l, 'position update')), 4000); }   // after the fills of the same order have been handled
    }
  };
  connect();
  setInterval(() => { if (sock && sock.readyState === 1 && Date.now() - (S.lastMsg || S.startedAt) > 120000) { try { sock.close(); } catch (_) {} } }, 30000);   // a silent socket is a dead socket
  setInterval(() => serial(() => refreshOwn().catch((e) => note('warn', 'own account: ' + e.message))), 30000);
  setInterval(() => { for (const l of cfg.leaders) serial(() => resync(l, 'periodic')); }, 5 * 60000);

  // ---- local status port for the site's Copy agent page (127.0.0.1 only; origin-checked; token for anything that acts)
  const port = (cfg.status && cfg.status.port) || 8790; const token = cfg.status && cfg.status.token;
  const okOrigin = (o) => !o || o === SITE || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  http.createServer(async (req, res) => {
    const origin = req.headers.origin; const cors = { 'Access-Control-Allow-Origin': okOrigin(origin) ? (origin || '*') : 'null', 'Access-Control-Allow-Headers': 'content-type, x-agent-token', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Content-Type': 'application/json' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (!okOrigin(origin)) { res.writeHead(403, cors); return res.end('{"error":"origin"}'); }
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/status') { res.writeHead(200, cors); return res.end(JSON.stringify(Object.assign({}, S, { _pu: undefined, uptime: Date.now() - S.startedAt, now: Date.now() }))); }
    if (req.method === 'POST') {
      if (token && req.headers['x-agent-token'] !== token) { res.writeHead(401, cors); return res.end('{"error":"token"}'); }
      let bodyTxt = ''; for await (const c of req) bodyTxt += c; let bodyJ = {}; try { bodyJ = JSON.parse(bodyTxt || '{}'); } catch (_) {}
      if (url.pathname === '/pause') { S.paused = true; note('control', 'paused from the site'); persist(); }
      else if (url.pathname === '/resume') { S.paused = false; S.tripped = null; note('control', 'resumed from the site'); persist(); }
      else if (url.pathname === '/close-all') { note('control', 'close all from the site'); await serial(() => closeAll('closed from the site')); }
      else if (url.pathname === '/resync') { note('control', 'resync from the site'); for (const l of cfg.leaders) await serial(() => resync(l, 'manual')); await serial(() => refreshOwn().catch(() => {})); }
      else if (url.pathname === '/simulate' && DRY) { const l = cfg.leaders[0]; const prod = Object.values(byId).find((p) => p.displayTicker === bodyJ.ticker); if (l && prod) { note('control', `simulated leader fill ${bodyJ.side} ${bodyJ.qty} ${bodyJ.ticker}`); route({ e: 'OrderFill', data: { sid: l.sid, d: [{ sid: l.sid, s: prod.ticker, sd: bodyJ.side === 'SELL' ? 1 : 0, sz: String(bodyJ.qty), px: String(bodyJ.px || S.mark[prod.id] || 0), t: bodyJ.t ? num(bodyJ.t) : undefined, oid: bodyJ.oid || 'sim-' + Date.now(), id: 'sim-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) }] } }); } }
      else { res.writeHead(404, cors); return res.end('{"error":"unknown"}'); }
      res.writeHead(200, cors); return res.end('{"ok":true}');
    }
    res.writeHead(404, cors); res.end('{"error":"unknown"}');
  }).listen(port, '127.0.0.1', () => log(`status on http://127.0.0.1:${port}/status · open ${SITE}/#/copytrade/agent`));
  process.on('SIGINT', () => { note('stop', 'agent stopped (positions stay open; the next start adopts them)'); persist(); process.exit(0); });
}

// ---------------------------------------------------------------- main
const commands = { keygen, link, run, status, help: async () => console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?\s?/, '')) };
if (!commands[cmd]) { console.error('unknown command', cmd); process.exit(2); }
commands[cmd]().catch((e) => { console.error(e.message || e); process.exit(1); });
