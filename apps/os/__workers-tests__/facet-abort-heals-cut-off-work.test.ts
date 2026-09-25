// __workers-tests__/facet-abort-heals-cut-off-work.test.ts — work `itx.facets.abort` cuts off is an
// outcome someone asked for, so it is modeled, not reported: the facet host rejects the call it cut
// off FACET_ABORTED (context/facet-host.ts `abort`), and whoever made the call owes the fresh
// instance the same work — never a halt, a backoff or an issue line. The callers the context itself
// runs:
//   • a PUSH (subscription-delivery.ts): ONE catch-up from the log, exactly as for a push the
//     watchdog timed out (facet-push-timeout-heals.test.ts). The runtime's bare `Error: <reason>`
//     was a `subscription-delivery.deliver` issue per abort (measured 2026-09-23).
//   • a REVIVE (the alarm pass, `reviveDueClaims`): the claim is owed again, due now, with no failure
//     counted — not the revive-failure backoff and its issue line.
//   • a CATCH-UP (a resume's, a configure's, the one a cut-off push owes): run again on the fresh
//     instance.
// The facet here hangs on a batch, on its first revive and on an armed catch-up, and would never
// answer any of them: the abort from the host needs nothing from it. The context is not reset.
// A push its row's REMOVAL cuts off (the facet deleted with the row, `ctx.facets.delete` failing the
// call in flight with the runtime's "Facet was deleted.") is modeled the same way: NO_FACET, the
// removal it raced, logged as `delivery.facet-removed-in-flight` — it was a
// `subscription-delivery.deliver` issue per removal (measured 2026-09-24).
//
// Pinned in the `workers` vitest project because it needs the real facet runtime (`ctx.facets`,
// its abort), a hosted processor SDK facet and the alarm on demand.

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, onTestFinished, test, vi } from "vitest";
import { stub, until } from "./support.ts";

/** A userspace processor that HANGS on any batch carrying a `pin/hang` event, on its FIRST revive
 *  and on a catch-up it was armed for — forever, before the engine runs. Each is recorded
 *  in the facet's own SQLite first (so the fresh instance after an abort sees the history);
 *  `probe()` reads those and the checkpoint without touching the engine. */
const HANGING_COUNTER_SRC = /* js */ `
import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "iterate/sdk";
const contract = defineProcessorContract({
  slug: "hangingcounter",
  version: "1.0.0",
  description: "counts durable events; hangs forever on a pin/hang batch, its first revive, an armed catch-up",
  stateSchema: z.object({ n: z.number().default(0) }),
  consumes: ["*"],
  emits: [],
});
class HangingCounterProcessor extends StreamProcessor {
  contract = contract;
  reduce({ state }) { return { n: state.n + 1 }; }
}
export class HangingCounterDurableObject extends StreamProcessorDurableObject {
  static publicMethods = [...super.publicMethods, "probe", "armCatchUpHang"];
  processor = new HangingCounterProcessor();
  #tables() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS seen (seq INTEGER PRIMARY KEY AUTOINCREMENT, through INTEGER, hung INTEGER)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS revives (seq INTEGER PRIMARY KEY AUTOINCREMENT, hung INTEGER)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS catchups (seq INTEGER PRIMARY KEY AUTOINCREMENT, hung INTEGER)",
    );
  }
  /** The NEXT catch-up hangs (once: the flag is spent by the catch-up that reads it). */
  armCatchUpHang() {
    this.ctx.storage.kv.put("hang-next-catch-up", true);
  }
  async catchUpFromLog() {
    this.#tables();
    const hang = Boolean(this.ctx.storage.kv.get("hang-next-catch-up"));
    this.ctx.storage.kv.delete("hang-next-catch-up");
    this.ctx.storage.sql.exec("INSERT INTO catchups (hung) VALUES (?)", hang ? 1 : 0);
    if (hang) await new Promise(() => {});
    return super.catchUpFromLog();
  }
  async processEventBatch(events, range) {
    this.#tables();
    const hang = events.some((e) => e.type === "pin/hang");
    this.ctx.storage.sql.exec("INSERT INTO seen (through, hung) VALUES (?, ?)", range.through, hang ? 1 : 0);
    if (hang) await new Promise(() => {});
    return super.processEventBatch(events, range);
  }
  async revive() {
    this.#tables();
    const hang = this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM revives").one().n === 0;
    this.ctx.storage.sql.exec("INSERT INTO revives (hung) VALUES (?)", hang ? 1 : 0);
    if (hang) await new Promise(() => {});
    return super.revive();
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
      seen: this.ctx.storage.sql.exec("SELECT * FROM seen").toArray(),
      revives: this.ctx.storage.sql.exec("SELECT * FROM revives").toArray(),
      catchups: this.ctx.storage.sql.exec("SELECT * FROM catchups").toArray(),
      checkpoints,
    };
  }
}
`;
const name = "hangingcounter";

