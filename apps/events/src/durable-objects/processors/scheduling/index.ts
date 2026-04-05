import { parseCronExpression } from "cron-schedule";
import { z } from "zod";
import type { ReducedStreamState } from "~/durable-objects/reduced-stream-state.ts";
import type { StreamProcessor } from "~/durable-objects/processors/runtime.ts";
import {
  DUPLICATE_SCHEDULE_THRESHOLD,
  Event,
  HUNG_INTERVAL_TIMEOUT_SECONDS,
  MAX_INTERVAL_SECONDS,
  type Schedule,
  type ScheduleCriteria,
  type ScheduleLookupArgs,
  type ScheduleProjectionState,
  type ScheduleRow,
  type SchedulingAlarmDeps,
  type SchedulingMutationDeps,
  SCHEDULE_ADDED_TYPE,
  SCHEDULE_CANCELLED_TYPE,
  SCHEDULE_EXECUTION_FINISHED_TYPE,
  SCHEDULE_EXECUTION_STARTED_TYPE,
  ScheduleAddedPayload,
  ScheduleCancelledPayload,
  ScheduleExecutionFinishedPayload,
  ScheduleExecutionStartedPayload,
  ScheduleTypeConstraint,
  deserializeSchedulePayload,
  rowToSchedule,
  serializeSchedulePayload,
} from "~/durable-objects/processors/scheduling/types.ts";

