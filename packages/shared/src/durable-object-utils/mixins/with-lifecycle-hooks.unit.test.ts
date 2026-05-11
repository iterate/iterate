import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  type AlarmForwardingTestRoom,
  type AlarmTestRoom,
  type InitialStateTestRoom,
  type InspectorTestRoom,
  type InitializeTestRoom as InitializeTestRoomInstance,
  type ListedRoom,
  type SchedulerTestRoom,
} from "../test-harness/initialize-fronting-worker.ts";
import {
  deriveDurableObjectNameFromStructuredName,
  getOrInitializeDoStub,
} from "./with-lifecycle-hooks.ts";

const testEnv = env as {
  ALARM_FORWARDING_ROOMS: DurableObjectNamespace<AlarmForwardingTestRoom>;
  ALARM_ROOMS: DurableObjectNamespace<AlarmTestRoom>;
  DO_CATALOG: D1Database;
  INITIAL_STATE_ROOMS: DurableObjectNamespace<InitialStateTestRoom>;
  INSPECTORS: DurableObjectNamespace<InspectorTestRoom>;
  LISTED_ROOMS: DurableObjectNamespace<ListedRoom>;
  ROOMS: DurableObjectNamespace<InitializeTestRoomInstance>;
  SCHEDULE_ROOMS: DurableObjectNamespace<SchedulerTestRoom>;
};

function roomInit(name: string, ownerUserId: string) {
  return {
    name: roomName(name, ownerUserId),
  };
}

function roomName(name: string, ownerUserId: string) {
  return deriveDurableObjectNameFromStructuredName({
    structuredName: {
      ownerUserId,
      testName: name,
    },
  });
}

function getRoom<TStub>(
  namespace: {
    getByName(name: string): TStub;
  },
  name: string,
  ownerUserId: string,
) {
  return namespace.getByName(roomName(name, ownerUserId));
}

