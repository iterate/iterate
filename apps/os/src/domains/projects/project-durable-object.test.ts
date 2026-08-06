import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import type { Env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { ProjectDurableObject } from "./project-durable-object.ts";

test("a cold worker-batch index does not load every project processor", async () => {
  using context = durableObjectContext(
    DurableObjectNameCodec.stringify({ projectId: "prj_stream_index", path: "/" }),
  );
  const project = new ProjectDurableObject(context.ctx, {
    APP_CONFIG: JSON.stringify({ openAiApiKey: "test-key" }),
    CF_VERSION_METADATA: { id: "test-version" },
  } as unknown as Env);

  await expect(
    project.indexCommittedBatchFacts({
      stream: {
        path: "/",
        at: "2026-08-06T05:06:00.000Z",
        type: "events.iterate.com/project/created",
        maxOffset: 380,
      },
    }),
  ).resolves.toBeUndefined();
});

function durableObjectContext(name: string) {
  const database = new DatabaseSync(":memory:");
  const values = new Map<string, unknown>();
  const storage = {
    sql: {
      databaseSize: 0,
      exec<T = unknown>(sql: string, ...bindings: (ArrayBuffer | null | number | string)[]) {
        const rows = database
          .prepare(sql)
          .all(
            ...bindings.map((binding) =>
              binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding,
            ),
          )
          .map((row) =>
            Object.fromEntries(
              Object.entries(row).map(([key, value]) => [
                key,
                value instanceof Uint8Array
                  ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
                  : value,
              ]),
            ),
          );
        return { toArray: () => rows as T[] };
      },
    },
    kv: {
      get<T>(key: string): T | undefined {
        const value = values.get(key);
        return value === undefined ? undefined : structuredClone(value as T);
      },
      put(key: string, value: unknown): void {
        values.set(key, structuredClone(value));
      },
      delete(key: string): void {
        values.delete(key);
      },
    },
    getAlarm: () => Promise.resolve(null),
    setAlarm: () => Promise.resolve(),
    deleteAlarm: () => Promise.resolve(),
  };
  return {
    ctx: {
      id: { name },
      storage,
      exports: {},
      getWebSockets: () => [],
      waitUntil: () => undefined,
    } as unknown as DurableObjectState,
    [Symbol.dispose]: () => database.close(),
  };
}
