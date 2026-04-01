import { parseCronExpression } from "cron-schedule";
import { z } from "zod";
import type {
  PublicStreamState,
  ReducedStreamState,
  Schedule,
  ScheduleCriteria,
  ScheduleLookupArgs,
  ScheduleProjectionState,
  SchedulingAlarmDeps,
  SchedulingMutationDeps,
} from "~/durable-objects/scheduling-types.ts";
import {
  DUPLICATE_SCHEDULE_THRESHOLD,
  Event,
  HUNG_INTERVAL_TIMEOUT_SECONDS,
  MAX_INTERVAL_SECONDS,
  ReducedStreamState as ReducedStreamStateSchema,
  SCHEDULE_ADDED_TYPE,
  SCHEDULE_CANCELLED_TYPE,
  SCHEDULE_EXECUTION_FINISHED_TYPE,
  SCHEDULE_EXECUTION_STARTED_TYPE,
  ScheduleAddedPayload,
  ScheduleCancelledPayload,
  ScheduleExecutionFinishedPayload,
  ScheduleExecutionStartedPayload,
  ScheduleRow,
  StreamPath,
} from "~/durable-objects/scheduling-types.ts";

/**
 * Scheduling semantics are intentionally kept close to Cloudflare Agents SDK:
 * - schedule / scheduleEvery / getSchedule / getSchedules / cancelSchedule
 * - _scheduleNextAlarm()
 * - alarm()
 *
 * Upstream references:
 * - https://github.com/cloudflare/agents/blob/main/packages/agents/src/index.ts
 * - https://github.com/cloudflare/agents/blob/main/packages/agents/src/tests/schedule.test.ts
 * - https://github.com/cloudflare/agents/blob/main/packages/agents/src/tests/agents/schedule.ts
 * - https://developers.cloudflare.com/durable-objects/api/alarms/
 *
 * Events-specific deltas we intentionally keep here, not in `stream.ts`:
 * - schedule mutations append internal stream events instead of mutating rows directly
 * - reduced_state carries `cf_agents_schedules` as the durable snapshot
 * - `cf_agents_schedules` stays as a derived SQL table because the single DO alarm
 *   needs efficient `MIN(time)` / `WHERE time <= now` queries and the copied tests
 *   inspect those rows directly
 * - we do not implement Agents SDK-specific retry options, keepAlive heartbeat,
 *   PartyServer initialization, or observability hooks in this worker
 *
 * When upstream scheduling changes, start by diffing the links above, then update:
 * 1. the public helpers in this file
 * 2. `reduceSchedulingState()` and `applyScheduleProjectionEventSync()` together
 * 3. the copied suite in `scheduling.test.ts`
 *
 * `scheduleOnStream()` below is the direct port of upstream `Agent.schedule()`.
 *
 * Local delta: schedule lifecycle changes are recorded as internal stream
 * events first, then mirrored into `cf_agents_schedules`.
 */
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
      events: [
        {
          path: deps.requireStreamPath(),
          type: SCHEDULE_ADDED_TYPE,
          payload: addedPayload,
        },
      ],
    });
  }

  await scheduleNextAlarmFromTable(deps.ctx);

  const schedule = getScheduleFromStorage(deps.ctx, addedPayload.scheduleId);
  if (schedule == null) {
    throw new Error(`Expected schedule ${addedPayload.scheduleId} to exist after scheduling.`);
  }

  return schedule;
}

/**
 * Derived from upstream `Agent.scheduleEvery()` and keeps the same idempotency
 * semantics and `_idempotent` option spelling so upstream diffs stay easy to
 * apply and the copied tests remain a real parity check.
 */
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
      events: [
        {
          path: deps.requireStreamPath(),
          type: SCHEDULE_ADDED_TYPE,
          payload: {
            scheduleId: createScheduleId(),
            callback: callbackName,
            payloadJson,
            scheduleType: "interval",
            time: Math.floor(Date.now() / 1000) + Math.floor(intervalSeconds),
            intervalSeconds,
          },
        },
      ],
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
  append(args: {
    events: Array<{ path: StreamPath; payload: { scheduleId: string }; type: string }>;
  }): Promise<unknown>;
  id: string;
  requireStreamPath(): StreamPath;
}): Promise<boolean> {
  if (getScheduleFromStorage(args.ctx, args.id) == null) {
    return false;
  }

  await args.append({
    events: [
      {
        path: args.requireStreamPath(),
        type: SCHEDULE_CANCELLED_TYPE,
        payload: {
          scheduleId: args.id,
        },
      },
    ],
  });

  await scheduleNextAlarmFromTable(args.ctx);
  return true;
}

