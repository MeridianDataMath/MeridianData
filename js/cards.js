/* MeridianDataHub — link-preview cards: one 1200 × 630 artwork for a perps account, a Predict wallet or a Predict slip, used twice:
 *   · in the browser (js/flex.js): drawn from the page's live figures, downloaded or copied as a PNG, with a period and an
 *     option to hide dollar amounts;
 *   · by the deploy (scripts/build-cards.mjs): rendered with resvg for every account, wallet and shareable slip as the
 *     image behind its share link (/a/<address>, /p/<address>, /s/<prediction id>), plus the small page that carries it
 *     for link unfurlers.
 * Classic script with no DOM access (the build loads it with vm): MD.cards.make({ U, P, site }) returns the builders. */
(function () {
  const MD = (window.MD = window.MD || {});
  const W = 1200, H = 630;
  const SITE = 'https://meridian.thedatahub.xyz';
  const C = { bg: '#070708', panel: '#0e0e0f', line: '#232324', text: '#ececee', text2: '#a1a1a8', text3: '#6b6b72', accent: '#23d4bc', green: '#34d487', red: '#ef454a' };
  const SANS = 'Geist, sans-serif', MONO = "'Geist Mono', monospace";
  // the Meridian symbol (assets/meridian-symbol.svg, 144 × 95)
  const LOGO = 'M106.723 12.8039C106.646 5.17209 103.931 1.71922 98.4607 0.417789C91.1338 -1.32539 80.4935 2.32385 69.9679 12.5422C69.8907 4.91032 67.1756 1.71922 61.7056 0.417789C54.0401 -1.40595 42.7463 4.89516 31.7531 16.0181C40.114 8.76949 48.4173 4.93543 54.4042 6.35984C65.6087 9.02558 60.9511 29.6562 48.3263 51.7468C35.7015 73.8375 19.4652 87.2979 8.26074 84.6322C2.27382 83.2078 0.241401 78.5384 1.17537 69.5229C-1.65487 82.5879 0.595376 92.1113 8.26074 93.9349C15.5879 95.6782 26.2306 89.9998 36.7568 79.7806C36.8337 87.412 39.5462 92.6336 45.0158 93.9349C52.343 95.6782 62.9857 89.9998 73.5118 79.7806C73.5888 87.412 76.3012 92.6336 81.7709 93.9349C94.2409 96.9018 116.314 78.3724 131.072 52.5483C145.831 26.7243 147.686 3.38462 135.216 0.417789C127.889 -1.32539 117.249 2.58563 106.723 12.8039ZM94.3172 52.5483C102.541 38.1579 106.759 24.5389 106.723 14.7869C114.583 8.34077 122.276 5.01838 127.914 6.35984C139.119 9.02558 134.461 29.6562 121.836 51.7468C109.212 73.8375 92.9754 87.2979 81.7709 84.6322C78.1587 83.7728 75.9861 81.7321 75.0359 78.2683C81.903 71.307 88.6495 62.4656 94.3172 52.5483ZM69.9679 14.7868C70.0035 24.5389 65.7862 38.1579 57.5621 52.5483C51.8944 62.4656 45.1479 71.307 38.2809 78.2683C39.231 81.7321 41.4036 83.7728 45.0158 84.6322C56.2203 87.2979 72.4566 73.8375 85.0814 51.7468C97.7062 29.6562 102.364 9.02558 91.1593 6.35984C85.5203 5.01838 77.8277 8.34077 69.9679 14.7868Z';
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const isAddr = (a) => /^0x[0-9a-f]{40}$/.test(String(a || ''));
  const f1 = (x) => (Math.round(x * 10) / 10).toString();

  function make({ U, P, site = SITE }) {
    const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
    /** Money for a headline or a figure: cents below $100K, compact above ("$1.43M"), a sign where asked. */
    const money = (v, sign) => { const n = Number(v) || 0; return Math.abs(n) >= 1e5 ? U.fmtUsd(n, { compact: true, sign }) : U.fmtUsd(n, { sign }); };
    const pct = (v, dp = 1, sign = false) => (v == null || !Number.isFinite(v) ? '—' : U.fmtPct(v, { dp, sign }));
    const roiTxt = (v) => (v == null || !Number.isFinite(v) ? null : pct(v, Math.abs(v) < 10 ? 1 : 0, true));
    const date = (t) => (t ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : null);
    const dateShort = (t) => (t ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : null);
    const range = (a, b) => { if (!a || !b) return null; const ya = new Date(a).getUTCFullYear(), yb = new Date(b).getUTCFullYear(); return (ya === yb ? dateShort(a) : date(a)) + ' – ' + date(b); };
    /** Font size for mono text to fit a width (Geist Mono advances 0.6 em; 0.62 leaves room for the bold weight). */
    const fit = (text, maxW, maxSize, minSize = 22) => Math.max(minSize, Math.min(maxSize, Math.floor(maxW / (String(text).length * 0.62))));
    const t = (x, y, s, size, o = {}) => `<text x="${f1(x)}" y="${f1(y)}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''} font-family="${o.mono ? MONO : SANS}" font-weight="${o.w || 400}" font-size="${size}"${o.ls ? ` letter-spacing="${o.ls}"` : ''} fill="${o.fill || C.text}"${o.op ? ` fill-opacity="${o.op}"` : ''}>${esc(s)}</text>`;
    const label = (x, y, s, o = {}) => t(x, y, String(s).toUpperCase(), 15, Object.assign({ w: 600, ls: 1.6, fill: C.text3 }, o));

    // ---------------------------------------------------------------- the chart
    /** A smooth path through the points that never overshoots them (monotone cubic, Fritsch–Carlson): a few daily points
     *  read as a curve rather than a zigzag, and no peak or dip appears that the data does not have. */
    const smooth = (P) => {
      const n = P.length; if (n < 3) return P.map((p, i) => (i ? 'L' : 'M') + f1(p[0]) + ' ' + f1(p[1])).join(' ');
      const dx = [], m = [];
      for (let i = 0; i < n - 1; i++) { dx[i] = P[i + 1][0] - P[i][0]; m[i] = dx[i] ? (P[i + 1][1] - P[i][1]) / dx[i] : 0; }
      const tg = [m[0]]; for (let i = 1; i < n - 1; i++) tg[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2; tg[n - 1] = m[n - 2];
      for (let i = 0; i < n - 1; i++) { if (!m[i]) { tg[i] = 0; tg[i + 1] = 0; continue; } const a = tg[i] / m[i], b = tg[i + 1] / m[i], q = a * a + b * b; if (q > 9) { const k = 3 / Math.sqrt(q); tg[i] = k * a * m[i]; tg[i + 1] = k * b * m[i]; } }
      let d = 'M' + f1(P[0][0]) + ' ' + f1(P[0][1]);
      for (let i = 0; i < n - 1; i++) {
        const [x0, y0] = P[i], [x1, y1] = P[i + 1];
        d += dx[i] ? ` C${f1(x0 + dx[i] / 3)} ${f1(y0 + (tg[i] * dx[i]) / 3)} ${f1(x1 - dx[i] / 3)} ${f1(y1 - (tg[i + 1] * dx[i]) / 3)} ${f1(x1)} ${f1(y1)}` : ` L${f1(x1)} ${f1(y1)}`;
      }
      return d;
    };
    function chart(pts, box, col, hide, emptyText) {
      const { x, y, w, h } = box;
      if (pts) pts = pts.filter((p, i) => i === pts.length - 1 || p[0] !== pts[i + 1][0]);   // one point per moment (a vertical tick otherwise)
      if (!pts || pts.length < 2) return t(x + w / 2, y + h / 2, emptyText || 'Not enough history for a curve yet', 20, { anchor: 'middle', fill: C.text3 });
      const t0 = pts[0][0], t1 = pts[pts.length - 1][0]; const vs = pts.map((p) => p[1]);
      let lo = Math.min(0, ...vs), hi = Math.max(0, ...vs); if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
      const pad = (hi - lo) * 0.1; lo -= pad; hi += pad * 1.6;   // headroom above for the end-point halo
      const X = (tt) => x + (t1 > t0 ? ((tt - t0) / (t1 - t0)) * w : w / 2), Y = (v) => y + h - ((v - lo) / (hi - lo)) * h;
      const line = smooth(pts.map((p) => [X(p[0]), Y(p[1])]));
      const zero = Y(0), last = vs[vs.length - 1];
      const area = line + ` L${f1(X(t1))} ${f1(zero)} L${f1(X(t0))} ${f1(zero)} Z`;
      const grid = [0.25, 0.5, 0.75].map((k) => `<line x1="${x}" y1="${f1(y + h * k)}" x2="${x + w}" y2="${f1(y + h * k)}" stroke="#ffffff" stroke-opacity="0.045" stroke-width="1"/>`).join('');
      // the high-water mark and the end value, as small tags (hidden with the dollar amounts)
      let peakI = 0; vs.forEach((v, i) => { if (v > vs[peakI]) peakI = i; });
      const tags = hide ? '' : [
        vs[peakI] > 0 && peakI < vs.length - 1 && vs[peakI] - last > (hi - lo) * 0.08 ? t(Math.min(X(pts[peakI][0]), x + w - 60), Y(vs[peakI]) - 16, 'peak ' + money(vs[peakI], true), 15, { anchor: 'middle', fill: C.text2, mono: true, w: 500 }) : '',
      ].join('');
      return `<defs>
  <linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity="0.38"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient>
  <filter id="soft" x="-10%" y="-30%" width="120%" height="160%"><feGaussianBlur stdDeviation="7"/></filter>
</defs>
${grid}
<line x1="${x}" y1="${f1(zero)}" x2="${x + w}" y2="${f1(zero)}" stroke="${C.text3}" stroke-opacity="0.7" stroke-width="1.5" stroke-dasharray="5 7"/>
<path d="${area}" fill="url(#area)"/>
<path d="${line}" fill="none" stroke="${col}" stroke-opacity="0.55" stroke-width="10" stroke-linejoin="round" stroke-linecap="round" filter="url(#soft)"/>
<path d="${line}" fill="none" stroke="${col}" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"/>
<circle cx="${f1(X(t1))}" cy="${f1(Y(last))}" r="15" fill="${col}" fill-opacity="0.22"/>
<circle cx="${f1(X(t1))}" cy="${f1(Y(last))}" r="7" fill="${col}"/>
<circle cx="${f1(X(t1))}" cy="${f1(Y(last))}" r="3" fill="${C.bg}"/>
${tags}
${t(x, y + h + 30, date(t0 * 1000), 15, { fill: C.text3 })}
${t(x + w, y + h + 30, date(t1 * 1000), 15, { fill: C.text3, anchor: 'end' })}`;
    }

    // ---------------------------------------------------------------- the card
    /**
     * o: { kind: 'perps' | 'bettor' | 'maker' | 'counterparty' (a maker side under P.MAKER_MIN predictions), address,
     * period ('All time', '30 days', …), pnl, roi (percent), curve [[unix s, USD from 0], …] or null, noCurveText (why
     * there is no curve, where it is not a lack of history), stats [[label, value], …] (four), statsHidden (the four with
     * dollar amounts hidden), hideAmounts, footRight, fontCss (a <style> body with @font-face rules; the browser embeds
     * the fonts, resvg brings its own) }
     */
    function flexSvg(o) {
      const hide = !!o.hideAmounts;
      const pnl = Number(o.pnl) || 0, roi = o.roi == null || !Number.isFinite(o.roi) ? null : o.roi;
      const sign = roi != null && hide ? roi : pnl;
      const col = sign > 0.004 ? C.green : sign < -0.004 ? C.red : C.accent;
      const kindLabel = o.kind === 'maker' ? 'Market maker · Meridian Predict' : o.kind === 'counterparty' ? 'Counterparty · Meridian Predict' : o.kind === 'bettor' ? 'Bettor · Meridian Predict' : 'Perps · Meridian';
      const hero = hide ? (roiTxt(roi) || '—') : money(pnl, true);
      const heroLabel = (hide ? 'Return' : o.kind === 'maker' ? 'Maker PnL' : o.kind === 'counterparty' ? 'Counterparty PnL' : o.kind === 'bettor' ? 'Net PnL' : 'PnL') + ' · ' + (o.period || 'All time');
      const heroSize = fit(hero, 440, 96, 40);
      const pill = hide ? (o.periodRange || null) : roiTxt(roi) ? roiTxt(roi) + ' ROI' : null;
      const pillW = pill ? String(pill).length * (hide ? 10.6 : 13.2) + (hide ? 32 : 58) : 0;
      const heroY = 242 + 14 + heroSize;   // baseline of the big figure
      const pillY = heroY + 22;
      const arrow = !hide && roi != null ? (roi >= 0 ? `M${84} ${pillY + 25} L${92} ${pillY + 13} L${100} ${pillY + 25} Z` : `M${84} ${pillY + 13} L${92} ${pillY + 25} L${100} ${pillY + 13} Z`) : '';
      const stats = (hide && o.statsHidden) || o.stats || [];
      const cell = (i) => {
        const [k, v] = stats[i] || ['', ''];
        const cx = 64 + (i % 2) * 226, cy = 446 + Math.floor(i / 2) * 68;
        return label(cx, cy, k) + '\n' + t(cx, cy + 34, v, fit(v, 206, 30, 18), { mono: true, w: 600 });
      };
      // the pill names the curve only when one is drawn (a card without one shows the period alone)
      const pillTxt = (o.curve && o.curve.length >= 2 ? 'Equity curve · ' : '') + (o.period || 'All time');
      const pw = pillTxt.length * 9.6 + 40;
      const box = { x: 572, y: 150, w: 532, h: 318 };
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
${o.fontCss ? `<style>${o.fontCss}</style>` : ''}
  <radialGradient id="glow" cx="0.74" cy="0.5" r="0.62"><stop offset="0" stop-color="${col}" stop-opacity="0.2"/><stop offset="0.55" stop-color="${col}" stop-opacity="0.05"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></radialGradient>
  <radialGradient id="tl" cx="0.05" cy="0" r="0.5"><stop offset="0" stop-color="${C.accent}" stop-opacity="0.1"/><stop offset="1" stop-color="${C.accent}" stop-opacity="0"/></radialGradient>
  <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#ffffff" stroke-opacity="0.05" stroke-width="1"/></pattern>
  <radialGradient id="gridFade" cx="0.6" cy="0.45" r="0.75"><stop offset="0" stop-color="#ffffff" stop-opacity="1"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
  <mask id="gridMask"><rect width="${W}" height="${H}" fill="url(#gridFade)"/></mask>
</defs>
<rect width="${W}" height="${H}" fill="${C.bg}"/>
<rect width="${W}" height="${H}" fill="url(#grid)" mask="url(#gridMask)"/>
<rect width="${W}" height="${H}" fill="url(#glow)"/>
<rect width="${W}" height="${H}" fill="url(#tl)"/>
<g transform="translate(64 46) scale(0.28)"><path fill="${C.text}" fill-rule="evenodd" d="${LOGO}"/></g>
<text x="116" y="70" font-family="${SANS}" font-weight="700" font-size="26" fill="${C.text}">Meridian<tspan fill="${C.accent}">DataHub</tspan></text>
<rect x="${f1(W - 64 - pw)}" y="42" width="${f1(pw)}" height="38" rx="19" fill="${col}" fill-opacity="0.1" stroke="${col}" stroke-opacity="0.5" stroke-width="1.5"/>
${t(W - 64 - pw / 2, 67, pillTxt, 16, { anchor: 'middle', w: 600, fill: col })}
${label(64, 142, kindLabel, { fill: C.text2 })}
${t(64, 184, short(o.address), 38, { mono: true, w: 600 })}
${label(64, 242, heroLabel)}
${t(60, heroY, hero, heroSize, { mono: true, w: 700, fill: col })}
${pill ? `<rect x="64" y="${pillY}" width="${f1(pillW)}" height="38" rx="19" fill="${col}" fill-opacity="0.14"/>${arrow ? `<path d="${arrow}" fill="${col}"/>` : ''}${t(hide ? 64 + pillW / 2 : 110, pillY + 26, pill, hide ? 17 : 20, { anchor: hide ? 'middle' : null, w: 600, fill: hide ? C.text2 : col, mono: !hide })}` : ''}
${[0, 1, 2, 3].map(cell).join('\n')}
<rect x="${box.x - 32}" y="${box.y - 50}" width="${box.w + 64}" height="${box.h + 112}" rx="22" fill="${C.panel}" fill-opacity="0.66" stroke="#ffffff" stroke-opacity="0.07" stroke-width="1.5"/>
${chart(o.curve, box, col, hide, o.noCurveText)}
<line x1="64" y1="578" x2="${W - 64}" y2="578" stroke="#ffffff" stroke-opacity="0.07" stroke-width="1.5"/>
${t(64, 610, site.replace(/^https?:\/\//, ''), 19, { w: 600, fill: C.accent })}
${t(W - 64, 610, o.footRight || '', 17, { anchor: 'end', fill: C.text3 })}
</svg>`;
    }

    // ---------------------------------------------------------------- perps accounts (leaderboard rows)
    /** A leaderboard row (data/leaderboard.json, all time) → the card's input. */
    const accountInput = (r) => {
      const s = (r.stats && r.stats.all) || {};
      const curve = r.curve && r.curve.length >= 2 ? r.curve : null;
      return {
        kind: 'perps', address: r.account, period: 'All time', pnl: s.pnl || 0, roi: s.roi, curve,
        periodRange: curve ? range(curve[0][0] * 1000, curve[curve.length - 1][0] * 1000) : r.createdAt ? 'since ' + date(r.createdAt) : null,
        stats: [['Win rate', r.winRate == null ? '—' : pct(r.winRate, 0)], ['Max drawdown', s.ddPct ? pct(s.ddPct, 1) : '—'], ['Volume', U.fmtUsd(r.volumeAll || s.volume || 0, { compact: true })], ['Positions', U.fmtNum(r.positionsCount || 0, 0)]],
        statsHidden: [['Win rate', r.winRate == null ? '—' : pct(r.winRate, 0)], ['Max drawdown', s.ddPct ? pct(s.ddPct, 1) : '—'], ['Positions', U.fmtNum(r.positionsCount || 0, 0)], ['Style', r.style && r.style !== '—' ? r.style : '—']],
        footRight: r.style && r.style !== '—' ? r.style + ' trader' + (r.createdAt ? ' · since ' + date(r.createdAt) : '') : r.createdAt ? 'On Meridian since ' + date(r.createdAt) : '',
      };
    };
    const accountSvg = (r) => flexSvg(accountInput(r));
    const accountText = (r) => {
      const s = (r.stats && r.stats.all) || {};
      const bits = [s.roi != null ? pct(s.roi, 1, true) + ' ROI' : null, U.fmtUsd(r.volumeAll || 0, { compact: true }) + ' volume', r.winRate != null ? pct(r.winRate, 0) + ' win rate' : null, s.ddPct ? pct(s.ddPct, 1) + ' max drawdown' : null, r.style && r.style !== '—' ? r.style + ' trader' : null].filter(Boolean);
      return { title: `${short(r.account)} on Meridian: ${money(s.pnl || 0, true)} all-time PnL`, description: bits.join(' · ') + '. Live positions, performance, copyability and tax records on MeridianDataHub.' };
    };

    // ---------------------------------------------------------------- Predict wallets
    /** Cumulative result the way the snapshot counts it: decided predictions at their decision time and, on pick
     *  configurations the wallet traded on the secondary market, the token ledger's events instead (sales, sets,
     *  verdicts). Ends at the wallet's PnL. norms: normalised predictions (P.norm / P.unslim). */
    const curveFromPredictions = (norms, trades, addr) => {
      const L = P.ledger(norms, trades || [], addr);
      const ev = [];
      for (const n of norms) {
        if (!n.decided || L.byPrediction[n.id]) continue;
        const mine = (n.predictor === addr ? n.pnl : 0) + (n.counterparty === addr ? -n.pnl : 0);
        if (n.predictor === addr || n.counterparty === addr) ev.push([P.decidedAt(n), mine]);
      }
      for (const e of L.events) ev.push([e.t, e.pnl]);
      if (!ev.length) return null;
      ev.sort((a, b) => a[0] - b[0]);
      const pts = [[Math.floor(ev[0][0] / 1000) - 3600, 0]]; let acc = 0;
      for (const [tt, v] of ev) { acc += v; const s = Math.floor(tt / 1000), y = Math.round(acc * 100) / 100; if (pts[pts.length - 1][0] === s) pts[pts.length - 1][1] = y; else pts.push([s, y]); }   // one point per second: events settled in the same second have no order between them
      return thin(pts, 90);
    };
    // at most max points, evenly spaced, plus the first, the last, the high and the low (evenly spaced samples alone dropped
    // the real peak the card tags)
    const thin = (pts, max) => { if (pts.length <= max) return pts; let hi = 0, lo = 0; pts.forEach((p, i) => { if (p[1] > pts[hi][1]) hi = i; if (p[1] < pts[lo][1]) lo = i; }); const keep = new Set([0, pts.length - 1, hi, lo]); const step = (pts.length - 1) / (max - 3); for (let f = 0; f < pts.length - 1; f += step) keep.add(Math.round(f)); return Array.from(keep).sort((a, b) => a - b).map((i) => pts[i]); };
    /** The same from a wallet's snapshot file. A truncated file holds only its newest predictions (and older traded
     *  ones), so its curve is the one the snapshot built from every prediction (file.curve); null in a file built before. */
    const walletCurve = (file, addr) => (!file || !Array.isArray(file.predictions) ? null : file.truncated ? (Array.isArray(file.curve) && file.curve.length >= 2 ? file.curve : null) : curveFromPredictions(file.predictions.map(P.unslim), file.trades, addr));
    /** A wallet's card input from its snapshot row; isMaker: the row is a counterparty's, a market maker from
     *  P.MAKER_MIN predictions (fewer: a one-off counterparty, as on the Market makers page). */
    const walletInput = (row, curve, isMaker) => {
      const record = `${U.fmtNum(row.won || 0, 0)}W / ${U.fmtNum(row.lost || 0, 0)}L`;
      const n = U.fmtNum(row.n || 0, 0);
      const mm = isMaker && P.isMarketMaker(row.n || 0);
      return {
        kind: isMaker ? (mm ? 'maker' : 'counterparty') : 'bettor', address: row.address, period: 'All time', pnl: row.pnl || 0, roi: row.roi, curve,
        periodRange: curve ? range(curve[0][0] * 1000, curve[curve.length - 1][0] * 1000) : row.first ? 'since ' + date(row.first) : null,
        stats: isMaker
          ? [['Win rate', pct(row.winRate, 0)], ['Record', record], ['Committed', U.fmtUsd(row.wagered || 0, { compact: true })], ['Taken', n]]
          : [['Win rate', pct(row.winRate, 0)], ['Record', record], ['Wagered', U.fmtUsd(row.wagered || 0, { compact: true })], ['Avg odds', row.avgOdds == null ? '—' : pct(row.avgOdds * 100, 0)]],
        statsHidden: isMaker
          ? [['Win rate', pct(row.winRate, 0)], ['Record', record], ['Taken', n], ['Open', U.fmtNum(row.open || 0, 0)]]
          : [['Win rate', pct(row.winRate, 0)], ['Record', record], ['Predictions', n], ['Avg odds', row.avgOdds == null ? '—' : pct(row.avgOdds * 100, 0)]],
        // the top category is the one with the most predictions, often a plurality: not "mostly"
        footRight: isMaker ? (mm ? 'Market maker' : 'One-off counterparty') + (row.first ? ' since ' + date(row.first) : '') : (row.topCat ? 'Top category ' + row.topCat : 'Meridian Predict') + (row.first ? ' · since ' + date(row.first) : ''),
      };
    };
    const walletSvg = (row, file, isMaker) => {
      const c = walletCurve(file, row.address); const inp = walletInput(row, c, isMaker);
      if (!c && file && file.truncated) inp.noCurveText = 'Curve not drawn: over 600 predictions';   // a file built before the snapshot wrote its curve
      return flexSvg(inp);
    };
    const walletText = (row, isMaker) => {
      const bits = [`${U.fmtNum(row.n || 0, 0)} prediction${row.n === 1 ? '' : 's'}${isMaker ? ' taken' : ''}`, `${U.fmtNum(row.won || 0, 0)}W / ${U.fmtNum(row.lost || 0, 0)}L`, row.roi != null ? pct(row.roi, 1, true) + ' ROI' : null, U.fmtUsd(row.wagered || 0, { compact: true }) + (isMaker ? ' committed' : ' wagered'), !isMaker && row.topCat ? 'top category ' + row.topCat : null].filter(Boolean);
      return { title: `${short(row.address)} on Meridian Predict: ${money(row.pnl || 0, true)} ${isMaker ? (P.isMarketMaker(row.n || 0) ? 'maker PnL' : 'counterparty PnL') : 'net'}`, description: bits.join(' · ') + '. Every prediction, its legs and how each resolved, on MeridianDataHub.' };
    };

    // ---------------------------------------------------------------- the site card (home and every other page)
    const siteSvg = ({ lb, pr }) => {
      const rows = (lb && lb.rows) || []; const T = pr && pr.agg && pr.agg.totals;
      const perpsVol = rows.reduce((a, r) => a + (Number(r.volumeAll) || 0), 0);
      const fig = (i, k, v) => label(64 + i * 268, 470, k) + t(64 + i * 268, 512, v, 34, { mono: true, w: 600 });
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <radialGradient id="glow" cx="0.8" cy="0.15" r="0.75"><stop offset="0" stop-color="${C.accent}" stop-opacity="0.24"/><stop offset="0.5" stop-color="${C.accent}" stop-opacity="0.05"/><stop offset="1" stop-color="${C.accent}" stop-opacity="0"/></radialGradient>
  <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#ffffff" stroke-opacity="0.05" stroke-width="1"/></pattern>
  <radialGradient id="gridFade" cx="0.75" cy="0.3" r="0.8"><stop offset="0" stop-color="#ffffff" stop-opacity="1"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
  <mask id="gridMask"><rect width="${W}" height="${H}" fill="url(#gridFade)"/></mask>
</defs>
<rect width="${W}" height="${H}" fill="${C.bg}"/>
<rect width="${W}" height="${H}" fill="url(#grid)" mask="url(#gridMask)"/>
<rect width="${W}" height="${H}" fill="url(#glow)"/>
<g transform="translate(64 46) scale(0.28)"><path fill="${C.text}" fill-rule="evenodd" d="${LOGO}"/></g>
<text x="64" y="220" font-family="${SANS}" font-weight="700" font-size="88" letter-spacing="-2" fill="${C.text}">Meridian<tspan fill="${C.accent}">DataHub</tspan></text>
${t(64, 278, 'Perps, Predict and copy-trading analytics for Meridian', 30, { fill: C.text2 })}
${t(64, 318, 'on Robinhood Chain: every account, every prediction.', 30, { fill: C.text2 })}
${fig(0, 'Perps accounts', U.fmtNum(rows.length, 0))}${fig(1, 'Perps volume', U.fmtUsd(perpsVol, { compact: true }))}${fig(2, 'Predict bettors', T ? U.fmtNum(T.bettors, 0) : '—')}${fig(3, 'Predict wagered', T ? U.fmtUsd(T.wagered, { compact: true }) : '—')}
<line x1="64" y1="578" x2="${W - 64}" y2="578" stroke="#ffffff" stroke-opacity="0.07" stroke-width="1.5"/>
${t(64, 610, site.replace(/^https?:\/\//, ''), 19, { w: 600, fill: C.accent })}
${t(W - 64, 610, 'Leaderboard · dashboard · copy trading · tax center', 17, { anchor: 'end', fill: C.text3 })}
</svg>`;
    };

    // ---------------------------------------------------------------- one Predict slip
    /** Characters of proportional text (Geist) that fit a width: about 0.49 em a character, 0.52 in semibold. */
    const fits = (maxW, size, bold) => Math.max(4, Math.floor(maxW / (size * (bold ? 0.52 : 0.49))));
    const clip = (s, maxW, size, bold) => { s = String(s || ''); const n = fits(maxW, size, bold); return s.length <= n ? s : s.slice(0, Math.max(1, n - 1)).replace(/\s+\S*$/, '') + '…'; };
    /** Text broken into at most maxLines lines at word boundaries, the last one clipped. */
    const wrapText = (s, maxW, size, bold, maxLines) => {
      const n = fits(maxW, size, bold); const lines = []; let cur = '';
      for (const w of String(s || '').split(/\s+/).filter(Boolean)) { const next = cur ? cur + ' ' + w : w; if (next.length <= n || !cur) cur = next; else { lines.push(cur); cur = w; } }
      if (cur) lines.push(cur);
      if (lines.length > maxLines) { const keep = lines.slice(0, maxLines); keep[maxLines - 1] = clip(keep[maxLines - 1] + ' ' + lines.slice(maxLines).join(' ') + ' …', maxW, size, bold); return keep; }
      return lines.map((l) => clip(l, maxW, size, bold));
    };
    /** Money on a slip: whole dollars from $100 up (cents there are noise), cents below. */
    const cash = (v, sign) => { const n = Number(v) || 0; return Math.abs(n) >= 1e5 ? U.fmtUsd(n, { compact: true, sign }) : Math.abs(n) >= 100 ? U.fmtUsd(n, { dp: 0, sign }) : U.fmtUsd(n, { sign }); };
    /** Where one leg stands for the bettor, from the record alone (no live data: the image stays byte-identical until the
     *  prediction changes): won / lost / void (a 50/50 is a loss on Meridian) once Meridian has settled the question, every
     *  leg of a won prediction won, otherwise open. A won prediction's leg Meridian has not settled (0x73f05a88…, a $1
     *  test paid while its question runs to December) was paid as won, with no result of its own. */
    const legState = (k, n) => (n.won ? (k.settled || n.partial ? 'won' : 'paid as won') : k.settled && (k.nonDecisive || k.resolvedToYes === true || k.resolvedToYes === false) ? (k.nonDecisive ? 'void' : k.resolvedToYes === !!k.yes ? 'won' : 'lost') : 'open');
    const slipState = (n) => (n.decided ? (n.won ? 'won' : n.nd ? 'void' : 'lost') : 'open');
    /** Does the site still offer to copy the slip: undecided and no leg past the end time Meridian lists (no betting
     *  cutoff: Meridian has taken bets after it). (The one thing on a card that changes with time alone: the image
     *  changes once, when the first leg passes it.) */
    const slipCopyable = (n, now = Date.now()) => !n.decided && !n.picks.some((k) => k.endTime && k.endTime <= now);
    /** Whether the deploy makes a slip's card and share page (scripts/build-cards.mjs): what people share, which is a slip
     *  still open, one decided in the last week, a win of the last 30 days or a big win (P.BIG_WIN is net PnL, a bettor's
     *  token sale included, as on the Overview). */
    const slipCardWanted = (n, now = Date.now()) => {
      if (!n.decided) return true;
      const age = now - (P.decidedAt(n) || 0), DAY = 864e5;
      return age < 7 * DAY || (!!n.won && (age < 30 * DAY || (Number(n.tradedPnl != null ? n.tradedPnl : n.pnl) || 0) > P.BIG_WIN));
    };
    // a bettor who traded its position tokens: the card shows its own result (as the slip page does), not payout − stake;
    // note('sold' | 'has sold') says what it did with them (a bettor that only bought more of its own side sold none)
    const ownOf = (n) => {
      const own = n.decided && n.tradedPnl != null ? Number(n.tradedPnl) : null;
      const held = n.held != null ? n.held : 1; const all = held < 1e-6, part = !all && held < 0.999;
      const note = (verb) => (all ? `the bettor ${verb} its tokens` : part ? `the bettor ${verb} ${U.fmtPct((1 - held) * 100, { dp: 0 })} of its tokens` : own != null ? 'the bettor traded position tokens on these picks' : '');
      return { own, held, all, part, note };
    };
    /** A Predict slip (a full record, P.full): the result or what it can win, and every leg with where it stands.
     *  o: { fontCss (the browser), now (the time it is judged at: can it still be copied?) } */
    function slipSvg(n, o = {}) {
      const st = slipState(n);
      const col = st === 'won' ? C.green : st === 'lost' ? C.red : st === 'void' ? '#f5b64a' : C.accent;
      const combo = n.legs > 1 ? `${n.legs}-leg combo` : 'Single';
      const x = mult(n.multiple);
      const { own, held, all, part, note } = ownOf(n);
      const hero = st === 'open' ? cash(n.pool) : own != null ? cash(own, true) : st === 'won' ? cash(n.pnl, true) : st === 'lost' ? cash(-n.stake, true) : cash(0);
      // a self-match (one wallet on both sides) moves no money: shown as the bettor side only, and said so
      const self = P.selfMatch(n);
      const heroLabel = (st === 'won' ? 'Won' : st === 'lost' ? 'Lost' : st === 'void' ? 'Void' : 'Pays') + (self ? ' · bettor side' : own != null ? ' · bettor PnL incl. token ' + (all || part ? 'sale' : 'trades') : '');
      // a sold-out winner's payout went to whoever bought its tokens; a loser's tokens paid nothing to anyone
      const sub = (st === 'won' ? `${cash(n.pool)} paid on a ${cash(n.stake)} stake` + (all ? ' to the token buyer' : part ? ' · ' + note('sold') : '')
        : st === 'lost' ? `${cash(n.stake)} stake · would have paid ${cash(n.pool)}` + (own != null ? ' · ' + note('sold') : '')
          : st === 'void' ? 'Stake returned' : `on a ${cash(n.stake)} stake, if ${n.legs > 1 ? 'every leg wins' : 'it wins'}` + (held < 0.999 ? ' · ' + note('has sold') : '')) + (self ? ' · self-matched: one wallet on both sides' : '');
      const subLines = wrapText(sub, 520, 22, false, 2);   // up to two lines under the hero, clear of the legs panel
      const heroSize = fit(hero, 460, 104, 44);
      const heroY = 250 + heroSize;
      // copyable decides the pill: past a leg's listed end the slip is not offered any more, but it is not decided either
      const closes = Math.min(...n.picks.map((k) => k.endTime || Infinity)), copyable = slipCopyable(n, o.now);
      const pill = st === 'won' ? 'Won · ' + combo : st === 'lost' ? 'Lost · ' + combo : st === 'void' ? 'Void' : (copyable ? 'Live · ' : 'Awaiting result · ') + combo;
      const pw = pill.length * 10.2 + 44;
      // locked odds below 1 never read 100% (as the resolution tracker's prices); Meridian's end time is a listed end,
      // not a betting cutoff (it has taken bets after it)
      const odds = n.odds == null ? '—' : n.odds > 0.99 && n.odds < 1 ? (Math.floor(n.odds * 1000 + 1e-6) / 10).toFixed(1) + '%' : pct(n.odds * 100, n.odds < 0.1 ? 1 : 0);
      const stats = [['Stake', cash(n.stake)], ['Multiplier', x], ['Odds', odds], n.decided ? ['Settled', dateShort(P.decidedAt(n)) || '—'] : ['Listed end', Number.isFinite(closes) ? dateShort(closes) : '—']];
      const cell = (i) => { const [k, v] = stats[i]; const cx = 64 + i * 122; return label(cx, 496, k) + t(cx, 530, v, fit(v, 112, 26, 16), { mono: true, w: 600 }); };
      // the legs, right: side, question (wrapped: up to four lines for a single, fewer as the legs add up), and a mark
      // for where each stands; up to five legs, the rest counted
      const box = { x: 596, y: 118, w: 540, h: 404 };
      const show = n.picks.slice(0, n.picks.length > 5 ? 4 : 5), more = n.picks.length - show.length;
      // a single gets a large question in the middle of the panel; a pair a little larger than a list
      const fs = show.length === 1 ? 28 : show.length === 2 ? 22 : 19, lh = Math.round(fs * 1.27), meta = show.length === 1 ? 17 : 14, mh = meta + 6;
      const qW = box.w - 92 - 70, avail = box.h - 58 - (more ? 30 : 0);
      let lines, maxL = show.length === 1 ? 6 : 4;
      const used = () => U.sum(lines, (l) => l.length * lh + mh);
      for (;;) { lines = show.map((k) => wrapText(k.q, qW, fs, true, maxL)); if (used() + show.length * 20 <= avail || maxL === 1) break; maxL--; }
      const pad = Math.max(8, Math.min(show.length === 1 ? 24 : 16, (avail - used()) / (2 * Math.max(1, show.length))));
      const block = used() + pad * 2 * show.length;
      const tops = []; let yy = box.y + 50 + (show.length <= 2 ? Math.max(0, (avail - block) / 2) : 0);
      for (const l of lines) { tops.push(yy); yy += pad * 2 + l.length * lh + mh; }
      const mark = (s, cx, cy) => (s === 'won' ? `<circle cx="${cx}" cy="${cy}" r="14" fill="${C.green}" fill-opacity="0.16"/><path d="M${cx - 6} ${cy} L${cx - 1.5} ${cy + 5} L${cx + 7} ${cy - 5.5}" fill="none" stroke="${C.green}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`
        : s === 'lost' ? `<circle cx="${cx}" cy="${cy}" r="14" fill="${C.red}" fill-opacity="0.16"/><path d="M${cx - 5} ${cy - 5} L${cx + 5} ${cy + 5} M${cx + 5} ${cy - 5} L${cx - 5} ${cy + 5}" stroke="${C.red}" stroke-width="3" stroke-linecap="round"/>`
        : s === 'void' ? `<circle cx="${cx}" cy="${cy}" r="14" fill="#f5b64a" fill-opacity="0.16"/><path d="M${cx - 6} ${cy} L${cx + 6} ${cy}" stroke="#f5b64a" stroke-width="3" stroke-linecap="round"/>`
        : `<circle cx="${cx}" cy="${cy}" r="14" fill="none" stroke="${C.accent}" stroke-opacity="0.55" stroke-width="2"/><circle cx="${cx}" cy="${cy}" r="4.5" fill="${C.accent}"/>`);
      const legRow = (k, i) => {
        const y = tops[i], ls = lines[i], h = pad * 2 + ls.length * lh + mh, mid = y + h / 2;
        const side = k.yes ? 'YES' : 'NO', sc = k.yes ? C.green : C.red;
        const s = legState(k, n);
        const chance = s === 'open' && k.fairAtBet != null ? pct(k.fairAtBet * 100, 0) + ' at bet' : s === 'open' ? 'open' : s === 'void' ? '50/50 · a loss' : s;   // 'paid as won' says itself
        const q0 = y + pad + Math.round(fs * 0.95);   // the first line's baseline
        return (i ? `<line x1="${box.x + 24}" y1="${f1(y)}" x2="${box.x + box.w - 24}" y2="${f1(y)}" stroke="#ffffff" stroke-opacity="0.06" stroke-width="1"/>` : '')
          + `<rect x="${box.x + 24}" y="${f1(mid - 14)}" width="${side === 'YES' ? 52 : 44}" height="28" rx="7" fill="${sc}" fill-opacity="0.14"/>`
          + t(box.x + 24 + (side === 'YES' ? 26 : 22), mid + 6, side, 15, { anchor: 'middle', w: 700, fill: sc, ls: 0.8 })
          + ls.map((l, j) => t(box.x + 92, q0 + j * lh, l, fs, { w: 600 })).join('')
          + t(box.x + 92, q0 + (ls.length - 1) * lh + meta + (show.length === 1 ? 14 : 8), chance + (k.cat ? ' · ' + k.cat : ''), meta, { fill: C.text3 })
          + mark(s === 'paid as won' ? 'won' : s, box.x + box.w - 38, mid);
      };
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
${o.fontCss ? `<style>${o.fontCss}</style>` : ''}
  <radialGradient id="glow" cx="0.2" cy="0.55" r="0.6"><stop offset="0" stop-color="${col}" stop-opacity="0.2"/><stop offset="0.55" stop-color="${col}" stop-opacity="0.05"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></radialGradient>
  <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#ffffff" stroke-opacity="0.05" stroke-width="1"/></pattern>
  <radialGradient id="gridFade" cx="0.3" cy="0.45" r="0.75"><stop offset="0" stop-color="#ffffff" stop-opacity="1"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
  <mask id="gridMask"><rect width="${W}" height="${H}" fill="url(#gridFade)"/></mask>
</defs>
<rect width="${W}" height="${H}" fill="${C.bg}"/>
<rect width="${W}" height="${H}" fill="url(#grid)" mask="url(#gridMask)"/>
<rect width="${W}" height="${H}" fill="url(#glow)"/>
<g transform="translate(64 46) scale(0.28)"><path fill="${C.text}" fill-rule="evenodd" d="${LOGO}"/></g>
<text x="116" y="70" font-family="${SANS}" font-weight="700" font-size="26" fill="${C.text}">Meridian<tspan fill="${C.accent}">DataHub</tspan></text>
<rect x="${f1(W - 64 - pw)}" y="42" width="${f1(pw)}" height="38" rx="19" fill="${col}" fill-opacity="0.12" stroke="${col}" stroke-opacity="0.55" stroke-width="1.5"/>
${t(W - 64 - pw / 2, 67, pill, 16, { anchor: 'middle', w: 600, fill: col })}
${label(64, 150, 'Predict slip · Meridian', { fill: C.text2 })}
${t(64, 188, 'by ' + short(n.predictor), 28, { mono: true, w: 600, fill: C.text2 })}
${label(64, 248, heroLabel)}
${t(60, heroY, hero, heroSize, { mono: true, w: 700, fill: st === 'open' ? C.text : own != null ? (own > 0.005 ? C.green : own < -0.005 ? C.red : C.text) : col })}
${subLines.map((l, j) => t(64, heroY + 44 + j * 28, l, 22, { fill: C.text2, w: 500 })).join('')}
${[0, 1, 2, 3].map(cell).join('\n')}
<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="22" fill="${C.panel}" fill-opacity="0.72" stroke="#ffffff" stroke-opacity="0.08" stroke-width="1.5"/>
${label(box.x + 24, box.y + 34, n.legs > 1 ? n.legs + ' legs' : '1 leg')}
${t(box.x + box.w - 24, box.y + 34, n.legs > 1 ? 'every leg must win' : '', 14, { anchor: 'end', fill: C.text3 })}
${show.map(legRow).join('\n')}
${more ? t(box.x + 92, yy + 24, '+ ' + more + ' more leg' + (more > 1 ? 's' : ''), 17, { fill: C.text3, w: 600 }) : ''}
<line x1="64" y1="578" x2="${W - 64}" y2="578" stroke="#ffffff" stroke-opacity="0.07" stroke-width="1.5"/>
${t(64, 610, site.replace(/^https?:\/\//, ''), 19, { w: 600, fill: C.accent })}
${t(W - 64, 610, copyable ? 'Copy this slip on MeridianDataHub' : 'Meridian Predict · placed ' + (date(n.t) || ''), 17, { anchor: 'end', fill: C.text3 })}
</svg>`;
    }
    /** The link preview's title and description for a slip. A bettor who traded its tokens gets its own result, as on
     *  the card; an open slip "pays" its payout (the dialog's "To win" is the profit, so "to win" is not used here). */
    const slipText = (n, now) => {
      const st = slipState(n), copyable = slipCopyable(n, now); const combo = n.legs > 1 ? `${n.legs}-leg combo` : 'single';
      const { own, note } = ownOf(n);
      const legs = n.picks.slice(0, 4).map((k) => (k.yes ? 'YES ' : 'NO ') + k.q).join(' · ') + (n.picks.length > 4 ? ` · +${n.picks.length - 4} more` : '');
      const title = P.selfMatch(n) ? `A ${mult(n.multiple)} ${combo} on Meridian Predict, self-matched (one wallet on both sides)`
        : st === 'won' ? (own != null ? `${cash(n.stake)} ${combo} (${mult(n.multiple)}) won; ${note('sold')}: bettor PnL ${cash(own, true)}` : `Won ${cash(n.pnl, true)} on a ${cash(n.stake)} ${combo} (${mult(n.multiple)})`)
        : st === 'lost' ? `${cash(n.stake)} ${combo} at ${mult(n.multiple)}: lost` + (own != null ? `; ${note('sold')}: bettor PnL ${cash(own, true)}` : '')
          : st === 'void' ? `${cash(n.stake)} ${combo}: void`
            : `${cash(n.stake)} ${combo} at ${mult(n.multiple)}: pays ${cash(n.pool)} if ${n.legs > 1 ? 'every leg wins' : 'it wins'}`;
      // a question ending in "?" takes no full stop after it
      return { title: P.selfMatch(n) ? title : title + ' · Meridian Predict', description: legs + (/[?.!…]$/.test(legs) ? ' ' : '. ') + 'Placed ' + (date(n.t) || '') + ' by ' + short(n.predictor) + (copyable ? '. Copy it on MeridianDataHub.' : '.') };
    };
    // a near-certain slip keeps the digits that show it pays more than its stake (1.000076 reads 1.0001×, not 1.00×)
    const mult = (m) => (m == null || !Number.isFinite(m) ? '—' : U.fmtNum(m, m < 1.01 ? 4 : m >= 100 ? 0 : 2) + '×');

    // ---------------------------------------------------------------- the page behind a share link
    /** kind 'a' (perps account: address), 'p' (Predict wallet: address) or 's' (Predict slip: id, a prediction id);
     *  target = the site route people are sent to. People are sent on by a script, which unfurlers ignore; the page
     *  carries no inline script or style, since the site's Content-Security-Policy (_headers) allows only index.html's one
     *  inline script, and its look comes from the site's stylesheet. */
    const sharePage = ({ kind, address, id, title, description, image, target }) => {
      const key = kind === 's' ? id : address;
      if (kind === 's' ? !/^0x[0-9a-f]{64}$/.test(String(id || '')) : !isAddr(address)) throw new Error('bad ' + (kind === 's' ? 'id ' : 'address ') + key);
      const url = `${site}/${kind}/${key}`; const img = `${site}/${image}`;
      return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · MeridianDataHub</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="${kind === 's' ? 'article' : 'profile'}">
<meta property="og:site_name" content="MeridianDataHub">
<meta property="og:url" content="${esc(url)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="${W}">
<meta property="og:image:height" content="${H}">
<meta property="og:image:alt" content="${esc(title)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(img)}">
<meta name="twitter:image:alt" content="${esc(title)}">
<meta name="theme-color" content="#23d4bc">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/css/app.css">
<script src="/js/share.js" defer></script>
</head>
<body class="share"><p>Opening <a id="go" href="${esc(target)}">${esc(title)}</a>…</p></body>
</html>
`;
    };

    return { flexSvg, accountInput, accountSvg, accountText, walletInput, walletSvg, walletText, walletCurve, curveFromPredictions, siteSvg, slipSvg, slipText, slipState, slipCardWanted, sharePage, money, short, range, date };
  }

  MD.cards = { W, H, SITE, esc, make };
})();
