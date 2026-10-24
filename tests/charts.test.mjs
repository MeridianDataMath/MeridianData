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
  // Chart.js calls a tick callback (value, index, ticks): the formatter gets the value and the step between the ticks
  const tk = [{ value: 0 }, { value: 50 }, { value: 100 }];
  const usd = C.bars({}, ['Jan'], [150]).config.options.scales;
  assert.equal(usd.y.ticks.callback(150, 0, tk), '$150', 'vertical bars: y ticks in dollars');
  assert.equal(usd.x.ticks.callback, undefined, 'the category axis keeps its labels');

  const eur = (v, step) => '€' + v + '/' + step;
  const s = C.bars({}, ['Jan'], [150], { axisFmt: eur }).config.options.scales;
  assert.equal(s.y.ticks.callback(150, 1, tk), '€150/50', 'vertical bars: y ticks from axisFmt, with the step');
  const hz = C.bars({}, ['Jan'], [150], { horizontal: true, axisFmt: eur }).config.options.scales;
  assert.equal(hz.x.ticks.callback(150, 1, tk), '€150/50', 'horizontal bars: x ticks from axisFmt');
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

test('axis money: the decimals come from the step, so no two ticks read the same; a unit rolls over after rounding', () => {
  const axis = (from, step, n) => Array.from({ length: n }, (_, i) => C.axisUsd(from + i * step, step));
  assert.deepEqual(axis(12000, 50, 5), ['$12.00K', '$12.05K', '$12.10K', '$12.15K', '$12.20K']);
  assert.deepEqual(axis(10, 0.5, 4), ['$10.0', '$10.5', '$11.0', '$11.5']);
  assert.deepEqual(axis(998000, 1000, 5), ['$998K', '$999K', '$1.000M', '$1.001M', '$1.002M']);
  assert.deepEqual(axis(1480, 10, 3), ['$1,480', '$1,490', '$1,500']);
  assert.equal(C.axisUsd(-1500), '-$1,500', 'without a step: whole dollars');
  assert.equal(C.axisUsd(2.5), '$2.50');
});
