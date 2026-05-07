import { ORPCError } from "@orpc/server";
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
  read: os.project.streams.read.use(projectScopeMiddleware).handler(async ({ context, input }) => {
    const project = requireProjectScope(context);
    const events = await getProjectStreamsCapability(context, project.id).read({
      afterOffset: input.afterOffset,
      beforeOffset: input.beforeOffset,
      streamPath: input.streamPath,
    });
    return { events };
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
