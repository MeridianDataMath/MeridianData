/* MeridianDataHub — development only: a synthetic, realistic trading history for stress-testing the Tax center.
   Not loaded by index.html. Inject it in a browser console (or a test script) and call MDSim.install():
   it patches MD.api / MD.predict so the Tax center sees a busy account (hundreds of positions over two years,
   deposits, withdrawals, conversions, liquidations, long-term holds, thousands of fills, Predict activity)
   whose daily ledger is built from the same events, so the report must reconcile to the cent. */
(function () {
  const MD = window.MD; const A = MD.api; const U = MD.util; const P = MD.predict;
  const DAY = 86400000;
  const rng = (seed) => { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; };
  const ADDR = '0x51de0a7f1b2c3d4e5f60718293a4b5c6d7e8f901'; const SID = '0195a7c4-0000-7000-8000-000000000001';
  const TOKENS = { USD: '01a047c4-2274-7606-bdf5-e6eb835dc30b', XAUUSD: '01a047c4-2752-7941-ab21-8459dd62265e', SPYUSD: '01a047c4-29b8-7386-8ffe-23ee2116972c', XAGUSD: '01a047c4-2885-790e-9bc6-812e3a88fe60', QQQUSD: '01a047c4-2aeb-7657-b76d-b0ac0265c92e' };
  const TOKEN_ADDR = { USD: '0xad221259d4a1f2d7376dc1012c561bc86640f009', XAUUSD: '0x5841555553440000000000000000000000000000', SPYUSD: '0x5350595553440000000000000000000000000000', XAGUSD: '0x5841475553440000000000000000000000000000', QQQUSD: '0x5151515553440000000000000000000000000000' };
  const dayKey = (t) => Math.floor(t / DAY) * DAY;

  window.MDSim = {
    async install(opts = {}) {
      const seed = opts.seed || 7; const r = rng(seed);
      const ref = await A.ref();
      const created = opts.created || Date.UTC(2024, 5, 1);
      const now = Date.now();
      const products = ref.active.slice();
      const quoteOf = (p) => Object.keys(TOKEN_ADDR).find((k) => TOKEN_ADDR[k] === String(p.quoteTokenAddress).toLowerCase()) || 'USD';
      const mark = (p) => ({ 'BTC-USD': 80000, 'ETH-USD': 2600, 'SOL-USD': 110, 'HYPE-USD': 90, 'XAU-USD': 4300, 'XAG-USD': 66, 'SPY-USD': 760, 'QQQ-USD': 716 }[p.displayTicker] || 100);

      // ---- events: every balance change is an event; the ledger is rebuilt from them, so it reconciles by construction
      const events = [];   // {t, token, kind, amount, fee}
      const transfers = [];
      let tx = 0; const hash = () => '0x' + (++tx).toString(16).padStart(64, '0');
      const deposit = (t, amt) => { events.push({ t, token: 'USD', kind: 'deposit', amount: amt }); transfers.push({ id: 'tr-' + transfers.length, createdAt: t, type: 'DEPOSIT', tokenName: 'USD', amount: String(amt), fee: '0', status: 'COMPLETED', finalizedTransactionHash: hash() }); };
      const withdraw = (t, amt) => { events.push({ t, token: 'USD', kind: 'withdrawal', amount: -amt, fee: -1 }); transfers.push({ id: 'tr-' + transfers.length, createdAt: t, type: 'WITHDRAW', tokenName: 'USD', amount: String(amt), fee: '1', status: 'COMPLETED', finalizedTransactionHash: hash() }); };
      const convert = (t, to, amt) => { events.push({ t, token: 'USD', kind: 'convOut', amount: -amt }); events.push({ t, token: to, kind: 'convIn', amount: amt }); transfers.push({ id: 'tr-' + transfers.length, createdAt: t, type: 'CONVERT', tokenName: 'USD', toTokenName: to, amount: String(amt), fee: '0', status: 'COMPLETED', finalizedTransactionHash: hash() }); };
      deposit(created + 3600000, 120000);
      for (const tok of ['XAUUSD', 'SPYUSD', 'XAGUSD', 'QQQUSD']) convert(created + 2 * 3600000, tok, 20000);
      // deposits / withdrawals through the years
      for (let t = created + 30 * DAY; t < now; t += (20 + r() * 40) * DAY) { if (r() < 0.55) deposit(t, Math.round(2000 + r() * 30000)); else withdraw(t, Math.round(500 + r() * 15000)); }

      // ---- positions
      const positions = []; const fills = [];
      const nPos = opts.positions || 640;
      for (let i = 0; i < nPos; i++) {
        const p = products[Math.floor(r() * products.length)]; const quote = quoteOf(p);
        const open = created + r() * (now - created - DAY);
        // holds: mostly hours to days, some weeks, a few over a year
        const holdMs = r() < 0.03 ? (370 + r() * 200) * DAY : r() < 0.15 ? (7 + r() * 60) * DAY : r() < 0.6 ? (1 + r() * 48) * 3600000 : (2 + r() * 6) * DAY;
        const close = open + holdMs;
        const isOpen = close > now;
        const px = mark(p); const size = +(r() * (px > 1000 ? 2 : px > 100 ? 40 : 400) + (px > 1000 ? 0.05 : 1)).toFixed(4);
        const long = r() < 0.55; const entry = px * (0.85 + r() * 0.3);
        const move = (r() - 0.47) * 0.12 * (holdMs > 30 * DAY ? 3 : 1);   // slight bettor edge, bigger moves on long holds
        const liq = !isOpen && r() < 0.04; const adl = !isOpen && !liq && r() < 0.01;
        const exit = liq ? entry * (long ? 0.9 : 1.1) : entry * (1 + move);
        const cost = size * entry, proceeds = size * exit;
        const gross = isOpen ? 0 : +((long ? proceeds - cost : cost - proceeds)).toFixed(6);
        const takerFee = U.num(p.takerFee) || 0.0003;
        // position fees: the real exchange charges them on some mPerp positions at some moment while they are open (not at open, not at close)
        const pfees = quote === 'USD' || r() > 0.3 ? 0 : +((cost + (isOpen ? 0 : proceeds)) * 0.00017).toFixed(6);
        const fundingPaid = +(((isOpen ? now : close) - open) / 3600000 * cost * 0.00001 * (r() - 0.45)).toFixed(6);   // signed: + = paid
        const upnl = isOpen ? +(cost * (r() - 0.5) * 0.08).toFixed(4) : 0;
        const pos = { id: 'pos-' + i, productId: p.id, side: long ? '0' : '1', size: isOpen ? String(size) : '0', totalIncreaseQuantity: String(size), totalDecreaseQuantity: isOpen ? '0' : String(size), totalIncreaseNotional: String(cost), totalDecreaseNotional: isOpen ? '0' : String(proceeds), feesAccruedUsd: '0', positionFeeAccruedUsd: String(pfees), fundingAccruedUsd: String(fundingPaid), realizedPnl: String(gross), unrealizedPnl: String(upnl), cost: String(cost), createdAt: Math.round(open), updatedAt: Math.round(isOpen ? open + r() * (now - open) : close), isLiquidated: liq, wasDeleveraged: adl }; positions.push(pos);
        // fills: opening fills (1-3) and closing fills (1-3); every fill charges its fee at fill time (maker half price), the position's fee total is their sum
        let fees = 0; const fill = (q, price, t, makerP, reduce, type) => { const maker = r() < makerP; const fee = +(q * price * takerFee * (maker ? 0.5 : 1)).toFixed(6); fees += fee; events.push({ t, token: quote, kind: 'fee', amount: -fee }); fills.push({ id: 'fill-' + fills.length, orderId: 'ord-' + i + '-' + fills.length, createdAt: Math.round(t), productId: p.id, side: reduce ? (long ? 1 : 0) : (long ? 0 : 1), type, filled: String(q), price: String(price), feeUsd: String(fee), isMaker: maker, reduceOnly: reduce }); };
        const nOpen = 1 + Math.floor(r() * 3); let left = size;
        for (let k = 0; k < nOpen; k++) { const q = k === nOpen - 1 ? left : +(left * (0.3 + r() * 0.4)).toFixed(4); left = +(left - q).toFixed(4); fill(q, entry, open + k * 60000, 0.4, false, r() < 0.5 ? 'LIMIT' : 'MARKET'); }
        if (!isOpen) { const nClose = 1 + Math.floor(r() * 3); left = size; for (let k = 0; k < nClose; k++) { const q = k === nClose - 1 ? left : +(left * (0.3 + r() * 0.4)).toFixed(4); left = +(left - q).toFixed(4); fill(q, exit, close - (nClose - 1 - k) * 60000, liq ? 0 : 0.3, true, liq ? 'MARKET' : 'LIMIT'); } }
        pos.feesAccruedUsd = String(+fees.toFixed(6));
        // ledger events: realized at close, funding spread daily while open
        const endT = isOpen ? now : close; const nDays = Math.max(1, Math.round((endT - open) / DAY));
        if (pfees) events.push({ t: open + r() * (endT - open), token: quote, kind: 'pfee', amount: -pfees });
        for (let d = 0; d < nDays; d++) events.push({ t: open + d * DAY + 3600000, token: quote, kind: 'funding', amount: -fundingPaid / nDays });
        if (!isOpen) events.push({ t: close, token: quote, kind: 'pnl', amount: gross });
      }
      positions.sort((a, b) => b.updatedAt - a.updatedAt); fills.sort((a, b) => b.createdAt - a.createdAt); transfers.sort((a, b) => b.createdAt - a.createdAt);
      // one unexplained credit, like the real exchange produced once, so the per-pool detail is exercised
      if (opts.glitch !== false) events.push({ t: Date.UTC(2026, 2, 3, 12), token: 'XAGUSD', kind: 'glitch', amount: 0.1 });

      // ---- daily ledger per token: cumulative fields like the archive; balance carries every event incl. position fees
      const tokList = Object.keys(TOKENS);
      const cum = {}; for (const tok of tokList) cum[tok] = { deposit: 0, withdrawal: 0, withdrawalFee: 0, depositFee: 0, conversionIn: 0, conversionOut: 0, realizedPnl: 0, tradingFee: 0, realizedFunding: 0, balance: 0 };
      events.sort((a, b) => a.t - b.t);
      const firstDay = dayKey(created), lastDay = dayKey(now);
      const rows = { balance: [], volume: [] };
      let ei = 0;
      for (let d = firstDay; d <= lastDay; d += DAY) {
        while (ei < events.length && events[ei].t < d + DAY) {
          const e = events[ei++]; const c = cum[e.token];
          if (e.kind === 'deposit') c.deposit += e.amount; else if (e.kind === 'withdrawal') { c.withdrawal += e.amount; c.withdrawalFee += e.fee; } else if (e.kind === 'convIn') c.conversionIn += e.amount; else if (e.kind === 'convOut') c.conversionOut += e.amount; else if (e.kind === 'pnl') c.realizedPnl += e.amount; else if (e.kind === 'fee') c.tradingFee += e.amount; else if (e.kind === 'funding') c.realizedFunding += e.amount;
          c.balance += e.amount + (e.kind === 'withdrawal' ? e.fee : 0);   // pfee and glitch move the balance without a ledger field
        }
        for (const tok of tokList) { const c = cum[tok]; rows.balance.push(Object.assign({ time: d, tokenId: TOKENS[tok] }, Object.fromEntries(Object.entries(c).map(([k, v]) => [k, String(v)])))); }
        rows.volume.push({ time: d, volumeUsd: '0' });
      }
      // volume per day from fills
      const volByDay = {}; for (const f of fills) { const k = dayKey(f.createdAt); volByDay[k] = (volByDay[k] || 0) + U.num(f.filled) * U.num(f.price); }
      for (const vr of rows.volume) vr.volumeUsd = String(volByDay[vr.time] || 0);
      const balancesNow = tokList.map((tok) => ({ tokenAddress: TOKEN_ADDR[tok], tokenName: tok, amount: String(cum[tok].balance), available: String(cum[tok].balance), totalUsed: '0' }));

      // ---- Predict: 400 predictions over the period, most decided, some unclaimed, some open
      const preds = [];
      for (let i = 0; i < 400; i++) {
        const t = created + 300 * DAY + r() * (now - created - 300 * DAY); const stake = +(5 + r() * 200).toFixed(2); const odds = 0.05 + r() * 0.9; const cp = +(stake / odds - stake).toFixed(2);
        const decided = r() < 0.9; const won = decided && r() < odds * 0.93; const settled = decided && r() < 0.8;
        preds.push({ id: 'pr-' + i, t: Math.round(t), sa: settled ? Math.round(t + (1 + r() * 20) * DAY) : null, p: ADDR, c: '0x79c1000000000000000000000000000000000052d', s: stake, cp, st: settled ? 1 : 0, dv: decided && !settled ? (won ? 1 : 0) : undefined, r: settled ? (won ? 'PREDICTOR_WINS' : 'COUNTERPARTY_WINS') : null, tx: null, cat: ['Sports', 'Crypto', 'Weather', 'Politics'][Math.floor(r() * 4)], k: [['Will something happen on day ' + i + '?', r() < 0.5 ? 1 : 0, +odds.toFixed(3), Math.round(t + 2 * DAY), 'Sports', null]] });
      }

      // ---- patch the API surface the Tax center (and the account picker) touch
      const orig = { subaccountsOf: A.subaccountsOf, subaccount: A.subaccount, history: A.history, positions: A.positions, page: A.page, balances: A.balances, openPositions: A.openPositions, live: P.live, snapshotFile: P.snapshotFile };
      const sub = { id: SID, account: ADDR, name: '0x7369' + '6d'.repeat(1) + '0'.repeat(56), createdAt: created };
      A.subaccountsOf = async (addr) => (String(addr).toLowerCase() === ADDR ? [sub] : orig.subaccountsOf(addr));
      A.subaccount = async (id) => (id === SID ? sub : orig.subaccount(id));
      A.history = async (kind, sid, o) => { if (sid !== SID) return orig.history(kind, sid, o); const src = kind === 'balance' ? rows.balance : kind === 'volume' ? rows.volume : []; return src.filter((x) => x.time >= (o.start || 0) && x.time < (o.end || Infinity)); };
      A.positions = async (sid, o) => { if (sid !== SID) return orig.positions(sid, o); const out = positions.slice(); out.truncated = false; return out; };
      A.openPositions = async (sid, o) => (sid === SID ? positions.filter((p) => U.num(p.size) !== 0) : orig.openPositions(sid, o));
      A.balances = async (sid, o) => (sid === SID ? balancesNow : orig.balances(sid, o));
      A.page = async (base, path, params, o) => {
        if (params && params.subaccountId === SID) {
          const inRange = (t) => t >= (params.createdAfter || 0) && t < (params.createdBefore || Infinity);
          if (path === '/v1/order/fill') { const out = fills.filter((f) => inRange(f.createdAt)); out.truncated = false; return out; }
          if (path === '/v1/token/transfer') { const out = transfers.filter((t) => inRange(t.createdAt)); out.truncated = false; return out; }
        }
        return orig.page(base, path, params, o);
      };
      P.live = async () => false;
      P.snapshotFile = async (rel, o) => (rel === 'bettors/' + ADDR + '.json' ? { address: ADDR, builtAt: now, total: preds.length, truncated: false, predictions: preds } : orig.snapshotFile(rel, o));
      A.clearCache && A.clearCache();
      const truth = { address: ADDR, sid: SID, positions: positions.length, fills: fills.length, transfers: transfers.length, events: events.length, balances: Object.fromEntries(tokList.map((k) => [k, cum[k].balance])), glitch: opts.glitch !== false ? 0.1 : 0 };
      window.MDSim.truth = truth; window.MDSim.data = { positions, fills, transfers, events, rows, preds };
      return truth;
    },
  };
})();
