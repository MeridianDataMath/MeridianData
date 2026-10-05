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
 *                                              Also --dry-run, or COPY_AGENT_DRY=1. Through npm: npm run dry, or
 *                                              npm start -- --dry (the "--" hands the flag to the agent; without it npm
 *                                              keeps the flag, and the agent only catches it in npm's environment).
 *   node copy-agent.mjs status                 what the running agent is doing (from its local status port)
 *   --config <file>                            another config than config.json (any command)
 *
 * Any argument the agent does not know stops it, so node copy-agent.mjs run --dyr (or npm start -- --dyr) exits without
 * starting. A misspelt flag typed before the "--" (npm start --dyr) stays with npm and the agent starts live, so
 * npm run dry is the safest way to start a dry run. Either way, its first line says DRY RUN or LIVE.
 *
 * Non-custodial by construction: the signer key is a Meridian linked signer (submit / cancel orders only), generated
 * and kept on this machine; the owner wallet signs the link once in the browser. Public data only otherwise: leaders'
 * fills come from the exchange WebSocket, prices from the REST API. Every order is EIP-712 signed the way the exchange
 * documents, with the domain and type strings from /v1/rpc/config (the same maths as the official SDK).
 *
 * Facts this code relies on, each checked against the exchange (see README):
 *   - a position's `size` is signed (long > 0); its `fundingAccruedUsd` is positive when PAID (the ledger says so)
 *   - an open position's `fundingUsd` and `positionFeeUsd` are funding and position fees charged but not yet settled into
 *     the balance (positive when paid; `cost` is unsigned): Meridian's Trade Equity is Σ pool amounts + Σ (mark − |cost ÷
 *     size|) × size − Σ fundingUsd − Σ positionFeeUsd, and the agent's equity is the same figure (checked against the app
 *     on a live account: balance + gross uPnL was $1,192.92 above its Trade Equity, exactly the $820.33 funding and
 *     $372.59 position fee unsettled)
 *   - the order submission response's `filled` is deprecated and always 0: fills are read back from GET /v1/order/{id}
 *   - a close order is quantity "0" + reduceOnly + close (dry-run: Ok); an IOC limit fills what it can and cancels the rest
 *   - signedAt must be within the exchange's clock tolerance: the clock offset to /v1/time is measured and applied, again
 *     every five minutes and after a rejection about the time (that order is then signed afresh and sent once more)
 *   - the WebSocket drops a connection after about a minute without a message: the Ticker stream keeps it busy
 *   - a signer's expiresAt is in milliseconds; a revoked signer makes every order fail with SignerRevoked
 *   - a position record's updatedAt is the time of its last fill, which tells a fill already inside a freshly read
 *     position size from one that still has to be added (a resync and the socket must not count a fill twice)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Wallet, ethers } from 'ethers';

const here = path.dirname(fileURLToPath(import.meta.url));
const API = 'https://api.meridian.xyz';
const WS_URL = 'wss://ws.meridian.xyz/v1/stream';
const SITE = 'https://meridian.thedatahub.xyz';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the copy decisions (pure)
// No I/O and nothing from the rest of this file: tests/agent.test.mjs loads exactly the lines between the markers and
// checks them, so the arithmetic the agent trades on is covered without the exchange, a key or ethers.
// @pure-begin
const num = (x) => { const n = typeof x === 'number' ? x : parseFloat(String(x)); return Number.isFinite(n) ? n : 0; };
const dec = (s) => { const m = String(s).split('.'); return m[1] ? m[1].replace(/0+$/, '').length : 0; };
/** down to a multiple of the market's lot size (never more than asked) */
const roundDown = (x, step) => { const d = dec(step); const st = num(step) || Math.pow(10, -d); return Number((Math.floor(x / st + 1e-9) * st).toFixed(d)); };
/** to the market's tick, up or down (a buy's limit rounds up, a sell's down: the cap is never tighter than asked) */
const roundTick = (x, tick, up) => { const d = dec(tick); const st = num(tick) || 1; return Number(((up ? Math.ceil : Math.floor)(x / st) * st).toFixed(d)); };
/** open / add / reduce / close / reverse, from the leader's position before and after its order */
const classify = (prev, next) => (!prev ? 'open' : !next ? 'close' : Math.sign(next) !== Math.sign(prev) ? 'reverse' : Math.abs(next) > Math.abs(prev) ? 'add' : 'reduce');
/**
 * The quantity for an opening, an add or a reversal's new leg. ratio: that share of the leader's quantity; perfill: `size`
 * USD per group of fills; fixed: the leader's whole opening order (orderQty, not its first piece, less any part of it
 * that closed an old position: openingOrderQty) becomes `size` USD, and an add of
 * a position we follow scales with what we hold less what earlier reductions still owe. Returns {q, k}: k is the copy
 * ratio fixed at a fixed-size opening (null otherwise).
 */
const sizeOrder = (sizing, { kind, leaderDelta, px, followed, ownNow, prev, orderQty, owed = 0 }) => {
  if (sizing.mode === 'ratio') return { q: leaderDelta * (num(sizing.ratio) / 100), k: null };
  if (sizing.mode === 'perfill') return { q: num(sizing.size) / px, k: null };
  if (kind === 'add' && followed && ownNow && prev) return { q: leaderDelta * Math.max(0, Math.abs(ownNow) - owed) / Math.abs(prev), k: null };
  const oq = orderQty && orderQty > leaderDelta ? orderQty : leaderDelta; const k = num(sizing.size) / (oq * px);
  return { q: leaderDelta * k, k };
};
/**
 * One open position of the copy account from its /v1/position record, as Meridian's app books it: entry = |cost ÷ size|
 * (the app's avgPrice), uPnL GROSS at the mark (what the app's positions table shows; without a mark the exchange's own
 * unrealizedPnl stands in), and the funding and position fee charged on it but not yet settled into the balance
 * (fundingUsd, positionFeeUsd: positive when paid). null for a flat record.
 */
const ownPosition = (p, m) => {
  const size = num(p.size); if (!size) return null;
  const entry = Math.abs(num(p.cost) / size); const mk = num(m);
  return { size, entry, mark: mk, notional: Math.abs(size) * mk, upnl: mk && entry ? size * (mk - entry) : num(p.unrealizedPnl), funding: num(p.fundingUsd), posFee: num(p.positionFeeUsd) };
};
/** Funding and position fees charged on the open positions and not yet settled into the balance, USD (+ = paid) */
const unsettledOf = (own) => Object.values(own || {}).reduce((a, o) => a + num(o.funding) + num(o.posFee), 0);
/**
 * The equity every risk figure counts on (today's loss, the drawdown, the leverage cap, "no equity"): Meridian's Trade
 * Equity, i.e. the balance (every pool's amount) plus the positions' gross uPnL less what is charged on them and not yet
 * settled. Without that last part a position paying funding looked flat until the charge settled into the balance, and
 * the daily-loss stop then saw the whole accumulated charge as one loss at that moment.
 */
const tradeEquity = (balance, own) => Object.values(own || {}).reduce((a, o) => a + num(o.upnl), num(balance)) - unsettledOf(own);
/**
 * A state.json from an agent that counted equity before the unsettled charges (no equityNet in it) holds the day's loss
 * baseline and the drawdown peak on that gross basis: both move onto the net one by what is unsettled at the first
 * reading, so the upgrade alone is neither a loss nor a drawdown (what was charged between that baseline and the reading
 * cannot be told apart and is not counted). null stays null (not saved).
 */
const toNetBasis = (saved, unsettled) => ({ equityDayStart: saved.equityDayStart != null ? saved.equityDayStart - unsettled : null, equityPeak: saved.equityPeak != null ? saved.equityPeak - unsettled : null });
/** USD that may still be added in a market under the per-market cap, the market's own cap, the leverage limit (on
 *  equity: tradeEquity) and the hard ceilings per position and per order (the agent always sets the last two; 0 here means
 *  "none" for the tests) */
const roomLeft = ({ curNotional = 0, maxPerMarket = 0, marketCap = 0, maxLeverage = 0, equity = 0, totalNotional = 0, maxPosition = 0, maxOrder = 0 }) => {
  let room = Infinity;
  if (maxPerMarket) room = Math.min(room, maxPerMarket - curNotional);
  if (marketCap) room = Math.min(room, marketCap - curNotional);
  if (maxLeverage && equity > 0) room = Math.min(room, maxLeverage * equity - totalNotional);
  if (maxPosition) room = Math.min(room, maxPosition - curNotional);
  if (maxOrder) room = Math.min(room, maxOrder);
  return room;
};
/** An order the size limits would overshoot is cut to the room left, or skipped when that is below the smallest order */
const fitToRoom = (q, px, room, minUsd) => (q * px <= room ? { q, cut: false, skip: false } : room < minUsd ? { q: 0, cut: false, skip: true } : { q: room / px, cut: true, skip: false });
/** A reduction: `share` of what should be held (what is held less what is owed), plus what earlier reductions still owe */
const reduceQty = (held, share, owed = 0) => { const a = Math.abs(held); const o = Math.min(owed, a); return Math.min(a, (a - o) * share + o); };
/** In the fixed modes a per-market cap left at 0 becomes five times the size: proportional adds would otherwise make a
 *  position any multiple of it. null: keep the config's. */
const MAX_SCALE = 5;
const defaultCap = (sizing, risk) => (sizing.mode !== 'ratio' && !(num(risk.maxNotionalPerMarket) > 0) ? MAX_SCALE * num(sizing.size) : null);
/** Limits that hold in every sizing mode, ratio included; a config that leaves one out gets the default here, never "no
 *  limit". maxPriceDeviationPct: a leader fill further than this from the mark is not copied (the books sometimes hold
 *  only stub quotes, and one tiny trade there would size a copy as if the market were that cheap). maxFillAgeMs: a
 *  leader fill that reaches a decision older than this (a reconnect, a long queue) is listed as missed, not copied. */
