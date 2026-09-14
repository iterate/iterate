import { z } from "zod";
import type { StreamEvent, StreamEventInput } from "./processor.ts";

const key = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !(value in Object.prototype));
// Lifecycle and recovery facts belong to their runtime transitions. In particular a scheduled
// resume cannot release a paused stream: pause deliberately holds every scheduled append.
const runtimeEvents = new Set([
  "events.iterate.com/stream/created",
  "events.iterate.com/stream/woken",
  "events.iterate.com/stream/paused",
  "events.iterate.com/stream/resumed",
  "events.iterate.com/stream/self-wake-halted",
  "events.iterate.com/stream/subscription-delivery-halted",
  "events.iterate.com/stream/subscription-delivery-resumed",
]);
const EventBody = z.strictObject({
  type: z
    .string()
    .min(1)
    .refine(
      (value) =>
        !value.startsWith("events.iterate.com/stream/append-schedule") && !runtimeEvents.has(value),
      "runtime scheduling/lifecycle events cannot be scheduled",
    ),
  payload: z.record(z.string(), z.json()).optional(),
  metadata: z.record(z.string(), z.json()).optional(),
});

/** One-shot, same-context durable batches. Event identity and provenance are assigned at firing.
 *  A bounded definition keeps the core checkpoint and its live-state updates small. */
export const ScheduledAppendInput = z
  .strictObject({
    key,
    when: z.strictObject({
      at: z.iso
        .datetime({ offset: true })
        .refine((value) => Number.isFinite(Date.parse(value)), "invalid instant"),
    }),
    events: z.array(EventBody).min(1).max(100),
  })
  .refine(
    (value) => JSON.stringify(value).length <= 64 * 1024,
    "schedule exceeds 65,536 serialized characters",
  );
export type ScheduledAppendInput = z.infer<typeof ScheduledAppendInput>;

export const ScheduledAppendCancelled = z.strictObject({
  key,
  ifScheduledAtOffset: z.number().int().positive().optional(),
});
export const ScheduledAppendSettled = z.strictObject({
  key,
  scheduledAtOffset: z.number().int().positive(),
  error: z.string().max(2000).optional(),
});

export type ScheduledAppend = ScheduledAppendInput & {
  scheduledAtOffset: number;
  source?: StreamEventInput["source"];
  failure?: { error: string; offset: number };
};

/** A pure projection: replay never consults the clock or re-appends an occurrence. */
export function reduceScheduledAppends(
  schedules: Record<string, ScheduledAppend>,
  event: StreamEvent,
): Record<string, ScheduledAppend> {
  if (event.ephemeral) return schedules;
  switch (event.type) {
    case "events.iterate.com/stream/append-scheduled": {
      const input = ScheduledAppendInput.parse(event.payload);
      return {
        ...schedules,
        [input.key]: {
          ...input,
          scheduledAtOffset: event.offset,
          source: event.source,
        },
      };
    }
    case "events.iterate.com/stream/append-schedule-cancelled": {
      const input = ScheduledAppendCancelled.parse(event.payload);
      const row = schedules[input.key];
      if (
        !row ||
        (input.ifScheduledAtOffset && input.ifScheduledAtOffset !== row.scheduledAtOffset)
      )
        return schedules;
      const next = { ...schedules };
      delete next[input.key];
      return next;
    }
    case "events.iterate.com/stream/append-schedule-completed":
    case "events.iterate.com/stream/append-schedule-failed": {
      const input = ScheduledAppendSettled.parse(event.payload);
      const row = schedules[input.key];
      if (!row || row.scheduledAtOffset !== input.scheduledAtOffset) return schedules;
      const next = { ...schedules };
      if (event.type === "events.iterate.com/stream/append-schedule-failed")
        next[input.key] = {
          ...row,
          failure: { error: input.error || "scheduled append failed", offset: event.offset },
        };
      else delete next[input.key];
      return next;
    }
    default:
      return schedules;
  }
}
