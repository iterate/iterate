// __workers-tests__/idle-facet-reads-its-log-once.test.ts — AN IDLE PROCESSOR A ROW PUSHES READS ITS
// LOG ONCE PER INCARNATION, NOT ONCE PER READ. A processor facet's read verbs (`snapshot`,
// `liveSnapshot`) catch up from the log unless the reduce has provably reached the head it was
// SHOWN (iterate/stream/processor.ts). A push shows a head; a facet a row pushes is also told so as
// it starts (`fedByPushes` in its props, context/facet-host.ts), so the head its first catch-up read
// counts as shown too. Without that word, a facet whose row consumes a few types of a busy log
// (`consumes`, as a voice delegate's or a user processor's row does) and that no commit it consumes
// has reached this incarnation re-reads its log through the context on every read: an
// ItxEntrypoint `readEvents` round trip on every `snapshot`. A row that consumes every durable
// event (the platform's own processors) pushes its facet each commit and never paid it. A
// processor NO row pushes still reads every time: a read is the only way it learns of an event.
//
// Pinned in the `workers` project: it needs the real facet host, a loaded SDK facet and its props.
// Run:
//   pnpm exec vitest run --project workers __workers-tests__/idle-facet-reads-its-log-once.test.ts

import { expect, test } from "vitest";
import { stub, until } from "./support.ts";

test("a processor a row pushes, read between commits it does not consume, reads its log once; one appended after is applied before the next read", async () => {
  const ctx = "prj_idle_facet_reads_once";
  await stub(ctx).append({
    type: "events.iterate.com/stream/subscription-configured",
    payload: {
      name: "tally",
      target: ["itx", "facets", ["get", "tally", COUNTING_TALLY_SPEC], "processEventBatch"],
      consumes: ["test/counted"],
    },
  });
  const facet = facetOf(ctx, "tally");
  // The enable caught the facet up from the log: its one read of this incarnation.
  expect(
    await until("the enable's catch-up", async () => (await facet.logReads()) || undefined),
  ).toBe(1);
  const snapshots: unknown[] = [];
  for (let i = 0; i < 5; i++) {
    await stub(ctx).append({ type: "test/noise" }); // the busy log: a commit the row does not push
    snapshots.push((await facet.snapshot()).state);
  }
  expect({ logReads: await facet.logReads(), snapshots }).toEqual({
    logReads: 1,
    snapshots: [{ n: 0 }, { n: 0 }, { n: 0 }, { n: 0 }, { n: 0 }],
  });
  // An event the row consumes is pushed as it commits: the very next read holds it.
  await stub(ctx).append({ type: "test/counted" });
  expect(await facet.snapshot()).toMatchObject({ state: { n: 1 } });
  await stub(ctx).append({ type: "test/noise" }, { type: "test/counted" });
  expect(await facet.snapshot()).toMatchObject({ state: { n: 2 } });
});

test("a processor no row pushes reads its log on every read — the host's word is what lets a head read from the log stand", async () => {
  const ctx = "prj_unpushed_facet_reads_each_time";
  const facet = facetOf(ctx, "plain", COUNTING_TALLY_SPEC); // hosted by expression: no row
  const states: unknown[] = [];
  for (let i = 0; i < 4; i++) {
    await stub(ctx).append({ type: "test/counted" });
    states.push((await facet.snapshot()).state);
  }
  expect({ logReads: await facet.logReads(), states }).toEqual({
    logReads: 4,
    states: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }],
  });
});

/** A tally of `test/counted` events whose host counts its round trips to its context. The
 *  projection is constant, so no live-state delta rides the scope and it runs no background work:
 *  every round trip it makes is a catch-up's read of the log. */
const COUNTING_TALLY_SPEC = {
  source: {
    "cap.js": /* js */ `
import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "./processor.js";
const contract = defineProcessorContract({
  slug: "tally",
  version: "1.0.0",
  description: "counts test/counted events",
  stateSchema: z.object({ n: z.number().default(0) }),
  consumes: ["test/counted"],
  emits: [],
});
class TallyProcessor extends StreamProcessor {
  contract = contract;
  reduce({ state }) { return { n: state.n + 1 }; }
  projectLiveState() { return null; }
}
export class CountingTallyDurableObject extends StreamProcessorDurableObject {
  static publicMethods = [...super.publicMethods, "logReads"];
  processor = new TallyProcessor();
  #roundTrips = 0;
  withItx(call) {
    this.#roundTrips++;
    return super.withItx(call);
  }
  logReads() { return this.#roundTrips; }
}
`,
  },
  className: "CountingTallyDurableObject",
};

/** The counting tally facet `name` on context `ctx`, by itx expression — `spec` hosts it. */
function facetOf(ctx: string, name: string, spec?: typeof COUNTING_TALLY_SPEC) {
  const call = (step: unknown[]) =>
    stub(ctx).invoke(["itx", "facets", spec ? ["get", name, spec] : ["get", name], step]);
  return {
    logReads: () => call(["logReads"]) as Promise<number>,
    snapshot: () => call(["snapshot"]) as Promise<{ offset: number; state: unknown }>,
  };
}
