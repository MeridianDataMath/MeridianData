// Real subaccounts captured once with GET requests (tests/fixtures/tax/*.json, compact tables: products, tokens and
// positions are referred to by their index in the file), expanded back into the API's own row shapes, and what
// MD.tax.load.events would return for a period of them.
import fs from 'node:fs';
import path from 'node:path';
import { root } from './_load.mjs';

const DAY = 86400000, HOUR = 3600000;
const rowsOf = (tab, map) => tab.rows.map((r) => { const o = {}; tab.cols.forEach((c, i) => { o[c] = r[i]; }); return map ? map(o) : o; });

export function perps(name) {
  const fx = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/tax', name), 'utf8'));
  const { products, tokens } = fx;
  const positions = rowsOf(fx.positions, (o) => Object.assign(o, { productId: products[o.productId].id }));
  const fills = rowsOf(fx.fills, (o) => Object.assign(o, { productId: products[o.productId].id, subaccountId: fx.sid }));
  const positionFills = rowsOf(fx.positionFills, (o) => Object.assign(o, { positionId: positions[o.positionId].id }));
  const charges = rowsOf(fx.charges, (o) => Object.assign(o, { positionId: typeof o.positionId === 'number' ? positions[o.positionId].id : o.positionId, productId: products[o.productId] ? products[o.productId].id : null }));
  const balance = rowsOf(fx.balance, (o) => Object.assign(o, { tokenId: tokens[o.tokenId].id }));
  const volume = rowsOf(fx.volume);
  const hour = rowsOf(fx.hour, (o) => Object.assign(o, { tokenId: tokens[o.tokenId].id }));
  const ref = { byId: Object.fromEntries(products.map((p) => [p.id, p])), tokenById: Object.fromEntries(tokens.map((t) => [t.id, t])) };
  const pfOf = (id) => positionFills.filter((f) => f.positionId === id).map(({ positionId, ...f }) => f);
  return { fx, sid: fx.sid, cutoff: fx.cutoff, createdAt: fx.createdAt, products, tokens, positions, fills, positionFills, pfOf, charges, balance, volume, hour, ref };
}

/** load.events' result for [start, end) of a fixture (MD: the loaded site). Position fills for the liquidated and
 *  deleveraged positions (plus `also`), hourly rows for the days the position fees need. */
export function events(MD, d, start, end, o = {}) {
  const U = MD.util, T = MD.tax;
  const to = Math.min(end, d.cutoff);
  const touched = T.load.touched(d.positions, start, end);
  const from = touched.length ? Math.min(...touched.map((p) => U.num(p.createdAt))) : start;
  const fills = d.fills.filter((f) => U.num(f.createdAt) >= from && U.num(f.createdAt) < to);
  const posFills = new Map();
  for (const p of touched) if (p.isLiquidated || p.wasDeleveraged || (o.also || []).includes(p.id)) posFills.set(p.id, d.pfOf(p.id));
  const charges = o.charges !== undefined ? o.charges : d.charges.filter((c) => U.num(c.time) >= from - HOUR && U.num(c.time) < to);
  const resFrom = Math.max(Math.floor(U.num(d.createdAt) / DAY) * DAY, Math.floor(from / DAY) * DAY);
  const asg = T.fills.assign(fills, posFills, d.positions);
  const days = T.funding.feeDays(T.ledger.residuals(d.balance, d.ref, DAY, resFrom), asg.byPos, d.positions, d.ref);
  const pfHours = new Map(days.map((D) => [D, d.hour.filter((r) => U.num(r.time) >= D - HOUR && U.num(r.time) < D + DAY)]));
  return { positions: d.positions, touched, from, to, fills, transfers: [], posFills, charges, pre: d.balance, resFrom, pfHours, truncated: { positions: false, fills: false, transfers: false, charges: charges == null, posFills: [] }, failed: [] };
}

/** The archive ledger of a UTC period of a fixture (no split days in UTC). */
export function ledger(MD, d, P, fx) {
  const U = MD.util;
  const day = Math.floor(P.start / DAY) * DAY - DAY;
  return MD.tax.ledger.build({ balance: d.balance.filter((r) => U.num(r.time) >= day), volume: d.volume.filter((r) => U.num(r.time) >= day), hour: null, ref: d.ref, period: P, fx });
}
