/// <reference types="@cloudflare/workers-types" />

import { Cron } from "croner";
import { rrulestr } from "rrule";
import type {
  LifecycleHooksMembers,
  LifecycleHooksProtected,
  LifecycleInit,
} from "./with-lifecycle-hooks.ts";
import type {
  MultiplexedAlarmsProtected,
  MultiplexedAlarmsMembers,
} from "./with-multiplexed-alarms.ts";
import { stringifyJsonPayload } from "./json-payload.ts";
import type {
  Constructor,
  DurableObjectClass,
  DurableObjectConstructor,
  MembersOf,
  ReqEnvOf,
  StaticSide,
} from "./mixin-types.ts";
import type { DurableObjectCoreProtected } from "./with-durable-object-core.ts";

const SCHEDULER_TABLE = "mixin_scheduler_schedules";
const DEFAULT_HUNG_SCHEDULE_TIMEOUT_MS = 30_000;

export type SchedulerRecurrence =
  | {
      type: "once";
      runAt: Date | number;
    }
  | {
      type: "delayed";
      delayMs: number;
    }
  | {
      type: "interval";
      everyMs: number;
    }
  | {
      type: "cron";
      expression: string;
      /**
       * Omit for UTC. Provide an IANA timezone only when the schedule should
       * follow local civil time, including DST changes.
       */
      timezone?: string;
    }
  | {
      type: "rrule";
      rrule: string;
      /**
       * Omit for UTC. RRULE timezone support depends on the Worker runtime's
       * Intl implementation, which Cloudflare Workers provide.
       */
      timezone?: string;
      /**
       * Defaults to the time schedule() is called. Use this when an RRULE has
       * COUNT/UNTIL semantics that need a stable beginning.
       */
      dtstart?: Date | number;
    };

export type StoredSchedulerRecurrence =
  | {
      type: "once";
      runAtMs: number;
    }
  | {
      type: "delayed";
      delayMs: number;
    }
  | {
      type: "interval";
      everyMs: number;
    }
  | {
      type: "cron";
      expression: string;
      timezone: string | null;
    }
  | {
      type: "rrule";
      rrule: string;
      timezone: string | null;
      dtstartMs: number;
    };

export type ScheduleInput = {
  /**
   * Stable idempotency key. Reusing a key replaces the existing schedule.
   *
   * This is intentionally stricter than Cloudflare Agents, where one-shot
   * schedule() calls can create duplicates unless idempotency is requested.
   */
  key: string;
  /**
   * Instance method to call when the schedule is due.
   *
   * The method may be protected. It is checked at schedule time and again at
   * dispatch time so persisted rows fail loudly after deploys that rename or
   * remove callbacks.
   */
  method: string;
  /**
   * Plain JSON-style callback payload.
   *
   * Store IDs and small config here, not clients, handles, functions, sockets,
   * Maps, class instances, or anything else that cannot survive JSON text
   * persistence. JSON.stringify catches some failures, but not every value that
   * would round-trip poorly.
   */
  payload?: unknown;
  /**
   * Explicit recurrence tag. Numeric fields are milliseconds, unlike Cloudflare
   * Agents' public schedule API where a bare number means seconds.
   * https://developers.cloudflare.com/agents/api-reference/schedule-tasks/
   */
  recurrence: SchedulerRecurrence;
};

