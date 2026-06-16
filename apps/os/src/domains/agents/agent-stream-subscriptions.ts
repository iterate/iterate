import type { EventInput, StreamPath } from "@iterate-com/shared/streams/types";
import { StreamPath as StreamPathSchema } from "@iterate-com/shared/streams/types";
import { durableObjectProcessorSubscriber } from "~/domains/streams/engine/shared/callable-subscriber.ts";
import { formatDurableObjectName } from "~/domains/durable-object-names.ts";
import { AgentProcessorContract } from "~/domains/agents/stream-processors/agent/contract.ts";
import { CloudflareAiProcessorContract } from "~/domains/agents/stream-processors/cloudflare-ai/contract.ts";
import { OpenAiWsProcessorContract } from "~/domains/agents/stream-processors/openai-ws/contract.ts";

const STREAM_SUBSCRIPTION_CONFIGURED_TYPE = "events.iterate.com/stream/subscription-configured";

export const AGENTS_STREAM_PATH = StreamPathSchema.parse("/agents");
export const AGENT_LLM_PROVIDER_SELECTED_EVENT_TYPE =
  "events.iterate.com/agent/llm-provider-selected";
export type AgentLlmProvider = "openai-ws" | "cloudflare-ai";

export type AgentDurableObjectName = {
  path: StreamPath;
  projectId: string;
};

/** Formats the Agent Durable Object name from its project-local stream path. */
export function getAgentDurableObjectName(input: { path: StreamPath | string; projectId: string }) {
  return formatDurableObjectName({ path: input.path, projectId: input.projectId });
}

export function agentLlmProcessorSlug(provider: AgentLlmProvider) {
  return provider === "openai-ws"
    ? OpenAiWsProcessorContract.slug
    : CloudflareAiProcessorContract.slug;
}

export function defaultAgentProcessorSlugs(provider: AgentLlmProvider) {
  return [AgentProcessorContract.slug, agentLlmProcessorSlug(provider)];
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
  const agentPath = StreamPathSchema.parse(input.agentPath);
  return {
    type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
    idempotencyKey: `agent-processor-subscription:${input.projectId}:${agentPath}:${input.processorSlug}:callable`,
    payload: {
      subscriptionKey: agentProcessorSubscriptionKey(input),
      subscriber: durableObjectProcessorSubscriber({
        bindingName: "AGENT",
        durableObjectName: getAgentDurableObjectName({
          path: agentPath,
          projectId: input.projectId,
        }),
        processorName: input.processorSlug,
      }),
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