export const schedulingProcessor: StreamProcessor = {
  slug: "scheduling",

  ensureSchema(ctx) {
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS cf_agents_schedules (
        id TEXT PRIMARY KEY,
        callback TEXT NOT NULL,
        payload TEXT CHECK(payload IS NULL OR json_valid(payload)),
        type TEXT NOT NULL CHECK(type IN (${ScheduleTypeConstraint})),
        time INTEGER NOT NULL,
        delayInSeconds INTEGER,
        cron TEXT,
        intervalSeconds INTEGER,
        running INTEGER NOT NULL DEFAULT 0,
        execution_started_at INTEGER,
        retry_options TEXT,
        created_at INTEGER NOT NULL
      )
    `);
  },

  hydrate({ ctx, reducedState }) {
    hydrateScheduleProjectionIfNeeded({
      ctx,
      reducedState,
    });
  },

  reduce({ event, state }) {
    return {
      ...state,
      cf_agents_schedules: reduceSchedulingState({
        event,
        schedules: state.cf_agents_schedules,
      }),
    };
  },

  applyProjectionSync({ ctx, event }) {
    applyScheduleProjectionEventSync({
      ctx,
      event,
    });
  },

  async afterCommit({ ctx, event }) {
    if (isScheduleControlEventType(event.type)) {
      await scheduleNextAlarmFromTable(ctx);
    }
  },

  async alarm({ append, ctx, instance }) {
    await runScheduleAlarm({
      append,
      ctx,
      instance,
    });
  },
};

export async function scheduleOnStream<T = unknown>(args: {
  callback: PropertyKey;
  deps: SchedulingMutationDeps;
  options?: { idempotent?: boolean };
  payload?: T;
  when: Date | number | string;
}): Promise<Schedule> {
  const { deps, options, payload, when } = args;
  const callbackName = deps.validateScheduleCallback(args.callback);
  const payloadJson = serializeSchedulePayload(payload);

  if (
    deps.isInitializing &&
    options?.idempotent == null &&
    typeof when !== "string" &&
    !deps.warnedScheduleInOnStart.has(callbackName)
  ) {
    deps.warnedScheduleInOnStart.add(callbackName);
    console.warn(
      `schedule("${callbackName}") called inside onInitialize() without { idempotent: true }. ` +
        "This creates a new row on every Durable Object restart, which can cause duplicate executions. " +
        "Pass { idempotent: true } to deduplicate, or use scheduleEvery() for recurring tasks.",
    );
  }

  let addedPayload: z.infer<typeof ScheduleAddedPayload>;
  let existing: ScheduleRow | undefined;

  if (when instanceof Date) {
    const timestamp = Math.floor(when.getTime() / 1000);

    if (options?.idempotent) {
      existing = getExistingScheduleRow(deps.ctx, {
        type: "scheduled",
        callback: callbackName,
        payloadJson,
      });
    }

    addedPayload = {
      scheduleId: existing?.id ?? createScheduleId(),
      callback: callbackName,
      payloadJson,
      scheduleType: "scheduled",
      time: existing?.time ?? timestamp,
    };
  } else if (typeof when === "number") {
    if (!Number.isFinite(when) || when <= 0) {
      throw new Error("Delay schedules require a positive number of seconds.");
    }

    const timestamp = Math.floor(Date.now() / 1000) + Math.floor(when);

    if (options?.idempotent) {
      existing = getExistingScheduleRow(deps.ctx, {
        type: "delayed",
        callback: callbackName,
        payloadJson,
      });
    }

    addedPayload = {
      scheduleId: existing?.id ?? createScheduleId(),
      callback: callbackName,
      payloadJson,
      scheduleType: "delayed",
      time: existing?.time ?? timestamp,
      delayInSeconds: existing?.delayInSeconds ?? Math.floor(when),
    };
  } else if (typeof when === "string") {
    const nextExecutionTime = getNextCronTime(when);
    const timestamp = Math.floor(nextExecutionTime.getTime() / 1000);
    const idempotent = options?.idempotent !== false;

    if (idempotent) {
      existing = getExistingScheduleRow(deps.ctx, {
        type: "cron",
        callback: callbackName,
        payloadJson,
        cron: when,
      });
    }

    addedPayload = {
      scheduleId: existing?.id ?? createScheduleId(),
      callback: callbackName,
      payloadJson,
      scheduleType: "cron",
      time: existing?.time ?? timestamp,
      cron: existing?.cron ?? when,
    };
  } else {
    throw new Error(
      `Invalid schedule type: ${JSON.stringify(when)} (${typeof when}) trying to schedule ${callbackName}`,
    );
  }

  if (existing == null) {
    await deps.append({
      type: SCHEDULE_ADDED_TYPE,
      payload: addedPayload,
    });
  }

  await scheduleNextAlarmFromTable(deps.ctx);

  const schedule = getScheduleFromStorage(deps.ctx, addedPayload.scheduleId);
  if (schedule == null) {
    throw new Error(`Expected schedule ${addedPayload.scheduleId} to exist after scheduling.`);
  }

  return schedule;
}

export async function scheduleEveryOnStream<T = unknown>(args: {
  callback: PropertyKey;
  deps: SchedulingMutationDeps;
  intervalSeconds: number;
  options?: { _idempotent?: boolean };
  payload?: T;
}): Promise<Schedule> {
  const { deps, intervalSeconds, options, payload } = args;
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    throw new Error("intervalSeconds must be a positive number");
  }

  if (intervalSeconds > MAX_INTERVAL_SECONDS) {
    throw new Error(`intervalSeconds cannot exceed ${MAX_INTERVAL_SECONDS} seconds (30 days)`);
  }

  const callbackName = deps.validateScheduleCallback(args.callback);
  const payloadJson = serializeSchedulePayload(payload);
  const idempotent = options?._idempotent !== false;
  const existing = idempotent
    ? getExistingScheduleRow(deps.ctx, {
        type: "interval",
        callback: callbackName,
        payloadJson,
        intervalSeconds,
      })
    : undefined;

  if (existing == null) {
    await deps.append({
      type: SCHEDULE_ADDED_TYPE,
      payload: {
        scheduleId: createScheduleId(),
        callback: callbackName,
        payloadJson,
        scheduleType: "interval",
        time: Math.floor(Date.now() / 1000) + Math.floor(intervalSeconds),
        intervalSeconds,
      },
    });
  }

  await scheduleNextAlarmFromTable(deps.ctx);

  const scheduleId =
    existing?.id ??
    getLatestScheduleIdFor(deps.ctx, {
      type: "interval",
      callback: callbackName,
      payloadJson,
      intervalSeconds,
    });

  if (scheduleId == null) {
    throw new Error("Failed to resolve interval schedule after scheduling.");
  }

  const schedule = getScheduleFromStorage(deps.ctx, scheduleId);
  if (schedule == null) {
    throw new Error(`Expected schedule ${scheduleId} to exist after scheduling.`);
  }

  return schedule;
}

export function getScheduleFromStorage(ctx: DurableObjectState, id: string): Schedule | undefined {
  const row = ctx.storage.sql
    .exec<ScheduleRow>(
      `SELECT id, callback, payload, type, time, delayInSeconds, cron, intervalSeconds,
              running, execution_started_at, retry_options, created_at
       FROM cf_agents_schedules
       WHERE id = ?
       LIMIT 1`,
      id,
    )
    .next().value;

  return row == null ? undefined : rowToSchedule(row);
}

export function getSchedulesFromStorage(
  ctx: DurableObjectState,
  criteria: ScheduleCriteria = {},
): Schedule[] {
  let query = `SELECT id, callback, payload, type, time, delayInSeconds, cron, intervalSeconds,
                      running, execution_started_at, retry_options, created_at
               FROM cf_agents_schedules
               WHERE 1 = 1`;
  const params: Array<string | number> = [];

  if (criteria.id != null) {
    query += " AND id = ?";
    params.push(criteria.id);
  }

  if (criteria.type != null) {
    query += " AND type = ?";
    params.push(criteria.type);
  }

  if (criteria.timeRange != null) {
    query += " AND time >= ? AND time <= ?";
    params.push(
      Math.floor((criteria.timeRange.start ?? new Date(0)).getTime() / 1000),
      Math.floor((criteria.timeRange.end ?? new Date(999999999999999)).getTime() / 1000),
    );
  }

  return ctx.storage.sql
    .exec<ScheduleRow>(query, ...params)
    .toArray()
    .map(rowToSchedule);
}

export async function cancelScheduleOnStream(args: {
  ctx: DurableObjectState;
  append: SchedulingMutationDeps["append"];
  id: string;
}): Promise<boolean> {
  if (getScheduleFromStorage(args.ctx, args.id) == null) {
    return false;
  }

  await args.append({
    type: SCHEDULE_CANCELLED_TYPE,
    payload: {
      scheduleId: args.id,
    },
  });

  await scheduleNextAlarmFromTable(args.ctx);
  return true;
}

export async function runScheduleAlarm(args: SchedulingAlarmDeps): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const dueSchedules = args.ctx.storage.sql
    .exec<ScheduleRow>(
      `SELECT id, callback, payload, type, time, delayInSeconds, cron, intervalSeconds,
              running, execution_started_at, retry_options, created_at
       FROM cf_agents_schedules
       WHERE time <= ?
       ORDER BY time ASC, created_at ASC`,
      now,
    )
    .toArray();

  if (dueSchedules.length > 0) {
    const oneShotCounts = new Map<string, number>();
    for (const row of dueSchedules) {
      if (row.type === "delayed" || row.type === "scheduled") {
        oneShotCounts.set(row.callback, (oneShotCounts.get(row.callback) ?? 0) + 1);
      }
    }

    for (const [callback, count] of oneShotCounts) {
      if (count < DUPLICATE_SCHEDULE_THRESHOLD) {
        continue;
      }

      console.warn(
        `Processing ${count} stale "${callback}" schedules in a single alarm cycle. ` +
          "This usually means schedule() is being called repeatedly without the idempotent option. " +
          "Consider using scheduleEvery() for recurring tasks or passing { idempotent: true } to schedule().",
      );
    }
  }

  for (const row of dueSchedules) {
    const callback = Reflect.get(args.instance, row.callback);
    if (typeof callback !== "function") {
      console.error("[stream-do] schedule callback not found", {
        callback: row.callback,
        scheduleId: row.id,
      });

      try {
        await appendScheduleExecutionFinished({
          append: args.append,
          nextTime: null,
          outcome: "failed",
          scheduleId: row.id,
        });
      } catch (appendError) {
        console.error(`[stream-do] failed to retire missing callback schedule "${row.callback}"`, {
          appendError,
          scheduleId: row.id,
        });
      }

      continue;
    }

    if (row.type === "interval" && row.running === 1) {
      const executionStartedAt = row.execution_started_at ?? 0;
      const elapsedSeconds = now - executionStartedAt;

      if (elapsedSeconds < HUNG_INTERVAL_TIMEOUT_SECONDS) {
        console.warn(`Skipping interval schedule ${row.id}: previous execution still running`);
        continue;
      }

      console.warn(
        `Forcing reset of hung interval schedule ${row.id} (started ${elapsedSeconds}s ago)`,
      );
    }

    try {
      if (row.type === "interval") {
        await args.append({
          type: SCHEDULE_EXECUTION_STARTED_TYPE,
          payload: {
            scheduleId: row.id,
            startedAt: now,
          },
        });
      }

      await callback.call(
        args.instance,
        deserializeSchedulePayload(row.payload),
        rowToSchedule(row),
      );

      await appendScheduleExecutionFinished({
        append: args.append,
        nextTime: getNextExecutionTime(row),
        outcome: "succeeded",
        scheduleId: row.id,
      });
    } catch (error) {
      console.error(`[stream-do] error executing callback "${row.callback}"`, error);

      try {
        await appendScheduleExecutionFinished({
          append: args.append,
          nextTime: getSafeFailedNextTime({ now, row }),
          outcome: "failed",
          scheduleId: row.id,
        });
      } catch (appendError) {
        console.error(`[stream-do] failed to record schedule failure "${row.callback}"`, {
          appendError,
          scheduleId: row.id,
        });
      }
    }
  }

  await scheduleNextAlarmFromTable(args.ctx);
}

export function isScheduleControlEventType(type: string): boolean {
  switch (type) {
    case SCHEDULE_ADDED_TYPE:
    case SCHEDULE_CANCELLED_TYPE:
    case SCHEDULE_EXECUTION_STARTED_TYPE:
    case SCHEDULE_EXECUTION_FINISHED_TYPE:
      return true;
    default:
      return false;
  }
}

export function reduceSchedulingState(args: {
  event: Event;
  schedules: ScheduleProjectionState;
}): ScheduleProjectionState {
  switch (args.event.type) {
    case SCHEDULE_ADDED_TYPE: {
      const payload = ScheduleAddedPayload.parse(args.event.payload);
      const nextSchedules = { ...args.schedules };
      nextSchedules[payload.scheduleId] = {
        id: payload.scheduleId,
        callback: payload.callback,
        payload: payload.payloadJson ?? null,
        type: payload.scheduleType,
        time: payload.time,
        delayInSeconds: payload.delayInSeconds ?? null,
        cron: payload.cron ?? null,
        intervalSeconds: payload.intervalSeconds ?? null,
        running: 0,
        execution_started_at: null,
        retry_options: null,
        created_at: Math.floor(new Date(args.event.createdAt).getTime() / 1000),
      };
      return nextSchedules;
    }
    case SCHEDULE_CANCELLED_TYPE: {
      const payload = ScheduleCancelledPayload.parse(args.event.payload);
      const nextSchedules = { ...args.schedules };
      delete nextSchedules[payload.scheduleId];
      return nextSchedules;
    }
    case SCHEDULE_EXECUTION_STARTED_TYPE: {
      const payload = ScheduleExecutionStartedPayload.parse(args.event.payload);
      const nextSchedules = { ...args.schedules };
      const schedule = nextSchedules[payload.scheduleId];
      if (schedule == null) {
        return args.schedules;
      }

      nextSchedules[payload.scheduleId] = {
        ...schedule,
        running: 1,
        execution_started_at: payload.startedAt,
      };
      return nextSchedules;
    }
    case SCHEDULE_EXECUTION_FINISHED_TYPE: {
      const payload = ScheduleExecutionFinishedPayload.parse(args.event.payload);
      const nextSchedules = { ...args.schedules };
      const schedule = nextSchedules[payload.scheduleId];
      if (schedule == null) {
        return args.schedules;
      }

      if (payload.nextTime == null) {
        delete nextSchedules[payload.scheduleId];
        return nextSchedules;
      }

      nextSchedules[payload.scheduleId] = {
        ...schedule,
        time: payload.nextTime,
        running: 0,
        execution_started_at: null,
      };
      return nextSchedules;
    }
    default:
      return args.schedules;
  }
}

export function applyScheduleProjectionEventSync(args: {
  ctx: DurableObjectState;
  event: Event;
}): void {
  applyScheduleProjectionEventFromPayloadSync({
    createdAt: args.event.createdAt,
    ctx: args.ctx,
    payload: JSON.stringify(args.event.payload),
    type: args.event.type,
  });
}

export function hydrateScheduleProjectionIfNeeded(args: {
  ctx: DurableObjectState;
  reducedState: ReducedStreamState;
}): void {
  const scheduleCount =
    args.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM cf_agents_schedules")
      .one()?.count ?? 0;

  if (scheduleCount > 0) {
    return;
  }

  hydrateScheduleProjectionFromStateSync(args.ctx, args.reducedState.cf_agents_schedules);
}

export async function scheduleNextAlarmFromTable(ctx: DurableObjectState): Promise<void> {
  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  const hungCutoffSeconds = nowSeconds - HUNG_INTERVAL_TIMEOUT_SECONDS;

  const readySchedule = ctx.storage.sql
    .exec<{ time: number }>(
      `SELECT time
       FROM cf_agents_schedules
       WHERE type != 'interval'
          OR running = 0
          OR coalesce(execution_started_at, 0) <= ?
       ORDER BY time ASC
       LIMIT 1`,
      hungCutoffSeconds,
    )
    .next().value;

  const recoveringInterval = ctx.storage.sql
    .exec<{ execution_started_at: number | null }>(
      `SELECT execution_started_at
       FROM cf_agents_schedules
       WHERE type = 'interval'
         AND running = 1
         AND coalesce(execution_started_at, 0) > ?
       ORDER BY execution_started_at ASC
       LIMIT 1`,
      hungCutoffSeconds,
    )
    .next().value;

  let nextTimeMs: number | null = null;
  if (readySchedule?.time != null) {
    nextTimeMs = Math.max(readySchedule.time * 1000, nowMs + 1);
  }

  if (recoveringInterval?.execution_started_at != null) {
    const recoveryTimeMs =
      (recoveringInterval.execution_started_at + HUNG_INTERVAL_TIMEOUT_SECONDS) * 1000;
    nextTimeMs = nextTimeMs == null ? recoveryTimeMs : Math.min(nextTimeMs, recoveryTimeMs);
  }

  if (nextTimeMs == null) {
    await ctx.storage.deleteAlarm();
    return;
  }

  await ctx.storage.setAlarm(nextTimeMs);
}

function getExistingScheduleRow(ctx: DurableObjectState, args: ScheduleLookupArgs) {
  const clauses = ["type = ?", "callback = ?", "payload IS ?"];
  const params: Array<string | number | null> = [args.type, args.callback, args.payloadJson];

  if (args.cron != null) {
    clauses.push("cron = ?");
    params.push(args.cron);
  }

  if (args.intervalSeconds != null) {
    clauses.push("intervalSeconds = ?");
    params.push(args.intervalSeconds);
  }

  return ctx.storage.sql
    .exec<ScheduleRow>(
      `SELECT id, callback, payload, type, time, delayInSeconds, cron, intervalSeconds,
              running, execution_started_at, retry_options, created_at
       FROM cf_agents_schedules
       WHERE ${clauses.join(" AND ")}
       LIMIT 1`,
      ...params,
    )
    .next().value;
}

function getLatestScheduleIdFor(ctx: DurableObjectState, args: ScheduleLookupArgs) {
  const row = getExistingScheduleRow(ctx, args);
  return row?.id;
}

function applyScheduleProjectionEventFromPayloadSync(args: {
  createdAt: string;
  ctx: DurableObjectState;
  payload: string;
  type: string;
}) {
  switch (args.type) {
    case SCHEDULE_ADDED_TYPE: {
      const payload = ScheduleAddedPayload.parse(JSON.parse(args.payload));
      args.ctx.storage.sql.exec(
        `INSERT INTO cf_agents_schedules (
           id, callback, payload, type, time, delayInSeconds, cron, intervalSeconds,
           running, execution_started_at, retry_options, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?)
         ON CONFLICT(id) DO UPDATE SET
           callback = excluded.callback,
           payload = excluded.payload,
           type = excluded.type,
           time = excluded.time,
           delayInSeconds = excluded.delayInSeconds,
           cron = excluded.cron,
           intervalSeconds = excluded.intervalSeconds,
           running = 0,
           execution_started_at = NULL`,
        payload.scheduleId,
        payload.callback,
        payload.payloadJson ?? null,
        payload.scheduleType,
        payload.time,
        payload.delayInSeconds ?? null,
        payload.cron ?? null,
        payload.intervalSeconds ?? null,
        Math.floor(new Date(args.createdAt).getTime() / 1000),
      );
      return;
    }
    case SCHEDULE_CANCELLED_TYPE: {
      const payload = ScheduleCancelledPayload.parse(JSON.parse(args.payload));
      args.ctx.storage.sql.exec(`DELETE FROM cf_agents_schedules WHERE id = ?`, payload.scheduleId);
      return;
    }
    case SCHEDULE_EXECUTION_STARTED_TYPE: {
      const payload = ScheduleExecutionStartedPayload.parse(JSON.parse(args.payload));
      args.ctx.storage.sql.exec(
        `UPDATE cf_agents_schedules
         SET running = 1, execution_started_at = ?
         WHERE id = ?`,
        payload.startedAt,
        payload.scheduleId,
      );
      return;
    }
    case SCHEDULE_EXECUTION_FINISHED_TYPE: {
      const payload = ScheduleExecutionFinishedPayload.parse(JSON.parse(args.payload));
      if (payload.nextTime == null) {
        args.ctx.storage.sql.exec(
          `DELETE FROM cf_agents_schedules WHERE id = ?`,
          payload.scheduleId,
        );
        return;
      }

      args.ctx.storage.sql.exec(
        `UPDATE cf_agents_schedules
         SET time = ?, running = 0, execution_started_at = NULL
         WHERE id = ?`,
        payload.nextTime,
        payload.scheduleId,
      );
      return;
    }
    default:
      return;
  }
}

function hydrateScheduleProjectionFromStateSync(
  ctx: DurableObjectState,
  schedules: ScheduleProjectionState,
) {
  ctx.storage.sql.exec("DELETE FROM cf_agents_schedules");
  for (const schedule of Object.values(schedules)) {
    ctx.storage.sql.exec(
      `INSERT INTO cf_agents_schedules (
         id, callback, payload, type, time, delayInSeconds, cron, intervalSeconds,
         running, execution_started_at, retry_options, created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      schedule.id,
      schedule.callback,
      schedule.payload,
      schedule.type,
      schedule.time,
      schedule.delayInSeconds,
      schedule.cron,
      schedule.intervalSeconds,
      schedule.running,
      schedule.execution_started_at,
      schedule.retry_options,
      schedule.created_at,
    );
  }
}

