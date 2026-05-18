import { Cron } from "croner";
import { z } from "zod";
import {
  assertNever,
  defineProcessorContract,
  reduceProcessorEvents,
  type StreamEvent,
} from "../stream-processor.ts";
import { CoreProcessorRegisteredEventType } from "../core/contract.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";

export const schedulingEventTypes = {
  appendScheduled: "events.iterate.com/scheduling/append-scheduled",
  scheduleConfigured: "events.iterate.com/scheduling/schedule-configured",
  scheduleCancelled: "events.iterate.com/scheduling/schedule-cancelled",
  scheduleExecutionStarted: "events.iterate.com/scheduling/schedule-execution-started",
  scheduleExecutionFinished: "events.iterate.com/scheduling/schedule-execution-finished",
} as const;

const EventInputPayload = z.object({
  type: z.string().trim().min(1),
  payload: z.json().default({}),
  metadata: z.record(z.string(), z.unknown()).optional(),
  idempotencyKey: z.string().trim().min(1).optional(),
});

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

/**
 * Frontend-safe scheduling contract.
 *
 * Scheduling is now an ordinary stream processor, not hidden logic inside
 * `apps/events/src/durable-objects/stream.ts`. A runner can host this processor
 * wherever it has a timer/alarm mechanism. The contract remains importable by
 * frontend code because it contains only schemas and a pure reducer.
 */
export const SchedulingProcessorContract = defineProcessorContract({
  slug: "scheduling",
  version: "0.1.0",
  description: "Reduces stream scheduling control events into due scheduled appends.",
  stateSchema: z.object({
    ...standardProcessorBehavior.stateShape,
    schedulesBySlug: z.record(z.string(), SchedulerEntryState).default({}),
  }),
  initialState: {
    ...standardProcessorBehavior.initialState,
  },
  processorDeps: [...standardProcessorBehavior.processorDeps],
  events: {
    [schedulingEventTypes.appendScheduled]: {
      description: "User intent to append an event later or repeatedly.",
      examples: [
        {
          description: "Append an event every 60 seconds",
          payload: {
            slug: "heartbeat",
            append: { type: "events.iterate.com/os/manual-event", payload: { message: "ping" } },
            schedule: { kind: "every", intervalSeconds: 60 },
          },
        },
        {
          description: "Append an event once after 30 seconds",
          payload: {
            slug: "delayed-reminder",
            append: {
              type: "events.iterate.com/os/manual-event",
              payload: { message: "reminder" },
            },
            schedule: { kind: "once-in", delaySeconds: 30 },
          },
        },
      ],
      payloadSchema: z.strictObject({
        slug: z.string().trim().min(1),
        append: EventInputPayload,
        schedule: StreamSchedule,
      }),
    },
    [schedulingEventTypes.scheduleConfigured]: {
      description: "Canonical low-level configured schedule.",
      payloadSchema: z.strictObject({
        slug: z.string().trim().min(1),
        callback: z.literal("append"),
        payloadJson: z.string().nullable().optional(),
        schedule: StreamSchedule,
        nextRunAt: z.number().int().nonnegative(),
      }),
    },
    [schedulingEventTypes.scheduleCancelled]: {
      description: "Cancels one configured schedule.",
      examples: [
        {
          description: "Cancel a schedule by slug",
          payload: { slug: "heartbeat" },
        },
      ],
      payloadSchema: z.strictObject({ slug: z.string().trim().min(1) }),
    },
    [schedulingEventTypes.scheduleExecutionStarted]: {
      description: "Runtime bookkeeping emitted just before a recurring schedule runs.",
      payloadSchema: z.strictObject({
        slug: z.string().trim().min(1),
        startedAt: z.number().int().nonnegative(),
      }),
    },
    [schedulingEventTypes.scheduleExecutionFinished]: {
      description: "Runtime bookkeeping emitted after a schedule run finishes.",
      payloadSchema: z.strictObject({
        slug: z.string().trim().min(1),
        outcome: z.enum(["succeeded", "failed"]),
        nextRunAt: z.number().int().nonnegative().nullable(),
      }),
    },
  },
  consumes: [
    ...standardProcessorBehavior.consumes,
    schedulingEventTypes.appendScheduled,
    schedulingEventTypes.scheduleConfigured,
    schedulingEventTypes.scheduleCancelled,
    schedulingEventTypes.scheduleExecutionStarted,
    schedulingEventTypes.scheduleExecutionFinished,
  ],
  emits: [
    ...standardProcessorBehavior.emits,
    schedulingEventTypes.scheduleConfigured,
    schedulingEventTypes.scheduleExecutionStarted,
    schedulingEventTypes.scheduleExecutionFinished,
  ],
  reduce({ contract, state, event }) {
    const nextState = standardProcessorBehavior.reduce({ state, event, contract });

    switch (event.type) {
      case CoreProcessorRegisteredEventType:
      case schedulingEventTypes.appendScheduled:
        return nextState;
      case schedulingEventTypes.scheduleConfigured:
        return {
          ...nextState,
          schedulesBySlug: {
            ...nextState.schedulesBySlug,
            [event.payload.slug]: {
              callback: event.payload.callback,
              payloadJson: event.payload.payloadJson ?? null,
              schedule: event.payload.schedule,
              nextRunAt: event.payload.nextRunAt,
              executionCount: 0,
              running: false,
              executionStartedAt: null,
              createdAt: Math.floor(new Date(event.createdAt).getTime() / 1000),
            },
          },
        };
      case schedulingEventTypes.scheduleCancelled: {
        if (!(event.payload.slug in nextState.schedulesBySlug)) return nextState;
        const schedulesBySlug = { ...nextState.schedulesBySlug };
        delete schedulesBySlug[event.payload.slug];
        return { ...nextState, schedulesBySlug };
      }
      case schedulingEventTypes.scheduleExecutionStarted: {
        const entry = nextState.schedulesBySlug[event.payload.slug];
        if (entry == null) return nextState;
        return {
          ...nextState,
          schedulesBySlug: {
            ...nextState.schedulesBySlug,
            [event.payload.slug]: {
              ...entry,
              running: true,
              executionStartedAt: event.payload.startedAt,
            },
          },
        };
      }
      case schedulingEventTypes.scheduleExecutionFinished: {
        const entry = nextState.schedulesBySlug[event.payload.slug];
        if (entry == null) return nextState;
        if (event.payload.nextRunAt == null) {
          const schedulesBySlug = { ...nextState.schedulesBySlug };
          delete schedulesBySlug[event.payload.slug];
          return { ...nextState, schedulesBySlug };
        }
        return {
          ...nextState,
          schedulesBySlug: {
            ...nextState.schedulesBySlug,
            [event.payload.slug]: {
              ...entry,
              nextRunAt: event.payload.nextRunAt,
              executionCount: entry.executionCount + 1,
              running: false,
              executionStartedAt: null,
            },
          },
        };
      }
      default:
        return assertNever(event);
    }
  },
});

