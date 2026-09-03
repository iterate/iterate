// worker-loader.ts — THE loader: `loadConfinedWorker` turns a SOURCE into a loaded worker through
// Cloudflare's `env.LOADER` (a `WorkerLoader`) — pick the cache key, mint the confined isolate under
// it — and stops at the `WorkerStub`. The CALLER then chooses the host: `worker.getEntrypoint(name?)`
// for a stateless `WorkerEntrypoint` (built-ins.ts `workers.get`), or `worker.getDurableObjectClass(
// name)` hosted as a durable facet of the context (iterate-context-durable-object.ts `facets.get(name,
// spec)`).
//
// THE CACHE KEY, Cloudflare's own contract (developers.cloudflare.com/dynamic-workers/api-reference):
// `LOADER.get(id, getCode)` runs `getCode` only when no isolate is warm under `id` — "although it is
// unusual for it to be called more than once", it MAY be — and "if anything about the content
// changes, you must use a new ID". So a source is EITHER its modules, literally (the key is then
// their content hash — the same content can never mean different code), OR an itx EXPRESSION that
// PRODUCES the modules, in which case the caller MUST name the `cacheKey` (a build id, a commit): the
// producer runs inside `getCode`, i.e. only on a cold isolate, and the caller owns "same key ⇒ same
// code". A producer without a key is refused: hashing the expression would be the stale-code trap.
// (apps/os derives its key from a repo's content hash and caches the BUILD artifact in KV under it;
// that tier belongs to a build capability, not here.)
//
// A loaded worker's `env.ITX` is a Workers-RPC service binding to the `ItxEntrypoint`. It reaches
// the genuine itx scope with `env.ITX.get()` — a real `IterateContext` RpcTarget — and then writes plain
// dotted access (`itx.demo.timer.callLater(cb)`), identical to what a capnweb client writes after
// `projects.get(id)`. There is no client-side wrapper: the scope IS a real RpcTarget, so mid-chain
// handles and callbacks pipeline natively over both lanes (no accumulating Proxy, no reduce shim).
//
// A loaded SOURCE EXPORTS its own host object — a `WorkerEntrypoint` (reached with
// `itx.workers.get({ source, className? })`) or a `DurableObject` class (hosted with
// `itx.facets.get(name, { source, className })`) — one door per host kind over Cloudflare's own
// `worker.getEntrypoint()` / `worker.getDurableObjectClass()` + `ctx.facets.get(name, startup)`. There is
// NO host-injected wrapper: the code the author wrote IS what runs. The one bare-lambda ergonomic —
// `itx.runScript("async (itx, x) => …")` — wraps its string into a WorkerEntrypoint at the call
// site (built-ins.ts `RUN_SCRIPT_ENTRYPOINT`), so even that bottoms out at an EXPORTED entrypoint.

import { PROCESSOR_SDK_MODULE } from "../generated/processor-sdk.ts";
import { toItxExpression, type ItxExpression, type ItxExpressionInput } from "./expression.ts";

/** Compose the loader cacheKey `owner` (context + a discriminator: a processor slug or a stateful
 *  className) COLLISION-FREE. The naive `${context}:${discriminator}` aliased across a different
 *  split — context "/x:y"+class "Door" and context "/x"+class "y:Door" both became
 *  "…/x:y:Door", a SHARED loader cacheKey = silent cross-context authority transfer (the isolate's
 *  whole world is the host stub baked in at first materialization). Length-prefixing the context
 *  makes the split unambiguous regardless of `:` in either half. (worker-loader.test.ts) */
export function facetLoaderOwner(iterateContextName: string, discriminator: string): string {
  return `${iterateContextName.length}#${iterateContextName}#${discriminator}`;
}

/** A worker's MODULES, module name → code. `"cap.js"` is the main module. */
export type WorkerModules = Record<string, string>;
/** A worker/facet SOURCE: the modules, literally — or an itx expression that PRODUCES them (a
 *  modules record, or one module string = `cap.js`), evaluated only when no isolate is warm under the
 *  caller's `cacheKey` (header). Stored where it is named: a facet's startup memo, a subscription's
 *  target, a rewrite rule's target. */
export type WorkerSource = WorkerModules | ItxExpressionInput;

