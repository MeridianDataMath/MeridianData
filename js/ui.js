/* MeridianDataHub — reusable UI widgets */
(function () {
  const MD = window.MD; const U = MD.util; const h = U.h;
  const UI = (MD.ui = {});
  // a caller's value that lands in h()'s second argument goes through U.kid: an object from an API would be read as attributes

  /**
   * table({cols:[{key,label,num,render(row),sortVal(row),title}], rows, empty, sort:{key,desc}, onSort(key), onRow(row), rowClass(row)})
   */
  UI.table = function (o) {
    const cols = o.cols;
    const thead = h('thead', h('tr', cols.map((c) => {
      const th = h('th', { class: [c.num ? 'num' : '', c.sortVal ? 'sortable' : '', o.sort && o.sort.key === c.key ? 'sorted ' + (o.sort.desc ? '' : 'asc') : '', c.cls || ''].join(' ').trim(), title: c.title || null }, c.label);
      if (c.sortVal && o.onSort) th.addEventListener('click', () => o.onSort(c.key));
      return th;
    })));
    const tbody = h('tbody');
    const rows = o.rows || [];
    if (!rows.length) tbody.appendChild(h('tr.empty', h('td', { colspan: cols.length }, o.empty || 'No data')));
    for (const r of rows) {
      const tr = h('tr', { class: [(o.onRow ? 'clickable' : ''), o.rowClass ? o.rowClass(r) : ''].join(' ').trim() });
      for (const c of cols) {
        const td = h('td', { class: (c.num ? 'num ' : '') + (c.cls || '') });
        const v = c.render ? c.render(r) : r[c.key];
        U.append(td, [v == null ? '—' : v]);
        tr.appendChild(td);
      }
      if (o.onRow) {
        tr.addEventListener('click', (e) => { if (e.target.closest('a,button,.copy')) return; o.onRow(r); });
        tr.tabIndex = 0;   // reachable with Tab, opened with Enter
        tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === tr) { e.preventDefault(); o.onRow(r); } });
      }
      tbody.appendChild(tr);
    }
    return h('div.tbl-wrap', h('table.tbl', thead, tbody));
  };

  /** numbered pager */
  UI.pager = function ({ page, pageSize, total, onPage }) {
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const from = total ? (page - 1) * pageSize + 1 : 0, to = Math.min(total, page * pageSize);
    const b = (icon, disabled, target, title) => h('button.btn.sm.icon', { disabled, title, onclick: () => onPage(target) }, U.icon(icon));
    return h('div.pager', h('span', `${from}-${to} of ${total}`), h('span.grow'), h('span', `Page ${page} of ${pages}`), b('first', page <= 1, 1, 'First'), b('chevL', page <= 1, page - 1, 'Previous'), b('chevR', page >= pages, page + 1, 'Next'), b('last', page >= pages, pages, 'Last'));
  };
  /** cursor pager for server-side pages */
  UI.cursorPager = function ({ page, hasNext, count, onPrev, onNext, loading }) {
    return h('div.pager', h('span', loading ? h('span.loading', h('span.spinner'), 'Loading') : `${count} rows · page ${page}`), h('span.grow'), h('button.btn.sm.icon', { disabled: page <= 1 || loading, title: 'Previous', onclick: onPrev }, U.icon('chevL')), h('button.btn.sm.icon', { disabled: !hasNext || loading, title: 'Next', onclick: onNext }, U.icon('chevR')));
  };

  // a value longer than a tile is wide ("$1,000,060.00") shrinks a step instead of being cut with an ellipsis
  UI.stat = (k, v, sub, cls) => { v = U.kid(v); const len = String(typeof v === 'string' ? v : (v && v.textContent) || '').length; return h('div.stat', h('div.k', U.kid(k)), h('div.v', { class: (cls || '') + (len > 14 ? ' xlong' : len > 12 ? ' long' : ''), title: len > 12 ? String(typeof v === 'string' ? v : v.textContent) : null }, v), sub ? h('div.sub', U.kid(sub)) : null); };
  UI.metric = (k, v, s, cls) => h('div.metric', h('div.k', U.kid(k)), h('div.v', { class: cls || '' }, v), s ? h('div.s', U.kid(s)) : null);
  UI.card = (title, body, extra) => h('div.card.tight', h('div.card-head', h('h2', U.kid(title)), extra || null), body);
  UI.loading = (text) => h('div.empty', h('span.loading', h('span.spinner'), text || 'Loading…'));
  UI.error = (err, retry) => h('div.error', h('div', String((err && err.message) || err || 'Error')), retry ? h('div', { style: { marginTop: '8px' } }, h('button.btn.sm', { onclick: retry }, 'Retry')) : null);
  UI.empty = (text) => h('div.empty', U.kid(text));

  /** segmented control: seg([{v,label}], value, onChange) → el with .set(v) */
  UI.seg = function (options, value, onChange, cls) {
    const el = h('div.seg', { class: cls || '' });
    const set = (v) => { value = v; U.$$('button', el).forEach((b) => b.classList.toggle('on', b.dataset.v === String(v))); };
    for (const o of options) el.appendChild(h('button', { dataset: { v: String(o.v) }, title: o.title || null, onclick: () => { set(o.v); onChange(o.v); } }, o.label));
    set(value); el.set = set; el.get = () => value;
    return el;
  };
  /** Thin progress bar along the bottom edge of the topbar. start() creeps towards 90 % on its own, set(0..1) pins a
   *  real value (bytes received etc.), done() completes and fades. Several loaders can overlap; the last done() hides it. */
  UI.progress = (() => {
    let bar, fill, timer, v = 0, active = 0, hideT;
    const el = () => { if (!bar) { fill = h('i'); bar = h('div.progress', fill); (U.$('.topbar') || document.body).appendChild(bar); } return bar; };
    const paint = () => { fill.style.width = (v * 100).toFixed(1) + '%'; };
    const creep = () => { if (v < 0.9) { v += (0.9 - v) * 0.08; paint(); } };
    return {
      start() { el(); clearTimeout(hideT); active++; bar.classList.add('on'); if (v === 0 || v >= 1) v = 0.06; paint(); if (!timer) timer = setInterval(creep, 250); },
      /** a page change: forget loaders of the page being left (their done() may never come) and start fresh */
      restart() { active = 0; v = 0; this.start(); },
      set(x) { if (!bar) return; v = Math.max(v, Math.min(0.95, x)); paint(); },
      done() { if (!bar) return; active = Math.max(0, active - 1); if (active) return; clearInterval(timer); timer = null; v = 1; paint(); hideT = setTimeout(() => { bar.classList.remove('on'); v = 0; paint(); }, 350); },
    };
  })();
  /** Tab bars that overflow (phones) get a fade on the right edge via CSS; `.fits` removes it when everything is visible
   *  or the bar is scrolled to its end. Checked after renders, on resize and on scroll. */
  const fitTabs = () => { for (const t of document.querySelectorAll('.tabs')) t.classList.toggle('fits', t.scrollWidth <= t.clientWidth + 1 || t.scrollLeft + t.clientWidth >= t.scrollWidth - 1); };
  UI.fitTabs = fitTabs;
  window.addEventListener('resize', fitTabs);
  document.addEventListener('scroll', (e) => { if (e.target && e.target.classList && e.target.classList.contains('tabs')) fitTabs(); }, true);
  /** Stat tiles fill their rows evenly: auto-fit put nine tiles seven to a row with two alone underneath; the same number
   *  of rows with the tiles spread over them (5 + 4) reads as one block. Phones keep their two columns (CSS). */
  const TILE_MIN = 150, TILE_GAP = 12;
  const balanceOne = (el) => {
    const n = el.children.length;
    if (window.innerWidth <= 720 || !n) { el.style.gridTemplateColumns = ''; return; }
    const max = Math.max(1, Math.floor((el.clientWidth + TILE_GAP) / (TILE_MIN + TILE_GAP)));
    const cols = Math.ceil(n / Math.ceil(n / max));
    const v = 'repeat(' + cols + ', minmax(0, 1fr))'; if (el.style.gridTemplateColumns !== v) el.style.gridTemplateColumns = v;
  };
  // each grid is watched for its own width (window resizes, the sidebar collapsing, a card changing size)
  const tileRO = typeof ResizeObserver !== 'undefined' ? new ResizeObserver((es) => { for (const e of es) { balanceOne(e.target); fitValues(e.target); } }) : null;
  const watched = new WeakSet();
  /** A tile value wider than its tile steps down a size (long, then xlong) instead of ending in "…": the character-count
   *  guess in UI.stat does not know how narrow a tile is (two to a row inside a card on a phone). */
  const fitValues = (root) => {
    for (const v of (root || document).querySelectorAll('.stat .v')) {
      if (v.scrollWidth <= v.clientWidth + 1) continue;
      if (!v.classList.contains('long') && !v.classList.contains('xlong')) { v.classList.add('long'); if (v.scrollWidth <= v.clientWidth + 1) continue; }
      v.classList.remove('long'); v.classList.add('xlong');
    }
  };
  UI.fitValues = fitValues;
  const balanceStats = () => { for (const el of document.querySelectorAll('.stats:not(.three)')) { if (tileRO && !watched.has(el)) { watched.add(el); tileRO.observe(el); } balanceOne(el); } fitValues(); };
  window.addEventListener('resize', () => { clearTimeout(fitValues._t); fitValues._t = setTimeout(() => fitValues(), 80); });
  UI.balanceStats = balanceStats;
  new MutationObserver(() => {
    clearTimeout(fitTabs._t); fitTabs._t = setTimeout(fitTabs, 50);
    clearTimeout(balanceStats._m); balanceStats._m = setTimeout(balanceStats, 50);
  }).observe(document.documentElement, { childList: true, subtree: true });

  /** Inline warning when a published snapshot is older than it should be (the publishers run every 30 minutes). */
  UI.STALE_MS = 2 * 3600000;
  UI.staleNote = (builtAt, hint) => (builtAt && Date.now() - builtAt > UI.STALE_MS
    ? h('span', { style: { color: 'var(--amber)' } }, ' · ', h('a', { href: '#/status', style: { color: 'inherit' }, title: (hint ? hint + ' · ' : '') + 'refreshed every 30 minutes normally; click for the data status page' }, 'stale'))   // the age itself is printed just before
    : null);
  /** modal({title, body}) → {close}; closes on the backdrop, the × button or Escape. Dialogs stack (a prediction opened
   *  from a question's list): Escape closes the top one, and a page change closes them all (UI.closeModals from the
   *  router, and after a click on a link to the page already shown). The top dialog takes the focus, everything behind
   *  it is inert (no Tab or Enter reaches the page), and a dialog opened from the keyboard gives the focus back where it
   *  was when it closes. */
  const modals = [];
  // how the last dialog was opened: only a keyboard user gets the focus back on close (a mouse user's row, focused by
  // the click, would otherwise hold its live tape still under U.replaceLive's keyboard-focus rule)
  let lastInput = 'pointer';
  if (typeof document !== 'undefined') { document.addEventListener('keydown', () => { lastInput = 'keyboard'; }, true); document.addEventListener('pointerdown', () => { lastInput = 'pointer'; }, true); }
  const syncInert = () => { const app = document.querySelector('.app'); if (app) app.inert = modals.length > 0; modals.forEach((x, i) => { x.el.inert = i < modals.length - 1; }); };
  UI.modal = function ({ title, body, wide }) {
    const onKey = (e) => { if (e.key === 'Escape' && modals[modals.length - 1] === m) close(); };
    const back = document.activeElement, byKeyboard = lastInput === 'keyboard';
    // a live list may have replaced the element meanwhile: its successor carries the same data-focus-key
    const key = back && back.dataset ? back.dataset.focusKey : null;
    const close = () => {
      const i = modals.indexOf(m); if (i < 0) return;
      bg.remove(); document.removeEventListener('keydown', onKey); modals.splice(i, 1); syncInert();
      const to = !byKeyboard ? null : back && back.isConnected ? back : key && window.CSS && CSS.escape ? document.querySelector('[data-focus-key="' + CSS.escape(key) + '"]') : null;
      if (to && typeof to.focus === 'function' && !to.closest('[inert]')) to.focus({ preventScroll: true });
      else if (modals.length) modals[modals.length - 1].scroller.focus({ preventScroll: true });   // the dialog underneath keeps the keyboard
    };
    // the focus goes to the scrolling body, so the arrow keys, Page Down and Space scroll the dialog
    const scroller = h('div.modal-body', { tabindex: -1 }, U.kid(body));
    const dialog = h('div.modal', { class: wide ? 'wide' : '', role: 'dialog', 'aria-modal': 'true' }, h('div.modal-head', h('h2', U.kid(title)), h('button.btn.sm.icon.ghost', { title: 'Close', onclick: close }, U.icon('x'))), scroller);
    const bg = h('div.modal-bg', { onclick: (e) => { if (e.target === bg) close(); } }, dialog);
    // capture phase: links in a dialog often stop the click's propagation (a row behind them has its own action); the
    // dialogs close once the click has gone through, and only when it navigated here (not a new tab, not prevented)
    bg.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[href^="#/"]');
      if (!a || a.target || e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      setTimeout(() => { if (!e.defaultPrevented) UI.closeModals(); });
    }, true);
    const m = { close, el: bg, scroller };
    modals.push(m); document.body.appendChild(bg); document.addEventListener('keydown', onKey); syncInert();
    scroller.focus({ preventScroll: true });
    return m;
  };
  UI.closeModals = () => { while (modals.length) modals[modals.length - 1].close(); };
  UI.checkbox = (label, checked, onChange) => { const inp = h('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked) }); return h('label.checkbox', inp, label); };

  UI.starBtn = function (fav, cls) {
    const b = h('button.star-btn', { class: (U.favorites.has(fav.subaccountId) ? 'on ' : '') + (cls || ''), title: 'Favorite' }, U.icon(U.favorites.has(fav.subaccountId) ? 'starFill' : 'star'));
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); const on = U.favorites.toggle(fav); b.classList.toggle('on', on); U.replace(b, U.icon(on ? 'starFill' : 'star')); U.toast(on ? 'Added to favorites' : 'Removed from favorites'); });
    return b;
  };

  UI.marketCell = (ticker, sub) => h('div.mkt-row', h('div.tick', U.kid(ticker)), sub ? h('div.sub', U.kid(sub)) : null);
  UI.chip = (text, cls) => h('span.chip', { class: cls || '' }, text);
  UI.pct = (v, opts) => (v == null || !Number.isFinite(v) ? h('span.dim', '—') : h('span', { class: 'num ' + U.pnlClass(v) }, U.fmtPct(v, Object.assign({ sign: true, dp: 1 }, opts))));
  UI.usd = (v, opts) => h('span.num', U.fmtUsd(v, opts));
})();
