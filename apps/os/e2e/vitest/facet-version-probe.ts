/**
 * The instrument both facet-source-version suites use: a userspace facet that
 * reports which instance answered, which build it was loaded from, and which
 * source revision that build came from.
 *
 * Shared rather than copied so `userspace-facet-source-version.e2e.test.ts`
 * (the pin) and `userspace-facet-recycle-false-alarm.e2e.test.ts` (why the pin
 * false-alarms) measure the same facet the same way — the only difference
 * between them is what they DO to it.
 */

export const PING = "events.iterate.test/facet-version/ping";
export const SEEN = "events.iterate.test/facet-version/seen";

export const PROBE_PATH = "version-probe.js";

/** One `SEEN` payload: who answered, on which build, from which source. */
export type FacetProbeAnswer = { id: string; bootId: string; buildKey: string; revision: string };

/**
 * The probe facet, committed to the project's config repo. Plain JavaScript
 * (the platform bundles it; TS syntax fails the build as a
 * `subscription-delivery-halted` event) — so `#private` fields and plain
 * assignment instead of type annotations.
 *
 * It owes no background work, so `recovery` stays off: this probe is about
 * facet IDENTITY across incarnations, and a keepalive alarm would add a second
 * thing that revives the facet.
 */
export const probeFacetSource = (revision: string) => `
import { StreamProcessorFacet } from "iterate/sdk";
import { defineProcessorContract, StreamProcessor } from "iterate/processors";
import { z } from "zod";

export const VersionProbeContract = defineProcessorContract({
  slug: "facet-version",
  version: "1.0.0",
  description: "Reports which facet instance and which loaded build handled each ping.",
  stateSchema: z.object({ seen: z.array(z.string()).default([]) }),
  events: {
    "${PING}": {
      description: "Ask the facet to identify itself.",
      payloadSchema: z.object({ id: z.string() }),
    },
    "${SEEN}": {
      description: "The answering facet instance, its build key, and its source revision.",
      payloadSchema: z.object({
        id: z.string(),
        bootId: z.string(),
        buildKey: z.string(),
        revision: z.string(),
      }),
    },
  },
  consumes: ["${PING}"],
  emits: ["${SEEN}"],
});

class VersionProbeProcessor extends StreamProcessor {
  contract = VersionProbeContract;
  // Set by the facet below, once per created processor.
  bootId = "unset";
  buildKey = "unset";

  reduce({ state, event }) {
    return { ...state, seen: [...state.seen, event.payload.id] };
  }

  processEvent({ event, append, blockProcessorWhile }) {
    if (event === null || event.type !== "${PING}") return;
    const id = event.payload.id;
    const bootId = this.bootId;
    const buildKey = this.buildKey;
    // Per-event work the cursor must not outrun: the answer IS the measurement.
    blockProcessorWhile(async () => {
      await append({
        type: "${SEEN}",
        idempotencyKey: "seen@" + id,
        // Baked into the SOURCE, so the answer says which build actually ran.
        payload: { id, bootId, buildKey, revision: "${revision}" },
      });
    });
  }
}

export class VersionProbeFacet extends StreamProcessorFacet {
  // One per FACET INSTANCE: a new value proves the facet was torn down and
  // started again (the base rebuilds its host per incarnation, but this field
  // lives on the Durable Object instance itself).
  #bootId = crypto.randomUUID();

  createProcessor(deps) {
    const processor = new VersionProbeProcessor(deps);
    processor.bootId = this.#bootId;
    // The build key the Stream DO resolved for this load — verbatim the
    // cacheKey half of the facetSourceVersion marker that drives the abort.
    processor.buildKey = String(this.env.ITERATE_WORKER_VERSION ?? "missing");
    return processor;
  }
}
`;
