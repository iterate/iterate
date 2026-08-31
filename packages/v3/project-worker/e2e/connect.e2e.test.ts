// connect.e2e.test.ts — itx.connectToCapnweb(url): dial a REMOTE capnweb API from inside the DO and
// call it over ONE one-shot HTTP batch (no persistent socket, so the remote never pins this DO — the
// outbound-capnweb primitive `itx.os` will be sugar over). The remote is the dummy capnweb API the
// globalSetup hosts in-process (was proofs/dummy-capnweb, a separately-deployed worker).
// (was proofs/prove_connect.mjs + proofs/prove_connect_multihop.mjs)

import { expect, test } from "vitest";
import { bareItx, freshCtx } from "./support/client.ts";

const remote = (): string => process.env.DUMMY_CAPNWEB_URL!;

test("connectToCapnweb dials a remote capnweb API and is mountable", async () => {
  const itx = bareItx(freshCtx("conn"));

  // 1. dial the remote capnweb API and call a method (one HTTP batch, no persistent socket)
  expect(await itx.invokeCapability(`itx.connectToCapnweb('${remote()}').hello('world')`)).toBe(
    "hi world from dummy-capnweb",
  );

  // 2. a second method with numeric args
  expect(await itx.invokeCapability(`itx.connectToCapnweb('${remote()}').add(2, 40)`)).toBe(42);

  // 3. NAMED as a mount — this is exactly how `itx.os` becomes sugar over connectToCapnweb.
  await itx.provide({ path: "itx.remoteApi", target: `itx.connectToCapnweb('${remote()}')` });
  expect(await itx.invokeCapability("itx.remoteApi.hello('mounted')")).toBe(
    "hi mounted from dummy-capnweb",
  );
});

// The once-RED multi-hop shape, now the regression pin: `.math.add(2,3)` is a PROPERTY hop to a
// nested RpcTarget then a call. walkSteps used to `await` between the hops, flushing the one-shot
// batch ("Batch RPC request ended"); the fold now pipelines the whole chain with no intervening
// awaits. (was proofs/prove_connect_multihop.mjs, RED then; the fix landed with the Kenton-review
// round.)
test("MULTI-hop connectToCapnweb(url).math.add(2,3) pipelines into one batch", async () => {
  const itx = bareItx(freshCtx("connmh"));
  expect(await itx.invokeCapability(`itx.connectToCapnweb('${remote()}').math.add(2, 3)`)).toBe(5);
});

// STILL-RED pin: a capability returned from a CALL, then called — `.svc('math').add(2,3)` — is the
// exact `itx.os.projects.get(id).rename(…)` shape the built-in's header advertises, and it still
// dies with "Batch RPC request ended": the expression dispatcher awaits between the two CALLS, and
// on a one-shot batch that await flushes the batch before the second call (verified 2026-08-31 —
// the property-hop fix above does not cover call-then-call).
test.fails("call-then-call chain .svc('math').add(2,3) through the one-shot batch", async () => {
  const itx = bareItx(freshCtx("conncc"));
  expect(await itx.invokeCapability(`itx.connectToCapnweb('${remote()}').svc('x').add(2, 3)`)).toBe(
    5,
  );
});
