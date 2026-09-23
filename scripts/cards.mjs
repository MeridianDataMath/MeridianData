/**
 * The card artwork and share pages live in js/cards.js (a classic script, so the site draws the same card in the browser
 * for "Equity curve flex"); this loads it for Node (scripts/build-cards.mjs, tests/cards.test.mjs).
 */
import fs from 'node:fs';
import vm from 'node:vm';

globalThis.window = globalThis.window || globalThis;
vm.runInThisContext(fs.readFileSync(new URL('../js/cards.js', import.meta.url), 'utf8'), { filename: 'js/cards.js' });
const cards = globalThis.MD.cards;   // kept here, so a later loader replacing MD cannot lose it

export const { W, H, SITE, esc } = cards;
/** makeCards({ U, P, site }) → the builders (see js/cards.js). */
export const makeCards = (o) => cards.make(o);
