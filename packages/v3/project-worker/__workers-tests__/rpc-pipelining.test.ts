// __workers-tests__/rpc-pipelining.test.ts — pins the RUNTIME contract worker.ts's pipelining
// registration stands on: `cloudflare:workers` exports RpcPromise as a real constructor, and a
// native Workers-RPC call returns an `instanceof` of it. workers-types lags this export (worker.ts
// casts around it) — if workerd ever drops or renames it, this fails LOUDLY instead of the
// registration silently never matching (which would quietly re-await every native chain step).
// The behavioral contract itself is pinned in src/core/dispatch.test.ts ("pipelined RPC promise
// threading") and, for the capnweb one-shot batch where it is CORRECTNESS, by
// e2e/connect.e2e.test.ts's call-then-call test.

// Side-effect import FIRST: worker.ts's module scope is where the native RpcPromise brand is
// REGISTERED with dispatch.ts. The regression test below fails if that registration disappears.
import "../src/worker.ts";
import * as cloudflareWorkers from "cloudflare:workers";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { evaluate } from "../src/core/dispatch.ts";
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

test("the step walk threads a NATIVE RpcPromise unawaited — regression = this fails", async () => {
  // THE regression detector for the native lane: evaluate() a chain whose call step returns a real
  // workerd RpcPromise, with a property step AFTER it. Pipelined (correct), the walk builds on the
  // promise — the property step yields a still-open RpcProperty; if the walk regressed to
  // await-every-step (or worker.ts's registerPipelinedRpcBrand calls disappeared), the value comes
  // back SETTLED — a plain number — and the instanceof assertion fails loudly.
  const { RpcPromise, RpcProperty } = cloudflareWorkers as unknown as Record<
    "RpcPromise" | "RpcProperty",
    abstract new () => unknown
  >;
  const stub = (
    env as unknown as { CONTEXT: DurableObjectNamespace<StreamDurableObject> }
  ).CONTEXT.getByName(canonicalName("prj_rpc_pipelining"));
  const scope = { itx: { host: () => stub.hostState() } };
  const { value } = await evaluate(scope, ["itx", ["host"], "incarnation"]);
  // NOT the settled number — the chain is still open (a pipelined property off a pipelined call)
  expect(value instanceof RpcProperty || value instanceof RpcPromise).toBe(true);
  expect(typeof (await value)).toBe("number"); // the terminal await settles the pipelined chain
});