function createScheduleId() {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 16);
}

function getNextCronTime(cron: string) {
  return parseCronExpression(cron).getNextDate();
}

function getNextExecutionTime(row: ScheduleRow) {
  switch (row.type) {
    case "cron":
      return Math.floor(getNextCronTime(row.cron ?? "").getTime() / 1000);
    case "interval": {
      const intervalSeconds = row.intervalSeconds;
      return intervalSeconds == null ? null : Math.floor(Date.now() / 1000) + intervalSeconds;
    }
    default:
      return null;
  }
}

function getSafeFailedNextTime(args: { now: number; row: ScheduleRow }) {
  switch (args.row.type) {
    case "interval":
      return args.row.intervalSeconds == null ? null : args.now + args.row.intervalSeconds;
    case "cron": {
      if (args.row.cron == null) {
        return null;
      }

      try {
        return Math.floor(getNextCronTime(args.row.cron).getTime() / 1000);
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}

async function appendScheduleExecutionFinished(args: {
  append: SchedulingAlarmDeps["append"];
  nextTime: number | null;
  outcome: "succeeded" | "failed";
  scheduleId: string;
}) {
  await args.append({
    type: SCHEDULE_EXECUTION_FINISHED_TYPE,
    payload: {
      scheduleId: args.scheduleId,
      outcome: args.outcome,
      nextTime: args.nextTime,
    },
  });
}
