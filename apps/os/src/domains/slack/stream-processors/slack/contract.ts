// Contract for the "slack" processor mounted on `/integrations/slack`.
//
// The stream processor host announces contracts after each subscription
// handshake; the reducer lives on the `SlackProcessor` class.

import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/streams/shared/stream-processors";
import { CoreProcessorContract } from "@iterate-com/streams/processors/core/contract";

const NullableOptionalString = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.string().optional(),
);

/**
 * Processor mounted on `/integrations/slack`.
 *
 * This processor is only a Slack webhook router. It owns the raw Slack webhook
 * event and a reduced `channel:thread_ts -> streamPath` lookup table. It does
 * not interpret webhooks as agent input. Destination stream bootstrap is
 * supplied as opaque event descriptors by the host application.
 *
 * The intended flow is:
 *
 * 1. A Slack ingress worker appends the raw Slack Events API body to
 *    `/integrations/slack` as `events.iterate.com/slack/webhook-received`.
 * 2. If the webhook is about a Slack thread and that thread has no route yet,
 *    this processor emits `events.iterate.com/slack/thread-route-configured`.
 * 3. This processor forwards the original webhook body verbatim to the routed
 *    Slack-backed stream. `slack-agent` does the actual agent transcription.
 */
export const SlackProcessorContract = defineProcessorContract({
  slug: "slack",
  version: "0.1.0",
  description: "Routes raw Slack webhooks into Slack-backed agent streams.",
  stateSchema: z.object({
    connection: z
      .object({
        status: z.enum(["connected", "disconnected"]).default("disconnected"),
        connectionId: z.string().optional(),
        externalId: z.string().optional(),
        teamId: z.string().optional(),
        teamName: z.string().optional(),
      })
      .default({ status: "disconnected" }),
    /**
     * Durable Slack-thread-to-stream routing table.
     *
     * Key: `channel:thread_ts`.
     * Value: the stream path where forwarded Slack webhooks should land.
     */
    routes: z.record(z.string(), z.string()).default({}),
  }),
  initialState: {},
  // The core contract owns `events.iterate.com/stream/subscription-configured`,
  // which this processor emits when bootstrapping routed streams.
  processorDeps: [CoreProcessorContract],
  events: {
    "events.iterate.com/slack/connected": {
      description: "Slack OAuth connection was established for this project.",
      payloadSchema: z
        .object({
          connectionId: z.string(),
          externalId: z.string(),
          projectId: z.string(),
          scopes: z.array(z.string()).optional(),
          teamDomain: NullableOptionalString,
          teamId: NullableOptionalString,
          teamName: NullableOptionalString,
          webhookProviderIdentifier: NullableOptionalString,
        })
        .loose(),
    },
    "events.iterate.com/slack/disconnected": {
      description: "Slack OAuth connection was removed for this project.",
      payloadSchema: z
        .object({
          connectionId: z.string().optional(),
          externalId: z.string().optional(),
          projectId: z.string(),
          scopes: z.array(z.string()).optional(),
          teamDomain: NullableOptionalString,
          teamId: NullableOptionalString,
          teamName: NullableOptionalString,
          webhookProviderIdentifier: NullableOptionalString,
        })
        .loose(),
    },
    "events.iterate.com/slack/webhook-received": {
      description:
        "Raw Slack Events API callback body, appended by the Slack ingress worker to `/integrations/slack` and forwarded unchanged to routed thread streams.",
      payloadSchema: z.object({ body: z.record(z.string(), z.unknown()) }),
    },
    "events.iterate.com/slack/thread-route-configured": {
      description:
        "Declares that a Slack thread timestamp maps to a stream path. The Slack processor reduces this into its routing table on `/integrations/slack`.",
      payloadSchema: z.object({
        channel: z.string(),
        threadTs: z.string(),
        streamPath: z.string(),
      }),
    },
  },
  consumes: [
    "events.iterate.com/slack/connected",
    "events.iterate.com/slack/disconnected",
    "events.iterate.com/slack/thread-route-configured",
    "events.iterate.com/slack/webhook-received",
  ],
  emits: [
    "events.iterate.com/stream/subscription-configured",
    "events.iterate.com/slack/thread-route-configured",
    "events.iterate.com/slack/webhook-received",
  ],
});

export type SlackProcessorState = z.infer<typeof SlackProcessorContract.stateSchema>;
