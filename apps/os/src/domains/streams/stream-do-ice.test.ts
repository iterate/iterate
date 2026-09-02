// The ice switch's contract (do-ice.ts): an iced environment's stream DOs
// consume alarms without re-arming, plant no new alarms, and stop minting
// boot `woken` events — the reversible containment for a duration runaway
// (tasks/stream-do-wake-loop-runaway.md). Un-icing resumes normal boots.
//
// Runs the REAL StreamDurableObject in plain node over an in-memory ctx fake
// (same shape as stream-facet-alarm-replay.test.ts / guarantees-not-given.test.ts).

import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import type { Env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { DO_ICE_KV_KEY } from "./do-ice.ts";
import { StreamDurableObject } from "./stream-durable-object.ts";

const PROJECT_ID = "prj_ice_test";
const STREAM_PATH = "/agents/ice-test";

test("an iced boot appends no woken event and plants no alarm", async () => {
  const harness = await bootStream({ iced: true });

  const events = harness.stream.getEventPage().events.map((event) => event.type);
  // The birth certificate and its platform feeds still append — creation is
  // user-facing — but the wake oscillator's fuel does not.
  expect(events).toContain("events.iterate.com/stream/created");
  expect(events).not.toContain("events.iterate.com/stream/woken");
  expect(harness.context.alarms).toEqual([]);

  await harness.context.settle();
  harness.context.close();
});

test("an iced alarm fire is consumed without re-arming or facet replays", async () => {
  const harness = await bootStream({ iced: true });

  // A facet desire arrives (e.g. a keepalive re-assert from before icing).
  harness.stream.proxySetAlarm(Date.now() - 1);
  expect(harness.context.alarms).toEqual([]);

  await expect(harness.stream.alarm()).resolves.toBeUndefined();
  expect(harness.facet.handleAlarmCalls).toBe(0);
  expect(harness.context.alarms).toEqual([]);

  await harness.context.settle();
  harness.context.close();
});

test("an un-iced boot appends woken and arms its delivery alarm as before", async () => {
  const harness = await bootStream({ iced: false });

  const events = harness.stream.getEventPage().events.map((event) => event.type);
  expect(events).toContain("events.iterate.com/stream/woken");
  expect(harness.context.alarms.length).toBeGreaterThan(0);

  await harness.context.settle();
  harness.context.close();
});

test("clearing the flag un-ices the next incarnation over the same storage", async () => {
  const flag = { iced: true };
  const first = await bootStream(flag);
  expect(first.stream.getEventPage().events.map((e) => e.type)).not.toContain(
    "events.iterate.com/stream/woken",
  );
  await first.context.settle();

  // Same durable storage, new incarnation, flag cleared — the post-incident
  // resume path. The boot appends `woken` and re-arms normally.
  flag.iced = false;
  const second = await rebootStream(first, flag);
  expect(second.stream.getEventPage().events.map((e) => e.type)).toContain(
    "events.iterate.com/stream/woken",
  );
  expect(second.context.alarms.length).toBeGreaterThan(0);

  await second.context.settle();
  second.context.close();
});

// ---------------------------------------------------------------------------
// Harness (mirrors stream-facet-alarm-replay.test.ts; kept local per the
// repo's test-structure convention — the scenario reads first, plumbing last)
// ---------------------------------------------------------------------------

async function bootStream(flag: { iced: boolean }) {
  const context = durableObjectContext(
    DurableObjectNameCodec.stringify({ projectId: PROJECT_ID, path: STREAM_PATH }),
  );
  return bootOverContext(context, flag);
}

/** Boot a fresh incarnation over an existing context's storage. */
async function rebootStream(
  previous: Awaited<ReturnType<typeof bootStream>>,
  flag: { iced: boolean },
) {
  previous.context.alarms.length = 0;
  return bootOverContext(previous.context, flag);
}

async function bootOverContext(
  context: ReturnType<typeof durableObjectContext>,
  flag: { iced: boolean },
) {
  const facet = {
    handleAlarmCalls: 0,
    stub: {
      configure: () => Promise.resolve(),
      handleAlarm: () => {
        facet.handleAlarmCalls += 1;
        return Promise.resolve();
      },
      wakeStreamProcessor: () => Promise.resolve(),
    },
  };
  context.facetStub.current = facet.stub;
  const stream = new StreamDurableObject(context.ctx, fakeEnv(flag));
  await context.waitForInitialization();
  await context.settle();
  return { context, facet, stream };
}

function fakeEnv(flag: { iced: boolean }): Env {
  return {
    STREAM: {
      getByName: () => ({
        appendCoreEvent: (eventInput: unknown) =>
          Promise.resolve({
            ...(eventInput as object),
            path: "/",
            offset: 1,
            createdAt: new Date().toISOString(),
          }),
      }),
    },
    PROJECT: {},
    PROJECT_DIRECTORY: {
      get: (key: string) => Promise.resolve(key === DO_ICE_KV_KEY && flag.iced ? "iced" : null),
    },
  } as unknown as Env;
}

function durableObjectContext(name: string) {
  const db = new DatabaseSync(":memory:");
  const values = new Map<string, unknown>();
  const backgroundWork: Promise<unknown>[] = [];
  const alarms: number[] = [];
  const facetStub: { current: object } = { current: {} };
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
    deleteAlarm(): Promise<void> {
      return Promise.resolve();
    },
    sync(): Promise<void> {
      return Promise.resolve();
    },
    transactionSync<T>(callback: () => T): T {
      return callback();
    },
  };
  const ctx = {
    id: { name },
    storage,
    exports: { ProcessorFacet: class {} },
    facets: {
      get: () => facetStub.current,
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
      throw new Error("test Durable Object aborted");
    },
  } as unknown as DurableObjectState;

  return {
    alarms,
    facetStub,
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
