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
  (`Start-MeridianData.ps1 -Port 9000 -NoBrowser` for options.) It serves only the site's own
  files (an allowlist: never `.git`, logs, scripts or anything in `agent/` beyond the four published
  files), answers only this machine, and sends the same headers as production, the
  Content-Security-Policy included, so a violation shows up locally first.
* Or just open `index.html` directly in a browser — it works from `file://` too.
* Or copy the folder to any static host (GitHub Pages, Cloudflare Pages, S3, nginx…).
  There is nothing to configure; routing is hash-based (`#/leaderboard`).

## Publish it

`.github/workflows/pages.yml` runs on every push, every 30 minutes and on demand. It builds the
perps snapshot (`data/leaderboard.json`), adds the Predict snapshot from the `snapshots` branch,
reads the Tax center's official exchange rates and the USDe/USD price (`data/fx/`, see the Tax center
below), assembles
`dist/` and deploys it:

* **Cloudflare** (recommended; works from a **private** repo, free): a Worker with static assets
  named `meridiandatahub` (`wrangler.jsonc`). Create it once in the dashboard (Workers & Pages →
  Create → *Upload assets*, upload the site folder without `.git` and `data/bettors`), create an
  API token from the *Edit Cloudflare Workers* template, and add two repository secrets:
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. From the next run the workflow runs
  `wrangler deploy` with `dist/`. The `*.workers.dev` address and the per-version preview URLs are
  switched off in `wrangler.jsonc` (`workers_dev: false`, `preview_urls: false`): wrangler treats a
  missing setting as "on" and re-enabled both at every deploy, even after they were disabled in the
  dashboard. To use them again, set them to `true` there, not in the dashboard. The public address
  `meridian.thedatahub.xyz` is a custom domain on the Worker (Settings → Domains & Routes) on the
  zone `thedatahub.xyz`, registered through Cloudflare Registrar; Cloudflare issues and renews the
  certificate itself. Turn on *Always Use HTTPS* under the zone's SSL/TLS → Edge Certificates.
  Private repos get 2,000 free Actions minutes a month; the 30-minute schedule uses about 1,500.
* Without those secrets the run fails rather than deploying anywhere else (the GitHub Pages
  fallback is gone: it only worked for public repos).

How the workflow keeps the Cloudflare token safe:
- Only the deploy step receives the token. The tests, builders, npm and git never do.
- Third-party actions are pinned to commit SHAs.
- The build tools (the card renderer and wrangler 4.141.0) install from the root
  `package-lock.json` with `npm ci --ignore-scripts`, every package with its integrity hash.
- Nothing is checked out with stored credentials.
- From the `snapshots` branch, only regular JSON files in the published layout are copied.
- A missing or empty Predict snapshot fails the run, so the previous deploy stays live.

The Predict snapshot is produced on a PC (see the Predict section below) whichever host is used.
`_headers` sets cache and security headers on Cloudflare, including a Content-Security-Policy:
- Scripts may come only from the site itself, plus `index.html`'s one inline script, allowed by its
  sha256. Recompute the hash when that script changes; `tests/cards.test.mjs` fails when they
  disagree.
- `connect-src` lists the APIs the site calls (the Tax center's rate and USDe price fallbacks, frankfurter.dev and
  DefiLlama's coins.llama.fi, included; `tests/cards.test.mjs` checks every host `js/tax/fx.js` calls is named), plus
  `https:` for a self-hosted ntfy server. `Start-MeridianData.ps1` reads the same block from `_headers` when it starts.
- The share pages under `/a/` and `/p/` redirect through `js/share.js`. They avoid a meta refresh,
  because Facebook's crawler would follow it to the home page's card.
- User-supplied links (`href`/`src`) must be relative or http(s). `U.h` never writes raw HTML, and
  it turns objects in a text position into plain text.

**Tests.** `node --test "tests/*.test.mjs"` (Node 22+, no dependencies, no network, a few
seconds) runs before anything else in the workflow; a failure stops the job, so nothing is
deployed. They load the site's own scripts the way the snapshot builder does and cover the money
math: the Predict secondary-market ledger with the cases checked against the exchange
(`predict-ledger`), the snapshot builder's reader of position-token burns against a fake RPC
that refuses wide ranges (`predict-burns`: the width the refusal names kept across runs, every
token read once to the head under each run's cap, a wallet's `rd` only once each position it held
at a paying verdict is accounted for), prediction semantics, result chips and a bettor page's headline figures
(`predict-analytics`), the copy simulator's and paper copy's sizing, cap, reductions, funding
share, position records and cost basis (`copy-engines`), the copy agent's decisions (`agent`:
the lines between `@pure-begin` and `@pure-end` in `agent/copy-agent.mjs`, loaded on their own
since the agent needs ethers and a key), account analytics, the copy profile and the
copyability caps (`analytics`), formatting and routing (`util`), the bar chart's value-axis
formatter (`charts`), the Tax center's time zones, periods and archive ledger (`tax-tz`,
`tax-periods`, `tax-ledger`: also each pool's level at the period's instants, the part of a split
day after the end left out), its exchange rates (`tax-fx`: each currency's source and
convention, the fallbacks, the session cache, the rate and rate date on every converted amount)
and the deploy-time rate builder (`fx-build`: parsers and checks on answers captured once from
the ECB, NBP, the Bank of Canada and DefiLlama's USDe price, in `tests/fixtures/fx/`), and its per-fill core
(`tax-fills`, `tax-funding`): fills to positions at a close/open tie, the replay at average entry
against the exchange's own per-fill realized PnL, every UTC day's disposals against the archive,
the liquidation fill as a disposal of its own, the holding period in calendar dates (and Form 8949's
Rev. Rul. 66-7 month-end reading), funding
received and paid per settlement with the per-day fallback, what is charged and not yet settled,
mPerp position fees split hour by hour, both readings of funding and position fees, the
Disposals and Funding settlements files, and the event loader (reading to the end of the hour an India period
ends in, which the ledger counts whole; `load.span` not reading again what another read of the tab covers, done
or still running, so the USDe lots' whole history after the period's trade detail asks only for the rest, while a
failed, cancelled or truncated read, or an open one for transfers, is read afresh; `load.detailSize`, the size above
which the trade detail waits to be asked for), on three real subaccounts captured
once with GET requests (`tests/fixtures/tax/`: a market maker with many partial closes, a
liquidated account, an XAU short with position fees). Its Predict record (`tax-predict`: both
roles, the three date bases, the gross split, the decided-not-claimed tail and, at a period
boundary, the booked-not-yet-claimed one by each basis's own booking, the record's statuses (a
traded prediction's from its tokens) and dates, the claim basis's words without redemption
times, the itemised secondary market, the daily ledger's in-period cumulative, the tile's
words) and its exports (`tax-exports`: the registry, a report's methodology rows against a tool
file's bare header, the perps daily ledger from its first active day, blank converted cells,
and the Predict files on four wallets' snapshot files kept in `tests/fixtures/tax/predict-*`,
where the record plus the secondary-market file give the Realized PnL tile under every basis,
period and zone, in USD and EUR; the Koinly and CoinTracking files' exact headers, tags, UTC times
and order, their sums against the ledger with the real transfers of 0x2f46… in
`tests/fixtures/tax/transfers-0x2f46.json`, the daily rows at 10:00 UTC, a deposit in the hour an India
period's end cuts (in the check, not the file), merged exact duplicates and
the Predict files against the tile; the Form 8949 statement's columns, MM/DD/YYYY dates, Part I and
II on and after the anniversary (28 Feb before a leap year Part I on 29 Feb), its label as one reading, totals that are the rows' sums and its check against the ledger;
the closed positions' report-currency columns at the close date and their whole-life note; the exports card's text; every
file's first row; the download toast). Its methodology, ZIP and summary (`tax-methodology`: the
record and a file's rows, the summary's parts gathered with the perps part (and its trade detail) before the holdings, methodology.txt and .json, the ZIP's central directory read back with
every CRC checked against zlib's, the classes' cash flows and totals on the three subaccounts,
Predict as a class under every basis, the summary file's Predict rows: every basis, the gross
split adding up to the realized row in USD and EUR, each basis's tail, the months' payouts), and the toast's live region
(`util`). Its USDe lots (`tax-lots`: FIFO, LIFO and the moving average,
the UK's same-day, 30-day and s104 matching on a worked example in London dates and with one pool
for everything only (a move out of a pool and a spend from it on one day never come up short), the
three scopes and both deposit readings (a conversion between pools a move of lots in each, never a
disposal), opening lots and what no lot covers, the events of a real account with position fees and
of the Predict wallets, the USDe/USD price, the files with the Form 1040 fact line at their head and
in the summary file, and 50,000 events in well under a second per run). Its holdings at an instant (`tax-holdings`: which archive bucket holds the
levels at a UTC midnight, a local midnight, a boundary inside an hour, a day the ledger kept whole
and now; cash per pool as the reconciliation has it, equity both ways, the funding not settled per
position and pool, equity now as the account page has it, the change in equity identity, the
positions open at an instant from the replay against the positions list on a real subaccount,
Predict at an instant on a worked book and four real wallets, the rate of the local day before the
instant, the B20 tile line, the summary rows and the Holdings file). Its wording, print and phone
rules (`tax-print`: the results, costs and transfers lines on three real subaccounts, each typed as
a trading result, funding, a fee or a transfer and together the balance change, before and after
the trade detail; the printed identity line in full with the period's UTC instants; no page text,
comment or README line stating a treatment; the disclaimer in every card that prints on its own;
the print block's A4 rules and the phone block's wrapping tables, the class tables folding Proceeds and Costs;
every export button with its spinner and failure toast; the neutral *held > 1 yr* chip, left out of a UK report).

**Equity curve flex.** The **Flex** button on an account page and **Equity curve flex** on a
bettor page open the account's or wallet's PnL card: headline PnL and ROI, the equity curve,
win rate, drawdown, volume or record. It comes in 24 hours / 7 days / 30 days / all time for perps
(all time for Predict), optionally with the dollar amounts hidden (the return leads, no $ anywhere),
and can be downloaded as a 2400×1260 PNG, copied, sent to the phone's share sheet, or posted on X.
It is drawn in the browser from the page's own figures (`js/flex.js` rasterises the SVG from
`js/cards.js` on a canvas, with the Geist fonts embedded), so nothing is uploaded and it works for
any account, not only those in the snapshot. The perps figures are the Overview tab's for the
period; a Predict wallet's curve is the exchange's own history when the API is reachable, otherwise
its predictions counted the snapshot's way (decided at the verdict, traded positions through the
token ledger), so it ends at the headline figure. A wallet whose predictions are not all in its
file gets the curve the snapshot built from every prediction (the file's `curve`, also on its
share card); a file built before carried one gets the card without a curve, saying why ("over 600
predictions"), rather than a partial one. That curve has one point per second (results
settled in the same second have no order between them) and is thinned to 90 points that always
keep its high and low, so the card's *peak* tag is the real one.

**Share links with preview cards.** Link unfurlers (Discord, X, Telegram, Slack…) never see the
part of a URL after `#`, where the site's routes live, so a pasted `#/account?…` link showed only
the site's generic preview. The deploy workflow therefore runs `scripts/build-cards.mjs` after
assembling `dist/`: for every perps account on the leaderboard and every Predict bettor and
market maker in the snapshot it renders a 1200×630 PNG card (headline PnL and ROI, the all-time
PnL line, record / win rate / volume and the like; artwork in `js/cards.js`, the same card as
Equity curve flex, loaded by `scripts/cards.mjs`; rendered with
`@resvg/resvg-js` and the Geist TrueType fonts in `scripts/fonts/`, SIL OFL) to
`cards/a|p/<address>.png`, plus a small page `a/<address>.html` / `p/<address>.html` that carries
the Open Graph and Twitter tags and sends people on to the page itself. Served at
`https://meridian.thedatahub.xyz/a/<address>` and `/p/<address>` (wrangler's auto-trailing-slash
drops the `.html`); the Share buttons on account and bettor pages copy these links. Predict slips
get the same at `/s/<prediction id>` (`cards/s/<id>.png`, `s/<id>.html`): the hero is the result
(net PnL once won, the stake once lost, the payout while open; where the bettor sold or traded
its position tokens, its own result with the sale, as on the slip page, so a win sold for $25
on a $500 stake reads −$475 and the payout goes "to the token buyer") beside the legs with a mark
for each. The pill reads *Live* until a leg is past the end time Meridian lists (a listed end,
not a betting cutoff) and *Awaiting result* after, and the footer invites copying only before.
The link preview's title says the same (an open slip "pays" its payout if it wins; "to win" is
the dialog's word for the profit). Cards are made for every open slip, every slip decided in the
last 7 days, the wins of the last 30 days and every big win (net PnL over $500, the bettor's own
where it sold its tokens). The Share button on a slip opens a dialog
that draws the same card in the browser (download, copy or share the image, post on X, copy the
link). A wallet or slip without a page yet, or an address in mixed case, falls through to
`index.html`, whose first script sends `/a/…`, `/p/…` and `/s/…` paths on to the hash route.
`cards/site.png` is the card of the
home page and of every other link. Rendering is deterministic and each image URL carries
`?v=<hash of the card>`, so an unchanged card is not uploaded again and an unfurler that cached
an old one fetches the new one. The leaderboard rows carry a compact all-time PnL curve
(`row.curve`, at most 60 points) for the account cards. The step is `continue-on-error`: if it
fails, the site deploys without cards and share links fall back to the site card. A card takes
about 0.1 s of one core and there are a couple of thousand, so the step runs one process per core
(`--jobs`) and starts no card after minute 12 of the job (`--deadline`), leaving the deploy room in
the 15-minute limit; slips come last, the oldest first. Locally: `npm ci`, then
`node scripts/build-cards.mjs --dist <folder with data/>` (`--only <address or prediction id>`
for one card, `--jobs 4` to use four cores).

The perps build has a time budget (`--budget` seconds, 9 minutes by default: four accounts are
built at a time and one takes two to three seconds from a PC, about half that on the Action's
runner; an active one with fills and candles takes more, and an older one more again, since its
funding charges are read three days at a time, one request after another; the job has 15 minutes in all);
accounts not reached are left out and the snapshot is marked partial (`skipped`) rather than the
deploy failing. `#/status` (**Data status**, linked from the home page's footer and from every
"stale" note) shows both snapshots' age, builder, counts and build time, plus the exchange's
round trip, maintenance flag and clock offset; the Predict builder writes a few hundred bytes to
`data/predict-status.json` for it so the page does not need the 1 MB snapshot.

### Privacy notes

