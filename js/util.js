/* MeridianDataHub — shared helpers (classic script, attaches to window.MD) */
(function () {
  const MD = (window.MD = window.MD || {});
  const U = (MD.util = {});

  /** Wallets the site leaves out of everything it shows: perps accounts (leaderboard, account pages, stop map) and
   *  Predict wallets (with every bet they are on). Since 2026-10-15. */
  U.EXCLUDED = new Set([
    '0x9aaeccaa94b7b99f6514fcc48e9e175005f19ca0',
    '0x9ffea49e4dcedd6427c700c6a9d98faafc24790f',
    '0xbd4e03adcd934c692ba4eded086fc25fc5b773cd',
  ]);
  U.isExcluded = (a) => U.EXCLUDED.has(String(a || '').toLowerCase());

  // ---------- DOM ----------
  U.$ = (sel, root) => (root || document).querySelector(sel);
  U.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /** A link or source U.h writes: relative ('page', '/x', '?q', '#/route'), blob:, http: or https:. Anything else
   *  (javascript:, data:, vbscript:, …) is refused. Tabs, newlines and leading blanks are dropped first, as the browser's
   *  URL parser does, so "java\tscript:" is still javascript:. */
  U.isSafeUrl = (v) => {
    const s = String(v).replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+/, '');
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s);
    return !scheme || /^(https?|blob)$/i.test(scheme[1]);
  };
  // keys U.h never writes: markup sinks. Untyped upstream JSON can hand an object where a string belongs, and a plain
  // object in the second argument is taken for attributes, so these must not be reachable from it at all
  const NO_KEYS = new Set(['html', 'innerhtml', 'outerhtml', 'srcdoc']);
  const URL_KEYS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'xlink:href']);
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
        const lk = k.toLowerCase();
        if (NO_KEYS.has(lk) || (URL_KEYS.has(lk) && !U.isSafeUrl(v))) continue;
        if (k === 'class' || k === 'className') el.className += (el.className ? ' ' : '') + v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (lk.startsWith('on')) { if (typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v); }   // a string would become an inline handler
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
  /** A value passed on as h()'s second argument: a Node, an array or nothing stays as it is, anything else becomes text,
   *  so a stray object from an API is printed rather than read as attributes. */
  U.kid = (v) => (v == null || v === false || v instanceof Node || Array.isArray(v) ? v : String(v));
  U.clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  /** Replace children, keeping the scroll position of the container and of any scrollers inside it (tables scrolled
   *  sideways on a phone, feeds scrolled down): live pages re-render on every tick and must not snap back. */
  const SCROLLERS = '.tbl-wrap, .feed, .scroll-y, .smap, .book';
  // The keyboard's place across a re-render: the element that had the focus is found again in what replaced it, by its
  // data-focus-key, else by its kind and name (aria-label, title, its label's or its own text) at the same position among
  // its namesakes. Live tables re-render every 30 s and on every event, and a focused row, checkbox or button fell to the
  // page. (A row's text changes as it ticks: rows carry a key, UI.table's rowKey.)
  const focusSig = (e) => e.tagName + '|' + String(e.getAttribute('aria-label') || e.getAttribute('title') || (e.labels && e.labels[0] ? e.labels[0].textContent : '') || (/^(INPUT|SELECT|TEXTAREA)$/.test(e.tagName) ? (e.name || e.placeholder || e.type) : e.textContent) || '').trim().slice(0, 80);
  const focusIn = (el) => {
    const a = typeof document !== 'undefined' ? document.activeElement : null;
    if (!a || a === el || !el.contains || !el.contains(a) || a === document.body) return null;
    let caret = null; try { if (typeof a.selectionStart === 'number') caret = { v: a.value, s: a.selectionStart, e: a.selectionEnd }; } catch (_) {}
    const key = a.dataset ? a.dataset.focusKey : null;
    if (key) return { key, caret };
    const sig = focusSig(a); const same = Array.from(el.querySelectorAll(a.tagName)).filter((x) => focusSig(x) === sig);
    return { sig, tag: a.tagName, i: same.indexOf(a), caret };
  };
  const focusBack = (el, f) => {
    if (!f || el.contains(document.activeElement)) return;
    let to = null;
    if (f.key) { if (window.CSS && CSS.escape) to = el.querySelector('[data-focus-key="' + CSS.escape(f.key) + '"]'); }
    else if (f.i >= 0) to = Array.from(el.querySelectorAll(f.tag)).filter((x) => focusSig(x) === f.sig)[f.i] || null;
    if (to && to.disabled) { el.__focusWant = { f, at: Date.now() }; return; }   // (a pager while its page loads: at the next render)
    if (to && typeof to.focus === 'function') {
      to.focus({ preventScroll: true });
      if (f.caret && to.value === f.caret.v) try { to.setSelectionRange(f.caret.s, f.caret.e); } catch (_) {}
    }
  };
  U.replace = (el, ...children) => {
    const own = { l: el.scrollLeft, t: el.scrollTop };
    const inner = Array.from(el.querySelectorAll(SCROLLERS)).map((s) => ({ l: s.scrollLeft, t: s.scrollTop }));
    const want = el.__focusWant; el.__focusWant = null;
    const f = focusIn(el) || (want && Date.now() - want.at < 10000 && typeof document !== 'undefined' && document.activeElement === document.body ? want.f : null);
    U.clear(el); U.append(el, children);
    if (own.l || own.t) { el.scrollLeft = own.l; el.scrollTop = own.t; }
    if (inner.some((s) => s.l || s.t)) el.querySelectorAll(SCROLLERS).forEach((s, i) => { const p = inner[i]; if (p && (p.l || p.t)) { s.scrollLeft = p.l; s.scrollTop = p.t; } });
    focusBack(el, f);
    return el;
  };
  /** For containers that re-render on every tick: skip a render while the reader is selecting text inside it or
   *  holding the mouse button over it, so copying a price or an address is possible; the next tick catches up. */
  let pointerDown = false;
  if (typeof document !== 'undefined') {   // the snapshot builder loads this file in Node, where there is no document
    document.addEventListener('pointerdown', () => { pointerDown = true; }, true);
    document.addEventListener('pointerup', () => { pointerDown = false; }, true);
    document.addEventListener('pointercancel', () => { pointerDown = false; }, true);
  }
  const canHover = () => !window.matchMedia || window.matchMedia('(hover: hover)').matches;
  U.replaceLive = (el, ...children) => {
    const sel = document.getSelection ? document.getSelection() : null;
    const selecting = sel && !sel.isCollapsed && sel.rangeCount && el.contains(sel.getRangeAt(0).commonAncestorContainer);
    // tapes (class pause-hover) hold still while the pointer is over them, so a row cannot slide away under a click, and
    // while the keyboard focus is inside them (a focused row would vanish); whatever arrived meanwhile is applied when the
    // pointer leaves or the focus moves out
    const pauses = el.classList.contains('pause-hover');
    // keyboard focus only (:focus-visible): a row clicked with the mouse, or given the focus back by a closing dialog,
    // must not freeze the tape
    const focusIn = () => { const a = document.activeElement; return a !== el && el.contains(a) && !!a.matches && a.matches(':focus-visible'); };
    // (the pointer only where it can hover: a phone keeps :hover after a tap, which held a tape until the next tap elsewhere)
    // nothing to hold still while it shows only a failure (its Retry was just pressed, under the pointer) or an empty or
    // loading note: what replaces it is what the visitor is waiting for
    const placeholder = el.children.length === 1 && !!el.firstElementChild.matches && el.firstElementChild.matches('.error, .empty');
    const held = !placeholder && (selecting || (pauses && ((canHover() && el.matches(':hover')) || focusIn())) || (pointerDown && el.matches(':hover')));
    if (held) {
      el.__pending = children;
      if (!el.__catchUp) {
        el.__catchUp = true;
        // (the class is read when it runs: an element can start or stop pausing after its first held render)
        const catchUp = () => { if (el.classList.contains('pause-hover') && ((canHover() && el.matches(':hover')) || focusIn())) return; const p = el.__pending; el.__pending = null; if (p && !(document.getSelection && !document.getSelection().isCollapsed)) U.replace(el, ...p); };
        el.addEventListener('mouseleave', () => setTimeout(catchUp));
        el.addEventListener('focusout', () => setTimeout(catchUp));   // after the focus has landed: still inside means stay
      }
      return el;
    }
    el.__pending = null;
    return U.replace(el, ...children);
  };
  /** A render the visitor asked for (a sort, a category) in a container U.replaceLive feeds: applied at once, even under
   *  the pointer or the keyboard focus, and a held live render still waiting (the order before it) is dropped */
  U.replaceNow = (el, ...children) => { el.__pending = null; return U.replace(el, ...children); };
  /** Re-render a container without losing the keyboard focus: fn() replaces what is inside el, and when an element in it
   *  had the focus, the one that replaced it (the same data-focus-key) gets it back. */
  U.keepFocus = (el, fn) => {
    const a = document.activeElement;
    const key = a && a !== el && el.contains(a) && a.dataset ? a.dataset.focusKey : null;
    fn();
    if (!key || el.contains(document.activeElement) || !(window.CSS && CSS.escape)) return;
    const to = el.querySelector('[data-focus-key="' + CSS.escape(key) + '"]');
    if (to) to.focus({ preventScroll: true });
  };
  U.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  U.svg = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };

  // ---------- Icons (lucide-style, 24px viewBox) ----------
  // an icon's own fill (starFill, bellFill: 'fill="currentColor"') replaces the outline default: a second fill attribute
  // on the same element is dropped by the parser, so the "filled" star stayed hollow
  const I = (d, extra) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"${/\bfill=/.test(extra || '') ? '' : ' fill="none"'} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra || ''}>${d}</svg>`;
  U.icons = {
    home: I('<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>'),
    more: I('<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>'),
    filter: I('<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>'),
    account: I('<rect width="20" height="14" x="2" y="5" rx="2"/><path d="M2 10h20"/>'),
    star: I('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'),
    starFill: I('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>', 'fill="currentColor"'),
    trophy: I('<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>'),
    trophyFill: I('<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" fill="currentColor"/>'),   // the cup filled (its own fill: the svg keeps fill none)
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
    pencil: I('<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/><path d="m15 5 4 4"/>'),
    activity: I('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'),
    bell: I('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),
    radar: I('<path d="M19.07 4.93A10 10 0 0 0 6.99 3.34"/><path d="M4 6h.01"/><path d="M2.29 9.62A10 10 0 1 0 21.31 8.35"/><path d="M16.24 7.76A6 6 0 1 0 8.23 16.67"/><path d="M12 18h.01"/><path d="M17.99 11.66A6 6 0 0 1 15.77 16.67"/><circle cx="12" cy="12" r="2"/><path d="m13.41 10.59 5.66-5.66"/>'),
    bellFill: I('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>', 'fill="currentColor"'),
    users: I('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
    panelClose: I('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/>'),
    panelOpen: I('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m14 9 3 3-3 3"/>'),
    wrench: I('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'),
    check: I('<path d="M20 6 9 17l-5-5"/>'),
    target: I('<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>'),
    ticket: I('<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/>'),
    pulse: I('<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>'),
    help: I('<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>'),
    info: I('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
    gavel: I('<path d="m14 13-7.5 7.5c-.83.83-2.17.83-3 0 0 0 0 0 0 0a2.12 2.12 0 0 1 0-3L11 10"/><path d="m16 16 6-6"/><path d="m8 8 6-6"/><path d="m9 7 8 8"/><path d="m21 11-8-8"/>'),
    layers: I('<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>'),
    scale: I('<path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/>'),
    receipt: I('<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 17.5v-11"/>'),
    download: I('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>'),
    share: I('<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" x2="12" y1="2" y2="15"/>'),
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

  // compact units, largest first, with their usual decimals ("$1.64T" for a market cap, not "$1,639.29B")
  const UNITS = [[1e12, 'T', 2], [1e9, 'B', 2], [1e6, 'M', 2], [1e3, 'K', 1]];
  /** The unit a compact figure is written in: by its size (K from 10,000: "$9,160" beside "$10.2K"), then the next one up
   *  when it rounds to 1,000 of it ("$1.00M", not "$1,000.0K"). dpFor(div): the decimals in that unit (an axis gives
   *  those its step needs); null: no unit. */
  const compactUnit = (a, dpFor) => {
    let i = a >= 1e12 ? 0 : a >= 1e9 ? 1 : a >= 1e6 ? 2 : a >= 1e4 ? 3 : -1;
    while (i >= 0) {
      const [div, suf, dp0] = UNITS[i], dp = dpFor ? dpFor(div) : dp0;
      if (i > 0 && Number((a / div).toFixed(dp)) >= 1000) { i--; continue; }
      return { div, suf, dp };
    }
    return null;
  };
  // the sign follows the figure as written: a loss that rounds to nothing reads "$0.00", not "-$0.00"
  const signOf = (n, shown, dp, plus) => (Number(Math.abs(shown).toFixed(dp)) === 0 ? '' : n < 0 ? '-' : plus && n > 0 ? '+' : '');
  /** USD formatting: fmtUsd(1234.5) → "$1,234.50"; opts: {sign, compact, dp, unitDp (compact: the decimals in a unit,
   *  from its divisor)} */
  U.fmtUsd = (x, opts = {}) => {
    const n = U.num(x);
    if (opts.compact) {
      const a = Math.abs(n);
      const u = compactUnit(a, opts.unitDp);
      if (u) { const v = a / u.div; return signOf(n, v, u.dp, opts.sign) + '$' + fmtN(v, u.dp) + u.suf; }
      if (a === 0 && opts.dp == null) return '$0';   // "$5,994 / $0", and an empty market's OI reads "$0", not "$0.00"
      const dp = opts.dp ?? (a >= 1000 ? 0 : 2);   // a compact column reads "$9,160" beside "$10.2K", not "$9,159.76"
      return signOf(n, a, dp, opts.sign) + '$' + fmtN(a, dp);
    }
    if (n !== 0 && Math.abs(n) < 0.01 && opts.dp == null) return '<$0.01';   // dust: "+$0.000716" helps nobody, and "+<$0.01" reads oddly; the colour still says which way
    const dp = opts.dp ?? 2;
    return signOf(n, n, dp, opts.sign) + '$' + fmtN(Math.abs(n), dp);   // one format per column: "-$0.07" next to "$37.94", not "-$0.0738"
  };
  /** Price formatting with sensible decimals for the magnitude (or tickSize decimals if given) */
  U.fmtPrice = (x, tick) => {
    const n = U.num(x);
    let dp;
    if (tick) { const t = String(tick); dp = t.includes('.') ? t.split('.')[1].length : 0; }
    else { const a = Math.abs(n); dp = a >= 10000 ? 1 : a >= 1000 ? 2 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6; }   // (by size: every negative price had 6 decimals)
    return signOf(n, n, dp) + fmtN(Math.abs(n), dp);
  };
  // the sign follows the rounded figure in every formatter: a tiny negative read "-0" ("-0 bps", and "-0.0 bps" in green)
  U.fmtNum = (x, dp = 2) => { const n = U.num(x); return signOf(n, n, dp) + fmtN(Math.abs(n), dp); };
  /** A size. With the product's lotSize: at its decimals, padded, as Meridian's app shows sizes (a size off the lot grid
   *  cannot exist, and rounding one to 4 dp showed 1.19645 BTC as 1.1965); without: up to 6 dp, trailing zeros dropped. */
  U.fmtQty = (x, lot) => {
    const n = U.num(x); const a = Math.abs(n);
    if (lot != null && lot !== '') { const t = String(lot); const dp = t.includes('.') ? t.split('.')[1].length : 0; return signOf(n, n, dp) + fmtN(a, dp, dp); }
    const dp = a >= 1000 ? 2 : a >= 1 ? 4 : 6;
    return signOf(n, n, dp) + fmtN(a, dp, 0);
  };
  U.fmtPct = (x, opts = {}) => {
    // not known (null, NaN, ∞): "—" (read through U.num first, it was 0, "0.00%")
    const n = typeof x === 'number' ? x : x == null || x === '' ? NaN : parseFloat(String(x));
    if (!Number.isFinite(n)) return '—';
    // the sign follows the rounded figure: -0.04 at one decimal reads "0.0%", not "-0.0%"
    const dp = opts.dp ?? 2, zero = Number(Math.abs(n).toFixed(dp)) === 0;
    const s = zero ? '' : n < 0 ? '-' : opts.sign && n > 0 ? '+' : '';
    return s + fmtN(Math.abs(n), dp) + '%';
  };
  U.fmtCompact = (x, dp = 1) => {
    const n = U.num(x); const a = Math.abs(n);
    let i = UNITS.findIndex(([d]) => a >= d);
    // a figure that rounds to 1,000 of its unit is written in the next one up ("1.0M", not "1,000.0K")
    if (i < 0 && Number(a.toFixed(a >= 100 ? 0 : dp)) >= 1000) i = UNITS.length - 1;
    while (i > 0 && Number((a / UNITS[i][0]).toFixed(dp)) >= 1000) i--;
    if (i < 0) { const d = a >= 100 ? 0 : dp; return signOf(n, a, d) + fmtN(a, d); }
    const v = a / UNITS[i][0];
    return signOf(n, v, dp) + fmtN(v, dp) + UNITS[i][1];
  };
  /** drawdown percent: '—' when none, '<0.01%' for tiny values */
  U.fmtDd = (pct) => (pct == null || !(pct > 0) ? '—' : pct < 0.01 ? '<0.01%' : U.fmtPct(pct, { dp: 2 }));
  U.pnlClass = (x) => { const n = U.num(x); return n > 0 ? 'pos' : n < 0 ? 'neg' : ''; };
  U.pnlEl = (x, opts) => U.h('span', { class: 'num ' + U.pnlClass(x) }, U.fmtUsd(x, Object.assign({ sign: true }, opts)));
  U.ratioFmt = (x, dp = 2) => (x == null || !Number.isFinite(x) ? '—' : signOf(x, x, dp) + fmtN(Math.abs(x), dp));

  // ---------- Time ----------
  U.now = () => Date.now();
  const pad = (n) => String(n).padStart(2, '0');
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  U.fmtDate = (ms) => { const d = new Date(U.num(ms)); return `${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`; };
  U.fmtDateShort = (ms) => { const d = new Date(U.num(ms)); return `${MON[d.getMonth()]} ${d.getDate()}`; };
  U.fmtTime = (ms) => { const d = new Date(U.num(ms)); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  U.capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  U.fmtHM = (ms) => { const d = new Date(U.num(ms)); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  /** Feed timestamps: clock time today, "Sep 17 21:06" for anything older, so a tape that spans days stays readable. */
  U.fmtFeedTime = (ms) => { const d = new Date(U.num(ms)); const now = new Date(); return d.toDateString() === now.toDateString() ? U.fmtTime(ms) : `${MON[d.getMonth()]} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  U.fmtDateTime = (ms) => { const d = new Date(U.num(ms)); return `${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  /** A UTC day bucket ('Oct 1, 2026 (UTC day)'): the per-day charts group by UTC day, so a local time would shift the date west of UTC. */
  U.fmtDayUTC = (ms) => { const d = new Date(U.num(ms)); return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} (UTC day)`; };
  /** "Sep 22, 23:00" within the current year, "Sep 22, 2025 23:00" otherwise: for schedules where the year is noise */
  U.fmtWhen = (ms) => { const d = new Date(U.num(ms)); return d.getFullYear() === new Date().getFullYear() ? `${MON[d.getMonth()]} ${d.getDate()}, ${pad(d.getHours())}:${pad(d.getMinutes())}` : U.fmtDateTime(ms); };
  /** UTC as the simulator's tables write it: "2026-10-22 18:26 UTC". */
  U.fmtUTC = (ms) => new Date(U.num(ms)).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  /** U.fmtFeedTime in UTC: the clock time on today's UTC day, "Oct 24 21:06" before it. */
  U.fmtFeedTimeUTC = (ms) => { const d = new Date(U.num(ms)), iso = d.toISOString(); return iso.slice(0, 10) === new Date().toISOString().slice(0, 10) ? iso.slice(11, 19) : `${MON[d.getUTCMonth()]} ${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
  /** This browser's time zone, short ("CET", "GMT+1"), to name a local clock time by. */
  U.tzName = () => { try { const p = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName'); return p ? p.value : 'local time'; } catch (_) { return 'local time'; } };
  U.fmtDateTimeS = (ms) => { const d = new Date(U.num(ms)); return `${MON[d.getMonth()]} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  /** The device clock's error against the exchange's, in ms (app.js reads Meridian's /v1/time once and keeps an error of
   *  more than half a minute): ages and the stale mark count from U.now(), so a clock running 2 h fast does not mark every
   *  fresh snapshot stale, nor a slow one read "0s ago" */
  U.clockSkew = 0;
  U.now = () => Date.now() + U.clockSkew;
  /** Settles once the exchange's clock has been read (or failed, or 4 s passed): what decides on an age without a
   *  visitor watching (the leaderboard's own build) waits for it */
  U.clockReady = Promise.resolve();
  U.fmtAgo = (ms) => {
    if (!(U.num(ms) > 0)) return '—';   // no time known (a status file that did not load): not "20750d ago"
    const s = Math.max(0, (U.now() - U.num(ms)) / 1000);
    if (s < 60) return `${Math.floor(s)}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };
  /** An age ("5m ago") that keeps itself current: every one on the page is written again every 30 s, so a page left open
   *  does not say "5m ago" for hours. fmt: its own wording of the time (U.fmtAgo unless given). */
  U.agoEl = (t, fmt) => { const el = U.h('span.ago'); el.__t = t; el.__fmt = fmt || null; el.textContent = (fmt || U.fmtAgo)(t); return el; };
  if (typeof document !== 'undefined' && typeof setInterval === 'function') setInterval(() => { for (const el of document.querySelectorAll('span.ago')) { const v = (el.__fmt || U.fmtAgo)(el.__t); if (el.textContent !== v) el.textContent = v; } }, 30000);
  U.fmtDuration = (ms) => {
    const s = Math.max(0, U.num(ms) / 1000);
    // each unit until its figure rounds to the next one: 59.6 s reads "1m", not "60s", and 3,599 s "1.0h", not "60m"
    if (Math.round(s) < 60) return `${Math.round(s)}s`;
    if (Math.round(s / 60) < 60) return `${Math.round(s / 60)}m`;
    if (Number((s / 3600).toFixed(1)) < 24) return `${(s / 3600).toFixed(1)}h`;
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
  /** A Meridian referral code as a slip's share link carries it (?r=): from a code, or from a link with ?ref=<code>
   *  pasted whole; letters and digits, 4 to 32 of them, else null (nothing else goes into a link). */
  U.refCode = (x) => {
    const s = String(x == null ? '' : x).trim(); const m = /[?&]ref=([A-Za-z0-9]{4,32})(?=[&#]|$)/.exec(s); const c = m ? m[1] : s;
    return /^[A-Za-z0-9]{4,32}$/.test(c) ? c : null;
  };
  /** A subaccount's name as its owner set it, where it reads as text (UTF-8, no control characters); null otherwise. */
  U.subName = (s) => {
    const raw = String((s && s.name) || '').trim();
    if (!/^(0x)?[0-9a-f]*$/i.test(raw)) return raw && !/[\u0000-\u001f\u007f-\u009f\ufffd]/.test(raw) ? raw : null;   // (given as text)
    try {
      const hx = raw.replace(/^0x/i, ''), b = [];
      for (let i = 0; i + 1 < hx.length; i += 2) { const c = parseInt(hx.substr(i, 2), 16); if (!c) break; b.push(c); }
      const t = b.length && typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(b)).trim() : '';
      return t && !/[\u0000-\u001f\u007f-\u009f\ufffd]/.test(t) ? t : null;
    } catch (_) { return null; }
  };
  /** A subaccount picker's option: its name (U.subName), else "#2 · 01a1654c… · since Oct 22, 2026" (its place among
   *  the wallet's subaccounts, oldest first: list). */
  U.subLabel = (s, list) => {
    const n = U.subName(s); if (n) return n;
    const ord = U.sortBy(list && list.length ? list : [s], (x) => U.num(x.createdAt));
    return '#' + (ord.indexOf(s) + 1) + ' · ' + String(s.id || '').slice(0, 8) + '… · since ' + U.fmtDate(s.createdAt);
  };
  U.decodeBytes32 = (hex) => {
    try {
      const h = String(hex || '').replace(/^0x/, '');
      let out = '';
      for (let i = 0; i < h.length; i += 2) { const c = parseInt(h.substr(i, 2), 16); if (!c) break; out += String.fromCharCode(c); }
      return out || hex;
    } catch (_) { return hex; }
  };
  /** One CSV field. Excel and Sheets run a text field that starts like a formula (= + - @, tab, CR) when the file is
   *  opened, and question titles, categories and tickers come from the exchange, so such text gets a leading apostrophe;
   *  a number, negative ones included, is written as it is. sep ';': the semicolon style Excel opens in columns where
   *  the list separator is a semicolon (Germany, Poland, France…), whose numbers take a decimal comma. */
  const CSV_NUM = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
  U.csvCell = (v, sep) => {
    if (v == null) return '';
    let s = String(v);
    const num = CSV_NUM.test(s);
    if (/^[=+\-@\t\r]/.test(s) && !num) s = "'" + s;
    if (sep === ';' && num) s = s.replace('.', ',');
    return (sep === ';' ? /[";\r\n]/ : /[",\r\n]/).test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
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
  // [{subaccountId, address, name (the subaccount's own name, 'primary' for the first), addedAt, label}], newest first
  // unless reordered; label: the name the user gave the wallet (the home page's favorites), this browser only
  const FAV_KEY = 'md.favorites.v1';
  U.FAV_LABEL_MAX = 32;
  U.favorites = {
    // (never a wallet the site leaves out, U.EXCLUDED: one saved before it was left out showed on Home with live equity)
    list() { const l = U.storage.get(FAV_KEY, []); return Array.isArray(l) ? l.filter((f) => !(f && U.isExcluded(f.address))) : []; },
    has(sid) { return this.list().some((f) => f.subaccountId === sid); },
    add(f) { const old = this.list().find((x) => x.subaccountId === f.subaccountId); const l = this.list().filter((x) => x.subaccountId !== f.subaccountId); l.unshift(Object.assign({ addedAt: Date.now() }, old && old.label ? { label: old.label } : null, f)); const ok = U.storage.set(FAV_KEY, l); U.emit('favorites'); return ok; },
    remove(sid) { const ok = U.storage.set(FAV_KEY, this.list().filter((f) => f.subaccountId !== sid)); U.emit('favorites'); return ok; },
    /** → whether it is a favorite now, or null when the browser would not save the change (site storage blocked) */
    toggle(f) { const ok = this.has(f.subaccountId) ? this.remove(f.subaccountId) : this.add(f); return ok === false ? null : this.has(f.subaccountId); },
    /** Name a favorite (trimmed, at most U.FAV_LABEL_MAX characters); an empty name takes it off. */
    setLabel(sid, label) { const v = String(label == null ? '' : label).replace(/\s+/g, ' ').trim().slice(0, U.FAV_LABEL_MAX); U.storage.set(FAV_KEY, this.list().map((f) => { if (f.subaccountId !== sid) return f; const g = Object.assign({}, f); if (v) g.label = v; else delete g.label; return g; })); U.emit('favorites'); },
    /** Put these favorites (subaccount ids, e.g. the ones a page shows, in their new order) into the places they hold in
     *  the list; the others keep theirs. Unknown ids are ignored. */
    reorder(sids) {
      const l = this.list(), by = new Map(l.map((f) => [f.subaccountId, f]));
      const want = Array.from(new Set(sids || [])).filter((s) => by.has(s)), set = new Set(want);
      const slots = []; l.forEach((f, i) => { if (set.has(f.subaccountId)) slots.push(i); });
      const out = l.slice(); slots.forEach((slot, k) => { out[slot] = by.get(want[k]); });
      U.storage.set(FAV_KEY, out); U.emit('favorites');
    },
  };

  // ---------- Events ----------
  const bus = new EventTarget();
  U.on = (name, fn) => { bus.addEventListener(name, fn); return () => bus.removeEventListener(name, fn); };
  U.emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));

  // ---------- Misc ----------
  /** A pause. With a signal it ends at once when that aborts (an AbortError): a retry's wait (Retry-After, up to a minute
   *  in the snapshot build) ran to its end after the build's deadline had aborted everything else */
  U.sleep = (ms, signal) => new Promise((resolve, reject) => {
    if (!signal) { setTimeout(resolve, ms); return; }
    if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const abort = () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); };
    const t = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
  /** setInterval for reads a page repeats while it is open: a tick that comes while the tab is hidden is skipped (a
   *  background tab kept scanning every account every two minutes), and one runs as soon as the tab shows again if any
   *  was skipped. Returns the function that stops it (for ctx.onCleanup). */
  U.every = (ms, fn) => {
    let missed = false;
    const hidden = () => typeof document !== 'undefined' && document.hidden;
    const tick = () => { if (hidden()) { missed = true; return; } missed = false; fn(); };
    const t = setInterval(tick, ms);
    const onVis = () => { if (!hidden() && missed) tick(); };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis); };
  };
  U.debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  U.throttle = (fn, ms) => { let last = 0, t; return (...a) => { const n = Date.now(); if (n - last >= ms) { last = n; fn(...a); } else { clearTimeout(t); t = setTimeout(() => { last = Date.now(); fn(...a); }, ms - (n - last)); } }; };
  /** run tasks with limited concurrency; tasks: array of () => Promise */
  U.pLimit = async (tasks, limit, onProgress) => {
    const results = new Array(tasks.length); let i = 0, done = 0;
    const worker = async () => { while (i < tasks.length) { const idx = i++; try { results[idx] = { ok: true, value: await tasks[idx]() }; } catch (e) { results[idx] = { ok: false, error: e }; } done++; if (onProgress) onProgress(done, tasks.length); } };
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
    return results;
  };
  /** Copy text, then say so: msg ("Copied" by default) once it is copied, for ms (U.toast's). True when it was. */
  U.copyText = async (text, msg, ms) => {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; }
    catch (_) { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { ok = document.execCommand('copy') !== false; } catch (e) {} ta.remove(); }
    U.toast(ok ? msg || 'Copied' : 'The browser did not allow copying: select the text and copy it by hand', ok ? ms : 4000);
    return ok;
  };
  let toastEl, toastT;
  /** A short message at the bottom of the screen, read out by screen readers (a polite live region); ms: how long it
   *  stays (1.6 s by default; longer for a warning that must be read). */
  // the live region is on the page from the start (one created with its first message was often not read out)
  const toastBox = () => { if (!toastEl && document.body) { toastEl = U.h('div.toast', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }); document.body.appendChild(toastEl); } return toastEl; };
  if (typeof document !== 'undefined' && document.addEventListener) { if (document.body) toastBox(); else document.addEventListener('DOMContentLoaded', toastBox); }
  U.toast = (msg, ms) => {
    if (!toastBox()) return;
    toastEl.textContent = msg; toastEl.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), ms > 0 ? ms : 1600);
  };
  U.copyBtn = (text) => U.h('button.copy', { type: 'button', title: 'Copy', 'aria-label': 'Copy ' + (String(text).length > 20 ? U.shortAddr(String(text), 4) : String(text)), onclick: (e) => { e.preventDefault(); e.stopPropagation(); U.copyText(text); } }, U.icon('copy'));
  U.sum = (arr, f) => arr.reduce((a, x) => a + (f ? f(x) : x), 0);
  U.groupBy = (arr, f) => arr.reduce((m, x) => { const k = f(x); (m[k] || (m[k] = [])).push(x); return m; }, {});
  U.sortBy = (arr, f, desc) => arr.slice().sort((a, b) => { const x = f(a), y = f(b); if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return desc ? (y > x ? 1 : y < x ? -1 : 0) : (x > y ? 1 : x < y ? -1 : 0); });
  U.clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  U.accountUrl = (address, sid, tab) => `#/account?address=${encodeURIComponent(address || '')}${sid ? '&sub=' + encodeURIComponent(sid) : ''}${tab ? '&tab=' + tab : ''}`;
  U.addrLink = (address, sid, n) => U.h('a.addr', { href: U.accountUrl(address, sid), title: address }, U.shortAddr(address, n));
  U.explorerTx = (hash) => `https://robinhoodchain.blockscout.com/tx/${hash}`;
  U.explorerAddr = (a) => `https://robinhoodchain.blockscout.com/address/${a}`;
  U.explorerBlock = (n) => `https://robinhoodchain.blockscout.com/block/${n}`;
  /** The chains USDe moves between in Meridian's records, by EVM chain id, with their explorers, and the LayerZero v2
   *  endpoint id of each (Robinhood Chain's 30416 and Ethereum's 30101 as Meridian's bridge records pair them) */
  U.CHAINS = { 1: { name: 'Ethereum', tx: 'https://etherscan.io/tx/' }, 4663: { name: 'Robinhood Chain', tx: 'https://robinhoodchain.blockscout.com/tx/' }, 42161: { name: 'Arbitrum', tx: 'https://arbiscan.io/tx/' },
    8453: { name: 'Base', tx: 'https://basescan.org/tx/' }, 10: { name: 'Optimism', tx: 'https://optimistic.etherscan.io/tx/' }, 137: { name: 'Polygon', tx: 'https://polygonscan.com/tx/' }, 56: { name: 'BNB Chain', tx: 'https://bscscan.com/tx/' } };
  U.LZ_EIDS = { 30101: 1, 30416: 4663, 30110: 42161, 30184: 8453, 30111: 10, 30109: 137, 30102: 56 };
  U.chainName = (id) => (U.CHAINS[id] ? U.CHAINS[id].name : 'chain ' + id);
  U.lzChainName = (eid) => (U.LZ_EIDS[eid] ? U.chainName(U.LZ_EIDS[eid]) : 'LayerZero endpoint ' + eid);
  U.explorerTxOn = (chainId, hash) => (hash && U.CHAINS[chainId] ? U.CHAINS[chainId].tx + hash : null);
  /** Relay's contracts on Robinhood Chain (api.relay.link/chains, read 2026-10-21): Meridian's app deposits through Relay,
   *  whose solvers deliver the funds through its router */
  U.RELAY = new Set(['0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f', '0x0729e2a4716d9f7dd17858d5d504426d228697f7', '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be', '0x5567954cd026cebfe486062cb75848e0f1c12e58', '0x4cd00e387622c35bddb9b4c962c136462338bc31']);
  /** A LayerZero destination (bytes32, an EVM address right-aligned in it) as the address; anything else as it is */
  U.lzAddress = (b32) => { const s = String(b32 || '').toLowerCase().replace(/^0x/, ''); return s.length === 64 && /^0{24}/.test(s) ? '0x' + s.slice(24) : b32 || null; };
})();
