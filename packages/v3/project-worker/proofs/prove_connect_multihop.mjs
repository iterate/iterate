// prove_connect_multihop.mjs — DEMONSTRATES the multi-hop bug in itx.connectToCapnweb(url).
//
// itx.connectToCapnweb(url) returns an InvokeHandle whose fold lands in
// invokePath(newHttpBatchRpcSession(url), path, args) → walkSteps (src/core/dispatch.ts).
// walkSteps does `value = await value` BETWEEN steps. On a one-shot HTTP-BATCH capnweb session
// an intermediate await FLUSHES the batch (capnweb rule: build the whole chain with NO awaits),
// so a MULTI-hop chain (`.math.add(2,3)` = one property hop THEN a call) dies on the second hop
// with "Batch RPC request ended." A SINGLE hop (`.hello('world')`, one call) awaits only at the
// end, so it survives. The built-in's own header advertises the multi-hop shape
// (`itx.os.projects.get(id).rename(...)`), so this is a LATENT bug, not a missed optimization.
//
// EXPECTED on the current deploy: single-hop PASSES, multi-hop FAILS (red). Do NOT "fix" this file.
import { newWebSocketRpcSession } from "capnweb";

const BASE = "project-worker.iterate.workers.dev";
const REMOTE = "https://dummy-capnweb.iterate.workers.dev/api";
const CTX = process.env.CTX ?? `prj_multihop${Date.now() % 100000}`;
let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const itx = await newWebSocketRpcSession(`wss://${BASE}/api?ctx=${CTX}`).authenticate().get();

// 1. CONTROL — single-hop still works (one await at the end, batch never flushed mid-chain).
//    This isolates the bug to multi-hop: the outbound-capnweb primitive itself is healthy.
{
  let greeting;
  try {
    greeting = await itx.invokeCapability(`itx.connectToCapnweb('${REMOTE}').hello('world')`);
  } catch (e) {
    greeting = `THREW: ${e?.name}: ${e?.message}`;
  }
  check(
    greeting === "hi world from dummy-capnweb",
    "SINGLE-hop connectToCapnweb(url).hello('world')",
    String(greeting),
  );
}

// 2. THE BUG — multi-hop `.math.add(2,3)` should return 5, but walkSteps awaits `session.math`
//    between the property hop and the `.add(...)` call, flushing the one-shot batch. Expected RED.
{
  let result, threw;
  try {
    result = await itx.invokeCapability(`itx.connectToCapnweb('${REMOTE}').math.add(2, 3)`);
  } catch (e) {
    threw = e;
  }
  if (threw) {
    check(
      false,
      "MULTI-hop connectToCapnweb(url).math.add(2,3) === 5",
      `THREW ${threw?.name}: ${threw?.message}`,
    );
  } else {
    check(
      result === 5,
      "MULTI-hop connectToCapnweb(url).math.add(2,3) === 5",
      `returned ${String(result)}`,
    );
  }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
