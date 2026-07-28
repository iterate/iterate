// The scheduler processor's executable spec, on the generic step harness from
// iterate/processors/testing: the REAL StreamProcessorRunner over the shared
// MemoryStream (production idempotency semantics: a same-key append with a
// different body is REJECTED), virtual time, and eviction-faithful crash().
// The scheduler's own dials — the stub script runner, the spy alarm, and the
// runner-backed committed reads the hosting DO wires as registry.reads(...) —
// are constructed in createProcessor; alarm wakes are function steps calling
// triggerDue() on the current incarnation, exactly what the DO's alarm() does.
//
// Where a scenario's premise is "delivery has NOT run yet" (a crashed wake
// re-running against un-advanced state, barren-wake backoff), triggerDue is
// called directly between plays instead of as a step — a step's settle()
// would drive delivery and dissolve the premise.

import { describe, expect, it, vi } from "vitest";
import {
  StreamProcessorRunner,
  type ConsumedInput,
  type ProcessorProgressStore,
} from "iterate/processors";
import {
  makeMemoryProgressStore,
  makeProcessorHarness,
  MemoryStream,
  type HarnessSubstrate,
} from "iterate/processors/testing";
import {
  activeSpans,
  recordedSpans,
  resetRecordedSpans,
} from "../../test/cloudflare-workers-shim.ts";
import {
  SchedulerProcessor,
  type SchedulerProcessorDeps,
} from "./scheduler-processor-implementation.ts";
import {
  SchedulerProcessorContract,
  type SchedulerProcessorState,
} from "./scheduler-processor-contract.ts";
import { SCHEDULER_HEARTBEAT_MS } from "./recurrence.ts";

type SchedulerEventInput = ConsumedInput<SchedulerProcessorContract>;

const T0 = Date.parse("2026-01-15T12:00:00Z");

const REQUESTED = "events.iterate.com/scheduler/trigger-requested";
const COMPLETED = "events.iterate.com/scheduler/trigger-completed";

// -----------------------------------------------------------------------------
// Event literals: the birth event and the recurring schedule-set shape. These
// are event BUILDERS (data), not append wrappers — every test appends through
// the harness's typed append.
// -----------------------------------------------------------------------------

const CREATED = {
  type: "events.iterate.com/scheduler/created",
  payload: { config: {} },
} satisfies SchedulerEventInput;

function setEvent(
  key: string,
  script = "async () => {}",
  extra?: {
    metadata?: Record<string, unknown>;
    recurrence?: { at: string } | { every: number } | { cron: string; timezone?: string };
  },
): SchedulerEventInput {
  return {
    type: "events.iterate.com/scheduler/schedule-set",
    payload: {
      action: { kind: "itx-script", script },
      key,
      recurrence: extra?.recurrence ?? { every: 60 },
      ...(extra?.metadata === undefined ? {} : { metadata: extra.metadata }),
    },
  };
}

// -----------------------------------------------------------------------------
// The generic harness plus the scheduler's dials, wired in createProcessor.
// -----------------------------------------------------------------------------

function makeSchedulerHarness(options?: {
  invokeCapability?: SchedulerProcessorDeps["dynamicWorkers"]["invokeCapability"];
  repointAlarm?: (atMs: number | null) => void | Promise<void>;
}) {
  const repointAlarm = vi.fn(options?.repointAlarm ?? (async () => {}));
  const invokeCapability = vi.fn(
    options?.invokeCapability ?? (async () => "ok"),
  ) as SchedulerProcessorDeps["dynamicWorkers"]["invokeCapability"];
  // T0-anchored substrate: createdAt stamps come from the same virtual clock
  // the processor's `now` dep reads, so reduce-time math is exact in
  // assertions.
  const substrate: HarnessSubstrate = {
    clock: { now: T0 },
    stream: new MemoryStream("/scheduler/primary"),
    progress: makeMemoryProgressStore(SchedulerProcessorContract),
  };
  const harness = makeProcessorHarness<SchedulerProcessorContract, SchedulerProcessor>({
    createProcessor: (deps) =>
      new SchedulerProcessor({
        ...deps,
        dynamicWorkers: { invokeCapability },
        readAlarm: async () => null,
        repointAlarm,
        reads: deps.reads,
      }),
    substrate,
  });
  return {
    ...harness,
    invokeCapability,
    repointAlarm,
    scheduler: harness.processor,
  };
}

