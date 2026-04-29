import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/shared/stream-processors";
import type { EventCatalog, StreamEventInput } from "@iterate-com/shared/stream-processors";

export const CoreProcessorRegisteredEventType = "events.iterate.com/core/processor/registered";

/**
 * Minimal core processor contract for shared processor lifecycle events.
 *
 * This is app-local while the abstraction is still settling. It gives ordinary
 * processors a canonical event to announce "this processor version is active
 * on this stream" without reaching into `events-contract`.
 */
export const CoreProcessorContract = defineProcessorContract({
  slug: "core",
  version: "0.1.0",
  description: "Core stream processor lifecycle events.",
  stateSchema: z.object({}).default({}),
  events: {
    "events.iterate.com/core/processor/registered": {
      description: "A processor registered its public contract on this stream.",
      payloadSchema: z.object({
        slug: z.string(),
        version: z.string(),
        description: z.string(),
        consumes: z.array(z.string()),
        emits: z.array(z.string()),
        ownedEvents: z.array(
          z.object({
            type: z.string(),
            description: z.string().optional(),
          }),
        ),
      }),
    },
  },
  consumes: [],
  emits: ["events.iterate.com/core/processor/registered"],
});

export function createProcessorRegisteredInput(args: {
  contract: {
    slug: string;
    version: string;
    description: string;
    consumes: readonly string[];
    emits: readonly string[];
    events: EventCatalog;
  };
}): StreamEventInput<
  typeof CoreProcessorRegisteredEventType,
  z.output<
    (typeof CoreProcessorContract.events)[typeof CoreProcessorRegisteredEventType]["payloadSchema"]
  >
> {
  return {
    type: CoreProcessorRegisteredEventType,
    idempotencyKey: `processor-registered:${args.contract.slug}:${args.contract.version}`,
    payload: {
      slug: args.contract.slug,
      version: args.contract.version,
      description: args.contract.description,
      consumes: [...args.contract.consumes],
      emits: [...args.contract.emits],
      ownedEvents: Object.values(args.contract.events).map((event) => ({
        type: getEventType(args.contract.events, event),
        ...(event.description == null ? {} : { description: event.description }),
      })),
    },
  };
}

function getEventType(events: EventCatalog, eventDefinition: EventCatalog[string]): string {
  for (const [eventType, event] of Object.entries(events)) {
    if (event === eventDefinition) {
      return eventType;
    }
  }

  throw new Error("Event definition does not belong to the provided event catalog.");
}
