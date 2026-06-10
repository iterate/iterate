import { z } from "zod";
import {
  EventTypeSchema,
  GenericEvent as GenericEventBase,
  GenericEventInput as GenericEventInputBase,
  JSONObject,
  StreamPath,
} from "./event-base-types.ts";
import {
  CircuitBreakerConfiguredEventInput,
  CircuitBreakerState,
  StreamPausedEventInput,
  StreamResumedEventInput,
} from "./circuit-breaker-types.ts";
import {
  ExternalSubscriberState,
  StreamSubscriptionConfiguredEventInput,
} from "./external-subscriber-types.ts";
import { HtmlRendererConfiguredEventInput } from "./html-renderer-types.ts";
import {
  STREAM_CHILD_STREAM_CREATED_TYPE,
  STREAM_DURABLE_OBJECT_WOKE_UP_TYPE,
  STREAM_ERROR_OCCURRED_TYPE,
  STREAM_FIRST_INITIALIZED_TYPE,
  STREAM_INVALID_EVENT_APPENDED_TYPE,
  STREAM_METADATA_UPDATED_TYPE,
} from "./core-event-types.ts";

export { JSONObject, StreamPath };
export * from "./circuit-breaker-types.ts";
export * from "./core-event-types.ts";
export * from "./external-subscriber-types.ts";
export * from "./html-renderer-types.ts";

export const StreamNamespace = z.string().trim().min(1).max(255);
export type StreamNamespace = z.infer<typeof StreamNamespace>;

export const StreamCursor = z.union([
  z.coerce.number<number>().int().positive(),
  z.literal("start"),
  z.literal("end"),
]);
export type StreamCursor = z.infer<typeof StreamCursor>;

export const StreamQuery = z
  .object({
    afterOffset: StreamCursor.optional(),
    beforeOffset: StreamCursor.optional(),
  })
  .strict();
export type StreamQuery = z.infer<typeof StreamQuery>;

const StreamInitializedEventInput = GenericEventInputBase.extend({
  type: z.literal(STREAM_FIRST_INITIALIZED_TYPE),
  payload: z.strictObject({
    namespace: StreamNamespace,
    path: StreamPath,
  }),
});
export const StreamInitializedEvent = GenericEventBase.extend(
  StreamInitializedEventInput.pick({ type: true, payload: true }).shape,
);
export type StreamInitializedEvent = z.infer<typeof StreamInitializedEvent>;

const StreamDurableObjectWokeUpEventInput = GenericEventInputBase.extend({
  type: z.literal(STREAM_DURABLE_OBJECT_WOKE_UP_TYPE),
  payload: z.strictObject({}),
});
const StreamDurableObjectWokeUpEvent = GenericEventBase.extend(
  StreamDurableObjectWokeUpEventInput.pick({ type: true, payload: true }).shape,
);
type StreamDurableObjectWokeUpEventInput = z.infer<typeof StreamDurableObjectWokeUpEventInput>;
type StreamDurableObjectWokeUpEvent = z.infer<typeof StreamDurableObjectWokeUpEvent>;

const ChildStreamCreatedEventInput = GenericEventInputBase.extend({
  type: z.literal(STREAM_CHILD_STREAM_CREATED_TYPE),
  payload: z.strictObject({
    childPath: StreamPath,
  }),
});
export const ChildStreamCreatedEvent = GenericEventBase.extend(
  ChildStreamCreatedEventInput.pick({ type: true, payload: true }).shape,
);
export type ChildStreamCreatedEvent = z.infer<typeof ChildStreamCreatedEvent>;

export const StreamMetadataUpdatedEventInput = GenericEventInputBase.extend({
  type: z.literal(STREAM_METADATA_UPDATED_TYPE),
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
  type: z.literal(STREAM_ERROR_OCCURRED_TYPE),
  payload: z.strictObject({
    message: z.string().trim().min(1),
    error: z
      .object({
        name: z.string().trim().min(1).optional(),
        message: z.string().trim().min(1),
        code: z.string().trim().min(1).optional(),
        stack: z.string().trim().min(1).optional(),
      })
      .optional(),
  }),
});
export const ErrorOccurredEvent = GenericEventBase.extend(
  ErrorOccurredEventInput.pick({ type: true, payload: true }).shape,
);
export type ErrorOccurredEvent = z.infer<typeof ErrorOccurredEvent>;

export const InvalidEventAppendedEventInput = GenericEventInputBase.extend({
  type: z.literal(STREAM_INVALID_EVENT_APPENDED_TYPE),
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
  StreamDurableObjectWokeUpEventInput,
  ChildStreamCreatedEventInput,
  StreamMetadataUpdatedEventInput,
  StreamSubscriptionConfiguredEventInput,
  ErrorOccurredEventInput,
  InvalidEventAppendedEventInput,
  CircuitBreakerConfiguredEventInput,
  HtmlRendererConfiguredEventInput,
  StreamPausedEventInput,
  StreamResumedEventInput,
] as const;

export const GenericEventInput = GenericEventInputBase;
export const GenericEvent = GenericEventBase;

type BuiltInEventInput = z.input<(typeof builtInEventInputOptions)[number]>;

type WithAutocompleteEventType<T extends { type: string }> = Omit<T, "type"> & {
  type: EventType;
};

export type EventType = BuiltInEventInput["type"] | (z.infer<typeof EventTypeSchema> & {});
export type GenericEventInput = WithAutocompleteEventType<z.input<typeof GenericEventInput>>;
export type GenericEvent = WithAutocompleteEventType<z.infer<typeof GenericEvent>>;

export const EventInput = GenericEventInputBase.extend({});
export type EventInput = GenericEventInput;

export const Event = GenericEventBase.extend({});
export type Event = GenericEvent;

const ProcessorsState = z.object({
  "circuit-breaker": CircuitBreakerState,
  "external-subscriber": ExternalSubscriberState,
});

export const StreamState = z.object({
  namespace: StreamNamespace,
  path: StreamPath,
  eventCount: z.number().int().nonnegative(),
  childPaths: z.array(StreamPath),
  /**
   * Full paths of every stream strictly under this one, in announcement order.
   * The root stream's copy lists every stream in the namespace.
   */
  descendantPaths: z.array(StreamPath),
  metadata: JSONObject,
  processors: ProcessorsState,
});
export type StreamState = z.infer<typeof StreamState>;

export const DestroyStreamResult = z.object({
  destroyedStreamCount: z.number().int().nonnegative(),
  finalStateByPath: z.record(z.string(), z.object({ finalState: StreamState.nullable() })),
});
export type DestroyStreamResult = z.infer<typeof DestroyStreamResult>;