/**
 * Derived from upstream `Agent.alarm()`.
 *
 * Integration invariant: this function may read due work from the SQL
 * projection, but any schedule state transition must be recorded through
 * `append()` so reduced_state and `cf_agents_schedules` keep moving together.
 */
export async function runScheduleAlarm(args: SchedulingAlarmDeps): Promise<void> {
  // This keeps the same "query all overdue rows, execute them, then re-point the
  // single DO alarm" shape as Agents SDK `alarm()`. The main deliberate delta is
  // that execution bookkeeping is appended as stream events, and those events
  // update both reduced_state and the derived SQL table in lockstep.
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
      console.error(`[stream-do] schedule callback not found`, {
        callback: row.callback,
        scheduleId: row.id,
      });
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

    if (row.type === "interval") {
      await args.append({
        events: [
          {
            path: args.requireStreamPath(),
            type: SCHEDULE_EXECUTION_STARTED_TYPE,
            payload: {
              scheduleId: row.id,
              startedAt: now,
            },
          },
        ],
      });
    }

    let outcome: "succeeded" | "failed" = "succeeded";
    try {
      await callback.call(
        args.instance,
        deserializeSchedulePayload(row.payload),
        rowToSchedule(row),
      );
    } catch (error) {
      outcome = "failed";
      console.error(`[stream-do] error executing callback "${row.callback}"`, error);
    }

    const nextTime =
      row.type === "cron"
        ? Math.floor(getNextCronTime(row.cron ?? "").getTime() / 1000)
        : row.type === "interval"
          ? Math.floor(Date.now() / 1000) + (row.intervalSeconds ?? 0)
          : null;

    await args.append({
      events: [
        {
          path: args.requireStreamPath(),
          type: SCHEDULE_EXECUTION_FINISHED_TYPE,
          payload: {
            scheduleId: row.id,
            outcome,
            nextTime,
          },
        },
      ],
    });
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
  // This is the authoritative in-memory / reduced_state projection for
  // scheduling. `applyScheduleProjectionEventSync()` must stay behaviorally
  // equivalent because the SQL table is only a query-optimized mirror.
  const nextSchedules = { ...args.schedules };

  switch (args.event.type) {
    case SCHEDULE_ADDED_TYPE: {
      const payload = ScheduleAddedPayload.parse(args.event.payload);
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
      delete nextSchedules[payload.scheduleId];
      return nextSchedules;
    }
    case SCHEDULE_EXECUTION_STARTED_TYPE: {
      const payload = ScheduleExecutionStartedPayload.parse(args.event.payload);
      const schedule = nextSchedules[payload.scheduleId];
      if (schedule == null) {
        return nextSchedules;
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
      const schedule = nextSchedules[payload.scheduleId];
      if (schedule == null) {
        return nextSchedules;
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
      return nextSchedules;
  }
}

export function applyScheduleProjectionEventSync(args: {
  ctx: DurableObjectState;
  event: Event;
}): void {
  // Keep the query-friendly SQL mirror in sync inside the same transaction that
  // appends the event and persists reduced_state. If you change one of the
  // schedule control event semantics, update this function and
  // `reduceSchedulingState()` together.
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
  // `cf_agents_schedules` is now part of reduced_state, so cold-start hydration
  // rebuilds the query-friendly SQL table from that snapshot instead of replaying
  // all historical schedule control events. If this table ever changes shape,
  // update both this hydrator and `readScheduleProjectionStateFromTable()`.
  const scheduleCount =
    args.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM cf_agents_schedules")
      .one()?.count ?? 0;

  if (scheduleCount > 0) {
    return;
  }

  hydrateScheduleProjectionFromStateSync(args.ctx, args.reducedState.cf_agents_schedules);
}

export function hydrateReducedStreamState(args: {
  persistedStateJson: string;
  ctx: DurableObjectState;
}): ReducedStreamState {
  const rawState = JSON.parse(args.persistedStateJson);
  const parsedReducedState = ReducedStreamStateSchema.safeParse(rawState);
  if (parsedReducedState.success) {
    return parsedReducedState.data;
  }

  // Backward-compat path for reduced_state rows written before
  // `cf_agents_schedules` became part of the snapshot. We recover from the
  // existing SQL table rather than replaying the full event log here.
  const parsedPublicState = ReducedStreamStateSchema.omit({
    cf_agents_schedules: true,
  }).parse(rawState);

  return {
    ...parsedPublicState,
    cf_agents_schedules: readScheduleProjectionStateFromTable(args.ctx),
  };
}

export function projectPublicStreamState(state: ReducedStreamState): PublicStreamState {
  return {
    path: state.path,
    lastOffset: state.lastOffset,
    eventCount: state.eventCount,
    metadata: state.metadata,
  };
}

export function readScheduleProjectionStateFromTable(
  ctx: DurableObjectState,
): ScheduleProjectionState {
  const rows = ctx.storage.sql
    .exec<ScheduleRow>(
      `SELECT id, callback, payload, type, time, delayInSeconds, cron, intervalSeconds,
              running, execution_started_at, retry_options, created_at
       FROM cf_agents_schedules`,
    )
    .toArray();

  return Object.fromEntries(rows.map((row: ScheduleRow) => [row.id, ScheduleRow.parse(row)]));
}

export async function scheduleNextAlarmFromTable(ctx: DurableObjectState): Promise<void> {
  // Directly derived from Agents SDK `_scheduleNextAlarm()`: derive the single
  // DO alarm from the earliest executable schedule row, plus a recovery wake-up
  // for interval rows that are still marked running but have not crossed the
  // hung threshold yet.
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

// Test-only scaffolding derived from
// `packages/agents/src/tests/agents/schedule.ts`. We keep it here because the
// copied suite depends on the same helpers, but production scheduling logic
// intentionally stays above this section.
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
  // Test-only cast that lets the copied upstream helper classes talk to the
  // minimal scheduling surface without pushing that helper-only shape into the
  // production DO API.
  return value as unknown as SchedulingTestSurface;
}

/**
 * Build the upstream-derived scheduling test durable objects against our
 * `StreamDurableObject` surface. If the Agents SDK test helper changes, diff it
 * against this factory and keep the names/behaviors aligned unless we have a
 * documented events-specific reason to diverge.
 */
export function createSchedulingTestDurableObjects<TBase extends new (...args: any[]) => object>(
  Base: TBase,
) {
  // The test harness below is a direct port of the Agents SDK schedule test
  // agents. Keep helper names and semantics aligned with upstream so the copied
  // test suite stays easy to diff. If upstream adds new schedule tests, update
  // this harness first and only then adjust the copied test file.
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

function rowToSchedule(row: ScheduleRow): Schedule {
  const base = {
    id: row.id,
    callback: row.callback,
    payload: deserializeSchedulePayload(row.payload),
    time: row.time,
    created_at: row.created_at,
  };

  switch (row.type) {
    case "scheduled":
      return {
        ...base,
        type: "scheduled",
      };
    case "delayed":
      return {
        ...base,
        type: "delayed",
        delayInSeconds: row.delayInSeconds ?? undefined,
      };
    case "cron":
      return {
        ...base,
        type: "cron",
        cron: row.cron ?? undefined,
      };
    case "interval":
      return {
        ...base,
        type: "interval",
        intervalSeconds: row.intervalSeconds ?? undefined,
      };
    default:
      throw new Error(`Unsupported schedule type ${String(row.type)}`);
  }
}

function createScheduleId() {
  return crypto.randomUUID().slice(0, 9);
}

function serializeSchedulePayload(payload: unknown) {
  return payload === undefined ? null : JSON.stringify(payload);
}

function deserializeSchedulePayload(payload: string | null) {
  return payload == null ? undefined : JSON.parse(payload);
}

function getNextCronTime(cron: string) {
  return parseCronExpression(cron).getNextDate();
}
