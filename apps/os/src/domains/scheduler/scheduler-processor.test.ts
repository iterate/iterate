import { describe, expect, it, vi } from "vitest";
import type { Stream } from "../../itx-api.generated.ts";
import type { StreamEvent, StreamEventInput } from "../streams/schemas.ts";
import type { StreamProcessorSnapshot } from "../streams/stream-processor.ts";
import {
  SchedulerProcessor,
  type SchedulerProcessorDeps,
} from "./scheduler-processor-implementation.ts";
import type {
  ScheduleSetPayload,
  SchedulerProcessorState,
} from "./scheduler-processor-contract.ts";
import { SCHEDULER_HEARTBEAT_MS } from "./recurrence.ts";

const T0 = Date.parse("2026-01-15T12:00:00Z");

/**
 * In-memory Stream with a controllable clock: `createdAt` comes from the same
 * fake clock the processor's `now` dep reads, so reduce-time math
 * (`Date.parse(event.createdAt)`) is exact in assertions. `failAppendsOfType`
 * simulates a transient Stream DO outage for specific event types.
 */
class MemoryStream implements Stream {
  events: StreamEvent[] = [];
  failAppendsOfType: string | undefined;

  constructor(
    readonly clock: { now: number },
    readonly path = "/scheduler/primary",
  ) {}

  async __describe() {
    return { instructions: "in-memory test stream", types: "", children: {} };
  }

  async kill(): Promise<void> {}

  async append(...inputs: StreamEventInput[]): Promise<StreamEvent[]> {
    return inputs.map((input) => {
      if (input.type === this.failAppendsOfType) {
        throw new Error(`injected append failure for ${input.type}`);
      }
      const existing =
        input.idempotencyKey === undefined
          ? undefined
          : this.events.find((event) => event.idempotencyKey === input.idempotencyKey);
      if (existing !== undefined) return existing;
      const event: StreamEvent = {
        ...input,
        createdAt: new Date(this.clock.now).toISOString(),
        offset: this.events.length + 1,
        path: this.path,
      };
      this.events.push(event);
      return event;
    });
  }

  at(): Stream {
    return this;
  }

  async getEvent(
    input: { offset: number } | { idempotencyKey: string },
  ): Promise<StreamEvent | undefined> {
    if ("offset" in input) return this.events.find((event) => event.offset === input.offset);
    return this.events.find((event) => event.idempotencyKey === input.idempotencyKey);
  }

  async getEvents(input: Parameters<Stream["getEvents"]>[0] = {}): Promise<StreamEvent[]> {
    const { afterOffset = 0, limit = 500 } = input;
    return this.events.filter((event) => event.offset > afterOffset).slice(0, limit);
  }

  readEvents(input: Parameters<Stream["readEvents"]>[0] = {}) {
    let afterOffset = input.afterOffset ?? 0;
    return {
      next: async () => {
        const page = await this.getEvents({ ...input, afterOffset });
        afterOffset = page.at(-1)?.offset ?? afterOffset;
        return page;
      },
      [Symbol.dispose]() {},
    };
  }

  async waitForEvent(): Promise<StreamEvent> {
    throw new Error("not used");
  }

  async getProcessorRuntimeState(): Promise<null> {
    return null;
  }

  async runtimeState() {
    return { coreProcessorState: null, runtime: { connections: {}, subscriptions: {} } };
  }

  async subscribe(): Promise<never> {
    throw new Error("MemoryStream does not implement subscribe().");
  }

  async acceptCrossPost(): Promise<never> {
    throw new Error("MemoryStream does not implement acceptCrossPost().");
  }

  async crossPostTo(): Promise<never> {
    throw new Error("MemoryStream does not implement crossPostTo().");
  }

  async removeCrossPost(): Promise<never> {
    throw new Error("MemoryStream does not implement removeCrossPost().");
  }
}

const SET_TYPE = "events.iterate.com/scheduler/schedule-set";
const CANCELLED_TYPE = "events.iterate.com/scheduler/schedule-cancelled";
const REQUESTED_TYPE = "events.iterate.com/scheduler/trigger-requested";
const COMPLETED_TYPE = "events.iterate.com/scheduler/trigger-completed";

