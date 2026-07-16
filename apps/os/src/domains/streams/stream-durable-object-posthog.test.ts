import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { StreamEventPostHogExporter } from "./stream-event-posthog.ts";
import { StreamDurableObject } from "./stream-durable-object.ts";

const requestFlush = vi.spyOn(StreamEventPostHogExporter.prototype, "requestFlush");
const flushIfDue = vi.spyOn(StreamEventPostHogExporter.prototype, "flushIfDue");

beforeEach(() => {
  requestFlush.mockReset().mockReturnValue(null);
  flushIfDue.mockReset().mockResolvedValue(null);
});

describe("StreamDurableObject PostHog boundary", () => {
  it("schedules only new commits without passing event data or changing append", () => {
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
    expect(requestFlush).not.toHaveBeenCalled();

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    requestFlush.mockImplementationOnce(() => {
      throw new Error("telemetry exploded");
    });
    const [survived] = stream.append({
      type: "events.iterate.test/posthog-boundary",
      payload: { private: "still committed" },
    });
    expect(survived?.offset).toBe(appended[2]!.offset + 1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "stream_posthog_flush_request_failed",
        projectId: null,
        streamId: "stream-do-id",
      }),
    );

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

  it("awaits the PostHog page under the native alarm invocation", async () => {
    const { stream } = createStream();
    requestFlush.mockClear();

    await stream.alarm();

    expect(flushIfDue).toHaveBeenCalledOnce();
    expect(requestFlush).not.toHaveBeenCalled();
  });
});

function createStream(): { stream: StreamDurableObject } {
  const values = new Map<string, unknown>();
  let alarmAt: number | null = null;
  const ctx = {
    id: {
      name: DurableObjectNameCodec.stringify(
        { path: "/", projectId: null },
        { allowNullProjectId: true },
      ),
      toString: () => "stream-do-id",
    },
    storage: {
      deleteAlarm: async () => {
        alarmAt = null;
      },
      getAlarm: async () => alarmAt,
      setAlarm: async (at: number | Date) => {
        alarmAt = typeof at === "number" ? at : at.getTime();
      },
      kv: {
        get: <T>(key: string) => values.get(key) as T | undefined,
        put: (key: string, value: unknown) => void values.set(key, value),
      },
      sql: wrapSqlStorage(new DatabaseSync(":memory:")),
    },
    exports: {},
    waitUntil: () => undefined,
  } as unknown as DurableObjectState;
  const env = {
    APP_CONFIG_POSTHOG: JSON.stringify({ apiKey: "phc_public" }),
    WORKER_SELF: "os-test",
  } as unknown as Env;
  return { stream: new StreamDurableObject(ctx, env) };
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
