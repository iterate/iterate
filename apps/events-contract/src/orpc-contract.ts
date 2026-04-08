import { eventIterator, oc } from "@orpc/contract";
import { internalContract } from "@iterate-com/shared/apps/internal-router-contract";
import { z } from "zod";

import {
  BuiltInEventInput,
  BuiltInEventType,
  DestroyStreamResult,
  Event,
  EventInput,
  GenericEventInput,
  InvalidEventAppendedEventInput,
  StreamPath,
  StreamState,
} from "./types.ts";

const PathMungingDescription =
  "For curl ergonomics, nested stream paths accept either raw nested segments or percent-escaped slash forms. Both resolve to the same canonical stream path.";

// `.catch()` keeps the server lenient — malformed events are stored as
// InvalidEventAppendedEvent instead of rejected. The cast preserves the input
// side as `EventInput` for client typing while keeping the output side aligned
// with Zod's parsed output shape.
const NormalizedAppendEventInput = EventInput.catch((ctx) =>
  InvalidEventAppendedEventInput.parse({
    type: "https://events.iterate.com/events/stream/invalid-event-appended",
    payload: {
      rawInput: toJsonValue(ctx.input),
      error: prettifyAppendEventError({
        input: ctx.input,
        fallbackIssues: ctx.error.issues,
      }),
    },
  }),
) as unknown as z.ZodType<z.output<typeof EventInput>, EventInput>;

export const AppendInput = z.object({
  path: StreamPath,
  event: NormalizedAppendEventInput,
});

const SecretSummary = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const eventsContract = oc.router({
  __internal: internalContract,
  append: oc
    .route({
      operationId: "appendStreamEvents",
      method: "POST",
      path: "/streams/{+path}",
      successDescription: "Event appended successfully and returned",
      description:
        "Appends one event to a stream. Offsets are assigned by the stream itself. Events with an existing idempotencyKey return the stored event instead of creating a duplicate.",
      tags: ["/streams"],
    })
    .input(AppendInput)
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
      inputStructure: "detailed",
      description:
        "Deletes all persisted data for a stream durable object. When `destroyChildren=true`, also destroys descendant streams discovered from that stream's history.",
      tags: ["/streams"],
    })
    .input(
      z.object({
        params: z.object({
          path: StreamPath,
        }),
        query: z
          .object({
            destroyChildren: z.union([z.boolean(), z.stringbool()]).optional(),
          })
          .optional()
          .default({}),
      }),
    )
    .output(DestroyStreamResult),
  stream: oc
    .route({
      operationId: "streamEvents",
      method: "GET",
      path: "/streams/{+path}",
      description: `Reads historical events from a stream and can keep the connection open for live events. ${PathMungingDescription} For example, \`GET /api/streams/team/inbox\`, \`GET /api/streams/team%2Finbox\`, and \`GET /api/streams/%2Fteam%2Finbox\` all target the same stream. The root stream is addressed canonically as \`GET /api/streams/%2F\`.`,
      tags: ["/streams"],
    })
    .input(
      z.object({
        path: StreamPath,
        offset: z.coerce.number().int().positive().optional(),
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
      path: "/streams/__state/{+path}",
      description: `Returns the latest reduced projection for a stream, including whether it has been initialized, metadata, and generated offsets. ${PathMungingDescription} For example, \`GET /api/streams/__state/team/inbox\`, \`GET /api/streams/__state/team%2Finbox\`, and \`GET /api/streams/__state/%2Fteam%2Finbox\` all target the same stream state. The root stream state is addressed canonically as \`GET /api/streams/__state/%2F\`.`,
      tags: ["/streams"],
    })
    .input(
      z.object({
        path: StreamPath,
      }),
    )
    .output(StreamState),
  listChildren: oc
    .route({
      operationId: "listChildren",
      method: "GET",
      path: "/streams/__children/{+path}",
      description:
        "Returns child stream paths discovered from a given stream. Defaults to the root stream ('/').",
      tags: ["/streams"],
    })
    .input(
      z.object({
        path: StreamPath,
      }),
    )
    .output(
      z.array(
        z.object({
          path: StreamPath,
          createdAt: z.iso.datetime({ offset: true }),
        }),
      ),
    ),
  secrets: {
    create: oc
      .route({
        method: "POST",
        path: "/secrets",
        description: "Create a secret (values stored in D1 as plaintext — demo only)",
        tags: ["/secrets"],
      })
      .input(
        z.object({
          name: z.string().trim().min(1),
          value: z.string(),
          description: z.string().optional(),
        }),
      )
      .output(SecretSummary),
    list: oc
      .route({
        method: "GET",
        path: "/secrets",
        description: "List secrets (no values)",
        tags: ["/secrets"],
      })
      .input(
        z.object({
          limit: z.coerce.number().int().min(1).max(100).optional().default(20),
          offset: z.coerce.number().int().min(0).optional().default(0),
        }),
      )
      .output(z.object({ secrets: z.array(SecretSummary), total: z.number().int().nonnegative() })),
    remove: oc
      .route({
        method: "DELETE",
        path: "/secrets/{id}",
        description: "Delete secret",
        tags: ["/secrets"],
      })
      .input(z.object({ id: z.string() }))
      .output(z.object({ ok: z.literal(true), id: z.string(), deleted: z.boolean() })),
  },
});

type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };

function prettifyAppendEventError(args: { input: unknown; fallbackIssues: z.ZodError["issues"] }) {
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
