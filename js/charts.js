/* MeridianDataHub — Chart.js wrappers with the site theme */
(function () {
  const MD = window.MD; const U = MD.util;
  const C = (MD.charts = {});
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const hexA = (hex, a) => {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})` : hex;
  };
  C.colors = () => ({ accent: css('--accent') || '#23d4bc', green: css('--green') || '#34d487', red: css('--red') || '#ef454a', blue: css('--accent-2') || '#6895ff', amber: css('--amber') || '#f5b64a', text: css('--text-3') || '#6b6b72', grid: '#1c1c1e' });

  if (window.Chart) {
    Chart.defaults.font.family = css('--font') || 'Geist, sans-serif';
    Chart.defaults.font.size = 11;
    Chart.defaults.color = '#6b6b72';
    Chart.defaults.animation = false;
    Chart.defaults.plugins.legend.display = false;
  }

  const xTick = (range) => (v) => {
    if (range <= 2 * U.DAY) return U.fmtHM(v);
    if (range <= 120 * U.DAY) return U.fmtDateShort(v);
    return U.fmtDateShort(v) + ' ’' + String(new Date(v).getFullYear()).slice(2);
  };
  /** Time-axis ticks on round local times: whole hours under two days, then midnights, then month starts. Chart.js's
   *  linear scale steps in round milliseconds, so a "Sep 19" label could sit at 07:12 and a point drawn at midnight
   *  read as the day before. */
  C.timeTicks = (min, max, maxCount = 8) => {
    const span = max - min; if (!(span > 0)) return [];
    const out = []; const fits = (n) => n <= maxCount;
    if (span < 2 * U.DAY) {
      const hs = [1, 2, 3, 6, 12].find((k) => fits(span / (k * 3600000))) || 12;
      const d = new Date(min); d.setMinutes(0, 0, 0); if (d.getTime() < min) d.setHours(d.getHours() + 1);
      while (d.getHours() % hs) d.setHours(d.getHours() + 1);
      for (; d.getTime() <= max; d.setHours(d.getHours() + hs)) out.push(d.getTime());
      return out;
    }
    const ds = [1, 2, 3, 7, 14].find((k) => fits(span / (k * U.DAY)));
    if (ds) {
      const d = new Date(min); d.setHours(0, 0, 0, 0); if (d.getTime() < min) d.setDate(d.getDate() + 1);
      for (; d.getTime() <= max; d.setDate(d.getDate() + ds)) out.push(d.getTime());
      return out;
    }
    const ms = [1, 2, 3, 6, 12].find((k) => fits(span / (k * 30.44 * U.DAY))) || 12;
    const d = new Date(min); d.setHours(0, 0, 0, 0); d.setDate(1); if (d.getTime() < min) d.setMonth(d.getMonth() + 1);
    while (d.getMonth() % ms) d.setMonth(d.getMonth() + 1);
    for (; d.getTime() <= max; d.setMonth(d.getMonth() + ms)) out.push(d.getTime());
    return out;
  };
  /** Money on an axis: whole dollars ("$500", "-$1,500", "$12.5K"); cents only where the steps are that small. */
  C.axisUsd = (v) => U.fmtUsd(v, { compact: true, dp: Math.abs(v) < 10 && v % 1 !== 0 ? 2 : 0 });
  const alignTicks = (axis) => { const t = C.timeTicks(axis.min, axis.max, 8); if (t.length >= 2) axis.ticks = t.map((value) => ({ value })); };

  C.destroy = (canvas) => { if (canvas && canvas.__chart) { try { canvas.__chart.destroy(); } catch (_) {} canvas.__chart = null; } };

  /**
   * line/bar chart of time series. opts: {points:[{x,y}], color, type:'line'|'bar', yFmt, tooltipLabel, zero:true,
   * titleFmt (the tooltip's title from x; a local date and time unless given, U.fmtDayUTC for per-UTC-day buckets)}
   */
  C.timeSeries = function (canvas, opts) {
    if (!window.Chart) return null;
    const col = C.colors();
    const pts = opts.points || [];
    const color = opts.color || col.accent;
    const type = opts.type || 'line';
    const xs = pts.map((p) => p.x);
    const range = xs.length > 1 ? xs[xs.length - 1] - xs[0] : U.DAY;
    const yFmt = opts.yFmt || C.axisUsd;
    // monotone interpolation stays smooth but never overshoots between points (a plain spline through a few daily
    // points drew peaks and dips the data never had); short series show their points so the reader sees where data is
    const dots = (n) => (type === 'line' && n <= 40 ? 2 : 0);
    // signColors: bars of a signed quantity (daily PnL, funding) green above zero and red below, whatever `color` is
    const barBg = opts.signColors ? (c) => hexA(c.raw && c.raw.y < 0 ? col.red : col.green, 0.6) : hexA(color, 0.55);
    const ds = {
      data: pts, borderColor: color, backgroundColor: type === 'bar' ? barBg : hexA(color, 0.12),
      borderWidth: type === 'bar' ? 0 : 2, pointRadius: dots(pts.length), pointBackgroundColor: color, pointBorderWidth: 0, pointHoverRadius: 4, pointHoverBackgroundColor: color, pointHoverBorderColor: '#0e0e0f',
      fill: type === 'line' && opts.fill !== false ? 'origin' : false, cubicInterpolationMode: 'monotone', borderRadius: 2, maxBarThickness: 18, stepped: opts.stepped || false,
    };
    // several lines on one chart: opts.series = [{points, color, label}] (no fill, a legend)
    const datasets = opts.series ? opts.series.map((sr) => Object.assign({}, ds, { data: sr.points, label: sr.label, borderColor: sr.color, pointBackgroundColor: sr.color, pointRadius: dots((sr.points || []).length), backgroundColor: hexA(sr.color, 0.1), fill: false, borderDash: sr.dash || undefined })) : [ds];
    const config = {
      type,
      data: { datasets },
      options: {
        responsive: true, maintainAspectRatio: false, parsing: false, normalized: true,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        scales: {
          // bounds 'data': the axis ends at the data (or xMin / xMax), not at the next round number of milliseconds, which
          // left up to a week of empty chart after the last point; bars get a half-bar margin at each end instead
          x: { type: 'linear', min: opts.xMin, max: opts.xMax, bounds: 'data', offset: type === 'bar', afterBuildTicks: alignTicks, grid: { color: col.grid, drawTicks: false }, border: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0, callback: xTick(range), padding: 8 } },
          y: { position: 'right', grid: { color: (c) => (c.tick.value === 0 && opts.zero !== false ? '#3a3a3d' : col.grid), drawTicks: false }, border: { display: false }, ticks: { maxTicksLimit: 6, callback: (v) => yFmt(v), padding: 8 }, beginAtZero: opts.beginAtZero || false },
        },
        plugins: {
          legend: { display: !!opts.series, position: 'top', align: 'end', labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true, pointStyle: 'circle', padding: 12 } },
          tooltip: {
            backgroundColor: '#1e1e1f', borderColor: '#2a2a2c', borderWidth: 1, titleColor: '#a1a1a8', bodyColor: '#ececee', padding: 10, displayColors: !!opts.series,
            callbacks: {
              title: (items) => (items[0] ? (opts.titleFmt || U.fmtDateTime)(items[0].raw.x) : ''),
              label: (item) => (opts.tooltipLabel ? opts.tooltipLabel(item.raw, item.dataset) : (item.dataset.label || opts.label || '') + ' ' + (opts.tipFmt || U.fmtUsd)(item.raw.y)),
            },
          },
        },
      },
    };
    // a chart that already exists on this canvas is updated in place (auto-refresh every 30 s): no flicker, and a
    // tooltip the reader is hovering survives the refresh
    const existing = canvas.__chart;
    if (existing && existing.config.type === type) { existing.data = config.data; existing.options = config.options; existing.update('none'); return existing; }
    C.destroy(canvas);
    const chart = new Chart(canvas, config);
    canvas.__chart = chart;
    return chart;
  };

  C.sparkline = function (canvas, values, opts = {}) {
    if (!window.Chart || !values || values.length < 2) return null;
    C.destroy(canvas);
    const col = C.colors();
    const up = values[values.length - 1] >= values[0];
    const color = opts.color || (up ? col.green : col.red);
    const chart = new Chart(canvas, {
      type: 'line',
      data: { labels: values.map((_, i) => i), datasets: [{ data: values, borderColor: color, borderWidth: 1.5, pointRadius: 0, fill: 'origin', backgroundColor: hexA(color, 0.1), cubicInterpolationMode: 'monotone' }] },
      options: { responsive: false, maintainAspectRatio: false, animation: false, events: [], scales: { x: { display: false }, y: { display: false } }, plugins: { tooltip: { enabled: false }, legend: { display: false } } },
    });
    canvas.__chart = chart;
    return chart;
  };

  C.bars = function (canvas, labels, values, opts = {}) {
    if (!window.Chart) return null;
    C.destroy(canvas);
    const col = C.colors();
    const colors = values.map((v) => (v >= 0 ? col.green : col.red));
    const chart = new Chart(canvas, {
      type: 'bar',
      data: { labels, datasets: [{ data: values, backgroundColor: colors.map((c) => hexA(c, 0.6)), borderColor: colors, borderWidth: 1, borderRadius: 3, maxBarThickness: 26 }] },
      options: {
        responsive: true, maintainAspectRatio: false, indexAxis: opts.horizontal ? 'y' : 'x',
        scales: { x: { grid: { color: col.grid, drawTicks: false }, border: { display: false }, ticks: opts.horizontal ? { callback: C.axisUsd } : {} }, y: { grid: { color: col.grid, drawTicks: false }, border: { display: false }, ticks: opts.horizontal ? {} : { callback: C.axisUsd } } },
        plugins: { tooltip: { backgroundColor: '#1e1e1f', borderColor: '#2a2a2c', borderWidth: 1, displayColors: false, callbacks: { label: (it) => (opts.fmt || U.fmtUsd)(it.raw) } } },
      },
    });
    canvas.__chart = chart;
    return chart;
  };

  /** Two series side by side per label (e.g. implied vs realized probability per odds bucket), in percent. */
  C.pairedBars = function (canvas, labels, a, b, opts = {}) {
    if (!window.Chart) return null;
    C.destroy(canvas);
    const col = C.colors();
    const fmt = opts.fmt || ((v) => U.fmtPct(v, { dp: 1 }));
    const ds = (label, data, color) => ({ label, data, backgroundColor: hexA(color, 0.55), borderColor: color, borderWidth: 1, borderRadius: 3, maxBarThickness: 22 });
    const chart = new Chart(canvas, {
      type: 'bar',
      data: { labels, datasets: [ds(opts.aLabel || 'A', a, opts.aColor || col.text), ds(opts.bLabel || 'B', b, opts.bColor || col.accent)] },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: { x: { grid: { display: false }, border: { display: false } }, y: { min: 0, max: opts.max, grid: { color: col.grid, drawTicks: false }, border: { display: false }, ticks: { callback: fmt } } },
        plugins: { legend: { display: true, position: 'top', align: 'end', labels: { color: col.text, boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: 'rectRounded' } }, tooltip: { backgroundColor: '#1e1e1f', borderColor: '#2a2a2c', borderWidth: 1, callbacks: { label: (it) => it.dataset.label + ': ' + fmt(it.raw) } } },
      },
    });
    canvas.__chart = chart;
    return chart;
  };
})();
