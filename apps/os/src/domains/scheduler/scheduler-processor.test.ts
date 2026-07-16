import { describe, expect, it, vi } from "vitest";
import {
  activeSpans,
  recordedSpans,
  resetRecordedSpans,
} from "../../test/cloudflare-workers-shim.ts";
import {
  StreamProcessorRunner,
  type ProcessorProgress,
  type ProcessorProgressStore,
} from "../streams/stream-processor-runner.ts";
import { MemoryStream } from "../streams/test-helpers.ts";
import {
  SchedulerProcessor,
  type SchedulerProcessorDeps,
} from "./scheduler-processor-implementation.ts";
import {
  SchedulerProcessorContract,
  type SchedulerProcessorState,
} from "./scheduler-processor-contract.ts";
import { SCHEDULER_HEARTBEAT_MS } from "./recurrence.ts";

const T0 = Date.parse("2026-01-15T12:00:00Z");

const SET_TYPE = "events.iterate.com/scheduler/schedule-set";
const CANCELLED_TYPE = "events.iterate.com/scheduler/schedule-cancelled";
const REQUESTED_TYPE = "events.iterate.com/scheduler/trigger-requested";
const COMPLETED_TYPE = "events.iterate.com/scheduler/trigger-completed";

/** In-memory two-cursor progress store (CAS-fenced like the DO adapter);
 * shared across harnesses to model a restart. */
function makeProgressStore() {
  let record: ProcessorProgress<SchedulerProcessorState> | undefined;
  const store: ProcessorProgressStore<SchedulerProcessorState> = {
    read: () => (record === undefined ? undefined : structuredClone(record)),
    commit: (progress, opts) => {
      const persisted = record?.processing.cursorRevision ?? 0;
      if (opts.expectedCursorRevision !== persisted) {
        throw new Error(
          `progress commit fenced: expected cursorRevision ${opts.expectedCursorRevision}, persisted ${persisted}`,
        );
      }
      record = structuredClone(progress);
    },
  };
  return store;
}

// The processor is driven by a REAL StreamProcessorRunner — the same driver
// the SchedulerDurableObject's registry runs in production — so the at-head
// alarm derivation (processEvent under `delivery.caughtUp`) and the
// runner-backed fold reads (deps.reads) are exercised exactly as deployed.
// `state()` reads the runner's committed fold; the processor instance's own
// checkpoint never advances under runner drive.
function makeHarness(options?: {
  invokeCapability?: SchedulerProcessorDeps["dynamicWorkers"]["invokeCapability"];
  repointAlarm?: SchedulerProcessorDeps["repointAlarm"];
  progressStore?: ReturnType<typeof makeProgressStore>;
  /** Park the runner's keepAlive-backed lanes so a test can hold delivery
   * exactly at a frame boundary: parked work is DEFERRED, and `deliver()`
   * unparks + flushes before driving. Deferral (not dropping) matters — the
   * at-head alarm repoint (processEvent under `delivery.caughtUp`) rides the
   * same keepAlive lane as a frame-blocking closure, so a dropped blocker
   * would wedge its frame's commit (and the runner chain behind it) forever. */
  parkRunnerBackground?: boolean;
}) {
  const clock = { now: T0 };
  let runnerBackgroundParked = options?.parkRunnerBackground === true;
  const parkedRunnerWork: Array<() => Promise<unknown>> = [];
  // Failures already reach the real waiter through the runner's keepalive
  // bridge (reject-then-rethrow); swallow the duplicate rethrow here.
  const runRunnerWork = (work: () => Promise<unknown>) => void work().catch(() => {});
  // createdAt comes from the same fake clock the processor's `now` dep reads,
  // so reduce-time math (`Date.parse(event.createdAt)`) is exact in assertions.
  const stream = new MemoryStream("/scheduler/primary");
  stream.now = () => clock.now;
  const repointAlarm = vi.fn(options?.repointAlarm ?? (async () => {}));
  const invokeCapability = vi.fn(
    options?.invokeCapability ?? (async () => "ok"),
  ) as SchedulerProcessorDeps["dynamicWorkers"]["invokeCapability"];
  const progressStore = options?.progressStore ?? makeProgressStore();
  let runner!: StreamProcessorRunner<typeof SchedulerProcessorContract, SchedulerProcessorDeps>;
  const processor = new SchedulerProcessor({
    stream,
    path: stream.path,
    projectId: null,
    dynamicWorkers: { invokeCapability },
    now: () => clock.now,
    readAlarm: async () => null,
    repointAlarm,
    // Runner-backed reads, exactly as the hosting DO wires registry.reads(...)
    // (lazy closures: the runner is constructed after the processor).
    reads: {
      snapshot: () => runner.snapshot(),
      waitUntilEvent: (input) => runner.waitUntilEvent(input),
    },
  });
  runner = new StreamProcessorRunner({
    processor,
    stream,
    durability: { progress: progressStore },
    now: () => clock.now,
    ...(options?.parkRunnerBackground === true
      ? {
          keepAlive: (work: () => Promise<unknown>) => {
            if (runnerBackgroundParked) parkedRunnerWork.push(work);
            else runRunnerWork(work);
          },
        }
      : {}),
  });
  const deliver = async () => {
    if (runnerBackgroundParked) {
      runnerBackgroundParked = false;
      for (const work of parkedRunnerWork.splice(0)) runRunnerWork(work);
    }
    // Drive until quiet: executions append events that need delivering too.
    for (;;) {
      const head = stream.events.at(-1)?.offset ?? 0;
      const { offset } = await runner.snapshot();
      if (offset >= head) return;
      await runner.catchUp();
    }
  };
  return {
    clock,
    deliver,
    invokeCapability,
    processor,
    progressStore,
    repointAlarm,
    runner,
    /** The runner's committed fold — the read the DO's registry serves. */
    state: () => runner.currentState,
    stream,
  };
}

