/* MeridianDataHub — reusable UI widgets */
(function () {
  const MD = window.MD; const U = MD.util; const h = U.h;
  const UI = (MD.ui = {});

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
  UI.stat = (k, v, sub, cls) => h('div.stat', h('div.k', k), h('div.v', { class: (cls || '') + (String(typeof v === 'string' ? v : (v && v.textContent) || '').length > 12 ? ' long' : '') }, v), sub ? h('div.sub', sub) : null);
  UI.metric = (k, v, s, cls) => h('div.metric', h('div.k', k), h('div.v', { class: cls || '' }, v), s ? h('div.s', s) : null);
  UI.card = (title, body, extra) => h('div.card.tight', h('div.card-head', h('h2', title), extra || null), body);
  UI.loading = (text) => h('div.empty', h('span.loading', h('span.spinner'), text || 'Loading…'));
  UI.error = (err, retry) => h('div.error', h('div', String((err && err.message) || err || 'Error')), retry ? h('div', { style: { marginTop: '8px' } }, h('button.btn.sm', { onclick: retry }, 'Retry')) : null);
  UI.empty = (text) => h('div.empty', text);

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
  new MutationObserver(() => { clearTimeout(fitTabs._t); fitTabs._t = setTimeout(fitTabs, 50); }).observe(document.documentElement, { childList: true, subtree: true });

  /** Inline warning when a published snapshot is older than it should be (the publishers run every 30 minutes). */
  UI.STALE_MS = 2 * 3600000;
  UI.staleNote = (builtAt, hint) => (builtAt && Date.now() - builtAt > UI.STALE_MS
    ? h('span', { style: { color: 'var(--amber)' }, title: (hint ? hint + ' · ' : '') + 'refreshed every 30 minutes normally' }, ' · stale')   // the age itself is printed just before
    : null);
  /** modal({title, body}) → {close}; closes on the backdrop, the × button or Escape */
  UI.modal = function ({ title, body, wide }) {
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); };
    const bg = h('div.modal-bg', { onclick: (e) => { if (e.target === bg) close(); } },
      h('div.modal', { class: wide ? 'wide' : '', role: 'dialog', 'aria-modal': 'true' }, h('div.modal-head', h('h2', title), h('button.btn.sm.icon.ghost', { title: 'Close', onclick: close }, U.icon('x'))), h('div.modal-body', body)));
    document.body.appendChild(bg); document.addEventListener('keydown', onKey);
    return { close, el: bg };
  };
  UI.checkbox = (label, checked, onChange) => { const inp = h('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked) }); return h('label.checkbox', inp, label); };

  UI.starBtn = function (fav, cls) {
    const b = h('button.star-btn', { class: (U.favorites.has(fav.subaccountId) ? 'on ' : '') + (cls || ''), title: 'Favorite' }, U.icon(U.favorites.has(fav.subaccountId) ? 'starFill' : 'star'));
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); const on = U.favorites.toggle(fav); b.classList.toggle('on', on); U.replace(b, U.icon(on ? 'starFill' : 'star')); U.toast(on ? 'Added to favorites' : 'Removed from favorites'); });
    return b;
  };

  UI.marketCell = (ticker, sub) => h('div.mkt-row', h('div.tick', ticker), sub ? h('div.sub', sub) : null);
  UI.chip = (text, cls) => h('span.chip', { class: cls || '' }, text);
  UI.pct = (v, opts) => (v == null || !Number.isFinite(v) ? h('span.dim', '—') : h('span', { class: 'num ' + U.pnlClass(v) }, U.fmtPct(v, Object.assign({ sign: true, dp: 1 }, opts))));
  UI.usd = (v, opts) => h('span.num', U.fmtUsd(v, opts));
})();
