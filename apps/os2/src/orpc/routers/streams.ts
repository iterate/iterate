import { ORPCError } from "@orpc/server";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
  type StreamDurableObjectStub,
} from "@iterate-com/shared/streams/helpers";
import type { Event, EventInput, StreamPath } from "@iterate-com/shared/streams/types";
import { activeOrganizationMiddleware, os } from "~/orpc/orpc.ts";
import { requireActiveOrganizationProject } from "~/orpc/project-access.ts";

export const streamsRouter = {
  streams: {
    append: os.streams.append
      .use(activeOrganizationMiddleware)
      .handler(async ({ context, input }) => {
        await requireActiveOrganizationProject({
          activeOrganization: context.activeOrganization,
          context,
          projectId: input.projectId,
        });
        const stream = await getStream(context.stream as StreamDurableObjectNamespace | undefined, {
          projectId: input.projectId,
          streamPath: input.streamPath,
        });
        const append = stream.append as (event: EventInput) => Promise<Event>;
        return { event: await append(input.event) };
      }),
    read: os.streams.read.use(activeOrganizationMiddleware).handler(async ({ context, input }) => {
      await requireActiveOrganizationProject({
        activeOrganization: context.activeOrganization,
        context,
        projectId: input.projectId,
      });
      const stream = await getStream(context.stream as StreamDurableObjectNamespace | undefined, {
        projectId: input.projectId,
        streamPath: input.streamPath,
      });
      return {
        events: await stream.history({
          after: input.afterOffset,
          before: input.beforeOffset ?? "end",
        }),
      };
    }),
    getState: os.streams.getState
      .use(activeOrganizationMiddleware)
      .handler(async ({ context, input }) => {
        await requireActiveOrganizationProject({
          activeOrganization: context.activeOrganization,
          context,
          projectId: input.projectId,
        });
        const stream = await getStream(context.stream as StreamDurableObjectNamespace | undefined, {
          projectId: input.projectId,
          streamPath: input.streamPath,
        });
        return await stream.getState();
      }),
  },
};

async function getStream(
  namespace: StreamDurableObjectNamespace | undefined,
  input: { projectId: string; streamPath: StreamPath },
): Promise<StreamDurableObjectStub> {
  if (!namespace) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "STREAM binding is not configured." });
  }

  return await getInitializedStreamStub({
    namespace,
    projectId: input.projectId,
    path: input.streamPath,
  });
}
