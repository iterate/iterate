import { z } from "zod";
import type { StreamEvent, StreamEventInput } from "iterate/stream/processor";

const keyPart = z.string().min(1);
const normalizedKey = keyPart
  .max(200, "normalized schedule key exceeds 200 characters")
  .refine((value) => !(value in Object.prototype));
/** A pair scopes a local key to a facet instance (or another explicit owner). Scope is naming,
 *  not access control: the context-wide API can inspect and cancel every schedule. */
export const ScheduleKey = z
  .union([keyPart, z.tuple([keyPart, keyPart])])
  .transform((value) => (typeof value === "string" ? value : JSON.stringify(value)))
  .pipe(normalizedKey);
export type ScheduleKey = z.input<typeof ScheduleKey>;
// Inspection rows carry this same identity plus metadata; accept them wherever a receipt works.
export const ScheduleReceipt = z.object({
  key: normalizedKey,
  scheduledAtOffset: z.number().int().positive(),
});
export type ScheduleReceipt = z.infer<typeof ScheduleReceipt>;
// After the epoch: the native alarm refuses a time at or before it (and clamps a past one to now).
const instant = z.iso
  .datetime({ offset: true })
  .refine((value) => Date.parse(value) > 0, "invalid instant");
// Bound arithmetic and make the smallest recurring cadence explicit. Missed ticks coalesce.
const delay = z
  .number()
  .int()
  .min(0)
  .max(365 * 24 * 60 * 60 * 1000);
// An operator's control belongs to the operator's own transition. In particular a scheduled resume
// cannot release a paused stream: pause deliberately holds every scheduled append. The platform's
// own records are refused by `normalizeControlEvent` (core-processor.ts `PLATFORM_ONLY_EVENT_TYPES`),
// which runs over every scheduled event.
const operatorControlEvents = new Set([
  "events.iterate.com/itx/paused",
  "events.iterate.com/itx/resumed",
  "events.iterate.com/itx/subscription-delivery-resumed",
]);
const EventBody = z.strictObject({
  type: z
    .string()
    .min(1)
    .refine(
      (value) =>
        !value.startsWith("events.iterate.com/itx/schedule-") && !operatorControlEvents.has(value),
      "scheduling and operator control events cannot be scheduled",
    ),
  payload: z.record(z.string(), z.json()).optional(),
  metadata: z.record(z.string(), z.json()).optional(),
});

/** Same-context durable batches. Event identity and provenance are assigned at firing.
 *  A bounded definition keeps the core checkpoint and its live-state updates small. */
export const ScheduledAppendInput = z
  .strictObject({
    key: ScheduleKey,
    when: z.union([
      z.strictObject({ at: instant }),
      z.strictObject({ afterMs: delay }),
      z.strictObject({ everyMs: delay.min(1000) }),
    ]),
    events: z.array(EventBody).min(1).max(100),
  })
  .refine(
    (value) => JSON.stringify(value).length <= 64 * 1024,
    "schedule exceeds 65,536 serialized characters",
  );
export type ScheduledAppendInput = z.input<typeof ScheduledAppendInput>;

export const ScheduledAppendCancelled = z.strictObject({
  key: ScheduleKey,
  ifScheduledAtOffset: z.number().int().positive().optional(),
});
export type ScheduledAppendCancelled = z.infer<typeof ScheduledAppendCancelled>;
export const ScheduledAppendSettled = z.strictObject({
  key: ScheduleKey,
  scheduledAtOffset: z.number().int().positive(),
  at: instant.optional(),
  error: z.string().max(2000).optional(),
});
export type ScheduledAppendSettled = z.infer<typeof ScheduledAppendSettled>;

export type ScheduledAppend = z.output<typeof ScheduledAppendInput> & {
  nextAt: string;
  scheduledAtOffset: number;
  source?: StreamEventInput["source"];
  failure?: { error: string; offset: number };
};

/** A pure projection: replay never consults the clock or re-appends an occurrence. The payloads are
 *  read as `normalizeControlEvent` (core-processor.ts) parsed and stored them — the casts below name
 *  each schema's output shape. */
export function reduceScheduledAppends(
  schedules: Record<string, ScheduledAppend>,
  event: StreamEvent,
): Record<string, ScheduledAppend> {
  if (event.ephemeral) return schedules;
  switch (event.type) {
    case "events.iterate.com/itx/schedule-set": {
      const input = event.payload as z.output<typeof ScheduledAppendInput>;
      return {
        ...schedules,
        [input.key]: {
          ...input,
          nextAt:
            "at" in input.when
              ? input.when.at
              : new Date(
                  Date.parse(event.createdAt) +
                    ("afterMs" in input.when ? input.when.afterMs : input.when.everyMs),
                ).toISOString(),
          scheduledAtOffset: event.offset,
          source: event.source,
        },
      };
    }
    case "events.iterate.com/itx/schedule-cancelled": {
      const input = event.payload as ScheduledAppendCancelled;
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
    case "events.iterate.com/itx/schedule-fired":
    case "events.iterate.com/itx/schedule-failed": {
      const input = event.payload as ScheduledAppendSettled;
      const row = schedules[input.key];
      if (!row || row.scheduledAtOffset !== input.scheduledAtOffset) return schedules;
      if ("everyMs" in row.when && input.at !== row.nextAt) return schedules;
      const next = { ...schedules };
      if (event.type === "events.iterate.com/itx/schedule-failed")
        next[input.key] = {
          ...row,
          failure: { error: input.error || "scheduled append failed", offset: event.offset },
        };
      else if ("everyMs" in row.when) {
        const due = Date.parse(row.nextAt);
        const ticks =
          Math.floor(Math.max(0, Date.parse(event.createdAt) - due) / row.when.everyMs) + 1;
        next[input.key] = {
          ...row,
          nextAt: new Date(due + ticks * row.when.everyMs).toISOString(),
        };
      } else delete next[input.key];
      return next;
    }
    default:
      return schedules;
  }
}
