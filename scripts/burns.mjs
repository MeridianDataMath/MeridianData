/**
 * The snapshot builder's reader of position-token burns on Robinhood Chain: when a trading wallet redeemed the tokens
 * its ledger still held at a verdict that pays (rd in its file, the tax center's claim dates through P.redemptionTimes).
 * A claim burns the wallet's whole balance of a token (Transfer holder → 0x0, emitted by the token).
 *
 * What the RPC (rpc.mainnet.chain.robinhood.com) answers, read on 2026-10-03: eth_getLogs spans at most 30 000 blocks
 * without an address filter, 100 000 with several addresses (or several values in one topic) and 10 000 000 with one
 * address; logs carry blockTimestamp 0x0, so block times are read apart. So each token is read on its own (its address;
 * topics Transfer, any holder, zero) in ranges of 10M blocks, from the first block it can exist in (the block of the
 * first placement on its pick configuration, else Predict's launch block) to the chain head. A refused range takes the
 * width the refusal names ('but only N are allowed'), else half, and keeps it. Each token's progress, width and burns
 * (every holder's: a wallet that turns out to hold it later finds its burns there) persist in the cache across runs,
 * so a run reads only new blocks, and a token whose every holder has redeemed is not read again.
 * No file and no network of its own: the builder hands it an rpc (scripts/build-snapshot.mjs, attachRedemptions).
 */

export const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const pad32 = (a) => '0x' + String(a).slice(2).toLowerCase().padStart(64, '0');
const ZERO = pad32('0x0');
const hex = (n) => '0x' + n.toString(16);
/** the last block at or before Predict's launch (P.LAUNCH_SEC, 2026-06-29 00:00:00 UTC), found by bisecting block
 *  times on 2026-10-03: no position token exists before it */
export const LAUNCH_BLOCK = 328896;
/** the widest range the RPC answers for one address (2026-10-03) */
export const SPAN = 10000000;
export const MIN_SPAN = 1000;

/** The width to try after a refusal: the one it names ('… but only N are allowed …') when narrower, else half. */
export function nextSpan(msg, span) {
  const m = /only (\d+) are allowed/i.exec(String(msg || ''));
  const n = m ? Number(m[1]) : NaN;
  return Math.max(MIN_SPAN, n > 0 && n < span ? n : Math.floor(span / 2));
}
// a refusal for pace, not for the range: the width stays
const PACE = /rate limit|429|too many requests|no answer/i;

/**
 * Reads the burns of the tokens in o.want ([{token, tx (the first placement on its pick configuration, for its start
 * block; optional)}]) up to o.head, from o.state (the cache's burnRead, mutated: {span (the width learned for one
 * address), t: {token: {f (first block), b (last block read), s (width), l: [[holder, amount, block time (s)]]}}}).
 * o: {rpc(calls) → one answer per call ({result} or {error}), state, want, head, cap (calls this run, start blocks and
 * block times included), batch (calls per request, 10), pause (ms between requests), sleep, log, launch}.
 * The tokens read furthest go first (a call each), so the cap goes to new ones after. Progress is kept range by range,
 * each range with its burns once every burn in it has its block time (else the next run reads it again); a width
 * learned from a refusal is kept anyway.
 * Returns {calls, refused, read (tokens of want read to the head)}.
 */
