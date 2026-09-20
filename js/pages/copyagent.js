/* MeridianDataHub — Copy agent page (#/copytrade/agent): set up the local copy agent (key, wallet-signed linked signer,
   config), then watch and control it through its local status port. The site never holds a key: the signer key stays
   on the user's machine, the owner wallet signs the link in the browser. */
(function () {
  const MD = window.MD; const U = MD.util; const A = MD.api; const AN = MD.analytics; const UI = MD.ui; const AL = MD.alerts; const h = U.h;
  const isAbort = (e) => e && e.name === 'AbortError';
  const KEY = 'md.agent.v1';   // page state kept in this browser: config draft, status port, token
  const DEF = () => ({ port: 8790, token: '', cfg: { owner: '', subaccountId: '', leaders: [], sizing: { mode: 'fixed', size: 200, ratio: 10 }, execution: { type: 'IOC', slippageBps: 15, groupMs: 1200, onLeaderFlat: 'close', onLeaderLiquidation: 'close' }, risk: { maxNotionalPerMarket: 1000, maxOpenPositions: 5, maxLeverage: 3, dailyLossStop: 100, drawdownStopPct: 15, minOrderUsd: 10, markets: { deny: [] }, onTrip: 'reduceOnly' }, ntfy: { server: 'https://ntfy.sh', topic: '' } } });
  const load = () => { const s = U.storage.get(KEY, null); const d = DEF(); if (!s) return d; return Object.assign(d, s, { cfg: Object.assign(d.cfg, s.cfg || {}, { sizing: Object.assign(d.cfg.sizing, (s.cfg || {}).sizing || {}), execution: Object.assign(d.cfg.execution, (s.cfg || {}).execution || {}), risk: Object.assign(d.cfg.risk, (s.cfg || {}).risk || {}), ntfy: Object.assign(d.cfg.ntfy, (s.cfg || {}).ntfy || {}) }) }); };
  const usd0 = (v) => U.fmtUsd(v, { dp: 0 });
  const code = (text) => h('pre.code', h('code', text));
  const files = ['copy-agent.mjs', 'package.json', 'config.example.json'];

  MD.copyagentPage = {
    async mount(root, route, ctx) {
      MD.setTopbar(h('span.title', 'Copy trading · Copy agent'));
      const st = load(); const save = () => U.storage.set(KEY, st);
      const body = h('div.stack');
      U.replace(root, h('div.page', h('div.stack', h('div.row.wrap', { style: { gap: '8px' } }, h('a.btn.sm.ghost', { href: '#/copytrade' }, '← Leaders'), h('span.dim.small', 'the copy agent runs on your own machine; this page sets it up and watches it')), body)));

      // ---- hero
      const hero = h('div.card.ct-hero',
        h('div.row', { style: { marginBottom: '8px' } }, UI.chip('Phase 4 · copy agent', 'accent'), h('span.dim.small', 'non-custodial · linked signer · your machine')),
        h('h1', 'Copy leaders into your own account'),
        h('p', 'A small program on your computer follows the leaders you choose and mirrors their positions into your Meridian subaccount, sized and limited the way you set here. It trades with a Meridian linked signer: a key made on your machine that can submit and cancel orders and can never withdraw. Your wallet signs the link once, on this page; the site holds nothing.'),
        h('p', 'Before running it with money, replay the leaders in the simulator and paper-copy them for a while. Copying is not a promise of the leader\'s result: see "Edge left" on every leader.'));

      // ---- step 1: install
      const step1 = UI.card('1 · Install and make a key', h('div', { style: { padding: '12px 16px' } },
        h('p.small.muted', { style: { margin: '0 0 8px' } }, 'Needs Node.js 22 or newer. Put these files in a folder of their own:'),
        h('div.row.wrap', { style: { gap: '6px', marginBottom: '8px' } }, files.map((f) => h('a.btn.sm', { href: 'agent/' + f, download: f }, f))),
        code('npm install\nnode copy-agent.mjs keygen'),
        h('p.small.dim', { style: { margin: '8px 0 0' } }, 'keygen writes signer.key next to the script and prints the signer address. The key can only ever place and cancel orders once linked; keep the file private anyway.')));

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
            { key: 'x', label: '', render: (r) => (r.status === 'ACTIVE' || r.status === 'PENDING' ? h('button.btn.sm.ghost', { onclick: async () => { if (!confirm('Revoke this signer? The agent can no longer trade with it (permanent for that address).')) return; try { const { rpc } = await rpcTypes(); const msg = { sender: st.cfg.owner, signer: r.signer || r.address, subaccount: r.subaccount, nonce: String(Date.now()) + '000000', signedAt: Math.floor(Date.now() / 1000) }; const signature = await walletSign('RevokeLinkedSigner', Object.assign({}, msg, { nonce: msg.nonce }), st.cfg.owner); await fetch(A.BASE + '/v1/linked-signer/revoke', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: Object.assign({}, msg, { subaccountId: sid }), signature }) }).then(async (x) => { if (!x.ok) throw new Error((await x.json()).message || x.status); }); U.toast('Revoked'); listSigners(); } catch (e) { U.toast('Revoke failed: ' + (e.message || e)); } } }, 'Revoke') : null) },
          ], rows }) : h('div.small.dim', 'none yet'));
        } catch (e) { if (!isAbort(e)) U.replace(signersOut, h('div.small.neg', 'Could not list signers: ' + e.message)); }
      };
      const linkBtn = h('button.btn.primary.sm', { onclick: async () => {
        let req; try { req = JSON.parse(linkIn.value.trim()); } catch (_) { U.replace(linkOut, h('span.neg', 'That is not the JSON the agent printed.')); return; }
        if (!req.data || !req.signerSignature) { U.replace(linkOut, h('span.neg', 'The request needs "data" and "signerSignature".')); return; }
        if (Date.now() / 1000 - U.num(req.data.signedAt) > 3300) { U.replace(linkOut, h('span.neg', 'This request is older than an hour: run "node copy-agent.mjs link" again.')); return; }
        try {
          U.replace(linkOut, h('span.dim', 'Asking the wallet to sign…'));
          const d = req.data;
          const signature = await walletSign('LinkSigner', { sender: d.sender, signer: d.signer, subaccount: d.subaccount, nonce: d.nonce, signedAt: d.signedAt }, d.sender);
          const r = await fetch(A.BASE + '/v1/linked-signer/link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: d, signature, signerSignature: req.signerSignature }) });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(Array.isArray(j.message) ? j.message.join('; ') : j.message || ('HTTP ' + r.status));
          U.replace(linkOut, h('span.pos', `Linked: ${U.shortAddr(d.signer, 6)} may now trade on ${U.decodeBytes32(d.subaccount)} (status ${j.status || 'pending'}; the exchange confirms it on chain within a minute).`));
          if (!st.cfg.owner) st.cfg.owner = d.sender; if (!st.cfg.subaccountId) st.cfg.subaccountId = d.subaccountId; save(); listSigners();
        } catch (e) { U.replace(linkOut, h('span.neg', 'Link failed: ' + (e.message || e))); }
      } }, 'Sign with wallet and link');
      const step2 = UI.card('2 · Link the signer with your wallet', h('div', { style: { padding: '12px 16px' } },
        h('p.small.muted', { style: { margin: '0 0 8px' } }, 'Fill config.json first (step 3 writes it), then run ', h('code', 'node copy-agent.mjs link'), '. It prints a request the signer has already signed; paste it here and your wallet co-signs it. The exchange then lists the key as a linked signer of your subaccount: orders only, no withdrawals, revocable here at any time.'),
        linkIn, h('div.row', { style: { marginTop: '8px', gap: '8px' } }, linkBtn, h('span.dim.small', 'EIP-712 · signed in your wallet, sent straight to api.meridian.xyz')), linkOut, signersOut));

      // ---- step 3: the config
      const c = st.cfg;
      const inp = (obj, key, attrs) => h('input.input.sm', Object.assign({ value: obj[key] == null ? '' : obj[key], oninput: (e) => { obj[key] = attrs && attrs.type === 'number' ? U.num(e.target.value) : e.target.value.trim(); save(); renderJson(); } }, attrs || {}));
      const sel = (obj, key, opts) => h('select.input.sm', { onchange: (e) => { obj[key] = e.target.value; save(); renderJson(); } }, opts.map(([v, label]) => h('option', { value: v, selected: obj[key] === v }, label)));
      const fld = (label, el, hint) => h('div', { style: { marginBottom: '8px' } }, h('div.field-lbl', label), el, hint ? h('div.dim.xs', { style: { marginTop: '2px' } }, hint) : null);
      const leadersWrap = h('div');
      const renderLeaders = () => U.replace(leadersWrap, h('div.row.wrap', { style: { gap: '6px' } }, c.leaders.map((l) => h('span.chip', { style: { display: 'inline-flex', gap: '6px', alignItems: 'center' } }, h('a', { href: U.accountUrl(l.address, l.sid) }, l.name && l.name !== 'primary' ? l.name : U.shortAddr(l.address, 4)), h('button', { style: { background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'inherit', display: 'inline-flex' }, onclick: () => { c.leaders = c.leaders.filter((x) => x.sid !== l.sid); save(); renderLeaders(); renderJson(); } }, U.icon('x')))),
        AL.state().leaders.filter((l) => !c.leaders.some((x) => x.sid === l.sid)).map((l) => h('button.btn.sm.ghost', { onclick: () => { c.leaders.push({ sid: l.sid, address: l.address, name: l.name || '' }); save(); renderLeaders(); renderJson(); } }, '+ ' + (l.name && l.name !== 'primary' ? l.name : U.shortAddr(l.address, 4))))),
        c.leaders.length ? null : h('div.dim.small', { style: { marginTop: '4px' } }, 'No leader yet: follow some with the bell on the Leaders page, they appear here to add.'));
      renderLeaders();
      const addrIn = h('input.input.sm', { placeholder: 'or a wallet address (0x…) to add', style: { width: '320px' }, spellcheck: false });
      const addBtn = h('button.btn.sm', { onclick: async () => { const v = addrIn.value.trim().toLowerCase(); if (!U.isAddress(v)) { U.toast('Enter a 0x address'); return; } try { const subs = await A.subaccountsOf(v); if (!subs.length) { U.toast('No Meridian subaccount for that address'); return; } for (const s of subs) if (!c.leaders.some((x) => x.sid === s.id)) c.leaders.push({ sid: s.id, address: v, name: U.decodeBytes32(s.name) }); addrIn.value = ''; save(); renderLeaders(); renderJson(); } catch (e) { U.toast(e.message); } } }, 'Add');
      const jsonOut = h('pre.code', { style: { maxHeight: '260px', overflow: 'auto' } });
      const buildCfg = () => ({ owner: c.owner, subaccountId: c.subaccountId, keyFile: 'signer.key', leaders: c.leaders, sizing: { mode: c.sizing.mode, size: U.num(c.sizing.size), ratio: U.num(c.sizing.ratio) }, execution: { type: c.execution.type, slippageBps: U.num(c.execution.slippageBps), groupMs: U.num(c.execution.groupMs) || 1200, onLeaderFlat: c.execution.onLeaderFlat, onLeaderLiquidation: c.execution.onLeaderLiquidation }, risk: { maxNotionalPerMarket: U.num(c.risk.maxNotionalPerMarket), maxOpenPositions: U.num(c.risk.maxOpenPositions), maxLeverage: U.num(c.risk.maxLeverage), dailyLossStop: U.num(c.risk.dailyLossStop), drawdownStopPct: U.num(c.risk.drawdownStopPct), minOrderUsd: U.num(c.risk.minOrderUsd), markets: { deny: (c.risk.markets.deny || []).filter(Boolean) }, onTrip: c.risk.onTrip }, status: { port: U.num(st.port) || 8790, token: st.token || '' }, ntfy: { server: c.ntfy.server || 'https://ntfy.sh', topic: c.ntfy.topic || '' } });
      const renderJson = () => { jsonOut.textContent = JSON.stringify(buildCfg(), null, 2); };
      const denyIn = h('input.input.sm', { value: (c.risk.markets.deny || []).join(', '), placeholder: 'e.g. HYPE-USD, XAG-USD', style: { width: '260px' }, oninput: (e) => { c.risk.markets.deny = e.target.value.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean); save(); renderJson(); } });
      const tokenIn = h('input.input.sm', { value: st.token, placeholder: 'any secret word', style: { width: '200px' }, oninput: (e) => { st.token = e.target.value.trim(); save(); renderJson(); } });
      const useWallet = h('button.btn.sm', { onclick: async () => { try { if (!window.ethereum) throw new Error('no wallet in this browser'); const [from] = await window.ethereum.request({ method: 'eth_requestAccounts' }); c.owner = from.toLowerCase(); const subs = await A.subaccountsOf(c.owner); if (subs.length) c.subaccountId = subs[0].id; save(); renderJson(); U.toast(subs.length ? 'Owner and subaccount filled from the wallet' : 'Owner filled; no Meridian subaccount found for it'); ownerIn.value = c.owner; subIn.value = c.subaccountId; listSigners(); } catch (e) { U.toast(e.message || String(e)); } } }, 'Use my wallet');
      const ownerIn = inp(c, 'owner', { placeholder: '0x… your wallet', style: { width: '380px' }, spellcheck: false });
      const subIn = inp(c, 'subaccountId', { placeholder: 'subaccount UUID (the account page shows it)', style: { width: '320px' }, spellcheck: false, onchange: () => listSigners() });
      const dl = h('button.btn.primary.sm', { onclick: () => { const cfg = buildCfg(); const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = h('a', { href: url, download: 'config.json' }); document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000); U.toast('config.json downloaded: put it next to copy-agent.mjs'); } }, 'Download config.json');
      const step3 = UI.card('3 · Configure', h('div', { style: { padding: '12px 16px' } },
        h('div.grid.cols-2',
          h('div',
            fld('Your account', h('div.row.wrap', { style: { gap: '6px' } }, ownerIn, subIn, useWallet)),
            fld('Leaders to copy', h('div', leadersWrap, h('div.row', { style: { gap: '6px', marginTop: '6px' } }, addrIn, addBtn))),
            fld('Sizing', h('div.row.wrap', { style: { gap: '6px' } }, sel(c.sizing, 'mode', [['fixed', 'Fixed $ per position (the leader\'s opening order)'], ['perfill', 'Fixed $ per fill'], ['ratio', '% of the leader\'s quantity']]), inp(c.sizing, 'size', { type: 'number', min: 10, step: 10, style: { width: '110px' } }), h('span.dim.small', 'USD ·'), inp(c.sizing, 'ratio', { type: 'number', min: 0.1, step: 1, style: { width: '80px' } }), h('span.dim.small', '% (ratio mode)')), 'the same three modes as the simulator; a fixed size is set from the leader\'s whole opening order, not its first fill'),
            fld('Execution', h('div.row.wrap', { style: { gap: '6px' } }, sel(c.execution, 'type', [['IOC', 'Limit IOC at mark ± slippage cap'], ['MARKET', 'Market order']]), inp(c.execution, 'slippageBps', { type: 'number', min: 1, step: 1, style: { width: '80px' } }), h('span.dim.small', 'bps cap'), sel(c.execution, 'onLeaderFlat', [['close', 'Leader flat without a fill → close'], ['hold', 'Leader flat without a fill → hold']]), sel(c.execution, 'onLeaderLiquidation', [['close', 'Leader liquidated → close'], ['hold', 'Leader liquidated → hold']])), 'an IOC order fills up to the cap and cancels the rest; what did not fill is logged and not chased')),
          h('div',
            fld('Risk limits', h('div.row.wrap', { style: { gap: '6px 12px' } },
              h('span.row', { style: { gap: '4px' } }, inp(c.risk, 'maxNotionalPerMarket', { type: 'number', min: 0, step: 100, style: { width: '100px' } }), h('span.dim.small', 'USD max per market')),
              h('span.row', { style: { gap: '4px' } }, inp(c.risk, 'maxOpenPositions', { type: 'number', min: 1, step: 1, style: { width: '70px' } }), h('span.dim.small', 'open positions max')),
              h('span.row', { style: { gap: '4px' } }, inp(c.risk, 'maxLeverage', { type: 'number', min: 1, step: 0.5, style: { width: '70px' } }), h('span.dim.small', '× max leverage on equity')),
              h('span.row', { style: { gap: '4px' } }, inp(c.risk, 'dailyLossStop', { type: 'number', min: 0, step: 10, style: { width: '90px' } }), h('span.dim.small', 'USD daily loss stop')),
              h('span.row', { style: { gap: '4px' } }, inp(c.risk, 'drawdownStopPct', { type: 'number', min: 0, step: 1, style: { width: '70px' } }), h('span.dim.small', '% drawdown stop')),
              h('span.row', { style: { gap: '4px' } }, inp(c.risk, 'minOrderUsd', { type: 'number', min: 0, step: 5, style: { width: '70px' } }), h('span.dim.small', 'USD min order')),
              h('span.row', { style: { gap: '4px' } }, sel(c.risk, 'onTrip', [['reduceOnly', 'On a stop: reduce-only'], ['closeAll', 'On a stop: close everything']]))), 'a tripped stop blocks new and larger positions until you resume from the dashboard; reductions and closes still follow the leader'),
            fld('Markets not to copy', denyIn),
            fld('Dashboard', h('div.row.wrap', { style: { gap: '6px' } }, h('span.dim.small', 'port'), inp(st, 'port', { type: 'number', min: 1024, step: 1, style: { width: '80px' } }), h('span.dim.small', 'token'), tokenIn), 'the agent answers this page on 127.0.0.1 only; the token guards pause / resume / close all'),
            fld('Phone push (ntfy)', h('div.row.wrap', { style: { gap: '6px' } }, inp(c.ntfy, 'topic', { placeholder: 'topic', style: { width: '200px' } }), inp(c.ntfy, 'server', { placeholder: 'https://ntfy.sh', style: { width: '160px' } })), 'rejected orders, risk stops and leader liquidations'))),
        h('div.row', { style: { gap: '8px', margin: '8px 0' } }, dl, h('span.dim.small', 'or copy the JSON into config.json next to the script')),
        jsonOut));
      renderJson();

      // ---- step 4 + dashboard
      const dash = h('div');
      let timer = null, last = null, lastErr = null;
      const post = async (p) => { try { const r = await fetch(`http://127.0.0.1:${U.num(st.port) || 8790}/${p}`, { method: 'POST', headers: { 'x-agent-token': st.token || '' } }); if (!r.ok) throw new Error(r.status === 401 ? 'wrong token' : 'HTTP ' + r.status); U.toast(p + ' sent'); poll(); } catch (e) { U.toast(`${p} failed: ${e.message}`); } };
      const poll = async () => {
        try { const r = await fetch(`http://127.0.0.1:${U.num(st.port) || 8790}/status`, { signal: ctx.signal }); last = await r.json(); lastErr = null; }
        catch (e) { if (isAbort(e)) return; last = null; lastErr = e.message; }
        renderDash();
      };
      const renderDash = () => {
        if (!last) {
          U.replace(dash, h('div.empty', h('div', { style: { marginBottom: '8px' } }, 'No agent answering on 127.0.0.1:' + (U.num(st.port) || 8790) + (lastErr ? ' (' + lastErr + ')' : '')), code('node copy-agent.mjs run'), h('div.dim.small', { style: { marginTop: '8px' } }, 'The dashboard connects to the agent on your own machine; nothing about it leaves your browser.')));
          return;
        }
        const S = last; const ref = MD._agentRef;
        const posRows = Object.entries(S.own || {}).map(([pid, o]) => ({ pid, ticker: ref && ref.byId[pid] ? ref.byId[pid].displayTicker : pid, o, leader: (S.leaders || []).find((l) => l.sid === (S.marketOwner || {})[pid]) }));
        const lpRows = [];
        for (const l of S.leaders || []) for (const [pid, q] of Object.entries((S.leaderPos || {})[l.sid] || {})) if (q) lpRows.push({ l, pid, ticker: ref && ref.byId[pid] ? ref.byId[pid].displayTicker : pid, q, mine: (S.own || {})[pid], owner: (S.marketOwner || {})[pid] === l.sid });
        const who = (l) => (l ? (l.name && l.name !== 'primary' ? l.name : U.shortAddr(l.address, 4)) : '—');
        U.replace(dash,
          h('div.row.wrap', { style: { gap: '8px', marginBottom: '10px' } },
            UI.chip(S.paused ? 'paused' : S.tripped ? 'risk stop' : 'running', S.paused ? 'amber' : S.tripped ? 'red' : 'green'), S.dry ? UI.chip('DRY RUN · nothing is placed', 'amber') : null, UI.chip('socket ' + S.ws, S.ws === 'open' ? 'green' : 'amber'),
            h('span.dim.small', `up ${U.fmtDuration(S.uptime)} · signer ${U.shortAddr(S.signer, 4)} · ${(S.leaders || []).length} leader(s) · ${S.orders ? S.orders.length : 0} orders · ${S.errors || 0} errors`), h('span.grow'),
            S.paused || S.tripped ? h('button.btn.sm.primary', { onclick: () => post('resume') }, 'Resume') : h('button.btn.sm', { onclick: () => post('pause') }, 'Pause'),
            h('button.btn.sm.ghost', { onclick: () => { if (confirm('Close every open position of the copy account at market?')) post('close-all'); } }, 'Close all')),
          S.tripped ? h('div.small', { style: { color: 'var(--red)', marginBottom: '8px' } }, 'Risk stop: ' + S.tripped.why + ' · resume to lift it') : null,
          h('div.stats',
            UI.stat('Equity', usd0(S.equity || 0), `${usd0(S.balance || 0)} balance · ${usd0(S.notional || 0)} in positions`),
            UI.stat('Today', U.fmtUsd((S.equity || 0) - (S.equityDayStart || 0), { sign: true, dp: 0 }), 'equity change since 00:00 UTC (deposits count)', U.pnlClass((S.equity || 0) - (S.equityDayStart || 0))),
            UI.stat('From peak', S.equityPeak ? U.fmtPct(-((S.equityPeak - S.equity) / S.equityPeak) * 100, { dp: 1 }) : '—', 'since the agent started', 'neg'),
            UI.stat('Leverage', S.equity > 0 ? U.fmtNum((S.notional || 0) / S.equity, 2) + '×' : '—', 'positions ÷ equity'),
            UI.stat('Signer expires', S.signerExpiresAt ? U.fmtDate(U.num(S.signerExpiresAt) < 1e12 ? U.num(S.signerExpiresAt) * 1000 : U.num(S.signerExpiresAt)) : '—', 'extend it from the agent before then')),
          h('div.grid.cols-2', { style: { marginTop: '12px' } },
            UI.card('My positions', UI.table({ cols: [
              { key: 'm', label: 'Market', render: (r) => UI.marketCell(r.ticker) },
              { key: 's', label: 'Side', render: (r) => U.sideEl(r.o.size > 0, true) },
              { key: 'q', label: 'Size', num: true, render: (r) => h('span', U.fmtQty(Math.abs(r.o.size)), h('span.dim.xs', ' · ' + usd0(r.o.notional))) },
              { key: 'e', label: 'Entry', num: true, render: (r) => U.fmtPrice(r.o.entry) },
              { key: 'u', label: 'uPnL', num: true, render: (r) => U.pnlEl(r.o.upnl, { dp: 2 }) },
              { key: 'l', label: 'Following', render: (r) => (r.leader ? who(r.leader) : h('span.dim', 'not from a leader')) },
            ], rows: posRows, empty: 'No open position' })),
            UI.card('Leaders\' positions', UI.table({ cols: [
              { key: 'l', label: 'Leader', render: (r) => who(r.l) },
              { key: 'm', label: 'Market', render: (r) => UI.marketCell(r.ticker) },
              { key: 's', label: 'Side', render: (r) => U.sideEl(r.q > 0, true) },
              { key: 'q', label: 'Their size', num: true, render: (r) => U.fmtQty(Math.abs(r.q)) },
              { key: 'mine', label: 'Mine', num: true, render: (r) => (r.mine && r.owner ? U.fmtQty(Math.abs(r.mine.size)) : h('span.dim', r.mine ? 'held from another leader' : 'not mirrored')) },
            ], rows: lpRows, empty: 'The leaders hold nothing right now' }))),
          UI.card('Orders', UI.table({ cols: [
            { key: 't', label: 'Time', render: (r) => h('span.dim', U.fmtFeedTime ? U.fmtFeedTime(r.t) : U.fmtAgo(r.t)) },
            { key: 'l', label: 'Leader', render: (r) => r.leader || h('span.dim', '—') },
            { key: 'm', label: 'Market', render: (r) => UI.marketCell(r.ticker) },
            { key: 's', label: 'Side', render: (r) => U.sideEl(r.side === 'BUY') },
            { key: 'q', label: 'Size', num: true, render: (r) => (r.close ? 'close' : U.fmtQty(r.qty)) },
            { key: 'ty', label: 'Type', render: (r) => h('span.dim.small', r.type + (r.px ? ' @ ' + U.fmtPrice(r.px) : '') + (r.reduceOnly ? ' · reduce-only' : '')) },
            { key: 'st', label: 'Status', render: (r) => h('span', UI.chip(r.status, r.status === 'accepted' ? 'green' : r.status === 'rejected' ? 'red' : 'amber'), r.filled != null ? h('span.dim.xs', ' filled ' + U.fmtQty(r.filled)) : null, r.error ? h('span.neg.xs', ' ' + r.error) : null) },
            { key: 'w', label: 'Why', render: (r) => h('span.dim.small', r.why) },
          ], rows: (S.orders || []).slice(0, 30), empty: 'No order yet' }), h('span.dim.small', 'newest first · from the agent\'s log')),
          UI.card('Events', UI.table({ cols: [
            { key: 't', label: 'Time', render: (r) => h('span.dim', U.fmtFeedTime ? U.fmtFeedTime(r.t) : U.fmtAgo(r.t)) },
            { key: 'k', label: '', render: (r) => UI.chip(r.kind, r.kind === 'error' || r.kind === 'trip' ? 'red' : r.kind === 'skip' || r.kind === 'warn' ? 'amber' : r.kind === 'order' ? 'green' : '') },
            { key: 'm', label: 'What', render: (r) => h('span.small', r.msg) },
          ], rows: (S.events || []).slice(0, 30), empty: 'Nothing yet' })));
      };
      const step4 = UI.card('4 · Run and watch', h('div', { style: { padding: '12px 16px' } }, code('node copy-agent.mjs run'), h('p.small.dim', { style: { margin: '8px 0 0' } }, 'Keep it running (a terminal, a scheduled task, a service). It logs to agent/logs/ and answers this dashboard on the port above. Stopping it leaves positions open; "Close all" here flattens the copy account.')));
      const dashCard = h('div.card', h('div.row', { style: { marginBottom: '8px' } }, h('h2', 'Dashboard'), UI.chip('local', 'blue'), h('span.grow'), h('span.dim.small', 'polls the agent every 3 s')), dash);
      U.replace(body, hero, step1, step2, step3, step4, dashCard,
        h('div.footer-note', 'The agent is software you run; MeridianDataHub places no orders and holds no keys. Losses follow the leaders you pick and the limits you set. Past performance is not a promise of future returns.'));
      try { MD._agentRef = await A.ref(ctx); } catch (_) {}
      listSigners();
      await poll(); timer = setInterval(poll, 3000); ctx.onCleanup(() => clearInterval(timer));
    },
  };
})();
