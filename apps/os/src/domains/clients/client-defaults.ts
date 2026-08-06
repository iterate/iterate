// The client stream's idempotent birth batch. EVERY `projects.connect`
// appends it — the keys derive from (projectId, path) only, so re-appending
// after the first connect dedupes to a no-op (the notification-defaults
// pattern). One atomic append, subscription last: the roster subscription
// catches up from offset 0, so ordering comes from the batch, never timing.

import { buildFacetProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";
import {
  CLIENT_COLLECTION_CREATED_EVENT_TYPE,
  CLIENT_COLLECTION_PATH,
  CLIENT_COLLECTION_SUBSCRIPTION_NAME,
  ClientCollectionProcessorContract,
} from "./client-collection-processor-contract.ts";

/**
 * The complete atomic birth batch for the project's singleton client-collection
 * stream (`/clients`): the existence marker plus the subscription arming its
 * facet-hosted projection processor. Every `projects.connect` ensures it before
 * the client birth commits its copy feed — the idempotency keys make retries
 * free (the agent-collection pattern).
 */
export function clientCollectionCreationEvents(input: { projectId: string }) {
  return [
    ClientCollectionProcessorContract.buildEvent({
      type: CLIENT_COLLECTION_CREATED_EVENT_TYPE,
      idempotencyKey: `client-collection/created:${input.projectId}`,
      payload: {},
    }),
    buildFacetProcessorSubscriptionConfiguredEvent({
      idempotencyKey: `stream/subscription-configured:${ClientCollectionProcessorContract.slug}`,
      name: ClientCollectionProcessorContract.slug,
    }),
  ];
}

/** Birth one client stream: its created fact plus the narrow roster copy subscription. */
export function buildClientStreamCreationEvents(input: { path: string; projectId: string }) {
  return [
    ClientCollectionProcessorContract.buildEvent({
      type: "events.iterate.com/client/created",
      idempotencyKey: `client/created:${input.projectId}:${input.path}`,
      payload: { path: input.path },
    }),
    CoreProcessorContract.buildEvent({
      type: "events.iterate.com/stream/subscription-configured",
      idempotencyKey: `stream/subscription-configured:${CLIENT_COLLECTION_SUBSCRIPTION_NAME}`,
      payload: {
        name: CLIENT_COLLECTION_SUBSCRIPTION_NAME,
        description: "Project client roster projection",
        filter: {
          eventTypes: [
            "events.iterate.com/client/created",
            "events.iterate.com/stream/connection-opened",
            "events.iterate.com/stream/connection-closed",
          ],
        },
        receiver: {
          action: "copy-to-stream",
          receivingStreamPath: CLIENT_COLLECTION_PATH,
          delivery: {
            // Configured in the same birth batch as client/created.
            start: "beginning",
            onFailingEvent: "halt",
          },
        },
      },
    }),
  ];
}
