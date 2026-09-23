/**
 * Link-preview cards: the SVG artwork (1200 × 630, rendered to PNG by scripts/build-cards.mjs) and the small HTML page
 * behind each share link (/a/<address> for a perps account, /p/<address> for a Predict wallet). Link unfurlers (Discord,
 * X, Telegram, Slack…) never see the part of a URL after "#", which is where the site's routes live, so a share link
 * needs a real path whose HTML carries the Open Graph tags; people who open it are sent on to the page itself.
 * Pure functions (no file or network access) so tests can check them; `U` / `P` are the site's util and Predict modules.
 */
export const W = 1200, H = 630;
export const SITE = 'https://meridian.thedatahub.xyz';
const C = { bg: '#09090a', panel: '#131314', line: '#232324', text: '#ececee', text2: '#a1a1a8', text3: '#6b6b72', accent: '#23d4bc', green: '#34d487', red: '#ef454a' };
const SANS = 'Geist', MONO = 'Geist Mono';
// the Meridian symbol (assets/meridian-symbol.svg, 144 × 95)
const LOGO = 'M106.723 12.8039C106.646 5.17209 103.931 1.71922 98.4607 0.417789C91.1338 -1.32539 80.4935 2.32385 69.9679 12.5422C69.8907 4.91032 67.1756 1.71922 61.7056 0.417789C54.0401 -1.40595 42.7463 4.89516 31.7531 16.0181C40.114 8.76949 48.4173 4.93543 54.4042 6.35984C65.6087 9.02558 60.9511 29.6562 48.3263 51.7468C35.7015 73.8375 19.4652 87.2979 8.26074 84.6322C2.27382 83.2078 0.241401 78.5384 1.17537 69.5229C-1.65487 82.5879 0.595376 92.1113 8.26074 93.9349C15.5879 95.6782 26.2306 89.9998 36.7568 79.7806C36.8337 87.412 39.5462 92.6336 45.0158 93.9349C52.343 95.6782 62.9857 89.9998 73.5118 79.7806C73.5888 87.412 76.3012 92.6336 81.7709 93.9349C94.2409 96.9018 116.314 78.3724 131.072 52.5483C145.831 26.7243 147.686 3.38462 135.216 0.417789C127.889 -1.32539 117.249 2.58563 106.723 12.8039ZM94.3172 52.5483C102.541 38.1579 106.759 24.5389 106.723 14.7869C114.583 8.34077 122.276 5.01838 127.914 6.35984C139.119 9.02558 134.461 29.6562 121.836 51.7468C109.212 73.8375 92.9754 87.2979 81.7709 84.6322C78.1587 83.7728 75.9861 81.7321 75.0359 78.2683C81.903 71.307 88.6495 62.4656 94.3172 52.5483ZM69.9679 14.7868C70.0035 24.5389 65.7862 38.1579 57.5621 52.5483C51.8944 62.4656 45.1479 71.307 38.2809 78.2683C39.231 81.7321 41.4036 83.7728 45.0158 84.6322C56.2203 87.2979 72.4566 73.8375 85.0814 51.7468C97.7062 29.6562 102.364 9.02558 91.1593 6.35984C85.5203 5.01838 77.8277 8.34077 69.9679 14.7868Z';

export const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const isAddr = (a) => /^0x[0-9a-f]{40}$/.test(String(a || ''));

