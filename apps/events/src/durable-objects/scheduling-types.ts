import {
  Event,
  EventInput,
  Offset,
  StreamMetadataUpdatedPayload,
  StreamPath,
  StreamState as PublicStreamStateSchema,
  type StreamState as PublicStreamStateValue,
} from "@iterate-com/events-contract";
import { z } from "zod";

/**
 * Scheduling in this app deliberately mirrors Cloudflare Agents' "many logical
 * schedules over one Durable Object alarm" design, but the source of truth is
 * our stream log plus reduced state instead of direct table mutation.
 *
 * Upstream reference:
 * https://github.com/cloudflare/agents/blob/main/packages/agents/src/index.ts
 *
 * When upstream scheduling semantics or tests change, update these shared
 * types/constants first, then re-diff `scheduling.ts` and `scheduling.test.ts`
 * against the latest Agents SDK implementation and tests.
 */
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

export const ScheduleRowState = z.object({
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
export type ScheduleRow = z.infer<typeof ScheduleRowState>;

export const ScheduleProjectionState = z.record(z.string(), ScheduleRowState).default({});
export type ScheduleProjectionState = z.infer<typeof ScheduleProjectionState>;

export const ReducedStreamState = PublicStreamStateSchema.extend({
  cf_agents_schedules: ScheduleProjectionState.default({}),
});
export type ReducedStreamState = z.infer<typeof ReducedStreamState>;

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
  append(args: { events: EventInput[] }): Promise<unknown>;
  ctx: DurableObjectState;
  isInitializing: boolean;
  requireStreamPath(): StreamPath;
  validateScheduleCallback(callback: PropertyKey): string;
  warnedScheduleInOnStart: Set<string>;
};

export type SchedulingAlarmDeps = {
  append(args: { events: EventInput[] }): Promise<unknown>;
  ctx: DurableObjectState;
  instance: object;
  requireStreamPath(): StreamPath;
};

export type PublicStreamState = PublicStreamStateValue;
export { Event, Offset, StreamMetadataUpdatedPayload, StreamPath };
