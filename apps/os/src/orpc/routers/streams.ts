import { env } from "cloudflare:workers";
import { ORPCError } from "@orpc/server";
import { createStreamSubscription } from "@iterate-com/streams/subscription";
import type { StreamRpc } from "@iterate-com/streams/types";
import type { RequestContext } from "~/request-context.ts";
import {
  getStreamsCapability,
  resolveStreamPath,
} from "~/domains/streams/entrypoints/streams-capability.ts";
import {
  getStreamDurableObjectName,
  withStreamPath,
  toAfterOffset,
  type StreamDurableObjectNamespace,
} from "~/domains/streams/stream-runtime.ts";
import { os, projectScopeMiddleware } from "~/orpc/orpc.ts";
import { requireProjectScope } from "~/orpc/project-access.ts";

export const projectStreamsRouter = {
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
};

function getProjectStreamsCapability(context: RequestContext, projectId: string) {
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
  afterOffset?: Parameters<typeof toAfterOffset>[0];
  context: RequestContext;
  projectId: string;
  signal?: AbortSignal;
  streamPath: string;
}) {
  const streamNamespace = env.STREAM as unknown as StreamDurableObjectNamespace;
  const streamPath = resolveStreamPath(input.streamPath);
  const streamStub = streamNamespace.getByName(
    getStreamDurableObjectName({
      namespace: input.projectId,
      path: streamPath,
    }),
  ) as unknown as StreamRpc;
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
    handle = await streamStub.subscribe({
      processEventBatch: subscription.processEventBatch,
      replayAfterOffset: toAfterOffset(input.afterOffset),
    });

    for await (const batch of subscription) {
      if (input.signal?.aborted) return;
      for (const event of batch.events) {
        yield withStreamPath(event, streamPath);
      }
    }
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
  }
}