export function makeCards({ U, P, site = SITE }) {
  const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
  /** Money for a headline or a stat: cents below $100K, compact above ("$1.43M"), a sign where asked. */
  const money = (v, sign) => {
    const n = Number(v) || 0;
    return Math.abs(n) >= 1e5 ? U.fmtUsd(n, { compact: true, sign }) : U.fmtUsd(n, { sign });
  };
  const pct = (v, dp = 1, sign = false) => (v == null || !Number.isFinite(v) ? '—' : U.fmtPct(v, { dp, sign }));
  const tone = (v) => (v > 0.004 ? C.green : v < -0.004 ? C.red : C.text);
  const date = (t) => (t ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : null);
  /** A mono headline sized to fit its box (Geist Mono advances 0.6 em; 0.62 leaves room for the bold weight). */
  const fit = (text, maxW, maxSize) => Math.max(24, Math.min(maxSize, Math.floor(maxW / (String(text).length * 0.62))));

  // ------------------------------------------------------------------ pieces
  // one glow, top right: a smooth gradient is most of a PNG's bytes (a second, blue one made every card a quarter bigger)
  const frame = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <radialGradient id="glowA" cx="0.82" cy="0.12" r="0.75"><stop offset="0" stop-color="${C.accent}" stop-opacity="0.26"/><stop offset="0.5" stop-color="${C.accent}" stop-opacity="0.05"/><stop offset="1" stop-color="${C.accent}" stop-opacity="0"/></radialGradient>
</defs>
<rect width="${W}" height="${H}" fill="${C.bg}"/>
<rect width="${W}" height="${H}" fill="url(#glowA)"/>
${inner}
</svg>`;
  const header = (kind) => {
    const kw = kind.length * 10.4 + 36;
    return `<g transform="translate(64 44) scale(0.3)"><path fill="${C.text}" fill-rule="evenodd" d="${LOGO}"/></g>
<text x="118" y="70" font-family="${SANS}" font-weight="700" font-size="28" fill="${C.text}">Meridian<tspan fill="${C.accent}">DataHub</tspan></text>
<rect x="${W - 64 - kw}" y="42" width="${kw}" height="38" rx="19" fill="none" stroke="${C.accent}" stroke-opacity="0.55" stroke-width="1.5"/>
<text x="${W - 64 - kw / 2}" y="67" text-anchor="middle" font-family="${SANS}" font-weight="600" font-size="16" letter-spacing="1.6" fill="${C.accent}">${esc(kind)}</text>`;
  };
  const footer = (right) => `<line x1="64" y1="566" x2="${W - 64}" y2="566" stroke="${C.line}" stroke-width="1.5"/>
<text x="64" y="602" font-family="${SANS}" font-weight="600" font-size="20" fill="${C.accent}">${esc(site.replace(/^https?:\/\//, ''))}</text>
<text x="${W - 64}" y="602" text-anchor="end" font-family="${SANS}" font-size="18" fill="${C.text3}">${esc(right || '')}</text>`;
  /** Label over a big figure. */
  const figure = (x, y, label, value, color, size, anchor = 'start') => `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${SANS}" font-weight="600" font-size="17" letter-spacing="1.4" fill="${C.text3}">${esc(label.toUpperCase())}</text>
<text x="${x}" y="${y + size + 10}" text-anchor="${anchor}" font-family="${MONO}" font-weight="600" font-size="${size}" fill="${color}">${esc(value)}</text>`;
  /** The row of four small figures above the footer. */
  const statRow = (items) => {
    const colW = (W - 128) / items.length;
    return items.map(([k, v, color], i) => {
      const x = 64 + i * colW;
      const size = fit(v, colW - 40, 34);
      return (i ? `<line x1="${x - 12}" y1="448" x2="${x - 12}" y2="528" stroke="${C.line}" stroke-width="1.5"/>` : '') + figure(x + (i ? 12 : 0), 462, k, v, color || C.text, size);
    }).join('\n');
  };
  /** Cumulative PnL as an area chart in a box; points [[t, v], …]. */
  const chart = (pts, box) => {
    if (!pts || pts.length < 2) return '';
    const { x, y, w, h } = box;
    const t0 = pts[0][0], t1 = pts[pts.length - 1][0]; const vs = pts.map((p) => p[1]);
    let lo = Math.min(0, ...vs), hi = Math.max(0, ...vs); if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    const X = (t) => x + (t1 > t0 ? ((t - t0) / (t1 - t0)) * w : w / 2), Y = (v) => y + h - ((v - lo) / (hi - lo)) * h;
    const line = pts.map((p, i) => (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1)).join(' ');
    const zero = Y(0); const last = vs[vs.length - 1]; const col = last >= 0 ? C.green : C.red;
    const area = line + ` L${X(t1).toFixed(1)} ${zero.toFixed(1)} L${X(t0).toFixed(1)} ${zero.toFixed(1)} Z`;
    const id = 'fill' + (last >= 0 ? 'G' : 'R');
    return `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity="0.32"/><stop offset="1" stop-color="${col}" stop-opacity="0.02"/></linearGradient></defs>
<rect x="${x - 20}" y="${y - 20}" width="${w + 40}" height="${h + 40}" rx="18" fill="${C.panel}" fill-opacity="0.72" stroke="${C.line}" stroke-width="1.5"/>
<line x1="${x}" y1="${zero.toFixed(1)}" x2="${x + w}" y2="${zero.toFixed(1)}" stroke="${C.text3}" stroke-opacity="0.6" stroke-width="1.5" stroke-dasharray="6 6"/>
<path d="${area}" fill="url(#${id})"/>
<path d="${line}" fill="none" stroke="${col}" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"/>
<circle cx="${X(t1).toFixed(1)}" cy="${Y(last).toFixed(1)}" r="6" fill="${col}"/>`;
  };
  /** Right-hand panel when there is no curve: a few more figures. */
  const sidePanel = (items, box) => {
    const { x, y, w, h } = box; const rowH = h / items.length;
    return `<rect x="${x - 20}" y="${y - 20}" width="${w + 40}" height="${h + 40}" rx="18" fill="${C.panel}" fill-opacity="0.72" stroke="${C.line}" stroke-width="1.5"/>` +
      items.map(([k, v], i) => `<text x="${x}" y="${y + i * rowH + rowH / 2 + 8}" font-family="${SANS}" font-size="22" fill="${C.text2}">${esc(k)}</text>
<text x="${x + w}" y="${y + i * rowH + rowH / 2 + 10}" text-anchor="end" font-family="${MONO}" font-weight="600" font-size="30" fill="${C.text}">${esc(v)}</text>`).join('\n');
  };
  const CHART = { x: 660, y: 170, w: 476, h: 200 };
  const identity = (addr, sub) => `<text x="64" y="176" font-family="${MONO}" font-weight="600" font-size="46" fill="${C.text}">${esc(short(addr))}</text>
<text x="64" y="214" font-family="${SANS}" font-size="21" fill="${C.text2}">${esc(sub)}</text>`;
  const headline = (label, value, color, second) => {
    const size = fit(value, 560, 88);
    return figure(64, 272, label, value, color, size) + (second ? `\n<text x="64" y="${272 + size + 58}" font-family="${SANS}" font-weight="600" font-size="26" fill="${second[1]}">${esc(second[0])}</text>` : '');
  };

  // ------------------------------------------------------------------ perps account
  /** A leaderboard row (data/leaderboard.json) → card SVG. */
  const accountSvg = (r) => {
    const s = (r.stats && r.stats.all) || {};
    const since = date(r.createdAt);
    const sub = ['Perps on Meridian', since ? 'since ' + since : null, r.style && r.style !== '—' ? r.style + ' trader' : null].filter(Boolean).join(' · ');
    const roi = s.roi == null ? null : pct(s.roi, Math.abs(s.roi) < 10 ? 1 : 0, true) + ' ROI';
    const right = r.curve && r.curve.length >= 2 ? chart(r.curve, CHART) : sidePanel([['Open positions', String(r.openCount || 0)], ['Closed positions', String(r.closedCount || 0)], ['Liquidated', String(r.liquidated || 0)]], CHART);
    return frame([
      header('PERPS ACCOUNT'), identity(r.account, sub),
      headline('All-time PnL', money(s.pnl || 0, true), tone(s.pnl || 0), roi ? [roi, tone(s.roi)] : null),
      right,
      statRow([['Volume', U.fmtUsd(r.volumeAll || s.volume || 0, { compact: true })], ['Win rate', r.winRate == null ? '—' : pct(r.winRate, 0)], ['Max drawdown', s.ddPct ? pct(s.ddPct, 1) : '—'], ['Equity', money(r.equity || 0)]]),
      footer('Positions, performance and tax records'),
    ].join('\n'));
  };
  const accountText = (r) => {
    const s = (r.stats && r.stats.all) || {};
    const bits = [s.roi != null ? pct(s.roi, 1, true) + ' ROI' : null, U.fmtUsd(r.volumeAll || 0, { compact: true }) + ' volume', r.winRate != null ? pct(r.winRate, 0) + ' win rate' : null, s.ddPct ? pct(s.ddPct, 1) + ' max drawdown' : null, r.style && r.style !== '—' ? r.style + ' trader' : null].filter(Boolean);
    return {
      title: `${short(r.account)} on Meridian: ${money(s.pnl || 0, true)} all-time PnL`,
      description: bits.join(' · ') + '. Live positions, performance, copyability and tax records on MeridianDataHub.',
    };
  };

  // ------------------------------------------------------------------ Predict wallet
  /** Cumulative result from a wallet's snapshot file, the way the snapshot counts it: decided predictions at their
   *  decision time, and on pick configurations it traded on the secondary market the token ledger's events instead
   *  (sales, sets, verdicts). Ends at the aggregate row's PnL. Null when the file holds only the newest predictions. */
  const walletCurve = (file, addr) => {
    if (!file || file.truncated || !Array.isArray(file.predictions)) return null;
    const norms = file.predictions.map(P.unslim);
    const L = P.ledger(norms, file.trades || [], addr);
    const ev = [];
    for (const n of norms) {
      if (!n.decided || L.byPrediction[n.id]) continue;
      const mine = (n.predictor === addr ? n.pnl : 0) + (n.counterparty === addr ? -n.pnl : 0);
      ev.push([P.decidedAt(n), mine]);
    }
    for (const e of L.events) ev.push([e.t, e.pnl]);
    if (!ev.length) return null;
    ev.sort((a, b) => a[0] - b[0]);
    const pts = [[Math.floor(ev[0][0] / 1000) - 3600, 0]]; let acc = 0;
    for (const [t, v] of ev) { acc += v; pts.push([Math.floor(t / 1000), Math.round(acc * 100) / 100]); }
    // thin to about 80 points, keeping the last
    if (pts.length > 80) { const step = (pts.length - 1) / 79; const out = []; for (let f = 0; f < pts.length - 1; f += step) out.push(pts[Math.round(f)]); out.push(pts[pts.length - 1]); return out; }
    return pts;
  };
  /** A bettor or maker row (predict.json agg) and its file → card SVG. */
  const walletSvg = (row, file, isMaker) => {
    const curve = walletCurve(file, row.address);
    const since = date(row.first);
    const sub = [isMaker ? 'Market maker on Meridian Predict' : 'Bettor on Meridian Predict', since ? 'since ' + since : null].filter(Boolean).join(' · ');
    const record = `${U.fmtNum(row.won || 0, 0)}W / ${U.fmtNum(row.lost || 0, 0)}L`;
    const right = curve ? chart(curve, CHART) : sidePanel(isMaker
      ? [['Predictions taken', U.fmtNum(row.n || 0, 0)], ['Open', U.fmtNum(row.open || 0, 0)], ['Unclaimed to collect', money(row.unclaimedPayout || 0)]]
      : [['Predictions', U.fmtNum(row.n || 0, 0)], ['Biggest win', row.biggestWin > 0 ? money(row.biggestWin) : '—'], ['Open', U.fmtNum(row.open || 0, 0)]], CHART);
    const roi = row.roi == null ? null : pct(row.roi, Math.abs(row.roi) < 10 ? 1 : 0, true) + ' ROI';
    return frame([
      header(isMaker ? 'MARKET MAKER' : 'PREDICT BETTOR'), identity(row.address, sub),
      headline(isMaker ? 'Maker PnL' : 'Net PnL', money(row.pnl || 0, true), tone(row.pnl || 0), roi ? [roi, tone(row.roi)] : null),
      right,
      statRow(isMaker
        ? [['Record', record], ['Win rate', pct(row.winRate, 0)], ['Committed', U.fmtUsd(row.wagered || 0, { compact: true })], ['Open exposure', U.fmtUsd(row.openWagered || 0, { compact: true })]]
        : [['Record', record], ['Win rate', pct(row.winRate, 0)], ['Wagered', U.fmtUsd(row.wagered || 0, { compact: true })], ['Avg odds', row.avgOdds == null ? '—' : pct(row.avgOdds * 100, 0)]]),
      footer(isMaker ? 'Flow, exposure and results' : row.topCat ? 'Mostly ' + row.topCat + ' · every prediction and its legs' : 'Every prediction and its legs'),
    ].join('\n'));
  };
  const walletText = (row, isMaker) => {
    const bits = [`${U.fmtNum(row.n || 0, 0)} predictions${isMaker ? ' taken' : ''}`, `${U.fmtNum(row.won || 0, 0)}W / ${U.fmtNum(row.lost || 0, 0)}L`, row.roi != null ? pct(row.roi, 1, true) + ' ROI' : null, U.fmtUsd(row.wagered || 0, { compact: true }) + (isMaker ? ' committed' : ' wagered'), !isMaker && row.topCat ? 'mostly ' + row.topCat : null].filter(Boolean);
    return {
      title: `${short(row.address)} on Meridian Predict: ${money(row.pnl || 0, true)} ${isMaker ? 'maker PnL' : 'net'}`,
      description: bits.join(' · ') + '. Every prediction, its legs and how each resolved, on MeridianDataHub.',
    };
  };

  // ------------------------------------------------------------------ the site card (home and every other page)
  const siteSvg = ({ lb, pr }) => {
    const rows = (lb && lb.rows) || []; const T = pr && pr.agg && pr.agg.totals;
    const perpsVol = rows.reduce((a, r) => a + (Number(r.volumeAll) || 0), 0);
    return frame([
      `<g transform="translate(64 44) scale(0.3)"><path fill="${C.text}" fill-rule="evenodd" d="${LOGO}"/></g>`,
      `<text x="64" y="206" font-family="${SANS}" font-weight="700" font-size="84" letter-spacing="-2" fill="${C.text}">Meridian<tspan fill="${C.accent}">DataHub</tspan></text>`,
      `<text x="64" y="262" font-family="${SANS}" font-size="30" fill="${C.text2}">Perps, Predict and copy-trading analytics for Meridian</text>`,
      `<text x="64" y="302" font-family="${SANS}" font-size="30" fill="${C.text2}">on Robinhood Chain: every account, every prediction.</text>`,
      statRow([['Perps accounts', U.fmtNum(rows.length, 0)], ['Perps volume', U.fmtUsd(perpsVol, { compact: true })], ['Predict bettors', T ? U.fmtNum(T.bettors, 0) : '—'], ['Predict wagered', T ? U.fmtUsd(T.wagered, { compact: true }) : '—']]),
      footer('Leaderboard · dashboard · copy trading · tax center'),
    ].join('\n'));
  };

  // ------------------------------------------------------------------ the page behind a share link
  /** kind 'a' (perps account) or 'p' (Predict wallet); target = the site route people are sent to. */
  const sharePage = ({ kind, address, title, description, image, target }) => {
    if (!isAddr(address)) throw new Error('bad address ' + address);
    const url = `${site}/${kind}/${address}`;
    const img = `${site}/${image}`;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · MeridianDataHub</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="profile">
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
<script>location.replace(${JSON.stringify(target)});</script>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#09090a;color:#a1a1a8;font:15px/1.5 system-ui,sans-serif}a{color:#23d4bc}</style>
</head>
<body><p>Opening <a href="${esc(target)}">${esc(title)}</a>…</p></body>
</html>
`;
  };

  return { accountSvg, accountText, walletSvg, walletText, walletCurve, siteSvg, sharePage, money, short };
}
