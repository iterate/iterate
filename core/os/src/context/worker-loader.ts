// worker-loader.ts — THE loader: `prepareConfinedWorker` turns a SOURCE into its loaded IDENTITY
// (the cache key) and a `load` thunk that mints the confined isolate under it through
// Cloudflare's `env.LOADER`, stopping at the `WorkerStub`. The CALLER then chooses the host — and
// WHEN to load: `load().getEntrypoint(name?)` at once for a stateless `WorkerEntrypoint`
// (`itx.workers.get`), or `load().getDurableObjectClass(name)` only when a durable facet of the
// context STARTS (`itx.facets.get(name, spec)`).
//
// THE CACHE KEY, Cloudflare's own contract (developers.cloudflare.com/dynamic-workers/api-reference):
// `LOADER.get(id, getCode)` runs `getCode` only when no isolate is warm under `id` — "although it is
// unusual for it to be called more than once", it MAY be — and "if anything about the content
// changes, you must use a new ID". So a source is EITHER its modules, literally (the key is then
// their content hash — the same content can never mean different code, its npm dependencies
// included: each resolves once per version as written, and a pkg.pr.new branch, which would load
// another build under the same key, is refused, module-resolution.ts), OR an itx EXPRESSION that
// PRODUCES the modules, in which case the caller MUST name the `cacheKey` (a build id, a commit): the
// producer runs inside `getCode`, i.e. only on a cold isolate, and the caller owns "same key ⇒ same
// code". A producer without a key is refused: hashing the expression would be the stale-code trap.
// A producer's answer is kept in ITX_KV for a day, so a cold isolate does not wake what produces it.
//
// A loaded worker's `env.ITX` is a Workers-RPC service binding to the `ItxEntrypoint`; `env.ITX.get()`
// is the genuine itx scope, a real RpcTarget, so mid-chain handles and callbacks pipeline natively —
// no client-side wrapper. Loaded code reaches it with `using itx = this.getItx()`, which releases
// the scope and every call made through it (lint: iterate/no-raw-itx-get). A loaded SOURCE EXPORTS its own host object (a `WorkerEntrypoint` or a
// `DurableObject` class), and no bare-lambda entry point: the code the author wrote IS what runs, and
// it always enters through an EXPORTED entrypoint. The one module the platform adds is evaluated
// first (module-resolution.ts `enteredThroughPlatform`): it carries the cause on `fetch` and gives
// every `WorkerEntrypoint` `callWithCause` and `getItx` (iterate src/sdk/loaded-worker.ts).

import { codedError, errorCode } from "iterate/lib";
import { normalizedItxExpression, type ItxExpression } from "iterate/expression";
import type { FacetSpec, WorkerSource } from "iterate/api";
import { COMPATIBILITY_DATE } from "iterate/compatibility-date";
import { failureKind, ONCE_NOW, retryPlatformFailures } from "iterate/platform-retry";
import { z } from "zod";
import PLATFORM_MODULES from "../generated/platform-modules.js";
import { sha256Hex } from "../caller.ts";
import { WorkerManifest } from "./worker-manifest.ts";
import { SOURCE_MAX_CHARS } from "./itx-expression-rewriting.ts";
import {
  enteredThroughPlatform,
  readPackage,
  resolveModules,
  type ResolveOptions,
} from "./module-resolution.ts";

/** A worker's FILES as authored, path → code (module-resolution.ts `readPackage` finds the entry and
 *  resolves the rest into what the loader takes). */
export type WorkerModules = Record<string, string>;
/** How long a producer's modules stay in `ITX_KV`. Their key names the producer's whole input, so
 *  what goes stale is only a caller's key that does not keep "same key ⇒ same code"; the expiry
 *  bounds that, and lets a deleted project's entries go. */
const PRODUCED_MODULES_TTL_SECONDS = 24 * 60 * 60;
/** The most one KV value may be (Cloudflare's limit). A repo's whole tree can pass it while the
 *  modules the entry reaches do not, so an answer over it is simply not kept. */
