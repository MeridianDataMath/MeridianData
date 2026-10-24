/* MeridianDataHub — hash router: #/path?query */
(function () {
  const MD = window.MD; const U = MD.util;
  const R = (MD.router = { current: null, pages: {}, ctx: null });

  R.parse = function (hash) {
    const h = (hash || location.hash || '#/').replace(/^#/, '');
    const [pathPart, query] = h.split('?');
    const path = (pathPart || '/').replace(/\/+$/, '') || '/';
    const params = {};
    const dec = (s) => { try { return decodeURIComponent(s); } catch (_) { return s; } };   // a stray "%" in a pasted link is not worth a blank page
    if (query) for (const kv of query.split('&')) { const [k, v] = kv.split('='); if (k) params[dec(k)] = dec((v || '').replace(/\+/g, ' ')); }
    return { path, params, name: path === '/' ? 'home' : path.slice(1).split('/')[0] };
  };
  R.url = (path, params) => '#' + path + (params && Object.keys(params).length ? '?' + Object.entries(params).filter(([, v]) => v != null && v !== '').map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&') : '');
  R.navigate = (path, params, opts = {}) => { const u = R.url(path, params); if (opts.replace) history.replaceState(null, '', u); else location.hash = u.slice(1); if (opts.replace) R.dispatch(); };
  /** update query params of the current route without a remount when `silent` */
  R.setParams = (patch, opts = {}) => {
    const r = R.parse();
    const params = Object.assign({}, r.params, patch);
    for (const k of Object.keys(params)) if (params[k] == null || params[k] === '') delete params[k];
    const u = R.url(r.path, params);
    if (opts.silent) { R.silent = true; history.replaceState(null, '', u); R.silent = false; if (R.current) R.current.params = params; curHash = u; }
    else location.hash = u.slice(1);
  };

  // Scroll positions per hash, so Back returns to where the reader was instead of the top of the page.
  // Pages fill in asynchronously, so the restore is retried for a moment until the page is tall enough.
  const scrollPos = new Map();
  let viaHistory = false, curHash = null;   // curHash follows silent param updates too, so the key matches what Back returns to
  window.addEventListener('popstate', () => { viaHistory = true; });
  const restoreScroll = (hash, ctx) => {
    const y = scrollPos.get(hash); if (!y) return;
    const t0 = Date.now();
    const tick = () => { if (ctx.signal.aborted || R.ctx !== ctx) return; if (R.root.scrollHeight - R.root.clientHeight >= y) { R.root.scrollTop = y; return; } if (Date.now() - t0 < 2500) setTimeout(tick, 100); };
    tick();
  };
  R.start = function (rootEl, onRoute) {
    R.root = rootEl; R.onRoute = onRoute;
    window.addEventListener('hashchange', () => R.dispatch());
    R.dispatch();
  };
  R.dispatch = async function () {
    const route = R.parse();
    const prev = R.current;
    const fromHistory = viaHistory; viaHistory = false;
    // same page + same params → nothing
    if (prev && prev.path === route.path && JSON.stringify(prev.params) === JSON.stringify(route.params)) return;
    // a dialog belongs to the page it was opened on (Back, Forward, a link or a notification leave it behind otherwise)
    if (window.MD.ui && window.MD.ui.closeModals) window.MD.ui.closeModals();
    if (prev && curHash) scrollPos.set(curHash, R.root.scrollTop);
    curHash = location.hash || '#/';
    if (R.ctx) { const old = R.ctx; old.done = true; try { old.abort.abort(); } catch (_) {} for (const f of old.cleanup.splice(0)) { try { f(); } catch (_) {} } }   // one failing cleanup must not leave the others (timers, socket subscriptions) running
    const abort = new AbortController();
    // a cleanup registered once the page has been left (a timer or a subscription started after a slow read came back)
    // runs at once: the page's own cleanup has already been and gone
    const ctx = { abort, signal: abort.signal, cleanup: [], route, onCleanup(fn) { if (this.done) { try { fn(); } catch (_) {} } else this.cleanup.push(fn); } };
    R.ctx = ctx; R.current = route;
    const page = R.pages[route.name] || R.pages.notfound;
    R.root.scrollTop = 0;
    // Chart.js keeps every chart, and through it its canvas and the page around it, until destroy()
    if (window.MD.charts && window.MD.charts.destroyAll) window.MD.charts.destroyAll();
    U.clear(R.root);
    // each page renders into an element of its own: a page left while it loads finishes into that, off the screen,
    // instead of over the page that replaced it
    const host = U.h('div.route');
    R.root.appendChild(host);
    if (R.onRoute) R.onRoute(route);
    const progress = window.MD.ui && window.MD.ui.progress;   // the thin line under the topbar, for every page change
    if (progress) progress.restart();
    if (fromHistory) restoreScroll(curHash, ctx);
    try { await page.mount(host, route, ctx); }
    catch (e) {
      if (R.ctx !== ctx || (e && e.name === 'AbortError')) return;   // a page already left: its failure is nobody's business
      console.error(e);
      const UI = window.MD.ui, msg = 'Failed to render page: ' + ((e && e.message) || e);
      U.replace(host, U.h('div.page', UI ? UI.error(msg, () => R.reload()) : U.h('div.error', msg)));
    }
    finally { if (progress && R.ctx === ctx) progress.done(); }
  };
  /** Mount the current page again (a Retry button, a newer snapshot): dispatch ignores an unchanged route, so a Retry
   *  wired to dispatch did nothing. */
  R.reload = () => { R.current = null; return R.dispatch(); };
})();
