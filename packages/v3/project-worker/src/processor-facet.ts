// processor-facet.ts — THE FACET SPINE: stream processors hosted in a real workerd facet
// (`ctx.facets.get`) on the Stream DO, each with its OWN isolated SQLite-backed storage and
// independent abort/restart — the resolved architecture's "many processors as facets per stream".
// Since increment 28 the ITERATE CONTEXT ITSELF is one of these: the parent DO is log + sockets
// + doors only, and the routing table lives here (FACET_PROCESSORS["iterate-context"]).
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
// parent owns all transport; workerd#6702 — which is exactly why the iterate-context facet's
// clients view is thin RPC wrappers over the parent's stub facade). A facet also must never
// enumerate the parent's `getWebSockets` (the #6702 prod leak).

import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { parseAppConfig } from "./core/config.ts";
import type { StreamEvent } from "./core/events.ts";
import { parse, toExpression, type Expression } from "./core/expression.ts";
import { stringifyName } from "./core/names.ts";
import {
  createStreamProcessorRegistry,
  defineProcessorContract,
  StreamProcessor,
  type ProcessorSnapshot,
  type ProcessorStream,
  type ReduceArgs,
} from "./core/processor.ts";
import { IterateContextStreamProcessor } from "./iterate-context-stream-processor.ts";
import { buildRoots, facetClientsView, type RootsEnv } from "./roots-builder.ts";
import type { StreamDurableObject } from "./stream-durable-object.ts";

interface Env extends RootsEnv {
  APP_CONFIG?: string;
}

/** The identity a facet is configured with — plain data, durable in the facet's own kv. */
export type FacetIdentity = { parentName: string; projectId: string; path: string; slug: string };

// ── the demo built-in facet processor: tally events by type ──
// Proves the whole spine (configure → deliver → fold → snapshot-through-parent) with the
// smallest possible processor.
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

/** What a built-in facet-processor factory receives: the stream + identity, the worker env, and
 *  a late-bound `invoke` back into THIS facet's own dispatch (usable only after boot — it is
 *  only ever CALLED lazily, from inside resolved targets). */
type FacetProcessorArgs = {
  stream: ProcessorStream;
  path: string;
  projectId: string;
  identity: FacetIdentity;
  env: Env;
  invoke: (call: Expression, depth?: number) => Promise<unknown>;
};

/** Built-in facet-hosted processors by slug. (Loader-loaded userspace classes ride the same
 *  spine — the class arrives via the Worker Loader instead of this map.) */
const FACET_PROCESSORS: Record<
  string,
  // `any` for the same reason as registry.register: StreamProcessor is invariant in State.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (args: FacetProcessorArgs) => StreamProcessor<any>
> = {
  tally: (args) => new TallyProcessor(args),
  // THE capability host: reduced state IS the routing table. Roots are FACET-BUILT: kv/secrets/
  // loader/fallback from the inherited worker env; the own stream + sibling contexts BY NAME
  // through the parent namespace; the clients view = thin RPC wrappers over the parent's stub
  // facade (sockets live on the parent, always).
  "iterate-context": ({ stream, path, projectId, identity, env, invoke }) => {
    const parent = () => env.CONTEXT.getByName(identity.parentName);
    const roots = buildRoots({
      projectId,
      path,
      contextName: identity.parentName,
      env,
      invoke: (call) => invoke(call),
      context: (p) => env.CONTEXT.getByName(stringifyName({ projectId, path: p })),
      clients: facetClientsView(parent),
    });
    return new IterateContextStreamProcessor({
      stream,
      path,
      projectId,
      seeds: parseAppConfig(env.APP_CONFIG).seeds,
      roots,
    });
  },
};

export class ProcessorFacet extends DurableObject<Env> {
  #booted?: {
    registry: ReturnType<typeof createStreamProcessorRegistry>;
    slug: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    processor: StreamProcessor<any>;
  };

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

  // ── the iterate-context surface (only valid when this facet hosts that slug) ──

  /** Resolve + run one call against the CURRENT table: catch up own registry → snapshot →
   *  resolve. This is also the facet's `resolveCurrent` — the recursion stays LOCAL. */
  async invoke(call: string | Expression, depth = 0): Promise<unknown> {
    const { processor } = this.#ictx();
    const state = (await this.#tableState()) as Parameters<typeof processor.resolve>[0];
    return processor.resolve(state, toExpression(call), undefined, depth);
  }

  /** Mount a capability (event provenance — `roots` targets are rejected by the processor). */
  provide(input: {
    pattern: string | Expression;
    target: string | Expression;
  }): Promise<{ providedAtOffset: number }> {
    return this.#ictx().processor.provide(input);
  }

  revoke(input: { providedAtOffset: number }): Promise<void> {
    return this.#ictx().processor.revoke(input);
  }

  /** THE FETCH LANE terminal: the parent forwards `x-itx-cap` requests NATIVELY
   *  (`facet.fetch(request)`), so a 101 tunnels straight through. Parse the header exactly as
   *  the parent's door used to, then resolveFetch against the current table. */
  async fetch(request: Request): Promise<Response> {
    const capHeader = request.headers.get("x-itx-cap");
    if (!capHeader) return new Response("processor facet: no x-itx-cap header\n", { status: 400 });
    try {
      const expr = capHeader.trimStart().startsWith("[")
        ? (JSON.parse(capHeader) as Expression)
        : parse(capHeader.startsWith("itx") ? capHeader : `itx.${capHeader}`);
      const { processor } = this.#ictx();
      const state = (await this.#tableState()) as Parameters<typeof processor.resolveFetch>[0];
      const result = await processor.resolveFetch(state, expr, request);
      if (result instanceof Response) return result;
      return new Response(`fetch lane: ${JSON.stringify(result)}\n`);
    } catch (error) {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      const status = /no capability matches/.test(message) ? 404 : 500;
      return new Response(`fetch lane error: ${message}\n`, { status });
    }
  }

  /** The current routing-table state — the registry's snapshot catches up from the log first. */
  async #tableState(): Promise<unknown> {
    const { registry, processor } = this.#boot();
    return (await registry.reads(processor).snapshot()).state;
  }

  #ictx(): { processor: IterateContextStreamProcessor } {
    const { processor, slug } = this.#boot();
    if (!(processor instanceof IterateContextStreamProcessor))
      throw new Error(`facet "${slug}" is not the iterate-context processor`);
    return { processor };
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
    const processor = make({
      stream,
      path: identity.path,
      projectId: identity.projectId,
      identity,
      env: this.env,
      invoke: (call, depth) => this.invoke(call, depth),
    });
    registry.register(processor);
    // Wire the resolver recursion LOCALLY: `itx.…` inside any mount target re-enters THIS
    // facet's dispatch (never a hop back through the parent).
    if (processor instanceof IterateContextStreamProcessor)
      processor.resolveCurrent = (call, depth) => this.invoke(call, depth);
    this.#booted = { registry, slug: identity.slug, processor };
    return this.#booted;
  }
}
