// The deploy's own scripts: the Predict snapshot gate (scripts/check-snapshot.mjs), the files a failed build takes from the
// live site (scripts/keep-live.mjs, against a fake fetch) and when the health job raises the alarm
// (scripts/deploy-health.mjs), and the versioned addresses of the scripts and stylesheets (scripts/version-assets.mjs).
// No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { pick, problems, excludedWallets, MAX_FILES, NAME } from '../scripts/check-snapshot.mjs';
import { keepLeaderboard, keepFx } from '../scripts/keep-live.mjs';
import { alarm, SNAPSHOT_MAX, TIMER_MAX, LB_MAX, leaderboardProblem, timerAlarm } from '../scripts/deploy-health.mjs';
import { versionPage, unversioned, buildId, stampBuild } from '../scripts/version-assets.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'md-deploy-'));
const put = (dir, rel, text) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const W = (n) => '0x' + String(n).repeat(40).slice(0, 40);

test('the snapshot gate takes only published names, never a link, and drops a left-out wallet\'s file', () => {
  const d = tmp(); const ex = excludedWallets();
  assert.ok(ex.size >= 1, 'the site\'s list is read'); const out = Array.from(ex)[0];
  put(d, 'predict.json', '{}'); put(d, 'predict-status.json', '{}'); put(d, `bettors/${W(1)}.json`, '{}'); put(d, `bettors/${out}.json`, '{}');
  put(d, 'questions/0x' + 'a'.repeat(64) + '.json', '{}'); put(d, 'slips/0f.json', '{}');
  put(d, 'notes.txt', 'x'); put(d, 'bettors/readme.json', '{}'); put(d, 'bettors/0x' + 'A'.repeat(40) + '.json', '{}'); put(d, 'deep/predict.json', '{}'); put(d, '.git/predict.json', '{}');
  let linked = false; try { fs.symlinkSync(path.join(d, 'predict.json'), path.join(d, 'predict-ideas.json')); linked = true; } catch (_) {}   // Windows may refuse links without rights
  assert.deepEqual(pick(d, ex), ['bettors/' + W(1) + '.json', 'predict-status.json', 'predict.json', 'questions/0x' + 'a'.repeat(64) + '.json', 'slips/0f.json']);
  if (linked) assert.ok(!pick(d, ex).includes('predict-ideas.json'), 'a link is not copied');
  assert.ok(NAME.test('predict-ideas.json')); assert.ok(NAME.test('predict-questions.json'), 'the questions, written apart from predict.json');
});

test('the snapshot gate refuses what is not JSON, too big, too many, or without Predict data', () => {
  const ok = { name: 'predict.json', size: 50, text: JSON.stringify({ agg: {}, predictions: 3 }) };
  const st = { name: 'predict-status.json', size: 20, text: '{"builtAt":1792800000000}' };
  assert.deepEqual(problems([ok, st]), []);
  assert.match(problems([ok, { name: 'predict-status.json', size: 2, text: '{}' }]).join(), /no predict-status\.json with a build time/);
  assert.match(problems([ok]).join(), /no predict-status\.json with a build time/, 'the status file is required');
  // a snapshot built with an older wallet list: refused, without naming the wallet (the run's log is public)
  const left = '0x' + 'e'.repeat(40), ex = new Set([left]);
  const named = problems([ok, st, { name: 'slips/0a.json', size: 60, text: JSON.stringify({ slips: { x: { p: left.toUpperCase().replace('0X', '0x') } } }) }], ex).join();
  assert.match(named, /older wallet list than the site's: update the snapshot machine/); assert.ok(!named.includes(left) && !named.includes('slips'));
  assert.deepEqual(problems([ok, st, { name: 'bettors/' + left + '.json', size: 2, text: '{"address":"' + left + '"}' }], ex), [], 'its own file is dropped by pick, not refused');
  assert.match(problems([ok, st, { name: 'slips/00.json', size: 3, text: '{"x' }]).join(), /slips\/00\.json is not JSON/);
  assert.match(problems([ok, st, { name: 'questions/x.json', size: 26e6, text: '{}' }]).join(), /over 25 MB/);
  assert.match(problems([{ name: 'predict.json', size: 9, text: JSON.stringify({ error: 'Error: boom\n at x', builtAt: 1 }) }]).join(), /holds no Predict data \(its build failed: Error: boom\)/);
  assert.match(problems([{ name: 'predict-status.json', size: 2, text: '{}' }]).join(), /no predict\.json/);
  // a predict.json whose questions are in a file of their own comes with that file
  const split = { name: 'predict.json', size: 40, text: JSON.stringify({ agg: { bettors: [] }, predictions: 5, questionsFile: 'predict-questions.json' }) };
  assert.match(problems([split, st]).join(), /names predict-questions\.json, which the snapshot lacks/);
  assert.deepEqual(problems([split, st, { name: 'predict-questions.json', size: 25, text: '{"questionsWithOi":[]}' }]), []);
  const many = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ name: `bettors/${i}.json`, size: 2, text: '{}' }));
  assert.match(problems([ok].concat(many)).join(), new RegExp(`${MAX_FILES + 2} files, more than`));
  assert.match(problems([ok, { name: 'bettors/a.json', size: 140e6, text: '{}' }, { name: 'bettors/b.json', size: 20e6, text: '{}' }]).join(), /MB in all, more than/);
});

