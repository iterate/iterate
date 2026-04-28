import { z } from "zod";
import {
  GenericEvent as GenericEventBase,
  GenericEventInput as GenericEventInputBase,
} from "@iterate-com/events-contract";
import { AgentLoopProcessorState } from "./agent-loop-processor-types.ts";
import { CodemodeProcessorState } from "./codemode-processor-types.ts";

/**
 * Reduced projection persisted in the DO's synchronous KV (under key
 * `iterate-agent:stream-processor-state`). Small + lightweight — not execution payloads.
 */
export const IterateAgentProcessorState = AgentLoopProcessorState.merge(CodemodeProcessorState);
export type IterateAgentProcessorState = z.infer<typeof IterateAgentProcessorState>;

function defineEventSchemas<const TType extends string, TPayload extends z.ZodType>(args: {
  type: TType;
  payload: TPayload;
}) {
  const input = GenericEventInputBase.extend({
    type: z.literal(args.type),
    payload: args.payload,
  });
  const event = GenericEventBase.extend(input.pick({ type: true, payload: true }).shape);
  return { event, input };
}

/**
 * Debug round-trip: any client can append `debug-info-requested` to dump the
 * processor's current view of state + the DO's synchronous runtime view (just
 * `inflightRequestId` for now) into the stream as a `debug-info-returned`
 * event. Cheap; no reducer side effects.
 */

export const { event: DebugInfoRequestedEvent, input: DebugInfoRequestedEventInput } =
  defineEventSchemas({
    type: "debug-info-requested",
    payload: z.object({}),
  });

export const DebugInfoReturnedEventInput = defineEventSchemas({
  type: "debug-info-returned",
  payload: z.object({
    state: IterateAgentProcessorState,
    runtime: z.object({
      inflightRequestId: z.string().nullable(),
    }),
  }),
}).input;
