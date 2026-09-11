// The facet alarm replay's loss-proofing: a facet-placed processor's only
// self-wake is the parent Stream DO's native alarm, and each fire CONSUMES
// it. If the replay into the facet fails, the parent merges a bounded retry
// back into the shared facet slot — but that self-armed write is the only
// wakeup left, and a reset storm can lose it with the incarnation (the
// 2026-08-25 preview incident: a deploy reset the DO between the fire and
// the re-arm commit, stranding a persisted keepalive revival desire for two
// minutes until an unrelated request booted the DO). The alarm invocation
// must therefore FAIL when a replay fails: Cloudflare's platform alarm retry
// survives resets and keeps the fire owed.
//
// Runs the REAL StreamDurableObject in plain node over an in-memory ctx fake
// (same shape as guarantees-not-given.test.ts) with a scripted facet.

import { DatabaseSync } from "node:sqlite";
import { expect, test, vi } from "vitest";
import type { Env } from "../../env.ts";
import { recordedSpans, resetRecordedSpans } from "../../test/cloudflare-workers-shim.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { StreamDurableObject } from "./stream-durable-object.ts";

const userspace = vi.hoisted(() => ({
  loadStatefulClass: vi.fn(),
}));

vi.mock("../workers/worker-runner.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workers/worker-runner.ts")>();
  return {
    ...actual,
    DynamicWorkerRunner: class {
      loadStatefulClass = userspace.loadStatefulClass;
    },
  };
});

test("a failed facet alarm replay rejects the alarm invocation and re-merges the bounded retry desire", async () => {
  const harness = await bootStreamWithAgentFacet();
  harness.facet.handleAlarmError = new Error("Durable Object reset because its code was updated");

  const before = Date.now();
  harness.stream.proxySetAlarm(before - 1);

  // The replay failure must reject the WHOLE alarm invocation — a resolved
  // alarm is a consumed alarm, and the platform only re-owes the fire when
  // the handler fails.
  await expect(harness.stream.alarm()).rejects.toThrow(
    /facet alarm replay failed for agent; failing the alarm invocation keeps the platform's alarm retry owed/,
  );
  expect(harness.facet.handleAlarmCalls).toBe(1);
  expect(harness.context.abortCalls()).toBe(0);

  // The bounded self-retry stays armed too (the fast path when the write
  // survives): the shared facet slot holds a future desire and the native
  // alarm was re-armed for it.
  const merged = harness.stream.proxyGetAlarm();
  expect(merged).not.toBeNull();
  expect(merged!).toBeGreaterThan(before);
  // toContain, not at(-1): the halted wake delivery's own retry may arm a
  // nearer alarm after the merge; the merged desire's native write is what
  // matters.
  expect(harness.context.alarms).toContain(merged);

  await harness.context.settle();
  harness.context.close();
});

test("the latency repro stamps only its one validated ephemeral probe", async () => {
  const harness = await bootStreamWithAgentFacet({ path: "/repros/append-correlation" });
  resetRecordedSpans();

  harness.stream.append({
    type: "events.iterate.com/repro/ephemeral-frame",
    ephemeral: true,
    payload: { fixed: "frame", probeId: "run-123:p:7" },
  });

  expect(recordedSpans).toEqual([
    {
      name: "stream.repro.append",
      attributes: {
        "iterate.repro.probe_id": "run-123:p:7",
        "iterate.stream.path": "/repros/append-correlation",
        "iterate.repro.ephemeral": true,
        "iterate.repro.event_count": 1,
      },
    },
  ]);

  resetRecordedSpans();
  harness.stream.append({
    type: "events.iterate.com/repro/ephemeral-frame",
    ephemeral: true,
    payload: { fixed: "frame", probeId: "not a bounded probe ID" },
  });
  expect(recordedSpans).toEqual([]);

  await harness.context.settle();
  harness.context.close();
});

