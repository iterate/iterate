import { env } from "cloudflare:workers";
import { ORPCError } from "@orpc/server";
import { getInitializedDoStub } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import type { Event, EventInput, StreamPath } from "@iterate-com/shared/streams/types";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "~/domains/streams/stream-runtime.ts";
import {
  configuredAgentSetupEvents,
  normalizeAgentPresetBasePath,
  presetConfiguredEvent,
  readAgentPathPrefixPresets,
  type AgentLlmProvider,
} from "~/domains/agents/agent-presets.ts";
import {
  AGENTS_STREAM_PATH,
  getAgentDurableObjectName,
} from "~/domains/agents/durable-objects/agent-durable-object.ts";
import { os, projectScopeMiddleware } from "~/orpc/orpc.ts";
import { requireProjectScope } from "~/orpc/project-access.ts";

export const projectAgentsRouter = {
  listPresets: os.project.agents.listPresets
    .use(projectScopeMiddleware)
    .handler(async ({ context }) => {
      const project = requireProjectScope(context);
      const events = await readAgentsRootEvents({ projectId: project.id });
      return {
        presets: readAgentPathPrefixPresets(events),
      };
    }),

  configurePreset: os.project.agents.configurePreset
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      // Surface the path rule as a client-visible BAD_REQUEST. Thrown as a plain
      // Error it would be masked as an internal error and reach the CLI as an
      // opaque "Non-error of type undefined thrown" (see toRepoORPCError).
      let basePath: StreamPath;
      try {
        basePath = normalizeAgentPresetBasePath(input.basePath);
      } catch (error) {
        throw new ORPCError("BAD_REQUEST", {
          message: error instanceof Error ? error.message : "Invalid agent preset path.",
        });
      }
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

type AgentRpcStub = {
  getRuntimeState(): Promise<unknown>;
  kill(): Promise<void>;
  sendMessage(input: { channel?: string; message: string }): Promise<{
    event: Event;
  }>;
};

async function readAgentsRootEvents(input: { projectId: string }) {
  const stream = await getAgentsRootStream({ projectId: input.projectId });
  return await stream.history({ before: "end" });
}

async function appendAgentsRootEvent(input: { event: EventInput; projectId: string }) {
  const stream = await getAgentsRootStream({ projectId: input.projectId });
  return await stream.append(input.event);
}

async function getAgentsRootStream(input: { projectId: string }) {
  return await getInitializedStreamStub({
    durableObjectNamespace: env.STREAM as unknown as StreamDurableObjectNamespace,
    namespace: input.projectId,
    path: AGENTS_STREAM_PATH,
  });
}

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
