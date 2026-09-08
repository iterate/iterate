// session-doors.e2e.test.ts — the session's doors: one-shot HTTP batch at /api (no WebSocket), an
// inline-source worker, and a fetch-shaped target through the session as a dotted `.fetch(request)`
// behind a rewrite rule (the commissioned fork feature carries the Response back).

import { expect, test } from "vitest";
import { freshCtx, httpBatch, openItx } from "./support/client.ts";
import { SOURCES } from "./support/sources.ts";

test("edge adoption: one-shot HTTP batch whoami, inline-source worker, dotted .fetch(request)", async () => {
  // The batch and the live session share ONE ctx (the proof used a single CTX for both).
  const ctx = freshCtx("edge");

  // 1. ONE-SHOT HTTP BATCH: a CLI-shaped client — no WebSocket anywhere
  const who = await httpBatch()
    .authenticate()
    .projects.get(ctx)
    .invoke(["itx", ["whoami"]]);
  // one-shot HTTP batch: whoami without a socket
  expect(who?.projectId).toBe(ctx);

  // live session for the rest
  const itx = openItx(ctx);

  // 2. THE SOURCE IS THE MODULES, handed over INLINE (the files/repo roots died in increment 57,
  //    the producer expression in the one after): hand the code over, run it
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
