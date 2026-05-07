import { ORPCError } from "@orpc/server";
import { listD1ObjectCatalogRecordsByIndex } from "@iterate-com/shared/durable-object-utils/mixins/with-d1-object-catalog";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
  type StreamDurableObjectStub,
} from "@iterate-com/shared/streams/helpers";
import type { Event, EventInput, StreamPath } from "@iterate-com/shared/streams/types";
import type { StreamDurableObjectStructuredName } from "@iterate-com/shared/streams/stream-durable-object";
import type { AppContext } from "~/context.ts";
import { activeOrganizationMiddleware, os } from "~/orpc/orpc.ts";
import { requireActiveOrganizationProject } from "~/orpc/project-access.ts";

export const projectStreamsRouter = {
  list: os.projects.streams.list
    .use(activeOrganizationMiddleware)
    .handler(async ({ context, input }) => {
      await requireActiveOrganizationProject({
        activeOrganization: context.activeOrganization,
        context,
        projectId: input.projectId,
      });
      const rows = await listD1ObjectCatalogRecordsByIndex<StreamDurableObjectStructuredName>(
        requireD1ObjectCatalog(context),
        {
          className: "StreamDurableObject",
          indexName: "namespace",
          indexValue: input.projectId,
        },
      );

      return {
        streams: rows.map((record) => ({
          name: record.name,
          namespace: record.structuredName.namespace,
          streamPath: record.structuredName.path,
          createdAt: record.createdAt,
          lastWokenAt: record.lastWokenAt,
        })),
      };
    }),
  create: os.projects.streams.create
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
  append: os.projects.streams.append
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
  read: os.projects.streams.read
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
      return {
        events: await stream.history({
          after: input.afterOffset,
          before: input.beforeOffset ?? "end",
        }),
      };
    }),
  getState: os.projects.streams.getState
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
};

async function getStream(
  durableObjectNamespace: StreamDurableObjectNamespace | undefined,
  input: { projectId: string; streamPath: StreamPath },
): Promise<StreamDurableObjectStub> {
  if (!durableObjectNamespace) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "STREAM binding is not configured." });
  }

  return await getInitializedStreamStub({
    durableObjectNamespace,
    namespace: input.projectId,
    path: input.streamPath,
  });
}

function requireD1ObjectCatalog(context: AppContext) {
  if (!context.doCatalog) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "DO_CATALOG binding not available.",
    });
  }

  return context.doCatalog;
}
