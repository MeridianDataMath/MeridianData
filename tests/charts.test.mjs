// Chart wrappers: the options C.bars hands to Chart.js (a stub Chart records them; no canvas is drawn).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_load.mjs';

load(['js/util.js']);   // before the stubs: util.js wires DOM listeners when it sees a document
const made = [];
globalThis.Chart = class { constructor(canvas, config) { this.config = config; made.push(config); } destroy() {} };
globalThis.Chart.defaults = { font: {}, plugins: { legend: {} } };
globalThis.document = { documentElement: {} };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
const MD = load(['js/charts.js']);
const C = MD.charts;

test('C.bars: the value axis is in dollars unless the caller gives its own formatter (the tax center\'s report currency)', () => {
  const usd = C.bars({}, ['Jan'], [150]).config.options.scales;
  assert.equal(usd.y.ticks.callback, C.axisUsd, 'vertical bars: y ticks in dollars');
  assert.equal(usd.y.ticks.callback(150), '$150');
  assert.equal(usd.x.ticks.callback, undefined, 'the category axis keeps its labels');

  const eur = (v) => '€' + v;
  const s = C.bars({}, ['Jan'], [150], { axisFmt: eur }).config.options.scales;
  assert.equal(s.y.ticks.callback, eur, 'vertical bars: y ticks from axisFmt');
  const hz = C.bars({}, ['Jan'], [150], { horizontal: true, axisFmt: eur }).config.options.scales;
  assert.equal(hz.x.ticks.callback, eur, 'horizontal bars: x ticks from axisFmt');
  assert.equal(hz.y.ticks.callback, undefined);
  assert.equal(made.length, 3);
});

test('charts are let go: all of them on a page change, and one whose canvas has been off the page for 15 s', () => {
  const prev = globalThis.Chart, now = Date.now;
  let destroyed = 0, t = 1e12;
  globalThis.Chart = class { constructor(canvas) { this.canvas = canvas; this.config = { type: 'bar' }; } destroy() { destroyed++; this.canvas = null; } };
  Date.now = () => t;
  try {
    C.destroyAll(); destroyed = 0;
    const on = { isConnected: true }, off = { isConnected: false };
    C.bars(on, ['a'], [1]); C.bars(off, ['a'], [1]);
    assert.equal(C.count(), 2);
    C.sweep(); assert.equal(destroyed, 0, 'a canvas just drawn before it is attached is not taken for gone');
    t += 16000; C.sweep(); assert.equal(destroyed, 1, 'off the page for 15 s: destroyed'); assert.equal(off.__chart, null);
    assert.ok(on.__chart, 'the chart on the page stays'); assert.equal(C.count(), 1);
    C.bars(on, ['a'], [2]); assert.equal(destroyed, 2, 'a new chart on the same canvas replaces the old one'); assert.equal(C.count(), 1);
    C.destroyAll(); assert.equal(destroyed, 3); assert.equal(C.count(), 0); assert.equal(on.__chart, null);
  } finally { globalThis.Chart = prev; Date.now = now; }
});
