// prove_inline.mjs — INLINE source (apps/os WorkerFileSource inline), the one source shape that
// isn't a producer expression. Proves `resolveSource` handles both: inline code handed over
// literally, and a producer expression (itx.kv.get — the "callback that produces the code").
import { newWebSocketRpcSession } from "capnweb";

const BASE = "project-worker.iterate.workers.dev";
const CTX = process.env.CTX ?? `prj_inline${Date.now() % 100000}`;
let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const itx = await newWebSocketRpcSession(`wss://${BASE}/api?ctx=${CTX}`).authenticate().get();

// 1. INLINE source: hand the code over literally — no kv.put, no producer to invoke.
const inline = await itx.invoke([
  "itx",
  ["runScript", { type: "inline", files: { "cap.js": "export default (itx, x) => x * 2;" } }, 21],
]);
check(inline === 42, "inline source runs (files handed over literally)", String(inline));

// 2. PRODUCER-EXPRESSION source still works through the same resolveSource path: itx.kv.get is a
//    callback that produces the code.
await itx.invokeCapability({
  path: ["kv", "put"],
  args: ["src/triple.js", "export default (itx, x) => x * 3;"],
});
const viaExpr = await itx.invoke(["itx", ["runScript", "itx.kv.get('src/triple.js')", 14]]);
check(viaExpr === 42, "producer-expression source runs (the itx.kv.get callback)", String(viaExpr));

// 3. inline code can call back into itx (env.ITX is bound in the confined isolate).
const withItx = await itx.invoke([
  "itx",
  [
    "runScript",
    {
      type: "inline",
      files: { "cap.js": "export default async (itx) => (await itx.whoami()).projectId;" },
    },
  ],
]);
check(withItx === CTX, "inline code calls back into itx (env.ITX bound)", String(withItx));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
