import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStream } from "iterate/processors/testing";
import type { Env } from "../../env.ts";
import type { ScriptExecutionStartOptions } from "./script-execution-durable-object.ts";

const h = vi.hoisted(() => ({
  invoke: vi.fn<(input: unknown) => Promise<unknown>>(),
}));

vi.mock("../workers/worker-runner.ts", () => ({
  DynamicWorkerRunner: class {
    invokeCapability(input: unknown) {
      return h.invoke(input);
    }
  },
}));

const { ScriptExecutionDurableObject } = await import("./script-execution-durable-object.ts");

const EXECUTION_ID = "exec-alarm-owned";
const PROJECT_ID = "prj_test";
const SCOPE_PATH = "/agents/test";
const STATE_KEY = "script-execution:state";
const STREAM_ID = "11111111-1111-4111-8111-111111111111";

function options(
  overrides: Partial<ScriptExecutionStartOptions> = {},
): ScriptExecutionStartOptions {
  return {
    executionExpiresAt: Date.now() + 60_000,
    projectId: PROJECT_ID,
    scopePath: SCOPE_PATH,
    settlementExpiresAt: Date.now() + 75_000,
    streamContext: {
      kind: "script-execution",
      executionId: EXECUTION_ID,
      scriptRunRequestedEventOffset: 3,
      streamPath: SCOPE_PATH,
    },
    streamId: STREAM_ID,
    ...overrides,
  };
}

function executor(
  input: {
    appendIfStreamId?: (args: {
      streamId: string;
      events: Parameters<MemoryStream["append"]>;
    }) => Promise<unknown>;
    executionId?: string;
    records?: Map<string, unknown>;
    stream?: MemoryStream;
  } = {},
) {
  const records = input.records ?? new Map<string, unknown>();
  const stream = input.stream ?? new MemoryStream(SCOPE_PATH);
  stream.streamId = STREAM_ID;
  const setAlarm = vi.fn(async () => undefined);
  const ctx = {
    blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => await callback(),
    exports: {},
    id: { name: input.executionId ?? EXECUTION_ID },
    storage: {
      kv: {
        delete: (key: string) => records.delete(key),
        get: <T>(key: string) => records.get(key) as T | undefined,
        put: (key: string, value: unknown) => records.set(key, value),
      },
      setAlarm,
    },
  } as unknown as DurableObjectState;
  const env = {
    STREAM: {
      getByName: () => ({
        appendIfStreamId:
          input.appendIfStreamId ??
          ((args) =>
            stream.appendIfStreamId({
              events: args.events,
              streamId: args.streamId,
            })),
        getEvent: (args: { idempotencyKey: string }) => stream.getEvent(args),
      }),
    },
  } as unknown as Env;
  return {
    records,
    setAlarm,
    stream,
    value: new ScriptExecutionDurableObject(ctx, env),
  };
}

