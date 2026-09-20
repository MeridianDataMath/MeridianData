/* MeridianDataHub — leader alerts: follow subaccounts and get told when they open, add, reduce, close, reverse or get
   liquidated, straight from the exchange WebSocket. Runs in one tab of this browser (the "owner", elected through
   localStorage so several open tabs do not double-send); delivers as a toast, a browser notification, and optionally an
   ntfy push to a phone. Everything lives in localStorage; nothing is sent anywhere but ntfy when a topic is set. */
(function () {
  const MD = window.MD; const U = MD.util; const A = MD.api;
  const AL = (MD.alerts = {});
  const KEY = 'md.alerts.v1', OWNER = 'md.alerts.owner';
  const TAB = Math.random().toString(36).slice(2, 10);
  const DEF = () => ({ v: 1, leaders: [], events: { open: true, add: false, reduce: false, close: true, reverse: true, liq: true }, minNotional: 0, browser: true, ntfy: { server: 'https://ntfy.sh', topic: '' }, history: [] });
  AL.MAX_LEADERS = 15;   // each followed account takes two account streams of the socket's fifty
  let st = null; const subs = new Map(); const pos = {}; const posAt = {}; const pending = new Map(); const seenFills = new Set(); let owner = false; let ownerT = null; let started = false;
  /** The leader's open sizes per market, and per market the time of the last fill the exchange's position records show
   *  (open records carry the sizes, the newest records the closes). A fill at or before that time is already inside the
   *  size read, so the socket's copy of it must not be added again when the two meet (see flush). */
  async function readPositions(sid) {
    const [open, recent] = await Promise.all([A.openPositions(sid), A.page(A.BASE, '/v1/position', { subaccountId: sid }, { maxPages: 1, limit: 50 }).catch(() => [])]);
    const cur = {}, at = {};
    for (const p of open.concat(recent)) { const t = U.num(p.updatedAt) || U.num(p.createdAt); if (t > (at[p.productId] || 0)) at[p.productId] = t; }
    for (const p of open) cur[p.productId] = U.num(p.size);
    pos[sid] = cur; posAt[sid] = at;
  }

  AL.state = () => (st || (st = Object.assign(DEF(), U.storage.get(KEY, null) || {})));
  AL.save = () => { U.storage.set(KEY, st); U.emit('alerts'); };
  AL.isFollowed = (sid) => AL.state().leaders.some((l) => l.sid === sid);
  AL.follow = (l) => { const s = AL.state(); if (s.leaders.some((x) => x.sid === l.sid)) return true; if (s.leaders.length >= AL.MAX_LEADERS) { U.toast(`Up to ${AL.MAX_LEADERS} leaders can be followed`); return false; } s.leaders.unshift({ sid: l.sid, address: String(l.address || '').toLowerCase(), name: l.name || '', addedAt: Date.now() }); AL.save(); AL.start(); AL.sync(); return true; };
  AL.unfollow = (sid) => { const s = AL.state(); s.leaders = s.leaders.filter((l) => l.sid !== sid); AL.save(); AL.sync(); };
  AL.toggle = (l) => (AL.isFollowed(l.sid) ? (AL.unfollow(l.sid), false) : AL.follow(l));
  AL.isOwner = () => owner;

  // ---- one tab does the listening: the owner claims a heartbeat in localStorage and the others follow its history
  const STALE = 90000;   // a hidden tab's timers may run once a minute, so its heartbeat must count that long
  const claimOwner = () => {
    const o = U.storage.get(OWNER, null);
    if (o && o.id !== TAB && Date.now() - o.t < STALE) { if (owner) { owner = false; AL.sync(); U.emit('alerts'); } return; }
    U.storage.set(OWNER, { id: TAB, t: Date.now() });
    if (!owner) { owner = true; AL.since = Date.now(); AL.sync(); U.emit('alerts'); }
  };
  const heartbeat = () => {
    if (!owner) return claimOwner();
    const o = U.storage.get(OWNER, null);
    if (o && o.id !== TAB && Date.now() - o.t < STALE) { owner = false; AL.sync(); U.emit('alerts'); return; }   // another tab took over (both claimed at once)
    U.storage.set(OWNER, { id: TAB, t: Date.now() });
  };

  /** Start following (called once from the app; safe to call again). */
  AL.start = () => {
    if (started) return; started = true;
    AL.state();
    claimOwner();
    ownerT = setInterval(heartbeat, 5000);
    const release = () => { if (owner) U.storage.del(OWNER); };   // hand over at once when this tab goes away (pagehide fires where beforeunload does not)
    window.addEventListener('beforeunload', release); window.addEventListener('pagehide', release);
    window.addEventListener('storage', (e) => {
      if (e.key === KEY) {   // another tab followed / unfollowed, or the owner wrote history
        const before = st && st.history.length ? st.history[0].id : null;
        st = null; const now = AL.state();
        if (!owner && now.history.length && now.history[0].id !== before && Date.now() - now.history[0].t < 120000) U.toast(now.history[0].msg);
        U.emit('alerts'); if (owner) AL.sync();
      }
      if (e.key === OWNER && !e.newValue) claimOwner();                            // the owner tab closed
    });
    AL.sync();
  };

  /** Bring the socket subscriptions in line with the followed list (owner only). */
  AL.sync = async () => {
    const s = AL.state();
    const want = owner ? new Set(s.leaders.map((l) => l.sid)) : new Set();
    for (const [sid, un] of subs) if (!want.has(sid)) { if (un) un(); else pendingUn.add(sid); subs.delete(sid); delete pos[sid]; }
    for (const sid of want) if (!subs.has(sid)) subscribeLeader(sid);
  };

  const pendingUn = new Set();   // unfollowed while its subscription was still being set up
  async function subscribeLeader(sid) {
    if (subs.has(sid)) return;
    subs.set(sid, null);           // claimed: a second call during the awaits below must not subscribe twice
    let ref; try { ref = await A.ref(); } catch (_) { subs.delete(sid); return; }
    // the leader's open positions now, so the first fill can be told apart from an add
    pos[sid] = {}; posAt[sid] = {};
    try { await readPositions(sid); } catch (_) {}
    const unFill = A.ws.subscribe('OrderFill', sid, (m) => {
      const d = m.data || {}; const items = Array.isArray(d.d) ? d.d : [];
      for (const it of items) { const prod = ref.byTicker[it.s]; if (!prod) continue; if (it.id) { if (seenFills.has(it.id)) continue; seenFills.add(it.id); if (seenFills.size > 2000) seenFills.delete(seenFills.values().next().value); } onFill(sid, prod, { q: (U.sideName(it.sd) === 'BUY' ? 1 : -1) * U.num(it.sz), px: U.num(it.px), t: U.num(it.t || d.t) || Date.now(), oid: it.oid || it.id }); }
    });
    const unLiq = A.ws.subscribe('SubaccountLiquidation', sid, (m) => {
      const d = m.data || {}; const items = Array.isArray(d.d) ? d.d : [d];
      for (const it of items) { const prod = it.s ? ref.byTicker[it.s] : null; emit({ sid, kind: 'liq', ticker: prod ? prod.displayTicker : (it.s || ''), pid: prod ? prod.id : null, qty: U.num(it.sz), px: U.num(it.px), t: Date.now(), notional: U.num(it.sz) * U.num(it.px) }); if (prod) pos[sid][prod.id] = 0; }
    });
    const un = () => { unFill(); unLiq(); };
    if (pendingUn.has(sid) || !subs.has(sid)) { pendingUn.delete(sid); un(); subs.delete(sid); return; }   // unfollowed meanwhile
    subs.set(sid, un);
    // resync positions now and then, in case a fill was missed while the socket reconnected
    const t = setInterval(async () => { if (!subs.has(sid)) { clearInterval(t); return; } try { await readPositions(sid); } catch (_) {} }, 10 * 60000);
  }

  /** Fills of one order arrive in pieces; gather them for a moment and classify the whole order once. */
  function onFill(sid, prod, f) {
    const key = sid + '|' + prod.id + '|' + f.oid;
    const cur = pending.get(key);
    if (cur) { cur.q += f.q; cur.notional += Math.abs(f.q) * f.px; cur.parts.push({ q: f.q, t: f.t }); clearTimeout(cur.timer); cur.timer = setTimeout(() => flush(key), 2500); return; }
    pending.set(key, { sid, prod, q: f.q, notional: Math.abs(f.q) * f.px, px: f.px, t: f.t, parts: [{ q: f.q, t: f.t }], timer: setTimeout(() => flush(key), 2500) });
  }
  function flush(key) {
    const e = pending.get(key); pending.delete(key); if (!e) return;
    const book = pos[e.sid] || (pos[e.sid] = {}); const at = (posAt[e.sid] || {})[e.prod.id] || 0;
    const qIn = e.parts.reduce((a, p) => a + (p.t > 0 && p.t <= at ? p.q : 0), 0);   // already inside the size read from the exchange
    const prev = (book[e.prod.id] || 0) - qIn; const next = prev + e.q; book[e.prod.id] = Math.abs(next) < 1e-9 ? 0 : next;
    const s = Math.sign; let kind;
    if (!prev) kind = 'open'; else if (!book[e.prod.id]) kind = 'close'; else if (s(next) !== s(prev)) kind = 'reverse'; else if (Math.abs(next) > Math.abs(prev)) kind = 'add'; else kind = 'reduce';
    emit({ sid: e.sid, kind, ticker: e.prod.displayTicker, pid: e.prod.id, qty: Math.abs(e.q), px: e.notional / Math.abs(e.q), notional: e.notional, side: kind === 'close' || kind === 'reduce' ? (prev > 0 ? 'LONG' : 'SHORT') : (next > 0 ? 'LONG' : 'SHORT'), t: e.t, tick: e.prod.tickSize });
  }

  const VERB = { open: 'opened', add: 'added to', reduce: 'reduced', close: 'closed', reverse: 'reversed into', liq: 'was liquidated on' };
  AL.describe = (a) => {
    const who = a.name && a.name !== 'primary' ? a.name : U.shortAddr(a.address || '', 4);
    const size = a.notional ? U.fmtUsd(a.notional, { compact: true, dp: 0 }) : '';
    if (a.kind === 'liq') return `${who} was liquidated${a.ticker ? ' on ' + a.ticker : ''}${size ? ' · ' + size : ''}`;
    return `${who} ${VERB[a.kind]} a ${a.side} on ${a.ticker}${size ? ' · ' + size : ''}${a.px ? ' @ ' + U.fmtPrice(a.px, a.tick) : ''}`;
  };

  function emit(a) {
    const s = AL.state(); const l = s.leaders.find((x) => x.sid === a.sid); if (!l) return;
    a.address = l.address; a.name = l.name; a.id = a.sid.slice(0, 8) + '-' + a.t + '-' + a.kind;
    if (!s.events[a.kind]) return;
    if (s.minNotional && a.notional && a.notional < s.minNotional) return;
    a.msg = AL.describe(a);
    s.history.unshift(a); if (s.history.length > 200) s.history.length = 200;
    AL.save();
    const url = location.origin + location.pathname + U.accountUrl(l.address, l.sid);
    U.toast(a.msg);
    if (s.browser && 'Notification' in window && Notification.permission === 'granted') {
      try { const n = new Notification(a.kind === 'liq' ? 'Leader liquidated' : 'Leader ' + VERB[a.kind].split(' ')[0], { body: a.msg, tag: a.id }); n.onclick = () => { window.focus(); location.hash = U.accountUrl(l.address, l.sid).slice(1); n.close(); }; } catch (_) {}
    }
    if (s.ntfy && s.ntfy.topic) AL.push(a, url).then(() => { if (s.ntfy.lastError) { s.ntfy.lastError = null; AL.save(); } }).catch((e) => { s.ntfy.lastError = { t: Date.now(), msg: e.message }; AL.save(); });
  }

  /** Publish one alert to ntfy (CORS-enabled; the topic is the only secret). */
  AL.push = async (a, url) => {
    const s = AL.state(); const server = (s.ntfy.server || 'https://ntfy.sh').replace(/\/+$/, '');
    const r = await fetch(server + '/' + encodeURIComponent(s.ntfy.topic), { method: 'POST', body: a.msg, headers: { Title: a.kind === 'liq' ? 'Leader liquidated' : 'Leader ' + VERB[a.kind].split(' ')[0], Tags: a.kind === 'liq' ? 'rotating_light' : a.kind === 'open' || a.kind === 'add' ? 'chart_with_upwards_trend' : 'chart_with_downwards_trend', Priority: a.kind === 'liq' ? '4' : '3', Click: url || location.href } });
    if (!r.ok) throw new Error('ntfy ' + r.status);
    return true;
  };
  AL.test = async () => { const s = AL.state(); if (!s.ntfy.topic) throw new Error('No topic set'); return AL.push({ kind: 'open', msg: 'MeridianDataHub leader alerts are set up on this device.', name: '' }, location.origin + location.pathname + '#/copytrade'); };
  AL.askPermission = async () => { if (!('Notification' in window)) return 'unsupported'; if (Notification.permission === 'granted') return 'granted'; try { return await Notification.requestPermission(); } catch (_) { return Notification.permission; } };
  AL.clearHistory = () => { AL.state().history = []; AL.save(); };
})();
