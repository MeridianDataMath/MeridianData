/* MeridianDataHub — Tax center core: the MD.tax namespace and what every tax module shares (fiscal-year presets, report
   currencies, CSV writing, the per-tab cache). Pure: no DOM, no network, safe to load in Node (tests/_load.mjs). */
(function () {
  const MD = window.MD; const U = MD.util;
  const T = (MD.tax = MD.tax || {});

  T.VERSION = '2026-10-03.1';   // written into exports and the methodology, so a file says which site built it
  T.DISCLAIMER = 'MeridianDataHub is not a tax adviser. These are records, not tax advice: the rules for perpetual futures, funding and prediction markets differ by country, and no tax is computed here. Use these records with a professional or a tax tool.';

  T.isAbort = (e) => !!e && e.name === 'AbortError';
  T.n6 = (x) => String(Math.round(U.num(x) * 1e6) / 1e6);
  T.cell = U.csvCell;   // quotes, and defuses text that a spreadsheet would run as a formula
  /** cols: [[header, row => value], …] */
  T.toCsv = (cols, rows) => [cols.map((c) => T.cell(c[0])).join(',')].concat(rows.map((r) => cols.map((c) => T.cell(c[1](r))).join(','))).join('\r\n');

  // ---------- fiscal years ----------
  // key → first local day of the fiscal year (m: month index as in Date.UTC, d: day), the zone a report defaults to when the
  // browser's own zone is not in that country (zoneMatch), and endName for years named by the calendar year they end in
  // (South Africa's year of assessment, New Zealand's income year, Pakistan's tax year). The URL's year= is always the
  // calendar year a period starts in, so old links keep working.
  T.PRESETS = {
    cal: { label: 'Calendar year · Jan 1 – Dec 31 (US, EU, CA, JP, EG, …)', m: 0, d: 1, zone: null, zoneMatch: null },
    uk: { label: 'United Kingdom · 6 Apr – 5 Apr', m: 3, d: 6, zone: 'Europe/London', zoneMatch: /^(Europe\/(London|Belfast)|GB|GB-Eire)$/ },
    au: { label: 'Australia · 1 Jul – 30 Jun', m: 6, d: 1, zone: 'Australia/Sydney', zoneMatch: /^Australia\// },   // +8 to +10:30: the browser's own Australian zone wins
    nz: { label: 'New Zealand · 1 Apr – 31 Mar', m: 3, d: 1, zone: 'Pacific/Auckland', zoneMatch: /^(Pacific\/(Auckland|Chatham)|NZ|NZ-CHAT)$/, endName: true },
    in: { label: 'India · 1 Apr – 31 Mar', m: 3, d: 1, zone: 'Asia/Kolkata', zoneMatch: /^Asia\/(Kolkata|Calcutta)$/ },
    za: { label: 'South Africa · 1 Mar – end of Feb', m: 2, d: 1, zone: 'Africa/Johannesburg', zoneMatch: /^Africa\/Johannesburg$/, endName: true },
    pk: { label: 'Pakistan · 1 Jul – 30 Jun', m: 6, d: 1, zone: 'Asia/Karachi', zoneMatch: /^Asia\/Karachi$/, endName: true },   // Egypt taxes the calendar year: old fy=eg links fall back to it
  };

  // ---------- report currencies ----------
  // USD plus every currency the ECB publishes a reference rate for (PLN and CAD also from their own central bank: T.fx);
  // PKR and EGP have no such rate, so a Pakistan or Egypt report uses the USD columns
  T.CCY = ['USD', 'EUR', 'GBP', 'CHF', 'CAD', 'AUD', 'NZD', 'JPY', 'SGD', 'HKD', 'INR', 'KRW', 'BRL', 'MXN', 'ZAR', 'SEK', 'NOK', 'ISK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON', 'TRY', 'ILS', 'PHP', 'THB', 'MYR', 'IDR', 'CNY'];
  T.dp = (ccy) => (['JPY', 'KRW', 'IDR', 'ISK'].includes(ccy) ? 0 : 2);   // decimals a statement in that currency shows

  /** Meridian Predict's launch (ms), read when asked: the Predict scripts may load after this one. */
  T.LAUNCH = () => (MD.predict && MD.predict.LAUNCH_SEC ? MD.predict.LAUNCH_SEC * 1000 : Date.UTC(2026, 5, 29));

  /** Loaded data for this tab (archive ledgers, later fills and charges), keyed by subaccount, kind and range. */
  T.cache = new Map();
})();
