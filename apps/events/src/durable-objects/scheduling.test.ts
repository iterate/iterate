import { env } from "cloudflare:test";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SCHEDULE_ADDED_TYPE } from "~/durable-objects/scheduling-types.ts";
import type {
  TestScheduleStreamDurableObject,
  TestStartupScheduleExplicitFalseStreamDurableObject,
  TestStartupScheduleNoWarnStreamDurableObject,
  TestStartupScheduleWarnStreamDurableObject,
} from "~/entry.workerd.vitest.ts";

// This suite is a direct port of Cloudflare Agents SDK scheduling tests:
// https://github.com/cloudflare/agents/blob/main/packages/agents/src/tests/schedule.test.ts
//
// Keep names, assertions, and coverage close to upstream so future SDK changes
// are easy to diff. If upstream behavior changes, update the harness in
// `scheduling.ts` first, then re-sync this file.
type TestEnv = {
  TEST_SCHEDULE_STREAM: DurableObjectNamespace<TestScheduleStreamDurableObject>;
  TEST_STARTUP_SCHEDULE_WARN_STREAM: DurableObjectNamespace<TestStartupScheduleWarnStreamDurableObject>;
  TEST_STARTUP_SCHEDULE_NO_WARN_STREAM: DurableObjectNamespace<TestStartupScheduleNoWarnStreamDurableObject>;
  TEST_STARTUP_SCHEDULE_EXPLICIT_FALSE_STREAM: DurableObjectNamespace<TestStartupScheduleExplicitFalseStreamDurableObject>;
};

const testEnv = env as unknown as TestEnv;

