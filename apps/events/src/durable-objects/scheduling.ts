import { parseCronExpression } from "cron-schedule";
import {
  type Event,
  type EventInput,
  type SchedulerState,
  SCHEDULE_CANCELLED_TYPE,
  SCHEDULE_CONFIGURED_TYPE,
  SCHEDULE_INTERNAL_EXECUTION_FINISHED_TYPE,
  SCHEDULE_INTERNAL_EXECUTION_STARTED_TYPE,
  type ScheduleConfiguredPayload,
  ScheduleConfiguredPayload as ScheduleConfiguredPayloadSchema,
  type ScheduleInternalExecutionFinishedPayload,
  ScheduleInternalExecutionFinishedPayload as ScheduleInternalExecutionFinishedPayloadSchema,
  type ScheduleInternalExecutionStartedPayload,
  ScheduleInternalExecutionStartedPayload as ScheduleInternalExecutionStartedPayloadSchema,
  type StreamAppendScheduledPayload,
  StreamAppendScheduledPayload as StreamAppendScheduledPayloadSchema,
  type StreamSchedule,
} from "@iterate-com/events-contract";
import { defineBuiltinProcessor } from "@iterate-com/events-contract/sdk";

/**
 * This file owns the scheduler runtime for `apps/events`.
 *
 * The important architectural choice is that scheduling is reduced from stream
 * events into `state.processors.scheduler`. We do not keep a second SQLite
 * projection table. The single Durable Object alarm is just a derived wake-up
 * pointer into that reduced state.
 *
 * The event split is intentional:
 *
 * - `append-scheduled` is ergonomic user intent
 * - `schedule/configured` is the canonical low-level upsert event
 * - `schedule/internal/*` are durable runtime bookkeeping events
 *
 * `append-scheduled` and `schedule/configured` intentionally share the same
 * `schedule` shape so the public API and the reducer talk about schedules
 * using one vocabulary.
 *
 * First-party references for the alarm model:
 *
 * - Durable Object alarms:
 *   https://developers.cloudflare.com/durable-objects/api/alarms/
 * - Durable Object state lifecycle:
 *   https://developers.cloudflare.com/durable-objects/api/state/
 * - Cloudflare Agents schedule tasks:
 *   https://developers.cloudflare.com/agents/api-reference/schedule-tasks/
 */
export const HUNG_INTERVAL_TIMEOUT_SECONDS = 30;

export const schedulingProcessor = defineBuiltinProcessor<SchedulerState>(() => ({
  slug: "scheduler",
  initialState: {},

  reduce({ event, state }) {
    return reduceSchedulerState({
      event,
      schedulerState: state,
    });
  },

  async afterAppend({ append, event }) {
    if (event.type !== "https://events.iterate.com/events/stream/append-scheduled") {
      return;
    }

    await append({
      type: SCHEDULE_CONFIGURED_TYPE,
      payload: lowerAppendScheduledEvent(event),
      idempotencyKey: getAppendScheduledRewriteIdempotencyKey(event),
    });
  },
}));

export function isSchedulerAlarmEventType(type: string) {
  return (
    type === SCHEDULE_CONFIGURED_TYPE ||
    type === SCHEDULE_CANCELLED_TYPE ||
    type === SCHEDULE_INTERNAL_EXECUTION_STARTED_TYPE ||
    type === SCHEDULE_INTERNAL_EXECUTION_FINISHED_TYPE
  );
}

export async function repointSchedulerAlarm(args: {
  ctx: DurableObjectState;
  schedulerState: SchedulerState;
}) {
  const nextAlarmAtMs = getNextSchedulerAlarmAtMs({
    nowMs: Date.now(),
    schedulerState: args.schedulerState,
  });

  if (nextAlarmAtMs == null) {
    await args.ctx.storage.deleteAlarm();
    return;
  }

  await args.ctx.storage.setAlarm(nextAlarmAtMs);
}

