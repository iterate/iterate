import { ORPCError } from "@orpc/server";
import {
  ChildStreamCreatedEvent,
  type EventInput,
  GenericEventInput,
  type JSONObject,
  StreamInitializedEvent,
  type ProjectSlug,
  type StreamPath,
} from "@iterate-com/events-contract";
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
  destroy: os.destroy.use(withProject).handler(async ({ input, context }) => {
    return await destroyStreamTree({
      projectSlug: context.projectSlug,
      path: input.path,
      destroyChildren: input.destroyChildren,
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
    const rootStreamStub = await getInitializedStreamStub({
      projectSlug: context.projectSlug,
      path: "/",
    });
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

async function destroyStreamTree(args: {
  projectSlug: ProjectSlug;
  path: StreamPath;
  destroyChildren?: boolean;
}) {
  if (args.destroyChildren) {
    const childPaths = (await listDiscoveredStreams({ projectSlug: args.projectSlug, path: args.path }))
      .map((stream) => stream.path)
      .filter((path) => path !== args.path)
      .sort((left, right) => right.length - left.length);

    for (const childPath of childPaths) {
      await getStreamStub({ projectSlug: args.projectSlug, path: childPath }).destroy();
    }
  }

  return await getStreamStub({ projectSlug: args.projectSlug, path: args.path }).destroy();
}

async function listDiscoveredStreams(args: { projectSlug: ProjectSlug; path: StreamPath }) {
  const events = await getStreamStub(args).history();
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
