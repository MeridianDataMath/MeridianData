# MeridianDataHub

**Live at <https://meridian.thedatahub.xyz/>.**

Account analytics, leaderboard and market dashboard for the **Meridian** perpetuals exchange
(Robinhood Chain), in the spirit of [ethereal.thehedgie.com](https://ethereal.thehedgie.com/).

Everything is a static site (plain HTML + JS, no build step, no backend). The browser talks
directly to Meridian's public APIs, which allow cross-origin requests:

| Source | Used for |
|---|---|
| `https://api.meridian.xyz` | products, prices, order book, subaccounts, balances, positions, orders, fills, transfers, points, liquidations, closure windows |
| `https://archive.meridian.xyz` | per-subaccount balance / unrealized-PnL / volume history (the charts and interval stats) |
| `wss://ws.meridian.xyz/v1/stream` | live tickers, order book, trade tape, per-account position/order/fill events |
| `https://tradingview.meridian.xyz` | 7-day oracle price sparklines on the dashboard |
| `https://api.predict.meridian.xyz/graphql` | Meridian Predict (Sapience): questions, predictions, positions, account stats, secondary-market trades |

## Run it

* **Double-click `Start-MeridianData.cmd`** — starts a tiny local web server on
  <http://localhost:8787/> and opens the browser. `Ctrl+C` in the window stops it.
  (`Start-MeridianData.ps1 -Port 9000 -NoBrowser` for options.)
* Or just open `index.html` directly in a browser — it works from `file://` too.
* Or copy the folder to any static host (GitHub Pages, Cloudflare Pages, S3, nginx…).
  There is nothing to configure; routing is hash-based (`#/leaderboard`).

## Publish it

`.github/workflows/pages.yml` runs on every push, every 30 minutes and on demand. It builds the
perps snapshot (`data/leaderboard.json`), adds the Predict snapshot from the `snapshots` branch,
assembles `dist/` and deploys it:

* **Cloudflare** (recommended; works from a **private** repo, free): a Worker with static assets
  named `meridiandatahub` (`wrangler.jsonc`). Create it once in the dashboard (Workers & Pages →
  Create → *Upload assets*, upload the site folder without `.git` and `data/bettors`), create an
  API token from the *Edit Cloudflare Workers* template, and add two repository secrets:
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. From the next run the workflow runs
  `wrangler deploy` with `dist/`. The default URL is `https://meridiandatahub.<your-subdomain>.workers.dev`;
  the subdomain can be changed under Workers & Pages → Overview. The public address
  `meridian.thedatahub.xyz` is a custom domain on the Worker (Settings → Domains & Routes) on the
  zone `thedatahub.xyz`, registered through Cloudflare Registrar; Cloudflare issues and renews the
  certificate itself. Turn on *Always Use HTTPS* under the zone's SSL/TLS → Edge Certificates.
  Private repos get 2,000 free Actions minutes a month; the 30-minute schedule uses about 1,500.
* **GitHub Pages** (public repos only): without those secrets the same workflow deploys to
  `https://<user>.github.io/<repo>/` (Settings → Pages → Source: GitHub Actions, once).

The Predict snapshot is produced on a PC (see the Predict section below) whichever host is used.
`_headers` sets cache and security headers on Cloudflare Pages and is ignored elsewhere.

### Privacy notes

* Fonts are self-hosted (`css/fonts.css`, `assets/fonts/`); no request goes to Google.
* The site sets no cookies and runs no analytics; favorites and preferences live in `localStorage`.
* Visitors' browsers call Meridian's public APIs directly, so Meridian sees their IP addresses.
* Snapshot commits are dated in UTC; the snapshot builder sends no identifying User-Agent.
* `js/api.js` contains the operator's Meridian referral code; remove it if the site should not be
  linkable to a Meridian account.

## Pages

* **Home** – search by wallet address (`0x…`) or subaccount UUID; ticker of the top accounts
  from the latest leaderboard snapshot; exchange stats.
* **Account**
  * *Overview* – equity / balance / margin per pool (USD cross pool + one isolated pool per
    mPerp), estimated liquidation prices, chart of PnL · Volume · Balance · Equity · Funding ·
    Fees (cumulative or per bucket, 24h / 7d / 30d / all time), interval stats, and tables for
    open positions, open orders, fills, position history and deposits/withdrawals/conversions.
  * *Live* – WebSocket-driven positions, orders, fills and an L2 order book for any market.
  * *Performance* – win rate, profit factor, expectancy, Sharpe, max drawdown, trading style,
    per-market breakdown, cumulative and daily PnL charts.
  * *Rewards* – points per season (rank, tier, referral points, epoch history), exchange-wide
    points, linked API signers.
* **Favorites** – starred accounts with live equity (stored in this browser only).
* **Leaderboard** – every subaccount on the exchange, ranked; sortable columns and filters for
  interval (24h/7d/30d/all), equity, volume, PnL, ROI, win rate, Sharpe, max drawdown, trading
  style. A snapshot is published every 30 minutes by the deploy workflow; **Update** rebuilds one
  in your browser (a few API calls per account), cached in `localStorage`. Subaccounts that
  never traded (the exchange's fee collector) are tagged *no trades*.
* **Dashboard** – all markets with live mark price, 24h change, bid/ask, funding, open interest,
  volume, sparkline and mPerp closure windows; a **stop map** (every account's take-profit,
  stop-loss and entry-stop levels per market as a ladder around the mark price, sized by
  notional, with the accounts behind each level); live trade tape (taker/maker links to the
  accounts); liquidation feed; funding table.
* **Tax center** – a full tax report per subaccount: fiscal-year presets (calendar, UK, Australia,
  New Zealand, India, South Africa, Egypt/Pakistan) or a custom UTC range; a reporting currency
  (28 currencies at ECB daily reference rates via frankfurter.dev, USD kept in every export);
  net result, realized PnL, gains and losses, fees, funding received / paid, deposits,
  withdrawals, long-term positions (held over a year), open positions at period end; an income
  vs expenses table with classification hints; monthly, fiscal-quarter and per-market
  breakdowns; a closed-positions ledger with holding periods; a full transaction ledger (fills,
  transfers, position closes, daily funding) with type filters; and nine CSV exports: summary
  with monthly and quarterly tables, capital gains (Form 8949-style), closed positions, daily
  ledger, all transactions, fills, transfers, Koinly universal, CoinTracking. The Predict
  section reports on a cash (claimed) basis with the decided-but-unclaimed tail shown apart,
  placed in the period its questions were decided in. Print-friendly. Records only, not tax advice.
  Accounting rules worth knowing: the period totals come from the exchange's daily ledger
  (realized PnL, trading fees, funding, transfers); mPerp position fees are missing from that
  ledger, so they are taken from the positions and spread over each position's holding time
  (a position straddling two years is split between them); fiscal quarters run from the fiscal
  year's first day in three-month steps (UK: 6 Apr – 5 Jul, …); "open at period end" is
  computed from open/close times for past periods too; every figure is shown in cents; the
  balance reconciliation (opening + deposits − withdrawals + result = closing) names any pool
  the ledger cannot explain; the transaction ledger's cash-effect column sums to the balance
  change. `js/dev/sim-tax.js` (not loaded by the site) fakes a busy two-year account with a
  ledger built from the same events, for stress-testing the report against a realistic
  return: `MDSim.install()` in the console, then open `#/tax?address=<its address>`.
* **Predict section** (Meridian's prediction markets, powered by Sapience; separate sidebar group):
  * *Overview* – exchange-wide totals, wagered and count per day, a live prediction tape,
    category and single-vs-combo breakdowns, market makers, secondary-market trades.
  * *Bettors* – every bettor ranked by net PnL with ROI, win rate, average odds, combo share,
    average vig paid, best win and last activity; click through to a bettor page.
  * *Questions* – only the questions people have bet on through Meridian (open interest now, open
    predictions, and questions settled in the last 30 days; the exchange itself lists 85k):
    search, category, open / ended-unsettled / settled / all (Open by default), sortable columns
    (stake ever placed on Meridian first); implied probability, Meridian OI with the number of
    open bets and stake, source volume, link to the mirrored source market. On an origin with live API access a link
    switches to the full explorer over every question. A **Resolution** column says when and
    how each question resolves: the Polymarket market's end (and the fixture time for sports,
    which moves when a game is postponed), Meridian's own betting cutoff when it is earlier, and
    the live position in Polymarket's UMA pipeline — *awaiting proposal*, *proposed X, challenge
    window ends 15:42*, *disputed*, *UMA vote*, *resolved on Polymarket, not settled on Meridian
    yet*. The ⓘ button opens the proposal / dispute details and the market's resolution rules.
    The same per-leg status sits on the open positions of every bettor page. Every question row
    opens a panel with the actual predictions on it: bettor, stake, odds, payout, maker, and every
    leg of the combo with its own state, since a combo pays only if all legs resolve for the bettor.
    An ended question none of whose open predictions can still win (each has a leg resolved against
    its bettor) is left out. The snapshot carries `questions/<conditionId>.json` per question for this.
  * *Decided vs settled* – a prediction is **decided** when every leg has resolved on Meridian and
    the verdict is recorded (`pickConfig.resolved` / `result`); it is **settled** only when the
    winner claims, which most do late or never (roughly 1,000 of 1,300 "unsettled" predictions are
    decided). Results, win rates, PnL and the ex-post vig therefore count from the verdict; the
    Overview shows *Unclaimed winnings* (won, not claimed) and bettor pages an *Unclaimed winnings*
    tile. *Unresolved on Meridian* is the small separate set of questions Meridian's resolver has
    not resolved although Polymarket has; those are listed first on the Ended tab. The tax center
    stays on a cash basis (claimed).
  * *Market makers* – who takes the other side of the RFQ auctions: share of flow, collateral
    committed, open exposure, PnL, win rate, vig captured.
  * *Vig & edge* – the bettor's locked odds versus the mirrored Polymarket market's price **at
    the moment of the bet**, overall, per category, per odds bucket, singles vs combos, and per
    week. The Predict API only exposes a question's source probability as it is now, so the
    snapshot builder fetches the price at bet time from Polymarket's own CLOB price history
    (`clob.polymarket.com/prices-history`, YES-token, last sample at or before the bet; 1-minute
    samples for short spans, up to 15-minute for long ones) and caches it per prediction in
    `data/cache/polymarket-prices.json`, so a run only looks up new predictions. Combos
    multiply the legs, so combos whose legs sit on one Polymarket event (correlated) are shown
    separately and kept out of the headline. The page's second half is the ex-post view,
    *Quote-implied vs realized*: on settled bets, the locked odds against the realized hit rate
    (with a 95% interval) and bettor ROI, overall, by bet type, by odds bucket and by category;
    that needs no source price and already contains correlation and bettor skill.
  * *Bettor page* – PnL curve, daily volume, open positions with locked odds vs the source now,
    full prediction history, category and combo breakdown (also the **Predict** tab on every
    perps account page). The Tax center gains a Predict block with realized PnL, monthly table
    and two CSV exports.
  **How the Predict data gets there.** The Predict API refuses datacenter IPs (GitHub's
  runners get 403) and only allows browsers from Meridian's own origins (CORS allowlist), so:
  `scripts/Update-PredictSnapshot.ps1` runs on a normal PC (portable Node in `../tools/node`
  or any `node` on PATH), pulls every prediction since launch paced under the API's 200
  requests/minute, and force-pushes a single parentless commit to the `snapshots` branch
  (`predict.json` + one slim file per wallet in `bettors/`). `scripts/Install-SnapshotTask.ps1`
  schedules that every 30 minutes. The deploy workflow copies the branch into `data/` on each
  run, which is where the site reads it from; after each push the PC script triggers that
  workflow (`workflow_dispatch`, with the GitHub credential git pushed with), so the site
  carries a new snapshot a few minutes after it is built instead of waiting for the workflow's
  own 30-minute schedule, which GitHub often runs late. On the public domain every Predict page
  therefore renders from the snapshot; live
  queries (full-text question search, exchange-side account stats, 20-second tape) switch on
  automatically on an allowed origin such as localhost. Without any snapshot the browser
  builds the last 14 days itself.
  **Resolution data** does not depend on the Predict API at all: a Meridian question's
  `conditionId` is the Polymarket condition id, so the browser asks Polymarket's public Gamma
  API (`gamma-api.polymarket.com`, CORS-open) for the market and, for anything past its end or
  in resolution, reads the UMA CTF adapter (`getQuestion`) and the optimistic oracle
  (`getRequest`) on Polygon through a public RPC (`polygon-bor-rpc.publicnode.com`, fallback
  `1rpc.io`). That gives the proposer, the proposed outcome, the exact end of the challenge
  window and any disputer. Neg-risk (multi-outcome) markets use a different adapter that keys
  questions differently, so for those only Polymarket's coarse status is shown.
* **Copy trading** (phase 1: leaders) – every trading wallet scored for **copyability**, the
  question a copier actually has: not "who made money" but "what would a follower have kept,
  entering a minute later, at taker fees, at that size, against these books?". The snapshot
  build gives each account a copy profile (`row.copy`): closed / open positions, hold-time
  buckets and median hold, median and 90th-percentile entry notional, market mix, result per
  position in bps (gross and net of fees), largest-win concentration, profitable weeks among
  active weeks, tenure and cadence, plus the frictions: slippage at the account's median size
  walked through today's books (`AN.bookSlippage`), how much of its 90th-percentile size fills
  within 1%, taker fees, and the price drift one and five minutes after each of its fills
  (`AN.fillDrift`, one-minute oracle candles from the TradingView endpoint, fetched in 3,000-bar
  windows and shared across accounts). The per-position result is the plain mean over positions
  (a fixed-size copier gets each position in equal measure), both tails winsorized at the 5th /
  95th percentile so one jackpot or blow-up cannot carry it, with a t-statistic saying whether
  it is clear of the noise; funding counts on both sides (a copier receives it too). "Edge
  left" = the share of that result that survives a copier's taker fees, drift and slippage (for
  a $2,000 position, `AN.COPY_SIZE`) in and out. The score (`AN.copyScore`, 0–100, computed on
  the site so the formula can change without a rebuild) is 35% track record, 45% copy
  friction, 20% activity, each pillar a weighted mean of its measured parts (unmeasured parts
  are left out, not zeroed), then capped with the reason shown: nothing survives copying → 40;
  less than all of it → 30 + 0.7 × edge left; fewer than 10 / 20 closed positions → 55 / 65;
  t < 2 → 60; no trade for 30 / 60 days → 60 / 45; a tenth of positions liquidated → 55; one
  position over 60% of all wins → 60; drawdown over 40% → 60; not profitable → scaled down and
  capped at 45; fewer than 5 closed positions means no score. Verdicts: Copyable (70+), Copy
  with care (50+), Hard to copy, Losing so far. Every row opens a breakdown with each part's
  value and reason, the caps that applied, the per-position waterfall from the leader's result
  to the copier's, hold-time strip, sizes, markets and track record. `js/dev/sim-leaders.mjs`
  runs twenty synthetic traders of very different styles (steady swing trader, profitable
  scalper, market maker, grid bot, whale, one-hit wonder, gambler, funding harvester, …)
  through the same pipeline against today's real books and prints the ranking with the
  expected verdict for each, so the formula is judged against what a copier wants rather than
  against whoever is on the exchange this week. Nothing on the page places orders; the roadmap
  on the page lists what comes next (simulator, alerts, a local copy agent with a Meridian
  linked signer).

The sidebar opens with labels on desktop and collapses to icons with the button at its bottom
(remembered per browser). Press `/` anywhere to jump to the search box. A thin progress line
under the top bar shows every page load; "How are these calculated?" (leaderboard, performance
tab, tax center) opens the metric definitions below in a panel. Published snapshots that are more
than two hours old are flagged as stale wherever they are shown. Subaccounts that never traded
(the exchange's fee-collector account "earns" PnL from fees received) are tagged *no trades* on the
leaderboard and left out of the home ticker and the copy-trading leaders.

## Metric definitions

* **PnL** (interval) = realized PnL + trading fees + realized funding over the interval, plus the
  change in unrealized PnL between the start of the interval and now.
* **Equity** = Σ margin balances (all pools are USD-equivalent tokens) + net unrealized PnL
  (unrealized − unsettled funding − unsettled position fees).
* **ROI** = PnL ÷ (equity at the start of the interval + deposits during it).
* **Max drawdown** = largest peak-to-trough decline of the equity curve in the interval.
* **Sharpe** = mean ÷ stdev of per-bucket PnL returns on prior equity, annualized; shown only with
  at least 10 buckets (so never for the 7-day interval)
  (daily buckets for 7d/30d/all, hourly for 24h).
* **Win rate** = closed positions with positive net result (realized − fees − funding) ÷ closed
  positions. **Trading style** is the average holding time of closed positions:
  Scalper < 1h, Intraday < 1d, Swing < 7d, otherwise Long-term.
* **Liquidation price** uses the app's pool maths: maintenance margin =
  notional × (1 / (2 × maxLeverage) + takerFee), solved per position with the equity left after
  the other positions' maintenance margin.

## Notes / limits

* Funding sign: the API reports funding as positive when *paid*; the UI flips it so that
  positive always means *received* (green).
* The leaderboard analyses the most recent 600 positions per account and the Archive API's
  daily buckets (hourly for the 24h interval). With many hundreds of accounts a build takes a
  few minutes; the public rate limit is generous (20 000 points per window).
* Meridian's history API clamps ranges (e.g. 3 days at 1-hour resolution, 120 days at daily);
  the client chunks requests automatically.
* Nothing is written anywhere except `localStorage` (favorites, leaderboard snapshot, chart
  preference).

## Layout

```
index.html              shell + script order
css/app.css             theme (Meridian palette, Geist font)
js/util.js              DOM/format/storage helpers, favorites
js/api.js               REST + Archive + candles + WebSocket client
js/analytics.js         series building, interval stats, position stats, margin state
js/charts.js            Chart.js wrappers
js/ui.js                tables, pagers, tiles, segmented controls
js/router.js            hash router
js/pages/*.js           home, account, favorites, leaderboard, dashboard, tax, copytrade, predict
js/predict/api.js       Predict (Sapience) GraphQL client
js/predict/analytics.js Predict normalisation, aggregation, per-wallet slim records
js/predict/resolution.js Polymarket Gamma + UMA oracle resolution tracker
js/app.js               bootstrap, sidebar, global search
vendor/chart.umd.js     Chart.js 4 (MIT)
assets/                 Meridian logo (media kit) + favicon
Start-MeridianData.*    local static server
```