export async function readBurns(o) {
  const st = o.state; if (!st.t) st.t = {};
  const head = o.head, cap = o.cap, batch = o.batch || 10, launch = o.launch != null ? o.launch : LAUNCH_BLOCK;
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))), log = o.log || (() => {});
  let calls = 0, refused = 0, said = false;
  const ask = async (list) => { calls += list.length; const r = await o.rpc(list); if (o.pause) await sleep(o.pause); return r; };
  const want = []; const seen = new Set();
  for (const w of o.want || []) { const tok = String(w.token || '').toLowerCase(); if (/^0x[0-9a-f]{40}$/.test(tok) && !seen.has(tok)) { seen.add(tok); want.push({ tok, tx: w.tx || null }); } }
  // a new token starts at the block of the first placement on its pick configuration (no burn can come before it)
  const fresh = want.filter((w) => !st.t[w.tok]);
  for (let i = 0; i < fresh.length; i += batch) {
    const part = fresh.slice(i, i + batch), withTx = part.filter((w) => w.tx);
    let res = [];
    if (withTx.length && calls + withTx.length <= cap) {
      try { res = await ask(withTx.map((w) => ({ method: 'eth_getTransactionReceipt', params: [w.tx] }))); } catch (e) { res = []; }
    }
    for (const w of part) {
      const k = withTx.indexOf(w), r = k >= 0 ? res[k] : null;
      const bn = r && r.result && r.result.blockNumber ? parseInt(r.result.blockNumber, 16) : NaN;
      const f = Number.isFinite(bn) && bn >= launch ? bn : launch;
      st.t[w.tok] = { f, b: f - 1, s: st.span || SPAN, l: [] };
    }
  }
  const work = want.map((w) => ({ tok: w.tok, x: st.t[w.tok] })).filter((s) => s.x.b < head)
    .map((s) => Object.assign(s, { fails: 0, stalled: false })).sort((a, b) => b.x.b - a.x.b);
  const times = new Map();   // block → its time (s), this run
  while (calls < cap) {
    const active = work.filter((s) => s.x.b < head && !s.stalled && s.fails < 20).slice(0, Math.min(batch, cap - calls));
    if (!active.length) break;
    const span = (s) => [s.x.b + 1, Math.min(head, s.x.b + s.x.s)];
    let res;
    try { res = await ask(active.map((s) => ({ method: 'eth_getLogs', params: [{ address: s.tok, fromBlock: hex(span(s)[0]), toBlock: hex(span(s)[1]), topics: [TRANSFER, null, ZERO] }] }))); }
    catch (e) { log('  predict: burn logs failed, the rest is read next run: ' + e.message); break; }
    const got = [];
    const asked = active.map(span);
    active.forEach((s, i) => {
      const r = res[i];
      if (r && !r.error && Array.isArray(r.result)) { s.fails = 0; got.push({ s, to: asked[i][1], logs: r.result }); return; }
      const msg = r && r.error ? String(r.error.message || r.error.code || 'error') : 'no answer';
      s.fails++; refused++;
      if (!said) { said = true; log('  predict: the RPC refused a burn-log range: ' + msg.slice(0, 240)); }   // once a run
      if (PACE.test(msg)) return;
      // from the width asked (another refusal in the same batch may have narrowed it already)
      s.x.s = Math.min(s.x.s, nextSpan(msg, asked[i][1] - asked[i][0] + 1));
      // the width the RPC names holds for every address: the other tokens take it too
      if (/only \d+ are allowed/i.test(msg)) { st.span = s.x.s; for (const z of work) if (z.x.s > st.span) z.x.s = st.span; }
    });
    // the block times of the burns just read (few: one per claim; the logs' own blockTimestamp is 0x0 on this RPC)
    for (const g of got) for (const l of g.logs) { const bn = parseInt(l.blockNumber, 16), ts = l.blockTimestamp ? parseInt(l.blockTimestamp, 16) : 0; if (ts > 0) times.set(bn, ts); }
    const need = Array.from(new Set(got.flatMap((g) => g.logs.map((l) => parseInt(l.blockNumber, 16))))).filter((bn) => !times.has(bn));
    for (let i = 0; i < need.length && calls < cap; i += batch) {
      const part = need.slice(i, i + Math.min(batch, cap - calls));
      try { const r = await ask(part.map((bn) => ({ method: 'eth_getBlockByNumber', params: [hex(bn), false] }))); part.forEach((bn, k) => { const b = r[k] && r[k].result; const ts = b && b.timestamp ? parseInt(b.timestamp, 16) : 0; if (ts > 0) times.set(bn, ts); }); }
      catch (e) { log('  predict: block times failed: ' + e.message); break; }
    }
    // a range is kept with its burns once every burn in it has its time; otherwise the token waits for the next run,
    // which reads that range again
    for (const g of got) {
      const rows = g.logs.map((l) => ['0x' + String((l.topics && l.topics[1]) || '').slice(-40).toLowerCase(), Number(BigInt(l.data && l.data !== '0x' ? l.data : '0x0')) / 1e18, times.get(parseInt(l.blockNumber, 16))]);
      if (rows.some((r) => !r[2])) { g.s.stalled = true; continue; }
      g.s.x.l = g.s.x.l.concat(rows); g.s.x.b = g.to;
    }
  }
  return { calls, refused, read: want.filter((w) => st.t[w.tok].b >= head).length };
}

/**
 * Each wallet's own redemptions from what is read: held {wallet: {'<pc>|<P|C>': {tokens, after}}} (what its ledger
 * held at a verdict that pays), tokOf {'<pc>|<P|C>': token}, byTok {token: '<pc>|<P|C>'}, state (readBurns'), head,
 * redemptionTimes (P.redemptionTimes). A held position counts once its redemption is found or its token is read to the
 * head (then it was not redeemed); a wallet gets rd only when every one of them counts (a position whose token is not
 * known never does). Returns {rd: {wallet: {'<pc>|<P|C>': ms}}, open (the tokens still to read: some holder's
 * redemption not found and not read to the head)}.
 */
export function redemptions({ held, tokOf, byTok, state, head, redemptionTimes }) {
  const T = (state && state.t) || {};
  const rd = {}, open = new Set();
  for (const w of Object.keys(held)) {
    const keys = Object.keys(held[w]), logs = [];
    for (const k of keys) { const tok = tokOf[k], x = tok ? T[tok] : null; if (x) for (const [h, amount, t] of x.l) if (h === w) logs.push({ token: tok, amount, t: t * 1000 }); }
    const got = redemptionTimes(logs, byTok, held[w]);
    let whole = true;
    for (const k of keys) {
      if (got[k] != null) continue;
      const tok = tokOf[k];
      if (!tok) { whole = false; continue; }
      if (!T[tok] || T[tok].b < head) { whole = false; open.add(tok); }
    }
    if (whole) rd[w] = got;
  }
  return { rd, open };
}
