// The review bot's shared IDENTITY, dependency-free on purpose (type-only
// imports bundle to pure data): the repo root's worker.ts imports this module
// for its subscription bootstrap lane, and the wake subscription persists the
// same ref — so the bootstrap and the stream spine can never disagree about
// which Durable Object (and which build) reviews a connection's pull requests.
import type { StreamEventInput } from "iterate/processors";
import type { DynamicWorkerSource, StatefulDynamicWorkerRef } from "iterate/sdk";

export const reviewBotSubscriptionConfigVersion = 1;

/** The stream that carries a connection's first-hand GitHub webhooks. */
export function githubConnectionStreamPath(connection: string): string {
  return `/integrations/github/${connection}`;
}

/** One build recipe shared by every connection's host. */
export const reviewBotAppSource = {
  createWorker: {
    entryPoint: "apps/review-bot/src/review-bot-app.ts",
    files: { type: "repo", repoPath: "/repos/config" },
    minify: true,
  },
} satisfies DynamicWorkerSource;

/**
 * Webhook streams are per connection and a wake subscription names one exact
 * stream, so each GitHub connection gets its own host instance: the
 * durableWorkerKey carries the connection slug, and the host learns its
 * stream coordinates from the wake request itself (review-bot-app.ts).
 */
export function reviewBotAppRef(connection: string) {
  return {
    type: "stateful",
    path: "/",
    className: "ReviewBotApp",
    durableWorkerKey: `app-review-bot:${connection}`,
    source: reviewBotAppSource,
  } satisfies StatefulDynamicWorkerRef;
}

/**
 * The durable WAKE subscription that puts a connection's ReviewBotApp on that
 * webhook stream's delivery spine. worker.ts offers this batch each time a
 * repo is linked (`repo/github-link-configured`); the stable subscriptionKey
 * means the latest config replaces the old target without resetting its
 * cursor.
 */
export function reviewBotSubscriptionEvents(connection: string): StreamEventInput[] {
  return [
    {
      type: "events.iterate.com/stream/subscription-configured",
      payload: {
        subscriptionKey: "app-review-bot#review-bot",
        delivery: {
          mode: "wake",
          expression: [
            "workers",
            ["get", reviewBotAppRef(connection)],
            "processor",
            "wakeStreamSubscriber",
          ],
          processorSlug: "review-bot",
        },
      },
      idempotencyKey: `review-bot/subscription:v${reviewBotSubscriptionConfigVersion}`,
    },
  ];
}
