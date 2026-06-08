import type { EventInput, StreamPath } from "@iterate-com/shared/streams/types";
import { StreamPath as StreamPathSchema } from "@iterate-com/shared/streams/types";
import { AgentChatProcessorContract } from "@iterate-com/shared/stream-processors/agent-chat/contract";
import { AgentProcessorContract } from "@iterate-com/shared/stream-processors/agent/contract";
import { CloudflareAiProcessorContract } from "@iterate-com/shared/stream-processors/cloudflare-ai/contract";
import { OpenAiWsProcessorContract } from "@iterate-com/shared/stream-processors/openai-ws/contract";
import type { AgentLlmProvider } from "~/domains/agents/agent-presets.ts";

const STREAM_SUBSCRIPTION_CONFIGURED_TYPE = "events.iterate.com/stream/subscription-configured";

export const AGENT_HOST_PROCESSOR_SLUG = "agent-host";

export function agentLlmProcessorSlug(provider: AgentLlmProvider) {
  return provider === "openai-ws"
    ? OpenAiWsProcessorContract.slug
    : CloudflareAiProcessorContract.slug;
}

export function defaultAgentProcessorSlugs(provider: AgentLlmProvider) {
  return [
    AgentChatProcessorContract.slug,
    AgentProcessorContract.slug,
    agentLlmProcessorSlug(provider),
    AGENT_HOST_PROCESSOR_SLUG,
  ];
}

export function agentProcessorSubscriptionConfiguredEvents(input: {
  agentPath: StreamPath | string;
  processorSlugs: readonly string[];
  projectId: string;
}): EventInput[] {
  return input.processorSlugs.map((processorSlug) =>
    agentProcessorSubscriptionConfiguredEvent({
      agentPath: input.agentPath,
      processorSlug,
      projectId: input.projectId,
    }),
  );
}

export function agentProcessorSubscriptionConfiguredEvent(input: {
  agentPath: StreamPath | string;
  processorSlug: string;
  projectId: string;
}): EventInput {
  return {
    type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
    idempotencyKey: `agent-processor-subscription:${input.projectId}:${StreamPathSchema.parse(input.agentPath)}:${input.processorSlug}:workers-rpc`,
    payload: {
      subscriptionKey: agentProcessorSubscriptionKey(input),
      subscriber: {
        type: "built-in",
        transport: "workers-rpc",
        processorSlug: input.processorSlug,
      },
    },
  };
}

export function agentProcessorSubscriptionKey(input: {
  agentPath: StreamPath | string;
  processorSlug: string;
  projectId: string;
}) {
  return `agent:${input.projectId}:${StreamPathSchema.parse(input.agentPath)}:${input.processorSlug}`;
}

export function agentProcessorRunnerName(input: {
  agentPath: StreamPath | string;
  processorSlug: string;
  projectId: string;
}) {
  const agentPath = StreamPathSchema.parse(input.agentPath);
  return `${input.projectId}:${agentPath}:${agentProcessorSubscriptionKey({
    agentPath,
    processorSlug: input.processorSlug,
    projectId: input.projectId,
  })}`;
}
