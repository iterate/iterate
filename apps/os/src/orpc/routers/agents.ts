import { env } from "cloudflare:workers";
import { getInitializedDoStub } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import type { Event, StreamPath } from "@iterate-com/shared/streams/types";
import { getAgentDurableObjectName } from "~/domains/agents/durable-objects/agent-durable-object.ts";
import { os, projectScopeMiddleware } from "~/orpc/orpc.ts";
import { requireProjectScope } from "~/orpc/project-access.ts";

export const projectAgentsRouter = {
  sendMessage: os.project.agents.sendMessage
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      const agent = await getAgentStub({
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
        agentPath: input.agentPath,
        projectId: project.id,
      });
      return await agent.getRuntimeState();
    }),

  kill: os.project.agents.kill.use(projectScopeMiddleware).handler(async ({ context, input }) => {
    const project = requireProjectScope(context);
    const agent = await getAgentStub({
      agentPath: input.agentPath,
      projectId: project.id,
    });
    // `ctx.abort` tears down the in-flight RPC along with the instance, so a
    // rejection here is the expected signature of a successful kill.
    await agent.kill().catch(() => undefined);
    return { killed: true };
  }),
};

type AgentRpcStub = {
  getRuntimeState(): Promise<unknown>;
  kill(): Promise<void>;
  sendMessage(input: { channel?: string; message: string }): Promise<{
    event: Event;
  }>;
};

async function getAgentStub(input: {
  agentPath: StreamPath;
  projectId: string;
}): Promise<AgentRpcStub> {
  const name = {
    agentPath: input.agentPath,
    projectId: input.projectId,
  };
  return (await getInitializedDoStub({
    allowCreate: true,
    namespace: env.AGENT,
    name: getAgentDurableObjectName(name),
  })) as unknown as AgentRpcStub;
}
