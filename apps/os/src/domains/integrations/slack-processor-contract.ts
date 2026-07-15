// Contract for the "slack" webhook-router processor mounted on each
// per-project `/integrations/slack/{connection}` stream. Rewritten new-style
// for itx from the pre-migration slack domain (git history).

import { z } from "zod";
import { defineProcessorContract } from "../streams/processor-contracts.ts";

/**
 * Processor mounted on `/integrations/slack/{connection}`.
 *
 * This processor is only a Slack webhook router. It owns the raw Slack webhook
 * event and a reduced `channel:thread_ts -> streamPath` lookup table. It does
 * not interpret webhooks as agent context.
 *
 * The intended flow is:
 *
 * 1. The webhook route appends the raw Slack Events API body to
 *    `/integrations/slack/{connection}` as `events.iterate.com/slack/webhook-received`.
 * 2. If the webhook is about a Slack thread and that thread has no route yet,
 *    this processor emits `events.iterate.com/slack/thread-route-configured`.
 * 3. This processor forwards the original webhook body verbatim to the routed
 *    Slack-backed agent stream. The `slack-agent` processor on that stream does
 *    the actual agent transcription; the project processor's
 *    child-stream-created lane gives the routed stream its subscriptions.
 */
export const SlackProcessorContract = defineProcessorContract({
  slug: "slack",
  version: "0.3.0",
  description: "Routes raw Slack webhooks into Slack-backed agent streams.",
  stateSchema: z.object({
    /**
     * Durable Slack-thread-to-stream routing table.
     *
     * Key: `channel:thread_ts`.
     * Value: the stream path where forwarded Slack webhooks should land.
     */
    routes: z.record(z.string(), z.string()).default({}),
  }),
  events: {
    "events.iterate.com/slack/webhook-received": {
      description:
        "Raw Slack Events API callback body, appended by the webhook route to `/integrations/slack/{connection}` and forwarded unchanged to routed thread streams.",
      payloadSchema: z.object({ body: z.record(z.string(), z.unknown()) }).loose(),
      examples: [
        {
          description:
            "A threaded Slack message, as Slack's Events API delivers it (trimmed to the typical fields).",
          payload: {
            body: {
              type: "event_callback",
              team_id: "T0XYZ1234",
              api_app_id: "A0AB12CD3",
              event: {
                type: "message",
                channel: "C0AB12CD3",
                user: "U0DE45FG6",
                text: "Hey @iterate, can you take a look at this?",
                ts: "1751980451.204569",
                thread_ts: "1751980423.123456",
                channel_type: "channel",
              },
              event_id: "Ev0HI78JK9",
              event_time: 1751980451,
            },
          },
        },
      ],
    },
    "events.iterate.com/slack/thread-route-configured": {
      description:
        "Declares that a Slack thread timestamp maps to a stream path. The Slack processor reduces this into its routing table on `/integrations/slack`.",
      payloadSchema: z.object({
        channel: z.string(),
        threadTs: z.string(),
        streamPath: z.string(),
      }),
      examples: [
        {
          description:
            "A fresh Slack thread gets its own routed agent stream (`/agents/slack/{connection}/{channel}/ts-{threadTs}`, channel and ts sanitized to lowercase kebab).",
          payload: {
            channel: "C0AB12CD3",
            threadTs: "1751980423.123456",
            streamPath: "/agents/slack/acme/c0ab12cd3/ts-1751980423-123456",
          },
        },
      ],
    },
  },
  consumes: [
    "events.iterate.com/slack/thread-route-configured",
    "events.iterate.com/slack/webhook-received",
  ],
  emits: [
    "events.iterate.com/slack/thread-route-configured",
    "events.iterate.com/slack/webhook-received",
  ],
});

/**
 * The contract's type under the same identifier, so type-level helpers read
 * without `typeof`: `ProcessorState<SlackProcessorContract>`,
 * `ConsumedEvent<SlackProcessorContract>`, `ProcessorEvent<SlackProcessorContract, T>`.
 */
export type SlackProcessorContract = typeof SlackProcessorContract;

export type SlackProcessorState = z.infer<typeof SlackProcessorContract.stateSchema>;
