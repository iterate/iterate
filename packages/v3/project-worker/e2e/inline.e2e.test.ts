// inline.e2e.test.ts — INLINE source (apps/os WorkerFileSource inline), the one source shape that
// isn't a producer expression. Source-loaded code runs via `itx.load(source).getEntrypoint().run(...)`.
// Proves `resolveSource` handles both source shapes: inline code handed over literally, and a
// producer expression (itx.kv.get — the "callback that produces the code"). Also proves the
// `itx.runScript(lambda)` sugar: a bare `"async (itx, ...args) => …"` string is wrapped in a
// WorkerEntrypoint (injecting itx) and run — no source involved.
// (was proofs/prove_inline.mjs)

import { expect, test } from "vitest";
import { freshCtx, openItx } from "./support/client.ts";

// A loaded SOURCE exports its host — here a WorkerEntrypoint whose `run` is `body`.
const entrypoint = (body: string) =>
  `import { WorkerEntrypoint } from "cloudflare:workers";\nexport default class extends WorkerEntrypoint { ${body} }`;

test("resolveSource handles inline + producer-expression sources, and runScript(lambda) sugar", async () => {
  const ctx = freshCtx("inline");
  const itx = openItx(ctx);

  // 1. INLINE source: hand the code over literally — no kv.put, no producer to invoke.
  const inline = await itx.invokeCapability([
    "itx",
    ["load", { type: "inline", files: { "cap.js": entrypoint("async run(x) { return x * 2; }") } }],
    ["getEntrypoint"],
    ["run", 21],
  ]);
  // inline source runs (files handed over literally)
  expect(inline).toBe(42);

  // 2. PRODUCER-EXPRESSION source still works through the same resolveSource path: itx.kv.get is a
  //    callback that produces the code.
  await itx.invokeCapability([
    "itx",
    "kv",
    ["put", "src/triple.js", entrypoint("async run(x) { return x * 3; }")],
  ]);
  const viaExpr = await itx.invokeCapability([
    "itx",
    ["load", "itx.kv.get('src/triple.js')"],
    ["getEntrypoint"],
    ["run", 14],
  ]);
  // producer-expression source runs (the itx.kv.get callback)
  expect(viaExpr).toBe(42);

  // 3. inline code can call back into itx (env.ITX is bound in the confined isolate).
  const withItx = await itx.invokeCapability([
    "itx",
    [
      "load",
      {
        type: "inline",
        files: {
          "cap.js": entrypoint(
            "async run() { const itx = await this.env.ITX.get(); return (await itx.whoami()).projectId; }",
          ),
        },
      },
    ],
    ["getEntrypoint"],
    ["run"],
  ]);
  // inline code calls back into itx (env.ITX bound)
  expect(withItx).toBe(ctx);

  // 4. runScript(lambda) sugar: a bare lambda STRING is wrapped in a WorkerEntrypoint (injecting
  //    itx) and run — no source, no kv.put. This is the new runScript contract.
  const doubled = await itx.runScript("async (itx, x) => x * 2", 21);
  // runScript(lambda) wraps + runs
  expect(doubled).toBe(42);
});
