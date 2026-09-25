// __workers-tests__/facet-restart-heals-cut-off-push.test.ts — a facet whose LOADED IDENTITY changes
// (its source re-configured, a deploy, a fresh loader generation) is restarted in place by the
// context (context/facet-host.ts `#materialize`), and the restart's abort cuts off any call still in
// flight on the old instance. That is an outcome of the change, modeled, not reported: the host
// rejects the cut-off call FACET_RESTARTED, and a cut-off PUSH is owed one catch-up from the log on
// the new instance (subscription-delivery.ts), exactly as a push `itx.facets.abort` cut off
// (facet-abort-heals-cut-off-work.test.ts) — logged as `delivery.facet-restarted-in-flight`, never
// a `subscription-delivery.deliver` issue.
//
// Pinned in the `workers` vitest project because it needs the real facet runtime (`ctx.facets`, its
// abort) and a hosted processor SDK facet.

import { expect, test, vi } from "vitest";
import { readLog, stub, until } from "./support.ts";

const name = "restartedcounter";

test("a push in flight on a facet restarted under a new loaded identity rejects FACET_RESTARTED — logged, caught up on the new instance, never an issue", async () => {
  const ctx = "prj_facet_restart_heals_its_push";
  const s = stub(ctx);
  await configure(ctx, hangingCounterSource(true));
  await until("the configure batch was pushed", async () => (await probe(ctx)).seen.length === 1);
  const [owed] = (await s.append({ type: "pin/hang" })) as { offset: number }[];
  await until("the hanging push is on the facet", async () => (await probe(ctx)).seen.length === 2);

  const errors = vi.spyOn(console, "error");
  const logs = vi.spyOn(console, "log");
  // The same name and class, NEW source: the row's next call restarts the facet in place.
  await configure(ctx, hangingCounterSource(false));

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
    return p.checkpoints.some((c) => c.reduced_through_offset > owed!.offset) ? p : undefined;
  });
  const events = await readLog(ctx);
  expect(JSON.parse(healed.checkpoints[0]!.state)).toEqual({ n: events.length }); // each once
  expect(
    ((await s.invoke(["itx", "subscriptions", ["get", name]])) as { halted?: unknown }).halted,
  ).toBeUndefined();
  expect(
    errors.mock.calls.flat().filter((line) => JSON.stringify(line).includes('"issue"')),
  ).toEqual([]);
});

function configure(ctx: string, source: string) {
  return stub(ctx).append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name,
      target: [
        "itx",
        "facets",
        [
          "get",
          name,
          { source: { "worker.js": source }, className: "RestartedCounterDurableObject" },
        ],
        "processEventBatch",
      ],
    },
  });
}

function probe(ctx: string) {
  return stub(ctx).invoke(["itx", "facets", ["get", name], ["probe"]]) as Promise<{
    seen: Array<{ through: number; hung: number }>;
    checkpoints: Array<{ reduced_through_offset: number; state: string }>;
  }>;
}

/** A userspace processor that HANGS forever on a batch carrying a `pin/hang` event while `HANG` is
 *  true; each batch is recorded in the facet's own SQLite first. `probe()` reads that and the
 *  checkpoint without touching the engine. */
function hangingCounterSource(hang: boolean) {
  return /* js */ `
import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "iterate/sdk";
const HANG = ${hang};
const contract = defineProcessorContract({
  slug: "restartedcounter",
  version: "1.0.0",
  description: "counts durable events; hangs forever on a pin/hang batch while HANG",
  stateSchema: z.object({ n: z.number().default(0) }),
  consumes: ["*"],
  emits: [],
});
class RestartedCounterProcessor extends StreamProcessor {
  contract = contract;
  reduce({ state }) { return { n: state.n + 1 }; }
}
export class RestartedCounterDurableObject extends StreamProcessorDurableObject {
  static publicMethods = [...super.publicMethods, "probe"];
  processor = new RestartedCounterProcessor();
  #tables() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS seen (seq INTEGER PRIMARY KEY AUTOINCREMENT, through INTEGER, hung INTEGER)",
    );
  }
  async processEventBatch(events, range) {
    this.#tables();
    const hang = HANG && events.some((e) => e.type === "pin/hang");
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
    return { seen: this.ctx.storage.sql.exec("SELECT * FROM seen").toArray(), checkpoints };
  }
}
`;
}
