// Contract for the "slack" webhook-router processor mounted on each
// per-project `/integrations/slack/{connection}` stream. Rewritten new-style
// for itx from the pre-migration slack domain (git history).

import { z } from "zod";
import { defineProcessorContract } from "iterate/processors";
import { AgentProcessorContract } from "../agents/agent-processor-contract.ts";
import { CapabilityHostProcessorContract } from "../capability-host/capability-host-processor-contract.ts";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";

const SlackBirthCertificate = z.object({
  config: z.object({ connection: z.string() }),
});

export const SlackAgentBirthCertificate = z.object({
  config: z.object({
    connection: z.string(),
    channel: z.string(),
    threadTs: z.string(),
  }),
});
export type SlackAgentBirthCertificate = z.output<typeof SlackAgentBirthCertificate>;

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
 * 3. Before forwarding the original webhook, this processor explicitly
 *    creates the Agent, CapabilityHost, and Slack facet on the routed stream
 *    and installs all three subscriptions. The `slack-agent` processor then
 *    does the actual transcription.
 */
export const SlackProcessorContract = defineProcessorContract({
  slug: "slack",
  version: "0.3.0",
  description: "Routes raw Slack webhooks into Slack-backed agent streams.",
  stateSchema: z.object({
    birthCertificate: SlackBirthCertificate.nullable().default(null),
    /**
     * Durable Slack-thread-to-stream routing table.
     *
     * Key: `channel:thread_ts`.
     * Value: the stream path where forwarded Slack webhooks should land.
     */
    routes: z.record(z.string(), z.string()).default({}),
  }),
  events: {
    "events.iterate.com/slack/created": {
      description: "Birth certificate for this Slack webhook router.",
      payloadSchema: SlackBirthCertificate,
      examples: [
        {
          description: "A Slack connection router is born for one named installation.",
          payload: { config: { connection: "acme-slack" } },
        },
      ],
    },
    "events.iterate.com/slack-agent/created": {
      description: "Birth certificate for the Slack facet on an agent stream.",
      payloadSchema: SlackAgentBirthCertificate,
      examples: [
        {
          description: "A Slack facet binds an agent stream to one thread.",
          payload: {
            config: {
              connection: "acme-slack",
              channel: "C01234567",
              threadTs: "1751980451.001200",
            },
          },
        },
      ],
    },
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
    "events.iterate.com/slack/created",
    "events.iterate.com/slack/thread-route-configured",
    "events.iterate.com/slack/webhook-received",
  ],
  processorDeps: [AgentProcessorContract, CapabilityHostProcessorContract, CoreProcessorContract],
  emits: [
    "events.iterate.com/agent/created",
    "events.iterate.com/agent/binding-set",
    "events.iterate.com/agent/configured",
    "events.iterate.com/agents/context-added",
    "events.iterate.com/capability-host/created",
    "events.iterate.com/capability-host/capability-provided",
    "events.iterate.com/slack-agent/created",
    "events.iterate.com/slack/thread-route-configured",
    "events.iterate.com/slack/webhook-received",
    "events.iterate.com/stream/subscription-configured",
  ],
});

/**
 * The contract's type under the same identifier, so type-level helpers read
 * without `typeof`: `ProcessorState<SlackProcessorContract>`,
 * `ConsumedEvent<SlackProcessorContract>`.
 */
export type SlackProcessorContract = typeof SlackProcessorContract;

export type SlackProcessorState = z.infer<typeof SlackProcessorContract.stateSchema>;