const KV_VALUE_MAX_BYTES = 25 * 1024 * 1024;
/** Refuse a spec whose LITERAL source is over the ceiling (itx-expression-rewriting.ts
 *  `SOURCE_MAX_CHARS`) — the startup memo is one kv cell in the DO (re-read on every post-eviction
 *  wake) and the hosting event one log row under the 8 MiB event ceiling, so an oversize source
 *  fails where it is handed in, coded, not late at materialization; a producer EXPRESSION is small by
 *  nature and is not measured. The one check both entry points (`itx.processors.enable`, the DO's
 *  `itx.facets.get`) make, so the refusal is atomic: nothing appended, no memo. */
export function assertFacetSourceWithinCeiling(spec: FacetSpec, where: string): void {
  if (typeof spec.source === "string" || Array.isArray(spec.source)) return; // a producer expression
  const chars = JSON.stringify(spec.source).length;
  if (chars > SOURCE_MAX_CHARS)
    throw codedError(
      "FACET_SOURCE_TOO_LARGE",
      `${where}: the facet's source is ${chars} chars, over the ${SOURCE_MAX_CHARS}-char ceiling — build it smaller, or load it from a producer expression with a cacheKey`,
    );
}

export const isWorkerModules = (source: unknown): source is WorkerModules =>
  // oxlint-disable-next-line iterate/simple-truthiness-check -- `source` is untrusted `unknown`; the null check is the standard non-null-object runtime guard and keeps this a boolean type predicate
  typeof source === "object" && source !== null && !Array.isArray(source);

/** A `workers.get` spec as a rule names a worker, with its manifest when the platform published it
 *  (worker-manifest.ts): anyone may write such a rule, so its shape is checked where a name is read. */
const NamedWorkerSpec = z.object({
  // the loader checks the files, or the expression, as it loads them
  source: z.custom<WorkerSource>(
    (value) => isWorkerModules(value) || typeof value === "string" || Array.isArray(value),
    "a worker's source is its files or an itx expression that produces them",
  ),
  cacheKey: z.string().optional(),
  // read only from a rule the platform wrote (`vouched`)
  manifest: z.unknown().optional(),
});

/** A worker's NAME resolved (the resolver's `namedWorker`): the `workers.get` spec of the rule it
 *  names, whether the platform wrote that rule (`vouched`), and the dispatch its producer runs
 *  through — with the authority of the context whose rule it is. */
export type NamedWorker = {
  spec: unknown;
  vouched: boolean;
  invoke: (call: ItxExpression) => Promise<unknown>;
};

/** WHAT A WORKER'S NAME LOADS for its entry `mainModule` — a source expression with no cacheKey
 *  (iterate/api `FacetSpec`, `workers.get`), resolved to the spec of the rule it names (the
 *  resolver's `namedWorker`): that spec's source under its cacheKey, and — only when the platform
 *  wrote the rule (`vouched`: its publication) — under `mainModule`'s identity in its manifest, with
 *  the manifest's generation. A publication may have dropped the module, or the Durable Object class
 *  a facet names (`className`): refused, naming it. A manifest anyone else wrote is ignored: its
 *  worker loads under its own cacheKey or content, as any source does. */
export function namedWorkerLoad(
  named: { spec: unknown; vouched: boolean },
  mainModule: string | undefined,
  where: string,
  className?: string,
): { source: WorkerSource; cacheKey?: string; moduleIdentity?: string; generation?: number } {
  const { source, cacheKey, manifest: given } = NamedWorkerSpec.parse(named.spec);
  const manifest = named.vouched && given !== undefined ? WorkerManifest.parse(given) : undefined;
  if (!manifest || !mainModule) return { source, cacheKey, generation: manifest?.generation };
  const published = manifest.modules[mainModule];
  if (!published)
    throw new Error(
      `${where}: the worker its source names publishes no module ${JSON.stringify(mainModule)}`,
    );
  if (className && !published.classes.includes(className))
    throw new Error(
      `${where}: the worker its source names publishes no Durable Object class ${JSON.stringify(className)} in ${JSON.stringify(mainModule)}`,
    );
  return { source, cacheKey, moduleIdentity: published.identity, generation: manifest.generation };
}