const LIMITS = { maxOrderUsd: 1000, maxPositionUsd: 5000, maxPriceDeviationPct: 3, maxFillAgeMs: 15000 };
/** What in a config must stop the agent before it trades, in words (empty: nothing). Left out is fine (a default). */
const checkConfig = (cfg) => {
  const e = []; const s = cfg.sizing || {}, r = cfg.risk || {}, x = cfg.execution || {};
  const want = (obj, where, key, min, above, max) => {
    const v = obj[key]; if (v == null) return;
    if (typeof v !== 'number' || !Number.isFinite(v) || (above ? v <= min : v < min) || (max != null && v > max)) e.push(`${where}.${key} is ${JSON.stringify(v)}: it must be a number ${above ? 'above' : 'of at least'} ${min}${max != null ? ' and at most ' + max : ''}`);
  };
  if (s.mode != null && !['fixed', 'perfill', 'ratio'].includes(s.mode)) e.push(`sizing.mode is ${JSON.stringify(s.mode)}: it must be fixed, perfill or ratio`);
  // only the field the chosen mode uses: the page writes 0 into the other one when it is left empty
  if ((s.mode == null ? 'fixed' : s.mode) === 'ratio') want(s, 'sizing', 'ratio', 0, true); else want(s, 'sizing', 'size', 0, true);
  want(r, 'risk', 'maxOrderUsd', 0, true); want(r, 'risk', 'maxPositionUsd', 0, true); want(r, 'risk', 'maxPriceDeviationPct', 0, true, 50);
  for (const k of ['maxNotionalPerMarket', 'maxOpenPositions', 'maxLeverage', 'dailyLossStop', 'drawdownStopPct', 'minOrderUsd']) want(r, 'risk', k, 0, false);
  // a plain-http ntfy server other than this machine would carry the pushes (and the topic, the only secret) in the clear
  const nt = cfg.ntfy || {}; if (nt.server != null && nt.server !== '' && !/^https:\/\/[^\s/]|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(String(nt.server))) e.push(`ntfy.server is ${JSON.stringify(nt.server)}: it must be an https:// address (plain http only on localhost)`);
  want(x, 'execution', 'maxFillAgeMs', 0, true); want(x, 'execution', 'slippageBps', 0, false); want(x, 'execution', 'groupMs', 0, false);
  return e;
};
/** Why a leader's fill price must not size or gate an order (null: it may). A missing or zero price makes any quantity
 *  look cheap, and a print far from the mark (a stub quote, a hostile trade) would size the copy at that price. */
const priceProblem = (px, mark, maxDevPct) => {
  if (!(px > 0) || !Number.isFinite(px)) return `the leader's fill price is missing or unusable (${px})`;
  if (!(mark > 0) || !Number.isFinite(mark)) return 'no mark price';
  const dev = Math.abs(px / mark - 1) * 100;
  return dev > maxDevPct ? `the leader filled at ${px}, ${dev.toFixed(1)}% off the mark ${mark} (the limit is ${maxDevPct}%)` : null;
};
/** The command line, strictly: an argument it does not know is an error, never ignored, so a mistyped --dry cannot start
 *  a live run. Dry also comes from COPY_AGENT_DRY and from npm (`npm start --dry` keeps the flag for npm, which hands it
 *  on as npm_config_dry_run); a value there that is neither on nor off is an error too. */
const FLAGS = { keygen: ['config', 'force'], link: ['config'], run: ['config', 'dry', 'dry-run'], status: ['config'], help: [] };
const parseArgs = (argv, env) => {
  const cmd = argv[0] == null || argv[0] === '--help' || argv[0] === '-h' ? 'help' : argv[0];
  const o = { cmd, dry: false, force: false, config: 'config.json', error: null };
  const fail = (msg) => Object.assign(o, { error: msg });
  if (!Object.prototype.hasOwnProperty.call(FLAGS, cmd)) return fail(`unknown command "${cmd}": keygen, link, run, status or help`);
  for (let i = 1; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m || !FLAGS[cmd].includes(m[1])) return fail(`unknown argument "${argv[i]}" for ${cmd} (it takes ${FLAGS[cmd].map((f) => '--' + f).join(', ') || 'none'})`);
    if (m[1] === 'config') { const v = m[2] != null ? m[2] : argv[++i]; if (!v || v.startsWith('-')) return fail('--config needs a file name'); o.config = v; }
    else if (m[2] != null) return fail(`--${m[1]} takes no value`);
    else if (m[1] === 'force') o.force = true;
    else o.dry = true;
  }
  if (cmd === 'run') for (const k of Object.keys(env || {})) {
    if (k !== 'COPY_AGENT_DRY' && !/^npm_config_.*dry/i.test(k)) continue;
    const v = String(env[k]).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(v)) o.dry = true;
    else if (!['', '0', 'false', 'no', 'off'].includes(v)) return fail(`${k}=${env[k]} is neither on (1) nor off (0)`);
  }
  return o;
};
/** state.json's content, or why it cannot be trusted: a file cut short or garbled must not pass for a fresh start (that
 *  would drop a tripped stop and the day's loss baseline). Only the shape is checked. */
const parseState = (text) => {
  let s; try { s = JSON.parse(text); } catch (e) { return { error: 'not valid JSON (' + e.message + ')' }; }
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { error: 'not an object' };
  for (const k of ['books', 'marketOwner', 'carry']) if (s[k] != null && (typeof s[k] !== 'object' || Array.isArray(s[k]))) return { error: k + ' is garbled' };
  if (s.orders != null && !Array.isArray(s.orders)) return { error: 'orders is garbled' };
  if (s.tripped != null && (typeof s.tripped !== 'object' || typeof s.tripped.why !== 'string')) return { error: 'tripped is garbled' };
  for (const k of ['equityDayStart', 'equityPeak', 'savedAt', 'dayBaseAt', 'peakSince']) if (s[k] != null && !Number.isFinite(s[k])) return { error: k + ' is garbled' };
  if (s.equityNet != null && typeof s.equityNet !== 'boolean') return { error: 'equityNet is garbled' };
  if (s.dayKey != null && !/^\d{4}-\d{2}-\d{2}$/.test(s.dayKey)) return { error: 'dayKey is garbled' };
  return { state: s };
};
/** The day's loss baseline: the first reading of a UTC day starts it, and deposits and withdrawals count from that
 *  reading (one made earlier that day is already inside it). A state file without dayBaseAt (an older agent) starts a
 *  fresh baseline rather than counting from 00:00. */
const dayBaseline = (prev, { day, readAt, equity }) => (prev.dayKey !== day || !prev.dayBaseAt ? { dayKey: day, equityDayStart: equity, dayBaseAt: readAt, fresh: true } : { dayKey: prev.dayKey, equityDayStart: prev.equityDayStart, dayBaseAt: prev.dayBaseAt, fresh: false });
/** The drawdown peak from state.json with the time flows count from; a peak saved without that time (an older agent)
 *  is dropped, the flows it was measured against being unknown */
const restorePeak = (saved, now) => (saved && saved.equityPeak != null && saved.peakSince ? { equityPeak: saved.equityPeak, peakSince: saved.peakSince } : { equityPeak: null, peakSince: now });
/** Per market, from a leader's open position records and its newest records: the open size, the time of the last fill
 *  in it, and whether the newest record ended in a liquidation */
const leaderRead = (openRows, recentRows) => {
  const pos = {}, at = {}, liq = {};
  for (const p of (openRows || []).concat(recentRows || [])) { const t = num(p.updatedAt) || num(p.createdAt); if (t > (at[p.productId] || 0)) { at[p.productId] = t; liq[p.productId] = !num(p.size) && !!p.isLiquidated; } }
  for (const p of openRows || []) if (num(p.size)) { pos[p.productId] = num(p.size); liq[p.productId] = false; }
  return { pos, at, liq };
};
/** A market we copy where the leader is now flat: the liquidation option when its last record there is a liquidation
 *  (or a liquidation prompted the re-read), the flat option otherwise */
const flatAction = (ex, wasLiq) => ((wasLiq ? ex.onLeaderLiquidation : ex.onLeaderFlat) === 'hold' ? 'hold' : 'close');
/** A resync in a market whose leader is flat: close ours or hold it; a held copy of a liquidated position is no longer
 *  followed (listed as an orphan), since the leader's next trade there starts something new */
const resyncFlat = (ex, wasLiq) => { const action = flatAction(ex, wasLiq); return { action, unfollow: action === 'hold' && !!wasLiq }; };
/** Deposits and withdrawals for the risk stops: the fresh reads, else the last full read (the day's only on the same UTC
 *  day), else 0. The stops keep running when the transfer list cannot be read: the last amounts can only miss a transfer
 *  made since, and a missed withdrawal counts as a loss, which errs towards stopping. read: { day, peak }, null = unreadable */
const flowsForStops = (read, last, dayKey) => {
  const day = read.day != null ? read.day : last && last.dayKey === dayKey && last.day != null ? last.day : 0;
  const peak = read.peak != null ? read.peak : last && last.peak != null ? last.peak : 0;
  return { day, peak, stale: read.day == null || read.peak == null };
};
/** The part of a leader order that closed the old position before it reversed (the new side is sized on the rest) */
const closedByOrder = (prev, q) => (prev && Math.sign(q) !== Math.sign(prev) ? Math.min(Math.abs(q), Math.abs(prev)) : 0);
const openingOrderQty = (orderQty, closed) => (orderQty ? Math.max(0, orderQty - (closed || 0)) : orderQty);
/** A rejection that says the order's time or nonce was off: worth one retry after measuring the clock again */
const isClockReject = (status, msg) => status >= 400 && status < 500 && status !== 401 && status !== 403 && /signed.?at|timestamp|clock|nonce|expired|too (old|early|late|far)|in the future/i.test(String(msg || ''));
/** The control port answers to its own name only: a DNS-rebinding page reaches 127.0.0.1 under a name of its own, and
 *  the browser sends that name as Host */
