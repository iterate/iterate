// worker-loader.ts — THE loader: wrap Cloudflare's `env.LOADER` (a `WorkerLoader`) into the two
// hosts this system runs dynamic code under — a stateless WorkerEntrypoint isolate, or a durable
// DurableObject facet. `confinedWorker` mints the confined isolate (the billed cacheKey lives here);
// `loadConfinedWorker` is the one shared "load the code" step; `versionedFacet` hosts a loaded class
// as a facet with a source-change restart marker; `resolveSource` normalizes a source to modules.
//
// A loaded worker's `env.ITX` is a Workers-RPC service binding to the `ItxEntrypoint`. It reaches
// the genuine itx scope with `env.ITX.get()` — a real `IterateContext` RpcTarget — and then writes plain
// dotted access (`itx.demo.timer.callLater(cb)`), identical to what a capnweb client writes after
// `session.get()`. There is no client-side wrapper: the scope IS a real RpcTarget, so mid-chain
// handles and callbacks pipeline natively over both lanes (no accumulating Proxy, no fold shim).

// A loaded SOURCE now EXPORTS its own host object — a `WorkerEntrypoint` (reached with
// `itx.load(src).getEntrypoint(name?)`) or a `DurableObject` class (`…getDurableObjectClass(name)`),
// mirroring Cloudflare's own `worker.getEntrypoint()` / `worker.getDurableObjectClass()`. There is
// NO host-injected wrapper: the code the author wrote IS what runs. The one bare-lambda ergonomic —
// `itx.runScript("async (itx, x) => …")` — wraps its string into a WorkerEntrypoint at the call
// site (built-ins.ts `RUN_SCRIPT_ENTRYPOINT`), so even that bottoms out at an EXPORTED entrypoint.

// A stateful dynamic worker is the user's `DurableObject` class loaded DIRECTLY as a facet; the
// stream DO calls its methods via native facet RPC (Reflect.apply through invokePath) — no wrapper.

import { PROCESSOR_SDK_MODULE } from "../generated/processor-sdk.ts";
import { toExpression, type Expression } from "./expression.ts";
import { hashSource } from "./hash.ts";

/** Compose the loader cacheKey `owner` (context + a discriminator: a processor slug or a stateful
 *  className) COLLISION-FREE. The naive `${context}:${discriminator}` aliased across a different
 *  split — context "/x:y"+class "Door" and context "/x"+class "y:Door" both became
 *  "…/x:y:Door", a SHARED loader cacheKey = silent cross-context authority transfer (the isolate's
 *  whole world is the host stub baked in at first materialization). Length-prefixing the context
 *  makes the split unambiguous regardless of `:` in either half. (wave2-sweep.test.ts) */
export function facetLoaderOwner(contextName: string, discriminator: string): string {
  return `${contextName.length}#${contextName}#${discriminator}`;
}

/** MINTS the loader cacheKey — the one audit point for the system's most cost-sensitive lever. The
 *  confinement contract, stated once: a loaded worker's WHOLE world — `env.ITX` (a service binding to
 *  the ItxEntrypoint; `.get()` yields the real itx scope) and every global fetch — is its owning
 *  context, so sibling calls and egress route through the host's dispatch with no second path.
 *
 *  ⚠️  THE cacheKey IS A DOLLAR AMOUNT. Cloudflare bills EVERY DISTINCT value ever passed to
 *  `LOADER.get` as a Dynamic Worker at $0.002/worker/day. apps/os PR #2504: a per-request random
 *  nonce in the key produced ~3.9M identities ≈ $7.8k in ~3 weeks, plus a cold isolate build on
 *  every dispatch (~5MB, 1-2s). Key components must be LOW-CARDINALITY: deploy version × owning
 *  context × content hash — NEVER a nonce, timestamp, request id, or offset. (The tension the nonce
 *  papered over is real — a loaded isolate captures the minting host's `env.ITX`/`globalOutbound`,
 *  which can die with the host's incarnation; we accept the rare re-dial failure and re-key on
 *  DEPLOY, not per use.) `kind` is a CLOSED union (`code` = stateless isolate; `facet` = durable
 *  class hosted as a facet) so a new key family is a deliberate type change; `owner` is composed
 *  collision-free by `facetLoaderOwner`; `contentHash` versions the source. */
export function confinedWorker(
  env: { LOADER: WorkerLoader; CF_VERSION_METADATA?: { id: string } },
  key: { kind: "code" | "facet"; owner: string; contentHash: string },
  mainModule: string,
  modules: Record<string, string>,
  host: Fetcher,
) {
  const deploy = env.CF_VERSION_METADATA?.id ?? "unversioned";
  return env.LOADER.get(`${key.kind}:${deploy}:${key.owner}:${key.contentHash}`, () => ({
    compatibilityDate: "2026-07-01",
    // Chain-enable Kenton's persistent-stub machinery: a loaded worker may STORE its env.ITX
    // (a ctx.exports-minted entrypoint stub) in its own durable storage and get a replay-on-use
    // handle back — every chain member needs the flag (see itx-entrypoint.ts).
    compatibilityFlags: ["allow_irrevocable_stub_storage"],
    mainModule,
    // The processor SDK ("processor.js", ~330KB) is injected by `loadConfinedWorker` (THE one
    // caller), not here, so `confinedWorker` stays a pure loader-primitive: every load gets
    // "processor.js" (any user code may `import "./processor.js"` uniformly), and only the
    // "runner.js" adapter stays processor-role-only. The itx scope is reached via `env.ITX.get()`,
    // not an injected module.
    modules,
    env: { ITX: host },
    globalOutbound: host,
  }));
}

