import { ORPCError } from "@orpc/server";
import { type EventInput, GenericEventInput, type JSONObject } from "@iterate-com/events-contract";
import jsonata from "jsonata";
import {
  getInitializedStreamStub,
  getStreamStub,
  StreamOffsetPreconditionError,
} from "~/lib/stream-helpers.ts";
import { decodeEventStream } from "~/lib/utils.ts";
import { os, withProject } from "~/orpc/orpc.ts";

export const streamsRouter = {
  append: os.append.use(withProject).handler(async ({ input, context }) => {
    const path = input.params.path;
    const event: EventInput =
      input.query.jsonataTransform == null
        ? (input.body as EventInput)
        : await transformAppendBody({
            body: input.body as JSONObject,
            jsonataTransform: input.query.jsonataTransform,
          });

    const streamStub = await getInitializedStreamStub({
      projectSlug: context.projectSlug,
      path,
    });
    try {
      const appendedEvent = await streamStub.append(event);
      return {
        event: appendedEvent,
      };
    } catch (error) {
      if (
        error instanceof StreamOffsetPreconditionError ||
        (error instanceof Error && error.name === "StreamOffsetPreconditionError") ||
        (error instanceof Error && /does not match next generated offset/i.test(error.message))
      ) {
        throw new ORPCError("PRECONDITION_FAILED", {
          message: error instanceof Error ? error.message : "Offset precondition failed.",
        });
      }

      if (
        error instanceof Error &&
        error.message === "stream-initialized may only be appended once"
      ) {
        throw new ORPCError("BAD_REQUEST", { message: error.message });
      }

      throw error;
    }
  }),
  destroy: os.destroy.use(withProject).handler(async ({ input, context }) => {
    return await getStreamStub({
      projectSlug: context.projectSlug,
      path: input.params.path,
    }).destroy({
      destroyChildren: input.query.destroyChildren ?? readDestroyChildrenQuery(context.rawRequest),
    });
  }),
  stream: os.stream.use(withProject).handler(async function* ({ input, signal, context }) {
    const streamStub = await getInitializedStreamStub({
      projectSlug: context.projectSlug,
      path: input.path,
    });

    if (!input.live) {
      const events = await streamStub.history({
        afterOffset: input.offset,
      });

      for (const event of events) {
        yield event;
      }

      return;
    }

    const stream = await streamStub.stream({
      afterOffset: input.offset,
      live: input.live,
    });

    for await (const event of decodeEventStream(stream, signal)) {
      yield event;
    }
  }),
  getState: os.getState.use(withProject).handler(async ({ input, context }) => {
    const streamStub = await getInitializedStreamStub({
      projectSlug: context.projectSlug,
      path: input.path,
    });
    return streamStub.getState();
  }),
  listStreams: os.listStreams.use(withProject).handler(async ({ context }) => {
    return await getStreamStub({
      projectSlug: context.projectSlug,
      path: "/",
    }).listChildren();
  }),
};

async function transformAppendBody(args: { body: JSONObject; jsonataTransform: string }) {
  const transformed = await evaluateJsonataTransform(args);
  const parsed = GenericEventInput.safeParse(transformed);

  if (!parsed.success) {
    throw new ORPCError("BAD_REQUEST", {
      message: "jsonataTransform must produce a valid single event body.",
      data: {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      },
    });
  }

  return parsed.data;
}

async function evaluateJsonataTransform(args: { body: JSONObject; jsonataTransform: string }) {
  try {
    const expression = jsonata(args.jsonataTransform);
    return await expression.evaluate(args.body);
  } catch (error) {
    throw new ORPCError("BAD_REQUEST", {
      message: `invalid_jsonata_transform: ${getErrorMessage(error)}`,
    });
  }
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }

  return String(error);
}

function readDestroyChildrenQuery(request: Request | undefined) {
  const rawValue =
    request == null ? null : new URL(request.url).searchParams.get("destroyChildren");

  if (rawValue == null) {
    return undefined;
  }

  if (rawValue === "true") {
    return true;
  }

  if (rawValue === "false") {
    return false;
  }

  return undefined;
}
