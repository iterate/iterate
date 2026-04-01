import { ORPCError } from "@orpc/server";
import { type Event, StreamPath } from "@iterate-com/events-contract";
import { ROOT_STREAM_PATH, decodeEventStream } from "~/lib/utils.ts";
import { os } from "~/orpc/orpc.ts";

export const streamsRouter = {
  append: os.append.handler(async ({ context, input }) => {
    const { path, ...event } = input;
    const streamStub = context.env.STREAM.getByName(path);
    await streamStub.initialize({ path });
    const result = await streamStub.append(event);

    if (result.kind === "offset-precondition-failed") {
      throw new ORPCError("PRECONDITION_FAILED", { message: result.message });
    }

    return {
      event: result.event,
    };
  }),
  stream: os.stream.handler(async function* ({ context, input, signal }) {
    const streamStub = context.env.STREAM.getByName(input.path);
    for await (const event of yieldStreamEvents({ streamStub, input, signal })) {
      yield event;
    }
  }),
  rootStream: os.rootStream.handler(async function* ({ context, input, signal }) {
    const streamStub = context.env.STREAM.getByName(ROOT_STREAM_PATH);
    await streamStub.initialize({ path: ROOT_STREAM_PATH });
    for await (const event of yieldStreamEvents({ streamStub, input, signal })) {
      yield event;
    }
  }),
  getState: os.getState.handler(async ({ context, input }) => {
    const streamStub = context.env.STREAM.getByName(input.streamPath);
    return streamStub.getState();
  }),
  rootState: os.rootState.handler(async ({ context }) => {
    const streamStub = context.env.STREAM.getByName(ROOT_STREAM_PATH);
    await streamStub.initialize({ path: ROOT_STREAM_PATH });
    return streamStub.getState();
  }),
  listStreams: os.listStreams.handler(async ({ context }) => {
    const rootStreamStub = context.env.STREAM.getByName(ROOT_STREAM_PATH);
    await rootStreamStub.initialize({ path: ROOT_STREAM_PATH });
    const events = await rootStreamStub.history();
    const rootState = await rootStreamStub.getState();
    const discovered = new Map<StreamPath, string>();

    for (const event of events) {
      if (event.type !== "https://events.iterate.com/events/stream/initialized") {
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

async function* yieldStreamEvents({
  streamStub,
  input,
  signal,
}: {
  streamStub: {
    history(input: { afterOffset?: string }): Promise<Event[]>;
    stream(input: { afterOffset?: string; live?: boolean }): Promise<ReadableStream<Uint8Array>>;
  };
  input: { offset?: string; live?: boolean };
  signal?: AbortSignal;
}) {
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
}
