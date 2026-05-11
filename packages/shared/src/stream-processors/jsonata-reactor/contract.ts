import { z } from "zod";
import {
  defineProcessorContract,
  reduceProcessorEvents,
  type StreamEvent,
} from "../stream-processor.ts";
import { CoreProcessorRegisteredEventType } from "../core/contract.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";

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

const JsonataReactorProcessorContractBase = defineProcessorContract({
  slug: "jsonata-reactor",
  version: "0.1.0",
  description:
    "Observes arbitrary stream events, matches them with JSONata rules, and appends configured reaction events.",
  stateSchema: z.object({
    ...standardProcessorBehavior.stateShape,
    rulesBySlug: z.record(z.string(), JsonataReactorRule.omit({ slug: true })).default({}),
  }),
  initialState: {
    ...standardProcessorBehavior.initialState,
  },
  processorDeps: [...standardProcessorBehavior.processorDeps],
  events: {
    [jsonataReactorEventTypes.ruleConfigured]: {
      description: "Adds or updates one JSONata reactor rule.",
      payloadSchema: JsonataReactorRule,
    },
  },
  consumes: [...standardProcessorBehavior.consumes, jsonataReactorEventTypes.ruleConfigured],
  emits: [...standardProcessorBehavior.emits],
  reduce({ contract, state, event }) {
    const nextState = standardProcessorBehavior.reduce({ state, event, contract });

    switch (event.type) {
      case CoreProcessorRegisteredEventType:
        return nextState;
      case jsonataReactorEventTypes.ruleConfigured:
        return {
          ...nextState,
          rulesBySlug: {
            ...nextState.rulesBySlug,
            [event.payload.slug]: {
              matcher: event.payload.matcher,
              reactions: event.payload.reactions,
            },
          },
        };
      default:
        return nextState;
    }
  },
});

export const JsonataReactorProcessorContract = Object.assign(JsonataReactorProcessorContractBase, {
  consumesAllEvents: true as const,
});

export function reduceJsonataReactorEvents(args: {
  events: readonly StreamEvent[];
  state?: JsonataReactorState;
}) {
  return reduceProcessorEvents({
    contract: JsonataReactorProcessorContract,
    events: args.events,
    state: args.state,
  });
}

export type JsonataReactorState = z.infer<typeof JsonataReactorProcessorContract.stateSchema>;
