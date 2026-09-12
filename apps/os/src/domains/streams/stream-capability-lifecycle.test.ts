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
  const disposeSnapshot = vi.fn();
  const result = { path: ["review"], providedAtOffset: 42 };
  const snapshot = { state: { capabilities: [], capabilityProviderPagers: [] } };
  Object.defineProperty(result, Symbol.dispose, {
    value: dispose,
  });
  Object.defineProperty(snapshot, Symbol.dispose, { value: disposeSnapshot });
  const facet = {
    catchUp: async () => undefined,
    configure: async () => undefined,
    provideCapability: async () => result,
    snapshot: async () => snapshot,
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
    expect(disposeSnapshot).toHaveBeenCalledTimes(2);
  } finally {
    context.close();
  }
});

test("processor facade releases plain facet read results before returning them", async () => {
  const disposeSnapshot = vi.fn();
  const disposeRuntime = vi.fn();
  const snapshot = { offset: 3, state: { ready: true } };
  const runtime = { state: "idle" };
  Object.defineProperty(snapshot, Symbol.dispose, { value: disposeSnapshot });
  Object.defineProperty(runtime, Symbol.dispose, { value: disposeRuntime });
  const facet = {
    catchUp: async () => undefined,
    configure: async () => undefined,
    getRuntimeState: async () => runtime,
    snapshot: async () => snapshot,
  };
  const context = durableObjectContext(facet);
  const stream = new StreamDurableObject(context.ctx, fakeEnv());
  await context.initialized;
  stream.append({
    type: "events.iterate.com/stream/subscription-configured",
    payload: {
      name: "plain-read",
      receiver: { action: "facet-processor", source: { kind: "builtin" } },
    },
  });
  await context.settle();

  try {
    const processor = stream.processorFacade({ name: "plain-read" });
    const receivedSnapshot = await processor.snapshot();
    const receivedRuntime = await processor.getRuntimeState();

    expect(receivedSnapshot).toEqual({ offset: 3, state: { ready: true } });
    expect(receivedRuntime).toEqual({ state: "idle" });
    expect(Symbol.dispose in receivedSnapshot).toBe(false);
    expect(Symbol.dispose in receivedRuntime).toBe(false);
    expect(disposeSnapshot).toHaveBeenCalledOnce();
    expect(disposeRuntime).toHaveBeenCalledOnce();
  } finally {
    context.close();
  }
});

test("facet live-state reads release both the snapshot and its returned RPC node", async () => {
  const disposeLiveState = vi.fn();
  const disposeSnapshot = vi.fn();
  const snapshot = { status: "available" };
  Object.defineProperty(snapshot, Symbol.dispose, { value: disposeSnapshot });
  const liveState = {
    get: async () => snapshot,
  };
  Object.defineProperty(liveState, Symbol.dispose, { value: disposeLiveState });
  const facet = {
    catchUp: async () => undefined,
    configure: async () => undefined,
    liveState: async () => liveState,
  };
  const context = durableObjectContext(facet);
  const stream = new StreamDurableObject(context.ctx, fakeEnv());
  await context.initialized;
  stream.append({
    type: "events.iterate.com/stream/subscription-configured",
    payload: {
      name: "live-read",
      receiver: { action: "facet-processor", source: { kind: "builtin" } },
    },
  });
  await context.settle();

  try {
    const received = await stream.processorFacade({ name: "live-read" }).liveState.get();

    expect(received).toEqual({ status: "available" });
    expect(Symbol.dispose in received).toBe(false);
    expect(disposeSnapshot).toHaveBeenCalledOnce();
    expect(disposeLiveState).toHaveBeenCalledOnce();
  } finally {
    context.close();
  }
});

test("facet live-state reads release their RPC node when the read rejects", async () => {
  const disposeLiveState = vi.fn();
  const liveState = {
    get: async () => Promise.reject(new Error("read failed")),
  };
  Object.defineProperty(liveState, Symbol.dispose, { value: disposeLiveState });
  const facet = {
    catchUp: async () => undefined,
    configure: async () => undefined,
    liveState: async () => liveState,
  };
  const context = durableObjectContext(facet);
  const stream = new StreamDurableObject(context.ctx, fakeEnv());
  await context.initialized;
  stream.append({
    type: "events.iterate.com/stream/subscription-configured",
    payload: {
      name: "failed-live-read",
      receiver: { action: "facet-processor", source: { kind: "builtin" } },
    },
  });
  await context.settle();

  try {
    await expect(
      stream.processorFacade({ name: "failed-live-read" }).liveState.get(),
    ).rejects.toThrow("read failed");
    expect(disposeLiveState).toHaveBeenCalledOnce();
  } finally {
    context.close();
  }
});

