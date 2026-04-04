import { ORPCError } from "@orpc/server";
import { StreamPath, type ChildStreamCreatedEvent } from "@iterate-com/events-contract";
import { StreamPausedError } from "@iterate-com/events-contract";
import {
  getInitializedStreamStub,
  getStreamStub,
  StreamOffsetPreconditionError,
} from "~/lib/stream-helpers.ts";
import { decodeEventStream } from "~/lib/utils.ts";
import { os } from "~/orpc/orpc.ts";

export const streamsRouter = {
  append: os.append.handler(async ({ input }) => {
    const streamStub = await getInitializedStreamStub({ path: input.path });

    try {
      return { event: await streamStub.append(input.event) };
    } catch (error) {
      throw toAppendOrpcError(error);
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
  listStreams: os.listStreams.handler(async ({ input }) => {
    const streamStub = await getInitializedStreamStub({ path: input.path });
    const events = await streamStub.history();
    const discovered: Record<StreamPath, string> = {
      [input.path]: new Date().toISOString(),
    };

    for (const event of events) {
      if (event.type === "https://events.iterate.com/events/stream/child-stream-created") {
        const childEvent = event as ChildStreamCreatedEvent;
        discovered[childEvent.payload.childPath] = childEvent.createdAt;
      } else if (event.type === "https://events.iterate.com/events/stream/initialized") {
        discovered[input.path] = event.createdAt;
      }
    }

    return Object.entries(discovered)
      .map(([path, createdAt]) => ({ path: path as StreamPath, createdAt }))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }),
};

function toAppendOrpcError(error: unknown) {
  // TODO: Replace this exception mapping with a result-style flow.
  // See apps/events/tasks/better-error-handling.md.
  // The instanceof/name checks handle direct calls. The message check handles
  // DO RPC where the error class is lost during serialization.
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

  throw error;
}
