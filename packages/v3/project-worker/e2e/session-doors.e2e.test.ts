// session-doors.e2e.test.ts — the session's doors: one-shot HTTP batch at /api (no WebSocket), an
// inline-source worker, a fetch-shaped target through the session as a dotted `.fetch(request)`
// behind a rewrite rule (the commissioned fork feature carries the Response back), and the raw
// `/version` door a deploy smoke polls.

// eslint-disable-next-line iterate/no-capnweb-http-batch -- the /api one-shot batch door itself is under test; everything else is WS
import { newHttpBatchRpcSession } from "capnweb";
import { expect, test } from "vitest";
import { freshCtx, openItx, workerUrl } from "./support/client.ts";
import { projectHostsAreLocal } from "./support/project-host.ts";
import { SOURCES } from "./support/sources.ts";

test("one-shot HTTP batch whoami at /api, an inline-source worker, and a dotted .fetch(request) through a rewrite rule", async () => {
  // The batch and the live session share ONE ctx (one project DO).
  const ctx = freshCtx("edge");

  // 1. ONE-SHOT HTTP BATCH: a CLI-shaped client — no WebSocket anywhere. Every call chained off the
  //    session flushes as a single POST to /api; the shape is the same `.authenticate().projects.get(ctx)`.
  // eslint-disable-next-line iterate/no-capnweb-http-batch -- the batch door is what this proves: a socketless CLI client works
  const batch: any = newHttpBatchRpcSession(workerUrl("/api"));
  const who = await batch
    .authenticate()
    .projects.get(ctx)
    .invoke(["itx", ["whoami"]]);
  // one-shot HTTP batch: whoami without a socket
  expect(who?.projectId).toBe(ctx);

  // live session for the rest
  const itx = openItx(ctx);

  // 2. THE SOURCE IS THE MODULES, handed over INLINE: hand the code over, run it
  const SRC_MINE = {
    "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Mine extends WorkerEntrypoint {
  async run() {
    const itx = await this.env.ITX.get();
    return \`from-inline:\${(await itx.whoami()).projectId}\`;
  }
}`,
  };
  const out = await itx.invoke(["itx", "workers", ["get", { source: SRC_MINE }], ["run"]]);
  // an inline source runs as a worker (itx round-trip inside)
  expect(out).toBe(`from-inline:${ctx}`);

  // 3. a fetch-shaped target through the SESSION (no /expression door): the terminal
  //    `.fetch(request)` rides the DO's fetch channel with the expression in x-itx-expression — one
  //    routing fork, no verb; `itx.site` is an ordinary rewrite rule onto the loaded entrypoint
  await itx.provide("itx.site", ["itx", "workers", ["get", { source: SOURCES.site }]]);
  const resp = await itx.site.fetch(new Request("https://itx.site/"));
  const html = await resp.text();
  // the Response rides back over capnweb
  expect(resp.status).toBe(200);
  expect(html).toContain("dynamic web capability");
});

test("/version answers `<label> <environmentName> <deployId>` — the deploy stamp a smoke waits for", async () => {
  // CODE_VERSION (worker.ts) first, then the configuration (src/app-config.ts): the e2e lane names
  // itself "e2e"; a deployed worker names its environment. The deploy id is Cloudflare's version id
  // of the deploy — local workerd mints one too — or "unversioned" where the binding is absent.
  const versionRes = await fetch(workerUrl("/version"));
  expect(versionRes.status).toBe(200);
  const [label, environmentName, deployId, ...rest] = (await versionRes.text()).trim().split(" ");
  expect(label).toMatch(/^live-\d+$/);
  expect(rest).toEqual([]);
  expect(deployId).toMatch(/^(?:[0-9a-f-]{36}|unversioned)$/);
  if (projectHostsAreLocal()) expect(environmentName).toBe("e2e");
  else expect(environmentName).toMatch(/^[a-z][a-z0-9_-]*$/);
});
