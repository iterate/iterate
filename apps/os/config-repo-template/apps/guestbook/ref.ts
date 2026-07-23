// The guestbook's shared identity, dependency-free on purpose: worker.ts
// routes to this ref, and the hosted-processor subscription in the creation batch below
// persists the same ref — so ingress and the stream spine always dial the
// same Durable Object.
import type { StreamEventInput } from "iterate/processors";
import type { StatefulDynamicWorkerRef } from "iterate/sdk";

export const guestbookStreamPath = "/guestbook";

export const guestbookAppRef = {
  className: "GuestbookApp",
  // "-stream" keeps clear of a retired predecessor's durable identity.
  durableWorkerKey: "app-guestbook-stream",
  path: "/",
  source: {
    createApp: {
      client: "apps/guestbook/client.tsx",
      files: { type: "repo", repoPath: "/repos/config" },
      server: "apps/guestbook/server.tsx",
    },
  },
  type: "stateful",
} satisfies StatefulDynamicWorkerRef;

/**
 * The guestbook's creation batch: the birth certificate plus the durable WAKE
 * subscription that wakes GuestbookApp when the stream advances.
 * Initialization is lazy and only matters when something consumes the fold:
 * the `/api` socket every page opens offers this batch, and so does a direct
 * `sign()`. (A bare GET of `/` serves only the static shell — its client then
 * opens `/api`, which initializes; a GET that never opens the socket has
 * nothing reading the subscription, so leaving it unconfigured is correct.)
 * The idempotency keys collapse duplicate offers. Bump the subscription key's
 * version whenever the persisted delivery expression changes.
 */
export function guestbookCreationEvents(): StreamEventInput[] {
  return [
    {
      type: "events.iterate.com/guestbook/created",
      payload: { config: { title: "Guestbook" } },
      idempotencyKey: "guestbook/created",
    },
    {
      type: "events.iterate.com/stream/subscription-configured",
      payload: {
        subscriptionKey: "app-guestbook#guestbook",
        receiver: {
          action: "processor-wake",
          expression: ["workers", ["get", guestbookAppRef], "processor", "wakeStreamProcessor"],
          // Must match GuestbookProcessorContract.slug (processor.ts); a
          // string literal because this module stays dependency-free.
          processorSlug: "guestbook",
        },
      },
      idempotencyKey: "guestbook/subscription:v1",
    },
  ];
}
