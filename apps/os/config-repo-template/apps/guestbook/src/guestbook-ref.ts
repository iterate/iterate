// The guestbook's shared IDENTITY, dependency-free on purpose (type-only
// imports bundle to pure data): the repo root's worker.ts imports this module
// for its HTTP route, the app's worker.ts for its sign verb, and the wake
// subscription persists the same ref — so ingress, spine delivery, and the
// creation batch can never disagree about which Durable Object (and which
// build) the guestbook is.
import type { DynamicWorkerRef } from "iterate/sdk";
import type { StreamEventInput } from "iterate/processors";

export const guestbookStreamPath = "/guestbook";

// One declarative ref for the guestbook host, shared by the HTTP routes and
// the wake subscription below — the same Durable Object either way, addressed
// by its durableWorkerKey. The source is this app's own Vite build: the
// platform's "vite" pipeline runs `npm run build` under apps/guestbook and
// hosts the built worker, Durable Object class included.
export const guestbookAppRef = {
  type: "stateful",
  path: "/",
  className: "GuestbookApp",
  durableWorkerKey: "app-guestbook",
  source: {
    files: { type: "repo", repoPath: "/repos/config" },
    options: { pipeline: "vite", rootDir: "apps/guestbook" },
  },
} satisfies DynamicWorkerRef;

/**
 * The guestbook's creation batch: the birth certificate plus the durable
 * WAKE subscription that puts the GuestbookApp Durable Object on the
 * stream's own delivery spine — the platform evaluates the persisted
 * expression (`workers.get(ref).processor.wakeStreamSubscriber`, resolved
 * via the dynamic capability fallback into the app's `processor` getter),
 * performs the wake handshake, and pushes event frames straight into the
 * registry's runner. Same machinery, same lane as the platform's own
 * domain processors. Both events are idempotency-keyed, so every creator
 * (the app's sign verb, a script, a test) offers this same batch and
 * the stream collapses it to one birth and one subscription.
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
        delivery: {
          mode: "wake",
          expression: ["workers", ["get", guestbookAppRef], "processor", "wakeStreamSubscriber"],
          processorSlug: "guestbook",
        },
      },
      idempotencyKey: "guestbook/subscription",
    },
  ];
}
