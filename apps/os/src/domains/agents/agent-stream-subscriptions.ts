import { z } from "zod";
import type { EventInput, StreamPath } from "@iterate-com/shared/streams/types";
import { StreamPath as StreamPathSchema } from "@iterate-com/shared/streams/types";
import { durableObjectProcessorSubscriber } from "@iterate-com/streams/shared/callable-subscriber";
import { AgentChatProcessorContract } from "~/domains/agents/stream-processors/agent-chat/contract.ts";
import { AgentProcessorContract } from "~/domains/agents/stream-processors/agent/contract.ts";
import { CloudflareAiProcessorContract } from "~/domains/agents/stream-processors/cloudflare-ai/contract.ts";
import { OpenAiWsProcessorContract } from "~/domains/agents/stream-processors/openai-ws/contract.ts";
import { AGENT_HOST_PROCESSOR_SLUG } from "~/domains/agents/stream-processors/agent-host/contract.ts";

const STREAM_SUBSCRIPTION_CONFIGURED_TYPE = "events.iterate.com/stream/subscription-configured";

export { AGENT_HOST_PROCESSOR_SLUG } from "~/domains/agents/stream-processors/agent-host/contract.ts";

export const AGENTS_STREAM_PATH = StreamPathSchema.parse("/agents");
export const OS_AGENT_LLM_PROVIDER_SELECTED_EVENT_TYPE =
  "events.iterate.com/os-agent/llm-provider-selected";
export type AgentLlmProvider = "openai-ws" | "cloudflare-ai";

export type AgentDurableObjectStructuredName = {
  agentPath: StreamPath;
  projectId: string;
};

export const AgentDurableObjectStructuredName = z.object({
  agentPath: StreamPathSchema,
  projectId: z.string().trim().min(1),
});

/**
 * An agent Durable Object's identity IS its stream coordinate:
 * `{projectId}:{agentPath}` (e.g. `prj_abc:/agents/hahaha`) — the same shape a
 * stream uses (`{namespace}:{path}`), not an opaque JSON blob. projectId has no
 * colon and agentPath is colon-free, so splitting on the FIRST colon is exact.
 * This makes the name self-describing: any holder can recover (projectId,
 * agentPath) — and the agent context's address — from the id alone, with no
 * out-of-band catalog or passed-down address.
 */
export function getAgentDurableObjectName(input: AgentDurableObjectStructuredName) {
  return `${input.projectId}:${input.agentPath}`;
}

/** The DO-name codec: parse `{projectId}:{agentPath}` back to its parts. The
 * lifecycle base hands the raw name string to this schema (see parseName). */
export const AgentDurableObjectName = z
  .string()
  .transform((value, ctx): AgentDurableObjectStructuredName => {
    const parsed = parseAgentDurableObjectName(value);
    if (!parsed) {
      ctx.addIssue({
        code: "custom",
        message: `Agent DO name must be "{projectId}:{agentPath}", got ${JSON.stringify(value)}.`,
      });
      return z.NEVER;
    }
    return parsed;
  });

export function parseAgentDurableObjectName(
  value: string,
): AgentDurableObjectStructuredName | null {
  const colon = value.indexOf(":");
  if (colon <= 0) return null;
  const projectId = value.slice(0, colon);
  const agentPath = value.slice(colon + 1);
  const parsed = AgentDurableObjectStructuredName.safeParse({ agentPath, projectId });
  return parsed.success ? parsed.data : null;
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
