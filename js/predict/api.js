/* MeridianDataHub — Meridian Predict (Sapience) GraphQL client. Read-only, public, no auth. */
(function () {
  const MD = window.MD; const U = MD.util;
  const P = (MD.predict = MD.predict || {});
  P.URL = 'https://api.predict.meridian.xyz/graphql';
  P.ESCROW = '0xe4cea507b19796362a5a28fa7cb705a3f1866213';
  P.SECONDARY_ESCROW = '0x7e318ef37c3bc3d0cba205af2d1fc9f9cefeb5df';
  P.CHAIN = 4663;
  P.PAGE = 25;                        // hard cap of the API
  P.LAUNCH_SEC = 1782691200;          // 2026-06-29 00:00 UTC, day before the first prediction
  // where Meridian's app starts a wallet's all-time history (its Predict portfolio: All Time P&L sums the daily account
  // history from 2026-06-22). A live wallet page reads from here, so its PnL is the app's: the launch-day tests below are
  // booked on 06-26 and 06-28 (0xd461…: −$8.86 from here, −$9.21 from the launch)
  P.EXCHANGE_START_SEC = 1782086400;  // 2026-06-22 00:00 UTC
  /** The launch-day test predictions, dated on-chain before P.LAUNCH_SEC (the API files them there, with no questions
   *  attached; their createdAt reads 2026-06-30): the snapshot leaves them out, while the app's figures count them. A
   *  closed set: read 2026-10-05, the 15 the snapshot's preLaunch counts, every one against 0xa386…642e. Per wallet: n
   *  predictions, v its own collateral in them (what the app's Volume adds). A page from the snapshot says what it leaves
   *  out with these. */
  P.PRE_LAUNCH = {
    '0xd4612bd63dbe6beea4a5c8fecb5011ddbd8fb976': { n: 9, v: 9 },
    '0x06b96f1c2ebe7090b67f44e1bd632eb6cece7524': { n: 3, v: 3 },
    '0xcfe62de3d326483be5ce261005e87fbb65175631': { n: 2, v: 2 },
    '0x9b5b33cd190a97d152ad4a2caa06aca8d076af0d': { n: 1, v: 0.53 },
    '0xa3868b2baf1fd8e1baf036abf5055815563b642e': { n: 15, v: 1.010346939, maker: true },
  };
  P.preLaunchOf = (addr) => P.PRE_LAUNCH[String(addr || '').toLowerCase()] || null;
  P.APP_URL = 'https://app.meridian.xyz/predict?ref=' + MD.api.REF;
  P.CLAIM_URL = 'https://app.meridian.xyz/portfolio/prediction-stats?ref=' + MD.api.REF;   // the app's Predict portfolio: "Claimable Payout" and its claim button
  /** A prediction id as the exchange writes it (and as a slip link carries it). */
  P.isPredictionId = (id) => /^0x[0-9a-f]{64}$/i.test(String(id || ''));
  /** Meridian's own page for one prediction ("Shared Prediction"): its Add To Slip button loads the same picks into the
   *  visitor's bet slip. The app keeps ?ref= as the pending referral code (checked 2026-09-29: localStorage
   *  pending-referral-code), so a slip copied from here brings the visitor in under the site's code. */
  // ref: the referral code a shared slip's link carried (?r=, the slip page only): that slip's Meridian link takes it
  P.meridianSlipUrl = (id, ref) => (P.isPredictionId(id) ? 'https://app.meridian.xyz/predict/p/' + String(id).toLowerCase() + '?ref=' + (MD.util.refCode(ref) || MD.api.REF) : P.APP_URL);
  /** A page of the app's Predict section: '/<condition id or group id>' a question or group, '/event/<event id>' a match,
   *  '/competitions/<slug>' a competition, '/leaderboard' with `query` (e.g. 'cycle=3') its monthly leaderboard */
  P.appPageUrl = (path, query) => 'https://app.meridian.xyz/predict' + (path || '') + '?' + (query ? query + '&' : '') + 'ref=' + MD.api.REF;

  /** 18-decimal amount → USDe. The API serialises these as strings when large and as JSON numbers when they fit
   *  (e.g. 6916996047430642 = 0.0069 USDe), so numbers are wei too. Only for wei fields, never for USD decimals. */
  P.usd = (v) => (v == null ? 0 : Number(String(v)) / 1e18);
  P.sec = (t) => (t == null ? 0 : typeof t === 'number' ? (t > 1e12 ? Math.floor(t / 1000) : t) : Math.floor(Date.parse(t) / 1000));
  P.ms = (t) => P.sec(t) * 1000;

  const cache = new Map();
  class GqlError extends Error { constructor(m, code) { super(m); this.code = code; } }
  P.GqlError = GqlError;
  // The API allows 200 requests per minute per IP (RateLimit-Limit header). Bulk jobs set minIntervalMs to pace
  // themselves; every caller gets a retry with backoff on 429 / transient network errors.
  P.minIntervalMs = 0; P.stats = { requests: 0, retries: 0 };
  P.strict = false;   // the snapshot builder sets it: a partial answer (errors beside data) fails instead of being taken
  let gate = Promise.resolve(), lastStart = 0;
  const pace = () => { if (!P.minIntervalMs) return Promise.resolve(); gate = gate.then(async () => { const wait = lastStart + P.minIntervalMs - Date.now(); if (wait > 0) await U.sleep(wait); lastStart = Date.now(); }); return gate; };
  /** POST a query. opts: {variables, ttl (ms cache), signal} */
  P.gql = async function (query, variables, opts = {}) {
    const key = query + '|' + JSON.stringify(variables || {});
    if (opts.ttl) { const c = cache.get(key); if (c && c.exp > Date.now()) return c.value; }
    // where the API does not answer this site (CORS: the one probe of P.live says so, remembered an hour) nothing is sent:
    // every call's preflight failed, was tried three times more (6 s) and logged errors before the page fell back to the
    // snapshot (the bettor and account pages on every view)
    if (!opts.probe && !(await P.live())) throw new GqlError('Network error: the Predict API does not answer this site', 'NETWORK');
    const body = JSON.stringify({ query, variables: variables || {} });
    for (let attempt = 0; ; attempt++) {
      await pace();
      let res;
      try { P.stats.requests++; res = await fetch(P.URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body, signal: opts.signal }); }
      catch (e) {
        if (e && e.name === 'AbortError') throw e;
        if (attempt < 3 && opts.retry !== false) { P.stats.retries++; await U.sleep(1000 * (attempt + 1)); continue; }
        throw new GqlError('Network error: ' + (e && (e.cause && e.cause.message ? e.cause.message : e.message)), 'NETWORK');
      }
      if (res.status === 429 && attempt < 5) {
        const reset = parseInt(res.headers.get('ratelimit-reset') || res.headers.get('retry-after') || '10', 10);
        P.stats.retries++; await U.sleep(Math.min(65, Math.max(2, reset + 1)) * 1000); continue;
      }
      let j = null; try { j = await res.json(); } catch (_) {}
      if (!res.ok && !(j && j.data)) {
        if (res.status >= 500 && attempt < 3) { P.stats.retries++; await U.sleep(2000 * (attempt + 1)); continue; }
        throw new GqlError((j && j.errors && j.errors[0] && j.errors[0].message) || ('HTTP ' + res.status), res.status);
      }
      // errors beside data (a partial answer): the pages take what came back; the snapshot builder (P.strict) publishes no
      // half answer, so it asks twice more, as after a timeout, and then fails
      if (j && j.errors && j.errors.length && (!j.data || P.strict)) {
        // the API stops a query after 8 s ("Query timeout: raw.$queryRaw exceeded 8000ms"), mostly a heavy list asked
        // cold: asked again it answered in under a second (2026-10-21, the Hot lists), so it gets two more tries
        if ((j.data || /^Query timeout/i.test(String(j.errors[0].message || ''))) && attempt < 2 && opts.retry !== false) { P.stats.retries++; await U.sleep(3000 * (attempt + 1)); continue; }
        throw new GqlError((j.data ? 'Partial answer: ' : '') + j.errors[0].message, (j.errors[0].extensions || {}).code);
      }
      if (opts.ttl) cache.set(key, { exp: Date.now() + opts.ttl, value: j.data });
      return j.data;
    }
  };
  P.clearCache = () => cache.clear();

  // ---------- field sets ----------
  // isPublic: listed on Meridian. Unlisted questions can still end up in combos, but Meridian's settlement bot does not
  // relay their results from Polygon, so they stay unsettled unless someone sends the relay by hand (see P.res).
  P.F = {
    condition: 'conditionId question shortName endTime settled resolvedToYes nonDecisive estimatedPrice isPublic category { name slug } tags',
    // the source market's volume: all time (Meridian's market page), the windows unfiltered, and the Filtered windows its
    // list cards show (P.questionVolume: 1 and 4 hours for its Hot lists too); the group's event id names its match
    conditionFull: 'conditionId question shortName endTime createdAt settled resolvedToYes nonDecisive estimatedPrice isPublic openInterest similarMarketVolume similarMarketVolume24h similarMarketVolume7d similarMarketVolumeFiltered1h similarMarketVolumeFiltered4h similarMarketVolumeFiltered24h similarMarketVolumeFiltered7d tags category { name slug } conditionGroup { groupId externalEventId } similarMarket { image markets }',
    // settleTxHash: the claim's transaction (null until claimed)
    prediction: 'predictionId chainId predictor counterparty predictorCollateral counterpartyCollateral predictorToken counterpartyToken settled result createdAt settledAt createTxHash settleTxHash pickConfig { pickConfigId endsAt resolved result picks { conditionId predictedOutcome condition { conditionId question shortName endTime settled settledAt resolvedToYes nonDecisive estimatedPrice isPublic category { name slug } tags } } }',
    position: 'id chainId createdAt holder side balance token userCollateral totalPayout prediction { predictionId } pickConfig { pickConfigId endsAt resolved result totalPredictorCollateral totalCounterpartyCollateral picks { conditionId predictedOutcome condition { question shortName endTime settled resolvedToYes nonDecisive estimatedPrice category { name } } } }',
    trade: 'id chainId token seller buyer tokenAmount price collateral txHash blockNumber executedAt',
    stats: 'timestamp realizedPnl cumulativePnl volume predictionsTotal predictionsWon predictionsLost predictionsPending predictionsNonDecisive deployedCollateral claimableCollateral',
  };

  // ---------- live-access probe ----------
  // The API only answers browsers from an allowlist of origins (*.meridian.xyz, *.sapience.xyz, localhost and 127.0.0.1
  // on any port, as probed 2026-10-02).
  // Elsewhere the site works from the published snapshot; live queries switch on automatically once the domain is allowed.
  P._live = null;
  // One probe per page load, no retries (a CORS refusal is final), and the verdict is remembered for an hour so the
  // next visit skips even that. Without this the refused probe's backoff held every Predict page for ~9 s.
  P.LIVE_MEMO_MS = 3600000;
  P.live = async function () {
    if (P._live !== null) return P._live;
    if (typeof window === 'undefined' || typeof location === 'undefined') { P._live = true; return true; }
    // one probe shared by every call made while it runs (each call of P.gql asks first)
    if (P._liveP) return P._liveP;
    P._liveP = (async () => {
      const memo = U.storage.get('md.predict.live', null);
      if (memo && memo.origin === location.origin && memo.exp > Date.now()) { P._live = !!memo.v; return P._live; }
      try { await P.gql('query { predictions(first: 0) { totalCount } }', null, { ttl: 60000, retry: false, probe: true }); P._live = true; }
      catch (e) { P._live = !(e && (e.code === 'NETWORK' || e.code === 403 || e.code === 405)); }
      U.storage.set('md.predict.live', { v: P._live, origin: location.origin, exp: Date.now() + P.LIVE_MEMO_MS });
      return P._live;
    })();
    return P._liveP;
  };
  /** Fetch a snapshot file by relative path (served next to the site; the deploy copies the "snapshots" branch into data/). */
  P.SNAPSHOT_BASES = ['data/'];
  // A file that is not there is null: the site answers it with its own page (index.html, status 200) or a 404. One that
  // could not be read (no connection, a server error, a download cut off) throws, so a page can say so and offer a Retry
  // rather than "no activity for this address".
  // One read of a file for a minute, shared by every caller: the wallet lookup, the bettor page, the account's Predict tab
  // and the tax card each read a wallet's file, which went out twice or three times. The shared read is tied to no one
  // caller (one leaving must not fail the others); a caller's own abort still ends its wait. A failed read is not kept.
  const fileMemo = new Map();
  P.snapshotFile = async function (rel, { signal } = {}) {
    let hit = fileMemo.get(rel);
    if (!hit || Date.now() - hit.at > 60000) {
      const p = readSnapshotFile(rel);
      hit = { at: Date.now(), p }; fileMemo.set(rel, hit);
      p.catch(() => { if (fileMemo.get(rel) === hit) fileMemo.delete(rel); });
    }
    const abortErr = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (signal && signal.aborted) throw abortErr();
    const best = signal ? await Promise.race([hit.p, new Promise((_, reject) => signal.addEventListener('abort', () => reject(abortErr()), { once: true }))]) : await hit.p;
    // the wallet, question and slip files carry no build time of their own, so one whose content did not change is the
    // same file at every build: theirs is the snapshot's
    if (best && best.builtAt == null && /^(bettors|questions|slips)\//.test(rel)) best.builtAt = await P.snapshotAt();
    return best;
  };
  async function readSnapshotFile(rel) {
    let fail = null;
    const failed = (why, code) => { fail = fail || Object.assign(new Error('The snapshot could not be read (' + why + ')'), { code }); return null; };
    const got = await Promise.all(P.SNAPSHOT_BASES.map(async (b) => {
      let r;
      try { r = await fetch(b + rel, { cache: 'no-cache' }); } catch (e) { if (e && e.name === 'AbortError') throw e; return failed('no connection', 'NETWORK'); }
      if (r.status === 404) return null;
      if (!r.ok) return failed('HTTP ' + r.status, r.status);
      if (/text\/html/i.test((r.headers && r.headers.get && r.headers.get('content-type')) || '')) return null;   // the site's page in its place
      try { return await r.json(); } catch (e) { if (e && e.name === 'AbortError') throw e; return e && e.name === 'SyntaxError' ? null : failed('download cut off', 'NETWORK'); }
    }));
    const best = got.filter(Boolean).sort((a, b) => (b.builtAt || 0) - (a.builtAt || 0))[0] || null;
    if (!best && fail) throw fail;
    return best;
  }
  /** The published snapshot's build time, from predict-status.json (a few hundred bytes, read at most once a minute) */
  let statusAt = null;
  P.snapshotAt = function () {
    if (!statusAt || Date.now() - statusAt.at > 60000) statusAt = { at: Date.now(), p: P.snapshotFile('predict-status.json').then((s) => (s && s.builtAt) || null, () => null) };
    return statusAt.p;
  };

  // ---------- predictions ----------
  P.predictionsPage = async function ({ filter, after, first, dir, signal, ttl }) {
    const d = await P.gql(`query Preds($first: Int!, $after: String, $filter: PredictionFilter, $dir: OrderDirection!) { predictions(first: $first, after: $after, filter: $filter, orderBy: { field: CREATED_AT, direction: $dir }) { totalCount pageInfo { hasNextPage endCursor } nodes { ${P.F.prediction} } } }`,
      { first: Math.min(P.PAGE, first || P.PAGE), after: after || null, filter: filter || null, dir: dir || 'DESC' }, { signal, ttl });
    return d.predictions;
  };
  /** Paginate one filter sequentially (cursor pagination). */
  P.predictionsAll = async function ({ filter, maxPages = 40, dir = 'DESC', signal, onPage }) {
    const rows = []; let after = null; let pages = 0; let total = null;
    do {
      const pg = await P.predictionsPage({ filter, after, dir, signal });
      if (total == null) total = pg.totalCount;
      rows.push(...pg.nodes); pages++;
      if (onPage) onPage(rows.length, total);
      after = pg.pageInfo.hasNextPage ? pg.pageInfo.endCursor : null;
    } while (after && pages < maxPages);
    rows.truncated = !!after; rows.total = total;
    return rows;
  };
  /**
   * Fetch every prediction created in [fromSec, toSec] by splitting the range into windows that paginate
   * concurrently (the API allows 25 rows per page but accepts a createdAt range filter).
   */
  P.predictionsWindowed = async function ({ fromSec, toSec, windows = 6, concurrency = 6, maxPagesPerWindow = 400, signal, onProgress, baseFilter }) {
    toSec = toSec || Math.floor(Date.now() / 1000);
    const span = Math.max(1, toSec - fromSec); const w = Math.ceil(span / windows);
    const ranges = []; for (let s = fromSec; s <= toSec; s += w) ranges.push([s, Math.min(toSec, s + w - 1)]);
    const seen = new Map(); let done = 0; let fetched = 0; let truncated = false;
    const tasks = ranges.map(([a, b]) => async () => {
      const rows = await P.predictionsAll({ filter: Object.assign({}, baseFilter || {}, { createdAt: { gte: a, lte: b } }), maxPages: maxPagesPerWindow, signal, onPage: (n, total) => { if (onProgress) onProgress(fetched + n, null); } });
      for (const r of rows) seen.set(r.predictionId, r);
      if (rows.truncated) truncated = true;   // a window hit its page cap: the list is incomplete
      fetched += rows.length; done++;
      if (onProgress) onProgress(seen.size, ranges.length - done);
    });
    const results = await U.pLimit(tasks, concurrency);
    if (signal && signal.aborted) throw new (typeof DOMException !== 'undefined' ? DOMException : Error)('Aborted', 'AbortError');
    const failed = results.filter((r) => !r.ok);
    if (failed.length) { const e = failed[0].error; throw new GqlError(`${failed.length}/${ranges.length} windows failed: ${e && e.message}`, e && e.code); }
    const out = Array.from(seen.values()).sort((x, y) => P.sec(y.createdAt) - P.sec(x.createdAt));
    out.truncated = truncated;
    return out;
  };
  P.predictionsCount = async (filter, o) => (await P.gql('query C($filter: PredictionFilter) { predictions(first: 0, filter: $filter) { totalCount } }', { filter: filter || null }, { ttl: 30000, signal: o && o.signal })).predictions.totalCount;
  P.tape = (first, o) => P.predictionsPage({ first: first || 25, signal: o && o.signal, ttl: (o && o.ttl) || 0 }).then((pg) => pg.nodes);

  // ---------- accounts ----------
  P.account = async function (address, { interval = 'DAY', fromSec, toSec, signal, ttl } = {}) {
    const d = await P.gql(`query Acct($a: Address!, $i: TimeInterval!, $from: Int, $to: Int) { account(address: $a) { stats { totalVolume } collateralBalance { amount } statsHistory(interval: $i, filter: { timestamp: { gte: $from, lte: $to } }) { nodes { ${P.F.stats} } } } }`,
      { a: address.toLowerCase(), i: interval, from: fromSec || null, to: toSec || null }, { signal, ttl });
    const acc = d.account || {};
    const hist = ((acc.statsHistory && acc.statsHistory.nodes) || []).map((n) => ({
      t: n.timestamp * 1000, pnl: P.usd(n.realizedPnl), cumPnl: P.usd(n.cumulativePnl), volume: P.usd(n.volume),
      total: n.predictionsTotal || 0, won: n.predictionsWon || 0, lost: n.predictionsLost || 0, pending: n.predictionsPending || 0, nonDecisive: n.predictionsNonDecisive || 0,
      deployed: P.usd(n.deployedCollateral), claimable: P.usd(n.claimableCollateral),
    }));
    return { totalVolume: P.usd(acc.stats && acc.stats.totalVolume), balance: P.usd(acc.collateralBalance && acc.collateralBalance.amount), history: hist };
  };
  P.predictionsOf = (address, o = {}) => P.predictionsAll({ filter: Object.assign({ participant: address.toLowerCase() }, o.filter || {}), maxPages: o.maxPages || 12, signal: o.signal, onPage: o.onPage });
  // positions(settled: false).totalCount is Meridian's Open Positions: it counts the rows with a balance (checked
  // 2026-10-05: 0xaca4… lists 7 rows sold to 0 and counts 0), one per pick configuration and side, undecided only
  P.positionsOf = async function (holder, { settled = false, first = 25, after, signal } = {}) {
    const d = await P.gql(`query Pos($h: Address!, $s: Boolean, $first: Int!, $after: String) { positions(first: $first, after: $after, filter: { holder: $h, settled: $s }, orderBy: { field: CREATED_AT, direction: DESC }) { totalCount pageInfo { hasNextPage endCursor } nodes { ${P.F.position} } } }`,
      { h: holder.toLowerCase(), s: settled, first: Math.min(P.PAGE, first), after: after || null }, { signal });
    return d.positions;
  };
  /** Every position token the holder can claim now, as Meridian's app reads them for its Claim card (positions(holder,
   *  claimable: true): decided, with a balance; P.claimRows keeps the winning side). All pages, up to maxPages. */
  P.claimableOf = async function (holder, { signal, maxPages = 20 } = {}) {
    const rows = []; let after = null, pages = 0;
    do {
      const d = await P.gql('query Claim($h: Address!, $first: Int!, $after: String) { positions(first: $first, after: $after, filter: { holder: $h, claimable: true }) { totalCount pageInfo { hasNextPage endCursor } nodes { side balance pickConfig { pickConfigId result } prediction { predictionId } } } }',
        { h: holder.toLowerCase(), first: P.PAGE, after }, { signal });
      rows.push(...d.positions.nodes); pages++;
      after = d.positions.pageInfo.hasNextPage ? d.positions.pageInfo.endCursor : null;
    } while (after && pages < maxPages);
    rows.truncated = !!after;
    return rows;
  };

  // ---------- Polymarket order book ----------
  /** Polymarket's CLOB midpoints, the chance Meridian's app shows for a question (the YES token's midpoint while no older
   *  than two minutes, else Meridian's estimatedPrice): token id → midpoint, for up to 100 tokens a request. Public, any
   *  origin (checked 2026-10-05: POST /midpoints answers with Access-Control-Allow-Origin *). */
  P.CLOB_MIDPOINTS = 'https://clob.polymarket.com/midpoints';
  P.midpoints = async function (tokens, { signal } = {}) {
    const out = {}; const list = Array.from(new Set((tokens || []).map(String).filter(Boolean)));
    for (let i = 0; i < list.length; i += 100) {
      const r = await fetch(P.CLOB_MIDPOINTS, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(list.slice(i, i + 100).map((t) => ({ token_id: t }))), signal });
      if (!r.ok) throw new GqlError('midpoints ' + r.status, r.status);
      const j = await r.json();
      for (const [t, v] of Object.entries(j || {})) { const p = Number(v); if (Number.isFinite(p) && p >= 0 && p <= 1) out[t] = p; }
    }
    return out;
  };

  // ---------- questions ----------
  P.conditions = async function ({ search, categorySlug, tags, settled, conditionIds, orderBy = 'OPEN_INTEREST', dir = 'DESC', first = 25, after, signal, ttl } = {}) {
    const filter = {};
    if (search) filter.search = search; if (categorySlug) filter.categorySlug = categorySlug; if (tags && tags.length) filter.tags = tags;
    if (settled != null) filter.settled = settled; if (conditionIds) filter.conditionIds = conditionIds;
    const d = await P.gql(`query Q($first: Int!, $after: String, $filter: ConditionFilter, $orderBy: ConditionOrderField!, $dir: OrderDirection!) { conditions(first: $first, after: $after, filter: $filter, orderBy: { field: $orderBy, direction: $dir }) { totalCount pageInfo { hasNextPage endCursor } nodes { ${P.F.conditionFull} } } }`,
      { first: Math.min(P.PAGE, first), after: after || null, filter, orderBy, dir }, { signal, ttl });
    return d.conditions;
  };
  P.conditionCounts = (o) => P.gql('query { all: conditions(first: 0) { totalCount } open: conditions(first: 0, filter: { settled: false }) { totalCount } settled: conditions(first: 0, filter: { settled: true }) { totalCount } }', null, { ttl: 60000, signal: o && o.signal });
  P.categories = (o) => P.gql('query { categories(first: 25, orderBy: { field: NAME, direction: ASC }) { nodes { id name slug } } }', null, { ttl: 600000, signal: o && o.signal }).then((d) => d.categories.nodes);
  P.rootTags = (o) => P.gql('query { rootTags { name displayName } }', null, { ttl: 600000, signal: o && o.signal }).then((d) => d.rootTags);

  // ---------- secondary market & flows ----------
  P.trades = async function ({ first = 25, after, seller, signal, ttl } = {}) {
    const d = await P.gql(`query T($first: Int!, $after: String, $filter: TradeFilter) { trades(first: $first, after: $after, filter: $filter, orderBy: { field: EXECUTED_AT, direction: DESC }) { totalCount pageInfo { hasNextPage endCursor } nodes { ${P.F.trade} } } }`,
      { first: Math.min(P.PAGE, first), after: after || null, filter: seller ? { seller: seller.toLowerCase() } : null }, { signal, ttl });
    return d.trades;
  };
  P.transfers = async function ({ account, first = 25, after, signal } = {}) {
    const q = account
      ? 'query Tr($first: Int!, $after: String, $account: Address!) { collateralTransfers(first: $first, after: $after, filter: { account: $account }, orderBy: { field: TIMESTAMP, direction: DESC }) { totalCount pageInfo { hasNextPage endCursor } nodes { id chainId from to value timestamp transactionHash blockNumber } } }'
      : 'query Tr($first: Int!, $after: String) { collateralTransfers(first: $first, after: $after, orderBy: { field: TIMESTAMP, direction: DESC }) { totalCount pageInfo { hasNextPage endCursor } nodes { id chainId from to value timestamp transactionHash blockNumber } } }';
    const d = await P.gql(q, Object.assign({ first: Math.min(P.PAGE, first), after: after || null }, account ? { account: account.toLowerCase() } : {}), { signal });
    return d.collateralTransfers;
  };
})();
