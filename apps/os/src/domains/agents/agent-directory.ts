// Project-agent lookups and dispatch: the domain functions both the oRPC
// agents router and itx.agents delegate to (moved here from the router so the
// itx surface never imports from src/orpc/).

import { env } from "cloudflare:workers";
import {
  getInitializedDoStub,
  listD1ObjectCatalogRecordsByIndex,
} from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
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
  type AgentPresetEvent,
} from "~/domains/agents/agent-presets.ts";
import {
  type AgentDurableObjectStructuredName,
  AGENTS_STREAM_PATH,
  getAgentDurableObjectName,
} from "~/domains/agents/durable-objects/agent-durable-object.ts";

export type AgentRpcStub = {
  getRuntimeState(): Promise<unknown>;
  kill(): Promise<void>;
  sendMessage(input: { channel?: string; message: string }): Promise<{
    event: Event;
  }>;
};

export async function listProjectAgents(input: { projectId: string }) {
  const records = await listD1ObjectCatalogRecordsByIndex<AgentDurableObjectStructuredName>(
    env.DB,
    {
      className: "AgentDurableObject",
      indexName: "projectId",
      indexValue: input.projectId,
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
}

export async function listAgentPresets(input: { projectId: string }) {
  const events = await readAgentsRootEvents(input);
  return { presets: readAgentPathPrefixPresets(events) };
}

/** Normalize, assemble setup events, and persist a path-prefix preset on the
 * agents root stream — the same flow as oRPC agents.configurePreset. */
export async function configureAgentPreset(input: {
  basePath: string;
  events: AgentPresetEvent[];
  model: string;
  projectId: string;
  provider: AgentLlmProvider;
  runOpts: Record<string, unknown>;
  systemPrompt: string;
}) {
  const basePath = normalizeAgentPresetBasePath(input.basePath);
  const events = [
    ...configuredAgentSetupEvents({
      model: input.model,
      provider: input.provider,
      runOpts: input.runOpts,
      systemPrompt: input.systemPrompt,
    }),
    ...input.events,
  ];
  await appendAgentsRootEvent({
    event: presetConfiguredEvent({ basePath, events }),
    projectId: input.projectId,
  });
  return { basePath, eventCount: events.length };
}

export async function readAgentsRootEvents(input: { projectId: string }) {
  const stream = await getAgentsRootStream(input);
  return await stream.history({ before: "end" });
}

export async function appendAgentsRootEvent(input: { event: EventInput; projectId: string }) {
  const stream = await getAgentsRootStream(input);
  return await stream.append(input.event);
}

async function getAgentsRootStream(input: { projectId: string }) {
  return await getInitializedStreamStub({
    durableObjectNamespace: env.STREAM as unknown as StreamDurableObjectNamespace,
    namespace: input.projectId,
    path: AGENTS_STREAM_PATH,
  });
}

export async function getAgentStub(input: {
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
