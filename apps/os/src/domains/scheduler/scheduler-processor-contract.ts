// The scheduler CONTRACT — durable time as stream events. Self-contained:
// state schema, events, consumes/emits, every payload schema spelled INLINE.
// The three schemas the contract needs twice each (recurrence and action ride
// both the `schedule-set` payload and the reduced schedule entry; the birth
// certificate rides `scheduler/created` and the reduced state) are hoisted
// functions below the contract, so the contract still opens the file.
//
// Five events, one reduced record. `schedule-set` / `schedule-cancelled` are
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
//
// The wire schemas are deliberately LOOSE (looseObject: historical payloads
// with extra keys keep parsing) while the itx-facing public types (./types.ts)
// stay clean strict unions; the `satisfies` checks inside the hoisted schema
// functions pin the two spellings to each other.

import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "iterate/processors";
import type {
  SchedulerAction as SchedulerActionType,
  SchedulerRecurrence as SchedulerRecurrenceType,
} from "./types.ts";

export const SchedulerProcessorContract = defineProcessorContract({
  slug: "scheduler",
  version: "0.1.0",
  description:
    "Durable time: keyed Schedules (recurrence + itx-script Action) reduced from stream events; " +
    "due Schedules are triggered by the hosting Durable Object's alarm and every Trigger's " +
    "request and outcome land back on the stream.",
  stateSchema: z.object({
    birthCertificate: schedulerBirthCertificateSchema()
      .nullable()
      .default(null)
      .meta({
        description:
          "Existence marker: null until scheduler/created reduces. Commands assert it; " +
          "reducing a second created event throws.",
      }),
    pendingTriggers: z
      .record(
        z.string().meta({ description: "The Trigger's executionId." }),
        z
          .looseObject({
            key: z
              .string()
              .min(1)
              .meta({ description: "The Schedule this Trigger is an occurrence of." }),
            requestedAt: z.iso.datetime({ offset: true }).meta({
              description:
                "When this occurrence was actually requested (alarm wake or manual trigger).",
            }),
            runCount: z.number().int().positive().meta({
              description: "The ordinal of this Trigger for its key, starting at 1.",
            }),
            scheduledFor: z.iso.datetime({ offset: true }).meta({
              description: "When this occurrence was due. Equals requestedAt for manual triggers.",
            }),
          })
          .meta({
            description:
              "One requested-but-not-completed Trigger: everything an execution attempt " +
              "needs except the code, which is resolved from `schedules` at execution time " +
              "(latest-code-wins).",
          }),
      )
      .default({})
      .meta({
        description:
          "Requested Triggers with no completion yet, keyed by executionId. The alarm " +
          "wake's sweep re-launches these after a Durable Object restart (at-least-once).",
      }),
    schedules: z
      .record(
        z.string().meta({ description: "The Schedule's key." }),
        z
          .looseObject({
            action: schedulerActionSchema(),
            definedAtOffset: z
              .number()
              .int()
              .nonnegative()
              .meta({
                description:
                  "Offset of the schedule-set event that last defined this key (audit " +
                  "provenance, and one component of the occurrence idempotency key: a re-set " +
                  "key can never dedupe against a spent request from a past incarnation).",
              }),
            metadata: z
              .record(z.string(), z.unknown())
              .optional()
              .meta({
                description:
                  "Caller-owned annotations from the defining schedule-set event, echoed on " +
                  "views and passed to the Action's `schedule` argument.",
              }),
            path: z
              .string()
              .trim()
              .min(1)
              .meta({ description: "Stream path of the defining schedule-set event." }),
            nextTriggerAt: z
              .number()
              .int()
              .nonnegative()
              .nullable()
              .meta({
                description:
                  "Epoch ms of the next due occurrence. Null once a one-shot has been " +
                  "requested, or when a cron expression yields no future occurrence " +
                  "(including unparseable expressions from raw appends — reduce is total and " +
                  "never throws, so a broken schedule parks visibly instead of poisoning the " +
                  "reduced state).",
              }),
            recurrence: schedulerRecurrenceSchema(),
            runCount: z.number().int().nonnegative().meta({
              description:
                "How many Triggers have been requested for this key since it was (re)set.",
            }),
            setAt: z.iso.datetime({ offset: true }).meta({
              description: "createdAt of the defining schedule-set event.",
            }),
          })
          .meta({
            description:
              "One reduced Schedule: everything the alarm computation, the executing side, " +
              "and the UI list need to know about a key.",
          }),
      )
      .default({})
      .meta({ description: "Every live Schedule, keyed by its caller-chosen key." }),
  }),
  events: {
    "events.iterate.com/scheduler/created": {
      description:
        "Creates the Scheduler processor on this stream. itx.schedulers.get(path).create() " +
        "appends it (idempotency-keyed per project + path) and returns only after the " +
        "processor has reduced it.",
      payloadSchema: schedulerBirthCertificateSchema(),
    },
    "events.iterate.com/scheduler/schedule-set": {
      description:
        "A Schedule was created or replaced under its key: a keyed upsert of recurrence + " +
        "Action. Re-setting a key resets its run count and re-anchors its next occurrence; a " +
        "Trigger already in flight for the old version runs the NEW code (latest-code-wins).",
      payloadSchema: z.looseObject({
        action: schedulerActionSchema(),
        key: z.string().trim().min(1).meta({
          description: "The Schedule's stable identity — upserts and cancels address this key.",
        }),
        metadata: z
          .record(z.string(), z.unknown())
          .optional()
          .meta({
            description:
              "Caller-owned annotations, echoed on views and passed to the Action's " +
              "`schedule` argument; the platform never interprets them.",
          }),
        recurrence: schedulerRecurrenceSchema(),
      }),
    },
    "events.iterate.com/scheduler/schedule-cancelled": {
      description:
        "The Schedule under this key was removed. Idempotent — cancelling an unknown key " +
        "reduces to nothing. A Trigger already requested for the key completes as `skipped`.",
      payloadSchema: z.looseObject({
        key: z.string().trim().min(1).meta({ description: "The key to remove." }),
      }),
    },
    "events.iterate.com/scheduler/trigger-requested": {
      description:
        "One due (or manually requested) occurrence of a Schedule — code-free by design: the " +
        "execution resolves the newest Action for the key from reduced state, so a re-set " +
        "between request and execution runs the new code. Alarm-requested occurrences are " +
        "idempotency-keyed by (key, defining set-event offset, due time), so a crashed wake " +
        "re-running against un-advanced state can never double-request; manual triggers are " +
        "deliberately unkeyed — every one is a new Trigger.",
      payloadSchema: z.looseObject({
        executionId: z
          .string()
          .min(1)
          .meta({
            description:
              "Unique id of this execution; the completion's idempotency key derives from it, " +
              "so a raced double-execution still commits exactly one outcome event.",
          }),
        key: z
          .string()
          .trim()
          .min(1)
          .meta({ description: "The Schedule this occurrence belongs to." }),
        requestedAt: z.iso.datetime({ offset: true }).meta({
          description:
            "When this occurrence was actually requested (alarm wake or manual trigger).",
        }),
        runCount: z.number().int().positive().meta({
          description: "The ordinal of this Trigger for its key, starting at 1.",
        }),
        scheduledFor: z.iso.datetime({ offset: true }).meta({
          description: "When this occurrence was due. Equals requestedAt for manual triggers.",
        }),
      }),
    },
    "events.iterate.com/scheduler/trigger-completed": {
      description:
        "A Trigger's execution finished — exactly one completion per executionId " +
        "(idempotency-keyed), recording which schedule-set version's code actually ran and " +
        "how it went. `skipped` means the Schedule was cancelled between request and " +
        "execution, so no code ran at all.",
      payloadSchema: z.looseObject({
        definedAtOffset: z.number().int().nonnegative().optional().meta({
          description: "The schedule-set offset whose code actually ran; absent when skipped.",
        }),
        error: z.string().optional().meta({
          description: "The thrown error's message, when the outcome is `failed`.",
        }),
        executionId: z.string().min(1).meta({ description: "The Trigger this outcome settles." }),
        key: z
          .string()
          .trim()
          .min(1)
          .meta({ description: "The Schedule the Trigger belonged to." }),
        outcome: z.enum(["succeeded", "failed", "skipped"]).meta({
          description:
            "How the execution ended. `skipped` = the Schedule was cancelled between " +
            "request and execution.",
        }),
        result: z.unknown().optional().meta({
          description:
            "The Action's JSON-detached return value, when it succeeded and returned one.",
        }),
      }),
    },
  },
  consumes: [
    "events.iterate.com/scheduler/created",
    "events.iterate.com/scheduler/schedule-set",
    "events.iterate.com/scheduler/schedule-cancelled",
    "events.iterate.com/scheduler/trigger-requested",
    "events.iterate.com/scheduler/trigger-completed",
  ],
  emits: [
    "events.iterate.com/scheduler/created",
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

/** The `schedule-set` payload — the Durable Object's setSchedule input — derived
 * through the contract (the schema itself lives inline in the event). */
export type ScheduleSetPayload = z.output<
  (typeof SchedulerProcessorContract.events)["events.iterate.com/scheduler/schedule-set"]["payloadSchema"]
>;

/**
 * When a Schedule triggers — used twice (the `schedule-set` payload and the
 * reduced schedule entry). Exactly one canonical spelling per shape: a single
 * ISO instant (`at`), a seconds interval re-anchored on each trigger
 * (`every`), or a cron expression with optional IANA timezone (`cron`).
 * Sub-minute rates belong to `every`; calendar points belong to `cron`.
 */
function schedulerRecurrenceSchema() {
  return z
    .union([
      z.looseObject({
        at: z.iso.datetime({ offset: true }).meta({
          description:
            "The single ISO instant this one-shot fires at; the Schedule leaves state once " +
            "its Trigger settles.",
        }),
      }),
      z.looseObject({
        every: z
          .number()
          .int()
          .positive()
          .meta({
            description:
              "Seconds between occurrences, re-anchored on each Trigger request: missed " +
              "occurrences coalesce and intervals drift by execution latency — fixed-phase " +
              "timing is what `cron` is for.",
          }),
      }),
      z.looseObject({
        cron: z
          .string()
          .trim()
          .min(1)
          .meta({
            description:
              "A cron expression (croner dialect); occurrences are computed in `timezone`, " +
              "UTC by default.",
          }),
        timezone: z.string().min(1).optional().meta({
          description: "IANA timezone name the cron expression is evaluated in.",
        }),
      }),
    ])
    .meta({
      description: "When a Schedule triggers: a one-shot instant, an interval, or a cron.",
    }) satisfies z.ZodType<SchedulerRecurrenceType, unknown>;
}

/**
 * What a Schedule does when it triggers — used twice (the `schedule-set`
 * payload and the reduced schedule entry). A closed union so an `append` kind
 * can be added later; the only kind today is running an itx script.
 */
function schedulerActionSchema() {
  return z
    .discriminatedUnion("kind", [
      z.looseObject({
        kind: z.literal("itx-script").meta({
          description: "The only Action kind today: run an itx script.",
        }),
        script: z
          .string()
          .trim()
          .min(1)
          .meta({
            description:
              "A function-expression string invoked as `fn(itx, schedule, trigger)` with " +
              "project-root itx authority.",
          }),
      }),
    ])
    .meta({ description: "What a Schedule does when it triggers." }) satisfies z.ZodType<
    SchedulerActionType,
    unknown
  >;
}

/** The `scheduler/created` payload, stored verbatim as the reduced state's
 * existence marker — used twice (the event and the state). */
function schedulerBirthCertificateSchema() {
  return z
    .strictObject({
      config: z
        .strictObject({})
        .meta({ description: "Reserved for birth-time configuration; empty today." }),
    })
    .meta({ description: "Immutable facts fixed at creation; nothing yet beyond existence." });
}
