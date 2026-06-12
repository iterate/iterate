// Contract for the "integration-ingress" router processor, mounted on the
// GLOBAL-namespace capture stream `/integrations/{slug}/webhooks`.
//
// One instance per integration for the whole deployment. Its only job is the
// routing hop: fold `route-registered` events (appended by project connect
// flows) into a routingKey → projectId table, and cross-post each captured
// provider event into the owning project's `/integrations/{slug}` stream.
// Fully event-sourced — no D1 lookup in the webhook path; the routing table
// IS the fold of this stream.

import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/streams/shared/stream-processors";
import {
  IntegrationEventReceivedPayload,
  IntegrationRouteRegisteredPayload,
  IntegrationRouteRemovedPayload,
} from "~/domains/integrations/integration-events.ts";

export const IntegrationIngressProcessorContract = defineProcessorContract({
  slug: "integration-ingress",
  version: "0.1.0",
  description:
    "Routes captured provider events from the global ingress stream to the claiming account's /integrations/{slug}/{account} stream, by routing key.",
  stateSchema: z.object({
    integration: z.string().optional(),
    /** routingKey (e.g. "installation:123", "guild:456") → the claiming
     * integration ACCOUNT. One key, one owner — but one project can hold
     * many accounts, each claiming its own keys. */
    routes: z
      .record(z.string(), z.object({ projectId: z.string(), account: z.string() }))
      .default({}),
    dropped: z.number().default(0),
  }),
  initialState: {},
  events: {
    "events.iterate.com/integration/event-received": {
      description:
        "A raw provider event (webhook body or gateway dispatch) captured verbatim at ingress, before any routing decision.",
      payloadSchema: IntegrationEventReceivedPayload,
    },
    "events.iterate.com/integration/route-registered": {
      description:
        "A project claimed a provider routing key (installation, guild, team). Appended by the connect flow; folded into the router's table.",
      payloadSchema: IntegrationRouteRegisteredPayload,
    },
    "events.iterate.com/integration/route-removed": {
      description: "A routing-key claim was released (disconnect).",
      payloadSchema: IntegrationRouteRemovedPayload,
    },
  },
  consumes: [
    "events.iterate.com/integration/event-received",
    "events.iterate.com/integration/route-registered",
    "events.iterate.com/integration/route-removed",
  ],
  // Cross-namespace forwarding goes through a host-supplied dep (the stream
  // append primitive is namespace-local), so this processor emits nothing on
  // its own stream.
  emits: [],
});

export type IntegrationIngressProcessorState = z.infer<
  typeof IntegrationIngressProcessorContract.stateSchema
>;