const hostOk = (host, port) => { const h = String(host || '').toLowerCase(); return h === '127.0.0.1:' + port || h === 'localhost:' + port; };
// @pure-end
const FINAL = new Set(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);
const ARGS = parseArgs(process.argv.slice(2), process.env);
if (ARGS.error) { console.error(`${ARGS.error}\nNothing was started. "node copy-agent.mjs help" lists the commands.`); process.exit(2); }

// ---------------------------------------------------------------- files
const configPath = path.resolve(here, ARGS.config);
const readConfig = () => { if (!fs.existsSync(configPath)) throw new Error(`No ${configPath}. Build one on the site's Copy agent page (or copy config.example.json).`); return JSON.parse(fs.readFileSync(configPath, 'utf8')); };
const keyPath = (cfg) => path.resolve(here, (cfg && cfg.keyFile) || 'signer.key');
const readKey = (cfg) => { const p = keyPath(cfg); if (!fs.existsSync(p)) throw new Error(`No signer key at ${p}: run "node copy-agent.mjs keygen" first.`); return new Wallet(fs.readFileSync(p, 'utf8').trim()); };
/**
 * Only the current user may read a file the agent keeps a secret in. POSIX honours the 0o600 it is written with; Windows
 * ignores that mode and the file inherits its folder's ACL (on a drive root: every signed-in account), so the inheritance
 * is cut and the current user alone is granted access. Returns what went wrong, or null.
 */
const restrictFile = (p) => {
  try {
    if (process.platform !== 'win32') { fs.chmodSync(p, 0o600); return null; }
    const me = (process.env.USERDOMAIN ? process.env.USERDOMAIN + '\\' : '') + os.userInfo().username;
    execFileSync('icacls', [p, '/inheritance:r', '/grant:r', me + ':F'], { stdio: 'pipe', windowsHide: true });
    return null;
  } catch (e) { return String((e.stderr && e.stderr.toString().trim()) || e.message); }
};
/** Whether others may read the key, in words (null: only this user, or it cannot be told) */
const keyExposure = (p) => {
  try {
    if (process.platform !== 'win32') { const m = fs.statSync(p).mode & 0o777; return m & 0o077 ? `${p} can be read by other users (mode ${m.toString(8)}): chmod 600 it` : null; }
    const acl = execFileSync('icacls', [p], { stdio: 'pipe', windowsHide: true }).toString();
    return /\(I\)/.test(acl) ? `${p} still inherits its folder's permissions, so other accounts on this PC may read it: icacls "${p}" /inheritance:r /grant:r "%USERNAME%:F" limits it to you (keygen does that for new keys)` : null;
  } catch (_) { return null; }
};
/**
 * The control port's token: the config's status.token, or, when that is empty (or the old example's "change-me"), one
 * generated once and kept in control.token next to the script for the owner to paste into the page. A short one stops
 * the agent: the token is all that stands between a local web page and close-all.
 */
const tokenPath = path.join(here, 'control.token');
const controlToken = (cfg, create) => {
  const t = String((cfg.status && cfg.status.token) || '').trim();
  if (t && t !== 'change-me') { if (t.length < 16) throw new Error('config status.token is shorter than 16 characters: leave it empty to have one generated, or use 16 or more random characters (the site\'s Copy agent page makes one).'); return { token: t, from: 'config status.token' }; }
  try { const f = fs.readFileSync(tokenPath, 'utf8').trim(); if (f.length >= 16) return { token: f, from: tokenPath }; } catch (_) {}
  if (!create) return { token: null, from: null };
  const token = randomBytes(24).toString('base64url');
  fs.writeFileSync(tokenPath, '', { mode: 0o600 }); restrictFile(tokenPath); fs.writeFileSync(tokenPath, token + '\n');
  return { token, from: tokenPath, created: true };
};
const statePath = path.join(here, 'state.json');
/**
 * The saved state, and what went wrong reading it. No file is a fresh start. A file that is there but cannot be read or
 * trusted is kept as state.json.damaged, the save before it (state.json.bak) stands in when it can, and `damaged` says so:
 * the agent then starts with its risk stop set, because what was lost may be a tripped stop or the day's loss baseline.
 */
