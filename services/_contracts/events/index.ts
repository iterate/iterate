import { eventIterator, oc } from "@orpc/contract";
import { oz } from "@orpc/zod";
import { JSON_SCHEMA_REGISTRY } from "@orpc/zod/zod4";
import * as z from "zod/v4";
import {
  ITERATE_EVENT_TYPE_PREFIX,
  IterateEventType,
  typedEvent,
} from "../lib/base-event-schema.ts";
import packageJson from "../package.json" with { type: "json" };

export const StreamPath = z.string().min(1);
export type StreamPath = z.infer<typeof StreamPath>;

export const Offset = z.string().min(1);
export type Offset = z.infer<typeof Offset>;

export const CreatedAt = z.string().datetime({ offset: true });
export type CreatedAt = z.infer<typeof CreatedAt>;

export const Version = z.union([z.string(), z.number()]);
export type Version = z.infer<typeof Version>;

const TraceContext = z.object({
  traceId: z.string(),
  spanId: z.string(),
  parentSpanId: z.string().nullable(),
});

const PlainUnknownRecord = z.record(z.string(), z.unknown());
const PlainStringRecord = z.record(z.string().min(1), z.string());
const orpcUrlSchema = oz.url();

export const CallbackURL = z.url().refine((value) => {
  const parsed = new URL(value);
  return orpcUrlSchema.safeParse(parsed).success;
}, "Invalid URL");
export type CallbackURL = z.infer<typeof CallbackURL>;

export const PUSH_SUBSCRIPTION_CALLBACK_ADDED_TYPE =
  `${ITERATE_EVENT_TYPE_PREFIX}events/stream/push-subscription-callback-added` as const;
export const STREAM_CREATED_TYPE = `${ITERATE_EVENT_TYPE_PREFIX}events/stream/created` as const;
export const STREAM_METADATA_UPDATED_TYPE =
  `${ITERATE_EVENT_TYPE_PREFIX}events/stream/metadata-updated` as const;

const RetryPolicyScheduleFixed = z.object({
  type: z.literal("fixed"),
  intervalMs: z.number().int().min(0),
});
const RetryPolicyScheduleExponential = z.object({
  type: z.literal("exponential"),
  baseMs: z.number().int().min(0),
  factor: z.number().min(1),
  maxMs: z.number().int().min(0).optional(),
});

export const PushSubscriptionRetrySchedule = z.discriminatedUnion("type", [
  RetryPolicyScheduleFixed,
  RetryPolicyScheduleExponential,
]);
export type PushSubscriptionRetrySchedule = z.infer<typeof PushSubscriptionRetrySchedule>;

export const PushSubscriptionRetryPolicy = z.object({
  times: z.number().int().min(0).optional(),
  schedule: PushSubscriptionRetrySchedule.optional(),
});
export type PushSubscriptionRetryPolicy = z.infer<typeof PushSubscriptionRetryPolicy>;

const PushSubscriptionType = z.enum([
  "webhook",
  "webhook-with-ack",
  "websocket",
  "websocket-with-ack",
]);

export const PushSubscriptionCallbackAddedPayload = z.object({
  type: PushSubscriptionType,
  URL: CallbackURL,
  subscriptionSlug: z.string().min(1),
  retryPolicy: PushSubscriptionRetryPolicy.optional(),
  jsonataFilter: z.string().min(1).optional(),
  jsonataTransform: z.string().min(1).optional(),
  httpRequestHeaders: PlainStringRecord.optional(),
  sendHistoricEventsFromOffset: Offset.optional(),
});
export type PushSubscriptionCallbackAddedPayload = z.infer<
  typeof PushSubscriptionCallbackAddedPayload
>;

export const StreamMetadataUpdatedPayload = z.object({
  metadata: PlainUnknownRecord,
});
export type StreamMetadataUpdatedPayload = z.infer<typeof StreamMetadataUpdatedPayload>;

export const StreamCreatedPayload = z.object({
  path: StreamPath,
});
export type StreamCreatedPayload = z.infer<typeof StreamCreatedPayload>;

export const PushSubscriptionCallbackAddedEvent = typedEvent(
  PUSH_SUBSCRIPTION_CALLBACK_ADDED_TYPE,
  PushSubscriptionCallbackAddedPayload,
);
export type PushSubscriptionCallbackAddedEvent = z.infer<typeof PushSubscriptionCallbackAddedEvent>;

export const StreamCreatedEvent = typedEvent(STREAM_CREATED_TYPE, StreamCreatedPayload);
export type StreamCreatedEvent = z.infer<typeof StreamCreatedEvent>;

export const StreamMetadataUpdatedEvent = typedEvent(
  STREAM_METADATA_UPDATED_TYPE,
  StreamMetadataUpdatedPayload,
);
export type StreamMetadataUpdatedEvent = z.infer<typeof StreamMetadataUpdatedEvent>;

const StreamEventInput = z.object({
  type: IterateEventType,
  payload: PlainUnknownRecord,
  version: Version.optional(),
});

export const StreamEvent = StreamEventInput.extend({
  path: StreamPath,
  offset: Offset,
  createdAt: CreatedAt,
  trace: TraceContext,
});
export type StreamEvent = z.infer<typeof StreamEvent>;

export const StreamSummary = z.object({
  path: StreamPath,
  createdAt: CreatedAt,
  eventCount: z.number().int().min(0),
  lastEventCreatedAt: CreatedAt,
  metadata: PlainUnknownRecord,
});
export type StreamSummary = z.infer<typeof StreamSummary>;

const StreamQuery = z.object({
  path: StreamPath,
  offset: Offset.optional(),
  live: z.boolean().optional(),
});

