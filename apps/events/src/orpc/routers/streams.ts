import { STREAM_CREATED_TYPE, StreamPath } from "@iterate-com/events-contract";
import { ROOT_STREAM_PATH, decodeEventStream } from "~/lib/utils.ts";
import { os } from "~/orpc/orpc.ts";

export const streamsRouter = {
  append: os.append.handler(async ({ context, input }) => {
    // We would rather let the Durable Object read its own name from `ctx.id.name`,
    // but that is still not reliable enough in constructors today. Until Cloudflare
    // makes that robust, the router stamps the validated path onto every event so
    // the DO can reduce and persist a trustworthy `state.path` on its own.
    const events = ("events" in input ? input.events : [input]).map((event) => ({
      ...event,
      path: input.path,
    }));

    // Durable Object RPC is always async from the caller side, even if the method
    // body itself only performs synchronous SQLite work.
    const streamStub = context.env.STREAM.getByName(input.path);
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
