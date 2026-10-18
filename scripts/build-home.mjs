/**
 * Writes data/home.json, the home page's summary (js/home-summary.js), from the snapshots this deploy publishes:
 * data/leaderboard.json, data/predict.json and data/predict-status.json. The home page then reads a few KB instead of
 * both snapshots. A missing or broken input leaves its part out; with nothing to summarise no file is written, and the
 * home page builds the summary from the snapshots in the browser, as it did before.
 *
 *   node scripts/build-home.mjs [--data <dir>]     (default: data/)
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dataDir = args.includes('--data') ? path.resolve(args[args.indexOf('--data') + 1]) : path.join(root, 'data');

// the site's classic-script modules, with the browser shims build-snapshot.mjs uses
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
for (const f of ['js/util.js', 'js/api.js', 'js/analytics.js', 'js/predict/api.js', 'js/predict/analytics.js', 'js/home-summary.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
}
const { MD } = globalThis;

const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8')); } catch (e) { console.warn(`home: ${f} not read (${e.message})`); return null; } };
const lb = read('leaderboard.json'), predict = read('predict.json'), status = read('predict-status.json');
// the left-out wallets go here too (P.dropExcluded), as the Predict pages drop them from any snapshot they load
const out = MD.homeSummary.build({ lb: lb && Array.isArray(lb.rows) ? lb : null, snap: predict && predict.agg ? MD.predict.dropExcluded(predict) : null, status });
if (!out.lb && !out.predict) { console.warn('home: nothing to summarise, no data/home.json written'); process.exit(0); }
const text = JSON.stringify(out);
fs.writeFileSync(path.join(dataDir, 'home.json'), text);
console.log(`wrote ${path.join(dataDir, 'home.json')}: ${(text.length / 1024).toFixed(1)} KB · ${out.lb ? out.lb.top.length + ' top wallets, ' + out.lb.books.length + ' books' : 'no leaderboard'} · ${out.predict ? out.predict.wins.length + ' wins, ' + out.predict.bets.length + ' bets' : 'no Predict snapshot'}`);
