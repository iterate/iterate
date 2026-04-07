import {
  Event,
  EventInput,
  SCHEDULE_ADDED_TYPE,
  SCHEDULE_CANCELLED_TYPE,
  SCHEDULE_EXECUTION_FINISHED_TYPE,
  SCHEDULE_EXECUTION_STARTED_TYPE,
  ScheduleAddedPayload,
  ScheduleCancelledPayload,
  ScheduleExecutionFinishedPayload,
  ScheduleExecutionStartedPayload,
  SchedulerRowState as SchedulerRowStateSchema,
  SchedulerState as SchedulerStateSchema,
  ScheduleType,
  ScheduleTypeConstraint,
  STREAM_APPEND_SCHEDULED_TYPE,
  StreamAppendSchedule,
  StreamAppendScheduledPayload,
  StreamPath,
} from "@iterate-com/events-contract";
import { z } from "zod";

export const HUNG_INTERVAL_TIMEOUT_SECONDS = 30;
export const DUPLICATE_SCHEDULE_THRESHOLD = 10;
export const MAX_INTERVAL_SECONDS = 30 * 24 * 60 * 60;

export {
  SCHEDULE_ADDED_TYPE,
  SCHEDULE_CANCELLED_TYPE,
  SCHEDULE_EXECUTION_FINISHED_TYPE,
  SCHEDULE_EXECUTION_STARTED_TYPE,
  ScheduleAddedPayload,
  ScheduleCancelledPayload,
  ScheduleExecutionFinishedPayload,
  ScheduleExecutionStartedPayload,
  ScheduleType,
  ScheduleTypeConstraint,
  STREAM_APPEND_SCHEDULED_TYPE,
  StreamAppendSchedule,
  StreamAppendScheduledPayload,
};

export type Schedule = {
  id: string;
  callback: string;
  payload: unknown;
  time: number;
  type: ScheduleType;
  created_at: number;
} & (
  | { type: "scheduled" }
  | { type: "delayed"; delayInSeconds?: number }
  | { type: "cron"; cron?: string }
  | { type: "interval"; intervalSeconds?: number }
);

export const ScheduleRow = SchedulerRowStateSchema;
export type ScheduleRow = z.infer<typeof ScheduleRow>;

export const ScheduleProjectionState = SchedulerStateSchema;
export type ScheduleProjectionState = z.infer<typeof ScheduleProjectionState>;

export type ScheduleCriteria = {
  id?: string;
  type?: ScheduleType;
  timeRange?: {
    start?: Date;
    end?: Date;
  };
};

export type ScheduleLookupArgs = {
  type: ScheduleType;
  callback: string;
  payloadJson: string | null;
  cron?: string;
  intervalSeconds?: number;
};

export type SchedulingMutationDeps = {
  append(event: EventInput): Promise<unknown> | unknown;
  ctx: DurableObjectState;
  isInitializing: boolean;
  validateScheduleCallback(callback: PropertyKey): string;
  warnedScheduleInOnStart: Set<string>;
};

export type SchedulingAlarmDeps = {
  append(event: EventInput): Promise<unknown> | unknown;
  ctx: DurableObjectState;
  instance: object;
};

export { Event, StreamPath };

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

export function rowToSchedule(row: ScheduleRow): Schedule {
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

export function serializeSchedulePayload(payload: unknown) {
  return payload === undefined ? null : JSON.stringify(payload);
}

export function deserializeSchedulePayload(payload: string | null) {
  return payload == null ? undefined : JSON.parse(payload);
}
