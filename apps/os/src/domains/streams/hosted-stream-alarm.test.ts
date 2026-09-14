// Hosted logical streams borrow one native host alarm but retain distinct child
// storage and identities. These tests exercise the host's public child-alarm
// doors against the real StreamDurableObject with only its facet map faked.

import { DatabaseSync } from "node:sqlite";
import { expect, test, vi } from "vitest";
import type { Env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { HOSTED_STREAM_HOST_PATH, HOSTED_STREAM_PREFIX } from "./hosted-stream-routing.ts";
import { StreamDurableObject } from "./stream-durable-object.ts";

const PROJECT_ID = "prj_hosted_alarm";

function logicalName(suffix: string, projectId = PROJECT_ID): string {
  return DurableObjectNameCodec.stringify({ projectId, path: `${HOSTED_STREAM_PREFIX}${suffix}` });
}

test("uses exact same-project facet namespaces and rejects another project's child", async () => {
  const harness = await bootHost();
  const child = logicalName("one");
  harness.facets.set(child, { getMaxOffset: () => 17 });

  await expect(
    harness.host.invokeHostedStream({ args: [], logicalName: child, method: "getMaxOffset" }),
  ).resolves.toBe(17);
  expect(harness.facetNames).toEqual([`hosted-stream:${child}`]);

  await expect(
    harness.host.setHostedStreamAlarm({
      atMs: Date.now(),
      logicalName: logicalName("other-project", "prj_other"),
    }),
  ).rejects.toThrow("different project");
  harness.close();
});

test("rejects hosted reset before it can invoke a child", async () => {
  const harness = await bootHost();
  const child = logicalName("reset");
  const reset = vi.fn(async () => undefined);
  harness.facets.set(child, { reset });

  await expect(
    harness.host.invokeHostedStream({ args: [], logicalName: child, method: "reset" }),
  ).rejects.toThrow("hosted stream prototype does not support reset");
  expect(reset).not.toHaveBeenCalled();
  harness.close();
});

test("does not replay a future sibling while a failed child has an owed retry", async () => {
  const harness = await bootHost();
  const failing = logicalName("failing");
  const future = logicalName("future");
  const failure = new Error("child alarm failed");
  const failingAlarm = vi.fn(async () => {
    throw failure;
  });
  const futureAlarm = vi.fn(async () => undefined);
  harness.facets.set(failing, { handleHostedAlarm: failingAlarm });
  harness.facets.set(future, { handleHostedAlarm: futureAlarm });

  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await harness.host.setHostedStreamAlarm({ atMs: Date.now() - 1, logicalName: failing });
    await harness.host.setHostedStreamAlarm({ atMs: Date.now() + 60_000, logicalName: future });
    await expect(harness.host.alarm()).rejects.toThrow("facet alarm replay failed");
    await expect(
      harness.host.alarm({ isRetry: true, retryCount: 1 } as AlarmInvocationInfo),
    ).resolves.toBeUndefined();

    expect(failingAlarm).toHaveBeenCalledOnce();
    expect(futureAlarm).not.toHaveBeenCalled();
    expect(await harness.host.getHostedStreamAlarm({ logicalName: future })).not.toBeNull();
  } finally {
    error.mockRestore();
    harness.close();
  }
});

test("keeps a re-entrant child alarm generation instead of deleting it with the older fire", async () => {
  const harness = await bootHost();
  const child = logicalName("reentrant");
  const rearmedAtMs = Date.now() + 60_000;
  harness.facets.set(child, {
    handleHostedAlarm: async () => {
      // An old numeric generation could become equal again after delete then
      // set (1 → deleted → 1), letting the completing old fire delete new work.
      await harness.host.deleteHostedStreamAlarm({ logicalName: child });
      await harness.host.setHostedStreamAlarm({ atMs: rearmedAtMs, logicalName: child });
    },
  });

  await harness.host.setHostedStreamAlarm({ atMs: Date.now() - 1, logicalName: child });
  await expect(harness.host.alarm()).resolves.toBeUndefined();
  await expect(harness.host.getHostedStreamAlarm({ logicalName: child })).resolves.toBe(
    rearmedAtMs,
  );
  harness.close();
});

test("retains an owed child alarm across a host restart and consumes it exactly once", async () => {
  const harness = await bootHost();
  const child = logicalName("restart");
  const alarm = vi.fn(async () => undefined);
  harness.facets.set(child, { handleHostedAlarm: alarm });
  await harness.host.setHostedStreamAlarm({ atMs: Date.now() - 1, logicalName: child });

  const restarted = new StreamDurableObject(harness.context.ctx, fakeEnv());
  await harness.context.waitForInitialization();
  await expect(restarted.alarm()).resolves.toBeUndefined();

  expect(alarm).toHaveBeenCalledOnce();
  await expect(restarted.getHostedStreamAlarm({ logicalName: child })).resolves.toBeNull();
  harness.close();
});

