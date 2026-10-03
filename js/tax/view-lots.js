/* MeridianDataHub — Tax center: the USDe lots card, on request. The reader picks a lot method and a scope (none is
   preselected: which one applies depends on their rules), a valuation and which deposit reading the detail shows; the
   card then reads the account's whole history (MD.tax.load.lifetime, with progress and Cancel) and the Predict card's
   record, builds every USDe flow (MD.tax.lots.usdeEvents) and runs the lots under both deposit readings. Opening lots
   are entered here and kept in this browser only. The choices live in the link (lot, lscope, px, dep). Builds DOM only
   when called. */
(function () {
  const MD = window.MD; const U = MD.util; const UI = MD.ui; const h = U.h;
  const T = MD.tax; const TZ = T.tz;
  const VL = (T.viewLots = {});
  const PAGE = 25, PRINT_MAX = 2000, DAY = 86400000, AHEAD = 30 * DAY;

  /** The reader's opening lots for a wallet: kept in this browser only, never sent anywhere (a convenience). */
  VL.storeKey = (addr) => 'md.tax.lots.' + String(addr || '').toLowerCase();
  VL.opening = (addr) => { const l = U.storage.get(VL.storeKey(addr), []); return Array.isArray(l) ? l.map(T.lots.cleanLot).filter(Boolean) : []; };
  VL.saveOpening = (addr, list) => (list.length ? U.storage.set(VL.storeKey(addr), list) : U.storage.del(VL.storeKey(addr)));

  /**
   * card: the card's element; ctx: {addr, sa (the subaccount; null for a Predict-only wallet), ref, period, money, fname,
   * params (the link's lot, lscope, px, dep), predict() → a promise of the Predict card's data (view-predict's load:
   * {pw, prep} or {missing}) or null, signal, onCleanup, onResult({runs, names, method, scope, dep, valuation, opening (how many
   * lots entered), warnings, files() → {ectx, extra} (the files' context and the lots' own methodology rows)}) (called
   * each time the lots are built), methodology(file, extra) (a report's methodology rows)}.
   */
  VL.render = function (card, ctx) {
    const LO = T.lots, TUI = T.ui, EX = T.exports, FX = T.fx;
    const { addr, sa, ref, period, money, fname } = ctx;
    const { tz, start, end } = period;
    const ccy = money.ccy, pnlEl = TUI.pnlEl(money), fmt = (v, o) => money.fmt(v, o);
    let method = LO.methodOf(ctx.params.lot), scope = LO.scopeOf(ctx.params.lscope), px = LO.valuationOf(ctx.params.px), dep = LO.readingOf(ctx.params.dep);
    let opening = VL.opening(addr);
    const amber = (...kids) => h('div.small', { style: { marginTop: '6px', color: 'var(--amber)' } }, ...kids);
    const dim = (...kids) => h('div.small.dim', { style: { marginTop: '6px' } }, ...kids);
    const plural = (n, w, ws) => `${U.fmtNum(n, 0)} ${n === 1 ? w : ws || w + 's'}`;

    // ---- controls: the choice is the reader's, so method and scope start empty ----
    const sel = (label, title, opts, value, onchange, placeholder) => h('select.input.sm', { style: { width: 'auto' }, 'aria-label': label, title, onchange: (e) => onchange(e.target.value) },
      placeholder ? h('option', { value: '', disabled: true, selected: !value }, placeholder) : null, opts.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
    const set = (patch) => { MD.router.setParams(patch, { silent: true }); go(); };
    const M_LBL = 'Lot method', S_LBL = 'Scope', V_LBL = 'Valuation', D_LBL = 'Deposits shown';
    const mSel = sel(M_LBL, M_LBL + ': how a disposal is matched to the units acquired', LO.METHODS.map((m) => [m, LO.METHOD_LABEL[m]]), method, (v) => { method = LO.methodOf(v); fitScope(); set({ lot: method, lscope: scope }); }, 'Choose a method…');
    const sSel = sel(S_LBL, S_LBL + ': which units share one set of lots', LO.SCOPES.map((s) => [s, LO.SCOPE_LABEL[s] + (s === 'pool' ? ' (each margin pool, the Predict wallet)' : s === 'wallet' ? ' (perps subaccount, Predict wallet)' : '')]), scope, (v) => { scope = LO.scopeOf(v); set({ lscope: scope }); }, 'Choose a scope…');
    // a method offered with some scopes only (UK pooling: one pool for everything) greys out the others and takes its
    // own; true when that changed the scope
    const scopeNote = h('div.dim.xs.no-print', { style: { marginBottom: '4px' } });
    const fitScope = () => {
      const ok = LO.scopesFor(method), s = LO.scopeFor(method, scope);
      for (const op of Array.from(sSel.options)) if (op.value) op.disabled = !ok.includes(op.value);
      scopeNote.textContent = LO.SCOPE_NOTE[method] ? LO.SCOPE_NOTE[method] + '.' : '';
      if (s === scope) return false;
      scope = s; sSel.value = scope || '';
      return true;
    };
    if (fitScope() && !ctx.signal.aborted) MD.router.setParams({ lscope: scope }, { silent: true });
    const vSel = sel(V_LBL, V_LBL + ': USDe in USD, before the report currency', LO.VALUATIONS.map((v) => [v, LO.VALUATION_LABEL[v]]), px, (v) => { px = LO.valuationOf(v); set({ px: px === 'par' ? null : px }); });
    const dSel = sel(D_LBL, D_LBL + ': which deposit reading the detail below shows (both are totalled)', LO.READINGS.map((r) => [r, LO.READING_LABEL[r]]), dep, (v) => { dep = LO.readingOf(v); set({ dep: dep === 'transfer' ? null : dep }); });
    const controls = h('div.row.wrap.no-print', { style: { rowGap: '8px', marginBottom: '6px' } },
      h('span.dim.small', M_LBL), mSel, h('span.dim.small', S_LBL), sSel, h('span.dim.small', V_LBL), vSel, h('span.dim.small', D_LBL), dSel);

    // ---- opening lots: USDe the reader held before it reached Meridian ----
    const lotsBody = h('div');
    const AT_LBL = 'Held', DATE_LBL = 'Acquired on', UNITS_LBL = 'Units (USDe)', COST_LBL = `Total cost (${ccy})`;
    const atIn = h('select.input.sm', { style: { width: 'auto' }, 'aria-label': AT_LBL, title: AT_LBL }, h('option', { value: LO.OUT }, 'Outside Meridian (deposits draw on it)'), h('option', { value: LO.PREDICT }, 'In the Predict wallet'));
    const dateIn = h('input.input.sm', { type: 'date', style: { width: 'auto' }, 'aria-label': DATE_LBL, title: DATE_LBL });
    const unitsIn = h('input.input.sm', { type: 'number', min: '0', step: 'any', placeholder: UNITS_LBL, style: { width: '130px' }, 'aria-label': UNITS_LBL, title: UNITS_LBL });
    const costIn = h('input.input.sm', { type: 'number', min: '0', step: 'any', placeholder: COST_LBL, style: { width: '140px' }, 'aria-label': COST_LBL, title: COST_LBL });
    const lotsSum = h('summary.small', { style: { cursor: 'pointer', color: 'var(--text-2)' } });
    const drawLots = () => {
      lotsSum.textContent = `Opening lots (${opening.length}) · USDe you held before it reached Meridian, kept in this browser only`;
      U.replace(lotsBody, opening.length ? UI.table({ cols: [
        { key: 'a', label: AT_LBL, render: (x) => (x.at === LO.PREDICT ? 'Predict wallet' : 'outside Meridian') },
        { key: 'd', label: DATE_LBL, render: (x) => x.date },
        { key: 'u', label: UNITS_LBL, num: true, render: (x) => U.fmtNum(x.units, 2) },
        { key: 'c', label: 'Total cost', num: true, render: (x) => T.n6(x.cost) + ' ' + x.ccy + (x.ccy !== ccy && x.ccy !== 'USD' ? ' (not used in ' + ccy + ')' : '') },
        { key: 'x', label: '', render: (x) => h('button.btn.sm.ghost.no-print', { onclick: () => { opening = opening.filter((y) => y !== x); VL.saveOpening(addr, opening); drawLots(); go(); } }, 'Remove') },
      ], rows: opening }) : null);
    };
    const addLot = () => {
      const x = LO.cleanLot({ at: atIn.value, date: dateIn.value, units: unitsIn.value, cost: costIn.value, ccy });
      if (!x) { U.toast('Enter the date, the units (above 0) and what they cost (0 or more)'); return; }
      opening = opening.concat([x]).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      VL.saveOpening(addr, opening); unitsIn.value = ''; costIn.value = '';
      drawLots(); go();
    };
    const lotsEd = h('details', { style: { margin: '8px 0' }, open: opening.length ? true : null }, lotsSum,
      h('div.small.dim', { style: { margin: '8px 0' } }, 'Deposits (and the Predict wallet\'s spending beyond what it received here) draw on these first, by the method chosen, with their dates and cost; without them, USDe enters at its value at the moment it arrives, and what it cost you before is not in these figures. The cost is in the report currency (' + ccy + ') or in USD. Saved in this browser for this wallet only; nothing is sent anywhere.'),
      lotsBody, h('div.row.wrap.no-print', { style: { rowGap: '8px', marginTop: '8px' } }, atIn, dateIn, unitsIn, costIn, h('button.btn.sm', { onclick: addLot }, 'Add')));
    drawLots();

    // ---- loading: the whole history once (cached for the tab), the Predict card's record, the price on request ----
    const statusEl = h('div'), resultEl = h('div');
    let dataP = null, priceP = null;
    const getData = () => {
      if (dataP) return dataP;
      const ac = new AbortController(); const stop = () => ac.abort();
      ctx.signal.addEventListener('abort', stop); ctx.onCleanup(() => ctx.signal.removeEventListener('abort', stop));
      const prog = TUI.progress(statusEl, stop);
      const say = (s) => prog.set('Reading the account\'s whole history for its lots: ' + (s.stage === 'ledger' ? 'daily ledger…' : [s.fillPages ? `fills ${plural(s.fillPages, 'page')}` + (s.fillRows ? ` (${U.fmtNum(s.fillRows, 0)})` : '') : 'fills…', s.posTotal ? `positions ${s.posDone}/${s.posTotal}` : null, s.fundTotal ? `funding ${s.fundDone}/${s.fundTotal}` : null].filter(Boolean).join(' · ')));
      prog.set(sa ? 'Reading the account\'s whole history for its lots…' : 'Waiting for the Predict record…');
      // the span ends 30 days after the period (the UK rule looks that far ahead); one that has not ended yet ends at a
      // day's end, so the tab's cache (MD.tax.cache) keeps one span for the day and only extends it
      const lifeEnd = end + AHEAD > Date.now() ? Math.ceil((end + AHEAD) / DAY) * DAY : end + AHEAD;
      // a subaccount without its creation time starts with the rate files' floor (before Meridian Predict launched); one
      // created after the span has nothing in it to read
      const first = sa ? U.num(sa.createdAt) || Date.UTC(2026, 5, 1) : null;
      dataP = (async () => {
        const [perps, pred] = await Promise.all([
          sa && first < lifeEnd ? T.load.lifetime(sa.id, { first, end: lifeEnd, ref, signal: ac.signal, progress: say }) : null,
          ctx.predict ? ctx.predict().catch(() => null) : null,
        ]);
        U.replace(statusEl);
        return { perps, pred: pred && pred.prep ? pred : null };
      })();
      dataP.catch((e) => {
        dataP = null;
        if (ctx.signal.aborted) return;
        U.replace(statusEl, h('div.small', { style: { color: 'var(--amber)', margin: '8px 0' } }, (T.isAbort(e) ? 'The USDe lots were not built (cancelled).' : 'The USDe lots could not be built: ' + e.message + '.') + ' ', h('button.btn.sm', { onclick: () => go() }, 'Load again')));
      });
      return dataP;
    };
    const getPrices = () => {
      if (!priceP) { priceP = FX.usde({ tz, signal: ctx.signal }).catch((e) => { priceP = null; if (T.isAbort(e)) throw e; return { failed: e.message }; }); }
      return priceP;
    };

    // ---- drawing ----
    let printAll = false, page = 1, last = null;
    const go = async () => {
      // print hides the selects that would build them: a printed report says the lots were not computed
      if (!method || !scope) { U.replace(resultEl, h('div.empty.no-print', 'Choose a lot method and a scope above to build the lots. The choice is yours: which method and scope apply depends on the rules that apply to you, and this page recommends none.'), h('div.small.dim.print-only', 'Not computed for this report: the USDe lots are built on request, once a lot method and a scope are chosen.')); return; }
      let data, prices = null;
      try { data = await getData(); } catch (e) { U.replace(resultEl); return; }
      if (px === 'market') { try { prices = await getPrices(); } catch (e) { return; } }
      if (ctx.signal.aborted) return;
      page = 1; last = build(data, prices); draw();
      // the Holdings card shows the lots held at the period's start and end; the page's summary, classes, methodology
      // and ZIP read the rest
      const L = last;
      if (ctx.onResult) ctx.onResult({ runs: L.runs, names: L.x.names, method, scope, dep, valuation: valuation(L), opening: opening.length, warnings: L.warnings, facts: LO.facts(L.x.events, start, end), files: () => filesOf(L) });
    };
    // the files' context and the lots' own methodology rows (T.lots.describe), under the reading shown
    const filesOf = (L) => {
      const res = L.runs[dep], alt = L.runs[dep === 'transfer' ? 'disposal' : 'transfer'];
      return {
        ectx: { res, alt, events: L.x.events, names: L.x.names, period, tz, money, fname, preset: period.preset, warnings: L.warnings },
        extra: LO.describe({ res, events: L.x.events, period, tz, money, addr, sid: sa ? sa.id : null, pw: L.pw, valuation: valuation(L), opening, skipped: L.x.skipped, early: L.x.early, cutoff: L.cutoff, dataNotes: L.warnings, now: Date.now() }),
      };
    };
    const build = (data, prices) => {
      const now = Date.now(), cutoff = Math.min(end + AHEAD, now);
      const priced = prices && !prices.failed ? prices : null;
      const cash = data.pred ? T.predict.cash(data.pred.prep) : null;
      const P0 = data.perps;
      const x = LO.usdeEvents({ perps: P0 ? { D: P0.D, ev: P0.ev, ref, dayRows: P0.dayRows } : null, cash, opening, tz, price: priced ? (t) => priced.at(t) : () => 1, money, cutoff });
      const o = { method, scope, tz, cutoff, at: [start, end] };
      const runs = { transfer: LO.run(x.events, Object.assign({ reading: 'transfer' }, o)), disposal: LO.run(x.events, Object.assign({ reading: 'disposal' }, o)) };
      const warnings = [];
      if (P0) warnings.push(...EX.eventWarnings({ ev: P0.ev }));
      const cov = data.pred ? T.predict.coverageNote(data.pred.prep) : null;
      if (cov && cov.blocking) warnings.push(cov.text);
      return { x, runs, priced, priceFail: prices && prices.failed ? prices.failed : null, cutoff, now, warnings, pw: data.pred && data.pred.pw ? data.pred.pw.address : null, cov, predMissing: !data.pred };
    };
    const valuation = (L) => (L.priced ? { kind: 'market', name: FX.USDE.name, rule: FX.USDE.rule, fetchedAt: (L.priced.via === 'file' ? 'published by this site, ' : 'DefiLlama directly, ') + (L.priced.fetchedAt || '?') } : { kind: 'par' });
    const draw = () => {
      const L = last; if (!L) return;
      const res = L.runs[dep], names = L.x.names;
      const inP = res.disposals.filter((d) => d.t >= start && d.t < end);
      const notes = [];
      // facts and notes, every one factual
      notes.push(h('div.small', { style: { margin: '4px 0 8px' } }, h('b', LO.factText(LO.facts(L.x.events, start, end)))));
      notes.push(dim(`${LO.METHOD_TEXT[method]} · ${LO.SCOPE_TEXT[scope]}` + (LO.SCOPE_NOTE[method] ? ` (${LO.SCOPE_NOTE[method]})` : '') + ' · ' + (L.priced ? `USDe valued at ${FX.USDE.name}, ${FX.USDE.rule}` : 'USDe valued at par (1 USDe = 1 USD)') + (money.rates ? `, then in ${ccy} at the rate of the local date` : '') + '.'));
      // conversions between pools: moves of lots under both readings (this page's reading: no token moves on chain)
      if (L.x.events.some((e) => e.kind === 'convert' && e.t < end)) notes.push(dim('Conversions between pools are read as moves, never disposals: no token moves on chain (the pools are internal balances of the same MeridianUSD), so their units keep their lots, acquisition dates and cost' + (scope === 'pool' ? ', moving to the other pool' : ' (both pools share one set of lots in this scope)') + '.'));
      if (!money.rates && !L.priced) notes.push(dim('In USD at par every disposal is at cost: no gain or loss in USD. FX or price effects appear in another report currency or at market price.'));
      if (L.priceFail) notes.push(amber(`The USDe/USD price could not be read (${L.priceFail}): valued at par instead.`));
      for (const t of L.priced ? L.priced.notes : []) notes.push(amber(t));
      if (L.priced && L.priced.latest.date < TZ.addDays(TZ.dayKey(Math.min(L.cutoff, end) - 1, tz), -3)) notes.push(amber(`The USDe/USD price runs to ${L.priced.latest.date}: later dates take that day's price.`));
      if (method === 'uk' && L.now < end + AHEAD) notes.push(amber(`The 30 days after the period are not over: matches can still change (events read to ${TZ.fmt(L.cutoff, tz, 'datetime')}).`));
      if (res.uncovered.n) notes.push(dim(`${plural(res.uncovered.n, 'arrival')} of USDe (${U.fmtNum(res.uncovered.units, 2)} units) not covered by an opening lot: each enters at its value at that moment, so what it cost before it reached Meridian is not in these figures. Enter opening lots above for USDe brought in from elsewhere.`));
      // what no lot covers because the data starts late is the 'not covered' note above; a shortfall here is the
      // matching's own (the flows had the units there)
      if (res.short.n) notes.push(amber(`${plural(res.short.n, 'disposal or move', 'disposals or moves')} (${U.fmtNum(res.short.units, 2)} units) found fewer units in the lots of their scope than its flows put there (a gap in this page's matching, not in the data): their cost is taken as their value then.`));
      for (const s of L.x.skipped) notes.push(amber('Opening lot not used: ' + LO.lotText(s) + ' (another currency than this report\'s ' + ccy + ' or USD).'));
      for (const s of L.x.early || []) notes.push(amber('Opening lot ' + LO.earlyText(ccy)(s) + '.'));
      for (const t of L.x.notes) notes.push(amber(t));
      const off = L.x.check.filter((c) => Math.abs(c.diff) >= 0.01);
      if (off.length) notes.push(amber('The perps flows here do not add up to the exchange\'s balance in: ' + off.map((c) => `${c.name} pool ${U.fmtUsd(c.diff, { sign: true, dp: 2 })}`).join(', ') + ' (a change the ledger has no entry for, or detail that could not be read; see the balance reconciliation above).'));
      else if (L.x.check.length) notes.push(dim('The perps flows add up to the exchange\'s balance in every pool.'));
      if (L.warnings.length) notes.push(amber('Incomplete: ' + L.warnings.join('; ') + '.'));
      if (L.predMissing) notes.push(dim('No Meridian Predict record for this wallet: Predict flows are not included.'));
      if (L.cov && !L.cov.blocking) notes.push(dim(L.cov.text));

      // both deposit readings, period totals side by side (neither marked as the one that applies)
      const tot = (r) => LO.totals(r.disposals, start, end);
      const both = [['transfer', tot(L.runs.transfer)], ['disposal', tot(L.runs.disposal)]];
      const cmp = UI.table({ cols: [
        { key: 'r', label: 'Deposits and withdrawals', render: ([r]) => h('div', { style: { whiteSpace: 'normal', maxWidth: '380px' } }, LO.READING_TEXT[r].replace(/^if /, ''), r === dep ? h('span.dim.xs', ' · detail below') : null) },   // a sentence: it wraps
        { key: 'n', label: 'Disposals', num: true, render: ([, x]) => U.fmtNum(x.n, 0) },
        { key: 'p', label: 'Proceeds', num: true, render: ([, x]) => fmt(x.proceedsC) },
        { key: 'c', label: 'Cost', num: true, render: ([, x]) => fmt(x.costC) },
        { key: 'g', label: 'Gains', num: true, render: ([, x]) => pnlEl(x.gainsC, x.gainsC) },
        { key: 'l', label: 'Losses', num: true, render: ([, x]) => pnlEl(x.lossesC, x.lossesC) },
        { key: 'net', label: 'Net', num: true, render: ([, x]) => pnlEl(x.netC, x.netC) },
      ], rows: both });

      const years = LO.byYear(res.disposals, { preset: period.preset, tz, names });
      const yearTbl = UI.table({ cols: [
        { key: 'y', label: 'Year', render: (r) => r.label },
        { key: 's', label: 'Scope', render: (r) => r.scope },
        { key: 'n', label: 'Disposals', num: true, title: 'of which fee payments in brackets', render: (r) => U.fmtNum(r.n, 0) + (r.fees ? ` (${U.fmtNum(r.fees, 0)})` : '') },
        { key: 'p', label: 'Proceeds', num: true, render: (r) => fmt(r.proceedsC) },
        { key: 'c', label: 'Cost', num: true, render: (r) => fmt(r.costC) },
        { key: 'g', label: 'Gains', num: true, render: (r) => pnlEl(r.gainsC, r.gainsC) },
        { key: 'l', label: 'Losses', num: true, render: (r) => pnlEl(r.lossesC, r.lossesC) },
        { key: 'net', label: 'Net', num: true, render: (r) => pnlEl(r.netC, r.netC) },
      ], rows: years, empty: 'No USDe disposals' });

      const rows = inP.slice().reverse();
      const shown = printAll ? rows.slice(0, PRINT_MAX) : rows.slice((page - 1) * PAGE, page * PAGE);
      const acq = (d) => { const ds = Array.from(new Set(d.pieces.filter((x) => x.acqT != null).map((x) => TZ.dayKey(x.acqT, tz)))); return ds.length === 1 ? ds[0] : ds.length ? 'VARIOUS' : '—'; };
      // days held; a 30-day match was acquired after the disposal, said so rather than as negative days
      const held = (d) => {
        const ds = d.pieces.filter((x) => x.days != null).map((x) => x.days), pos = ds.filter((x) => x >= 0), neg = ds.filter((x) => x < 0);
        if (!ds.length) return '—';
        const span = (l) => { const a = Math.min(...l), b = Math.max(...l); return a === b ? `${a} d` : `${a}–${b} d`; };
        return [pos.length ? span(pos) : null, neg.length ? 'acquired ' + span(neg.map((x) => -x)) + ' after' : null].filter(Boolean).join(' · ') + (d.pieces.some((x) => x.overYear) ? ' · over a year' + (d.pieces.every((x) => x.acqT == null || x.overYear) ? '' : ' (part)') : '');
      };
      const dispTbl = UI.table({ cols: [
        { key: 't', label: TUI.tzLabel('Time', tz), render: (d) => h('span.dim', { title: new Date(d.t).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' }, TZ.fmt(d.t, tz, 'iso').slice(0, 16)) },
        { key: 's', label: 'Scope', render: (d) => LO.keyLabel(d.key, names) },
        { key: 'k', label: 'Kind', render: (d) => h('span', { title: d.what || '' }, LO.KIND[d.kind] || d.kind) },
        { key: 'u', label: 'Units', num: true, render: (d) => U.fmtNum(d.units, d.units < 1 ? 4 : 2) },
        { key: 'p', label: 'Proceeds', num: true, render: (d) => fmt(d.proceedsC) },
        { key: 'c', label: 'Cost', num: true, render: (d) => fmt(d.costC) },
        { key: 'g', label: 'Gain or loss', num: true, render: (d) => pnlEl(d.gainC, d.gainC) },
        { key: 'r', label: 'Matched by', render: (d) => h('span.small', d.rule, d.provisional ? h('span.chip.amber', { style: { marginLeft: '6px' }, title: 'its 30 days are not over: the match can still change' }, 'provisional') : null) },
        { key: 'a', label: TUI.tzLabel('Acquired', tz), render: acq },
        { key: 'h', label: 'Held', render: held },
      ], rows: shown, empty: 'No USDe disposals in this period' });

      const endPools = (res.at.find((s) => s.t === end) || { pools: [] }).pools.filter((p) => Math.abs(p.units) > 1e-6);
      const poolTbl = UI.table({ cols: [
        { key: 's', label: 'Scope', render: (p) => LO.keyLabel(p.key, names) },
        { key: 'u', label: 'Units', num: true, render: (p) => U.fmtNum(p.units, 2) },
        { key: 'c', label: 'Cost', num: true, render: (p) => fmt(p.c) },
        { key: 'a', label: 'Cost per unit', num: true, render: (p) => (p.units > 1e-9 ? fmt(p.c / p.units, { dp: 4 }) : '—') },
      ], rows: endPools, empty: 'Nothing held at the period end' });

      // the files: site reports, the report's methodology first with the lots' own rows in it (T.lots.describe)
      const { ectx } = filesOf(L);
      const save = (d) => { const f = EX.build(d.id, ectx), extra = filesOf(L).extra; TUI.save(f, ctx.methodology ? ctx.methodology(f, extra) : extra); };

      U.replace(resultEl, ...notes,
        h('h3', { style: { margin: '14px 0 8px' } }, 'This period, both deposit readings'), h('div.card.tight.wrap-cells', cmp),
        h('h3', { style: { margin: '14px 0 8px' } }, 'Per year and scope · ' + LO.READING_LABEL[dep].toLowerCase()), h('div.card.tight.wrap-cells', yearTbl),
        h('h3', { style: { margin: '14px 0 8px' } }, `Disposals in the period (${U.fmtNum(inP.length, 0)}) · ` + LO.READING_LABEL[dep].toLowerCase()),
        h('div.card.tight', printAll && rows.length > PRINT_MAX ? h('div.small.muted', { style: { padding: '8px 14px' } }, `The newest ${U.fmtNum(PRINT_MAX, 0)} of ${U.fmtNum(rows.length, 0)} disposals are printed; the USDe disposals export lists them all.`) : null, dispTbl,
          !printAll && rows.length > PAGE ? UI.pager({ page, pageSize: PAGE, total: rows.length, onPage: (p) => { page = p; draw(); } }) : null),
        h('h3', { style: { margin: '14px 0 8px' } }, 'Held at the period end · ' + LO.READING_LABEL[dep].toLowerCase()), h('div.card.tight.wrap-cells', poolTbl),
        h('div.metric-list.no-print', { style: { marginTop: '14px' } }, EX.offered('lots', ectx).map((d) => TUI.exBtn(EX.text(d.label, ectx), EX.text(d.sub, ectx), () => save(d), true))));
    };
    const bp = () => { printAll = true; draw(); }, ap = () => { printAll = false; draw(); };
    if (!ctx.signal.aborted) { window.addEventListener('beforeprint', bp); window.addEventListener('afterprint', ap); ctx.onCleanup(() => { window.removeEventListener('beforeprint', bp); window.removeEventListener('afterprint', ap); }); }

    U.replace(card,
      h('div.row.wrap', { style: { marginBottom: '6px' } }, h('h2', 'USDe lots'), UI.chip('on request', ''), h('span.grow')),
      h('p.muted.small', { style: { margin: '0 0 10px', maxWidth: '900px' } }, 'Perps balances are MeridianUSD, which the exchange mints 1:1 when USDe is deposited and burns when it is withdrawn; Meridian Predict settles in USDe. If your rules treat USDe as a cryptoasset rather than money, spending it (fees, losses, funding, Predict stakes) can itself give a gain or loss in your currency, and receiving it (profits, payouts) is an acquisition at its value. These lots match each USDe disposal to the units acquired, by the method and scope you choose. They cover Meridian activity and the opening lots you enter only: USDe held or spent elsewhere is not seen here, and a method that pools a whole holding needs that too.'),
      controls, h('div.dim.xs.no-print', { style: { marginBottom: '4px' } }, 'No method or scope is preselected: which one applies depends on the rules that apply to you (for example FIFO, an average, or the UK\'s same-day, 30-day and s104 pooling), and the choice is yours. Both deposit readings are computed; the select picks the one the detail shows.'),
      scopeNote, lotsEd, statusEl, resultEl,
      h('div.footer-note.print-keep', { style: { textAlign: 'left', paddingBottom: 0 } }, T.DISCLAIMER));
    go();
  };
})();
