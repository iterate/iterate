// Contract for the "slack-route" processor — Slack's provider-specific
// fan-out, mounted on the account stream `/integrations/slack/{account}`
// alongside the generic "integration" processor (both hosted by the
// account's IntegrationDurableObject).
//
// It consumes the generic capture envelope (`integration/event-received`)
// the ingress router forwards, keys each Slack webhook as
// `channel:thread_ts`, and forwards it — in the legacy
// `slack/webhook-received` wire format — to the per-thread agent stream the
// slack-agent processor consumes. Route memory lives on the account stream
// as `slack/thread-route-configured` events.

import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/streams/shared/stream-processors";
import { CoreProcessorContract } from "@iterate-com/streams/processors/core/contract";
import { IntegrationEventReceivedPayload } from "~/domains/integrations/integration-events.ts";

export const SlackRouteProcessorContract = defineProcessorContract({
  slug: "slack-route",
  version: "0.1.0",
  description:
    "Routes Slack events from the account's /integrations/slack/{account} stream into per-thread agent streams.",
  stateSchema: z.object({
    /**
     * Durable Slack-thread-to-stream routing table.
     * Key: `channel:thread_ts`. Value: the routed stream path.
     */
    routes: z.record(z.string(), z.string()).default({}),
  }),
  initialState: {},
  // The core contract owns `stream/subscription-configured`, which this
  // processor emits when bootstrapping routed streams.
  processorDeps: [CoreProcessorContract],
  events: {
    "events.iterate.com/integration/event-received": {
      description: "The generic capture envelope; payload.body is the raw Slack callback.",
      payloadSchema: IntegrationEventReceivedPayload,
    },
    "events.iterate.com/slack/thread-route-configured": {
      description:
        "Declares that a Slack thread timestamp maps to a stream path — the route memory.",
      payloadSchema: z.object({
        channel: z.string(),
        threadTs: z.string(),
        streamPath: z.string(),
      }),
    },
    "events.iterate.com/slack/webhook-received": {
      description:
        "The legacy per-thread wire format the slack-agent processor consumes: { body } forwarded verbatim to routed thread streams.",
      payloadSchema: z.object({ body: z.record(z.string(), z.unknown()) }),
    },
  },
  consumes: [
    "events.iterate.com/integration/event-received",
    "events.iterate.com/slack/thread-route-configured",
  ],
  emits: [
    "events.iterate.com/stream/subscription-configured",
    "events.iterate.com/slack/thread-route-configured",
    "events.iterate.com/slack/webhook-received",
  ],
});

export type SlackRouteProcessorState = z.infer<typeof SlackRouteProcessorContract.stateSchema>;
