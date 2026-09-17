// The iterate project's config worker, re-committed with the right links (dash = the OS, os = the
// platform). A commit re-points `itx.worker` by the base ConfigWorker's convention (followCommittedSource).
import { newWebSocketRpcSession } from "capnweb";

const origin = process.env.ISSUER_ORIGIN || "https://os.iterate2.com";
const url = new URL("/internal/rpc", origin);
url.protocol = "wss:";
const root = newWebSocketRpcSession<any>(url.href);
const session = root.authenticate({
  type: "admin-secret",
  secret: process.env.APP_CONFIG_ADMIN_API_SECRET!,
  as: { email: "jonas3@templestein.com" },
});
const itx = session.projects.get("iterate");
const repo = itx.repos.get("/repos/config");
const committed = await repo.commitFiles({
  message: "the config worker: the OS is dash.iterate2.com, sign-in is os.iterate2.com",
  changes: [
    {
      path: "worker.ts",
      content: `import { ConfigWorker } from "./processor.js";
// The iterate project's config worker: its fetch is the apex — iterate2.com (the platform's
// custom-hostname door) and iterate.iterate2.app (the project host under the base).
export default class extends ConfigWorker {
  fetch(request) {
    const url = new URL(request.url);
    return new Response(
      \`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>iterate</title></head><body style="font:16px/1.55 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1.25rem"><h1>iterate</h1><p>This page is the <code>iterate</code> project's own config worker answering on <code>\${url.hostname}\${url.pathname}</code> — userspace code, served through the platform's custom-hostname door.</p><p><a href="https://dash.iterate2.com/">Open the OS</a> · <a href="https://os.iterate2.com/login">Sign in</a></p></body></html>\`,
      { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
    );
  }
}
`,
    },
  ],
});
console.log("commit:", committed.commitOid, committed.changedPaths);
// The rule follows the commit through the config worker's own processEventBatch; if that has not
// run yet, point it explicitly (idempotent — the same target).
await itx.append({
  type: "events.iterate.com/itx/rewrite-rule-configured",
  payload: {
    match: "itx.worker",
    target: `itx.workers.get({ source: "itx.repos.get('/repos/config').readFile('worker.ts')", cacheKey: 'config:${committed.commitOid}' })`,
  },
});
console.log("itx.worker:", (await itx.rewriteRules.get("itx.worker")).target);
root[Symbol.dispose]?.();
process.exit(0);