const fakeSite = (files) => async (url) => {
  const rel = url.replace(/^https:\/\/site\.test\//, '');
  return rel in files ? { ok: true, status: 200, text: async () => (typeof files[rel] === 'string' ? files[rel] : JSON.stringify(files[rel])) } : { ok: false, status: 404, text: async () => '' };
};

test('a perps build that wrote nothing deploys the published leaderboard again; one that wrote a file keeps it', async () => {
  const d = tmp(); const site = 'https://site.test';
  const live = { builtAt: Date.UTC(2026, 9, 23, 22, 0), rows: [{ sid: 'a' }] };
  const said = await keepLeaderboard({ site, data: d, fetchImpl: fakeSite({ 'data/leaderboard.json': live }) });
  assert.match(said, /the published one \(built 2026-10-23T22:00:00\.000Z\) goes out again/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, 'leaderboard.json'), 'utf8')), live);
  fs.writeFileSync(path.join(d, 'leaderboard.json'), '{"rows":[{"sid":"new"}]}');
  assert.equal(await keepLeaderboard({ site, data: d, fetchImpl: fakeSite({ 'data/leaderboard.json': live }) }), null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'leaderboard.json'), 'utf8')).rows[0].sid, 'new', 'this run\'s file stays');
  const e = tmp(); assert.match(await keepLeaderboard({ site, data: e, fetchImpl: fakeSite({ 'data/leaderboard.json': { rows: [] } }) }), /not read \(it has no rows\)/);
  assert.equal(fs.existsSync(path.join(e, 'leaderboard.json')), false, 'an empty published file is not deployed');
  // a file cut short (a build stopped mid-write) is replaced by the published one
  const g = tmp(); fs.writeFileSync(path.join(g, 'leaderboard.json'), '{"builtAt":1,"rows":[{"sid":"a"},{"si');
  assert.match(await keepLeaderboard({ site, data: g, fetchImpl: fakeSite({ 'data/leaderboard.json': live }) }), /left a leaderboard.json that is not one: the published one/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(g, 'leaderboard.json'), 'utf8')), live);
});

