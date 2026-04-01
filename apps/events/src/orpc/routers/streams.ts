import { ORPCError } from "@orpc/server";
import { StreamPath } from "@iterate-com/events-contract";
import { ROOT_STREAM_PATH, decodeEventStream } from "~/lib/utils.ts";
import { os } from "~/orpc/orpc.ts";

export const streamsRouter = {
  append: os.append.handler(async ({ context, input }) => {
    const events = "events" in input ? input.events : [input];
    const streamStub = await getInitializedStreamStub(context.env, input.path);
    const result = await streamStub.append({ events });

    if (result.kind === "offset-precondition-failed") {
      throw new ORPCError("PRECONDITION_FAILED", { message: result.message });
    }

    return {
      events: result.events,
    };
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
    const rootStreamStub = await getInitializedStreamStub(context.env, ROOT_STREAM_PATH);
    const events = await rootStreamStub.history();
    const rootState = await rootStreamStub.getState();
    const discovered = new Map<StreamPath, string>();

    for (const event of events) {
      if (event.type !== "https://events.iterate.com/events/stream/created") {
        continue;
      }

      const parsedPath = StreamPath.safeParse(event.payload.path);
      if (!parsedPath.success || discovered.has(parsedPath.data)) {
        continue;
      }

      discovered.set(parsedPath.data, event.createdAt);
    }

    if (rootState.initialized === true && !discovered.has(ROOT_STREAM_PATH)) {
      discovered.set(ROOT_STREAM_PATH, events[0]?.createdAt ?? new Date(0).toISOString());
    }

    return [...discovered.entries()]
      .map(([path, createdAt]) => ({ path, createdAt }))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }),
};

async function getInitializedStreamStub(env: Env, path: StreamPath) {
  const streamStub = env.STREAM.getByName(path);
  await streamStub.initialize({ path });
  return streamStub;
}
