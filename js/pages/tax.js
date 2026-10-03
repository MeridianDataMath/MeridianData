/* MeridianDataHub — Tax center: fiscal-year reports for one subaccount (and the wallet's Predict activity):
   summary, gains/losses, results, costs and transfers by type, monthly / quarterly / per-market breakdowns, every disposal and
   transaction, a report currency at official daily rates, and exports for accountants and tax tools, in the time zone
   the reader chooses. Records only, not advice. This file is the page itself (the account, the period, its controls,
   the notes, the report's methodology on screen and in print, and what sees every section: the summary files, the ZIP
   of everything and the tax-tool import notes); the rest lives in js/tax/ (MD.tax): periods, time zones, exchange
   rates, the archive ledger, the fills and settlements, the Predict record, the USDe lots, the holdings at an instant,
   the summary and classes, the methodology, the ZIP writer, the exports, the perps cards (view-perps), the Holdings
   card (view-holdings), the Predict card (view-predict) and the USDe lots card (view-lots). */
(function () {
  const MD = window.MD; const U = MD.util; const A = MD.api; const UI = MD.ui; const h = U.h;
  const TX = MD.tax; const TZ = TX.tz; const PER = TX.periods; const TUI = TX.ui; const FX = TX.fx;
  const { isAbort } = TX;

  MD.router.pages.tax = {
    async mount(root, route, ctx) {
      MD.setTopbar(h('span.title', 'Tax center'));
      const last = U.storage.get('md.lastAccount', null) || {};
      let addr = String(route.params.address || last.address || '').trim().toLowerCase();
      let subParam = route.params.sub || (addr && addr === String(last.address || '').toLowerCase() ? last.sub : null);

      // ---- account picker ----
      const WALLET = 'Wallet address or subaccount ID', SUB = 'Subaccount';
      const input = h('input.input', { placeholder: 'Wallet address (0x…) or subaccount ID', value: addr, spellcheck: false, 'aria-label': WALLET, title: WALLET });
      const subSel = h('select.input', { style: { display: 'none', width: 'auto' }, 'aria-label': SUB, title: SUB, onchange: (e) => { MD.router.setParams({ sub: e.target.value }); } });
      const pickErr = h('div.small.neg', { style: { minHeight: '16px', marginTop: '6px' } });
      // a new wallet keeps the period (from / to / year / zone) of the link: only an invalid range is dropped, and that one
      // falls back to the fiscal year on its own
      const picker = h('form.row.wrap', { onsubmit: async (e) => {
        e.preventDefault(); pickErr.textContent = '';
        const v = input.value.trim();
        if (U.isAddress(v)) { MD.router.setParams({ address: v.toLowerCase(), sub: null }); return; }
        if (U.isUuid(v)) { try { const sa = await A.subaccount(v); MD.router.setParams({ address: sa.account, sub: sa.id }); } catch (err) { pickErr.textContent = 'Subaccount not found'; } return; }
        pickErr.textContent = 'Enter a 0x wallet address or a subaccount ID';
      } }, h('div.grow', input), subSel, h('button.btn.primary', { type: 'submit' }, 'Load'));
      // print hides the picker (a form): this line names the wallet, subaccount, Predict wallet and period in full instead
      const idLine = h('div.small.print-only', { style: { margin: '0 0 6px', overflowWrap: 'anywhere' } });
      const head = h('div.card',
        h('div.row.wrap', { style: { marginBottom: '6px' } }, h('h2', 'Tax center'), UI.chip('records · not advice', ''), h('span.grow'), MD.defsLink(), h('button.btn.sm.ghost.no-print', { onclick: () => window.print() }, U.icon('printer'), 'Print / PDF')),
        h('p.muted', { style: { margin: '0 0 12px', maxWidth: '900px' } }, 'Tax records for a Meridian wallet (its perps subaccount and its Meridian Predict activity): gains and losses, results, costs and transfers by type, monthly, quarterly and per-market breakdowns, every transaction, and exports for accountants and tax tools, for any fiscal year and in your reporting currency. Periods, dates and times follow the time zone chosen below (every export also carries UTC). Perps balances are MeridianUSD, minted 1:1 when USDe is deposited and burned when it is withdrawn; Meridian Predict settles in USDe; amounts are shown at 1 USDe = 1 USD (USDe lots, further down, value it otherwise on request).'),
        idLine, picker, pickErr);
      const body = h('div.stack');
      U.replace(root, h('div.page', h('div.stack', head, body)));

      if (!U.isAddress(addr)) { U.replace(body, h('div.card', h('div.empty', 'Enter a wallet address above, or open any account page and press "Tax" in its header.'))); return; }

      // ---- resolve subaccount ----
      let subs, sa, ref;
      try { [subs, ref] = await Promise.all([A.subaccountsOf(addr, ctx), A.ref(ctx)]); }
      catch (e) { if (isAbort(e)) return; U.replace(body, UI.error(e, () => MD.router.reload())); return; }
      sa = subs.length ? (subs.find((s) => s.id === subParam) || subs[0]) : null;
      if (subs.length > 1) { subSel.style.display = ''; U.replace(subSel, subs.map((s) => h('option', { value: s.id, selected: s.id === sa.id }, U.decodeBytes32(s.name)))); }
      const sid = sa ? sa.id : null;

      // ---- period: fiscal-year preset + year, or a custom range, from local midnight in the chosen zone ----
      const now = Date.now();
      // Predict activity can predate the perps subaccount: the year list starts at Meridian Predict's launch at the latest
      const period = PER.resolve(route.params, { firstT: sa ? (U.num(sa.createdAt) || now) : now, now, browserZone: TZ.browser() });
      const { mode, preset: fy, year, years, tz, start, end, label } = period;
      // the zone a report defaults to is written into the link, so a shared link reports the same instants
      if (route.params.tz !== tz && !ctx.signal.aborted) MD.router.setParams({ tz }, { silent: true });
      const ccy = TX.CCY.includes(route.params.ccy) ? route.params.ccy : (U.storage.get('md.tax.ccy', 'USD') || 'USD');
      // PLN and CAD have their own central bank's rates by default; src=ecb (the Rate source select) picks the ECB's
      const srcChoices = FX.choices(ccy), src = srcChoices && route.params.src === 'ecb' ? 'ecb' : null;
      // every control is named by the same text it shows
      const FY_LBL = 'Fiscal year', TZ_LBL = 'Time zone', CCY_LBL = 'Report in', SRC_LBL = 'Rate source', FROM = `From (${tz})`, TO = `To (${tz})`;
      const fySel = h('select.input.sm', { style: { width: 'auto' }, 'aria-label': FY_LBL, title: FY_LBL, onchange: (e) => MD.router.setParams({ fy: e.target.value === 'cal' ? null : e.target.value, from: null, to: null, tz: null }) }, Object.entries(TX.PRESETS).map(([k, v]) => h('option', { value: k, selected: k === fy }, v.label)));
      const zones = TZ.list(); if (!zones.includes(tz)) zones.splice(1, 0, tz);
      const tzSel = h('select.input.sm', { style: { width: 'auto', maxWidth: '230px' }, 'aria-label': TZ_LBL, title: TZ_LBL + ': the period, its months and quarters, and every local date and time', onchange: (e) => MD.router.setParams({ tz: e.target.value }) }, zones.map((z) => h('option', { value: z, selected: z === tz }, z)));
      const yearSeg = UI.seg(years.map((y) => ({ v: y, label: PER.yearName(fy, y), title: PER.fyLabel(fy, y) })), mode === 'year' ? year : null, (y) => MD.router.setParams({ year: y, from: null, to: null }), 'sm');
      // the inputs show the period in force, never a range the link had that was refused
      const fromIn = h('input.input.sm', { type: 'date', value: period.fromKey, 'aria-label': FROM, title: FROM, style: { width: 'auto' } });
      const toIn = h('input.input.sm', { type: 'date', value: period.toKey, min: period.fromKey, 'aria-label': TO, title: TO, style: { width: 'auto' } });
      fromIn.addEventListener('change', () => { toIn.min = fromIn.value || ''; });
      const apply = () => {
        const f = fromIn.value, t = toIn.value;
        if (f && t && f <= t) MD.router.setParams({ from: f, to: t, year: null });
        else U.toast(!f || !t ? 'Choose both a start and an end date' : 'The start date must be on or before the end date');
      };
      const ccySel = h('select.input.sm', { style: { width: 'auto' }, 'aria-label': CCY_LBL, title: 'Reporting currency, at official daily rates: ' + FX.MAP_TEXT, onchange: (e) => { U.storage.set('md.tax.ccy', e.target.value); MD.router.setParams({ ccy: e.target.value === 'USD' ? null : e.target.value, src: null }); } }, TX.CCY.map((c) => h('option', { value: c, selected: c === ccy }, c)));
      const srcSel = srcChoices ? h('select.input.sm', { style: { width: 'auto' }, 'aria-label': SRC_LBL, title: SRC_LBL + ' for ' + ccy + ': ' + srcChoices.map((x) => x.label + ' (' + FX.SOURCES[x.v].ruleLong + ')').join(' or '), onchange: (e) => MD.router.setParams({ src: e.target.value === 'ecb' ? 'ecb' : null }) }, srcChoices.map((x) => h('option', { value: x.v, selected: x.v === FX.sourceFor(ccy, src) }, x.label))) : null;
      const controls = h('div.card.no-print', h('div.row.wrap', { style: { rowGap: '10px' } },
        h('span.dim.small', FY_LBL), fySel, h('span.dim.small', TZ_LBL), tzSel, yearSeg, h('span.dim.small', `or custom (${tz})`), fromIn, h('span.dim', '→'), toIn,
        h('button.btn.sm', { onclick: apply }, 'Apply'),
        h('span.grow'), h('span.dim.small', CCY_LBL), ccySel, srcSel ? h('span.dim.small', SRC_LBL) : null, srcSel),
        h('div.dim.xs', { style: { marginTop: '8px', textAlign: 'right' } }, FX.ONLY_TEXT));
      const notices = [
        period.badRange ? TUI.notice(`The custom range in this link (${period.from || '?'} → ${period.to || '?'}) is not a valid period; showing ${label}.`) : null,
        period.yearMissing ? TUI.notice(`No Meridian activity in ${PER.fyLabel(fy, period.reqYear)} (before Meridian Predict launched on ${TZ.fmt(TX.LAUNCH(), 'UTC', 'short')}, or not started yet); showing ${label}.`) : null,
      ].filter(Boolean);
      // a backstop: a period that ends before it starts still leaves the controls to pick another
      if (!(end > start)) { U.replace(body, controls, ...notices, h('div.card', h('div.error', 'Invalid period.'))); return; }
      const status = h('div.card', UI.loading('Collecting daily ledgers and position history…'));
      U.replace(body, controls, ...notices, status);
      const periodLine = h('div.small.dim', { style: { marginBottom: '10px' } }, 'Period ', period.startText, ' → ', period.endText, period.ongoing && mode === 'custom' ? ' (not over yet)' : '');

      // ---- money: each amount at the rate of its own local date, from its currency's source (MD.tax.fx); CSVs always carry
      // USD and, when another currency is chosen, the converted amount with its rate and the rate's date ----
      let rates = null, fxNote = null;
      if (ccy !== 'USD') {
        // rates are needed from the first day anything can have happened (the subaccount's creation, or Predict's launch),
        // whatever the period: the USDe lots and the Predict record convert amounts dated before it. A date before the
        // first rate has none (FX.rates), never a later one in its place
        try { rates = await FX.load({ ccy, src, fromKey: FX.fromKey({ createdAt: sa ? sa.createdAt : null, now, tz }), toKey: period.toKey, tz, now, signal: ctx.signal }); }
        catch (e) { if (isAbort(e)) return; fxNote = 'Rates for ' + ccy + ' could not be loaded (' + e.message + '); amounts are in USD.'; }
        if (rates) for (const n of rates.notes) notices.push(TUI.notice(n.text));   // a step down to another source, said at the top
      }
      const cur = rates ? ccy : 'USD';
      const money = FX.money(rates, tz);
      const pnlEl = TUI.pnlEl(money);
      const fname = (kind) => `meridian-${kind}-${U.shortAddr(addr, 4).replace('…', '-')}-${period.fromKey}_${period.toKey}.csv`;
      const EX = TX.exports, M = TX.methodology;
      let vp = null, hv = null;

      // ---- the report's state: what the methodology, the summary, the classes and the ZIP read as it arrives ----
      // predict: the Predict card's data (view-predict's load; null while loading); predictCtx: its files' context under
      // the basis chosen on the card; lots: the USDe lots once built
      const rep = { pw: null, predict: null, predictFailed: false, predictMode: TX.predict.modeOf(route.params.pdate), predictCtx: null, lots: null };
      let predictLoaded = null; const predictData = new Promise((r) => { predictLoaded = r; });
      let predictReady = Promise.resolve();
      // held: how the claim basis dates tokens held to a winning verdict (the wallet's own redemption times, or the fallback)
      const predictInfo = () => (rep.predict ? (rep.predict.missing ? { missing: true } : { mode: rep.predictMode, live: rep.predict.live, builtAt: rep.predict.builtAt, held: TX.predict.heldClaimText(rep.predict.prep) }) : rep.predictFailed ? { failed: true } : null);
      // the Predict record for the summary and the classes: {prep, mode}, {missing}, or {failed} when it did not load
      const predictState = async () => { const D = await predictData; return !D ? { failed: true } : D.missing ? { missing: true } : { prep: D.prep, mode: rep.predictMode }; };
      // what the report found missing, for the methodology's Completeness row (each section says it once)
      const allWarnings = () => {
        const w = vp ? vp.warnings().slice() : [];
        if (hv) for (const x of hv.warnings()) if (!w.includes(x)) w.push('holdings: ' + x);
        if (rep.predict && rep.predict.prep) { const cov = TX.predict.coverageNote(rep.predict.prep); if (cov && cov.blocking) w.push(cov.text); }
        if (rep.predictFailed && !rep.predict) w.push('the Meridian Predict data did not load');
        if (rep.lots && rep.lots.warnings) for (const x of rep.lots.warnings) w.push('USDe lots: ' + x);
        return Array.from(new Set(w));
      };
      const recCtx = (title) => ({ title, addr, sid: sa ? sa.id : null, subName: sa ? U.decodeBytes32(sa.name) : null, pw: rep.pw, link: String(location.href), period, money, perps: !!sa, predict: predictInfo(), lots: rep.lots, rateBasis: vp ? vp.rateBasis() : null, warnings: allWarnings(), now: Date.now() });
      const record = (title) => M.build(recCtx(title));
      // a site report's first rows: the record, titled by the file, with the file's own completeness and describe rows
      const meth = (file, extra) => M.csvRows(record(), file.label || file.name, { warnings: file.warnings || [], extra: extra || file.extra });
      // the summary files' context: the perps part once its detail is in (or failed), then the holdings (their funding
      // not settled at a past instant needs that detail), the Predict record alongside (T.summary.gather)
      const summaryCtx = async () => {
        const { perps, hold, predict } = await TX.summary.gather({ perps: vp ? () => vp.summaryPerps() : null, hold: hv ? () => hv.summaryRows().catch(() => []) : null, predict: predictState });
        return { period, tz, money, fname, perps, D: perps ? perps.D : null, hold, predict, lots: rep.lots, warnings: allWarnings() };
      };
      // every file of the report in one ZIP, with methodology.txt and methodology.json beside them
      const zipAll = async () => {
        const sc = await summaryCtx();
        const items = EX.offered('summary', sc).map((d) => EX.build(d.id, sc)), skipped = [];
        if (vp) { items.push(...await vp.files()); skipped.push(...vp.skipped()); }
        await predictReady;
        if (rep.predictCtx) items.push(...EX.offered('predict', rep.predictCtx).map((d) => EX.build(d.id, rep.predictCtx)));
        else skipped.push('Meridian Predict files (' + (rep.predictFailed ? 'the Predict data did not load' : 'no Meridian Predict activity in the period') + ')');
        if (hv) { const x = await hv.fileParts(); items.push(Object.assign(x.file, { extra: x.extra })); }
        if (rep.lots && rep.lots.files) { const x = rep.lots.files(); for (const d of EX.offered('lots', x.ectx)) items.push(Object.assign(EX.build(d.id, x.ectx), { extra: x.extra })); }
        else skipped.push('USDe lots files (not computed: choose a lot method and a scope in the USDe lots card)');
        const rec = record('Meridian tax records: every file of this report');
        const entries = EX.bundle(items.map((f) => ({ file: f, meth: f.kind === 'tool' ? null : M.csvRows(rec, f.label, { warnings: f.warnings, extra: f.extra }) })), rec, { skipped });
        const bad = items.filter((f) => f.warnings.length).length;
        TUI.download(fname('tax-records').replace(/\.csv$/, '.zip'), TX.zip.build(entries, new Date()), { type: 'application/zip', warn: bad ? [bad + ' file(s) incomplete, as methodology.txt in the ZIP says'] : null });
      };
      // the tax-tool files' import notes: a tool reads its file's first row as the header, so their methodology is here
      const importNotes = async () => {
        const tools = vp ? await vp.toolFiles() : [];
        await predictReady;
        if (rep.predictCtx) for (const d of EX.offered('predict', rep.predictCtx)) if (d.kind === 'tool') tools.push(EX.build(d.id, rep.predictCtx));
        const text = M.text(record('Import notes for the tax-tool files'), { files: tools.map((f) => ({ name: EX.fileName(f), kind: f.kind, warnings: f.warnings })), notes: M.toolNotes() });
        TUI.download(fname('methodology').replace(/\.csv$/, '.txt'), text, { type: 'text/plain;charset=utf-8' });
      };
      // the methodology on screen (in the notes card, drawn when opened) and in print (a block only print shows)
      const methScreen = h('div', { style: { marginTop: '8px' } }), methPrint = h('div');
      const drawMeth = (el) => U.replace(el, TUI.methodologyEl(record('Meridian tax records')));
      // on screen only: print has the whole record in its own block below
      const methDetails = h('details.no-print', { style: { marginTop: '12px' }, ontoggle: (e) => { if (e.target.open) drawMeth(methScreen); } },
        h('summary.small', { style: { cursor: 'pointer', color: 'var(--text-2)' } }, 'Methodology of this report · the same rows start every report file'), methScreen);
      const printBlock = h('div.card.print-only', h('h3', { style: { marginBottom: '10px' } }, 'Report identity and methodology'), methPrint);
      const drawId = () => { idLine.textContent = M.identity(recCtx()); };
      const refresh = () => { if (methDetails.open) drawMeth(methScreen); drawMeth(methPrint); drawId(); if (vp) vp.refreshClasses(); };
      const bpMeth = () => { drawMeth(methPrint); drawId(); };   // the generated time is the print's
      if (!ctx.signal.aborted) { window.addEventListener('beforeprint', bpMeth); ctx.onCleanup(() => window.removeEventListener('beforeprint', bpMeth)); }
      // the Predict card (js/tax/view-predict.js), under the date basis of the link (pdate; the claim by default)
      // the USDe lots read the Predict card's record once it is loaded (null when it cannot be)
      const pctx = { addr, period, fname, money, pnlEl, mode: rep.predictMode, signal: ctx.signal, methodology: meth, importNotes,
        onData: (D) => { rep.predict = D; rep.pw = D && D.pw ? D.pw : null; predictLoaded(D); refresh(); },
        onDraw: (fc) => { rep.predictCtx = fc; rep.predictMode = fc.mode; refresh(); } };
      const predictFail = (el) => (e) => { rep.predictFailed = true; predictLoaded(null); if (!isAbort(e)) U.replace(el, h('div.row', h('h2', 'Meridian Predict')), UI.error(e)); refresh(); };
      // converting a USD amount at its date's rate leaves out what USDe itself gained or lost in that currency between
      // receiving and spending it: said under the rate line, and computed by the lots card on request
      const fxOnly = rates ? h('div.dim.xs', { style: { marginTop: '2px' } }, `Each amount is converted at its own date's rate; a change in USDe's own value in ${ccy} between receiving and spending it is not in these figures (USDe lots, below, computes it on request).`) : null;
      const fxLine = rates ? h('div', h('div.small.dim', { style: { marginTop: '6px' } }, money.line(period)), fxOnly) : fxNote ? h('div.small.neg', { style: { marginTop: '6px' } }, fxNote) : null;
      // the USDe lots card (js/tax/view-lots.js): on request, after the Predict card; once built, the Holdings card shows
      // the lots held at the period's start and end, and the summary, the classes and the ZIP include them
      const lotsCard = h('div.card');
      const lctx = { addr, sa, ref, period, money, fname, params: route.params, predict: () => predictData, signal: ctx.signal, onCleanup: (fn) => ctx.onCleanup(fn), methodology: meth,
        onResult: (L) => { if (hv) hv.setLots(L); rep.lots = L; refresh(); } };
      // the Holdings card (js/tax/view-holdings.js): what was held at the period's start and end
      const holdCard = h('div.card');
      const hctx = { addr, sid: sa ? sa.id : null, ref, period, money, fname, now, led: null, positions: [], upnl: null, predict: () => predictData, signal: ctx.signal, methodology: meth };

      if (!sa) {
        // Predict-only wallet: no perps ledgers, but the prediction-market section, the holdings, the lots, the summary,
        // the methodology and the ZIP still apply
        const predictOnly = h('div.card', h('div.row', h('h2', 'Meridian Predict'), UI.chip('prediction markets', 'accent')), h('div.empty', h('span.loading', h('span.spinner'), 'Loading Predict history…')));
        const sc0 = { period, tz, money };
        const runSummary = async (d) => { const sc = await summaryCtx(); const f = EX.build(d.id, sc); TUI.save(f, meth(f, f.extra)); };
        const exportsOnly = h('div.card.no-print', h('h3', { style: { marginBottom: '4px' } }, 'Exports (CSV)'),
          h('p.dim.small', { style: { margin: '0 0 12px' } }, EX.cardText({ money, tz, sections: ['summary'] }) + ' The Predict section above has its own files.'),
          h('div.metric-list', ...EX.offered('summary', sc0).map((d) => TUI.exBtn(EX.text(d.label, sc0), EX.text(d.sub, sc0), () => runSummary(d), true)),
            TUI.exBtn('Import notes (methodology.txt)', 'How the Meridian Predict Koinly and CoinTracking files are made (UTC, tags, the date basis), with this report\'s methodology.', importNotes, true),
            TUI.exBtn('Download everything (ZIP)', 'Every file of this report (Meridian Predict under its card\'s date basis, the summary, holdings, the USDe lots once built), plus methodology.txt and methodology.json; it waits for the Predict data.', zipAll, true)));
        U.replace(body, controls, ...notices, h('div.card', h('div.empty', 'This wallet has no Meridian perps subaccount, so there are no perps ledgers to report. Prediction-market activity is below.'), periodLine, fxLine), predictOnly, lotsCard, holdCard, exportsOnly,
          h('div.card', h('div.footer-note.print-keep', { style: { textAlign: 'left', padding: 0 } }, TX.DISCLAIMER), methDetails), printBlock);
        hv = TX.viewHoldings.render(holdCard, hctx);
        predictReady = TX.viewPredict.render(predictOnly, pctx).catch(predictFail(predictOnly));
        TX.viewLots.render(lotsCard, lctx);
        refresh();
        return;
      }

      // ---- data: the archive cut at the period's local boundaries, and the positions ----
      let positions, led, arch;
      const ac = new AbortController(); const stop = () => ac.abort();
      ctx.signal.addEventListener('abort', stop); ctx.onCleanup(() => ctx.signal.removeEventListener('abort', stop));
      const prog = TUI.progress(status, stop);
      prog.set('Collecting daily ledgers and position history…');
      try {
        const [a, pos] = await Promise.all([
          TX.load.archive(sid, period, { signal: ac.signal, progress: (stage, done, total) => prog.set(stage === 'daily' ? 'Collecting daily ledgers and position history…' : 'Reading the hourly ledger of the UTC days the period\'s local boundaries cut…', done, total) }),
          A.positions(sid, { maxPages: 100, signal: ac.signal, ttl: 5 * 60000 }),   // the same pages the trade detail reads
        ]);
        arch = a; positions = pos;
        led = TX.ledger.build({ balance: arch.balance, volume: arch.volume, hour: arch.hour, ref, period, fx: money.fx });
      } catch (e) {
        if (ctx.signal.aborted) return;
        U.replace(status, isAbort(e) ? h('div.empty', 'Cancelled. ', h('button.btn.sm', { onclick: () => MD.router.reload() }, 'Load again')) : UI.error(e, () => MD.router.reload()));
        return;
      }

      const fyStartText = mode === 'year' ? period.startText : null;
      const info = h('div.card', h('h3', { style: { marginBottom: '10px' } }, 'What counts on Meridian'),
        h('div.note-grid',
          h('div.it', h('div.t', 'Realized PnL'), h('div.d', 'Booked whenever a position is reduced or closed, including liquidations and auto-deleveraging. The period totals use the exchange\'s settled ledger. The disposals list each reduction, partial close, liquidation or auto-deleverage on its own date, from the position\'s fills (liquidation and auto-deleverage fills read from the position itself); together they add up to the ledger, which the page checks UTC day by UTC day and names any day that does not. Closed positions sums each position fully closed in the period over its whole life.')),
          h('div.it', h('div.t', 'Gains, losses and holding periods'), h('div.d', `Each reduction of a position is booked against the position's average entry price (the exchange's method: replaying the fills that way reproduces every fill's realized PnL) and listed as its own disposal row; the closed-positions table sums them per position. FIFO or LIFO within a position would split a result differently between periods, when a position is reduced in one period and closed in a later one. The fills export lists every fill's price and quantity, liquidation and ADL fills included. A disposal is flagged as held over a year when the last increase it is averaged over was more than a year before it, in calendar dates in ${tz} (sold after the anniversary; the anniversary of 29 Feb is 28 Feb), which is stricter than counting from the position's opening; a closed position, when it was closed more than a year after it opened. The Form 8949 statement's Part also follows the IRS's month-end ruling (Rev. Rul. 66-7, read for one year): an increase on the last day of a month is held more than a year only from the first day of the 13th month after it (28 Feb 2027 → 1 Mar 2028).`)),
          h('div.it', h('div.t', 'Funding'), h('div.d', 'Charged every hour while a position is open, and settled into the balance at the position\'s next fill (an increase, a reduction or the close), so the hourly charges between two fills settle as one amount, received or paid. Received and paid are each the sum of those settlements, per position, never netted across positions or days; each UTC day\'s settlements are checked against the exchange\'s ledger, and a day that does not add up (charges that could not be read) is netted per day, said where it happens. Funding and position fees are shown two ways side by side, and neither is marked as the one that applies: as separate items on their settlement dates, or inside each disposal\'s result (the settlements since the position opened, shared by the quantity closed).')),
          h('div.it', h('div.t', 'Fees'), h('div.d', 'Taker / maker trading fees on every fill (the exchange\'s daily fee line); a disposal carries its closing fill\'s fee and its share of the opening fees (the fees of the increases still open, shared by the quantity closed). Position fees on mPerp markets (XAU, XAG, SPY, QQQ), which the fee line leaves out: they are the mPerp pool\'s balance change that no other ledger entry explains, booked when the exchange settles them into the balance (at a fill of the position), like funding, and attributed to the fills of that pool in the hour they settled in (by notional, when two positions were filled in that hour). Withdrawal / deposit fees are shown inside withdrawals and as their own line.')),
          h('div.it', h('div.t', 'Deposits, withdrawals, conversions'), h('div.d', 'A deposit wraps USDe into MeridianUSD 1:1 and a withdrawal unwraps it; a conversion between pools (the USD pool and an mPerp pool, internal balances of the same MeridianUSD) moves no token on chain. They move collateral, not results, and are listed so the balance reconciles; whether a deposit, withdrawal or conversion is a disposal depends on the rules that apply to you. The USDe lots card computes both readings of deposits and withdrawals, and reads a conversion as a move of its lots (their acquisition dates and cost kept), never as a disposal.')),
          h('div.it', h('div.t', 'Currency and rates'), h('div.d', `Perps balances are MeridianUSD, which the exchange mints 1:1 when USDe is deposited and burns when it is withdrawn; Meridian Predict settles in USDe. Amounts are shown at 1 USDe = 1 USD. If your rules treat USDe as a cryptoasset rather than money, spending it (fees, funding, losses, Predict stakes) can itself give a gain or loss in your currency. The USDe lots card computes that part on request, by the lot method and scope you choose, for Meridian activity and the opening lots you enter only (USDe held elsewhere is not seen here). A reporting currency converts each amount at the rate of its own local date in ${tz}, from the source set for that currency: ${FX.MAP_TEXT}. ` + (rates ? `This report: ${rates.src.name}, ${rates.src.ruleLong}; ${rates.src.holidays}` + (rates.src.cross ? ` (${rates.src.cross})` : '') + '. ' : '') + 'Until the rate a date takes is published (the ECB around 16:00 CET, NBP around noon in Warsaw, the Bank of Canada by 16:30 in Ottawa), that date uses the one before it; the next update replaces it. Once the trade detail is loaded, each fill, settlement and transfer converts at its own date, and the period, monthly and quarterly totals add those same amounts; until then, and on a UTC day whose detail does not add up to the exchange\'s ledger, the day converts whole at the rate of the local date holding its middle (the methodology\'s Rate rule says which); a disposal\'s result and notional legs convert at its own date, its opening-fee share and the funding and position fees carried into it at the dates they were paid; closed positions at the close date; amounts of right now (claimable, unrealized) at the latest rate. A date before the first published rate has none: nothing is converted there, and the cell says so. The official series are read from the central banks each time the site is published (data/fx); where one is missing the page says so and uses the ECB\'s rates, from frankfurter.dev when needed. Every converted amount in the exports carries its rate and the rate\'s date. ' + FX.ONLY_TEXT + ' If your rules prescribe a rate source or rate date this page does not implement (for example India\'s Rule 115: the SBI telegraphic-transfer buying rate of the last day of the month before), use the USD columns in the exports.')),
          h('div.it', h('div.t', 'Time zone and quarters'), h('div.d', `Periods run in ${tz}: ` + (fyStartText ? `this fiscal year starts ${fyStartText}, ` : '') + 'a period runs from 00:00 local time on its first day to 00:00 on the day after its last, months and quarters are cut at local midnight too, and a fiscal year\'s quarters run from its first day in three-month steps (6 Apr – 5 Jul for the UK); a custom range shows calendar quarters. Fills, settlements, transfers, position closes and Predict placements, claims and sales count by their exact time. The exchange keeps its ledger per UTC day: a UTC day that a boundary cuts is split hour by hour from its hourly ledger, and in a zone that is not a whole number of hours from UTC (India, Adelaide, Newfoundland) the hour a boundary cuts in its middle counts in the period it starts in. The daily ledger export keeps UTC days, with those days in parts.'))),
        h('div.footer-note.print-keep', { style: { textAlign: 'left', paddingBottom: 0 } }, TX.DISCLAIMER), methDetails);

      const predictCard = h('div.card', h('div.row', h('h2', 'Meridian Predict'), UI.chip('prediction markets', 'accent')), h('div.empty', h('span.loading', h('span.spinner'), 'Loading Predict history…')));
      // the archive's unrealized PnL at the period's start and end (or now): one small read each, for the Holdings card
      // and the Open at period end tile
      const HO = TX.holdings;
      const specs = HO.instants(period, now).map((x) => HO.archiveRow(x.t, { now, fallbackDays: led.fallbackDays }));
      const upnl = TX.load.upnl(sid, specs, { signal: ctx.signal });
      upnl.catch(() => {});   // each reader says what failed
      hv = TX.viewHoldings.render(holdCard, Object.assign(hctx, { led, positions, upnl }));
      // the perps cards (js/tax/view-perps.js): the ledger figures at once, the per-fill detail loading right after
      vp = TX.viewPerps.render({ sa, sid, addr, ref, period, money, pnlEl, rates, cur, fname, positions, led, arch, now, fxLine, signal: ctx.signal, onCleanup: (fn) => ctx.onCleanup(fn),
        upnlEnd: upnl.then((r) => { const u = HO.upnlOf(r[1]); return u && u.found ? u.total : null; }).catch(() => null),
        holdingsCard: holdCard, onDetail: (ev, D, err, o) => { hv.setDetail(ev, D, err, o); refresh(); },
        // the summary files, the methodology rows, the classes' other sections, the ZIP and the import notes come from the
        // page, which sees every section
        summaryCtx, methodology: meth, zip: zipAll, importNotes,
        classExtras: () => ({ predict: rep.predict && rep.predict.prep ? { prep: rep.predict.prep, mode: rep.predictMode } : null, lots: rep.lots }) });
      U.replace(body, controls, ...notices, ...vp.cards, predictCard, lotsCard, info, printBlock);
      vp.start();
      predictReady = TX.viewPredict.render(predictCard, pctx).catch(predictFail(predictCard));
      TX.viewLots.render(lotsCard, lctx);
      refresh();
    },
  };
})();
