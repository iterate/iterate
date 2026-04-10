import { z } from "zod";
import {
  EventTypeSchema,
  GenericEvent as GenericEventBase,
  GenericEventInput as GenericEventInputBase,
} from "./event-base-types.ts";

/**
 * Scheduling is modeled as stream control events, not as a separate scheduler
 * table or RPC surface.
 *
 * The important split is:
 *
 * - `append-scheduled` is ergonomic user intent
 * - `schedule/configured` is the canonical low-level upsert event
 * - `schedule/internal/*` are durable runtime bookkeeping events
 *
 * `append-scheduled` and `schedule/configured` intentionally share the same
 * `schedule` shape so callers and reducer state talk about schedules using one
 * vocabulary.
 *
 * Relevant first-party references:
 *
 * - Durable Object alarms:
 *   https://developers.cloudflare.com/durable-objects/api/alarms/
 * - Durable Object state lifecycle:
 *   https://developers.cloudflare.com/durable-objects/api/state/
 * - Cloudflare Agents scheduling docs:
 *   https://developers.cloudflare.com/agents/api-reference/schedule-tasks/
 */
const iterateEventUriPrefix = "https://events.iterate.com/" as const;

export const STREAM_APPEND_SCHEDULED_TYPE =
  `${iterateEventUriPrefix}events/stream/append-scheduled` as const;
export const SCHEDULE_CONFIGURED_TYPE =
  `${iterateEventUriPrefix}events/stream/schedule/configured` as const;
export const SCHEDULE_CANCELLED_TYPE =
  `${iterateEventUriPrefix}events/stream/schedule/cancelled` as const;
export const SCHEDULE_INTERNAL_EXECUTION_STARTED_TYPE =
  `${iterateEventUriPrefix}events/stream/schedule/internal/execution-started` as const;
export const SCHEDULE_INTERNAL_EXECUTION_FINISHED_TYPE =
  `${iterateEventUriPrefix}events/stream/schedule/internal/execution-finished` as const;

export const StreamSchedule = z.discriminatedUnion("kind", [
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
export type StreamSchedule = z.infer<typeof StreamSchedule>;

// The scheduled target is validated as a normal event envelope, but we do not
// recursively re-run built-in payload discrimination at schedule-creation time.
// The eventual callback remains the canonical validator when the scheduled
// event actually fires.
const ScheduledAppendTargetEventInput = GenericEventInputBase.extend({
  type: EventTypeSchema,
});
type ScheduledAppendTargetEventInput = z.infer<typeof ScheduledAppendTargetEventInput>;

export const StreamAppendScheduledPayload = z.strictObject({
  slug: z.string().trim().min(1),
  append: ScheduledAppendTargetEventInput,
  schedule: StreamSchedule,
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

export const ScheduleConfiguredPayload = z.strictObject({
  slug: z.string().trim().min(1),
  callback: z.string().trim().min(1),
  payloadJson: z.string().nullable().optional(),
  schedule: StreamSchedule,
  nextRunAt: z.number().int().nonnegative(),
});
export type ScheduleConfiguredPayload = z.infer<typeof ScheduleConfiguredPayload>;

export const ScheduleConfiguredEventInput = GenericEventInputBase.extend({
  type: z.literal(SCHEDULE_CONFIGURED_TYPE),
  payload: ScheduleConfiguredPayload,
});
export const ScheduleConfiguredEvent = GenericEventBase.extend(
  ScheduleConfiguredEventInput.pick({ type: true, payload: true }).shape,
);

const ScheduleCancelledPayload = z.strictObject({
  slug: z.string().trim().min(1),
});
type ScheduleCancelledPayload = z.infer<typeof ScheduleCancelledPayload>;

export const ScheduleCancelledEventInput = GenericEventInputBase.extend({
  type: z.literal(SCHEDULE_CANCELLED_TYPE),
  payload: ScheduleCancelledPayload,
});
export const ScheduleCancelledEvent = GenericEventBase.extend(
  ScheduleCancelledEventInput.pick({ type: true, payload: true }).shape,
);

export const ScheduleInternalExecutionStartedPayload = z.strictObject({
  slug: z.string().trim().min(1),
  startedAt: z.number().int().nonnegative(),
});
export type ScheduleInternalExecutionStartedPayload = z.infer<
  typeof ScheduleInternalExecutionStartedPayload
>;

export const ScheduleInternalExecutionStartedEventInput = GenericEventInputBase.extend({
  type: z.literal(SCHEDULE_INTERNAL_EXECUTION_STARTED_TYPE),
  payload: ScheduleInternalExecutionStartedPayload,
});
export const ScheduleInternalExecutionStartedEvent = GenericEventBase.extend(
  ScheduleInternalExecutionStartedEventInput.pick({ type: true, payload: true }).shape,
);

export const ScheduleInternalExecutionFinishedPayload = z.strictObject({
  slug: z.string().trim().min(1),
  outcome: z.enum(["succeeded", "failed"]),
  nextRunAt: z.number().int().nonnegative().nullable(),
});
export type ScheduleInternalExecutionFinishedPayload = z.infer<
  typeof ScheduleInternalExecutionFinishedPayload
>;

export const ScheduleInternalExecutionFinishedEventInput = GenericEventInputBase.extend({
  type: z.literal(SCHEDULE_INTERNAL_EXECUTION_FINISHED_TYPE),
  payload: ScheduleInternalExecutionFinishedPayload,
});
export const ScheduleInternalExecutionFinishedEvent = GenericEventBase.extend(
  ScheduleInternalExecutionFinishedEventInput.pick({ type: true, payload: true }).shape,
);

const SchedulerEntryState = z.strictObject({
  callback: z.string().trim().min(1),
  payloadJson: z.string().nullable(),
  schedule: StreamSchedule,
  nextRunAt: z.number().int().nonnegative(),
  executionCount: z.number().int().nonnegative(),
  running: z.boolean(),
  executionStartedAt: z.number().int().nonnegative().nullable(),
  createdAt: z.number().int().nonnegative(),
});
type SchedulerEntryState = z.infer<typeof SchedulerEntryState>;

export const SchedulerState = z.record(z.string(), SchedulerEntryState).default({});
export type SchedulerState = z.infer<typeof SchedulerState>;
