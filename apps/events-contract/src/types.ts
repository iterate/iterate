import { z } from "zod";
import {
  EventTypeSchema,
  GenericEvent as GenericEventBase,
  GenericEventInput as GenericEventInputBase,
  JSONObject,
  StreamPath,
} from "./event-base-types.ts";
import {
  CircuitBreakerState,
  StreamPausedEvent,
  StreamPausedEventInput,
  StreamResumedEvent,
  StreamResumedEventInput,
} from "./circuit-breaker-types.ts";
import {
  ExternalSubscriberState,
  StreamSubscriptionConfiguredEvent,
  StreamSubscriptionConfiguredEventInput,
} from "./external-subscriber-types.ts";
import {
  JsonataTransformerConfiguredEvent,
  JsonataTransformerConfiguredEventInput,
  JsonataTransformerState,
} from "./jsonata-transformer-types.ts";
import {
  DynamicWorkerState,
  DynamicWorkerConfiguredEventInput,
  DynamicWorkerConfiguredEvent,
} from "./dynamic-worker-types.ts";
import {
  ScheduleConfiguredEvent,
  ScheduleConfiguredEventInput,
  ScheduleCancelledEvent,
  ScheduleCancelledEventInput,
  ScheduleInternalExecutionFinishedEvent,
  ScheduleInternalExecutionFinishedEventInput,
  ScheduleInternalExecutionStartedEvent,
  ScheduleInternalExecutionStartedEventInput,
  SchedulerState,
  StreamAppendScheduledEvent,
  StreamAppendScheduledEventInput,
} from "./scheduling-types.ts";

export { JSONObject, StreamPath };

export const ProjectSlug = z.string().trim().min(1).max(255);
export type ProjectSlug = z.infer<typeof ProjectSlug>;

const StreamInitializedEventInput = GenericEventInputBase.extend({
  type: z.literal("https://events.iterate.com/events/stream/initialized"),
  payload: z.strictObject({
    projectSlug: ProjectSlug,
    path: StreamPath,
  }),
});
export const StreamInitializedEvent = GenericEventBase.extend(
  StreamInitializedEventInput.pick({ type: true, payload: true }).shape,
);
export type StreamInitializedEvent = z.infer<typeof StreamInitializedEvent>;

const StreamDurableObjectConstructedEventInput = GenericEventInputBase.extend({
  type: z.literal("https://events.iterate.com/events/stream/durable-object-constructed"),
  payload: z.strictObject({}),
});
const StreamDurableObjectConstructedEvent = GenericEventBase.extend(
  StreamDurableObjectConstructedEventInput.pick({ type: true, payload: true }).shape,
);
type StreamDurableObjectConstructedEventInput = z.infer<
  typeof StreamDurableObjectConstructedEventInput
>;
type StreamDurableObjectConstructedEvent = z.infer<typeof StreamDurableObjectConstructedEvent>;

const ChildStreamCreatedEventInput = GenericEventInputBase.extend({
  type: z.literal("https://events.iterate.com/events/stream/child-stream-created"),
  payload: z.strictObject({
    childPath: StreamPath,
  }),
});
export const ChildStreamCreatedEvent = GenericEventBase.extend(
  ChildStreamCreatedEventInput.pick({ type: true, payload: true }).shape,
);
export type ChildStreamCreatedEvent = z.infer<typeof ChildStreamCreatedEvent>;

export const StreamMetadataUpdatedEventInput = GenericEventInputBase.extend({
  type: z.literal("https://events.iterate.com/events/stream/metadata-updated"),
  payload: z.strictObject({
    metadata: JSONObject,
  }),
});
export const StreamMetadataUpdatedEvent = GenericEventBase.extend(
  StreamMetadataUpdatedEventInput.pick({ type: true, payload: true }).shape,
);
export type StreamMetadataUpdatedEventInput = z.infer<typeof StreamMetadataUpdatedEventInput>;
export type StreamMetadataUpdatedEvent = z.infer<typeof StreamMetadataUpdatedEvent>;

const ErrorOccurredEventInput = GenericEventInputBase.extend({
  type: z.literal("https://events.iterate.com/events/stream/error-occurred"),
  payload: z.strictObject({
    message: z.string().trim().min(1),
  }),
});
export const ErrorOccurredEvent = GenericEventBase.extend(
  ErrorOccurredEventInput.pick({ type: true, payload: true }).shape,
);
export type ErrorOccurredEvent = z.infer<typeof ErrorOccurredEvent>;

