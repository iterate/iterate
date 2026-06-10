import {
  configuredAgentSetupEvents,
  normalizeAgentPresetBasePath,
  presetConfiguredEvent,
  type AgentLlmProvider,
} from "~/domains/agents/agent-presets.ts";
import {
  appendAgentsRootEvent,
  getAgentStub,
  listAgentPresets,
  listProjectAgents,
} from "~/domains/agents/agent-directory.ts";
import { os, projectScopeMiddleware } from "~/orpc/orpc.ts";
import { requireProjectScope } from "~/orpc/project-access.ts";

export const projectAgentsRouter = {
  list: os.project.agents.list.use(projectScopeMiddleware).handler(async ({ context }) => {
    const project = requireProjectScope(context);
    return await listProjectAgents({ projectId: project.id });
  }),

  listPresets: os.project.agents.listPresets
    .use(projectScopeMiddleware)
    .handler(async ({ context }) => {
      const project = requireProjectScope(context);
      return await listAgentPresets({ projectId: project.id });
    }),

  configurePreset: os.project.agents.configurePreset
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      const basePath = normalizeAgentPresetBasePath(input.basePath);
      const events = [
        ...configuredAgentSetupEvents({
          model: input.model,
          provider: input.provider as AgentLlmProvider,
          runOpts: input.runOpts,
          systemPrompt: input.systemPrompt,
        }),
        ...input.events,
      ];
      await appendAgentsRootEvent({
        event: presetConfiguredEvent({ basePath, events }),
        projectId: project.id,
      });
      return { basePath, eventCount: events.length };
    }),

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