describe("ScriptExecutionDurableObject alarm ownership", () => {
  beforeEach(() => {
    h.invoke.mockReset();
  });

  it("persists and arms in start, then keeps the full invocation inside the alarm", async () => {
    const invocation = Promise.withResolvers<unknown>();
    h.invoke.mockReturnValueOnce(invocation.promise);
    const x = executor();

    await x.value.start("async () => 42", options());

    expect(h.invoke).not.toHaveBeenCalled();
    expect(x.setAlarm).toHaveBeenCalledOnce();
    expect(x.records.get(STATE_KEY)).toMatchObject({ phase: "queued" });

    const alarm = x.value.alarm();
    await vi.waitFor(() => {
      expect(h.invoke).toHaveBeenCalledOnce();
      expect(x.records.get(STATE_KEY)).toMatchObject({ phase: "running" });
    });

    invocation.resolve({ answer: 42 });
    await alarm;

    expect(x.records.get(STATE_KEY)).toMatchObject({ phase: "settled" });
    expect(x.stream.events).toMatchObject([
      {
        idempotencyKey: `capability-host/script-run-settled@${EXECUTION_ID}`,
        payload: {
          executionId: EXECUTION_ID,
          settlement: { result: { answer: 42 }, status: "succeeded" },
        },
      },
    ]);
  });

  it("settles a recovered running phase as orphaned without replaying arbitrary code", async () => {
    const invocation = Promise.withResolvers<unknown>();
    h.invoke.mockReturnValueOnce(invocation.promise);
    const records = new Map<string, unknown>();
    const stream = new MemoryStream(SCOPE_PATH);
    const first = executor({ records, stream });
    await first.value.start("async () => doSomethingOnce()", options());
    const firstAlarm = first.value.alarm();
    await vi.waitFor(() => {
      expect(records.get(STATE_KEY)).toMatchObject({ phase: "running" });
    });

    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const recovered = executor({ records, stream });
    await recovered.value.alarm();

    expect(h.invoke).toHaveBeenCalledOnce();
    expect(stream.events).toMatchObject([
      {
        payload: {
          executionId: EXECUTION_ID,
          settlement: {
            executionMayHaveOccurred: true,
            failureKind: "orphaned",
            phase: "recovery",
            status: "failed",
          },
        },
      },
    ]);
    expect(consoleWarn).toHaveBeenCalledWith(
      "[script-execution] recovered interrupted alarm without replaying script",
      { executionId: EXECUTION_ID },
    );

    invocation.resolve("late success");
    await firstAlarm;
    expect(h.invoke).toHaveBeenCalledOnce();
    expect(stream.events).toHaveLength(1);
    consoleWarn.mockRestore();
  });

  it("retries a persisted settlement without invoking the script again", async () => {
    h.invoke.mockResolvedValueOnce("done");
    const records = new Map<string, unknown>();
    const stream = new MemoryStream(SCOPE_PATH);
    let unavailable = true;
    const appendIfStreamId = async (args: {
      streamId: string;
      events: Parameters<MemoryStream["append"]>;
    }) => {
      if (unavailable) {
        throw Object.assign(new Error("stream reset"), { durableObjectReset: true });
      }
      return await stream.appendIfStreamId(args);
    };
    const first = executor({ appendIfStreamId, records, stream });
    await first.value.start("async () => 'done'", options());

    await expect(first.value.alarm()).rejects.toThrow();
    expect(records.get(STATE_KEY)).toMatchObject({
      phase: "settling",
      settlement: { result: "done", status: "succeeded" },
    });

    unavailable = false;
    const recovered = executor({ appendIfStreamId, records, stream });
    await recovered.value.alarm();

    expect(h.invoke).toHaveBeenCalledOnce();
    expect(records.get(STATE_KEY)).toMatchObject({ phase: "settled" });
    expect(stream.events).toHaveLength(1);
  });

  it("never invokes a queued execution whose absolute deadline has passed", async () => {
    const x = executor();
    await x.value.start(
      "async () => shouldNotRun()",
      options({
        executionExpiresAt: Date.now() - 1,
        settlementExpiresAt: Date.now() + 15_000,
      }),
    );

    await x.value.alarm();

    expect(h.invoke).not.toHaveBeenCalled();
    expect(x.stream.events[0]).toMatchObject({
      payload: {
        settlement: {
          executionMayHaveOccurred: false,
          phase: "before-execution",
          status: "failed",
        },
      },
    });
  });

  it("accepts exact duplicate handoffs and rejects mismatched reuse of an execution id", async () => {
    const x = executor();
    const startOptions = options();
    await x.value.start("async () => 1", startOptions);
    await x.value.start("async () => 1", startOptions);
    await expect(x.value.start("async () => 2", startOptions)).rejects.toThrow(
      "mismatched duplicate handoff",
    );

    expect(x.records.get(STATE_KEY)).toMatchObject({
      phase: "queued",
      request: { code: "async () => 1" },
    });
    expect(x.setAlarm).toHaveBeenCalledTimes(2);
  });

  it("rejects a handoff addressed to the wrong executor identity", async () => {
    const x = executor({ executionId: "exec-other" });
    await expect(x.value.start("async () => 1", options())).rejects.toThrow(
      `script execution "${EXECUTION_ID}" does not match executor identity "exec-other"`,
    );
    expect(x.records.size).toBe(0);
  });
});