test("a restarted host redelivers an in-flight child alarm from its durable owed record", async () => {
  const harness = await bootHost();
  const child = logicalName("restart-in-flight");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  harness.facets.set(child, {
    handleHostedAlarm: async () => {
      calls += 1;
      if (calls === 1) {
        entered.resolve();
        await release.promise;
      }
    },
  });
  await harness.host.setHostedStreamAlarm({ atMs: Date.now() - 1, logicalName: child });

  const first = harness.host.alarm();
  await entered.promise;
  const restarted = new StreamDurableObject(harness.context.ctx, fakeEnv());
  await harness.context.waitForInitialization();
  await expect(restarted.getHostedStreamAlarm({ logicalName: child })).resolves.not.toBeNull();

  // A real reset cancels the old execution. This in-memory harness keeps it
  // alive until released, so two deliveries are expected and prove at-least-once
  // recovery rather than an invalid exactly-once assertion.
  await expect(restarted.alarm()).resolves.toBeUndefined();
  release.resolve();
  await expect(first).resolves.toBeUndefined();
  expect(calls).toBe(2);
  await expect(restarted.getHostedStreamAlarm({ logicalName: child })).resolves.toBeNull();
  harness.close();
});

test("bounds a permanently failing child to three local replays and leaves its terminal record", async () => {
  vi.useFakeTimers();
  const harness = await bootHost();
  const child = logicalName("terminal");
  const alarm = vi.fn(async () => {
    throw new Error("");
  });
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  harness.facets.set(child, { handleHostedAlarm: alarm });
  await harness.host.setHostedStreamAlarm({ atMs: Date.now() - 1, logicalName: child });

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(harness.host.alarm()).rejects.toThrow("facet alarm replay failed");
      await vi.advanceTimersByTimeAsync(1_001);
    }
    const nativeAlarmCount = harness.alarms.length;
    await expect(
      harness.host.alarm({ isRetry: true, retryCount: 4 } as AlarmInvocationInfo),
    ).resolves.toBeUndefined();

    expect(alarm).toHaveBeenCalledTimes(3);
    expect(harness.alarms).toHaveLength(nativeAlarmCount);
    expect(await harness.host.getHostedStreamAlarm({ logicalName: child })).not.toBeNull();
    expect(error).toHaveBeenCalledWith(
      "hosted stream prototype child alarm reached durable retry limit",
      expect.objectContaining({ failures: 3, logicalName: child }),
    );
  } finally {
    error.mockRestore();
    harness.close();
    vi.useRealTimers();
  }
});

test("does not dispatch the same child generation twice while its first alarm remains in flight", async () => {
  const harness = await bootHost();
  const child = logicalName("in-flight");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const alarm = vi.fn(async () => {
    entered.resolve();
    await release.promise;
  });
  harness.facets.set(child, { handleHostedAlarm: alarm });
  await harness.host.setHostedStreamAlarm({ atMs: Date.now() - 1, logicalName: child });

  const first = harness.host.alarm();
  await entered.promise;
  const second = harness.host.alarm({ isRetry: true, retryCount: 1 } as AlarmInvocationInfo);
  await Promise.resolve();
  expect(alarm).toHaveBeenCalledOnce();

  release.resolve();
  await expect(first).resolves.toBeUndefined();
  await expect(second).resolves.toBeUndefined();
  expect(alarm).toHaveBeenCalledOnce();
  harness.close();
});

async function bootHost() {
  const context = durableObjectContext(
    DurableObjectNameCodec.stringify({ projectId: PROJECT_ID, path: HOSTED_STREAM_HOST_PATH }),
  );
  const host = new StreamDurableObject(context.ctx, fakeEnv());
  await context.waitForInitialization();
  return { ...context, host };
}

function fakeEnv(): Env {
  return {
    DEPLOYMENT_ENV: "preview_17",
    STREAM: {
      getByName: () => ({
        appendCoreEvent: (eventInput: unknown) =>
          Promise.resolve({
            ...(eventInput as object),
            offset: 1,
            createdAt: new Date().toISOString(),
          }),
      }),
    },
  } as unknown as Env;
}

function durableObjectContext(name: string) {
  const db = new DatabaseSync(":memory:");
  const values = new Map<string, unknown>();
  const backgroundWork: Promise<unknown>[] = [];
  const alarms: number[] = [];
  const facets = new Map<string, Record<string, (...args: never[]) => unknown>>();
  const facetNames: string[] = [];
  let latestInitialization: Promise<unknown> | undefined;
  const storage = {
    sql: wrapSqlStorage(db),
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
    setAlarm(atMs: number): Promise<void> {
      alarms.push(atMs);
      return Promise.resolve();
    },
    deleteAlarm: async (): Promise<void> => undefined,
    sync: async (): Promise<void> => undefined,
    transactionSync<T>(callback: () => T): T {
      return callback();
    },
  };
  const ctx = {
    id: { name },
    storage,
    exports: { HostedStreamPrototypeFacet: class {} },
    facets: {
      get(facetName: string): object {
        facetNames.push(facetName);
        const logical = facetName.slice("hosted-stream:".length);
        const child = facets.get(logical);
        if (!child) throw new Error(`missing scripted hosted child ${logical}`);
        return child;
      },
      abort: () => {},
    },
    getWebSockets: (): WebSocket[] => [],
    waitUntil(work: Promise<unknown>): void {
      backgroundWork.push(work);
    },
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      const work = Promise.resolve().then(callback);
      latestInitialization = work;
      return work;
    },
    abort(): never {
      throw new Error("test Durable Object aborted");
    },
  } as unknown as DurableObjectState;
  return {
    alarms,
    close: () => db.close(),
    context: { ctx, waitForInitialization: async () => await latestInitialization },
    ctx,
    facetNames,
    facets,
    async waitForInitialization(): Promise<void> {
      await latestInitialization;
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
  if (value instanceof Uint8Array)
    return [key, value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)];
  return [key, value];
}
