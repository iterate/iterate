import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { STREAM_RECOVERY_FORMAT, STREAM_RECOVERY_VERSION } from "./recovery.ts";
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
  it("publishes new and idempotently retried commits without passing event data", () => {
    const { stream } = createStream();
    requestFlush.mockClear().mockReturnValueOnce(1_050);

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
    expect(requestFlush).toHaveBeenCalledOnce();

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failedInput = {
      type: "events.iterate.test/posthog-boundary",
      idempotencyKey: "telemetry-failure",
      payload: { private: "still committed" },
    } as const;
    requestFlush.mockImplementationOnce(() => {
      throw new Error("telemetry exploded");
    });
    expect(() => stream.append(failedInput)).toThrow("telemetry exploded");
    const survived = stream.getEvent({ idempotencyKey: failedInput.idempotencyKey });
    expect(survived?.offset).toBe(appended[2]!.offset + 1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        errorName: "Error",
        message: "stream_posthog_flush_request_failed",
        projectId: null,
        streamId: "stream-do-id",
      }),
    );
    requestFlush.mockClear();
    expect(stream.append(failedInput)).toEqual([survived]);
    expect(requestFlush).toHaveBeenCalledOnce();

    requestFlush.mockClear();
    expect(() =>
      stream.append({
        type: "events.iterate.test/posthog-boundary",
        offset: 999,
        payload: {},
      } as unknown as Parameters<StreamDurableObject["append"]>[0]),
    ).toThrow();
    expect(requestFlush).not.toHaveBeenCalled();
  });

  it("publishes the durable export desire before post-commit fan-out can fail", async () => {
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

    requestFlush.mockClear();
    const committed = stream.getEvent({ idempotencyKey: input.idempotencyKey });
    expect(stream.append(input)).toEqual([committed]);
    expect(requestFlush).toHaveBeenCalledOnce();
    wake.mockRestore();
  });

  it("awaits the PostHog page under the native alarm invocation", async () => {
    const { stream } = createStream();
    requestFlush.mockClear();

    await stream.alarm();

    expect(flushIfDue).toHaveBeenCalledOnce();
    expect(requestFlush).not.toHaveBeenCalled();
  });

  it("preserves a new append desire that arrives while the alarm flush is yielding", async () => {
    let resolveFlush: (next: number | null) => void = () => undefined;
    flushIfDue.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFlush = resolve;
      }),
    );
    const nextAttemptAt = vi.spyOn(StreamEventPostHogExporter.prototype, "nextAttemptAt", "get");
    nextAttemptAt.mockReturnValueOnce(null).mockReturnValue(2_050);
    const { alarmAt, stream } = createStream();
    requestFlush.mockClear().mockReturnValue(2_050);

    const alarm = stream.alarm();
    await vi.waitFor(() => expect(flushIfDue).toHaveBeenCalledOnce());
    stream.append({ type: "events.iterate.test/during-posthog-flush", payload: {} });
    resolveFlush(null);
    await alarm;

    expect(alarmAt()).toBe(2_050);
    nextAttemptAt.mockRestore();
  });

  it("leaves Cloudflare's native alarm retry intact when subscription work throws", async () => {
    const onAlarm = vi.spyOn(StreamSubscribers.prototype, "onAlarm").mockImplementationOnce(() => {
      throw new Error("subscription alarm failed");
    });
    const { alarmAt, deleteAlarm, stream } = createStream({ initialAlarmAt: 1_000 });

    await expect(stream.alarm()).rejects.toThrow("subscription alarm failed");

    expect(alarmAt()).toBe(1_000);
    expect(deleteAlarm).not.toHaveBeenCalled();
    onAlarm.mockRestore();
  });

  it("leaves Cloudflare's native alarm retry intact when checkpointing throws", async () => {
    const { alarmAt, deleteAlarm, failCoreCheckpoint, stream } = createStream({
      initialAlarmAt: 1_000,
    });
    failCoreCheckpoint();

    await expect(stream.alarm()).rejects.toThrow("core checkpoint failed");

    expect(alarmAt()).toBe(1_000);
    expect(deleteAlarm).not.toHaveBeenCalled();
  });

  it("republishes the old durable PostHog desire when a flush state write throws", async () => {
    flushIfDue.mockRejectedValueOnce(new Error("posthog state write failed"));
    const { alarmAt, deleteAlarm, stream } = createStream({
      initialAlarmAt: 1_000,
      posthogState: {
        attempt: 0,
        cursor: 0,
        generation: 0,
        lastAbandonment: null,
        lastError: null,
        nextAttemptAt: 1_000,
      },
    });

    await expect(stream.alarm()).rejects.toThrow("posthog state write failed");

    expect(alarmAt()).toBe(1_000);
    expect(deleteAlarm).not.toHaveBeenCalled();
  });

  it("leaves a consumed successful alarm unscheduled when no durable owner remains", async () => {
    const { deleteAlarm, setAlarm, stream } = createStream({
      initialAlarmAt: 1_000,
      posthogEnabled: false,
    });
    setAlarm.mockClear();

    await stream.alarm();

    // Cloudflare consumes the running alarm before invoking the handler; no
    // owner remains, so neither a replacement nor an explicit cancellation is
    // necessary.
    expect(setAlarm).not.toHaveBeenCalled();
    expect(deleteAlarm).not.toHaveBeenCalled();
  });

  it("adopts a committed recovery generation before tearing down subscribers", () => {
    const adopt = vi.spyOn(StreamEventPostHogExporter.prototype, "adoptRecoveryState");
    const reset = vi
      .spyOn(StreamSubscribers.prototype, "resetForRecovery")
      .mockImplementationOnce(() => {
        throw new Error("subscriber disposal failed");
      });
    const { stream, values } = createStream();

    expect(() =>
      stream.restoreFromRecovery({
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
      }),
    ).toThrow("subscriber disposal failed");

    expect(adopt).toHaveBeenCalledOnce();
    expect(adopt.mock.invocationCallOrder[0]).toBeLessThan(reset.mock.invocationCallOrder[0]!);
    expect(values.get("posthogStreamEventExport")).toMatchObject({ cursor: 1, generation: 1 });
    expect(stream.runtimeState().coreProcessorState.maxOffset).toBe(1);
    const [afterRecovery] = stream.append({
      type: "events.iterate.test/after-recovery-cleanup-failure",
      payload: {},
    });
    expect(afterRecovery?.offset).toBe(2);
    expect(stream.runtimeState().coreProcessorState.maxOffset).toBe(2);
    adopt.mockRestore();
    reset.mockRestore();
  });

  it("aborts recovery before replacing the log when telemetry state is malformed", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const malformed = { generation: "unknown", raw: "preserve me" };
    const { stream, values } = createStream({ posthogState: malformed });
    const before = stream.getEvents({ includeEphemeral: true });

    expect(() =>
      stream.restoreFromRecovery({
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
      }),
    ).toThrow("invalid durable PostHog stream export state");

    expect(values.get("posthogStreamEventExport")).toBe(malformed);
    expect(stream.getEvents({ includeEphemeral: true })).toEqual(before);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ message: "stream_posthog_state_initialization_failed" }),
    );
    error.mockRestore();
  });
});

