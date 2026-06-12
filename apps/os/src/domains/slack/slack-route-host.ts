// Host wiring for the slack-route processor — the three deps the processor
// can't supply itself, ported from the deleted SlackIntegrationDurableObject.
// The generic IntegrationDurableObject hosts the processor; this module is
// the slack-specific half it plugs in (bootstrap events for routed thread
// streams, the 👀 ack, host pre-warming).

import { env } from "cloudflare:workers";
import { durableObjectProcessorSubscriber } from "@iterate-com/streams/shared/callable-subscriber";
import type { SlackRouteProcessorDeps } from "~/domains/slack/stream-processors/slack-route/implementation.ts";
import { SlackAgentProcessorContract } from "~/domains/slack/stream-processors/slack-agent/contract.ts";
import { eyesReactionTargetFromWebhookPayload } from "~/domains/slack/stream-processors/slack-agent/implementation.ts";
import {
  getSlackAgentDurableObjectName,
  type SlackAgentDurableObject,
} from "~/domains/slack/durable-objects/slack-agent-durable-object.ts";
import { callSlackWebApi } from "~/domains/slack/entrypoints/slack-capability.ts";
import { readSlackToken } from "~/domains/slack/slack-token.ts";
import {
  AGENT_HOST_PROCESSOR_SLUG,
  agentProcessorSubscriptionConfiguredEvent,
  getAgentDurableObjectName,
} from "~/domains/agents/agent-stream-subscriptions.ts";
import type { AgentDurableObject } from "~/domains/agents/durable-objects/agent-durable-object.ts";
import { resolveStreamPath } from "~/domains/streams/entrypoints/streams-backend.ts";

const STREAM_SUBSCRIPTION_CONFIGURED_TYPE = "events.iterate.com/stream/subscription-configured";

type SlackRouteHostEnv = {
  AGENT: DurableObjectNamespace<AgentDurableObject>;
  SLACK_AGENT: DurableObjectNamespace<SlackAgentDurableObject>;
};

export function slackRouteProcessorDeps(input: {
  projectId: string;
  account: string;
}): SlackRouteProcessorDeps {
  const { projectId } = input;
  return {
    createRoutedStreamBootstrapEvents: ({ streamPath }) => {
      const resolved = resolveStreamPath(streamPath);
      return [
        {
          type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
          idempotencyKey: `slack-agent-subscription:${projectId}:${resolved}:workers-rpc:callable`,
          payload: {
            subscriptionKey: `slack-agent:${projectId}:${resolved}`,
            subscriber: durableObjectProcessorSubscriber({
              bindingName: "SLACK_AGENT",
              durableObjectName: getSlackAgentDurableObjectName({
                projectId,
                streamPath: resolved,
              }),
              processorName: SlackAgentProcessorContract.slug,
            }),
          },
        },
        // Subscribe the agent host with the same key AgentDurableObject's
        // wake hook re-declares, so the two dedupe to one runner.
        agentProcessorSubscriptionConfiguredEvent({
          agentPath: resolved,
          processorSlug: AGENT_HOST_PROCESSOR_SLUG,
          projectId,
        }),
      ];
    },
    acknowledgeRoutedWebhook: async ({ payload }) => {
      const ack = eyesReactionTargetFromWebhookPayload(payload);
      if (ack == null) return;
      const token = await readSlackToken({ projectId, account: input.account });
      if (!token) return;
      try {
        await callSlackWebApi({
          body: { channel: ack.channel, name: "eyes", timestamp: ack.timestamp },
          method: "reactions.add",
          token,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // The slack-agent processor adds the same reaction once the routed
        // stream catches up; whichever lands second dedups here.
        if (message.includes("already_reacted") || message.includes("not_reactable")) return;
        console.error("[slack-route] routed-webhook acknowledgement failed", { error, projectId });
      }
    },
    prewarmRoutedStreamHosts: async ({ streamPath }) => {
      const hostEnv = env as unknown as SlackRouteHostEnv;
      const resolved = resolveStreamPath(streamPath);
      const slackAgentName = getSlackAgentDurableObjectName({ projectId, streamPath: resolved });
      const agentName = getAgentDurableObjectName({ agentPath: resolved, projectId });
      // initialize() runs each host's full wake hook concurrently with the
      // thread stream's bootstrap append; everything either side appends is
      // idempotency-keyed and order-independent.
      await Promise.all([
        hostEnv.SLACK_AGENT.getByName(slackAgentName).initialize({ name: slackAgentName }),
        hostEnv.AGENT.getByName(agentName).initialize({ name: agentName }),
      ]);
    },
  };
}
