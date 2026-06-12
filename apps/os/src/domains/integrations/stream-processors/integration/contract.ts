// Contract for the "integration" processor mounted on the PROJECT-namespace
// lifecycle stream `/integrations/{slug}`.
//
// This is where an integration LIVES inside a project: connection lifecycle,
// every routed provider event, and (next) the seam where provider-specific
// fan-out plugs in — the generalization of the Slack thread router, which
// today is a bespoke processor on /integrations/slack.

import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/streams/shared/stream-processors";
import {
  IntegrationConnectedPayload,
  IntegrationDisconnectedPayload,
  IntegrationEventReceivedPayload,
} from "~/domains/integrations/integration-events.ts";

export const IntegrationProcessorContract = defineProcessorContract({
  slug: "integration",
  version: "0.1.0",
  description:
    "Folds one integration ACCOUNT's lifecycle inside a project: connection state and routed provider events on /integrations/{slug}/{account}.",
  stateSchema: z.object({
    integration: z.string().optional(),
    account: z.string().optional(),
    connection: z
      .object({
        status: z.enum(["connected", "disconnected"]).default("disconnected"),
        ownership: z.enum(["first-party", "customer"]).optional(),
        externalId: z.string().optional(),
        displayName: z.string().optional(),
        routingKeys: z.array(z.string()).default([]),
        providedSecretSlugs: z.array(z.string()).default([]),
      })
      .default({ status: "disconnected", routingKeys: [], providedSecretSlugs: [] }),
    eventsReceived: z.number().default(0),
    lastEventAt: z.string().optional(),
  }),
  initialState: {},
  events: {
    "events.iterate.com/integration/connected": {
      description:
        "This project connected the integration — records ownership (first-party vs customer app), the provider-side identity, claimed routing keys, and provided Secret slugs.",
      payloadSchema: IntegrationConnectedPayload,
    },
    "events.iterate.com/integration/disconnected": {
      description: "This project disconnected the integration.",
      payloadSchema: IntegrationDisconnectedPayload,
    },
    "events.iterate.com/integration/event-received": {
      description:
        "A provider event routed to this project by the global ingress router, verbatim.",
      payloadSchema: IntegrationEventReceivedPayload,
    },
  },
  consumes: [
    "events.iterate.com/integration/connected",
    "events.iterate.com/integration/disconnected",
    "events.iterate.com/integration/event-received",
  ],
  emits: [],
});

export type IntegrationProcessorState = z.infer<typeof IntegrationProcessorContract.stateSchema>;
