// __workers-tests__/facet-timeout-restart-heals-sibling-push.test.ts — a facet call the watchdog
// TIMES OUT restarts the facet (context/facet-host.ts `#call`, FACET_CALL_WATCHDOG_MS), and the
// restart's abort cuts off every OTHER call still in flight on that instance. The timed-out call
// is the one that failed: it stays TIMEOUT. The others did not time out — the facet they ran on
// was restarted under them — so they reject FACET_RESTARTED, exactly like a call a restart under a
// new loaded identity cut off (facet-restart-heals-cut-off-push.test.ts): a cut-off PUSH is owed
// one catch-up from the log on the new instance, logged as `delivery.facet-restarted-in-flight`,
// never a `subscription-delivery.deliver` issue.
//
// Real time, the real 60 s watchdog (a copy below). Pinned in the `workers` vitest project because
// it needs the real facet runtime (`ctx.facets`, its abort) and a hosted processor SDK facet.
// Long by nature: ~62 s (a long pole, apps/os/vitest.config.ts).

import { errorCode } from "iterate/lib";
import { expect, test, vi } from "vitest";
import { readLog, stub, until } from "./support.ts";

/** FACET_CALL_WATCHDOG_MS (not exported — a copy, so a change to the constant shows up here). */
const WATCHDOG_MS = 60_000;
const name = "timedoutsibling";

test(
  "a push in flight on a facet a sibling call's timeout restarts rejects FACET_RESTARTED — logged, caught up on the new instance, never an issue; the timed-out call stays TIMEOUT",
  { timeout: WATCHDOG_MS + 60_000 },
  async () => {
    const ctx = "prj_facet_timeout_restart_heals_sibling_push";
    const s = stub(ctx);
    await s.append({
      type: "events.iterate.com/itx/subscription-configured",
      payload: {
        name,
        target: [
          "itx",
          "facets",
          [
            "get",
            name,
            { source: { "worker.js": SOURCE }, className: "TimedOutSiblingDurableObject" },
          ],
          "processEventBatch",
        ],
      },
    });
    await until("the configure batch was pushed", async () => (await probe(ctx)).seen.length === 1);

    // The call that will time out: in flight FIRST, so its watchdog fires first.
    const stalled = (
      s.invoke(["itx", "facets", ["get", name], ["stall"]]) as Promise<unknown>
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    await until("the stalling call is on the facet", async () => (await probe(ctx)).stalls === 1);
    // The sibling: a push that hangs on the same instance.
    const [owed] = (await s.append({ type: "pin/hang" })) as { offset: number }[];
    await until(
      "the hanging push is on the facet",
      async () => (await probe(ctx)).seen.length === 2,
    );

    const errors = vi.spyOn(console, "error");
    const logs = vi.spyOn(console, "log");

    // The watchdog times the stalled call out and restarts the facet; that call stays TIMEOUT.
    const timedOut = await stalled;
    expect(errorCode(timedOut)).toBe("TIMEOUT");

    const cutOff = await until("the cut-off push is logged as the restart", async () =>
      logs.mock.calls
        .flat()
        .find((line) => JSON.stringify(line).includes('"delivery.facet-restarted-in-flight"')),
    );
    expect(cutOff).toMatchObject({
      name,
      failureSite: "subscription-delivery.deliver",
      code: "FACET_RESTARTED",
    });
    const healed = await until("the new instance reduced past the cut-off batch", async () => {
      const p = await probe(ctx);
      return p.checkpoints.some((c) => c.reduced_through_offset >= owed!.offset) ? p : undefined;
    });
    expect(healed.seen.filter((row) => Number(row.hung) === 1)).toHaveLength(1); // never re-pushed
    const events = await readLog(ctx);
    expect(JSON.parse(healed.checkpoints[0]!.state)).toEqual({ n: events.length }); // each once
    expect(
      ((await s.invoke(["itx", "subscriptions", ["get", name]])) as { halted?: unknown }).halted,
    ).toBeUndefined();
    expect(
      errors.mock.calls.flat().filter((line) => JSON.stringify(line).includes('"issue"')),
    ).toEqual([]);
  },
);

function probe(ctx: string) {
  return stub(ctx).invoke(["itx", "facets", ["get", name], ["probe"]]) as Promise<{
    stalls: number;
    seen: Array<{ through: number; hung: number }>;
    checkpoints: Array<{ reduced_through_offset: number; state: string }>;
  }>;
}

/** A userspace processor with a `stall()` that never answers, and a push that HANGS forever on a
 *  batch carrying a `pin/hang` event; each is recorded in the facet's own SQLite first. `probe()`
 *  reads those and the checkpoint without touching the engine. */
const SOURCE = /* js */ `
import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "iterate/sdk";
const contract = defineProcessorContract({
  slug: "${name}",
  version: "1.0.0",
  description: "counts durable events; hangs forever on a pin/hang batch and on stall()",
  stateSchema: z.object({ n: z.number().default(0) }),
  consumes: ["*"],
  emits: [],
});
class TimedOutSiblingProcessor extends StreamProcessor {
  contract = contract;
  reduce({ state }) { return { n: state.n + 1 }; }
}
export class TimedOutSiblingDurableObject extends StreamProcessorDurableObject {
  static publicMethods = [...super.publicMethods, "probe", "stall"];
  processor = new TimedOutSiblingProcessor();
  #tables() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS seen (seq INTEGER PRIMARY KEY AUTOINCREMENT, through INTEGER, hung INTEGER)",
    );
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS stalls (seq INTEGER PRIMARY KEY AUTOINCREMENT)");
  }
  async stall() {
    this.#tables();
    this.ctx.storage.sql.exec("INSERT INTO stalls DEFAULT VALUES");
    await new Promise(() => {});
  }
  async processEventBatch(events, range) {
    this.#tables();
    const hang = events.some((e) => e.type === "pin/hang");
    this.ctx.storage.sql.exec("INSERT INTO seen (through, hung) VALUES (?, ?)", range.through, hang ? 1 : 0);
    if (hang) await new Promise(() => {});
    return super.processEventBatch(events, range);
  }
  probe() {
    this.#tables();
    let checkpoints = [];
    try {
      checkpoints = this.ctx.storage.sql
        .exec("SELECT reduced_through_offset, state FROM reduce_checkpoints")
        .toArray();
    } catch {}
    return {
      stalls: this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM stalls").one().n,
      seen: this.ctx.storage.sql.exec("SELECT * FROM seen").toArray(),
      checkpoints,
    };
  }
}
`;
