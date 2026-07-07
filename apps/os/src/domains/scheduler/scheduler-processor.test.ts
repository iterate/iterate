import { describe, expect, it, vi } from "vitest";
import type { Stream, StreamEvent, StreamEventInput } from "../../types.ts";
import type { StreamProcessorSnapshot } from "../streams/stream-processor.ts";
import {
  SchedulerProcessor,
  type SchedulerProcessorDeps,
} from "./scheduler-processor-implementation.ts";
import type { SchedulerProcessorState } from "./scheduler-processor-contract.ts";
import { SCHEDULER_HEARTBEAT_MS } from "./recurrence.ts";

const T0 = Date.parse("2026-01-15T12:00:00Z");

/**
 * In-memory Stream with a controllable clock: `createdAt` comes from the same
 * fake clock the processor's `now` dep reads, so reduce-time math
 * (`Date.parse(event.createdAt)`) is exact in assertions.
 */
class MemoryStream implements Stream {
  events: StreamEvent[] = [];

  constructor(readonly clock: { now: number }) {}

  async __describe() {
    return { instructions: "in-memory test stream", types: "", children: {} };
  }

  async append(...inputs: StreamEventInput[]): Promise<StreamEvent[]> {
    return inputs.map((input) => {
      const existing =
        input.idempotencyKey === undefined
          ? undefined
          : this.events.find((event) => event.idempotencyKey === input.idempotencyKey);
      if (existing !== undefined) return existing;
      const event: StreamEvent = {
        ...input,
        createdAt: new Date(this.clock.now).toISOString(),
        offset: this.events.length + 1,
      };
      this.events.push(event);
      return event;
    });
  }

  at(): Stream {
    return this;
  }

  async getEvent(): Promise<StreamEvent | undefined> {
    throw new Error("not used");
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
    return { coreProcessorState: null, runtime: { connections: {} } };
  }

  async subscribe(): Promise<never> {
    throw new Error("MemoryStream does not implement subscribe().");
  }
}

const SET_TYPE = "events.iterate.com/scheduler/schedule-set";
const CANCELLED_TYPE = "events.iterate.com/scheduler/schedule-cancelled";
const REQUESTED_TYPE = "events.iterate.com/scheduler/trigger-requested";
const COMPLETED_TYPE = "events.iterate.com/scheduler/trigger-completed";

function makeHarness(options?: {
  invokeCapability?: SchedulerProcessorDeps["dynamicWorkers"]["invokeCapability"];
  snapshotStore?: { snapshot: StreamProcessorSnapshot<SchedulerProcessorState> | undefined };
}) {
  const clock = { now: T0 };
  const stream = new MemoryStream(clock);
  const repointAlarm = vi.fn();
  const invokeCapability = vi.fn(
    options?.invokeCapability ?? (async () => "ok"),
  ) as SchedulerProcessorDeps["dynamicWorkers"]["invokeCapability"];
  const snapshotStore = options?.snapshotStore ?? { snapshot: undefined };
  const processor = new SchedulerProcessor({
    stream,
    dynamicWorkers: { invokeCapability },
    now: () => clock.now,
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
    await stream.append(setEvent("job", "async () => 1"));
    await deliver();
    const first = processor.state.schedules["job"]!;
    expect(first.nextTriggerAt).toBe(T0 + 60_000);
    expect(first.definedAtOffset).toBe(1);

    await stream.append(setEvent("job", "async () => 2"));
    await deliver();
    const second = processor.state.schedules["job"]!;
    expect(second.action.script).toBe("async () => 2");
    expect(second.definedAtOffset).toBe(2);
    expect(second.runCount).toBe(0);
  });

  it("cancel removes the key and is a no-op for unknown keys", async () => {
    const { deliver, processor, stream } = makeHarness();
    await stream.append(setEvent("job"));
    await stream.append({ type: CANCELLED_TYPE, payload: { key: "job" } });
    await stream.append({ type: CANCELLED_TYPE, payload: { key: "never-existed" } });
    await deliver();
    expect(processor.state.schedules).toEqual({});
  });
});

