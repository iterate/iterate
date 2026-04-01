import { eventIterator, oc } from "@orpc/contract";
import { commonContract } from "@iterate-com/shared/apps/common-router-contract";
import { z } from "zod";

const streamPathPattern = /^\/(?:[a-z0-9_-]+(?:\/[a-z0-9_-]+)*)?$/;
const createdAt = z.iso.datetime({ offset: true });
type BuiltInEventType =
  | "https://events.iterate.com/events/stream/initialized"
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

export const EventInput = z.object({
  type: EventType,
  payload: JSONObject,
  metadata: JSONObject.optional(),
  // When a stream already has an event with this key, append returns that
  // stored event instead of creating a second one.
  idempotencyKey: z.string().trim().min(1).optional(),
  // Optional optimistic concurrency guard. When supplied, it must equal the
  // next offset this stream would generate for a newly inserted event.
  offset: Offset.optional(),
});
export type EventInput = z.infer<typeof EventInput>;

export const Event = z.object({
  ...EventInput.shape,
  path: StreamPath,
  offset: Offset,
  createdAt,
});
export type Event = z.infer<typeof Event>;

export const StreamInitializedPayload = z.object({
  path: StreamPath,
});
export type StreamInitializedPayload = z.infer<typeof StreamInitializedPayload>;

export const StreamMetadataUpdatedPayload = z.object({
  metadata: JSONObject,
});
export type StreamMetadataUpdatedPayload = z.infer<typeof StreamMetadataUpdatedPayload>;

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
const internalStreamInitializedEventType = "https://events.iterate.com/events/stream/initialized";
const reservedInitializationIdempotencyKey = "stream-initialized";
const PathMungingDescription =
  "For curl ergonomics, nested stream paths accept either raw nested segments or percent-escaped slash forms. Both resolve to the same canonical stream path.";
const StreamHistoryPathDescription = `${PathMungingDescription} For example, \`GET /api/streams/team/inbox\`, \`GET /api/streams/team%2Finbox\`, and \`GET /api/streams/%2Fteam%2Finbox\` all target the same stream. The root stream is addressed canonically as \`GET /api/streams/%2F\`.`;
const StreamStatePathDescription = `${PathMungingDescription} For example, \`GET /api/__state/team/inbox\`, \`GET /api/__state/team%2Finbox\`, and \`GET /api/__state/%2Fteam%2Finbox\` all target the same stream state. The root stream state is addressed canonically as \`GET /api/__state/%2F\`.`;

export const eventsContract = oc.router({
  common: commonContract,
  append: oc
    .route({
      operationId: "appendStreamEvents",
      method: "POST",
      path: "/streams/{+path}",
      successDescription: "Event appended successfully and returned",
      description:
        "Appends one event to a stream. A newly initialized stream first stores its own synthetic stream-initialized event at offset 0, so the first caller-appended event uses offset 1. Events with an existing idempotencyKey return the stored event instead of creating a duplicate.",
      tags: ["Streams"],
    })
    .input(
      z
        .object({
          path: StreamPath,
          ...EventInput.shape,
        })
        .superRefine((value, context) => {
          if (value.type === internalStreamInitializedEventType) {
            context.addIssue({
              code: "custom",
              path: ["type"],
              message: "stream-initialized is internal-only and cannot be appended directly.",
            });
          }

          if (value.idempotencyKey === reservedInitializationIdempotencyKey) {
            context.addIssue({
              code: "custom",
              path: ["idempotencyKey"],
              message: `"${reservedInitializationIdempotencyKey}" is reserved for internal stream initialization.`,
            });
          }
        }),
    )
    .output(
      z.object({
        event: Event,
      }),
    ),
  stream: oc
    .route({
      operationId: "streamEvents",
      method: "GET",
      path: "/streams/{+path}",
      description: `Reads historical events from a stream and can keep the connection open for live events. ${StreamHistoryPathDescription}`,
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
      path: "/__state/{+path}",
      description: `Returns the latest reduced projection for a stream, including whether it has been initialized, metadata, and generated offsets. ${StreamStatePathDescription}`,
      tags: ["Streams"],
    })
    .input(
      z.object({
        path: StreamPath,
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
