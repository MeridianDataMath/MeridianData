# MeridianDataHub

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

* **Cloudflare Pages** (recommended; works from a **private** repo, free): create a Pages project
  named `meridiandatahub` (Workers & Pages → Create → Pages → *Upload assets*, upload this folder
  once), create an API token with the *Cloudflare Pages: Edit* permission, and add two repository
  secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. From the next run the workflow
  deploys to `https://meridiandatahub.pages.dev`; attach a custom domain in the Pages project.
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
* **Leaderboard** – every subaccount on the exchange, ranked; filters for interval
  (24h/7d/30d/all), equity, volume, PnL, ROI, win rate, Sharpe, max drawdown, trading style.
  The snapshot is built in your browser (a few API calls per account), cached in
  `localStorage` and rebuilt when older than 30 minutes or when you press **Update**.
* **Dashboard** – all markets with live mark price, 24h change, bid/ask, funding, open interest,
  volume, sparkline and mPerp closure windows; a **stop map** (every account's take-profit,
  stop-loss and entry-stop levels per market as a ladder around the mark price, sized by
  notional, with the accounts behind each level); live trade tape (taker/maker links to the
  accounts); liquidation feed; funding table.
* **Tax center** – per subaccount and tax year (or custom UTC range): net result, realised PnL,
  fees, funding, deposits, withdrawals, monthly breakdown, closed-positions ledger, and CSV
  exports (summary, daily ledger, closed positions, fills, transfers, Koinly universal template)
  plus a print-friendly view. Records only, not tax advice.
* **Predict section** (Meridian's prediction markets, powered by Sapience; separate sidebar group):
  * *Overview* – exchange-wide totals, wagered and count per day, a live prediction tape,
    category and single-vs-combo breakdowns, market makers, secondary-market trades.
  * *Bettors* – every bettor ranked by net PnL with ROI, win rate, average odds, combo share,
    average vig paid, best win and last activity; click through to a bettor page.
  * *Questions* – explorer over all 77k questions: search, category, open/settled, sorted by
    Meridian open interest, end time or newest; implied probability, Meridian OI, source volume,
    link to the mirrored source market.
  * *Market makers* – who takes the other side of the RFQ auctions: share of flow, collateral
    committed, open exposure, PnL, win rate, vig captured.
  * *Vig & edge* – the bettor's locked odds versus the source market's probability, overall,
    per category, per odds bucket, singles vs combos, and per week.
  * *Bettor page* – PnL curve, daily volume, open positions with locked odds vs the source now,
    full prediction history, category and combo breakdown (also the **Predict** tab on every
    perps account page). The Tax center gains a Predict block with realised PnL, monthly table
    and two CSV exports.
  **How the Predict data gets there.** The Predict API refuses datacenter IPs (GitHub's
  runners get 403) and only allows browsers from Meridian's own origins (CORS allowlist), so:
  `scripts/Update-PredictSnapshot.ps1` runs on a normal PC (portable Node in `../tools/node`
  or any `node` on PATH), pulls every prediction since launch paced under the API's 200
  requests/minute, and force-pushes a single parentless commit to the `snapshots` branch
  (`predict.json` + one slim file per wallet in `bettors/`). `scripts/Install-SnapshotTask.ps1`
  schedules that every 30 minutes. The Pages workflow copies the branch into `data/` on each
  run and the site also reads it straight from `raw.githubusercontent.com`, taking whichever is
  newer. On the public domain every Predict page therefore renders from the snapshot; live
  queries (full-text question search, exchange-side account stats, 20-second tape) switch on
  automatically on an allowed origin such as localhost. Without any snapshot the browser
  builds the last 14 days itself.
* **Copy trading** (in development) – roadmap plus leader scouting: every wallet ranked by
  all-time PnL with ROI, win rate, drawdown and style, one click to watch or open it. Mirroring
  positions is not implemented yet; nothing on the page places orders.

The sidebar opens with labels on desktop and collapses to icons with the button at its bottom
(remembered per browser). Press `/` anywhere to jump to the search box.

## Metric definitions

* **PnL** (interval) = realized PnL + trading fees + realized funding over the interval, plus the
  change in unrealized PnL between the start of the interval and now.
* **Equity** = Σ margin balances (all pools are USD-equivalent tokens) + net unrealized PnL
  (unrealized − unsettled funding − unsettled position fees).
* **ROI** = PnL ÷ (equity at the start of the interval + deposits during it).
* **Max drawdown** = largest peak-to-trough decline of the equity curve in the interval.
* **Sharpe** = mean ÷ stdev of per-bucket PnL returns on prior equity, annualized
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
js/pages/*.js           home, account, favorites, leaderboard, dashboard
js/app.js               bootstrap, sidebar, global search
vendor/chart.umd.js     Chart.js 4 (MIT)
assets/                 Meridian logo (media kit) + favicon
Start-MeridianData.*    local static server
```
