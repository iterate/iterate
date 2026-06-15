// Defines the "jsonata-reactor" processor contract.
//
// The `"*"` entry in `consumes` drives the host's subscription event-type
// filter (unfiltered delivery).

import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/shared/streams/stream-processors";

export const jsonataReactorEventTypes = {
  ruleConfigured: "events.iterate.com/jsonata-reactor/rule-configured",
} as const;

export const JsonataReactorExpression = z.string().trim().min(1);

export const AppendEventsReaction = z.strictObject({
  type: z.literal("append-events"),
  events: JsonataReactorExpression,
});

export const JsonataReactorRule = z.strictObject({
  slug: z.string().trim().min(1),
  matcher: JsonataReactorExpression,
  reactions: z.array(AppendEventsReaction),
});

export const JsonataReactorProcessorContract = defineProcessorContract({
  slug: "jsonata-reactor",
  version: "0.1.0",
  description:
    "Observes arbitrary stream events, matches them with JSONata rules, and appends configured reaction events.",
  stateSchema: z.object({
    rulesBySlug: z.record(z.string(), JsonataReactorRule.omit({ slug: true })).default({}),
  }),
  initialState: {},
  events: {
    [jsonataReactorEventTypes.ruleConfigured]: {
      description: "Adds or updates one JSONata reactor rule.",
      payloadSchema: JsonataReactorRule,
    },
  },
  consumes: ["*", jsonataReactorEventTypes.ruleConfigured],
  emits: [],
});

export type JsonataReactorState = z.infer<typeof JsonataReactorProcessorContract.stateSchema>;
