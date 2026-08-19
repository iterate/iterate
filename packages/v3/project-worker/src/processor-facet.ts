// processor-facet.ts — THE BUILT-IN FACET SPINE: a stream processor hosted in a real workerd
// facet (`ctx.facets.get`) on the Stream DO, with its OWN isolated SQLite-backed storage and
// independent abort/restart. A facet hosts a DURABLE OBJECT; *stream processor* is the role its
// object plays. This is the DISTANCE lane — for built-in processors with effects (processEvent,
// retries, isolation needs); the ITERATE CONTEXT and the CORE processor are reduce-only and run
// INLINE at the parent's commit point instead (zero distance needs zero runner — see
// core/processor.ts ReduceOnlyProcessor and the core-processor jam doc).
//
// The parent↔facet channel:
//   • IDENTITY via first-contact `configure({ parentName, projectId, path, slug })` — plain data,
//     stashed DURABLY in the facet's own kv (a facet cannot receive constructor args, and a
//     parent-chosen env is impossible for a built-in class: it inherits the WORKER's env).
//   • BACK-CHANNEL by NAME, never a live stub: the facet re-resolves `env.CONTEXT
//     .getByName(parentName)` per use (stubs must not outlive their RPC turn).
//   • DELIVERY via `processEventBatch(events, window)` — the parent pushes every commit with its
//     scan-window proof; the base class folds the fast path and gap-repairs from the log
//     otherwise. No registry: the processor IS its own runner (core/processor.ts).
//
// Platform constraints carried deliberately: facets have NO alarms (workerd#6810 — the parent
// proxies when a processor needs one; none does yet) and hold NO hibernatable sockets (the
// parent owns all transport; workerd#6702). A facet must never enumerate the parent's
// `getWebSockets` (the #6702 prod leak). And per workerd#6800 the PARENT aborts idle facets
// (see the quiesce alarm in stream-durable-object.ts) — losing nothing, because every cursor
// here is durable in the facet's own storage and rebuild is cursor-driven.

import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { defineProcessorContract, type StreamEvent } from "./core/events.ts";
import {
  StreamProcessor,
  type ProcessorSnapshot,
  type ProcessorStorage,
  type ProcessorStream,
  type ReduceArgs,
  type ScanWindow,
} from "./core/processor.ts";
import type { RootsEnv } from "./roots-builder.ts";

interface Env extends RootsEnv {
  APP_CONFIG?: string;
}

/** The identity a facet is configured with — plain data, durable in the facet's own kv.
 *  `export` names the userspace module export for loader-hosted processors (runner.js). */
export type FacetIdentity = {
  parentName: string;
  projectId: string;
  path: string;
  slug: string;
  export?: string;
};

// ── the demo built-in facet processor: tally events by type ──
// Proves the whole spine (configure → push → fold → snapshot-through-parent) with the smallest
// possible processor.
const TallyContract = defineProcessorContract({
  slug: "tally",
  version: "1.0.0",
  description: "Counts committed events by type — the facet-spine demo processor.",
  stateSchema: z.object({ counts: z.record(z.string(), z.number()).default({}) }),
  events: {},
  consumes: ["*"],
  emits: [],
});

class TallyProcessor extends StreamProcessor<{ counts: Record<string, number> }> {
  readonly contract = TallyContract;
  protected override reduce({ event, state }: ReduceArgs<{ counts: Record<string, number> }>) {
    return { counts: { ...state.counts, [event.type]: (state.counts[event.type] ?? 0) + 1 } };
  }
}

/** What a built-in facet-processor factory receives: the stream + storage + identity. */
type FacetProcessorArgs = {
  stream: ProcessorStream;
  storage: ProcessorStorage;
  path: string;
  projectId: string;
  identity: FacetIdentity;
};

/** Built-in facet-hosted processors by slug. (Loader-loaded userspace classes ride the same
 *  spine through the injected runner.js instead of this map.) */
const FACET_PROCESSORS: Record<
  string,
  // `any` because StreamProcessor is invariant in State — every concrete subclass must fit.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (args: FacetProcessorArgs) => StreamProcessor<any>
> = {
  tally: (args) => new TallyProcessor(args),
};

export class ProcessorFacet extends DurableObject<Env> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #processor?: StreamProcessor<any>;

  /** First contact: the parent hands the facet its identity. Durable — survives facet restarts. */
  configure(identity: FacetIdentity): { ok: true } {
    this.ctx.storage.kv.put("identity", identity);
    return { ok: true };
  }

  /** The parent pushes every commit here with its scan-window proof. Fire-and-forget from the
   *  parent's side; the base class serializes, folds the fast path, gap-repairs otherwise. */
  async processEventBatch(events: StreamEvent[], window: ScanWindow): Promise<void> {
    await this.#p().processEventBatch(events, window);
  }

  /** Catch up from the parent's log, then report the fold (offset + reduced state). */
  snapshot(): Promise<ProcessorSnapshot<unknown>> {
    return this.#p().snapshot();
  }

  /** The live-state seed door ({rev, state: projection}), forwarded. */
  liveSnapshot(): Promise<{ rev: number; state: unknown }> {
    return this.#p().liveSnapshot();
  }

  /** The barrier verb, forwarded (read-your-writes for whatever builds on this fold). */
  waitUntilProcessed(input: { offset: number; timeoutMs?: number }): Promise<void> {
    return this.#p().waitUntilProcessed(input);
  }

  /** Rehydrate from the durable identity (every incarnation — facets restart independently,
   *  and the parent's quiesce alarm aborts idle facets on purpose). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #p(): StreamProcessor<any> {
    if (this.#processor) return this.#processor;
    const identity = this.ctx.storage.kv.get("identity") as FacetIdentity | undefined;
    if (!identity) throw new Error("ProcessorFacet: not configured (call configure() first)");
    const make = FACET_PROCESSORS[identity.slug];
    if (!make) throw new Error(`ProcessorFacet: no built-in processor "${identity.slug}"`);
    // The back-channel: the parent BY NAME, re-resolved per call — never a retained stub.
    const parent = () => this.env.CONTEXT.getByName(identity.parentName);
    const stream: ProcessorStream = {
      append: (...events) => parent().append(...events),
      read: (after, limit) => parent().read(after, limit),
    };
    const storage: ProcessorStorage = {
      get: <T>(k: string) => this.ctx.storage.kv.get(k) as T | undefined,
      put: (k: string, v: unknown) => this.ctx.storage.kv.put(k, v),
    };
    this.#processor = make({
      stream,
      storage,
      path: identity.path,
      projectId: identity.projectId,
      identity,
    });
    return this.#processor;
  }
}