/** WORKAROUND — workerd keeps a named isolate whose startup FAILED (a `getCode` that threw) in its
 *  isolate map for the process's life, so every later `LOADER.get(id)` replays the failure: server.c++
 *  `WorkerStubImpl` never gets a `service`, and only an abort removes the map entry (still so on
 *  upstream main, 2026-09-03; the fix belongs there). Until a workerd release carries it: a producer
 *  that threw marks its loader id DEAD; the next attempt runs the producer OUTSIDE the loader (a
 *  failure there mints nothing) and loads the modules LITERALLY under the next GENERATION of the id
 *  (`generationId`). One extra identity per dead→recovered transition, never per attempt.
 *  Memory-only: a platform-isolate reset costs one replayed failure. Code that fails to START is outside this (same
 *  key ⇒ same code — the author's bug) and is replayed until upstream lands.
 *
 *  ONE RECOVERY AT A TIME: every caller that finds the id dead while a recovery runs waits on that
 *  one (`recovery`), as the loader has every caller of a cold id wait on one `getCode`, so a burst of
 *  callers runs one producer against the repo facet, not one each. The recovery is kept beside the `itxEntrypoint` stub it was started for, which a context mints once
 *  per incarnation: a new incarnation never waits on a promise its dead predecessor left behind. */
/** A source resolved into what the loader takes (module-resolution.ts). */
type ResolvedWorker = Awaited<ReturnType<typeof resolveModules>>;
const loaderIdGenerations = new Map<
  string,
  {
    generation: number;
    dead: boolean;
    recovery?: { itxEntrypoint: Fetcher; modules: Promise<ResolvedWorker> };
  }
>();

/** This isolate's salt on a generation past 0 (`generationId`), minted on first use: a Worker may
 *  not make random values in global scope. */
let retiredGenerationSalt: string | undefined;
/** THE LOADER ID OF `base`'s `generation`, as this isolate spells it. Generation 0 is `base`, which
 *  every isolate shares, so a warm entry serves them all. A later one replaces an entry that failed,
 *  and the Worker Loader shares an entry by id across the isolates of a machine (workerd#7485):
 *  so a generation past 0 carries this isolate's salt, and a replay loads fresh code, not a
 *  sibling's failing entry. The one nonce a loader id may carry: it grows identities with failures,
 *  one per failure per isolate, never with requests. */
function generationId(base: string, generation: number): string {
  if (!generation) return base;
  retiredGenerationSalt ||= crypto.randomUUID().slice(0, 8);
  return `${base}#${generation}.${retiredGenerationSalt}`;
}

/** The content hash of a literal module map, memoized by the map's IDENTITY: the DO hands the SAME
 *  startup-memo object per facet per incarnation, so the per-character hash runs ONCE per source per
 *  incarnation instead of once per push. SYNCHRONOUS on purpose (the commit path, where
 *  `crypto.subtle` cannot run), so it is two independent 32-bit hashes (djb2 and FNV-1a) plus the
 *  length: djb2 alone collides on two-character differences (`"Aa"` and `"B@"`), and one shared hash
 *  is one shared isolate. A guard against an accidental collision, not a crafted one (trusted clients). */
