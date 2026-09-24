// __workers-tests__/facet-claim-due-at-birth.test.ts — a claim a hosted processor holds on its
// context's alarm (`processors.claim`: an attempt in flight, owed a `revive()` by its time) is DUE AT
// THE NEXT BIRTH (context/facet-host.ts, the constructor): the incarnation that ran the attempt is
// over, and work that died with it would otherwise wait out the claim's time. The config repo's
// creation waited 20 s so (2026-09-24, the latency guard) after the platform replaced its context
// under a call (project/collection.ts TERMINAL_WAIT_SLICE_MS). A claim on the ladder of failed
// revives keeps its backoff: a facet that cannot be revived must not cost a revive per birth.
//
// Pinned in the `workers` vitest project: it needs the real facet runtime, a hosted processor SDK
// facet, an eviction and the alarm on demand.

import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { releasePins, stub, until } from "./support.ts";

/** A userspace processor that records each `revive()` in its own SQLite before the engine runs it. */
const REVIVE_COUNTER_SRC = /* js */ `
import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "./processor.js";
const contract = defineProcessorContract({
  slug: "revivecounter",
  version: "1.0.0",
  description: "counts durable events; records every revive",
  stateSchema: z.object({ n: z.number().default(0) }),
  consumes: ["*"],
  emits: [],
});
class ReviveCounterProcessor extends StreamProcessor {
  contract = contract;
  reduce({ state }) { return { n: state.n + 1 }; }
}
export class ReviveCounterDurableObject extends StreamProcessorDurableObject {
  static publicMethods = [...super.publicMethods, "revives"];
  processor = new ReviveCounterProcessor();
  #table() {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS revives (at INTEGER)");
  }
  async revive() {
    this.#table();
    this.ctx.storage.sql.exec("INSERT INTO revives (at) VALUES (?)", Date.now());
    return super.revive();
  }
  revives() {
    this.#table();
    return this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM revives").one().n;
  }
}
`;
const name = "revivecounter";

test("a claim the last incarnation left is revived by the next birth at once, not at the claim's time", async () => {
  const ctx = "prj_claim_due_at_birth";
  const revives = await hostedOn(ctx);
  // What `runInBackground` holds while an attempt is in flight: a claim, here a minute out.
  await stub(ctx).invoke(["itx", "processors", ["claim", name, Date.now() + 60_000]]);
  await releasePins(ctx); // workerd keeps a DO with a live facet resident; the edge does not
  await evictDurableObject(stub(ctx));

  // The birth: the first call of the fresh incarnation. Its alarm is owed now, not in a minute.
  await stub(ctx).invoke(["itx", ["readEvents", 0, 1]]);
  const alarm = await runInDurableObject(stub(ctx), (_instance, state) => state.storage.getAlarm());
  // The harness may already have run it (and the pass spent the claim): no alarm is fine then.
  if (alarm !== null) expect(alarm).toBeLessThanOrEqual(Date.now());
  await runDurableObjectAlarm(stub(ctx));
  await until("the fresh incarnation revived the facet", async () => (await revives()) === 1);
  const claim = await runInDurableObject(stub(ctx), (_instance, state) =>
    state.storage.kv.get(`facet-claim:${name}`),
  );
  expect(claim).toBeUndefined(); // spent by the revive; the facet has no attempt in flight
});

test("a claim on the ladder of failed revives keeps its backoff across a birth", async () => {
  const ctx = "prj_claim_on_ladder_at_birth";
  const revives = await hostedOn(ctx);
  const at = Date.now() + 60_000;
  // A claim put back after a revive threw once (FacetHost `reviveDueClaims`), as its rows stand.
  await runInDurableObject(stub(ctx), (_instance, state) => {
    state.storage.kv.put(`facet-claim:${name}`, at);
    state.storage.kv.put(`facet-claim-failures:${name}`, 1);
  });
  await releasePins(ctx);
  await evictDurableObject(stub(ctx));

  await stub(ctx).invoke(["itx", ["readEvents", 0, 1]]);
  await runDurableObjectAlarm(stub(ctx)); // whatever the birth armed: the claim is not due
  expect(await revives()).toBe(0);
  const claim = await runInDurableObject(stub(ctx), (_instance, state) =>
    state.storage.kv.get(`facet-claim:${name}`),
  );
  expect(claim).toBe(at);
});

/** The processor enabled on `ctx` (`subscription-configured` spelled raw, as in
 *  facet-abort-heals-cut-off-work.test.ts), its configure batch pushed; its revive count. */
async function hostedOn(ctx: string) {
  await stub(ctx).append({
    type: "events.iterate.com/stream/subscription-configured",
    payload: {
      name,
      target: [
        "itx",
        "facets",
        [
          "get",
          name,
          { source: { "cap.js": REVIVE_COUNTER_SRC }, className: "ReviveCounterDurableObject" },
        ],
        "processEventBatch",
      ],
    },
  });
  const revives = () =>
    stub(ctx).invoke(["itx", "facets", ["get", name], ["revives"]]) as Promise<number>;
  await until("the processor is hosted", async () => (await revives()) === 0);
  return revives;
}
