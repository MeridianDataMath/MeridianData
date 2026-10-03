/* MeridianDataHub — Tax center UI helpers: downloads, export buttons, amounts, progress lines and the methodology block.
   Touches the DOM only when called, so it loads in Node too. */
(function () {
  const MD = window.MD; const U = MD.util; const T = MD.tax; const h = U.h;
  const TUI = (T.ui = {});
  TUI.WARN_MS = 6000;   // a download that is incomplete says so long enough to be read

  /** Saves data as a file. data: text (a CSV gets a byte-order mark, so Excel reads it as UTF-8; o.bom false leaves it
   *  out, as a tax tool reads its first row as the header) or bytes (a ZIP). o: {warn ([text]: what makes the file
   *  incomplete: the name gets -INCOMPLETE and the toast says why, for about 6 s), bom, type}. */
  TUI.download = (name, data, o = {}) => {
    const warn = o.warn && o.warn.length ? o.warn : null;
    if (warn) name = T.exports.fileName({ name, warnings: warn });
    const text = typeof data === 'string';
    const blob = new Blob(text && o.bom !== false ? ['﻿' + data] : [data], { type: o.type || 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name }); document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    U.toast((warn ? warn.join('; ') + ' · ' : '') + 'Downloaded ' + name, warn ? TUI.WARN_MS : undefined);
  };
  /** Saves a built export (MD.tax.exports.build): a report with its methodology rows first, a tool file as it is. */
  TUI.save = (file, meth) => {
    const EX = T.exports, tool = file.kind === 'tool';
    TUI.download(EX.fileName(file), EX.render(file, tool ? null : meth), { warn: file.warnings, bom: !tool });
  };
  /** A click handler that shows a spinner on the button while fn runs, and a toast if it fails. */
  TUI.busyFn = (btn, fn) => async () => { btn.disabled = true; const old = Array.from(btn.childNodes); U.replace(btn, h('span.spinner'), ' Preparing…'); try { await fn(); } catch (e) { if (!T.isAbort(e)) U.toast('Export failed: ' + e.message, TUI.WARN_MS); } btn.disabled = false; U.replace(btn, old); };
  /** An export button with its line of text. async: fn runs through TUI.busyFn (a spinner, and 'Export failed: …' when
   *  it throws), as every Tax center export passes it; without it a failure would reach only the console. */
  TUI.exBtn = (label, sub, fn, async) => { const b = h('button.btn', {}, U.icon('download'), label); b.addEventListener('click', async ? TUI.busyFn(b, fn) : fn); return h('div.metric', h('div', b), h('div.s', { style: { marginTop: '6px' } }, sub)); };
  /** money → (amount in the report currency, the same in USD for its colour) → a signed amount element */
  TUI.pnlEl = (money) => (vC, vUsd) => h('span', { class: 'num ' + U.pnlClass(vUsd != null ? vUsd : vC) }, money.fmt(vC, { sign: true }));
  /** A loading line in el that counts ('Reading hourly ledgers… 3 / 8'), with Cancel when onCancel is given. */
  TUI.progress = (el, onCancel) => {
    const txt = h('span', 'Loading…');
    const btn = onCancel ? h('button.btn.sm.ghost', { style: { marginLeft: '10px' }, onclick: () => { btn.disabled = true; onCancel(); } }, 'Cancel') : null;
    U.replace(el, h('div.empty', h('span.loading', h('span.spinner'), txt), btn));
    return { set(label, done, total) { txt.textContent = label + (total ? ` ${done} / ${total}` : ''); } };
  };
  /** Text with a break opportunity after each '/' and '_', for a zone name in a narrow column heading ('Time
   *  (America/Argentina/Buenos_Aires)'): a printed table can then wrap the heading instead of growing past the page. */
  TUI.wbr = (text) => String(text).replace(/[/_]/g, '$&\n').split('\n').filter(Boolean).flatMap((p, i) => (i ? [h('wbr'), p] : [p]));   // no lookbehind: older Safari cannot parse one
  /** A column heading that names the zone: 'Time (Europe/Berlin)', breakable after its slashes. */
  TUI.tzLabel = (word, tz) => h('span', word + ' (', TUI.wbr(tz), ')');
  /** A one-line notice card (a link that was corrected, a fallback): factual, amber. */
  TUI.notice = (...text) => h('div.card', h('div.small', { style: { color: 'var(--amber)' } }, ...text));
  /** The methodology record (MD.tax.methodology.build) as a definition list. */
  TUI.methodologyEl = (rows) => h('dl.tax-meth', rows.map(([k, v]) => [h('dt', k), h('dd', /^https?:\/\//.test(String(v)) ? h('span.mono', String(v)) : String(v))]));
})();
