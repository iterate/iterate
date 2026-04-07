import { z } from "zod";
import {
  EventTypeSchema,
  GenericEvent as GenericEventBase,
  GenericEventInput as GenericEventInputBase,
  JSONObject,
  Offset,
  StreamPath,
} from "./event-base-types.ts";
import {
  CircuitBreakerState,
  StreamPausedEventInput,
  StreamPausedEvent,
  StreamResumedEventInput,
  StreamResumedEvent,
} from "./circuit-breaker-types.ts";
import {
  JsonataTransformerState,
  JsonataTransformerConfiguredEventInput,
  JsonataTransformerConfiguredEvent,
} from "./jsonata-transformer-types.ts";
import {
  ScheduleAddedEvent,
  ScheduleAddedEventInput,
  ScheduleCancelledEvent,
  ScheduleCancelledEventInput,
  ScheduleExecutionFinishedEvent,
  ScheduleExecutionFinishedEventInput,
  ScheduleExecutionStartedEvent,
  ScheduleExecutionStartedEventInput,
  SchedulerState,
  StreamAppendScheduledEvent,
  StreamAppendScheduledEventInput,
} from "./scheduling-types.ts";

export { JSONObject, Offset, StreamPath };

export const ProjectSlug = z.string().trim().min(1).max(255);
export type ProjectSlug = z.infer<typeof ProjectSlug>;

export const StreamInitializedEventInput = GenericEventInputBase.extend({
  type: z.literal("https://events.iterate.com/events/stream/initialized"),
  payload: z.strictObject({
    projectSlug: ProjectSlug,
    path: StreamPath,
  }),
});
export const StreamInitializedEvent = GenericEventBase.extend(
  StreamInitializedEventInput.pick({ type: true, payload: true }).shape,
);
export type StreamInitializedEventInput = z.infer<typeof StreamInitializedEventInput>;
export type StreamInitializedEvent = z.infer<typeof StreamInitializedEvent>;

export const StreamDurableObjectConstructedEventInput = GenericEventInputBase.extend({
  type: z.literal("https://events.iterate.com/events/stream/durable-object-constructed"),
  payload: z.strictObject({}),
});
export const StreamDurableObjectConstructedEvent = GenericEventBase.extend(
  StreamDurableObjectConstructedEventInput.pick({ type: true, payload: true }).shape,
);
export type StreamDurableObjectConstructedEventInput = z.infer<
  typeof StreamDurableObjectConstructedEventInput
>;
export type StreamDurableObjectConstructedEvent = z.infer<
  typeof StreamDurableObjectConstructedEvent
>;

export const ChildStreamCreatedEventInput = GenericEventInputBase.extend({
  type: z.literal("https://events.iterate.com/events/stream/child-stream-created"),
  payload: z.strictObject({
    childPath: StreamPath,
  }),
});
export const ChildStreamCreatedEvent = GenericEventBase.extend(
  ChildStreamCreatedEventInput.pick({ type: true, payload: true }).shape,
);
export type ChildStreamCreatedEventInput = z.infer<typeof ChildStreamCreatedEventInput>;
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

export const ErrorOccurredEventInput = GenericEventInputBase.extend({
  type: z.literal("https://events.iterate.com/events/stream/error-occurred"),
  payload: z.strictObject({
    message: z.string().trim().min(1),
  }),
});
export const ErrorOccurredEvent = GenericEventBase.extend(
  ErrorOccurredEventInput.pick({ type: true, payload: true }).shape,
);
export type ErrorOccurredEventInput = z.infer<typeof ErrorOccurredEventInput>;
export type ErrorOccurredEvent = z.infer<typeof ErrorOccurredEvent>;

export const InvalidEventAppendedEventInput = GenericEventInputBase.extend({
  type: z.literal("https://events.iterate.com/events/stream/invalid-event-appended"),
  payload: z.strictObject({
    rawInput: z.json(),
    error: z.string().trim().min(1),
  }),
});
export const InvalidEventAppendedEvent = GenericEventBase.extend(
  InvalidEventAppendedEventInput.pick({ type: true, payload: true }).shape,
);
export type InvalidEventAppendedEventInput = z.infer<typeof InvalidEventAppendedEventInput>;
export type InvalidEventAppendedEvent = z.infer<typeof InvalidEventAppendedEvent>;

const builtInEventInputOptions = [
  StreamInitializedEventInput,
  StreamDurableObjectConstructedEventInput,
  ChildStreamCreatedEventInput,
  StreamMetadataUpdatedEventInput,
  ErrorOccurredEventInput,
  InvalidEventAppendedEventInput,
  StreamAppendScheduledEventInput,
  ScheduleAddedEventInput,
  ScheduleCancelledEventInput,
  ScheduleExecutionStartedEventInput,
  ScheduleExecutionFinishedEventInput,
  JsonataTransformerConfiguredEventInput,
  StreamPausedEventInput,
  StreamResumedEventInput,
] as const;

const builtInEventOptions = [
  StreamInitializedEvent,
  StreamDurableObjectConstructedEvent,
  ChildStreamCreatedEvent,
  StreamMetadataUpdatedEvent,
  ErrorOccurredEvent,
  InvalidEventAppendedEvent,
  StreamAppendScheduledEvent,
  ScheduleAddedEvent,
  ScheduleCancelledEvent,
  ScheduleExecutionStartedEvent,
  ScheduleExecutionFinishedEvent,
  JsonataTransformerConfiguredEvent,
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

// Widens `type` from a narrow literal to the full `EventType` union so editors
// autocomplete built-in type URIs while still accepting arbitrary strings.
// The `& {}` in `EventType` prevents TypeScript from collapsing the union to
// just `string`, preserving literal suggestions in IntelliSense.
// https://github.com/microsoft/TypeScript/issues/29729
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

export const ProcessorsState = z.object({
  "circuit-breaker": CircuitBreakerState,
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