test("a successful facet alarm replay resolves the alarm and leaves the facet slot clear", async () => {
  const harness = await bootStreamWithAgentFacet();

  harness.stream.proxySetAlarm(Date.now() - 1);
  await expect(harness.stream.alarm()).resolves.toBeUndefined();

  expect(harness.facet.handleAlarmCalls).toBe(1);
  expect(harness.stream.proxyGetAlarm()).toBeNull();

  await harness.context.settle();
  harness.context.close();
});

test("a platform retry fire replays into facets even when the shared slot is empty", async () => {
  const harness = await bootStreamWithAgentFacet();

  // The lost-merge window: the slot delete committed but the failure path's
  // re-merge died with the incarnation. The platform retry must not trust
  // the empty slot — it pokes every facet so their durable records re-derive
  // whatever is owed.
  await expect(
    harness.stream.alarm({ isRetry: true, retryCount: 1 } as AlarmInvocationInfo),
  ).resolves.toBeUndefined();
  expect(harness.facet.handleAlarmCalls).toBe(1);

  // A non-retry fire with an empty slot stays a no-op — ordinary delivery
  // alarms must not poke facets on every append.
  await expect(harness.stream.alarm()).resolves.toBeUndefined();
  expect(harness.facet.handleAlarmCalls).toBe(1);

  await harness.context.settle();
  harness.context.close();
});

test("a failing facet keeps the platform retry chain alive across retry fires", async () => {
  const harness = await bootStreamWithAgentFacet();
  harness.facet.handleAlarmError = new Error("Durable Object reset because its code was updated");

  await expect(
    harness.stream.alarm({ isRetry: true, retryCount: 2 } as AlarmInvocationInfo),
  ).rejects.toThrow(/facet alarm replay failed for agent/);
  expect(harness.facet.handleAlarmCalls).toBe(1);

  await harness.context.settle();
  harness.context.close();
});

test("a not-yet-due facet desire re-arms without replaying and the alarm resolves", async () => {
  const harness = await bootStreamWithAgentFacet();

  const future = Date.now() + 60_000;
  harness.stream.proxySetAlarm(future);
  await expect(harness.stream.alarm()).resolves.toBeUndefined();

  expect(harness.facet.handleAlarmCalls).toBe(0);
  expect(harness.stream.proxyGetAlarm()).toBe(future);

  await harness.context.settle();
  harness.context.close();
});

test("a parent replacement reports one durable resource-recovery revival without error telemetry", async () => {
  const harness = await bootStreamWithAgentFacet({ source: "userspace" });
  harness.context.values.set("facetResourceRecovery:agent", {
    attempts: 1,
    deploymentVersion: "unversioned",
    nonce: "recovery-1",
    reason: "too-many-subrequests",
    requestedAtMs: Date.now(),
    source: "hosted-delivery",
    cursorChangedAtOffset: 7,
  });

  // This is the fresh parent incarnation after ctx.abort(). Reusing the
  // durable storage is intentional: the marker is the handoff across the
  // replacement, while stream offsets and the failed delivery cursor remain
  // untouched below it.
  const restarted = new StreamDurableObject(harness.context.ctx, fakeEnv());
  await harness.context.waitForInitialization();
  const revived = restarted.getEvents({
    eventTypes: ["events.iterate.com/stream/processor-revived"],
  });
  expect(revived).toHaveLength(1);
  expect(revived[0]!.payload).toMatchObject({
    processorSlug: "agent",
    reason: "too-many-subrequests",
    recoveryNonce: "recovery-1",
    parentRestart: true,
    cursorChangedAtOffset: 7,
  });
  expect(
    restarted.getEvents({ eventTypes: ["events.iterate.com/stream/error-occurred"] }),
  ).toHaveLength(0);

  // A second eviction before delivery completes must not duplicate the
  // expected diagnostic: its nonce is the durable idempotency boundary.
  new StreamDurableObject(harness.context.ctx, fakeEnv());
  await harness.context.waitForInitialization();
  expect(
    restarted.getEvents({ eventTypes: ["events.iterate.com/stream/processor-revived"] }),
  ).toHaveLength(1);

  await harness.context.settle();
  harness.context.close();
});

