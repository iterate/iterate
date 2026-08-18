// processor-facet.ts — THE FACET SPINE: stream processors hosted in a real workerd facet
// (`ctx.facets.get`) on the Stream DO, each with its OWN isolated SQLite-backed storage and
// independent abort/restart — the resolved architecture's "many processors as facets per stream".
//
// The parent↔facet channel is the designed one (apps/os pattern, uniform for built-in AND
// loader-loaded facet classes):
//   • IDENTITY via first-contact `configure({ parentName, projectId, path, slug })` — plain data,
//     stashed DURABLY in the facet's own kv (a facet cannot receive constructor args, and a
//     parent-chosen env is impossible for a built-in class: it inherits the WORKER's env).
//   • BACK-CHANNEL by NAME, never a live stub: the facet re-resolves `env.CONTEXT
//     .getByName(parentName)` per use (stubs must not outlive their RPC turn).
//   • DRIVE via `deliver(events, head)` — the parent calls it after each commit; the registry
//     inside the facet enforces the same concurrency contract as everywhere else (it is
//     host-agnostic on purpose: a processor cannot tell whether it runs in-DO or in a facet).
//
// Platform constraints carried deliberately: facets have NO alarms (workerd#6810 — the parent
// proxies when a processor needs one; none does yet) and hold NO hibernatable sockets (the
// parent owns all transport; workerd#6702). A facet also must never enumerate the parent's
// `getWebSockets` (the #6702 prod leak).

import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import type { StreamEvent } from "./core/events.ts";
import {
  createStreamProcessorRegistry,
  defineProcessorContract,
  StreamProcessor,
  type ProcessorSnapshot,
  type ProcessorStream,
  type ReduceArgs,
} from "./core/processor.ts";
import type { StreamDurableObject } from "./stream-durable-object.ts";

interface Env {
  CONTEXT: DurableObjectNamespace<StreamDurableObject>;
}

/** The identity a facet is configured with — plain data, durable in the facet's own kv. */
export type FacetIdentity = { parentName: string; projectId: string; path: string; slug: string };

// ── the demo built-in facet processor: tally events by type ──
// Proves the whole spine (configure → deliver → fold → snapshot-through-parent) with the
// smallest possible processor. Real processors (the iterate-context table itself, userspace
// loader classes) slot into FACET_PROCESSORS the same way.
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

/** Built-in facet-hosted processors by slug. (Loader-loaded userspace classes come next — same
 *  registry, the class arrives via the Worker Loader instead of this map.) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FACET_PROCESSORS: Record<
  string,
  // `any` for the same reason as registry.register: StreamProcessor is invariant in State.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (args: { stream: ProcessorStream; path: string; projectId: string }) => StreamProcessor<any>
> = {
  tally: (args) => new TallyProcessor(args),
};

export class ProcessorFacet extends DurableObject<Env> {
  #booted?: { registry: ReturnType<typeof createStreamProcessorRegistry>; slug: string };

  /** First contact: the parent hands the facet its identity. Durable — survives facet restarts. */
  configure(identity: FacetIdentity): { ok: true } {
    this.ctx.storage.kv.put("identity", identity);
    return { ok: true };
  }

  /** The parent drives this after each commit (and for catch-up on cold reads). */
  async deliver(events: StreamEvent[], streamMaxOffset: number): Promise<void> {
    await this.#boot().registry.deliver(events, streamMaxOffset);
  }

  /** Catch up from the parent's log, then report the fold (offset + reduced state). */
  async snapshot(): Promise<ProcessorSnapshot<unknown>> {
    const { registry, slug } = this.#boot();
    await registry.catchUp(slug);
    const stored = this.ctx.storage.kv.get(`processor:${slug}:progress`) as
      | { reducedThroughOffset: number; state: unknown }
      | undefined;
    return { offset: stored?.reducedThroughOffset ?? 0, state: stored?.state ?? {} };
  }

  /** Rehydrate from the durable identity (every incarnation — facets restart independently). */
  #boot() {
    if (this.#booted) return this.#booted;
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
    const registry = createStreamProcessorRegistry({
      storage: {
        get: <T>(k: string) => this.ctx.storage.kv.get(k) as T | undefined,
        put: (k: string, v: unknown) => this.ctx.storage.kv.put(k, v),
      },
      stream,
      path: identity.path,
      projectId: identity.projectId,
    });
    registry.register(make({ stream, path: identity.path, projectId: identity.projectId }));
    this.#booted = { registry, slug: identity.slug };
    return this.#booted;
  }
}
