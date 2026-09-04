import { createFailing } from "@iterate-com/shared/test-support/failing-test";
import { expect, test, vi } from "vitest";
import {
  makeMemoryProgressStore,
  makeProcessorHarness,
  MemoryStream,
} from "iterate/processors/testing";
import {
  SchedulerProcessor,
  type SchedulerProcessorDeps,
} from "./scheduler-processor-implementation.ts";
import { SchedulerProcessorContract } from "./scheduler-processor-contract.ts";

const T0 = Date.parse("2026-01-15T12:00:00Z");
const COMPLETED_TYPE = "events.iterate.com/scheduler/trigger-completed";

function makeHarness(
  invokeCapability: SchedulerProcessorDeps["dynamicWorkers"]["invokeCapability"],
) {
  const clock = { now: T0 };
  const stream = new MemoryStream("/scheduler/primary");
  return makeProcessorHarness<typeof SchedulerProcessorContract, SchedulerProcessor>({
    createProcessor: (deps) =>
      new SchedulerProcessor({
        ...deps,
        dynamicWorkers: { invokeCapability },
        readAlarm: async () => null,
        repointAlarm: async () => {},
        reads: deps.reads,
      }),
    substrate: { clock, stream, progress: makeMemoryProgressStore(SchedulerProcessorContract) },
  });
}

function setEvent() {
  return {
    type: "events.iterate.com/scheduler/schedule-set",
    payload: {
      action: { kind: "itx-script", script: "async () => ({ made: 'cat-image' })" },
      key: "report",
      recurrence: { every: 60 },
    },
  } as const;
}

async function runOneAction(
  invokeCapability: SchedulerProcessorDeps["dynamicWorkers"]["invokeCapability"],
) {
  const h = makeHarness(invokeCapability);
  await h.append(
    {
      type: "events.iterate.com/scheduler/created",
      idempotencyKey: "scheduler/created:rpc-ownership-regression",
      payload: { config: {} },
    },
    setEvent(),
  );
  h.clock.now = T0 + 61_000;
  await h.processor().triggerDue();
  await h.settle();
  return h.events(COMPLETED_TYPE)[0]!;
}

createFailing(test, /SCHEDULER RESULT NOT DISPOSED/)(
  "DESIRED: a scheduler action disposes its RPC result after detaching the JSON value",
  async () => {
    const dispose = vi.fn();
    const result = Object.assign({ made: "cat-image" }, { [Symbol.dispose]: dispose });

    const completed = await runOneAction(async () => result);

    expect(completed.payload).toMatchObject({
      outcome: "succeeded",
      result: { made: "cat-image" },
    });
    expect(dispose, "SCHEDULER RESULT NOT DISPOSED").toHaveBeenCalledOnce();
  },
);

createFailing(test, /SCHEDULER CLEANUP FAILURE NOT ISOLATED/)(
  "DESIRED: RPC result cleanup failure does not replace a successful scheduler action",
  async () => {
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
    expect(dispose, "SCHEDULER CLEANUP FAILURE NOT ISOLATED").toHaveBeenCalledOnce();
  },
);

createFailing(test, /SCHEDULER NO DISPOSE ON DETACH FAILURE/)(
  "DESIRED: a scheduler disposes its RPC result even when JSON detachment fails",
  async () => {
    const dispose = vi.fn();
    const result: Record<string | symbol, unknown> = { [Symbol.dispose]: dispose };
    result.self = result;

    const completed = await runOneAction(async () => result);

    expect(completed.payload).toMatchObject({ outcome: "failed" });
    expect(dispose, "SCHEDULER NO DISPOSE ON DETACH FAILURE").toHaveBeenCalledOnce();
  },
);
