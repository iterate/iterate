// core-events.ts — the core's events that a domain processor also consumes. A leaf module (zod only):
// the Project contract names this catalog in its `processorDeps`, and the dash bundles that
// contract, so it must not pull core-processor.ts's facet and rewrite-rule code into a client.
// The core validates these at the append boundary and reduces them (core-processor.ts).
import { z } from "zod";

/** The core events a processor may consume without owning them. */
export const CoreEventCatalog = {
  events: {
    "events.iterate.com/itx/ingress-configured": {
      description:
        "Where the project's apex points: an itx expression, or null for nowhere. The core's control event: the append validates it and the core's reduce serves the apex from it (stream/core-processor.ts). The Project saga points it at the seed commit and the Project processor at every later commit of the config repo, each append keyed by its commit.",
      // Stored as the parsed expression: the append boundary normalizes a string target.
      payloadSchema: z.object({ target: z.array(z.unknown()).nullable() }),
    },
  },
};
