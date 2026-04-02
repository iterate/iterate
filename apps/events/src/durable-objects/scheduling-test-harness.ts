import type { Schedule, ScheduleCriteria } from "~/durable-objects/scheduling-types.ts";

type SchedulingTestSurface = {
  cancelSchedule(id: string): Promise<boolean>;
  ctx: DurableObjectState;
  getSchedule(id: string): Schedule | undefined;
  getSchedules(criteria?: ScheduleCriteria): Schedule[];
  schedule<T = unknown>(
    when: Date | number | string,
    callback: PropertyKey,
    payload?: T,
    options?: { idempotent?: boolean },
  ): Promise<Schedule>;
  scheduleEvery<T = unknown>(
    intervalSeconds: number,
    callback: PropertyKey,
    payload?: T,
    options?: { _idempotent?: boolean },
  ): Promise<Schedule>;
  wasScheduleWarningEmitted(callback: string): boolean;
};

function asSchedulingTestSurface(value: object): SchedulingTestSurface {
  return value as unknown as SchedulingTestSurface;
}

/**
 * Test-only port of the Cloudflare Agents scheduling test durable objects.
 *
 * Keep this out of the production worker entry so the main bundle only carries
 * the runtime scheduler, not the parity harness used by Vitest.
 */
export function createSchedulingTestDurableObjects<TBase extends new (...args: any[]) => object>(
  Base: TBase,
) {
  class TestStartupScheduleWarnStreamDurableObject extends Base {
    testCallback() {}

    protected async onInitialize(): Promise<void> {
      await asSchedulingTestSurface(this).schedule(60, "testCallback");
    }

    wasWarnedFor(callback: string) {
      return asSchedulingTestSurface(this).wasScheduleWarningEmitted(callback);
    }

    async getScheduleCount(): Promise<number> {
      const result = asSchedulingTestSurface(this).ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM cf_agents_schedules",
      );
      return result.one()?.count ?? 0;
    }
  }

  class TestStartupScheduleNoWarnStreamDurableObject extends Base {
    testCallback() {}

    protected async onInitialize(): Promise<void> {
      await asSchedulingTestSurface(this).schedule(60, "testCallback", undefined, {
        idempotent: true,
      });
    }

    wasWarnedFor(callback: string) {
      return asSchedulingTestSurface(this).wasScheduleWarningEmitted(callback);
    }

    async getScheduleCount(): Promise<number> {
      const result = asSchedulingTestSurface(this).ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM cf_agents_schedules",
      );
      return result.one()?.count ?? 0;
    }
  }

  class TestStartupScheduleExplicitFalseStreamDurableObject extends Base {
    testCallback() {}

    protected async onInitialize(): Promise<void> {
      await asSchedulingTestSurface(this).schedule(60, "testCallback", undefined, {
        idempotent: false,
      });
    }

    wasWarnedFor(callback: string) {
      return asSchedulingTestSurface(this).wasScheduleWarningEmitted(callback);
    }
  }

  class TestScheduleStreamDurableObject extends Base {
    intervalCallbackCount = 0;
    slowCallbackExecutionCount = 0;
    slowCallbackStartTimes: number[] = [];
    slowCallbackEndTimes: number[] = [];

    testCallback() {}

    intervalCallback() {
      this.intervalCallbackCount++;
    }

    throwingCallback() {
      throw new Error("Intentional test error");
    }

    async slowCallback() {
      this.slowCallbackExecutionCount++;
      this.slowCallbackStartTimes.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 500));
      this.slowCallbackEndTimes.push(Date.now());
    }

    secondIntervalCallback() {}

    cronCallback() {}

    async cancelScheduleById(id: string): Promise<boolean> {
      return asSchedulingTestSurface(this).cancelSchedule(id);
    }

    async getScheduleById(id: string) {
      return asSchedulingTestSurface(this).getSchedule(id);
    }

    async clearStoredAlarm(): Promise<void> {
      await asSchedulingTestSurface(this).ctx.storage.deleteAlarm();
    }

    async setStoredAlarm(timeMs: number): Promise<void> {
      await asSchedulingTestSurface(this).ctx.storage.setAlarm(timeMs);
    }

    async getStoredAlarm(): Promise<number | null> {
      return asSchedulingTestSurface(this).ctx.storage.getAlarm();
    }

    async backdateSchedule(id: string, time: number): Promise<void> {
      asSchedulingTestSurface(this).ctx.storage.sql.exec(
        `UPDATE cf_agents_schedules SET time = ? WHERE id = ?`,
        time,
        id,
      );
    }

    async createSchedule(delaySeconds: number): Promise<string> {
      const schedule = await asSchedulingTestSurface(this).schedule(delaySeconds, "testCallback");
      return schedule.id;
    }

    async createIntervalSchedule(intervalSeconds: number): Promise<string> {
      const schedule = await asSchedulingTestSurface(this).scheduleEvery(
        intervalSeconds,
        "intervalCallback",
      );
      return schedule.id;
    }

    async createIntervalScheduleAndReadAlarm(
      intervalSeconds: number,
    ): Promise<{ alarm: number | null; id: string }> {
      const schedule = await asSchedulingTestSurface(this).scheduleEvery(
        intervalSeconds,
        "intervalCallback",
      );
      const alarm = await asSchedulingTestSurface(this).ctx.storage.getAlarm();
      return { alarm, id: schedule.id };
    }

    async createThrowingIntervalSchedule(intervalSeconds: number): Promise<string> {
      const schedule = await asSchedulingTestSurface(this).scheduleEvery(
        intervalSeconds,
        "throwingCallback",
      );
      return schedule.id;
    }

    async getSchedulesByType(type: "scheduled" | "delayed" | "cron" | "interval") {
      return asSchedulingTestSurface(this).getSchedules({ type });
    }

    async createSlowIntervalSchedule(intervalSeconds: number): Promise<string> {
      const schedule = await asSchedulingTestSurface(this).scheduleEvery(
        intervalSeconds,
        "slowCallback",
      );
      return schedule.id;
    }

    async simulateHungSchedule(intervalSeconds: number): Promise<string> {
      const schedule = await asSchedulingTestSurface(this).scheduleEvery(
        intervalSeconds,
        "intervalCallback",
      );
      asSchedulingTestSurface(this).ctx.storage.sql.exec(
        `UPDATE cf_agents_schedules
         SET running = 1, execution_started_at = ?
         WHERE id = ?`,
        Math.floor(Date.now() / 1000) - 60,
        schedule.id,
      );
      return schedule.id;
    }

    async simulateLegacyHungSchedule(intervalSeconds: number): Promise<string> {
      const schedule = await asSchedulingTestSurface(this).scheduleEvery(
        intervalSeconds,
        "intervalCallback",
      );
      asSchedulingTestSurface(this).ctx.storage.sql.exec(
        `UPDATE cf_agents_schedules
         SET running = 1, execution_started_at = NULL
         WHERE id = ?`,
        schedule.id,
      );
      return schedule.id;
    }

    async createCronSchedule(cronExpr: string): Promise<string> {
      const schedule = await asSchedulingTestSurface(this).schedule(cronExpr, "cronCallback");
      return schedule.id;
    }

    async createCronScheduleWithPayload(cronExpr: string, payload: string): Promise<string> {
      const schedule = await asSchedulingTestSurface(this).schedule(
        cronExpr,
        "cronCallback",
        payload,
      );
      return schedule.id;
    }

    async createCronScheduleNonIdempotent(cronExpr: string): Promise<string> {
      const schedule = await asSchedulingTestSurface(this).schedule(
        cronExpr,
        "cronCallback",
        undefined,
        {
          idempotent: false,
        },
      );
      return schedule.id;
    }

    async createIdempotentDelayedSchedule(delaySeconds: number): Promise<string> {
      const schedule = await asSchedulingTestSurface(this).schedule(
        delaySeconds,
        "testCallback",
        undefined,
        {
          idempotent: true,
        },
      );
      return schedule.id;
    }

    async createIdempotentDelayedScheduleWithPayload(
      delaySeconds: number,
      payload: string,
    ): Promise<string> {
      const schedule = await asSchedulingTestSurface(this).schedule(
        delaySeconds,
        "testCallback",
        payload,
        {
          idempotent: true,
        },
      );
      return schedule.id;
    }

    async createIdempotentScheduledSchedule(dateMs: number): Promise<string> {
      const schedule = await asSchedulingTestSurface(this).schedule(
        new Date(dateMs),
        "testCallback",
        undefined,
        {
          idempotent: true,
        },
      );
      return schedule.id;
    }

    async getScheduleCount(): Promise<number> {
      const result = asSchedulingTestSurface(this).ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM cf_agents_schedules",
      );
      return result.one()?.count ?? 0;
    }

    async getScheduleCountByTypeAndCallback(type: string, callback: string): Promise<number> {
      const result = asSchedulingTestSurface(this).ctx.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM cf_agents_schedules
         WHERE type = ? AND callback = ?`,
        type,
        callback,
      );
      return result.one()?.count ?? 0;
    }

    async insertStaleDelayedRows(count: number, callback: string): Promise<void> {
      const past = Math.floor(Date.now() / 1000) - 60;
      for (let index = 0; index < count; index++) {
        asSchedulingTestSurface(this).ctx.storage.sql.exec(
          `INSERT INTO cf_agents_schedules (
             id, callback, payload, type, delayInSeconds, time, running,
             execution_started_at, retry_options, created_at
           )
           VALUES (?, ?, NULL, 'delayed', 60, ?, 0, NULL, NULL, ?)`,
          `stale-${index}`,
          callback,
          past,
          past - 60,
        );
      }

      await asSchedulingTestSurface(this).ctx.storage.setAlarm(Date.now() + 1000);
    }

    async createIntervalScheduleWithPayload(
      intervalSeconds: number,
      payload: string,
    ): Promise<string> {
      const schedule = await asSchedulingTestSurface(this).scheduleEvery(
        intervalSeconds,
        "intervalCallback",
        payload,
      );
      return schedule.id;
    }

    async createSecondIntervalSchedule(intervalSeconds: number): Promise<string> {
      const schedule = await asSchedulingTestSurface(this).scheduleEvery(
        intervalSeconds,
        "secondIntervalCallback",
      );
      return schedule.id;
    }
  }

  return {
    TestScheduleStreamDurableObject,
    TestStartupScheduleExplicitFalseStreamDurableObject,
    TestStartupScheduleNoWarnStreamDurableObject,
    TestStartupScheduleWarnStreamDurableObject,
  };
}