type CreateStreamOptions = {
  initialAlarmAt?: number;
  posthogEnabled?: boolean;
  posthogState?: unknown;
};

function createStream(options: CreateStreamOptions = {}): {
  alarmAt(): number | null;
  deleteAlarm: ReturnType<typeof vi.fn>;
  failCoreCheckpoint(): void;
  setAlarm: ReturnType<typeof vi.fn>;
  stream: StreamDurableObject;
  values: Map<string, unknown>;
} {
  const values = new Map<string, unknown>();
  if (options.posthogState !== undefined) {
    values.set("posthogStreamEventExport", options.posthogState);
  }
  let alarmAt: number | null = options.initialAlarmAt ?? null;
  let coreCheckpointFails = false;
  const deleteAlarm = vi.fn(async () => {
    alarmAt = null;
  });
  const setAlarm = vi.fn(async (at: number | Date) => {
    alarmAt = typeof at === "number" ? at : at.getTime();
  });
  const ctx = {
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
          if (key === "state" && coreCheckpointFails) {
            throw new Error("core checkpoint failed");
          }
          values.set(key, value);
        },
      },
      sql: wrapSqlStorage(new DatabaseSync(":memory:")),
      transactionSync: <T>(callback: () => T) => callback(),
    },
    exports: {},
    waitUntil: () => undefined,
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
    deleteAlarm,
    failCoreCheckpoint: () => {
      coreCheckpointFails = true;
    },
    setAlarm,
    stream,
    values,
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