test('an exchange-rate source this run did not write comes from the live site, with its index entry', async () => {
  const d = tmp(); const site = 'https://site.test';
  const entry = (id, file) => ({ file, from: '2026-06-01', to: '2026-10-23', count: 100 });
  const live = { 'data/fx/index.json': { v: 1, builtAt: 'live', floor: '2026-06-01', files: { ecb: entry('ecb', 'ecb.json'), nbp: entry('nbp', 'nbp-usd.json'), evil: entry('evil', '../../index.html') } }, 'data/fx/ecb.json': { dates: ['2026-10-23'] }, 'data/fx/nbp-usd.json': { dates: ['2026-10-23'], live: true } };
  // this run wrote ECB, NBP failed
  put(d, 'fx/ecb.json', JSON.stringify({ dates: ['2026-10-24'], fresh: true }));
  put(d, 'fx/index.json', JSON.stringify({ v: 1, builtAt: 'run', floor: '2026-06-01', files: { ecb: entry('ecb', 'ecb.json') }, failed: { nbp: 'HTTP 503' } }));
  const said = await keepFx({ site, data: d, fetchImpl: fakeSite(live) });
  assert.match(said, /nbp not built this run; the published file goes out again/);
  const idx = JSON.parse(fs.readFileSync(path.join(d, 'fx/index.json'), 'utf8'));
  assert.deepEqual(Object.keys(idx.files).sort(), ['ecb', 'nbp'], 'a file name that is not plain is never fetched');
  assert.equal(idx.builtAt, 'run'); assert.equal(idx.failed, undefined, 'the source is there again');
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'fx/ecb.json'), 'utf8')).fresh, true, 'what this run wrote stays');
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'fx/nbp-usd.json'), 'utf8')).live, true);
  // the FX step wrote nothing at all: every published source, under the published index's header
  const e = tmp(); assert.match(await keepFx({ site, data: e, fetchImpl: fakeSite(live) }), /ecb, nbp not built/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(e, 'fx/index.json'), 'utf8')).builtAt, 'live');
  // everything written this run: nothing to do
  assert.equal(await keepFx({ site, data: d, fetchImpl: fakeSite(live) }), null);
});

test('the health check raises the alarm once when data goes stale, then daily, never on every run', () => {
  const H = 3600000, M = 60000; const at = (h, m) => Date.UTC(2026, 9, 24, h, m);
  assert.equal(alarm(1.9 * H, at(12, 14), SNAPSHOT_MAX), false);
  assert.equal(alarm(2 * H + 10 * M, at(12, 14), SNAPSHOT_MAX), true, 'the first run past two hours');
  assert.equal(alarm(2 * H + 40 * M, at(12, 44), SNAPSHOT_MAX), false, 'the next run stays quiet');
  assert.equal(alarm(15 * H, at(3, 14), SNAPSHOT_MAX), true, 'daily, early in the 03:00 UTC hour');
  assert.equal(alarm(15 * H, at(3, 44), SNAPSHOT_MAX), false, 'once a day, not every run of that hour');
  assert.equal(alarm(NaN, at(3, 14), SNAPSHOT_MAX), false, 'no age read: no alarm');
  // the timer, judged on the two-hourly backup runs: one of them falls in a two-hour window
  assert.equal(alarm(80 * M, at(13, 29), TIMER_MAX, 2 * H + 5 * M), true);
  assert.equal(alarm(3.5 * H, at(15, 29), TIMER_MAX, 2 * H + 5 * M), false);
  assert.equal(alarm(Infinity, at(3, 29), TIMER_MAX, 2 * H + 5 * M), true, 'never dispatched: daily');
  // the timer: every scheduled run while it is silent (GitHub drops most of them); a push run once, then daily
  assert.equal(timerAlarm(5 * H, at(15, 29), 'schedule'), true); assert.equal(timerAlarm(60 * M, at(15, 29), 'schedule'), false);
  assert.equal(timerAlarm(80 * M, at(15, 2), 'push'), true); assert.equal(timerAlarm(5 * H, at(15, 2), 'push'), false);
  assert.equal(timerAlarm(2 * M, at(15, 16), 'workflow_dispatch'), false, 'a run the timer dispatched');
});