test("a userspace facet's native quota error marks, arms, and aborts the parent", async () => {
  userspace.loadStatefulClass.mockResolvedValue({
    klass: class {},
    ok: true,
    resolved: { cacheKey: "quota-test" },
  });
  const harness = await bootStreamWithAgentFacet({ source: "userspace" });
  harness.facet.handleAlarmError = new Error("Too many subrequests");
  const failureBoundaryOffset = harness.stream.getMaxOffset();

  // Retry fires fan out even without a facet alarm desire. That exercises the
  // real parent -> userspace facet call path without inventing a response
  // silence watchdog.
  await expect(
    harness.stream.alarm({ isRetry: true, retryCount: 1 } as AlarmInvocationInfo),
  ).rejects.toThrow(/facet alarm replay failed for agent/);

  expect(harness.context.abortCalls()).toBe(1);
  expect(harness.context.syncsBeforeAbort()).toHaveLength(1);
  expect(harness.context.syncsBeforeAbort()[0]).toBeGreaterThan(0);
  expect(harness.context.alarms).toContainEqual(expect.any(Number));
  expect(harness.context.values.get("facetResourceRecovery:agent")).toMatchObject({
    attempts: 1,
    reason: "too-many-subrequests",
    source: "facet-call",
    failureBoundaryOffset,
  });
  await harness.context.settle();
  harness.context.close();
});

test("the exact native quota text from a builtin facet keeps its ordinary alarm failure path", async () => {
  const harness = await bootStreamWithAgentFacet();
  harness.facet.handleAlarmError = new Error("Too many subrequests");

  await expect(
    harness.stream.alarm({ isRetry: true, retryCount: 1 } as AlarmInvocationInfo),
  ).rejects.toThrow(/facet alarm replay failed for agent/);
  expect(harness.context.abortCalls()).toBe(0);
  expect(harness.context.values.get("facetResourceRecovery:agent")).toBeUndefined();
  await harness.context.settle();
  harness.context.close();
});

test("a userspace quota episode stops after three parent replacements and records a terminal error", async () => {
  userspace.loadStatefulClass.mockResolvedValue({
    klass: class {},
    ok: true,
    resolved: { cacheKey: "quota-test" },
  });
  const harness = await bootStreamWithAgentFacet({ source: "userspace" });
  harness.facet.handleAlarmError = new Error("Too many subrequests");

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await expect(
      harness.stream.alarm({ isRetry: true, retryCount: attempt } as AlarmInvocationInfo),
    ).rejects.toThrow(/facet alarm replay failed for agent/);
  }
  expect(harness.context.abortCalls()).toBe(3);

  // The fourth exact failure is terminal: no fourth parent replacement and
  // one durable error fact instead of an unbounded reset loop.
  await expect(
    harness.stream.alarm({ isRetry: true, retryCount: 4 } as AlarmInvocationInfo),
  ).rejects.toThrow(/facet alarm replay failed for agent/);
  expect(harness.context.abortCalls()).toBe(3);
  expect(
    harness.stream.getEvents({ eventTypes: ["events.iterate.com/stream/error-occurred"] }),
  ).toHaveLength(1);
  expect(harness.context.values.get("facetResourceRecovery:agent")).toMatchObject({
    attempts: 4,
    terminal: true,
  });
  await harness.context.settle();
  harness.context.close();
});

// -----------------------------------------------------------------------------
// Harness: the real StreamDurableObject over an in-memory DurableObjectState
// fake, with ctx.facets serving one scripted facet stub. Storage shape follows
// guarantees-not-given.test.ts.
// -----------------------------------------------------------------------------

const PROJECT_ID = "prj_facet_alarm_replay";
const AGENT_PATH = "/agents/onboarding";