/** THE one loading step, shared by BOTH hosts: resolve the source → contentHash → mint the confined
 *  worker (SDK injected). It stops at the loaded `worker` handle — the CALLER then chooses the host,
 *  exactly like Cloudflare's own two-step: `worker.getEntrypoint(name?)` for a stateless
 *  `WorkerEntrypoint` (built-ins.ts `statelessHandle`), or `worker.getDurableObjectClass(name)` fed
 *  to `versionedFacet` for a durable `DurableObject` facet (stream-durable-object.ts `#durableFacet`).
 * "load the code" and "choose the host" are visibly separate. `version` (the contentHash) rides back for the facet marker dance. */
export async function loadConfinedWorker(opts: {
  env: { LOADER: WorkerLoader; CF_VERSION_METADATA?: { id: string } };
  invoke: (call: Expression) => Promise<unknown>;
  host: Fetcher;
  kind: "code" | "facet";
  owner: string;
  source: WorkerSource;
  mainModule: string;
  /** Role-specific modules layered over the user's source + the always-present SDK (e.g. the
   *  processor `runner.js` adapter). */
  extraModules?: Record<string, string>;
  what: string;
  /** PRE-RESOLVED `{ modules, version }` from a caller-owned memo — skips the source fetch + hash.
   *  The commit pump loads the SAME facet on EVERY commit; a per-facet memo (keyed by the printed
   *  source expression, invalidated at disable/quiesce) turns that into one fetch+hash per
   *  materialization instead of one per commit. The loader `cacheKey` is unchanged either way (a warm
   *  isolate returns cheaply), so this is pure work avoided, not a cardinality change. */
  resolved?: { version: string; modules: Record<string, string> };
}): Promise<{
  worker: ReturnType<typeof confinedWorker>;
  version: string;
  modules: Record<string, string>;
}> {
  const userModules =
    opts.resolved?.modules ?? (await resolveSource(opts.invoke, opts.source, opts.what));
  const version = opts.resolved?.version ?? hashSource(JSON.stringify(userModules));
  const worker = confinedWorker(
    opts.env,
    { kind: opts.kind, owner: opts.owner, contentHash: version },
    opts.mainModule,
    { ...userModules, "processor.js": PROCESSOR_SDK_MODULE, ...opts.extraModules },
    opts.host,
  );
  return { worker, version, modules: userModules };
}

/** A source expression may evaluate to a modules record ({ name: code }) or to ONE module
 *  string (plain kv); normalize to the loader's shape.
 *  Anything else is a loud error, not an empty worker. */
function asModules(result: unknown, what: string): Record<string, string> {
  if (typeof result === "string") return { "cap.js": result };
  if (result && typeof result === "object" && !Array.isArray(result))
    return result as Record<string, string>;
  throw new Error(`${what}: source expression produced no module code`);
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
async function resolveSource(
  invoke: (call: Expression) => Promise<unknown>,
  source: WorkerSource,
  what: string,
): Promise<Record<string, string>> {
  if (
    typeof source === "object" &&
    !Array.isArray(source) &&
    (source as { type?: string }).type === "inline"
  )
    return asModules((source as { files: Record<string, string> }).files, what);
  return asModules(await invoke(toExpression(source as string | Expression)), what);
}

/** Materialize (or restart on a source change) a durable facet hosting a LOADED class, keeping
 *  its storage across restarts — the version-marker dance, stated once for both hosts (the
 *  stream's userspace processors and stateful facets). The deploy id is already in the
 *  loader cacheKey (confinedWorker); the marker catches CONTENT changes within a deploy. */
export function versionedFacet(
  ctx: {
    storage: { kv: { get(k: string): unknown; put(k: string, v: unknown): void } };
    facets: {
      get(name: string, cb: () => { class: DurableObjectClass }): unknown;
      abort(name: string, reason: string): void;
    };
  },
  opts: {
    worker: { getDurableObjectClass(name: string): DurableObjectClass | undefined };
    className: string;
    facetName: string;
    markerKey: string;
    version: string;
  },
): unknown {
  const klass = opts.worker.getDurableObjectClass(opts.className);
  if (!klass) throw new Error(`loaded worker does not export class "${opts.className}"`);
  const prev = ctx.storage.kv.get(opts.markerKey) as string | undefined;
  if (prev !== undefined && prev !== opts.version) {
    try {
      ctx.facets.abort(opts.facetName, "source changed");
    } catch {
      /* facet not running */
    }
  }
  if (prev !== opts.version) ctx.storage.kv.put(opts.markerKey, opts.version);
  return ctx.facets.get(opts.facetName, () => ({ class: klass }));
}
