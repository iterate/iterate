// __workers-tests__/rpc-pipelining.test.ts — pins the RUNTIME contract worker.ts's pipelining
// registration stands on: `cloudflare:workers` exports RpcPromise as a real constructor, and a
// native Workers-RPC call returns an `instanceof` of it. workers-types lags this export (worker.ts
// casts around it) — if workerd ever drops or renames it, this fails LOUDLY instead of the
// registration silently never matching (which would quietly re-await every native chain step).
// The behavioral contract itself is pinned in src/context/dispatch.test.ts ("pipelined RPC promise
// threading") and, for the capnweb one-shot batch where it is CORRECTNESS, by
// the e2e lane's remote-capnweb call-then-call test.

// Side-effect import FIRST: worker.ts's module scope is where the native RpcPromise brand is
// REGISTERED with dispatch.ts. The regression test below fails if that registration disappears.
import "../src/worker.ts";
import * as cloudflareWorkers from "cloudflare:workers";
import { expect, test } from "vitest";
import { walkSteps } from "../src/context/dispatch.ts";
import { stub } from "./support.ts";

test("cloudflare:workers exports RpcPromise and native RPC calls are instanceof it", async () => {
  const RpcPromise = (cloudflareWorkers as unknown as { RpcPromise: abstract new () => unknown })
    .RpcPromise;
  expect(typeof RpcPromise).toBe("function");

  const p = stub("prj_rpc_pipelining").rpcStubTransportState();
  expect(p).toBeInstanceOf(RpcPromise);
  const state = await p;
  expect(typeof state.rpcStubPagers).toBe("number");
});

test("the step walk threads a NATIVE RpcPromise unawaited — regression = this fails", async () => {
  // THE regression detector for the native lane: walk a chain whose call step returns a real
  // workerd RpcPromise, with a property step AFTER it. Pipelined (correct), the walk builds on the
  // promise — the property step yields a still-open RpcProperty; if the walk regressed to
  // await-every-step (or worker.ts's registerPipelinedRpcBrand calls disappeared), the value comes
  // back SETTLED — a plain number — and the instanceof assertion fails loudly.
  const { RpcPromise, RpcProperty } = cloudflareWorkers as unknown as Record<
    "RpcPromise" | "RpcProperty",
    abstract new () => unknown
  >;
  const itx = { transport: () => stub("prj_rpc_pipelining").rpcStubTransportState() };
  const { value } = await walkSteps(
    { value: itx, receiver: undefined },
    [["transport"], "rpcStubPagers"],
    "expression",
  );
  // NOT the settled number — the chain is still open (a pipelined property off a pipelined call)
  expect(value instanceof RpcProperty || value instanceof RpcPromise).toBe(true);
  expect(typeof (await value)).toBe("number"); // the terminal await settles the pipelined chain
});