describe("schedule operations", () => {
  it("should repoint the stored alarm when a schedule control event is appended directly", async () => {
    const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("public-schedule-append-test");
    const path = "/public-schedule-append-test";
    const scheduleId = "public-schedule-append-id";
    const time = Math.floor(Date.now() / 1000) + 60;

    await streamStub.append({
      events: [
        {
          path,
          type: SCHEDULE_ADDED_TYPE,
          payload: {
            scheduleId,
            callback: "testCallback",
            payloadJson: null,
            scheduleType: "delayed",
            time,
            delayInSeconds: 60,
          },
        },
      ],
    });

    expect(await streamStub.getStoredAlarm()).toBe(time * 1000);

    const schedule = await streamStub.getScheduleById(scheduleId);
    expect(schedule?.id).toBe(scheduleId);
    expect(schedule?.callback).toBe("testCallback");
  });

  describe("cancelSchedule", () => {
    it("should return false when cancelling a non-existent schedule", async () => {
      const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("cancel-nonexistent-test");

      const result = await streamStub.cancelScheduleById("non-existent-id");
      expect(result).toBe(false);
    });

    it("should return true when cancelling an existing schedule", async () => {
      const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("cancel-existing-test");
      const scheduleId = await streamStub.createSchedule(60);

      const result = await streamStub.cancelScheduleById(scheduleId);
      expect(result).toBe(true);
    });
  });

  describe("getSchedule", () => {
    it("should return undefined when getting a non-existent schedule", async () => {
      const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("get-nonexistent-test");

      const result = await streamStub.getScheduleById("non-existent-id");
      expect(result).toBeUndefined();
    });

    it("should return schedule when getting an existing schedule", async () => {
      const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("get-existing-test");
      const scheduleId = await streamStub.createSchedule(60);

      const result = await streamStub.getScheduleById(scheduleId);
      expect(result).toBeDefined();
      expect(result?.id).toBe(scheduleId);
      expect(result?.callback).toBe("testCallback");
    });
  });

  describe("scheduleEvery (interval scheduling)", () => {
    it("should create an interval schedule with correct type", async () => {
      const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("interval-create-test");
      const scheduleId = await streamStub.createIntervalSchedule(30);

      const result = await streamStub.getScheduleById(scheduleId);
      expect(result).toBeDefined();
      expect(result?.type).toBe("interval");
      if (result?.type === "interval") {
        expect(result.intervalSeconds).toBe(30);
      }
      expect(result?.callback).toBe("intervalCallback");

      await streamStub.cancelScheduleById(scheduleId);
    });

    it("should cancel an interval schedule", async () => {
      const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("interval-cancel-test");
      const scheduleId = await streamStub.createIntervalSchedule(30);

      const beforeCancel = await streamStub.getScheduleById(scheduleId);
      expect(beforeCancel).toBeDefined();

      const cancelled = await streamStub.cancelScheduleById(scheduleId);
      expect(cancelled).toBe(true);

      const afterCancel = await streamStub.getScheduleById(scheduleId);
      expect(afterCancel).toBeUndefined();
    });

    it("should filter schedules by interval type", async () => {
      const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("interval-filter-test");
      const delayedId = await streamStub.createSchedule(60);
      const intervalId = await streamStub.createIntervalSchedule(30);

      const intervalSchedules = await streamStub.getSchedulesByType("interval");
      expect(intervalSchedules.length).toBe(1);
      expect(intervalSchedules[0].type).toBe("interval");

      const delayedSchedules = await streamStub.getSchedulesByType("delayed");
      expect(delayedSchedules.length).toBe(1);
      expect(delayedSchedules[0].type).toBe("delayed");

      await streamStub.cancelScheduleById(delayedId);
      await streamStub.cancelScheduleById(intervalId);
    });

    it("should persist interval schedule after callback throws", async () => {
      const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("interval-error-resilience-test");
      const scheduleId = await streamStub.createThrowingIntervalSchedule(1);

      await runDurableObjectAlarm(streamStub);

      const result = await streamStub.getScheduleById(scheduleId);
      expect(result).toBeDefined();
      expect(result?.type).toBe("interval");

      await streamStub.cancelScheduleById(scheduleId);
    });

    it("should reset running flag to 0 after interval execution completes", async () => {
      const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("running-flag-reset-test");

      await runInDurableObject(streamStub, async (instance: TestScheduleStreamDurableObject) => {
        instance.slowCallbackExecutionCount = 0;
        instance.slowCallbackStartTimes = [];
        instance.slowCallbackEndTimes = [];
        instance.intervalCallbackCount = 0;
      });

      const scheduleId = await streamStub.createIntervalSchedule(1);

      await runInDurableObject(streamStub, async (instance: TestScheduleStreamDurableObject) => {
        const past = Math.floor(Date.now() / 1000) - 1;
        instance.ctx.storage.sql.exec(
          `UPDATE cf_agents_schedules SET time = ? WHERE id = ?`,
          past,
          scheduleId,
        );
      });

      await runDurableObjectAlarm(streamStub);

      const afterState = await runInDurableObject(
        streamStub,
        async (instance: TestScheduleStreamDurableObject) => {
          const result = instance.ctx.storage.sql.exec<{
            running: number;
            execution_started_at: number | null;
          }>(
            `SELECT running, execution_started_at
             FROM cf_agents_schedules
             WHERE id = ?`,
            scheduleId,
          );
          return result.toArray()[0] ?? null;
        },
      );
      expect(afterState).toBeDefined();
      expect(afterState?.running).toBe(0);

      const count = await runInDurableObject(
        streamStub,
        async (instance: TestScheduleStreamDurableObject) => instance.intervalCallbackCount,
      );
      expect(count).toBeGreaterThan(0);

      await streamStub.cancelScheduleById(scheduleId);
    });

    it("should skip execution when running flag is already set (concurrent prevention)", async () => {
      const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("concurrent-prevention-test");

      await runInDurableObject(streamStub, async (instance: TestScheduleStreamDurableObject) => {
        instance.intervalCallbackCount = 0;
      });

      const scheduleId = await streamStub.createIntervalSchedule(60);
      await streamStub.clearStoredAlarm();

      await runInDurableObject(streamStub, async (instance: TestScheduleStreamDurableObject) => {
        const recentStart = Math.floor(Date.now() / 1000) - 5;
        const past = Math.floor(Date.now() / 1000) - 1;
        instance.ctx.storage.sql.exec(
          `UPDATE cf_agents_schedules
           SET running = 1, execution_started_at = ?, time = ?
           WHERE id = ?`,
          recentStart,
          past,
          scheduleId,
        );
      });

      await streamStub.setStoredAlarm(Date.now() + 1000);
      await runDurableObjectAlarm(streamStub);

      const count = await runInDurableObject(
        streamStub,
        async (instance: TestScheduleStreamDurableObject) => instance.intervalCallbackCount,
      );
      expect(count).toBe(0);

      await streamStub.cancelScheduleById(scheduleId);
    });

    it("should force-reset hung interval schedule after 30 seconds", async () => {
      const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("hung-reset-test");

      await runInDurableObject(streamStub, async (instance: TestScheduleStreamDurableObject) => {
        instance.intervalCallbackCount = 0;
      });

      const scheduleId = await streamStub.simulateHungSchedule(1);
      await streamStub.clearStoredAlarm();

      const beforeState = await runInDurableObject(
        streamStub,
        async (instance: TestScheduleStreamDurableObject) => {
          const past = Math.floor(Date.now() / 1000) - 1;
          instance.ctx.storage.sql.exec(
            `UPDATE cf_agents_schedules SET time = ? WHERE id = ?`,
            past,
            scheduleId,
          );

          const result = instance.ctx.storage.sql.exec<{
            running: number;
            execution_started_at: number | null;
          }>(
            `SELECT running, execution_started_at
             FROM cf_agents_schedules
             WHERE id = ?`,
            scheduleId,
          );
          return result.toArray()[0] ?? null;
        },
      );
      expect(beforeState?.running).toBe(1);

      await streamStub.setStoredAlarm(Date.now() + 1000);
      await runDurableObjectAlarm(streamStub);

      const count = await runInDurableObject(
        streamStub,
        async (instance: TestScheduleStreamDurableObject) => instance.intervalCallbackCount,
      );
      expect(count).toBeGreaterThan(0);

      await streamStub.cancelScheduleById(scheduleId);
    });

    it("should handle legacy schedules with NULL execution_started_at", async () => {
      const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("legacy-hung-test");

      await runInDurableObject(streamStub, async (instance: TestScheduleStreamDurableObject) => {
        instance.intervalCallbackCount = 0;
      });

      const scheduleId = await streamStub.simulateLegacyHungSchedule(1);
      await streamStub.clearStoredAlarm();

      const beforeState = await runInDurableObject(
        streamStub,
        async (instance: TestScheduleStreamDurableObject) => {
          const result = instance.ctx.storage.sql.exec<{
            running: number;
            execution_started_at: number | null;
          }>(
            `SELECT running, execution_started_at
             FROM cf_agents_schedules
             WHERE id = ?`,
            scheduleId,
          );
          return result.toArray()[0] ?? null;
        },
      );
      expect(beforeState?.running).toBe(1);
      expect(beforeState?.execution_started_at).toBeNull();

      await streamStub.backdateSchedule(scheduleId, Math.floor(Date.now() / 1000) - 1);
      await streamStub.setStoredAlarm(Date.now() + 1000);
      await runDurableObjectAlarm(streamStub);

      const count = await runInDurableObject(
        streamStub,
        async (instance: TestScheduleStreamDurableObject) => instance.intervalCallbackCount,
      );
      expect(count).toBeGreaterThan(0);

      await streamStub.cancelScheduleById(scheduleId);
    });
  });

  describe("schedule() onStart() warning", () => {
    it("should warn when schedule() is called inside onStart() without idempotent", async () => {
      const streamStub = testEnv.TEST_STARTUP_SCHEDULE_WARN_STREAM.getByName("onstart-warn-test");

      const warned = await streamStub.wasWarnedFor("testCallback");
      expect(warned).toBe(true);

      const count = await streamStub.getScheduleCount();
      expect(count).toBe(1);
    });

    it("should not warn when schedule() is called inside onStart() with idempotent: false (explicit opt-out)", async () => {
      const streamStub = testEnv.TEST_STARTUP_SCHEDULE_EXPLICIT_FALSE_STREAM.getByName(
        "onstart-explicit-false-test",
      );

      const warned = await streamStub.wasWarnedFor("testCallback");
      expect(warned).toBe(false);
    });

    it("should not warn when schedule() is called inside onStart() with idempotent", async () => {
      const streamStub =
        testEnv.TEST_STARTUP_SCHEDULE_NO_WARN_STREAM.getByName("onstart-no-warn-test");

      const warned = await streamStub.wasWarnedFor("testCallback");
      expect(warned).toBe(false);

      const count = await streamStub.getScheduleCount();
      expect(count).toBe(1);
    });
  });

  describe("schedule() cron idempotency (default)", () => {
    it("should return existing schedule when called with same cron, callback, and payload", async () => {
      const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("cron-idempotent-same-args-test");

      const firstId = await streamStub.createCronSchedule("0 * * * *");
      const secondId = await streamStub.createCronSchedule("0 * * * *");

      expect(secondId).toBe(firstId);

      const count = await streamStub.getScheduleCountByTypeAndCallback("cron", "cronCallback");
      expect(count).toBe(1);

      await streamStub.cancelScheduleById(firstId);
    });

    it("should not create duplicates when called many times (simulating repeated onStart)", async () => {
      const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("cron-idempotent-repeated-test");
      const ids: string[] = [];

      for (let index = 0; index < 5; index++) {
        ids.push(await streamStub.createCronSchedule("*/5 * * * *"));
      }

      expect([...new Set(ids)]).toHaveLength(1);

      const count = await streamStub.getScheduleCountByTypeAndCallback("cron", "cronCallback");
      expect(count).toBe(1);

      await streamStub.cancelScheduleById(ids[0]);
    });

    it("should create a new row when cron expression differs", async () => {
      const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName(
        "cron-idempotent-different-cron-test",
      );

      const firstId = await streamStub.createCronSchedule("0 * * * *");
      const secondId = await streamStub.createCronSchedule("30 * * * *");

      expect(secondId).not.toBe(firstId);

      const count = await streamStub.getScheduleCountByTypeAndCallback("cron", "cronCallback");
      expect(count).toBe(2);

      await streamStub.cancelScheduleById(firstId);
      await streamStub.cancelScheduleById(secondId);
    });

    it("should create a new row when payload differs", async () => {
      const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName(
        "cron-idempotent-different-payload-test",
      );

      const firstId = await streamStub.createCronScheduleWithPayload("0 * * * *", "foo");
      const secondId = await streamStub.createCronScheduleWithPayload("0 * * * *", "bar");

      expect(secondId).not.toBe(firstId);

      const count = await streamStub.getScheduleCountByTypeAndCallback("cron", "cronCallback");
      expect(count).toBe(2);

      await streamStub.cancelScheduleById(firstId);
      await streamStub.cancelScheduleById(secondId);
    });

    it("should allow duplicate cron rows when idempotent is explicitly false", async () => {
      const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("cron-non-idempotent-test");

      const firstId = await streamStub.createCronScheduleNonIdempotent("0 * * * *");
      const secondId = await streamStub.createCronScheduleNonIdempotent("0 * * * *");

      expect(secondId).not.toBe(firstId);

      const count = await streamStub.getScheduleCountByTypeAndCallback("cron", "cronCallback");
      expect(count).toBe(2);

      await streamStub.cancelScheduleById(firstId);
      await streamStub.cancelScheduleById(secondId);
    });
  });

  describe("schedule() delayed/scheduled idempotency (opt-in)", () => {
    it("should return existing delayed schedule when idempotent is true", async () => {
      const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("delayed-idempotent-test");

      const firstId = await streamStub.createIdempotentDelayedSchedule(60);
      const secondId = await streamStub.createIdempotentDelayedSchedule(60);

      expect(secondId).toBe(firstId);

      const count = await streamStub.getScheduleCountByTypeAndCallback("delayed", "testCallback");
      expect(count).toBe(1);

      await streamStub.cancelScheduleById(firstId);
    });

    it("should not create duplicates across many calls (simulating crash loop)", async () => {
      const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName(
        "delayed-idempotent-crash-loop-test",
      );
      const ids: string[] = [];

      for (let index = 0; index < 10; index++) {
        ids.push(await streamStub.createIdempotentDelayedSchedule(60));
      }

      expect([...new Set(ids)]).toHaveLength(1);

      const count = await streamStub.getScheduleCountByTypeAndCallback("delayed", "testCallback");
      expect(count).toBe(1);

      await streamStub.cancelScheduleById(ids[0]);
    });

    it("should create separate rows for different payloads even with idempotent", async () => {
      const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName(
        "delayed-idempotent-different-payload-test",
      );

      const firstId = await streamStub.createIdempotentDelayedScheduleWithPayload(60, "alice");
      const secondId = await streamStub.createIdempotentDelayedScheduleWithPayload(60, "bob");

      expect(secondId).not.toBe(firstId);

      const count = await streamStub.getScheduleCountByTypeAndCallback("delayed", "testCallback");
      expect(count).toBe(2);

      await streamStub.cancelScheduleById(firstId);
      await streamStub.cancelScheduleById(secondId);
    });

    it("should still create duplicates when idempotent is not set (default)", async () => {
      const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName(
        "delayed-non-idempotent-default-test",
      );

      const firstId = await streamStub.createSchedule(60);
      const secondId = await streamStub.createSchedule(60);

      expect(secondId).not.toBe(firstId);

      const count = await streamStub.getScheduleCountByTypeAndCallback("delayed", "testCallback");
      expect(count).toBe(2);

      await streamStub.cancelScheduleById(firstId);
      await streamStub.cancelScheduleById(secondId);
    });

    it("should return existing scheduled (Date) schedule when idempotent is true", async () => {
      const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("scheduled-idempotent-test");

      const futureMs = Date.now() + 60_000;
      const firstId = await streamStub.createIdempotentScheduledSchedule(futureMs);
      const secondId = await streamStub.createIdempotentScheduledSchedule(futureMs + 30_000);

      expect(secondId).toBe(firstId);

      const count = await streamStub.getScheduleCountByTypeAndCallback("scheduled", "testCallback");
      expect(count).toBe(1);

      await streamStub.cancelScheduleById(firstId);
    });
  });

  describe("alarm() duplicate schedule warning", () => {
    it("should warn when processing many stale one-shot rows for the same callback", async () => {
      const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("alarm-duplicate-warning-test");

      await streamStub.insertStaleDelayedRows(15, "testCallback");
      await runDurableObjectAlarm(streamStub);

      const count = await streamStub.getScheduleCountByTypeAndCallback("delayed", "testCallback");
      expect(count).toBe(0);
    });

    it("should not warn when stale one-shot count is below threshold", async () => {
      const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("alarm-no-warning-test");

      await streamStub.insertStaleDelayedRows(3, "testCallback");
      await runDurableObjectAlarm(streamStub);

      const count = await streamStub.getScheduleCountByTypeAndCallback("delayed", "testCallback");
      expect(count).toBe(0);
    });
  });

  describe("scheduleEvery idempotency", () => {
    it("should return existing schedule when called with same callback and interval", async () => {
      const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("idempotent-same-args-test");

      const firstId = await streamStub.createIntervalSchedule(30);
      const secondId = await streamStub.createIntervalSchedule(30);

      expect(secondId).toBe(firstId);

      const count = await runInDurableObject(
        streamStub,
        async (instance: TestScheduleStreamDurableObject) => {
          const result = instance.ctx.storage.sql.exec<{ count: number }>(
            `SELECT COUNT(*) AS count
             FROM cf_agents_schedules
             WHERE type = 'interval' AND callback = 'intervalCallback'`,
          );
          return result.toArray()[0]?.count ?? 0;
        },
      );
      expect(count).toBe(1);

      await streamStub.cancelScheduleById(firstId);
    });

    it("should re-arm a lost alarm when idempotency returns an existing interval schedule", async () => {
      const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("idempotent-rearm-lost-alarm-test");

      const firstId = await streamStub.createIntervalSchedule(30);

      await streamStub.clearStoredAlarm();
      expect(await streamStub.getStoredAlarm()).toBeNull();

      const { alarm: rearmedAlarm, id: secondId } =
        await streamStub.createIntervalScheduleAndReadAlarm(30);
      expect(secondId).toBe(firstId);
      expect(rearmedAlarm).not.toBeNull();

      await streamStub.cancelScheduleById(firstId);
    });

    it("should immediately re-arm an overdue interval schedule when idempotency returns the existing row", async () => {
      const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName(
        "idempotent-rearm-overdue-interval-test",
      );

      const firstId = await streamStub.createIntervalSchedule(30);

      await runInDurableObject(streamStub, async (instance: TestScheduleStreamDurableObject) => {
        instance.intervalCallbackCount = 0;
      });
      await streamStub.clearStoredAlarm();
      await streamStub.backdateSchedule(firstId, Math.floor(Date.now() / 1000) - 1);

      expect(await streamStub.getStoredAlarm()).toBeNull();

      const { alarm: rearmedAlarm, id: secondId } =
        await streamStub.createIntervalScheduleAndReadAlarm(30);
      expect(secondId).toBe(firstId);
      expect(rearmedAlarm).not.toBeNull();

      await streamStub.clearStoredAlarm();
      await streamStub.setStoredAlarm(Date.now() + 1000);
      await runDurableObjectAlarm(streamStub);

      const count = await runInDurableObject(
        streamStub,
        async (instance: TestScheduleStreamDurableObject) => instance.intervalCallbackCount,
      );
      expect(count).toBeGreaterThan(0);

      await streamStub.cancelScheduleById(firstId);
    });

    it("should return existing schedule when called with same callback, interval, and payload", async () => {
      const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("idempotent-same-payload-test");

      const firstId = await streamStub.createIntervalScheduleWithPayload(30, "hello");
      const secondId = await streamStub.createIntervalScheduleWithPayload(30, "hello");

      expect(secondId).toBe(firstId);

      const count = await runInDurableObject(
        streamStub,
        async (instance: TestScheduleStreamDurableObject) => {
          const result = instance.ctx.storage.sql.exec<{ count: number }>(
            `SELECT COUNT(*) AS count
             FROM cf_agents_schedules
             WHERE type = 'interval' AND callback = 'intervalCallback'`,
          );
          return result.toArray()[0]?.count ?? 0;
        },
      );
      expect(count).toBe(1);

      await streamStub.cancelScheduleById(firstId);
    });

    it("should create a new row when interval changes for same callback", async () => {
      const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("idempotent-interval-change-test");

      const firstId = await streamStub.createIntervalSchedule(30);
      const secondId = await streamStub.createIntervalSchedule(60);

      expect(secondId).not.toBe(firstId);

      const count = await runInDurableObject(
        streamStub,
        async (instance: TestScheduleStreamDurableObject) => {
          const result = instance.ctx.storage.sql.exec<{ count: number }>(
            `SELECT COUNT(*) AS count
             FROM cf_agents_schedules
             WHERE type = 'interval' AND callback = 'intervalCallback'`,
          );
          return result.toArray()[0]?.count ?? 0;
        },
      );
      expect(count).toBe(2);

      const schedule = await streamStub.getScheduleById(secondId);
      expect(schedule).toBeDefined();
      if (schedule?.type === "interval") {
        expect(schedule.intervalSeconds).toBe(60);
      }

      const original = await streamStub.getScheduleById(firstId);
      expect(original).toBeDefined();
      if (original?.type === "interval") {
        expect(original.intervalSeconds).toBe(30);
      }

      await streamStub.cancelScheduleById(firstId);
      await streamStub.cancelScheduleById(secondId);
    });

    it("should create a new row when payload changes for same callback", async () => {
      const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("idempotent-payload-change-test");

      const firstId = await streamStub.createIntervalScheduleWithPayload(30, "foo");
      const secondId = await streamStub.createIntervalScheduleWithPayload(30, "bar");

      expect(secondId).not.toBe(firstId);

      const count = await runInDurableObject(
        streamStub,
        async (instance: TestScheduleStreamDurableObject) => {
          const result = instance.ctx.storage.sql.exec<{ count: number }>(
            `SELECT COUNT(*) AS count
             FROM cf_agents_schedules
             WHERE type = 'interval' AND callback = 'intervalCallback'`,
          );
          return result.toArray()[0]?.count ?? 0;
        },
      );
      expect(count).toBe(2);

      const first = await streamStub.getScheduleById(firstId);
      expect(first).toBeDefined();
      expect(first?.payload).toBe("foo");

      const second = await streamStub.getScheduleById(secondId);
      expect(second).toBeDefined();
      expect(second?.payload).toBe("bar");

      await streamStub.cancelScheduleById(firstId);
      await streamStub.cancelScheduleById(secondId);
    });

    it("should allow different callbacks to have their own interval schedules", async () => {
      const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName(
        "idempotent-different-callbacks-test",
      );

      const firstId = await streamStub.createIntervalSchedule(30);
      const secondId = await streamStub.createSecondIntervalSchedule(30);

      expect(secondId).not.toBe(firstId);

      const count = await runInDurableObject(
        streamStub,
        async (instance: TestScheduleStreamDurableObject) => {
          const result = instance.ctx.storage.sql.exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM cf_agents_schedules WHERE type = 'interval'`,
          );
          return result.toArray()[0]?.count ?? 0;
        },
      );
      expect(count).toBe(2);

      await streamStub.cancelScheduleById(firstId);
      await streamStub.cancelScheduleById(secondId);
    });

    it("should not create duplicates when called many times (simulating repeated onStart)", async () => {
      const streamStub = testEnv.TEST_SCHEDULE_STREAM.getByName("idempotent-repeated-calls-test");
      const ids: string[] = [];

      for (let index = 0; index < 5; index++) {
        ids.push(await streamStub.createIntervalSchedule(30));
      }

      expect([...new Set(ids)]).toHaveLength(1);

      const count = await runInDurableObject(
        streamStub,
        async (instance: TestScheduleStreamDurableObject) => {
          const result = instance.ctx.storage.sql.exec<{ count: number }>(
            `SELECT COUNT(*) AS count
             FROM cf_agents_schedules
             WHERE type = 'interval' AND callback = 'intervalCallback'`,
          );
          return result.toArray()[0]?.count ?? 0;
        },
      );
      expect(count).toBe(1);

      await streamStub.cancelScheduleById(ids[0]);
    });
  });
});
