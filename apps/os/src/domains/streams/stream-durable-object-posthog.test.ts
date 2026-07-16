import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import {
  STREAM_RECOVERY_FORMAT,
  STREAM_RECOVERY_VERSION,
  type StreamRecoveryRestoreInput,
} from "./recovery.ts";
import { StreamEventPostHogExporter } from "./stream-event-posthog.ts";
import { StreamDurableObject } from "./stream-durable-object.ts";
import { StreamSubscribers } from "./stream-subscribers.ts";

const requestFlush = vi.spyOn(StreamEventPostHogExporter.prototype, "requestFlush");
const flushIfDue = vi.spyOn(StreamEventPostHogExporter.prototype, "flushIfDue");

beforeEach(() => {
  requestFlush.mockReset().mockReturnValue(1_050);
  flushIfDue.mockReset().mockResolvedValue(null);
});

describe("StreamDurableObject PostHog boundary", () => {
  it("creates one payload-blind export obligation per nonempty commit", () => {
    const { stream } = createStream();
    requestFlush.mockClear();
    const first = {
      type: "events.iterate.test/posthog-boundary",
      idempotencyKey: "same-event",
      payload: { private: "must not cross the telemetry boundary" },
    } as const;
    const second = {
      type: "events.iterate.test/posthog-boundary",
      payload: { private: "also private" },
    } as const;

    const appended = stream.append(first, first, second);

    expect(appended[1]).toEqual(appended[0]);
    expect(requestFlush).toHaveBeenCalledOnce();
    expect(requestFlush).toHaveBeenCalledWith();

    requestFlush.mockClear();
    expect(stream.append(first)).toEqual([appended[0]]);
    expect(requestFlush).not.toHaveBeenCalled();
  });

  it("rolls back the event if its local export obligation cannot commit", () => {
    const { stream } = createStream();
    requestFlush.mockClear().mockImplementationOnce(() => {
      throw new Error("telemetry state unavailable");
    });
    const input = {
      type: "events.iterate.test/atomic-posthog-obligation",
      idempotencyKey: "atomic-posthog-obligation",
      payload: {},
    } as const;
    const before = stream.runtimeState().coreProcessorState.maxOffset;

    expect(() => stream.append(input)).toThrow("telemetry state unavailable");
    expect(stream.getEvent({ idempotencyKey: input.idempotencyKey })).toBeUndefined();
    expect(stream.runtimeState().coreProcessorState.maxOffset).toBe(before);

    requestFlush.mockReturnValue(1_050);
    expect(stream.append(input)[0]?.offset).toBe(before + 1);
  });

  it("commits the export obligation before post-commit fan-out", async () => {
    const { alarmAt, stream } = createStream();
    const wake = vi.spyOn(StreamSubscribers.prototype, "wake").mockImplementationOnce(() => {
      throw new Error("subscriber fan-out failed");
    });
    requestFlush.mockClear();
    const input = {
      type: "events.iterate.test/posthog-before-fanout",
      idempotencyKey: "posthog-before-fanout",
      payload: {},
    } as const;

    expect(() => stream.append(input)).toThrow("subscriber fan-out failed");

    expect(requestFlush).toHaveBeenCalledOnce();
    expect(requestFlush.mock.invocationCallOrder[0]).toBeLessThan(
      wake.mock.invocationCallOrder[0]!,
    );
    await vi.waitFor(() => expect(alarmAt()).toBe(1_050));
    expect(stream.getEvent({ idempotencyKey: input.idempotencyKey })).toBeDefined();
    wake.mockRestore();
  });

  it("awaits PostHog beneath the native alarm invocation", async () => {
    let resolveFlush: () => void = () => undefined;
    flushIfDue.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFlush = () => resolve(null);
      }),
    );
    const { consumeAlarm, stream } = createStream({ initialAlarmAt: 1_000 });
    requestFlush.mockClear();
    consumeAlarm();

    let completed = false;
    const alarm = stream.alarm().then(() => {
      completed = true;
    });
    await vi.waitFor(() => expect(flushIfDue).toHaveBeenCalledOnce());
    expect(completed).toBe(false);

    resolveFlush();
    await alarm;
    expect(requestFlush).not.toHaveBeenCalled();
  });

  it("publishes work committed while an alarm fetch is yielding", async () => {
    let resolveFlush: () => void = () => undefined;
    flushIfDue.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFlush = () => resolve(null);
      }),
    );
    const nextAttemptAt = vi
      .spyOn(StreamEventPostHogExporter.prototype, "nextAttemptAt", "get")
      .mockReturnValue(2_050);
    const { alarmAt, consumeAlarm, stream } = createStream({ initialAlarmAt: 1_000 });
    requestFlush.mockClear().mockReturnValue(2_050);
    consumeAlarm();

    const alarm = stream.alarm();
    await vi.waitFor(() => expect(flushIfDue).toHaveBeenCalledOnce());
    stream.append({ type: "events.iterate.test/during-posthog-flush", payload: {} });
    resolveFlush();
    await alarm;

    expect(alarmAt()).toBe(2_050);
    nextAttemptAt.mockRestore();
  });

  it.each([
    ["subscription work", () => vi.spyOn(StreamSubscribers.prototype, "onAlarm")],
    ["core checkpoint", null],
  ] as const)("preserves Cloudflare's native retry when %s throws", async (_label, spyFactory) => {
    const onAlarm = spyFactory?.().mockImplementationOnce(() => {
      throw new Error("alarm work failed");
    });
    const { alarmAt, consumeAlarm, failCoreCheckpoint, setAlarm, stream } = createStream({
      initialAlarmAt: 1_000,
    });
    setAlarm.mockClear();
    consumeAlarm();
    if (spyFactory === null) failCoreCheckpoint();

    await expect(stream.alarm()).rejects.toThrow();

    expect(alarmAt()).toBeNull();
    expect(setAlarm).not.toHaveBeenCalled();
    onAlarm?.mockRestore();
  });

  it("preserves Cloudflare's native retry when PostHog fails", async () => {
    flushIfDue.mockRejectedValueOnce(new Error("posthog state write failed"));
    const { alarmAt, consumeAlarm, setAlarm, stream } = createStream({ initialAlarmAt: 1_000 });
    setAlarm.mockClear();
    consumeAlarm();

    await expect(stream.alarm()).rejects.toThrow("posthog state write failed");

    expect(alarmAt()).toBeNull();
    expect(setAlarm).not.toHaveBeenCalled();
  });

  it("deletes a stale replacement after a successful turn with no owner", async () => {
    const { alarmAt, consumeAlarm, deleteAlarm, setAlarm, stream } = createStream({
      initialAlarmAt: 1_000,
      posthogEnabled: false,
    });
    setAlarm.mockClear();
    consumeAlarm();

    await stream.alarm();

    expect(deleteAlarm).toHaveBeenCalledOnce();
    expect(setAlarm).not.toHaveBeenCalled();
    expect(alarmAt()).toBeNull();
  });

  it("adopts committed recovery telemetry before tearing down subscribers", () => {
    const adopt = vi.spyOn(StreamEventPostHogExporter.prototype, "adoptRecoveryState");
    const reset = vi
      .spyOn(StreamSubscribers.prototype, "resetForRecovery")
      .mockImplementationOnce(() => {
        throw new Error("subscriber disposal failed");
      });
    const { stream, values } = createStream();

    expect(() => stream.restoreFromRecovery(recoveryInput())).toThrow("subscriber disposal failed");

    expect(adopt).toHaveBeenCalledOnce();
    expect(adopt.mock.invocationCallOrder[0]).toBeLessThan(reset.mock.invocationCallOrder[0]!);
    expect(values.get("posthogStreamEventExport")).toEqual({
      cursor: 1,
      dueAt: null,
      page: null,
    });
    expect(stream.runtimeState().coreProcessorState.maxOffset).toBe(1);
    adopt.mockRestore();
    reset.mockRestore();
  });

  it("lets authoritative recovery replace malformed telemetry state", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { stream, values } = createStream({
      posthogState: { cursor: "unknown", raw: "customer-secret" },
    });

    expect(stream.restoreFromRecovery(recoveryInput())).toEqual({
      restoredEventCount: 1,
      lastImportedOffset: 1,
      currentMaxOffset: 2,
    });

    expect(values.get("posthogStreamEventExport")).toEqual({
      cursor: 1,
      dueAt: null,
      page: null,
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain("customer-secret");
    error.mockRestore();
  });

  it("does not construct export work without PostHog config", () => {
    requestFlush.mockClear();

    createStream({ posthogEnabled: false });

    expect(requestFlush).not.toHaveBeenCalled();
  });
});

