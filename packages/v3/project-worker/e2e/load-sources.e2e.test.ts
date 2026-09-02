// load-sources.e2e.test.ts — itx.load(source), the Worker-Loader mirror. Load code → a WORKER, then
// pick the host EXPLICITLY via the two accessors Cloudflare exposes: `.getEntrypoint()` (stateless
// WorkerEntrypoint) and `itx.facets.get(name, { source, className })` (a DurableObject hosted as the
// durable facet `name`). Plus `itx.facets.get(name)` — the same door, addressing a RUNNING facet. The
// SOURCE is either a producer expression (itx.kv.get — the "callback that produces the code") or
// INLINE files handed over literally; `itx.runScript(lambda)` is the source-less sugar.

import { expect, test } from "vitest";
import { freshCtx, openItx } from "./support/client.ts";

// A loaded SOURCE exports its host — here a WorkerEntrypoint whose `run` is `body`.
const entrypoint = (body: string) =>
  `import { WorkerEntrypoint } from "cloudflare:workers";\nexport default class extends WorkerEntrypoint { ${body} }`;

test("itx.load(src).getEntrypoint() (stateless) + itx.facets.get(name, spec) (durable facet) + itx.facets.get(name)", async () => {
  const itx = openItx(freshCtx("load"));

  // Seed the two sources into kv — each EXPORTS its host object (the contract): a WorkerEntrypoint or
  // a DurableObject class. No host-injected wrapper.
  await itx.kv.put("src/greet.js", entrypoint("async run(name) { return `hi ${name}`; }"));
  await itx.kv.put(
    "src/counter.js",
    `import { DurableObject } from "cloudflare:workers";
export class CounterDurableObject extends DurableObject {
  async bump() { const n = ((await this.ctx.storage.get('n')) ?? 0) + 1; await this.ctx.storage.put('n', n); return n; }
  async value() { return (await this.ctx.storage.get('n')) ?? 0; }
}`,
  );
  const SRC_GREET = `"itx.kv.get('src/greet.js')"`;
  const SRC_COUNTER = `"itx.kv.get('src/counter.js')"`;

  // 1. STATELESS: load → getEntrypoint() → a WorkerEntrypoint isolate, run it.
  expect(await itx.invoke(`itx.load(${SRC_GREET}).getEntrypoint().run('jonas')`)).toBe("hi jonas");

  // 2. DURABLE NAMED: facets.get('c1', { source, className: 'CounterDurableObject' }) → a facet named 'c1' whose
  //    state persists across calls.
  await itx.invoke(
    `itx.facets.get('c1', { source: ${SRC_COUNTER}, className: 'CounterDurableObject' }).bump()`,
  );
  expect(
    await itx.invoke(
      `itx.facets.get('c1', { source: ${SRC_COUNTER}, className: 'CounterDurableObject' }).bump()`,
    ),
  ).toBe(2);

  // 3. ADDRESS BY NAME: itx.facets.get('c1') reaches the SAME running instance with NO source (via
  //    the durable registration the hosting call wrote).
  expect(await itx.invoke(`itx.facets.get('c1').value()`)).toBe(2);

  // 4. a DIFFERENT instance name is INDEPENDENT state.
  expect(
    await itx.invoke(
      `itx.facets.get('c2', { source: ${SRC_COUNTER}, className: 'CounterDurableObject' }).bump()`,
    ),
  ).toBe(1);
});

test("resolveSource handles inline + producer-expression sources, and runScript(lambda) sugar", async () => {
  const ctx = freshCtx("inline");
  const itx = openItx(ctx);

  // 1. INLINE source: hand the code over literally — no kv.put, no producer to invoke.
  const inline = await itx.invoke([
    "itx",
    ["load", { type: "inline", files: { "cap.js": entrypoint("async run(x) { return x * 2; }") } }],
    ["getEntrypoint"],
    ["run", 21],
  ]);
  expect(inline).toBe(42);

  // 2. PRODUCER-EXPRESSION source through the same resolveSource path: itx.kv.get is a callback that
  //    produces the code.
  await itx.kv.put("src/triple.js", entrypoint("async run(x) { return x * 3; }"));
  const viaExpr = await itx.invoke([
    "itx",
    ["load", "itx.kv.get('src/triple.js')"],
    ["getEntrypoint"],
    ["run", 14],
  ]);
  expect(viaExpr).toBe(42);

  // 3. inline code can call back into itx (env.ITX is bound in the confined isolate).
  const withItx = await itx.invoke([
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
  expect(withItx).toBe(ctx);

  // 4. runScript(lambda) sugar: a bare lambda STRING is wrapped in a WorkerEntrypoint (injecting
  //    itx) and run — no source, no kv.put.
  expect(await itx.runScript("async (itx, x) => x * 2", 21)).toBe(42);
});
