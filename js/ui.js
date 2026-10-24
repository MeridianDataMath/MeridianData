/* MeridianDataHub — reusable UI widgets */
(function () {
  const MD = window.MD; const U = MD.util; const h = U.h;
  const UI = (MD.ui = {});
  // a caller's value that lands in h()'s second argument goes through U.kid: an object from an API would be read as attributes

  /**
   * table({cols:[{key,label,num,render(row),sortVal(row),title}], rows, empty, sort:{key,desc}, onSort(key), onRow(row), canRow(row)
   * (which rows onRow takes: the others look and act as plain rows), rowClass(row)})
   */
  UI.table = function (o) {
    const cols = o.cols;
    const thead = h('thead', h('tr', cols.map((c) => {
      const th = h('th', { class: [c.num ? 'num' : '', c.sortVal ? 'sortable' : '', o.sort && o.sort.key === c.key ? 'sorted ' + (o.sort.desc ? '' : 'asc') : '', c.cls || ''].join(' ').trim(), title: c.title || null }, c.label);
      if (c.sortVal && o.onSort) th.addEventListener('click', () => o.onSort(c.key));
      return th;
    })));
    const tbody = h('tbody');
    // Phone rows: in a narrow box (css .tbl-wrap.ph, under 560 px) a table of five or more columns lists its rows as
    // two-line items, as the Predict feeds do: its lead (a rank) and title column with an aside on the first line, the
    // other columns as label and value under them. o.phone: false keeps the table as it is; { lead, title, aside, hide, wide }
    // names those columns by key (hide: left out on a phone; wide: a value two thirds of the line wide, for a cell that does
    // not fit a third); without names, a leading '#' column is the lead and the next one the title. The Predict pages keep their tables (css).
    let ph = null;
    if (o.phone !== false && (o.phone || cols.length >= 5)) {
      const rankFirst = cols.length > 1 && (cols[0].label === '#' || cols[0].key === 'rank');
      ph = Object.assign({ lead: rankFirst ? cols[0].key : null, title: (rankFirst ? cols[1] : cols[0]).key, aside: null, hide: [], wide: [] }, typeof o.phone === 'object' ? o.phone : {});
    }
    const phRole = (c) => (!ph ? '' : c.key === ph.lead ? ' ph-lead' : c.key === ph.title ? ' ph-title' : c.key === ph.aside ? ' ph-aside' : ph.hide.includes(c.key) ? ' ph-hide' : ph.wide.includes(c.key) ? ' ph-wide' : '');
    const phLabel = (c) => c.phLabel || (typeof c.label === 'string' ? c.label : (c.label && c.label.textContent) || '');
    // o.groups ([{ head, rows, empty }]): each group's rows under a full-width header row (head), a group without rows
    // saying so (empty); without groups, o.rows
    const groups = o.groups || [{ rows: o.rows || [] }];
    if (!o.groups && !groups[0].rows.length) tbody.appendChild(h('tr.empty', h('td', { colspan: cols.length }, o.empty || 'No data')));
    for (const g of groups) {
      if (g.head != null) tbody.appendChild(h('tr.group', h('td', { colspan: cols.length }, g.head)));
      if (o.groups && !g.rows.length && g.empty) tbody.appendChild(h('tr.empty', h('td', { colspan: cols.length }, g.empty)));
      for (const r of g.rows) tbody.appendChild(rowEl(r));
    }
    return h('div.tbl-wrap', { class: ph ? 'ph' : null }, h('table.tbl', thead, tbody));
    function rowEl(r) {
      const opens = !!o.onRow && (!o.canRow || o.canRow(r));
      const tr = h('tr', { class: [(opens ? 'clickable' : ''), o.rowClass ? o.rowClass(r) : ''].join(' ').trim() });
      for (const c of cols) {
        const role = phRole(c);
        const td = h('td', { class: ((c.num ? 'num ' : '') + (c.cls || '') + role).trim() || null });
        if (ph && (!role || role === ' ph-aside' || role === ' ph-wide')) td.dataset.l = phLabel(c);   // its label above the value on a phone
        const v = c.render ? c.render(r) : r[c.key];
        U.append(td, [v == null ? '—' : v]);
        tr.appendChild(td);
      }
      if (opens) {
        tr.addEventListener('click', (e) => { if (e.target.closest('a,button,.copy')) return; o.onRow(r); });
        tr.tabIndex = 0;   // reachable with Tab, opened with Enter
        tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === tr) { e.preventDefault(); o.onRow(r); } });
      }
      return tr;
    }
  };

  /** An amount in full, compact in a phone row (UI.table phone, css .n2): "$23,720,633.03" reads "$23.72M" there. */
  UI.money2 = (x, o) => h('span.n2', h('span.n-full', U.fmtUsd(x, o)), h('span.n-compact', U.fmtUsd(x, Object.assign({}, o, { compact: true }))));

  /** A rank in a ranked list: 1st, 2nd and 3rd as gold, silver and bronze medals (podium false: the number alone). */
  UI.rank = (i, podium = true) => (podium && i >= 1 && i <= 3
    ? h('span.rank.medal', { class: 'r' + i, title: ['1st', '2nd', '3rd'][i - 1] + ' place' }, String(i))
    : h('span.rank', String(i)));

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
  /** A select with a search box, for long lists: a button with the chosen option's label; clicking it opens the list
   *  under a filter field. Typing narrows it by the label and the option's keys (every word must be found, accents and
   *  case ignored; an exact word or a word's start ranks first), arrows and Enter choose, Escape, Tab or a click
   *  elsewhere closes. pick({ options: [{ v, label, keys?, note? }], value, onChange, label, title, placeholder }) */
  UI.pick = function ({ options, value, onChange, label, title, placeholder }) {
    const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const index = options.map((o, i) => { const hay = norm(o.label + ' ' + (o.keys || '') + ' ' + (o.note || '')); return { o, i, hay, toks: hay.split(/[\s,()·]+/).filter(Boolean) }; });
    const cur = options.find((o) => o.v === value) || null;
    const btn = h('button.input.sm.pick-btn', { type: 'button', title: title || label || null, 'aria-label': label || null, 'aria-haspopup': 'listbox', 'aria-expanded': 'false' },
      h('span.pick-val', cur ? cur.label : String(value == null ? '' : value)), h('span.pick-caret', '▾'));
    const search = h('input.input.sm', { type: 'search', placeholder: placeholder || 'Search…', autocomplete: 'off', spellcheck: false, 'aria-label': 'Search ' + (label || '').toLowerCase() });
    const list = h('div.pick-list', { role: 'listbox', 'aria-label': label || null });
    const panel = h('div.pick-panel', search, list); panel.hidden = true;
    const wrap = h('span.pick', btn, panel);
    let shown = [], active = 0;
    const scrollTo = () => { const el = list.children[active]; if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' }); };
    const draw = () => {
      const words = norm(search.value).split(/\s+/).filter(Boolean);
      // every word somewhere; ranked by how many words are a whole word (2) or a word's start (1) of the option
      shown = !words.length ? index.slice() : index.filter((x) => words.every((w) => x.hay.includes(w)))
        .map((x) => Object.assign({ score: words.reduce((s, w) => s + (x.toks.includes(w) ? 2 : x.toks.some((t) => t.startsWith(w)) ? 1 : 0), 0) }, x))
        .sort((a, b) => b.score - a.score || a.i - b.i);
      if (active >= shown.length) active = Math.max(0, shown.length - 1);
      U.replace(list, shown.length ? shown.map((x, k) => h('div.pick-opt', { role: 'option', 'aria-selected': String(x.o.v === value), class: (k === active ? 'on' : '') + (x.o.v === value ? ' sel' : ''),
        onmousedown: (e) => { e.preventDefault(); choose(x.o); }, onmousemove: () => { if (active !== k) { active = k; U.$$('.pick-opt', list).forEach((el, j) => el.classList.toggle('on', j === k)); } } },
      h('span', x.o.label), x.o.note ? h('span.note', x.o.note) : null)) : h('div.pick-empty', 'Nothing matches'));
    };
    const outside = (e) => { if (!wrap.contains(e.target)) close(); };
    function open() {
      panel.hidden = false; btn.setAttribute('aria-expanded', 'true'); search.value = '';
      // under the button, moved left as far as it must to stay in the window (16 px from either edge)
      const r = btn.getBoundingClientRect(), w = Math.min(300, window.innerWidth - 32);
      panel.style.width = w + 'px'; panel.style.left = (Math.max(16, Math.min(r.left, window.innerWidth - 16 - w)) - r.left) + 'px';
      active = Math.max(0, index.findIndex((x) => x.o.v === value)); draw(); scrollTo(); search.focus();
      document.addEventListener('mousedown', outside, true);
    }
    function close() { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); document.removeEventListener('mousedown', outside, true); }
    function choose(o) { close(); btn.focus(); if (o && o.v !== value) onChange(o.v); }
    btn.addEventListener('click', () => (panel.hidden ? open() : close()));
    search.addEventListener('input', () => { active = 0; draw(); list.scrollTop = 0; });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!shown.length) return; active = (active + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length; U.$$('.pick-opt', list).forEach((el, j) => el.classList.toggle('on', j === active)); scrollTo(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (shown[active]) choose(shown[active].o); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); btn.focus(); }
      else if (e.key === 'Tab') close();
    });
    return wrap;
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
  // kept on the page while the snapshot is young, and shown once it is not: a page left open turns stale on time (checked
  // with the ages, every 30 s)
  UI.staleNote = (builtAt, hint) => {
    if (!builtAt) return null;
    const el = h('span.stale-note', { style: { color: 'var(--amber)' } }, ' · ', h('a', { href: '#/status', style: { color: 'inherit' }, title: (hint ? hint + ' · ' : '') + 'refreshed every 30 minutes normally; click for the data status page' }, 'stale'));   // the age itself is printed just before
    el.__t = builtAt; el.hidden = !(Date.now() - builtAt > UI.STALE_MS);
    return el;
  };
  if (typeof document !== 'undefined') setInterval(() => { for (const el of document.querySelectorAll('.stale-note')) el.hidden = !(Date.now() - el.__t > UI.STALE_MS); }, 30000);
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

  /** Name a favorite wallet (U.favorites.setLabel): a small dialog with its address, the name, and a way to unfavorite it.
   *  The home page opens it from a favorite's right-click or long press, the Favorites page from a row's pencil. */
  UI.nameFavorite = function (sid) {
    const f = U.favorites.list().find((x) => x.subaccountId === sid); if (!f) return null;
    const input = h('input.input', { type: 'text', value: f.label || '', maxLength: U.FAV_LABEL_MAX, placeholder: 'A name for this wallet', autocomplete: 'off', 'aria-label': 'Name' });
    input.spellcheck = false;   // h() skips a false attribute
    let m = null;
    const save = (v) => { const name = String(v || '').replace(/\s+/g, ' ').trim(); U.favorites.setLabel(sid, name); if (m) m.close(); U.toast(name ? 'Saved as ' + name : 'Name removed'); };
    const form = h('form.fav-name', { onsubmit: (e) => { e.preventDefault(); save(input.value); } },
      h('div.small.dim.addr-full', f.address),
      input,
      h('div.row.wrap', { style: { gap: '8px' } },
        h('button.btn.sm.primary', { type: 'submit' }, 'Save'),
        f.label ? h('button.btn.sm', { type: 'button', onclick: () => save('') }, 'Remove the name') : null,
        h('span.grow'),
        h('button.btn.sm.ghost', { type: 'button', title: 'Remove this wallet from your favorites', onclick: () => { U.favorites.remove(sid); if (m) m.close(); U.toast('Removed from favorites'); } }, U.icon('trash'), 'Unfavorite')),
      h('div.xs.dim', 'Names stay in this browser, like your favorites.'));
    m = UI.modal({ title: 'Name this wallet', body: form });
    setTimeout(() => { input.focus(); input.select(); }, 30);
    return m;
  };

  UI.marketCell = (ticker, sub) => h('div.mkt-row', h('div.tick', U.kid(ticker)), sub ? h('div.sub', U.kid(sub)) : null);
  UI.chip = (text, cls) => h('span.chip', { class: cls || '' }, text);
  UI.pct = (v, opts) => (v == null || !Number.isFinite(v) ? h('span.dim', '—') : h('span', { class: 'num ' + U.pnlClass(v) }, U.fmtPct(v, Object.assign({ sign: true, dp: 1 }, opts))));
  UI.usd = (v, opts) => h('span.num', U.fmtUsd(v, opts));
})();