function makeHarness(options?: {
  invokeCapability?: SchedulerProcessorDeps["dynamicWorkers"]["invokeCapability"];
  repointAlarm?: SchedulerProcessorDeps["repointAlarm"];
  snapshotStore?: { snapshot: StreamProcessorSnapshot<SchedulerProcessorState> | undefined };
}) {
  const clock = { now: T0 };
  const stream = new MemoryStream(clock);
  const repointAlarm = vi.fn(options?.repointAlarm ?? (async () => {}));
  const invokeCapability = vi.fn(
    options?.invokeCapability ?? (async () => "ok"),
  ) as SchedulerProcessorDeps["dynamicWorkers"]["invokeCapability"];
  const snapshotStore = options?.snapshotStore ?? { snapshot: undefined };
  const processor = new SchedulerProcessor({
    stream,
    path: stream.path,
    projectId: null,
    dynamicWorkers: { invokeCapability },
    now: () => clock.now,
    readAlarm: async () => null,
    repointAlarm,
    readState: () => snapshotStore.snapshot,
    writeState: (snapshot) => {
      snapshotStore.snapshot = snapshot;
    },
  });
  let cursor = 0;
  const deliver = async () => {
    // Deliver until quiet: executions append events that need delivering too.
    for (;;) {
      const events = stream.events.slice(cursor);
      if (events.length === 0) return;
      cursor = stream.events.length;
      await processor.ingest({ events, streamMaxOffset: stream.events.length });
    }
  };
  return { clock, deliver, invokeCapability, processor, repointAlarm, snapshotStore, stream };
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
    const { deliver, processor, stream } = makeHarness();
    await stream.append(setEvent("report", "async () => 1"));
    await deliver();
    const first = processor.state.schedules["report"]!;
    expect(first.nextTriggerAt).toBe(T0 + 60_000);
    expect(first.definedAtOffset).toBe(1);

    await stream.append(setEvent("report", "async () => 2"));
    await deliver();
    const second = processor.state.schedules["report"]!;
    expect(second.action.script).toBe("async () => 2");
    expect(second.definedAtOffset).toBe(2);
    expect(second.runCount).toBe(0);
  });

  it("cancel removes the key and is a no-op for unknown keys", async () => {
    const { deliver, processor, stream } = makeHarness();
    await stream.append(setEvent("report"));
    await deliver();
    expect(processor.state.schedules["report"]).toBeDefined();

    await stream.append({ type: CANCELLED_TYPE, payload: { key: "report" } });
    await stream.append({ type: CANCELLED_TYPE, payload: { key: "never-existed" } });
    await deliver();
    expect(processor.state.schedules).toEqual({});
  });

  it("tolerates raw-append trigger events for ghosts: unknown key completes as skipped, unknown executionId is a no-op", async () => {
    const harness = makeHarness();
    const { deliver, invokeCapability, processor, stream } = harness;
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
    expect(processor.state.pendingTriggers).toEqual({});
    expect(processor.state.schedules).toEqual({});
  });

  it("parks a raw-appended cron with no future occurrence instead of poisoning the fold, and it survives completion", async () => {
    const harness = makeHarness();
    const { deliver, processor, stream } = harness;
    // Feb 30 never occurs; assertValidRecurrence would reject this at set()
    // time, but raw appends bypass the command surface.
    await stream.append(
      setEvent("impossible", "async () => 'never'", {
        recurrence: { cron: "0 0 30 2 *" },
      }),
    );
    await deliver();
    expect(processor.state.schedules["impossible"]!.nextTriggerAt).toBeNull();
    expect(processor.getScheduleView("impossible")).toMatchObject({ nextTriggerAt: null });

    // Manually triggering a parked (non-one-shot) schedule runs it and keeps it.
    const { event } = processor.buildManualTriggerEvent("impossible");
    await stream.append(event);
    await deliver();
    await waitForCompletion(harness);
    expect(processor.state.schedules["impossible"]).toBeDefined();
    expect(processor.state.schedules["impossible"]!.nextTriggerAt).toBeNull();
  });

  it("exposes the public view shape: metadata round-trip, ISO conversion, key-sorted list", async () => {
    const { deliver, processor, stream } = makeHarness();
    await stream.append(setEvent("zulu"));
    await stream.append(setEvent("alpha", "async () => {}", { metadata: { owner: "tests" } }));
    await deliver();

    expect(processor.getScheduleView("missing")).toBeUndefined();
    expect(processor.getScheduleView("alpha")).toEqual({
      action: { kind: "itx-script", script: "async () => {}" },
      definedAtOffset: 2,
      key: "alpha",
      metadata: { owner: "tests" },
      nextTriggerAt: new Date(T0 + 60_000).toISOString(),
      recurrence: { every: 60 },
      runCount: 0,
      setAt: new Date(T0).toISOString(),
    });
    expect(processor.listScheduleViews().map((view) => view.key)).toEqual(["alpha", "zulu"]);
  });
});

