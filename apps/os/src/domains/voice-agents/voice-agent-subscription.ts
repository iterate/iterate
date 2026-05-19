import { STREAM_SUBSCRIPTION_CONFIGURED_TYPE } from "@iterate-com/shared/streams/core-event-types";
import { STREAM_CIRCUIT_BREAKER_CONFIGURED_TYPE } from "@iterate-com/shared/streams/types";
import type { EventInput, StreamPath } from "@iterate-com/shared/streams/types";
import {
  getStreamProcessorDurableObjectName,
  streamProcessorSubscriptionSlug,
  VOICE_AGENT_PROCESSOR_SLUG,
  type StreamProcessorDurableObjectStructuredName,
} from "~/domains/stream-processors/stream-processor-slugs.ts";

export function streamProcessorSubscriptionConfiguredEvent(
  input: StreamProcessorDurableObjectStructuredName,
): EventInput {
  const durableObjectName = getStreamProcessorDurableObjectName(input);
  const subscriptionSlug = streamProcessorSubscriptionSlug(input);
  return {
    idempotencyKey: `stream-processor-websocket-subscription:STREAM_PROCESSOR:${durableObjectName}:${input.streamPath}:${subscriptionSlug}`,
    type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
    payload: {
      slug: subscriptionSlug,
      type: "websocket",
      callable: {
        type: "fetch",
        via: {
          type: "env-binding",
          bindingType: "durable-object-namespace",
          bindingName: "STREAM_PROCESSOR",
          durableObject: {
            name: durableObjectName,
          },
        },
        fetchRequest: {
          path: {
            base: "/stream-subscription",
            mode: "replace",
          },
        },
      },
    },
  };
}

export function voiceAgentSubscriptionConfiguredEvent(input: {
  projectId: string;
  streamPath: StreamPath;
}): EventInput {
  return streamProcessorSubscriptionConfiguredEvent({
    processorSlug: VOICE_AGENT_PROCESSOR_SLUG,
    projectId: input.projectId,
    streamPath: input.streamPath,
  });
}

export function voiceAgentCircuitBreakerConfiguredEvent(input: {
  projectId: string;
  streamPath: StreamPath;
}): EventInput {
  return {
    idempotencyKey: `voice-agent-circuit-breaker:${input.projectId}:${input.streamPath}`,
    type: STREAM_CIRCUIT_BREAKER_CONFIGURED_TYPE,
    payload: {
      burstCapacity: 10_000,
      refillRatePerMinute: 6_000,
    },
  };
}
