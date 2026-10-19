/* MeridianDataHub — the timer that keeps the site's data fresh.
   At :14 and :44 (wrangler.jsonc), just after the snapshot machine publishes the Predict snapshot (:09 and :39), it starts
   the site's "Snapshot & deploy" workflow on GitHub (workflow_dispatch). GitHub starts a dispatched run at once, while its
   own schedule drops most runs under load (October 2026).
   DISPATCH_TOKEN: a fine-grained GitHub token for MeridianData with Actions read and write only, set as this Worker's
   secret in the Cloudflare dashboard (Settings → Variables and Secrets). The Worker has no route and no workers.dev
   address: nothing can call it from outside. */
const REPO = 'MeridianDataMath/MeridianData', WORKFLOW = 'pages.yml';

const gh = (env, path, method, body) => fetch('https://api.github.com/repos/' + REPO + path, {
  method,
  headers: { authorization: 'Bearer ' + env.DISPATCH_TOKEN, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'meridiandatahub-cron', 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
});
const ok = (res) => res.status === 204 || res.status === 200;

export default {
  async scheduled(event, env) {
    if (!env.DISPATCH_TOKEN) { console.log('no DISPATCH_TOKEN: add it in the dashboard (Settings → Variables and Secrets)'); return; }
    const dispatch = () => gh(env, '/actions/workflows/' + WORKFLOW + '/dispatches', 'POST', { ref: 'main' });
    let res = await dispatch();
    if (!ok(res)) {
      const text = (await res.text()).slice(0, 300);
      // GitHub turns off a public repository's workflow after 60 days without a commit: on again, then once more
      if (!/disabled/i.test(text)) { console.log('dispatch refused: HTTP ' + res.status + ' ' + text); return; }
      await gh(env, '/actions/workflows/' + WORKFLOW + '/enable', 'PUT');
      res = await dispatch();
    }
    console.log(ok(res) ? 'deploy started' : 'dispatch failed: HTTP ' + res.status + ' ' + (await res.text()).slice(0, 300));
  },
};