function setEvent(key: string, script = "async () => {}", extra?: Record<string, unknown>) {
  return {
    type: SET_TYPE,
    payload: {
      action: { kind: "itx-script", script },
      key,
      recurrence: { every: 60 },
      ...extra,
    },
  };
}

async function waitForCompletion(harness: ReturnType<typeof makeHarness>, count = 1) {
  await vi.waitFor(async () => {
    expect(harness.stream.events.filter((e) => e.type === COMPLETED_TYPE)).toHaveLength(count);
  });
  await harness.deliver();
}

describe("SchedulerProcessor reduce", () => {
  it("upserts on schedule-set: re-setting a key replaces code, provenance, and run count", async () => {
    const { deliver, state, stream } = makeHarness();
    await stream.append(setEvent("report", "async () => 1"));
    await deliver();
    const first = state().schedules["report"]!;
    expect(first.nextTriggerAt).toBe(T0 + 60_000);
    expect(first.definedAtOffset).toBe(1);

    await stream.append(setEvent("report", "async () => 2"));
    await deliver();
    const second = state().schedules["report"]!;
    expect(second.action.script).toBe("async () => 2");
    expect(second.definedAtOffset).toBe(2);
    expect(second.runCount).toBe(0);
  });

  it("cancel removes the key and is a no-op for unknown keys", async () => {
    const { deliver, state, stream } = makeHarness();
    await stream.append(setEvent("report"));
    await deliver();
    expect(state().schedules["report"]).toBeDefined();

    await stream.append({ type: CANCELLED_TYPE, payload: { key: "report" } });
    await stream.append({ type: CANCELLED_TYPE, payload: { key: "never-existed" } });
    await deliver();
    expect(state().schedules).toEqual({});
  });

  it("tolerates raw-append trigger events for ghosts: unknown key completes as skipped, unknown executionId is a no-op", async () => {
    const harness = makeHarness();
    const { deliver, invokeCapability, state, stream } = harness;
    await stream.append({
      type: COMPLETED_TYPE,
      payload: { executionId: "never-requested", key: "ghost", outcome: "succeeded" },
    });
    await stream.append({
      type: REQUESTED_TYPE,
      payload: {
        executionId: "ghost-execution",
        key: "ghost",
        requestedAt: new Date(T0).toISOString(),
        runCount: 1,
        scheduledFor: new Date(T0).toISOString(),
      },
    });
    await deliver();
    await waitForCompletion(harness, 2);

    expect(invokeCapability).not.toHaveBeenCalled();
    const skipped = stream.events.filter((e) => e.type === COMPLETED_TYPE).at(-1)!;
    expect(skipped.payload).toMatchObject({
      executionId: "ghost-execution",
      key: "ghost",
      outcome: "skipped",
    });
    expect(state().pendingTriggers).toEqual({});
    expect(state().schedules).toEqual({});
  });

  it("parks a raw-appended cron with no future occurrence instead of poisoning the fold, and it survives completion", async () => {
    const harness = makeHarness();
    const { deliver, processor, state, stream } = harness;
    // Feb 30 never occurs; assertValidRecurrence would reject this at set()
    // time, but raw appends bypass the command surface.
    await stream.append(
      setEvent("impossible", "async () => 'never'", {
        recurrence: { cron: "0 0 30 2 *" },
      }),
    );
    await deliver();
    expect(state().schedules["impossible"]!.nextTriggerAt).toBeNull();
    await expect(processor.getScheduleView("impossible")).resolves.toMatchObject({
      nextTriggerAt: null,
    });

    // Manually triggering a parked (non-one-shot) schedule runs it and keeps it.
    const { event } = await processor.buildManualTriggerEvent("impossible");
    await stream.append(event);
    await deliver();
    await waitForCompletion(harness);
    expect(state().schedules["impossible"]).toBeDefined();
    expect(state().schedules["impossible"]!.nextTriggerAt).toBeNull();
  });

  it("exposes the public view shape: metadata round-trip, ISO conversion, key-sorted list", async () => {
    const { deliver, processor, stream } = makeHarness();
    await stream.append(setEvent("zulu"));
    await stream.append(setEvent("alpha", "async () => {}", { metadata: { owner: "tests" } }));
    await deliver();

    await expect(processor.getScheduleView("missing")).resolves.toBeUndefined();
    await expect(processor.getScheduleView("alpha")).resolves.toEqual({
      action: { kind: "itx-script", script: "async () => {}" },
      definedAtOffset: 2,
      key: "alpha",
      metadata: { owner: "tests" },
      nextTriggerAt: new Date(T0 + 60_000).toISOString(),
      recurrence: { every: 60 },
      runCount: 0,
      setAt: new Date(T0).toISOString(),
    });
    expect((await processor.listScheduleViews()).map((view) => view.key)).toEqual([
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
    const harness = makeHarness({
      invokeCapability: async () => {
        expect([...activeSpans].map((span) => span.name)).toContain("scheduler action invocation");
        await actionFinished;
      },
    });
    const { clock, deliver, processor, stream } = harness;
    await stream.append(setEvent("report"));
    await deliver();

    clock.now = T0 + 61_000;
    await processor.triggerDue();
    await deliver();

    const invocation = recordedSpans.find((span) => span.name === "scheduler action invocation");
    expect(invocation).toMatchObject({
      attributes: { "iterate.scheduler.execution_id": expect.any(String) },
    });
    expect(activeSpans.has(invocation!)).toBe(true);
    await expect(processor.getRuntimeState()).resolves.toMatchObject({
      runtime: { inflightExecutions: [expect.any(String)] },
    });

    finishAction();
    await waitForCompletion(harness);
    expect(activeSpans.has(invocation!)).toBe(false);
    expect(invocation).toMatchObject({
      attributes: { "iterate.scheduler.action_outcome": "succeeded" },
    });
  });

  it("requests due schedules with incarnation-scoped idempotency keys and advances the clock", async () => {
    const harness = makeHarness();
    const { clock, deliver, processor, state, stream } = harness;
    await stream.append(setEvent("report"));
    await deliver();

    clock.now = T0 + 61_000;
    await processor.triggerDue();
    const requested = stream.events.filter((e) => e.type === REQUESTED_TYPE);
    expect(requested).toHaveLength(1);
    expect(requested[0]!.idempotencyKey).toBe(
      `scheduler/trigger-requested:report:1:${T0 + 60_000}`,
    );
    expect(requested[0]!.payload).toMatchObject({
      key: "report",
      requestedAt: new Date(clock.now).toISOString(),
      runCount: 1,
      scheduledFor: new Date(T0 + 60_000).toISOString(),
    });

    // A crashed wake re-running against un-advanced state cannot
    // double-trigger: the idempotency key dedupes the append.
    await processor.triggerDue();
    expect(stream.events.filter((e) => e.type === REQUESTED_TYPE)).toHaveLength(1);

    await deliver();
    // The interval re-anchors on the request time.
    expect(state().schedules["report"]!.nextTriggerAt).toBe(clock.now + 60_000);
    expect(state().schedules["report"]!.runCount).toBe(1);

    // And once state advanced, the occurrence is spent for good.
    await processor.triggerDue();
    expect(stream.events.filter((e) => e.type === REQUESTED_TYPE)).toHaveLength(1);
    await waitForCompletion(harness);
  });

  it("a re-set one-shot with the same instant triggers again (incarnation in the idempotency key)", async () => {
    const harness = makeHarness();
    const { clock, deliver, processor, state, stream } = harness;
    const at = new Date(T0 - 60_000).toISOString(); // already due at set time
    const oneShot = () =>
      stream.append({
        type: SET_TYPE,
        payload: {
          action: { kind: "itx-script", script: "async () => 'ran'" },
          key: "once",
          recurrence: { at },
        },
      });

    await oneShot();
    await deliver();
    await processor.triggerDue();
    await deliver();
    await waitForCompletion(harness, 1);
    expect(state().schedules).toEqual({});

    // Re-applying the identical schedule (declarative clients do this) must
    // trigger again, not dedupe against the spent incarnation's request.
    clock.now = T0 + 10_000;
    await oneShot();
    await deliver();
    await processor.triggerDue();
    await deliver();
    await waitForCompletion(harness, 2);
    expect(stream.events.filter((e) => e.type === REQUESTED_TYPE)).toHaveLength(2);
  });

  it("executes the script with (schedule, trigger) args and records success + provenance", async () => {
    const harness = makeHarness({ invokeCapability: async () => ({ made: "cat-image" }) });
    const { clock, deliver, invokeCapability, state, stream } = harness;
    await stream.append(
      setEvent("report", "async (itx, schedule, trigger) => 42", { metadata: { owner: "test" } }),
    );
    await deliver();
    clock.now = T0 + 61_000;
    await harness.processor.triggerDue();
    await deliver();
    await waitForCompletion(harness);

    expect(invokeCapability).toHaveBeenCalledTimes(1);
    const call = vi.mocked(invokeCapability).mock.calls[0]![0];
    expect(call.path).toEqual(["run"]);
    expect(call.traceRole).toBe("scheduler_action");
    expect(
      (call.ref as { source: { files: { files: Record<string, string> } } }).source.files.files[
        "main.js"
      ],
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
      requestedAt: new Date(clock.now).toISOString(),
      runCount: 1,
    });
    expect(typeof triggerArg.executionId).toBe("string");

    const completed = stream.events.find((e) => e.type === COMPLETED_TYPE)!;
    expect(completed.payload).toMatchObject({
      definedAtOffset: 1,
      key: "report",
      outcome: "succeeded",
      result: { made: "cat-image" },
    });
    expect(completed.idempotencyKey).toBe(`scheduler/trigger-completed:${triggerArg.executionId}`);
    expect(state().pendingTriggers).toEqual({});
  });

  it("records a throwing script as outcome=failed and keeps the recurrence alive", async () => {
    resetRecordedSpans();
    const harness = makeHarness({
      invokeCapability: async () => {
        throw new Error("script exploded");
      },
    });
    const { clock, deliver, processor, state, stream } = harness;
    await stream.append(setEvent("report"));
    await deliver();
    clock.now = T0 + 61_000;
    await processor.triggerDue();
    await deliver();
    await waitForCompletion(harness);

    expect(stream.events.find((e) => e.type === COMPLETED_TYPE)!.payload).toMatchObject({
      error: "script exploded",
      outcome: "failed",
    });
    expect(recordedSpans.find((span) => span.name === "scheduler action invocation")).toMatchObject(
      { attributes: { "iterate.scheduler.action_outcome": "failed" } },
    );
    // Failure does not retry and does not kill the schedule: next occurrence stands.
    expect(state().schedules["report"]!.nextTriggerAt).toBe(clock.now + 60_000);
  });

  it("a failed completion append is a transport error, not a script outcome: the sweep retries", async () => {
    const harness = makeHarness();
    const { clock, deliver, invokeCapability, processor, state, stream } = harness;
    await stream.append(setEvent("report"));
    await deliver();
    clock.now = T0 + 61_000;

    stream.failAppendsOfType = COMPLETED_TYPE;
    await processor.triggerDue();
    await deliver();
    // The script ran, its completion append failed, and crucially nothing
    // recorded a bogus outcome=failed for a script that succeeded.
    await vi.waitFor(() => expect(invokeCapability).toHaveBeenCalledTimes(1));
    expect(stream.events.filter((e) => e.type === COMPLETED_TYPE)).toHaveLength(0);
    await vi.waitFor(() => expect(Object.keys(state().pendingTriggers)).toHaveLength(1));
    await vi.waitFor(async () => {
      await expect(processor.getRuntimeState()).resolves.toMatchObject({
        runtime: { inflightExecutions: [] },
      });
    });

    // Next wake: the sweep re-launches (at-least-once) and the append heals.
    stream.failAppendsOfType = undefined;
    await processor.triggerDue();
    await waitForCompletion(harness);
    expect(invokeCapability).toHaveBeenCalledTimes(2);
    expect(stream.events.find((e) => e.type === COMPLETED_TYPE)!.payload).toMatchObject({
      outcome: "succeeded",
    });
  });

  it("completes as skipped when the schedule was cancelled between request and execution", async () => {
    const harness = makeHarness();
    const { clock, deliver, invokeCapability, processor, state, stream } = harness;
    await stream.append(setEvent("report"));
    await deliver();
    clock.now = T0 + 61_000;
    await processor.triggerDue(); // appends trigger-requested (not yet delivered)
    await stream.append({ type: CANCELLED_TYPE, payload: { key: "report" } });
    await deliver(); // one frame: requested + cancelled commit before the execution's barrier lifts
    await waitForCompletion(harness);

    expect(invokeCapability).not.toHaveBeenCalled();
    expect(stream.events.find((e) => e.type === COMPLETED_TYPE)!.payload).toMatchObject({
      key: "report",
      outcome: "skipped",
    });
    expect(state().pendingTriggers).toEqual({});
  });

  it("latest-code-wins: a re-set between request and execution runs the new code", async () => {
    const harness = makeHarness();
    const { clock, deliver, invokeCapability, stream } = harness;
    await stream.append(setEvent("report", "async () => 'v1'"));
    await deliver();
    clock.now = T0 + 61_000;
    await harness.processor.triggerDue();
    const [reset] = await stream.append(setEvent("report", "async () => 'v2'"));
    await deliver();
    await waitForCompletion(harness);

    const call = vi.mocked(invokeCapability).mock.calls[0]![0];
    expect(
      (call.ref as { source: { files: { files: Record<string, string> } } }).source.files.files[
        "main.js"
      ],
    ).toContain("'v2'");
    expect(stream.events.find((e) => e.type === COMPLETED_TYPE)!.payload).toMatchObject({
      definedAtOffset: reset!.offset,
      outcome: "succeeded",
    });
  });

  it("one-shots leave state once their trigger settles", async () => {
    const harness = makeHarness();
    const { clock, deliver, processor, state, stream } = harness;
    await stream.append({
      type: SET_TYPE,
      payload: {
        action: { kind: "itx-script", script: "async () => {}" },
        key: "once",
        recurrence: { at: new Date(T0 + 30_000).toISOString() },
      },
    });
    await deliver();
    clock.now = T0 + 31_000;
    await processor.triggerDue();
    await deliver();
    await waitForCompletion(harness);
    expect(state().schedules).toEqual({});
  });

  it("manual triggers require an existing key, run immediately, and advance the recurring clock", async () => {
    const harness = makeHarness();
    const { clock, deliver, processor, state, stream } = harness;
    await expect(processor.buildManualTriggerEvent("ghost")).rejects.toThrow(/no schedule/);

    await stream.append(setEvent("report"));
    await deliver();
    clock.now = T0 + 10_000; // before the 60s occurrence — manual runs anyway
    const { event, executionId } = await processor.buildManualTriggerEvent("report");
    await stream.append(event);
    await deliver();
    await waitForCompletion(harness);
    expect(stream.events.find((e) => e.type === COMPLETED_TYPE)!.payload).toMatchObject({
      executionId,
      outcome: "succeeded",
    });
    // The documented side effect: a manual trigger re-anchors the interval.
    expect(state().schedules["report"]!.nextTriggerAt).toBe(clock.now + 60_000);
    expect(state().schedules["report"]!.runCount).toBe(1);
  });
});

describe("recovery and alarm derivation", () => {
  it("at-least-once: a restart mid-execution re-launches pending triggers on the next wake", async () => {
    const progressStore = makeProgressStore();
    // First incarnation: the execution hangs forever (simulates eviction mid-run).
    const before = makeHarness({
      invokeCapability: () => new Promise(() => {}),
      progressStore,
    });
    await before.stream.append(setEvent("report"));
    await before.deliver();
    before.clock.now = T0 + 61_000;
    await before.processor.triggerDue();
    await before.deliver();
    expect(Object.keys(before.state().pendingTriggers)).toHaveLength(1);
    expect(before.stream.events.filter((e) => e.type === COMPLETED_TYPE)).toHaveLength(0);

    // Second incarnation: same durable progress and stream, fresh in-memory
    // in-flight set. The wake's sweep re-launches the orphaned execution.
    const after = makeHarness({ progressStore });
    after.stream.events = [...before.stream.events];
    after.clock.now = T0 + 62_000;
    await after.processor.triggerDue();
    await vi.waitFor(() => {
      expect(after.stream.events.filter((e) => e.type === COMPLETED_TYPE)).toHaveLength(1);
    });
    expect(after.stream.events.find((e) => e.type === COMPLETED_TYPE)!.payload).toMatchObject({
      key: "report",
      outcome: "succeeded",
    });
  });

  it("a checkpoint-loss replay does not re-run triggers whose completion is already on the stream", async () => {
    // Build a fully settled history with one harness…
    const before = makeHarness();
    await before.stream.append(setEvent("report"));
    await before.deliver();
    before.clock.now = T0 + 61_000;
    await before.processor.triggerDue();
    await before.deliver();
    await waitForCompletion(before);
    expect(vi.mocked(before.invokeCapability)).toHaveBeenCalledTimes(1);

    // …then replay it from offset 0 on a fresh progress store, FRAMED so the
    // completion sits behind the frame's observed head (the catch-up shape).
    // The runner's background lanes are parked so delivery deterministically
    // holds at the frame boundary while the launched execution runs its gate.
    const replay = makeHarness({ parkRunnerBackground: true });
    replay.stream.events = [...before.stream.events];
    const completedOffset = replay.stream.events.find((e) => e.type === COMPLETED_TYPE)!.offset;
    const firstPage = replay.stream.events.filter((e) => e.offset < completedOffset);
    const opened = await replay.runner.openDelivery();
    await opened.sink({
      events: firstPage,
      scannedAfterOffset: opened.checkpointOffset,
      scannedThroughOffset: firstPage.at(-1)!.offset,
      streamMaxOffset: replay.stream.events.at(-1)!.offset,
    });
    // Give any wrongly-launched execution time to run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(replay.invokeCapability).not.toHaveBeenCalled();
    await replay.deliver();
    expect(replay.stream.events.filter((e) => e.type === COMPLETED_TYPE)).toHaveLength(1);
  });

  it("a rejecting repointAlarm fails the frame and the redelivery re-arms (the await is load-bearing)", async () => {
    let rejectOnce = true;
    const harness = makeHarness({
      repointAlarm: async () => {
        if (rejectOnce) {
          rejectOnce = false;
          throw new Error("setAlarm outage");
        }
      },
    });
    const { deliver, repointAlarm, state, stream } = harness;
    await stream.append(setEvent("report"));
    await expect(deliver()).rejects.toThrow("setAlarm outage");
    expect(state().schedules).toEqual({});

    // The cursor did not advance, so redelivering the same events heals.
    await deliver();
    expect(state().schedules["report"]).toBeDefined();
    expect(repointAlarm).toHaveBeenLastCalledWith(T0 + 60_000);
  });

  it("repoints at the head of every delivery: earliest trigger wins, heartbeat while any state remains, deleted when empty", async () => {
    const { deliver, repointAlarm, stream } = makeHarness();
    await stream.append(setEvent("report")); // every 60s → due at T0+60s
    await deliver();
    expect(repointAlarm).toHaveBeenLastCalledWith(T0 + 60_000);

    // A parked entry (no computable occurrence) still holds the heartbeat.
    await stream.append(
      setEvent("report", "async () => {}", { recurrence: { cron: "0 0 30 2 *" } }),
    );
    await deliver();
    expect(repointAlarm).toHaveBeenLastCalledWith(T0 + SCHEDULER_HEARTBEAT_MS);

    // An emptied scheduler deletes its alarm and sleeps for good.
    await stream.append({ type: CANCELLED_TYPE, payload: { key: "report" } });
    await deliver();
    expect(repointAlarm).toHaveBeenLastCalledWith(null);
  });

  it("triggerDue on an empty scheduler deletes the alarm (the heartbeat has nothing to heal)", async () => {
    const { processor, repointAlarm } = makeHarness();
    await processor.triggerDue();
    expect(repointAlarm).toHaveBeenCalledWith(null);
  });

  it("an in-flight execution is never double-launched by concurrent sweeps or redelivery", async () => {
    resetRecordedSpans();
    let invocations = 0;
    const harness = makeHarness({
      invokeCapability: () => {
        invocations += 1;
        return new Promise(() => {}); // hangs — stays in-flight for the whole test
      },
    });
    const { clock, deliver, processor, stream } = harness;
    await stream.append(setEvent("report"));
    await deliver();
    clock.now = T0 + 61_000;
    await processor.triggerDue();
    await deliver(); // launches the execution
    await vi.waitFor(() => expect(invocations).toBe(1));

    // Repeated wakes sweep the still-pending trigger but the in-memory
    // in-flight set dedupes: exactly one live execution per executionId.
    await processor.triggerDue();
    await processor.triggerDue();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(invocations).toBe(1);
    const invocationSpans = recordedSpans.filter(
      (span) => span.name === "scheduler action invocation",
    );
    expect(invocationSpans).toHaveLength(1);
    expect(activeSpans.has(invocationSpans[0]!)).toBe(true);
  });

  it("barren wakes back off exponentially instead of hot-looping at the minimum delay", async () => {
    const harness = makeHarness();
    const { clock, deliver, processor, repointAlarm, stream } = harness;
    await stream.append(setEvent("report"));
    await deliver();
    clock.now = T0 + 61_000;

    // Wake 1 appends the request but ingestion is "wedged" (we never deliver):
    // progress since the last wake is judged by checkpoint movement.
    await processor.triggerDue();
    expect(repointAlarm).toHaveBeenLastCalledWith(clock.now + 1_000);

    await processor.triggerDue();
    expect(repointAlarm).toHaveBeenLastCalledWith(clock.now + 2_000);
    await processor.triggerDue();
    expect(repointAlarm).toHaveBeenLastCalledWith(clock.now + 4_000);

    // Ingestion heals → checkpoint moves → backoff resets to normal cadence.
    await deliver();
    await processor.triggerDue();
    expect(repointAlarm).toHaveBeenLastCalledWith(clock.now + 60_000);
    await waitForCompletion(harness);
  });
});
