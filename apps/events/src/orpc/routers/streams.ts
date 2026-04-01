import { STREAM_CREATED_TYPE, StreamPath, type JSONObject } from "@iterate-com/events-contract";
import { ORPCError } from "@orpc/server";
import jsonata from "jsonata";
import { z } from "zod";
import { ROOT_STREAM_PATH, decodeEventStream } from "~/lib/utils.ts";
import { os } from "~/orpc/orpc.ts";

export const streamsRouter = {
  append: os.append.handler(async ({ context, input }) => {
    const path = input.params.path;
    const events =
      input.query.jsonataTransform == null
        ? stampPathOnAppendEvents({
            path,
            body: input.body,
          })
        : [
            await transformAppendBody({
              path,
              body: input.body,
              jsonataTransform: input.query.jsonataTransform,
            }),
          ];

    // Durable Object RPC is always async from the caller side, even if the method
    // body itself only performs synchronous SQLite work.
    const streamStub = context.env.STREAM.getByName(path);
    return streamStub.append({ events });
  }),
  stream: os.stream.handler(async function* ({ context, input, signal }) {
    const streamStub = context.env.STREAM.getByName(input.path);
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
  getState: os.getState.handler(async ({ context, input }) => {
    const streamStub = context.env.STREAM.getByName(input.streamPath);
    return streamStub.getState();
  }),
  listStreams: os.listStreams.handler(async ({ context }) => {
    const rootStreamStub = context.env.STREAM.getByName(ROOT_STREAM_PATH);
    const events = await rootStreamStub.history();
    const discovered = new Map<StreamPath, string>();

    for (const event of events) {
      if (event.type !== STREAM_CREATED_TYPE) {
        continue;
      }

      const parsedPath = StreamPath.safeParse(event.payload.path);
      if (!parsedPath.success || discovered.has(parsedPath.data)) {
        continue;
      }

      discovered.set(parsedPath.data, event.createdAt);
    }

    // `/` is the discovery stream itself, so it will not discover itself via a
    // `STREAM_CREATED` payload. Add it explicitly so the UI can always navigate
    // to the root stream as a first-class system stream.
    discovered.set(ROOT_STREAM_PATH, events[0]?.createdAt ?? new Date(0).toISOString());

    return [...discovered.entries()]
      .map(([path, createdAt]) => ({ path, createdAt }))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }),
};

const eventAppendBody = z.object({
  type: z.string().trim().min(1),
  payload: z.record(z.string(), z.json()),
  metadata: z.record(z.string(), z.json()).optional(),
  idempotencyKey: z.string().trim().min(1).optional(),
});

const appendRequestBody = z.union([
  eventAppendBody,
  z.object({
    events: z.array(eventAppendBody).min(1),
  }),
]);

async function transformAppendBody(args: {
  path: StreamPath;
  body: JSONObject;
  jsonataTransform: string;
}) {
  const transformed = await evaluateJsonataTransform({
    body: args.body,
    jsonataTransform: args.jsonataTransform,
  });
  const parsed = eventAppendBody.safeParse(transformed);

  if (!parsed.success) {
    throw new ORPCError("BAD_REQUEST", {
      message: "jsonataTransform must produce a valid single event body.",
      data: {
        issues: flattenIssues(parsed.error.issues).map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      },
    });
  }

  return {
    ...parsed.data,
    path: args.path,
  };
}

async function evaluateJsonataTransform(args: { body: JSONObject; jsonataTransform: string }) {
  try {
    // JSONata can throw plain objects instead of `Error`, so normalize both parse
    // and evaluation failures into one BAD_REQUEST message.
    // https://docs.jsonata.org/embedding-extending
    const expression = jsonata(args.jsonataTransform);
    return await expression.evaluate(args.body);
  } catch (error) {
    throw new ORPCError("BAD_REQUEST", {
      message: `invalid_jsonata_transform: ${getErrorMessage(error)}`,
    });
  }
}

function stampPathOnAppendEvents(args: { path: StreamPath; body: unknown }) {
  const parsed = appendRequestBody.safeParse(args.body);
  if (!parsed.success) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Append body must be a single event body or an events array.",
      data: {
        issues: flattenIssues(parsed.error.issues).map((issue) => ({
          path: ["body", ...issue.path],
          message: issue.message,
        })),
      },
    });
  }

  const events = "events" in parsed.data ? parsed.data.events : [parsed.data];
  return events.map((event) => ({
    ...event,
    path: args.path,
  }));
}

function flattenIssues(issues: readonly z.core.$ZodIssue[]) {
  const flattened: Array<{ path: readonly PropertyKey[]; message: string }> = [];

  for (const issue of issues) {
    if (issue.code === "invalid_union") {
      for (const nestedIssues of issue.errors) {
        flattened.push(...flattenIssues(nestedIssues));
      }
      continue;
    }

    flattened.push({
      path: issue.path,
      message: issue.message,
    });
  }

  return flattened;
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