describe("withLifecycleHooks", () => {
  it("initializes by name and exposes params through assertInitialized", async () => {
    const room = getRoom(testEnv.ROOMS, "unit-room-a", "user-a");

    await expect(room.initialize(roomInit("unit-room-a", "user-a"))).resolves.toEqual({
      ownerUserId: "user-a",
    });
    await expect(room.getStructuredName()).resolves.toEqual({
      ownerUserId: "user-a",
    });
  });

  it("supports the protected structuredName convenience in subclasses", async () => {
    const room = getRoom(testEnv.ROOMS, "unit-room-message", "user-message");

    await room.initialize(roomInit("unit-room-message", "user-message"));

    await expect(room.sendMessage("hello")).resolves.toEqual({
      room: roomName("unit-room-message", "user-message"),
      ownerUserId: "user-message",
      text: "hello",
    });
  });

  it("throws synchronously from subclass code when not initialized", async () => {
    const room = testEnv.ROOMS.getByName("unit-room-uninitialized");

    await expect(room.trySendMessage("hello")).resolves.toMatchObject({
      name: "NotInitializedError",
    });
  });

  it("keeps initialization idempotent for identical params", async () => {
    const room = getRoom(testEnv.ROOMS, "unit-room-idempotent", "user-original");

    await room.initialize(roomInit("unit-room-idempotent", "user-original"));

    await expect(
      room.initialize(roomInit("unit-room-idempotent", "user-original")),
    ).resolves.toEqual({
      ownerUserId: "user-original",
    });
  });

  it("rejects a structured name that would address a different object", async () => {
    const room = getRoom(testEnv.ROOMS, "unit-room-conflict", "user-original");

    await room.initialize(roomInit("unit-room-conflict", "user-original"));

    await expect(
      room.tryInitializeName(roomInit("unit-room-conflict", "user-replacement")),
    ).resolves.toMatchObject({ name: "InitializeNameMismatchError" });
  });

  it("rejects mismatched names", async () => {
    const room = testEnv.ROOMS.getByName("unit-room-mismatch");

    await expect(
      room.tryInitializeName(roomInit("different-room-name", "user-a")),
    ).resolves.toMatchObject({
      name: "InitializeNameMismatchError",
    });
  });

  it("initializes through the free getOrInitializeDoStub helper", async () => {
    const room = await getOrInitializeDoStub({
      namespace: testEnv.ROOMS,
      name: {
        ownerUserId: "user-static",
      },
    });

    await expect(room.getStructuredName()).resolves.toEqual({
      ownerUserId: "user-static",
    });
  });

  it("initializes from a deterministic name when callers omit the name", async () => {
    const room = await getOrInitializeDoStub({
      namespace: testEnv.ROOMS,
      name: {
        ownerUserId: "user-derived",
      },
    });

    await expect(room.getStructuredName()).resolves.toEqual({
      ownerUserId: "user-derived",
    });
  });

  it("derives the same name regardless of init param object key order", () => {
    expect(
      deriveDurableObjectNameFromStructuredName({
        structuredName: { ownerUserId: "user-derived", projectId: "project-a" },
      }),
    ).toBe(
      deriveDurableObjectNameFromStructuredName({
        structuredName: { projectId: "project-a", ownerUserId: "user-derived" },
      }),
    );
  });

  it("rejects helper calls without a name", async () => {
    await expect(
      getOrInitializeDoStub({
        namespace: testEnv.ROOMS,
      } as never),
    ).rejects.toThrow("requires name");
  });

  it("keeps initialization idempotent across direct and helper initialization", async () => {
    const name = deriveDurableObjectNameFromStructuredName({
      structuredName: { ownerUserId: "user-order" },
    });
    const room = testEnv.ROOMS.getByName(name);

    await room.initialize({ name });

    await expect(
      getOrInitializeDoStub({
        namespace: testEnv.ROOMS,
        name: {
          ownerUserId: "user-order",
        },
      }).then((stub) => stub.getStructuredName()),
    ).resolves.toEqual({
      ownerUserId: "user-order",
    });
  });

  it("waits for registered lifecycle hooks before initialize returns", async () => {
    const room = getRoom(testEnv.ROOMS, "unit-room-hook-waits", "user-hook");

    await expect(room.initialize(roomInit("unit-room-hook-waits", "user-hook"))).resolves.toEqual({
      ownerUserId: "user-hook",
    });

    await expect(room.getLifecycleHookState()).resolves.toEqual({
      firstInitializeRuns: 1,
      firstInitializeOwnerUserId: "user-hook",
      instanceWakeRuns: 1,
      instanceWakeStarted: true,
      instanceWakeFinished: true,
      instanceWakeFailedOnce: false,
    });
  });

  it("rejects ensureStarted before initialize has stored params", async () => {
    const room = testEnv.ROOMS.getByName("unit-room-ensure-before-init");

    await expect(room.tryEnsureReady()).resolves.toMatchObject({
      kind: "error",
      name: "NotInitializedError",
    });
  });

  it("runs lifecycle hooks once for concurrent initialization attempts", async () => {
    const room = getRoom(testEnv.ROOMS, "unit-room-concurrent-init", "user-concurrent");

    await expect(
      room.initializeTwiceConcurrently({
        ownerUserId: "user-concurrent",
      }),
    ).resolves.toEqual({
      results: [
        {
          ownerUserId: "user-concurrent",
        },
        {
          ownerUserId: "user-concurrent",
        },
      ],
      hookRuns: 1,
    });

    await expect(room.getLifecycleHookState()).resolves.toMatchObject({
      firstInitializeRuns: 1,
      instanceWakeRuns: 1,
    });
  });

  it("retries instance wake hooks after a startup failure", async () => {
    const room = getRoom(testEnv.ROOMS, "unit-room-hook-fails-once", "user-fails-once");

    await expect(
      room.tryInitialize({
        ownerUserId: "user-fails-once",
      }),
    ).resolves.toMatchObject({
      kind: "error",
      name: "Error",
      message: "instance wake hook failed once",
    });

    await expect(room.getLifecycleHookState()).resolves.toMatchObject({
      firstInitializeRuns: 1,
      instanceWakeRuns: 1,
      instanceWakeStarted: true,
      instanceWakeFinished: false,
      instanceWakeFailedOnce: true,
    });

    await expect(
      room.initialize(roomInit("unit-room-hook-fails-once", "user-fails-once")),
    ).resolves.toEqual({
      ownerUserId: "user-fails-once",
    });

    await expect(room.getLifecycleHookState()).resolves.toEqual({
      firstInitializeRuns: 1,
      firstInitializeOwnerUserId: "user-fails-once",
      instanceWakeRuns: 2,
      instanceWakeStarted: true,
      instanceWakeFinished: true,
      instanceWakeFailedOnce: true,
    });
  });

  it("treats throw undefined from an instance wake hook as a real startup failure", async () => {
    const room = getRoom(testEnv.ROOMS, "unit-room-hook-throws-undefined", "user-throws-undefined");

    await expect(
      room.tryInitialize({
        ownerUserId: "user-throws-undefined",
      }),
    ).resolves.toEqual({
      kind: "error",
      name: "UnknownError",
      message: "undefined",
    });

    await expect(room.getLifecycleHookState()).resolves.toMatchObject({
      firstInitializeRuns: 1,
      instanceWakeRuns: 1,
      instanceWakeStarted: true,
      instanceWakeFinished: false,
    });

    await expect(room.tryEnsureReady()).resolves.toEqual({
      kind: "error",
      name: "UnknownError",
      message: "undefined",
    });

    await expect(room.getLifecycleHookState()).resolves.toMatchObject({
      firstInitializeRuns: 1,
      instanceWakeRuns: 2,
      instanceWakeStarted: true,
      instanceWakeFinished: false,
    });
  });

  it("supports immutable initial state separate from the Durable Object name", async () => {
    const name = `initial-state-${crypto.randomUUID()}`;
    const room = await getOrInitializeDoStub({
      namespace: testEnv.INITIAL_STATE_ROOMS,
      name,
      initialState: {
        projectId: "project-initial",
        plan: "pro",
      },
    });

    await expect(room.getNameForTest()).resolves.toBe(name);
    await expect(room.getInitialStateForTest()).resolves.toEqual({
      projectId: "project-initial",
      plan: "pro",
    });

    await expect(room.initialize({ name })).resolves.toBe(name);
    await expect(room.getInitialStateForTest()).resolves.toEqual({
      projectId: "project-initial",
      plan: "pro",
    });
  });

  it("requires initial state the first time a stateful object is initialized", async () => {
    const name = `initial-state-required-${crypto.randomUUID()}`;
    const room = testEnv.INITIAL_STATE_ROOMS.getByName(name);

    await expect(room.tryInitialize({ name })).resolves.toMatchObject({
      name: "InitializeInitialStateRequiredError",
    });
  });

  it("rejects conflicting initial state for an already initialized object", async () => {
    const name = `initial-state-conflict-${crypto.randomUUID()}`;
    const room = testEnv.INITIAL_STATE_ROOMS.getByName(name);

    await room.initialize({
      name,
      initialState: {
        projectId: "project-original",
        plan: "free",
      },
    });

    await expect(
      room.tryInitialize({
        name,
        initialState: {
          projectId: "project-replacement",
          plan: "free",
        },
      }),
    ).resolves.toMatchObject({
      name: "InitializeInitialStateMismatchError",
    });
  });
});

