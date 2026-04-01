import { ORPCError } from "@orpc/server";
import { StreamPath } from "@iterate-com/events-contract";
import {
  getInitializedStreamStub,
  getStreamStub,
  StreamOffsetPreconditionError,
} from "~/lib/stream-helpers.ts";
import { decodeEventStream } from "~/lib/utils.ts";
import { os } from "~/orpc/orpc.ts";

export const streamsRouter = {
  append: os.append.handler(async ({ input }) => {
    const { path, ...event } = input;
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
        discovered[event.streamPath] = event.createdAt;
      } else if (event.type === "https://events.iterate.com/events/stream/initialized") {
        discovered["/"] = event.createdAt;
      }
    }

    return Object.entries(discovered)
      .map(([path, createdAt]) => ({ path: path as StreamPath, createdAt }))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }),
};
