import { ORPCError } from "@orpc/server";
import {
  type ChildStreamCreatedEvent,
  type EventInput,
  GenericEventInput,
  type JSONObject,
  type StreamPath,
} from "@iterate-com/events-contract";
import jsonata from "jsonata";
import {
  getInitializedStreamStub,
  getStreamStub,
  StreamOffsetPreconditionError,
} from "~/lib/stream-helpers.ts";
import { decodeEventStream } from "~/lib/utils.ts";
import { os } from "~/orpc/orpc.ts";

export const streamsRouter = {
  append: os.append.handler(async ({ input }) => {
    const path = input.params.path;
    const event: EventInput =
      input.query.jsonataTransform == null
        ? (input.body as EventInput)
        : await transformAppendBody({
            body: input.body as JSONObject,
            jsonataTransform: input.query.jsonataTransform,
          });

    const streamStub = await getInitializedStreamStub({ path });
    try {
      const appendedEvent = await streamStub.append(event);
      return {
        event: appendedEvent,
      };
    } catch (error) {
      // TODO: Replace this exception mapping with a result-style flow.
      // See apps/events/tasks/better-error-handling.md.
      if (
        error instanceof StreamOffsetPreconditionError ||
        (error instanceof Error && error.name === "StreamOffsetPreconditionError")
      ) {
        throw new ORPCError("PRECONDITION_FAILED", {
          message: error instanceof Error ? error.message : "Offset precondition failed.",
        });
      }

      throw error;
    }
  }),
  destroy: os.destroy.handler(async ({ input }) => {
    const streamStub = getStreamStub(input.path);
    return streamStub.destroy();
  }),
  stream: os.stream.handler(async function* ({ input, signal }) {
    const streamStub = await getInitializedStreamStub({ path: input.path });

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
  getState: os.getState.handler(async ({ input }) => {
    const streamStub = await getInitializedStreamStub({ path: input.path });
    return streamStub.getState();
  }),
  listStreams: os.listStreams.handler(async () => {
    const rootStreamStub = await getInitializedStreamStub({ path: "/" });
    const events = await rootStreamStub.history();
    const discovered: Record<StreamPath, string> = {
      "/": new Date().toISOString(),
    };

    for (const event of events) {
      if (event.type === "https://events.iterate.com/events/stream/child-stream-created") {
        const childEvent = event as ChildStreamCreatedEvent;
        discovered[childEvent.payload.path] = childEvent.createdAt;
      } else if (event.type === "https://events.iterate.com/events/stream/initialized") {
        discovered["/"] = event.createdAt;
      }
    }

    return Object.entries(discovered)
      .map(([path, createdAt]) => ({ path: path as StreamPath, createdAt }))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
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
