import { z } from "zod";
import {
  assertNever,
  defineProcessorContract,
  reduceProcessorEvents,
  type StreamEvent,
} from "../stream-processor.ts";
import { CoreProcessorRegisteredEventType } from "../core/contract.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";

export const jsonataTransformerEventTypes = {
  transformerConfigured: "events.iterate.com/jsonata-transformer/transformer-configured",
} as const;

export const JsonataExpression = z.string().trim().min(1);

/**
 * Shared JSONata transformer contract.
 *
 * The implementation imports JSONata directly because expression evaluation is
 * normal library code, not a deployment-specific runtime dependency.
 */
export const JsonataTransformerProcessorContract = defineProcessorContract({
  slug: "jsonata-transformer",
  version: "0.1.0",
  description: "Transforms matching source events into appended events using JSONata expressions.",
  stateSchema: z.object({
    ...standardProcessorBehavior.stateShape,
    transformersBySlug: z
      .record(
        z.string(),
        z.object({
          matcher: JsonataExpression,
          transform: JsonataExpression,
        }),
      )
      .default({}),
  }),
  initialState: {
    ...standardProcessorBehavior.initialState,
  },
  processorDeps: [...standardProcessorBehavior.processorDeps],
  events: {
    [jsonataTransformerEventTypes.transformerConfigured]: {
      description: "Adds or updates one JSONata transformer.",
      payloadSchema: z.strictObject({
        slug: z.string().trim().min(1),
        matcher: JsonataExpression,
        transform: JsonataExpression,
      }),
    },
  },
  consumes: [
    ...standardProcessorBehavior.consumes,
    jsonataTransformerEventTypes.transformerConfigured,
  ],
  emits: [...standardProcessorBehavior.emits],
  reduce({ contract, state, event }) {
    const nextState = standardProcessorBehavior.reduce({ state, event, contract });

    switch (event.type) {
      case CoreProcessorRegisteredEventType:
        return nextState;
      case jsonataTransformerEventTypes.transformerConfigured:
        return {
          ...nextState,
          transformersBySlug: {
            ...nextState.transformersBySlug,
            [event.payload.slug]: {
              matcher: event.payload.matcher,
              transform: event.payload.transform,
            },
          },
        };
      default:
        return assertNever(event);
    }
  },
});

export function reduceJsonataTransformerEvents(args: {
  events: readonly StreamEvent[];
  state?: JsonataTransformerState;
}) {
  return reduceProcessorEvents({
    contract: JsonataTransformerProcessorContract,
    events: args.events,
    state: args.state,
  });
}

export type JsonataTransformerState = z.infer<
  typeof JsonataTransformerProcessorContract.stateSchema
>;
