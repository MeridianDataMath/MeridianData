/* MeridianData — Meridian Predict (Sapience) GraphQL client. Read-only, public, no auth. */
(function () {
  const MD = window.MD; const U = MD.util;
  const P = (MD.predict = MD.predict || {});
  P.URL = 'https://api.predict.meridian.xyz/graphql';
  P.ESCROW = '0xe4cea507b19796362a5a28fa7cb705a3f1866213';
  P.SECONDARY_ESCROW = '0x7e318ef37c3bc3d0cba205af2d1fc9f9cefeb5df';
  P.CHAIN = 4663;
  P.PAGE = 25;                        // hard cap of the API
  P.LAUNCH_SEC = 1782691200;          // 2026-06-29 00:00 UTC, day before the first prediction
  P.APP_URL = 'https://app.meridian.xyz/predict?ref=BJ9Y51H9XB1L';

  /** 18-decimal amount → USDe. The API serialises these as strings when large and as JSON numbers when they fit
   *  (e.g. 6916996047430642 = 0.0069 USDe), so numbers are wei too. Only for wei fields, never for USD decimals. */
  P.usd = (v) => (v == null ? 0 : Number(String(v)) / 1e18);
  P.sec = (t) => (t == null ? 0 : typeof t === 'number' ? (t > 1e12 ? Math.floor(t / 1000) : t) : Math.floor(Date.parse(t) / 1000));
  P.ms = (t) => P.sec(t) * 1000;

  const cache = new Map();
  class GqlError extends Error { constructor(m, code) { super(m); this.code = code; } }
  P.GqlError = GqlError;
  /** POST a query. opts: {variables, ttl (ms cache), signal} */
  P.gql = async function (query, variables, opts = {}) {
    const key = query + '|' + JSON.stringify(variables || {});
    if (opts.ttl) { const c = cache.get(key); if (c && c.exp > Date.now()) return c.value; }
    let res;
    try { res = await fetch(P.URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ query, variables: variables || {} }), signal: opts.signal }); }
    catch (e) { if (e && e.name === 'AbortError') throw e; throw new GqlError('Network error: ' + (e && e.message), 'NETWORK'); }
    let j = null; try { j = await res.json(); } catch (_) {}
    if (!res.ok && !(j && j.data)) throw new GqlError((j && j.errors && j.errors[0] && j.errors[0].message) || ('HTTP ' + res.status), res.status);
    if (j && j.errors && j.errors.length && !j.data) throw new GqlError(j.errors[0].message, (j.errors[0].extensions || {}).code);
    if (opts.ttl) cache.set(key, { exp: Date.now() + opts.ttl, value: j.data });
    return j.data;
  };
  P.clearCache = () => cache.clear();

  // ---------- field sets ----------
  P.F = {
    condition: 'conditionId question shortName endTime settled resolvedToYes nonDecisive estimatedPrice category { name slug } tags',
    conditionFull: 'conditionId question shortName endTime createdAt settled resolvedToYes nonDecisive estimatedPrice openInterest similarMarketVolume24h similarMarketVolume7d tags category { name slug } conditionGroup { groupId externalEventId } similarMarket { image markets }',
    prediction: 'predictionId chainId predictor counterparty predictorCollateral counterpartyCollateral settled result createdAt settledAt createTxHash pickConfig { pickConfigId endsAt resolved result picks { conditionId predictedOutcome condition { conditionId question shortName endTime settled resolvedToYes nonDecisive estimatedPrice category { name slug } tags } } }',
    position: 'id chainId createdAt holder side balance token userCollateral totalPayout prediction { predictionId } pickConfig { pickConfigId endsAt resolved result totalPredictorCollateral totalCounterpartyCollateral picks { conditionId predictedOutcome condition { question shortName endTime settled resolvedToYes estimatedPrice category { name } } } }',
    trade: 'id chainId token seller buyer tokenAmount price collateral txHash blockNumber executedAt',
    stats: 'timestamp realizedPnl cumulativePnl volume predictionsTotal predictionsWon predictionsLost predictionsPending predictionsNonDecisive deployedCollateral claimableCollateral',
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
    const seen = new Map(); let done = 0;
    const tasks = ranges.map(([a, b]) => async () => {
      const rows = await P.predictionsAll({ filter: Object.assign({}, baseFilter || {}, { createdAt: { gte: a, lte: b } }), maxPages: maxPagesPerWindow, signal, onPage: () => { if (onProgress) onProgress(seen.size + done, null); } });
      for (const r of rows) seen.set(r.predictionId, r);
      done++;
      if (onProgress) onProgress(seen.size, ranges.length - done);
    });
    await U.pLimit(tasks, concurrency);
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return Array.from(seen.values()).sort((x, y) => P.sec(y.createdAt) - P.sec(x.createdAt));
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
  P.positionsOf = async function (holder, { settled = false, first = 25, after, signal } = {}) {
    const d = await P.gql(`query Pos($h: Address!, $s: Boolean, $first: Int!, $after: String) { positions(first: $first, after: $after, filter: { holder: $h, settled: $s }, orderBy: { field: CREATED_AT, direction: DESC }) { totalCount pageInfo { hasNextPage endCursor } nodes { ${P.F.position} } } }`,
      { h: holder.toLowerCase(), s: settled, first: Math.min(P.PAGE, first), after: after || null }, { signal });
    return d.positions;
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