export type SchedulerRecord = {
  key: string;
  method: string;
  payload: unknown;
  recurrence: StoredSchedulerRecurrence;
  nextRunAt: string;
  running: boolean;
  executionStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SchedulerMembers = {
  getSchedule(key: string): SchedulerRecord | null;
  getSchedules(criteria?: { type?: StoredSchedulerRecurrence["type"] }): SchedulerRecord[];
};

/**
 * Type-only protected scheduler surface.
 *
 * Mutation is protected for the same reason `scheduleMultiplexedAlarm()` is
 * protected: a Durable Object public method is also an RPC method. App classes
 * should expose domain-specific public methods instead of giving every caller
 * direct access to the schedule table.
 */
export abstract class SchedulerProtected {
  protected schedule(_input: ScheduleInput): Promise<SchedulerRecord> {
    throw new Error("SchedulerProtected is type-only and should never run.");
  }

  protected cancelSchedule(_key: string): Promise<boolean> {
    throw new Error("SchedulerProtected is type-only and should never run.");
  }
}

type WithSchedulerResult<TBase extends DurableObjectClass> =
  // Preserve the wrapped generic class value so this remains legal:
  //
  //   const Base = withScheduler<Init>()(withMultiplexedAlarms<Init>()(...));
  //   class Room extends Base<Env> {}
  StaticSide<TBase> &
    DurableObjectClass<ReqEnvOf<TBase>, MembersOf<TBase> & SchedulerMembers & SchedulerProtected> &
    Constructor<SchedulerMembers> &
    Constructor<SchedulerProtected>;

type SchedulerRow = {
  key: string;
  method: string;
  payload_json: string;
  recurrence_json: string;
  next_run_at_ms: number;
  running: number;
  execution_started_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
};

type SchedulerAlarmPayload = {
  key: string;
  expectedRunAtMs: number;
};

export class SchedulerPayloadSerializationError extends Error {
  constructor(cause: unknown) {
    super(
      `Scheduled task payload must be JSON-serializable: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "SchedulerPayloadSerializationError";
  }
}

export class MissingSchedulerMethodError extends Error {
  constructor(key: string, method: string) {
    super(`Schedule "${key}" targets missing method "${method}".`);
    this.name = "MissingSchedulerMethodError";
  }
}

export class NoNextScheduleOccurrenceError extends Error {
  constructor(key: string) {
    super(`Schedule "${key}" has no next occurrence.`);
    this.name = "NoNextScheduleOccurrenceError";
  }
}

/**
 * Adds a small persisted scheduler on top of `withMultiplexedAlarms()`.
 *
 * `withMultiplexedAlarms()` owns Cloudflare's single platform alarm slot.
 * This mixin owns higher-level schedule metadata: one-shot runs, delayed runs,
 * intervals, cron expressions, and RRULE expressions. Every schedule row is
 * projected into one underlying multiplexed alarm whose payload points back to
 * the schedule key.
 *
 * Schedules are also the intended low-level primitive for runtime maintenance
 * loops, such as "periodically ensure my Discord socket is connected". The
 * scheduler only provides durable wakeups. The concrete Durable Object must
 * persist the desired state and make the scheduled method idempotently rebuild
 * any in-memory state from storage and env. Do not add a second durable
 * `enableKeepAlive({ key, method, everyMs })` API for that shape; it would be
 * another scheduler with a less precise name.
 */
export function withScheduler<InitParams extends LifecycleInit>(options?: {
  /**
   * Overlap recovery threshold for recurring schedules.
   *
   * This is an option because expected callback duration is app-specific. Leave
   * unset unless the app has a clearer stale-running threshold than the default.
   */
  hungScheduleTimeoutMs?: number;
}) {
  return function <TBase extends DurableObjectClass>(
    Base: TBase &
      Constructor<
        DurableObjectCoreProtected &
          LifecycleHooksMembers<InitParams> &
          LifecycleHooksProtected<InitParams> &
          MultiplexedAlarmsMembers &
          MultiplexedAlarmsProtected
      >,
  ): WithSchedulerResult<TBase> {
    const BaseWithCapabilities = Base as unknown as DurableObjectConstructor<
      unknown,
      DurableObjectCoreProtected &
        LifecycleHooksMembers<InitParams> &
        LifecycleHooksProtected<InitParams> &
        MultiplexedAlarmsMembers &
        MultiplexedAlarmsProtected
    >;

    abstract class SchedulerMixin extends BaseWithCapabilities implements SchedulerMembers {
      readonly #hungScheduleTimeoutMs =
        options?.hungScheduleTimeoutMs ?? DEFAULT_HUNG_SCHEDULE_TIMEOUT_MS;

      constructor(...args: any[]) {
        super(...args);

        // Local SQLite only. This table stores schedule metadata; the actual
        // wakeup row lives in `mixin_multiplexed_alarms`.
        this.getDurableObjectSql().exec(`CREATE TABLE IF NOT EXISTS ${SCHEDULER_TABLE} (
          key TEXT PRIMARY KEY,
          method TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          recurrence_json TEXT NOT NULL,
          next_run_at_ms INTEGER NOT NULL,
          running INTEGER NOT NULL DEFAULT 0,
          execution_started_at_ms INTEGER,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        )`);
        this.getDurableObjectSql()
          .exec(`CREATE INDEX IF NOT EXISTS mixin_scheduler_schedules_next_run_at
          ON ${SCHEDULER_TABLE} (next_run_at_ms)`);

        this.registerOnStart(() => this.armSchedulerRows());
      }

      getSchedule(key: string): SchedulerRecord | null {
        const row = this.getDurableObjectSql()
          .exec<SchedulerRow>(
            `SELECT key, method, payload_json, recurrence_json, next_run_at_ms,
                    running, execution_started_at_ms, created_at_ms, updated_at_ms
             FROM ${SCHEDULER_TABLE}
             WHERE key = ?
             LIMIT 1`,
            key,
          )
          .toArray()[0];

        return row === undefined ? null : schedulerRowToRecord(row);
      }

      getSchedules(criteria: { type?: StoredSchedulerRecurrence["type"] } = {}): SchedulerRecord[] {
        return this.getDurableObjectSql()
          .exec<SchedulerRow>(
            `SELECT key, method, payload_json, recurrence_json, next_run_at_ms,
                    running, execution_started_at_ms, created_at_ms, updated_at_ms
             FROM ${SCHEDULER_TABLE}
             ORDER BY next_run_at_ms ASC, key ASC`,
          )
          .toArray()
          .map(schedulerRowToRecord)
          .filter(
            (record) => criteria.type === undefined || record.recurrence.type === criteria.type,
          );
      }

      protected async schedule(input: ScheduleInput): Promise<SchedulerRecord> {
        await this.ensureStarted();

        if (!input.key) {
          throw new Error("schedule(input) requires a non-empty key.");
        }

        this.getSchedulerMethod(input.key, input.method);

        const nowMs = Date.now();
        const recurrence = normalizeRecurrence(input.recurrence, nowMs);
        // Initial RRULE scheduling is inclusive because `dtstart` is itself an
        // occurrence. Without this, `FREQ=DAILY;COUNT=1` with the default
        // dtstart would ask for the first occurrence strictly after dtstart,
        // find none, and fail before the schedule is ever stored.
        const nextRunAtMs = computeNextRunAtMs(input.key, recurrence, nowMs, {
          includeAfter: true,
        });
        const existing = this.getSchedulerRow(input.key);
        const payloadJson = stringifySchedulerPayload(input.payload);
        const recurrenceJson = JSON.stringify(recurrence);

        if (existing !== undefined) {
          await this.cancelMultiplexedAlarm(
            schedulerAlarmKey(existing.key, existing.next_run_at_ms),
          );
        }

        this.getDurableObjectSql().exec(
          `INSERT INTO ${SCHEDULER_TABLE}
            (key, method, payload_json, recurrence_json, next_run_at_ms, running,
             execution_started_at_ms, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             method = excluded.method,
             payload_json = excluded.payload_json,
             recurrence_json = excluded.recurrence_json,
             next_run_at_ms = excluded.next_run_at_ms,
             running = 0,
             execution_started_at_ms = NULL,
             updated_at_ms = excluded.updated_at_ms`,
          input.key,
          input.method,
          payloadJson,
          recurrenceJson,
          nextRunAtMs,
          nowMs,
          nowMs,
        );

        await this.scheduleMultiplexedAlarm({
          key: schedulerAlarmKey(input.key, nextRunAtMs),
          runAt: nextRunAtMs,
          method: "runScheduledTask",
          payload: {
            key: input.key,
            expectedRunAtMs: nextRunAtMs,
          } satisfies SchedulerAlarmPayload,
        });

        const row = this.getSchedulerRow(input.key);

        if (row === undefined) {
          throw new Error(`Schedule "${input.key}" was not stored.`);
        }

        return schedulerRowToRecord(row);
      }

      protected async cancelSchedule(key: string): Promise<boolean> {
        await this.ensureStarted();

        const existing = this.getSchedulerRow(key);

        if (existing === undefined) {
          return false;
        }

        this.getDurableObjectSql().exec(`DELETE FROM ${SCHEDULER_TABLE} WHERE key = ?`, key);
        await this.cancelMultiplexedAlarm(schedulerAlarmKey(existing.key, existing.next_run_at_ms));

        return true;
      }

      protected async runScheduledTask(payload: unknown): Promise<void> {
        const alarmPayload = parseSchedulerAlarmPayload(payload);
        const row = this.getSchedulerRow(alarmPayload.key);

        if (row === undefined || row.next_run_at_ms !== alarmPayload.expectedRunAtMs) {
          return;
        }

        const recurrence = parseStoredRecurrence(row.recurrence_json);
        const isRecurring = isRecurringRecurrence(recurrence);

        if (isRecurring && row.running === 1) {
          const startedAtMs = row.execution_started_at_ms ?? 0;
          const elapsedMs = Date.now() - startedAtMs;

          if (elapsedMs < this.#hungScheduleTimeoutMs) {
            console.warn(
              `[withScheduler] skipping overlapping schedule "${row.key}" because the previous run is still marked running.`,
            );
            await this.skipOverlappingRecurringSchedule(row);
            return;
          }

          console.warn(
            `[withScheduler] schedule "${row.key}" appears hung; retrying after ${elapsedMs}ms.`,
          );
        }

        if (isRecurring) {
          this.getDurableObjectSql().exec(
            `UPDATE ${SCHEDULER_TABLE}
             SET running = 1, execution_started_at_ms = ?
             WHERE key = ?`,
            Date.now(),
            row.key,
          );
        }

        const method = this.getSchedulerMethod(row.key, row.method);
        const methodPayload = JSON.parse(row.payload_json) as unknown;

        try {
          await method.call(this, methodPayload, schedulerRowToRecord(row));
        } catch (error) {
          console.error(`[withScheduler] scheduled task "${row.key}" failed`, error);

          if (isRecurring) {
            await this.advanceRecurringSchedule(row, recurrence);
            return;
          }

          throw error;
        }

        if (isRecurring) {
          await this.advanceRecurringSchedule(row, recurrence);
          return;
        }

        // The callback can await and may replace this schedule key while it is
        // running. That is a normal pattern for idempotent domain APIs: "run this
        // one-shot now, then schedule the next one under the same stable key".
        //
        // Deleting by key alone would erase the replacement row after the old
        // callback completes. Match the exact row snapshot instead. If anything
        // about the row changed during the await, this delete affects zero rows
        // and the newer schedule remains intact.
        this.getDurableObjectSql().exec(
          `DELETE FROM ${SCHEDULER_TABLE}
           WHERE key = ?
             AND method = ?
             AND payload_json = ?
             AND recurrence_json = ?
             AND next_run_at_ms = ?
             AND updated_at_ms = ?`,
          row.key,
          row.method,
          row.payload_json,
          row.recurrence_json,
          row.next_run_at_ms,
          row.updated_at_ms,
        );
      }

      private getSchedulerRow(key: string): SchedulerRow | undefined {
        return this.getDurableObjectSql()
          .exec<SchedulerRow>(
            `SELECT key, method, payload_json, recurrence_json, next_run_at_ms,
                    running, execution_started_at_ms, created_at_ms, updated_at_ms
             FROM ${SCHEDULER_TABLE}
             WHERE key = ?
             LIMIT 1`,
            key,
          )
          .toArray()[0];
      }

      private getSchedulerMethod(
        key: string,
        method: string,
      ): (payload: unknown, schedule: SchedulerRecord) => void | Promise<void> {
        const target = Reflect.get(this, method);

        if (typeof target !== "function") {
          console.error("[withScheduler] missing schedule method", { key, method });
          throw new MissingSchedulerMethodError(key, method);
        }

        return target as (payload: unknown, schedule: SchedulerRecord) => void | Promise<void>;
      }

      private async advanceRecurringSchedule(
        row: SchedulerRow,
        recurrence: StoredSchedulerRecurrence,
      ): Promise<void> {
        let nextRunAtMs: number;

        try {
          nextRunAtMs = computeNextRunAtMs(row.key, recurrence, Date.now());
        } catch (error) {
          if (!(error instanceof NoNextScheduleOccurrenceError)) {
            throw error;
          }

          // Finite RRULEs can be complete after the callback for their final
          // occurrence runs. That is a successful terminal state, not an alarm
          // failure: throwing here would make Cloudflare retry the already-due
          // multiplexed alarm forever.
          //
          // The callback may also have replaced this schedule key while it was
          // running. In that case the replacement row is the new source of truth
          // and already has its own backing multiplexed alarm. Match the exact
          // row snapshot we started from so final-occurrence cleanup only deletes
          // the old row, never the replacement.
          const deleteCursor = this.getDurableObjectSql().exec(
            `DELETE FROM ${SCHEDULER_TABLE}
             WHERE key = ?
               AND method = ?
               AND payload_json = ?
               AND recurrence_json = ?
               AND next_run_at_ms = ?
               AND updated_at_ms = ?`,
            row.key,
            row.method,
            row.payload_json,
            row.recurrence_json,
            row.next_run_at_ms,
            row.updated_at_ms,
          );

          if (deleteCursor.rowsWritten > 0) {
            console.info(
              `[withScheduler] completed finite schedule "${row.key}" with no next occurrence.`,
            );
          }

          return;
        }

        const nowMs = Date.now();

        // Recurring callbacks are allowed to replace their own schedule by
        // calling `this.schedule({ key: sameKey, ... })`. That is useful when a
        // domain API wants to say "run on an interval until condition X, then
        // switch to a different cadence". If we updated by key only, the stale
        // pre-callback recurrence would overwrite the replacement's next run.
        // Match the exact row snapshot instead; zero rows written means the
        // callback deliberately changed the schedule and the replacement has
        // already armed its own multiplexed alarm.
        const updateCursor = this.getDurableObjectSql().exec(
          `UPDATE ${SCHEDULER_TABLE}
           SET next_run_at_ms = ?, running = 0, execution_started_at_ms = NULL, updated_at_ms = ?
           WHERE key = ?
             AND method = ?
             AND payload_json = ?
             AND recurrence_json = ?
             AND next_run_at_ms = ?
             AND updated_at_ms = ?`,
          nextRunAtMs,
          nowMs,
          row.key,
          row.method,
          row.payload_json,
          row.recurrence_json,
          row.next_run_at_ms,
          row.updated_at_ms,
        );

        if (updateCursor.rowsWritten === 0) {
          return;
        }

        await this.scheduleMultiplexedAlarm({
          key: schedulerAlarmKey(row.key, nextRunAtMs),
          runAt: nextRunAtMs,
          method: "runScheduledTask",
          payload: {
            key: row.key,
            expectedRunAtMs: nextRunAtMs,
          } satisfies SchedulerAlarmPayload,
        });
      }

      private async skipOverlappingRecurringSchedule(row: SchedulerRow): Promise<void> {
        const startedAtMs = row.execution_started_at_ms ?? Date.now();
        const nextRunAtMs = startedAtMs + this.#hungScheduleTimeoutMs;
        const nowMs = Date.now();

        // Keep running=1 because the previous invocation may genuinely still be
        // working. This is not a recurrence advance; it is a recovery checkpoint.
        //
        // Scheduling at the next cron/interval occurrence would make hung
        // recovery depend on the recurrence cadence. A daily schedule would wait
        // a day to notice that a 30-second timeout expired. The checkpoint keeps
        // overlap prevention and hung recovery separate.
        this.getDurableObjectSql().exec(
          `UPDATE ${SCHEDULER_TABLE}
           SET next_run_at_ms = ?, updated_at_ms = ?
           WHERE key = ?`,
          nextRunAtMs,
          nowMs,
          row.key,
        );

        await this.scheduleMultiplexedAlarm({
          key: schedulerAlarmKey(row.key, nextRunAtMs),
          runAt: nextRunAtMs,
          method: "runScheduledTask",
          payload: {
            key: row.key,
            expectedRunAtMs: nextRunAtMs,
          } satisfies SchedulerAlarmPayload,
        });
      }

      private async armSchedulerRows(): Promise<void> {
        const rows = this.getDurableObjectSql()
          .exec<SchedulerRow>(
            `SELECT key, method, payload_json, recurrence_json, next_run_at_ms,
                    running, execution_started_at_ms, created_at_ms, updated_at_ms
             FROM ${SCHEDULER_TABLE}`,
          )
          .toArray();

        for (const row of rows) {
          await this.scheduleMultiplexedAlarm({
            key: schedulerAlarmKey(row.key, row.next_run_at_ms),
            runAt: row.next_run_at_ms,
            method: "runScheduledTask",
            payload: {
              key: row.key,
              expectedRunAtMs: row.next_run_at_ms,
            } satisfies SchedulerAlarmPayload,
          });
        }
      }
    }

    // TypeScript cannot infer that this mixin preserves the wrapped generic
    // class and adds protected members. The implementation above is the runtime
    // shape; the cast publishes the Cloudflare-style `Base<Env>` constructor.
    return SchedulerMixin as unknown as WithSchedulerResult<TBase>;
  };
}

function normalizeRecurrence(
  recurrence: SchedulerRecurrence,
  nowMs: number,
): StoredSchedulerRecurrence {
  switch (recurrence.type) {
    case "once":
      return {
        type: "once",
        runAtMs: normalizeEpochMs(recurrence.runAt, "recurrence.runAt"),
      };
    case "delayed":
      if (!Number.isFinite(recurrence.delayMs) || recurrence.delayMs < 0) {
        throw new Error("recurrence.delayMs must be a non-negative finite number.");
      }
      return {
        type: "delayed",
        delayMs: recurrence.delayMs,
      };
    case "interval":
      if (!Number.isFinite(recurrence.everyMs) || recurrence.everyMs <= 0) {
        throw new Error("recurrence.everyMs must be a positive finite number.");
      }
      return {
        type: "interval",
        everyMs: recurrence.everyMs,
      };
    case "cron":
      validateTimezone(recurrence.timezone);
      return {
        type: "cron",
        expression: recurrence.expression,
        timezone: recurrence.timezone ?? null,
      };
    case "rrule":
      validateTimezone(recurrence.timezone);
      validateBareRrule(recurrence.rrule);
      return {
        type: "rrule",
        rrule: recurrence.rrule,
        timezone: recurrence.timezone ?? null,
        dtstartMs:
          recurrence.dtstart === undefined
            ? nowMs
            : normalizeEpochMs(recurrence.dtstart, "recurrence.dtstart"),
      };
  }
}

function validateBareRrule(value: string): void {
  const upper = value.toUpperCase();

  // Keep this API deliberately narrow: callers provide the rule body only, for
  // example `FREQ=DAILY;BYHOUR=9`. Full iCalendar snippets can contain DTSTART,
  // TZID, RDATE, EXDATE, and an `RRULE:` prefix, all of which have precedence
  // rules that conflict with our explicit `dtstart` and `timezone` fields.
  //
  // Supporting those later is a separate API decision. Rejecting them now keeps
  // schedule rows inspectable: recurrence.rrule is the recurrence rule, and
  // recurrence.dtstartMs/timezone are the only start/timezone sources.
  if (
    upper.includes("DTSTART") ||
    upper.includes("RDATE") ||
    upper.includes("EXDATE") ||
    upper.includes("RRULE:")
  ) {
    throw new Error(
      "recurrence.rrule must be a bare RRULE body like FREQ=DAILY;BYHOUR=9. Use recurrence.dtstart and recurrence.timezone instead of embedded iCalendar fields.",
    );
  }
}

function computeNextRunAtMs(
  key: string,
  recurrence: StoredSchedulerRecurrence,
  afterMs: number,
  options: { includeAfter?: boolean } = {},
): number {
  const after = new Date(afterMs);
  let next: Date | null;

  switch (recurrence.type) {
    case "once":
      return recurrence.runAtMs;
    case "delayed":
      return afterMs + recurrence.delayMs;
    case "interval":
      return afterMs + recurrence.everyMs;
    case "cron":
      next = new Cron(recurrence.expression, {
        paused: true,
        timezone: recurrence.timezone ?? "UTC",
      }).nextRun(after);
      break;
    case "rrule":
      next = rrulestr(recurrence.rrule, {
        dtstart: new Date(recurrence.dtstartMs),
        tzid: recurrence.timezone ?? "UTC",
      }).after(after, options.includeAfter === true);
      break;
  }

  if (next === null) {
    throw new NoNextScheduleOccurrenceError(key);
  }

  return next.getTime();
}

function isRecurringRecurrence(recurrence: StoredSchedulerRecurrence): boolean {
  return (
    recurrence.type === "interval" || recurrence.type === "cron" || recurrence.type === "rrule"
  );
}

function normalizeEpochMs(value: Date | number, label: string): number {
  const timeMs = value instanceof Date ? value.getTime() : value;

  if (!Number.isFinite(timeMs)) {
    throw new Error(`${label} must be a finite epoch-millisecond timestamp.`);
  }

  return timeMs;
}

function validateTimezone(timezone: string | undefined): void {
  if (timezone === undefined) {
    return;
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch (error) {
    throw new Error(
      `Invalid IANA timezone "${timezone}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function stringifySchedulerPayload(payload: unknown): string {
  return stringifyJsonPayload(payload, SchedulerPayloadSerializationError);
}

function parseStoredRecurrence(value: string): StoredSchedulerRecurrence {
  return JSON.parse(value) as StoredSchedulerRecurrence;
}

function schedulerRowToRecord(row: SchedulerRow): SchedulerRecord {
  return {
    key: row.key,
    method: row.method,
    payload: JSON.parse(row.payload_json) as unknown,
    recurrence: parseStoredRecurrence(row.recurrence_json),
    nextRunAt: new Date(row.next_run_at_ms).toISOString(),
    running: row.running === 1,
    executionStartedAt:
      row.execution_started_at_ms === null
        ? null
        : new Date(row.execution_started_at_ms).toISOString(),
    createdAt: new Date(row.created_at_ms).toISOString(),
    updatedAt: new Date(row.updated_at_ms).toISOString(),
  };
}

function parseSchedulerAlarmPayload(payload: unknown): SchedulerAlarmPayload {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("key" in payload) ||
    !("expectedRunAtMs" in payload) ||
    typeof payload.key !== "string" ||
    typeof payload.expectedRunAtMs !== "number"
  ) {
    throw new Error("Scheduler alarm payload must include key and expectedRunAtMs.");
  }

  return {
    key: payload.key,
    expectedRunAtMs: payload.expectedRunAtMs,
  };
}

function schedulerAlarmKey(scheduleKey: string, runAtMs: number): string {
  return `scheduler:${scheduleKey}:${runAtMs}`;
}
