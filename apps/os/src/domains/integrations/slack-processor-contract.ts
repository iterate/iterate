// Contract for the "slack" webhook-router processor mounted on each
// per-project `/integrations/slack/{connection}` stream. It also owns the
// `slack-agent/created` birth event for the Slack facet on routed agent
// streams: the router is what appends it (inside the creation batch it sends
// to a fresh thread stream), and declaring it here keeps the contract import
// direction one-way (slack-agent depends on slack, never back).

import { z } from "zod";
import { defineProcessorContract } from "iterate/processors";
import { AgentProcessorContract } from "../agents/agent-processor-contract.ts";
import { CapabilityHostProcessorContract } from "../capability-host/capability-host-processor-contract.ts";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";

export const SlackProcessorContract = defineProcessorContract({
  slug: "slack",
  version: "0.3.0",
  description:
    "Routes raw Slack webhooks into Slack-backed agent streams: reduces a " +
    "`channel:thread_ts → stream path` routing table, births the routed agent " +
    "stream on first contact, and forwards each webhook unchanged. It never " +
    "interprets webhooks as agent context — that is the slack-agent processor's job.",
  stateSchema: z.object({
    birthCertificate: slackRouterBirthCertificateSchema()
      .nullable()
      .default(null)
      .meta({
        description:
          "Existence marker: null until slack/created reduces. The router forwards nothing " +
          "before it — the named connection in the certificate qualifies every thread path " +
          "this router creates.",
      }),
    routes: z
      .record(
        z.string().meta({ description: "Slack thread key, `channel:thread_ts`." }),
        z.string().meta({ description: "Stream path forwarded Slack webhooks land on." }),
      )
      .default({})
      .meta({
        description:
          "Durable Slack-thread-to-stream routing table, reduced from " +
          "slack/thread-route-configured facts. A webhook whose thread key is present here " +
          "forwards to the recorded path; a missing key on a routable webhook creates the " +
          "route (and the routed stream) first.",
      }),
  }),
  events: {
    "events.iterate.com/slack/created": {
      description: "Birth certificate for this Slack webhook router.",
      payloadSchema: slackRouterBirthCertificateSchema(),
      examples: [
        {
          description: "A Slack connection router is born for one named installation.",
          payload: { config: { connection: "acme-slack" } },
        },
      ],
    },
    "events.iterate.com/slack-agent/created": {
      description: "Birth certificate for the Slack facet on an agent stream.",
      payloadSchema: z.object({
        config: z
          .object({
            connection: z
              .string()
              .meta({ description: "Named Slack connection the facet posts through." }),
            channel: z.string().meta({ description: "Slack channel id of the bound thread." }),
            threadTs: z
              .string()
              .meta({ description: "Slack thread timestamp of the bound thread." }),
          })
          .meta({ description: "The one Slack thread this agent stream is bound to." }),
      }),
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
        "Raw Slack Events API callback body, appended by the webhook route to " +
        "`/integrations/slack/{connection}` and forwarded unchanged to routed thread streams.",
      payloadSchema: z
        .object({
          body: z
            .record(z.string(), z.unknown())
            .meta({ description: "The Slack callback body, verbatim as Slack delivered it." }),
        })
        .loose()
        .meta({
          description: "The webhook envelope; extra keys (headers, team id) ride along untouched.",
        }),
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
        "Declares that a Slack thread timestamp maps to a stream path. The Slack router " +
        "reduces this into its routing table on `/integrations/slack/{connection}`.",
      payloadSchema: z.object({
        channel: z.string().meta({ description: "Slack channel id of the routed thread." }),
        threadTs: z.string().meta({ description: "Slack thread timestamp of the routed thread." }),
        streamPath: z
          .string()
          .meta({ description: "Stream path future webhooks for this thread forward to." }),
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

/**
 * The router's birth certificate — the ONE schema this contract uses twice
 * (the `slack/created` payload and the reduced state's existence marker), so
 * it lives in this hoisted function below the contract. The slack-agent
 * contract's birth certificate is NOT here: it appears once, inline on the
 * `slack-agent/created` event, and the sibling contract reaches through
 * `SlackProcessorContract.events[...]` for it.
 */
function slackRouterBirthCertificateSchema() {
  return z.object({
    config: z
      .object({
        connection: z.string().meta({
          description:
            "Named Slack connection (workspace installation) this router serves; " +
            "qualifies the `/agents/slack/{connection}/…` thread paths it creates.",
        }),
      })
      .meta({ description: "Router configuration fixed at birth." }),
  });
}