test("a push hung on a facet that itx.facets.abort resets is caught up by the fresh instance — reduced once, the row live, the context not reset", async () => {
  const ctx = "prj_facet_abort_heals_its_push";
  const { probe, read } = await hostedOn(ctx);
  const [owed] = (await stub(ctx).append({ type: "pin/hang" })) as { offset: number }[];
  await until("the hanging push is on the facet", async () => (await probe()).seen.length === 2);
  const wakesBefore = (await read()).filter((e) => e.type === "events.iterate.com/itx/woken");

  const errors = consoleErrors();
  const aborted = await stub(ctx).invoke(["itx", "facets", ["abort", name, "unstick"]]);
  expect(aborted).toMatchObject({
    type: "events.iterate.com/itx/facet-aborted",
    payload: { name, reason: "unstick" },
  });
  // Seconds, not the 60 s watchdog: the fresh instance reads the owed span from the log.
  const healed = await until("the fresh instance caught up past the cut-off batch", async () => {
    const p = await probe();
    return p.checkpoints.some((c) => c.reduced_through_offset > owed!.offset) ? p : undefined;
  });
  expect(healed.seen.filter((row) => Number(row.hung) === 1)).toHaveLength(1); // never re-pushed
  const events = await read();
  expect(JSON.parse(healed.checkpoints[0]!.state)).toEqual({ n: events.length }); // each once
  expect(
    ((await stub(ctx).invoke(["itx", "subscriptions", ["get", name]])) as { halted?: unknown })
      .halted,
  ).toBeUndefined();
  expect(events.filter((e) => e.type === "events.iterate.com/itx/woken")).toEqual(wakesBefore);
  expect(issueLines(errors)).toEqual([]);
});

test("a revive hung on a facet that itx.facets.abort resets is owed again at once — no backoff, no issue — and the fresh instance's revive runs", async () => {
  const ctx = "prj_facet_abort_owes_its_revive";
  const { probe } = await hostedOn(ctx);
  // A due claim, what a processor holds while a `runInBackground` attempt is in flight.
  await stub(ctx).invoke(["itx", "processors", ["claim", name, Date.now()]]);
  const errors = consoleErrors();
  // The pass — the harness's own alarm or this one, whichever runs it first: its revive hangs.
  const pass = runDurableObjectAlarm(stub(ctx));
  await until("the revive hangs on the facet", async () => (await probe()).revives.length === 1);

  await stub(ctx).invoke(["itx", "facets", ["abort", name, "unstick the revive"]]);
  await pass;
  // Owed again and due now: the next pass revives the fresh instance, which answers.
  const revived = await until("the fresh instance was revived", async () => {
    await runDurableObjectAlarm(stub(ctx));
    const p = await probe();
    return p.revives.length >= 2 ? p : undefined;
  });
  expect(revived.revives.map((row) => Number(row.hung))).toEqual([1, 0]);
  const failures = await runInDurableObject(stub(ctx), (_instance, state) =>
    state.storage.kv.get(`facet-claim-failures:${name}`),
  );
  expect(failures).toBeUndefined(); // no backoff rung
  expect(issueLines(errors)).toEqual([]);
});

