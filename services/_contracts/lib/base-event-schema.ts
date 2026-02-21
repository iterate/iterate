import * as z from "zod/v4";

export const ITERATE_EVENT_TYPE_PREFIX = "https://events.iterate.com/" as const;

export const IterateEventType = z.templateLiteral([ITERATE_EVENT_TYPE_PREFIX, z.string().min(1)]);
export type IterateEventType = z.infer<typeof IterateEventType>;

export const EventVersion = z.union([z.string(), z.number()]);
export type EventVersion = z.infer<typeof EventVersion>;

export const BaseEvent = z.object({
  type: IterateEventType,
  payload: z.record(z.string(), z.unknown()),
  version: EventVersion.optional(),
});
export type BaseEvent = z.infer<typeof BaseEvent>;

export const TraceContext = z.object({
  traceId: z.string(),
  spanId: z.string(),
  parentSpanId: z.string().nullable(),
});
export type TraceContext = z.infer<typeof TraceContext>;

export const StoredEvent = BaseEvent.extend({
  path: z.string().min(1),
  offset: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
  trace: TraceContext,
});
export type StoredEvent = z.infer<typeof StoredEvent>;

export const typedEvent = <
  TType extends `${typeof ITERATE_EVENT_TYPE_PREFIX}${string}`,
  TPayload extends z.ZodType<Record<string, unknown>>,
>(
  type: TType,
  payload: TPayload,
) =>
  BaseEvent.extend({
    type: z.literal(type),
    payload,
  });
