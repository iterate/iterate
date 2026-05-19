import { deriveDurableObjectNameFromStructuredName } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { STREAM_SUBSCRIPTION_CONFIGURED_TYPE } from "@iterate-com/shared/streams/core-event-types";
import { STREAM_CIRCUIT_BREAKER_CONFIGURED_TYPE } from "@iterate-com/shared/streams/types";
import type { EventInput, StreamPath } from "@iterate-com/shared/streams/types";

export function voiceAgentSubscriptionConfiguredEvent(input: {
  projectId: string;
  streamPath: StreamPath;
}): EventInput {
  const durableObjectName = deriveDurableObjectNameFromStructuredName({
    structuredName: {
      projectId: input.projectId,
      streamPath: input.streamPath,
    },
  });
  return {
    idempotencyKey: `stream-processor-websocket-subscription:VOICE_AGENT:${durableObjectName}:${input.streamPath}:voice-agent:${input.projectId}:${input.streamPath}`,
    type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
    payload: {
      slug: `voice-agent:${input.projectId}:${input.streamPath}`,
      type: "websocket",
      callable: {
        type: "fetch",
        via: {
          type: "env-binding",
          bindingType: "durable-object-namespace",
          bindingName: "VOICE_AGENT",
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
