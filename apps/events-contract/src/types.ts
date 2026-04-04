import { z } from "zod";

// `StreamPath` is the canonical parser for stream identifiers, including values
// that come from HTTP route params. It normalizes only the two cases we expect
// from routing:
// - add the leading slash when callers pass `foo/bar`
// - decode url-encoded slashes so `foo%2Fbar` becomes `/foo/bar`
//
// Everything else still has to already be a valid canonical stream path. We do
// not silently "fix" uppercase letters, extra punctuation, trailing slashes, or
// other malformed inputs because that would hide real misunderstandings.
// https://orpc.dev/docs/openapi/routing
// https://github.com/colinhacks/zod/blob/main/packages/docs-v3/README.md#preprocess
export const StreamPath = z.preprocess(
  (value) => {
    if (typeof value !== "string") {
      return value;
    }

    try {
      const decoded = decodeURIComponent(value);
      return decoded.startsWith("/") ? decoded : `/${decoded}`;
    } catch {
      return value;
    }
  },
  z
    .string()
    .max(1023)
    .regex(/^\/(?:[a-z0-9_-]+(?:\/[a-z0-9_-]+)*)?$/),
);
export type StreamPath = z.infer<typeof StreamPath>;

export const ProjectSlug = z.string().trim().min(1).max(255);
export type ProjectSlug = z.infer<typeof ProjectSlug>;

export const Offset = z.coerce.number().int().positive();
export type Offset = z.infer<typeof Offset>;

// Keep public payload/state shapes JSON-only so Cloudflare Durable Object RPC
// can prove they are serializable. `Record<string, unknown>` made the generated
// stub methods collapse to `never`, while bare `z.json()` would also allow
// top-level arrays/scalars/null. We want "JSON object with JSON values". For
// background on the `never` failure mode, see
// https://github.com/cloudflare/workerd/issues/2003.
export const JSONObject = z.record(z.string(), z.json());
export type JSONObject = z.infer<typeof JSONObject>;

const EventTypeSchema = z.string().trim().min(1).max(2048);

export const GenericEventInput = z.object({
  type: EventTypeSchema,
  payload: JSONObject,
  metadata: JSONObject.optional(),
  idempotencyKey: z.string().trim().min(1).optional(),
  offset: Offset.optional(),
});

export const GenericEvent = z.object({
  ...GenericEventInput.shape,
  streamPath: StreamPath,
  offset: Offset,
  createdAt: z.iso.datetime({ offset: true }),
});

export const StreamInitializedEventInput = GenericEventInput.extend({
  type: z.literal("https://events.iterate.com/events/stream/initialized"),
  payload: z.object({
    projectSlug: ProjectSlug,
    path: StreamPath,
  }),
});
export const StreamInitializedEvent = GenericEvent.extend(
  StreamInitializedEventInput.pick({ type: true, payload: true }).shape,
);
export type StreamInitializedEventInput = z.infer<typeof StreamInitializedEventInput>;
export type StreamInitializedEvent = z.infer<typeof StreamInitializedEvent>;

export const ChildStreamCreatedEventInput = GenericEventInput.extend({
  type: z.literal("https://events.iterate.com/events/stream/child-stream-created"),
  payload: z.object({
    path: StreamPath,
  }),
});
export const ChildStreamCreatedEvent = GenericEvent.extend(
  ChildStreamCreatedEventInput.pick({ type: true, payload: true }).shape,
);
export type ChildStreamCreatedEventInput = z.infer<typeof ChildStreamCreatedEventInput>;
export type ChildStreamCreatedEvent = z.infer<typeof ChildStreamCreatedEvent>;

export const StreamMetadataUpdatedEventInput = GenericEventInput.extend({
  type: z.literal("https://events.iterate.com/events/stream/metadata-updated"),
  payload: z.object({
    metadata: JSONObject,
  }),
});
export const StreamMetadataUpdatedEvent = GenericEvent.extend(
  StreamMetadataUpdatedEventInput.pick({ type: true, payload: true }).shape,
);
export type StreamMetadataUpdatedEventInput = z.infer<typeof StreamMetadataUpdatedEventInput>;
export type StreamMetadataUpdatedEvent = z.infer<typeof StreamMetadataUpdatedEvent>;

export const ErrorOccurredEventInput = GenericEventInput.extend({
  type: z.literal("https://events.iterate.com/events/stream/error-occurred"),
  payload: z.object({
    message: z.string().trim().min(1),
  }),
});
export const ErrorOccurredEvent = GenericEvent.extend(
  ErrorOccurredEventInput.pick({ type: true, payload: true }).shape,
);
export type ErrorOccurredEventInput = z.infer<typeof ErrorOccurredEventInput>;
export type ErrorOccurredEvent = z.infer<typeof ErrorOccurredEvent>;

export const BuiltInEventInput = z.discriminatedUnion("type", [
  StreamInitializedEventInput,
  ChildStreamCreatedEventInput,
  StreamMetadataUpdatedEventInput,
  ErrorOccurredEventInput,
]);
export const BuiltInEvent = z.discriminatedUnion("type", [
  StreamInitializedEvent,
  ChildStreamCreatedEvent,
  StreamMetadataUpdatedEvent,
  ErrorOccurredEvent,
]);
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

export const StreamState = z.object({
  projectSlug: ProjectSlug,
  path: StreamPath,
  maxOffset: z.number().int().nonnegative(),
  metadata: JSONObject,
});
export type StreamState = z.infer<typeof StreamState>;

export const DestroyStreamResult = z.object({
  destroyed: z.literal(true),
  finalState: StreamState.nullable(),
});
export type DestroyStreamResult = z.infer<typeof DestroyStreamResult>;