describe("SchedulerProcessor reduce", () => {
  it("ignores a second scheduler birth certificate during reduction", async () => {
    const h = makeSchedulerHarness();
    await h.play(["append", CREATED]);
    await h.append(CREATED);
    expect(h.state().birthCertificate).toEqual(CREATED.payload);
  });

  it("upserts on schedule-set: re-setting a key replaces code, provenance, and run count", async () => {
    const h = makeSchedulerHarness();
    await h.play(["append", CREATED, setEvent("report", "async () => 1")]);
    expect(h.state().schedules["report"]).toMatchObject({
      definedAtOffset: 2,
      nextTriggerAt: T0 + 60_000,
    });

    await h.play(["append", setEvent("report", "async () => 2")]);
    expect(h.state().schedules["report"]).toMatchObject({
      action: { script: "async () => 2" },
      definedAtOffset: 3,
      runCount: 0,
    });
  });

  it("cancel removes the key and is a no-op for unknown keys", async () => {
    const h = makeSchedulerHarness();
    await h.play(["append", CREATED, setEvent("report")]);
    expect(h.state().schedules["report"]).toBeDefined();

    await h.play([
      "append",
      { type: "events.iterate.com/scheduler/schedule-cancelled", payload: { key: "report" } },
      {
        type: "events.iterate.com/scheduler/schedule-cancelled",
        payload: { key: "never-existed" },
      },
    ]);
    expect(h.state().schedules).toEqual({});
  });

  it("tolerates raw-append trigger events for ghosts: unknown key completes as skipped, unknown executionId is a no-op", async () => {
    const h = makeSchedulerHarness();
    await h.play([
      "append",
      CREATED,
      {
        type: COMPLETED,
        payload: { executionId: "never-requested", key: "ghost", outcome: "succeeded" },
      },
      {
        type: REQUESTED,
        payload: {
          executionId: "ghost-execution",
          key: "ghost",
          requestedAt: new Date(T0).toISOString(),
          runCount: 1,
          scheduledFor: new Date(T0).toISOString(),
        },
      },
    ]);
    expect(h.events(COMPLETED)).toHaveLength(2);

    expect(h.invokeCapability).not.toHaveBeenCalled();
    expect(h.events(COMPLETED).at(-1)!.payload).toMatchObject({
      executionId: "ghost-execution",
      key: "ghost",
      outcome: "skipped",
    });
    expect(h.state().pendingTriggers).toEqual({});
    expect(h.state().schedules).toEqual({});
  });

  it("parks a raw-appended cron with no future occurrence instead of poisoning reduce, and it survives completion", async () => {
    const h = makeSchedulerHarness();
    // Feb 30 never occurs; assertValidRecurrence would reject this at set()
    // time, but raw appends bypass the command surface.
    await h.play([
      "append",
      CREATED,
      setEvent("impossible", "async () => 'never'", { recurrence: { cron: "0 0 30 2 *" } }),
    ]);
    expect(h.state().schedules["impossible"]!.nextTriggerAt).toBeNull();
    await expect(h.scheduler().getScheduleView("impossible")).resolves.toMatchObject({
      nextTriggerAt: null,
    });

    // Manually triggering a parked (non-one-shot) schedule runs it and keeps it.
    await h.play(async () => {
      const { event } = await h.scheduler().buildManualTriggerEvent("impossible");
      await h.stream.append(event);
    });
    expect(h.events(COMPLETED)).toHaveLength(1);
    expect(h.state().schedules["impossible"]).toMatchObject({ nextTriggerAt: null });
  });

  it("exposes the public view shape: metadata round-trip, ISO conversion, key-sorted list", async () => {
    const h = makeSchedulerHarness();
    await h.play(
      ["append", CREATED, setEvent("zulu")],
      ["append", setEvent("alpha", "async () => {}", { metadata: { owner: "tests" } })],
    );

    await expect(h.scheduler().getScheduleView("missing")).resolves.toBeUndefined();
    await expect(h.scheduler().getScheduleView("alpha")).resolves.toEqual({
      action: { kind: "itx-script", script: "async () => {}" },
      definedAtOffset: 3,
      key: "alpha",
      metadata: { owner: "tests" },
      nextTriggerAt: new Date(T0 + 60_000).toISOString(),
      recurrence: { every: 60 },
      runCount: 0,
      setAt: new Date(T0).toISOString(),
    });
    expect((await h.scheduler().listScheduleViews()).map((view) => view.key)).toEqual([
      "alpha",
      "zulu",
    ]);
  });
});

