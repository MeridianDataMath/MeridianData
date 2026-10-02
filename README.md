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
assembles `dist/` and deploys it:

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
- `connect-src` lists the APIs the site calls, plus `https:` for a self-hosted ntfy server.
- The share pages under `/a/` and `/p/` redirect through `js/share.js`. They avoid a meta refresh,
  because Facebook's crawler would follow it to the home page's card.
- User-supplied links (`href`/`src`) must be relative or http(s). `U.h` never writes raw HTML, and
  it turns objects in a text position into plain text.

**Tests.** `node --test "tests/*.test.mjs"` (Node 22+, no dependencies, no network, well under a
second) runs before anything else in the workflow; a failure stops the job, so nothing is
deployed. They load the site's own scripts the way the snapshot builder does and cover the money
math: the Predict secondary-market ledger with the cases checked against the exchange
(`predict-ledger`), prediction semantics, result chips and a bettor page's headline figures
(`predict-analytics`), the copy simulator's and paper copy's sizing, cap, reductions, funding
share, position records and cost basis (`copy-engines`), the copy agent's decisions (`agent`:
the lines between `@pure-begin` and `@pure-end` in `agent/copy-agent.mjs`, loaded on their own
since the agent needs ethers and a key), account analytics, the copy profile and the
copyability caps (`analytics`), formatting and routing (`util`), the bar chart's value-axis
formatter (`charts`).

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
* **Tax center** – a full tax report per subaccount: fiscal-year presets (calendar, UK, Australia,
  New Zealand, India, South Africa, Pakistan) or a custom UTC range; a reporting currency
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
  the ledger cannot explain; the transaction ledger's cash-effect column does not add up to the
  balance change (it has no row for PnL booked on partial closes of positions still open, carries
  each closed position's whole result and position fee at its close, and lists only order fills,
  not liquidation fills), so the reconciliation is the check; the realized PnL that the closed
  positions do not explain (booked on positions open at the period end, less what the closed ones
  booked before the period) is its own line; funding received / paid is split by the sign of each
  UTC day's net, not per hourly payment; the unrealized PnL of open positions is net of unsettled
  funding and position fees, as on the account page, and is in no total; printing lists every row
  of the closed-positions and transaction tables. `js/dev/sim-tax.js` (not loaded by the site) fakes a busy two-year account with a
  ledger built from the same events, for stress-testing the report against a realistic
  return: `MDSim.install()` in the console, then open `#/tax?address=<its address>`.
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
    of them. The tax center is the one exception: it books Predict results on the claim date, when the
    cash arrives.
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
    stays on a cash basis (claimed).
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
    seller's unclaimed winnings; the tax center books a sale as a disposal on its date and the
    held share on its claim, with a trades CSV.
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
    perps account page). The Tax center gains a Predict block with realized PnL, monthly table
    and two CSV exports.
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
  center keeps its own position-fee line and does not read it). An interval starts at the first
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
js/pages/*.js           home, account, favorites, leaderboard, dashboard, tax, copytrade, copysim, copyagent, predict, status
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
