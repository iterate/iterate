import { Event, EventInput, StreamPath } from "@iterate-com/events-contract";
import { z } from "zod";

const iterateEventUriPrefix = "https://events.iterate.com/" as const;

export const HUNG_INTERVAL_TIMEOUT_SECONDS = 30;
export const DUPLICATE_SCHEDULE_THRESHOLD = 10;
export const MAX_INTERVAL_SECONDS = 30 * 24 * 60 * 60;

export const SCHEDULE_ADDED_TYPE = `${iterateEventUriPrefix}events/stream/schedule/added` as const;
export const SCHEDULE_CANCELLED_TYPE =
  `${iterateEventUriPrefix}events/stream/schedule/cancelled` as const;
export const SCHEDULE_EXECUTION_STARTED_TYPE =
  `${iterateEventUriPrefix}events/stream/schedule/execution-started` as const;
export const SCHEDULE_EXECUTION_FINISHED_TYPE =
  `${iterateEventUriPrefix}events/stream/schedule/execution-finished` as const;

export const ScheduleType = z.enum(["scheduled", "delayed", "cron", "interval"]);
export type ScheduleType = z.infer<typeof ScheduleType>;

export const ScheduleTypeConstraint = "'scheduled', 'delayed', 'cron', 'interval'";

export const ScheduleAddedPayload = z
  .object({
    scheduleId: z.string().trim().min(1),
    callback: z.string().trim().min(1),
    payloadJson: z.string().nullable().optional(),
    scheduleType: ScheduleType,
    time: z.number().int().nonnegative(),
    delayInSeconds: z.number().int().positive().optional(),
    cron: z.string().trim().min(1).optional(),
    intervalSeconds: z.number().int().positive().optional(),
  })
  .superRefine((payload, ctx) => {
    switch (payload.scheduleType) {
      case "scheduled":
        return;
      case "delayed":
        if (payload.delayInSeconds == null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["delayInSeconds"],
            message: "delayInSeconds is required for delayed schedules.",
          });
        }
        return;
      case "cron":
        if (payload.cron == null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["cron"],
            message: "cron is required for cron schedules.",
          });
        }
        return;
      case "interval":
        if (payload.intervalSeconds == null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["intervalSeconds"],
            message: "intervalSeconds is required for interval schedules.",
          });
        }
        return;
      default:
        return;
    }
  });

export const ScheduleCancelledPayload = z.object({
  scheduleId: z.string().trim().min(1),
});

export const ScheduleExecutionStartedPayload = z.object({
  scheduleId: z.string().trim().min(1),
  startedAt: z.number().int().nonnegative(),
});

export const ScheduleExecutionFinishedPayload = z.object({
  scheduleId: z.string().trim().min(1),
  outcome: z.enum(["succeeded", "failed"]),
  nextTime: z.number().int().nonnegative().nullable(),
});

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

export const ScheduleRow = z.object({
  id: z.string().trim().min(1),
  callback: z.string().trim().min(1),
  payload: z.string().nullable(),
  type: ScheduleType,
  time: z.number().int().nonnegative(),
  delayInSeconds: z.number().int().nullable(),
  cron: z.string().nullable(),
  intervalSeconds: z.number().int().nullable(),
  running: z.number().int().min(0).max(1),
  execution_started_at: z.number().int().nonnegative().nullable(),
  retry_options: z.string().nullable(),
  created_at: z.number().int().nonnegative(),
});
export type ScheduleRow = z.infer<typeof ScheduleRow>;

export const ScheduleProjectionState = z.record(z.string(), ScheduleRow).default({});
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
