// workers-remote-capnweb.e2e.test.ts — dialing a REMOTE capnweb API is USERSPACE: a WorkerEntrypoint
// loaded through `itx.workers.get({ source, className, props })` imports capnweb's client from the SDK
// (`./processor.js`), reads the remote's url from Cloudflare's own `ctx.props`, and dials it over ONE
// one-shot HTTP batch through the context's egress. No built-in, no persistent socket, so the remote
// never pins the context DO. Behind a rewrite rule at a name, it is exactly how an `itx.os` would be
// sugar. The remote is THIS worker's own /api — another project of the same worker — so the proof
// runs identically locally and deployed, with no stand-in server.

import { expect, test } from "vitest";
import { freshCtx, openItx, workerUrl } from "./support/client.ts";

// The whole remote-dialing worker, handed over inline. Each method builds ONE capnweb chain with no
// intervening awaits (the one-shot batch flushes on the first await), so even the call → property →
// call → call chain (`authenticate().projects.get(id).whoami()`, the `itx.os.projects.get(id).rename(…)`
// shape) rides one POST.
const SRC_REMOTE = {
  "cap.js": /* js */ `
import { WorkerEntrypoint } from "cloudflare:workers";
import { newHttpBatchRpcSession } from "./processor.js";
export class Remote extends WorkerEntrypoint {
  #api() { return newHttpBatchRpcSession(this.ctx.props.url); }
  whoami() { return this.#api().authenticate().projects.get(this.ctx.props.projectId).whoami(); }
}
`,
};

test("a userspace worker dials a remote capnweb API with the url in ctx.props, behind a rewrite rule by name — one batch per chain", async () => {
  const other = freshCtx("conn-other");
  const itx = openItx(freshCtx("conn"));
  await itx.provide("itx.remoteApi", [
    "itx",
    "workers",
    [
      "get",
      {
        source: SRC_REMOTE,
        className: "Remote",
        props: { url: workerUrl("/api"), projectId: other },
      },
    ],
  ]);
  // 1. one method, one HTTP batch, through the rule
  expect(await itx.remoteApi.whoami()).toEqual({ projectId: other, path: "/" });
  // 2. the same rule by expression string — a rule is a rule
  expect(await itx.invoke("itx.remoteApi.whoami()")).toEqual({ projectId: other, path: "/" });
});
