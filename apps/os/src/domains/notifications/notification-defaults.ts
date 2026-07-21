import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { buildDurableObjectProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { NotificationProcessorContract } from "./notification-processor-contract.ts";

/** The complete atomic notification-processor birth batch. */
export function notificationCreationEvents(input: { projectId: string }) {
  const durableObjectName = DurableObjectNameCodec.stringify({
    path: "/",
    projectId: input.projectId,
  });
  return [
    NotificationProcessorContract.buildEvent({
      type: "events.iterate.com/notification/created",
      idempotencyKey: `notification-created:${input.projectId}`,
      payload: { config: {} },
    }),
    buildDurableObjectProcessorSubscriptionConfiguredEvent({
      durableObjectName,
      idempotencyKey: `stream/subscription-configured:${durableObjectName}#${NotificationProcessorContract.slug}`,
      processor: ["notificationProcessor"],
      processorSlug: NotificationProcessorContract.slug,
    }),
  ];
}