test('the leaderboard on the site goes stale: its file not rebuilt, or most of its rows carried, for two hours', () => {
  const H = 3600000, now = Date.UTC(2026, 9, 24, 20, 14);
  assert.equal(leaderboardProblem({ builtAt: now - H, cov: { rows: 380, carried: 2, oldest: now - 3 * H } }, now), null, 'a few rows carried: fine');
  const old = leaderboardProblem({ builtAt: now - 3 * H, cov: { rows: 380, carried: 0 } }, now);
  assert.match(old.what, /3\.0 h old: the perps build has failed on every run/); assert.equal(old.age, 3 * H);
  const carried = leaderboardProblem({ builtAt: now - 10 * 60000, cov: { rows: 380, carried: 300, oldest: now - LB_MAX - 60000 } }, now);
  assert.match(carried.what, /300 of the leaderboard's 380 rows are carried/);
  assert.equal(leaderboardProblem({ builtAt: now - 10 * 60000, cov: { rows: 380, carried: 300, oldest: now - H } }, now), null, 'carried, but not yet for two hours');
  assert.equal(leaderboardProblem(null, now), null); assert.equal(leaderboardProblem({}, now), null);
});

test('the three wrangler versions agree (a bumped one would make the deploy action install its own, with the token set)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const want = String((pkg.devDependencies || {}).wrangler || (pkg.dependencies || {}).wrangler || '').replace(/^[~^]/, '');
  assert.ok(/^\d+\.\d+\.\d+$/.test(want), 'package.json pins wrangler exactly');
  for (const f of ['.github/workflows/pages.yml', '.github/workflows/cron.yml']) {
    const got = Array.from(fs.readFileSync(path.join(root, f), 'utf8').matchAll(/wranglerVersion:\s*['"]?([\d.]+)/g), (m) => m[1]);
    assert.ok(got.length, f + ' sets wranglerVersion'); for (const v of got) assert.equal(v, want, f);
  }
});

test('every page asks for the site\'s scripts and stylesheets by their content (?v=), or the deploy stops', () => {
  const H = { 'js/app.js': 'aaaaaaaaaa', 'css/app.css': 'bbbbbbbbbb', 'js/share.js': 'cccccccccc' };
  const hashOf = (p) => H[p] || null;
  const page = '<link rel="stylesheet" href="css/app.css"><script defer src="js/app.js"></script><script src="/js/share.js?v=old"></script><a href="https://x.com/js/app.js">x</a><img src="assets/logo.svg">';
  const out = versionPage(page, hashOf);
  assert.equal(out, '<link rel="stylesheet" href="css/app.css?v=bbbbbbbbbb"><script defer src="js/app.js?v=aaaaaaaaaa"></script><script src="/js/share.js?v=cccccccccc"></script><a href="https://x.com/js/app.js">x</a><img src="assets/logo.svg">');
  assert.deepEqual(unversioned(out, hashOf), []);
  assert.equal(versionPage(out, hashOf), out, 'a second run changes nothing');
  // the deploy's build id: from the versions index.html loads, in its <meta name="md-build"> (the lazy loader compares it)
  const idx = '<meta name="md-build" content="dev">' + out;
  const id = buildId(idx); assert.match(id, /^[0-9a-f]{12}$/);
  assert.equal(buildId(idx.replace(/\?v=[0-9a-f]+/, '?v=0000000000')), buildId(idx.replace(/\?v=[0-9a-f]+/, '?v=0000000000')), 'the same versions, the same id');
  assert.notEqual(buildId(idx.replace(/\?v=[0-9a-f]+/, '?v=0000000000')), id, 'a file changed: another id');
  assert.match(stampBuild(idx, id), new RegExp('<meta name="md-build" content="' + id + '">'));
  assert.throws(() => stampBuild(out, id), /no <meta name="md-build">/);
  assert.deepEqual(unversioned(page, hashOf), ['css/app.css (want ?v=bbbbbbbbbb)', 'js/app.js (want ?v=aaaaaaaaaa)', 'js/share.js?v=old (want ?v=cccccccccc)']);
  assert.throws(() => versionPage('<script src="js/gone.js"></script>', hashOf), /js\/gone\.js is referenced but not there/);
});
