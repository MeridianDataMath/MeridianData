#!/usr/bin/env node
/**
 * After the deploy (the health job in .github/workflows/pages.yml): fails the run, which GitHub mails to the account the
 * workflow runs as, when the site's data has stopped updating. It fails once when the age crosses the line and then once a
 * day (a run in the first half of the 03:00 UTC hour), never on every run. Checked:
 *   - the Predict snapshot live on the site is over 2 hours old (the snapshot machine, or its push, has stopped)
 *   - on a scheduled run (the two-hourly backup): the Cloudflare timer (cron/) has not dispatched the deploy for over
 *     75 minutes (its Worker stopped, or its GitHub token expired)
 * With NTFY_TOPIC set (a repository secret) the same text is pushed there too.
 *   node scripts/deploy-health.mjs [--site https://…] [--event schedule]     (GH_TOKEN, GITHUB_REPOSITORY for the timer)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIN = 60000, H = 60 * MIN;
export const SNAPSHOT_MAX = 2 * H, TIMER_MAX = 75 * MIN;
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

async function main(argv) {
  const at = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
  const site = String(at('--site', 'https://meridian.thedatahub.xyz')).replace(/\/+$/, ''), event = at('--event', '');
  const now = Date.now(), bad = [];
  try {
    const r = await fetch(`${site}/data/predict-status.json?t=${now}`, { signal: AbortSignal.timeout(30000), headers: { 'cache-control': 'no-cache' } });
    const b = r.ok ? Number((await r.json()).builtAt) : 0;
    if (!(b > 0)) console.warn(`::warning::the live predict-status.json gave no build time (HTTP ${r.status})`);
    else { const age = now - b; console.log(`Predict snapshot live: built ${ago(age)} ago`); if (alarm(age, now, SNAPSHOT_MAX)) bad.push(`the Predict snapshot on the site is ${ago(age)} old: the snapshot machine has stopped publishing (Mac mini: its launchd job, its push to MeridianData-snapshots, or the machine itself)`); }
  } catch (e) { console.warn(`::warning::the live predict-status.json was not read: ${e.message}`); }
  if (event === 'schedule' && process.env.GH_TOKEN && process.env.GITHUB_REPOSITORY) {
    try {
      const r = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/pages.yml/runs?event=workflow_dispatch&per_page=1`, { signal: AbortSignal.timeout(30000), headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const run = ((await r.json()).workflow_runs || [])[0];
      const age = run ? now - Date.parse(run.created_at) : Infinity;
      console.log(`last run dispatched by the timer: ${run ? ago(age) + ' ago' : 'none'}`);
      // the backup runs every two hours, so its window is two hours: one of its runs falls in it
      if (alarm(age, now, TIMER_MAX, 2 * H + 5 * MIN)) bad.push(`the Cloudflare timer (cron/) has not dispatched a deploy for ${run ? ago(age) : 'ever'}: check the meridiandatahub-cron Worker's Cron Trigger and its DISPATCH_TOKEN`);
    } catch (e) { console.warn(`::warning::the timer's runs were not read: ${e.message}`); }
  }
  if (!bad.length) return;
  for (const b of bad) console.error(`::error::${b}`);
  const topic = process.env.NTFY_TOPIC;
  if (topic) { try { await fetch(`${String(process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '')}/${encodeURIComponent(topic)}`, { method: 'POST', body: bad.join('\n'), headers: { Title: 'MeridianDataHub: data stopped updating', Tags: 'warning' }, signal: AbortSignal.timeout(15000) }); } catch (_) {} }
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch((e) => { console.error(`::error::${e.message}`); process.exitCode = 1; });