export const InvalidEventAppendedEventInput = GenericEventInputBase.extend({
  type: z.literal("https://events.iterate.com/events/stream/invalid-event-appended"),
  payload: z.strictObject({
    rawInput: z.json(),
    error: z.string().trim().min(1),
  }),
});
const InvalidEventAppendedEvent = GenericEventBase.extend(
  InvalidEventAppendedEventInput.pick({ type: true, payload: true }).shape,
);
export type InvalidEventAppendedEventInput = z.infer<typeof InvalidEventAppendedEventInput>;
type InvalidEventAppendedEvent = z.infer<typeof InvalidEventAppendedEvent>;

const builtInEventInputOptions = [
  StreamInitializedEventInput,
  StreamDurableObjectConstructedEventInput,
  ChildStreamCreatedEventInput,
  StreamMetadataUpdatedEventInput,
  StreamSubscriptionConfiguredEventInput,
  ErrorOccurredEventInput,
  InvalidEventAppendedEventInput,
  StreamAppendScheduledEventInput,
  ScheduleConfiguredEventInput,
  ScheduleCancelledEventInput,
  ScheduleInternalExecutionStartedEventInput,
  ScheduleInternalExecutionFinishedEventInput,
  JsonataTransformerConfiguredEventInput,
  DynamicWorkerConfiguredEventInput,
  StreamPausedEventInput,
  StreamResumedEventInput,
] as const;

const builtInEventOptions = [
  StreamInitializedEvent,
  StreamDurableObjectConstructedEvent,
  ChildStreamCreatedEvent,
  StreamMetadataUpdatedEvent,
  StreamSubscriptionConfiguredEvent,
  ErrorOccurredEvent,
  InvalidEventAppendedEvent,
  StreamAppendScheduledEvent,
  ScheduleConfiguredEvent,
  ScheduleCancelledEvent,
  ScheduleInternalExecutionStartedEvent,
  ScheduleInternalExecutionFinishedEvent,
  JsonataTransformerConfiguredEvent,
  DynamicWorkerConfiguredEvent,
  StreamPausedEvent,
  StreamResumedEvent,
] as const;
const [firstBuiltInType, ...restBuiltInTypes] = builtInEventInputOptions.map(
  (schema) => schema.shape.type,
);
export const BuiltInEventType = z.union([firstBuiltInType, ...restBuiltInTypes]);

const GenericEventType = EventTypeSchema.refine(
  (value) => !BuiltInEventType.safeParse(value).success,
  {
    message: "Built-in event types must use their built-in payload schema.",
  },
);

export const GenericEventInput = GenericEventInputBase.extend({
  type: GenericEventType,
});
export const GenericEvent = GenericEventBase.extend({
  type: GenericEventType,
});

export const BuiltInEventInput = z.discriminatedUnion("type", builtInEventInputOptions);
export const BuiltInEvent = z.discriminatedUnion("type", builtInEventOptions);
export type BuiltInEventInput = z.infer<typeof BuiltInEventInput>;
export type BuiltInEvent = z.infer<typeof BuiltInEvent>;

type WithAutocompleteEventType<T extends { type: string }> = Omit<T, "type"> & {
  type: EventType;
};

export type EventType = BuiltInEventInput["type"] | (z.infer<typeof EventTypeSchema> & {});
export type GenericEventInput = WithAutocompleteEventType<z.infer<typeof GenericEventInput>>;
export type GenericEvent = WithAutocompleteEventType<z.infer<typeof GenericEvent>>;

export const EventInput = z.union([BuiltInEventInput, GenericEventInput]);
export type EventInput = BuiltInEventInput | GenericEventInput;

export const Event = z.union([BuiltInEvent, GenericEvent]);
export type Event = BuiltInEvent | GenericEvent;

const ProcessorsState = z.object({
  "circuit-breaker": CircuitBreakerState,
  "external-subscriber": ExternalSubscriberState.default({ subscribersBySlug: {} }),
  "dynamic-worker": DynamicWorkerState,
  "jsonata-transformer": JsonataTransformerState,
  scheduler: SchedulerState,
});

export const StreamState = z.object({
  projectSlug: ProjectSlug,
  path: StreamPath,
  eventCount: z.number().int().nonnegative(),
  childPaths: z.array(StreamPath).default([]),
  metadata: JSONObject,
  processors: ProcessorsState,
});
export type StreamState = z.infer<typeof StreamState>;

export const DestroyStreamResult = z.object({
  destroyedStreamCount: z.number().int().nonnegative(),
  finalStateByPath: z.record(z.string(), z.object({ finalState: StreamState.nullable() })),
});
export type DestroyStreamResult = z.infer<typeof DestroyStreamResult>;
