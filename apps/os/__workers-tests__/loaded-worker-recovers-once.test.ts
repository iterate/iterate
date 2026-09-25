// __workers-tests__/loaded-worker-recovers-once.test.ts — a loaded worker whose cold load failed is
// produced again ONCE for a burst of concurrent callers, not once per caller (context/worker-loader.ts
// `loaderIdGenerations`). prd, 2026-09-24 14:36 UTC: the iterate project's config worker's first
// load after a deploy failed, a scanner sent 4,502 requests in 31 s, and every request ran its own
// producer — ~915 concurrent `repo.modules` calls on one repo facet, its host 503 for ~70 s. Here the
// producer is a loaded facet whose first `modules()` answers nothing (the failed load) and whose
// later ones answer after 300 ms (a cold repo fetch); it counts every call in its own storage.
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import type { ItxExpression } from "iterate/expression";
import { stub } from "./support.ts";

test("a burst of 20 concurrent callers after a failed cold load runs the producer once, and every caller gets the site", async () => {
  const s = stub("prj_loader_recovers_once");
  const producer = { source: { "worker.js": producerSource }, className: "ProducerDurableObject" };
  expect(await s.invoke(["itx", "facets", ["get", "producer", producer], ["runs"]])).toBe(0);
  const site: ItxExpression = [
    "itx",
    "workers",
    ["get", { source: ["itx", "facets", ["get", "producer"], ["modules"]], cacheKey: "site@1" }],
    ["hello"],
  ];
  // the cold load's producer answers no modules, so the load fails inside the loader: its id is dead
  // from here. Called in the object: a rejection over the raw stub is also reported unhandled.
  await expect(runInDurableObject(s, (instance) => instance.invoke(site))).rejects.toThrow(
    /a source is its files/,
  );
  const answers = await Promise.all(Array.from({ length: 20 }, () => s.invoke(site)));
  expect(answers).toEqual(Array.from({ length: 20 }, () => "hi"));
  // the failed load and ONE recovery — before the fix, one recovery per caller: 21
  expect(await s.invoke(["itx", "facets", ["get", "producer"], ["runs"]])).toBe(2);
});

const producerSource = /* js */ `
import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "iterate/sdk";
const contract = defineProcessorContract({
  slug: "producer",
  version: "1.0.0",
  description: "a loaded worker's modules: none on the first call, the site on every later one after 300 ms",
  stateSchema: z.object({}),
  consumes: ["*"],
  emits: [],
});
class ProducerProcessor extends StreamProcessor {
  contract = contract;
  reduce({ state }) { return state; }
}
export class ProducerDurableObject extends StreamProcessorDurableObject {
  static publicMethods = [...super.publicMethods, "modules", "runs"];
  processor = new ProducerProcessor();
  runs() {
    return this.ctx.storage.kv.get("runs") ?? 0;
  }
  async modules() {
    const runs = this.runs() + 1;
    this.ctx.storage.kv.put("runs", runs);
    if (runs === 1) return null; // no modules: the load fails inside the loader
    await new Promise((resolve) => setTimeout(resolve, 300));
    return {
      "worker.js": "import { WorkerEntrypoint } from 'cloudflare:workers'; export default class Site extends WorkerEntrypoint { hello() { return 'hi'; } }",
    };
  }
}
`;