/** Cloudflare's loader id for the cache; REQUIRED when `source` is a producer expression (the caller
 *  owns "same key ⇒ same code"), optional beside literal modules (it then replaces the content hash). */
export type WorkerCacheKey = string;

/** What hosts a class as a durable FACET — `itx.facets.get(name, spec)`, `enableProcessor(name, spec)`:
 *  the source (modules, or a producer expression with its `cacheKey`) and the exported class. */
export type FacetSpec = { source: WorkerSource; cacheKey?: WorkerCacheKey; className: string };

const isWorkerModules = (source: unknown): source is WorkerModules =>
  typeof source === "object" && source !== null && !Array.isArray(source);

/** WORKAROUND — workerd keeps a named isolate whose startup FAILED (a `getCode` that threw, code that
 *  failed to start) in its isolate map for the process's life, so every later `LOADER.get(id)` replays
 *  the failure: server.c++ `WorkerStubImpl` never gets a `service`, and only an abort removes the map
 *  entry (still so on upstream main, 2026-09-03; the fix belongs there — drop the entry on startup
 *  failure the way abort does). Until a workerd release carries it: a producer that threw marks its
 *  loader id DEAD; the next attempt runs the producer OUTSIDE the loader (a failure there reaches no
 *  map entry and mints nothing) and, once the modules are in hand, loads them LITERALLY under the next
 *  GENERATION of the id (`<id>#<n>`). One extra identity per dead→recovered transition, never per
 *  attempt; the happy path still produces inside `getCode`, on a cold isolate only. Memory-only: a
 *  platform-isolate reset costs one replayed failure before recovering. Code that fails to START is
 *  outside this (same key ⇒ same code — the author's bug) and is replayed until upstream lands. */
const loaderIdGenerations = new Map<string, { generation: number; dead: boolean }>();

/** What `loadConfinedWorker` needs. */
type LoadConfinedWorkerOptions = {
  env: { LOADER: WorkerLoader; CF_VERSION_METADATA?: { id: string } };
  /** The `ItxEntrypoint` stub a loaded worker gets as `env.ITX` and `globalOutbound` — the loopback
   *  minted for the owning context (itx-entrypoint.ts). */
  itxEntrypoint: Fetcher;
  /** `worker` = a stateless isolate (`itx.workers.get`); `facet` = a durable class hosted as a facet
   *  (`itx.facets.get`). A CLOSED union so a new cacheKey family is a deliberate type change. */
  kind: "worker" | "facet";
  /** The owning context (a facet's owner is composed collision-free by `facetLoaderOwner`). */
  owner: string;
  source: WorkerSource;
  cacheKey?: WorkerCacheKey;
  /** Evaluate a producer expression through the owning context's dispatch — inside `getCode`, so
   *  only on a cold isolate. */
  invoke: (call: ItxExpression) => Promise<unknown>;
  /** Names the load site in errors (`facet "tally"`, `workers.get`). */
  where: string;
};

/**
 * THE one loading step: source → the cache key → the confined worker (SDK injected, the modules
 * produced inside Cloudflare's `getCode` when the source is an expression). It stops at the loaded
 * `worker` handle — "load the code" and "choose the host" are visibly separate. `loaderId` is the
 * id the worker was loaded under — the LOADED IDENTITY the facet door stores as its restart marker
 * (a source change within a deploy, a deploy, or a workaround generation restarts the facet in
 * place, its storage surviving).
 *
 * ⚠️  THE cacheKey IS A DOLLAR AMOUNT. Cloudflare bills EVERY DISTINCT value ever passed to
 * `LOADER.get` as a Dynamic Worker at $0.002/worker/day. apps/os PR #2504: a per-request random
 * nonce in the key produced ~3.9M identities ≈ $7.8k in ~3 weeks, plus a cold isolate build on
 * every dispatch (~5MB, 1-2s). Key components must be LOW-CARDINALITY: deploy version × owning
 * context × (content hash | the caller's build/commit id) — NEVER a nonce, timestamp, request id, or
 * offset. (The tension the nonce papered over is real — a loaded isolate captures the minting host's
 * `env.ITX`/`globalOutbound`, which can die with the host's incarnation; we accept the rare re-dial
 * failure and re-key on DEPLOY, not per use.) The confinement contract, stated once: a loaded
 * worker's WHOLE world — `env.ITX` (a service binding to the ItxEntrypoint; `.get()` yields the real
 * itx scope) and every global fetch — is its owning context, so sibling calls and egress route
 * through the host's dispatch with no second path.
 */
