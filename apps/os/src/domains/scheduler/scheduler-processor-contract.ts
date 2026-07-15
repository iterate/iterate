import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "../streams/processor-contracts.ts";
import type {
  SchedulerAction as SchedulerActionType,
  SchedulerRecurrence as SchedulerRecurrenceType,
} from "./types.ts";

// =============================================================================
// Scheduler contract: durable time as stream events.
//
// Four events, one reduced record. `schedule-set` / `schedule-cancelled` are
// the caller-facing vocabulary (upsert / remove by key); `trigger-requested` /
// `trigger-completed` are the runtime's durable bookkeeping for one due
// occurrence. Everything the scheduler knows — the UI list, the next platform
// alarm, pending executions — is reduced from these events; there is no side
// table.
//
// A Trigger runs the newest Action for its key: the executing side resolves
// the script from reduced state at execution time (see the implementation), so
// `trigger-requested` carries no code — the code is already on the stream in
// the `schedule-set` event, and `trigger-completed.definedAtOffset` points at
// exactly which version ran.
// =============================================================================

/**
 * When a Schedule triggers. Exactly one canonical spelling per shape: a single
 * ISO instant (`at`), a seconds interval re-anchored on each trigger
 * (`every`), or a cron expression with optional IANA timezone (`cron`).
 * Sub-minute rates belong to `every`; calendar points belong to `cron`.
 */
const SchedulerRecurrence = z.union([
  z.looseObject({ at: z.iso.datetime({ offset: true }) }),
  z.looseObject({ every: z.number().int().positive() }),
  z.looseObject({ cron: z.string().trim().min(1), timezone: z.string().min(1).optional() }),
]) satisfies z.ZodType<SchedulerRecurrenceType, unknown>;

/**
 * What a Schedule does when it triggers. A closed union so an `append` kind
 * can be added later; the only kind today is running an itx script — a
 * function-expression string invoked as `fn(itx, schedule, trigger)` with
 * project-root itx authority.
 */
const SchedulerAction = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("itx-script"), script: z.string().trim().min(1) }),
]) satisfies z.ZodType<SchedulerActionType, unknown>;

/** Payload of `schedule-set`: a keyed upsert of recurrence + action. */
export const ScheduleSetPayload = z.looseObject({
  action: SchedulerAction,
  key: z.string().trim().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
  recurrence: SchedulerRecurrence,
});
export type ScheduleSetPayload = z.infer<typeof ScheduleSetPayload>;

/** Payload of `trigger-requested`: one due occurrence, code-free by design. */
const TriggerRequestedPayload = z.looseObject({
  executionId: z.string().min(1),
  key: z.string().trim().min(1),
  /** When this occurrence was actually requested (alarm wake or manual trigger). */
  requestedAt: z.iso.datetime({ offset: true }),
  /** The ordinal of this Trigger for its key, starting at 1. */
  runCount: z.number().int().positive(),
  /** When this occurrence was due. Equals `requestedAt` for manual triggers. */
  scheduledFor: z.iso.datetime({ offset: true }),
});
type TriggerRequestedPayload = z.infer<typeof TriggerRequestedPayload>;

/** Payload of `trigger-completed`: the outcome of one Trigger's execution. */
const TriggerCompletedPayload = z.looseObject({
  /** The `schedule-set` offset whose code actually ran; absent when skipped. */
  definedAtOffset: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
  executionId: z.string().min(1),
  key: z.string().trim().min(1),
  /** `skipped` = the Schedule was cancelled between request and execution. */
  outcome: z.enum(["succeeded", "failed", "skipped"]),
  result: z.unknown().optional(),
});
type TriggerCompletedPayload = z.infer<typeof TriggerCompletedPayload>;

/**
 * One reduced Schedule: everything the alarm computation, the executing side,
 * and the UI list need to know about a key.
 */
const ScheduleEntry = z.looseObject({
  action: SchedulerAction,
  /** Offset of the `schedule-set` event that last defined this key (audit provenance). */
  definedAtOffset: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  /** Stream path of the defining `schedule-set` event. */
  path: z.string().trim().min(1),
  /**
   * Epoch ms of the next due occurrence. Null once a one-shot has been
   * requested, or when a cron expression yields no future occurrence (including
   * unparseable expressions from raw appends — reduce is total and never
   * throws, so a broken schedule parks visibly instead of poisoning the fold).
   */
  nextTriggerAt: z.number().int().nonnegative().nullable(),
  recurrence: SchedulerRecurrence,
  /** How many Triggers have been requested for this key since it was (re)set. */
  runCount: z.number().int().nonnegative(),
  /** `createdAt` of the defining `schedule-set` event. */
  setAt: z.iso.datetime({ offset: true }),
});
type ScheduleEntry = z.infer<typeof ScheduleEntry>;

/** One requested-but-not-completed Trigger, keyed by executionId in state. */
const PendingTrigger = z.looseObject({
  key: z.string().min(1),
  requestedAt: z.iso.datetime({ offset: true }),
  runCount: z.number().int().positive(),
  scheduledFor: z.iso.datetime({ offset: true }),
});
type PendingTrigger = z.infer<typeof PendingTrigger>;

export const SchedulerProcessorContract = defineProcessorContract({
  slug: "scheduler",
  version: "0.1.0",
  description:
    "Durable time: keyed Schedules (recurrence + itx-script Action) reduced from stream events; " +
    "due Schedules are triggered by the hosting Durable Object's alarm and every Trigger's " +
    "request and outcome land back on the stream.",
  stateSchema: z.object({
    pendingTriggers: z.record(z.string(), PendingTrigger).default({}),
    schedules: z.record(z.string(), ScheduleEntry).default({}),
  }),
  events: {
    "events.iterate.com/scheduler/schedule-set": {
      description: "A Schedule was created or replaced under its key.",
      payloadSchema: ScheduleSetPayload,
    },
    "events.iterate.com/scheduler/schedule-cancelled": {
      description: "The Schedule under this key was removed.",
      payloadSchema: z.looseObject({ key: z.string().trim().min(1) }),
    },
    "events.iterate.com/scheduler/trigger-requested": {
      description: "One due (or manually requested) occurrence of a Schedule.",
      payloadSchema: TriggerRequestedPayload,
    },
    "events.iterate.com/scheduler/trigger-completed": {
      description: "A Trigger's execution finished (succeeded, failed, or skipped).",
      payloadSchema: TriggerCompletedPayload,
    },
  },
  consumes: [
    "events.iterate.com/scheduler/schedule-set",
    "events.iterate.com/scheduler/schedule-cancelled",
    "events.iterate.com/scheduler/trigger-requested",
    "events.iterate.com/scheduler/trigger-completed",
  ],
  emits: [
    "events.iterate.com/scheduler/schedule-set",
    "events.iterate.com/scheduler/schedule-cancelled",
    "events.iterate.com/scheduler/trigger-requested",
    "events.iterate.com/scheduler/trigger-completed",
  ],
});

/** The contract's type under the same identifier — helpers read without `typeof`. */
export type SchedulerProcessorContract = typeof SchedulerProcessorContract;

/** The scheduler's reduced state: the one object the UI, alarm, and executor read. */
export type SchedulerProcessorState = ProcessorState<SchedulerProcessorContract>;
