#!/usr/bin/env node
/**
 * After the deploy (the health job in .github/workflows/pages.yml): fails the run, which GitHub mails to the account the
 * workflow runs as, when the site's data has stopped updating. It fails once when the age crosses the line and then once a
 * day (a run in the first half of the 03:00 UTC hour), never on every run. Checked:
 *   - the Predict snapshot live on the site is over 2 hours old (the snapshot machine, or its push, has stopped; or the
 *     deploys themselves, which the alarm then says when this run's deploy failed), or its status file has no build time
 *   - the perps leaderboard live on the site (its summary in home.json) is over 2 hours old (the build fails on every run
 *     and the published file goes out again), or most of its rows have been carried from earlier builds for that long
 *   - the Cloudflare timer (cron/) has not dispatched the deploy for over 75 minutes (its Worker stopped, or its GitHub
 *     token expired): on every scheduled run while it lasts (GitHub drops many of them), on the others once, then daily
 * With NTFY_TOPIC set (a repository secret) the same text is pushed there too.
 *   node scripts/deploy-health.mjs [--site https://…] [--event schedule] [--deploy success]   (GH_TOKEN, GITHUB_REPOSITORY)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIN = 60000, H = 60 * MIN;
export const SNAPSHOT_MAX = 2 * H, TIMER_MAX = 75 * MIN, LB_MAX = 2 * H, CARRIED_SHARE = 0.5;
/**
 * Whether a run at `now` raises the alarm about something `age` ms old that must be under `limit`: in the first `window`
 * past the limit (one run's worth: half an hour for the timer's runs, two hours for the backup's), then daily in the
 * first half of the 03:00 UTC hour.
 */
export const alarm = (age, now, limit, window = 30 * MIN) => {
  if (!(age >= limit)) return false;
  const d = new Date(now);
  return age < limit + window || (d.getUTCHours() === 3 && d.getUTCMinutes() < 30);
};
const ago = (ms) => (ms >= 2 * H ? `${(ms / H).toFixed(1)} h` : `${Math.round(ms / MIN)} min`);
/** The perps leaderboard as the live home.json sums it up (lb: builtAt, cov) → { age, what } when it is stale: not rebuilt
 *  for LB_MAX (the build fails on every run and keep-live sends the published file out again), or most of its rows carried
 *  from earlier builds for that long (the build runs, its reads fail); null when fine or unknown */
export const leaderboardProblem = (lb, now) => {
  if (!lb || !(lb.builtAt > 0)) return null;
  const age = now - lb.builtAt;
  if (age >= LB_MAX) return { age, what: `the perps leaderboard on the site is ${ago(age)} old: the perps build has failed on every run since (the published file goes out again; see the "Build perps snapshot" step)` };
  const c = lb.cov;
  if (c && c.rows > 0 && c.carried / c.rows > CARRIED_SHARE && c.oldest > 0 && now - c.oldest >= LB_MAX) return { age: now - c.oldest, what: `${c.carried} of the leaderboard's ${c.rows} rows are carried from earlier builds, the oldest ${ago(now - c.oldest)} old: the perps build runs but its reads fail` };
  return null;
};
/** Whether this run raises the timer's alarm: every scheduled run while the timer is silent past TIMER_MAX (the two-hourly
 *  backup, which GitHub often drops, may be the only runs left), any other run once past it, then daily */
export const timerAlarm = (age, now, event) => (event === 'schedule' ? age >= TIMER_MAX : alarm(age, now, TIMER_MAX));

async function main(argv) {
  const at = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
  const site = String(at('--site', 'https://meridian.thedatahub.xyz')).replace(/\/+$/, ''), event = at('--event', ''), deploy = at('--deploy', '');
  const now = Date.now(), bad = [];
  try {
    const r = await fetch(`${site}/data/predict-status.json?t=${now}`, { signal: AbortSignal.timeout(30000), headers: { 'cache-control': 'no-cache' } });
    // the host answers a missing file with the site's page (status 200): only JSON counts
    const b = r.ok && /json/i.test((r.headers && r.headers.get && r.headers.get('content-type')) || '') ? Number((await r.json()).builtAt) : 0;
    if (!(b > 0)) { console.warn(`::warning::the live predict-status.json gave no build time (HTTP ${r.status})`); if (alarm(Infinity, now, SNAPSHOT_MAX)) bad.push('the live predict-status.json gives no build time: neither the Predict pages nor this check can tell how old the snapshot is'); }
    else {
      const age = now - b; console.log(`Predict snapshot live: built ${ago(age)} ago`);
      if (alarm(age, now, SNAPSHOT_MAX)) bad.push(deploy && deploy !== 'success' ? `the Predict snapshot on the site is ${ago(age)} old, and this run's deploy did not succeed (${deploy}): the deploys may be what stopped, not the snapshot machine` : `the Predict snapshot on the site is ${ago(age)} old: the snapshot machine has stopped publishing (Mac mini: its launchd job, its push to MeridianData-snapshots, or the machine itself)`);
    }
  } catch (e) { console.warn(`::warning::the live predict-status.json was not read: ${e.message}`); }
  try {
    const r = await fetch(`${site}/data/home.json?t=${now}`, { signal: AbortSignal.timeout(30000), headers: { 'cache-control': 'no-cache' } });
    const j = r.ok && /json/i.test((r.headers && r.headers.get && r.headers.get('content-type')) || '') ? await r.json() : null;
    if (!j || !j.lb) console.warn('::warning::the live home.json sums up no leaderboard: its age was not checked');
    else { console.log(`perps leaderboard live: built ${ago(now - j.lb.builtAt)} ago`); const p = leaderboardProblem(j.lb, now); if (p && alarm(p.age, now, LB_MAX)) bad.push(p.what); }
  } catch (e) { console.warn(`::warning::the live home.json was not read: ${e.message}`); }
  if (process.env.GH_TOKEN && process.env.GITHUB_REPOSITORY) {
    try {
      const r = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/pages.yml/runs?event=workflow_dispatch&per_page=1`, { signal: AbortSignal.timeout(30000), headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const run = ((await r.json()).workflow_runs || [])[0];
      const age = run ? now - Date.parse(run.created_at) : Infinity;
      console.log(`last run dispatched by the timer: ${run ? ago(age) + ' ago' : 'none'}`);
      if (timerAlarm(age, now, event)) bad.push(`the Cloudflare timer (cron/) has not dispatched a deploy for ${run ? ago(age) : 'ever'}: check the meridiandatahub-cron Worker's Cron Trigger and its DISPATCH_TOKEN`);
    } catch (e) { console.warn(`::warning::the timer's runs were not read: ${e.message}`); }
  }
  if (!bad.length) return;
  for (const b of bad) console.error(`::error::${b}`);
  const topic = process.env.NTFY_TOPIC;
  if (topic) { try { await fetch(`${String(process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '')}/${encodeURIComponent(topic)}`, { method: 'POST', body: bad.join('\n'), headers: { Title: 'MeridianDataHub: data stopped updating', Tags: 'warning' }, signal: AbortSignal.timeout(15000) }); } catch (_) {} }
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch((e) => { console.error(`::error::${e.message}`); process.exitCode = 1; });