describe("triggering", () => {
  it("requests due schedules with incarnation-scoped idempotency keys and advances the clock", async () => {
    const harness = makeHarness();
    const { clock, deliver, processor, stream } = harness;
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
    expect(processor.state.schedules["report"]!.nextTriggerAt).toBe(clock.now + 60_000);
    expect(processor.state.schedules["report"]!.runCount).toBe(1);

    // And once state advanced, the occurrence is spent for good.
    await processor.triggerDue();
    expect(stream.events.filter((e) => e.type === REQUESTED_TYPE)).toHaveLength(1);
    await waitForCompletion(harness);
  });

  it("a re-set one-shot with the same instant triggers again (incarnation in the idempotency key)", async () => {
    const harness = makeHarness();
    const { clock, deliver, processor, stream } = harness;
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
    expect(processor.state.schedules).toEqual({});

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
    const { clock, deliver, invokeCapability, processor, stream } = harness;
    await stream.append(
      setEvent("report", "async (itx, schedule, trigger) => 42", { metadata: { owner: "test" } }),
    );
    await deliver();
    clock.now = T0 + 61_000;
    await processor.triggerDue();
    await deliver();
    await waitForCompletion(harness);

    expect(invokeCapability).toHaveBeenCalledTimes(1);
    const call = vi.mocked(invokeCapability).mock.calls[0]![0];
    expect(call.path).toEqual(["run"]);
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
    expect(processor.state.pendingTriggers).toEqual({});
  });

  it("recovers schedule path from the defining event for legacy snapshots", async () => {
    const snapshotStore: {
      snapshot: StreamProcessorSnapshot<SchedulerProcessorState> | undefined;
    } = { snapshot: undefined };
    const harness = makeHarness({ snapshotStore });
    const { clock, deliver, invokeCapability, processor, stream } = harness;
    const [defined] = await stream.append(setEvent("report"));
    const payload = defined!.payload as ScheduleSetPayload;
    snapshotStore.snapshot = {
      offset: defined!.offset,
      state: {
        pendingTriggers: {},
        schedules: {
          report: {
            action: payload.action,
            definedAtOffset: defined!.offset,
            nextTriggerAt: T0 + 60_000,
            recurrence: payload.recurrence,
            runCount: 0,
            setAt: defined!.createdAt,
          },
        },
      },
    };

    clock.now = T0 + 61_000;
    await processor.triggerDue();
    await deliver();
    await waitForCompletion(harness);

    const call = vi.mocked(invokeCapability).mock.calls[0]![0];
    const [scheduleArg] = call.args as [Record<string, unknown>];
    expect(scheduleArg).toMatchObject({ key: "report", path: stream.path });
  });

  it("records a throwing script as outcome=failed and keeps the recurrence alive", async () => {
    const harness = makeHarness({
      invokeCapability: async () => {
        throw new Error("script exploded");
      },
    });
    const { clock, deliver, processor, stream } = harness;
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
    // Failure does not retry and does not kill the schedule: next occurrence stands.
    expect(processor.state.schedules["report"]!.nextTriggerAt).toBe(clock.now + 60_000);
  });

  it("a failed completion append is a transport error, not a script outcome: the sweep retries", async () => {
    const harness = makeHarness();
    const { clock, deliver, invokeCapability, processor, stream } = harness;
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
    await vi.waitFor(() => expect(Object.keys(processor.state.pendingTriggers)).toHaveLength(1));

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
    const { clock, deliver, invokeCapability, processor, stream } = harness;
    await stream.append(setEvent("report"));
    await deliver();
    clock.now = T0 + 61_000;
    await processor.triggerDue(); // appends trigger-requested (not yet delivered)
    await stream.append({ type: CANCELLED_TYPE, payload: { key: "report" } });
    await deliver(); // one batch: requested + cancelled reduce before the execution runs
    await waitForCompletion(harness);

    expect(invokeCapability).not.toHaveBeenCalled();
    expect(stream.events.find((e) => e.type === COMPLETED_TYPE)!.payload).toMatchObject({
      key: "report",
      outcome: "skipped",
    });
    expect(processor.state.pendingTriggers).toEqual({});
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
    const { clock, deliver, processor, stream } = harness;
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
    expect(processor.state.schedules).toEqual({});
  });

  it("manual triggers require an existing key, run immediately, and advance the recurring clock", async () => {
    const harness = makeHarness();
    const { clock, deliver, processor, stream } = harness;
    expect(() => processor.buildManualTriggerEvent("ghost")).toThrow(/no schedule/);

    await stream.append(setEvent("report"));
    await deliver();
    clock.now = T0 + 10_000; // before the 60s occurrence — manual runs anyway
    const { event, executionId } = processor.buildManualTriggerEvent("report");
    await stream.append(event);
    await deliver();
    await waitForCompletion(harness);
    expect(stream.events.find((e) => e.type === COMPLETED_TYPE)!.payload).toMatchObject({
      executionId,
      outcome: "succeeded",
    });
    // The documented side effect: a manual trigger re-anchors the interval.
    expect(processor.state.schedules["report"]!.nextTriggerAt).toBe(clock.now + 60_000);
    expect(processor.state.schedules["report"]!.runCount).toBe(1);
  });
});

