// __workers-tests__/facet-push-timeout-heals.test.ts — a facet push the watchdog TIMES OUT is not
// lost. `FacetHost#callFacet` bounds every facet call at FACET_CALL_WATCHDOG_MS
// (60 s) and aborts the facet when it fires; the timed-out batch was never checkpointed, and a
// facet push is on no retry ladder (subscription-delivery.ts: at-least-once for facets is the
// facet's own gap repair on its NEXT push). Before this pin, with no later event the row's state
// stayed stale until something else touched the facet (measured 2026-09-13). Now the delivery
// loop owes the restarted facet ONE catch-up from the log per timed-out push
// (`#catchUpAfterPushTimeout`): the batch lands within seconds of the abort, reduced exactly once.
// (The configure batch itself is never the owed one: the enable's catch-up has reduced it before
// it is pushed — so the slow push here is the first APPENDED event's.)
//
// Real time, the real 60 s constant (a copy below, so a change shows up here). Pinned in the
// `workers` vitest project because it needs the real facet runtime (`ctx.facets`, the abort) and
// a hosted processor SDK facet. Long by nature: ~70 s.

import { expect, test } from "vitest";
import { stub, until } from "./support.ts";

/** FACET_CALL_WATCHDOG_MS (not exported — a copy, so a change to the constant shows up here). */
const WATCHDOG_MS = 60_000;
/** The slow push outlives the watchdog by 5 s. */
const SLOW_MS = WATCHDOG_MS + 5_000;

/** A userspace processor (alarm-and-pins.test.ts's counter) whose SECOND pushed batch — the first
 *  appended event's; the first is the configure batch — sleeps past the watchdog BEFORE the
 *  checkpoint write, the position of a slow `blockProcessorWhile`. Every
 *  batch that reaches `processEventBatch` is recorded in the facet's own SQLite (`seen`) before the
 *  delay, so a redelivery is a second row; the slow decision is module-level, so no later attempt
 *  is slow. `probe()` reads both tables WITHOUT touching the engine (a read verb would catch up). */
const SLOW_COUNTER_SRC = /* js */ `
import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "./processor.js";
const contract = defineProcessorContract({
  slug: "slowcounter",
  version: "1.0.0",
  description: "counts durable events; its SECOND pushed batch takes ${SLOW_MS} ms",
  stateSchema: z.object({ n: z.number().default(0) }),
  consumes: ["*"],
  emits: [],
});
let moduleBatches = 0;
class SlowCounterProcessor extends StreamProcessor {
  contract = contract;
  reduce({ state }) { return { n: state.n + 1 }; }
}
export class SlowCounterDurableObject extends StreamProcessorDurableObject {
  static publicMethods = [...super.publicMethods, "probe"];
  processor = new SlowCounterProcessor();
  #seen() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS seen (seq INTEGER PRIMARY KEY AUTOINCREMENT, after INTEGER, through INTEGER, offsets TEXT, slept INTEGER, at INTEGER)",
    );
  }
  async processEventBatch(events, range) {
    this.#seen();
    const slept = moduleBatches === 1;
    moduleBatches++;
    this.ctx.storage.sql.exec(
      "INSERT INTO seen (after, through, offsets, slept, at) VALUES (?, ?, ?, ?, ?)",
      range.after, range.through, JSON.stringify(events.map((e) => e.offset)), slept ? 1 : 0, Date.now(),
    );
    if (slept) await new Promise((r) => setTimeout(r, ${SLOW_MS}));
    return super.processEventBatch(events, range);
  }
  probe() {
    this.#seen();
    let checkpoints = [];
    try {
      checkpoints = this.ctx.storage.sql
        .exec("SELECT slug, reduced_through_offset, state FROM reduce_checkpoints")
        .toArray();
    } catch {}
    return { seen: this.ctx.storage.sql.exec("SELECT * FROM seen").toArray(), checkpoints };
  }
}
`;

