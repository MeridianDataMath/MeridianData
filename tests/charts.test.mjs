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
