// Loads the site's classic scripts (they attach to window.MD) into this Node process, the way the snapshot builder does.
// Only DOM-free modules: util, api, analytics, the copy engines and the Predict analytics. node --test runs every test
// file in its own process, so each file gets a fresh MD.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function load(files) {
  globalThis.window = globalThis;
  globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };
  if (!globalThis.window.addEventListener) globalThis.window.addEventListener = () => {};
  for (const f of files) vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
  return globalThis.MD;
}

/** assert two numbers agree to `eps` (money: a hundredth of a cent by default) */
export function near(assert, actual, expected, eps = 1e-6, msg) {
  assert.ok(Number.isFinite(actual), `${msg || 'value'} is not a number: ${actual}`);
  assert.ok(Math.abs(actual - expected) <= eps, `${msg || 'value'}: expected ${expected}, got ${actual}`);
}
