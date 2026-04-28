import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  type AlarmForwardingTestRoom,
  type AlarmTestRoom,
  type InspectorTestRoom,
  type InitializeTestRoom as InitializeTestRoomInstance,
  type ListedRoom,
  type SchedulerTestRoom,
} from "../test-harness/initialize-fronting-worker.ts";
import { getOrInitializeDoStub } from "./with-lifecycle-hooks.ts";

const testEnv = env as {
  ALARM_FORWARDING_ROOMS: DurableObjectNamespace<AlarmForwardingTestRoom>;
  ALARM_ROOMS: DurableObjectNamespace<AlarmTestRoom>;
  DO_CATALOG: D1Database;
  INSPECTORS: DurableObjectNamespace<InspectorTestRoom>;
  LISTED_ROOMS: DurableObjectNamespace<ListedRoom>;
  ROOMS: DurableObjectNamespace<InitializeTestRoomInstance>;
  SCHEDULE_ROOMS: DurableObjectNamespace<SchedulerTestRoom>;
};

describe("withLifecycleHooks", () => {
  it("initializes by name and exposes params through assertInitialized", async () => {
    const room = testEnv.ROOMS.getByName("unit-room-a");

    await expect(room.initialize({ name: "unit-room-a", ownerUserId: "user-a" })).resolves.toEqual({
      name: "unit-room-a",
      ownerUserId: "user-a",
    });
    await expect(room.getInitParams()).resolves.toEqual({
      name: "unit-room-a",
      ownerUserId: "user-a",
    });
  });

  it("supports the protected initParams convenience in subclasses", async () => {
    const room = testEnv.ROOMS.getByName("unit-room-message");

    await room.initialize({ name: "unit-room-message", ownerUserId: "user-message" });

    await expect(room.sendMessage("hello")).resolves.toEqual({
      room: "unit-room-message",
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
    const room = testEnv.ROOMS.getByName("unit-room-idempotent");

    await room.initialize({ name: "unit-room-idempotent", ownerUserId: "user-original" });

    await expect(
      room.initialize({ name: "unit-room-idempotent", ownerUserId: "user-original" }),
    ).resolves.toEqual({
      name: "unit-room-idempotent",
      ownerUserId: "user-original",
    });
  });

  it("rejects conflicting params for an already initialized object", async () => {
    const room = testEnv.ROOMS.getByName("unit-room-conflict");

    await room.initialize({ name: "unit-room-conflict", ownerUserId: "user-original" });

    await expect(
      room.tryInitialize({ name: "unit-room-conflict", ownerUserId: "user-replacement" }),
    ).resolves.toMatchObject({
      name: "InitializeParamsMismatchError",
    });
  });

  it("rejects mismatched names", async () => {
    const room = testEnv.ROOMS.getByName("unit-room-mismatch");

    await expect(
      room.tryInitialize({ name: "different-room", ownerUserId: "user-a" }),
    ).resolves.toMatchObject({
      kind: "error",
      name: "InitializeNameMismatchError",
    });
  });

  it("initializes through the free getOrInitializeDoStub helper", async () => {
    const room = await getOrInitializeDoStub({
      namespace: testEnv.ROOMS,
      name: "unit-room-helper",
      initParams: {
        ownerUserId: "user-static",
      },
    });

    await expect(room.getInitParams()).resolves.toEqual({
      name: "unit-room-helper",
      ownerUserId: "user-static",
    });
  });

  it("initializes from complete init params when callers derive the name themselves", async () => {
    const room = await getOrInitializeDoStub({
      namespace: testEnv.ROOMS,
      initParams: {
        name: "unit-room-derived-user-derived",
        ownerUserId: "user-derived",
      },
    });

    await expect(room.getInitParams()).resolves.toEqual({
      name: "unit-room-derived-user-derived",
      ownerUserId: "user-derived",
    });
  });

  it("keeps initialization idempotent across direct and helper initialization", async () => {
    const room = testEnv.ROOMS.getByName("unit-room-order");

    await room.initialize({ name: "unit-room-order", ownerUserId: "user-order" });

    await expect(
      getOrInitializeDoStub({
        namespace: testEnv.ROOMS,
        name: "unit-room-order",
        initParams: {
          ownerUserId: "user-order",
        },
      }).then((stub) => stub.getInitParams()),
    ).resolves.toEqual({
      name: "unit-room-order",
      ownerUserId: "user-order",
    });
  });

  it("waits for registered lifecycle hooks before initialize returns", async () => {
    const room = testEnv.ROOMS.getByName("unit-room-hook-waits");

    await expect(
      room.initialize({ name: "unit-room-hook-waits", ownerUserId: "user-hook" }),
    ).resolves.toEqual({
      name: "unit-room-hook-waits",
      ownerUserId: "user-hook",
    });

    await expect(room.getLifecycleHookState()).resolves.toEqual({
      firstInitializeRuns: 1,
      firstInitializeOwnerUserId: "user-hook",
      startRuns: 1,
      startStarted: true,
      startFinished: true,
      startFailedOnce: false,
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
    const room = testEnv.ROOMS.getByName("unit-room-concurrent-init");

    await expect(
      room.initializeTwiceConcurrently({
        name: "unit-room-concurrent-init",
        ownerUserId: "user-concurrent",
      }),
    ).resolves.toEqual({
      results: [
        {
          name: "unit-room-concurrent-init",
          ownerUserId: "user-concurrent",
        },
        {
          name: "unit-room-concurrent-init",
          ownerUserId: "user-concurrent",
        },
      ],
      hookRuns: 1,
    });

    await expect(room.getLifecycleHookState()).resolves.toMatchObject({
      firstInitializeRuns: 1,
      startRuns: 1,
    });
  });

  it("retries start hooks after a startup failure", async () => {
    const room = testEnv.ROOMS.getByName("unit-room-hook-fails-once");

    await expect(
      room.tryInitialize({
        name: "unit-room-hook-fails-once",
        ownerUserId: "user-fails-once",
      }),
    ).resolves.toMatchObject({
      kind: "error",
      name: "Error",
      message: "start hook failed once",
    });

    await expect(room.getLifecycleHookState()).resolves.toMatchObject({
      firstInitializeRuns: 1,
      startRuns: 1,
      startStarted: true,
      startFinished: false,
      startFailedOnce: true,
    });

    await expect(
      room.initialize({
        name: "unit-room-hook-fails-once",
        ownerUserId: "user-fails-once",
      }),
    ).resolves.toEqual({
      name: "unit-room-hook-fails-once",
      ownerUserId: "user-fails-once",
    });

    await expect(room.getLifecycleHookState()).resolves.toEqual({
      firstInitializeRuns: 1,
      firstInitializeOwnerUserId: "user-fails-once",
      startRuns: 2,
      startStarted: true,
      startFinished: true,
      startFailedOnce: true,
    });
  });

  it("treats throw undefined from a start hook as a real startup failure", async () => {
    const room = testEnv.ROOMS.getByName("unit-room-hook-throws-undefined");

    await expect(
      room.tryInitialize({
        name: "unit-room-hook-throws-undefined",
        ownerUserId: "user-throws-undefined",
      }),
    ).resolves.toEqual({
      kind: "error",
      name: "UnknownError",
      message: "undefined",
    });

    await expect(room.getLifecycleHookState()).resolves.toMatchObject({
      firstInitializeRuns: 1,
      startRuns: 1,
      startStarted: true,
      startFinished: false,
    });

    await expect(room.tryEnsureReady()).resolves.toEqual({
      kind: "error",
      name: "UnknownError",
      message: "undefined",
    });

    await expect(room.getLifecycleHookState()).resolves.toMatchObject({
      firstInitializeRuns: 1,
      startRuns: 2,
      startStarted: true,
      startFinished: false,
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
    const room = testEnv.LISTED_ROOMS.getByName("listed-unit");

    await room.initialize({ name: "listed-unit", ownerUserId: "user-listed" });

    await vi.waitFor(async () => {
      await expect(room.getD1ObjectCatalogRecord()).resolves.toMatchObject({
        class: "ListedRoom",
        name: "listed-unit",
        initParams: {
          name: "listed-unit",
          ownerUserId: "user-listed",
        },
      });
    });
  });

  it("creates the catalog table on first write", async () => {
    const room = testEnv.LISTED_ROOMS.getByName("listed-creates-table");

    await room.initialize({
      name: "listed-creates-table",
      ownerUserId: "user-listed",
    });

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

  it("indexes initialized objects by configured init params", async () => {
    const room = testEnv.LISTED_ROOMS.getByName("listed-owner-index-unit");

    await room.initialize({
      name: "listed-owner-index-unit",
      ownerUserId: "user-indexed",
    });

    await vi.waitFor(async () => {
      const response = await SELF.fetch(
        "https://example.com/listed-rooms/by-owner-user-id/user-indexed",
      );

      await expect(response.json()).resolves.toMatchObject([
        {
          class: "ListedRoom",
          name: "listed-owner-index-unit",
          initParams: {
            name: "listed-owner-index-unit",
            ownerUserId: "user-indexed",
          },
        },
      ]);
    });
  });
});

describe("withMultiplexedAlarms", () => {
  it("schedules, lists, arms, dispatches, and deletes a logical alarm", async () => {
    const room = testEnv.ALARM_ROOMS.getByName("alarm-unit-dispatch");

    await room.initialize({
      name: "alarm-unit-dispatch",
      ownerUserId: "user-alarm",
    });
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
    const room = testEnv.ALARM_ROOMS.getByName("alarm-unit-replace");

    await room.initialize({
      name: "alarm-unit-replace",
      ownerUserId: "user-alarm",
    });
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
    const room = testEnv.ALARM_ROOMS.getByName("alarm-unit-replace-during-dispatch");

    await room.initialize({
      name: "alarm-unit-replace-during-dispatch",
      ownerUserId: "user-alarm",
    });
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
    const room = testEnv.ALARM_ROOMS.getByName("alarm-unit-cancel");

    await room.initialize({
      name: "alarm-unit-cancel",
      ownerUserId: "user-alarm",
    });
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
    const room = testEnv.ALARM_ROOMS.getByName("alarm-unit-long-future");
    const nowMs = Date.now();
    const oneYearMs = 365 * 24 * 60 * 60 * 1_000;
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1_000;

    await room.initialize({
      name: "alarm-unit-long-future",
      ownerUserId: "user-alarm",
    });
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
    const room = testEnv.ALARM_ROOMS.getByName("alarm-unit-missing-method");

    await room.initialize({
      name: "alarm-unit-missing-method",
      ownerUserId: "user-alarm",
    });

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
    const room = testEnv.ALARM_ROOMS.getByName("alarm-unit-missing-dispatch");

    await room.initialize({
      name: "alarm-unit-missing-dispatch",
      ownerUserId: "user-alarm",
    });
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
    const room = testEnv.ALARM_ROOMS.getByName("alarm-unit-bad-payload");

    await room.initialize({
      name: "alarm-unit-bad-payload",
      ownerUserId: "user-alarm",
    });

    await expect(room.scheduleUnserializableAlarm()).resolves.toMatchObject({
      name: "MultiplexedAlarmPayloadSerializationError",
    });
    await expect(room.getMultiplexedAlarms()).resolves.toEqual([]);
  });

  it("processes at most fifty due rows per alarm tick", async () => {
    const room = testEnv.ALARM_ROOMS.getByName("alarm-unit-drain-limit");

    await room.initialize({
      name: "alarm-unit-drain-limit",
      ownerUserId: "user-alarm",
    });

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
    const room = testEnv.ALARM_FORWARDING_ROOMS.getByName("alarm-unit-forward-info");

    await room.initialize({
      name: "alarm-unit-forward-info",
      ownerUserId: "user-alarm",
    });

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
    const room = testEnv.SCHEDULE_ROOMS.getByName("scheduler-unit-once");

    await room.initialize({
      name: "scheduler-unit-once",
      ownerUserId: "user-scheduler",
    });
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
    const room = testEnv.SCHEDULE_ROOMS.getByName("scheduler-unit-startup-existing-row");

    await room.seedScheduleRowBeforeStartup("existing");

    await expect(
      Promise.race([
        room
          .initialize({
            name: "scheduler-unit-startup-existing-row",
            ownerUserId: "user-scheduler",
          })
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
    const room = testEnv.SCHEDULE_ROOMS.getByName("scheduler-unit-replace");

    await room.initialize({
      name: "scheduler-unit-replace",
      ownerUserId: "user-scheduler",
    });
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
    const room = testEnv.SCHEDULE_ROOMS.getByName("scheduler-unit-replace-during-run");

    await room.initialize({
      name: "scheduler-unit-replace-during-run",
      ownerUserId: "user-scheduler",
    });
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
    const room = testEnv.SCHEDULE_ROOMS.getByName("scheduler-unit-replace-during-recurring-run");
    const beforeRunMs = Date.now();

    await room.initialize({
      name: "scheduler-unit-replace-during-recurring-run",
      ownerUserId: "user-scheduler",
    });
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
    const room = testEnv.SCHEDULE_ROOMS.getByName("scheduler-unit-replace-final-rrule");

    await room.initialize({
      name: "scheduler-unit-replace-final-rrule",
      ownerUserId: "user-scheduler",
    });
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
    const room = testEnv.SCHEDULE_ROOMS.getByName("scheduler-unit-cancel");

    await room.initialize({
      name: "scheduler-unit-cancel",
      ownerUserId: "user-scheduler",
    });
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
    const room = testEnv.SCHEDULE_ROOMS.getByName("scheduler-unit-interval");

    await room.initialize({
      name: "scheduler-unit-interval",
      ownerUserId: "user-scheduler",
    });
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
    const room = testEnv.SCHEDULE_ROOMS.getByName("scheduler-unit-once-fails");

    await room.initialize({
      name: "scheduler-unit-once-fails",
      ownerUserId: "user-scheduler",
    });
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
    const room = testEnv.SCHEDULE_ROOMS.getByName("scheduler-unit-recurring-fails");

    await room.initialize({
      name: "scheduler-unit-recurring-fails",
      ownerUserId: "user-scheduler",
    });
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
    const room = testEnv.SCHEDULE_ROOMS.getByName("scheduler-unit-finite-rrule-done");

    await room.initialize({
      name: "scheduler-unit-finite-rrule-done",
      ownerUserId: "user-scheduler",
    });
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
    const room = testEnv.SCHEDULE_ROOMS.getByName("scheduler-unit-rrule-first-occurrence");

    await room.initialize({
      name: "scheduler-unit-rrule-first-occurrence",
      ownerUserId: "user-scheduler",
    });

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
    const room = testEnv.SCHEDULE_ROOMS.getByName("scheduler-unit-overlap");
    const startedAtMs = Date.now() - 1_000;

    await room.initialize({
      name: "scheduler-unit-overlap",
      ownerUserId: "user-scheduler",
    });
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
    const room = testEnv.SCHEDULE_ROOMS.getByName("scheduler-unit-hung");

    await room.initialize({
      name: "scheduler-unit-hung",
      ownerUserId: "user-scheduler",
    });
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
    const room = testEnv.SCHEDULE_ROOMS.getByName("scheduler-unit-calendar");

    await room.initialize({
      name: "scheduler-unit-calendar",
      ownerUserId: "user-scheduler",
    });
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
    const room = testEnv.SCHEDULE_ROOMS.getByName("scheduler-unit-full-rrule");

    await room.initialize({
      name: "scheduler-unit-full-rrule",
      ownerUserId: "user-scheduler",
    });

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