function recoveryInput(): StreamRecoveryRestoreInput {
  return {
    format: STREAM_RECOVERY_FORMAT,
    version: STREAM_RECOVERY_VERSION,
    stream: { projectId: null, path: "/" },
    highestAssignedOffset: 1,
    events: [
      {
        type: "events.iterate.com/stream/created",
        payload: { projectId: null, path: "/" },
        createdAt: "2026-07-16T00:00:00.000Z",
        offset: 1,
        path: "/",
      },
    ],
  };
}

type CreateStreamOptions = {
  initialAlarmAt?: number;
  posthogEnabled?: boolean;
  posthogState?: unknown;
};

function createStream(options: CreateStreamOptions = {}) {
  const values = new Map<string, unknown>();
  if (options.posthogState !== undefined) {
    values.set("posthogStreamEventExport", options.posthogState);
  }
  const db = new DatabaseSync(":memory:");
  let alarmAt: number | null = options.initialAlarmAt ?? null;
  let coreCheckpointFails = false;
  const deleteAlarm = vi.fn(async () => {
    alarmAt = null;
  });
  const setAlarm = vi.fn(async (at: number | Date) => {
    alarmAt = typeof at === "number" ? at : at.getTime();
  });
  const waitUntilPromises: Promise<unknown>[] = [];
  const ctx = {
    blockConcurrencyWhile: (callback: () => Promise<unknown>) => {
      const promise = callback();
      void promise.catch(() => undefined);
      return promise;
    },
    id: {
      name: DurableObjectNameCodec.stringify(
        { path: "/", projectId: null },
        { allowNullProjectId: true },
      ),
      toString: () => "stream-do-id",
    },
    storage: {
      deleteAlarm,
      getAlarm: async () => alarmAt,
      setAlarm,
      kv: {
        get: <T>(key: string) => values.get(key) as T | undefined,
        put: (key: string, value: unknown) => {
          if (key === "state" && coreCheckpointFails) throw new Error("core checkpoint failed");
          values.set(key, value);
        },
      },
      sql: wrapSqlStorage(db),
      transactionSync: <T>(callback: () => T): T => {
        const snapshot = new Map(values);
        db.exec("begin");
        try {
          const result = callback();
          db.exec("commit");
          return result;
        } catch (error) {
          db.exec("rollback");
          values.clear();
          for (const [key, value] of snapshot) values.set(key, value);
          throw error;
        }
      },
    },
    exports: {},
    waitUntil: (promise: Promise<unknown>) => {
      waitUntilPromises.push(promise);
      void promise.catch(() => undefined);
    },
  } as unknown as DurableObjectState;
  const env = {
    ...(options.posthogEnabled === false
      ? {}
      : { APP_CONFIG_POSTHOG: JSON.stringify({ apiKey: "phc_public" }) }),
    WORKER_SELF: "os-test",
  } as unknown as Env;
  const stream = new StreamDurableObject(ctx, env);
  return {
    alarmAt: () => alarmAt,
    consumeAlarm: () => {
      alarmAt = null;
    },
    deleteAlarm,
    failCoreCheckpoint: () => {
      coreCheckpointFails = true;
    },
    setAlarm,
    stream,
    values,
    waitUntilPromises,
  };
}

function wrapSqlStorage(db: DatabaseSync): SqlStorage {
  return {
    exec<T = unknown>(sql: string, ...bindings: (ArrayBuffer | null | number | string)[]) {
      const rows = db
        .prepare(sql)
        .all(
          ...bindings.map((binding) =>
            binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding,
          ),
        )
        .map((row) => Object.fromEntries(Object.entries(row).map(fromNodeSqlValue)));
      return { toArray: () => rows as T[] };
    },
  } as SqlStorage;
}

function fromNodeSqlValue([key, value]: [string, unknown]) {
  if (value instanceof Uint8Array) {
    return [key, value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)];
  }
  return [key, value];
}
