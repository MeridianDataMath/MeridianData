/* MeridianDataHub — which wallet holds a trader's predictions.
 * The Meridian app places predictions through a ZeroDev Kernel v3.1 smart account on Robinhood Chain (4663), owned by
 * the wallet the trader signs in with: the same address that owns their perps subaccounts. The account's address is fixed
 * by its owner (KernelFactory.getAddress with the ECDSA validator holding the owner, index 0), and the ECDSA validator
 * records the owner of every account that uses it (checked against the derivation, since an account writes that record
 * itself), so both directions are an eth_call or two on the public RPC (CORS *).
 * Checked 2026-09-25 against every wallet that ever predicted: 712 of 718 are such accounts and all 712 derive from
 * their owner exactly; the other six (the market makers and a few direct wallets) are not smart accounts. Of the 27 perps
 * owners, none had a prediction under the owner address itself and 17 had them under this account.
 * Calls made in the same tick go out as one batch (the RPC answers bursts with 429), and answers are kept in
 * localStorage: the mapping never changes, except that an address with no owner yet may become an account later. */
(function () {
  const MD = window.MD; const U = MD.util; const P = MD.predict;
  const W = (P.wallets = {});
  W.RPC = 'https://rpc.mainnet.chain.robinhood.com';
  W.FACTORY = '0xaac5d4240af87249b3f71bc8e4a2cae074a3e419';   // ZeroDev KernelFactory v3.1
  W.ECDSA = '0x845adb2c711129d4f3966735ed98a9f09fc4ce57';     // ZeroDev ECDSA validator: holds each account's owner
  W.BATCH = 10;
  W.NONE_TTL = 86400000;   // "no owner" is remembered for a day, an owner or a derived address for good
  const SEL = { getAddress: '48aac392', initialize: '3c3b752b', owner: '20709efc' };
  const lc = (a) => String(a || '').toLowerCase();
  const hex = (s) => lc(s).replace(/^0x/, '');
  const word = (s) => hex(s).padStart(64, '0');
  const right = (s) => { const x = hex(s); return x.padEnd(Math.max(64, Math.ceil(x.length / 64) * 64), '0'); };
  const isZero = (a) => /^0x0{40}$/.test(a);

  /** Calldata for KernelFactory.getAddress(data, index 0), data = Kernel.initialize(0x01 ‖ ECDSA validator, no hook,
   *  owner, "", []): what the Meridian app deploys for an owner. */
  W.walletCalldata = (owner) => {
    const init = SEL.initialize
      + right('01' + hex(W.ECDSA))                  // bytes21 root validator: 0x01 = validator, then its address
      + word('0')                                   // hook: none
      + word('a0') + word('e0') + word('100')       // offsets of validatorData, hookData, initConfig
      + word('14') + right(hex(owner))              // validatorData: the owner's 20 bytes
      + word('0')                                   // hookData: empty
      + word('0');                                  // initConfig: empty array
    return '0x' + SEL.getAddress + word('40') + word('0') + word((init.length / 2).toString(16)) + right(init);
  };
  /** Calldata for ECDSAValidator.ecdsaValidatorStorage(account): the account's owner, or zero. */
  W.ownerCalldata = (wallet) => '0x' + SEL.owner + word(hex(wallet));
  /** Last 20 bytes of a 32-byte return value as an address. */
  W.addrOf = (result) => (typeof result === 'string' && result.length >= 42 ? '0x' + hex(result).slice(-40) : null);

  // ---- batched eth_call ----
  let queue = [], timer = null;
  async function rpc(calls) {
    const body = JSON.stringify(calls.map((c, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_call', params: [{ to: c.to, data: c.data }, 'latest'] })));
    for (let attempt = 0; ; attempt++) {
      let j = null, status = 0;
      try { const r = await fetch(W.RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body }); status = r.status; j = await r.json().catch(() => null); }
      catch (e) { status = -1; }
      if (Array.isArray(j)) { const by = new Map(j.map((x) => [x.id, x])); return calls.map((c, i) => by.get(i) || { error: { message: 'no answer' } }); }
      if (attempt < 4) { await U.sleep(1000 * (attempt + 1)); continue; }   // 429 on bursts, the odd network error
      throw new Error('Robinhood Chain RPC ' + (j && j.error && j.error.message ? j.error.message : status > 0 ? 'HTTP ' + status : 'unreachable'));
    }
  }
  async function flush() {
    const q = queue; queue = []; timer = null;
    for (let i = 0; i < q.length; i += W.BATCH) {
      const part = q.slice(i, i + W.BATCH);
      try { const res = await rpc(part); part.forEach((c, k) => (res[k].error || typeof res[k].result !== 'string' ? c.reject(new Error(res[k].error ? res[k].error.message : 'no result')) : c.resolve(res[k].result))); }
      catch (e) { part.forEach((c) => c.reject(e)); }
    }
  }
  const call = (to, data) => new Promise((resolve, reject) => { queue.push({ to, data, resolve, reject }); if (!timer) timer = setTimeout(flush, 0); });

  // ---- cache: memory for requests in flight, localStorage for answers ----
  const STORE = 'md.predict.wallets.v1';
  const pending = new Map();
  const readStore = () => U.storage.get(STORE, null) || {};
  const parseAddr = (res) => { const a = W.addrOf(res); return a && !isZero(a) ? a : null; };
  /** keep(v): whether an answer may be stored (a null that will change is not) */
  function lookup(key, to, data, parse, keep) {
    const hit = readStore()[key];
    if (hit && (hit.v || Date.now() - hit.t < W.NONE_TTL)) return Promise.resolve(hit.v);
    if (pending.has(key)) return pending.get(key);
    const p = call(to, data).then((res) => {
      const v = parse(res); if (!keep || keep(v)) { const s = readStore(); s[key] = { v, t: Date.now() }; U.storage.set(STORE, s); } return v;
    }).finally(() => pending.delete(key));
    pending.set(key, p); return p;
  }
  /** The owner an address was derived from in this browser, if it is one of the derived wallets remembered. */
  const derivedBy = (a) => { const s = readStore(); for (const k in s) if (k.startsWith('w:') && s[k].v === a) return k.slice(2); return null; };
  /** The Predict wallet an owner places its predictions through (its Kernel account's address, deployed or not). */
  W.walletOf = (owner) => lookup('w:' + lc(owner), W.FACTORY, W.walletCalldata(owner), parseAddr);
  /** The owner of a Predict wallet, or null when the address is not one (a plain wallet, a market maker's contract).
   *  The validator's storage is written by each account for itself, so any contract can name any owner there: only an
   *  account at that owner's own derived address counts. An account derived here that nobody has deployed yet has no
   *  entry, but its owner is known all the same. */
  W.ownerOf = async (wallet) => {
    const a = lc(wallet);
    const o = await lookup('o:' + a, W.ECDSA, W.ownerCalldata(a), parseAddr, (v) => v !== null || !derivedBy(a));
    if (!o) return derivedBy(a);
    return (await W.walletOf(o)) === a ? o : null;
  };
  /** Both views of an address: { owner, wallet, isWallet }. For a Predict wallet the owner is the trader and wallet the
   *  address itself; for anything else the address is the owner and wallet its derived account. The two first calls go
   *  out in one batch; a Predict wallet does not need the second one to succeed. */
  W.resolve = async (address) => {
    const a = lc(address);
    const [o, d] = await Promise.allSettled([W.ownerOf(a), W.walletOf(a)]);
    if (o.status === 'rejected') throw o.reason;
    if (o.value) return { owner: o.value, wallet: a, isWallet: true };
    if (d.status === 'rejected') throw d.reason;
    return { owner: a, wallet: d.value, isWallet: false };
  };
  /** Whether an address has any Meridian Predict activity: live, a count of its predictions; either way, its snapshot
   *  file (which also carries secondary-market trades, the only activity of some wallets). */
  W.hasActivity = async (address, { signal } = {}) => {
    const a = lc(address);
    if (await P.live()) { try { if ((await P.predictionsCount({ participant: a }, { signal })) > 0) return true; } catch (e) { if (e && e.name === 'AbortError') throw e; } }
    const f = await P.snapshotFile('bettors/' + a + '.json', { signal }).catch(() => null);
    return !!(f && ((f.predictions && f.predictions.length) || (f.trades && f.trades.length)));
  };
  /** The address whose predictions belong to `address`: its Predict wallet when that has activity, else the address
   *  itself (a Predict wallet, or a wallet that bets directly). { address, owner, wallet, via, active, also }: via is set
   *  when the predictions come from the derived wallet; active says whether there are any (null for a Predict wallet
   *  itself: not checked); also is the address itself when it has activity of its own besides its wallet's (none do
   *  today, but the figures shown would leave it out). Falls back to the address itself, with `error`, if the RPC
   *  cannot be reached. */
  W.predictAddress = async (address, { signal } = {}) => {
    const a = lc(address);
    let r; try { r = await W.resolve(a); } catch (e) { return { address: a, owner: null, wallet: null, via: null, active: null, also: null, error: e }; }
    if (r.isWallet || !r.wallet || r.wallet === a) return { address: a, owner: r.owner, wallet: r.wallet, via: null, active: null, also: null };
    const [inWallet, own] = await Promise.all([W.hasActivity(r.wallet, { signal }), W.hasActivity(a, { signal })]);
    if (inWallet) return { address: r.wallet, owner: a, wallet: r.wallet, via: r.wallet, active: true, also: own ? a : null };
    if (own) return { address: a, owner: a, wallet: r.wallet, via: null, active: true, also: null };
    return { address: r.wallet, owner: a, wallet: r.wallet, via: r.wallet, active: false, also: null };   // nothing either way: the Predict wallet is where it would be
  };
})();
