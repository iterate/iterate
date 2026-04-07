import { z } from "zod";
import {
  EventTypeSchema,
  GenericEvent as GenericEventBase,
  GenericEventInput as GenericEventInputBase,
} from "./event-base-types.ts";

const iterateEventUriPrefix = "https://events.iterate.com/" as const;

export const STREAM_APPEND_SCHEDULED_TYPE =
  `${iterateEventUriPrefix}events/stream/append-scheduled` as const;
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

export const SchedulerRowState = z.object({
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
export type SchedulerRowState = z.infer<typeof SchedulerRowState>;

export const SchedulerState = z.record(z.string(), SchedulerRowState).default({});
export type SchedulerState = z.infer<typeof SchedulerState>;

export const StreamAppendSchedule = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("once-at"),
    at: z.iso.datetime({ offset: true }),
  }),
  z.strictObject({
    kind: z.literal("once-in"),
    delaySeconds: z.number().int().positive(),
  }),
  z.strictObject({
    kind: z.literal("every"),
    intervalSeconds: z.number().int().positive(),
  }),
  z.strictObject({
    kind: z.literal("cron"),
    cron: z.string().trim().min(1),
  }),
]);
export type StreamAppendSchedule = z.infer<typeof StreamAppendSchedule>;

// The scheduled target is validated as a normal event envelope, but we do not
// recursively re-run built-in payload discrimination at schedule-creation time.
// The eventual `append` callback remains the canonical validator when the
// scheduled event actually fires.
export const ScheduledAppendTargetEventInput = GenericEventInputBase.extend({
  type: EventTypeSchema,
});
export type ScheduledAppendTargetEventInput = z.infer<typeof ScheduledAppendTargetEventInput>;

export const StreamAppendScheduledPayload = z.strictObject({
  scheduleId: z.string().trim().min(1),
  append: ScheduledAppendTargetEventInput,
  schedule: StreamAppendSchedule,
});
export type StreamAppendScheduledPayload = z.infer<typeof StreamAppendScheduledPayload>;

export const StreamAppendScheduledEventInput = GenericEventInputBase.extend({
  type: z.literal(STREAM_APPEND_SCHEDULED_TYPE),
  payload: StreamAppendScheduledPayload,
});
export const StreamAppendScheduledEvent = GenericEventBase.extend(
  StreamAppendScheduledEventInput.pick({ type: true, payload: true }).shape,
);
export type StreamAppendScheduledEventInput = z.infer<typeof StreamAppendScheduledEventInput>;
export type StreamAppendScheduledEvent = z.infer<typeof StreamAppendScheduledEvent>;

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
export type ScheduleAddedPayload = z.infer<typeof ScheduleAddedPayload>;

export const ScheduleAddedEventInput = GenericEventInputBase.extend({
  type: z.literal(SCHEDULE_ADDED_TYPE),
  payload: ScheduleAddedPayload,
});
export const ScheduleAddedEvent = GenericEventBase.extend(
  ScheduleAddedEventInput.pick({ type: true, payload: true }).shape,
);

export const ScheduleCancelledPayload = z.object({
  scheduleId: z.string().trim().min(1),
});
export type ScheduleCancelledPayload = z.infer<typeof ScheduleCancelledPayload>;

export const ScheduleCancelledEventInput = GenericEventInputBase.extend({
  type: z.literal(SCHEDULE_CANCELLED_TYPE),
  payload: ScheduleCancelledPayload,
});
export const ScheduleCancelledEvent = GenericEventBase.extend(
  ScheduleCancelledEventInput.pick({ type: true, payload: true }).shape,
);

export const ScheduleExecutionStartedPayload = z.object({
  scheduleId: z.string().trim().min(1),
  startedAt: z.number().int().nonnegative(),
});
export type ScheduleExecutionStartedPayload = z.infer<typeof ScheduleExecutionStartedPayload>;

export const ScheduleExecutionStartedEventInput = GenericEventInputBase.extend({
  type: z.literal(SCHEDULE_EXECUTION_STARTED_TYPE),
  payload: ScheduleExecutionStartedPayload,
});
export const ScheduleExecutionStartedEvent = GenericEventBase.extend(
  ScheduleExecutionStartedEventInput.pick({ type: true, payload: true }).shape,
);

export const ScheduleExecutionFinishedPayload = z.object({
  scheduleId: z.string().trim().min(1),
  outcome: z.enum(["succeeded", "failed"]),
  nextTime: z.number().int().nonnegative().nullable(),
});
export type ScheduleExecutionFinishedPayload = z.infer<typeof ScheduleExecutionFinishedPayload>;

export const ScheduleExecutionFinishedEventInput = GenericEventInputBase.extend({
  type: z.literal(SCHEDULE_EXECUTION_FINISHED_TYPE),
  payload: ScheduleExecutionFinishedPayload,
});
export const ScheduleExecutionFinishedEvent = GenericEventBase.extend(
  ScheduleExecutionFinishedEventInput.pick({ type: true, payload: true }).shape,
);