test(
  "a push the watchdog timed out is caught up from the log by the restarted facet — no later event needed, reduced exactly once",
  { timeout: 150_000 },
  async () => {
    const ctx = "prj_facet_push_timeout_heals";
    const name = "slowcounter";
    // `itx.processors.enable(name, { source, className })` spelled raw at the DO's `append` method
    // (alarm-and-pins.test.ts): ONE subscription-configured whose target is the facet's
    // processEventBatch through the load chain.
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
            { source: { "cap.js": SLOW_COUNTER_SRC }, className: "SlowCounterDurableObject" },
          ],
          "processEventBatch",
        ],
      },
    });
    type Probe = {
      seen: Array<{ seq: number; after: number; through: number; offsets: string; slept: number }>;
      checkpoints: Array<{ slug: string; reduced_through_offset: number; state: string }>;
    };
    const probe = () =>
      stub(ctx).invoke(["itx", "facets", ["get", name], ["probe"]]) as Promise<Probe>;
    // The enable catches the facet up and then pushes the configure batch (fast, already reduced).
    const enabled = await until("the configure batch was pushed", async () => {
      const p = await probe();
      return p.seen.length === 1 ? p : undefined;
    });
    expect(Number(enabled.seen[0]!.slept)).toBe(0);
    // ONE appended event: its push is THE slow one, and it is the batch the checkpoint lacks.
    const [owed] = (await stub(ctx).append({ type: "pin/owed" })) as { offset: number }[];
    const owedThrough = owed!.offset;
    const t0 = Date.now();
    const slowPush = await until("the slow push has started", async () => {
      const p = await probe();
      return p.seen.length === 2 ? p : undefined;
    });
    expect(slowPush.seen[1]).toMatchObject({ through: owedThrough, slept: 1 });
    expect(slowPush.checkpoints[0]!.reduced_through_offset).toBeLessThan(owedThrough);

    // Nothing else is appended. The watchdog fires at 60 s and aborts the facet; the delivery loop's
    // catch-up re-materializes it and it reads the owed span from the log (`catchUpFromLog` — no
    // `seen` row: only `processEventBatch` writes one) — the checkpoint reaches the owed offset well before
    // anything else would have touched it.
    const healed = await until(
      "the restarted facet caught up past the timed-out batch",
      async () => {
        const p = await probe();
        return p.checkpoints.some((c) => c.reduced_through_offset >= owedThrough) ? p : undefined;
      },
      WATCHDOG_MS + 20_000,
    );
    const healedAtMs = Date.now() - t0;
    expect(healedAtMs).toBeGreaterThanOrEqual(WATCHDOG_MS - 1_000); // not before the watchdog fired
    expect(healedAtMs).toBeLessThan(WATCHDOG_MS + 20_000); // and soon after it
    // Exactly once: the slow attempt persisted nothing and was not re-pushed; the catch-up reduced
    // the span once.
    expect(healed.seen.map((row) => Number(row.slept))).toEqual([0, 1]);
    const [checkpoint] = healed.checkpoints;
    expect(checkpoint?.slug).toBe(name);
    // Every durable event, each incarnation's wake record included: what a "*" row sees.
    const durableEvents = (
      (await stub(ctx).invoke(["itx", ["readEvents", 0, 500]])) as { events: unknown[] }
    ).events.length;
    expect(JSON.parse(checkpoint!.state)).toEqual({ n: durableEvents });

    // And the row is live: the next append lands as an ordinary push, once.
    await stub(ctx).append({ type: "pin/after-heal" });
    const after = await until("the next push landed", async () => {
      const p = await probe();
      return p.checkpoints[0]!.reduced_through_offset > checkpoint!.reduced_through_offset
        ? p
        : undefined;
    });
    expect(after.seen).toHaveLength(3);
    expect(JSON.parse(after.checkpoints[0]!.state)).toEqual({ n: durableEvents + 1 });
  },
);