describe("recovery and alarm derivation", () => {
  it("at-least-once: a restart mid-execution re-launches pending triggers on the next wake", async () => {
    const snapshotStore = {
      snapshot: undefined as StreamProcessorSnapshot<SchedulerProcessorState> | undefined,
    };
    // First incarnation: the execution hangs forever (simulates eviction mid-run).
    const before = makeHarness({
      invokeCapability: () => new Promise(() => {}),
      snapshotStore,
    });
    await before.stream.append(setEvent("report"));
    await before.deliver();
    before.clock.now = T0 + 61_000;
    await before.processor.triggerDue();
    await before.deliver();
    expect(Object.keys(before.processor.state.pendingTriggers)).toHaveLength(1);
    expect(before.stream.events.filter((e) => e.type === COMPLETED_TYPE)).toHaveLength(0);

    // Second incarnation: same durable checkpoint and stream, fresh in-memory
    // in-flight set. The wake's sweep re-launches the orphaned execution.
    const after = makeHarness({ snapshotStore });
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

    // …then replay it from offset 0 on a fresh checkpoint, PAGED so the
    // completion sits in a later batch than its request (the catch-up shape).
    const replay = makeHarness();
    replay.stream.events = [...before.stream.events];
    const completedOffset = replay.stream.events.find((e) => e.type === COMPLETED_TYPE)!.offset;
    const firstPage = replay.stream.events.filter((e) => e.offset < completedOffset);
    await replay.processor.ingest({
      events: firstPage,
      streamMaxOffset: replay.stream.events.length,
    });
    // Give any wrongly-launched execution time to run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(replay.invokeCapability).not.toHaveBeenCalled();
    await replay.deliver();
    expect(replay.stream.events.filter((e) => e.type === COMPLETED_TYPE)).toHaveLength(1);
  });

  it("a rejecting repointAlarm fails the batch and the redelivery re-arms (the await is load-bearing)", async () => {
    let rejectOnce = true;
    const harness = makeHarness({
      repointAlarm: async () => {
        if (rejectOnce) {
          rejectOnce = false;
          throw new Error("setAlarm outage");
        }
      },
    });
    const { processor, repointAlarm, stream } = harness;
    await stream.append(setEvent("report"));
    const events = stream.events.slice();
    await expect(processor.ingest({ events, streamMaxOffset: 1 })).rejects.toThrow(
      "setAlarm outage",
    );
    expect(processor.state.schedules).toEqual({});

    // The checkpoint did not advance, so redelivering the same batch heals.
    await processor.ingest({ events, streamMaxOffset: 1 });
    expect(processor.state.schedules["report"]).toBeDefined();
    expect(repointAlarm).toHaveBeenLastCalledWith(T0 + 60_000);
  });

  it("repoints after every batch: earliest trigger wins, heartbeat while any state remains, deleted when empty", async () => {
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
