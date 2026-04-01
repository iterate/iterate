import { eventIterator, oc } from "@orpc/contract";
import { commonContract } from "@iterate-com/shared/apps/common-router-contract";
import { z } from "zod";

const streamPathPattern = /^\/(?:[a-z0-9_-]+(?:\/[a-z0-9_-]+)*)?$/;
const createdAt = z.iso.datetime({ offset: true });
type BuiltInEventType =
  | "https://events.iterate.com/events/stream/created"
  | "https://events.iterate.com/events/stream/metadata-updated"
  | "https://events.iterate.com/events/error-occurred";

/** Event type identifier (URI, URN, reverse-DNS, etc.) — not limited to iterate.com URLs. */
export type EventType = BuiltInEventType | (string & {});
export const EventType = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .pipe(z.custom<EventType>((value) => typeof value === "string"));

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
export const StreamPath = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }

  try {
    const decoded = decodeURIComponent(value);
    return decoded.startsWith("/") ? decoded : `/${decoded}`;
  } catch {
    return value;
  }
}, z.string().max(1023).regex(streamPathPattern));
export type StreamPath = z.infer<typeof StreamPath>;
export const Offset = z.string().trim().min(1);
// Keep public payload/state shapes JSON-only so Cloudflare Durable Object RPC
// can prove they are serializable. `Record<string, unknown>` made the generated
// stub methods collapse to `never`, while bare `z.json()` would also allow
// top-level arrays/scalars/null. We want "JSON object with JSON values". For
// background on the `never` failure mode, see
// https://github.com/cloudflare/workerd/issues/2003.
export const JSONObject = z.record(z.string(), z.json());
export type JSONObject = z.infer<typeof JSONObject>;

const appendEventShape = {
  type: EventType,
  payload: JSONObject,
  metadata: JSONObject.optional(),
  // When a stream already has an event with this key, append returns that
  // stored event instead of creating a second one.
  idempotencyKey: z.string().trim().min(1).optional(),
  // Optional optimistic concurrency guard. When supplied, it must equal the
  // next offset this stream would generate for a newly inserted event.
  offset: Offset.optional(),
} satisfies z.ZodRawShape;

export const AppendEventInput = z.object(appendEventShape);
export type AppendEventInput = z.infer<typeof AppendEventInput>;

const eventShape = {
  ...appendEventShape,
  path: StreamPath,
  offset: Offset,
  createdAt,
} satisfies z.ZodRawShape;

export const Event = z.object(eventShape);
export type Event = z.infer<typeof Event>;

export const StreamCreatedPayload = z.object({
  path: StreamPath,
});
export type StreamCreatedPayload = z.infer<typeof StreamCreatedPayload>;

export const StreamMetadataUpdatedPayload = z.object({
  metadata: JSONObject,
});
export type StreamMetadataUpdatedPayload = z.infer<typeof StreamMetadataUpdatedPayload>;

export const ErrorOccurredPayload = z.object({
  message: z.string().trim().min(1),
});
export type ErrorOccurredPayload = z.infer<typeof ErrorOccurredPayload>;

const AppendInput = z.union([
  z.object({
    path: StreamPath,
    ...appendEventShape,
  }),
  z.object({
    path: StreamPath,
    events: z.array(AppendEventInput).min(1),
  }),
]);

export const StreamState = z.object({
  initialized: z.boolean(),
  path: StreamPath.nullable(),
  lastOffset: Offset.nullable(),
  eventCount: z.number().int().nonnegative(),
  metadata: JSONObject,
});
export type StreamState = z.infer<typeof StreamState>;

const SecretSummary = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const secretShape = {
  ...SecretSummary.shape,
  value: z.string(),
} satisfies z.ZodRawShape;

const Secret = z.object(secretShape);

export const eventsContract = oc.router({
  common: commonContract,
  append: oc
    .route({
      operationId: "appendStreamEvents",
      method: "POST",
      path: "/streams/{+path}",
      successDescription: "Events appended successfully and returned",
      description:
        "Appends events to a stream in order. A newly initialized stream first stores its own synthetic stream-created event at offset 0, so the first caller-appended event uses offset 1. Events with an existing idempotencyKey return the stored event instead of creating a duplicate.",
      tags: ["Streams"],
    })
    .input(AppendInput)
    .output(
      z.object({
        events: z.array(Event),
      }),
    ),
  stream: oc
    .route({
      operationId: "streamEvents",
      method: "GET",
      path: "/streams/{+path}",
      description: "Reads historical events and can keep the connection open for live events.",
      tags: ["Streams"],
    })
    .input(
      z.object({
        path: StreamPath,
        offset: Offset.optional(),
        live: z.coerce.boolean().optional(),
      }),
    )
    // https://orpc.dev/docs/event-iterator
    // https://orpc.dev/docs/client/event-iterator
    .output(eventIterator(Event)),
  getState: oc
    .route({
      operationId: "getStreamState",
      method: "GET",
      path: "/stream-state/{+streamPath}",
      description:
        "Returns the latest reduced projection for a stream, including whether it has been initialized, metadata, and generated offsets.",
      tags: ["Streams"],
    })
    .input(
      z.object({
        streamPath: StreamPath,
      }),
    )
    .output(StreamState),
  listStreams: oc
    .route({
      operationId: "listStreams",
      method: "GET",
      path: "/streams",
      description: "Returns stream paths discovered from the root stream.",
      tags: ["Streams"],
    })
    .input(z.strictObject({}).optional().default({}))
    .output(
      z.array(
        z.object({
          path: StreamPath,
          createdAt,
        }),
      ),
    ),
  secrets: {
    create: oc
      .route({
        method: "POST",
        path: "/secrets",
        description: "Create a secret (values stored in D1 as plaintext — demo only)",
        tags: ["secrets"],
      })
      .input(
        z.object({
          name: z.string().trim().min(1),
          value: z.string(),
          description: z.string().optional(),
        }),
      )
      .output(Secret),
    list: oc
      .route({
        method: "GET",
        path: "/secrets",
        description: "List secrets (no values)",
        tags: ["secrets"],
      })
      .input(
        z.object({
          limit: z.coerce.number().int().min(1).max(100).optional().default(20),
          offset: z.coerce.number().int().min(0).optional().default(0),
        }),
      )
      .output(z.object({ secrets: z.array(SecretSummary), total: z.number().int().nonnegative() })),
    find: oc
      .route({
        method: "GET",
        path: "/secrets/{id}",
        description: "Get secret by id (includes value)",
        tags: ["secrets"],
      })
      .input(z.object({ id: z.string() }))
      .output(Secret),
    remove: oc
      .route({
        method: "DELETE",
        path: "/secrets/{id}",
        description: "Delete secret",
        tags: ["secrets"],
      })
      .input(z.object({ id: z.string() }))
      .output(z.object({ ok: z.literal(true), id: z.string(), deleted: z.boolean() })),
  },
});
