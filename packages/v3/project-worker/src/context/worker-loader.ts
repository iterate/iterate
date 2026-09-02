// worker-loader.ts — THE loader: `loadConfinedWorker` turns a SOURCE into a loaded worker through
// Cloudflare's `env.LOADER` (a `WorkerLoader`) — resolve the source to modules, hash them, mint the
// confined isolate under the billed cacheKey — and stops at the `WorkerStub`. The CALLER then chooses
// the host, exactly like Cloudflare's own two-step: `worker.getEntrypoint(name?)` for a stateless
// `WorkerEntrypoint` (built-ins.ts), or `worker.getDurableObjectClass(name)` hosted as a durable
// facet of the context (iterate-context-durable-object.ts).
//
// A loaded worker's `env.ITX` is a Workers-RPC service binding to the `ItxEntrypoint`. It reaches
// the genuine itx scope with `env.ITX.get()` — a real `IterateContext` RpcTarget — and then writes plain
// dotted access (`itx.demo.timer.callLater(cb)`), identical to what a capnweb client writes after
// `projects.get(id)`. There is no client-side wrapper: the scope IS a real RpcTarget, so mid-chain
// handles and callbacks pipeline natively over both lanes (no accumulating Proxy, no reduce shim).
//
// A loaded SOURCE EXPORTS its own host object — a `WorkerEntrypoint` (reached with
// `itx.load(src).getEntrypoint(name?)`) or a `DurableObject` class (`…getDurableObjectClass(name)`),
// mirroring Cloudflare's own `worker.getEntrypoint()` / `worker.getDurableObjectClass()`. There is
// NO host-injected wrapper: the code the author wrote IS what runs. The one bare-lambda ergonomic —
// `itx.runScript("async (itx, x) => …")` — wraps its string into a WorkerEntrypoint at the call
// site (built-ins.ts `RUN_SCRIPT_ENTRYPOINT`), so even that bottoms out at an EXPORTED entrypoint.

import { PROCESSOR_SDK_MODULE } from "../generated/processor-sdk.ts";
import { toExpression, type Expression } from "./expression.ts";

/** Compose the loader cacheKey `owner` (context + a discriminator: a processor slug or a stateful
 *  className) COLLISION-FREE. The naive `${context}:${discriminator}` aliased across a different
 *  split — context "/x:y"+class "Door" and context "/x"+class "y:Door" both became
 *  "…/x:y:Door", a SHARED loader cacheKey = silent cross-context authority transfer (the isolate's
 *  whole world is the host stub baked in at first materialization). Length-prefixing the context
 *  makes the split unambiguous regardless of `:` in either half. (worker-loader.test.ts) */
export function facetLoaderOwner(contextName: string, discriminator: string): string {
  return `${contextName.length}#${contextName}#${discriminator}`;
}

/** A worker/facet SOURCE is a PRODUCER of module code, resolved the SAME way at every load site
 *  (stateless workers, stateful facets, processor facets). Two shapes, both bottoming out here:
 *   • an itx-Expression producer — the norm. `itx.kv.get('src/x.js')` IS a callback that fetches
 *     the code; a repo fetch is just `itx.repo.get(...)`; a provided capnweb/Workers-RPC callback
 *     is any expression that invokes it. Re-derivable across incarnations — the durable form,
 *     mirroring apps/os `env.LOADER.get(cacheKey, () => code)` with the producer on the wire.
 *   • `{ type: "inline", files }` — the code handed over literally (apps/os `WorkerFileSource`
 *     inline), the one shape with no producer to invoke.
 *  `type:"repo"` is deliberately NOT a third branch here — it is surface sugar that compiles to a
 *  producer expression, so there is ONE resolve path, not a per-variant fan-out. */
export type WorkerSource = string | Expression | { type: "inline"; files: Record<string, string> };

/** What `loadConfinedWorker` needs. */
type LoadConfinedWorkerOptions = {
  env: { LOADER: WorkerLoader; CF_VERSION_METADATA?: { id: string } };
  /** Resolve one call through the owning context's dispatch — how a producer expression is run. */
  invoke: (call: Expression) => Promise<unknown>;
  /** The loaded isolate's whole world: its `env.ITX` and its `globalOutbound` (the ItxEntrypoint
   *  loopback minted for the owning context — itx-entrypoint.ts). */
  host: Fetcher;
  /** `code` = a stateless isolate; `facet` = a durable class hosted as a facet. A CLOSED union so a
   *  new cacheKey family is a deliberate type change. */
  kind: "code" | "facet";
  /** The owning context (a facet's owner is composed collision-free by `facetLoaderOwner`). */
  owner: string;
  source: WorkerSource;
  /** Names the load site in errors (`facet "tally"`, `load.getEntrypoint`). */
  where: string;
  /** PRE-RESOLVED `{ modules, contentHash }` from a caller-owned memo — skips the source fetch + hash.
   *  The commit pump loads the SAME facet on EVERY commit; a per-facet memo (keyed by the printed
   *  source expression, invalidated at disable/quiesce) turns that into one fetch+hash per
   *  materialization instead of one per commit. The loader `cacheKey` is unchanged either way (a warm
   *  isolate returns cheaply), so this is pure work avoided, not a cardinality change. */
  resolved?: { contentHash: string; modules: Record<string, string> };
};

