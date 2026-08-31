// __workers-tests__/rpc-pipelining.test.ts — pins the RUNTIME contract worker.ts's pipelining
// registration stands on: `cloudflare:workers` exports RpcPromise as a real constructor, and a
// native Workers-RPC call returns an `instanceof` of it. workers-types lags this export (worker.ts
// casts around it) — if workerd ever drops or renames it, this fails LOUDLY instead of the
// registration silently never matching (which would quietly re-await every native chain step).
// The behavioral contract itself is pinned in src/core/dispatch.test.ts ("pipelined RPC promise
// threading") and, for the capnweb one-shot batch where it is CORRECTNESS, by
// e2e/connect.e2e.test.ts's call-then-call test.

import * as cloudflareWorkers from "cloudflare:workers";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { canonicalName } from "../src/core/durable-object-names.ts";
import type { StreamDurableObject } from "../src/stream-durable-object.ts";

test("cloudflare:workers exports RpcPromise and native RPC calls are instanceof it", async () => {
  const RpcPromise = (cloudflareWorkers as unknown as { RpcPromise: abstract new () => unknown })
    .RpcPromise;
  expect(typeof RpcPromise).toBe("function");

  const stub = (
    env as unknown as { CONTEXT: DurableObjectNamespace<StreamDurableObject> }
  ).CONTEXT.getByName(canonicalName("prj_rpc_pipelining"));
  const p = stub.hostState();
  expect(p).toBeInstanceOf(RpcPromise);
  const state = (await p) as Record<string, unknown>;
  expect(typeof state.incarnation).toBe("number");
});
