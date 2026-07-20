// Shared identity for the guestbook stream-processor host. worker.ts routes
// HTTP here; the creation batch persists the same ref as the wake target so
// ingress and the stream spine always dial the same Durable Object.
import type { StreamEventInput } from "iterate/processors";
import type { StatefulDynamicWorkerRef } from "iterate/sdk";

export const guestbookStreamPath = "/guestbook";
export const guestbookSubscriptionConfigVersion = 1;

// `as const` freezes the discriminant so StatefulDynamicWorkerRef's source
// files union picks the repo branch (not a widened `{ type: string }`).
const repoFiles = { type: "repo", repoPath: "/repos/config" } as const;

/**
 * Stream-processor host. Uses createWorker (not createApp) so the platform
 * injects iterate/processors + iterate/sdk virtual modules. A new
 * durableWorkerKey keeps the SQLite-era app-guestbook facet from answering
 * wake/API traffic with the wrong class.
 */
export const guestbookHostRef = {
  type: "stateful",
  path: "/",
  className: "GuestbookApp",
  durableWorkerKey: "app-guestbook-stream",
  source: {
    createWorker: {
      entryPoint: "apps/guestbook/host.ts",
      files: repoFiles,
    },
  },
} satisfies StatefulDynamicWorkerRef;

/** Birth certificate + durable wake subscription onto the host above. */
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
        delivery: {
          mode: "wake",
          expression: ["workers", ["get", guestbookHostRef], "processor", "wakeStreamSubscriber"],
          processorSlug: "guestbook",
        },
      },
      idempotencyKey: `guestbook/subscription:v${guestbookSubscriptionConfigVersion}`,
    },
  ];
}
