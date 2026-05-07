import { ORPCError } from "@orpc/server";
import { listD1ObjectCatalogRecordsByIndex } from "@iterate-com/shared/durable-object-utils/mixins/with-d1-object-catalog";
import { getOrInitializeDoStub } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "@iterate-com/shared/streams/helpers";
import type { Event, EventInput, StreamPath } from "@iterate-com/shared/streams/types";
import type { StreamDurableObject } from "@iterate-com/shared/streams/stream-durable-object";
import {
  defaultAgentSetupEvents,
  normalizeAgentPresetBasePath,
  presetConfiguredEvent,
  readAgentPathPrefixPresets,
  type AgentLlmProvider,
} from "~/domains/agents/agent-presets.ts";
import {
  type AgentDurableObject,
  type AgentDurableObjectStructuredName,
  AGENTS_STREAM_PATH,
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

  listPresets: os.project.agents.listPresets
    .use(projectScopeMiddleware)
    .handler(async ({ context }) => {
      const project = requireProjectScope(context);
      const events = await readAgentsRootEvents({ context, projectId: project.id });
      return {
        presets: readAgentPathPrefixPresets(events),
      };
    }),

  configurePreset: os.project.agents.configurePreset
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      const basePath = normalizeAgentPresetBasePath(input.basePath);
      const events = [
        ...defaultAgentSetupEvents(input.provider as AgentLlmProvider).map((event) =>
          input.provider === "openai-ws" &&
          event.type === "events.iterate.com/openai-ws/config-updated"
            ? { ...event, payload: { model: input.model } }
            : input.provider === "cloudflare-ai" &&
                event.type === "events.iterate.com/agent/llm-config-updated"
              ? {
                  ...event,
                  payload: {
                    debounceMs: 1000,
                    model: input.model,
                    runOpts: input.runOpts,
                  },
                }
              : event.type === "events.iterate.com/agent/system-prompt-updated"
                ? { ...event, payload: { systemPrompt: input.systemPrompt } }
                : event,
        ),
        ...input.events,
      ];
      await appendAgentsRootEvent({
        context,
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

async function readAgentsRootEvents(input: {
  context: { stream?: DurableObjectNamespace<StreamDurableObject> };
  projectId: string;
}) {
  const stream = await getAgentsRootStream(input);
  return await stream.history({ before: "end" });
}

async function appendAgentsRootEvent(input: {
  context: { stream?: DurableObjectNamespace<StreamDurableObject> };
  event: EventInput;
  projectId: string;
}) {
  const stream = await getAgentsRootStream(input);
  return await stream.append(input.event);
}

async function getAgentsRootStream(input: {
  context: { stream?: DurableObjectNamespace<StreamDurableObject> };
  projectId: string;
}) {
  if (!input.context.stream) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "STREAM Durable Object namespace is not configured.",
    });
  }

  return await getInitializedStreamStub({
    durableObjectNamespace: input.context.stream as unknown as StreamDurableObjectNamespace,
    namespace: input.projectId,
    path: AGENTS_STREAM_PATH,
  });
}

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
