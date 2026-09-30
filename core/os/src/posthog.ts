// posthog.ts — every `reportIssue` (iterate/lib) also becomes a `$exception` in PostHog Error
// Tracking, from the edge and from every Durable Object alike: worker.ts installs it with
// `forwardIssues` at module load, the one module graph both run in. PostHog's Workers recipe
// (posthog.com/docs/libraries/cloudflare-workers): a client per capture, `flushAt: 1` and
// `flushInterval: 0`, the send in `waitUntil`. Retries are off: the SDK's only timers are then the
// request's own timeout, cleared when the fetch settles, so a report never holds a Durable
// Object resident past its one request.

import { env, waitUntil } from "cloudflare:workers";
import type { Issue } from "iterate/lib";
import { PostHog } from "posthog-node";
import { appConfigOf } from "./app-config.ts";
import type { Env } from "./env.ts";

/** Sent where the worker has a PostHog project key (`APP_CONFIG posthogProjectKey`) — envs.ts
 *  gives one to prd only, so previews and local dev report nothing. */
export function captureIssueInPosthog(issue: Issue): void {
  // `cloudflare:workers` types its env without this worker's bindings
  const config = appConfigOf(env as Env);
  if (!config.posthogProjectKey) return;
  const client = new PostHog(config.posthogProjectKey, {
    host: "https://eu.i.posthog.com",
    flushAt: 1,
    flushInterval: 0,
    fetchRetryCount: 0,
    requestTimeout: 5_000,
  });
  // No person: an issue carries no user, so PostHog records it without a person profile.
  const sent = client
    .captureExceptionImmediate(issue.caught, undefined, {
      ...issue.attributes,
      failureSite: issue.failureSite,
      $environment: config.urls.os ? new URL(config.urls.os).host : "unconfigured",
      deployId: config.deployId,
      $process_person_profile: false,
    })
    // the send has settled; a bounded shutdown (the SDK's default waits 30 s) holds nothing past it
    .then(() => client.shutdown(1_000))
    .catch((error: unknown) =>
      // warn, not error, and after the shutdown too: a failed report — capture or flush — must
      // never reject `waitUntil` into an uncaught error that pages the prd fault alarm
      console.warn({ event: "posthog.capture-failed", message: String(error) }),
    );
  waitUntil(sent);
}