describe("withOuterbase", () => {
  it("serves the embedded SQL inspector page and SQL endpoint", async () => {
    const inspector = testEnv.INSPECTORS.getByName("outerbase-unit");

    await inspector.seedSql();

    await expect(
      inspector.fetch("https://example.com/__outerbase").then((response) => response.text()),
    ).resolves.toContain("https://libsqlstudio.com/embed/sqlite");

    const response = await inspector.fetch("https://example.com/__outerbase/sql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        statement: "SELECT text FROM messages WHERE id = ?",
        params: ["msg_1"],
      }),
    });

    await expect(response.json()).resolves.toMatchObject({
      data: {
        rows: [{ text: "hello" }],
      },
    });
  });

  it("rejects SQL params that cannot be bound to Durable Object SQLite", async () => {
    const inspector = testEnv.INSPECTORS.getByName("outerbase-unit-bad-params");

    await inspector.seedSql();

    const response = await inspector.fetch("https://example.com/__outerbase/sql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        statement: "SELECT text FROM messages WHERE id = ?",
        params: [{ id: "msg_1" }],
      }),
    });

    await expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "params entries must be strings, numbers, null, or ArrayBuffers.",
    });
  });
});

describe("withKvInspector", () => {
  it("pretty-prints Durable Object KV contents", async () => {
    const inspector = testEnv.INSPECTORS.getByName("kv-unit");

    await inspector.seedKv("hello", { nested: "world" });

    await expect(
      inspector.fetch("https://example.com/__kv/json").then((response) => response.json()),
    ).resolves.toEqual([{ key: "hello", value: { nested: "world" } }]);
    await expect(
      inspector.fetch("https://example.com/__kv").then((response) => response.text()),
    ).resolves.toContain("&quot;nested&quot;: &quot;world&quot;");
  });
});