export async function loadConfinedWorker(
  opts: LoadConfinedWorkerOptions,
): Promise<{ worker: WorkerStub; loaderId: string }> {
  const { where, source, cacheKey } = opts;
  const requireMainModule = (modules: unknown): WorkerModules => {
    if (!isWorkerModules(modules) || typeof modules["cap.js"] !== "string")
      throw new Error(`${where}: a source is its modules, and needs a "cap.js" main module`);
    return modules;
  };
  // 1. the key's last component — and how the modules will be obtained.
  let sourceVersion: string;
  let getModules: () => Promise<WorkerModules> | WorkerModules;
  if (isWorkerModules(source)) {
    const modules = requireMainModule(source);
    // The content hash — djb2 over the modules' JSON: stable, so the cacheKey and the facet's
    // version marker change exactly when the source does.
    const serialized = JSON.stringify(modules);
    let h = 5381;
    for (let i = 0; i < serialized.length; i++) h = ((h << 5) + h + serialized.charCodeAt(i)) | 0;
    sourceVersion = cacheKey ?? (h >>> 0).toString(36);
    getModules = () => modules;
  } else {
    if (cacheKey === undefined)
      throw new Error(
        `${where}: a source EXPRESSION needs a cacheKey (a build id, a commit) — the producer runs only when no isolate is warm under it, so the key must change whenever the code does`,
      );
    sourceVersion = cacheKey;
    getModules = async () => {
      const produced = await opts.invoke(toItxExpression(source));
      return requireMainModule(typeof produced === "string" ? { "cap.js": produced } : produced);
    };
  }
  // 2. the confined worker under the billed cacheKey (see the header). `getCode` runs on a cold
  //    isolate only — a producer expression is evaluated exactly there, unless the id is DEAD
  //    (`loaderIdGenerations`): then the modules are produced here, outside the loader, and loaded
  //    literally under the next generation of the id.
  const deploy = opts.env.CF_VERSION_METADATA?.id ?? "unversioned";
  const loaderIdBase = `${opts.kind}:${deploy}:${opts.owner}:${sourceVersion}`;
  let { generation, dead } = loaderIdGenerations.get(loaderIdBase) ?? {
    generation: 0,
    dead: false,
  };
  let modulesForWorkerCode = getModules;
  if (dead) {
    const modules = await getModules(); // outside the loader: a throw here poisons nothing
    generation += 1;
    dead = false;
    loaderIdGenerations.set(loaderIdBase, { generation, dead });
    modulesForWorkerCode = () => modules;
  }
  const loaderId = generation ? `${loaderIdBase}#${generation}` : loaderIdBase;
  const worker = opts.env.LOADER.get(loaderId, async () => {
    let modules: WorkerModules;
    try {
      modules = await modulesForWorkerCode();
    } catch (error) {
      loaderIdGenerations.set(loaderIdBase, { generation, dead: true });
      throw error;
    }
    // The processor SDK ("processor.js", ~370 KB) is injected only when a module IMPORTS it — a
    // stateless worker that never does skips compiling it (the review measured the SDK at ~40× a
    // typical fixture). The failure mode is loud: a forgotten import fails at module link, by
    // name. The itx scope is reached via `env.ITX.get()`, not an injected module.
    const importsProcessorSdk = Object.values(modules).some((code) =>
      /["']\.\/processor\.js["']/.test(code),
    );
    return {
      // What every loaded isolate runs under. PURE-PLAY: no node:* — userspace code stays portable
      // across workerd builds (nodejs_compat is on by default at this date for the platform worker
      // itself; the loaded half opts out). `allow_irrevocable_stub_storage` (experimental) lets
      // loaded code store its `env.ITX` stub and replay it (facets-persistent-stub.e2e pins it) —
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
      modules: importsProcessorSdk ? { ...modules, "processor.js": PROCESSOR_SDK_MODULE } : modules,
      env: { ITX: opts.itxEntrypoint },
      globalOutbound: opts.itxEntrypoint,
    };
  });
  return { worker, loaderId };
}
