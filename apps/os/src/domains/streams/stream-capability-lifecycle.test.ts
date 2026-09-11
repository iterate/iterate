// Native Workers RPC results carry hidden disposers. Registration must return
// plain coordinates rather than forward that disposer into its caller's context.

import { DatabaseSync } from "node:sqlite";
import { expect, test, vi } from "vitest";
import type { Env } from "../../env.ts";
import { CapabilityHostProcessorContract } from "../capability-host/capability-host-processor-contract.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { StreamDurableObject } from "./stream-durable-object.ts";

test("provideCapability releases the facet RPC result before returning its durable identity", async () => {
  const dispose = vi.fn();
  const result = { path: ["review"], providedAtOffset: 42 };
  Object.defineProperty(result, Symbol.dispose, {
    value: dispose,
  });
  const facet = {
    catchUp: async () => undefined,
    configure: async () => undefined,
    provideCapability: async () => result,
    snapshot: async () => ({ state: { capabilities: [], capabilityProviderPagers: [] } }),
  };
  const context = durableObjectContext(facet);
  const stream = new StreamDurableObject(context.ctx, fakeEnv());
  await context.initialized;
  stream.append({
    type: "events.iterate.com/stream/subscription-configured",
    payload: {
      name: CapabilityHostProcessorContract.slug,
      receiver: { action: "facet-processor", source: { kind: "builtin" } },
    },
  });
  await context.settle();

  try {
    const provision = await stream.provideCapability({
      expression: ["streams"],
      path: ["review"],
      type: "itx-call",
    });
    expect(provision).toEqual({ path: ["review"], providedAtOffset: 42 });
    expect(Symbol.dispose in provision).toBe(false);
    expect(dispose).toHaveBeenCalledOnce();
  } finally {
    context.close();
  }
});

test("a departing Pager receives a reciprocal close even when no durable cleanup is owed", async () => {
  const context = durableObjectContext({});
  try {
    const stream = new StreamDurableObject(context.ctx, fakeEnv());
    await context.initialized;
    const close = vi.fn();
    const socket = { close, deserializeAttachment: () => null } as unknown as WebSocket;

    await stream.webSocketClose(socket);

    expect(close).toHaveBeenCalledOnce();
    await context.settle();
  } finally {
    context.close();
  }
});

function fakeEnv(): Env {
  return {
    STREAM: {
      getByName: () => ({
        appendCoreEvent: async (input: unknown) => ({
          ...(input as object),
          createdAt: new Date().toISOString(),
          offset: 1,
          path: "/",
        }),
      }),
    },
  } as unknown as Env;
}

function durableObjectContext(facet: object) {
  const db = new DatabaseSync(":memory:");
  const values = new Map<string, unknown>();
  const backgroundWork: Promise<unknown>[] = [];
  let initialized: Promise<unknown> = Promise.resolve();
  const ctx = {
    abort: () => {
      throw new Error("test Durable Object aborted");
    },
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      const work = Promise.resolve().then(callback);
      initialized = work;
      return work;
    },
    exports: { ProcessorFacet: class {} },
    facets: { abort: () => {}, get: () => facet },
    getWebSockets: () => [],
    id: {
      name: DurableObjectNameCodec.stringify({ path: "/", projectId: "prj_capability_result" }),
    },
    storage: {
      deleteAlarm: async () => undefined,
      kv: {
        delete: () => undefined,
        get<T>(key: string): T | undefined {
          const value = values.get(key);
          return value === undefined ? undefined : structuredClone(value as T);
        },
        put: (key: string, value: unknown) => values.set(key, structuredClone(value)),
      },
      setAlarm: async () => undefined,
      sql: wrapSqlStorage(db),
      sync: async () => undefined,
      transactionSync: <T>(callback: () => T) => callback(),
    },
    waitUntil: (work: Promise<unknown>) => backgroundWork.push(work),
  } as unknown as DurableObjectState;

  return {
    close: () => db.close(),
    ctx,
    get initialized() {
      return initialized;
    },
    async settle() {
      let known = -1;
      while (known !== backgroundWork.length) {
        known = backgroundWork.length;
        await Promise.all(backgroundWork);
        await Promise.resolve();
      }
    },
  };
}

function wrapSqlStorage(db: DatabaseSync): SqlStorage {
  return {
    databaseSize: 0,
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
  } as unknown as SqlStorage;
}

function fromNodeSqlValue([key, value]: [string, unknown]) {
  if (value instanceof Uint8Array) {
    return [key, value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)];
  }
  return [key, value];
}
