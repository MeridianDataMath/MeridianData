/* MeridianDataHub — Meridian API client (REST, Archive, TradingView candles, WebSocket) */
(function () {
  const MD = window.MD; const U = MD.util;
  const A = (MD.api = {});

  A.BASE = 'https://api.meridian.xyz';
  A.ARCHIVE = 'https://archive.meridian.xyz';
  A.TV = 'https://tradingview.meridian.xyz';
  A.WS_URL = 'wss://ws.meridian.xyz/v1/stream';
  A.MAX_LIMIT = 200;
  A.SITE_URL = 'https://meridian.thedatahub.xyz';
  /** Share link with a preview card: /a/<address> (perps account) or /p/<address> (Predict wallet). The pages behind them
   *  are written at deploy time (scripts/build-cards.mjs) and send visitors on to the account; unfurlers read the card. */
  A.shareUrl = (kind, address) => A.SITE_URL + '/' + kind + '/' + String(address || '').toLowerCase();
  A.APP_URL = 'https://app.meridian.xyz/?ref=BJ9Y51H9XB1L'; // every link to the Meridian app carries the site owner's referral code

  // ---------- fetch with cache / in-flight dedupe ----------
  const cache = new Map();
  const inflight = new Map();
  A.clearCache = (prefix) => { for (const k of Array.from(cache.keys())) if (!prefix || k.startsWith(prefix)) cache.delete(k); };

  class ApiError extends Error {
    constructor(status, message, url) { super(message); this.status = status; this.url = url; }
  }
  A.ApiError = ApiError;

  async function rawGet(url, signal) {
    let res;
    try {
      res = await fetch(url, { signal, headers: { accept: 'application/json' } });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      throw new ApiError(0, 'Network error: ' + (e && e.message ? e.message : e), url);
    }
    if (res.status === 429) {
      const reset = parseInt(res.headers.get('ratelimit-reset') || '3', 10);
      await U.sleep(Math.min(10, Math.max(1, reset)) * 1000);
      if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
      res = await fetch(url, { signal, headers: { accept: 'application/json' } });
    }
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }
    if (!res.ok) {
      const msg = body && body.message ? (Array.isArray(body.message) ? body.message.join('; ') : body.message) : res.statusText || ('HTTP ' + res.status);
      throw new ApiError(res.status, msg, url);
    }
    return body;
  }

  /** GET with optional TTL cache (ms). Identical concurrent requests share one fetch. */
  A.get = async function (url, opts = {}) {
    const ttl = opts.ttl || 0;
    if (ttl) {
      const c = cache.get(url);
      if (c && c.exp > Date.now()) return c.value;
    }
    if (inflight.has(url)) return inflight.get(url);
    const p = rawGet(url, opts.signal).then((v) => { if (ttl) cache.set(url, { exp: Date.now() + ttl, value: v }); inflight.delete(url); return v; }, (e) => { inflight.delete(url); throw e; });
    inflight.set(url, p);
    return p;
  };

  const qs = (params) => {
    const parts = [];
    for (const [k, v] of Object.entries(params || {})) {
      if (v == null || v === '') continue;
      if (Array.isArray(v)) v.forEach((x) => parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(x)));
      else parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    }
    return parts.length ? '?' + parts.join('&') : '';
  };
  A.qs = qs;

  /** Cursor pagination: collects up to maxPages pages of `limit` rows. */
  A.page = async function (base, path, params, opts = {}) {
    const limit = Math.min(A.MAX_LIMIT, opts.limit || A.MAX_LIMIT);
    const maxPages = opts.maxPages || 50;
    const rows = []; let cursor = null; let pages = 0; let hasNext = false;
    do {
      const url = base + path + qs(Object.assign({}, params, { limit, cursor }));
      const r = await A.get(url, { ttl: opts.ttl, signal: opts.signal });
      const data = (r && r.data) || [];
      rows.push(...data);
      hasNext = !!(r && r.hasNext && r.nextCursor);
      cursor = hasNext ? r.nextCursor : null;
      pages++;
    } while (hasNext && pages < maxPages);
    rows.truncated = hasNext;
    return rows;
  };
  /** Single page with cursor (for server-side paged tables). */
  A.pageOne = async function (base, path, params, opts = {}) {
    const url = base + path + qs(Object.assign({}, params, { limit: Math.min(A.MAX_LIMIT, opts.limit || 25), cursor: opts.cursor || null }));
    const r = await A.get(url, { ttl: opts.ttl, signal: opts.signal });
    return { rows: (r && r.data) || [], hasNext: !!(r && r.hasNext), nextCursor: r && r.nextCursor };
  };

  // ---------- Reference data (products, tokens) ----------
  const REF_TTL = 5 * 60 * 1000;
  A.products = (o) => A.get(A.BASE + '/v1/product?limit=200', { ttl: REF_TTL, signal: o && o.signal }).then((r) => r.data || []);
  A.tokens = (o) => A.get(A.BASE + '/v1/token?limit=200', { ttl: REF_TTL, signal: o && o.signal }).then((r) => r.data || []);
  /** Products + tokens with lookup maps. */
  A.ref = async function (o) {
    const [products, tokens] = await Promise.all([A.products(o), A.tokens(o)]);
    const byId = {}, byTicker = {}, tokenById = {}, tokenByAddr = {};
    for (const p of products) { byId[p.id] = p; byTicker[p.ticker] = p; }
    for (const t of tokens) { tokenById[t.id] = t; tokenByAddr[String(t.address).toLowerCase()] = t; }
    const active = products.filter((p) => p.status === 'ACTIVE');
    return { products, active, byId, byTicker, tokens, tokenById, tokenByAddr };
  };
  A.marketPrices = async (ids, o) => {
    if (!ids || !ids.length) return {};
    const r = await A.get(A.BASE + '/v1/product/market-price' + qs({ productIds: ids }), { ttl: (o && o.ttl) || 5000, signal: o && o.signal });
    const m = {}; for (const x of r.data || []) m[x.productId] = x; return m;
  };
  A.projectedFunding = async (ids, o) => {
    const r = await A.get(A.BASE + '/v1/funding/projected-rate' + qs({ productIds: ids }), { ttl: 30000, signal: o && o.signal });
    const m = {}; for (const x of r.data || []) m[x.productId] = x; return m;
  };
  A.liquidity = (pid, o) => A.get(A.BASE + '/v1/product/market-liquidity' + qs({ productId: pid }), { signal: o && o.signal });
  A.trades = (pid, limit, o) => A.get(A.BASE + '/v1/order/trade' + qs({ productId: pid, limit: limit || 50 }), { ttl: (o && o.ttl) || 0, signal: o && o.signal }).then((r) => r.data || []);
  /** One order by id (public): the way to learn which subaccount stood behind a trade from the REST history. Filled orders never change. */
  A.order = (id, o) => A.get(A.BASE + '/v1/order/' + encodeURIComponent(id), { ttl: o && o.ttl != null ? o.ttl : 6 * 3600000, signal: o && o.signal });
  A.liquidations = (limit, o) => A.get(A.BASE + '/v1/position/liquidation' + qs({ limit: limit || 50 }), { ttl: 15000, signal: o && o.signal }).then((r) => r.data || []);
  A.gaps = (ids, start, end, o) => A.page(A.BASE, '/v1/product/mark-price-gap', { productIds: ids, startTime: start, endTime: end }, { ttl: 60000, maxPages: 5, signal: o && o.signal });
  A.fundingHistory = (pid, start, end, o) => A.page(A.BASE, '/v1/funding', { productId: pid, startTime: start, endTime: end }, { ttl: 60000, maxPages: 10, signal: o && o.signal });
  A.maintenance = (o) => A.get(A.BASE + '/v1/maintenance', { ttl: 60000, signal: o && o.signal });
  A.serverTime = (o) => A.get(A.BASE + '/v1/time', { signal: o && o.signal });

  // ---------- Accounts ----------
  A.allSubaccounts = (o) => A.page(A.BASE, '/v1/subaccount/all', {}, { ttl: (o && o.ttl) || 60000, maxPages: 100, signal: o && o.signal });
  A.subaccountsOf = (address, o) => A.page(A.BASE, '/v1/subaccount', { sender: String(address).toLowerCase() }, { ttl: 60000, signal: o && o.signal });
  A.subaccount = (id, o) => A.get(A.BASE + '/v1/subaccount/' + encodeURIComponent(id), { ttl: 60000, signal: o && o.signal });
  A.balances = (sid, o) => A.page(A.BASE, '/v1/subaccount/balance', { subaccountId: sid }, { ttl: (o && o.ttl) || 0, signal: o && o.signal });
  A.openPositions = (sid, o) => A.page(A.BASE, '/v1/position', { subaccountId: sid, open: true }, { ttl: (o && o.ttl) || 0, signal: o && o.signal }).then((rows) => rows.filter((p) => U.num(p.size) !== 0));
  A.positions = (sid, o) => A.page(A.BASE, '/v1/position', { subaccountId: sid }, { maxPages: (o && o.maxPages) || 10, ttl: (o && o.ttl) || 0, signal: o && o.signal });
  A.positionsPage = (sid, cursor, limit, o) => A.pageOne(A.BASE, '/v1/position', { subaccountId: sid }, { cursor, limit, signal: o && o.signal });
  A.positionFills = (positionId, o) => A.page(A.BASE, '/v1/position/fill', { positionId }, { maxPages: 5, ttl: 60000, signal: o && o.signal });
  A.openOrders = (sid, o) => A.page(A.BASE, '/v1/order', { subaccountId: sid, isWorking: true }, { maxPages: 5, signal: o && o.signal });
  /** Untriggered stop orders (take profit / stop loss) — a separate filter from working orders. */
  A.pendingOrders = (sid, o) => A.page(A.BASE, '/v1/order', { subaccountId: sid, isPending: true }, { maxPages: 5, signal: o && o.signal });
  /** Working + pending orders in one list. */
  A.activeOrders = async (sid, o) => { const [w, p] = await Promise.all([A.openOrders(sid, o).catch(() => []), A.pendingOrders(sid, o).catch(() => [])]); const seen = new Set(); return w.concat(p).filter((x) => (seen.has(x.id) ? false : seen.add(x.id))); };
  A.fillsPage = (sid, cursor, limit, o) => A.pageOne(A.BASE, '/v1/order/fill', { subaccountId: sid }, { cursor, limit, signal: o && o.signal });
  A.fills = (sid, o) => A.page(A.BASE, '/v1/order/fill', { subaccountId: sid, createdAfter: o && o.after }, { maxPages: (o && o.maxPages) || 10, signal: o && o.signal });
  A.transfersPage = (sid, cursor, limit, o) => A.pageOne(A.BASE, '/v1/token/transfer', { subaccountId: sid }, { cursor, limit, signal: o && o.signal });
  A.transfers = (sid, o) => A.page(A.BASE, '/v1/token/transfer', { subaccountId: sid }, { maxPages: 10, signal: o && o.signal });
  A.usdeTransfers = (address, o) => A.page(A.BASE, '/v1/usde/transfer', { address: String(address).toLowerCase() }, { maxPages: 3, ttl: 60000, signal: o && o.signal });
  A.signers = (sid, o) => A.page(A.BASE, '/v1/linked-signer', { subaccountId: sid }, { maxPages: 2, ttl: 60000, signal: o && o.signal });
  A.pointsSummary = (address, o) => A.get(A.BASE + '/v1/points/summary' + qs({ address: String(address).toLowerCase() }), { ttl: 60000, signal: o && o.signal }).then((r) => r.data || []);
  A.points = (address, season, epoch, o) => A.get(A.BASE + '/v1/points' + qs({ address: String(address).toLowerCase(), season, epoch }), { ttl: 60000, signal: o && o.signal }).then((r) => r.data || []);
  A.pointsTotal = (o) => A.get(A.BASE + '/v1/points/total', { ttl: 5 * 60000, signal: o && o.signal });

  // ---------- Archive (history) ----------
  A.RES = {
    hour1: { ms: U.HOUR, max: 3 * U.DAY },
    hour2: { ms: 2 * U.HOUR, max: 7 * U.DAY },
    hour4: { ms: 4 * U.HOUR, max: 14 * U.DAY },
    hour8: { ms: 8 * U.HOUR, max: 30 * U.DAY },
    hour12: { ms: 12 * U.HOUR, max: 60 * U.DAY },
    day1: { ms: U.DAY, max: 120 * U.DAY },
    week1: { ms: 7 * U.DAY, max: 364 * U.DAY },
    month1: { ms: 30 * U.DAY, max: Infinity },
  };
  A.totalVolume = (sid, o) => A.get(A.ARCHIVE + '/v1/subaccount/total-volume' + qs({ subaccountId: sid }), { ttl: (o && o.ttl) || 0, signal: o && o.signal }).then((r) => U.num(r && r.volumeUsd));
  /**
   * History rows for kind in {balance, unrealized-pnl, volume}, automatically chunked to the
   * resolution's max range and paginated. Returns rows sorted ascending by time.
   */
  A.history = async function (kind, sid, { start, end, resolution, signal, ttl }) {
    const res = A.RES[resolution]; if (!res) throw new Error('bad resolution ' + resolution);
    end = end || Date.now();
    start = Math.floor(start / res.ms) * res.ms;
    const rows = [];
    let s = start;
    const chunk = Math.min(res.max, 400 * U.DAY) - 1000;
    const seen = new Set();
    while (s < end) {
      const e = Math.min(end, s + chunk);
      // the archive rejects an endTime later than its own clock; when the chunk ends "now", let the server default it
      const endParam = e >= Date.now() - 2 * 60000 ? null : e;
      const part = await A.page(A.ARCHIVE, '/v1/subaccount/' + kind, { subaccountId: sid, startTime: s, endTime: endParam, resolution, order: 'asc' }, { maxPages: 40, ttl: ttl || 0, signal });
      // chunks (and the server's clamping to bucket boundaries) can repeat the boundary bucket → dedupe
      for (const r of part) { const k = r.time + '|' + (r.tokenId || ''); if (seen.has(k)) continue; seen.add(k); rows.push(r); }
      s = e;
    }
    rows.sort((a, b) => a.time - b.time);
    return rows;
  };

  // ---------- Candles (TradingView UDF) ----------
  A.candles = async function (ticker, resolution, fromMs, toMs, countback, o) {
    const url = A.TV + '/v1/oracle-price/history' + qs({ symbol: ticker + '-Perp', resolution, from: Math.floor(fromMs / 1000), to: Math.floor(toMs / 1000), countback });
    const r = await A.get(url, { ttl: 60000, signal: o && o.signal });
    if (!r || r.s !== 'ok') return [];
    return r.t.map((t, i) => ({ t: t * 1000, o: r.o[i], h: r.h[i], l: r.l[i], c: r.c[i], v: r.v[i] }));
  };

  // ---------- WebSocket stream ----------
  const WS = (A.ws = {
    sock: null, status: 'closed', subs: new Map(), handlers: new Map(), statusFns: new Set(), retry: 0, idleT: null,
    key(type, id) { return type + '|' + id; },
    onStatus(fn) { this.statusFns.add(fn); fn(this.status); return () => this.statusFns.delete(fn); },
    setStatus(s) { this.status = s; this.statusFns.forEach((f) => { try { f(s); } catch (_) {} }); },
    ensure() {
      if (this.sock && (this.sock.readyState === 0 || this.sock.readyState === 1)) return;
      clearTimeout(this.idleT);
      this.setStatus('connecting');
      let sock;
      try { sock = new WebSocket(A.WS_URL); } catch (e) { this.setStatus('closed'); return; }
      this.sock = sock;
      sock.onopen = () => {
        this.retry = 0; this.setStatus('open');
        for (const [, sub] of this.subs) this.send(sub.payload);
      };
      sock.onmessage = (ev) => { this.lastMsg = Date.now(); let m; try { m = JSON.parse(ev.data); } catch (_) { return; } this.route(m); };
      this.lastMsg = Date.now();
      this.watch();
      sock.onclose = () => {
        this.setStatus('closed');
        if (this.subs.size) { const d = Math.min(15000, 500 * Math.pow(2, this.retry++)); setTimeout(() => this.ensure(), d); }
      };
      sock.onerror = () => {};
    },
    send(obj) { if (this.sock && this.sock.readyState === 1) this.sock.send(JSON.stringify(obj)); },
    /** A socket can stay "open" after the laptop slept or the network blipped while nothing arrives any more (tickers
     *  normally come every second). Silence for 45 s, coming back online, or the tab becoming visible again after a
     *  quiet spell all force a reconnect, so the status dot and the data are honest. */
    watch() {
      if (this.watchT) return;
      const stale = (ms) => this.sock && this.sock.readyState === 1 && this.subs.size && Date.now() - (this.lastMsg || 0) > ms;
      const kick = () => { try { this.sock.close(); } catch (_) {} };
      this.watchT = setInterval(() => { if (stale(45000)) kick(); }, 15000);
      window.addEventListener('online', () => { if (stale(5000)) kick(); });
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && stale(10000)) kick(); });
    },
    route(m) {
      if (!m || !m.e) return;
      const d = m.data || {};
      const keys = [];
      if (d.s) keys.push(this.key(m.e, d.s));
      if (d.sid) keys.push(this.key(m.e, d.sid));
      if (Array.isArray(d.d)) for (const it of d.d) if (it && it.sid) keys.push(this.key(m.e, it.sid));
      const seen = new Set();
      for (const k of keys) {
        if (seen.has(k)) continue; seen.add(k);
        const hs = this.handlers.get(k); if (!hs) continue;
        hs.forEach((h) => { try { h(m); } catch (e) { console.error(e); } });
      }
    },
    /** subscribe('Ticker', 'BTCUSD', fn) / subscribe('OrderFill', '<sid>', fn). Returns unsubscribe fn. */
    subscribe(type, id, handler) {
      const k = this.key(type, id);
      if (!this.handlers.has(k)) this.handlers.set(k, new Set());
      this.handlers.get(k).add(handler);
      if (!this.subs.has(k)) {
        const data = /^(L2Book|Ticker|TradeFill)$/.test(type) ? { type, symbol: id } : { type, subaccountId: id };
        const payload = { event: 'subscribe', data };
        this.subs.set(k, { payload });
        this.send(payload);
      }
      this.ensure();
      return () => {
        const hs = this.handlers.get(k); if (hs) hs.delete(handler);
        if (!hs || hs.size === 0) {
          this.handlers.delete(k);
          const sub = this.subs.get(k);
          if (sub) { this.subs.delete(k); this.send(Object.assign({}, sub.payload, { event: 'unsubscribe' })); }
          if (this.subs.size === 0) { clearTimeout(this.idleT); this.idleT = setTimeout(() => { if (this.subs.size === 0 && this.sock) { try { this.sock.close(); } catch (_) {} } }, 20000); }
        }
      };
    },
  });
})();
