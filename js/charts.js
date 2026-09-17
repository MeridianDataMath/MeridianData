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

  C.destroy = (canvas) => { if (canvas && canvas.__chart) { try { canvas.__chart.destroy(); } catch (_) {} canvas.__chart = null; } };

  /**
   * line/bar chart of time series. opts: {points:[{x,y}], color, type:'line'|'bar', yFmt, tooltipLabel, zero:true}
   */
  C.timeSeries = function (canvas, opts) {
    if (!window.Chart) return null;
    C.destroy(canvas);
    const col = C.colors();
    const pts = opts.points || [];
    const color = opts.color || col.accent;
    const type = opts.type || 'line';
    const xs = pts.map((p) => p.x);
    const range = xs.length > 1 ? xs[xs.length - 1] - xs[0] : U.DAY;
    const yFmt = opts.yFmt || ((v) => U.fmtUsd(v, { compact: true }));
    const ds = {
      data: pts, borderColor: color, backgroundColor: type === 'bar' ? hexA(color, 0.55) : hexA(color, 0.12),
      borderWidth: type === 'bar' ? 0 : 2, pointRadius: 0, pointHoverRadius: 4, pointHoverBackgroundColor: color, pointHoverBorderColor: '#0e0e0f',
      fill: type === 'line' && opts.fill !== false ? 'origin' : false, tension: 0.25, borderRadius: 2, maxBarThickness: 18, stepped: opts.stepped || false,
    };
    const chart = new Chart(canvas, {
      type,
      data: { datasets: [ds] },
      options: {
        responsive: true, maintainAspectRatio: false, parsing: false, normalized: true,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        scales: {
          x: { type: 'linear', min: opts.xMin, max: opts.xMax, grid: { color: col.grid, drawTicks: false }, border: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0, callback: xTick(range), padding: 8 } },
          y: { position: 'right', grid: { color: (c) => (c.tick.value === 0 && opts.zero !== false ? '#3a3a3d' : col.grid), drawTicks: false }, border: { display: false }, ticks: { maxTicksLimit: 6, callback: (v) => yFmt(v), padding: 8 }, beginAtZero: opts.beginAtZero || false },
        },
        plugins: {
          tooltip: {
            backgroundColor: '#1e1e1f', borderColor: '#2a2a2c', borderWidth: 1, titleColor: '#a1a1a8', bodyColor: '#ececee', padding: 10, displayColors: false,
            callbacks: {
              title: (items) => (items[0] ? U.fmtDateTime(items[0].raw.x) : ''),
              label: (item) => (opts.tooltipLabel ? opts.tooltipLabel(item.raw) : (opts.label || '') + ' ' + (opts.tipFmt || U.fmtUsd)(item.raw.y)),
            },
          },
        },
      },
    });
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
      data: { labels: values.map((_, i) => i), datasets: [{ data: values, borderColor: color, borderWidth: 1.5, pointRadius: 0, fill: 'origin', backgroundColor: hexA(color, 0.1), tension: 0.3 }] },
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
        scales: { x: { grid: { color: col.grid, drawTicks: false }, border: { display: false }, ticks: opts.horizontal ? { callback: (v) => U.fmtUsd(v, { compact: true }) } : {} }, y: { grid: { color: col.grid, drawTicks: false }, border: { display: false }, ticks: opts.horizontal ? {} : { callback: (v) => U.fmtUsd(v, { compact: true }) } } },
        plugins: { tooltip: { backgroundColor: '#1e1e1f', borderColor: '#2a2a2c', borderWidth: 1, displayColors: false, callbacks: { label: (it) => (opts.fmt || U.fmtUsd)(it.raw) } } },
      },
    });
    canvas.__chart = chart;
    return chart;
  };
})();
