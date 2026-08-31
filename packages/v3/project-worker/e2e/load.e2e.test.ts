// load.e2e.test.ts — itx.load(source), the Worker-Loader mirror. Load code → a WORKER, then pick the
// host EXPLICITLY via the two accessors Cloudflare exposes: `.getEntrypoint()` (stateless
// WorkerEntrypoint) and `.getDurableObjectClass(name).get(instance?)` (a DurableObject hosted as a
// durable facet). Plus `itx.facets.get(name)` — the separate address-a-RUNNING-facet door.
// (was proofs/prove_load.mjs)

import { expect, test } from "vitest";
import { freshCtx, openItx } from "./support/client.ts";

test("itx.load: getEntrypoint (stateless) + getDurableObjectClass().get() (durable facet) + facets.get()", async () => {
  const itx = openItx(freshCtx("load"));

  // Seed the two sources into kv — each EXPORTS its host object (the contract): a WorkerEntrypoint or
  // a DurableObject class. No host-injected wrapper.
  await itx.invokeCapability([
    "itx",
    "kv",
    [
      "put",
      "src/greet.js",
      `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Greeter extends WorkerEntrypoint {
  async run(name) { return \`hi \${name}\`; }
}`,
    ],
  ]);
  await itx.invokeCapability([
    "itx",
    "kv",
    [
      "put",
      "src/counter.js",
      `import { DurableObject } from "cloudflare:workers";
export class Counter extends DurableObject {
  async bump() { const n = ((await this.ctx.storage.get('n')) ?? 0) + 1; await this.ctx.storage.put('n', n); return n; }
  async value() { return (await this.ctx.storage.get('n')) ?? 0; }
}`,
    ],
  ]);

  const SRC_GREET = `"itx.kv.get('src/greet.js')"`;
  const SRC_COUNTER = `"itx.kv.get('src/counter.js')"`;

  // 1. STATELESS: load → getEntrypoint() → a WorkerEntrypoint isolate, run it.
  expect(await itx.invokeCapability(`itx.load(${SRC_GREET}).getEntrypoint().run('jonas')`)).toBe(
    "hi jonas",
  );

  // 2. DURABLE NAMED: load → getDurableObjectClass('Counter').get('c1') → a facet named 'c1' whose
  //    state persists across calls.
  await itx.invokeCapability(
    `itx.load(${SRC_COUNTER}).getDurableObjectClass('Counter').get('c1').bump()`,
  );
  expect(
    await itx.invokeCapability(
      `itx.load(${SRC_COUNTER}).getDurableObjectClass('Counter').get('c1').bump()`,
    ),
  ).toBe(2);

  // 3. ADDRESS BY NAME: itx.facets.get('c1') reaches the SAME running instance with NO source (via
  //    the durable registration the .get('c1') materialization wrote).
  expect(await itx.invokeCapability(`itx.facets.get('c1').value()`)).toBe(2);

  // 4. a DIFFERENT instance name is INDEPENDENT state.
  expect(
    await itx.invokeCapability(
      `itx.load(${SRC_COUNTER}).getDurableObjectClass('Counter').get('c2').bump()`,
    ),
  ).toBe(1);
});
