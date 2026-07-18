import { expect, test, vi } from "vitest";
import {
  StreamProcessorRunner,
  type ProcessorProgress,
  type ProcessorProgressStore,
} from "iterate/processors";
import { MemoryStream } from "iterate/processors/testing";
import {
  SchedulerProcessor,
  type SchedulerProcessorDeps,
} from "./scheduler-processor-implementation.ts";
import {
  SchedulerProcessorContract,
  type SchedulerProcessorState,
} from "./scheduler-processor-contract.ts";

const T0 = Date.parse("2026-01-15T12:00:00Z");
const COMPLETED_TYPE = "events.iterate.com/scheduler/trigger-completed";

function makeProgressStore(): ProcessorProgressStore<SchedulerProcessorState> {
  let record: ProcessorProgress<SchedulerProcessorState> | undefined;
  return {
    read: () => (record === undefined ? undefined : structuredClone(record)),
    commit: (progress, options) => {
      const persistedRevision = record?.processing.cursorRevision ?? 0;
      if (options.expectedCursorRevision !== persistedRevision) {
        throw new Error(
          `progress commit fenced: expected ${options.expectedCursorRevision}, persisted ${persistedRevision}`,
        );
      }
      record = structuredClone(progress);
    },
  };
}

function makeHarness(
  invokeCapability: SchedulerProcessorDeps["dynamicWorkers"]["invokeCapability"],
) {
  const clock = { now: T0 };
  const stream = new MemoryStream("/scheduler/primary");
  stream.now = () => clock.now;
  stream.events.push({
    type: "events.iterate.com/scheduler/created",
    idempotencyKey: "scheduler/created:rpc-ownership-regression",
    payload: { config: {} },
    createdAt: new Date(clock.now).toISOString(),
    offset: 1,
    path: stream.path,
  });

  let runner!: StreamProcessorRunner<typeof SchedulerProcessorContract, SchedulerProcessorDeps>;
  const processor = new SchedulerProcessor({
    stream,
    path: stream.path,
    projectId: null,
    dynamicWorkers: { invokeCapability },
    now: () => clock.now,
    readAlarm: async () => null,
    repointAlarm: async () => {},
    reads: {
      snapshot: () => runner.snapshot(),
      waitUntilEvent: (input) => runner.waitUntilEvent(input),
    },
  });
  runner = new StreamProcessorRunner({
    processor,
    stream,
    durability: { progress: makeProgressStore() },
    now: () => clock.now,
  });

  const deliver = async () => {
    for (;;) {
      const head = stream.events.at(-1)?.offset ?? 0;
      const { offset } = await runner.snapshot();
      if (offset >= head) return;
      await runner.catchUp();
    }
  };

  return { clock, deliver, processor, stream };
}

function setEvent() {
  return {
    type: "events.iterate.com/scheduler/schedule-set",
    payload: {
      action: { kind: "itx-script", script: "async () => ({ made: 'cat-image' })" },
      key: "report",
      recurrence: { every: 60 },
    },
  };
}

async function runOneAction(
  invokeCapability: SchedulerProcessorDeps["dynamicWorkers"]["invokeCapability"],
) {
  const harness = makeHarness(invokeCapability);
  await harness.stream.append(setEvent());
  await harness.deliver();
  harness.clock.now = T0 + 61_000;
  await harness.processor.triggerDue();
  await harness.deliver();
  await vi.waitFor(() => {
    expect(harness.stream.events.some((event) => event.type === COMPLETED_TYPE)).toBe(true);
  });
  await harness.deliver();
  return harness.stream.events.find((event) => event.type === COMPLETED_TYPE)!;
}

test.fails("DESIRED: a scheduler action disposes its RPC result after detaching the JSON value", async () => {
  const dispose = vi.fn();
  const result = Object.assign({ made: "cat-image" }, { [Symbol.dispose]: dispose });

  const completed = await runOneAction(async () => result);

  expect(completed.payload).toMatchObject({
    outcome: "succeeded",
    result: { made: "cat-image" },
  });
  expect(dispose).toHaveBeenCalledOnce();
});

test.fails("DESIRED: RPC result cleanup failure does not replace a successful scheduler action", async () => {
  const cleanupError = new Error("dispose failed");
  const dispose = vi.fn(() => {
    throw cleanupError;
  });
  const result = Object.assign({ made: "cat-image" }, { [Symbol.dispose]: dispose });

  const completed = await runOneAction(async () => result);

  expect(completed.payload).toMatchObject({
    outcome: "succeeded",
    result: { made: "cat-image" },
  });
  expect(dispose).toHaveBeenCalledOnce();
});

test.fails("DESIRED: a scheduler disposes its RPC result even when JSON detachment fails", async () => {
  const dispose = vi.fn();
  const result: Record<string | symbol, unknown> = { [Symbol.dispose]: dispose };
  result.self = result;

  const completed = await runOneAction(async () => result);

  expect(completed.payload).toMatchObject({ outcome: "failed" });
  expect(dispose).toHaveBeenCalledOnce();
});