describe("withD1ObjectCatalog", () => {
  it("returns null when the object has not been initialized", async () => {
    const room = testEnv.LISTED_ROOMS.getByName("listed-uninitialized-unit");

    await expect(room.getD1ObjectCatalogRecord()).resolves.toBeNull();
  });

  it("returns JSON null through the fronting worker when no catalog record exists", async () => {
    const response = await SELF.fetch(
      "https://example.com/listed-rooms/listed-missing-unit/catalog",
    );

    await expect(response.json()).resolves.toBeNull();
  });

  it("best-effort writes initialized objects into D1", async () => {
    const room = getRoom(testEnv.LISTED_ROOMS, "listed-unit", "user-listed");

    await room.initialize(roomInit("listed-unit", "user-listed"));

    await vi.waitFor(async () => {
      await expect(room.getD1ObjectCatalogRecord()).resolves.toMatchObject({
        class: "ListedRoom",
        structuredName: {
          ownerUserId: "user-listed",
        },
      });
    });
  });

  it("creates the catalog table on first write", async () => {
    const room = getRoom(testEnv.LISTED_ROOMS, "listed-creates-table", "user-listed");

    await room.initialize(roomInit("listed-creates-table", "user-listed"));

    await vi.waitFor(async () => {
      await expect(
        testEnv.DO_CATALOG.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mixin_d1_object_catalog_objects'",
        ).first(),
      ).resolves.toEqual({
        name: "mixin_d1_object_catalog_objects",
      });
    });
  });

  it("indexes initialized objects by configured structured names", async () => {
    const room = getRoom(testEnv.LISTED_ROOMS, "listed-owner-index-unit", "user-indexed");

    await room.initialize(roomInit("listed-owner-index-unit", "user-indexed"));

    await vi.waitFor(async () => {
      const response = await SELF.fetch(
        "https://example.com/listed-rooms/by-owner-user-id/user-indexed",
      );

      await expect(response.json()).resolves.toMatchObject([
        {
          class: "ListedRoom",
          structuredName: {
            ownerUserId: "user-indexed",
          },
        },
      ]);
    });
  });
});