async function bootStreamWithAgentFacet(
  options: { path?: string; source?: "builtin" | "userspace" } = {},
) {
  const facet = {
    handleAlarmError: undefined as Error | undefined,
    handleAlarmCalls: 0,
    stub: {
      configure: () => Promise.resolve(),
      handleAlarm: () => {
        facet.handleAlarmCalls += 1;
        return facet.handleAlarmError === undefined
          ? Promise.resolve()
          : Promise.reject(facet.handleAlarmError);
      },
      // The wake delivery is not under test; its failure rides the sender's
      // own retry machinery, which never touches the facet slot.
      wakeStreamProcessor: () => Promise.reject(new Error("wake delivery not under test")),
    },
  };
  const context = durableObjectContext(
    DurableObjectNameCodec.stringify({ projectId: PROJECT_ID, path: options.path ?? AGENT_PATH }),
    facet.stub,
  );
  const stream = new StreamDurableObject(context.ctx, fakeEnv());
  await context.waitForInitialization();
  await context.settle();
  stream.append({
    type: "events.iterate.com/stream/subscription-configured",
    payload: {
      name: "agent",
      receiver:
        options.source === "userspace"
          ? {
              action: "facet-processor",
              source: {
                kind: "userspace",
                worker: {
                  className: "TestFacet",
                  durableWorkerKey: "test-facet",
                  path: AGENT_PATH,
                  source: {
                    createWorker: {
                      entryPoint: "facet.js",
                      files: { type: "repo", repoPath: "/repos/config" },
                    },
                  },
                  type: "stateful",
                },
              },
            }
          : { action: "facet-processor", source: { kind: "builtin" } },
    },
  });
  if (options.source !== "userspace") await context.settle();
  return { context, facet, stream };
}

function fakeEnv(): Env {
  return {
    STREAM: {
      getByName: () => ({
        // Ancestor announcements may address streams this test never creates.
        appendCoreEvent: (eventInput: unknown) =>
          Promise.resolve({
            ...(eventInput as object),
            path: "/",
            offset: 1,
            createdAt: new Date().toISOString(),
          }),
      }),
    },
  } as unknown as Env;
}

function durableObjectContext(name: string, facetStub: object) {
  const db = new DatabaseSync(":memory:");
  const values = new Map<string, unknown>();
  const backgroundWork: Promise<unknown>[] = [];
  const alarms: number[] = [];
  let latestInitialization: Promise<unknown> | undefined;
  let abortCalls = 0;
  let syncCalls = 0;
  const syncsBeforeAbort: number[] = [];
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
    deleteAlarm(): Promise<void> {
      return Promise.resolve();
    },
    sync(): Promise<void> {
      syncCalls += 1;
      return Promise.resolve();
    },
    transactionSync<T>(callback: () => T): T {
      return callback();
    },
  };
  const ctx = {
    id: { name },
    storage,
    // The builtin facet class lookup only checks presence; ctx.facets ignores
    // the startup callback and serves the scripted stub.
    exports: { ProcessorFacet: class {} },
    facets: {
      get: () => facetStub,
      abort: () => {},
    },
    getWebSockets(): WebSocket[] {
      return [];
    },
    waitUntil(work: Promise<unknown>): void {
      backgroundWork.push(work);
    },
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      const work = Promise.resolve().then(callback);
      latestInitialization = work;
      return work;
    },
    abort(): never {
      abortCalls += 1;
      syncsBeforeAbort.push(syncCalls);
      throw new Error("test Durable Object aborted");
    },
  } as unknown as DurableObjectState;

  return {
    alarms,
    abortCalls: () => abortCalls,
    syncsBeforeAbort: () => syncsBeforeAbort,
    values,
    close: () => db.close(),
    ctx,
    async waitForInitialization(): Promise<void> {
      await latestInitialization;
    },
    async settle(): Promise<void> {
      let seen = -1;
      while (seen !== backgroundWork.length) {
        seen = backgroundWork.length;
        await Promise.allSettled([...backgroundWork]);
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
