import { env as workerEnv } from "cloudflare:workers";
import { ORPCError } from "@orpc/server";
import {
  ChildStreamCreatedEvent,
  type EventInput,
  GenericEventInput,
  type JSONObject,
  StreamInitializedEvent,
  type StreamPath,
} from "@iterate-com/events-contract";
import jsonata from "jsonata";
import { getStreamStub, StreamOffsetPreconditionError } from "~/lib/stream-helpers.ts";
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

    const streamStub = await getStreamStub(path);
    try {
      const appendedEvent = await streamStub.append(event);
      return {
        event: appendedEvent,
      };
    } catch (error) {
      // TODO: Replace this exception mapping with a result-style flow.
      // See apps/events/tasks/better-error-handling.md.
      // The instanceof/name checks handle direct calls. The message check
      // handles DO RPC where the error class is lost during serialization.
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
  destroy: os.destroy.handler(async ({ input }) => {
    return await destroyStreamTree(input);
  }),
  destroyRoot: os.destroyRoot.handler(async ({ input }) => {
    return await destroyStreamTree({
      path: "/",
      destroyChildren: input.destroyChildren,
    });
  }),
  stream: os.stream.handler(async function* ({ input, signal }) {
    const streamStub = await getStreamStub(input.path);

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
    const streamStub = await getStreamStub(input.path);
    return streamStub.getState();
  }),
  listStreams: os.listStreams.handler(async () => {
    return await listDiscoveredStreams("/");
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

async function destroyStreamTree(args: { path: StreamPath; destroyChildren?: boolean }) {
  if (args.destroyChildren) {
    const childPaths = (await listDiscoveredStreams(args.path))
      .map((stream) => stream.path)
      .filter((path) => path !== args.path)
      .sort((left, right) => right.length - left.length);

    for (const childPath of childPaths) {
      await getStreamStubWithoutInitializing(childPath).destroy();
    }
  }

  return await getStreamStubWithoutInitializing(args.path).destroy();
}

async function listDiscoveredStreams(path: StreamPath) {
  const events = await getStreamStubWithoutInitializing(path).history();
  const discovered = new Map<StreamPath, string>();

  for (const event of events) {
    const childEvent = ChildStreamCreatedEvent.safeParse(event);
    if (childEvent.success) {
      discovered.set(childEvent.data.payload.path, childEvent.data.createdAt);
      continue;
    }

    const initializedEvent = StreamInitializedEvent.safeParse(event);
    if (initializedEvent.success) {
      discovered.set(initializedEvent.data.payload.path, initializedEvent.data.createdAt);
    }
  }

  return Array.from(discovered, ([path, createdAt]) => ({ path, createdAt })).sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
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

function getStreamStubWithoutInitializing(path: StreamPath) {
  return workerEnv.STREAM.getByName(path);
}
