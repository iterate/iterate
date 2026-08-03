import { buildFacetProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { NotificationProcessorContract } from "./notification-processor-contract.ts";

/** The complete atomic notification-processor birth batch. */
export function notificationCreationEvents(input: { projectId: string }) {
  return [
    NotificationProcessorContract.buildEvent({
      type: "events.iterate.com/notification/created",
      idempotencyKey: `notification-created:${input.projectId}`,
      payload: { config: {} },
    }),
    buildFacetProcessorSubscriptionConfiguredEvent({
      idempotencyKey: `stream/subscription-configured:${NotificationProcessorContract.slug}`,
      processorSlug: NotificationProcessorContract.slug,
    }),
  ];
}