JSON_SCHEMA_REGISTRY.add(StreamEventInput, {
  description: "Event payload accepted by append operations",
  examples: [
    {
      type: "https://events.iterate.com/events/example/value-recorded",
      payload: { value: 42 },
      version: "1",
    },
  ],
});

JSON_SCHEMA_REGISTRY.add(StreamEvent, {
  description: "Stored stream event with path, offset, trace, and timestamp",
  examples: [
    {
      path: "/projects/demo/events",
      offset: "0000000000000001",
      type: "https://events.iterate.com/events/example/value-recorded",
      payload: { value: 42 },
      version: "1",
      createdAt: "2026-01-01T00:00:00.000Z",
      trace: {
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: "b7ad6b7169203331",
        parentSpanId: null,
      },
    },
  ],
});

JSON_SCHEMA_REGISTRY.add(StreamSummary, {
  description: "High-level stream summary used by listStreams",
  examples: [
    {
      path: "/projects/demo/events",
      createdAt: "2026-01-01T00:00:00.000Z",
      eventCount: 1,
      lastEventCreatedAt: "2026-01-01T00:00:00.000Z",
      metadata: { environment: "dev" },
    },
  ],
});

JSON_SCHEMA_REGISTRY.add(PushSubscriptionCallbackAddedPayload, {
  description: "Push subscription registration payload",
  examples: [
    {
      type: "webhook",
      URL: "https://example.com/webhook",
      subscriptionSlug: "main",
      retryPolicy: {
        times: 3,
        schedule: { type: "fixed", intervalMs: 250 },
      },
    },
  ],
});

export const parsePushSubscriptionCallbackAddedPayload = (
  input: unknown,
): PushSubscriptionCallbackAddedPayload | undefined => {
  const result = PushSubscriptionCallbackAddedPayload.safeParse(input);
  return result.success ? result.data : undefined;
};

export const parseStreamMetadataUpdatedPayload = (
  input: unknown,
): StreamMetadataUpdatedPayload | undefined => {
  const result = StreamMetadataUpdatedPayload.safeParse(input);
  return result.success ? result.data : undefined;
};

export const eventBusContract = oc.router({
  append: oc
    .route({
      operationId: "appendStreamEvents",
      method: "POST",
      path: "/streams/{+path}",
      successStatus: 204,
      successDescription: "Events appended successfully",
      summary: "Append one or more events to a stream",
      description: "Appends events to a stream in order.",
      tags: ["Streams"],
    })
    .input(
      z.object({
        path: StreamPath,
        events: z.array(StreamEventInput).min(1),
      }),
    )
    .output(z.void()),
  subscribe: oc
    .route({
      operationId: "registerPushSubscription",
      method: "POST",
      path: "/streams/{+path}/subscribe",
      successStatus: 204,
      successDescription: "Subscription registration event appended",
      summary: "Register a push subscription by appending an event",
      description: "Appends a subscription registration event to the target stream.",
      tags: ["Subscriptions"],
    })
    .input(
      z.object({
        path: StreamPath,
        subscription: PushSubscriptionCallbackAddedPayload,
      }),
    )
    .output(z.void()),
  ackOffset: oc
    .route({
      operationId: "acknowledgeSubscriptionOffset",
      method: "POST",
      path: "/streams/{+path}/subscriptions/{subscriptionSlug}/ack",
      successStatus: 204,
      successDescription: "Offset acknowledged",
      summary: "Acknowledge delivery of a specific offset for a push subscription",
      description: "Records the last-delivered offset for the given subscription.",
      tags: ["Subscriptions"],
    })
    .input(
      z.object({
        path: StreamPath,
        subscriptionSlug: z.string().min(1),
        offset: Offset,
      }),
    )
    .output(z.void()),
  stream: oc
    .route({
      operationId: "streamEvents",
      method: "GET",
      path: "/streams/{+path}",
      summary: "Read stream history and optionally stay subscribed for live events",
      description: "Reads historical events and can keep the connection open for live events.",
      tags: ["Streams"],
    })
    .input(StreamQuery)
    .output(eventIterator(StreamEvent)),
  listStreams: oc
    .route({
      operationId: "listStreams",
      summary: "List streams with counts, recency, and metadata",
      description: "Returns known streams and metadata useful for dashboards.",
      tags: ["Streams"],
    })
    .input(z.strictObject({}).optional())
    .output(z.array(StreamSummary)),
});

const nonEmptyStringWithTrimDefault = (defaultValue: string) =>
  z
    .preprocess((value) => {
      if (typeof value !== "string") return value;
      const trimmed = value.trim();
      return trimmed.length === 0 ? undefined : trimmed;
    }, z.string().min(1).optional())
    .default(defaultValue);

export const EventsServiceEnv = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(17301),
  DATABASE_URL: nonEmptyStringWithTrimDefault("events.sqlite"),
  ITERATE_EVENTS_WS_IDLE_DISCONNECT_MS: z.coerce.number().int().min(0).default(30_000),
});
export type EventsServiceEnv = z.infer<typeof EventsServiceEnv>;

export const serviceManifest = {
  name: packageJson.name,
  slug: "events",
  version: packageJson.version,
  port: 17301,
  orpcContract: eventBusContract,
  envVars: EventsServiceEnv,
  // Wildcard ownership is intentionally simple for now. We expect a dedicated design
  // for ownership expressions once multiple services start declaring broader patterns.
  ownedEventStreamPaths: ["events/_meta"] as const,
  ownedEventSchemas: [
    PushSubscriptionCallbackAddedEvent,
    StreamCreatedEvent,
    StreamMetadataUpdatedEvent,
  ] as const,
} as const;

export type EventBusContract = typeof eventBusContract;
