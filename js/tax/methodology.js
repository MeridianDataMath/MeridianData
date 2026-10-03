/* MeridianDataHub — Tax center methodology: one record per report of how its figures were made (who, which period in
   which zone, which rates, which conventions and readings, which data, what is missing), as [key, value] rows. The site's
   own report CSVs start with it, the ZIP carries it as methodology.txt and methodology.json beside the files, the
   tax-tool files have it in their import notes (a tool reads its file's first row as the header, so nothing goes before
   it), and the page shows it on screen and in print. Words only, no advice: a treatment is described as what this report
   does, and where the rules differ every reading is computed and named, none as the one that applies. Pure: no DOM, no
   network. */
(function () {
  const MD = window.MD; const U = MD.util; const T = MD.tax; const TZ = T.tz;
  const M = (T.methodology = {});
  const iso = (t) => new Date(U.num(t)).toISOString().replace('T', ' ').slice(0, 19);

  /**
   * The record. ctx: {title, addr, sid, subName, pw ({address, via} or an address: the Predict wallet; null: not looked
   * up), link (this report's address), period (T.periods.resolve), money (T.fx.money), perps (the wallet has a perps
   * subaccount), predict ({mode, live, builtAt, held (T.predict.heldClaimText)} | {missing: true} | {failed: true} |
   * null while loading), lots ({method, scope, dep, valuation {kind, name, rule}, opening (how many lots entered)} once
   * built, else null), rateBasis (how the perps figures convert to the report currency, added to the Rate rule: each
   * part at its own date, and the UTC days still converted whole; null in USD), warnings (what the report found
   * missing), now}.
   */
  M.build = (ctx) => {
    const P = ctx.period, tz = P.tz, money = ctx.money, PR = T.predict, LO = T.lots;
    const pw = ctx.pw && typeof ctx.pw === 'object' ? ctx.pw.address : ctx.pw;
    const pr = ctx.predict, lots = ctx.lots;
    const rows = [
      ['Report', ctx.title || 'Meridian tax records'],
      ['Disclaimer', T.DISCLAIMER],
      ['Wallet', ctx.addr || ''],
      ['Subaccount', ctx.sid ? (ctx.subName ? ctx.subName + ' · ' : '') + ctx.sid : 'none: this wallet has no Meridian perps subaccount'],
      ['Predict wallet', pw ? pw + (ctx.pw && ctx.pw.via ? ' (the smart account the wallet owns, from which the Meridian app places predictions)' : '') : pr && pr.failed ? 'not known (the Predict data did not load)' : 'not looked up yet'],
      ['Report link', ctx.link || ''],
      ['Period', P.label + ': ' + P.startText + ' → ' + P.endText + ' (the end is the first instant after the period)'],
      ['Fiscal year', P.mode === 'year' ? (T.PRESETS[P.preset] || T.PRESETS.cal).label + '; the year is named as that country names it' : 'a custom range of local dates, both included (quarters are calendar quarters)'],
      ['Time zone', tz + (tz === 'UTC' ? '' : ' (' + TZ.zoneLabel(tz, P.start) + ' at the period start)') + ': the period, its months and quarters start at local midnight; local dates in the files are in this zone'],
      ...money.describe(),
      ['Times', 'every fill, settlement, transfer, close and Predict event counts by its exact instant; report files carry UTC and the local time; the daily ledger keeps the exchange\'s UTC days (a day the period\'s boundaries cut is split hour by hour from the hourly ledger; an hour a boundary cuts in its middle counts in the period it starts in); the tax-tool files are in UTC'],
      ['USDe valuation', 'perps balances are MeridianUSD, minted 1:1 when USDe is deposited and burned when it is withdrawn; Meridian Predict settles in USDe; every amount is at 1 USDe = 1 USD' + (lots && lots.valuation && lots.valuation.kind === 'market' ? ', except the USDe lots: ' + lots.valuation.name + ', ' + lots.valuation.rule : '')],
    ];
    // the perps figures' own basis (each part at its own date; the UTC days still converted whole, named) in the Rate rule
    if (ctx.rateBasis) { const r = rows.find((x) => x[0] === 'Rate rule'); if (r) r[1] += '; ' + ctx.rateBasis; }
    if (ctx.perps) rows.push(
      ['Perps disposals', 'one per reducing fill (a reduction, partial close, liquidation or auto-deleverage), on its own date, booked against the position\'s average entry price (the exchange\'s method: replaying the fills that way reproduces each fill\'s realized PnL); each position is its own lot'],
      ['Perps fees', 'a disposal carries its closing fill\'s fee and its share of the opening fees (the fees of the increases still open, shared by quantity closed); fees are inside its result'],
      ['Proceeds and costs', 'disposals and Form 8949: a notional convention (a long\'s cost is its entry notional plus the opening-fee share and its proceeds the exit notional less the closing fee; a short\'s proceeds its entry notional less the opening-fee share and its cost the exit notional plus the closing fee; proceeds − cost = the result either way); gains and losses by class: cash flows per disposal (credits: a positive result, funding received when inside; debits: a negative result, fees, funding paid and position fees when inside), not notional'],
      ['Funding and position fees', 'two readings, computed side by side, neither marked as the one that applies: (a) separate items on their settlement dates (each hourly funding charge settles at the position\'s next fill; mPerp position fees are booked when settled into the balance, at a fill); (b) inside each disposal\'s result (the settlements since the position opened, shared by quantity closed)'],
      ['Holding period', 'held over a year when sold on or after the day after the anniversary of the acquisition, in local dates in ' + tz + ' (the anniversary of 29 Feb is 28 Feb); a disposal averaged over several increases counts from the last of them, which is stricter than counting from the position\'s opening; the Form 8949 statement\'s Part also follows the IRS\'s month-end ruling (Rev. Rul. 66-7, read for one year): an acquisition on the last day of a month is held more than a year only from the first day of the 13th month after it, so an increase on 28 Feb 2027 sold on 29 Feb 2028 is Part I there and held over a year elsewhere'],
    );
    rows.push(['Meridian Predict', !pr ? 'loading' : pr.failed ? 'not available (the Predict data did not load)' : pr.missing ? 'no Meridian Predict record for this wallet'
      : 'both sides of every prediction (as the bettor and as the market maker); results dated ' + PR.MODE_FILE[PR.modeOf(pr.mode)] + ' in this report; also computed beside it: ' + PR.MODES.filter((m) => m !== PR.modeOf(pr.mode)).map((m) => PR.MODE_FILE[m]).join(' and ') + '; secondary-market sales and matched sets on their own dates under every basis; the secondary market at the wallet\'s average cost'
        + (pr.held ? '; on the claim basis, position tokens held to a winning verdict are dated ' + pr.held : '')]);
    if (pr && !pr.failed && !pr.missing) rows.push(['Meridian Predict data', pr.live ? 'the Predict API, live' + (pr.builtAt ? '; source times, claims through twin predictions and redemptions from the published snapshot built ' + iso(pr.builtAt) + ' UTC' : '') : 'the published snapshot' + (pr.builtAt ? ', built ' + iso(pr.builtAt) + ' UTC' : '')]);
    rows.push(['USDe lots', lots ? `${LO.METHOD_LABEL[lots.method]}; ${LO.SCOPE_LABEL[lots.scope].toLowerCase()}; both deposit readings computed (${LO.READINGS.map((r) => LO.READING_LABEL[r].toLowerCase()).join(' and ')}), the page showing ${LO.READING_LABEL[lots.dep].toLowerCase()}; ${lots.opening ? lots.opening + ' opening lot(s) entered' : 'no opening lots entered'}` : 'not computed (on request on the page: choose a lot method and a scope)']);
    rows.push(
      ['Tax-tool files', 'Koinly and CoinTracking files hold one row per event in UTC (a UTC day whose detail is not available: one row of that day\'s total at 10:00 UTC); the perps and the Meridian Predict files are separate, so importing both counts nothing twice'],
      ['Data sources', (ctx.perps ? 'api.meridian.xyz (positions, order fills, position fills, transfers, hourly funding charges, products), archive.meridian.xyz (daily and hourly balance and volume ledger, unrealized PnL); ' : '') + 'Meridian Predict (' + (pr && pr.live ? 'the Predict API and the published snapshot' : 'the published snapshot') + ')' + (money.rates ? '; rates as in the Rate source row' : '') + (lots && lots.valuation && lots.valuation.kind === 'market' ? '; the USDe/USD price from DefiLlama' : '')],
      ['Completeness', ctx.warnings && ctx.warnings.length ? ctx.warnings.join('; ') : 'no truncated read, failed check or netted day was found'],
      ['Generated (UTC)', iso(ctx.now != null ? ctx.now : Date.now())],
      ['Site version', T.VERSION],
    );
    return rows;
  };

  /** The report's identity in one line, printed at its top (the account picker is a form, which print hides): the full
   *  wallet, the subaccount (name and ID), the Predict wallet, the period in its zone with the exact UTC instants, and
   *  when it was generated. ctx: as M.build. */
  M.identity = (ctx) => {
    const P = ctx.period, pr = ctx.predict;
    const pw = ctx.pw && typeof ctx.pw === 'object' ? ctx.pw.address : ctx.pw;
    return [
      'Wallet ' + (ctx.addr || '—'),
      ctx.sid ? 'subaccount ' + (ctx.subName ? ctx.subName + ' (' + ctx.sid + ')' : ctx.sid) : 'no perps subaccount',
      'Predict wallet ' + (pw || (pr && pr.failed ? 'not known (the Predict data did not load)' : 'not looked up yet')),
      P.label + ': ' + P.startText + ' → ' + P.endText,
      'generated ' + iso(ctx.now != null ? ctx.now : Date.now()) + ' UTC',
    ].join(' · ');
  };

  // the rows every record has, which a file's own describe rows never replace
  const GENERIC = new Set(['Report', 'Disclaimer', 'Wallet', 'Subaccount', 'Predict wallet', 'Period', 'Time zone', 'Completeness', 'Generated (UTC)', 'Site version']);
  // a file's own row that heads it, right after the period's zone (the USDe lots' Form 1040 fact line), not with the
  // other new rows before Data sources
  const heads = (k) => !!T.lots && k === T.lots.FACT_ROW_KEY;
  /**
   * The record as one file's first rows: its title in Report, its own completeness (o.warnings: the file's warnings; the
   * record's when left out), and o.extra (a file's own describe rows: a key the record has replaces its value, a new
   * one goes before Data sources, or right after Time zone when it heads the file; the generic rows above stay the
   * record's).
   */
  M.csvRows = (m, title, o = {}) => {
    const rows = m.map((r) => r.slice());
    const set = (k, v) => { const i = rows.findIndex((r) => r[0] === k); if (i >= 0) rows[i] = [k, v]; };
    if (title) set('Report', title);
    if (o.warnings) set('Completeness', o.warnings.length ? o.warnings.join('; ') : 'nothing missing was found in this file\'s data');
    for (const [k, v] of o.extra || []) {
      if (GENERIC.has(k)) continue;
      const i = rows.findIndex((r) => r[0] === k);
      if (i >= 0) { rows[i] = [k, v]; continue; }
      const tz = heads(k) ? rows.findIndex((r) => r[0] === 'Time zone') : -1;
      const at = tz >= 0 ? tz + 1 : rows.findIndex((r) => r[0] === 'Data sources');
      rows.splice(at < 0 ? rows.length : at, 0, [k, v]);
    }
    return rows;
  };

  /**
   * How the tax-tool files are made, for their import notes: [[file, text]]. The vendors' templates as published:
   * Koinly's universal template, support.koinly.io/en/articles/9489976 (updated 2026-06-03), tags from 9490023 and
   * 9490027; CoinTracking's transaction types, cointracking.freshdesk.com 29000042783, and its futures fees guide,
   * 29000051068 (both read 2026-10).
   */
  M.toolNotes = () => [
    ['Import', 'import every tax-tool file as UTC (its times are UTC, written YYYY-MM-DD HH:mm:ss); each file holds nothing but the tool\'s header and its rows'],
    ['Koinly universal CSV', 'header Date, Sent Amount, Sent Currency, Received Amount, Received Currency, Fee Amount, Fee Currency, Net Worth Amount, Net Worth Currency, Tag, Description, TxHash; perps: one "realized gain" row per disposal fill (Received for a gain, Sent for a loss, its closing fee as Fee Amount), "futures fee" for the fee of a fill that closes nothing and for each mPerp position-fee settlement, "funding fee" for each funding settlement (Received or Sent), deposits (Received, net of the deposit fee, no TxHash: the deposit\'s on-chain record is the exchange\'s relayer transaction, not the wallet\'s send) and withdrawals (Sent, the fee as Fee Amount, the transaction that paid the USDe out as TxHash) without a tag, "other fee" for a transfer fee on its own; Meridian Predict: one "realized gain" row per result booked under the report\'s date basis, the claim or trade transaction as TxHash; amounts in USDe; rows that would be exact duplicates (same second, amount, tag and hash) are merged, as Koinly skips exact duplicates'],
    ['CoinTracking CSV', 'header Type, Buy Amount, Buy Cur., Sell Amount, Sell Cur., Fee, Fee Cur., Exchange, Trade-Group, Comment, Date; perps: "Derivatives / Futures Profit" or "Derivatives / Futures Loss" per disposal fill with its closing fee, "Margin Fee" for the fee of a fill that closes nothing and for position fees, funding as "Other Income" (received) or "Other Fee" (paid) in Trade-Group "Funding Rate", "Deposit" and "Withdrawal" per transfer, "Other Fee" for a transfer fee on its own; Meridian Predict: "Derivatives / Futures Profit" or "Loss" per result in Trade-Group "Predict"; amounts in USDe'],
    ['Daily rows', 'a UTC day whose per-event detail is not available or does not add up to the exchange\'s ledger (truncated reads, funding charges that could not be read, a check that failed) is one row of that day\'s ledger total, stamped 10:00 UTC (that keeps its date from UTC−10 to UTC+13); the file\'s name then ends in -INCOMPLETE and the import notes and the download say which'],
    ['Perps and Predict', 'the perps files and the Meridian Predict files are separate (the Predict files are in the Predict section); importing both counts nothing twice'],
  ];

  /** The record as text (methodology.txt): its rows, then o.files ([{name, kind, warnings}]) and o.notes (M.toolNotes). */
  M.text = (m, o = {}) => {
    const title = (m.find((r) => r[0] === 'Report') || [0, 'Meridian tax records'])[1];
    const out = ['MeridianDataHub · ' + title, ''];
    for (const [k, v] of m) out.push(k + ': ' + v);
    if (o.files && o.files.length) {
      out.push('', 'Files');
      for (const f of o.files) out.push('- ' + f.name + ' (' + (f.kind === 'tool' ? 'tax-tool import file: the tool\'s header first, no methodology rows' : 'report: these rows first, then a blank line, then its tables') + ')' + (f.warnings && f.warnings.length ? ': incomplete: ' + f.warnings.join('; ') : ''));
    }
    if (o.skipped && o.skipped.length) { out.push('', 'Not included'); for (const s of o.skipped) out.push('- ' + s); }
    if (o.notes && o.notes.length) { out.push('', 'Tax-tool files'); for (const [k, v] of o.notes) out.push('- ' + k + ': ' + v); }
    return out.join('\r\n') + '\r\n';
  };
  /** The record as JSON (methodology.json): {site, version, generated, record: [{key, value}], files, skipped, toolNotes}. */
  M.json = (m, o = {}) => JSON.stringify({
    site: 'MeridianDataHub', version: T.VERSION, generated: (m.find((r) => r[0] === 'Generated (UTC)') || [0, ''])[1],
    record: m.map(([key, value]) => ({ key, value })),
    files: (o.files || []).map((f) => ({ name: f.name, kind: f.kind, warnings: f.warnings || [] })),
    skipped: o.skipped || [],
    toolNotes: (o.notes || []).map(([key, value]) => ({ key, value })),
  }, null, 2) + '\n';
})();
