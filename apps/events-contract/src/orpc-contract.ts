import { eventIterator, oc } from "@orpc/contract";
import { commonContract } from "@iterate-com/shared/apps/common-router-contract";
import { z } from "zod";

import {
  DestroyStreamResult,
  Event,
  EventInput,
  Offset,
  StreamPath,
  StreamState,
} from "./types.ts";

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

const PathMungingDescription =
  "For curl ergonomics, nested stream paths accept either raw nested segments or percent-escaped slash forms. Both resolve to the same canonical stream path.";

const streamListEntryCreatedAt = z.iso.datetime({ offset: true });

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
    .input(z.intersection(z.object({ path: StreamPath }), EventInput))
    .output(
      z.object({
        event: Event,
      }),
    ),
  destroy: oc
    .route({
      operationId: "destroyStream",
      method: "DELETE",
      path: "/streams/{+path}",
      description: "Deletes all persisted data for a stream durable object.",
      tags: ["Streams"],
    })
    .input(z.object({ path: StreamPath }))
    .output(DestroyStreamResult),
  stream: oc
    .route({
      operationId: "streamEvents",
      method: "GET",
      path: "/streams/{+path}",
      description: `Reads historical events from a stream and can keep the connection open for live events. ${PathMungingDescription} For example, \`GET /api/streams/team/inbox\`, \`GET /api/streams/team%2Finbox\`, and \`GET /api/streams/%2Fteam%2Finbox\` all target the same stream. The root stream is addressed canonically as \`GET /api/streams/%2F\`.`,
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
      description: `Returns the latest reduced projection for a stream, including whether it has been initialized, metadata, and generated offsets. ${PathMungingDescription} For example, \`GET /api/__state/team/inbox\`, \`GET /api/__state/team%2Finbox\`, and \`GET /api/__state/%2Fteam%2Finbox\` all target the same stream state. The root stream state is addressed canonically as \`GET /api/__state/%2F\`.`,
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
          createdAt: streamListEntryCreatedAt,
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