const loadState = () => {
  let r; try { r = parseState(fs.readFileSync(statePath, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return { saved: {} }; r = { error: e.message }; }
  if (!r.error) return { saved: r.state };
  try { fs.copyFileSync(statePath, statePath + '.damaged'); } catch (_) {}
  let bak = null; try { const b = parseState(fs.readFileSync(statePath + '.bak', 'utf8')); if (!b.error) bak = b.state; } catch (_) {}
  return { saved: bak || {}, damaged: `state.json could not be read (${r.error}; kept as state.json.damaged)` + (bak ? `, so the save before it (state.json.bak, ${bak.savedAt ? new Date(bak.savedAt).toISOString() : 'undated'}) stands in` : ', and there is no usable backup: the day\'s loss baseline and the drawdown peak start again from now') };
};
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
/** The offset to the exchange's clock, from the middle of the request's round trip; a failed read keeps the last one */
async function syncClock() { try { const t0 = Date.now(); const t = await api('/v1/time'); const t1 = Date.now(); if (num(t.time) > 0) clockOffset = Math.round(num(t.time) - (t0 + t1) / 2); } catch (_) {} return clockOffset; }   // whole ms: the nonce is a BigInt of it

// ---------------------------------------------------------------- commands
async function keygen() {
  const cfg = fs.existsSync(configPath) ? readConfig() : null; const p = keyPath(cfg);
  if (fs.existsSync(p) && !ARGS.force) { const w = readKey(cfg); console.log(`A signer key already exists at ${p}\nAddress: ${w.address}\n(--force to replace it; the old address stays linked until you revoke it on the exchange)`); return; }
  const w = Wallet.createRandom();
  // the file is made empty and locked down before the key goes in, so the key is never readable by others, not even briefly
  fs.writeFileSync(p, '', { mode: 0o600 }); const locked = restrictFile(p);
  fs.writeFileSync(p, w.privateKey + '\n', { mode: 0o600 });
  console.log(`Signer key written to ${p}\nAddress: ${w.address}\n\nOnce linked, this key can submit and cancel orders and can never withdraw; orders alone can still lose the account's margin, so keep the file private.\nNext: node copy-agent.mjs link`);
  if (locked) console.error(`\n!!! WARNING: ${p} could not be limited to your user account (${locked}).\n!!! Other accounts on this machine may be able to read the key. Fix it before linking:\n!!!   ${process.platform === 'win32' ? `icacls "${p}" /inheritance:r /grant:r "%USERNAME%:F"` : `chmod 600 "${p}"`}\n`);
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
  console.log(`Link request written to link-request.json (valid for about an hour).\n\nSigner address: ${w.address}\nThe site shows the signer before your wallet signs: it must be this address. Never paste a link request someone else gave you; it would let their key trade your account.\n\nPaste it on ${SITE}/#/copytrade/agent → "Link the signer"; your wallet signs it there and the site sends it to the exchange.\n\n` + JSON.stringify(req));
}

async function status() {
  const cfg = readConfig(); const port = (cfg.status && cfg.status.port) || 8790; const { token } = controlToken(cfg, false);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/status`, { headers: token ? { 'x-agent-token': token } : {} });
    if (r.status === 401) { console.log(`The agent on port ${port} refused the token: it was started with another config status.token or control.token.`); return; }
    console.log(JSON.stringify(await r.json(), null, 2));
  } catch (e) { console.log(`No agent answering on port ${port} (${e.message}). Start it with: node copy-agent.mjs run`); }
}

// ---------------------------------------------------------------- the engine
async function run() {
  const cfg = readConfig();
  const DRY = ARGS.dry || !!(cfg.execution && cfg.execution.dryRun);
  // the mode first, and unmissable: a live run is the one that spends money
  console.log(DRY ? '\n=== DRY RUN · every order goes to the exchange\'s dry-run endpoint · NOTHING IS PLACED ===\n' : '\n!!! LIVE · this agent places REAL orders with your linked signer · Ctrl+C stops it !!!\n');
  const problems = checkConfig(cfg);
  if (problems.length) throw new Error(`${configPath} cannot be used, nothing was started:\n  - ${problems.join('\n  - ')}`);
  const ctl = controlToken(cfg, true); const w = readKey(cfg);
  if (!DRY && process.stdout.isTTY) { console.log('Starting in 5 s: Ctrl+C now if you meant --dry.'); await sleep(5000); }
  const ex = Object.assign({ type: 'IOC', slippageBps: 15, groupMs: 1200, onLeaderFlat: 'close', onLeaderLiquidation: 'close', onOrphan: 'hold' }, cfg.execution || {});
  const risk = Object.assign({ maxNotionalPerMarket: 0, maxOpenPositions: 0, maxLeverage: 0, dailyLossStop: 0, drawdownStopPct: 0, minOrderUsd: 0, markets: {}, onTrip: 'reduceOnly' }, cfg.risk || {});
  const sizing = Object.assign({ mode: 'fixed', size: 200, ratio: 10 }, cfg.sizing || {});
  // the hard limits are never off: left out (or null) they take the defaults, whatever the sizing mode
  const defaulted = [];
  for (const k of ['maxOrderUsd', 'maxPositionUsd', 'maxPriceDeviationPct']) if (risk[k] == null) { risk[k] = LIMITS[k]; defaulted.push('risk.' + k); }
  if (ex.maxFillAgeMs == null) { ex.maxFillAgeMs = LIMITS.maxFillAgeMs; defaulted.push('execution.maxFillAgeMs'); }
  // a fixed-size copy follows the leader's adds in proportion, so a leader who opens small and scales in would make a
  // position any multiple of `size`; without a per-market cap of your own, five times the size is the most one gets
  const derivedCap = defaultCap(sizing, risk); const capDerived = derivedCap != null;
  if (capDerived) risk.maxNotionalPerMarket = derivedCap;
  const offset = await syncClock();
  const rpc = await api('/v1/rpc/config');
  const products = (await api('/v1/product?limit=200')).data || [];
  const byId = {}, byTicker = {}; for (const p of products) { byId[p.id] = p; byTicker[p.ticker] = p; }
  const sa = await api('/v1/subaccount/' + cfg.subaccountId);
  const sub = sa.name; const SID = sa.id;
  if (String(sa.account).toLowerCase() !== String(cfg.owner || '').toLowerCase()) throw new Error(`Subaccount ${SID} belongs to ${sa.account}, not config.owner ${cfg.owner}`);
  let signer = null; try { signer = await api('/v1/linked-signer/address/' + w.address); } catch (e) { if (e.status !== 404) throw e; }
  if (!DRY && (!signer || signer.status !== 'ACTIVE')) throw new Error(`Signer ${w.address} is ${signer ? signer.status : 'not linked'} for this account: run "node copy-agent.mjs link" and finish it on the site (or run --dry).`);

  // persisted state: what we follow from whom, so a restart does not orphan positions. A damaged state.json starts with
  // the risk stop set (see loadState): only an explicit resume clears it
  const { saved, damaged } = loadState();
  const S = { dry: DRY, startedAt: Date.now(), paused: !!saved.paused, tripped: damaged ? { t: Date.now(), why: `${damaged}${saved.tripped ? '; the stop it had: ' + saved.tripped.why : ''}: check the positions and resume` } : saved.tripped || null, signer: w.address, owner: sa.account, subaccountId: SID, subaccountName: sub, leaders: cfg.leaders, sizing, risk, execution: ex,
    books: saved.books || {}, marketOwner: saved.marketOwner || {}, own: {}, mark: {}, equity: null, balance: 0, notional: 0, upnl: 0, unsettled: 0, ownAt: 0, equityDayStart: saved.equityDayStart || null, dayKey: saved.dayKey || null, dayBaseAt: saved.dayBaseAt || null, ...restorePeak(saved, serverNow()), flowsDay: 0, flowsSinceStart: 0, orders: (saved.orders || []).slice(0, 1000), events: [], errors: 0, lastError: null, ws: 'closed', reconnects: 0, leaderPos: {}, leaderPosAt: {}, resyncAt: {}, carry: saved.carry || {}, leaderSeeded: {}, signerExpiresAt: signer ? num(signer.expiresAt) : null, clockOffset: offset, orphans: [], missed: [] };
  let persistErr = null, onDiskGood = !damaged;   // a damaged file must not become the backup
  // a baseline or peak saved by an agent that counted equity gross is moved onto the net basis at the first reading
  // (toNetBasis); until then a save keeps saying it is gross, so a stop in between cannot skip the move
  let grossBasis = !saved.equityNet && (S.equityDayStart != null || S.equityPeak != null);
  const persist = () => {
    try {
      fs.writeFileSync(statePath + '.tmp', JSON.stringify({ paused: S.paused, tripped: S.tripped, books: S.books, marketOwner: S.marketOwner, carry: S.carry, equityDayStart: S.equityDayStart, dayKey: S.dayKey, dayBaseAt: S.dayBaseAt, equityPeak: S.equityPeak, peakSince: S.peakSince, equityNet: !grossBasis, orders: S.orders.slice(0, 1000), savedAt: Date.now() }));
      // written whole beside it and swapped in: a crash or a full disk mid-write leaves the last good file, never half of one
      if (onDiskGood && fs.existsSync(statePath)) fs.copyFileSync(statePath, statePath + '.bak');
      fs.renameSync(statePath + '.tmp', statePath); persistErr = null; onDiskGood = true;
    } catch (e) { if (persistErr !== e.message) { persistErr = e.message; note('error', `state.json could not be saved (${e.message}): a restart now would lose what changed since`); push('Copy agent cannot save its state', e.message); } }
  };
  const note = (kind, msg, extra) => { const e = Object.assign({ t: Date.now(), kind, msg }, extra || {}); S.events.unshift(e); if (S.events.length > 300) S.events.length = 300; log(kind, msg, extra || ''); };
  const push = async (title, msg) => { if (!(cfg.ntfy && cfg.ntfy.topic)) return; try { await fetch(((cfg.ntfy.server || 'https://ntfy.sh').replace(/\/+$/, '')) + '/' + encodeURIComponent(cfg.ntfy.topic), { method: 'POST', body: msg, headers: { Title: title, Tags: 'robot', Priority: '4' } }); } catch (_) {} };
  const who = (l) => (l.name && l.name !== 'primary' ? l.name : l.address.slice(0, 6) + '…' + l.address.slice(-4));
  if (damaged) { note('trip', S.tripped.why); push('Copy agent started with its risk stop set', damaged); }
  if (ctl.created) note('start', `config status.token is empty: generated one (${ctl.token.slice(0, 4)}…) and saved it in ${ctl.from}; paste it into the Copy agent page's token field`);
  // marks: the Ticker stream's while fresh (about one a second per market; it also keeps the socket from idling out),
  // else the last REST read. Sizing, every limit and the IOC price use this, never the leader's own fill price.
  const tick = {};
  const markOf = (pid) => { const t = tick[pid]; return t && Date.now() - t.at < 15000 ? t.px : S.mark[pid] || 0; };
  /** A leader opening or add that is not copied because the news cannot be trusted (too old, priced off the market, or
   *  only seen on a re-read): kept for the dashboard, never chased */
  const missed = (m) => { S.missed.unshift(Object.assign({ at: Date.now() }, m)); if (S.missed.length > 100) S.missed.length = 100; note('skip', `${m.ticker} ${m.kind} by ${m.leader} not copied: ${m.why}`, { leader: m.leader }); };

  // ---- one thing at a time: every decision and order goes through this queue, so two leader orders arriving
  //      together cannot both size against the same stale position
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  // ---- own account: balances, positions, marks, and the deposits / withdrawals that must not count as PnL
  const dayKeyOf = (t) => new Date(t).toISOString().slice(0, 10);
  // deposits and withdrawals since `since`, every page; null when unreadable, so the stops wait a cycle rather than take
  // a transfer for a loss
  const flows = async (since) => {
    try {
      let sum = 0, cursor = null;
      for (let page = 0; page < 50; page++) {
        const r = await api('/v1/token/transfer', { params: { subaccountId: SID, createdAfter: since, limit: 100, cursor } });
        for (const t of r.data || []) { const ty = String(t.type || '').toUpperCase(); const amt = num(t.amount); sum += /DEPOSIT/.test(ty) ? amt - num(t.fee) : /WITHDRAW/.test(ty) ? -(amt + num(t.fee)) : 0; }
        if (!(r.hasNext && r.nextCursor)) return sum;
        cursor = r.nextCursor;
      }
      return null;   // more than 50 pages: not all of them read
    } catch (_) { return null; }
  };
  const refreshOwn = async () => {
    const readAt = serverNow();   // the baseline is taken before the reads it is compared with
    const [bal, pos, prices] = await Promise.all([api('/v1/subaccount/balance', { params: { subaccountId: SID, limit: 100 } }), api('/v1/position', { params: { subaccountId: SID, open: true, limit: 100 } }), api('/v1/product/market-price?' + products.filter((p) => p.status === 'ACTIVE').map((p) => 'productIds=' + p.id).join('&'))]);
    const mark = {}; for (const x of prices.data || []) mark[x.productId] = num(x.oraclePrice) || num(x.markPrice);
    const own = {};
    if (DRY) { for (const [pid, o] of Object.entries(S.own || {})) { const m = mark[pid] || o.mark; own[pid] = Object.assign({}, o, { mark: m, notional: Math.abs(o.size) * m, upnl: o.size * (m - o.entry) }); } }   // the virtual book of a dry run (no funding or position fee is charged on it)
    else for (const p of pos.data || []) { const o = ownPosition(p, mark[p.productId]); if (o) own[p.productId] = o; }
    const balance = (bal.data || []).reduce((a, b) => a + num(b.amount), 0);
    // equity as Meridian's Trade Equity (tradeEquity): the per-position uPnL stays gross, as the app's positions table shows it
    S.own = own; S.mark = mark; S.balance = balance; S.unsettled = unsettledOf(own); S.equity = tradeEquity(balance, own); S.ownAt = Date.now();
    S.upnl = Object.values(own).reduce((a, o) => a + o.upnl, 0); S.notional = Object.values(own).reduce((a, o) => a + o.notional, 0);
    if (grossBasis) {
      const nb = toNetBasis(S, S.unsettled); S.equityDayStart = nb.equityDayStart; S.equityPeak = nb.equityPeak; grossBasis = false;
      if (S.unsettled) note('start', `equity now takes out the funding and position fees charged but not yet settled (${S.unsettled.toFixed(2)} USD), as Meridian's Trade Equity does: the saved day baseline and drawdown peak moved by the same amount`);
    }
    for (const pid of Object.keys(S.carry)) if (!own[pid] || !(S.carry[pid] > 1e-12)) delete S.carry[pid];   // nothing left to reduce, nothing owed
    const db = dayBaseline(S, { day: dayKeyOf(readAt), readAt, equity: S.equity }); S.dayKey = db.dayKey; S.equityDayStart = db.equityDayStart; S.dayBaseAt = db.dayBaseAt;
    const fDay = db.fresh ? 0 : await flows(S.dayBaseAt), fPeak = await flows(S.peakSince);
    // an unreadable transfer list does not switch the stops off: they run on the last amounts read (flowsForStops)
    const fl = flowsForStops({ day: fDay, peak: fPeak }, S.flowsLast, S.dayKey);
    if (fl.stale) { if (!S.flowsErr) { const msg = 'deposits and withdrawals could not be read: the daily-loss and drawdown stops use the last amounts read until they can (a withdrawal made since counts as a loss)'; note('warn', msg); push('Copy agent: transfers unreadable', msg); } S.flowsErr = true; }
    else { S.flowsErr = false; S.flowsLast = { day: fl.day, peak: fl.peak, dayKey: S.dayKey }; }
    S.flowsDay = fl.day; S.flowsSinceStart = fl.peak;
    const adjEquity = S.equity - S.flowsSinceStart;   // deposits since peakSince do not raise the peak, withdrawals do not count as loss
    if (S.equityPeak == null || adjEquity > S.equityPeak) S.equityPeak = adjEquity;   // the first reading sets it, in the same terms
    S.dayPnl = S.equity - S.equityDayStart - S.flowsDay;   // funding and position fees count the hour they are charged, not when they settle
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
  /** Sign, submit and read back one order. side 0 buy / 1 sell. close: quantity 0 + reduceOnly closes the whole position. */
  async function place({ prod, side, qty, reduceOnly = false, close = false, why, leader, leaderSid, leaderPx, leaderT, kind, resync = false }) {
    const mark = markOf(prod.id);
    let q = close ? 0 : roundDown(Math.min(qty, num(prod.maxQuantity) || Infinity), prod.lotSize);
    // a reduction the exchange will not take yet (below its minimum, or a remainder an IOC left) is not lost: it is
    // carried and folded into the next reduction of that market, so the copy does not stay bigger than the leader's share
    const carry = (dq, why) => { if (!(reduceOnly && !close) || !(dq > 1e-12)) return; S.carry[prod.id] = (S.carry[prod.id] || 0) + dq; if (why) note('leader', `${prod.displayTicker}: ${dq} of the reduction ${why}; carried to the next one (${S.carry[prod.id]} pending)`, { leader }); };
    if (!close && q < num(prod.minQuantity)) { if (reduceOnly) carry(qty, `is below the minimum ${prod.minQuantity}`); else note('skip', `${prod.displayTicker}: ${qty} is below the minimum ${prod.minQuantity}`, { leader }); return null; }
    if (!close && mark && q * mark < (risk.minOrderUsd || 0)) { if (reduceOnly) carry(qty, 'is below minOrderUsd'); else note('skip', `${prod.displayTicker}: ${(q * mark).toFixed(2)} USD is below minOrderUsd`, { leader }); return null; }
    if (!close && !mark) { note('skip', `${prod.displayTicker}: no mark price, not trading blind`, { leader }); carry(qty, 'had no mark price'); return null; }
    // the last word before signing: an order that adds exposure is checked at the mark against every size limit again,
    // whatever computed its quantity (reductions and closes only ever shrink a position and are never held back here)
    if (!reduceOnly && !close) { const lim = roomFor(prod); if (q * mark > lim * (1 + 1e-9) + 1e-9) { note('skip', `${prod.displayTicker}: ${(q * mark).toFixed(2)} USD at the mark is over the ${Math.max(0, lim).toFixed(2)} USD the limits leave; not sent`, { leader }); return null; } }
    carry(qty - q, null);   // the lot-size rounding remainder, kept quietly
    const useLimit = !close && ex.type !== 'MARKET'; const type = useLimit ? 'LIMIT' : 'MARKET'; const ro = !!(reduceOnly || close);
    const px = useLimit ? roundTick(mark * (1 + (side === 0 ? 1 : -1) * ((ex.slippageBps || 15) / 1e4)), prod.tickSize, side === 0) : 0;
    // signed afresh for every attempt: a retry after the clock is measured again needs a new nonce and signedAt
    const signed = async () => {
      const n = nonce(); const signedAt = Math.floor(serverNow() / 1000); const cid = randomUUID();
      const msg = { sender: w.address, subaccount: sub, quantity: BigInt(Math.round(q * 1e9)), price: BigInt(Math.round(px * 1e9)), reduceOnly: ro, side, engineType: 0, productId: Number(prod.onchainId), nonce: n, signedAt };
      const signature = await sign(w, rpc, 'TradeOrder', msg);
      const data = { sender: w.address, subaccount: sub, quantity: String(q), side, engineType: 0, onchainId: Number(prod.onchainId), nonce: n.toString(), signedAt, type, reduceOnly: ro, clientOrderId: cid };
      if (useLimit) { data.price = String(px); data.timeInForce = 'IOC'; }
      if (close) data.close = true;
      return { data, signature };
    };
    const submit = (o) => (DRY ? api('/v1/order/dry-run', { method: 'POST', body: { data: Object.assign({}, o.data, { sender: sa.account }) } }) : api('/v1/order', { method: 'POST', body: { data: o.data, signature: o.signature } }));
    let ord = await signed();
    const before = S.own[prod.id] ? S.own[prod.id].size : 0;
    const rec = { t: Date.now(), leader, leaderSid: leaderSid || null, leaderPx: leaderPx || null, leaderT: leaderT || null, kind: kind || (close ? 'close' : reduceOnly ? 'reduce' : 'open'), cid: ord.data.clientOrderId, pid: prod.id, ticker: prod.displayTicker, side: side === 0 ? 'BUY' : 'SELL', qty: q, close, reduceOnly: ro, type, px: px || null, mark, why, status: 'sent', before, fills: [], resync: !!resync };
    S.orders.unshift(rec); if (S.orders.length > 1000) S.orders.length = 1000;
    try {
      let r;
      try { r = await submit(ord); }
      catch (e) {   // the exchange refused the order's time: measure the clock again and send it once more
        if (!isClockReject(e.status, e.message)) throw e;
        const was = clockOffset; await syncClock(); S.clockOffset = clockOffset;
        note('warn', `${prod.displayTicker}: the exchange refused the order's time (${e.message}); clock measured again (${((clockOffset - was) / 1000).toFixed(1)} s change), sending it once more`);
        ord = await signed(); rec.cid = ord.data.clientOrderId; r = await submit(ord);
      }
      if (DRY) {   // the exchange checks margin and fields, places nothing; a virtual book stands in for the fill
        rec.status = 'dry'; rec.margin = r && r.marginRequired != null ? num(r.marginRequired) : null; rec.code = r && r.code;
        const fillPx = px || mark; const cur = S.own[prod.id]; const dq = close ? -(cur ? cur.size : 0) : (side === 0 ? q : -q);
        if (!cur) { if (dq) S.own[prod.id] = { size: dq, entry: fillPx, mark: fillPx, notional: Math.abs(dq) * fillPx, upnl: 0, virtual: true }; }
        else { const size = cur.size + dq; if (Math.abs(size) < 1e-12) delete S.own[prod.id]; else S.own[prod.id] = Object.assign(cur, { size, entry: Math.sign(size) === Math.sign(cur.size) && Math.abs(size) > Math.abs(cur.size) ? (cur.entry * Math.abs(cur.size) + fillPx * Math.abs(dq)) / Math.abs(size) : cur.entry }); }
        rec.filled = close ? Math.abs(before) : q; rec.after = S.own[prod.id] ? S.own[prod.id].size : 0; rec.id = 'dry-' + rec.cid.slice(0, 8);
        if (rec.filled) rec.fills.push({ id: 'dry-' + rec.cid, t: Date.now(), px: fillPx, qty: rec.filled, fee: rec.filled * fillPx * (num(prod.takerFee) || 0.0003), maker: false, virtual: true });
        note('order', `DRY ${rec.side} ${close ? 'close' : q} ${prod.displayTicker} ${type}${px ? ' @ ' + px : ''} · ${why} · margin ${rec.margin} · ${rec.code}`);
      } else {
        rec.id = r && r.id; rec.code = r && r.result; rec.status = 'accepted';
        // the submission response's `filled` is deprecated (always 0): read the order back until it is final
        let o = null; for (let i = 0; i < 8; i++) { await sleep(i ? 500 : 250); try { o = await api('/v1/order/' + rec.id); } catch (_) {} if (o && FINAL.has(o.status)) break; }
        if (o) { rec.orderStatus = o.status; rec.filled = num(o.filled); rec.reason = o.rejectedReason || null; }
        rec.after = await settle(prod.id, before);
        const got = close ? Math.abs(before - rec.after) : Math.abs(rec.after - before);
        rec.status = rec.orderStatus === 'REJECTED' ? 'rejected' : got < 1e-12 ? 'unfilled' : Math.abs(got - (close ? Math.abs(before) : q)) > num(prod.lotSize) ? 'partial' : 'filled';
        note(rec.status === 'filled' ? 'order' : 'warn', `${rec.side} ${close ? 'close' : q} ${prod.displayTicker} ${type}${px ? ' @ ' + px : ''} · ${why} · ${rec.status}${rec.filled != null ? ' ' + rec.filled : ''}${rec.reason ? ' · ' + rec.reason : ''}`, { id: rec.id });
        if (rec.reason === 'SignerRevoked' || rec.code === 'SignerRevoked') { S.paused = true; note('error', 'the signer was revoked: paused; link a new one on the site'); push('Copy agent paused', 'signer revoked'); }
        if (!close && got < q - 1e-12) carry(q - got, rec.status === 'rejected' ? 'was rejected' : 'did not fill inside the slippage cap');   // an opening is never chased; a reduction is owed
      }
    } catch (e) {
      rec.status = 'rejected'; rec.error = e.message; S.errors++; S.lastError = { t: Date.now(), msg: e.message };
      note('error', `${prod.displayTicker} ${rec.side} rejected: ${e.message}`, { why }); push('Copy agent order rejected', `${prod.displayTicker} ${rec.side}: ${e.message}`);
      if (/SignerRevoked|Unauthorized/i.test(e.message) || e.status === 401) { S.paused = true; note('error', 'the exchange no longer accepts this signer: paused'); }
      if (!close) carry(q, 'was rejected');
    }
    if (DRY) await refreshOwn().catch(() => {});
    persist();
    return rec;
  }
  async function closeAll(why) { for (const [pid, o] of Object.entries(S.own)) { const prod = byId[pid]; if (prod && o.size) { delete S.carry[pid]; await place({ prod, side: o.size > 0 ? 1 : 0, qty: 0, close: true, why }); } } }
  const closeMarket = async (pid, why, leaderName, ctxL) => { const o = S.own[pid]; const prod = byId[pid]; if (!o || !o.size || !prod) return null; delete S.carry[pid]; const r = await place(Object.assign({ prod, side: o.size > 0 ? 1 : 0, qty: 0, close: true, why, leader: leaderName }, ctxL || {}, { kind: 'close' })); if (!S.own[pid]) { for (const b of Object.values(S.books)) delete b[pid]; delete S.marketOwner[pid]; } return r; };
  /** A reduction of `share` of what is held, plus whatever earlier reductions of that market still owe (see place). */
  const reduceBy = async (pid, share, args) => { const o = S.own[pid]; if (!o || !o.size) return null; const owed = Math.min(S.carry[pid] || 0, Math.abs(o.size)); delete S.carry[pid]; const qty = reduceQty(o.size, share, owed); return place(Object.assign({ prod: byId[pid], side: o.size > 0 ? 1 : 0, qty, reduceOnly: true }, args, owed ? { why: args.why + ` + ${owed} carried` } : {})); };   // the share applies to what should be held, i.e. without what is still owed

  /** May a new or larger position be taken? The reason, in words, when not. */
  const allowed = (prod, addNotional, leaderSid) => {
    if (S.paused) return 'paused';
    if (S.tripped) return 'risk stop is on (reduce-only)';
    if (Date.now() - S.ownAt > 120000) return 'own account data is stale (exchange unreachable?)';
    if (!S.leaderSeeded[leaderSid]) return 'leader positions not read yet';
    if (risk.markets && risk.markets.deny && risk.markets.deny.includes(prod.displayTicker)) return `${prod.displayTicker} is denied`;
    if (risk.markets && risk.markets.allow && risk.markets.allow.length && !risk.markets.allow.includes(prod.displayTicker)) return `${prod.displayTicker} is not in the allowed markets`;
    const cur = S.own[prod.id]; const curNotional = held(prod.id);
    const over = (x, cap) => x > cap * (1 + 1e-9);   // an order cut to exactly the room left must not fail on the last bit of a float
    if (risk.maxNotionalPerMarket && over(curNotional + addNotional, risk.maxNotionalPerMarket)) return `would exceed ${risk.maxNotionalPerMarket} USD in ${prod.displayTicker}`;
    if (over(curNotional + addNotional, risk.maxPositionUsd)) return `would exceed the ${risk.maxPositionUsd} USD ceiling per position in ${prod.displayTicker}`;
    if (over(addNotional, risk.maxOrderUsd)) return `the order is over the ${risk.maxOrderUsd} USD ceiling per order`;
    if (num(prod.maxPositionNotionalUsd) && over(curNotional + addNotional, num(prod.maxPositionNotionalUsd))) return `would exceed the market's position cap`;
    if (risk.maxOpenPositions && !cur && Object.keys(S.own).length >= risk.maxOpenPositions) return `already ${risk.maxOpenPositions} open positions`;
    // on equity (tradeEquity), not on the balance Meridian's account leverage divides by: losing positions and the funding
    // and position fees charged on them raise it, so the cap tightens as the account loses
    if (risk.maxLeverage && S.equity > 0 && over((heldTotal() + addNotional) / S.equity, risk.maxLeverage)) return `would exceed ${risk.maxLeverage}x leverage on equity`;
    if (S.equity <= 0) return 'no equity';
    const owner = S.marketOwner[prod.id]; if (owner && owner !== leaderSid) return `${prod.displayTicker} is being copied from another leader`;
    return null;
  };
  /** What is held, in USD at the current mark (the limits are about what a position is worth now, not when it was read) */
  const held = (pid) => { const o = S.own[pid]; return o ? Math.abs(o.size) * (markOf(pid) || o.mark || 0) : 0; };
  const heldTotal = () => Object.keys(S.own).reduce((a, pid) => a + held(pid), 0);
  /** How much notional may still be added in a market under the per-market cap, the market's own cap, the leverage limit
   *  and the hard ceilings per position and per order: an order that would overshoot is cut to this rather than dropped,
   *  so the copy stays as close as the limits allow. */
  const roomFor = (prod) => roomLeft({ curNotional: held(prod.id), maxPerMarket: num(risk.maxNotionalPerMarket), marketCap: num(prod.maxPositionNotionalUsd), maxLeverage: num(risk.maxLeverage), equity: S.equity, totalNotional: heldTotal(), maxPosition: num(risk.maxPositionUsd), maxOrder: num(risk.maxOrderUsd) });

  // ---- leaders: positions seeded from the exchange, resynced on every hint and every five minutes
  // A position record's updatedAt is the time of the last fill in it, so a fill whose time is at or before the record's
  // updatedAt is already inside the size that was read; the socket's copy of that fill must not be added on top
  // (a resync landing while an order's fills are still being grouped would otherwise count them twice and, say, take
  // a close for a reversal). Open records carry the sizes; the newest records carry the updatedAt of recent closes and
  // whether one was a liquidation (a liquidation leaves no fill, so a re-read is the only place it shows).
  const readLeader = async (l) => {
    const [openR, recentR] = await Promise.all([api('/v1/position', { params: { subaccountId: l.sid, open: true, limit: 100 } }), api('/v1/position', { params: { subaccountId: l.sid, limit: 50 } })]);
    return leaderRead(openR.data, recentR.data);
  };
  const seedLeader = async (l) => { try { const r = await readLeader(l); S.leaderPos[l.sid] = r.pos; S.leaderPosAt[l.sid] = r.at; S.leaderSeeded[l.sid] = true; } catch (e) { S.leaderSeeded[l.sid] = false; note('warn', `could not read ${who(l)}'s positions: ${e.message}; not copying its openings until it can be read`); } S.books[l.sid] = S.books[l.sid] || {}; };
  for (const l of cfg.leaders) await seedLeader(l);
  await refreshOwn();

  // ---- preflight: what would make an order fail or a result mislead
  if (Math.abs(offset) > 5000) note('warn', `this machine's clock is ${(offset / 1000).toFixed(1)} s off the exchange's; corrected for signing`);
  if (!DRY && signer && num(signer.expiresAt) && num(signer.expiresAt) < Date.now() + 3 * 86400000) { note('warn', `the linked signer expires ${new Date(num(signer.expiresAt)).toISOString()}: before then make a new key (node copy-agent.mjs keygen --force), link it on the site and restart the agent`); push('Copy agent signer expiring', new Date(num(signer.expiresAt)).toISOString()); }
  if (S.equity <= 0) note('warn', 'the copy account has no equity; nothing can be opened');
  if (ex.type === 'MARKET') note('warn', 'execution.type is MARKET: the only slippage protection is the exchange\'s own cap (MarketOrderReachedMaxSlippage); IOC with a bps cap is safer');
  if (sizing.mode !== 'ratio' && num(sizing.size) < (risk.minOrderUsd || 0)) note('warn', `sizing.size ${sizing.size} is below risk.minOrderUsd ${risk.minOrderUsd}: every order would be skipped`);
  if (capDerived) note('start', `risk.maxNotionalPerMarket is not set: using ${MAX_SCALE} × sizing.size = ${risk.maxNotionalPerMarket} USD per market, the most a position may grow to when a leader adds to it`);
  if (sizing.mode !== 'ratio' && num(sizing.size) > num(risk.maxOrderUsd)) note('warn', `sizing.size ${sizing.size} is above risk.maxOrderUsd ${risk.maxOrderUsd}: every opening is cut to ${risk.maxOrderUsd} USD (raise risk.maxOrderUsd to copy at full size)`);
  if (sizing.mode !== 'ratio' && num(risk.maxNotionalPerMarket) < num(sizing.size)) note('warn', `risk.maxNotionalPerMarket ${risk.maxNotionalPerMarket} is below sizing.size ${sizing.size}: every opening is cut to the cap`);
  note('start', `hard limits in every sizing mode: ${risk.maxOrderUsd} USD per order, ${risk.maxPositionUsd} USD per position · a leader fill more than ${risk.maxPriceDeviationPct}% off the mark or ${ex.maxFillAgeMs / 1000} s old is not copied${defaulted.length ? ' · defaults for ' + defaulted.join(', ') : ''}`);
  if (!num(risk.maxLeverage)) note('warn', 'risk.maxLeverage is 0, no leverage limit: the ceilings per order and per position still hold, but nothing caps the total across markets');
  const exposed = keyExposure(keyPath(cfg)); if (exposed) note('warn', exposed);
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
  note('start', `copy agent up · ${DRY ? 'DRY RUN, nothing is placed' : 'LIVE, real orders'} · signer ${w.address} · ${cfg.leaders.length} leader(s) · equity ${S.equity.toFixed(2)} USD (Meridian's Trade Equity) · sizing ${sizing.mode} ${sizing.mode === 'ratio' ? sizing.ratio + '%' : sizing.size + ' USD'} · ${ex.type}${ex.type === 'IOC' ? ' ±' + ex.slippageBps + ' bps' : ''}`);

  /** One leader order (its fills grouped): decide and place the mirror. Runs inside the serial queue. */
  async function onLeaderOrder(l, prod, g) {
    const name = who(l);
    // a fill without a usable size cannot be placed in the leader's position at all: the next re-read of it will
    if (!Number.isFinite(g.q) || !(Math.abs(g.q) > 0)) { note('warn', `${name} ${prod.displayTicker}: a fill without a usable size (${g.q}); left to the next re-read of the leader's positions`); return; }
    const lp = S.leaderPos[l.sid] || (S.leaderPos[l.sid] = {}); const at = (S.leaderPosAt[l.sid] || {})[prod.id] || 0;
    // fills at or before the last read of the leader's positions are already inside that size: classify from it, do not add
    const qIn = (g.parts || []).reduce((a, p) => a + (p.t > 0 && p.t <= at ? p.q : 0), 0);
    if (qIn) S.missed = S.missed.filter((m) => !(m.reread && m.sid === l.sid && m.pid === prod.id));   // that read took these fills for missed; they are here after all
    const prev = (lp[prod.id] || 0) - qIn;
    const next = prev + g.q; lp[prod.id] = Math.abs(next) < 1e-12 ? 0 : next;
    const book = S.books[l.sid] || (S.books[l.sid] = {}); const px = g.badPx ? NaN : g.notional / Math.abs(g.q);
    const own = S.own[prod.id]; const ownQty = own ? own.size : 0; const followed = S.marketOwner[prod.id] === l.sid;
    const kind = classify(prev, lp[prod.id]);
    // the part of this leader order that closed the old position, over all its groups of fills: the new side is sized
    // on the rest of the order (as paper copy does)
    const cp = closedByOrder(prev, g.q);
    if (g.oid && cp) { if (!S.orderClosed || Object.keys(S.orderClosed).length > 200) S.orderClosed = {}; S.orderClosed[g.oid] = (S.orderClosed[g.oid] || 0) + cp; }
    note('leader',`${name} ${kind} ${prod.displayTicker} ${g.q > 0 ? '+' : ''}${g.q} @ ${Number.isFinite(px) ? px : 'no price'}`);
    const ctxL = { leaderSid: l.sid, leaderPx: px > 0 && Number.isFinite(px) ? px : null, leaderT: g.t || serverNow(), kind };
    if (kind === 'close') { if (followed && ownQty) await closeMarket(prod.id, `${name} closed`, name, ctxL); return; }
    if (kind === 'reduce') {
      if (!followed || !ownQty) return;
      // a resync that read the position after every fill of this order already mirrored the reduction
      const r = S.resyncAt[prod.id]; if (r && (g.parts || []).every((p) => p.t > 0 && p.t <= r)) { note('leader', `${prod.displayTicker} reduce: already mirrored by the resync`); return; }
      const share = Math.abs(g.q) / Math.abs(prev);
      await reduceBy(prod.id, share, Object.assign({ why: `${name} reduced ${(share * 100).toFixed(0)}%`, leader: name }, ctxL));
      return;
    }
    if (kind === 'reverse' && followed && ownQty) await closeMarket(prod.id, `${name} reversed`, name, ctxL);
    const ownNow = S.own[prod.id] ? S.own[prod.id].size : 0;
    // open, add, or the new leg of a reversal
    if (kind === 'add' && !followed && ownNow) { note('skip', `${prod.displayTicker} add: we hold a position here that is not a copy of ${name}`); return; }
    // only on news that is fresh and priced near the market (the closes and reductions above need neither: they only
    // shrink a position, and a re-read would make them anyway)
    const mark = markOf(prod.id); const age = serverNow() - (g.t || serverNow());
    const bad = (age > ex.maxFillAgeMs ? `the leader's fill is ${(age / 1000).toFixed(1)} s old (the limit is ${ex.maxFillAgeMs / 1000} s)` : null) || priceProblem(px, mark, risk.maxPriceDeviationPct);
    if (bad) { missed({ leader: name, sid: l.sid, pid: prod.id, ticker: prod.displayTicker, kind, q: g.q, px: ctxL.leaderPx, t: g.t || null, why: bad }); return; }
    // sized and limited at the mark: the leader's price only had to be near it
    const leaderDelta = kind === 'reverse' ? Math.abs(next) : Math.abs(g.q);
    const sz = sizeOrder(sizing, { kind, leaderDelta, px: mark, followed, ownNow, prev, orderQty: openingOrderQty(g.orderQty, (S.orderClosed || {})[g.oid]), owed: S.carry[prod.id] || 0 });
    let q = sz.q; if (sz.k != null) book[prod.id] = { k: sz.k, openedAt: Date.now() };
    const side = next > 0 ? 0 : 1;
    // the size limits cut the order to what they allow (a leader scaling in beyond the cap is followed up to it);
    // everything else (paused, stopped, stale data, denied market, another leader's market, no equity) skips it
    const room = roomFor(prod); let why = `${name} ${kind}`;
    const fit = fitToRoom(q, mark, room, Math.max(num(prod.minQuantity) * mark, risk.minOrderUsd || 0));
    if (fit.skip) { note('skip', `${prod.displayTicker} ${kind}: ${allowed(prod, q * mark, l.sid) || 'at the size limit'} (${held(prod.id).toFixed(0)} USD held)`, { leader: name }); return; }
    if (fit.cut) { note('leader', `${prod.displayTicker} ${kind}: ${(q * mark).toFixed(0)} USD cut to ${room.toFixed(0)} USD by the size limits`, { leader: name }); q = fit.q; why += ' (cut to the size limit)'; }
    const no = allowed(prod, q * mark, l.sid);
    if (no) { note('skip', `${prod.displayTicker} ${kind}: ${no}`, { leader: name }); return; }
    const r = await place(Object.assign({ prod, side, qty: q, why, leader: name }, ctxL, { kind: kind === 'reverse' ? 'open' : kind }));
    if (r && S.own[prod.id] && Math.sign(S.own[prod.id].size) === (side === 0 ? 1 : -1)) { S.marketOwner[prod.id] = l.sid; book[prod.id] = book[prod.id] || { k: q / leaderDelta, openedAt: Date.now() }; }
    persist();
  }

  /** Compare a leader's positions with what we last knew and mirror what the socket may have missed. */
  async function resync(l, why) {
    let read; try { read = await readLeader(l); } catch (e) { note('warn', `resync ${who(l)}: ${e.message}`); return; }
    const after = read.pos; const before = S.leaderPos[l.sid] || {}; const known = S.leaderSeeded[l.sid]; S.leaderPos[l.sid] = after; S.leaderPosAt[l.sid] = read.at; S.leaderSeeded[l.sid] = true;
    // openings and adds the read shows but no fill brought (a gap in the socket): listed for the dashboard, never chased
    // (not on the first read that works: what a leader held before that is no news)
    if (known) for (const pid of Object.keys(after)) {
      if (!byId[pid] || Array.from(pending.keys()).some((k) => k.startsWith(l.sid + '|' + pid + '|'))) continue;
      const b = before[pid] || 0, a = after[pid]; const kind = classify(b, a); const grew = kind === 'add' ? Math.abs(a) - Math.abs(b) : kind === 'open' || kind === 'reverse' ? Math.abs(a) : 0;
      if (grew > 1e-12) missed({ leader: who(l), sid: l.sid, pid, ticker: byId[pid].displayTicker, kind, q: Math.sign(a) * grew, px: null, t: read.at[pid] || null, why: `seen only on a re-read of the leader's positions (${why}); no fill for it came over the socket`, reread: true });
    }
    for (const pid of Object.keys(S.own)) {
      if (S.marketOwner[pid] !== l.sid) continue;
      // fills of this market still being grouped: the flush mirrors them with the read just taken, so nothing is done twice
      if (Array.from(pending.keys()).some((k) => k.startsWith(l.sid + '|' + pid + '|'))) continue;
      const prod = byId[pid]; const b = before[pid] || 0, a = after[pid] || 0; const ownQty = S.own[pid].size;
      const ctxL = { leaderSid: l.sid, leaderPx: markOf(pid) || null, leaderT: serverNow() };   // the leader's own price is unknown here: the mark stands in, flagged
      const acted = () => { S.resyncAt[pid] = read.at[pid] || Date.now(); };   // a fill of that time or earlier is covered by this
      if (!a) {
        // on every re-read, not only the one a liquidation event prompts: the leader's last record there says which option applies
        const wasLiq = why === 'liquidation' || !!(read.liq && read.liq[pid]);
        const rf = resyncFlat(ex, wasLiq);
        if (rf.action === 'close') { note('leader', `${who(l)} is ${wasLiq ? 'liquidated' : 'flat'} in ${prod.displayTicker} (${why})`); acted(); await closeMarket(pid, `leader ${wasLiq ? 'liquidated' : 'flat'} (${why})`, who(l), Object.assign({ resync: true }, ctxL)); }
        // held after a liquidation: no longer this leader's, so later re-reads leave it alone (an orphan); flat + hold does nothing
        else if (rf.unfollow) { delete S.marketOwner[pid]; if (S.books[l.sid]) delete S.books[l.sid][pid]; if (!S.orphans.includes(pid)) S.orphans.push(pid); note('leader', `${who(l)} was liquidated in ${prod.displayTicker}: holding ours (onLeaderLiquidation hold); it is no longer followed`); }
      }
      else if (Math.sign(a) !== Math.sign(ownQty)) { note('leader', `${who(l)} is on the other side in ${prod.displayTicker} (${why}); closing ours, not chasing`); acted(); await closeMarket(pid, `leader reversed (${why})`, who(l), Object.assign({ resync: true }, ctxL)); }
      else if (b && Math.abs(a) < Math.abs(b) - 1e-12) { const share = 1 - Math.abs(a) / Math.abs(b); note('leader', `${who(l)} reduced ${prod.displayTicker} by ${(share * 100).toFixed(0)}% while the socket was quiet`); acted(); await reduceBy(pid, share, Object.assign({ why: `${who(l)} reduced (${why})`, leader: who(l), kind: 'reduce', resync: true }, ctxL)); }
    }
    persist();
  }

  // ---- socket: leaders' fills (grouped per order), anything else about a leader triggers a resync
  const attachFill = (fl) => { if (!fl.orderId) return; const rec = S.orders.find((r) => r.id === fl.orderId); if (!rec) return; if (rec.fills.some((x) => x.id === fl.id)) return; rec.fills.push({ id: fl.id, t: fl.t, px: fl.px, qty: fl.qty, fee: fl.fee, maker: fl.maker }); persist(); };
  // fills that arrived while the agent was down: read back for every recorded order that has fewer fills than its size
  const backfillFills = async () => { try { const rows = (await api('/v1/order/fill', { params: { subaccountId: SID, limit: 100 } })).data || []; for (const f of rows) attachFill({ id: f.id, orderId: f.orderId, t: num(f.createdAt), px: num(f.price), qty: num(f.filled), fee: num(f.feeUsd), maker: !!f.isMaker }); } catch (_) {} };
  if (!DRY) await backfillFills();
  const pending = new Map(); const seen = new Set();
  const puTimer = {};   // one per leader: a hint for one leader must not cancel another's re-read
  const onFill = (l, prod, f) => {
    const key = l.sid + '|' + prod.id + '|' + f.oid; const cur = pending.get(key); const badPx = !(f.px > 0);   // one unpriced piece spoils the order's average
    if (cur) { cur.q += f.q; cur.notional += Math.abs(f.q) * f.px; cur.t = Math.max(cur.t, f.t); cur.parts.push({ q: f.q, t: f.t }); cur.badPx = cur.badPx || badPx; clearTimeout(cur.timer); cur.timer = setTimeout(() => flush(key), ex.groupMs); return; }
    pending.set(key, { l, prod, q: f.q, notional: Math.abs(f.q) * f.px, oid: f.oid, t: f.t, parts: [{ q: f.q, t: f.t }], badPx, timer: setTimeout(() => flush(key), ex.groupMs) });
  };
  const flush = (key) => serial(async () => {
    const g = pending.get(key); pending.delete(key); if (!g) return;
    if (sizing.mode === 'fixed' && g.oid && !/^sim-/.test(g.oid)) { try { const o = await api('/v1/order/' + g.oid); g.orderQty = num(o.quantity); } catch (_) {} }   // the whole order, not its first piece
    try { await onLeaderOrder(g.l, g.prod, g); } catch (e) { S.errors++; S.lastError = { t: Date.now(), msg: e.message }; note('error', e.message); }
  });
  let sock = null, retry = 0;
  const connect = () => {
    S.ws = 'connecting'; sock = new WebSocket(WS_URL);
    sock.onopen = () => {
      S.ws = 'open'; retry = 0;
      for (const l of cfg.leaders) for (const type of ['OrderFill', 'PositionUpdate', 'SubaccountLiquidation']) sock.send(JSON.stringify({ event: 'subscribe', data: { type, subaccountId: l.sid } }));
      sock.send(JSON.stringify({ event: 'subscribe', data: { type: 'OrderFill', subaccountId: SID } }));
      // every market's Ticker: live marks, and a message a second, so the exchange never drops the socket as idle (it does
      // after about a minute of silence, and a leader fill in the gap never arrives)
      for (const p of products) if (p.status === 'ACTIVE') sock.send(JSON.stringify({ event: 'subscribe', data: { type: 'Ticker', symbol: p.ticker } }));
      if (S.wsDownAt) { S.reconnects++; note('warn', `socket back after ${((Date.now() - S.wsDownAt) / 1000).toFixed(1)} s: a leader fill in that gap never arrives, so the leaders are read again (closes and reductions are mirrored, openings listed as missed)`); S.wsDownAt = null; }
      if (S.lastMsg) for (const l of cfg.leaders) serial(() => resync(l, 'reconnect'));
    };
    sock.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (_) { return; } S.lastMsg = Date.now(); route(m); };
    sock.onclose = () => { S.ws = 'closed'; S.wsDownAt = S.wsDownAt || Date.now(); setTimeout(connect, Math.min(15000, 500 * Math.pow(2, retry++))); };
    sock.onerror = () => {};
  };
  const route = (m) => {
    if (!m || !m.e) return; const d = m.data || {};
    if (m.e === 'Ticker') { const p = byTicker[d.s]; const px = num(d.markPx); if (p && px > 0) tick[p.id] = { px, at: Date.now() }; return; }
    const items = Array.isArray(d.d) ? d.d : [d];
    for (const it of items) {
      const sid = it.sid || d.sid; const l = cfg.leaders.find((x) => x.sid === sid);
      if (m.e === 'OrderFill' && sid === SID) { attachFill({ id: it.id, orderId: it.oid, t: num(it.t || d.t) || Date.now(), px: num(it.px), qty: num(it.sz), fee: num(it.fee), maker: !!it.m }); serial(() => refreshOwn().catch(() => {})); continue; }
      if (!l) continue;
      if (m.e === 'OrderFill') { const prod = byTicker[it.s]; if (!prod) continue; if (it.id) { if (seen.has(it.id)) continue; seen.add(it.id); if (seen.size > 5000) seen.delete(seen.values().next().value); } onFill(l, prod, { q: (String(it.sd) === '0' ? 1 : -1) * num(it.sz), px: num(it.px), oid: it.oid || it.id, t: num(it.t || d.t) || serverNow() }); }
      else if (m.e === 'SubaccountLiquidation') { note('leader', `${who(l)}: liquidation event`); push('Leader liquidated', who(l)); setTimeout(() => serial(() => resync(l, 'liquidation')), 1500); }
      else if (m.e === 'PositionUpdate') { clearTimeout(puTimer[l.sid]); puTimer[l.sid] = setTimeout(() => { delete puTimer[l.sid]; serial(() => resync(l, 'position update')); }, 4000); }   // after the fills of the same order have been handled
    }
  };
  connect();
  setInterval(() => { if (sock && sock.readyState === 1 && Date.now() - (S.lastMsg || S.startedAt) > 120000) { try { sock.close(); } catch (_) {} } }, 30000);   // a silent socket is a dead socket
  setInterval(() => serial(() => refreshOwn().catch((e) => note('warn', 'own account: ' + e.message))), 30000);
  setInterval(() => { for (const l of cfg.leaders) serial(() => resync(l, 'periodic')); }, 5 * 60000);
  // the clock drifts (and Windows may step it): a signedAt outside the exchange's tolerance would fail every order, closes
  // included, so the offset is measured again every five minutes (and after any rejection about the time, in place)
  setInterval(async () => { const was = clockOffset; await syncClock(); S.clockOffset = clockOffset; if (Math.abs(clockOffset - was) > 1000) note('warn', `the clock offset to the exchange moved ${((clockOffset - was) / 1000).toFixed(1)} s (now ${(clockOffset / 1000).toFixed(1)} s); signing uses the new one`); }, 5 * 60000);

  // ---- local status port for the site's Copy agent page: 127.0.0.1 only, answering to its own Host name only (DNS
  //      rebinding), to the site's origin and the local dev server's only, and the token on every request, /status too
  const port = (cfg.status && cfg.status.port) || 8790;
  const origins = new Set([SITE, 'http://localhost:8787', 'http://127.0.0.1:8787'].concat(((cfg.status && cfg.status.origins) || []).filter((o) => typeof o === 'string')));
  const tokenHash = createHash('sha256').update(ctl.token).digest();
  const tokenOk = (t) => typeof t === 'string' && timingSafeEqual(createHash('sha256').update(t).digest(), tokenHash);   // hashed: equal lengths, and the time taken says nothing about the token
  http.createServer(async (req, res) => {
    const origin = req.headers.origin; const cors = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' };
    if (origin && origins.has(origin)) Object.assign(cors, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'content-type, x-agent-token', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Private-Network': 'true' });
    const deny = (code, error) => { res.writeHead(code, cors); res.end(JSON.stringify({ error })); };
    if (!hostOk(req.headers.host, port)) return deny(403, 'host');
    if (origin && !origins.has(origin)) return deny(403, 'origin');
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }   // a preflight carries no token; the request after it must
    if (!tokenOk(req.headers['x-agent-token'])) return deny(401, 'token');
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/status') { res.writeHead(200, cors); return res.end(JSON.stringify(Object.assign({}, S, { uptime: Date.now() - S.startedAt, now: Date.now() }))); }
    if (req.method === 'POST') {
      let bodyTxt = ''; for await (const c of req) { bodyTxt += c; if (bodyTxt.length > 65536) return deny(413, 'body'); } let bodyJ = {}; try { bodyJ = JSON.parse(bodyTxt || '{}'); } catch (_) {}
      if (url.pathname === '/pause') { S.paused = true; note('control', 'paused from the site'); persist(); }
      else if (url.pathname === '/resume') { S.paused = false; S.tripped = null; note('control', 'resumed from the site'); persist(); }
      else if (url.pathname === '/close-all') { note('control', 'close all from the site'); await serial(() => closeAll('closed from the site')); }
      else if (url.pathname === '/resync') { note('control', 'resync from the site'); for (const l of cfg.leaders) await serial(() => resync(l, 'manual')); await serial(() => refreshOwn().catch(() => {})); }
      else if (url.pathname === '/simulate' && DRY) { const l = cfg.leaders[0]; const prod = Object.values(byId).find((p) => p.displayTicker === bodyJ.ticker); if (l && prod) { note('control', `simulated leader fill ${bodyJ.side} ${bodyJ.qty} ${bodyJ.ticker}`); route({ e: 'OrderFill', data: { sid: l.sid, d: [{ sid: l.sid, s: prod.ticker, sd: bodyJ.side === 'SELL' ? 1 : 0, sz: String(bodyJ.qty), px: String(bodyJ.px != null ? bodyJ.px : markOf(prod.id)), t: bodyJ.t ? num(bodyJ.t) : undefined, oid: bodyJ.oid || 'sim-' + Date.now(), id: 'sim-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) }] } }); } }
      else { res.writeHead(404, cors); return res.end('{"error":"unknown"}'); }
      res.writeHead(200, cors); return res.end('{"ok":true}');
    }
    res.writeHead(404, cors); res.end('{"error":"unknown"}');
  }).listen(port, '127.0.0.1', () => log(`status on http://127.0.0.1:${port}/status (token from ${ctl.from}) · open ${SITE}/#/copytrade/agent`));
  process.on('SIGINT', () => { note('stop', 'agent stopped (positions stay open; the next start adopts them)'); persist(); process.exit(0); });
}

// ---------------------------------------------------------------- main
const commands = { keygen, link, run, status, help: async () => console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?\s?/, '')) };
commands[ARGS.cmd]().catch((e) => { console.error(e.message || e); process.exit(1); });
