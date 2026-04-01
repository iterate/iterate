import { eventIterator, oc } from "@orpc/contract";
import { commonContract } from "@iterate-com/shared/apps/common-router-contract";
import { z } from "zod";

const streamPathPattern = /^\/(?:[a-z0-9_-]+(?:\/[a-z0-9_-]+)*)?$/;
const createdAt = z.iso.datetime({ offset: true });

const iterateEventUriPrefix = "https://events.iterate.com/" as const;

export const STREAM_CREATED_TYPE = `${iterateEventUriPrefix}events/stream/created` as const;
export const STREAM_METADATA_UPDATED_TYPE =
  `${iterateEventUriPrefix}events/stream/metadata-updated` as const;

/** Event type identifier (URI, URN, reverse-DNS, etc.) — not limited to iterate.com URLs. */
export const EventType = z.string().trim().min(1).max(2048);
export type EventType = z.infer<typeof EventType>;

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
// can prove they are serializable. We still want callers to hand in normal JS
// objects, so this Zod 4 codec accepts a broad record input shape and encodes
// it into a canonical "JSON object with JSON values" output shape via a JSON
// round-trip. Codecs are the documented Zod 4 tool for different input/output
// schemas: https://zod.dev/api?id=codecs
//
// We intentionally keep the OUTPUT schema as an object-only JSON shape because
// bare `z.json()` would allow top-level arrays/scalars/null, and earlier
// `Record<string, unknown>` experiments made generated DO RPC stubs collapse to
// `never`: https://github.com/cloudflare/workerd/issues/2003
const JsonObjectSchema = z.object({}).catchall(z.json());
export const JSONObject = z.codec(z.record(z.string(), z.any()), JsonObjectSchema, {
  decode: (value) => JSON.parse(JSON.stringify(value)),
  encode: (value) => value,
});
export type JSONObject = z.output<typeof JSONObject>;

export const EventInput = z.object({
  path: StreamPath,
  type: EventType,
  payload: JSONObject,
  metadata: JSONObject.optional(),
  // When a stream already has an event with this key, append returns that
  // stored event instead of creating a second one.
  idempotencyKey: z.string().trim().min(1).optional(),
});
export type EventInput = z.input<typeof EventInput>;
/** Validated shape after `EventInput` parsing (Durable Object and internal callers). */
export type EventInputOutput = z.output<typeof EventInput>;

export const Event = EventInput.extend({
  offset: Offset,
  createdAt,
});
export type Event = z.output<typeof Event>;

export const StreamCreatedPayload = z.object({
  path: StreamPath,
});
export type StreamCreatedPayload = z.infer<typeof StreamCreatedPayload>;

export const StreamMetadataUpdatedPayload = z.object({
  metadata: JSONObject,
});
export type StreamMetadataUpdatedPayload = z.infer<typeof StreamMetadataUpdatedPayload>;

const AppendInput = z.intersection(
  z.object({
    path: StreamPath,
  }),
  z.union([
    EventInput,
    z.object({
      events: z.array(EventInput).min(1),
    }),
  ]),
);

export const StreamState = z.object({
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

const Secret = SecretSummary.extend({
  value: z.string(),
});

export const eventsContract = oc.router({
  common: commonContract,
  append: oc
    .route({
      operationId: "appendStreamEvents",
      method: "POST",
      path: "/streams/{+path}",
      successDescription: "Events appended successfully and returned",
      description:
        "Appends events to a stream in order. Offsets are assigned by the stream itself. Events with an existing idempotencyKey return the stored event instead of creating a duplicate.",
      tags: ["Streams"],
    })
    .input(AppendInput)
    .output(
      z.object({
        created: z.boolean(),
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
        "Returns the latest reduced projection for a stream, including metadata and generated offsets.",
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