describe("withMultiplexedAlarms", () => {
  it("schedules, lists, arms, dispatches, and deletes a logical alarm", async () => {
    const room = getRoom(testEnv.ALARM_ROOMS, "alarm-unit-dispatch", "user-alarm");

    await room.initialize(roomInit("alarm-unit-dispatch", "user-alarm"));
    await room.scheduleRecordAlarm({
      key: "record",
      runAt: Date.now() + 60_000,
      payload: { message: "hello" },
    });

    await expect(room.getMultiplexedAlarms()).resolves.toMatchObject([
      {
        key: "record",
        method: "recordAlarmPayload",
        payload: { message: "hello" },
      },
    ]);
    await expect(room.getPlatformAlarm()).resolves.toEqual(expect.any(Number));

    await room.makeMultiplexedAlarmsDueForTest();
    await expect(room.runAlarmNow()).resolves.toBeUndefined();
    await expect(room.getAlarmExecutionState()).resolves.toEqual({
      runs: 1,
      payload: { message: "hello" },
    });
    await expect(room.getMultiplexedAlarms()).resolves.toEqual([]);
    await expect(room.getPlatformAlarm()).resolves.toBeNull();
  });

  it("replaces existing logical alarm rows by stable key", async () => {
    const room = getRoom(testEnv.ALARM_ROOMS, "alarm-unit-replace", "user-alarm");

    await room.initialize(roomInit("alarm-unit-replace", "user-alarm"));
    await room.scheduleRecordAlarm({
      key: "replace-me",
      runAt: Date.now() + 60_000,
      payload: { version: 1 },
    });
    await room.scheduleRecordAlarm({
      key: "replace-me",
      runAt: Date.now() + 120_000,
      payload: { version: 2 },
    });

    await expect(room.getMultiplexedAlarms()).resolves.toMatchObject([
      {
        key: "replace-me",
        method: "recordAlarmPayload",
        payload: { version: 2 },
      },
    ]);
  });

  it("does not delete a replacement row created while a logical alarm callback is running", async () => {
    const room = getRoom(testEnv.ALARM_ROOMS, "alarm-unit-replace-during-dispatch", "user-alarm");

    await room.initialize(roomInit("alarm-unit-replace-during-dispatch", "user-alarm"));
    await room.scheduleSelfReplacingAlarm({
      key: "replace-while-running",
      runAt: Date.now() + 60_000,
    });

    await room.makeMultiplexedAlarmsDueForTest();
    await expect(room.runAlarmNow()).resolves.toBeUndefined();
    await expect(room.getMultiplexedAlarms()).resolves.toMatchObject([
      {
        key: "replace-while-running",
        method: "recordAlarmPayload",
        payload: { version: "replacement" },
      },
    ]);
  });

  it("cancels logical alarms and re-arms the platform alarm", async () => {
    const room = getRoom(testEnv.ALARM_ROOMS, "alarm-unit-cancel", "user-alarm");

    await room.initialize(roomInit("alarm-unit-cancel", "user-alarm"));
    await room.scheduleRecordAlarm({
      key: "cancel-me",
      runAt: Date.now() + 60_000,
    });

    await expect(room.cancelRecordAlarm("cancel-me")).resolves.toBe(true);
    await expect(room.cancelRecordAlarm("cancel-me")).resolves.toBe(false);
    await expect(room.getMultiplexedAlarms()).resolves.toEqual([]);
    await expect(room.getPlatformAlarm()).resolves.toBeNull();
  });

  it("clamps the platform alarm while keeping long-future logical rows intact", async () => {
    const room = getRoom(testEnv.ALARM_ROOMS, "alarm-unit-long-future", "user-alarm");
    const nowMs = Date.now();
    const oneYearMs = 365 * 24 * 60 * 60 * 1_000;
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1_000;

    await room.initialize(roomInit("alarm-unit-long-future", "user-alarm"));
    await room.scheduleRecordAlarm({
      key: "long-future",
      runAt: nowMs + oneYearMs,
    });

    await expect(room.getMultiplexedAlarms()).resolves.toMatchObject([
      {
        key: "long-future",
        runAt: new Date(nowMs + oneYearMs).toISOString(),
      },
    ]);
    await expect(room.getPlatformAlarm()).resolves.toBeLessThanOrEqual(
      nowMs + thirtyDaysMs + 1_000,
    );
  });

  it("requires lifecycle start before scheduling", async () => {
    const room = testEnv.ALARM_ROOMS.getByName("alarm-unit-before-init");

    await expect(
      room.scheduleRecordAlarm({
        key: "before-init",
        runAt: Date.now(),
      }),
    ).resolves.toMatchObject({
      name: "NotInitializedError",
    });
  });

  it("rejects missing methods at schedule time", async () => {
    const room = getRoom(testEnv.ALARM_ROOMS, "alarm-unit-missing-method", "user-alarm");

    await room.initialize(roomInit("alarm-unit-missing-method", "user-alarm"));

    await expect(
      room.scheduleMissingMethodAlarm({
        key: "missing",
        runAt: Date.now(),
      }),
    ).resolves.toMatchObject({
      name: "MissingMultiplexedAlarmMethodError",
    });
    await expect(room.getMultiplexedAlarms()).resolves.toEqual([]);
  });

  it("keeps rows and logs when a persisted method is missing at dispatch time", async () => {
    const room = getRoom(testEnv.ALARM_ROOMS, "alarm-unit-missing-dispatch", "user-alarm");

    await room.initialize(roomInit("alarm-unit-missing-dispatch", "user-alarm"));
    await room.seedMissingMethodAlarmRow("missing-after-deploy");

    await expect(room.runAlarmNow()).resolves.toMatchObject({
      name: "MissingMultiplexedAlarmMethodError",
    });
    await expect(room.getMultiplexedAlarms()).resolves.toMatchObject([
      {
        key: "missing-after-deploy",
        method: "missingAfterDeploy",
      },
    ]);
  });

  it("rejects non-JSON-serializable payloads at schedule time", async () => {
    const room = getRoom(testEnv.ALARM_ROOMS, "alarm-unit-bad-payload", "user-alarm");

    await room.initialize(roomInit("alarm-unit-bad-payload", "user-alarm"));

    await expect(room.scheduleUnserializableAlarm()).resolves.toMatchObject({
      name: "MultiplexedAlarmPayloadSerializationError",
    });
    await expect(room.getMultiplexedAlarms()).resolves.toEqual([]);
  });

  it("processes at most fifty due rows per alarm tick", async () => {
    const room = getRoom(testEnv.ALARM_ROOMS, "alarm-unit-drain-limit", "user-alarm");

    await room.initialize(roomInit("alarm-unit-drain-limit", "user-alarm"));

    for (let index = 0; index < 55; index += 1) {
      await room.scheduleRecordAlarm({
        key: `record-${index}`,
        runAt: Date.now() + 60_000,
        payload: { index },
      });
    }

    await room.makeMultiplexedAlarmsDueForTest();
    await expect(room.runAlarmNow()).resolves.toBeUndefined();
    await expect(room.getAlarmExecutionState()).resolves.toMatchObject({
      runs: 50,
    });
  });

  it("forwards Cloudflare alarm retry metadata to lower alarm implementations", async () => {
    const room = getRoom(testEnv.ALARM_FORWARDING_ROOMS, "alarm-unit-forward-info", "user-alarm");

    await room.initialize(roomInit("alarm-unit-forward-info", "user-alarm"));

    await expect(
      room.runAlarmNow({
        isRetry: true,
        retryCount: 3,
        scheduledTime: 123,
      }),
    ).resolves.toBeUndefined();
    await expect(room.getForwardedAlarmInfo()).resolves.toEqual({
      isRetry: true,
      retryCount: 3,
      scheduledTime: 123,
    });
  });
});

