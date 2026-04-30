import { ORPCError } from "@orpc/server";
import {
  type ChildStreamCreatedEvent,
  type ProjectSlug,
  STREAM_CHILD_STREAM_CREATED_TYPE,
  STREAM_FIRST_INITIALIZED_TYPE,
  type StreamPath,
  StreamPausedError,
} from "@iterate-com/events-contract";
import {
  getInitializedStreamStub,
  getStreamStub,
  StreamOffsetPreconditionError,
} from "~/lib/stream-helpers.ts";
import { decodeEventStream } from "~/lib/utils.ts";
import { os, withProject } from "~/orpc/orpc.ts";

export const streamsRouter = {
  append: os.append.use(withProject).handler(async ({ input, context }) => {
    const streamStub = await getInitializedStreamStub({
      projectSlug: context.projectSlug,
      path: input.path,
    });

    try {
      return { event: await streamStub.append(input.event) };
    } catch (error) {
      throw mapAppendOrpcError(error);
    }
  }),

  destroy: os.destroy.use(withProject).handler(async ({ input, context }) => {
    return getStreamStub({
      projectSlug: context.projectSlug,
      path: input.params.path,
    }).destroy({
      destroyChildren: input.query.destroyChildren,
    });
  }),

  stream: os.stream.use(withProject).handler(async function* ({ input, signal, context }) {
    const streamStub = await getInitializedStreamStub({
      projectSlug: context.projectSlug,
      path: input.path,
    });

    const stream = await streamStub.stream({
      after: input.afterOffset,
      before: input.beforeOffset,
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

  listChildren: os.listChildren.use(withProject).handler(async ({ input, context }) => {
    const events =
      input.path === "/"
        ? await getRootStreamHistory({ projectSlug: context.projectSlug, path: input.path })
        : await getStreamStub({
            projectSlug: context.projectSlug,
            path: input.path,
          }).historyIfInitialized();
    const discovered: Record<StreamPath, string> = {};

    for (const event of events) {
      if (event.type === STREAM_CHILD_STREAM_CREATED_TYPE) {
        discovered[(event as ChildStreamCreatedEvent).payload.childPath] = event.createdAt;
      } else if (event.type === STREAM_FIRST_INITIALIZED_TYPE) {
        discovered[input.path] = event.createdAt;
      }
    }

    if (input.path === "/" && discovered["/"] == null) {
      discovered["/"] = new Date().toISOString();
    }

    return Object.entries(discovered)
      .map(([path, createdAt]) => ({ path: path as StreamPath, createdAt }))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }),
};

async function getRootStreamHistory(args: { projectSlug: ProjectSlug; path: "/" }) {
  const streamStub = await getInitializedStreamStub(args);
  return streamStub.history();
}

function mapAppendOrpcError(error: unknown) {
  if (
    error instanceof StreamOffsetPreconditionError ||
    (error instanceof Error && error.name === "StreamOffsetPreconditionError") ||
    (error instanceof Error && /does not match next generated offset/i.test(error.message))
  ) {
    return new ORPCError("PRECONDITION_FAILED", {
      message: error instanceof Error ? error.message : "Offset precondition failed.",
    });
  }

  if (error instanceof Error && error.message === "stream-initialized may only be appended once") {
    return new ORPCError("BAD_REQUEST", { message: error.message });
  }

  if (
    error instanceof StreamPausedError ||
    (error instanceof Error && error.name === "StreamPausedError") ||
    (error instanceof Error && /stream is paused/i.test(error.message))
  ) {
    return new ORPCError("PRECONDITION_FAILED", {
      message:
        error instanceof Error ? error.message : "stream is paused; only stream/resumed is allowed",
    });
  }

  return error;
}