test("a catch-up hung on a facet that itx.facets.abort resets runs again on the fresh instance, with no issue", async () => {
  const ctx = "prj_facet_abort_reruns_its_catch_up";
  const { probe } = await hostedOn(ctx);
  const before = (await probe()).catchups.length;
  await stub(ctx).invoke(["itx", "facets", ["get", name], ["armCatchUpHang"]]);
  const errors = consoleErrors();
  // An operator's resume: a facet row resumes by catching up from the log (subscription-delivery.ts).
  await stub(ctx).append({
    type: "events.iterate.com/itx/subscription-delivery-resumed",
    payload: { name },
  });
  await until("the catch-up hangs", async () => (await probe()).catchups.length === before + 1);

  await stub(ctx).invoke(["itx", "facets", ["abort", name, "unstick the catch-up"]]);
  const caughtUp = await until("the fresh instance caught up", async () => {
    const p = await probe();
    return p.catchups.length >= before + 2 ? p : undefined;
  });
  expect(caughtUp.catchups.slice(before).map((row) => Number(row.hung))).toEqual([1, 0]);
  expect(issueLines(errors)).toEqual([]);
});

/** The processor enabled on `ctx` (`processors.enable` spelled raw, as in
 *  facet-push-timeout-heals.test.ts), its configure batch pushed; its probe and the log. */
test("a push hung on a facet whose row is removed is that removal — logged, never an issue", async () => {
  const ctx = "prj_facet_delete_cuts_its_push";
  const { probe } = await hostedOn(ctx);
  await stub(ctx).append({ type: "pin/hang" });
  await until("the hanging push is on the facet", async () => (await probe()).seen.length === 2);
  const errors = consoleErrors();
  const logs = vi.spyOn(console, "log");
  onTestFinished(() => {
    logs.mockRestore();
  });
  await stub(ctx).append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: { name, target: null },
  });
  const removal = await until("the cut-off push is logged as the removal", async () =>
    logs.mock.calls
      .flat()
      .find((line) => JSON.stringify(line).includes('"delivery.facet-removed-in-flight"')),
  );
  expect(removal).toMatchObject({
    name,
    failureSite: "subscription-delivery.deliver",
    message: `facet "${name}" was deleted while this call was in flight`,
  });
  expect(issueLines(errors)).toEqual([]);
});

test("a claim released after its facet was deleted leaves no facet-ran row for a birth to start", async () => {
  const ctx = "prj_facet_release_after_delete";
  const { probe } = await hostedOn(ctx);
  await probe();
  await stub(ctx).append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: { name, target: null },
  });
  expect(await ranRow(ctx)).toBeUndefined(); // the deletion took it
  // What the facet's own release does when it lands after that (processors.claim, from the facet).
  await stub(ctx).invoke(["itx", "processors", ["claim", name, null]], [], {
    principal: null,
    app: true,
  });
  expect(await ranRow(ctx)).toBeUndefined();
});

const ranRow = (ctx: string) =>
  runInDurableObject(stub(ctx), (_instance, state) => state.storage.kv.get(`facet-ran:${name}`));

async function hostedOn(ctx: string) {
  await stub(ctx).append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name,
      target: [
        "itx",
        "facets",
        [
          "get",
          name,
          {
            source: { "worker.js": HANGING_COUNTER_SRC },
            className: "HangingCounterDurableObject",
          },
        ],
        "processEventBatch",
      ],
    },
  });
  const probe = () =>
    stub(ctx).invoke(["itx", "facets", ["get", name], ["probe"]]) as Promise<{
      seen: Array<{ through: number; hung: number }>;
      revives: Array<{ hung: number }>;
      catchups: Array<{ hung: number }>;
      checkpoints: Array<{ reduced_through_offset: number; state: string }>;
    }>;
  const read = async () =>
    ((await stub(ctx).invoke(["itx", ["readEvents", 0, 500]])) as { events: { type: string }[] })
      .events;
  await until("the configure batch was pushed", async () => (await probe()).seen.length === 1);
  return { probe, read };
}

/** `console.error`, spied until the test finishes. */
function consoleErrors() {
  const errors = vi.spyOn(console, "error");
  onTestFinished(() => {
    errors.mockRestore();
  });
  return errors;
}

/** The `reportIssue` lines the context logged — it runs in this isolate, so they are this console's. */
function issueLines(errors: { mock: { calls: unknown[][] } }) {
  return errors.mock.calls.flat().filter((line) => JSON.stringify(line).includes('"issue"'));
}