describe("triggering", () => {
  it("requests due schedules with occurrence-stable idempotency keys and advances the clock", async () => {
    const harness = makeHarness();
    const { clock, deliver, processor, stream } = harness;
    await stream.append(setEvent("job"));
    await deliver();

    clock.now = T0 + 61_000;
    await processor.triggerDue();
    const requested = stream.events.filter((e) => e.type === REQUESTED_TYPE);
    expect(requested).toHaveLength(1);
    expect(requested[0]!.idempotencyKey).toBe(`scheduler/trigger-requested:job:${T0 + 60_000}`);
    expect(requested[0]!.payload).toMatchObject({
      key: "job",
      runCount: 1,
      scheduledFor: new Date(T0 + 60_000).toISOString(),
    });

    // A crashed wake re-running against un-advanced state cannot double-fire:
    // the idempotency key dedupes the append.
    await processor.triggerDue();
    expect(stream.events.filter((e) => e.type === REQUESTED_TYPE)).toHaveLength(1);

    await deliver();
    // The interval re-anchors on the request time.
    expect(processor.state.schedules["job"]!.nextTriggerAt).toBe(clock.now + 60_000);
    expect(processor.state.schedules["job"]!.runCount).toBe(1);

    // And once state advanced, the occurrence is spent for good.
    await processor.triggerDue();
    expect(stream.events.filter((e) => e.type === REQUESTED_TYPE)).toHaveLength(1);
    await waitForCompletion(harness);
  });

  it("executes the script with (schedule, trigger) args and records success + provenance", async () => {
    const harness = makeHarness({ invokeCapability: async () => ({ made: "cat-image" }) });
    const { clock, deliver, invokeCapability, processor, stream } = harness;
    await stream.append(
      setEvent("job", "async (itx, schedule, trigger) => 42", {
        metadata: { owner: "test" },
      }),
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
      key: "job",
      metadata: { owner: "test" },
      recurrence: { every: 60 },
    });
    expect(triggerArg).toMatchObject({ runCount: 1 });
    expect(typeof triggerArg.executionId).toBe("string");

    const completed = stream.events.find((e) => e.type === COMPLETED_TYPE)!;
    expect(completed.payload).toMatchObject({
      definedAtOffset: 1,
      key: "job",
      outcome: "succeeded",
      result: { made: "cat-image" },
    });
    expect(completed.idempotencyKey).toBe(`scheduler/trigger-completed:${triggerArg.executionId}`);
    expect(processor.state.pendingTriggers).toEqual({});
  });

  it("records a throwing script as outcome=failed and keeps the recurrence alive", async () => {
    const harness = makeHarness({
      invokeCapability: async () => {
        throw new Error("script exploded");
      },
    });
    const { clock, deliver, processor, stream } = harness;
    await stream.append(setEvent("job"));
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
    expect(processor.state.schedules["job"]!.nextTriggerAt).toBe(clock.now + 60_000);
  });

  it("completes as skipped when the schedule was cancelled between request and execution", async () => {
    const harness = makeHarness();
    const { clock, deliver, invokeCapability, processor, stream } = harness;
    await stream.append(setEvent("job"));
    await deliver();
    clock.now = T0 + 61_000;
    await processor.triggerDue(); // appends trigger-requested (not yet delivered)
    await stream.append({ type: CANCELLED_TYPE, payload: { key: "job" } });
    await deliver(); // one batch: requested + cancelled reduce before the execution runs
    await waitForCompletion(harness);

    expect(invokeCapability).not.toHaveBeenCalled();
    expect(stream.events.find((e) => e.type === COMPLETED_TYPE)!.payload).toMatchObject({
      key: "job",
      outcome: "skipped",
    });
    expect(processor.state.pendingTriggers).toEqual({});
  });

  it("latest-code-wins: a re-set between request and execution runs the new code", async () => {
    const harness = makeHarness();
    const { clock, deliver, invokeCapability, stream } = harness;
    await stream.append(setEvent("job", "async () => 'v1'"));
    await deliver();
    clock.now = T0 + 61_000;
    await harness.processor.triggerDue();
    const [reset] = await stream.append(setEvent("job", "async () => 'v2'"));
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

  it("manual triggers require an existing key and run immediately", async () => {
    const harness = makeHarness();
    const { deliver, processor, stream } = harness;
    expect(() => processor.buildManualTriggerEvent("ghost")).toThrow(/no schedule/);

    await stream.append(setEvent("job"));
    await deliver();
    const { event, executionId } = processor.buildManualTriggerEvent("job");
    await stream.append(event);
    await deliver();
    await waitForCompletion(harness);
    expect(stream.events.find((e) => e.type === COMPLETED_TYPE)!.payload).toMatchObject({
      executionId,
      outcome: "succeeded",
    });
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
    await before.stream.append(setEvent("job"));
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
      key: "job",
      outcome: "succeeded",
    });
  });

  it("repoints the alarm after every batch: earliest trigger wins, heartbeat is the floor", async () => {
    const { deliver, repointAlarm, stream } = makeHarness();
    await stream.append(setEvent("job")); // every 60s → due at T0+60s
    await deliver();
    expect(repointAlarm).toHaveBeenLastCalledWith(T0 + 60_000);

    await stream.append({ type: CANCELLED_TYPE, payload: { key: "job" } });
    await deliver();
    expect(repointAlarm).toHaveBeenLastCalledWith(T0 + SCHEDULER_HEARTBEAT_MS);
  });

  it("triggerDue repoints even when nothing is due (the heartbeat wake path)", async () => {
    const { processor, repointAlarm } = makeHarness();
    await processor.triggerDue();
    expect(repointAlarm).toHaveBeenCalledWith(T0 + SCHEDULER_HEARTBEAT_MS);
  });
});