export async function runSchedulerAlarm(args: {
  append(event: EventInput): Event | Promise<Event>;
  ctx: DurableObjectState;
  getSchedulerState(): SchedulerState;
  instance: object;
}) {
  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  const dueEntries = getDueSchedulerEntries({
    nowSeconds,
    schedulerState: args.getSchedulerState(),
  });

  for (const [slug, entry] of dueEntries) {
    const invalidPayloadOutcome = tryParseScheduledPayload(entry.payloadJson);
    if (invalidPayloadOutcome.ok === false) {
      await appendScheduleExecutionFinished({
        append: args.append,
        outcome: "failed",
        nextRunAt: null,
        slug,
      });
      continue;
    }

    const callback = Reflect.get(args.instance, entry.callback);
    if (typeof callback !== "function") {
      await appendScheduleExecutionFinished({
        append: args.append,
        outcome: "failed",
        nextRunAt: null,
        slug,
      });
      continue;
    }

    if (entry.schedule.kind === "every") {
      await args.append({
        type: SCHEDULE_INTERNAL_EXECUTION_STARTED_TYPE,
        payload: {
          slug,
          startedAt: nowSeconds,
        } satisfies ScheduleInternalExecutionStartedPayload,
      });
    }

    let outcome: ScheduleInternalExecutionFinishedPayload["outcome"] = "succeeded";
    try {
      await callback.call(args.instance, invalidPayloadOutcome.value, {
        callback: entry.callback,
        createdAt: entry.createdAt,
        nextRunAt: entry.nextRunAt,
        payload: invalidPayloadOutcome.value,
        running: entry.running,
        schedule: entry.schedule,
        slug,
      });
    } catch {
      outcome = "failed";
    }

    await appendScheduleExecutionFinished({
      append: args.append,
      outcome,
      nextRunAt: getNextRunAtAfterExecution({
        nowSeconds,
        outcome,
        schedule: entry.schedule,
      }),
      slug,
    });
  }

  await repointSchedulerAlarm({
    ctx: args.ctx,
    schedulerState: args.getSchedulerState(),
  });
}

function reduceSchedulerState(args: {
  event: Event;
  schedulerState: SchedulerState;
}): SchedulerState {
  switch (args.event.type) {
    case SCHEDULE_CONFIGURED_TYPE: {
      const payload = ScheduleConfiguredPayloadSchema.parse(args.event.payload);
      return {
        ...args.schedulerState,
        [payload.slug]: {
          callback: payload.callback,
          payloadJson: payload.payloadJson ?? null,
          schedule: payload.schedule,
          nextRunAt: payload.nextRunAt,
          running: false,
          executionStartedAt: null,
          createdAt: Math.floor(new Date(args.event.createdAt).getTime() / 1000),
        },
      };
    }
    case SCHEDULE_CANCELLED_TYPE: {
      const payload = args.event.payload as { slug: string };
      if (!(payload.slug in args.schedulerState)) {
        return args.schedulerState;
      }

      const nextState = { ...args.schedulerState };
      delete nextState[payload.slug];
      return nextState;
    }
    case SCHEDULE_INTERNAL_EXECUTION_STARTED_TYPE: {
      const payload = ScheduleInternalExecutionStartedPayloadSchema.parse(args.event.payload);
      const entry = args.schedulerState[payload.slug];
      if (entry == null) {
        return args.schedulerState;
      }

      return {
        ...args.schedulerState,
        [payload.slug]: {
          ...entry,
          running: true,
          executionStartedAt: payload.startedAt,
        },
      };
    }
    case SCHEDULE_INTERNAL_EXECUTION_FINISHED_TYPE: {
      const payload = ScheduleInternalExecutionFinishedPayloadSchema.parse(args.event.payload);
      const entry = args.schedulerState[payload.slug];
      if (entry == null) {
        return args.schedulerState;
      }

      if (payload.nextRunAt == null) {
        const nextState = { ...args.schedulerState };
        delete nextState[payload.slug];
        return nextState;
      }

      return {
        ...args.schedulerState,
        [payload.slug]: {
          ...entry,
          nextRunAt: payload.nextRunAt,
          running: false,
          executionStartedAt: null,
        },
      };
    }
    default:
      return args.schedulerState;
  }
}

function lowerAppendScheduledEvent(event: Event): ScheduleConfiguredPayload {
  const payload = StreamAppendScheduledPayloadSchema.parse(event.payload);
  const createdAt = new Date(event.createdAt);

  return {
    slug: payload.slug,
    callback: "append",
    payloadJson: JSON.stringify(payload.append),
    schedule: payload.schedule,
    nextRunAt: getInitialNextRunAt({
      baseDate: createdAt,
      schedule: payload.schedule,
    }),
  };
}

