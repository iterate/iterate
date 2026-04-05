import type { EventInput } from "@iterate-com/events-contract";
import {
  cancelScheduleOnStream,
  getScheduleFromStorage,
  getSchedulesFromStorage,
  scheduleEveryOnStream,
  scheduleOnStream,
} from "~/durable-objects/processors/scheduling/index.ts";
import type { SchedulingMutationDeps } from "~/durable-objects/processors/scheduling/types.ts";

type SchedulingTestSurface = {
  append(event: EventInput): Promise<unknown> | unknown;
  ctx: DurableObjectState;
  ensureInitializedForCurrentName(): Promise<void>;
  getSchedulingMutationDeps(): SchedulingMutationDeps;
  initialize(args: { path: string; projectSlug: string }): Promise<void> | void;
  wasScheduleWarningEmitted(callback: string): boolean;
};

function asSchedulingTestSurface(value: object): SchedulingTestSurface {
  return value as unknown as SchedulingTestSurface;
}

async function getSchedulingMutationDeps(value: object) {
  const surface = asSchedulingTestSurface(value);
  await surface.ensureInitializedForCurrentName();
  return surface.getSchedulingMutationDeps();
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
  class SchedulingTestBase extends Base {
    protected async ensureInitializedForCurrentName(): Promise<void> {
      const surface = asSchedulingTestSurface(this);
      const reducedStateCount =
        surface.ctx.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM reduced_state")
          .one()?.count ?? 0;

      if (reducedStateCount > 0) {
        return;
      }

      await surface.initialize({ projectSlug: "test", path: "/__test" });
    }
  }

  class TestStartupScheduleWarnStreamDurableObject extends SchedulingTestBase {
    testCallback() {}

    protected async onInitialize(): Promise<void> {
      await scheduleOnStream({
        when: 60,
        callback: "testCallback",
        deps: await getSchedulingMutationDeps(this),
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

  class TestStartupScheduleNoWarnStreamDurableObject extends SchedulingTestBase {
    testCallback() {}

    protected async onInitialize(): Promise<void> {
      await scheduleOnStream({
        when: 60,
        callback: "testCallback",
        deps: await getSchedulingMutationDeps(this),
        options: {
          idempotent: true,
        },
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

  class TestStartupScheduleExplicitFalseStreamDurableObject extends SchedulingTestBase {
    testCallback() {}

    protected async onInitialize(): Promise<void> {
      await scheduleOnStream({
        when: 60,
        callback: "testCallback",
        deps: await getSchedulingMutationDeps(this),
        options: {
          idempotent: false,
        },
      });
    }

    wasWarnedFor(callback: string) {
      return asSchedulingTestSurface(this).wasScheduleWarningEmitted(callback);
    }
  }

  class TestScheduleStreamDurableObject extends SchedulingTestBase {
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
      return cancelScheduleOnStream({
        id,
        append: asSchedulingTestSurface(this).append.bind(this),
        ctx: asSchedulingTestSurface(this).ctx,
      });
    }

    async getScheduleById(id: string) {
      return getScheduleFromStorage(asSchedulingTestSurface(this).ctx, id);
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
      const schedule = await scheduleOnStream({
        when: delaySeconds,
        callback: "testCallback",
        deps: await getSchedulingMutationDeps(this),
      });
      return schedule.id;
    }

    async createIntervalSchedule(intervalSeconds: number): Promise<string> {
      const schedule = await scheduleEveryOnStream({
        intervalSeconds,
        callback: "intervalCallback",
        deps: await getSchedulingMutationDeps(this),
      });
      return schedule.id;
    }

    async createIntervalScheduleAndReadAlarm(
      intervalSeconds: number,
    ): Promise<{ alarm: number | null; id: string }> {
      const schedule = await scheduleEveryOnStream({
        intervalSeconds,
        callback: "intervalCallback",
        deps: await getSchedulingMutationDeps(this),
      });
      const alarm = await asSchedulingTestSurface(this).ctx.storage.getAlarm();
      return { alarm, id: schedule.id };
    }

    async createThrowingIntervalSchedule(intervalSeconds: number): Promise<string> {
      const schedule = await scheduleEveryOnStream({
        intervalSeconds,
        callback: "throwingCallback",
        deps: await getSchedulingMutationDeps(this),
      });
      return schedule.id;
    }

    async getSchedulesByType(type: "scheduled" | "delayed" | "cron" | "interval") {
      return getSchedulesFromStorage(asSchedulingTestSurface(this).ctx, { type });
    }

    async createSlowIntervalSchedule(intervalSeconds: number): Promise<string> {
      const schedule = await scheduleEveryOnStream({
        intervalSeconds,
        callback: "slowCallback",
        deps: await getSchedulingMutationDeps(this),
      });
      return schedule.id;
    }

    async simulateHungSchedule(intervalSeconds: number): Promise<string> {
      const schedule = await scheduleEveryOnStream({
        intervalSeconds,
        callback: "intervalCallback",
        deps: await getSchedulingMutationDeps(this),
      });
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
      const schedule = await scheduleEveryOnStream({
        intervalSeconds,
        callback: "intervalCallback",
        deps: await getSchedulingMutationDeps(this),
      });
      asSchedulingTestSurface(this).ctx.storage.sql.exec(
        `UPDATE cf_agents_schedules
         SET running = 1, execution_started_at = NULL
         WHERE id = ?`,
        schedule.id,
      );
      return schedule.id;
    }

    async createCronSchedule(cronExpr: string): Promise<string> {
      const schedule = await scheduleOnStream({
        when: cronExpr,
        callback: "cronCallback",
        deps: await getSchedulingMutationDeps(this),
      });
      return schedule.id;
    }

    async createCronScheduleWithPayload(cronExpr: string, payload: string): Promise<string> {
      const schedule = await scheduleOnStream({
        when: cronExpr,
        callback: "cronCallback",
        deps: await getSchedulingMutationDeps(this),
        payload,
      });
      return schedule.id;
    }

    async createCronScheduleNonIdempotent(cronExpr: string): Promise<string> {
      const schedule = await scheduleOnStream({
        when: cronExpr,
        callback: "cronCallback",
        deps: await getSchedulingMutationDeps(this),
        options: {
          idempotent: false,
        },
      });
      return schedule.id;
    }

    async createIdempotentDelayedSchedule(delaySeconds: number): Promise<string> {
      const schedule = await scheduleOnStream({
        when: delaySeconds,
        callback: "testCallback",
        deps: await getSchedulingMutationDeps(this),
        options: {
          idempotent: true,
        },
      });
      return schedule.id;
    }

    async createIdempotentDelayedScheduleWithPayload(
      delaySeconds: number,
      payload: string,
    ): Promise<string> {
      const schedule = await scheduleOnStream({
        when: delaySeconds,
        callback: "testCallback",
        deps: await getSchedulingMutationDeps(this),
        payload,
        options: {
          idempotent: true,
        },
      });
      return schedule.id;
    }

    async createIdempotentScheduledSchedule(dateMs: number): Promise<string> {
      const schedule = await scheduleOnStream({
        when: new Date(dateMs),
        callback: "testCallback",
        deps: await getSchedulingMutationDeps(this),
        options: {
          idempotent: true,
        },
      });
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
      const schedule = await scheduleEveryOnStream({
        intervalSeconds,
        callback: "intervalCallback",
        deps: await getSchedulingMutationDeps(this),
        payload,
      });
      return schedule.id;
    }

    async createSecondIntervalSchedule(intervalSeconds: number): Promise<string> {
      const schedule = await scheduleEveryOnStream({
        intervalSeconds,
        callback: "secondIntervalCallback",
        deps: await getSchedulingMutationDeps(this),
      });
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