describe("withScheduler", () => {
  it("schedules, dispatches, and deletes a one-shot task", async () => {
    const room = getRoom(testEnv.SCHEDULE_ROOMS, "scheduler-unit-once", "user-scheduler");

    await room.initialize(roomInit("scheduler-unit-once", "user-scheduler"));
    await room.scheduleTask({
      key: "once",
      recurrence: {
        type: "once",
        runAt: Date.now() + 60_000,
      },
      payload: { message: "hello" },
    });

    await expect(room.getSchedules()).resolves.toMatchObject([
      {
        key: "once",
        method: "recordScheduledPayload",
        payload: { message: "hello" },
        recurrence: { type: "once" },
      },
    ]);

    await room.makeScheduleDueForTest("once");
    await expect(room.runAlarmNow()).resolves.toBeUndefined();
    await expect(room.getScheduledExecutionState()).resolves.toEqual({
      runs: 1,
      failures: 0,
      payload: { message: "hello" },
    });
    await expect(room.getSchedules()).resolves.toEqual([]);
  });

  it("can start when schedule rows already exist before lifecycle startup", async () => {
    const room = getRoom(
      testEnv.SCHEDULE_ROOMS,
      "scheduler-unit-startup-existing-row",
      "user-scheduler",
    );

    await room.seedScheduleRowBeforeStartup("existing");

    await expect(
      Promise.race([
        room
          .initialize(roomInit("scheduler-unit-startup-existing-row", "user-scheduler"))
          .then(() => "started"),
        new Promise<"timed-out">((resolve) => {
          setTimeout(() => resolve("timed-out"), 100);
        }),
      ]),
    ).resolves.toBe("started");
    await expect(room.getMultiplexedAlarms()).resolves.toMatchObject([
      {
        key: expect.stringContaining("scheduler:existing:"),
        method: "runScheduledTask",
      },
    ]);
  });

  it("replaces schedules by required stable key", async () => {
    const room = getRoom(testEnv.SCHEDULE_ROOMS, "scheduler-unit-replace", "user-scheduler");

    await room.initialize(roomInit("scheduler-unit-replace", "user-scheduler"));
    await room.scheduleTask({
      key: "poll",
      recurrence: {
        type: "interval",
        everyMs: 60_000,
      },
      payload: { version: 1 },
    });
    await room.scheduleTask({
      key: "poll",
      recurrence: {
        type: "interval",
        everyMs: 120_000,
      },
      payload: { version: 2 },
    });

    await expect(room.getSchedules()).resolves.toMatchObject([
      {
        key: "poll",
        payload: { version: 2 },
        recurrence: {
          type: "interval",
          everyMs: 120_000,
        },
      },
    ]);
  });

  it("does not delete a replacement schedule created while a one-shot task is running", async () => {
    const room = getRoom(
      testEnv.SCHEDULE_ROOMS,
      "scheduler-unit-replace-during-run",
      "user-scheduler",
    );

    await room.initialize(roomInit("scheduler-unit-replace-during-run", "user-scheduler"));
    await room.scheduleSelfReplacingTask({
      key: "replace-while-running",
      recurrence: {
        type: "once",
        runAt: Date.now() + 60_000,
      },
    });

    await room.makeScheduleDueForTest("replace-while-running");
    await expect(room.runAlarmNow()).resolves.toBeUndefined();
    await expect(room.getSchedules()).resolves.toMatchObject([
      {
        key: "replace-while-running",
        method: "recordScheduledPayload",
        payload: { version: "replacement" },
        recurrence: {
          type: "delayed",
          delayMs: 60_000,
        },
      },
    ]);
  });

  it("does not advance over a replacement schedule created while a recurring task is running", async () => {
    const room = getRoom(
      testEnv.SCHEDULE_ROOMS,
      "scheduler-unit-replace-during-recurring-run",
      "user-scheduler",
    );
    const beforeRunMs = Date.now();

    await room.initialize(
      roomInit("scheduler-unit-replace-during-recurring-run", "user-scheduler"),
    );
    await room.scheduleSelfReplacingTask({
      key: "replace-recurring-while-running",
      recurrence: {
        type: "interval",
        everyMs: 3_600_000,
      },
    });

    await room.makeScheduleDueForTest("replace-recurring-while-running");
    await expect(room.runAlarmNow()).resolves.toBeUndefined();

    await expect(room.getSchedules()).resolves.toMatchObject([
      {
        key: "replace-recurring-while-running",
        method: "recordScheduledPayload",
        payload: { version: "replacement" },
        recurrence: {
          type: "delayed",
          delayMs: 60_000,
        },
      },
    ]);
    await expect(
      room.getScheduleNextRunAtMsForTest("replace-recurring-while-running"),
    ).resolves.toBeLessThan(beforeRunMs + 120_000);
  });

  it("does not delete a replacement schedule created by a final finite RRULE run", async () => {
    const room = getRoom(
      testEnv.SCHEDULE_ROOMS,
      "scheduler-unit-replace-final-rrule",
      "user-scheduler",
    );

    await room.initialize(roomInit("scheduler-unit-replace-final-rrule", "user-scheduler"));
    await room.scheduleSelfReplacingTask({
      key: "replace-final-rrule",
      recurrence: {
        type: "rrule",
        rrule: "FREQ=DAILY;COUNT=1",
      },
    });

    await room.makeScheduleDueForTest("replace-final-rrule");
    await expect(room.runAlarmNow()).resolves.toBeUndefined();
    await expect(room.getSchedules()).resolves.toMatchObject([
      {
        key: "replace-final-rrule",
        method: "recordScheduledPayload",
        payload: { version: "replacement" },
        recurrence: {
          type: "delayed",
          delayMs: 60_000,
        },
      },
    ]);
  });

  it("cancels schedules and their backing multiplexed alarm", async () => {
    const room = getRoom(testEnv.SCHEDULE_ROOMS, "scheduler-unit-cancel", "user-scheduler");

    await room.initialize(roomInit("scheduler-unit-cancel", "user-scheduler"));
    await room.scheduleTask({
      key: "cancel-me",
      recurrence: {
        type: "delayed",
        delayMs: 60_000,
      },
    });

    await expect(room.cancelTask("cancel-me")).resolves.toBe(true);
    await expect(room.cancelTask("cancel-me")).resolves.toBe(false);
    await expect(room.getSchedules()).resolves.toEqual([]);
    await expect(room.getMultiplexedAlarms()).resolves.toEqual([]);
  });

  it("reschedules interval tasks after successful execution", async () => {
    const room = getRoom(testEnv.SCHEDULE_ROOMS, "scheduler-unit-interval", "user-scheduler");

    await room.initialize(roomInit("scheduler-unit-interval", "user-scheduler"));
    await room.scheduleTask({
      key: "interval",
      recurrence: {
        type: "interval",
        everyMs: 60_000,
      },
      payload: { kind: "interval" },
    });

    await room.makeScheduleDueForTest("interval");
    await expect(room.runAlarmNow()).resolves.toBeUndefined();
    await expect(room.getScheduledExecutionState()).resolves.toMatchObject({
      runs: 1,
      payload: { kind: "interval" },
    });
    await expect(room.getSchedules()).resolves.toMatchObject([
      {
        key: "interval",
        running: false,
        recurrence: {
          type: "interval",
          everyMs: 60_000,
        },
      },
    ]);
  });

  it("keeps one-shot schedules due when execution fails", async () => {
    const room = getRoom(testEnv.SCHEDULE_ROOMS, "scheduler-unit-once-fails", "user-scheduler");

    await room.initialize(roomInit("scheduler-unit-once-fails", "user-scheduler"));
    await room.scheduleFailingTask({
      key: "failing-once",
      recurrence: {
        type: "once",
        runAt: Date.now() + 60_000,
      },
    });

    await room.makeScheduleDueForTest("failing-once");
    await expect(room.runAlarmNow()).resolves.toMatchObject({
      name: "Error",
      message: "scheduled task failed",
    });
    await expect(room.getScheduledExecutionState()).resolves.toMatchObject({
      failures: 1,
    });
    await expect(room.getSchedule("failing-once")).resolves.toMatchObject({
      key: "failing-once",
      recurrence: {
        type: "once",
      },
    });
  });

  it("advances recurring schedules when execution fails", async () => {
    const room = getRoom(
      testEnv.SCHEDULE_ROOMS,
      "scheduler-unit-recurring-fails",
      "user-scheduler",
    );

    await room.initialize(roomInit("scheduler-unit-recurring-fails", "user-scheduler"));
    await room.scheduleFailingTask({
      key: "failing-interval",
      recurrence: {
        type: "interval",
        everyMs: 60_000,
      },
    });

    await room.makeScheduleDueForTest("failing-interval");
    await expect(room.runAlarmNow()).resolves.toBeUndefined();
    await expect(room.getScheduledExecutionState()).resolves.toMatchObject({
      failures: 1,
    });
    await expect(room.getSchedule("failing-interval")).resolves.toMatchObject({
      key: "failing-interval",
      running: false,
      recurrence: {
        type: "interval",
      },
    });
  });

  it("deletes finite RRULE schedules after their final occurrence", async () => {
    const room = getRoom(
      testEnv.SCHEDULE_ROOMS,
      "scheduler-unit-finite-rrule-done",
      "user-scheduler",
    );

    await room.initialize(roomInit("scheduler-unit-finite-rrule-done", "user-scheduler"));
    await room.seedExhaustedFiniteRruleScheduleForTest("finite-rrule");

    await expect(room.runAlarmNow()).resolves.toBeUndefined();
    await expect(room.getScheduledExecutionState()).resolves.toMatchObject({
      runs: 1,
      payload: { final: true },
    });
    await expect(room.getSchedule("finite-rrule")).resolves.toBeNull();
    await expect(room.getMultiplexedAlarms()).resolves.toEqual([]);
  });

  it("does not skip the first RRULE occurrence at dtstart", async () => {
    const room = getRoom(
      testEnv.SCHEDULE_ROOMS,
      "scheduler-unit-rrule-first-occurrence",
      "user-scheduler",
    );

    await room.initialize(roomInit("scheduler-unit-rrule-first-occurrence", "user-scheduler"));

    await expect(
      room.scheduleTask({
        key: "single-rrule",
        recurrence: {
          type: "rrule",
          rrule: "FREQ=DAILY;COUNT=1",
        },
        payload: { occurrence: 1 },
      }),
    ).resolves.toMatchObject({
      key: "single-rrule",
      recurrence: {
        type: "rrule",
      },
    });

    await room.makeScheduleDueForTest("single-rrule");
    await expect(room.runAlarmNow()).resolves.toBeUndefined();
    await expect(room.getScheduledExecutionState()).resolves.toMatchObject({
      runs: 1,
      payload: { occurrence: 1 },
    });
    await expect(room.getSchedule("single-rrule")).resolves.toBeNull();
  });

  it("skips overlapping interval schedules while they are recently running", async () => {
    const room = getRoom(testEnv.SCHEDULE_ROOMS, "scheduler-unit-overlap", "user-scheduler");
    const startedAtMs = Date.now() - 1_000;

    await room.initialize(roomInit("scheduler-unit-overlap", "user-scheduler"));
    await room.scheduleTask({
      key: "overlap",
      recurrence: {
        type: "interval",
        everyMs: 60_000,
      },
    });
    await room.simulateRunningScheduleForTest("overlap", startedAtMs);

    await expect(room.runAlarmNow()).resolves.toBeUndefined();
    await expect(room.getScheduledExecutionState()).resolves.toMatchObject({
      runs: 0,
    });
    await expect(room.getSchedule("overlap")).resolves.toMatchObject({
      key: "overlap",
      running: true,
    });
    await expect(room.getMultiplexedAlarms()).resolves.toMatchObject([
      {
        key: expect.stringContaining(`scheduler:overlap:${startedAtMs + 30_000}`),
      },
    ]);
  });

  it("retries interval schedules that look hung", async () => {
    const room = getRoom(testEnv.SCHEDULE_ROOMS, "scheduler-unit-hung", "user-scheduler");

    await room.initialize(roomInit("scheduler-unit-hung", "user-scheduler"));
    await room.scheduleTask({
      key: "hung",
      recurrence: {
        type: "interval",
        everyMs: 60_000,
      },
    });
    await room.simulateRunningScheduleForTest("hung", Date.now() - 60_000);

    await expect(room.runAlarmNow()).resolves.toBeUndefined();
    await expect(room.getScheduledExecutionState()).resolves.toMatchObject({
      runs: 1,
    });
    await expect(room.getSchedule("hung")).resolves.toMatchObject({
      key: "hung",
      running: false,
    });
  });

  it("stores cron and rrule recurrence as tagged rows", async () => {
    const room = getRoom(testEnv.SCHEDULE_ROOMS, "scheduler-unit-calendar", "user-scheduler");

    await room.initialize(roomInit("scheduler-unit-calendar", "user-scheduler"));
    await room.scheduleTask({
      key: "cron",
      recurrence: {
        type: "cron",
        expression: "0 9 * * *",
      },
    });
    await room.scheduleTask({
      key: "rrule",
      recurrence: {
        type: "rrule",
        rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
      },
    });

    await expect(room.getSchedules()).resolves.toMatchObject([
      {
        key: "cron",
        recurrence: {
          type: "cron",
          expression: "0 9 * * *",
          timezone: null,
        },
      },
      {
        key: "rrule",
        recurrence: {
          type: "rrule",
          rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
          timezone: null,
        },
      },
    ]);
  });

  it("rejects full iCalendar RRULE strings with embedded DTSTART", async () => {
    const room = getRoom(testEnv.SCHEDULE_ROOMS, "scheduler-unit-full-rrule", "user-scheduler");

    await room.initialize(roomInit("scheduler-unit-full-rrule", "user-scheduler"));

    await expect(
      room.scheduleTask({
        key: "full-rrule",
        recurrence: {
          type: "rrule",
          rrule: ["DTSTART;TZID=Europe/London:20260427T090000", "RRULE:FREQ=DAILY;COUNT=2"].join(
            "\n",
          ),
        },
      }),
    ).resolves.toMatchObject({
      name: "Error",
      message: expect.stringContaining("bare RRULE"),
    });
    await expect(room.getSchedules()).resolves.toEqual([]);
  });
});