function getAppendScheduledRewriteIdempotencyKey(event: Event) {
  return `scheduler:rewrite:${event.streamPath}:${event.offset}`;
}

function getInitialNextRunAt(args: { baseDate: Date; schedule: StreamSchedule }) {
  switch (args.schedule.kind) {
    case "once-at":
      return Math.floor(new Date(args.schedule.at).getTime() / 1000);
    case "once-in":
      return Math.floor(args.baseDate.getTime() / 1000) + args.schedule.delaySeconds;
    case "every":
      return Math.floor(args.baseDate.getTime() / 1000) + args.schedule.intervalSeconds;
    case "cron":
      return Math.floor(getNextCronTime(args.schedule.cron, args.baseDate).getTime() / 1000);
  }
}

function getNextSchedulerAlarmAtMs(args: { nowMs: number; schedulerState: SchedulerState }) {
  const nowSeconds = Math.floor(args.nowMs / 1000);
  const hungCutoff = nowSeconds - HUNG_INTERVAL_TIMEOUT_SECONDS;
  let nextAlarmAtMs: number | null = null;

  for (const entry of Object.values(args.schedulerState)) {
    if (entry.schedule.kind === "every" && entry.running) {
      const startedAt = entry.executionStartedAt;
      if (startedAt != null && startedAt > hungCutoff) {
        const recoveryAtMs = startedAt * 1000 + HUNG_INTERVAL_TIMEOUT_SECONDS * 1000;
        nextAlarmAtMs = pickEarlierTimestampMs(nextAlarmAtMs, recoveryAtMs);
        continue;
      }
    }

    nextAlarmAtMs = pickEarlierTimestampMs(
      nextAlarmAtMs,
      Math.max(entry.nextRunAt * 1000, args.nowMs + 1),
    );
  }

  return nextAlarmAtMs;
}

function getDueSchedulerEntries(args: { nowSeconds: number; schedulerState: SchedulerState }) {
  const hungCutoff = args.nowSeconds - HUNG_INTERVAL_TIMEOUT_SECONDS;

  return Object.entries(args.schedulerState)
    .filter(([, entry]) => {
      if (entry.nextRunAt > args.nowSeconds) {
        return false;
      }

      if (entry.schedule.kind !== "every" || entry.running === false) {
        return true;
      }

      return entry.executionStartedAt == null || entry.executionStartedAt <= hungCutoff;
    })
    .sort((left, right) => {
      const leftEntry = left[1];
      const rightEntry = right[1];
      return (
        leftEntry.nextRunAt - rightEntry.nextRunAt || leftEntry.createdAt - rightEntry.createdAt
      );
    });
}

function getNextRunAtAfterExecution(args: {
  nowSeconds: number;
  outcome: ScheduleInternalExecutionFinishedPayload["outcome"];
  schedule: StreamSchedule;
}) {
  if (args.schedule.kind === "once-at" || args.schedule.kind === "once-in") {
    return null;
  }

  if (args.schedule.kind === "every") {
    return args.nowSeconds + args.schedule.intervalSeconds;
  }

  try {
    return Math.floor(getNextCronTime(args.schedule.cron).getTime() / 1000);
  } catch {
    return args.outcome === "failed" ? null : null;
  }
}

function tryParseScheduledPayload(payloadJson: string | null) {
  if (payloadJson == null) {
    return { ok: true as const, value: undefined };
  }

  try {
    return { ok: true as const, value: JSON.parse(payloadJson) };
  } catch {
    return { ok: false as const };
  }
}

async function appendScheduleExecutionFinished(args: {
  append(event: EventInput): Event | Promise<Event>;
  outcome: ScheduleInternalExecutionFinishedPayload["outcome"];
  nextRunAt: number | null;
  slug: string;
}) {
  await args.append({
    type: SCHEDULE_INTERNAL_EXECUTION_FINISHED_TYPE,
    payload: {
      slug: args.slug,
      outcome: args.outcome,
      nextRunAt: args.nextRunAt,
    } satisfies ScheduleInternalExecutionFinishedPayload,
  });
}

function getNextCronTime(cron: string, startDate?: Date) {
  return parseCronExpression(cron).getNextDate(startDate);
}

function pickEarlierTimestampMs(current: number | null, candidate: number) {
  if (current == null) {
    return candidate;
  }

  return Math.min(current, candidate);
}