/**
 * THE one loading step: source → modules → contentHash → the confined worker (SDK injected). It
 * stops at the loaded `worker` handle — "load the code" and "choose the host" are visibly separate.
 * The `contentHash` rides back for the facet's source-change marker.
 *
 * ⚠️  THE cacheKey IS A DOLLAR AMOUNT. Cloudflare bills EVERY DISTINCT value ever passed to
 * `LOADER.get` as a Dynamic Worker at $0.002/worker/day. apps/os PR #2504: a per-request random
 * nonce in the key produced ~3.9M identities ≈ $7.8k in ~3 weeks, plus a cold isolate build on
 * every dispatch (~5MB, 1-2s). Key components must be LOW-CARDINALITY: deploy version × owning
 * context × content hash — NEVER a nonce, timestamp, request id, or offset. (The tension the nonce
 * papered over is real — a loaded isolate captures the minting host's `env.ITX`/`globalOutbound`,
 * which can die with the host's incarnation; we accept the rare re-dial failure and re-key on
 * DEPLOY, not per use.) The confinement contract, stated once: a loaded worker's WHOLE world —
 * `env.ITX` (a service binding to the ItxEntrypoint; `.get()` yields the real itx scope) and every
 * global fetch — is its owning context, so sibling calls and egress route through the host's
 * dispatch with no second path.
 */
export async function loadConfinedWorker(
  opts: LoadConfinedWorkerOptions,
): Promise<{ worker: WorkerStub; contentHash: string; modules: Record<string, string> }> {
  const { where, resolved } = opts;
  let modules: Record<string, string>;
  let contentHash: string;
  if (resolved) ({ modules, contentHash } = resolved);
  else {
    // 1. the source → modules: inline files are the modules; a producer expression is invoked and
    //    may yield a modules record ({ name: code }) or ONE module string (plain kv). Anything else is
    //    a loud error, not an empty worker.
    const { source } = opts;
    const produced =
      typeof source === "string" || Array.isArray(source)
        ? await opts.invoke(toExpression(source))
        : source.files;
    if (typeof produced === "string") modules = { "cap.js": produced };
    else if (produced && typeof produced === "object" && !Array.isArray(produced))
      modules = produced as Record<string, string>;
    else throw new Error(`${where}: source expression produced no module code`);
    // 2. the content hash — djb2 over the modules' JSON: stable, so the cacheKey and the facet's
    //    version marker change exactly when the source does.
    const serialized = JSON.stringify(modules);
    let h = 5381;
    for (let i = 0; i < serialized.length; i++) h = ((h << 5) + h + serialized.charCodeAt(i)) | 0;
    contentHash = (h >>> 0).toString(36);
  }
  // 3. the confined worker under the billed cacheKey (see the header).
  const deploy = opts.env.CF_VERSION_METADATA?.id ?? "unversioned";
  const worker = opts.env.LOADER.get(`${opts.kind}:${deploy}:${opts.owner}:${contentHash}`, () => ({
    // What every loaded isolate runs under. PURE-PLAY: no node:* — userspace code stays portable
    // across workerd builds (nodejs_compat is on by default at this date for the platform worker
    // itself; the loaded half opts out). `allow_irrevocable_stub_storage` (experimental) lets
    // loaded code store its `env.ITX` stub and replay it (load-persistent-stub.e2e pins it) —
    // every worker in the chain needs it, so the parent config carries it too. No `limits`
    // (cpuMs / subRequests): trusted clients. Note the platform bound of 10 distinct dynamic
    // workers with in-flight requests per DO — the idle quiesce is what keeps a context's facet
    // isolates under it.
    compatibilityDate: "2026-09-01",
    compatibilityFlags: [
      "no_nodejs_compat",
      "no_nodejs_compat_v2",
      "allow_irrevocable_stub_storage",
    ],
    mainModule: "cap.js",
    // The processor SDK ("processor.js", ~330KB) rides EVERY load, so any user code may
    // `import "./processor.js"` uniformly. The itx scope is reached via `env.ITX.get()`, not an
    // injected module.
    modules: { ...modules, "processor.js": PROCESSOR_SDK_MODULE },
    env: { ITX: opts.host },
    globalOutbound: opts.host,
  }));
  return { worker, contentHash, modules };
}