const contentHashByWorkerModules = new WeakMap<WorkerModules, string>();
export function contentHashOfWorkerModules(modules: WorkerModules): string {
  let hash = contentHashByWorkerModules.get(modules);
  if (!hash) {
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

/** What `prepareConfinedWorker` needs. */
type PrepareConfinedWorkerOptions = {
  env: { LOADER: WorkerLoader; ITX_KV: KVNamespace };
  /** The deploy identity every loader id folds in (worker.ts `AppConfig.deployId`: CF_VERSION_METADATA.id,
   *  "unversioned" locally) — a facet built from an isolate a PRIOR deployment minted cannot be called
   *  by the new parent, so a redeploy must mint fresh isolates. */
  deployId: string;
  /** The platform origin the `itxEntrypoint` stub was minted with (null until a self-host's first
   *  stamped caller) — FOLDED INTO THE LOADER ID: a warm isolate keeps the `env.ITX` it captured, so
   *  one minted before the origin was known must not be reused once it is (the next `LOADER.get`
   *  under the new id mints a fresh isolate; the stale one idles out). One extra identity per
   *  context at most, once. */
  platformOrigin: string | null;
  /** The `ItxEntrypoint` stub a loaded worker gets as `env.ITX` and `globalOutbound` — the loopback
   *  minted for the owning context (iterate-context.ts `ItxEntrypoint`). */
  itxEntrypoint: Fetcher;
  /** `worker` = a stateless isolate (`itx.workers.get`); `facet` = a durable class hosted as a facet
   *  (`itx.facets.get`). A CLOSED union so a new cacheKey family is a deliberate type change. */
  kind: "worker" | "facet";
  /** The owning context's name — for a facet, the pair (context name, className). Either way it is
   *  ONE element of the JSON-array loader id, so a ":" in either half cannot alias another owner:
   *  context "/x:y" + class "Tally" and context "/x" + class "y:Tally" stay two identities
   *  (worker-loader.test.ts). */
  owner: string | readonly [iterateContextName: string, className: string];
  source: WorkerSource;
  cacheKey?: string;
  /** The module of `source` loaded as the entry (`resolveModules`'s `mainModule`), package.json's
   *  `main` when absent. One more element of the loader id when given: two entries of one source
   *  are two workers. */
  mainModule?: string;
  /** What names the code in the loader id in place of `cacheKey` or the content hash: the entry's
   *  own identity (`moduleIdentityOf`), from the manifest of the worker a facet is named by
   *  (FacetHost). A producer then runs under it: every source that answers one identity loads the
   *  same code for that entry. */
  moduleIdentity?: string;
  /** Evaluate a producer expression through the owning context's dispatch — inside `getCode`, so
   *  only on a cold isolate. */
  invoke: (call: ItxExpression) => Promise<unknown>;
  /** Names the load site in errors (`facet "tally"`, `workers.get`). */
  where: string;
};

/**
 * THE one loading step, in two halves. RESOLVE, now: source → the cache key → `loaderId`, the
 * LOADED IDENTITY `FacetHost#materialize` stores as the facet's restart marker
 * (the one await is a dead id's recovery, which produces the modules OUTSIDE the loader so a
 * failure poisons nothing). LOAD, when the caller says: `load()` mints or reuses the confined
 * isolate under that identity and stops at the `worker` handle. "Name the code", "load the code"
 * and "choose the host" are visibly separate: `itx.workers.get` calls `load()` at once (a stateless
 * entrypoint per call; the loader caches by key); `FacetHost#materialize` calls
 * it only for a facet that STARTS — a call to a RUNNING facet never touches the loader
 * (Cloudflare's facet lifecycle; one isolate lookup per
 * warm call).
 *
 * ⚠️  THE cacheKey IS A DOLLAR AMOUNT. Cloudflare bills EVERY DISTINCT value ever passed to
 * `LOADER.get` as a Dynamic Worker at $0.002/worker/day, and a new value is a cold isolate build
 * (~5MB, 1-2s): a per-request nonce in the key bills a new worker and a cold build on every
 * dispatch. Key components must be LOW-CARDINALITY: deploy version × owning
 * context × (content hash | the caller's build/commit id) — NEVER a nonce, timestamp, request id, or
 * offset, but for one bounded by failures (`generationId`). (The tension the nonce papered over is
 * real — a loaded isolate captures the minting host's `env.ITX`/`globalOutbound`, which can die
 * with the host's incarnation; we accept the rare re-dial failure and re-key on DEPLOY, not per
 * use.) The confinement contract, stated once: a loaded
 * worker's WHOLE world — `env.ITX` and every global fetch — is its owning context, so sibling calls
 * and egress route through the host's dispatch with no second path.
 */
export async function prepareConfinedWorker(
  opts: PrepareConfinedWorkerOptions,
): Promise<{ loaderId: string; load: () => WorkerStub; retire: () => void }> {
  const { where, source, cacheKey, mainModule } = opts;
  const requireFiles = (files: unknown): WorkerModules => {
    if (!isWorkerModules(files)) throw new Error(`${where}: a source is its files, path → code`);
    return files;
  };
  // 1. the key's last component, tagged with what names the code — a published module's identity,
  // the caller's cacheKey, or the content — so no cacheKey takes the id a module identity names;
  // and how the modules will be obtained.
  const named = opts.moduleIdentity
    ? `module:${opts.moduleIdentity}`
    : cacheKey
      ? `key:${cacheKey}`
      : undefined;
  let sourceVersion: string;
  let getModules: () => Promise<WorkerModules> | WorkerModules;
  if (isWorkerModules(source)) {
    const modules = requireFiles(source);
    readPackage(modules, where); // refused where it is handed in, not late in a cold load
    sourceVersion = named || `content:${contentHashOfWorkerModules(modules)}`;
    getModules = () => modules;
  } else {
    if (!named)
      throw new Error(
        `${where}: a source EXPRESSION needs a cacheKey (a build id, a commit) — the producer runs only when no isolate is warm under it and no answer of its is kept (a day, per deploy), so the key must change whenever the code does`,
      );
    sourceVersion = named;
    // A producer's modules are kept in `ITX_KV` under its whole input — the deploy (the loader id
    // folds it in too, and a deploy can change how a producer answers), the owner, the caller's key
    // (else the published module identity it loads under) and the expression — so a cold isolate
    // reads them there instead of waking the context that produces them. For the site ingress
    // that context is `/repos/config`, and a commit's tree never changes. A KV failure is a miss:
    // the producer runs, as it always did.
    const cacheFailed = (action: "get" | "put") => (error: unknown) => {
      console.warn({
        event: "worker-loader.platform-failure-module-cache",
        action,
        name: opts.owner,
        where,
        message: error instanceof Error ? error.message : String(error),
      });
    };
    /** Only an answer that can load is kept or believed: one the producer gave before its build
     *  landed must reach the dead-id recovery's next run, not be read back for a day. */
    const loadable = (files: unknown): files is WorkerModules => {
      if (!isWorkerModules(files)) return false;
      try {
        readPackage(files, where);
        return true;
      } catch {
        return false;
      }
    };
    getModules = async () => {
      const producer = normalizedItxExpression(source);
      const kvKey = `produced-modules-1/${await sha256Hex(
        JSON.stringify([
          opts.deployId,
          opts.owner,
          cacheKey || `module:${opts.moduleIdentity}`,
          producer,
        ]),
      )}`;
      const stored: unknown = await opts.env.ITX_KV.get(kvKey, "json").catch(cacheFailed("get"));
      if (loadable(stored)) return stored;
      // The producer is a read the cacheKey names, so running it twice is running it once: a read a
      // deploy's reset of the context it reads cut (the project ingress's
      // `itx.repos.get("/repos/config")`, read on the first request after every deploy), or a lost
      // connection, is read once more, from that context's fresh incarnation.
      const produced = await retryPlatformFailures(() => opts.invoke(producer), {
        area: "worker-loader",
        schedule: ONCE_NOW,
        idempotent: true,
        kind: failureKind,
        describe: () => ({ name: opts.owner, where }),
      });
      // A producer that answers one module's text (a `readFile`, a `kv.get`) answers the source of
      // that one module, named as its `main`.
      const files = requireFiles(
        typeof produced === "string"
          ? { "package.json": '{"main":"worker.js"}', "worker.js": produced }
          : produced,
      );
      const value = JSON.stringify(files);
      if (loadable(files) && new TextEncoder().encode(value).byteLength <= KV_VALUE_MAX_BYTES)
        await opts.env.ITX_KV.put(kvKey, value, {
          expirationTtl: PRODUCED_MODULES_TTL_SECONDS,
        }).catch(cacheFailed("put"));
      return files;
    };
  }
  // 2. the confined worker under the billed cacheKey. A JSON array, never `a:b:c`: a context name,
  //    a class name or a caller's cacheKey may itself contain ":", and a joined string would let two
  //    different owners name ONE isolate — a silent cross-context authority transfer, since the
  //    isolate's whole world is the host stub baked in at first materialization. Changing the
  //    spelling restarts every facet once on its next wake (a new restart marker), storage
  //    surviving — the same as a deploy does.
  const loaderIdBase = JSON.stringify([
    opts.kind,
    opts.deployId,
    opts.platformOrigin,
    opts.owner,
    sourceVersion,
    ...(mainModule ? [mainModule] : []),
  ]);
  const state = loaderIdGenerations.get(loaderIdBase) ?? { generation: 0, dead: false };
  let { generation } = state;
  // Produce AND resolve: a source whose imports cannot resolve (a missing file, a parse error, esm.sh
  // down) fails here — in the recovery below that is before `load()` opens a new generation, so a
  // failure that persists mints no billed identity per retry.
  const produce = async (): Promise<ResolvedWorker> =>
    enteredThroughPlatform(
      await resolveModules(await getModules(), resolveOptions(opts.env, where, mainModule)),
      PLATFORM_MODULES,
    );
  let workerForCode = produce;
  if (state.dead) {
    // Outside the loader, so a throw here poisons nothing; one run for every caller while it lasts.
    let recovery =
      state.recovery?.itxEntrypoint === opts.itxEntrypoint ? state.recovery.modules : undefined;
    if (!recovery) {
      const deadGeneration = generation;
      const started = Promise.resolve().then(produce);
      recovery = started;
      loaderIdGenerations.set(loaderIdBase, {
        generation,
        dead: true,
        recovery: { itxEntrypoint: opts.itxEntrypoint, modules: started },
      });
      // Only the recovery the map still holds settles it: a newer one (another incarnation's) wins.
      const settle = (next: { generation: number; dead: boolean }) => {
        if (loaderIdGenerations.get(loaderIdBase)?.recovery?.modules === started)
          loaderIdGenerations.set(loaderIdBase, next);
      };
      started.then(
        () => settle({ generation: deadGeneration + 1, dead: false }),
        () => settle({ generation: deadGeneration, dead: true }), // the next caller tries again
      );
    }
    const resolved = await recovery;
    generation += 1;
    workerForCode = async () => resolved;
  }
  const loaderId = generationId(loaderIdBase, generation);
  const load = () =>
    opts.env.LOADER.get(loaderId, async () => {
      let resolved: ResolvedWorker;
      try {
        // Only on a cold isolate; resolution is locked per dependency set in ITX_KV, so a cold start
        // after the first one reads KV and never the network.
        resolved = await workerForCode();
      } catch (error) {
        loaderIdGenerations.set(loaderIdBase, { generation, dead: true });
        throw error;
      }
      return {
        // The Node.js compatibility this date turns on stays off: it adds ~0.7 ms to every cold load
        // (measured 2026-09-29), and the SDK needs only `nodejs_als`, which carries a call's cause
        // (cause.ts).
        // `allow_irrevocable_stub_storage` (experimental) lets loaded code store its `env.ITX` stub
        // and replay it (workers-and-facets.e2e pins it) — every worker in the chain needs it, so
        // the parent config carries it too. No `limits`: trusted clients. The platform bounds a DO to
        // 10 distinct dynamic workers with in-flight requests — the pins' release keeps a context under it.
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: [
          "no_nodejs_compat",
          "no_nodejs_compat_v2",
          "nodejs_als",
          "allow_irrevocable_stub_storage",
        ],
        mainModule: resolved.mainModule,
        modules: resolved.modules,
        env: { ITX: opts.itxEntrypoint },
        globalOutbound: opts.itxEntrypoint,
      };
    });
  return {
    loaderId,
    load,
    /** Mark this identity DEAD: the next `prepareConfinedWorker` for the same base loads under the
     *  next generation — a genuinely fresh isolate. The recovery for a cached isolate that can no
     *  longer be called (the clone-version failure the DO's facet call names). */
    retire: () => {
      // Only the identity still current: a burst of calls that all failed on generation n retires
      // it once, and a late one never sends a recovered n+1 back to the dead n.
      const current = loaderIdGenerations.get(loaderIdBase) ?? { generation: 0, dead: false };
      if (current.generation === generation && !current.dead)
        loaderIdGenerations.set(loaderIdBase, { generation, dead: true });
    },
  };
}

/** WHETHER A CALL INTO A LOADED WORKER MET THE WORKER LOADER DEFECT that poisons a cached entry
 *  (facet-host.ts `isFacetStartPlatformFailure` names it; `retire` above is the recovery). The
 *  runtime reports it either as V8's clone-version text or as the opaque
 *  `internal error; reference = …`: its detail goes only to Cloudflare's own runtime log (workerd
 *  jsg/ser.c++), and the reference is logged nowhere, so it looks nothing up. The opaque text
 *  counts only when the runtime raised it: an internal failure inside the loaded worker reaches the
 *  caller unprefixed (workerd io/worker-entrypoint.c++ `exceptionToPropagate`), while an error the
 *  loaded code threw itself, the same text rethrown included, arrives with `remote` set and is the
 *  code's own. Retiring on that would mint a new billed identity for every request. An overload is
 *  its own kind of platform failure (platform-retry.ts `failureKind`), answered 503, and never a
 *  bad isolate. */
export function isLoadedWorkerPlatformFailure(error: unknown): error is Error {
  if (!(error instanceof Error) || errorCode(error) !== undefined) return false;
  if (error.message.includes("Unable to deserialize cloned data")) return true;
  // workerd's own flag on an error that crossed from another worker (jsg `decodeTunneledException`);
  // absent from the Error type, so read as the unknown it is.
  const { remote } = error as { remote?: unknown };
  return (
    error.message.startsWith("internal error; reference = ") &&
    remote !== true &&
    failureKind(error) === "failed"
  );
}

/** How the loader resolves a source (module-resolution.ts): this deployment's platform packages,
 *  the npm locks in ITX_KV, and the network for a dependency set no lock holds yet. */
function resolveOptions(
  env: { ITX_KV: KVNamespace },
  where: string,
  mainModule: string | undefined,
): ResolveOptions {
  return {
    platform: PLATFORM_MODULES,
    store: env.ITX_KV,
    // A wrapper, never the bare global: workerd refuses `fetch` called as another object's
    // method ("Illegal invocation"), which `opts.fetch(...)` in the resolver would be.
    fetch: (input, init) => fetch(input, init),
    where,
    mainModule,
  };
}

/**
 * THE IDENTITY OF ONE MODULE OF A SOURCE: the SHA-256 of what the loader loads with it as the main
 * module — its resolved graph, its npm dependencies as their locks have them — less this
 * deployment's platform packages, which the deploy id in every loader id names already. Two sources
 * whose `mainModule` answers one identity load the same code for it, so a facet whose class lives
 * there keeps running across a commit that changes only the rest of the source (a worker's
 * manifest, FacetHost). A module that does not resolve throws, as its load would.
 */
export async function moduleIdentityOf(
  files: WorkerModules,
  mainModule: string,
  env: { ITX_KV: KVNamespace },
  where: string,
): Promise<string> {
  const resolved = await resolveModules(files, resolveOptions(env, where, mainModule));
  const graph = Object.entries(resolved.modules)
    .filter(([name]) => !Object.hasOwn(PLATFORM_MODULES.modules, name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256Hex(JSON.stringify([resolved.mainModule, graph]));
}
