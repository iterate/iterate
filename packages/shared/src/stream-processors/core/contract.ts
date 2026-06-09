import { z } from "zod";
import { defineProcessorContract } from "../stream-processor.ts";
import type { EventCatalog, StreamEventInput } from "../stream-processor.ts";

export const CoreProcessorRegisteredEventType =
  "events.iterate.com/core/stream-processor-registered";
export const CoreProcessorErrorOccurredEventType = "events.iterate.com/core/error-occurred";

/**
 * Minimal core processor contract for shared processor lifecycle events.
 *
 * This is app-local while the abstraction is still settling. It gives ordinary
 * processors a canonical event to announce "this processor version is active
 * on this stream" without reaching into an app contract.
 */
export const CoreProcessorContract = defineProcessorContract({
  slug: "core",
  version: "0.1.0",
  description: "Core stream processor lifecycle events.",
  stateSchema: z.object({}).default({}),
  events: {
    "events.iterate.com/core/stream-processor-registered": {
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
            examples: z
              .array(
                z.object({
                  description: z.string(),
                  payload: z.unknown(),
                }),
              )
              .optional(),
          }),
        ),
      }),
    },
    "events.iterate.com/core/error-occurred": {
      description:
        "A stream processor runner or stream core component recorded a structured error event.",
      payloadSchema: z.object({
        message: z.string().trim().min(1),
        error: z
          .object({
            name: z.string().trim().min(1).optional(),
            message: z.string().trim().min(1),
            code: z.string().trim().min(1).optional(),
            stack: z.string().trim().min(1).optional(),
          })
          .optional(),
      }),
    },
  },
  consumes: [],
  emits: [
    "events.iterate.com/core/stream-processor-registered",
    "events.iterate.com/core/error-occurred",
  ],
});

/**
 * Builds the standard core registration event for a processor contract.
 *
 * Well-behaved processors append this event once per processor version. Keeping
 * this helper centralized prevents each processor from hand-building the same
 * payload and idempotency key, and it guarantees the event describes only the
 * processor's owned event catalog. Imported `processorDeps` still appear in
 * `consumes` / `emits`, but their schemas are owned and documented elsewhere.
 */
export function buildProcessorRegisteredEvent(args: {
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
      ownedEvents: Object.entries(args.contract.events).map(([type, event]) => ({
        type,
        ...(event.description == null ? {} : { description: event.description }),
        ...(event.examples == null || event.examples.length === 0
          ? {}
          : { examples: [...event.examples] }),
      })),
    },
  };
}
