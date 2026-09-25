// __workers-tests__/processor-runs-start-in-an-alarm.test.ts — A RUN A PROCESSOR REQUESTED STARTS IN
// AN ALARM PASS, a fresh invocation, so a loop of processor turns never piles up Cloudflare's
// subrequest depth (why: iterate-context-durable-object.ts `#startRequestedRuns`). workerd counts no
// depth, so this pins the mechanism: every run of a processor's 30-turn loop is started by a pass,
// which its `alarm-fired` trace counts, and a caller's run starts at its commit. The depth itself is
// pinned against a deployed preview (apps/agents/e2e/agents.e2e.test.ts, "an agent's script has as
// many hops left").
// Run:
//   pnpm exec vitest run --configLoader runner --project workers __workers-tests__/processor-runs-start-in-an-alarm.test.ts

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import type { StreamEvent } from "iterate/stream/processor";
import type { AlarmTrace } from "../src/iterate-context-durable-object.ts";
import { adminCredentials, openSession, stub, until } from "./support.ts";

const TURNS = 30;

test(`a processor's ${TURNS} turns of run-requested → run-settled: every run starts in an alarm pass; a caller's itx.run starts at its commit`, async () => {
  const ctx = "prj_processor_runs_alarm";
  await stub(ctx).append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "looper",
      target: ["itx", "facets", ["get", "looper", LOOPER_SPEC], "processEventBatch"],
      consumes: ["test/loop", "events.iterate.com/itx/run-settled"],
    },
  });
  await stub(ctx).append({ type: "test/loop" });
  const settled = await until(
    `${TURNS} turns`,
    async () => {
      const runs = (await readWithTraces(ctx)).filter(
        (event) => event.type === "events.iterate.com/itx/run-settled",
      );
      return runs.length >= TURNS ? runs : undefined;
    },
    60_000,
  );
  expect(settled.map((event) => event.payload?.settlement)).toEqual(
    Array.from({ length: TURNS }, (_, turn) => ({ status: "succeeded", result: turn })),
  );
  expect(runsStartedByAlarmPasses(await readWithTraces(ctx))).toBe(TURNS);

  // A caller's run is the caller's depth: it starts at its commit, and no pass starts it.
  const itx = await (await openSession()).authenticate(adminCredentials()).projects.get(ctx);
  expect(await itx.run("async () => 'at once'")).toBe("at once");
  expect(runsStartedByAlarmPasses(await readWithTraces(ctx))).toBe(TURNS);
});

test("a run the context died owing its alarm is settled `interrupted` by the incarnation that alarm wakes, never started", async () => {
  const ctx = "prj_processor_run_owed_at_death";
  const s = stub(ctx);
  // The request commits, the alarm is armed for it, both are made durable — and the context dies
  // before any alarm can run: one turn, no event in between.
  await runInDurableObject(s, async (instance, state) => {
    await instance.append({
      type: "events.iterate.com/itx/run-requested",
      payload: { code: "async () => 'never'" },
      source: { processor: { slug: "looper", version: "1.0.0" } },
    });
    await state.storage.sync();
    state.abort("killed before its alarm pass");
  }).catch(() => {}); // abort() throws by design: nothing after it runs
  // A fresh stub: the old one died with its incarnation. The alarm is due at once, so the runtime
  // may deliver it before the harness does, most often under load; either way an alarm, not a
  // request, wakes the fresh incarnation, and the wake record below says which.
  await runDurableObjectAlarm(stub(ctx));
  // Settled by the ALARM's wake record, in the same batch — not by the read below, whose own wake
  // record would settle it too.
  const log = await readWithTraces(ctx);
  const settled = log.find((event) => event.type === "events.iterate.com/itx/run-settled");
  expect(settled?.payload?.settlement).toMatchObject({
    status: "failed",
    failureKind: "interrupted",
  });
  expect(log.find((event) => event.offset === settled!.offset - 1)).toMatchObject({
    type: "events.iterate.com/itx/woken",
    payload: { reason: "alarm" },
  });
});

/** The log with the ring's ephemerals, where the alarm passes' traces are. */
const readWithTraces = async (ctx: string) =>
  (
    (await stub(ctx).invoke(["itx", ["readEvents", 0, 500, { includeEphemeral: true }]])) as {
      events: StreamEvent[];
    }
  ).events;

const runsStartedByAlarmPasses = (events: StreamEvent[]) =>
  events
    .filter((event) => event.type === "events.iterate.com/itx/alarm-trace")
    .map((event) => event.payload as unknown as AlarmTrace)
    .filter((trace) => trace.reason === "alarm-fired")
    .reduce((sum, trace) => sum + (trace.runs ?? 0), 0);

/** A processor that asks its context for a run on `test/loop` and again on each settlement, until
 *  it has seen TURNS of them; each script answers its turn. Its appends are blocked — per-event
 *  consequences, as the agent's script requests are. */
const LOOPER_SPEC = {
  source: {
    "worker.js": /* js */ `
import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "iterate/sdk";
const contract = defineProcessorContract({
  slug: "looper",
  version: "1.0.0",
  description: "requests a run, and another each time one settles",
  stateSchema: z.object({ turns: z.number().default(0) }),
  consumes: ["test/loop", "events.iterate.com/itx/run-settled"],
  emits: ["events.iterate.com/itx/run-requested"],
});
class LooperProcessor extends StreamProcessor {
  contract = contract;
  reduce({ event, state }) {
    if (event.type === "events.iterate.com/itx/run-settled") return { turns: state.turns + 1 };
  }
  processEvent({ event, state, append, blockProcessorWhile }) {
    if (!event || state.turns >= ${TURNS}) return;
    blockProcessorWhile(() =>
      append({
        type: "events.iterate.com/itx/run-requested",
        idempotencyKey: this.idempotencyKey("run", event),
        payload: { code: "async () => " + state.turns },
      }),
    );
  }
}
export class LooperDurableObject extends StreamProcessorDurableObject {
  processor = new LooperProcessor();
}`,
  },
  className: "LooperDurableObject",
};
