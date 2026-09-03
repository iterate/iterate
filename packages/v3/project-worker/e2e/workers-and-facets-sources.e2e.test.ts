// load-sources.e2e.test.ts — loading code: ONE door per host kind. `itx.workers.get({ source })` (a
// stateless WorkerEntrypoint — its spec is its address) and `itx.facets.get(name, { source, className })`
// (a DurableObject hosted as the durable facet `name`). Plus `itx.facets.get(name)` — the same door,
// addressing a RUNNING facet. The
// SOURCE is the worker's MODULES (module name → code, `"cap.js"` is the main module), handed over
// INLINE at the load site; `itx.runScript(lambda)` is the source-less sugar.

import { RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import { freshCtx, openItx } from "./support/client.ts";

// A loaded SOURCE exports its host — here a WorkerEntrypoint whose `run` is `body`.
const entrypoint = (body: string) =>
  `import { WorkerEntrypoint } from "cloudflare:workers";\nexport default class extends WorkerEntrypoint { ${body} }`;

test("itx.workers.get({ source: src }) (stateless) + itx.facets.get(name, spec) (durable facet) + itx.facets.get(name)", async () => {
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

  // 1. STATELESS: workers.get({ source }) → a WorkerEntrypoint isolate, run it.
  expect(await itx.invoke(`itx.workers.get({ source: ${SRC_GREET} }).run('jonas')`)).toBe(
    "hi jonas",
  );

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
    "workers",
    ["get", { source: { "cap.js": entrypoint("async run(x) { return x * 2; }") } }],
    ["run", 21],
  ]);
  expect(inline).toBe(42);

  // 2. inline code can call back into itx (env.ITX is bound in the confined isolate).
  const withItx = await itx.invoke([
    "itx",
    "workers",
    [
      "get",
      {
        source: {
          "cap.js": entrypoint(
            "async run() { const itx = await this.env.ITX.get(); return (await itx.whoami()).projectId; }",
          ),
        },
      },
    ],
    ["run"],
  ]);
  expect(withItx).toBe(ctx);

  // 3. runScript(lambda) sugar: a bare lambda STRING is wrapped in a WorkerEntrypoint (injecting
  //    itx) and run — no source at all.
  expect(await itx.runScript("async (itx, x) => x * 2", 21)).toBe(42);
});

// ── a PRODUCER source behind a cacheKey: Cloudflare's `get(id, getCode)` contract, end to end ──

test("a source EXPRESSION with a cacheKey is produced ONCE per cold isolate — a warm key never re-runs it, a new key does, and no key is refused", async () => {
  const ctx = freshCtx("cachekey");
  const itx = openItx(ctx);
  // The producer: a LIVE code store the test holds, so every evaluation is countable. In a product it
  // is a build (`itx.build('todo')`) — the expensive thing the key exists to skip.
  class CodeStore extends RpcTarget {
    produced: string[] = [];
    get(name: string): Record<string, string> {
      this.produced.push(name);
      return { "cap.js": entrypoint(`async run(x) { return "${name}:" + x; }`) };
    }
  }
  const codeStore = new CodeStore();
  await itx.provide("itx.codeStore", codeStore);

  // 1. no key → refused at the door; the producer never ran
  await expect(
    itx.invoke(["itx", "workers", ["get", { source: "itx.codeStore.get('greet')" }], ["run", 1]]),
  ).rejects.toThrow(/needs a cacheKey/);
  expect(codeStore.produced).toEqual([]);

  // 2. with a key: the first call produces, the second rides the warm isolate
  const spec = { source: "itx.codeStore.get('greet')", cacheKey: "greet@v1" };
  expect(await itx.invoke(["itx", "workers", ["get", spec], ["run", 1]])).toBe("greet:1");
  expect(await itx.invoke(["itx", "workers", ["get", spec], ["run", 2]])).toBe("greet:2");
  expect(codeStore.produced).toEqual(["greet"]);

  // 3. a new key is a new isolate: produced again (the caller changed the code, so the key)
  expect(
    await itx.invoke([
      "itx",
      "workers",
      ["get", { source: "itx.codeStore.get('greet')", cacheKey: "greet@v2" }],
      ["run", 3],
    ]),
  ).toBe("greet:3");
  expect(codeStore.produced).toEqual(["greet", "greet"]);

  // 4. the same for a FACET: hosted from a producer, the state persists across calls and the
  //    producer ran once; the memo keeps the key so a bare `facets.get(name)` re-materializes it
  class FacetCodeStore extends RpcTarget {
    produced = 0;
    get(): Record<string, string> {
      this.produced++;
      return {
        "cap.js": `import { DurableObject } from "cloudflare:workers";
export class CounterDurableObject extends DurableObject {
  async bump() { const n = ((await this.ctx.storage.get('n')) ?? 0) + 1; await this.ctx.storage.put('n', n); return n; }
}`,
      };
    }
  }
  const facetCodeStore = new FacetCodeStore();
  await itx.provide("itx.facetCodeStore", facetCodeStore);
  const facetSpec = {
    source: "itx.facetCodeStore.get()",
    cacheKey: "counter@v1",
    className: "CounterDurableObject",
  };
  expect(await itx.invoke(["itx", "facets", ["get", "ck", facetSpec], ["bump"]])).toBe(1);
  expect(await itx.invoke(["itx", "facets", ["get", "ck", facetSpec], ["bump"]])).toBe(2);
  expect(await itx.invoke(["itx", "facets", ["get", "ck"], ["bump"]])).toBe(3);
  expect(facetCodeStore.produced).toBe(1);
});
