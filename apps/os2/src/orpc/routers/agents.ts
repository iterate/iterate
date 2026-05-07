import { ORPCError } from "@orpc/server";
import { listD1ObjectCatalogRecordsByIndex } from "@iterate-com/shared/durable-object-utils/mixins/with-d1-object-catalog";
import { getOrInitializeDoStub } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import type { Event, StreamPath } from "@iterate-com/shared/streams/types";
import {
  type AgentDurableObject,
  type AgentDurableObjectStructuredName,
  getAgentDurableObjectName,
} from "~/domains/agents/durable-objects/agent-durable-object.ts";
import { os, projectScopeMiddleware } from "~/orpc/orpc.ts";
import { requireProjectScope } from "~/orpc/project-access.ts";

export const projectAgentsRouter = {
  list: os.project.agents.list.use(projectScopeMiddleware).handler(async ({ context }) => {
    const project = requireProjectScope(context);
    if (!context.doCatalog) {
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: "DO catalog binding not available.",
      });
    }

    const records = await listD1ObjectCatalogRecordsByIndex<AgentDurableObjectStructuredName>(
      context.doCatalog,
      {
        className: "AgentDurableObject",
        indexName: "projectId",
        indexValue: project.id,
      },
    );

    return {
      agents: records
        .filter((record) => record.structuredName.agentPath.startsWith("/agents/"))
        .map((record) => ({
          agentPath: record.structuredName.agentPath,
          createdAt: record.createdAt,
          lastWokenAt: record.lastWokenAt,
          name: record.name,
          projectId: record.structuredName.projectId,
        })),
    };
  }),

  sendMessage: os.project.agents.sendMessage
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      const agent = await getAgentStub({
        context,
        agentPath: input.agentPath,
        projectId: project.id,
      });
      return await agent.sendMessage({
        channel: input.channel,
        message: input.message,
      });
    }),

  runtimeState: os.project.agents.runtimeState
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      const agent = await getAgentStub({
        context,
        agentPath: input.agentPath,
        projectId: project.id,
      });
      return await agent.getRuntimeState();
    }),
};

type AgentRpcStub = {
  getRuntimeState(): Promise<unknown>;
  sendMessage(input: { channel?: string; message: string }): Promise<{
    event: Event;
  }>;
};

async function getAgentStub(input: {
  agentPath: StreamPath;
  context: { agent?: DurableObjectNamespace<AgentDurableObject> };
  projectId: string;
}): Promise<AgentRpcStub> {
  if (!input.context.agent) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "AGENT Durable Object namespace is not configured.",
    });
  }

  const name = {
    agentPath: input.agentPath,
    projectId: input.projectId,
  };
  return (await getOrInitializeDoStub({
    namespace: input.context.agent,
    name: getAgentDurableObjectName(name),
  })) as unknown as AgentRpcStub;
}
