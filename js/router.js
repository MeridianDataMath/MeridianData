/* MeridianDataHub — hash router: #/path?query */
(function () {
  const MD = window.MD; const U = MD.util;
  const R = (MD.router = { current: null, pages: {}, ctx: null });

  R.parse = function (hash) {
    const h = (hash || location.hash || '#/').replace(/^#/, '');
    const [pathPart, query] = h.split('?');
    const path = (pathPart || '/').replace(/\/+$/, '') || '/';
    const params = {};
    if (query) for (const kv of query.split('&')) { const [k, v] = kv.split('='); if (k) params[decodeURIComponent(k)] = decodeURIComponent((v || '').replace(/\+/g, ' ')); }
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
    if (opts.silent) { R.silent = true; history.replaceState(null, '', u); R.silent = false; if (R.current) R.current.params = params; }
    else location.hash = u.slice(1);
  };

  R.start = function (rootEl, onRoute) {
    R.root = rootEl; R.onRoute = onRoute;
    window.addEventListener('hashchange', () => R.dispatch());
    R.dispatch();
  };
  R.dispatch = async function () {
    const route = R.parse();
    const prev = R.current;
    // same page + same params → nothing
    if (prev && prev.path === route.path && JSON.stringify(prev.params) === JSON.stringify(route.params)) return;
    if (R.ctx) { try { R.ctx.abort.abort(); } catch (_) {} if (R.ctx.cleanup) { try { R.ctx.cleanup.forEach((f) => f()); } catch (_) {} } }
    const abort = new AbortController();
    const ctx = { abort, signal: abort.signal, cleanup: [], route, onCleanup(fn) { this.cleanup.push(fn); } };
    R.ctx = ctx; R.current = route;
    const page = R.pages[route.name] || R.pages.notfound;
    R.root.scrollTop = 0;
    U.clear(R.root);
    if (R.onRoute) R.onRoute(route);
    try { await page.mount(R.root, route, ctx); }
    catch (e) { if (!(e && e.name === 'AbortError')) { console.error(e); U.replace(R.root, U.h('div.page', U.h('div.error', 'Failed to render page: ' + (e.message || e)))); } }
  };
})();
