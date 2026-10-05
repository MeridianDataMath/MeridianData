/* MeridianDataHub — Copy agent page (#/copytrade/agent): set up the local copy agent (key, wallet-signed linked signer,
   config), then watch and control it through its local status port. The site never holds a key: the signer key stays
   on the user's machine, the owner wallet signs the link in the browser. */
(function () {
  const MD = window.MD; const U = MD.util; const A = MD.api; const UI = MD.ui; const AL = MD.alerts; const C = MD.charts; const h = U.h;
  const isAbort = (e) => e && e.name === 'AbortError';
  const KEY = 'md.agent.v1';   // page state kept in this browser: config draft, status port, token
  // the agent's control token: random, since it is all that stands between any local web page and pause / resume / close all
  const newToken = () => { const b = new Uint8Array(24); crypto.getRandomValues(b); return btoa(String.fromCharCode.apply(null, b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const DEF = () => ({ port: 8790, token: newToken(), cfg: { owner: '', subaccountId: '', leaders: [], sizing: { mode: 'fixed', size: 200, ratio: 10 }, execution: { type: 'IOC', slippageBps: 15, groupMs: 1200, maxFillAgeMs: 15000, onLeaderFlat: 'close', onLeaderLiquidation: 'close' }, risk: { maxOrderUsd: 1000, maxPositionUsd: 5000, maxNotionalPerMarket: 1000, maxOpenPositions: 5, maxLeverage: 3, maxPriceDeviationPct: 3, dailyLossStop: 100, drawdownStopPct: 15, minOrderUsd: 10, markets: { deny: [] }, onTrip: 'reduceOnly' }, ntfy: { server: 'https://ntfy.sh', topic: '' } } });
  const load = () => {
    const s = U.storage.get(KEY, null); const d = DEF();
    const st = !s ? d : Object.assign(d, s, { cfg: Object.assign(d.cfg, s.cfg || {}, { sizing: Object.assign(d.cfg.sizing, (s.cfg || {}).sizing || {}), execution: Object.assign(d.cfg.execution, (s.cfg || {}).execution || {}), risk: Object.assign(d.cfg.risk, (s.cfg || {}).risk || {}), ntfy: Object.assign(d.cfg.ntfy, (s.cfg || {}).ntfy || {}) }) });
    if (String(st.token || '').length < 16) st.token = newToken();   // an old empty or short one: the agent no longer starts with it
    return st;
  };
  const usd0 = (v) => U.fmtUsd(v, { dp: 0 });
  /** The agent's leverage two ways, from its status: as Meridian's app shows it (positions at the mark ÷ the balance, i.e.
   *  every pool's amount) and on equity, the one the agent's max leverage caps; null when the divisor is not above 0 */
  const leverage = (S) => ({ balance: U.num(S.balance) > 0 ? U.num(S.notional) / U.num(S.balance) : null, equity: U.num(S.equity) > 0 ? U.num(S.notional) / U.num(S.equity) : null });
  const code = (text) => h('pre.code', h('code', text));
  const files = ['copy-agent.mjs', 'package.json', 'package-lock.json', 'config.example.json'];

  /**
   * Copy history from the agent's order records: our own positions rebuilt from the fills the exchange reported for the
   * agent's orders (the same episode engine as the simulator), each attributed to the leader whose order opened it;
   * slippage against the leader's own fill price and the delay behind it per fill. Only what the agent itself opened
   * (CS.agentFills): a close of a position it adopted or one traded by hand is not a position of its own.
   * A position's result is Meridian's own figure (`pnl`, CS.leaderResult's app: Closed P&L, open ones gross at the mark),
   * which Realized, Open, the per-leader P&L, the share profitable and the chart count; the site's net (position fees and
   * unsettled funding, open ones with their partial closes) rides along as `net` for the tooltips.
   */
  function history(S, ref, positions) {
    const CS = MD.copysim; const recs = (S.orders || []).filter((r) => r.fills && r.fills.length);
    if (!recs.length) return null;
    const byOrder = {}; for (const r of recs) byOrder[r.id] = r;
    const fills = CS.agentFills(recs);
    const eps = CS.attachPositions(CS.episodes(fills, positions || []), positions || []);
    const leaderOf = (sid) => (S.leaders || []).find((l) => l.sid === sid) || null;
    const rows = eps.map((e) => {
      const first = e.fills.find((x) => !x.synthetic); const rec = first && byOrder[first.oid]; const l = rec ? leaderOf(rec.leaderSid) : null;
      const L = CS.leaderResult(e, S.mark && S.mark[e.pid]);
      // slippage and delay per fill of this position, from the orders that produced them
      let slipW = 0, slipSum = 0, delaySum = 0, delayN = 0, standIn = 0;
      for (const fl of e.fills) { const r = byOrder[fl.oid]; if (!r || !r.leaderPx) continue; const dir = r.side === 'BUY' ? 1 : -1; const w = Math.abs(fl.q) * fl.px; if (r.resync) { standIn += w; continue; } slipW += w; slipSum += dir * ((fl.px - r.leaderPx) / r.leaderPx) * 1e4 * w; if (r.leaderT) { delaySum += Math.max(0, fl.t - r.leaderT); delayN++; } }
      const prod = ref && ref.byId[e.pid];
      return { e, L, ticker: prod ? prod.displayTicker : e.pid, leader: l, leaderSid: rec ? rec.leaderSid : null, open: !!e.qty, t0: e.start, t1: e.end, hold: (e.end || Date.now()) - e.start, pnl: L.app, net: L.net, gross: L.gross, fees: L.fees, posFee: L.posFee, funding: L.funding, entryNotional: L.entryNotional, slipW, slipSum, slipBps: slipW ? slipSum / slipW : null, delayMs: delayN ? delaySum / delayN : null, standIn: standIn > 0, liq: e.liq, why: rec ? rec.why : '' };
    }).sort((a, b) => (b.t1 || Date.now()) - (a.t1 || Date.now()));
    const perLeader = {};
    // slippage is weighted by each fill's own notional everywhere (per position, per leader, in total)
    for (const r of rows) { const k = r.leaderSid || 'none'; const p = perLeader[k] || (perLeader[k] = { leader: r.leader, sid: k, n: 0, open: 0, wins: 0, pnl: 0, net: 0, fees: 0, posFee: 0, funding: 0, slipW: 0, slipSum: 0, delaySum: 0, delayN: 0, notional: 0 }); p.n++; if (r.open) p.open++; else if (r.pnl > 0) p.wins++; p.pnl += r.pnl; p.net += r.net; p.fees += r.fees; p.posFee += r.posFee; p.funding += r.funding; p.notional += r.entryNotional; p.slipW += r.slipW; p.slipSum += r.slipSum; if (r.delayMs != null) { p.delaySum += r.delayMs; p.delayN++; } }
    const leaders = Object.values(perLeader).map((p) => Object.assign(p, { slipBps: p.slipW ? p.slipSum / p.slipW : null, delayMs: p.delayN ? p.delaySum / p.delayN : null, closed: p.n - p.open, winRate: p.n - p.open ? (p.wins / (p.n - p.open)) * 100 : null })).sort((a, b) => b.pnl - a.pnl);
    const closed = rows.filter((r) => !r.open).slice().sort((a, b) => a.t1 - b.t1);
    const series = {}; const cum = {};
    for (const r of closed) { const k = r.leaderSid || 'none'; cum[k] = (cum[k] || 0) + r.pnl; (series[k] || (series[k] = [])).push({ x: r.t1, y: cum[k] }); }
    const openRows = rows.filter((r) => r.open);
    // realized / open: Meridian's Closed P&L and its open P&L at the mark; the *Net twins are the site's, for the tooltips
    const T = { realized: U.sum(closed, (r) => r.pnl), openPnl: U.sum(openRows, (r) => r.pnl), realizedNet: U.sum(closed, (r) => r.net), openNet: U.sum(openRows, (r) => r.net), fees: U.sum(rows, (r) => r.fees), posFee: U.sum(rows, (r) => r.posFee), funding: U.sum(rows, (r) => r.funding), n: rows.length, open: openRows.length, wins: closed.filter((r) => r.pnl > 0).length };
    T.net = T.realizedNet + T.openNet;
    const slipW = U.sum(rows, (r) => r.slipW); T.slipBps = slipW ? U.sum(rows, (r) => r.slipSum) / slipW : null;
    const dRows = rows.filter((r) => r.delayMs != null); T.delayMs = dRows.length ? U.sum(dRows, (r) => r.delayMs) / dRows.length : null;
    return { rows, leaders, series, T };
  }

  MD.copyagentPage = {
    leverage, history,
    async mount(root, route, ctx) {
      MD.setTopbar(h('span.title', 'Copy trading · Copy agent'));
      const st = load(); const save = () => U.storage.set(KEY, st); save();   // a token made just now must be the one next time too
      // the agent's local port: every request carries the token, /status included
      const agentUrl = (p) => `http://127.0.0.1:${U.num(st.port) || 8790}/${p}`; const agentHdr = () => ({ 'x-agent-token': st.token || '' });
      const agentSigner = async () => { try { const r = await fetch(agentUrl('status'), { headers: agentHdr(), signal: AbortSignal.timeout(2000) }); if (!r.ok) return { refused: r.status }; return { signer: (await r.json()).signer }; } catch (_) { return null; } };
      const body = h('div.stack');
      U.replace(root, h('div.page', h('div.stack', h('div.row.wrap', { style: { gap: '8px' } }, h('a.btn.sm.ghost', { href: '#/copytrade' }, '← Leaders'), h('span.dim.small', 'the copy agent runs on your own machine; this page sets it up and watches it')), body)));

      // ---- hero
      const hero = h('div.card.ct-hero',
        h('div.row', { style: { marginBottom: '8px' } }, UI.chip('non-custodial', 'accent'), h('span.dim.small', 'linked signer · your machine · orders only, never withdrawals')),
        h('h1', 'Copy leaders into your own account'),
        h('p', 'A small program on your computer follows the leaders you choose and mirrors their positions into your Meridian subaccount, sized and limited the way you set here. It trades with a Meridian linked signer: a key made on your machine that can submit and cancel orders and can never withdraw (orders alone can still lose the account\'s margin, so only ever link a key you made yourself). Your wallet signs the link once, on this page; the site holds nothing.'),
        h('p', 'Before running it with money: replay the leaders in the simulator, paper-copy them for a while, then run the agent with --dry (every order goes to the exchange\'s margin check, nothing is placed) and watch it here. Copying is not a promise of the leader\'s result: see "Edge left" on every leader.'),
        h('details', { style: { marginTop: '6px' } }, h('summary.small', { style: { cursor: 'pointer', color: 'var(--text-2)' } }, 'What the agent does and does not do'), h('ul.small.muted', { style: { margin: '6px 0 0 18px', padding: 0, lineHeight: '1.6' } },
          h('li', 'It mirrors position changes it sees on the leader\'s fill stream, sized by your rule; it reads its own fills back from the exchange after every order rather than assuming them, and re-reads the leaders every five minutes and on every hint, so a close or a reduction missed over a disconnect is caught up. An opening missed over a disconnect, heard of late, or filled far from the mark is listed as not copied and never chased.'),
          h('li', 'It sizes every opening and add and checks every limit at the exchange\'s mark, not at the leader\'s price, with a hard ceiling per order and per position in every sizing mode. Openings, adds and reductions need a mark price and go out as limit IOC orders capped at the mark ± your slippage (or as market orders if you choose); closes (the leader closed or reversed, a re-read found the leader flat, Close all, a risk stop set to close everything, an orphan you set to be closed) always go out as market orders. It never chases an unfilled opening (an unfilled reduction is added to the next one), never opens a position in a market another followed leader already occupies, and never opens or adds while its view of your own account is more than two minutes old.'),
          h('li', 'Stops: today\'s loss and the drawdown from the peak, both on Meridian\'s Trade Equity (funding and position fees count when they are charged, not when they settle) and both with deposits and withdrawals taken out so a transfer cannot trip or mask them. A stop blocks new and larger positions (or closes everything, by config) until you resume.'),
          h('li', 'What it cannot protect you from: the leader being wrong; a partial fill leaving you smaller than intended (later reductions scale to what you actually hold); the exchange rejecting a close because it would breach a limit; your machine, network or the exchange going down while positions are open (they stay open; the next start adopts them). The dashboard lists its latest 30 orders with what the exchange reported; the daily log files in its logs folder keep every one.'))));

      // ---- step 1: install
      const step1 = UI.card('1 · Install and make a key', h('div', { style: { padding: '12px 16px' } },
        h('p.small.muted', { style: { margin: '0 0 8px' } }, 'Needs Node.js 22 or newer. Put these files in a folder of their own:'),
        h('div.row.wrap', { style: { gap: '6px', marginBottom: '8px' } }, files.map((f) => h('a.btn.sm', { href: 'agent/' + f, download: f }, f))),
        code('npm ci --ignore-scripts\nnode copy-agent.mjs keygen'),
        h('p.small.dim', { style: { margin: '8px 0 0' } }, 'npm ci installs exactly the versions package-lock.json pins, checked against their hashes, and --ignore-scripts runs none of their install scripts. keygen writes signer.key next to the script, readable by your user account only, and prints the signer address. Once linked the key can only place and cancel orders, but that is enough to lose the account\'s margin: keep the folder in your own user profile, not on a shared drive.')));

      // ---- step 2: link the signer with the wallet
      const linkIn = h('textarea.input', { rows: 4, placeholder: 'Paste the contents of link-request.json here (node copy-agent.mjs link writes it after config.json exists)', spellcheck: false, style: { width: '100%', fontFamily: 'var(--mono)', fontSize: '11.5px' } });
      const linkOut = h('div.small', { style: { marginTop: '8px' } });
      const signersOut = h('div', { style: { marginTop: '10px' } });
      const rpcTypes = async () => { const rpc = await A.get(A.BASE + '/v1/rpc/config', { ttl: 600000 }); const parse = (s) => s.split(',').map((f) => { const [type, name] = f.trim().split(' '); return { name, type }; }); return { rpc, parse }; };
      const walletSign = async (primary, message, owner) => {
        if (!window.ethereum) throw new Error('No wallet found in this browser (MetaMask, Rabby, …)');
        const { rpc, parse } = await rpcTypes();
        const [from] = await window.ethereum.request({ method: 'eth_requestAccounts' });
        if (owner && from.toLowerCase() !== owner.toLowerCase()) throw new Error(`The wallet is on ${U.shortAddr(from, 4)}, not the owner ${U.shortAddr(owner, 4)}`);
        const typed = { types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], [primary]: parse(rpc.signatureTypes[primary]) }, primaryType: primary, domain: { name: rpc.domain.name, version: rpc.domain.version, chainId: Number(rpc.domain.chainId), verifyingContract: rpc.domain.verifyingContract }, message };
        return window.ethereum.request({ method: 'eth_signTypedData_v4', params: [from, JSON.stringify(typed)] });
      };
      const listSigners = async () => {
        const sid = st.cfg.subaccountId; if (!U.isUuid(sid)) { U.replace(signersOut); return; }
        try {
          const rows = await A.page(A.BASE, '/v1/linked-signer', { subaccountId: sid }, { maxPages: 2 });
          U.replace(signersOut, h('div.small.dim', { style: { marginBottom: '4px' } }, 'Signers linked to this subaccount'), rows.length ? UI.table({ cols: [
            { key: 'a', label: 'Signer', render: (r) => h('span.mono', U.shortAddr(r.signer || r.address || '', 6)) },
            { key: 'n', label: 'Name', render: (r) => r.name || h('span.dim', '—') },
            { key: 's', label: 'Status', render: (r) => UI.chip(String(r.status || '').toLowerCase(), r.status === 'ACTIVE' ? 'green' : r.status === 'PENDING' ? 'amber' : '') },
            { key: 'e', label: 'Expires', render: (r) => (r.expiresAt ? U.fmtDate(U.num(r.expiresAt) < 1e12 ? U.num(r.expiresAt) * 1000 : U.num(r.expiresAt)) : h('span.dim', '—')) },
            { key: 'x', label: '', render: (r) => (r.status === 'ACTIVE' || r.status === 'PENDING' ? h('button.btn.sm.ghost', { onclick: async () => {
              // the list holds the exchange's own browser sessions too: say which kind of signer this is
              const conf = r.category === 'API' && r.name === 'MeridianDataHub copy agent'
                ? `Revoke the copy agent's signer ${U.shortAddr(r.signer, 4)}? Orders signed with this key are refused once the exchange processes the revocation.`
                : `Revoke ${r.name || 'this signer'} (${U.shortAddr(r.signer, 4)})?${r.category === 'TRADE_SESSION' ? ' This is a Meridian browser session, not the copy agent.' : ''} Orders signed with this key are refused once the exchange processes the revocation.`;
              if (!confirm(conf)) return;
              try {
                // a signer row carries no subaccount: the message needs its bytes32 name, and the owner, from the exchange
                const sa = await A.subaccount(sid);
                const msg = { sender: sa.account, signer: r.signer, subaccount: sa.name, nonce: String(Date.now()) + '000000', signedAt: Math.floor(Date.now() / 1000) };
                const signature = await walletSign('RevokeLinkedSigner', msg, sa.account);
                const x = await fetch(A.BASE + '/v1/linked-signer/revoke', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: Object.assign({}, msg, { subaccountId: sid }), signature }) });
                const j = await x.json().catch(() => ({}));
                if (!x.ok) throw new Error(Array.isArray(j.message) ? j.message.join('; ') : j.message || ('HTTP ' + x.status));
                U.toast(`Revoke submitted (status ${String(j.status || 'PENDING_REVOKE').toLowerCase()})`); listSigners();
              } catch (e) { U.toast('Revoke failed: ' + (e.message || e)); }
            } }, 'Revoke') : null) },
          ], rows }) : h('div.small.dim', 'none yet'));
        } catch (e) { if (!isAbort(e)) U.replace(signersOut, h('div.small.neg', 'Could not list signers: ' + e.message)); }
      };
      /** The pasted request, or what makes it wrong for the account set up in step 3, in words */
      const readLink = () => {
        let req; try { req = JSON.parse(linkIn.value.trim()); } catch (_) { return { err: 'That is not the JSON the agent printed.' }; }
        const d = req && req.data; if (!d || !req.signerSignature) return { err: 'The request needs "data" and "signerSignature".' };
        if (!U.isAddress(d.signer) || !U.isAddress(d.sender)) return { err: 'The request has no valid signer or owner address.' };
        if (Date.now() / 1000 - U.num(d.signedAt) > 3300) return { err: 'This request is more than 55 minutes old, so this page no longer signs it: run "node copy-agent.mjs link" again for a fresh one.' };
        if (U.isAddress(st.cfg.owner) && d.sender.toLowerCase() !== st.cfg.owner.toLowerCase()) return { err: `This request is for the wallet ${d.sender}, not the one in step 3 (${st.cfg.owner}).` };
        if (U.isUuid(st.cfg.subaccountId) && d.subaccountId !== st.cfg.subaccountId) return { err: `This request is for subaccount ${d.subaccountId}, not the one in step 3 (${st.cfg.subaccountId}).` };
        return { req, d };
      };
      // what the wallet is about to authorise, shown as soon as it is pasted and before anything is signed
      const linkWho = h('div.small', { style: { marginTop: '8px' } });
      linkIn.addEventListener('input', () => {
        const r = readLink(); if (!linkIn.value.trim()) { U.replace(linkWho); return; }
        U.replace(linkWho, r.err ? h('span.neg', r.err) : h('div', h('div', 'Signer this would let trade: ', h('b.mono', r.d.signer)), h('div.dim', `on subaccount ${U.decodeBytes32(r.d.subaccount)} (${r.d.subaccountId}) of ${r.d.sender}. It must be the address "node copy-agent.mjs link" printed on your machine.`)));
      });
      const linkBtn = h('button.btn.primary.sm', { onclick: async () => {
        const lr = readLink(); if (lr.err) { U.replace(linkOut, h('span.neg', lr.err)); return; }
        const { req, d } = lr;
        // the running agent's own signer, when it answers: a request for any other key is refused outright
        const ag = await agentSigner();
        if (ag && ag.signer && ag.signer.toLowerCase() !== d.signer.toLowerCase()) { U.replace(linkOut, h('span.neg', `Refused: this request would let ${d.signer} trade, but the agent running on this machine signs with ${ag.signer}. Link only the key your own agent printed; a request from anyone else hands them your account.`)); return; }
        const seen = ag && ag.signer ? 'It is the signer of the agent running on this machine.' : `No agent ${ag ? 'accepted this page\'s token' : 'answers'} on this machine, so the page cannot compare: check it against the address "node copy-agent.mjs link" printed.`;
        if (!confirm(`Your wallet is about to let this key trade on your account:\n\nsigner: ${d.signer}\nsubaccount: ${U.decodeBytes32(d.subaccount)}\nowner: ${d.sender}\n\n${seen}\n\nIt can never withdraw, but its orders alone can lose the account's margin. Continue?`)) return;
        try {
          U.replace(linkOut, h('span.dim', 'Asking the wallet to sign…'));
          const signature = await walletSign('LinkSigner', { sender: d.sender, signer: d.signer, subaccount: d.subaccount, nonce: d.nonce, signedAt: d.signedAt }, d.sender);
          const r = await fetch(A.BASE + '/v1/linked-signer/link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: d, signature, signerSignature: req.signerSignature }) });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(Array.isArray(j.message) ? j.message.join('; ') : j.message || ('HTTP ' + r.status));
          U.replace(linkOut, h('span.pos', `Linked: ${U.shortAddr(d.signer, 6)} may now trade on ${U.decodeBytes32(d.subaccount)} (status ${j.status || 'pending'}; the exchange confirms it on chain within a minute).`));
          if (!st.cfg.owner) st.cfg.owner = d.sender; if (!st.cfg.subaccountId) st.cfg.subaccountId = d.subaccountId; save(); listSigners();
        } catch (e) { U.replace(linkOut, h('span.neg', 'Link failed: ' + (e.message || e))); }
      } }, 'Sign with wallet and link');
      const step2 = UI.card('2 · Link the signer with your wallet', h('div', { style: { padding: '12px 16px' } },
        h('p.small.muted', { style: { margin: '0 0 8px' } }, 'Fill config.json first (step 3 writes it), then run ', h('code', 'node copy-agent.mjs link'), '. It prints a request the signer has already signed; paste it here and your wallet co-signs it. The exchange then lists the key as a linked signer of your subaccount: orders only, no withdrawals, revocable here at any time. The page shows the signer before your wallet signs and refuses one that is not your running agent\'s; never paste a link request someone else gave you.'),
        linkIn, linkWho, h('div.row', { style: { marginTop: '8px', gap: '8px' } }, linkBtn, h('span.dim.small', 'EIP-712 · signed in your wallet, sent straight to api.meridian.xyz')), linkOut, signersOut));

      // ---- step 3: the config
      const c = st.cfg;
      const inp = (obj, key, attrs) => h('input.input.sm', Object.assign({ value: obj[key] == null ? '' : obj[key], oninput: (e) => { obj[key] = attrs && attrs.type === 'number' ? U.num(e.target.value) : e.target.value.trim(); save(); renderJson(); } }, attrs || {}));
      const sel = (obj, key, opts) => h('select.input.sm', { onchange: (e) => { obj[key] = e.target.value; save(); renderJson(); } }, opts.map(([v, label]) => h('option', { value: v, selected: obj[key] === v }, label)));
      // the ntfy topic is the only secret (anyone who knows it reads the pushes): say so when it is easy to guess, and
      // when the server is not https (the agent refuses a plain-http one except on localhost)
      const ntfyWarn = h('span.small.neg');
      const ntfyCheck = () => { const w = MD.alerts.topicWarning(c.ntfy.topic); const bad = c.ntfy.server && !MD.alerts.serverOk(c.ntfy.server); U.replace(ntfyWarn, [w ? w + ': Generate one instead' : null, bad ? 'the server must be https://' : null].filter(Boolean).join(' · ')); };
      const ntfyTopic = inp(c.ntfy, 'topic', { placeholder: 'topic', style: { width: '200px' } }); ntfyTopic.addEventListener('input', ntfyCheck);
      const ntfyServer = inp(c.ntfy, 'server', { placeholder: 'https://ntfy.sh', style: { width: '160px' } }); ntfyServer.addEventListener('input', ntfyCheck);
      ntfyCheck();
      const fld = (label, el, hint) => h('div', { style: { marginBottom: '8px' } }, h('div.field-lbl', label), el, hint ? h('div.dim.xs', { style: { marginTop: '2px' } }, hint) : null);
      const leadersWrap = h('div');
      const renderLeaders = () => U.replace(leadersWrap, h('div.row.wrap', { style: { gap: '6px' } }, c.leaders.map((l) => h('span.chip', { style: { display: 'inline-flex', gap: '6px', alignItems: 'center' } }, h('a', { href: U.accountUrl(l.address, l.sid) }, l.name && l.name !== 'primary' ? l.name : U.shortAddr(l.address, 4)), h('button', { style: { background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'inherit', display: 'inline-flex' }, onclick: () => { c.leaders = c.leaders.filter((x) => x.sid !== l.sid); save(); renderLeaders(); renderJson(); } }, U.icon('x')))),
        AL.state().leaders.filter((l) => !c.leaders.some((x) => x.sid === l.sid)).map((l) => h('button.btn.sm.ghost', { onclick: () => { c.leaders.push({ sid: l.sid, address: l.address, name: l.name || '' }); save(); renderLeaders(); renderJson(); } }, '+ ' + (l.name && l.name !== 'primary' ? l.name : U.shortAddr(l.address, 4))))),
        c.leaders.length ? null : h('div.dim.small', { style: { marginTop: '4px' } }, 'No leader yet: follow some with the bell on the Leaders page, they appear here to add.'));
      renderLeaders();
      const addrIn = h('input.input.sm', { placeholder: 'or a wallet address (0x…) to add', style: { width: '320px' }, spellcheck: false });
      const addBtn = h('button.btn.sm', { onclick: async () => { const v = addrIn.value.trim().toLowerCase(); if (!U.isAddress(v)) { U.toast('Enter a 0x address'); return; } try { const subs = await A.subaccountsOf(v); if (!subs.length) { U.toast('No Meridian subaccount for that address'); return; } for (const s of subs) if (!c.leaders.some((x) => x.sid === s.id)) c.leaders.push({ sid: s.id, address: v, name: U.decodeBytes32(s.name) }); addrIn.value = ''; save(); renderLeaders(); renderJson(); } catch (e) { U.toast(e.message); } } }, 'Add');
      const jsonOut = h('pre.code', { style: { maxHeight: '260px', overflow: 'auto' } });
      // a hard limit left empty (or at 0) is written as its default, never as "no limit" (the agent would refuse a 0 there)
      const D = DEF().cfg; const orDef = (v, d) => (U.num(v) > 0 ? U.num(v) : d);
      const buildCfg = () => ({ owner: c.owner, subaccountId: c.subaccountId, keyFile: 'signer.key', leaders: c.leaders, sizing: { mode: c.sizing.mode, size: U.num(c.sizing.size), ratio: U.num(c.sizing.ratio) }, execution: { type: c.execution.type, slippageBps: U.num(c.execution.slippageBps), groupMs: U.num(c.execution.groupMs) || 1200, maxFillAgeMs: orDef(c.execution.maxFillAgeMs, D.execution.maxFillAgeMs), onLeaderFlat: c.execution.onLeaderFlat, onLeaderLiquidation: c.execution.onLeaderLiquidation }, risk: { maxOrderUsd: orDef(c.risk.maxOrderUsd, D.risk.maxOrderUsd), maxPositionUsd: orDef(c.risk.maxPositionUsd, D.risk.maxPositionUsd), maxNotionalPerMarket: U.num(c.risk.maxNotionalPerMarket), maxOpenPositions: U.num(c.risk.maxOpenPositions), maxLeverage: U.num(c.risk.maxLeverage), maxPriceDeviationPct: Math.min(50, orDef(c.risk.maxPriceDeviationPct, D.risk.maxPriceDeviationPct)), dailyLossStop: U.num(c.risk.dailyLossStop), drawdownStopPct: U.num(c.risk.drawdownStopPct), minOrderUsd: U.num(c.risk.minOrderUsd), markets: { deny: (c.risk.markets.deny || []).filter(Boolean) }, onTrip: c.risk.onTrip }, status: { port: U.num(st.port) || 8790, token: st.token }, ntfy: { server: c.ntfy.server || 'https://ntfy.sh', topic: c.ntfy.topic || '' } });
      const renderJson = () => { jsonOut.textContent = JSON.stringify(buildCfg(), null, 2); };
      const denyIn = h('input.input.sm', { value: (c.risk.markets.deny || []).join(', '), placeholder: 'e.g. HYPE-USD, XAG-USD', style: { width: '260px' }, oninput: (e) => { c.risk.markets.deny = e.target.value.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean); save(); renderJson(); } });
      const tokenHint = h('span.xs');
      const tokenCheck = () => U.replace(tokenHint, st.token.length < 16 ? h('span.neg', '16 characters or more: the agent refuses a shorter one') : null);
      const tokenIn = h('input.input.sm', { value: st.token, spellcheck: false, style: { width: '260px', fontFamily: 'var(--mono)' }, oninput: (e) => { st.token = e.target.value.trim(); save(); renderJson(); tokenCheck(); } });
      const tokenNew = h('button.btn.sm.ghost', { title: 'Make a new random token (then download config.json again and restart the agent)', onclick: () => { st.token = newToken(); tokenIn.value = st.token; save(); renderJson(); tokenCheck(); U.toast('New token: download config.json again and restart the agent'); } }, 'New');
      const ageIn = h('input.input.sm', { type: 'number', min: 1, step: 1, value: U.num(c.execution.maxFillAgeMs) / 1000 || 15, style: { width: '70px' }, oninput: (e) => { c.execution.maxFillAgeMs = Math.round(U.num(e.target.value) * 1000); save(); renderJson(); } });
      const useWallet = h('button.btn.sm', { onclick: async () => { try { if (!window.ethereum) throw new Error('no wallet in this browser'); const [from] = await window.ethereum.request({ method: 'eth_requestAccounts' }); c.owner = from.toLowerCase(); const subs = await A.subaccountsOf(c.owner); if (subs.length) c.subaccountId = subs[0].id; save(); renderJson(); U.toast(subs.length ? 'Owner and subaccount filled from the wallet' : 'Owner filled; no Meridian subaccount found for it'); ownerIn.value = c.owner; subIn.value = c.subaccountId; listSigners(); } catch (e) { U.toast(e.message || String(e)); } } }, 'Use my wallet');
      const ownerIn = inp(c, 'owner', { placeholder: '0x… your wallet', style: { width: '380px' }, spellcheck: false });
      const subIn = inp(c, 'subaccountId', { placeholder: 'subaccount ID ("Use my wallet" fills in your first)', style: { width: '320px' }, spellcheck: false, onchange: () => listSigners() });
      const dl = h('button.btn.primary.sm', { onclick: () => { const cfg = buildCfg(); const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = h('a', { href: url, download: 'config.json' }); document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000); U.toast('config.json downloaded: put it next to copy-agent.mjs'); } }, 'Download config.json');
      const step3 = UI.card('3 · Configure', h('div', { style: { padding: '12px 16px' } },
        h('div.grid.cols-2',
          h('div',
            fld('Your account', h('div.row.wrap', { style: { gap: '6px' } }, ownerIn, subIn, useWallet)),
            fld('Leaders to copy', h('div', leadersWrap, h('div.row', { style: { gap: '6px', marginTop: '6px' } }, addrIn, addBtn))),
            fld('Sizing', h('div.row.wrap', { style: { gap: '6px' } }, sel(c.sizing, 'mode', [['fixed', 'Fixed $ per position (the leader\'s opening order)'], ['perfill', 'Fixed $ per leader order (per batch of its fills)'], ['ratio', '% of the leader\'s quantity']]), inp(c.sizing, 'size', { type: 'number', min: 10, step: 10, style: { width: '110px' } }), h('span.dim.small', 'USD ·'), inp(c.sizing, 'ratio', { type: 'number', min: 0.1, step: 1, style: { width: '80px' } }), h('span.dim.small', '% (ratio mode)')), 'fixed: the leader\'s opening order becomes this size, counted on the quantity the leader ordered, so an order cancelled after a partial fill gives a proportionally smaller copy (the simulator counts only what filled); per order: this size for each batch of a leader order\'s fills that arrive within 1.2 s of each other, while the simulator\'s "$ per fill" sizes every entry fill (an order that fills against four resting orders is four fills there, one batch here); ratio: that % of the leader\'s quantity, as in the simulator. Adds follow in proportion only up to the USD max per market below (a leader who opens small and scales in would otherwise make a position any multiple of the size); left at 0, the agent uses five times the size'),
            fld('Execution', h('div.row.wrap', { style: { gap: '6px' } }, sel(c.execution, 'type', [['IOC', 'Limit IOC at mark ± slippage cap'], ['MARKET', 'Market order']]), inp(c.execution, 'slippageBps', { type: 'number', min: 1, step: 1, style: { width: '80px' } }), h('span.dim.small', 'bps cap'), sel(c.execution, 'onLeaderFlat', [['close', 'Leader flat without a fill → close'], ['hold', 'Leader flat without a fill → hold']]), sel(c.execution, 'onLeaderLiquidation', [['close', 'Leader liquidated → close'], ['hold', 'Leader liquidated → hold']]), h('span.row', { style: { gap: '4px' } }, ageIn, h('span.dim.small', 's max age of a leader fill'))), 'A leader liquidation follows its own setting, whatever the flat setting says (a held copy of a liquidated position is no longer followed in that market). An IOC order fills up to the cap and cancels the rest: an unfilled opening or add is logged and not chased, an unfilled reduction is added to the next reduction of that market; closes always go out as market orders, whichever type is chosen here. A leader fill that reaches the agent later than the max age (a reconnect, a long queue) is listed as missed on the dashboard, not copied')),
          h('div',
            fld('Risk limits', h('div.row.wrap', { style: { gap: '6px 12px' } },
              h('span.row', { style: { gap: '4px' } }, inp(c.risk, 'maxOrderUsd', { type: 'number', min: 10, step: 100, style: { width: '90px' } }), h('span.dim.small', 'USD max per order')),
              h('span.row', { style: { gap: '4px' } }, inp(c.risk, 'maxPositionUsd', { type: 'number', min: 10, step: 100, style: { width: '90px' } }), h('span.dim.small', 'USD max per position')),
              h('span.row', { style: { gap: '4px' } }, inp(c.risk, 'maxNotionalPerMarket', { type: 'number', min: 0, step: 100, style: { width: '100px' } }), h('span.dim.small', 'USD max per market')),
              h('span.row', { style: { gap: '4px' } }, inp(c.risk, 'maxPriceDeviationPct', { type: 'number', min: 0.5, max: 50, step: 0.5, style: { width: '70px' } }), h('span.dim.small', '% max leader price off the mark')),
              h('span.row', { style: { gap: '4px' } }, inp(c.risk, 'maxOpenPositions', { type: 'number', min: 1, step: 1, style: { width: '70px' } }), h('span.dim.small', 'open positions max')),
              h('span.row', { style: { gap: '4px' } }, inp(c.risk, 'maxLeverage', { type: 'number', min: 1, step: 0.5, style: { width: '70px' }, title: 'Positions at the mark ÷ equity (Meridian\'s Trade Equity). Meridian\'s own account leverage divides by the balance instead, so this one is the higher of the two whenever the positions\' uPnL, less the funding and position fees charged on them and not yet settled, is negative' }), h('span.dim.small', '× max leverage on equity')),
              h('span.row', { style: { gap: '4px' } }, inp(c.risk, 'dailyLossStop', { type: 'number', min: 0, step: 10, style: { width: '90px' } }), h('span.dim.small', 'USD daily loss stop')),
              h('span.row', { style: { gap: '4px' } }, inp(c.risk, 'drawdownStopPct', { type: 'number', min: 0, step: 1, style: { width: '70px' } }), h('span.dim.small', '% drawdown stop')),
              h('span.row', { style: { gap: '4px' } }, inp(c.risk, 'minOrderUsd', { type: 'number', min: 0, step: 5, style: { width: '70px' } }), h('span.dim.small', 'USD min order')),
              h('span.row', { style: { gap: '4px' } }, sel(c.risk, 'onTrip', [['reduceOnly', 'On a stop: reduce-only'], ['closeAll', 'On a stop: close everything']]))), 'the USD max per order and per position are hard ceilings in every sizing mode, ratio included (left empty they take the default, never "no limit"); sizes and limits are counted at the exchange\'s mark, and a leader fill further off it than the % set (a stub quote on a thin book) is not copied. A tripped stop blocks new and larger positions until you resume from the dashboard; reductions and closes still follow the leader'),
            fld('Markets not to copy', denyIn),
            fld('Dashboard', h('div.row.wrap', { style: { gap: '6px' } }, h('span.dim.small', 'port'), inp(st, 'port', { type: 'number', min: 1024, step: 1, style: { width: '80px' } }), h('span.dim.small', 'token'), tokenIn, tokenNew, tokenHint), 'made at random here and written into config.json: the agent answers on 127.0.0.1 only, and only with this token, which guards the dashboard, pause / resume and close all. If you run the agent with a config of your own and an empty token, it makes one in control.token next to the script: paste that here'),
            fld('Phone push (ntfy)', h('div.row.wrap', { style: { gap: '6px' } }, ntfyTopic, h('button.btn.sm', { title: 'Fill in a long random topic nobody can guess; subscribe to the same name in the ntfy app', onclick: () => { ntfyTopic.value = MD.alerts.newTopic(); ntfyTopic.dispatchEvent(new Event('input')); } }, 'Generate'), ntfyServer, ntfyWarn), 'rejected orders, risk stops and leader liquidations; the topic is the only secret (anyone who knows it reads these), and the server must be https:// (plain http only on localhost)'))),
        h('div.row', { style: { gap: '8px', margin: '8px 0' } }, dl, h('span.dim.small', 'or copy the JSON into config.json next to the script')),
        jsonOut));
      renderJson(); tokenCheck();

      // ---- step 4 + dashboard
      const dash = h('div'); const histWrap = h('div');
      let timer = null, last = null, lastErr = null, refused = null, ownPositions = null, ownPosAt = 0;
      const post = async (p) => { try { const r = await fetch(agentUrl(p), { method: 'POST', headers: agentHdr() }); if (!r.ok) throw new Error(r.status === 401 ? 'wrong token' : 'HTTP ' + r.status); U.toast(p + ' sent'); poll(); } catch (e) { U.toast(`${p} failed: ${e.message}`); } };
      const poll = async () => {
        try {
          const r = await fetch(agentUrl('status'), { signal: ctx.signal, headers: agentHdr() });
          // it answered but will not show itself: the token (or this page's origin) is not one it accepts
          if (r.status === 401 || r.status === 403) { last = null; lastErr = null; refused = r.status; } else { last = await r.json(); lastErr = null; refused = null; }
        } catch (e) { if (isAbort(e)) return; last = null; lastErr = e.message; refused = null; }
        renderDash();
        // the copy account's position records (funding, liquidations) for the history, refreshed every minute
        if (last && last.subaccountId && !last.dry && Date.now() - ownPosAt > 60000) { ownPosAt = Date.now(); try { ownPositions = await A.positions(last.subaccountId, { maxPages: 3, signal: ctx.signal }); } catch (e) { if (isAbort(e)) return; } }
        renderHistory();
      };
      function renderHistory() {
        if (!last) { U.replace(histWrap, h('div.empty', 'Appears once the agent is running: every position it opens, attributed to the leader whose order caused it, with your slippage against their fills and the delay behind them.')); return; }
        const H = history(last, MD._agentRef, ownPositions);
        if (!H) { U.replace(histWrap, h('div.empty', 'No filled order yet. History is built from the fills the exchange reports for the agent\'s orders, attributed to the leader whose order caused each one.')); return; }
        const who = (l) => (l ? (l.name && l.name !== 'primary' ? l.name : U.shortAddr(l.address, 4)) : 'no leader');
        const col = C.colors(); const palette = [col.accent, col.blue, col.amber, col.green, col.red];
        const usd2 = (v) => U.fmtUsd(v, { sign: true, dp: 2 });
        // Meridian's figures in the tiles; the site's net, with what it adds, in their tooltips
        const tiles = h('div.stats',
          UI.stat('Realized', h('span', { title: `Meridian's Closed P&L of these positions, summed: realized P&L − trading fees + settled funding, without position fees. Site's net incl. position fees and unsettled funding: ${usd2(H.T.realizedNet)}.` }, usd2(H.T.realized)), `${H.T.n - H.T.open} closed position${H.T.n - H.T.open === 1 ? '' : 's'} · ${H.T.n - H.T.open ? U.fmtPct((H.T.wins / (H.T.n - H.T.open)) * 100, { dp: 0 }) : '—'} profitable`, U.pnlClass(H.T.realized)),
          UI.stat('Open', h('span', { title: `Meridian's P&L of these open positions: (mark − average entry) × size, before fees and funding. Site's net incl. their partial closes, trading and position fees and funding (settled and not yet settled): ${usd2(H.T.openNet)}.` }, usd2(H.T.openPnl)), `${H.T.open} at the live mark, before fees and funding`, U.pnlClass(H.T.openPnl)),
          UI.stat('Slippage vs leader', H.T.slipBps == null ? '—' : (H.T.slipBps > 0 ? '+' : '') + U.fmtNum(H.T.slipBps, 1) + ' bps', 'your fill price against the leader\'s, per fill, size-weighted · positive = you paid more', H.T.slipBps > 0 ? 'neg' : H.T.slipBps < 0 ? 'pos' : ''),
          UI.stat('Delay', H.T.delayMs == null ? '—' : U.fmtNum(H.T.delayMs / 1000, 1) + ' s', 'from the leader\'s fill to yours, average'),
          UI.stat('Fees & funding', U.fmtUsd(-H.T.fees - H.T.posFee + H.T.funding, { sign: true, dp: 2 }), `${U.fmtUsd(H.T.fees, { dp: 2 })} fees` + (H.T.posFee ? ` · ${U.fmtUsd(H.T.posFee, { dp: 2 })} position fees` : '') + ` · ${U.fmtUsd(H.T.funding, { sign: true, dp: 2 })} funding`, U.pnlClass(-H.T.fees - H.T.posFee + H.T.funding)));
        const leadersTbl = UI.table({ cols: [
          { key: 'l', label: 'Leader', render: (p) => (p.leader ? h('a.addr', { href: U.accountUrl(p.leader.address, p.leader.sid) }, who(p.leader)) : h('span.dim', 'no leader')) },
          { key: 'n', label: 'Positions', num: true, render: (p) => h('span', String(p.closed), p.open ? h('span.dim.xs', ' + ' + p.open + ' open') : null) },
          { key: 'wr', label: 'Profitable', num: true, render: (p) => (p.winRate == null ? h('span.dim', '—') : U.fmtPct(p.winRate, { dp: 0 })) },
          { key: 'pnl', label: 'P&L', num: true, title: 'As Meridian shows the positions: Closed P&L (realized − trading fees + settled funding, without position fees) for closed ones, P&L at the mark (before fees and funding) for open ones, summed. Hover a cell for the site\'s net', render: (p) => h('span', { title: `Site's net incl. position fees and unsettled funding${p.open ? ', open positions also with their partial closes, fees and funding' : ''}: ${usd2(p.net)}` + (Math.abs(p.posFee) >= 0.005 ? ` (position fees ${usd2(-p.posFee)})` : '') }, U.pnlEl(p.pnl, { dp: 2 })) },
          { key: 'f', label: 'Fees', num: true, title: 'trading fees plus position fees (mPerps)', render: (p) => U.fmtUsd(p.fees + p.posFee, { dp: 2 }) },
          { key: 'fu', label: 'Funding', num: true, render: (p) => U.pnlEl(p.funding, { dp: 2 }) },
          { key: 'sl', label: 'Slippage', num: true, render: (p) => (p.slipBps == null ? h('span.dim', '—') : h('span', { class: p.slipBps > 0 ? 'neg' : 'pos' }, (p.slipBps > 0 ? '+' : '') + U.fmtNum(p.slipBps, 1) + ' bps')) },
          { key: 'd', label: 'Delay', num: true, render: (p) => (p.delayMs == null ? h('span.dim', '—') : U.fmtNum(p.delayMs / 1000, 1) + ' s') },
          { key: 'sim', label: '', render: (p) => (p.leader ? h('a.btn.sm.ghost', { href: '#/copytrade/sim?address=' + p.leader.address + '&sub=' + p.leader.sid }, 'Simulate') : null) },
        ], rows: H.leaders });
        const posTbl = UI.table({ cols: [
          { key: 't', label: 'Closed (UTC)', render: (r) => h('span.dim', r.open ? 'open' : new Date(r.t1).toISOString().replace('T', ' ').slice(0, 16)) },
          { key: 'l', label: 'Leader', render: (r) => (r.leader ? who(r.leader) : h('span.dim', '—')) },
          { key: 'm', label: 'Market', render: (r) => UI.marketCell(r.ticker) },
          { key: 's', label: 'Side', render: (r) => U.sideEl(r.e.side > 0, true) },
          // entry notional with the quantity opened beside it; Meridian's Size (that quantity at the exit price) in the tooltip
          { key: 'sz', label: 'Entry notional', num: true, title: 'What the agent put into the position: the opening order plus every add, each at its own fill price, with the quantity opened beside it. Meridian\'s Closed P&L "Size" is that quantity valued at the exit price instead: hover a row for it', render: (r) => { const prod = MD._agentRef && MD._agentRef.byId[r.e.pid]; return h('span', { title: MD.copysimPage.sizeTitle(r.e, r.entryNotional, prod) }, U.fmtUsd(r.entryNotional, { dp: 0 }), h('span.dim.xs', ' · ' + U.fmtQty(MD.copysimPage.closedSize(r.e).qty, prod && prod.lotSize))); } },
          { key: 'h', label: 'Held', num: true, render: (r) => U.fmtDuration(r.hold) },
          // Meridian's figure for the position, the site's net with what makes the difference in the tooltip
          { key: 'pnl', label: 'P&L', num: true, title: 'As Meridian shows the position: Closed P&L (realized − trading fees + settled funding, without position fees), or for an open one the P&L at the mark before fees and funding. Hover a row for the site\'s net (position fees and unsettled funding)', render: (r) => h('span', h('span', { title: MD.copysimPage.pnlTitle(r.L) }, U.pnlEl(r.pnl, { dp: 2 })), r.liq ? UI.chip('LIQ', 'red') : null) },
          { key: 'sl', label: 'Slippage', num: true, title: 'your fill price against the leader\'s, size-weighted over the position\'s fills; "at mark" when the leader\'s price was unknown (a close after a resync)', render: (r) => (r.slipBps == null ? h('span.dim', r.standIn ? 'at mark' : '—') : h('span', { class: r.slipBps > 0 ? 'neg' : 'pos' }, (r.slipBps > 0 ? '+' : '') + U.fmtNum(r.slipBps, 1) + ' bps', r.standIn ? h('span.dim.xs', ' · part at mark') : null)) },
          { key: 'd', label: 'Delay', num: true, render: (r) => (r.delayMs == null ? h('span.dim', '—') : U.fmtNum(r.delayMs / 1000, 1) + ' s') },
        ], rows: H.rows.slice(0, 40), empty: 'No position the agent opened has a fill yet; positions it adopted at start or that were closed by Close all are not listed.' });
        const canvas = h('canvas');
        const chartCard = h('div.card.chart-fill', h('div.row', { style: { marginBottom: '6px', flex: 'none' } }, h('h3', 'Realized by leader'), h('span.grow'), h('span.dim.small', 'cumulative Closed P&L, by position close')), h('div.chart-box.sm', canvas));
        U.replace(histWrap, tiles, h('div.grid.cols-2', { style: { marginTop: '12px' } }, UI.card('By leader', leadersTbl), chartCard), UI.card('Positions', posTbl, h('span.dim.small', (H.rows.length > 40 ? `newest 40 of ${H.rows.length} positions` : `${H.rows.length} position${H.rows.length === 1 ? '' : 's'}`) + ' from the agent\'s orders, newest first' + (last.dry ? ' · dry run: fills are virtual' : ''))),
          h('div.footer-note', { style: { textAlign: 'left', paddingBottom: 0 } }, 'Only positions the agent opened are here (fills the exchange reported for its orders); anything traded by hand on the same subaccount is not attributed. P&L is what Meridian shows for the position: its Closed P&L (realized − trading fees + settled funding, without position fees; the exchange\'s own record when it covers exactly this position, else the same sum from the fills), or for an open one the P&L at the live mark, before fees and funding. The site\'s net, which also takes off position fees and counts funding charged and not yet settled (and, while a position is open, its partial closes, fees and funding), is in each tooltip; funding, position fees and liquidations come from the exchange\'s position records. Slippage is your average fill against the leader\'s average fill on the order that triggered yours; a close made after a resync has no leader price and is shown "at mark".'));
        const ser = Object.entries(H.series).map(([sid, pts], i) => ({ points: pts, color: palette[i % palette.length], label: who((last.leaders || []).find((l) => l.sid === sid) || null) }));
        if (ser.length) C.timeSeries(canvas, { series: ser, yFmt: C.axisUsd, tipFmt: (v) => U.fmtUsd(v, { dp: 2, sign: true }) });
      }
      const renderDash = () => {
        if (!last) {
          const where = '127.0.0.1:' + (U.num(st.port) || 8790);
          if (refused) { U.replace(dash, h('div.empty', h('div', { style: { color: 'var(--amber)' } }, refused === 401 ? `The agent on ${where} refused this page's token. Put the token it runs with into the token field in step 3: status.token in its config.json, or control.token next to the script if it made one.` : `The agent on ${where} refused this page: it answers the site and the local dev server only.`))); return; }
          U.replace(dash, h('div.empty', h('div', { style: { marginBottom: '8px' } }, 'No agent answering on ' + where + (lastErr ? ' (' + lastErr + ')' : '')), code('node copy-agent.mjs run --dry'), h('div.dim.small', { style: { marginTop: '8px' } }, 'The dashboard connects to the agent on your own machine; nothing about it leaves your browser.')));
          return;
        }
        const S = last; const ref = MD._agentRef;
        const posRows = Object.entries(S.own || {}).map(([pid, o]) => ({ pid, ticker: ref && ref.byId[pid] ? ref.byId[pid].displayTicker : pid, o, leader: (S.leaders || []).find((l) => l.sid === (S.marketOwner || {})[pid]) }));
        const lpRows = [];
        for (const l of S.leaders || []) for (const [pid, q] of Object.entries((S.leaderPos || {})[l.sid] || {})) if (q) lpRows.push({ l, pid, ticker: ref && ref.byId[pid] ? ref.byId[pid].displayTicker : pid, q, mine: (S.own || {})[pid], owner: (S.marketOwner || {})[pid] === l.sid });
        const who = (l) => (l ? (l.name && l.name !== 'primary' ? l.name : U.shortAddr(l.address, 4)) : '—');
        // equity is Meridian's Trade Equity (balance + gross uPnL − funding and position fees charged and not yet settled);
        // an agent from before that sends no `unsettled`, and its equity is the gross one: said, not hidden
        const netEq = S.unsettled != null; const upnl = U.sum(Object.values(S.own || {}), (o) => U.num(o.upnl));
        const lev = leverage(S);
        U.replace(dash,
          h('div.row.wrap', { style: { gap: '8px', marginBottom: '10px' } },
            UI.chip(S.paused ? 'paused' : S.tripped ? 'risk stop' : 'running', S.paused ? 'amber' : S.tripped ? 'red' : 'green'), S.dry ? UI.chip('DRY RUN · nothing is placed', 'amber') : UI.chip('LIVE · real orders', 'red'), UI.chip('socket ' + S.ws + (S.reconnects ? ' · ' + S.reconnects + ' reconnect' + (S.reconnects > 1 ? 's' : '') : ''), S.ws === 'open' ? 'green' : 'amber'),
            h('span.dim.small', `up ${U.fmtDuration(S.uptime)} · signer ${U.shortAddr(S.signer, 4)} · ${(S.leaders || []).length} leader(s) · ${S.orders ? S.orders.length : 0} orders · ${S.errors || 0} errors` + (S.risk && S.risk.maxOrderUsd ? ` · at most ${usd0(S.risk.maxOrderUsd)} per order, ${usd0(S.risk.maxPositionUsd)} per position` : '')), h('span.grow'),
            S.paused || S.tripped ? h('button.btn.sm.primary', { onclick: () => post('resume') }, 'Resume') : h('button.btn.sm', { onclick: () => post('pause') }, 'Pause'),
            h('button.btn.sm.ghost', { onclick: () => post('resync'), title: 'Read the leaders\' positions again now. In markets you copy, a leader found flat closes yours (unless set to hold), a leader found on the other side closes yours without opening the new side, and a reduction is mirrored. Openings and adds the socket missed are listed under Not copied and not placed.' }, 'Resync'),
            h('button.btn.sm.ghost', { onclick: () => { if (confirm('Close every open position of the copy account at market?')) post('close-all'); } }, 'Close all')),
          S.tripped ? h('div.small', { style: { color: 'var(--red)', marginBottom: '8px' } }, 'Risk stop: ' + S.tripped.why + ' · new and larger positions are blocked until you resume') : null,
          S.orphans && S.orphans.length ? h('div.small', { style: { color: 'var(--amber)', marginBottom: '8px' } }, `${S.orphans.length} open position${S.orphans.length > 1 ? 's' : ''} no leader holds (opened by hand, held after a leader's liquidation, or from a leader no longer followed): the agent leaves ${S.orphans.length > 1 ? 'them' : 'it'} alone`) : null,
          Math.abs(S.clockOffset || 0) > 5000 ? h('div.small.dim', { style: { marginBottom: '8px' } }, `This machine's clock is ${(S.clockOffset / 1000).toFixed(1)} s off the exchange's; the agent corrects for it when signing.`) : null,
          Date.now() - (S.ownAt || 0) > 120000 ? h('div.small', { style: { color: 'var(--amber)', marginBottom: '8px' } }, 'The agent has not managed to read the copy account for over two minutes: no new positions until it can.') : null,
          S.flowsErr ? h('div.small', { style: { color: 'var(--amber)', marginBottom: '8px' } }, 'The agent cannot read deposits and withdrawals right now: the loss stops wait until it can.') : null,
          h('div.stats',
            UI.stat(h('span', { title: 'Meridian\'s Trade Equity: the balance (every margin pool), plus the open positions\' uPnL at the mark, less the funding and position fees charged on them and not yet settled into the balance. Today, From peak and the leverage cap count on it.' }, 'Equity'), usd0(S.equity || 0),
              `${usd0(S.balance || 0)} balance · ${U.fmtUsd(upnl, { sign: true, dp: 0 })} uPnL` + (!netEq ? ' · before unsettled funding and position fees, which Meridian takes out (an older agent: download copy-agent.mjs again)' : S.unsettled ? ` · ${U.fmtUsd(-S.unsettled, { sign: true, dp: 0 })} funding & position fees not yet settled` : '')),
            UI.stat('Today', U.fmtUsd(S.dayPnl || 0, { sign: true, dp: 0 }), 'since 00:00 UTC, or since the agent\'s first reading today if that was later · deposits and withdrawals taken out' + (netEq ? ' · funding and position fees count when charged' : '') + (S.risk && S.risk.dailyLossStop ? ` · stop at −${usd0(S.risk.dailyLossStop)}` : ''), U.pnlClass(S.dayPnl || 0)),
            UI.stat('From peak', S.ddPct != null ? U.fmtPct(-S.ddPct, { dp: 1 }) : '—', (S.peakSince ? 'since ' + U.fmtDateTime(S.peakSince) : 'since the agent started') + ' · deposits and withdrawals taken out' + (S.risk && S.risk.drawdownStopPct ? ` · stop at −${S.risk.drawdownStopPct}%` : ''), S.ddPct > 0 ? 'neg' : ''),
            // Meridian's account leverage divides by the balance; the agent's cap divides by equity (stricter while losing)
            UI.stat(h('span', { title: 'As Meridian\'s Trade Account Leverage: the open positions at the mark ÷ the balance (every margin pool), not ÷ equity. The agent\'s max leverage counts on equity instead, so its figure is the higher of the two whenever the positions\' uPnL, less the funding and position fees charged on them and not yet settled, is negative.' }, 'Leverage'), lev.balance != null ? U.fmtNum(lev.balance, 2) + '×' : '—',
              `${usd0(S.notional || 0)} in positions ÷ balance, as Meridian shows it · ${lev.equity != null ? U.fmtNum(lev.equity, 2) + '×' : '—'} on equity` + (S.risk && S.risk.maxLeverage ? `, the agent's max ${S.risk.maxLeverage}×` : '')),
            UI.stat('Signer expires', S.signerExpiresAt ? U.fmtDate(U.num(S.signerExpiresAt)) : (S.dry ? 'dry run' : '—'), 'the agent cannot extend its signer (the exchange currently sets 90 days from linking): before then make a new key (node copy-agent.mjs keygen --force), link it in step 2 and restart the agent')),
          h('div.grid.cols-2', { style: { marginTop: '12px' } },
            UI.card('My positions', UI.table({ cols: [
              { key: 'm', label: 'Market', render: (r) => UI.marketCell(r.ticker) },
              { key: 's', label: 'Side', render: (r) => U.sideEl(r.o.size > 0, true) },
              { key: 'q', label: 'Size', num: true, render: (r) => h('span', U.fmtQty(Math.abs(r.o.size)), h('span.dim.xs', ' · ' + usd0(r.o.notional)), (S.carry || {})[r.pid] > 0 ? h('span.xs', { style: { color: 'var(--amber)' }, title: 'A reduction the exchange would not take yet (below its minimum, or unfilled); it is added to the next reduction of this market' }, ' · −' + U.fmtQty(S.carry[r.pid]) + ' owed') : null) },
              { key: 'e', label: 'Entry', num: true, render: (r) => U.fmtPrice(r.o.entry) },
              // gross, as Meridian's positions table shows it; what is charged and not yet settled is what Equity takes out
              { key: 'u', label: 'uPnL', num: true, title: 'At the mark, before funding and position fees, as Meridian\'s positions table shows it. Beside it: the funding and position fees charged on the position and not yet settled into the balance, which Equity takes out', render: (r) => { const due = U.num(r.o.funding) + U.num(r.o.posFee); return h('span', U.pnlEl(r.o.upnl, { dp: 2 }), Math.abs(due) >= 0.005 ? h('span.dim.xs', { title: `funding ${U.fmtUsd(-U.num(r.o.funding), { sign: true, dp: 2 })} · position fee ${U.fmtUsd(-U.num(r.o.posFee), { sign: true, dp: 2 })}, charged and not yet settled` }, ' · ' + U.fmtUsd(-due, { sign: true, dp: 2 }) + ' unsettled') : null); } },
              { key: 'l', label: 'Following', render: (r) => (r.leader ? who(r.leader) : h('span.dim', 'not from a leader')) },
            ], rows: posRows, empty: 'No open position' })),
            UI.card('Leaders\' positions', UI.table({ cols: [
              { key: 'l', label: 'Leader', render: (r) => who(r.l) },
              { key: 'm', label: 'Market', render: (r) => UI.marketCell(r.ticker) },
              { key: 's', label: 'Side', render: (r) => U.sideEl(r.q > 0, true) },
              { key: 'q', label: 'Their size', num: true, render: (r) => U.fmtQty(Math.abs(r.q)) },
              { key: 'mine', label: 'Mine', num: true, render: (r) => (r.mine && r.owner ? U.fmtQty(Math.abs(r.mine.size)) : h('span.dim', !r.mine ? 'not mirrored' : (S.leaders || []).some((x) => x.sid === (S.marketOwner || {})[r.pid]) ? 'held from another leader' : 'held, not from a leader')) },
            ], rows: lpRows, empty: 'The leaders hold nothing right now' }))),
          S.missed && S.missed.length ? UI.card('Not copied', UI.table({ cols: [
            { key: 't', label: 'Time', render: (r) => h('span.dim', U.fmtFeedTime ? U.fmtFeedTime(r.at) : U.fmtAgo(r.at)) },
            { key: 'l', label: 'Leader', render: (r) => r.leader },
            { key: 'm', label: 'Market', render: (r) => UI.marketCell(r.ticker) },
            { key: 'k', label: 'Leader\'s order', render: (r) => h('span', U.sideEl(r.q > 0, true), h('span.dim.small', ` ${r.kind} ${U.fmtQty(Math.abs(r.q))}`)) },
            { key: 'w', label: 'Why', render: (r) => h('span.dim.small', r.why) },
          ], rows: S.missed.slice(0, 20) }), h('span.dim.small', 'leader openings and adds that came too late, at a price too far from the mark, or only showed on a re-read after a gap in the socket: never chased')) : null,
          UI.card('Orders', UI.table({ cols: [
            { key: 't', label: 'Time', render: (r) => h('span.dim', U.fmtFeedTime ? U.fmtFeedTime(r.t) : U.fmtAgo(r.t)) },
            { key: 'l', label: 'Leader', render: (r) => r.leader || h('span.dim', '—') },
            { key: 'm', label: 'Market', render: (r) => UI.marketCell(r.ticker) },
            { key: 's', label: 'Side', render: (r) => U.sideEl(r.side === 'BUY') },
            { key: 'q', label: 'Size', num: true, render: (r) => (r.close ? 'close' : U.fmtQty(r.qty)) },
            { key: 'ty', label: 'Type', render: (r) => h('span.dim.small', r.type + (r.px ? ' @ ' + U.fmtPrice(r.px) : '') + (r.reduceOnly ? ' · reduce-only' : '')) },
            { key: 'st', label: 'Status', title: 'filled / partial / unfilled are read back from the exchange after the order, not assumed', render: (r) => h('span', UI.chip(r.status, r.status === 'filled' || r.status === 'dry' ? 'green' : r.status === 'rejected' || r.status === 'unfilled' ? 'red' : 'amber'), r.filled != null && r.status !== 'dry' ? h('span.dim.xs', ' ' + U.fmtQty(r.filled) + ' of ' + (r.close ? U.fmtQty(Math.abs(r.before || 0)) : U.fmtQty(r.qty))) : null, r.reason ? h('span.neg.xs', ' ' + r.reason) : null, r.error ? h('span.neg.xs', ' ' + r.error) : null) },
            { key: 'w', label: 'Why', render: (r) => h('span.dim.small', r.why) },
          ], rows: (S.orders || []).slice(0, 30), empty: 'No order yet' }), h('span.dim.small', ((S.orders || []).length > 30 ? `latest 30 of ${S.orders.length}` : 'newest first') + ' · every order is in the agent\'s daily log files')),
          UI.card('Events', UI.table({ cols: [
            { key: 't', label: 'Time', render: (r) => h('span.dim', U.fmtFeedTime ? U.fmtFeedTime(r.t) : U.fmtAgo(r.t)) },
            { key: 'k', label: '', render: (r) => UI.chip(r.kind, r.kind === 'error' || r.kind === 'trip' ? 'red' : r.kind === 'skip' || r.kind === 'warn' ? 'amber' : r.kind === 'order' ? 'green' : '') },
            { key: 'm', label: 'What', render: (r) => h('span.small', r.msg) },
          ], rows: (S.events || []).slice(0, 30), empty: 'Nothing yet' })));
      };
      const step4 = UI.card('4 · Run and watch', h('div', { style: { padding: '12px 16px' } }, code('node copy-agent.mjs run --dry    # first: every order goes to the margin check, nothing is placed\nnode copy-agent.mjs run          # then live: real orders'), h('p.small.dim', { style: { margin: '8px 0 0' } }, 'Through npm: npm run dry, or npm start -- --dry (the "--" hands the flag to the agent; without it npm keeps the flag for itself). The agent stops at any argument it does not know, so node copy-agent.mjs run --dyr (or npm start -- --dyr) exits without starting. A misspelt flag typed before the "--" (npm start --dyr) stays with npm and the agent starts live, so npm run dry is the safest way to start a dry run. Either way, its first line says DRY RUN or LIVE. Keep it running (a terminal, a scheduled task, a service). It writes its logs to a logs folder next to the script and answers this dashboard on the port above. Stopping it leaves positions open; "Close all" here flattens the copy account.')));
      const dashCard = h('div.card', h('div.row', { style: { marginBottom: '8px' } }, h('h2', 'Dashboard'), UI.chip('local', 'blue'), h('span.grow'), h('span.dim.small', 'polls the agent every 3 s')), dash);
      const histCard = h('div.card', h('div.row', { style: { marginBottom: '8px' } }, h('h2', 'Copy history'), UI.chip('attribution', 'accent'), h('span.grow'), h('span.dim.small', 'per leader · your slippage against their fills')), histWrap);
      U.replace(body, hero, step1, step2, step3, step4, dashCard, histCard,
        h('div.footer-note', 'The agent is software you run; MeridianDataHub places no orders and holds no keys. Losses follow the leaders you pick and the limits you set. Past performance is not a promise of future returns.'));
      try { MD._agentRef = await A.ref(ctx); } catch (_) {}
      listSigners();
      await poll(); timer = setInterval(poll, 3000); ctx.onCleanup(() => clearInterval(timer));
    },
  };
})();
