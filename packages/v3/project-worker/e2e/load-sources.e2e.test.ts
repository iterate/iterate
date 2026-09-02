// load-sources.e2e.test.ts — itx.load(source), the Worker-Loader mirror. Load code → a WORKER, then
// pick the host EXPLICITLY via the two accessors Cloudflare exposes: `.getEntrypoint()` (stateless
// WorkerEntrypoint) and `itx.facets.get(name, { source, className })` (a DurableObject hosted as the
// durable facet `name`). Plus `itx.facets.get(name)` — the same door, addressing a RUNNING facet. The
// SOURCE is the worker's MODULES (module name → code, `"cap.js"` is the main module), handed over
// INLINE at the load site; `itx.runScript(lambda)` is the source-less sugar.

import { expect, test } from "vitest";
import { freshCtx, openItx } from "./support/client.ts";

// A loaded SOURCE exports its host — here a WorkerEntrypoint whose `run` is `body`.
const entrypoint = (body: string) =>
  `import { WorkerEntrypoint } from "cloudflare:workers";\nexport default class extends WorkerEntrypoint { ${body} }`;

test("itx.load(src).getEntrypoint() (stateless) + itx.facets.get(name, spec) (durable facet) + itx.facets.get(name)", async () => {
  const itx = openItx(freshCtx("load"));

  // The two sources, handed over INLINE — each EXPORTS its host object (the contract): a
  // WorkerEntrypoint or a DurableObject class. No host-injected wrapper.
  const SRC_GREET = JSON.stringify({
    "cap.js": entrypoint("async run(name) { return `hi ${name}`; }"),
  });
  const SRC_COUNTER = JSON.stringify({
    "cap.js": `import { DurableObject } from "cloudflare:workers";
export class CounterDurableObject extends DurableObject {
  async bump() { const n = ((await this.ctx.storage.get('n')) ?? 0) + 1; await this.ctx.storage.put('n', n); return n; }
  async value() { return (await this.ctx.storage.get('n')) ?? 0; }
}`,
  });

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

test("the load door takes the modules INLINE, and runScript(lambda) sugar", async () => {
  const ctx = freshCtx("inline");
  const itx = openItx(ctx);

  // 1. THE source: the modules, handed over literally at the load site — nothing to fetch first.
  const inline = await itx.invoke([
    "itx",
    ["load", { "cap.js": entrypoint("async run(x) { return x * 2; }") }],
    ["getEntrypoint"],
    ["run", 21],
  ]);
  expect(inline).toBe(42);

  // 2. inline code can call back into itx (env.ITX is bound in the confined isolate).
  const withItx = await itx.invoke([
    "itx",
    [
      "load",
      {
        "cap.js": entrypoint(
          "async run() { const itx = await this.env.ITX.get(); return (await itx.whoami()).projectId; }",
        ),
      },
    ],
    ["getEntrypoint"],
    ["run"],
  ]);
  expect(withItx).toBe(ctx);

  // 3. runScript(lambda) sugar: a bare lambda STRING is wrapped in a WorkerEntrypoint (injecting
  //    itx) and run — no source at all.
  expect(await itx.runScript("async (itx, x) => x * 2", 21)).toBe(42);
});
