// Contract for the "slack" webhook-router processor mounted on the per-project
// `/integrations/slack` stream. Rewritten new-style for the next engine from
// the legacy-quarantine reference (legacy-quarantine/domains/slack/).

import { z } from "zod";
import { defineProcessorContract } from "../streams/stream-processor.ts";

const NullableOptionalString = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.string().optional(),
);

/**
 * Processor mounted on `/integrations/slack`.
 *
 * This processor is only a Slack webhook router. It owns the raw Slack webhook
 * event and a reduced `channel:thread_ts -> streamPath` lookup table. It does
 * not interpret webhooks as agent input.
 *
 * The intended flow is:
 *
 * 1. The webhook route appends the raw Slack Events API body to
 *    `/integrations/slack` as `events.iterate.com/slack/webhook-received`.
 * 2. If the webhook is about a Slack thread and that thread has no route yet,
 *    this processor emits `events.iterate.com/slack/thread-route-configured`.
 * 3. This processor forwards the original webhook body verbatim to the routed
 *    Slack-backed agent stream. The `slack-agent` processor on that stream does
 *    the actual agent transcription; the project processor's
 *    child-stream-created lane gives the routed stream its subscriptions.
 */
export const SlackProcessorContract = defineProcessorContract({
  slug: "slack",
  version: "0.2.0",
  description: "Routes raw Slack webhooks into Slack-backed agent streams.",
  stateSchema: z.object({
    connection: z
      .object({
        status: z.enum(["connected", "disconnected"]).default("disconnected"),
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
  events: {
    "events.iterate.com/slack/connected": {
      description: "Slack OAuth connection was established for this project.",
      payloadSchema: z
        .object({
          externalId: z.string(),
          projectId: z.string(),
          scopes: z.array(z.string()).optional(),
          teamDomain: NullableOptionalString,
          teamId: NullableOptionalString,
          teamName: NullableOptionalString,
        })
        .loose(),
    },
    "events.iterate.com/slack/disconnected": {
      description: "Slack OAuth connection was removed for this project.",
      payloadSchema: z
        .object({
          externalId: z.string().optional(),
          projectId: z.string(),
          teamId: NullableOptionalString,
          teamName: NullableOptionalString,
        })
        .loose(),
    },
    "events.iterate.com/slack/webhook-received": {
      description:
        "Raw Slack Events API callback body, appended by the webhook route to `/integrations/slack` and forwarded unchanged to routed thread streams.",
      payloadSchema: z.object({ body: z.record(z.string(), z.unknown()) }).loose(),
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
    "events.iterate.com/slack/thread-route-configured",
    "events.iterate.com/slack/webhook-received",
  ],
});

export type SlackProcessorState = z.infer<typeof SlackProcessorContract.stateSchema>;
