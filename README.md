# MeridianData

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

## Run it

* **Double-click `Start-MeridianData.cmd`** — starts a tiny local web server on
  <http://localhost:8787/> and opens the browser. `Ctrl+C` in the window stops it.
  (`Start-MeridianData.ps1 -Port 9000 -NoBrowser` for options.)
* Or just open `index.html` directly in a browser — it works from `file://` too.
* Or copy the folder to any static host (GitHub Pages, Cloudflare Pages, S3, nginx…).
  There is nothing to configure; routing is hash-based (`#/leaderboard`).

## Publish it (GitHub Pages)

The repo ships with `.github/workflows/pages.yml`, which deploys the site to GitHub Pages and, every
15 minutes, rebuilds `data/leaderboard.json` with `scripts/build-snapshot.mjs` (the same code the
browser uses) so visitors get the leaderboard instantly instead of building it themselves.

1. Create a **public** GitHub repository (public = unlimited free Actions minutes) and push this folder
   to its `main` branch.
2. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**. This is a one-time
   manual step; the workflow's token is not allowed to enable Pages on its own, so until it is done
   the "configure-pages" step fails (the snapshot step before it still runs).
3. Wait for the "Snapshot & deploy" workflow to finish; the site is at
   `https://<user>.github.io/<repo>/`.
4. Optional custom domain: add a `CNAME` DNS record pointing at `<user>.github.io`, enter the domain
   under Settings → Pages, and put the domain in a `CNAME` file in the repo root.

GitHub pauses scheduled workflows in repositories with no commits for 60 days; pushing anything (or
pressing "Run workflow") re-enables it. Any other static host (Cloudflare Pages, Netlify, Vercel, S3)
works too — upload the folder as-is; without the Action the leaderboard is simply built in each
visitor's browser.

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
