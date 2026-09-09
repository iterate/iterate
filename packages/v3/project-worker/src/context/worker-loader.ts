// worker-loader.ts — THE loader: `loadConfinedWorker` turns a SOURCE into a loaded worker through
// Cloudflare's `env.LOADER` — pick the cache key, mint the confined isolate under it — and stops at
// the `WorkerStub`. The CALLER then chooses the host: `worker.getEntrypoint(name?)` for a stateless
// `WorkerEntrypoint` (`itx.workers.get`), or `worker.getDurableObjectClass(name)` hosted as a durable
// facet of the context (`itx.facets.get(name, spec)`).
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
// A loaded worker's `env.ITX` is a Workers-RPC service binding to the `ItxEntrypoint`; `env.ITX.get()`
// is the genuine itx scope, a real RpcTarget, so mid-chain handles and callbacks pipeline natively —
// no client-side wrapper. A loaded SOURCE EXPORTS its own host object (a `WorkerEntrypoint` or a
// `DurableObject` class): there is NO host-injected wrapper and no bare-lambda door — the code the
// author wrote IS what runs, and it always enters through an EXPORTED entrypoint.

import { PROCESSOR_SDK_MODULE } from "../generated/processor-sdk.ts";
import { codedError } from "../lib/errors.ts";
import {
  normalizedItxExpression,
  type ItxExpression,
  type ItxExpressionInput,
} from "./expression.ts";

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
/** The most a facet's LITERAL source may be, serialized — the startup memo is one kv cell in the DO
 *  (re-read on every post-eviction wake) and the hosting event one log row under the 8 MiB event
 *  ceiling; an oversize source must fail at the door, coded, not late at materialization (the 2026-09-07
 *  wave-0 plan, issue 2). A producer EXPRESSION is small by nature and is not measured. */
export const FACET_SOURCE_MAX_CHARS = 1 << 20;
/** Refuse a spec whose literal source is over the ceiling — the one check both doors (the edge's
 *  `enableProcessor`, the DO's facet door) make, so the refusal is atomic: nothing appended, no memo. */
export function assertFacetSourceWithinCeiling(spec: FacetSpec, where: string): void {
  if (typeof spec.source === "string" || Array.isArray(spec.source)) return; // a producer expression
  const chars = JSON.stringify(spec.source).length;
  if (chars > FACET_SOURCE_MAX_CHARS)
    throw codedError(
      "FACET_SOURCE_TOO_LARGE",
      `${where}: the facet's source is ${chars} chars, over the ${FACET_SOURCE_MAX_CHARS}-char ceiling — build it smaller, or load it from a producer expression with a cacheKey`,
    );
}

/** The same spec with an absent `cacheKey` left OUT (never `cacheKey: undefined`) — the one shape a
 *  memo, an event or a compare sees. */
export const facetSpecOf = ({ source, cacheKey, className }: FacetSpec): FacetSpec => ({
  source,
  ...(cacheKey !== undefined && { cacheKey }),
  className,
});

const isWorkerModules = (source: unknown): source is WorkerModules =>
  typeof source === "object" && source !== null && !Array.isArray(source);

/** WORKAROUND — workerd keeps a named isolate whose startup FAILED (a `getCode` that threw) in its
 *  isolate map for the process's life, so every later `LOADER.get(id)` replays the failure: server.c++
 *  `WorkerStubImpl` never gets a `service`, and only an abort removes the map entry (still so on
 *  upstream main, 2026-09-03; the fix belongs there). Until a workerd release carries it: a producer
 *  that threw marks its loader id DEAD; the next attempt runs the producer OUTSIDE the loader (a
 *  failure there mints nothing) and loads the modules LITERALLY under the next GENERATION of the id
 *  (`<id>#<n>`). One extra identity per dead→recovered transition, never per attempt. Memory-only: a
 *  platform-isolate reset costs one replayed failure. Code that fails to START is outside this (same
 *  key ⇒ same code — the author's bug) and is replayed until upstream lands. */
const loaderIdGenerations = new Map<string, { generation: number; dead: boolean }>();

/** The content hash of a literal module map, memoized by the map's IDENTITY: the DO hands the SAME
 *  startup-memo object per facet per incarnation, so the per-character hash runs ONCE per source per
 *  incarnation instead of once per push. SYNCHRONOUS on purpose (the commit path, where
 *  `crypto.subtle` cannot run), so it is two independent 32-bit hashes (djb2 and FNV-1a) plus the
 *  length: djb2 alone collides on two-character differences (`"Aa"` and `"B@"`), and one shared hash
 *  is one shared isolate. A guard against an accidental collision, not a crafted one (trusted clients). */