describe("triggering", () => {
  it("traces the action invocation without blocking delivery", async () => {
    resetRecordedSpans();
    let finishAction!: () => void;
    const actionFinished = new Promise<void>((resolve) => {
      finishAction = resolve;
    });
    const h = makeSchedulerHarness({
      invokeCapability: async () => {
        expect([...activeSpans].map((span) => span.name)).toContain("scheduler action invocation");
        await actionFinished;
      },
    });
    await h.play(["append", CREATED, setEvent("report")], ["advanceTime", 61_000], () =>
      h.scheduler().triggerDue(),
    );

    await expect(h.scheduler().getRuntimeState()).resolves.toMatchObject({
      runtime: { inflightExecutions: [expect.any(String)] },
    });
    const invocation = recordedSpans.find((span) => span.name === "scheduler action invocation");
    expect(invocation).toMatchObject({
      attributes: { "iterate.scheduler.execution_id": expect.any(String) },
    });
    expect(activeSpans.has(invocation!)).toBe(true);

    finishAction();
    await h.settle();
    expect(h.events(COMPLETED)).toHaveLength(1);
    expect(activeSpans.has(invocation!)).toBe(false);
    expect(invocation).toMatchObject({
      attributes: { "iterate.scheduler.action_outcome": "succeeded" },
    });
  });

  it("requests due schedules with incarnation-scoped idempotency keys and advances the clock", async () => {
    const h = makeSchedulerHarness();
    await h.play(["append", CREATED, setEvent("report")], ["advanceTime", 61_000]);

    // Alarm wake — delivery deliberately not driven yet.
    await h.scheduler().triggerDue();
    const requested = h.events(REQUESTED);
    expect(requested).toHaveLength(1);
    expect(requested[0]!.idempotencyKey).toBe(
      `scheduler/trigger-requested:report:2:${T0 + 60_000}`,
    );
    expect(requested[0]!.payload).toMatchObject({
      key: "report",
      requestedAt: new Date(T0 + 61_000).toISOString(),
      runCount: 1,
      scheduledFor: new Date(T0 + 60_000).toISOString(),
    });

    // A crashed wake re-running against un-advanced state cannot
    // double-trigger: it observes the committed request under the occurrence
    // key and skips it.
    await h.scheduler().triggerDue();
    expect(h.events(REQUESTED)).toHaveLength(1);

    await h.settle();
    // The interval re-anchors on the request time.
    expect(h.state().schedules["report"]).toMatchObject({
      nextTriggerAt: T0 + 61_000 + 60_000,
      runCount: 1,
    });

    // And once state advanced, the occurrence is spent for good.
    await h.scheduler().triggerDue();
    expect(h.events(REQUESTED)).toHaveLength(1);
    await h.settle();
    expect(h.events(COMPLETED)).toHaveLength(1);
  });

  it("a foreign event occupying an occurrence key is surfaced loudly, never passed off as the trigger", async () => {
    const h = makeSchedulerHarness();
    await h.play(["append", CREATED, setEvent("report")]);

    // Poison the predictable occurrence key with an unrelated raw append —
    // the collision strict append would have exposed.
    const entry = h.state().schedules["report"]!;
    await h.stream.append({
      type: "events.iterate.com/example/noise",
      idempotencyKey: `scheduler/trigger-requested:report:${entry.definedAtOffset}:${entry.nextTriggerAt}`,
      payload: {},
    });

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await h.advanceTime(61_000);
      await h.scheduler().triggerDue();
      // The occurrence cannot commit under its burned key — no silent
      // "deduplicated" pretence, and a LOUD classified error instead.
      expect(h.events(REQUESTED)).toHaveLength(0);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringMatching(/occupied by a foreign event/),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("a re-set one-shot with the same instant triggers again (incarnation in the idempotency key)", async () => {
    const h = makeSchedulerHarness();
    const at = new Date(T0 - 60_000).toISOString(); // already due at set time
    const oneShot = () =>
      ({
        type: "events.iterate.com/scheduler/schedule-set",
        payload: {
          action: { kind: "itx-script", script: "async () => 'ran'" },
          key: "once",
          recurrence: { at },
        },
      }) satisfies SchedulerEventInput;

    await h.play(["append", CREATED, oneShot()], () => h.scheduler().triggerDue());
    expect(h.events(COMPLETED)).toHaveLength(1);
    expect(h.state().schedules).toEqual({});

    // Re-applying the identical schedule (declarative clients do this) must
    // trigger again, not dedupe against the spent incarnation's request.
    await h.play(["advanceTime", 10_000], ["append", oneShot()], () => h.scheduler().triggerDue());
    expect(h.events(COMPLETED)).toHaveLength(2);
    expect(h.events(REQUESTED)).toHaveLength(2);
  });

  it("executes the script with (schedule, trigger) args and records success + provenance", async () => {
    const h = makeSchedulerHarness({ invokeCapability: async () => ({ made: "cat-image" }) });
    await h.play(
      [
        "append",
        CREATED,
        setEvent("report", "async (itx, schedule, trigger) => 42", {
          metadata: { owner: "test" },
        }),
      ],
      ["advanceTime", 61_000],
      () => h.scheduler().triggerDue(),
    );
    expect(h.events(COMPLETED)).toHaveLength(1);

    expect(h.invokeCapability).toHaveBeenCalledTimes(1);
    const call = vi.mocked(h.invokeCapability).mock.calls[0]![0];
    expect(call.path).toEqual(["run"]);
    expect(call.traceRole).toBe("scheduler_action");
    expect(
      (
        call.ref as {
          source: { createWorker: { files: { files: Record<string, string> } } };
        }
      ).source.createWorker.files.files["main.js"],
    ).toContain("async (itx, schedule, trigger) => 42");
    const [scheduleArg, triggerArg] = call.args as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(scheduleArg).toMatchObject({
      key: "report",
      metadata: { owner: "test" },
      path: "/scheduler/primary",
      recurrence: { every: 60 },
    });
    expect(triggerArg).toMatchObject({
      requestedAt: new Date(T0 + 61_000).toISOString(),
      runCount: 1,
    });
    expect(typeof triggerArg.executionId).toBe("string");

    const completed = h.events(COMPLETED)[0]!;
    expect(completed.payload).toMatchObject({
      definedAtOffset: 2,
      key: "report",
      outcome: "succeeded",
      result: { made: "cat-image" },
    });
    expect(completed.idempotencyKey).toBe(`scheduler/trigger-completed:${triggerArg.executionId}`);
    expect(h.state().pendingTriggers).toEqual({});
  });

  it("records a throwing script as outcome=failed and keeps the recurrence alive", async () => {
    resetRecordedSpans();
    const h = makeSchedulerHarness({
      invokeCapability: async () => {
        throw new Error("script exploded");
      },
    });
    await h.play(["append", CREATED, setEvent("report")], ["advanceTime", 61_000], () =>
      h.scheduler().triggerDue(),
    );
    expect(h.events(COMPLETED)).toHaveLength(1);

    expect(h.events(COMPLETED)[0]!.payload).toMatchObject({
      error: "script exploded",
      outcome: "failed",
    });
    expect(recordedSpans.find((span) => span.name === "scheduler action invocation")).toMatchObject(
      { attributes: { "iterate.scheduler.action_outcome": "failed" } },
    );
    // Failure does not retry and does not kill the schedule: next occurrence stands.
    expect(h.state().schedules["report"]!.nextTriggerAt).toBe(T0 + 61_000 + 60_000);
  });

  it("a failed completion append is a transport error, not a script outcome: the sweep retries", async () => {
    const h = makeSchedulerHarness();
    await h.play(["append", CREATED, setEvent("report")], ["advanceTime", 61_000]);

    h.stream.failAppendsOfType = COMPLETED;
    await h.play(() => h.scheduler().triggerDue());
    // The script ran, its completion append failed, and crucially nothing
    // recorded a bogus outcome=failed for a script that succeeded.
    expect(h.invokeCapability).toHaveBeenCalledTimes(1);
    expect(h.events(COMPLETED)).toHaveLength(0);
    expect(Object.keys(h.state().pendingTriggers)).toHaveLength(1);
    await expect(h.scheduler().getRuntimeState()).resolves.toMatchObject({
      runtime: { inflightExecutions: [] },
    });

    // Next wake: the sweep re-launches (at-least-once) and the append heals.
    h.stream.failAppendsOfType = undefined;
    await h.play(() => h.scheduler().triggerDue());
    expect(h.events(COMPLETED)).toHaveLength(1);
    expect(h.invokeCapability).toHaveBeenCalledTimes(2);
    expect(h.events(COMPLETED)[0]!.payload).toMatchObject({ outcome: "succeeded" });
  });

  it("completes as skipped when the schedule was cancelled between request and execution", async () => {
    const h = makeSchedulerHarness();
    await h.play(["append", CREATED, setEvent("report")], ["advanceTime", 61_000]);
    await h.scheduler().triggerDue(); // appends trigger-requested (not yet delivered)
    await h.stream.append({
      type: "events.iterate.com/scheduler/schedule-cancelled",
      payload: { key: "report" },
    });
    // One frame: requested + cancelled commit before the execution's barrier lifts.
    await h.settle();
    expect(h.events(COMPLETED)).toHaveLength(1);

    expect(h.invokeCapability).not.toHaveBeenCalled();
    expect(h.events(COMPLETED)[0]!.payload).toMatchObject({ key: "report", outcome: "skipped" });
    expect(h.state().pendingTriggers).toEqual({});
  });

  it("latest-code-wins: a re-set between request and execution runs the new code", async () => {
    const h = makeSchedulerHarness();
    await h.play(
      ["append", CREATED, setEvent("report", "async () => 'v1'")],
      ["advanceTime", 61_000],
    );
    await h.scheduler().triggerDue(); // requested appended, not yet delivered
    const [reset] = await h.stream.append(setEvent("report", "async () => 'v2'"));
    await h.settle();
    expect(h.events(COMPLETED)).toHaveLength(1);

    const call = vi.mocked(h.invokeCapability).mock.calls[0]![0];
    expect(
      (
        call.ref as {
          source: { createWorker: { files: { files: Record<string, string> } } };
        }
      ).source.createWorker.files.files["main.js"],
    ).toContain("'v2'");
    expect(h.events(COMPLETED)[0]!.payload).toMatchObject({
      definedAtOffset: reset!.offset,
      outcome: "succeeded",
    });
  });

  it("one-shots leave state once their trigger settles", async () => {
    const h = makeSchedulerHarness();
    await h.play(
      [
        "append",
        CREATED,
        {
          type: "events.iterate.com/scheduler/schedule-set",
          payload: {
            action: { kind: "itx-script", script: "async () => {}" },
            key: "once",
            recurrence: { at: new Date(T0 + 30_000).toISOString() },
          },
        },
      ],
      ["advanceTime", 31_000],
      () => h.scheduler().triggerDue(),
    );
    expect(h.events(COMPLETED)).toHaveLength(1);
    expect(h.state().schedules).toEqual({});
  });

  it("manual triggers require an existing key, run immediately, and advance the recurring clock", async () => {
    const h = makeSchedulerHarness();
    await h.play(["append", CREATED]);
    await expect(h.scheduler().buildManualTriggerEvent("ghost")).rejects.toThrow(/no schedule/);

    await h.play(["append", setEvent("report")], ["advanceTime", 10_000]);
    // 10s in — before the 60s occurrence — a manual trigger runs anyway.
    const { event, executionId } = await h.scheduler().buildManualTriggerEvent("report");
    await h.play(async () => {
      await h.stream.append(event);
    });
    expect(h.events(COMPLETED)).toHaveLength(1);
    expect(h.events(COMPLETED)[0]!.payload).toMatchObject({
      executionId,
      outcome: "succeeded",
    });
    // The documented side effect: a manual trigger re-anchors the interval.
    expect(h.state().schedules["report"]).toMatchObject({
      nextTriggerAt: T0 + 10_000 + 60_000,
      runCount: 1,
    });
  });
});

describe("recovery and alarm derivation", () => {
  it("at-least-once: a restart mid-execution re-launches pending triggers on the next wake", async () => {
    // The first incarnation's execution hangs forever (an eviction mid-run);
    // the successor's wake sweep re-launches it from the reduced state — the
    // empty in-memory in-flight set after crash() IS the re-launch signal.
    let invocations = 0;
    const h = makeSchedulerHarness({
      invokeCapability: async () => {
        invocations += 1;
        if (invocations === 1) return new Promise(() => {}); // dies with incarnation 1
        return "ok";
      },
    });
    await h.play(["append", CREATED, setEvent("report")], ["advanceTime", 61_000], () =>
      h.scheduler().triggerDue(),
    );
    expect(invocations).toBe(1);
    expect(Object.keys(h.state().pendingTriggers)).toHaveLength(1);
    expect(h.events(COMPLETED)).toHaveLength(0);

    await h.play(["crash"], ["advanceTime", 1_000], () => h.scheduler().triggerDue());
    expect(h.events(COMPLETED)).toHaveLength(1);
    expect(h.events(COMPLETED)[0]!.payload).toMatchObject({
      key: "report",
      outcome: "succeeded",
    });
  });

  it("a checkpoint-loss replay does not re-run triggers whose completion is already on the stream", async () => {
    // Build a fully settled history with the step harness…
    const h = makeSchedulerHarness();
    await h.play(["append", CREATED, setEvent("report")], ["advanceTime", 61_000], () =>
      h.scheduler().triggerDue(),
    );
    expect(h.events(COMPLETED)).toHaveLength(1);
    expect(h.invokeCapability).toHaveBeenCalledTimes(1);

    // …then replay it from offset 0 on a fresh progress store — a checkpoint
    // loss — FRAMED so the completion sits behind the frame's observed head
    // (the catch-up shape). This needs frame-boundary control the step
    // harness deliberately lacks, so the replay runner is constructed inline
    // with its keepAlive lanes PARKED (deferred, not dropped — a dropped
    // frame-blocking closure would wedge its frame's commit forever): the
    // barrier-kicked self-pull defers, delivery holds at the frame boundary,
    // and the launched execution provably passes through its
    // completion-existence gate rather than the pending-recheck.
    const invokeCapability = vi.fn(
      async () => "ok",
    ) as SchedulerProcessorDeps["dynamicWorkers"]["invokeCapability"];
    let parked = true;
    const parkedWork: Array<() => Promise<unknown>> = [];
    // Failures already reach the real waiter through the runner's keepalive
    // bridge (reject-then-rethrow); swallow the duplicate rethrow here.
    const runWork = (work: () => Promise<unknown>) => void work().catch(() => {});
    let runner!: StreamProcessorRunner<SchedulerProcessorContract, SchedulerProcessorDeps>;
    const processor = new SchedulerProcessor({
      stream: h.stream,
      path: h.stream.path,
      projectId: null,
      dynamicWorkers: { invokeCapability },
      now: () => h.clock.now,
      readAlarm: async () => null,
      repointAlarm: async () => {},
      reads: {
        snapshot: () => runner.snapshot(),
        waitUntilEvent: (input) => runner.waitUntilEvent(input),
      },
    });
    runner = new StreamProcessorRunner({
      processor,
      stream: h.stream,
      durability: {
        progress: makeMemoryProgressStore(
          SchedulerProcessorContract,
        ) as ProcessorProgressStore<SchedulerProcessorState>,
      },
      now: () => h.clock.now,
      keepAlive: (work) => {
        if (parked) parkedWork.push(work);
        else runWork(work);
      },
    });

    const completedOffset = h.events(COMPLETED)[0]!.offset;
    const firstPage = h.events().filter((event) => event.offset < completedOffset);
    const opened = await runner.openEventBatchCallback();
    await opened.processEventBatch({
      streamId: h.stream.streamId,
      events: firstPage,
      scannedAfterOffset: opened.checkpointOffset,
      scannedThroughOffset: firstPage.at(-1)!.offset,
      streamMaxOffset: h.events().at(-1)!.offset,
    });
    // Give any wrongly-launched execution time to run its gate.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(invokeCapability).not.toHaveBeenCalled();

    // Unpark and finish the replay: still no re-run, no duplicate completion,
    // and the re-reduced state converges on the live incarnation's.
    parked = false;
    for (const work of parkedWork.splice(0)) runWork(work);
    for (;;) {
      const head = h.events().at(-1)!.offset;
      const { offset } = await runner.snapshot();
      if (offset >= head) break;
      await runner.catchUp();
    }
    expect(invokeCapability).not.toHaveBeenCalled();
    expect(h.events(COMPLETED)).toHaveLength(1);
    expect((await runner.snapshot()).state).toEqual(h.state());
  });

  it("a rejecting repointAlarm fails the frame and the redelivery re-arms (the await is load-bearing)", async () => {
    let rejectOnce = true;
    const h = makeSchedulerHarness({
      repointAlarm: async () => {
        if (rejectOnce) {
          rejectOnce = false;
          throw new Error("setAlarm outage");
        }
      },
    });
    await expect(h.play(["append", CREATED, setEvent("report")])).rejects.toMatchObject({
      message: "harness play() step 0 (append) failed",
      cause: { message: "setAlarm outage" },
    });
    expect(h.state().schedules).toEqual({});

    // The cursor did not advance, so redelivering the same events heals.
    await h.settle();
    expect(h.state().schedules["report"]).toBeDefined();
    expect(h.repointAlarm).toHaveBeenLastCalledWith(T0 + 60_000);
  });

  it("repoints at the head of every delivery: earliest trigger wins, heartbeat while any state remains, deleted when empty", async () => {
    const h = makeSchedulerHarness();
    await h.play(["append", CREATED, setEvent("report")]); // every 60s → due at T0+60s
    expect(h.repointAlarm).toHaveBeenLastCalledWith(T0 + 60_000);

    // A parked entry (no computable occurrence) still holds the heartbeat.
    await h.play([
      "append",
      setEvent("report", "async () => {}", { recurrence: { cron: "0 0 30 2 *" } }),
    ]);
    expect(h.repointAlarm).toHaveBeenLastCalledWith(T0 + SCHEDULER_HEARTBEAT_MS);

    // An emptied scheduler deletes its alarm and sleeps for good.
    await h.play([
      "append",
      { type: "events.iterate.com/scheduler/schedule-cancelled", payload: { key: "report" } },
    ]);
    expect(h.repointAlarm).toHaveBeenLastCalledWith(null);
  });

  it("triggerDue on an empty scheduler deletes the alarm (the heartbeat has nothing to heal)", async () => {
    const h = makeSchedulerHarness();
    await h.play(["append", CREATED]);
    await h.scheduler().triggerDue();
    expect(h.repointAlarm).toHaveBeenCalledWith(null);
  });

  it("an in-flight execution is never double-launched by concurrent sweeps or redelivery", async () => {
    resetRecordedSpans();
    let invocations = 0;
    const h = makeSchedulerHarness({
      invokeCapability: () => {
        invocations += 1;
        return new Promise(() => {}); // hangs — stays in-flight for the whole test
      },
    });
    await h.play(["append", CREATED, setEvent("report")], ["advanceTime", 61_000], () =>
      h.scheduler().triggerDue(),
    );
    expect(invocations).toBe(1);

    // Repeated wakes sweep the still-pending trigger but the in-memory
    // in-flight set dedupes: exactly one live execution per executionId.
    await h.scheduler().triggerDue();
    await h.scheduler().triggerDue();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(invocations).toBe(1);
    const invocationSpans = recordedSpans.filter(
      (span) => span.name === "scheduler action invocation",
    );
    expect(invocationSpans).toHaveLength(1);
    expect(activeSpans.has(invocationSpans[0]!)).toBe(true);
  });

  it("barren wakes back off exponentially instead of hot-looping at the minimum delay", async () => {
    const h = makeSchedulerHarness();
    await h.play(["append", CREATED, setEvent("report")], ["advanceTime", 61_000]);
    const now = T0 + 61_000;

    // Wake 1 appends the request but delivery is "wedged" (never driven):
    // progress since the last wake is judged by committed-offset movement.
    await h.scheduler().triggerDue();
    expect(h.repointAlarm).toHaveBeenLastCalledWith(now + 1_000);

    await h.scheduler().triggerDue();
    expect(h.repointAlarm).toHaveBeenLastCalledWith(now + 2_000);
    await h.scheduler().triggerDue();
    expect(h.repointAlarm).toHaveBeenLastCalledWith(now + 4_000);

    // Delivery heals → the committed offset moves → backoff resets to the
    // normal cadence.
    await h.settle();
    await h.scheduler().triggerDue();
    expect(h.repointAlarm).toHaveBeenLastCalledWith(now + 60_000);
    await h.settle();
    expect(h.events(COMPLETED)).toHaveLength(1);
  });
});
