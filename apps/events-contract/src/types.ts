import { z } from "zod";
import {
  EventTypeSchema,
  GenericEvent as GenericEventBase,
  GenericEventInput as GenericEventInputBase,
  JSONObject,
  StreamPath,
} from "./event-base-types.ts";
import {
  CircuitBreakerConfiguredEvent,
  CircuitBreakerConfiguredEventInput,
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
  HtmlRendererConfiguredEvent,
  HtmlRendererConfiguredEventInput,
} from "./html-renderer-types.ts";
import {
  DynamicWorkerState,
  DynamicWorkerConfiguredEventInput,
  DynamicWorkerConfiguredEvent,
  DynamicWorkerEnvVarSetEvent,
  DynamicWorkerEnvVarSetEventInput,
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

const StreamDurableObjectWokeUpEventInput = GenericEventInputBase.extend({
  type: z.literal("https://events.iterate.com/events/stream/durable-object-woke-up"),
  payload: z.strictObject({}),
});
const StreamDurableObjectWokeUpEvent = GenericEventBase.extend(
  StreamDurableObjectWokeUpEventInput.pick({ type: true, payload: true }).shape,
);
type StreamDurableObjectWokeUpEventInput = z.infer<typeof StreamDurableObjectWokeUpEventInput>;
type StreamDurableObjectWokeUpEvent = z.infer<typeof StreamDurableObjectWokeUpEvent>;

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
  StreamDurableObjectWokeUpEventInput,
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
  DynamicWorkerEnvVarSetEventInput,
  CircuitBreakerConfiguredEventInput,
  HtmlRendererConfiguredEventInput,
  StreamPausedEventInput,
  StreamResumedEventInput,
] as const;

const builtInEventOptions = [
  StreamInitializedEvent,
  StreamDurableObjectWokeUpEvent,
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
  DynamicWorkerEnvVarSetEvent,
  CircuitBreakerConfiguredEvent,
  HtmlRendererConfiguredEvent,
  StreamPausedEvent,
  StreamResumedEvent,
] as const;
const [firstBuiltInType, ...restBuiltInTypes] = builtInEventInputOptions.map(
  (schema) => schema.shape.type,
);
const BuiltInEventType = z.union([firstBuiltInType, ...restBuiltInTypes]);

export const GenericEventInput = GenericEventInputBase;
export const GenericEvent = GenericEventBase;

export const BuiltInEventInput = z.discriminatedUnion("type", builtInEventInputOptions);
const BuiltInEvent = z.discriminatedUnion("type", builtInEventOptions);
export type BuiltInEventInput = z.input<typeof BuiltInEventInput>;
type BuiltInEvent = z.infer<typeof BuiltInEvent>;

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

const ValidatedGenericEventType = EventTypeSchema.refine(
  (value) => !BuiltInEventType.safeParse(value).success,
  {
    message: "Built-in event types must use their built-in payload schema.",
  },
);
const ValidatedGenericEventInput = GenericEventInputBase.extend({
  type: ValidatedGenericEventType,
});

const ValidatedEventInput = z.union([BuiltInEventInput, ValidatedGenericEventInput]);

export const NormalizedEventInput = ValidatedEventInput.catch((ctx) =>
  InvalidEventAppendedEventInput.parse({
    type: "https://events.iterate.com/events/stream/invalid-event-appended",
    payload: {
      rawInput: toJsonValue(ctx.input),
      error: prettifyValidatedEventInputError({
        input: ctx.input,
        fallbackIssues: ctx.error.issues,
      }),
    },
  }),
) as unknown as z.ZodType<z.output<typeof EventInput>, EventInput>;

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

type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };

function prettifyValidatedEventInputError(args: {
  input: unknown;
  fallbackIssues: z.ZodError["issues"];
}) {
  const specificResult = hasBuiltInEventType(args.input)
    ? BuiltInEventInput.safeParse(args.input)
    : GenericEventInput.safeParse(args.input);

  if (!specificResult.success) {
    return z.prettifyError(specificResult.error);
  }

  return z.prettifyError(new z.ZodError(args.fallbackIssues));
}

function hasBuiltInEventType(input: unknown) {
  if (typeof input !== "object" || input == null || Array.isArray(input)) {
    return false;
  }

  return BuiltInEventType.safeParse((input as Record<string, unknown>).type).success;
}

function toJsonValue(input: unknown): JsonValue {
  if (input === undefined) {
    return null;
  }

  if (
    input === null ||
    typeof input === "string" ||
    typeof input === "number" ||
    typeof input === "boolean"
  ) {
    return input;
  }

  if (Array.isArray(input)) {
    return input.map((value) => toJsonValue(value));
  }

  if (typeof input === "object") {
    return Object.fromEntries(
      Object.entries(input).map(([key, value]) => [key, toJsonValue(value)]),
    );
  }

  return null;
}
