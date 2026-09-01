// edge.e2e.test.ts — the edge-adoption batch: one-shot HTTP batch at /api (no WebSocket),
// a fetch-shaped capability through the session as a dotted `.fetch(request)` (the commissioned fork
// feature carries the Response back), disableProcessor, the repo.
// (was proofs/prove_edge.mjs)

import { expect, test } from "vitest";
import { freshCtx, httpBatch, openItx } from "./support/client.ts";
import { seedSources } from "./support/sources.ts";

test("edge adoption: one-shot HTTP batch whoami, kv-source worker, dotted .fetch(request), disableProcessor", async () => {
  // The batch and the live session share ONE ctx (the proof used a single CTX for both).
  const ctx = freshCtx("edge");

  // 1. ONE-SHOT HTTP BATCH: a CLI-shaped client — no WebSocket anywhere
  const who = await httpBatch()
    .authenticate()
    .projects.get(ctx)
    .invokeCapability(["itx", ["whoami"]]);
  // one-shot HTTP batch: whoami without a socket
  expect(who?.projectId).toBe(ctx);

  // live session for the rest
  const itx = openItx(ctx);
  await seedSources(itx, ["site"]);

  // 2. SOURCE IS PLAIN KV (the files/repo roots died in increment 57): put source, run it
  await itx.invokeCapability([
    "itx",
    "kv",
    [
      "put",
      "src/mine.js",
      `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Mine extends WorkerEntrypoint {
  async run() {
    const itx = await this.env.ITX.get();
    return \`from-kv:\${(await itx.whoami()).projectId}\`;
  }
}`,
    ],
  ]);
  const out = await itx.invokeCapability(
    `itx.load("itx.kv.get('src/mine.js')").getEntrypoint().run()`,
  );
  // kv-stored source runs as a worker (itx round-trip inside)
  expect(out).toBe(`from-kv:${ctx}`);

  // 3. a fetch-shaped capability through the SESSION (no /cap door): the terminal `.fetch(request)`
  //    rides the DO's fetch channel with the capability in x-itx-cap — one routing rule, no verb
  await itx.provide("itx.site", `itx.load("itx.kv.get('src/site.js')").getEntrypoint()`);
  const resp = await itx.site.fetch(new Request("https://itx.site/"));
  const html = await resp.text();
  // the Response rides back over capnweb
  expect(resp.status).toBe(200);
  expect(html).toContain("dynamic web capability");

  // 4. disableProcessor: enable, disable, snapshot now refuses
  await itx.enableProcessor("tally");
  await itx.invokeCapability(`itx.append({ type: 'mark' })`);
  await itx.disableProcessor("tally");
  let denied = "";
  try {
    await itx.invokeCapability("itx.facets.get('tally').snapshot()");
  } catch (e) {
    denied = String(e);
  }
  // disabled processor is gone (row + facet deleted)
  expect(denied).toMatch(/no facet/);
});