export function reduceSchedulingEvents(args: {
  events: readonly StreamEvent[];
  state?: SchedulingState;
}) {
  return reduceProcessorEvents({
    contract: SchedulingProcessorContract,
    events: args.events,
    state: args.state,
  });
}

export function buildScheduleConfiguredPayloadFromAppendScheduledEvent(
  event: StreamEvent<
    typeof schedulingEventTypes.appendScheduled,
    z.output<
      (typeof SchedulingProcessorContract.events)[typeof schedulingEventTypes.appendScheduled]["payloadSchema"]
    >
  >,
) {
  return {
    slug: event.payload.slug,
    callback: "append" as const,
    payloadJson: JSON.stringify(event.payload.append),
    schedule: event.payload.schedule,
    nextRunAt: getInitialNextRunAt({
      baseDate: new Date(event.createdAt),
      schedule: event.payload.schedule,
    }),
  };
}

export function getAppendScheduledRewriteIdempotencyKey(
  event: Pick<StreamEvent, "streamPath" | "offset">,
) {
  return `scheduling:rewrite:${event.streamPath}:${event.offset}`;
}

export function getInitialNextRunAt(args: { baseDate: Date; schedule: StreamSchedule }) {
  switch (args.schedule.kind) {
    case "once-at":
      return Math.floor(new Date(args.schedule.at).getTime() / 1000);
    case "once-in":
      return Math.floor(args.baseDate.getTime() / 1000) + args.schedule.delaySeconds;
    case "every":
      return Math.floor(args.baseDate.getTime() / 1000) + args.schedule.intervalSeconds;
    case "cron": {
      const nextRun = new Cron(args.schedule.cron).nextRun(args.baseDate);
      if (nextRun == null) throw new Error(`Cron schedule has no next run: ${args.schedule.cron}`);
      return Math.floor(nextRun.getTime() / 1000);
    }
  }
}

export type SchedulingState = z.infer<typeof SchedulingProcessorContract.stateSchema>;
