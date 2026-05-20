import { defineProcessorContract } from "@iterate-com/shared/stream-processors";
import { z } from "zod";

export const SubscriptionProcessorContract = defineProcessorContract({
  slug: "subscription",
  version: "0.1.0",
  description: "Maintains durable StreamProcessor subscribers and pushes committed events to them.",
  stateSchema: z.object({
    subscribersByKey: z.record(
      z.string(),
      z.object({
        key: z.string(),
        processorSlug: z.string(),
        lastSentOffset: z.number().int().nonnegative(),
      }),
    ),
  }),
  initialState: {
    subscribersByKey: {},
  },
  events: {
    "events.iterate.com/stream/processor-subscribed": {
      description:
        "Registers a durable StreamProcessor object that should receive committed stream events.",
      payloadSchema: z.object({
        key: z.string(),
        processorSlug: z.string(),
      }),
    },
  },
  consumes: ["events.iterate.com/stream/processor-subscribed"],
  emits: [],
  reduce(args) {
    if (args.event.type !== "events.iterate.com/stream/processor-subscribed") return args.state;

    const existing = args.state.subscribersByKey[args.event.payload.key];
    return {
      subscribersByKey: {
        ...args.state.subscribersByKey,
        [args.event.payload.key]: {
          key: args.event.payload.key,
          processorSlug: args.event.payload.processorSlug,
          lastSentOffset: existing?.lastSentOffset ?? 0,
        },
      },
    };
  },
});
