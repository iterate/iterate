import { z } from "zod";
import type { EventInput, StreamPath } from "@iterate-com/shared/streams/types";
import { StreamPath as StreamPathSchema } from "@iterate-com/shared/streams/types";
import { deriveDurableObjectNameFromStructuredName } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { durableObjectProcessorSubscriber } from "@iterate-com/streams/shared/callable-subscriber";
import { AgentChatProcessorContract } from "~/domains/agents/stream-processors/agent-chat/contract.ts";
import { AgentProcessorContract } from "~/domains/agents/stream-processors/agent/contract.ts";
import { CloudflareAiProcessorContract } from "~/domains/agents/stream-processors/cloudflare-ai/contract.ts";
import { OpenAiWsProcessorContract } from "~/domains/agents/stream-processors/openai-ws/contract.ts";
import { AGENT_HOST_PROCESSOR_SLUG } from "~/domains/agents/stream-processors/agent-host/contract.ts";
import type { AgentLlmProvider } from "~/domains/agents/agent-presets.ts";
import {
  VOICE_AGENT_PROVIDER_GEMINI_LIVE,
  VOICE_AGENT_PROVIDER_GROK_REALTIME,
  VOICE_AGENT_PROVIDER_OPENAI_REALTIME,
  type VoiceAgentProvider,
} from "~/domains/agents/stream-processors/voice-agent/contract.ts";

const STREAM_SUBSCRIPTION_CONFIGURED_TYPE = "events.iterate.com/stream/subscription-configured";

export { AGENT_HOST_PROCESSOR_SLUG } from "~/domains/agents/stream-processors/agent-host/contract.ts";

export const AGENTS_STREAM_PATH = StreamPathSchema.parse("/agents");
export const GEMINI_LIVE_VOICE_PROCESSOR_SLUG = "voice-agent/gemini-live";
export const OPENAI_REALTIME_VOICE_PROCESSOR_SLUG = "voice-agent/openai-realtime";
export const GROK_REALTIME_VOICE_PROCESSOR_SLUG = "voice-agent/grok-realtime";

export type AgentDurableObjectStructuredName = {
  agentPath: StreamPath;
  projectId: string;
};

export const AgentDurableObjectStructuredName = z.object({
  agentPath: StreamPathSchema,
  projectId: z.string().trim().min(1),
});

export function getAgentDurableObjectName(input: AgentDurableObjectStructuredName) {
  return deriveDurableObjectNameFromStructuredName({
    structuredName: input,
  });
}

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

export function voiceProviderProcessorSlug(provider: VoiceAgentProvider) {
  switch (provider) {
    case VOICE_AGENT_PROVIDER_GEMINI_LIVE:
      return GEMINI_LIVE_VOICE_PROCESSOR_SLUG;
    case VOICE_AGENT_PROVIDER_OPENAI_REALTIME:
      return OPENAI_REALTIME_VOICE_PROCESSOR_SLUG;
    case VOICE_AGENT_PROVIDER_GROK_REALTIME:
      return GROK_REALTIME_VOICE_PROCESSOR_SLUG;
  }
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
    // The `:callable` suffix (previously `:workers-rpc`) makes this a NEW
    // idempotency key, so the callable subscription lands on existing streams
    // and replaces the legacy built-in subscriber under the same
    // subscriptionKey.
    idempotencyKey: `agent-processor-subscription:${input.projectId}:${agentPath}:${input.processorSlug}:callable`,
    payload: {
      subscriptionKey: agentProcessorSubscriptionKey(input),
      subscriber: durableObjectProcessorSubscriber({
        bindingName: "AGENT",
        durableObjectName: getAgentDurableObjectName({
          agentPath,
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
