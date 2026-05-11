import { ORPCError } from "@orpc/server";
import type { Event } from "@iterate-com/shared/streams/types";
import type { AppContext } from "~/context.ts";
import { getStreamsCapability } from "~/domains/streams/entrypoints/streams-capability.ts";
import { os, projectScopeMiddleware } from "~/orpc/orpc.ts";
import { requireProjectScope } from "~/orpc/project-access.ts";

export const projectStreamsRouter = {
  list: os.project.streams.list.use(projectScopeMiddleware).handler(async ({ context }) => {
    const project = requireProjectScope(context);
    const streams = await getProjectStreamsCapability(context, project.id).list();
    return { streams };
  }),
  create: os.project.streams.create
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      return await getProjectStreamsCapability(context, project.id).create({
        streamPath: input.streamPath,
      });
    }),
  append: os.project.streams.append
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      const event = await getProjectStreamsCapability(context, project.id).append({
        event: input.event,
        streamPath: input.streamPath,
      });
      return { event };
    }),
  appendBatch: os.project.streams.appendBatch
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      const events = await getProjectStreamsCapability(context, project.id).appendBatch({
        events: input.events,
        streamPath: input.streamPath,
      });
      return { events };
    }),
  read: os.project.streams.read.use(projectScopeMiddleware).handler(async ({ context, input }) => {
    const project = requireProjectScope(context);
    const events = await getProjectStreamsCapability(context, project.id).read({
      afterOffset: input.afterOffset,
      beforeOffset: input.beforeOffset,
      streamPath: input.streamPath,
    });
    return { events };
  }),
  streamEvents: os.project.streams.streamEvents
    .use(projectScopeMiddleware)
    .handler(async function* ({ context, input, signal }) {
      const project = requireProjectScope(context);
      const response = await getProjectStreamsCapability(context, project.id).stream({
        afterOffset: input.afterOffset,
        beforeOffset: input.beforeOffset,
        streamPath: input.streamPath,
      });
      if (!response.body) return;

      for await (const event of decodeStreamEventLines(response.body, signal)) {
        yield event;
      }
    }),
  getState: os.project.streams.getState
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      return await getProjectStreamsCapability(context, project.id).getState({
        streamPath: input.streamPath,
      });
    }),
};

function getProjectStreamsCapability(context: AppContext, projectId: string) {
  if (!context.workerExports) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Worker exports are not available.",
    });
  }

  return getStreamsCapability({
    exports: context.workerExports,
    props: {
      appendPolicy: { mode: "any" },
      namespace: projectId,
    },
  });
}

async function* decodeStreamEventLines(stream: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = () => {
    void reader.cancel();
  };

  try {
    if (signal?.aborted) return;
    signal?.addEventListener("abort", onAbort, { once: true });

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) break;
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim()) yield JSON.parse(line) as Event;
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) yield JSON.parse(buffer) as Event;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
