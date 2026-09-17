/* MeridianData — shared helpers (classic script, attaches to window.MD) */
(function () {
  const MD = (window.MD = window.MD || {});
  const U = (MD.util = {});

  // ---------- DOM ----------
  U.$ = (sel, root) => (root || document).querySelector(sel);
  U.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /** h('div.cls#id', {attr: v, onclick: fn}, children...) */
  U.h = function h(tag, attrs, ...children) {
    const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(tag) || [];
    const el = document.createElement(m[1] || 'div');
    if (m[2]) {
      m[2].match(/[.#][\w-]+/g).forEach((t) => {
        if (t[0] === '.') el.classList.add(t.slice(1));
        else el.id = t.slice(1);
      });
    }
    if (attrs && typeof attrs === 'object' && !(attrs instanceof Node) && !Array.isArray(attrs)) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class' || k === 'className') el.className += (el.className ? ' ' : '') + v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'html') el.innerHTML = v;
        else if (k in el && k !== 'list' && k !== 'form') { try { el[k] = v; } catch (_) { el.setAttribute(k, v); } }
        else el.setAttribute(k, v === true ? '' : v);
      }
    } else if (attrs != null) {
      children.unshift(attrs);
    }
    U.append(el, children);
    return el;
  };
  U.append = function (el, children) {
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  };
  U.clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  U.replace = (el, ...children) => { U.clear(el); U.append(el, children); return el; };
  U.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  U.svg = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };

  // ---------- Icons (lucide-style, 24px viewBox) ----------
  const I = (d, extra) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra || ''}>${d}</svg>`;
  U.icons = {
    home: I('<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>'),
    account: I('<rect width="20" height="14" x="2" y="5" rx="2"/><path d="M2 10h20"/>'),
    star: I('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'),
    starFill: I('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>', 'fill="currentColor"'),
    trophy: I('<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>'),
    grid: I('<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>'),
    search: I('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
    copy: I('<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
    external: I('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
    refresh: I('<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>'),
    book: I('<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>'),
    x: I('<path d="M4 4l16 16M20 4L4 20"/>'),
    chevL: I('<path d="m15 18-6-6 6-6"/>'),
    chevR: I('<path d="m9 18 6-6-6-6"/>'),
    first: I('<path d="m17 18-6-6 6-6"/><path d="M7 6v12"/>'),
    last: I('<path d="m7 18 6-6-6-6"/><path d="M17 6v12"/>'),
    trash: I('<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>'),
    activity: I('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'),
    users: I('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
    panelClose: I('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/>'),
    panelOpen: I('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m14 9 3 3-3 3"/>'),
    wrench: I('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'),
    check: I('<path d="M20 6 9 17l-5-5"/>'),
    target: I('<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>'),
    help: I('<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>'),
    layers: I('<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>'),
    scale: I('<path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/>'),
    receipt: I('<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 17.5v-11"/>'),
    download: I('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>'),
    printer: I('<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect width="12" height="8" x="6" y="14"/>'),
    meridian: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 95" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M106.723 12.8039C106.646 5.17209 103.931 1.71922 98.4607 0.417789C91.1338 -1.32539 80.4935 2.32385 69.9679 12.5422C69.8907 4.91032 67.1756 1.71922 61.7056 0.417789C54.0401 -1.40595 42.7463 4.89516 31.7531 16.0181C40.114 8.76949 48.4173 4.93543 54.4042 6.35984C65.6087 9.02558 60.9511 29.6562 48.3263 51.7468C35.7015 73.8375 19.4652 87.2979 8.26074 84.6322C2.27382 83.2078 0.241401 78.5384 1.17537 69.5229C-1.65487 82.5879 0.595376 92.1113 8.26074 93.9349C15.5879 95.6782 26.2306 89.9998 36.7568 79.7806C36.8337 87.412 39.5462 92.6336 45.0158 93.9349C52.343 95.6782 62.9857 89.9998 73.5118 79.7806C73.5888 87.412 76.3012 92.6336 81.7709 93.9349C94.2409 96.9018 116.314 78.3724 131.072 52.5483C145.831 26.7243 147.686 3.38462 135.216 0.417789C127.889 -1.32539 117.249 2.58563 106.723 12.8039ZM94.3172 52.5483C102.541 38.1579 106.759 24.5389 106.723 14.7869C114.583 8.34077 122.276 5.01838 127.914 6.35984C139.119 9.02558 134.461 29.6562 121.836 51.7468C109.212 73.8375 92.9754 87.2979 81.7709 84.6322C78.1587 83.7728 75.9861 81.7321 75.0359 78.2683C81.903 71.307 88.6495 62.4656 94.3172 52.5483ZM69.9679 14.7868C70.0035 24.5389 65.7862 38.1579 57.5621 52.5483C51.8944 62.4656 45.1479 71.307 38.2809 78.2683C39.231 81.7321 41.4036 83.7728 45.0158 84.6322C56.2203 87.2979 72.4566 73.8375 85.0814 51.7468C97.7062 29.6562 102.364 9.02558 91.1593 6.35984C85.521 5.01839 77.8283 8.34076 69.9679 14.7868Z"/></svg>`,
  };
  U.icon = (name) => U.svg(U.icons[name]);

  // ---------- Numbers ----------
  U.num = (x) => {
    if (x == null || x === '') return 0;
    const n = typeof x === 'number' ? x : parseFloat(String(x));
    return Number.isFinite(n) ? n : 0;
  };
  const nf = (dp, min) => new Intl.NumberFormat('en-US', { minimumFractionDigits: min ?? dp, maximumFractionDigits: dp });
  const nfCache = {};
  const fmtN = (n, dp, min) => { const k = dp + ':' + (min ?? dp); return (nfCache[k] || (nfCache[k] = nf(dp, min))).format(n); };

  /** USD formatting: fmtUsd(1234.5) → "$1,234.50"; opts: {sign, compact, dp} */
  U.fmtUsd = (x, opts = {}) => {
    const n = U.num(x);
    if (opts.compact) {
      const a = Math.abs(n);
      const s = n < 0 ? '-' : opts.sign && n > 0 ? '+' : '';
      if (a >= 1e9) return s + '$' + fmtN(a / 1e9, 2) + 'B';
      if (a >= 1e6) return s + '$' + fmtN(a / 1e6, 2) + 'M';
      if (a >= 1e4) return s + '$' + fmtN(a / 1e3, 1) + 'K';
      return s + '$' + fmtN(a, opts.dp ?? 2);
    }
    const dp = opts.dp ?? (Math.abs(n) >= 1 || n === 0 ? 2 : Math.abs(n) >= 0.01 ? 4 : 6);
    const s = n < 0 ? '-' : opts.sign && n > 0 ? '+' : '';
    return s + '$' + fmtN(Math.abs(n), dp);
  };
  /** Price formatting with sensible decimals for the magnitude (or tickSize decimals if given) */
  U.fmtPrice = (x, tick) => {
    const n = U.num(x);
    let dp;
    if (tick) { const t = String(tick); dp = t.includes('.') ? t.split('.')[1].length : 0; }
    else dp = n >= 10000 ? 1 : n >= 1000 ? 2 : n >= 1 ? 2 : n >= 0.01 ? 4 : 6;
    return fmtN(n, dp);
  };
  U.fmtNum = (x, dp = 2) => fmtN(U.num(x), dp);
  U.fmtQty = (x) => {
    const n = U.num(x); const a = Math.abs(n);
    const dp = a >= 1000 ? 2 : a >= 1 ? 4 : 6;
    return fmtN(n, dp, 0);
  };
  U.fmtPct = (x, opts = {}) => {
    const n = U.num(x);
    if (!Number.isFinite(n)) return '—';
    const s = n < 0 ? '-' : opts.sign && n > 0 ? '+' : '';
    return s + fmtN(Math.abs(n), opts.dp ?? 2) + '%';
  };
  U.fmtCompact = (x, dp = 1) => {
    const n = U.num(x); const a = Math.abs(n); const s = n < 0 ? '-' : '';
    if (a >= 1e9) return s + fmtN(a / 1e9, dp) + 'B';
    if (a >= 1e6) return s + fmtN(a / 1e6, dp) + 'M';
    if (a >= 1e3) return s + fmtN(a / 1e3, dp) + 'K';
    return s + fmtN(a, a >= 100 ? 0 : dp);
  };
  /** drawdown percent: '—' when none, '<0.01%' for tiny values */
  U.fmtDd = (pct) => (pct == null || !(pct > 0) ? '—' : pct < 0.01 ? '<0.01%' : U.fmtPct(pct, { dp: 2 }));
  U.pnlClass = (x) => { const n = U.num(x); return n > 0 ? 'pos' : n < 0 ? 'neg' : ''; };
  U.pnlEl = (x, opts) => U.h('span', { class: 'num ' + U.pnlClass(x) }, U.fmtUsd(x, Object.assign({ sign: true }, opts)));
  U.ratioFmt = (x, dp = 2) => (x == null || !Number.isFinite(x) ? '—' : fmtN(x, dp));

  // ---------- Time ----------
  U.now = () => Date.now();
  const pad = (n) => String(n).padStart(2, '0');
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  U.fmtDate = (ms) => { const d = new Date(U.num(ms)); return `${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`; };
  U.fmtDateShort = (ms) => { const d = new Date(U.num(ms)); return `${MON[d.getMonth()]} ${d.getDate()}`; };
  U.fmtTime = (ms) => { const d = new Date(U.num(ms)); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  U.fmtHM = (ms) => { const d = new Date(U.num(ms)); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  U.fmtDateTime = (ms) => { const d = new Date(U.num(ms)); return `${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  U.fmtDateTimeS = (ms) => { const d = new Date(U.num(ms)); return `${MON[d.getMonth()]} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  U.fmtAgo = (ms) => {
    const s = Math.max(0, (Date.now() - U.num(ms)) / 1000);
    if (s < 60) return `${Math.floor(s)}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };
  U.fmtDuration = (ms) => {
    const s = Math.max(0, U.num(ms) / 1000);
    if (s < 60) return `${Math.round(s)}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
    return `${(s / 86400).toFixed(1)}d`;
  };
  U.fmtCountdown = (ms) => {
    const s = Math.max(0, Math.floor(U.num(ms) / 1000));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  };
  U.DAY = 86400000; U.HOUR = 3600000;

  // ---------- Strings ----------
  U.shortAddr = (a, n = 4) => { a = String(a || ''); return a.length > 2 * n + 4 ? `${a.slice(0, 2 + n)}…${a.slice(-n)}` : a; };
  U.isAddress = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s || '').trim());
  U.isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || '').trim());
  U.decodeBytes32 = (hex) => {
    try {
      const h = String(hex || '').replace(/^0x/, '');
      let out = '';
      for (let i = 0; i < h.length; i += 2) { const c = parseInt(h.substr(i, 2), 16); if (!c) break; out += String.fromCharCode(c); }
      return out || hex;
    } catch (_) { return hex; }
  };
  U.sideName = (s) => (String(s) === '0' || s === 'BUY' ? 'BUY' : 'SELL');
  U.sideEl = (s, long) => { const buy = String(s) === '0' || s === 'BUY' || s === 'LONG' || s === true; const t = long ? (buy ? 'LONG' : 'SHORT') : (buy ? 'BUY' : 'SELL'); return U.h('span', { class: 'bold ' + (buy ? 'pos' : 'neg') }, t); };

  // ---------- Storage ----------
  U.storage = {
    get(k, def) { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch (_) { return def; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (_) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (_) {} },
  };

  // ---------- Favorites ----------
  const FAV_KEY = 'md.favorites.v1';
  U.favorites = {
    list() { return U.storage.get(FAV_KEY, []); },
    has(sid) { return this.list().some((f) => f.subaccountId === sid); },
    add(f) { const l = this.list().filter((x) => x.subaccountId !== f.subaccountId); l.unshift(Object.assign({ addedAt: Date.now() }, f)); U.storage.set(FAV_KEY, l); U.emit('favorites'); },
    remove(sid) { U.storage.set(FAV_KEY, this.list().filter((f) => f.subaccountId !== sid)); U.emit('favorites'); },
    toggle(f) { if (this.has(f.subaccountId)) this.remove(f.subaccountId); else this.add(f); return this.has(f.subaccountId); },
  };

  // ---------- Events ----------
  const bus = new EventTarget();
  U.on = (name, fn) => { bus.addEventListener(name, fn); return () => bus.removeEventListener(name, fn); };
  U.emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));

  // ---------- Misc ----------
  U.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  U.debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  U.throttle = (fn, ms) => { let last = 0, t; return (...a) => { const n = Date.now(); if (n - last >= ms) { last = n; fn(...a); } else { clearTimeout(t); t = setTimeout(() => { last = Date.now(); fn(...a); }, ms - (n - last)); } }; };
  /** run tasks with limited concurrency; tasks: array of () => Promise */
  U.pLimit = async (tasks, limit, onProgress) => {
    const results = new Array(tasks.length); let i = 0, done = 0;
    const worker = async () => { while (i < tasks.length) { const idx = i++; try { results[idx] = { ok: true, value: await tasks[idx]() }; } catch (e) { results[idx] = { ok: false, error: e }; } done++; if (onProgress) onProgress(done, tasks.length); } };
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
    return results;
  };
  U.copyText = async (text) => {
    try { await navigator.clipboard.writeText(text); U.toast('Copied'); }
    catch (_) { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); U.toast('Copied'); } catch (e) {} ta.remove(); }
  };
  let toastEl, toastT;
  U.toast = (msg) => {
    if (!toastEl) { toastEl = U.h('div.toast'); document.body.appendChild(toastEl); }
    toastEl.textContent = msg; toastEl.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), 1600);
  };
  U.copyBtn = (text) => U.h('span.copy', { title: 'Copy', onclick: (e) => { e.preventDefault(); e.stopPropagation(); U.copyText(text); } }, U.icon('copy'));
  U.sum = (arr, f) => arr.reduce((a, x) => a + (f ? f(x) : x), 0);
  U.groupBy = (arr, f) => arr.reduce((m, x) => { const k = f(x); (m[k] || (m[k] = [])).push(x); return m; }, {});
  U.sortBy = (arr, f, desc) => arr.slice().sort((a, b) => { const x = f(a), y = f(b); if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return desc ? (y > x ? 1 : y < x ? -1 : 0) : (x > y ? 1 : x < y ? -1 : 0); });
  U.clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  U.accountUrl = (address, sid, tab) => `#/account?address=${encodeURIComponent(address || '')}${sid ? '&sub=' + encodeURIComponent(sid) : ''}${tab ? '&tab=' + tab : ''}`;
  U.addrLink = (address, sid, n) => U.h('a.addr', { href: U.accountUrl(address, sid), title: address }, U.shortAddr(address, n));
  U.explorerTx = (hash) => `https://robinhoodchain.blockscout.com/tx/${hash}`;
  U.explorerAddr = (a) => `https://robinhoodchain.blockscout.com/address/${a}`;
})();