* Fonts are self-hosted (`css/fonts.css`, `assets/fonts/`); no request goes to Google.
* The site sets no cookies and runs no analytics; favorites, paper accounts, alerts and preferences live in `localStorage`. Leader alerts post to an ntfy topic only if one is entered.
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
    open positions, orders & stops, fills, position history and deposits/withdrawals/conversions.
    The chart and the interval tiles count funding when it is charged (open positions' unsettled
    funding included; "Funding settled" when the archive's funding history cannot be read), and
    their fees include mPerp position fees. Line charts plot each archive bucket at its end and end
    on the live figures (the PnL line at the PnL tile, the Equity line at the live equity); the
    all-time bars are UTC days. Auto-refresh reloads the archive series whenever a balance moves
    (a close, funding settlement, fee or transfer).
  * *Live* – WebSocket-driven positions, orders, fills and an L2 order book for any market.
  * *Performance* – win rate, profit factor, expectancy, Sharpe, max drawdown, trading style,
    per-market breakdown, cumulative and daily PnL charts (both end on the all-time total, live
    unrealized PnL included); funding includes the open positions' unsettled funding, fees the
    mPerp position fees.
  * *Rewards* – points per season (rank, tier, referral points, epoch history), exchange-wide
    points, linked API signers.
* **Favorites** – starred accounts with live equity (stored in this browser only).
* **Leaderboard** – every subaccount on the exchange, ranked; sortable columns and filters for
  interval (24h/7d/30d/all), equity, volume, PnL, ROI, win rate, Sharpe, max drawdown, trading
  style. PnL, volume, ROI, Sharpe and drawdown follow the interval; equity, positions, win rate
  and trading style do not. **#** is the account's rank on the whole leaderboard in the current
  sort, also while a search or filter hides other rows. A snapshot is published every 30 minutes
  by the deploy workflow; **Update** rebuilds one in your browser (a few API calls per account),
  cached in `localStorage`; cancelling it drops the partial build and keeps the snapshot shown.
  Subaccounts that never traded (the exchange's fee collector) are tagged *no trades*; the
  exchange's own subaccount 0x1598… (it took over a liquidated trader's position and is credited
  the mPerps position fees; `AN.EXCHANGE`) is tagged *exchange account*.
* **Dashboard** – all markets with live mark price, 24h change, bid/ask, funding, open interest
  (long + short, as Meridian reports it), 24h volume (traded quantity × current mark price),
  sparkline and mPerp closure windows; the volume and open-interest tiles are the column
  totals, and products and
  projected funding are re-read every minute; a **stop map** (every account's take-profit,
  stop-loss and entry-stop orders per market as a ladder around the mark price, sized by
  notional, with the accounts behind each level; the account list is re-read on every scan);
  live trade tape (taker/maker links to the accounts); liquidation feed; funding table (rate
  charged at the last hourly funding, projected next charge, cumulative funding per unit of
  the base asset).
* **Tax center** (`#/tax?address=0x…`; the page is `js/pages/tax.js`, its parts `js/tax/*.js` under `MD.tax`) – tax
  records for one wallet: its Meridian perps subaccount and its Meridian Predict activity, for a fiscal year or any
  range of local dates, in the time zone and the reporting currency the reader picks. Everything is computed in the
  visitor's browser from the exchange's public data (GET requests only) and the published Predict snapshot. Records,
  not advice: no tax is computed, and where the rules are unsettled (funding inside a result or apart from it, the
  date a Predict result counts at, whether a deposit is a disposal, which Form 8949 box) every reading is computed
  and shown side by side, none marked as the one that applies. **MeridianDataHub is not a tax adviser**: the
  statement (`MD.tax.DISCLAIMER`, quoted under *Not a tax adviser* below) is on the page, in print and in every
  file's methodology.
  * *Using it* – an address in the picker (or **Tax** on an account page); a wallet with several subaccounts gets a
    select, and a report covers one subaccount plus the wallet's Predict wallet. Everything is in the link, so a
    shared link reproduces the report:

    | Link parameter | What it sets | Default |
    |---|---|---|
    | `address`, `sub` | wallet; subaccount when there are several | the last account viewed; its first subaccount |
    | `fy` | fiscal-year preset: `uk`, `au`, `nz`, `in`, `za`, `pk` | calendar year (left out of the link) |
    | `year` | the calendar year the fiscal year starts in | the newest year with activity |
    | `from`, `to` | a custom range of local dates, both included | none (the fiscal year) |
    | `tz` | IANA time zone | from the preset (below), written into the link silently |
    | `ccy`, `src` | report currency; `src=ecb` takes the ECB's rates for PLN or CAD | USD, or the last one chosen in this browser |
    | `pdate` | Predict date basis: `claimable`, `verdict` | claim (left out of the link) |
    | `lot`, `lscope`, `px`, `dep` | USDe lots: method, scope (`global` whenever `lot=uk`), `market` valuation, `disposal` deposit reading | none chosen (the lots are built on request) |

    The page, top to bottom: the controls (preset, year chips, custom from / to in local dates, time zone, report
    currency, rate source for PLN and CAD; every control named for screen readers by the text it shows); notices (a
    refused range, a year with no activity, a rate source stepped down); the perps card (period line in local time
    and UTC, tiles, the rate line, the trade detail's progress and checks, the balance reconciliation); *Results,
    costs and transfers*; *Gains and losses by class*; *Holdings at period start and end*; net result by month, the
    quarterly and monthly tables; *By market*; *Disposals*; *Closed positions*; *All transactions*; *Exports*;
    *Meridian Predict*; *USDe lots*; *What counts on Meridian* (notes, the disclaimer, the methodology on request);
    and a print-only *Report identity and methodology* block. A wallet with no perps subaccount gets the controls, a
    note saying so with the period and rate lines, the Predict card, the USDe lots, the holdings, an exports card
    (summary, classes, import notes, ZIP), the disclaimer and the methodology.
  * *Periods and time zones* (`tz.js`, `periods.js`) – every instant stays UTC; only its reading is local, from the
    browser's own zone data (no DST rule is hard-coded). The **Time zone** select offers UTC and every IANA zone the
    browser knows. Its default follows the preset: the browser's own zone when it belongs to that country (any
    `Australia/*` zone for Australia, Auckland or Chatham for New Zealand), else the country's zone (Europe/London,
    Australia/Sydney, Pacific/Auckland, Asia/Kolkata, Africa/Johannesburg, Asia/Karachi); the calendar year takes
    the browser's zone. A period runs from 00:00 local on its first day (the first instant of that day where a DST
    change skips midnight, as in America/Santiago) to 00:00 on the day after its last; a fiscal year still running
    ends now. Months and quarters are cut at local midnight too: a fiscal year's quarters run from its first day in
    three-month steps (UK: 6 Apr – 5 Jul, …), a custom range has calendar quarters. Years carry their country's name
    (2026/27 for the UK, Australia and India; 2027 for a year named by its end: South Africa, New Zealand,
    Pakistan), while `year=` stays the calendar year the period starts in, so old links keep working. The year list
    starts at the subaccount's creation or Meridian Predict's launch (29 Jun 2026), whichever is earlier. A `year=`
    with no activity shows the newest year with a note; a custom range that is not a real, ordered pair of days
    (2026-02-30, a start after the end) falls back to the fiscal year with a note. The period line reads like `6 Apr
    2026 00:00 Europe/London (2026-04-05 23:00 UTC) → …`.
  * *Dates and times* – fills, settlements, transfers, closes and Predict placements, claims and sales count by
    their exact instant against the local start and end, and their days and months are local dates. Event tables
    show local time (UTC in a tooltip); event files carry `Time (UTC)` and `Time (<zone>)` side by side (one column
    in UTC). The perps daily ledger keeps the exchange's UTC days. Form 8949 dates are local dates as MM/DD/YYYY.
    The tax-tool files are UTC only.
  * *Currency and rates* (`fx.js`, `scripts/build-fx.mjs`) – each amount converts at the rate of its own local date
    in the report's zone, never one rate for a period, from the source set for its currency:
    * **PLN**: NBP table A average (mid) rate of the last table published *before* the date (the convention of art.
      11a of the Polish PIT Act); the rate-date cell carries the table number (`2026-09-25 (187/A/NBP/2026)` for an
      event on Monday 28 Sep).
    * **CAD**: the Bank of Canada's daily rate (Valet `FXUSDCAD`) of that date, or of the closest preceding day it
      published one (CRA Folio S5-F4-C1 ¶1.4).
    * **Every other currency**: the ECB's euro reference rates crossed through the euro at full precision (USD→X = X
      per EUR ÷ USD per EUR; EUR = 1 ÷ USD per EUR), that date or the last ECB business day before it (weekends and
      TARGET closing days).
    * A **Rate source** select (`src=ecb`) appears for PLN and CAD only. 30 currencies: USD plus the 29 the ECB
      publishes (RON and ISK included; ISK, JPY, KRW and IDR show no decimals). PKR and EGP are not offered (no such
      rate): the page says to use the USD columns for those, and for any rule it does not implement (India's Rule
      115, the SBI telegraphic-transfer buying rate, for one).
    * **Where the rates come from.** Most central banks cannot be read from a visitor's browser (no CORS), so the
      deploy runs `node scripts/build-fx.mjs --out data/fx` (workflow step *Official exchange rates (data/fx)*,
      `continue-on-error`, so a central bank that is down never blocks a deploy): one GET of the ECB's SDMX API for
      every currency from 2026-06-01 (`EXR/D..EUR.SP00.A`, csvdata), NBP's table A for USD in pieces of at most 367
      days (with each table's number), the Bank of Canada's Valet series, and DefiLlama's daily USDe/USD price (the
      USDe lots' market valuation, not an exchange rate); a 15 s timeout and two retries each, from fixed start
      dates so the URLs stay the same between runs. Each series is checked (real ascending dates, positive values,
      no gap over 10 days, no day-to-day move over 20 %) and a source that fails is left out with a warning while
      the others are written atomically; `data/fx/index.json` lists each file's range, URL and fetch time. `data/`
      is not committed and `/data/*` is served with `no-cache`.
    * **Fallbacks**, each named in a notice at the top: the NBP or Bank of Canada file missing, starting too late or
      older than the period needs → the ECB's rates; the ECB file missing or without the currency → frankfurter.dev
      (EUR base, the same cross); the ECB file older than the period or today needs → its newest days from
      frankfurter.dev; nothing readable → USD with a red note. The page counts a file only when it answers as JSON
      (Cloudflare answers a missing path with `index.html`). frankfurter answers are kept in `sessionStorage` as
      `{at, raw}`, and one that reaches today without today's rate is read again after 15 minutes with `cache:
      'no-cache'`. Locally (no `data/fx/`) the page uses frankfurter.dev, and the USDe price DefiLlama directly
      (kept for an hour). A date whose rate is not out yet (the ECB around 16:00 CET, NBP around noon in Warsaw, the
      Bank of Canada by 16:30 in Ottawa) takes the rate before until the next deploy.
    * **On the page and in the files**: the line under the tiles names the source, its rule and the zone, with the
      latest rate (the *last rate in period* for a period that has ended), and says that a change in USDe's own
      value in the report currency between receiving and spending it is not in these figures (the USDe lots compute
      it on request). Every converted CSV amount has `<name> <CCY>`, `USD→<CCY> rate` (twelve significant digits)
      and `Rate date (<source>)` beside it. Dated amounts convert at their own date (a fill, settlement or transfer
      at its own instant, a closed position at its close, never the notional at the open date; a Predict result at
      the date of the basis chosen); amounts of right now (claimable, unrealized now) at the latest rate, named in
      the tile; values at an instant (the holdings, the unrealized PnL at a past period's end) at the rate of the
      local day before it. Amounts show in cents in every currency (whole units for ISK, JPY, KRW, IDR); compact ones
      follow the USD format (B, M and K steps, whole units from 1,000).
    * **A disposal's parts at their own dates** (`fills.js` replay, as UK CG78310 and German §20 Abs. 4 S. 1 EStG
      read it, labelled a reading): its result, closing fee and notional legs convert at the disposal date (the rate
      column); its opening-fee share (each increase's fee at the date paid, shared by quantity like the USD one) and
      the funding and position fees carried into it (each settlement at its own date) at the dates they were paid;
      its nets, proceeds and cost are built from those parts (`openFeeC`, `fundingInC`, `posFeeInC`, `netC`,
      `netAllC`, `proceedsC`, `costC`), so proceeds − cost = net in both currencies. The Disposals file, the Form
      8949 report-currency columns and totals, the disposals and by-market tables and the by-class figures use them;
      the files say so in their methodology rows.
    * **Totals from the same events.** Until the trade detail is in, the perps ledger figures convert each UTC day (or
      part of a split day) whole at the rate of the local date holding its middle. Once it is in, every report-currency
      total (realized PnL, trading and position fees, funding received, paid and net, deposits, withdrawals and their
      fees; the tiles, by type, monthly, quarterly, the summary and the holdings' change in equity) is recast from the
      events, each fill, settlement and transfer at its own local date (`fills.js` `F.ledgerC`, `ledger.js`
      `L.recast`), so the figures of one file agree (the net result is the by-class total when every position opened
      and closed in the period; funding net = received − paid). A UTC day whose events of one kind do not add up to
      the exchange's ledger keeps that kind converted whole, and the Rate rule names it; the traded volume always
      converts whole; the daily ledger file gives each day's net both ways.
    * **Rates reach back to the wallet's first activity, never clamped.** The page loads rates from the wallet's
      first possible activity (the subaccount's creation or Meridian Predict's launch, whichever is first:
      `FX.fromKey`), whatever the period, since the USDe lots and the Predict record convert amounts dated before
      it. A date before the first published rate has none (`no rate (before the first published rate)`): the
      amount stays unconverted, its converted and rate cells are blank and the rate-date cell says so, the Rate notes
      name such dates, and the holdings at such an instant show "no rate" with the USD value; it never takes a later
      rate in its place. An opening USDe lot dated before it is the one exception the lots need a figure for: its
      cost's other currency is at the first published rate, and the lots card and their methodology name it.
  * *Perps ledger and reconciliation* (`ledger.js`) – the period totals come from the exchange's archive, kept per
    UTC day as running totals per margin pool. Whole UTC days come from its daily rows; each UTC day that a local
    boundary cuts (the period's start and end, local month and quarter starts: about 14 a year, none in UTC) is
    split hour by hour from its hourly rows, read from the hour before that day; a split day on which nothing moved
    is not read at all. An hour that a boundary cuts in its middle (a zone a half or quarter hour off UTC: India,
    Adelaide, Newfoundland) counts in the period it starts in, as the page says. The hours must add up to the day's
    own row, pool by pool; a day whose hours do not (or cannot be read) is kept whole on the side holding most of
    it, and named. The archive's `endTime` is inclusive, so rows at or after the end are dropped. mPerp position
    fees have no field in the archive: they are the balance change of an mPerp pool (a token that cannot be
    deposited and is some product's quote token) that no other entry explains, booked when the exchange settles them
    (at a fill of the position); the USD pool's own residual stays a reconciliation difference instead, and an mPerp
    residual that is a credit or comes on a day without a fill is named. Opening and closing balances are the pools'
    levels at the period's instants, so the **balance reconciliation** (opening + deposits − withdrawals + result =
    closing) is exact unless the exchange changed a non-mPerp pool without an entry, which it names.
  * *Trade detail* (`load.js`) – loads on its own once the ledger figures are on screen when the period is of
    ordinary size (`load.detailSize`: at most 250 positions to replay, fills and funding charges reaching back at
    most 400 days from the period's end, a position list read whole; the largest account checked, 218 positions in
    2026, loads on its own in about 4 s). A bigger period waits: the perps card says why and offers **Load trade
    detail**, the parts that need it (the Holdings card's funding not settled at a past instant too) say it is not
    loaded yet, and an export that needs it (the summary, the ZIP, the per-fill files) starts it; the summary files
    build their holdings rows only once it is in. Once started it runs with a progress line
    (`Loading trade detail: fills n pages · positions i/N · funding j/M`) and **Cancel**, GET only and paced (pages
    one after another, everything else four at a time; a 429 is waited out): the positions (up to 100 pages); every
    order fill from the opening of the earliest position the period touches (opened before its end, open or changed
    since its start) to the end of the hour the period ends in (up to 500 pages: each position replays from its
    first fill, and the ledger's last hour is whole); the period's transfers and the hourly funding charges of the
    same range; `/v1/position/fill` four at a time for liquidated and deleveraged positions (their LIQUIDATION and
    DELEVERAGE fills are not order fills) and for any position whose replay does not give the exchange's totals; the
    daily ledger before the period when an mPerp position opened before it; and the hourly ledger only of the UTC
    days on which two or more positions of one mPerp pool were filled. Kept for the tab (`MD.tax.cache`): a range
    whose last hour ended more than 5 minutes ago is reused, one still running is extended with what happened since.
    Every export that needs it waits on the same load, with its button's spinner. If it is cancelled or fails, the
    ledger figures stay, the parts that need it say so, funding falls back to each day's net, and **Load again**
    retries.
  * *Disposals* (`fills.js`) – every fill goes to its position: a sweep per market over the positions sorted by
    opening (positions on one market never overlap, except at the instant one closes and the next opens; there a
    fill closes the old one up to what it still holds and opens the new one with the rest, its fee split pro rata).
    Each position is replayed from its first fill at **average entry**, the exchange's own method: an increase moves
    the average, a reduction books (exit − average) × quantity, sign flipped for a short. One **disposal** per
    reducing fill (a reduction, partial close, liquidation or auto-deleverage), on its own date: quantity, average
    entry, exit, gross (the exchange's own per-fill figure where read), the opening-fee share (the fees of the
    increases still open, shared by quantity closed) and the closing fee, net, the funding and position fees settled
    at that fill and those carried in (below), proceeds and cost (a labelled notional convention: a long's cost is
    its entry notional plus its opening-fee share, a short's proceeds its entry notional less it; proceeds − cost =
    net either way), the date acquired (the local date of the increases it is averaged over, or VARIOUS), held over
    a year, and partial, LIQ and ADL flags. **Gains** and **Losses** are the period's positive and negative gross;
    **Realized PnL** stays the ledger's figure, and the difference, if any, shows as *Realized PnL outside the
    disposals* (0.01 or more), with the UTC days that do not reconcile and what the hour a boundary cuts moves. *By
    market* comes from the disposals; *Closed positions* stays a whole-life summary per position fully closed in the
    period. FIFO or LIFO inside a position would split a result differently between periods: the page says it uses
    the exchange's average entry, and the fills file lists every fill.
  * *Funding and position fees* (`funding.js`) – Meridian charges funding every hour and moves it into the balance
    at the position's next fill. Each hourly charge settles at the position's first fill at or after it (the close,
    when no loaded fill follows; an open position keeps its charges unsettled), so the charges between two fills
    settle as one amount, received or paid. **Received** and **paid** are the sums of those settlements, per
    position, never netted across positions or days (0x2f46…, Aug–Sep 2026: 233.89 received and 589.60 paid, where
    netting per UTC day gave 36.32 and 392.03). Each UTC day's settlements are checked against the archive's settled
    funding; a day that does not add up (unreadable or missing charges) falls back to its own net and the page says
    `n days netted per day: settlement detail unavailable`. Two lines for information, in no total: funding charged
    in the period, and the part of it settled after it (or not yet). mPerp **position fees**: each bucket's residual
    in an mPerp pool goes to that pool's fills in it, by notional (from the hourly ledger where two positions of a
    pool were filled the same UTC day). **Both readings, side by side**, neither marked as the one that applies:
    funding and position fees as separate items on their settlement dates (the tiles, the results table, the funding
    settlements file), or inside each disposal's result (those settled since the position opened, shared by quantity
    closed: the *Net, inside* columns).
  * *Results, costs and transfers* (`summary.js` `byType`) – each line with a **Type** that says what it is (trading
    result, funding, fee, transfer), never how it is taxed: trading gains and losses, realized PnL outside the
    disposals (only when there is any), funding received and paid, trading fees, position fees, withdrawal and
    deposit fees, deposits, withdrawals. With every amount known they add up to the balance change (deposits −
    withdrawals + net result). Below it, for information: funding charged in the period and its part settled later,
    and the opening fees on positions still open at the end (in the report currency each at the date it was paid).
  * *Gains and losses by class* (`summary.js`) – classes by the market's base token: BTC, ETH, SOL and HYPE are
    crypto perps; XAU and XAG commodity mPerps; SPY and QQQ equity-ETF mPerps; any other market `Other · <ticker>`.
    Per class: disposals (with a gain / with a loss), proceeds, costs, gains (the sum of the positive results),
    losses (of the negative ones) and net, in USD and the report currency (each disposal's parts at their own dates),
    and the perps total; one table per reading of funding and position fees. Each disposal counts on its own cash
    flows, not notional: credits are a positive result (and, inside, funding received), debits a negative result and
    its trading fees (and, inside, funding paid and position fees). Meridian Predict (each date basis) and the USDe
    lots (each deposit reading) are rows of their own, never summed with perps or with each other. Which box or line
    a class goes in is not said. 0x8ddb…, 2026, inside reading: commodity gains +$555.68 and losses −$180.05,
    equity-ETF −$104.60, net +$271.03.
  * *Holdings at period start and end* (`holdings.js`, card `view-holdings.js`) – what the wallet held at the
    period's start and its end (now, for a period still running), for rules that ask for values at a date. Values,
    not results: none is in Net result or any total, and the card says so.
    * **Which archive bucket**: the archive files a bucket's end level under the bucket's start and its `endTime` is
      inclusive. A UTC midnight reads the daily bucket of the day before; any other instant the hour it falls in,
      rounded up as the ledger rounds a boundary inside an hour (India's 18:30 UTC reads the bucket ending 19:00); a
      UTC day the ledger kept whole, its edge on the side the ledger put it; now, the newest hourly bucket. One
      small unrealized-PnL read per instant (`load.upnl`); a read that fails leaves that instant without equity,
      said so.
    * **Perps, per margin pool and in total**: the cash balance (the ledger's own levels at the instant, so the
      reconciliation's balances); the unrealized PnL, price only (the archive's figure); the funding charged and not
      settled (from the trade detail's charges; now, the exchange's own `fundingUsd`); the position fees accrued and
      not settled, now only (the archive keeps no field for them); equity = cash + unrealized, and equity net of the
      unsettled funding (and now of those fees: the account page's equity); the positions open (held just before the
      instant), with size, average entry and opening date from the replay.
    * **Change in perps equity, deposits and withdrawals taken out**: equity at the end − equity at the start −
      deposits + withdrawals, price only and net of unsettled funding; in USD it equals the net result + the change
      in unrealized PnL + any balance change the ledger has no entry for (0x2f46…, 20–28 Sep 2026: −$7,507.96 =
      −$6,425.92 − $1,082.04).
    * **Meridian Predict at the instant**, at cost, from what happened before it: own predictions placed and not
      decided (stake or collateral), position tokens on undecided pick configurations at the ledger's average cost,
      results decided and not claimed (wins' payouts, voids' refunds, losses counted, tokens held to a verdict and
      not redeemed). What an open prediction is worth is not known here, and the card says so.
    * **USDe lots held**, once the lots are built: units and their cost under both deposit readings.
    * The *Open at period end* tile of a period that has ended takes the archive's unrealized PnL at the end ("price
      only, before unsettled funding and position fees · not included in Net result or Realized PnL").
    * Not here: country rate profiles, a 31 Dec 2025 step-up or prior-year value (Meridian started in 2026), marks
      per position from the oracle candles, mark-to-market worksheets.
  * *Meridian Predict* (`predict.js`, card `view-predict.js`) – the wallet's Predict wallet (the smart account the
    address owns), from the API where it answers this site, else the published snapshot (its file also brings the
    secondary market, the wallet's own redemptions, each leg's source-market resolution time and, for a big maker, a
    compact row for every prediction). Live, the claims the snapshot saw through another wallet's twin prediction
    and the source times are merged in from the file, so live and snapshot give the same claim-basis total.
    * **Both sides.** Every prediction the wallet is part of counts from its own side (a bet against itself is left
      out: it moves no money). As the bettor, its stake against the maker's collateral; as the market maker, its
      collateral against the bettor's stake. Wagered is the wallet's own collateral; tiles, tail and files are
      signed for its role.
    * **Date basis** (a select in the card, `pdate=`): *claim* (the default): a win or a void's refund when this
      wallet claims it, a loss when the counterparty claims the pool (a note says that claim is the other side's
      transaction and moves none of this wallet's money), tokens held to the verdict when this wallet redeems them
      (its own burn, from the snapshot's `rd`; while its file has no `rd`, its own claim on that side, else the
      latest claim on that pick configuration by any wallet, which the card's line, its note and the methodology
      say);
      *claimable*: when Meridian settled the result (`P.decidedAt`, exact or estimated, flagged); *verdict*: when
      the source market resolved it (`P.sourceVerdictAt`, a leg without that time at its Meridian settlement,
      flagged). Sales and matched sets are booked on their own dates under every basis. A line gives the period's
      realized PnL under all three; none is marked as the one that applies. Words: *decided (settled on Meridian)*,
      *claimed (paid out)*, *source market resolved*; never a bare "settled".
    * **Tiles**: Realized PnL (with what it is made of: claimed predictions, secondary-market sales, matched sets,
      bought tokens redeemed), winnings (payout − stake of won predictions), payouts, lost stakes, wagered,
      predictions placed and won · lost · void booked, the results not claimed by the period's end (under claim,
      those decided in the period, outside the total; under the other two, *Booked, not yet claimed*: those the
      basis books in the period, inside it, so a result resolved at the source just before the period and decided
      on Meridian in it is the previous period's under the verdict basis; each listed at its decision), the secondary
      market (sales, proceeds, purchases), and *Claimable now* / *In open positions* (live) or *Open stakes now* at
      cost (snapshot). Winnings − lost stakes + ledger gains + ledger losses = realized PnL, in USD and the report
      currency. A monthly table by local month follows. In 2026 on the claim basis: 0xc1ce… +$36.78 (19 Koinly rows,
      the record and the secondary-market file adding up to it); 0xba3b…, which only buys tokens (0 predictions, 81
      purchases), +$743.12, all of it in the secondary-market file and read as *bought position tokens redeemed*;
      0x79cb…, a maker with 5,690 predictions, +$14,465.09 from its compact rows.
    * **Big makers**: a wallet file keeps the newest 600 predictions (and older ones on pick configurations it
      traded); its `rows` hold one compact row for every prediction, so the period figures stay whole, and only the
      per-prediction record is limited to the loaded predictions (said in an amber note and in that file, whose name
      then ends in `-INCOMPLETE`). Without rows the figures are incomplete, said on the card and in every Predict
      file.
  * *USDe lots* (`lots.js`, card `view-lots.js`; on request, after the Predict card) – perps balances are
    MeridianUSD, which the exchange mints 1:1 when USDe is deposited and burns when it is withdrawn; Predict settles
    in USDe. If the reader's rules treat USDe as a cryptoasset rather than money, spending it can itself give a gain
    or loss in the report currency, and receiving it is an acquisition at its value. The card says so in those words
    (a reading, not a statement of the law) and computes that part, for Meridian activity and the opening lots
    entered only.
    * **Choices, none preselected**: a method (FIFO; LIFO; a moving average, holding periods counted first in, first
      out; UK pooling: same local day first (s105), then the next 30 days, earliest first (s106A), then the s104
      pool) and a scope (per pool: each margin pool, the Predict wallet and the wallet outside Meridian apart; per
      wallet: the subaccount's pools together; or one pool for everything); the card says the choice is the reader's
      and recommends none. UK pooling runs with one pool for everything only (`lots.scopesFor`): the page reads the
      s104 pool as one per person for each asset, not one per wallet or margin pool, so with it the other scopes are
      greyed out, a link asking for one of them gets one pool, and the card, the lots' methodology and the files say
      so. Valuation: at par (1 USDe = 1 USD, first) or at market (DefiLlama's daily USDe/USD price at 00:00 UTC of
      each local date), then in the report currency at the local date's rate.
    * **Events** (`lots.usdeEvents`): perps, in the pool of each market's quote token: the gross of every disposal
      fill, every fill's fee, each funding and position-fee settlement and transfer fee; deposits, withdrawals and
      conversions as moves. Predict (`predict.cash`), in the Predict wallet: every placement's stake or collateral
      out, a win's payout and a void's refund in when this wallet claims them, token sales in and purchases out,
      tokens held to the verdict in when this wallet redeems them (as the claim basis dates them); a loss pays nothing, and what is
      decided and not claimed is not USDe yet. Each perps pool's events must add up to the exchange's balance of it,
      which the card states (or names the pools that do not).
    * **Both readings of deposits and withdrawals**, side by side: as transfers (lots move in and out, no gain), or
      wrapping as a disposal plus an acquisition at its value. Conversions between pools move no token on chain (the
      pools are internal balances of the same MeridianUSD), so the lots read them as moves under both readings and in
      every scope, never as disposals: their units keep their lots, acquisition dates and cost (in the per-pool scope
      they move to the other pool; elsewhere both pools share one set of lots). The card, the info card and the
      lots' methodology (`Conversions between pools`) state this as the page's reading.
    * **Opening lots**: USDe acquired before it reached Meridian (where held: outside Meridian or in the Predict
      wallet; date; units; total cost in the report currency or USD), entered in the card and kept in this browser
      only (`localStorage` `md.tax.lots.<address>`, never sent anywhere). What they do not cover enters at its value
      and is said so.
    * **Results**: the fact line `USDe disposed of in the period: yes/no (N fee payments, M other)` (deposits and
      withdrawals counted apart, conversions not at all), for the US Form 1040 digital-asset question and stated
      as a fact of Meridian activity, never as its answer: on the card, as a row right after the period in the
      lots' methodology rows that head both lots files (`lots.factRow`), and in the summary file before the USDe
      lots rows; the period's disposals, proceeds, cost, gains and losses under both readings; per fiscal year and
      scope; every disposal with the rule that matched it, the dates acquired and days held; what is held at the
      end. A disposal or move that finds fewer units in its scope's lots than its flows put there is costed at its
      value and named as a gap in the matching, not in the data (data that starts late is the 'not covered' note).
      With UK pooling the events are read to 30 days after the period, and until those days have passed a disposal
      its own day does not cover whole is marked provisional. The whole history is read once (`load.lifetime`, with
      the same progress, Cancel, pacing and cache); its fills and transfers go through `load.span`, which reuses
      what the period's trade detail read (done or still running) and reads only the months outside it, with the
      request cache on every closed part. The engine uses heaps and pointers only.
  * *Exports* (`exports.js`, one registry for the buttons, the ZIP and the exports card's text) – each file is one
    of the site's own **reports** (the report's methodology as key, value rows, a blank line, then its tables; with
    a byte-order mark, so a spreadsheet reads UTF-8) or a tax tool's **import file** (exactly the tool's header as
    its first row and nothing else, no byte-order mark; its methodology is in **Import notes (methodology.txt)** and
    the ZIP). A file that cannot be whole (truncated reads, unreadable charges, a position or UTC day that does not
    reconcile, a day as a daily total, an incomplete Predict file) ends in `-INCOMPLETE`; a report says why in its
    `Completeness` row, a tool file in the download's notice (about 6 s, a polite live region) and the import notes.
    In another currency, "+ CCY" below means each amount also as `<name> <CCY>` with `USD→<CCY> rate` and the rate
    date, at the row's own date.

    | File | Kind | One row per | Columns |
    |---|---|---|---|
    | Summary | report | period | the period (local and UTC); every perps total (net result, realized PnL, gains, losses, disposals, fees, position fees, transfer fees, funding received, paid and net, funding charged and settled later, deposits, withdrawals, volume, opening and closing balance, closed / winning / losing positions, liquidation and ADL disposals, held over a year, open positions, reconciliation difference); the holdings at both instants; Predict realized PnL under every basis, its gross split under the report's basis (winnings, payouts of won predictions, lost stakes, void refunds, ledger gains, ledger losses, wagered; winnings − lost stakes + ledger gains + ledger losses = its realized row) and, per basis, the results not claimed by the end (decided in the period under claim, booked in it under the others); the USDe lots' Form 1040 fact line (USDe disposed of in the period: yes/no, Meridian activity only, a fact and not an answer) and their totals under both readings (or "not computed"); then the classes, perps by month and by quarter, Predict by month (realized PnL, winnings, payouts, lost stakes, ledger gains and losses, wagered; USD + CCY) |
    | Gains and losses by class | report | class × reading | section, class, reading or date basis, disposals (with a gain / a loss), proceeds, costs, gains, losses, net (USD + CCY) |
    | Disposals | report | reducing fill | position, market, class, side, fill no., times, quantity, average entry, exit, entry and exit notional, gross, opening-fee share, closing fee, net (separate), funding and position fees settled at the fill and carried in, net (inside), proceeds and cost (notional convention), date acquired, held over a year, partial, liquidation, ADL, position ID (+ CCY: gross at the disposal date; the opening-fee share, closing fee and the funding and position fees carried in each at the date paid; nets, proceeds and cost built from those parts) |
    | Funding settlements | report | position × settlement | status (settled; netted per UTC day; charged, not settled by the period end), settled time, UTC day, market, side, position, charged from / to, hourly charges, received, paid (+ CCY) |
    | Form 8949 statement | report | disposal | for the reading that reports each perp disposal as a capital gain or loss on Form 8949 and Schedule D (the IRS has issued no guidance on perpetual futures, and other readings, a swap / notional principal contract or a trader's mark-to-market election, report them elsewhere): Part (I / II by the anniversary rule, with Rev. Rul. 66-7 at a month's end, from the last increase), the box if a digital asset (I, L) and if not (C, F) side by side, (a) to (h) with MM/DD/YYYY dates, funding and position fees inside and (h) under that reading, time sold (UTC) (+ CCY for (d), (e), (h), built from the parts at their own dates); then totals per Part under both readings (Schedule D lines 3 and 10), the Exception 2 summary rows (code M) and a check against the ledger |
    | Closed positions | report | position | closed and opened times, market, side, size, average entry and exit, entry and exit notional, realized PnL, trading and position fees, funding (net, received, paid), net, held hours, held more than a year, liquidated, deleveraged, ID (+ CCY at the close date); each row the position's whole-life result dated at the final close (PnL, fees and funding of earlier partial closes included, before the period too), which its own methodology row says: not the period's figure, which is in Disposals and Form 8949 |
    | Daily ledger | report | UTC day (a split day in parts) | date, part, realized PnL, trading fees, funding (net, received, paid, detail), net, position fees, deposits, withdrawals, transfer fees, volume, balance at end (+ CCY for the net at the rate of the day's middle, and the net as the totals have it, each event at its own local date); from the first day with a balance or any flow |
    | All transactions | report | event | times, type (fill, funding, position fee, transfer, close), what, cash effect, fee, notional, realized PnL (+ CCY for the cash effect), detail, tx, ID; oldest first; the cash effects add up to the balance change |
    | Fills (trades) | report | fill | times, market, side, order type, quantity, price, notional, fee, realized PnL, maker, reduce only, position, order and fill IDs (liquidation and ADL fills included; no CCY) |
    | Deposits, withdrawals & conversions | report | transfer | times, type, token, to token, amount, fee, status, initiated and finalized tx, ID (token units) |
    | Perps: Koinly universal CSV | tool | event | `Date, Sent Amount, Sent Currency, Received Amount, Received Currency, Fee Amount, Fee Currency, Net Worth Amount, Net Worth Currency, Tag, Description, TxHash` |
    | Perps: CoinTracking CSV | tool | event | `Type, Buy Amount, Buy Cur., Sell Amount, Sell Cur., Fee, Fee Cur., Exchange, Trade-Group, Comment, Date` |
    | Predict daily ledger | report | local day | date, basis, realized PnL, winnings, payouts, lost stakes, void refunds, ledger gains and losses, secondary market, cumulative in the period (the last row is the tile), wagered, placed, won / lost / void booked, token positions held to the verdict (+ CCY) |
    | Predict record (all statuses) | report | prediction | side, placed, decided (exact or estimated), source resolved (flag), claimed and by whom, booked, basis, status at the period end (open, decided not claimed, claimed, sold; a traded prediction's from its tokens, as its booked date: tokens redeemed, decided redemption not confirmed (dated by another wallet's claim), decided tokens not redeemed), picks, legs, category, own and counterparty collateral, odds, result, share held, payout, cost, net, where its PnL is booked, whether in the period's total, the net at each of the three dates (+ CCY each), prediction and pick configuration IDs, placement and claim tx |
    | Predict secondary market | report | trade, set or held position | times, kind (bought, sold, held to verdict, both sides held), dated by, prediction, side, counterparty, tokens, price, amount, average cost, realized PnL (+ CCY), IDs, tx; no total rows |
    | Predict decided, not claimed (*booked, not yet claimed* under the other bases: what the basis books in the period) | report | result | decided (exact or estimated), booked (the other bases), placed, picks, source, side, tokens, cost, claimable, result, PnL at the decision (+ CCY), claimed after the period, whether in the period's total, basis, ID |
    | Predict · Koinly universal CSV, Predict · CoinTracking CSV | tool | result, sale or set | the tools' headers as above |
    | Holdings at period start and end | report | value × instant | instant, times, item, detail, count, USD, CCY with the rate of the local day before, note; the positions open at each instant; the change in equity and what it is made of |
    | USDe disposals (lots) | report | disposal | times, scope, held at, kind, what, units, proceeds, cost, gain or loss (+ CCY), matched by, acquired, holding days, held over a year, units without a lot, provisional (UK), reading, ID, tx; the matched pieces; per fiscal year and scope under both readings; the pools at the end |
    | USDe flows | report | unit movement | times, in period, direction, held at, moved to, kind, what, units, USD per USDe, value (+ CCY), source, ID, tx; from the account's first event to the period end |

    * **The tax-tool files** are built from events, not daily totals: times in UTC as `YYYY-MM-DD HH:mm:ss` (import
      as UTC), oldest first, a deposit before results at the same instant, amounts in USDe. Perps Koinly: `realized
      gain` per disposal fill (Received for a gain, Sent for a loss, its closing fee as Fee Amount), `futures fee`
      for the fee of a fill that closes nothing and each position-fee settlement, `funding fee` per funding
      settlement, `other fee` for a transfer fee on its own; deposits (Received, net of the deposit fee, no TxHash:
      a deposit's finalized transaction is the exchange's relayer transaction, which Koinly would not match) and
      withdrawals (Sent, the fee as Fee Amount, the payout transaction as TxHash) untagged; conversions left out.
      Perps CoinTracking: `Derivatives / Futures Profit` or `Loss` per disposal fill with its fee, `Margin Fee` for
      other fill fees and position fees, funding as `Other Income` / `Other Fee` in Trade-Group `Funding Rate`,
      `Deposit`, `Withdrawal`, `Other Fee`. Each kind is checked UTC day by UTC day against the ledger; a day that
      does not add up (or every day without the trade detail) is that day's ledger total stamped 10:00 UTC (which
      keeps its date from UTC−10 to UTC+13), and the file says so. Rows a tool would skip as exact duplicates are
      merged, amounts added. Predict Koinly and CoinTracking: one row per result booked under the card's basis, sale
      and matched set (`realized gain`; `Derivatives / Futures Profit|Loss` in Trade-Group `Predict`), the wallet's
      own claim transaction or the trade's as TxHash, adding up to the Realized PnL tile. The perps and Predict
      files are separate, so importing both counts nothing twice. Neither file has been test-imported into either
      tool: whether CoinTracking reads these column names and how either tool treats each type could not be checked
      without an account.
    * **Form 8949 statement**: built for one reading, labelled as such on its button and in its methodology row:
      each perp disposal reported as a capital gain or loss on Form 8949 and Schedule D. The IRS has issued no
      guidance on perpetual futures, and other readings (a swap / notional principal contract, a trader's
      mark-to-market election) report them elsewhere. Part II only when the last increase a disposal is averaged
      over is more than a year old (stricter than counting from the position's opening, and said in the file), the
      anniversary read with Rev. Rul. 66-7 at a month's end (below). (d) and (e) follow the notional convention with
      fees inside (there is no Form 1099), so (f) and (g) are blank; (b) is VARIOUS where the increases fall on different local dates; the check row sets
      Σ(h) against the ledger's realized PnL − trading fees, item by item (realized PnL outside the disposals, fees
      of fills in an hour a boundary cuts, fees of fills in no disposal, opening fees carried in and still open),
      and is 0 on every account checked. No code E or aggregated mode, no TurboTax file (its gains columns could not
      be confirmed), no Predict rows (their classification is unsettled), no loss limit.
    * **The exports card** says, from the registry, which files add the report currency beside each amount, which
      add only the net, which have none, and which are per event, per UTC day, per position or period totals.
  * *Methodology, import notes and the ZIP* (`methodology.js`, `zip.js`) – one record per report, as key, value
    rows: report, disclaimer, wallet, subaccount (name and ID), Predict wallet, report link, period (local and the
    exact UTC instants), fiscal year, time zone, report currency, rate source, rate rule (with the holiday rule and
    the date convention), latest rate and rate notes, how times count, USDe valuation, perps disposals, perps fees,
    proceeds and costs, funding and position fees (both readings), holding period, Meridian Predict (the basis used
    and the others computed beside it) and its data (snapshot build time or live), USDe lots (method, scope,
    readings, opening lots, or not computed), the tax-tool files, data sources, completeness (truncations, failed
    checks, netted or daily days, an incomplete Predict file), generated (UTC) and site version. A file's own rows
    join it (the holdings' and the lots' describe rows, the classes' and Form 8949's notes: a new key before Data
    sources, except the lots' Form 1040 fact line, right after Time zone) and its `Completeness` row is its own. It is shown on screen (*Methodology of this report*, under the notes), printed, written first in
    every report file, and in the ZIP. **Import notes (methodology.txt)** (perps exports card and Predict card)
    holds the record, each tool file with what it misses, and the tools' notes (headers, tags, UTC, daily rows).
    **Download everything (ZIP)** (stored entries, UTF-8 names, CRC-32, no dependency) waits for the trade detail,
    the holdings' reads and the Predict data, and holds every file of the report (the summary and classes, every
    perps file the trade detail allows, the Predict files under the card's basis, the holdings, the USDe lots once
    built), each named as its own download, plus methodology.txt (the record, the files and what each misses, what
    was not included and why, the tool notes) and methodology.json (the same as data).
  * *Print and phone* – **Print / PDF** prints the whole report: the identity line at the top (the full wallet, the
    subaccount's name and ID, the Predict wallet, the period in its zone with the exact UTC instants, the time it
    was generated), the balance reconciliation open, every row of the disposals, closed-positions and transactions
    tables (above 2,000 disposals the per-position-per-local-day view, with a note; the USDe lots the newest 2,000),
    the Predict card with its addresses in full and the basis in force, *Not computed for this report* for lots not
    built, the disclaimer in every card that prints on its own, and the *Report identity and methodology* block.
    Tables print at 9px with text cells wrapping and amounts on one line, so every table fits an A4 page; controls,
    buttons and the definitions link are left out. On a phone (`max-width: 720px`, screens only) the results,
    reconciliation, quarterly, class and holdings tables wrap their text and keep amounts on one line; the class
    tables (*Gains and losses by class* and its *Other sections*) fold Proceeds and Costs into a line under the
    name, so Disposals, Gains, Losses and Net stay in view; wider tables scroll sideways. Every export button shows a
    spinner while its file is built and a toast (*Export failed: …*) if building it throws.
  * *Conventions* (each named in the methodology) – a disposal is a reducing fill, booked against the position's
    average entry (the exchange's method), its trading fees inside its result; each position is its own lot.
    Proceeds and costs follow the notional convention in the disposals and Form 8949, and cash flows in the classes.
    Held over a year: sold on or after the day after the acquisition's anniversary in local dates (29 Feb's
    anniversary is 28 Feb), from the last increase a disposal is averaged over. Form 8949's Part also follows the
    IRS's month-end ruling (Rev. Rul. 66-7: an asset acquired on the last day of a month is held more than six
    months only from the first day of the seventh month after; read here for one year, the 13th): an increase on
    28 Feb 2027 sold on 29 Feb 2028 is Part I there and held over a year elsewhere (`tz.heldOverYear(…, 'us')`).
    The flag on screen is a neutral *held > 1 yr* chip, left out of a UK report; the files keep the column in every
    report. Funding and position fees are
    computed both ways. Amounts are USDe at 1 USD unless the USDe lots value them at market; the report currency is
    the rate of each amount's local date; values at an instant use the local day before. Daily rows in tool files
    sit at 10:00 UTC. An hour that a boundary cuts in its middle belongs to the period it starts in, in the ledger;
    events count by their exact instant, and the page shows what that hour moves.
  * *Checks the page runs*, each said where it fails: the balance reconciliation per pool; each UTC day's disposals
    against the archive's realized PnL; each position's replay against the exchange's quantities, notional and
    realized PnL (re-read from its own fills when it fails); each UTC day's funding settlements against the
    archive's settled funding; each UTC day's position fees against the mPerp residual; the transactions' cash
    effects against the balance change; Form 8949's Σ(h) against the ledger, item by item; the tax-tool files per
    UTC day and kind; the hours of a split day against its daily row; each perps pool's USDe events against its
    balance; the Predict record plus the secondary market against the Realized PnL tile. The tests and the
    end-to-end check below also hold each closed position's settlements against the exchange's `fundingAccruedUsd`
    and its position fees against `positionFeeAccruedUsd`.
  * *Verified end to end* (3 Oct 2026, GET only, Predict from the published snapshot; the harnesses are not part of
    the repository) – perps: 0x8ddb… (mPerp position fees), 0x7c75…, 0x8003… (liquidated), 0x2f46… (market maker,
    funding) and 0x5853… (with Predict wallet 0x0fbf…), each in UTC, Europe/London, Australia/Sydney and
    Asia/Kolkata, for the fiscal year and for 15–27 Sep 2026, in USD, EUR, PLN (NBP and ECB) and CAD (Bank of Canada
    and ECB): 240 reports, 18,748 checks, all passing (reconciliation exact; disposals = the archive per UTC day;
    funding per settlement and per position; position fees per day and per position; every tile against its file;
    every file parsed back as a spreadsheet reads it; tool headers exact; every ZIP read back with zlib's CRC-32).
    Predict: 0xc1ce…, 0x79cb… (maker), 0xba3b… (buyer), 0x7ff8…, 0x0fbf… and 0x0dc6… in the same zones and
    currencies under all three bases (4,879 checks), and every snapshot wallet × preset × year × basis (742 wallets,
    20,034 runs): the record plus the secondary market = the tile (for a big maker, the loaded predictions' part),
    the Koinly file = the tile, the gross split identity. 0x0fbf…, UK 2026/27: 73 results (52 won, 20 lost, 1 sale)
    adding up to −76.407197 = the tile, in 72 Koinly rows (two exact duplicates merged). 0x7ff8…: five losses
    decided 30 Sep 2026 22:19 UTC and claimed by the counterparty on 1 Oct are Q3 under *claimable* and *verdict*,
    Q4 under *claim*, and listed in Q3's decided-not-claimed. 0x0dc6…: a $2 loss claimed 30 Jun 2026 19:51 UTC is in
    Sydney's and Karachi's 2026/27 (2027) year. USDe lots on seven wallets, every method, scope, reading and
    valuation: 3,970 checks, every perps pool's events = the exchange's balance. The largest account (0x2f46…: 1,979
    fills, 218 positions, 2,028 hourly charges in 2026) loads its trade detail in about 4 s with 28 GETs and
    progress at least every second, then 12 ms of work; 44,050 synthetic fills with 90,046 charges take 0.4 s, every
    perps file 1.2 s (26 M characters), four lot methods over 85,000 USDe events 2 s. The page renders without a
    script error. Fixed by this check: a period ending inside an hour (India) now reads its fills, charges and
    transfers to the end of that hour, so its last UTC day reconciles (and the tab keeps it open until that hour is
    over); the holdings at a period end inside a UTC day now take the pools' levels at that instant, not at the
    day's end; and `js/dev/sim-tax.js` now keeps one position per market at a time and answers for its own position
    fills and funding charges, so its report reconciles and nothing about it is sent to the exchange.
  * *Out of scope*, on purpose:
    * computing tax: tax due, rates, deductions, allowances or loss limits (the US capital-loss limit, the UK annual
      exempt amount, a gambling-loss cap and the like): the page gives gross gains, gross losses and counts;
    * choosing a treatment where the law is unsettled: how a perpetual is classified, funding inside or outside a
      result and at settlement or accrual, the regime and the date of a Predict result, deposits as disposals, USDe
      as money or a cryptoasset, which SA108 or Form 8949 box: every reading is computed and shown side by side,
      none marked as correct;
    * trader, business or professional status, and elections (mark-to-market, a lot method required per wallet): the
      page shows the facts and lets the reader pick a method, recommending none;
    * anything needing holdings or activity outside Meridian beyond the opening lots entered on the page: a pool
      over a whole holding (UK s104, Canada's ACB, Sweden's average, France's portfolio value), wash sales or
      straddles against positions elsewhere, total wealth; the USDe flows file serves tools that keep a whole
      portfolio;
    * residency, part-year residency, state conformity, connected persons, joint or household filing;
    * filing or submitting returns, signing forms or certifying figures;
    * classifying Meridian or Sapience (reporting provider, licensed venue, a foreign account for any return);
    * a counterparty's residence or the country of source of a result;
    * when a claimable win counts as received: the decided, claimable and claimed dates are given instead;
    * certifying a USDe price or an official rate where the law names none: the source and the rate date are on
      every row;
    * pending or future legislation.
  * *Not built*, deferred by the plan with its reasons:
    * specific identification of USDe lots: it needs an identification made at the time of each disposal, which a
      records page cannot make after the fact (offering it afterwards could give records that do not meet the rules
      that allow it); FIFO, LIFO, the moving average and UK pooling are built and the reader picks one;
    * the other official rate sources (the Bank of England's XUDLUSS, HMRC's monthly rates, the Riksbank, Norges
      Bank, Danmarks Nationalbank, the ESTV, the RBA, the RBNZ, the SARB, the SBP, India's Rule 115 SBI TT buying
      rate) and the monthly-average and year-end conventions: no rule checked requires them, SBI publishes no API,
      and each is a few lines in `scripts/build-fx.mjs` and `fx.SOURCES`; until then the USD columns serve;
    * an India Schedule VDA file: the Disposals file already has the acquisition and transfer dates, cost,
      consideration and gains and losses listed apart, and the form under the 2025 Act is unverified;
    * a Hong Kong fiscal-year preset: a custom range covers it;
    * an Australian 12-month CGT flag: *held over a year* (the disposals' column and the chip) covers the fact;
    * a TurboTax file: its column list could not be confirmed.
  * *Not a tax adviser* – `MD.tax.DISCLAIMER`, verbatim: "MeridianDataHub is not a tax adviser. These are records,
    not tax advice: the rules for perpetual futures, funding and prediction markets differ by country, and no tax is
    computed here. Use these records with a professional or a tax tool." It is in the notes card, on a wallet with
    no perps subaccount, in the USDe lots and Holdings cards (each prints on its own), in the printed methodology
    block, in every report file's methodology rows, in methodology.txt and methodology.json and in the import notes.
    The header chip reads *records · not advice*. Where a text speaks of a treatment it is a reading ("if your rules
    treat USDe as a cryptoasset …"), and a test scans the page, the tax modules, the definitions and this README for
    a treatment stated as fact.
  * *Code and tests* – `js/pages/tax.js` keeps the picker, the period and currency controls, the layout, the notes,
    the methodology on screen and in print, the summary files, the ZIP and the import notes; the cards are
    `view-perps.js`, `view-predict.js`, `view-holdings.js` and `view-lots.js`; every other module is pure (no DOM,
    no network) except `load.js`, `fx.load` / `fx.usde` and `ui.js`, so the tests load them in Node (see *Tests*
    above). `js/dev/sim-tax.js` (not loaded by the site) fakes a busy two-year account whose daily and hourly ledger
    is built from the same events, one position per market at a time, with its own position fills and no hourly
    funding charges (funding nets per UTC day), answering for its own account without calling the exchange:
    `MDSim.install()` in the console, then open `#/tax?address=<its address>`; the report reconciles, every UTC day
    and every position.
* **Predict section** (Meridian's prediction markets, powered by Sapience; separate sidebar group):
  * *Overview* – exchange-wide totals, wagered and count per UTC day, a live prediction tape,
    category and single-vs-combo breakdowns, market makers, secondary-market trades.
    Everything on it comes from one snapshot: a newer one published while the page is open is
    offered in the tape's header (*newer snapshot published · show it*) rather than mixed in,
    and the snapshot's age line keeps counting. Where the aggregate has no secondary-market
    trades (the browser build, a failed trades fetch), the tiles and notes that would count
    them say they are not counted.
    **Big wins** sits beside the tape (stacked when the page is narrower than about 1240 px). It
    lists every bettor win whose net PnL (payout − stake) is above $500 (`P.BIG_WIN`), counted
    at the verdict, claimed or not. For a bettor who traded its position tokens, the net PnL is
    its own result, sale included, so a win sold for little is not one.
    - *Row.* Each row shows the stake, the multiplier (payout ÷ stake) and the PnL (payout −
      stake). The payout itself is in the prediction's dialog.
    - *Sorting.* Latest settlement first by default, or by PnL or multiplier. A row's time is
      when the win was settled (decided), never when its payout was claimed, which can be weeks
      later: 0x4a72… settled Sep 13 and was claimed Sep 29. A win settled but not claimed yet is
      listed all the same, with an *unclaimed* chip, and the card's header counts them. The
      tooltip has the settlement, claim and placement times. The same rule holds across the site:
      a result is dated at its settlement.
    - *Settlement time.* When the win settled on Meridian: its last leg's `condition.settledAt`
      (`P.legVerdictAt`), stored as `da` on every decided record (see *Settled vs claimed*
      below).
      - Older records without leg times fall back to Polymarket's resolution time, which the
        builder looked up once for big wins and cached in the price cache (`resolved`), then to
        the listed end, never after the claim.
      - A leg's listed end can be a day late: a price question about Sep 28 is listed to end on
        the 29th.
    - *Sold positions.* A bettor who sold its position tokens before the verdict does not collect
      the payout.
      - A win it sold for less than $500 of its own result is left out. One partly sold is
        marked *x% sold*, and its PnL is the bettor's own result, the sale included (`h` and `lp`
        from its token ledger).
    - *Snapshot.* The snapshot carries the list as `agg.bigWins` (slim records with every leg's
      question id).
  * *Any prediction opens a dialog.* This covers the tape, big wins, a question's predictions and
    a bettor page's history and open positions. The dialog shows:
    - the result, stake, payout, odds, PnL and vig;
    - the bettor and the market maker, and the placed, settled and claimed times;
    - every leg with its result: Meridian's own once it has settled the question, before that
      Polymarket's. Leg questions link to that question's dialog, and ⓘ opens the resolution
      details;
    - **Open bettor's account**;
    - **Copy slip to Meridian** while the site still offers the slip (see Slips), and **Slip**
      (the slip page).

    A loss dates from the first leg that went against the bettor: its other legs may run for
    weeks. Where the bettor sold its tokens, the dialog shows its own result and who collects
    (only a win has a payout for the token buyer). "Won" is never the payout: the sentence says
    what was paid on what stake, as the slip page does. Slim legs carry Meridian's result for a
    settled question as a 9th element (1 YES, 0 NO, 2 50/50).
    - An undecided prediction whose legs already tell says so, as the question dialog does: *lost
      · awaiting settlement* once a leg went against the bettor (Meridian's result, else
      Polymarket's, 50/50 included), *won on Polymarket · awaiting settlement* once every leg went
      its way. The dialog, the slip page and a bettor page's history all use it.
    - A leg shows when Meridian settled it, or else the end time Meridian lists for it. That is a
      listed end, not a betting cutoff: Meridian has taken bets after it (566 legs in 335
      predictions by 2026-09-30, the latest on Sep 30).
    - A won prediction's leg Meridian has not settled reads *paid as won*, not *won* (only the
      $1 test against 0x3106…: paid ten minutes after the bet while its question runs to
      December). A settlement time is never dated from a listed end before the bet.
    - The self-matched prediction (one wallet on both sides) says so: *Wallet PnL* $0, no vig,
      and a note that it is left out of the Predict figures.
    - *Secondary market*: when only other wallets traded the tokens on these picks, it says this
      bettor sold none; where the bettor's own trading is unknown (a maker's page), a lost
      prediction claims no payout for a buyer.
  * *Dialogs.*
    - Dialogs stack, and Escape closes the top one.
    - Any page change closes them all: a link, Back or a notification.
    - The top dialog takes the keyboard focus, and the page behind it is inert. Focus returns
      where it was when the dialog closes.
    - Live tapes hold still while a row has the keyboard focus.
  * *Slips* (`#/predict/p/<predictionId>`, Meridian's own path). `index.html` redirects
    `/predict/p/<id>` there, so a link from the app works with the domain swapped. One prediction
    as a card like Meridian's shared-prediction page:
    - size, payout, max gain (or the result, with who collects when the bettor sold its tokens),
      and each leg with its live Polymarket chance and where it stands;
    - **Copy slip to Meridian Predict** opens Meridian's page for that prediction
      (`app.meridian.xyz/predict/p/<id>?ref=<code>`). Its **Add To Slip** adds the same picks to
      the visitor's bet slip, next to anything already there. No other site can fill Meridian's
      slip directly: it lives in the app's own storage.
    - The app keeps `?ref=` as its pending referral code (checked 2026-09-29), so a copied slip
      brings the visitor in under the site's code (`MD.api.REF`; every link to the app carries
      it).
    - The page stops offering to copy a slip once it is decided, or once any leg is past the end
      time Meridian lists for it, settled on Meridian, or its Polymarket market closed. The listed
      end is the site's own line, not Meridian's betting cutoff (Meridian has taken bets after
      it), so no text calls it one: such a slip reads *awaiting result*, and its card's pill says
      the same.
    - The chances are Polymarket's once it answers; until then (or if it fails) they are
      Meridian's estimates from the snapshot, and the labels say so (*Estimate (snapshot)*).
    - Locked odds below 1 never read 100% (99.9%, floored as the resolution tracker's prices),
      and a multiplier below 1.01× keeps four decimals (1.0001×).
    - **Share slip** copies the page's link. `#/predict/p` without an id takes a pasted Meridian
      link.
    - The snapshot carries every prediction by id in `slips/<first two hex digits>.json`, about
      25 KB each today and growing with the count, so a slip link loads one small file. Where the
      bettor traded its tokens, records carry `h` and `lp`, as big wins do, and so do the records
      in the question and wallet files: a prediction opened from a question or from its maker's
      page shows the bettor's side as it stood (sold, the payout to the token buyer, its own PnL).
    - A slip file that cannot be read is reported as such (with a retry), not as a missing
      prediction.
  * *Snapshot compatibility.* Tape rows (`P.compact`) keep every field they always had and add
    the legs (`k`), so a page that has not reloaded still reads a new snapshot. `P.full` turns
    any stored row back into a full record. The snapshot is published before the page code
    deploys, so its format only ever gains fields: the bettor and maker rows' `vigN` (how many
    predictions their Avg vig covers), `recentFrom` in `predict.json` and `predict-status.json`
    (how far back the Questions list's recently settled tail reaches), a wallet file's `newest`
    (how many of its predictions are the newest; in a truncated file the rest are older ones on
    traded positions), and in a truncated file `curve` (the cumulative PnL from every prediction,
    `curveFromPredictions`) and `daily` (the stake per UTC day, `[day, USD]`), both for the role
    its page counts.
  * *Bettors* – every bettor ranked by net PnL with ROI, win rate, average odds, combo share,
    average vig paid, best win and last bet; click through to a bettor page. The count line
    says what is filtered (*364 of 733 bettors · 3+ predictions*), `#` is the place on the
    filtered board, and a full address is found whatever the filters.
    - *ROI* (`P.roiOf`): net PnL, the secondary market included, ÷ the stakes of decided
      predictions (claimed or not) plus the sold share of open ones (a sale books its result before
      the verdict, so its stake joins the base). A bettor page counts it the same way, and a maker's
      page reads the maker's own row (ROI on its committed collateral, Avg odds = its bettors' odds).
    - *Best win*: the largest net result on one decided prediction; where the bettor traded the
      tokens, its own result with the sale (as the Overview's big wins count it).
    - *Top category*: the category with the most predictions; a tie goes to the larger stake, then
      the name (`P.topCategory`).
  * *Questions* – only the questions people have bet on through Meridian (those with money still
    on them, open predictions or decided ones not yet claimed, then the questions of the most
    recently settled predictions, about 1,200 in all; the footer says how far back that tail
    reaches, `recentFrom`; the exchange itself lists 85k):
    search, category, open / ended-unsettled / settled / all (Open by default), sortable columns
    (stake ever placed on Meridian first); probability, Meridian OI with the number of
    open bets and stake, source volume, link to the mirrored source market. *Probability* is
    Polymarket's YES price now (its first outcome, the one Meridian's YES mirrors), loaded for the
    rows on screen; until it has loaded, the `estimatedPrice` Meridian's API reported at the
    snapshot, which stops following the market once a game starts. A settled question shows its
    result instead, and the column sorts by what it shows. *Staked on Meridian* and Meridian OI
    count a combo in full on every question it includes, so they overlap across rows and add up
    to no total (the footer says so). Meridian OI is the
    collateral still in escrow on the question, worked out from the predictions: stake + maker
    collateral of every prediction on it not yet claimed (open, or decided and unclaimed), a combo
    in full on each of its questions. That matches the API's `openInterest` on nearly every row
    the API lists (125 of 133 on 2026-10-02), but the API reports 0 for unlisted questions and the
    builder does not ask it about settled ones, so every row gets this figure. Self-matched
    predictions are left out of the list's counts, its stakes and its question files, as
    everywhere else. On an origin with live API access a link
    switches to the full explorer over every question. A **Resolution** column says when and
    how each question resolves: the Polymarket market's end (and the fixture time for sports,
    which moves when a game is postponed), Meridian's own listed end time when it is earlier (a
    listed end, not a betting cutoff: Meridian has taken bets after it), and
    the live position in Polymarket's UMA pipeline — *awaiting proposal*, *proposed X, challenge
    window ends 15:42*, *disputed*, *UMA vote*, *resolved on Polymarket, not settled on Meridian
    yet*. The ⓘ button opens the proposal / dispute details and the market's resolution rules.
    The same per-leg status sits on the open positions of every bettor page. Every question row
    opens a panel with the actual predictions on it: bettor, stake, odds, payout, maker, and every
    leg of the combo with its own state, since a combo pays only if all legs resolve for the bettor.
    On the Ended tab, an ended question none of whose open predictions can still win (each has a
    leg resolved against its bettor, or 50/50, on Polymarket) is left out and counted under the
    list; the other tabs list every question. The ended questions and every leg of their open
    predictions are loaded for this, again on each 30-second tick, so a question that passes its
    end while the page is open joins the tab and its count. The snapshot carries
    `questions/<conditionId>.json` per question for this.
    Three cases that looked stuck and are not what they seem (investigated 2026-09-23):
    - *Polymarket's end date can be wrong.* "Another GTA VI trailer released by September 30?" was
      listed with the Aug 31 market's end date (Sep 1), and Meridian copied it as its listed end time.
      The rules go by the question, so a still-trading market whose title states a later deadline
      ("by / before / through / until <Month> <Day>") runs to 11:59 PM ET that day
      (`R.titleDeadline`; a title without a year takes the year nearest the listed end, so
      "by December 31?" listed to end Jan 1 04:59 UTC is Dec 31 of the year before); the ⓘ panel
      shows both dates. An open market's line names its date for what it is (*Polymarket end
      date* or *Deadline in the question*), not as a resolution time: Polymarket resolves once
      the outcome is known under its rules, before or after that date. A market still taking
      orders past its listed end date with no outcome priced at 95 % or more reads *still trading*,
      not *awaiting proposal* (Karen Bass: listed Jun 3, runoff Nov 3).
    - *Postponed games.* A sports market's end date is a placeholder (for CPBL and NPB, the
      scheduled start + 7 days). If a game is postponed, the rules keep the market open until the
      make-up game is played. If it is cancelled with no make-up game, the market resolves 50-50,
      which Meridian settles as a loss for the bettor. The site shows *postponed* in three cases:
      1. Polymarket's game feed marks it postponed (event `period` `POST`). Example: La Liga
         Levante–Athletic, Sep 16, moved to Oct 21. `CAN` marks a cancelled match and reads
         *cancelled*. Example: WTA Monterrey Bartunkova–Potapova on Aug 26. Polymarket resolved it
         50-50, Meridian's resolver recorded it non-decisive, and all three combos on it settled
         COUNTERPARTY_WINS, although their other two legs had won.
      2. The fixture was re-dated past both the day in the market's slug and Meridian's listed end
         time.
         Example: MLS Seattle–Real Salt Lake, *postponed from Apr 12 · now Sep 24*.
      3. Some leagues' feeds never change: NPB and CPBL stay on `NS` whatever happens, and the
         original date stays listed. For these, a sports game `R.NO_RESULT_HOURS` (12) past its start
         with no result and no proposal gets its odds checked (`R.playedCheck`: hourly prices from
         Polymarket's CLOB `prices-history`, CORS `*`).
         - A played game moves its odds: the winner reaches 99 % within hours, and a tie goes to
           50-50.
         - Median odds that stay within `R.MOVE` (10 points) of the pre-game level over the stretch
           checked (at most the first 3 days after the start; the latest price the CLOB appends
           past that window is left out) mean the game was most likely not played. Example: NPB
           Rakuten–SoftBank on Sep 21 (NPB: 中止, rained out) was 41 % before the start and a 38 %
           median over the next 2½ days, reading *Probably postponed · no sign it was played on
           Sep 21*. The Sep 20 game went from 38 % to 99.95 % in three hours.
         - Odds that moved without producing a winner read *no result · Nd* (an abandoned or
           unfinished game resolves 50-50).

      Weather markets also carry a `gameStartTime`, so this applies only to sports markets
      (`sportsMarketType`). The ⓘ panel shows the evidence, the current Polymarket odds and the
      league's official source for the make-up date. The CPBL game Rakuten–TSG on Jul 10 (typhoon,
      made up Sep 22) is still listed on Jul 10. Only Polymarket's whitelisted proposers (339
      addresses on the managed oracle) can propose, and stale listings like this one have waited
      weeks for one.
    - *Meridian's bot does not relay unlisted questions.* Meridian learns an outcome only when
      someone calls `requestResolution(conditionId)` on the Polygon reader
      `0x3E402e220fB36f4d849F8B3B3b139f68ddb69c98`, which pays a LayerZero fee of about 3 POL. That
      reader reads Polymarket's ConditionalTokens payout and sends it to the resolver
      `0xe42847ee…0475` on Robinhood Chain (4663). Meridian's bot wallet
      `0xe32b714fc552aeab6ac9144d70f2a61b26bebef2` sends these for listed questions, typically within
      minutes of Polymarket resolving. Its query (Sapience's `polymarket-keeper`) selects
      `public: true` and open interest above zero, so unlisted questions (`isPublic: false`) are
      skipped. Such questions still reach combos, and they then stay unsettled until someone sends
      the relay by hand, together with every prediction on them. As of 2026-09-23 that is 1,011
      bet-on questions and 26 blocked
      predictions ($1,587 locked): 5 predictions are owed to bettors, and 21 are losses the maker
      cannot collect. Anyone can send the relay, for example with a wallet on Polygon. Two unlisted legs
      unblocked that way on Sep 3 were claimed within hours. The snapshot now carries `pub` per
      question, so the Ended tab names this cause.
    - On Meridian a leg that resolves 50/50 does not refund: the prediction settles as
      COUNTERPARTY_WINS, so the tracker counts such a leg as lost.
  * *Settled vs claimed* – a prediction is **settled** (decided) when every leg has resolved on
    Meridian and the verdict is recorded (`pickConfig.resolved` / `result`); it is **claimed**
    (paid out) only when the winner collects, which most do late or never (roughly 1,000 of 1,300
    unclaimed predictions are settled). In the code, `n.decided` is the verdict and `n.settled` /
    `n.settledAt` the claim, as the API names them. A claim redeems the wallet's whole balance of
    a position token (one pick configuration and side, shared by every prediction on the same
    picks), but the API flags only the prediction the claim went through. So the wallet's other
    decided predictions on that token count as claimed at the same time (`P.markTokenClaims`, in
    the snapshot builder and on a live bettor page). Checked on-chain: on 2026-10-01 the bettors'
    251 such wins ($32.7K), on 2026-10-02 the makers' 726 (on 305 tokens), every token at 0. With
    them the snapshot's decided-but-unclaimed predictions fell from 1,120 to 143, and the bettors'
    unclaimed wins from 393 ($38.1K) to 142 ($5.5K). Live, the exchange's own won / lost /
    pending counts still follow the API's flag, and a bettor page's record allows for that
    (`P.bettorFigures`: `viaToken`). Results, win rates, PnL and the ex-post vig count from the
    settlement, and so does every date the site shows for a result (Big wins, slip pages and
    cards, curves, the Questions page's most recently settled predictions): claiming changes none
    of them. The tax center is the one exception: it books Predict results on the claim date by
    default (a loss at the counterparty's claim of the pool), and offers the decision on Meridian and
    the source market's resolution as the other date bases, with the period under all three side by side.
    - *Settlement time.* The API keeps none for a prediction, but each leg's condition carries
      Meridian's `settledAt`. `P.legVerdictAt` dates a win when its last leg settled and a loss
      when the first leg settled against the bettor. The snapshot builder stores that as `da` on
      every decided prediction, and the compact leg records keep the leg's time as a tenth field
      (unix seconds), which older readers ignore. Without leg times (older records) the builder's
      Polymarket resolution times for big wins, then an estimate from the listed ends, stand in,
      never after the claim. The user's example: 0x4a72… settled Sep 13 and was claimed Sep 29;
      it is dated Sep 13 everywhere. As of 2026-09-23 the API flagged 1,102 decided predictions as
    unclaimed: 389 bettor wins and 713 maker wins (most of them, it turned out, paid by a claim on
    the same token; see above). The Overview mentions the count only in its
    footnote. A bettor page shows an *Unclaimed winnings* tile (money that bettor can collect). A
    maker page doesn't (a maker's wins left to collect change none of its figures). Offline, a wallet page's
    *Cumulative PnL* chart is drawn from the verdicts too (`curveFromPredictions`). The old
    claim-based chart ended at +$508 for maker 0xdd9b…, whose PnL is +$1,500. When the file holds
    only the newest predictions (and older ones on traded positions), the chart and the *Daily
    volume* bars are the snapshot's, built from every prediction (the file's `curve` and `daily`):
    0x79cb…'s curve is negative through mid-August and ends at its all-time PnL, and its bars add
    up to its Volume tile. A file built before carried them gets no curve (it says why) and the
    bars of its newest predictions only, captioned, never a curve shifted to end at the headline.
    A combo lost on its first leg is settled while a later leg is still open. A result chip reads from the side of the page it is on (the maker's on a maker's page)
    and says *unclaimed* only where that side has something to collect: a decided loss is simply
    *lost*, whether or not the winner has claimed. Checked against the exchange: an account's
    `statsHistory` books PnL at the verdict (its cumulative PnL equals the sum of every decided
    prediction's result, claimed or not) while its won / lost counts move only at the claim, so a
    bettor page takes the PnL as the exchange reports it and adds only the decided-but-unclaimed
    predictions to the record. The page loads a wallet's newest 300 predictions (600 in a snapshot
    file); beyond that (every market maker, heavy bettors) the record, win rate, ROI, open count,
    open stake (less the open positions it sold out of, all of which the file holds) and unclaimed
    winnings come from the snapshot's aggregate for the wallet, which covers all of them; the
    status line says which predictions the tables show, and the *Open positions* header why rows
    are missing (sold on the secondary market, or older ones not loaded). Live, the exchange's
    figures count a self-match (both sides in its volume, pending until claimed) and its daily
    volume counts the wallet's secondary-market trades: the page takes both out, so the bars add
    up to the Volume tile and Open counts the loaded predictions when they are all loaded.
    *Unresolved on Meridian* is the small separate set of questions Meridian's resolver has
    not resolved although Polymarket has (unlisted questions, see above); those are listed first on the Ended tab. The tax center
    dates results by the claim by default (see *Tax center*).
  * *Predict wallets* – the Meridian app does not place predictions from the address a trader
    signs in with. That address owns the perps subaccounts. Predictions come from a ZeroDev Kernel
    v3.1 smart account it controls on Robinhood Chain: an ERC-1967 proxy to
    `0xbac849bb…4b4d`, with the ECDSA validator `0x845adb2c…ce57` holding the owner. Its address
    follows from the owner as `KernelFactory(0xaac5d424…e419).getAddress(initialize(0x01‖validator,
    no hook, owner, "", []), 0)`.
    - The ECDSA validator's `ecdsaValidatorStorage(account)` returns the owner. Each account writes
      that record itself, so an owner counts only when the account sits at that owner's own derived
      address. The public RPC allows browser calls (CORS `*`) but answers bursts with 429.
    - Verified 2026-09-25 against every wallet that ever predicted: 712 of 718 are such accounts,
      and all 712 derive exactly from their owner. The other six are the market makers and four
      wallets that bet directly.
    - Of the 27 perps owners, none had a prediction under their own address, and 17 have them under
      their Predict wallet. Example: owner `0x1111…1111` → Predict wallet `0x4824…ccac`.
    - `js/predict/wallets.js` (`P.wallets`) batches the calls, retries 429s and keeps the answers in
      localStorage. A missing owner is kept for a day only.
    - The account Overview has a one-line summary above the account card: net PnL, predictions,
      record, open and unclaimed. It shows the same figures as the Predict tab (both use
      `P.walletHeadline`) and links to that tab. Accounts without Predict activity show nothing.
    - These use it: the account page's Predict tab, the tax center's Predict section, the account
      page for an address without perps, the bettor page (a Perps link and a "Predict wallet of"
      line to the owner; an owner address moves to its Predict wallet) and the global search (a
      Predict wallet opens its owner's Predict tab).
  * *Secondary market* – a position can be sold before the verdict. Position tokens belong to a
    pick configuration and a side (every prediction on the same picks shares them, so one trade
    can move many predictions' tokens); a token pays 1 USDe if its side wins. The snapshot builder
    fetches every trade and ties it to its pick configuration and side through the predictions'
    `predictorToken` / `counterpartyToken`, with the value per token once decided, and ships each
    wallet's trades in its file. `P.ledger` then follows the tokens: per pick configuration and
    side an average cost (own predictions add the pool at their collateral, purchases what was
    paid); a sale books its price minus the cost of the tokens sold, at the sale; holding both
    sides books the matched amount (it pays for sure), at that moment; what is still held settles
    at the verdict. Only a sale lowers the share a prediction still holds (`held`): a matched set
    keeps its tokens (`hedged`), so a maker that bought back its bettor's side is not marked sold. Checked on 2026-09-22 against the exchange's own account PnL for every one of
    the 82 wallets that ever traded: 80 match to the cent, open positions included (the other two
    differ by $0.50 / $0.35 on predictions they never traded). Some wallets sell a bet's tokens
    seconds before its prediction is timestamped; such a sale is covered by the next acquisition.
    The aggregate (Overview, Bettors, Market makers) carries the adjustment; a bettor page marks
    sold predictions, shows their ledger result and a *Secondary market* card (price per token,
    outcome, the sale's result against its cost), and no longer lists a sold winner as the
    seller's unclaimed winnings; the tax center books a sale on its date and the share still held
    when its date basis books it (its redemption, by default), itemised in its secondary-market file.
  * *Market makers* – who takes the other side of the RFQ auctions: share of predictions,
    collateral committed, open collateral, PnL, win rate, average quoted vig (the Overview's
    makers table uses the same columns, `makerCols`). A counterparty counts as a market maker
    from its fifth prediction (`P.MAKER_MIN`). Anyone can take the other side once:
    0x3106…88d1 took a single $1 against $1 at 50 % on Sep 29, settled ten minutes later, which is
    a test, not a market. Such one-off counterparties are named under the table and left out of
    the lists, the counts and the chart; they still count in the tiles (collateral, PnL, win rate
    and vig). Their bettor page and share card call them that (*one-off counterparty*,
    *Counterparty PnL*), and a prediction's dialog names them *Counterparty* (`P.isMarketMaker`).
    A maker's page reads from its side: *Maker win rate* and *Maker PnL* in its category and
    singles-vs-combos tables (which add up to its headline), *Collateral committed* by category,
    and the bettors' odds labelled as such (*Avg bettor odds*, *Bettor odds*). Since Sep 30, 0xea41…5250 (a plain wallet, no contract, quoting priced odds on
    crypto, weather and sports questions) is a third market maker beside 0x79cb… and 0xdd9b….
    - The Maker PnL tile states its secondary-market part, and a note under the table works out
      how it meets the Overview's bettor net result: each prediction is zero-sum, so the two
      differ only by the secondary market (what wallets that never bet made there, and results
      booked before the verdict: sales, and both sides held).
  * *Vig & edge* – the bettor's locked odds versus the mirrored Polymarket market's price **at
    the moment of the bet**, overall, per category, per odds bucket, singles vs combos, and per
    week. The Predict API only exposes a question's source probability as it is now, so the
    snapshot builder fetches the price at bet time from Polymarket's own CLOB price history
    (`clob.polymarket.com/prices-history`, YES-token, last sample at or before the bet, else the
    first one up to 6 h after; 1-minute samples for windows up to 3 days, 5-minute up to 15) and
    caches it per prediction in `data/cache/polymarket-prices.json`, so a run only looks up new
    predictions. The CLOB refuses any window longer than 15 days (HTTP 400 "interval is too
    long"), so a question's bets are fetched in runs of at most 13 days. Until 2026-10-01 they
    went in one window per question, and 549 predictions on questions bet on over more than 15
    days stayed unpriced (the page called them "without Polymarket history", which was wrong);
    the builder retries them. Combos multiply the legs, so combos with legs on the same match or
    asset (correlated: the product understates fair for legs that go together and overstates it
    for a range) are shown separately and kept out of the headline. Polymarket files one match
    under several events: a game's More Markets, Exact Score and player-prop events are children
    of its main event (`parentEventId`), and not every child carries the game's `gameId`; an
    asset's "above ___ on <date>" and "price on <date>" events are separate events for one price
    at one time. So the builder gives each leg its match keys (the root event, the `gameId`, the
    asset and date), and two legs that share any key are on one match. Until 2026-10-02 legs were
    keyed by their own event, and 473 combos on one match counted as independent. The page's
    second half is the ex-post view, *Quote-implied vs realized*: on settled bets, the locked
    odds against the realized hit rate and bettor ROI (each bet's result ÷ stake, as if held to
    the verdict, before secondary-market trades), overall, by bet type, by odds bucket and by
    category; that needs no source price and already contains correlation and bettor skill.
    - *The 95% interval.* Bets on the same question win or lose together (41 singles rode on one
      Fed decision), so the interval is not that of independent coin flips: `P.aggregate`
      simulates 1,000 outcomes with every question resolved once for all its bets (YES with its
      Polymarket price at bet), with a fixed seed, and the ± is 1.96 standard deviations of the
      simulated hit rate. It is 1.1 to 4.4 times the independent one; a gap is coloured only
      when the implied rate falls outside it. Figures built without the simulation (a single
      wallet's) use the Wilson interval, tested against its own bounds (it is not centred on the
      raw hit rate).
    - *The generated note* ("How to read this if you bet") states only figures from the snapshot:
      the quoted vig's mean and median, the pooled realized return, the odds ranges with a clearly
      negative return (with their wins against the wins their odds implied) and each bet type's
      pooled return. It names no positive odds range, because a pooled positive return can rest
      on a single wallet.
  * *Bettor page* – PnL curve, daily volume, open positions with locked odds vs the chance now,
    full prediction history, category and combo breakdown (also the **Predict** tab on every
    perps account page). The Tax center has a Predict card for the same wallet (both roles, three
    date bases, the gross split, its own report and tax-tool files: see *Tax center*).
    - *Chance now*: the legs multiplied (as independent), a leg Meridian has settled counting as
      won or lost (its estimatedPrice freezes before the settlement), an open one at Polymarket's
      price once loaded, else Meridian's estimate from the snapshot, marked. A Meridian-settled leg
      reads *Settled on Meridian* in the Resolution column, and a position with a leg settled
      against the bettor leaves the table like one lost on Polymarket.
    - *History*: an open row has no PnL yet (—); *sold* marks a sale, *hedged* a position whose
      other side the wallet also bought (the matched amount is booked when both are held).
    - A wallet that only trades tokens shows what it *Traded* on the secondary market instead of a
      $0 Volume, and has no share card of its own (its flex card links the site).
  **How the Predict data gets there.** The Predict API refuses datacenter IPs (GitHub's
  runners get 403) and answers browsers only from an allowlist of origins (Meridian's and
  Sapience's domains, localhost), which this site is not on, so:
  `scripts/Update-PredictSnapshot.ps1` runs on a normal PC (portable Node in `../tools/node`
  or any `node` on PATH), pulls every prediction since launch paced under the API's 200
  requests/minute, and force-pushes a single parentless commit to the `snapshots` branch
  (`predict.json` + one slim file per wallet in `bettors/` and per question in `questions/`).
  `scripts/Install-SnapshotTask.ps1` schedules that every 30 minutes.
  - **Local code only:** the task runs this checkout's code as it is and never pulls. Review what
    changed on GitHub and `git pull` by hand.
    - A snapshot-format change reaches the live site with the next run, before the new page code
      is deployed.
    - So a format change only adds fields: the page code that is live must still read the new
      snapshot, and the new page code must read the old one.
  - **Checked before the force-push:** the snapshot must parse, hold at least 98% of the
    predictions the API counts, and not fall more than 5% below the published one. Otherwise it
    logs "snapshot not published". `-Force` publishes a real drop once.
  - **Safe file names:** addresses and condition ids from the API become file names only when they
    are well-formed hex.
  - **Tax center fields** (additive; page code from before them ignores them, and the page reads
    files without them):
    - in `bettors/<address>.json`, each prediction's claim transaction (`stx`, the API's
      `settleTxHash`) and each decided leg's source-market resolution (leg element 11, `vt`,
      seconds: Polymarket's `umaEndDate`, else `closedTime` once closed, looked up for every
      decided leg at most about 150 Gamma requests a run and cached as `resolved` in the price
      cache); slips and question files carry neither;
    - `rd: {"<pick configuration>|<P|C>": ms}`, when the wallet redeemed the tokens its ledger
      held at a verdict that pays (`P.redemptionTimes` over its burns: Transfer holder → 0x0).
      `scripts/burns.mjs` reads them with `eth_getLogs` on Robinhood Chain one token at a time:
      the RPC spans at most 10M blocks for one address, 100,000 for several and 30,000 without
      one (read on 2026-10-03; the earlier whole-wallet read without an address was refused every
      run). Each token is read from the block of the first placement on its pick configuration
      (else Predict's launch block, 328,896) to the head, every holder's burns at once; a refused
      range takes the width the refusal names (else half) and keeps it, and the refusal is logged
      once a run. At most 10 calls a request and 300 a run (start blocks and block times
      included), paced. Each token's progress, width and burns are cached as `burnRead` in the
      price cache, so `--cache` scratch copies work and a run reads only new blocks; a token
      whose every holder has redeemed is not read again. A wallet's `rd` is written only once
      each position it held at a paying verdict is redeemed or read to the head.
      `P.ledger(norms, trades, addr, rd)` then dates held winnings by the wallet's own burn
      (else its earliest own claim, else not redeemed), and without `rd` keeps the older rule
      (its own claim on that side, else the latest claim on the pick configuration);
    - in a truncated file, `rows` with `rowsFmt: 1`: `[t, stakeW, pnlW, code, claimable s,
      verdict s, claim s, traded]` for every prediction of the wallet, either role (`P.taxRows`);
    - trade rows carry `vt` where every leg's source time is known.
    Each new step runs in its own `try`/`catch`: a failure leaves its field out and never stops
    the snapshot.
  - **Complete history only:** an incomplete history (a time window hitting its page cap) writes
    no snapshot. The deploy workflow copies the branch into `data/` on each
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
  window and any disputer. Neg-risk (multi-outcome) markets use a different adapter
  (`0x69c47De9…`) that keys its request by Gamma's `negRiskRequestID` rather than `questionID`,
  so they are read through that id. Before the oracle has been read (or where it is never read,
  as on a slip page) a market Gamma marks *proposed* reads *Outcome proposed on UMA* with no time:
  Gamma's `updatedAt` is a batch-refresh stamp, not the proposal time.
* **Copy trading** (`#/copytrade`, leaders) – every trading wallet scored for **copyability**, the
  question a copier actually has: not "who made money" but "how much of a leader's result would
  a follower keep, entering a minute later, at taker fees, against today's order books, with a
  position the size of the leader's median one but no more than $2,000?". The snapshot build
  gives each account a copy profile (`row.copy`): closed / open positions, hold-time buckets and
  median hold, median and 90th-percentile (nearest rank) entry notional, market mix (share of
  positions, closed and open), result per position in bps (gross and net of fees),
  largest-win concentration, profitable weeks among active weeks (Monday to Sunday, UTC, as on
  Predict), tenure and cadence, plus the frictions: slippage at the account's median size
  walked through today's books (`AN.bookSlippage`), the share of its 90th-percentile size that
  the asks within 1% of the mid absorb, taker fees, and the price drift exactly one and five
  minutes after each of its most recent fills (up to 400; `AN.fillDrift`, the price at that
  moment interpolated between one-minute oracle closes as the copy simulator prices a delay,
  candles from the TradingView endpoint fetched in 3,000-bar windows and shared across
  accounts). A fill more than 5% from the oracle at the time (a dust order that swept a parked
  far quote) is left out: notional-weighted it would outweigh every other fill. The
  per-position result is the plain mean over positions (a fixed-size copier gets each position
  in equal measure); from 10 positions on, the most extreme 5% on each side (at least one
  position) is winsorized so one jackpot or blow-up cannot carry it, below 10 it is the plain
  mean (the breakdown says which, from `nTrim`), with a t-statistic saying whether it is clear
  of the noise. Funding and mPerp position fees count on both sides (a copier holding the same
  position receives or pays them too, `posFeeBps`); only the leader's trading fees (`feesBps`)
  are swapped for the copier's taker fees. "Edge left" = the share of that result that
  survives a copier's taker fees, drift and slippage (for a $2,000 position, `AN.COPY_SIZE`, or
  the leader's median entry size when smaller) in and out, divided on the unrounded means; over
  100% the page shows ">100%" with both per-position figures. The score (`AN.copyScore`, 0–100,
  computed on the site so the formula can change without a rebuild) is 35% track record, 45%
  copy friction, 20% activity, each pillar a weighted mean of its measured parts (unmeasured
  parts are left out, not zeroed), then capped with the reason shown: a per-position result
  not positive after fees and funding, or nothing of it surviving copying → 40; less than all
  of it → 30 + 0.7 × edge left; fewer than 10 / 20 closed positions → 55 / 65; from 10 closed
  positions, the result not clear of the noise (t < 2) → 60; under 50% of a 90th-percentile
  order filling within 1% of the mid → 60; no trade for 30 / 60 days → 60 / 45; a tenth of
  positions liquidated → 55; one position 60% or more of all wins → 60; drawdown of 40% or more
  → 60; not profitable → scaled down by 40% and capped at 45; fewer than 5 closed positions
  means no score. Verdicts: Copyable (70+), Copy with care (50+), Hard to copy, Losing so far.
  Every row opens a breakdown with each part's value and reason, the score before caps (`raw`)
  and the caps that applied, the per-position waterfall from the leader's result to the
  copier's, hold-time strip, sizes, markets and track record. `js/dev/sim-leaders.mjs`
  runs twenty synthetic traders of very different styles (steady swing trader, profitable
  scalper, market maker, grid bot, whale, one-hit wonder, gambler, funding harvester, …)
  through the same pipeline against today's real books and prints the ranking with the
  expected verdict for each, so the formula is judged against what a copier wants rather than
  against whoever is on the exchange this week. Nothing on the page places orders; copying is
  done by the copy agent below, a program on the user's own machine with a Meridian linked
  signer.
* **Predict ideas from winning bettors** (a card on the Copy trading page, `P.ideasCard`).
  Predict is copied by hand, one slip at a time.
  - *Winning bettor:* at least 10 decided bets (`P.IDEAS.minDecided`), in profit, and more of
    them won than their locked odds implied.
  - *The record* (`rec` on every bettor row of the snapshot). Its figures:
    - bets, wins, and expected wins (the sum of the locked chances);
    - `luck`: the exact chance of that many wins or more if every bet had exactly the chance its
      odds priced (`P.luckOf`, the Poisson-binomial upper tail). It is stored unrounded, because
      the tiers compare it with their cutoffs (0.10017 rounded to 0.1 read as a good record).
    - The calculation is exact at any size: a bin that absorbs the tail keeps the work at bets ×
      wins.
  - *Bets, not predictions:* luck needs independent trials, but predictions that share a question
    share their fate.
    - Example: the same pick placed again; 0xec7a… had 11 predictions on 3 outcomes.
    - Predictions linked through shared questions (union-find over leg ids) are one bet. The link
      runs through chains: overlapping combos over a round of fixtures can make one bet of many
      predictions over several days (0x59e7…'s largest is 70 predictions on 148 questions), and
      the card's footer, the Record title and the record tooltip say so.
    - That bet is one real event: its largest-stake prediction, at that prediction's own odds and
      with its own result.
    - Averaging a group's odds while counting it won on most of its stake mixed a chance and an
      outcome that do not belong together. One big winning single could absorb the small losing
      combos around it.
    - Every decided prediction counts, sold or not: a copier holds a pick to the verdict. Leaving
      out what was sold dropped the losers bettors dumped mid-event.
    - Only an idea needs the bettor to still hold at least half its tokens.
    - Wallet files drop settled legs' ids, so a bettor page does not compute a record
      (`P.bettorSummary`); the snapshot's is the one.
  - *Why wins, not money:* a long shot's payout is so skewed that a money-weighted z-score read
    one 49× hit among nine losses as a "5-sigma" record. Counted in wins, that bettor won 1
    where the odds implied 4.5, so it has no record at all. A long shot that hit still counts as
    one win, however much it paid, so a record of long shots can reach a tier on a few hits
    (0x7dbb…: 3 wins in 12 bets at 4.5–18%), and the page does not claim otherwise.
  - *Tiers:*
    - Strong at luck 1 in 50 or rarer and good at 1 in 10 (`P.IDEAS.strongLuck` / `goodLuck`).
    - When no winning bettor reaches good, the best record counts as good, so the list always has
      one to point at (the site owner's call, 2026-09-30).
    - Below good, the chip shows the figure ("luck 1 in 9").
    - These are plain thresholds: with some 140 bettors ranked by luck, luck alone gives about a
      tenth of them a "1 in 10" record. The card's footer says so with the snapshot's count
      (`tested` in `predict-ideas.json`): by luck alone, on average at most about tested × 0.1
      records at 1 in 10 and tested × 0.02 at 1 in 50, so a tier ranks records and does not show
      skill.
    - A stricter cut across all of them (Benjamini–Hochberg) left no one on 2026-09-30. The best
      was 17 of 24 bets won where 11.3 were implied, 1 in 105.
  - *An idea:* one of their predictions the site still offers to copy: undecided, every leg
    before the end time Meridian lists for it (a listed end, not a betting cutoff: Meridian has
    taken bets after it) and unsettled, and the bettor still holding at least half its tokens.
    The same picks placed again count once, with the count (×4). The page also leaves out a slip
    whose market has closed on Polymarket, or one on a game that has finished (Polymarket's game
    feed, `ended` on the market's event): its result is known, though Meridian may still take
    bets until the market resolves (on Oct 1 at 21:30 UTC, six of the seven slips listed were on
    Nations League games that had already finished; their listed end was 21:44).
  - *Ranking:* newest first by default, or by the bettor's record, or by the earliest listed end
    (*Ending soon*).
  - *No referral wording:* the page never mentions the referral code; every link to Meridian just
    carries it.
  - *Each idea shows:*
    - the bettor and its record;
    - the legs and the time to the earliest listed end among them;
    - the bettor's odds and stake;
    - Polymarket's chance for the whole slip now, and how far it moved since the bet. That is
      measured against Polymarket's chance at the bet, not the locked odds, which include the
      maker's margin; `≈` marks legs on one match or asset. Until Polymarket answers (or if it
      fails) the figure is Meridian's estimate from the snapshot, dimmed and marked *(snapshot)*;
    - **Copy to Meridian** (Meridian's page for the prediction with the referral code; see
      Slips) and **Slip**.
  - *Winning bettors* view: the list itself, with record, luck, PnL, ROI, wagered, open slips and
    last bet.
  - *Snapshot:* it writes `predict-ideas.json` (bettors and ideas, a few tens of KB), so the page
    does not load the Predict snapshot.
  - *Supply:* there are few ideas at any moment. Most winning bettors have not bet for weeks, so
    the card shows how many winning bettors there are when none has an open slip. A new slip
    appears with the first Predict snapshot built after it is placed (published every 30
    minutes), not within a set time.
* **Copy simulator** (`#/copytrade/sim?address=…&sub=…`, the Simulate button on every leader)
  – replays a leader's positions as a follower with a chosen size (fixed dollars per position,
  or a percentage of the leader's quantity), delay (instant … 120 s), slippage (from today's
  books at your size, or a set number of bps) and market selection, since a chosen date.
  `js/copy/sim.js`: position episodes are rebuilt from the leader's public fills by signed net
  quantity per market (ordered by time, then by UUIDv7 id for fills in one millisecond), a fill
  that crosses zero being split into the close of one episode and the open of the next (this
  matched the exchange's own position list 44/44 and 31/31 on real accounts, reversals
  included); the exchange's position records anchor the reconstruction: at every recorded close
  the net quantity is forced to zero, so a liquidation (which leaves no fill) is closed at the
  position's average exit, and when the fill history (newest 3,000 fills) starts inside an older
  position the phantom is confined to that one episode instead of shifting every later one;
  episodes the window cannot have seen whole are flagged and left out, and the page's "Data
  limits" note says how many, together with positions lacking a record (funding unknown) and
  delayed fills without a candle. Sizing: fixed $ per position sizes on the leader's whole
  opening *order* (all of its fills, since real orders fill in pieces), adds then follow in
  proportion; fixed $ per fill sizes every entry fill; or a % of the leader's quantity. In the
  two fixed modes a position may grow to at most a maximum (the "max" field, five times the
  size by default, `S.MAX_SCALE`): a leader who opens small and scales in would otherwise make
  the copier's position any multiple of the size it asked for (a $923 position opened with an
  $8 order made a $226,804 "fixed $2,000" copy before the cap), and adds beyond it are skipped
  ("capped" on the position). In every mode a reduction cuts the copier's position by the same
  share as the leader's, so a capped position is still closed when the leader closes. Each of
  the leader's fills is copied at the one-minute
  oracle price `delay` seconds later (from the fill price to its minute's close inside the fill's
  minute, from the previous close to that minute's close afterwards), moved against the copier
  by the slippage, at the market's taker fee; funding and position fees are the leader's scaled
  by the copier's share of the leader's position size × time (they accrue with size held over
  time, so a leader who opens tiny and scales in does not inflate the copier's share), an open
  position's charged-but-unapplied funding (`fundingUsd`, `positionFeeUsd`) included; each
  episode takes the exchange's position record nearest its first fill (within 5 s, nearest
  pairs first, each record used once, so a fast flipper's episodes a second apart each get
  their own); open positions are marked at the current oracle price. The page shows copier vs
  leader net, the share kept (the copier's net against the leader's result scaled to the
  copier's size position by position, `T.leaderScaled`; the leader's curve is drawn the same
  way, while the Leader net tile stays in the leader's own dollars), per-position bps, costs
  split into fees / drift / slippage (drift signed as a cost everywhere: + = a worse price),
  funding, the copier's max drawdown, the cumulative curves of both, a latency-sensitivity
  table (the same copy at every delay, each delay counting its own fills without a candle)
  and every position with both sides' results, newest opened first. The start date is a UTC
  day. `sim-leaders.mjs --replay
  <style>` runs the engine on a synthetic leader and checks the arithmetic against the style's
  known parameters (the leader's cash flows are conserved exactly).
* **Paper copy** (the card under the simulator) – the same copier, live: a virtual account in
  the browser's localStorage (`js/copy/paper.js`, `md.paper.<sid>`, version 3).
  - **Source of truth:** the exchange's fill history (`/v1/order/fill`). An `OrderFill` stream
    message only schedules a sync `delay` seconds after the fill. Each fill is applied once,
    under its own id, with the leader's real quantity.
  - **Pricing:** a fill applied on time is priced at the live mark of that moment (`Ticker`
    stream, or the market price when the stream is quiet), so the delay cost is measured on the
    real tape. Fills found later (the tab was closed, the stream dropped; a 2-minute poll looks
    too) are priced at candle closes and marked "caught up". Catch-up resumes from the newest
    fill applied, not from the last visit.
  - **Sizing:** a fixed-size copy is sized on the leader's whole order (looked up by order id):
    what filled once the order is done, else what was asked. It is not sized on the first piece,
    and a reversal's new side is sized on the part of the order that opened it. It is capped per
    position like the simulator's. Fees and slippage are as set; funding accrues each minute at
    each market's latest hourly rate (the products re-read, cached 5 minutes) while a tab
    follows, counted once however many tabs are open.
  - **Settings:** exactly what the form shows when following starts, Run pressed or not: size,
    maximum, ratio, delay, slippage and the Markets filter. A fill in a market left out is
    marked seen and the leader's position there is kept as not the copy's (`pre`).
  - **Timing:** times are the exchange's clock (`/v1/time`), not the browser's. The history is
    read oldest first, so a page cap never drops the fills a later sync would need.
  - **Positions held before following:** following starts from the leader's open positions at
    that moment (`pre`). The copy does not hold them, so the leader cutting or closing one later
    is not a new position. A fill cuts the copy by the same share as the leader's whole position
    (the copied part plus `pre`), and only what goes past zero opens the other side.
    - The bug this fixed (reported 2026-09-25): following 0x7c75… while its ETH long was open,
      its closing sells became a $2,000 short that was later closed "at mark" for −$13.
  - **Reconciling:** after each sync the copy is lined up with the leader's actual open
    positions (`P.reconcile`), but not in a market with fills still to come or a leader fill in
    the last minute.
    - Leader flat, or on the other side: the copy is closed "at mark".
    - Leader smaller than its fills say: the copy is cut by the same share.
    - Leader larger: the extra is counted as the leader's own.
  - **Two tabs:** the newer copy of the account wins (a write counter plus the `storage` event).
  - **Rebuild:** recomputes the account from the fills since it started, at candle prices, from
    the leader's positions at that moment (rebuilt from its position records and fills).
    Accounts kept by an earlier version get a note offering it.
  - **The card:** realized (closed positions plus what the open ones already booked: partial
    closes, fees and funding), unrealized at the live mark against the cost of what is still
    held (`basis`, the exchange's average-cost convention: a reduction scales it down in
    proportion, so Avg entry stays the entry price), delay cost (+ = a cost; measured /
    modelled), fees and slippage, funding, open virtual positions and the mirrored-fill log
    (a reconcile cut that leaves the position open reads "cut at mark"). A position kept before
    the basis existed shows its result so far (partial closes, fees and funding included) under
    "Result so far" until Rebuild. Stop & discard removes the account.
* **Leader alerts** (the bell on any leader row, breakdown or simulator; the card on the Copy
  trading page) – follow up to 15 subaccounts and be told when one opens, adds to, reduces,
  closes or reverses a position, or is liquidated. `js/copy/alerts.js` subscribes to each
  followed account's `OrderFill` and `SubaccountLiquidation` streams (seeded from its open
  positions, resynced every ten minutes), groups the fills of one order for 2.5 s and classifies
  the order against the running position; a fill dated at or before the `updatedAt` of the
  position record last read is already inside that size and is not added again, so a resync
  landing mid-order cannot turn a close into a "reversed" alert. A liquidation's size is the
  position's (`sz` is signed, negative for a short: its sign gives the side, and the notional
  is never negative, so a minimum size does not drop a short's liquidation), dated at the
  event's time. Events and a minimum notional are configurable.
  Delivery: a toast on the site, a browser notification (permission asked on the page), and
  optionally an ntfy push to a phone (topic and server on the page, "Send a test"; the tab
  POSTs to the topic, which is the only secret: *Generate* fills in a random one, a guessable
  name is pointed out, and the server must be https, with plain http only on localhost). Alerts flow while a tab of the site is open in
  that browser; one tab is elected listener through a localStorage heartbeat so several tabs
  never double-send, the others mirror the log. History (last 200) is kept in localStorage.
* **Copy agent** (`#/copytrade/agent`, `agent/copy-agent.mjs`) – the copying itself, as a program
  the user runs on their own machine (Node 22+, one dependency: ethers). Non-custodial by
  construction: `keygen` makes a fresh key on that machine; `link` has it sign a Meridian
  `LinkSigner` message and prints the request; on the site the owner's wallet co-signs the same
  EIP-712 message (`eth_signTypedData_v4`) and the page POSTs both signatures to
  `/v1/linked-signer/link` (the API's CORS allows it). The exchange then treats the key as an
  API signer of that subaccount: submit and cancel orders only, never withdrawals, revocable
  from the same page. The site never sees a key. `run` follows the leaders in `config.json`
  over the exchange WebSocket (fills grouped per order, sized on the whole opening order), keeps
  a book per leader and market, and mirrors: open → sized order (fixed $ per position, counted
  on the quantity the leader ordered, so an order cancelled after a partial fill gives a
  proportionally smaller copy where the simulator counts only what filled; fixed $ per leader
  order, per batch of its fills arriving within 1.2 s of each other, where the simulator's
  "$ per fill" sizes every entry fill; or a % of the leader's quantity, as in the simulator),
  add → in proportion, reduce → the same share of its own position (reduce-only), close → a
  close order (quantity 0, reduce-only), reverse → close then open, the new side sized on the
  rest of the leader's order (the part that closed the old position, added up over all of the
  order's groups of fills, is taken out, as paper copy does). A leader found flat on a re-read
  → close (or hold, by config); when the leader's last position record in that market is a
  liquidation (or a liquidation event prompted the re-read), the liquidation option applies
  instead, on every re-read, and a position held after a liquidation is no longer followed
  (an orphan). Openings, adds and reductions are limit IOC at the mark ± a slippage cap (or
  market orders, by config); closes always go out as market orders. Every order is
  EIP-712-signed with the domain and type strings from `/v1/rpc/config`, exactly as the
  official SDK does; the unfilled part of an opening or add is logged, never chased, and that
  of a reduction is carried to the next reduction of the market. Risk limits, checked before every new
  or larger position: max notional per market, max open positions, max leverage on equity,
  daily loss stop and drawdown stop (a trip makes the agent reduce-only, or close everything,
  until resumed), minimum order size, denied markets; one leader per market. The three size
  limits cut an order to what they allow rather than dropping it, so a leader scaling in is
  followed up to the cap; in the fixed modes a per-market cap of 0 is replaced by five times
  the size (logged at start), because proportional adds would otherwise make a position any
  multiple of the size. A local status
  port (127.0.0.1 only, origin-checked, token-guarded for pause / resume / close all) feeds
  the page's dashboard: equity, day and peak change, leverage, own positions against the
  leaders', the latest 30 orders with their status and fill (the daily log files in `logs/`
  keep every one), the event log. `run --dry` sends every order
  to the exchange's dry-run endpoint instead (margin check, nothing placed) and keeps a virtual
  book, so the whole loop can be watched before any money moves; `/simulate` on the status
  port feeds it a pretend leader fill. Logs in `agent/logs/`; ntfy push on rejected orders,
  risk stops and leader liquidations. The page builds `config.json` from the followed leaders
  and the limits, lists and revokes signers, and shows the dashboard. The deploy publishes only
  `copy-agent.mjs`, `package.json`, `package-lock.json` and `config.example.json`. Keys, configs,
  link requests, state and logs are gitignored: everything in `agent/` except those four files.
  Hardening of the key-holding process:
  - **Pinned dependency.** ethers is pinned to 6.17.0 with its lockfile; install with
    `npm ci --ignore-scripts`.
  - **Key permissions.** `keygen` restricts `signer.key` to the current user (icacls on Windows,
    0600 elsewhere), and `run` warns if a key is still readable by others.
  - **Status port.** It needs its token on every request, `/status` included. The token comes from
    the page (random) or is generated into `control.token`; one shorter than 16 characters stops
    the agent. The port also checks the Host header (against DNS rebinding) and exact origins.
  - **Hard ceilings in every sizing mode.** Defaults are `maxOrderUsd` 1000 and `maxPositionUsd`
    5000; the start log warns when `sizing.size` is above the per-order ceiling. Sizes and limits
    are counted at the exchange's mark. A leader fill more than `maxPriceDeviationPct` (3%) off
    the mark, or older than `maxFillAgeMs` (15 s), opens nothing. Closes and reductions still
    follow.
  - **Strict arguments.** A typo that reaches the agent exits. `--dry`, `--dry-run`,
    `COPY_AGENT_DRY=1` or `npm run dry` / `npm start -- --dry` select the dry run, and the mode
    is printed unmistakably. A misspelt flag typed before npm's `--` (`npm start --dyr`) stays
    with npm and the agent starts live, so `npm run dry` is the safest way to a dry run.
  - **Fails closed.** A damaged `state.json` stops the agent rather than clearing a tripped risk
    stop.
  - **Clock.** The clock offset is measured again periodically and after a time rejection.
  - **ntfy.** A plain-http ntfy server other than localhost is refused.
  - **Linking.** The page's link step shows the signer it is about to authorise, and warns when it
    differs from the running agent's.
  Facts the agent relies on, each checked against the exchange rather than assumed: a position's
  `size` is signed (long > 0) and its `fundingAccruedUsd` is positive when *paid* (the SDK's
  docstring says the opposite; the archive ledger, which reconciles to the cent, settles it:
  Σ positions = −Σ ledger on a closed account); the order submission response's `filled` is
  deprecated and always 0, so fills are read back from `GET /v1/order/{id}` until the status is
  final and the position is re-read until it reflects the order (status filled / partial /
  unfilled / rejected, with the exchange's `rejectedReason`); a close is quantity "0" +
  reduceOnly + close, and a reduce-only IOC on an existing position, both accepted by the
  dry-run endpoint; `signedAt` must sit inside the exchange's clock tolerance, so the offset to
  `/v1/time` is measured and applied (this PC was 3 s off); a signer's `expiresAt` is in
  milliseconds and a revoked signer fails every order with `SignerRevoked`, on which the agent
  pauses. The agent cannot extend its signer (the exchange currently sets 90 days from
  linking): before then a new key is made (`keygen --force`), linked on the page and the agent
  restarted. Safety rules: one serial queue for every decision and order (two leader orders arriving
  together cannot both size against the same stale position); adds scale to what is actually
  held after partial fills; state (`state.json`: what is followed from whom, stops, the order
  log) survives restarts, and on start open positions that a followed leader also holds are
  adopted while the rest are flagged as orphans (left alone, or closed with `onOrphan`); the
  leaders are re-read on every `PositionUpdate` hint (debounced per leader, so one leader's
  hint never cancels another's re-read) and liquidation hint, on reconnect and every five
  minutes, and a close, a reduction or a side change missed over a disconnect is mirrored (an
  opening is not chased); a re-read and the socket never count a fill twice: a position
  record's `updatedAt` is the time of its last fill, so a grouped fill dated at or before the
  record last read is already inside that size and only classifies the order, and a re-read
  leaves markets alone whose fills are still being grouped (a resync landing mid-order used to
  be able to take a close for a reversal and open the other side); a reduction the exchange
  will not take yet (below the market's minimum quantity, or the remainder an IOC left, or a
  rejection) is carried and folded into the next reduction of that market, with adds sized on
  what should be held, so the copy does not stay bigger than the leader's share ("owed" on the
  dashboard's positions; a close clears it); no opening, add or reduction without a mark
  (closes are market orders), no opening or add while the own-account read is more
  than two minutes stale or a leader's positions could not be read; the daily-loss and drawdown
  stops take deposits and withdrawals out (`/v1/token/transfer`, every page), counted from the
  day's first reading and from the time the drawdown peak was set, both kept in `state.json`
  across restarts (a state file from an older agent starts both afresh), so a transfer can
  neither trip nor mask them; while the transfers cannot be read the stops are not checked and
  the dashboard says so; quantities are capped at the market's `maxQuantity` and rounded to its lot.
* **Copy history** (the last card of the Copy agent page) – attribution of what the agent did.
  Every mirrored order carries the leader's own fill price and time; the exchange's fills for
  the agent's orders attach to their order (from the `OrderFill` stream, backfilled from
  `/v1/order/fill` on start), and the page rebuilds the copy account's positions from those
  fills with the simulator's episode engine, each position attributed to the leader whose
  order opened it. Only what the agent opened counts (`CS.agentFills`): a reduction or close
  counts up to what the agent's own openings hold in that market, so closing a position it
  adopted at start, one traded by hand (Close all) or one whose opening order has left the
  1,000-order log adds no position. Per leader: closed and open positions, share profitable,
  net (the result less trading fees and mPerps position fees plus funding received: realized
  for closed positions, at the live mark for open ones; funding, position fees and liquidations
  from the exchange's position records), slippage of your fills against the leader's weighted
  by each fill's notional (positive = you paid more), average delay from the leader's fill to
  yours; a cumulative realized chart per leader; every position with its slippage and delay
  (the newest 40 listed). A close made after a resync has no leader price and is marked "at
  mark". Positions traded by hand on the same subaccount are not attributed.

The sidebar opens with labels on desktop and collapses to icons with the button at its bottom
(remembered per browser). Press `/` anywhere to jump to the search box. A thin progress line
under the top bar shows every page load; "How are these calculated?" (leaderboard, copy trading,
performance tab, tax center) opens the metric definitions below in a panel. Published snapshots
that are more than two hours old are flagged as stale wherever they are shown. Subaccounts that
never traded (the exchange's fee-collector account "earns" PnL from fees received) are tagged
*no trades* on the leaderboard, and the exchange's own subaccount 0x1598… (it took over a
liquidated trader's position and is credited the mPerps position fees) is tagged *exchange
account*; both are left out of the home ticker and the copy-trading leaders. The latter's row in
the snapshot carries `exchange: true` for the share cards, which call it an exchange account
rather than a trader of its style.

## Metric definitions

* **PnL** (interval) = realized PnL − trading fees − mPerp position fees + funding over the
  interval, plus the change in unrealized PnL from the start of the interval to now. Funding counts
  when the exchange charges it each hour, including funding charged to open positions and not yet
  settled into the balance; unrealized PnL is net of that unsettled funding at both ends (and of
  unsettled position fees at the end): the archive's unrealized PnL is price-only, so each bucket
  is put on that basis from the archive's hourly funding history (`AN.netOfUnsettled`). Position
  fees are not in the exchange's daily ledger: they are the balance change it records no deposit,
  withdrawal, conversion, trade, fee or funding entry for (`posFee` in `AN.buildSeries`; the tax
  center books the same residual, from the mPerp pools only, in `js/tax/ledger.js`). An interval starts at the first
  archive bucket boundary at or after its nominal start (within 1 hour for 24h, 2 hours for 7d,
  8 hours for 30d); all-time starts at the subaccount's creation.
* **Equity** = Σ margin balances (all pools are USD-equivalent tokens) + net unrealized PnL
  (unrealized − unsettled funding − unsettled position fees).
* **ROI** = PnL ÷ (equity at the start of the interval + deposits during it).
* **Max drawdown** = largest peak-to-trough decline in the interval, as a percentage of a time-weighted
  return index (each bucket's gain on the capital it started with, plus that bucket's deposits, compounded), so
  deposits and withdrawals change nothing: losing $30 of $184 and then withdrawing the rest is a 16.6 % drawdown,
  not 100 %. Buckets are 1 hour for 24h, 2 hours for 7d, 8 hours for 30d and 1 day for all-time, on the
  leaderboard, the account page and the cards alike (`AN.resFor`); finer buckets catch swings inside a day, so a
  shorter interval can show a deeper drawdown than a longer one. The dollar figure (account page) is the loss
  since the high-water mark of the flow-adjusted PnL curve.
* **Sharpe** = mean ÷ stdev of per-bucket PnL returns on prior equity, annualized, with the same
  buckets as the drawdown; shown only with at least 10 returns, at least 3 of them non-zero (an
  account's first bucket has no prior equity, so its all-time Sharpe appears from its 11th day at
  the earliest).
* **Win rate** = closed positions with positive net result (realized − trading fees − position
  fees + funding received − funding paid) ÷ closed positions. **Trading style** is the average
  holding time of closed positions: Scalper < 1h, Intraday < 1d, Swing < 7d, otherwise Long-term.
* **Liquidation price** is an estimate from the app's pool maths: maintenance margin =
  notional × (1 / (2 × maxLeverage) + takerFee), solved per position with the equity left after
  the other positions' maintenance margin, the other positions held at their marks. "none" when
  even a fall to zero would not liquidate a long; a liquidation more than 500% from the mark is
  tagged ">500%".

## Notes / limits

* Funding sign: the position endpoints (`fundingUsd`, `fundingAccruedUsd`) and the archive's
  funding history (`fundingCharge`) report funding as positive when *paid*, the archive's
  `realizedFunding` as positive when *received*; the UI shows positive = received (green)
  everywhere.
* The leaderboard analyses the most recent 600 positions per account and the Archive API's
  1-hour, 2-hour, 8-hour and daily buckets for 24h / 7d / 30d / all-time, plus its hourly funding
  history (3-day windows) so funding counts when charged. With many hundreds of accounts a build
  takes a few minutes; the public rate limit is generous (20 000 points per window).
* Meridian's history API clamps ranges (e.g. 3 days at 1-hour resolution, 120 days at daily);
  the client chunks requests automatically.
* Nothing is written anywhere except `localStorage` (favorites, leaderboard snapshot, chart
  preference, the Tax center's report currency and the USDe opening lots entered there) and
  `sessionStorage` (the Tax center's frankfurter.dev and DefiLlama answers).

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
js/pages/*.js           home, account, favorites, leaderboard, dashboard, tax, copytrade, copysim, copyagent, predict, status
js/tax/*.js             tax center modules (MD.tax): core (presets, currencies, CSV, the disclaimer), tz (local time),
                        periods, fx (exchange rates: sources, conventions, fallbacks, money formatting), ledger (the
                        archive cut at local boundaries), load (archive and per-fill reads, cached for the tab), fills
                        (fills to positions, the replay at average entry, disposals, day checks), funding (funding
                        settlements per position, mPerp position fees per fill), predict (a wallet's Predict record:
                        both roles, three date bases, the gross split, the decided-not-claimed tail, its USDe flows, the
                        Predict files), lots (the USDe lots: events, scopes, deposit readings, FIFO / LIFO / average /
                        UK pooling, the lots files), holdings (values at the period's start and end: perps per pool,
                        Predict at cost, the lots), summary (results by type, gains and losses by class, the summary
                        file), methodology (the report's record, import notes, methodology.txt / .json), zip (the ZIP
                        writer), exports (the registry of export files, the tax-tool rows, Form 8949), ui (downloads,
                        progress), view-perps (the perps cards), view-predict (the Predict card), view-lots (the USDe
                        lots card), view-holdings (the Holdings card); pure except load, fx.load, fx.usde, ui and view-*
scripts/build-fx.mjs    deploy-time official exchange rates for the tax center (data/fx/: ECB, NBP, Bank of Canada) and
                        DefiLlama's USDe/USD price (the USDe lots' market valuation)
js/copy/sim.js          copy simulator engine: fills → position episodes → a copier's replay
js/copy/paper.js        paper copy: a virtual account mirroring a leader live, kept in localStorage
js/copy/alerts.js       leader alerts: followed accounts, WebSocket classification, toast / notification / ntfy
agent/copy-agent.mjs    the copy agent (runs on the user's machine): keygen, link, run [--dry], status
agent/package.json      its one dependency (ethers 6.17.0, pinned with package-lock.json); config.example.json documents every setting
js/dev/*                development only, not loaded by the site: sim-tax.js (a fake busy account for the tax center),
                        sim-leaders.mjs (twenty synthetic traders through the copyability score and the simulator)
js/predict/api.js       Predict (Sapience) GraphQL client
js/predict/analytics.js Predict normalisation, aggregation, per-wallet slim records
js/predict/resolution.js Polymarket Gamma + UMA oracle resolution tracker
js/app.js               bootstrap, sidebar, global search
vendor/chart.umd.js     Chart.js 4 (MIT)
assets/                 Meridian logo (media kit) + favicon
Start-MeridianData.*    local static server
```
