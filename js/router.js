/* MeridianDataHub — hash router: #/path?query */
(function () {
  const MD = window.MD; const U = MD.util;
  const R = (MD.router = { current: null, pages: {}, ctx: null });

  /** A group of scripts kept out of the first load (index.html holds them as <template id="lazy-<name>">, in order: a
   *  template's scripts are not fetched, and the deploy versions their addresses like the rest), loaded on first need;
   *  resolves once every one has run. A failed load can be tried again. Without its template (a test page) it is taken
   *  as loaded. */
  const groups = {};
  // A page left open across a deploy names the old deploy's files (?v= of its own index.html), and the host answers any ?v
  // with today's file (a removed one with the site's page, which the browser then keeps a year as that script): its lazy
  // groups would run new code on the old page's core. The deploy's build id (index.html's <meta name="md-build">) is
  // compared with the live one before a group loads, and after one fails: a newer deploy reloads the page instead.
  // The live id is read again after 5 s (kept a minute, a deploy landing inside it was missed, and the re-check after a
  // failed load always got the old answer: Retry failed for the rest of the minute), and given 10 s: no answer is
  // "unknown", the group loads. Chart.js is not checked: a vendor file that cannot mix with the site's code, and loaded
  // with a page's first chart, often long after the page opened (it reloaded a Tax report or a simulation just as its
  // results came).
  const pageBuild = () => { const m = typeof document !== 'undefined' && document.querySelector ? document.querySelector('meta[name="md-build"]') : null; return m ? m.getAttribute('content') : null; };
  let liveP = null, liveAt = 0;
  const liveBuild = (fresh) => {
    if (liveP && !fresh && Date.now() - liveAt < 5000) return liveP;
    liveAt = Date.now();
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined;
    return (liveP = fetch('./', { cache: 'no-cache', signal }).then((r) => (r.ok ? r.text() : '')).then((t) => { const m = /<meta name="md-build" content="([^"]*)">/.exec(t); return m ? m[1] : null; }, () => null));
  };
  const outdated = async (fresh) => { const mine = pageBuild(); if (!mine || mine === 'dev' || typeof fetch !== 'function') return false; const live = await liveBuild(fresh); return !!live && live !== mine; };
  const CHECKED = (name) => name !== 'charts';
  const reload = () => { try { U.toast('A newer version of the site is out: loading it'); } catch (_) {} location.reload(); return new Promise(() => {}); };
  MD.need = (name) => groups[name] || (groups[name] = (async () => {
    const tpl = typeof document !== 'undefined' && document.getElementById ? document.getElementById('lazy-' + name) : null;
    const srcs = tpl && tpl.content ? Array.from(tpl.content.querySelectorAll('script')).map((s) => s.getAttribute('src')) : [];
    if (!srcs.length) return;
    if (CHECKED(name) && await outdated()) return reload();
    await new Promise((resolve, reject) => {
      let left = srcs.length;
      for (const src of srcs) {
        const s = document.createElement('script'); s.src = src; s.async = false;   // they run in the order given
        s.onload = () => { if (--left === 0) resolve(); };
        s.onerror = () => reject(new Error('Part of the site did not load (' + src + '): check the connection and try again'));
        document.head.appendChild(s);
      }
    });
  })().catch(async (e) => { delete groups[name]; if (CHECKED(name) && await outdated(true)) return reload(); throw e; }));
  /** route name → the script group its page is in (the Tax center, the Predict pages), loaded before it mounts */
  R.LAZY = { tax: 'tax', predict: 'predict' };

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
    if (opts.silent) { R.silent = true; history.replaceState(history.state, '', u); R.silent = false; if (R.current) R.current.params = params; curHash = u; }
    else location.hash = u.slice(1);
  };

  // Scroll positions per hash, so Back returns to where the reader was instead of the top of the page.
  // Pages fill in asynchronously, so the restore is retried for a moment until the page is tall enough.
  const scrollPos = new Map(), focusPos = new Map();
  let byKeyboard = false;   // the last input was a key (Tab, Enter), not a pointer
  if (typeof document !== 'undefined') {
    document.addEventListener('keydown', (e) => { if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) byKeyboard = true; }, true);
    document.addEventListener('pointerdown', () => { byKeyboard = false; }, true);
  }
  /** The keyboard to the page (the skip link, a keyboard route change): the main region, so Tab goes on into the page. */
  R.focusPage = () => { const m = R.root; if (!m) return; if (!m.hasAttribute('tabindex')) m.tabIndex = -1; m.focus({ preventScroll: true }); };
  let curHash = null;   // curHash follows silent param updates too, so the key matches what Back returns to
  // each history entry numbered (history.state.i, from this load's time up: unique across reloads): an entry seen before
  // is reached by Back or Forward, a new one (state null) by a link. Only those restore a scroll position (Chrome fires
  // popstate on every hash change, so a link to a page seen before came back scrolled down)
  let entrySeq = Date.now(), curEntry = null;
  const restoreScroll = (hash, ctx) => {
    const y = scrollPos.get(hash); if (!y) return;
    const t0 = Date.now();
    const tick = () => { if (ctx.signal.aborted || R.ctx !== ctx) return; if (R.root.scrollHeight - R.root.clientHeight >= y) { R.root.scrollTop = y; return; } if (Date.now() - t0 < 2500) setTimeout(tick, 100); };
    tick();
  };
  // the element that had the focus when the page was left, by its key: retried for a moment, as the page draws late
  const restoreFocus = (hash, ctx) => {
    const key = focusPos.get(hash); if (!key || !(window.CSS && CSS.escape)) return;
    const t0 = Date.now();
    const tick = () => { if (ctx.signal.aborted || R.ctx !== ctx) return; const el = R.root.querySelector('[data-focus-key="' + CSS.escape(key) + '"]'); if (el) { el.focus({ preventScroll: true }); return; } if (Date.now() - t0 < 2500) setTimeout(tick, 100); };
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
    const hs = typeof history !== 'undefined' ? history : null;   // (none where the tests run the router)
    const was = hs && hs.state && typeof hs.state.i === 'number' ? hs.state.i : null;
    const fromHistory = was != null && was !== curEntry;
    if (was == null) { try { if (hs) hs.replaceState(Object.assign({}, hs.state, { i: ++entrySeq }), ''); } catch (_) {} curEntry = entrySeq; } else curEntry = was;
    // same page + same params → nothing
    if (prev && prev.path === route.path && JSON.stringify(prev.params) === JSON.stringify(route.params)) return;
    // a dialog belongs to the page it was opened on (Back, Forward, a link or a notification leave it behind otherwise)
    if (window.MD.ui && window.MD.ui.closeModals) window.MD.ui.closeModals();
    if (prev && curHash) { scrollPos.set(curHash, R.root.scrollTop); const a = document.activeElement; focusPos.set(curHash, a && a !== document.body && R.root.contains(a) && a.dataset && a.dataset.focusKey ? a.dataset.focusKey : null); }
    curHash = location.hash || '#/';
    if (R.ctx) { const old = R.ctx; old.done = true; try { old.abort.abort(); } catch (_) {} for (const f of old.cleanup.splice(0)) { try { f(); } catch (_) {} } }   // one failing cleanup must not leave the others (timers, socket subscriptions) running
    const abort = new AbortController();
    // a cleanup registered once the page has been left (a timer or a subscription started after a slow read came back)
    // runs at once: the page's own cleanup has already been and gone
    const ctx = { abort, signal: abort.signal, cleanup: [], route, onCleanup(fn) { if (this.done) { try { fn(); } catch (_) {} } else this.cleanup.push(fn); } };
    R.ctx = ctx; R.current = route;
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
    if (fromHistory) { restoreScroll(curHash, ctx); restoreFocus(curHash, ctx); }
    else if (byKeyboard && prev && prev.path !== route.path) R.focusPage();
    // a page in a group not loaded yet: its scripts first (a failed load says so, with a Retry)
    const own = (o, k) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);   // (#/constructor is no page)
    const lazy = own(R.LAZY, route.name);
    if (lazy && !own(R.pages, route.name)) {
      const UI = window.MD.ui;
      U.replace(host, U.h('div.page', UI ? UI.loading('Loading…') : 'Loading…'));
      try { await MD.need(lazy); }
      catch (e) { if (R.ctx === ctx) { U.replace(host, U.h('div.page', UI ? UI.error(e, () => R.reload()) : U.h('div.error', e.message))); if (progress) progress.done(); } return; }
      if (R.ctx !== ctx) return;
      U.clear(host);
    }
    const page = own(R.pages, route.name) || R.pages.notfound;
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
