import { z } from "zod";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";
import { defineProcessorContract } from "../stream-processor.ts";

/**
 * Processor mounted on `/slack/webhooks`.
 *
 * This processor is only a Slack webhook router. It owns the raw Slack webhook
 * event and a reduced `channel:thread_ts -> streamPath` lookup table. It does
 * not interpret webhooks as agent input and it does not know about the Agent
 * processor.
 *
 * The intended flow is:
 *
 * 1. A Slack ingress worker appends the raw Slack Events API body to
 *    `/slack/webhooks` as `events.iterate.com/slack/webhook-received`.
 * 2. If the webhook is about a Slack thread and that thread has no route yet,
 *    this processor emits `events.iterate.com/slack/thread-route-configured`.
 * 3. This processor forwards the original webhook body verbatim to the routed
 *    Slack-backed stream. `slack-thread` does the actual agent transcription.
 */
export const SlackProcessorContract = defineProcessorContract({
  slug: "slack",
  version: "0.1.0",
  description: "Routes raw Slack webhooks into Slack-backed agent streams.",
  stateSchema: z.object({
    ...standardProcessorBehavior.stateShape,
    /**
     * Durable Slack-thread-to-stream routing table.
     *
     * Key: `channel:thread_ts`.
     * Value: the stream path where forwarded Slack webhooks should land.
     */
    routes: z.record(z.string(), z.string()).default({}),
  }),
  initialState: standardProcessorBehavior.initialState,
  processorDeps: [...standardProcessorBehavior.processorDeps],
  events: {
    "events.iterate.com/slack/webhook-received": {
      description:
        "Raw Slack Events API callback body, appended by the Slack ingress worker to `/slack/webhooks` and forwarded unchanged to routed thread streams.",
      payloadSchema: z.object({ body: z.record(z.string(), z.unknown()) }),
    },
    "events.iterate.com/slack/thread-route-configured": {
      description:
        "Declares that a Slack thread timestamp maps to a stream path. The Slack processor reduces this into its routing table on `/slack/webhooks`.",
      payloadSchema: z.object({
        channel: z.string(),
        threadTs: z.string(),
        streamPath: z.string(),
      }),
    },
  },
  consumes: [
    ...standardProcessorBehavior.consumes,
    "events.iterate.com/slack/thread-route-configured",
    "events.iterate.com/slack/webhook-received",
  ],
  emits: [
    ...standardProcessorBehavior.emits,
    "events.iterate.com/slack/thread-route-configured",
    "events.iterate.com/slack/webhook-received",
  ],
  reduce({ contract, state, event }) {
    const nextState = standardProcessorBehavior.reduce({ contract, state, event });
    switch (event.type) {
      case "events.iterate.com/slack/thread-route-configured":
        return {
          ...nextState,
          routes: {
            ...nextState.routes,
            [`${event.payload.channel}:${event.payload.threadTs}`]: event.payload.streamPath,
          },
        };
      default:
        return nextState;
    }
  },
});