test("facet live-state subscriptions retain their RPC node until close", async () => {
  const disposeLiveState = vi.fn();
  const disposeHandle = vi.fn();
  const unsubscribe = vi.fn();
  const handle = { ping: vi.fn(), unsubscribe };
  Object.defineProperty(handle, Symbol.dispose, { value: disposeHandle });
  const liveState = {
    subscribe: async () => handle,
  };
  Object.defineProperty(liveState, Symbol.dispose, { value: disposeLiveState });
  const facet = {
    catchUp: async () => undefined,
    configure: async () => undefined,
    liveState: async () => liveState,
  };
  const context = durableObjectContext(facet);
  const stream = new StreamDurableObject(context.ctx, fakeEnv());
  await context.initialized;
  stream.append({
    type: "events.iterate.com/stream/subscription-configured",
    payload: {
      name: "live-subscribe",
      receiver: { action: "facet-processor", source: { kind: "builtin" } },
    },
  });
  await context.settle();

  try {
    const subscription = await stream
      .processorFacade({ name: "live-subscribe" })
      .liveState.subscribe(() => undefined);
    expect(disposeLiveState).not.toHaveBeenCalled();

    subscription[Symbol.dispose]();
    subscription.unsubscribe();

    expect(unsubscribe).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(disposeHandle).toHaveBeenCalledOnce());
    expect(disposeLiveState).toHaveBeenCalledOnce();
  } finally {
    context.close();
  }
});

test("facet live-state subscriptions release their node when setup fails", async () => {
  const disposeLiveState = vi.fn();
  const liveState = {
    subscribe: async () => Promise.reject(new Error("subscribe failed")),
  };
  Object.defineProperty(liveState, Symbol.dispose, { value: disposeLiveState });
  const facet = {
    catchUp: async () => undefined,
    configure: async () => undefined,
    liveState: async () => liveState,
  };
  const context = durableObjectContext(facet);
  const stream = new StreamDurableObject(context.ctx, fakeEnv());
  await context.initialized;
  stream.append({
    type: "events.iterate.com/stream/subscription-configured",
    payload: {
      name: "failed-live-subscribe",
      receiver: { action: "facet-processor", source: { kind: "builtin" } },
    },
  });
  await context.settle();

  try {
    await expect(
      stream
        .processorFacade({ name: "failed-live-subscribe" })
        .liveState.subscribe(() => undefined),
    ).rejects.toThrow("subscribe failed");
    expect(disposeLiveState).toHaveBeenCalledOnce();
  } finally {
    context.close();
  }
});

test("facet live-state subscriptions retain RPC ownership until remote close settles", async () => {
  const disposeLiveState = vi.fn();
  const disposeHandle = vi.fn();
  let finishClose!: () => void;
  const close = new Promise<void>((resolve) => {
    finishClose = resolve;
  });
  const handle = { ping: vi.fn(), unsubscribe: vi.fn(() => close) };
  Object.defineProperty(handle, Symbol.dispose, { value: disposeHandle });
  const liveState = {
    subscribe: async () => handle,
  };
  Object.defineProperty(liveState, Symbol.dispose, { value: disposeLiveState });
  const facet = {
    catchUp: async () => undefined,
    configure: async () => undefined,
    liveState: async () => liveState,
  };
  const context = durableObjectContext(facet);
  const stream = new StreamDurableObject(context.ctx, fakeEnv());
  await context.initialized;
  stream.append({
    type: "events.iterate.com/stream/subscription-configured",
    payload: {
      name: "deferred-live-subscribe",
      receiver: { action: "facet-processor", source: { kind: "builtin" } },
    },
  });
  await context.settle();

  try {
    const subscription = await stream
      .processorFacade({ name: "deferred-live-subscribe" })
      .liveState.subscribe(() => undefined);
    subscription.unsubscribe();
    expect(disposeHandle).not.toHaveBeenCalled();
    expect(disposeLiveState).not.toHaveBeenCalled();

    finishClose();
    await vi.waitFor(() => expect(disposeHandle).toHaveBeenCalledOnce());
    expect(disposeLiveState).toHaveBeenCalledOnce();
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