const contentHashByWorkerModules = new WeakMap<WorkerModules, string>();
function contentHashOfWorkerModules(modules: WorkerModules): string {
  let hash = contentHashByWorkerModules.get(modules);
  if (hash === undefined) {
    const serialized = JSON.stringify(modules);
    let djb2 = 5381;
    let fnv1a = 0x811c9dc5;
    for (let i = 0; i < serialized.length; i++) {
      const code = serialized.charCodeAt(i);
      djb2 = ((djb2 << 5) + djb2 + code) | 0;
      fnv1a = Math.imul(fnv1a ^ code, 0x01000193);
    }
    hash = `${(djb2 >>> 0).toString(36)}-${(fnv1a >>> 0).toString(36)}-${serialized.length.toString(36)}`;
    contentHashByWorkerModules.set(modules, hash);
  }
  return hash;
}

/** What `loadConfinedWorker` needs. */
type LoadConfinedWorkerOptions = {
  env: { LOADER: WorkerLoader };
  /** The deploy identity every loader id folds in (app-config.ts `deployId`: CF_VERSION_METADATA.id,
   *  "unversioned" locally) — a facet built from an isolate a PRIOR deployment minted cannot be called
   *  by the new parent, so a redeploy must mint fresh isolates. */
  deployId: string;
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
 * THE one loading step: source → the cache key → the confined worker. It stops at the loaded
 * `worker` handle — "load the code" and "choose the host" are visibly separate. `loaderId` is the
 * LOADED IDENTITY the facet door stores as its restart marker.
 *
 * ⚠️  THE cacheKey IS A DOLLAR AMOUNT. Cloudflare bills EVERY DISTINCT value ever passed to
 * `LOADER.get` as a Dynamic Worker at $0.002/worker/day. apps/os PR #2504: a per-request random
 * nonce in the key produced ~3.9M identities ≈ $7.8k in ~3 weeks, plus a cold isolate build on
 * every dispatch (~5MB, 1-2s). Key components must be LOW-CARDINALITY: deploy version × owning
 * context × (content hash | the caller's build/commit id) — NEVER a nonce, timestamp, request id, or
 * offset. (The tension the nonce papered over is real — a loaded isolate captures the minting host's
 * `env.ITX`/`globalOutbound`, which can die with the host's incarnation; we accept the rare re-dial
 * failure and re-key on DEPLOY, not per use.) The confinement contract, stated once: a loaded
 * worker's WHOLE world — `env.ITX` and every global fetch — is its owning context, so sibling calls
 * and egress route through the host's dispatch with no second path.
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
    sourceVersion = cacheKey ?? contentHashOfWorkerModules(modules);
    getModules = () => modules;
  } else {
    if (cacheKey === undefined)
      throw new Error(
        `${where}: a source EXPRESSION needs a cacheKey (a build id, a commit) — the producer runs only when no isolate is warm under it, so the key must change whenever the code does`,
      );
    sourceVersion = cacheKey;
    getModules = async () => {
      const produced = await opts.invoke(normalizedItxExpression(source));
      return requireMainModule(typeof produced === "string" ? { "cap.js": produced } : produced);
    };
  }
  // 2. the confined worker under the billed cacheKey. A JSON array, never `a:b:c`: an owner or a
  //    caller's cacheKey may itself contain ":", and a joined string would let two different
  //    (owner, key) pairs name ONE isolate — the cross-context authority transfer `facetLoaderOwner`
  //    exists to prevent, reopened one field over. Changing the spelling restarts every facet once
  //    on its next wake (a new restart marker), storage surviving — the same as a deploy does.
  const loaderIdBase = JSON.stringify([opts.kind, opts.deployId, opts.owner, sourceVersion]);
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
    // The processor SDK ("processor.js", ~370 KB — ~40× a typical fixture) is injected only when a
    // module IMPORTS it. The failure mode is loud: a forgotten import fails at module link, by name.
    const importsProcessorSdk = Object.values(modules).some((code) =>
      /["']\.\/processor\.js["']/.test(code),
    );
    return {
      // PURE-PLAY: no node:*, so userspace code stays portable across workerd builds.
      // `allow_irrevocable_stub_storage` (experimental) lets loaded code store its `env.ITX` stub
      // and replay it (workers-and-facets.e2e pins it) — every worker in the chain needs it, so
      // the parent config carries it too. No `limits`: trusted clients. The platform bounds a DO to
      // 10 distinct dynamic workers with in-flight requests — the idle quiesce keeps a context under it.
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
