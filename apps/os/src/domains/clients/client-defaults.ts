// The client stream's idempotent birth batch. EVERY `projects.connect`
// appends it — the keys derive from (projectId, path) only, so re-appending
// after the first connect dedupes to a no-op (the notification-defaults
// pattern). One atomic append, subscription last: the roster subscription
// catches up from offset 0, so ordering comes from the batch, never timing.

import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";
import {
  CLIENT_COLLECTION_PATH,
  CLIENT_COLLECTION_SUBSCRIPTION_KEY,
  ClientCollectionProcessorContract,
} from "./client-collection-processor-contract.ts";

/** Birth one client stream: its created fact plus the narrow roster copy subscription. */
export function buildClientStreamCreationEvents(input: { path: string; projectId: string }) {
  const durableObjectName = DurableObjectNameCodec.stringify({
    projectId: input.projectId,
    path: input.path,
  });
  return [
    ClientCollectionProcessorContract.buildEvent({
      type: "events.iterate.com/client/created",
      idempotencyKey: `client/created:${durableObjectName}`,
      payload: { path: input.path },
    }),
    CoreProcessorContract.buildEvent({
      type: "events.iterate.com/stream/subscription-configured",
      idempotencyKey: `stream/subscription-configured:${durableObjectName}#${CLIENT_COLLECTION_SUBSCRIPTION_KEY}`,
      payload: {
        subscriptionKey: CLIENT_COLLECTION_SUBSCRIPTION_KEY,
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
