import {
  assertNever,
  buildProcessorIdempotencyKey,
  implementProcessor,
  type ProcessorStreamApi,
} from "../stream-processor.ts";
import { CoreProcessorRegisteredEventType } from "../core/contract.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";
import {
  buildScheduleConfiguredPayloadFromAppendScheduledEvent,
  getInitialNextRunAt,
  SchedulingProcessorContract,
  schedulingEventTypes,
  type StreamSchedule,
  type SchedulingState,
} from "./contract.ts";

const HUNG_INTERVAL_TIMEOUT_SECONDS = 30;

type SchedulingStreamApi = ProcessorStreamApi<typeof SchedulingProcessorContract>;

/**
 * Ordinary stream processor implementation for scheduling.
 *
 * This only rewrites user-facing `append-scheduled` events into canonical
 * `schedule-configured` state events. A concrete runner still owns how timers
 * or Durable Object alarms wake up and call `appendDueScheduledEvents(...)`.
 */
export function createSchedulingProcessor() {
  return implementProcessor(SchedulingProcessorContract, {
    async afterAppend({ event, state, streamApi }) {
      await standardProcessorBehavior.afterAppend({
        contract: SchedulingProcessorContract,
        state,
        streamApi,
      });

      switch (event.type) {
        case CoreProcessorRegisteredEventType:
        case schedulingEventTypes.scheduleConfigured:
        case schedulingEventTypes.scheduleCancelled:
        case schedulingEventTypes.scheduleExecutionStarted:
        case schedulingEventTypes.scheduleExecutionFinished:
          return;
        case schedulingEventTypes.appendScheduled:
          await streamApi.append({
            event: {
              type: schedulingEventTypes.scheduleConfigured,
              idempotencyKey: buildProcessorIdempotencyKey({
                processor: SchedulingProcessorContract,
                key: "append-scheduled-to-configured",
                sourceEvent: event,
              }),
              payload: buildScheduleConfiguredPayloadFromAppendScheduledEvent(event),
            },
          });
          return;
        default:
          return assertNever(event);
      }
    },
  });
}

export function getNextSchedulingWakeUpAtMs(args: { nowMs: number; state: SchedulingState }) {
  const nowSeconds = Math.floor(args.nowMs / 1000);
  const hungCutoff = nowSeconds - HUNG_INTERVAL_TIMEOUT_SECONDS;
  let nextWakeUpAtMs: number | null = null;

  for (const entry of Object.values(args.state.schedulesBySlug)) {
    if (entry.schedule.kind === "every" && entry.running) {
      const startedAt = entry.executionStartedAt;
      if (startedAt != null && startedAt > hungCutoff) {
        nextWakeUpAtMs = pickEarlierTimestampMs(
          nextWakeUpAtMs,
          startedAt * 1000 + HUNG_INTERVAL_TIMEOUT_SECONDS * 1000,
        );
        continue;
      }
    }

    nextWakeUpAtMs = pickEarlierTimestampMs(
      nextWakeUpAtMs,
      Math.max(entry.nextRunAt * 1000, args.nowMs + 1),
    );
  }

  return nextWakeUpAtMs;
}

/**
 * Append all schedules due at `nowMs`.
 *
 * Runners can call this from a Durable Object alarm, a Node timer, or a pull
 * loop. The processor stays deployable because the only dependency here is the
 * already-scoped `streamApi`.
 */
export async function appendDueScheduledEvents(args: {
  nowMs: number;
  state: SchedulingState;
  streamApi: SchedulingStreamApi;
}) {
  const nowSeconds = Math.floor(args.nowMs / 1000);

  for (const [slug, entry] of getDueSchedulerEntries({
    nowSeconds,
    state: args.state,
  })) {
    const parsedPayload = tryParseScheduledPayload(entry.payloadJson);
    if (!parsedPayload.ok) {
      await appendScheduleExecutionFinished({
        nextRunAt: null,
        outcome: "failed",
        slug,
        streamApi: args.streamApi,
      });
      continue;
    }

    if (entry.schedule.kind === "every") {
      await args.streamApi.append({
        event: {
          type: schedulingEventTypes.scheduleExecutionStarted,
          payload: { slug, startedAt: nowSeconds },
        },
      });
    }

    try {
      await args.streamApi.append({
        event: parsedPayload.value,
      });
      await appendScheduleExecutionFinished({
        nextRunAt: getNextRunAtAfterExecution({
          nowSeconds,
          outcome: "succeeded",
          schedule: entry.schedule,
        }),
        outcome: "succeeded",
        slug,
        streamApi: args.streamApi,
      });
    } catch {
      await appendScheduleExecutionFinished({
        nextRunAt: getNextRunAtAfterExecution({
          nowSeconds,
          outcome: "failed",
          schedule: entry.schedule,
        }),
        outcome: "failed",
        slug,
        streamApi: args.streamApi,
      });
    }
  }
}

function getDueSchedulerEntries(args: { nowSeconds: number; state: SchedulingState }) {
  const hungCutoff = args.nowSeconds - HUNG_INTERVAL_TIMEOUT_SECONDS;

  return Object.entries(args.state.schedulesBySlug)
    .filter(([, entry]) => {
      if (entry.nextRunAt > args.nowSeconds) return false;
      if (entry.schedule.kind !== "every" || !entry.running) return true;
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
  outcome: "succeeded" | "failed";
  schedule: StreamSchedule;
}) {
  if (args.schedule.kind === "once-at" || args.schedule.kind === "once-in") {
    return null;
  }

  if (args.schedule.kind === "every") {
    return args.nowSeconds + args.schedule.intervalSeconds;
  }

  try {
    return getInitialNextRunAt({
      baseDate: new Date(args.nowSeconds * 1000),
      schedule: args.schedule,
    });
  } catch {
    return null;
  }
}

function tryParseScheduledPayload(
  payloadJson: string | null,
): { ok: true; value: Parameters<SchedulingStreamApi["append"]>[0]["event"] } | { ok: false } {
  if (payloadJson == null) return { ok: false };

  try {
    return { ok: true, value: JSON.parse(payloadJson) };
  } catch {
    return { ok: false };
  }
}

async function appendScheduleExecutionFinished(args: {
  nextRunAt: number | null;
  outcome: "succeeded" | "failed";
  slug: string;
  streamApi: SchedulingStreamApi;
}) {
  await args.streamApi.append({
    event: {
      type: schedulingEventTypes.scheduleExecutionFinished,
      payload: {
        slug: args.slug,
        outcome: args.outcome,
        nextRunAt: args.nextRunAt,
      },
    },
  });
}

function pickEarlierTimestampMs(current: number | null, candidate: number) {
  return current == null ? candidate : Math.min(current, candidate);
}
