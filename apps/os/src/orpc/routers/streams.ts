import { ORPCError } from "@orpc/server";
import { withStreamConnectionFromWorkers } from "@iterate-com/streams/workers/connect";
import { createStreamSubscription } from "@iterate-com/streams/subscription";
import type { AppContext } from "~/context.ts";
import {
  getStreamsCapability,
  resolveStreamPath,
} from "~/domains/streams/entrypoints/streams-capability.ts";
import {
  getStreamDurableObjectName,
  toLegacyEvent,
  toNewAfterOffset,
  type StreamDurableObject,
  type StreamDurableObjectNamespace,
} from "~/domains/streams/new-stream-runtime.ts";
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
      if (input.beforeOffset != null && input.beforeOffset !== "end") {
        const events = await getProjectStreamsCapability(context, project.id).read({
          afterOffset: input.afterOffset,
          beforeOffset: input.beforeOffset,
          streamPath: input.streamPath,
        });
        for (const event of events) {
          yield event;
        }
        return;
      }

      for await (const event of subscribeProjectStreamEvents({
        afterOffset: input.afterOffset,
        context,
        projectId: project.id,
        signal,
        streamPath: input.streamPath,
      })) {
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
      projectId,
    },
  });
}

async function* subscribeProjectStreamEvents(input: {
  afterOffset?: Parameters<typeof toNewAfterOffset>[0];
  context: AppContext;
  projectId: string;
  signal?: AbortSignal;
  streamPath: string;
}) {
  const streamNamespace = requireStreamNamespace(input.context);
  const streamPath = resolveStreamPath(input.streamPath);
  const streamStub = streamNamespace.getByName(
    getStreamDurableObjectName({
      namespace: input.projectId,
      path: streamPath,
    }),
  );
  using connection = await withStreamConnectionFromWorkers({
    url: "https://stream.local/",
    fetch: (request) => fetchDurableObjectWebSocket(streamStub, request),
  });
  let handle: { unsubscribe(): void } | undefined;
  await using subscription = createStreamSubscription({
    onDispose: () => handle?.unsubscribe(),
  });
  const onAbort = () => {
    handle?.unsubscribe();
    void subscription[Symbol.asyncDispose]();
  };

  try {
    if (input.signal?.aborted) return;
    input.signal?.addEventListener("abort", onAbort, { once: true });
    handle = await connection.stream.subscribe({
      processEventBatch: subscription.processEventBatch,
      replayAfterOffset: toNewAfterOffset(input.afterOffset),
    });

    for await (const batch of subscription) {
      if (input.signal?.aborted) return;
      for (const event of batch.events) {
        yield toLegacyEvent(event, streamPath);
      }
    }
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
  }
}

function fetchDurableObjectWebSocket(
  stub: DurableObjectStub<StreamDurableObject>,
  request: Request,
) {
  const url = new URL(request.url);
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol === "ws:") url.protocol = "http:";
  return stub.fetch(
    new Request(url, {
      headers: new Headers(request.headers),
      method: request.method,
    }),
  );
}

function requireStreamNamespace(context: AppContext): StreamDurableObjectNamespace {
  if (!context.stream) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "STREAM Durable Object namespace is not configured.",
    });
  }

  return context.stream as unknown as StreamDurableObjectNamespace;
}
