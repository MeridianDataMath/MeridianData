/* MeridianDataHub — Tax center: the Meridian Predict card for one wallet and period. Loads the wallet's predictions (the
   API where it answers this site, else the published snapshot; the snapshot file also brings the secondary market, the
   wallet's own redemptions and, for a wallet with more predictions than a file keeps, a row for every prediction), then
   draws from MD.tax.predict: both sides of every prediction, under the date basis chosen in the card (claim by default;
   the select redraws in place and keeps the choice in the link as pdate). Builds DOM only when called. */
(function () {
  const MD = window.MD; const U = MD.util; const UI = MD.ui; const h = U.h;
  const T = MD.tax;
  const VPR = (T.viewPredict = {});
  const MODE_LBL = 'Results dated at';

  /** The wallet's record for the page (network): {pw (the Predict wallet), live, prep, lastAll (the exchange's stats row
   *  of right now, live), builtAt} or {pw, live, missing: true} when the snapshot has no file for it. */
  VPR.load = async function (addr, o = {}) {
    const P = MD.predict, PR = T.predict;
    // the Meridian app places predictions from a smart account the address owns (its Predict wallet), not from the
    // address itself: everything below is that wallet's
    const pw = await P.wallets.predictAddress(addr);
    const w = pw.address;
    const live = await P.live();
    if (live) {
      // the 'now' tiles read the newest stats row: a window of the last two days, rounded to the minute so the cache
      // can hit (a window as long as the period would show the period's last day as 'now', and a year of it is refused:
      // 'Too many buckets (366)')
      const nowSec = Math.floor(Date.now() / 60000) * 60;
      const [acct, raw, tf] = await Promise.all([
        P.account(w, { interval: 'DAY', fromSec: nowSec - 2 * 86400, toSec: nowSec, ttl: 60000, signal: o.signal }).catch((e) => { if (T.isAbort(e)) throw e; return null; }),
        P.predictionsOf(w, { maxPages: 40, signal: o.signal }),
        P.snapshotFile('bettors/' + w + '.json', { signal: o.signal }).catch(() => null)]);
      const lastAll = acct && acct.history.length ? acct.history[acct.history.length - 1] : null;
      // wins paid by a claim on a twin prediction (same token) count as claimed then, as in the snapshot
      // (P.markTokenClaims); claims the snapshot saw through another wallet's twin, and the source-market times, come
      // from the snapshot file (PR.mergeSnapshot), so live and snapshot agree on the claim basis
      const norms = raw.map(P.norm); P.markTokenClaims(norms);
      const fileNorms = tf && Array.isArray(tf.predictions) ? tf.predictions.map(P.unslim) : [];
      PR.mergeSnapshot(norms, fileNorms);
      const truncated = !!raw.truncated;
      let all = norms, cutoff = null;
      if (truncated && fileNorms.length) {
        // the API's newest predictions, and before them what the snapshot has: its rows for the figures, its older
        // predictions on traded pick configurations for the ledger
        cutoff = Math.min(...norms.map((n) => n.t));
        const seen = new Set(norms.map((n) => n.id));
        all = norms.concat(fileNorms.filter((n) => !seen.has(n.id) && n.t < cutoff));
      }
      const prep = PR.prepare({ norms: all, trades: (tf && tf.trades) || [], rd: tf ? tf.rd : undefined, rows: truncated && tf ? tf.rows : null, rowsFmt: tf ? tf.rowsFmt : null, truncated, total: raw.total != null ? raw.total : raw.length, newest: raw.length, cutoff, addr: w, live: true, builtAt: tf ? tf.builtAt : null });
      return { pw, live, prep, lastAll, builtAt: tf ? tf.builtAt : null };
    }
    const f = await P.snapshotFile('bettors/' + w + '.json', { signal: o.signal });
    if (!f) return { pw, live, missing: true };
    const prep = PR.prepare({ norms: f.predictions.map(P.unslim), trades: f.trades || [], rd: f.rd, rows: f.rows, rowsFmt: f.rowsFmt, truncated: !!f.truncated, total: f.total, newest: f.newest, addr: w, live: false, builtAt: f.builtAt });
    return { pw, live, prep, lastAll: null, builtAt: f.builtAt };
  };

  /**
   * card: the Predict card's element; ctx: {addr (the address of the report), period, fname(kind), money, pnlEl, mode
   * (the date basis: MD.tax.predict.modeOf(pdate)), signal, onData(D) (called with VPR.load's result once loaded),
   * onDraw(fctx) (called after every draw with the files' context, under the basis chosen), methodology(file) (a
   * report's methodology rows), importNotes() (the tax-tool import notes)}. Fills the card and resolves to {pnl, pnlC,
   * unclaimedPnl, label} for the summary (it follows the select), or null when the period has nothing.
   */
  VPR.render = async function (card, ctx) {
    const PR = T.predict, TUI = T.ui, EX = T.exports;
    const { period, money, pnlEl, fname } = ctx;
    const { end, tz } = period;
    const D = await VPR.load(ctx.addr, { signal: ctx.signal });
    if (ctx.onData) ctx.onData(D);   // the USDe lots read the same record (its USDe flows: T.predict.cash)
    const { pw, live } = D;
    // an address on screen is shortened; in print it is written out, so the printed record names the wallets in full
    const addrText = (w) => [h('span.no-print', U.shortAddr(w, 4)), h('span.print-only', w)];
    const walletLink = (w) => h('a.addr', { href: '#/predict/bettor?address=' + w, title: w }, addrText(w));
    const via = pw.error ? h('span.small', { style: { color: 'var(--amber)' } }, 'Could not look up the Predict wallet of this address (the Robinhood Chain RPC did not answer): these are only the predictions placed from the address itself. Reload to try again · ')
      : pw.via ? h('span.dim.small', 'Predict wallet ', walletLink(pw.via), ' (the smart account of ', addrText(ctx.addr), ')', pw.also ? h('span', { style: { color: 'var(--amber)' } }, ' · the address itself has predictions of its own too, not in these figures: ', walletLink(pw.also)) : null, ' · ') : null;
    const headRow = (...kids) => h('div.row.wrap', { style: { marginBottom: '10px' } }, h('h2', 'Meridian Predict'), UI.chip('prediction markets', 'accent'), h('span.grow'), via, ...kids);
    // nothing to report: the summary reads a plain zero
    const none = (text) => { card.dataset.pnl = '0'; card.dataset.pnlLabel = 'Predict realized PnL (no activity)'; U.replace(card, headRow(), h('div.empty', text)); return null; };
    if (D.missing) return none('No Meridian Predict activity for this wallet (as of the last snapshot).');
    const { prep, lastAll, builtAt } = D;

    // the card shows when the period has anything: a placement, a result booked under any basis, a sale or purchase, a
    // result decided and not claimed; collateral of right now only when the period reaches today (a past period with
    // nothing in it is empty, whatever the wallet holds now)
    const reachesToday = end >= Date.now() - U.DAY;
    const nowColl = live && lastAll && reachesToday && (lastAll.claimable > 1e-9 || lastAll.deployed > 1e-9);
    if (!PR.hasActivity(prep, period) && !nowColl) {
      return none('No Meridian Predict activity for this wallet in the period.');
    }

    const cmp = PR.compare(prep, period, money);
    const cov = PR.coverageNote(prep);
    // what a file says when it cannot be whole: the period figures (totals) or the per-prediction list (file)
    const notes = { totals: cov && cov.blocking ? cov.text : null, file: PR.fileNote(prep) };
    const sel = h('select.input.sm.no-print', { style: { width: 'auto' }, 'aria-label': MODE_LBL, title: MODE_LBL + ': the date a result is booked at (sales and matched sets are always booked on their own dates)' },
      PR.MODES.map((m) => h('option', { value: m }, PR.MODE_LABEL[m])));
    // print hides the select: the basis in force is written beside its label instead
    const selPrint = h('span.print-only.small');
    const body = h('div');
    const foot = h('div.footer-note.print-keep', { style: { textAlign: 'left', paddingBottom: 0 } });
    const plural = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
    let out = null;
    const draw = (mode) => {
      sel.value = mode; selPrint.textContent = PR.MODE_LABEL[mode];
      const ev = PR.book(prep, mode), tail = PR.tail(prep, mode, period), F = PR.figures(ev, tail, period, money, tz);
      const S = PR.secondary(ev, period, money);
      const tl = F.tail;
      card.dataset.pnl = T.n6(F.pnl);
      card.dataset.pnlLabel = PR.pnlLabel(mode);
      // the summary export names the results decided and not claimed too: outside the figure in claim mode, inside it otherwise
      if (tl.n) { card.dataset.tailPnl = T.n6(tl.pnl); card.dataset.tailLabel = tl.booked ? 'Predict booked, not yet claimed (PnL at the decision, in the figure above)' : 'Predict decided, not claimed (PnL at the decision, not in the figure above)'; }
      else { delete card.dataset.tailPnl; delete card.dataset.tailLabel; }
      const counts = `${F.won} won · ${F.lost} lost` + (F.void ? ` · ${F.void} void` : '');
      // the secondary market's tile shows whenever the period has a sale, a matched set or a purchase (a wallet that only
      // buys tokens has its whole result there); a purchase books nothing by itself
      const secParts = [S.sales ? `${plural(S.sales, 'sale')} · ${money.fmt(S.proceedsC)} proceeds` : null, S.sets ? `${plural(S.sets, 'matched set')} (both sides held)` : null,
        S.buys ? `${S.buys} bought · ${money.fmt(S.paidC)} paid` : null, S.sales ? (S.sets ? 'sales and sets in the realized total' : 'sales in the realized total') : S.sets ? 'sets in the realized total' : 'no sales'].filter(Boolean);
      const tiles = h('div.stats',
        UI.stat('Realized PnL', money.fmt(F.pnlC, { sign: true }), PR.madeOfText(PR.madeOf(ev, prep, mode, period), mode) + ' · in period', U.pnlClass(F.pnl)),
        UI.stat('Winnings', money.fmt(F.winGainC, { sign: true }), 'payout − stake of won predictions', U.pnlClass(F.winGain)),
        UI.stat('Payouts', money.fmt(F.payoutsC), (mode === 'claim' ? 'claimed (paid out) on won predictions' : 'of won predictions booked') + ', stake included'),
        UI.stat('Lost stakes', money.fmt(F.lostStakesC), 'collateral of lost predictions'),
        UI.stat('Wagered', money.fmt(F.wageredC), 'stakes or maker collateral placed in period' + (money.rates ? ', each at its own date\'s rate' : '')),
        UI.stat('Predictions', String(F.placed), `placed in period · ${PR.countsLabel(mode)}: ${counts}`),
        tl.n ? UI.stat(tl.title, money.fmt(tl.pnlC, { sign: true }), `${tl.won} won · ${tl.lost} lost` + (tl.void ? ` · ${tl.void} void` : '') + (tl.booked ? ' · booked in period, in the total, not claimed (paid out) yet' : ' · decided in period, not in the total until claimed (paid out)'), U.pnlClass(tl.pnl)) : null,
        S.sales || S.sets || S.buys ? UI.stat('Secondary market', money.fmt(S.pnlC, { sign: true }), secParts.join(' · '), U.pnlClass(S.pnl)) : null,
        // amounts of right now have no date of their own: the latest rate, named in the tile
        live ? UI.stat('Claimable now', lastAll ? money.now(lastAll.claimable) : '—', lastAll ? 'won, not yet claimed (paid out)' + money.nowTag() : 'the exchange\'s account stats did not answer') : UI.stat('Open stakes now', money.now(PR.openStakes(prep)), 'this wallet\'s collateral in undecided predictions and the position tokens it holds on undecided picks, at cost' + money.nowTag()),
        live ? UI.stat('In open positions', lastAll ? money.now(lastAll.deployed) : '—', 'collateral deployed now' + (lastAll ? money.nowTag() : '')) : UI.stat('Snapshot', U.fmtAgo(builtAt), 'live account stats need API access'));
      const tbl = UI.table({ cols: [
        { key: 'm', label: 'Month', render: (m) => m.label },
        { key: 'p', label: 'Realized PnL', num: true, render: (m) => pnlEl(m.pnlC, m.pnl) },
        { key: 'g', label: 'Winnings', num: true, render: (m) => money.fmt(m.winGainC) },
        { key: 'o', label: 'Payouts', num: true, render: (m) => money.fmt(m.payoutsC) },
        { key: 'l', label: 'Lost stakes', num: true, render: (m) => money.fmt(m.lostStakesC) },
        { key: 'v', label: 'Wagered', num: true, render: (m) => money.fmt(m.wageredC) },
        { key: 'n', label: 'Predictions', num: true, render: (m) => String(m.placed) },
        // token positions held to the verdict are no prediction of the wallet's: counted apart, so a buyer's month with a
        // result does not read 0 / 0 alone
        { key: 'w', label: mode === 'claim' ? 'Claimed won / lost' : 'Booked won / lost', num: true, render: (m) => `${m.won} / ${m.lost}` + (m.void ? ` / ${m.void} void` : '') + (m.held ? ` · ${m.held} held to verdict` : '') },
      ], rows: F.months, empty: 'No activity in this period' });
      // the files come from the exports registry (js/tax/exports.js, section 'predict'), under the basis chosen here;
      // a site report starts with the report's methodology (its Completeness row says what it misses), a tax-tool file
      // with the tool's header; either says it is incomplete in its name (-INCOMPLETE) and in the toast
      const fctx = { prep, fig: F, mode, period, tz, money, fname, notes };
      const save = (d) => { const f = EX.build(d.id, fctx); TUI.save(f, f.kind === 'tool' ? null : ctx.methodology ? ctx.methodology(f) : f.warnings.length ? [['Completeness', f.warnings.join('; ')]] : null); };
      const offered = EX.offered('predict', fctx);
      const cmpLine = h('div.small.dim', { style: { margin: '0 0 10px' } }, 'Realized PnL in this period by date basis: ',
        ...PR.MODES.flatMap((m, i) => [i ? ' · ' : null, h(m === mode ? 'b' : 'span', m + ' ', h('span', { class: 'num ' + U.pnlClass(cmp[m].pnl) }, money.fmt(cmp[m].pnlC, { sign: true })))]).filter(Boolean),
        ` · this report books results ${PR.modeText(mode, prep)}`);
      U.replace(body,
        cmpLine, tiles,
        h('div', { style: { margin: '14px 0' } }, h('div.card.tight', tbl)),
        h('div.metric-list.no-print', offered.map((d) => TUI.exBtn(EX.text(d.label, fctx), EX.text(d.sub, fctx), () => save(d), true)),
          ctx.importNotes && offered.some((d) => d.kind === 'tool') ? TUI.exBtn('Import notes (methodology.txt)', 'How the Koinly and CoinTracking files are made (UTC, tags, the date basis), with this report\'s methodology.', ctx.importNotes, true) : null));
      U.replace(foot, PR.footnote(mode, prep));
      out = { pnl: F.pnl, pnlC: F.pnlC, unclaimedPnl: tl.booked ? 0 : tl.pnl, label: card.dataset.pnlLabel };
      if (ctx.onDraw) ctx.onDraw(fctx);
      return out;
    };
    sel.addEventListener('change', () => { const m = PR.modeOf(sel.value); MD.router.setParams({ pdate: m === PR.DEFAULT ? null : m }, { silent: true }); draw(m); });
    const roleText = prep.coverage.roles.maker && prep.coverage.roles.bettor ? 'both as bettor and as market maker' : prep.coverage.roles.maker ? 'as the market maker' : prep.coverage.roles.bettor ? 'as the bettor' : 'on the secondary market only';
    U.replace(card,
      headRow(h('span.dim.small', MODE_LBL + ' '), sel, selPrint),
      h('div.small.dim', { style: { marginBottom: '8px' } }, (live ? 'From the wallet\'s predictions (collateral now from the exchange\'s account stats)' : 'From the wallet\'s predictions in the published snapshot') + ` · this wallet ${roleText} · USDe`),
      cov ? h('div.small', { style: { color: 'var(--amber)', marginBottom: '10px' } }, cov.text) : null,
      body, foot);
    draw(PR.modeOf(ctx.mode));
    return out;
  };
})();
