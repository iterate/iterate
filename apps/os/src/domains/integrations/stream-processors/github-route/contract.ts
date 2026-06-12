// Contract for the "github-route" processor — GitHub's provider-specific
// fan-out, mounted on the account stream `/integrations/github/{account}`
// alongside the generic "integration" processor (both hosted by the
// account's IntegrationDurableObject). The exact sibling of slack-route:
// where Slack events fan out to per-thread AGENT streams, GitHub events fan
// out to per-repo REPO streams.
//
// Route memory is declared, not learned: linking an iterate repo to a GitHub
// repo appends `github/repo-route-configured` here (the REPO processor's
// reaction to `repo/remote-configured` — see
// domains/repos/stream-processors/repo-stream-processor.ts). This processor
// folds those into a full_name → repo stream path table and forwards every
// matching webhook envelope verbatim.

import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/streams/shared/stream-processors";
import { IntegrationEventReceivedPayload } from "~/domains/integrations/integration-events.ts";

export const GithubRouteProcessorContract = defineProcessorContract({
  slug: "github-route",
  version: "0.1.0",
  description:
    "Routes GitHub events from the account's /integrations/github/{account} stream into per-repo streams, by repository full name.",
  stateSchema: z.object({
    /** `owner/name` (lowercased) → the linked repo's stream path. */
    routes: z.record(z.string(), z.string()).default({}),
  }),
  initialState: {},
  events: {
    "events.iterate.com/integration/event-received": {
      description: "The generic capture envelope; payload.body is the raw GitHub webhook.",
      payloadSchema: IntegrationEventReceivedPayload,
    },
    "events.iterate.com/github/repo-route-configured": {
      description:
        "Declares that a GitHub repository maps to an iterate repo's stream — the route memory, appended by the repo processor when a remote is configured.",
      payloadSchema: z.object({
        /** GitHub `owner/name`, matched case-insensitively. */
        fullName: z.string(),
        repoStreamPath: z.string(),
      }),
    },
    "events.iterate.com/github/repo-route-removed": {
      description: "Releases a repository → repo-stream link.",
      payloadSchema: z.object({ fullName: z.string() }),
    },
  },
  consumes: [
    "events.iterate.com/integration/event-received",
    "events.iterate.com/github/repo-route-configured",
    "events.iterate.com/github/repo-route-removed",
  ],
  emits: ["events.iterate.com/integration/event-received"],
});

export type GithubRouteProcessorState = z.infer<typeof GithubRouteProcessorContract.stateSchema>;
