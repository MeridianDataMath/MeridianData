/* MeridianDataHub — "Equity curve flex": the account's or wallet's card (js/cards.js) drawn in the browser from the page's
 * own figures, for a chosen period, with or without dollar amounts; downloaded or copied as a PNG, or posted on X.
 * Nothing is uploaded: the SVG is rasterised on a canvas here. The site's Geist fonts are embedded in the SVG, since an
 * SVG drawn as an image cannot reach the page's web fonts. */
(function () {
  const MD = window.MD; const U = MD.util; const h = U.h;
  const FX = (MD.flex = {});
  let fontCss = null;
  const b64 = async (url) => {
    const r = await fetch(url); if (!r.ok) throw new Error('font ' + r.status);
    const bytes = new Uint8Array(await r.arrayBuffer()); let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  FX.fonts = async () => {
    if (fontCss) return fontCss;
    try {
      const [sans, mono] = await Promise.all([b64('assets/fonts/geist-latin.woff2'), b64('assets/fonts/geist-mono-latin.woff2')]);
      fontCss = `@font-face{font-family:'Geist';font-weight:100 900;src:url(data:font/woff2;base64,${sans}) format('woff2')}@font-face{font-family:'Geist Mono';font-weight:100 900;src:url(data:font/woff2;base64,${mono}) format('woff2')}`;
    } catch (e) { fontCss = ''; }   // the card still renders, in the system's fonts
    return fontCss;
  };
  const load = (svg) => new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    const img = new Image();
    img.onload = () => resolve({ img, url }); img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('The card could not be drawn')); };
    img.src = url;
  });
  /** SVG → PNG blob at `scale` × 1200 × 630 (2 = crisp on phones and retina screens). */
  FX.png = async (svg, scale = 2) => {
    const { img, url } = await load(svg);
    try {
      if (img.decode) { try { await img.decode(); } catch (_) {} }
      await new Promise((r) => setTimeout(r, 30));   // embedded fonts: let the image finish laying out its text
      const c = document.createElement('canvas'); c.width = MD.cards.W * scale; c.height = MD.cards.H * scale;
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('PNG export failed'))), 'image/png'));
    } finally { URL.revokeObjectURL(url); }
  };
  const saveBlob = (blob, name) => {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name }); document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  /**
   * o: { address, periods: [{ v, label }], period (initial v), build: async (v) → card input (js/cards.js flexSvg without
   *      hideAmounts / fontCss), shareUrl, what ('account' | 'wallet') }
   */
  FX.open = function (o) {
    const K = MD.cards.make({ U, P: MD.predict });
    let period = o.period || (o.periods && o.periods.length ? o.periods[o.periods.length - 1].v : 'all');
    let hide = !!U.storage.get('md.flex.hide', false);
    const inputs = new Map(); let svg = null, previewUrl = null, seq = 0;
    // the PNG of what is on screen, made as soon as the preview changes: sharing must start right on the tap (Safari drops
    // the share sheet after an await), and download / copy are instant
    let pngP = null, pngBlob = null;
    const img = h('img', { alt: 'Equity curve card', style: { width: '100%', height: 'auto', display: 'block', borderRadius: '12px', border: '1px solid var(--border-3)' } });
    const frame = h('div.flex-frame', img);
    const status = h('div.flex-status');
    const setBusy = (text) => { frame.classList.toggle('busy', !!text); U.replace(status, text ? h('span.dim.small', h('span.spinner.sm'), ' ', text) : ''); };
    const periodSeg = o.periods && o.periods.length > 1 ? h('span', MD.ui.seg(o.periods, period, (v) => { period = v; render(); }, 'sm')) : null;
    const hideBox = MD.ui.checkbox('Hide dollar amounts', hide, (v) => { hide = v; U.storage.set('md.flex.hide', v); render(); });
    const fname = () => `meridian-${String(o.address).slice(0, 8)}-${period}${hide ? '-pct' : ''}.png`;
    const btnDl = h('button.btn.primary', { onclick: async () => { if (!svg) return; try { btnDl.disabled = true; saveBlob(await (pngP || FX.png(svg)), fname()); U.toast('Saved ' + fname()); } catch (e) { U.toast(e.message || 'Download failed'); } finally { btnDl.disabled = false; } } }, U.icon('download'), 'Download PNG');
    const canCopy = !!(navigator.clipboard && window.ClipboardItem);
    const btnCopy = canCopy ? h('button.btn', { onclick: async () => {
      if (!svg) return;
      try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngP || FX.png(svg) })]); U.toast('Image copied: paste it into a post or a chat'); }
      catch (e) { U.toast('This browser would not copy the image: use Download'); }
    } }, U.icon('copy'), 'Copy image') : null;
    // phones (and some desktops): the system share sheet with the image attached, straight into X, Telegram, Instagram…
    const canShareFiles = (() => { try { return !!(navigator.canShare && navigator.canShare({ files: [new File([''], 't.png', { type: 'image/png' })] })); } catch (e) { return false; } })();
    const btnShare = canShareFiles ? h('button.btn', { onclick: () => {
      if (!pngBlob) { U.toast('The image is still being made: try again in a moment'); return; }
      // the share link shows amounts, so with them hidden the post carries the site's address instead
      navigator.share({ files: [new File([pngBlob], fname(), { type: 'image/png' })], text: hide || !o.shareUrl ? MD.api.SITE_URL : o.shareUrl }).catch((e) => { if (e && e.name !== 'AbortError') U.toast('Sharing failed: use Download'); });
    } }, U.icon('external'), 'Share image') : null;
    const btnX = h('button.btn', { onclick: () => {
      const inp = inputs.get(period); if (!inp) return;
      const roi = inp.roi == null || !Number.isFinite(inp.roi) ? null : U.fmtPct(inp.roi, { sign: true, dp: Math.abs(inp.roi) < 10 ? 1 : 0 });
      const when = (o.periods.find((p) => p.v === period) || {}).label || 'All time';
      const what = o.what === 'wallet' ? 'Meridian Predict' : 'Meridian';
      const text = hide ? `My ${what} equity curve: ${roi || '—'} (${when.toLowerCase()})` : `My ${what} equity curve: ${K.money(inp.pnl, true)}${roi ? ' (' + roi + ' ROI)' : ''}, ${when.toLowerCase()}`;
      // the share link unfurls into the all-time card with dollar amounts, so with amounts hidden the post links the site
      const url = hide ? MD.api.SITE_URL : o.shareUrl;
      window.open('https://x.com/intent/post?text=' + encodeURIComponent(text) + '&url=' + encodeURIComponent(url), '_blank', 'noopener');
    } }, U.icon('external'), 'Post on X');
    const btnLink = o.shareUrl ? h('button.btn.ghost', { onclick: () => { U.copyText(o.shareUrl); U.toast('Share link copied · it shows the all-time card'); } }, U.icon('copy'), 'Copy share link') : null;
    const body = h('div.flex-modal',
      h('div.row.wrap', { style: { gap: '10px', marginBottom: '12px' } }, periodSeg, hideBox, h('span.grow'), status),
      frame,
      h('div.row.wrap', { style: { gap: '8px', marginTop: '14px' } }, btnDl, btnShare, btnCopy, btnX, h('span.grow'), btnLink),
      h('p.dim.xs', { style: { margin: '12px 0 0' } }, 'Made in your browser from the figures on this page; nothing is uploaded. "Post on X" opens a draft: attach the downloaded image to it. The share link shows the all-time card.'));
    const modal = MD.ui.modal({ title: 'Equity curve flex', body, wide: true });
    const show = (s) => { if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = URL.createObjectURL(new Blob([s], { type: 'image/svg+xml' })); img.src = previewUrl; };
    async function render() {
      const my = ++seq;
      try {
        let inp = inputs.get(period);
        if (!inp) { setBusy('Loading ' + ((o.periods.find((p) => p.v === period) || {}).label || '').toLowerCase() + '…'); inp = await o.build(period); inputs.set(period, inp); }
        const css = await FX.fonts();
        if (my !== seq) return;
        svg = K.flexSvg(Object.assign({}, inp, { hideAmounts: hide, fontCss: css }));
        show(svg); setBusy(null);
        pngBlob = null; const p = (pngP = FX.png(svg)); p.then((b) => { if (pngP === p) pngBlob = b; }).catch(() => {});
      } catch (e) { if (my !== seq) return; setBusy(null); U.replace(status, h('span.neg.small', e.message || 'Could not build the card')); }
    }
    const obs = new MutationObserver(() => { if (!document.body.contains(modal.el)) { obs.disconnect(); if (previewUrl) URL.revokeObjectURL(previewUrl); } });
    obs.observe(document.body, { childList: true });
    render();
    return modal;
  };

  /**
   * A card to share as it is (a Predict slip): the link first, since a pasted link unfurls into this same card in Discord,
   * X, Telegram…; the image for places that take a picture.
   * o: { title, alt, draw: (fontCss) → SVG, fname, shareUrl, postText,
   *      card: the published card's URL (does the link unfurl yet?), expected: whether the deploy makes one for it }
   */
  FX.card = function (o) {
    let svg = null, previewUrl = null, pngP = null, pngBlob = null, ready = false;
    const img = h('img', { alt: o.alt || o.title, style: { width: '100%', height: 'auto', display: 'block', borderRadius: '12px', border: '1px solid var(--border-3)' } });
    const frame = h('div.flex-frame.busy', img);
    const linkIn = h('input.input.mono.share-link-input', { value: o.shareUrl, readOnly: true, 'aria-label': 'Share link', onfocus: (e) => e.target.select() });
    const btnLink = h('button.btn.primary', { onclick: () => { U.copyText(o.shareUrl); U.toast(ready ? 'Link copied: wherever you paste it, it shows this card' : 'Link copied'); } }, U.icon('copy'), 'Copy link');
    const btnDl = h('button.btn', { onclick: async () => { if (!svg) return; try { btnDl.disabled = true; saveBlob(await (pngP || FX.png(svg)), o.fname); U.toast('Saved ' + o.fname); } catch (e) { U.toast(e.message || 'Download failed'); } finally { btnDl.disabled = false; } } }, U.icon('download'), 'Download PNG');
    const canCopy = !!(navigator.clipboard && window.ClipboardItem);
    const btnCopy = canCopy ? h('button.btn', { onclick: async () => {
      if (!svg) return;
      try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngP || FX.png(svg) })]); U.toast('Image copied: paste it into a post or a chat'); }
      catch (e) { U.toast('This browser would not copy the image: use Download'); }
    } }, U.icon('copy'), 'Copy image') : null;
    const canShareFiles = (() => { try { return !!(navigator.canShare && navigator.canShare({ files: [new File([''], 't.png', { type: 'image/png' })] })); } catch (e) { return false; } })();
    const btnShare = canShareFiles ? h('button.btn', { onclick: () => {
      if (!pngBlob) { U.toast('The image is still being made: try again in a moment'); return; }
      navigator.share({ files: [new File([pngBlob], o.fname, { type: 'image/png' })], text: o.shareUrl }).catch((e) => { if (e && e.name !== 'AbortError') U.toast('Sharing failed: use Download'); });
    } }, U.icon('external'), 'Share image') : null;
    const btnX = h('button.btn', { onclick: () => window.open('https://x.com/intent/post?text=' + encodeURIComponent(o.postText || o.title) + '&url=' + encodeURIComponent(o.shareUrl), '_blank', 'noopener') }, U.icon('external'), 'Post on X');
    const note = h('p.dim.xs', { style: { margin: '12px 0 0' } }, 'The link opens this slip on the site.');
    const body = h('div.flex-modal',
      frame,
      h('div.share-link', linkIn, btnLink),
      h('div.row.wrap', { style: { gap: '8px', marginTop: '10px' } }, btnX, btnShare, btnCopy, btnDl),
      note);
    const modal = MD.ui.modal({ title: o.title, body, wide: true });
    // is the card published? Its URL answers with the image; a missing file gets the site's page (the SPA fallback)
    if (o.card) fetch(o.card, { method: 'HEAD', cache: 'no-store' }).then((r) => r.ok && /^image\//.test(r.headers.get('content-type') || '')).catch(() => false).then((ok) => {
      ready = ok;
      note.textContent = ok ? 'Paste the link in Discord, X, Telegram or anywhere else: it shows this card, no click needed. The image is made in your browser.'
        : o.expected ? 'The link opens this slip; its preview card is added with the next site update, within the hour. Until then, share the image.'
          : 'The link opens this slip. Preview cards are made for open slips, the last week\'s and the wins: share the image for this one.';
    });
    (async () => {
      try {
        svg = o.draw(await FX.fonts());
        previewUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })); img.src = previewUrl; frame.classList.remove('busy');
        const p = (pngP = FX.png(svg)); p.then((b) => { if (pngP === p) pngBlob = b; }).catch(() => {});
      } catch (e) { frame.classList.remove('busy'); frame.replaceWith(h('p.neg.small', e.message || 'Could not draw the card')); }
    })();
    const obs = new MutationObserver(() => { if (!document.body.contains(modal.el)) { obs.disconnect(); if (previewUrl) URL.revokeObjectURL(previewUrl); } });
    obs.observe(document.body, { childList: true });
    return modal;
  };
})();
