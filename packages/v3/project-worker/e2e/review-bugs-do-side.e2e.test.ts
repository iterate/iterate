// e2e/review-bugs-do-side.e2e.test.ts — the itx-door half of one RED proof from the 2026-09-02
// DO-side bug hunt (docs/reviews/2026-09-02-bugs-do-side.md). `test.fails` is the house convention
// for a known-red proof, so the lane stays green; flipping it back to `test` is how a fix is proved.
//
// It lives in the e2e lane rather than __workers-tests__ for one reason: a `getCode` that throws
// leaves an unhandled rejection inside the worker, which the in-process workers lane reports as a
// lane error. Out here the worker is a real process, so the proof is clean — and it is the honest
// altitude anyway: this is the public `itx.workers.get({ source, cacheKey })` door.

import { expect, test } from "vitest";
import { freshCtx, openItx } from "./support/client.ts";

const OK_ENTRYPOINT_SRC = `import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint { hello() { return "hi"; } }`;

// BUG: a source PRODUCER EXPRESSION that throws poisons its `cacheKey` permanently — every later
// load under that key replays the first failure, with the original error, and the producer is never
// run again. The code is unloadable under that key for the life of the loader cache.
// WHY: worker-loader.ts runs the producer INSIDE `env.LOADER.get(id, getCode)`'s callback (the
// 2026-09-02 change: "the producer runs inside `getCode`, i.e. only on a cold isolate"), and the
// runtime caches a failed `getCode` under the id exactly as it caches a successful isolate
// (__workers-tests__/review-bugs-do-side.test.ts pins that platform half). Two things make it stick:
// the id is deliberately LOW-CARDINALITY (`${kind}:${deploy}:${owner}:${cacheKey}` — "the cacheKey
// IS A DOLLAR AMOUNT: NEVER a nonce, timestamp, request id"), so minting a fresh one to recover is
// exactly what the loader doctrine forbids; and for a FACET the startup memo pins `{ source,
// cacheKey }`, so every later `itx.facets.get(name)` — a processor's whole materialization path —
// re-hits the dead key with no way to ask for a re-run.
// The trigger is ordinary and TRANSIENT: the producer reads a build artifact that has not landed
// yet, or calls a lent builder stub that is momentarily RPC_STUB_OFFLINE, or appends to a paused
// stream. One such moment and that build id is dead.
// EXPECTED: a failed producer caches nothing — the next load runs it again and succeeds once its
// inputs are there.
test.fails("a cacheKey whose producer threw once loads fine when the producer would now succeed", async () => {
  const itx = openItx(freshCtx("poisonkey"));
  // The producer is an itx expression that reads the built modules out of the context's own kv —
  // the ordinary "a build capability wrote the artifact, now load it" shape.
  const source = "itx.kv.get('build:cap.js')";
  const cacheKey = "review-bugs:producer-poison:v1"; // a build id: low-cardinality, as required
  const load = (): Promise<unknown> =>
    itx.invoke(["itx", "workers", ["get", { source, cacheKey }], ["hello"]]);

  // 1. The artifact has not landed yet, so the producer throws inside getCode.
  await expect(load()).rejects.toThrow();

  // 2. The build lands. Same producer expression, same key — it would now return the modules.
  await itx.invoke(["itx", "kv", ["put", "build:cap.js", OK_ENTRYPOINT_SRC]]);
  expect(await itx.invoke(["itx", "kv", ["get", "build:cap.js"]])).toContain("hello");

  // 3. …and the key is dead: the load replays the ORIGINAL failure instead of re-running the
  //    producer.
  expect(await load()).toBe("hi");
});
