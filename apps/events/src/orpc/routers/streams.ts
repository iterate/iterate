import { ORPCError } from "@orpc/server";
import {
  ChildStreamCreatedPayload,
  StreamPath,
  childStreamCreatedEventType,
  streamInitializedEventType,
} from "@iterate-com/events-contract";
import {
  getInitializedStreamStub,
  StreamAppendInputError,
  StreamOffsetPreconditionError,
} from "~/lib/stream-helpers.ts";
import { ROOT_STREAM_PATH, decodeEventStream } from "~/lib/utils.ts";
import { os } from "~/orpc/orpc.ts";

export const streamsRouter = {
  append: os.append.handler(async ({ context, input }) => {
    const { path, ...event } = input;
    const streamStub = await getInitializedStreamStub(context.env, path);
    try {
      const appendedEvent = await streamStub.append(event);
      return {
        event: appendedEvent,
      };
    } catch (error) {
      if (
        error instanceof StreamOffsetPreconditionError ||
        (error instanceof Error && error.name === "StreamOffsetPreconditionError")
      ) {
        throw new ORPCError("PRECONDITION_FAILED", {
          message: error instanceof Error ? error.message : "Offset precondition failed.",
        });
      }

      if (
        error instanceof StreamAppendInputError ||
        (error instanceof Error && error.name === "StreamAppendInputError")
      ) {
        throw new ORPCError("BAD_REQUEST", {
          message: error instanceof Error ? error.message : "Invalid stream append input.",
        });
      }

      throw error;
    }
  }),
  stream: os.stream.handler(async function* ({ context, input, signal }) {
    const streamStub = await getInitializedStreamStub(context.env, input.path);

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
    const streamStub = await getInitializedStreamStub(context.env, input.path);
    return streamStub.getState();
  }),
  listStreams: os.listStreams.handler(async ({ context }) => {
    const rootStreamStub = await getInitializedStreamStub(context.env, ROOT_STREAM_PATH);
    const events = await rootStreamStub.history();
    const rootState = await rootStreamStub.getState();
    const discovered = new Map<StreamPath, string>();

    for (const event of events) {
      if (event.type !== childStreamCreatedEventType) {
        continue;
      }

      const payload = ChildStreamCreatedPayload.safeParse(event.payload);
      if (!payload.success || discovered.has(payload.data.path)) {
        continue;
      }

      discovered.set(payload.data.path, event.createdAt);
    }

    if (rootState.initialized === true && !discovered.has(ROOT_STREAM_PATH)) {
      const rootInitializedEvent = events.find(
        (event) => event.path === ROOT_STREAM_PATH && event.type === streamInitializedEventType,
      );
      if (rootInitializedEvent == null) {
        throw new Error("Initialized root stream is missing its self stream-initialized event.");
      }

      discovered.set(ROOT_STREAM_PATH, rootInitializedEvent.createdAt);
    }

    return [...discovered.entries()]
      .map(([path, createdAt]) => ({ path, createdAt }))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }),
};
