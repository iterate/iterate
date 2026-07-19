// The guestbook's shared IDENTITY, dependency-free on purpose (type-only
// imports bundle to pure data): the repo root's worker.ts imports this module
// for its HTTP route, guestbook-app.ts for its sign verb, and the wake
// subscription persists the same ref — so ingress, spine delivery, and the
// creation batch can never disagree about which Durable Object (and which
// build) the guestbook is.
import type { StreamEventInput } from "iterate/processors";
import type { DynamicWorkerSource, StatefulDynamicWorkerRef } from "iterate/sdk";

export const guestbookStreamPath = "/guestbook";

const repoFiles = { type: "repo", repoPath: "/repos/config" } as const;

/** TanStack Start pages and browser assets, built by the app's Vite pipeline. */
export const guestbookPageSource = {
  files: repoFiles,
  options: { pipeline: "vite", rootDir: "apps/guestbook" },
} satisfies DynamicWorkerSource;

// One declarative ref for the guestbook host, shared by the HTTP routes and
// the wake subscription below — the same Durable Object either way, addressed
// by its durableWorkerKey. Its small Wrangler entry excludes the independent
// TanStack SSR build. The stale policy lets a still-running facet answer while
// the host checks for a newer repo version in the background; a cold facet
// mounts this exact cached artifact.
export const guestbookAppRef = {
  type: "stateful",
  path: "/",
  className: "GuestbookApp",
  durableWorkerKey: "app-guestbook",
  updatePolicy: "stale-while-rebuild",
  source: {
    files: repoFiles,
    options: {
      entryPoint: "src/guestbook-app.ts",
      minify: true,
      rootDir: "apps/guestbook",
    },
  },
} satisfies StatefulDynamicWorkerRef;

/**
 * The guestbook's creation batch: the birth certificate plus the durable
 * WAKE subscription that puts the GuestbookApp Durable Object on the
 * stream's own delivery spine — the platform evaluates the persisted
 * expression (`workers.get(ref).processor.wakeStreamSubscriber`, resolved
 * via the dynamic capability fallback into the app's `processor` getter),
 * performs the wake handshake, and pushes event frames straight into the
 * registry's runner. Same machinery, same lane as the platform's own
 * domain processors. Every creator (the app's sign verb, a script, a test)
 * offers this same batch. The birth key is permanent; the subscription event
 * key is versioned whenever its persisted expression changes. Its stable
 * subscriptionKey then replaces the old config without resetting its cursor.
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
      // v2 migrates the original Vite-backed worker ref to the independent,
      // small stateful entrypoint above. Keep subscriptionKey stable; bump
      // this event key whenever the persisted delivery expression changes.
      idempotencyKey: "guestbook/subscription:v2",
    },
  ];
}
