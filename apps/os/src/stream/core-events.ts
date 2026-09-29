// core-events.ts — the core's events that a domain processor also consumes or appends. A leaf module (zod only):
// the Project contract names this catalog in its `processorDeps`, and the dash bundles that
// contract, so it must not pull core-processor.ts's facet and rewrite-rule code into a client.
// The core validates these at the append boundary and reduces them (core-processor.ts).
import { z } from "zod";

/** The core events a processor may consume or append without owning them. */
export const CoreEventCatalog = {
  events: {
    "events.iterate.com/itx/ingress-configured": {
      description:
        "Where the project's apex points: an itx expression, or null for nowhere. The core's control event: the append validates it and the core's reduce serves the apex from it (stream/core-processor.ts). The Project saga points it at the seed commit and the Project processor at every later commit of the config repo, each append keyed by its commit.",
      // Stored as the parsed expression: the append boundary normalizes a string target.
      payloadSchema: z.object({ target: z.array(z.unknown()).nullable() }),
    },
    "events.iterate.com/itx/subscription-configured": {
      description:
        "Who is sent this context's events: the row `name` hands `target` (an itx expression ending in the method called with each batch) the events it `consumes`, from the one after `afterOffset` (absent: from this event); the same name replaces the row, a null target removes it. The core's control event: the append validates it and the core's reduce keeps the table (stream/core-processor.ts). The Project processor writes the `config-worker` row beside every `itx/ingress-configured` it appends for the config repo.",
      // The fields the Project writes; the append boundary validates every field a row may carry.
      payloadSchema: z.object({
        name: z.string().min(1),
        target: z.array(z.unknown()).nullable(),
        consumes: z.array(z.string()).optional(),
        afterOffset: z.number().int().nonnegative().optional(),
      }),
    },
    "events.iterate.com/itx/child-created": {
      description:
        "A context under this one exists: every context appends it to each ancestor up to its root when it wakes (iterate-context-durable-object.ts `announceToAncestors`), keyed by the child's path, so it lands once per child. The Project processor reduces the ones on `/` into its context registry.",
      payloadSchema: z.object({ childPath: z.string().min(1) }),
    },
  },
};
