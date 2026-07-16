import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";

type CaptureCommittedStreamEvents =
  typeof import("./stream-event-posthog.ts").captureCommittedStreamEvents;

const captureCommittedStreamEvents = vi.hoisted(() =>
  vi.fn<CaptureCommittedStreamEvents>(() => Promise.resolve()),
);

vi.mock("./stream-event-posthog.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./stream-event-posthog.ts")>()),
  captureCommittedStreamEvents,
}));

import { StreamDurableObject } from "./stream-durable-object.ts";

beforeEach(() => captureCommittedStreamEvents.mockReset().mockResolvedValue(undefined));

describe("StreamDurableObject PostHog boundary", () => {
  it("captures only new commits without letting telemetry change append", () => {
    const stream = createStream();
    captureCommittedStreamEvents.mockClear();

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
    expect(captureCommittedStreamEvents).toHaveBeenCalledOnce();
    const [captureInput] = captureCommittedStreamEvents.mock.calls[0]!;
    expect(captureInput).toMatchObject({
      events: [
        { committedAt: appended[0]!.createdAt, offset: appended[0]!.offset },
        { committedAt: appended[2]!.createdAt, offset: appended[2]!.offset },
      ],
      projectId: null,
      streamId: "stream-do-id",
      workerName: "os-test",
    });
    expect(JSON.stringify(captureInput.events)).not.toContain("private");

    captureCommittedStreamEvents.mockClear();
    expect(stream.append(first)).toEqual([appended[0]]);
    expect(captureCommittedStreamEvents).not.toHaveBeenCalled();

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    captureCommittedStreamEvents.mockImplementationOnce(() => {
      throw new Error("telemetry exploded");
    });
    const [survived] = stream.append({
      type: "events.iterate.test/posthog-boundary",
      payload: { private: "still committed" },
    });
    expect(survived?.offset).toBe(appended[2]!.offset + 1);
    expect(error).toHaveBeenCalledWith(
      "stream core background work failed",
      expect.objectContaining({ message: "telemetry exploded" }),
    );

    captureCommittedStreamEvents.mockClear();
    expect(() =>
      stream.append({
        type: "events.iterate.test/posthog-boundary",
        offset: 999,
        payload: {},
      } as unknown as Parameters<StreamDurableObject["append"]>[0]),
    ).toThrow();
    expect(captureCommittedStreamEvents).not.toHaveBeenCalled();
  });
});

function createStream(): StreamDurableObject {
  const values = new Map<string, unknown>();
  const ctx = {
    id: {
      name: DurableObjectNameCodec.stringify(
        { path: "/", projectId: null },
        { allowNullProjectId: true },
      ),
      toString: () => "stream-do-id",
    },
    storage: {
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
  return new StreamDurableObject(ctx, env);
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
