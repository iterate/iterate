import { deriveDurableObjectNameFromStructuredName } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { STREAM_SUBSCRIPTION_CONFIGURED_TYPE } from "@iterate-com/shared/streams/core-event-types";
import type { EventInput, StreamPath } from "@iterate-com/shared/streams/types";

export function agentSubscriptionConfiguredEvent(input: {
  agentPath: StreamPath;
  projectId: string;
}): EventInput {
  const durableObjectName = deriveDurableObjectNameFromStructuredName({
    structuredName: {
      agentPath: input.agentPath,
      projectId: input.projectId,
    },
  });
  return {
    idempotencyKey: `stream-processor-websocket-subscription:AGENT:${durableObjectName}:${input.agentPath}:agent:${input.projectId}:${input.agentPath}`,
    type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
    payload: {
      slug: `agent:${input.projectId}:${input.agentPath}`,
      type: "websocket",
      callable: {
        type: "fetch",
        via: {
          type: "env-binding",
          bindingType: "durable-object-namespace",
          bindingName: "AGENT",
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
