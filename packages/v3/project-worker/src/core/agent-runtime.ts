// agent-runtime.ts — code injected into every loaded agent's confined isolate.
//
// A loaded worker's `env.ITX` is a Workers-RPC service binding to the `ItxEntrypoint`. It reaches
// the genuine itx scope with `env.ITX.get()` — a real `Itx` RpcTarget — and then writes plain
// dotted access (`itx.demo.timer.callLater(cb)`), identical to what a capnweb client writes after
// `session.get()`. There is no client-side wrapper: the scope IS a real RpcTarget, so mid-chain
// handles and callbacks pipeline natively over both lanes (no accumulating Proxy, no fold shim).

// A loaded SOURCE now EXPORTS its own host object — a `WorkerEntrypoint` (reached with
// `itx.load(src).getEntrypoint(name?)`) or a `DurableObject` class (`…getDurableObjectClass(name)`),
// mirroring Cloudflare's own `worker.getEntrypoint()` / `worker.getDurableObjectClass()`. There is
// NO host-injected wrapper: the code the author wrote IS what runs. The one bare-lambda ergonomic —
// `itx.runScript("async (itx, x) => …")` — wraps its string into a WorkerEntrypoint at the call
// site (built-ins.ts `RUN_SCRIPT_ENTRYPOINT`), so even that bottoms out at an EXPORTED entrypoint.

// (The STATEFUL dynamic-worker wrapper `statefulDoRunner` was removed: with native facet RPC
// (Reflect.apply via invokePath), the stream DO loads the user's
// `DurableObject` class DIRECTLY and calls its methods — no `__HostedActor` fetch-tunnel wrapper.)

/** Load a confined dynamic worker — THE one loader wiring (stateless code caps, userspace facet
 *  processors, stateful facets all ride it). The confinement contract, stated once: the
 *  worker's WHOLE world — `env.ITX` (a service binding to the ItxEntrypoint; `.get()` yields the
 *  real itx scope) and every global fetch — is its owning context, so sibling calls and egress
 *  route through the host's dispatch with no second path. Callers version their `cacheKey`
 *  themselves (content hash + deploy id — see the stale-isolate learning on versionedFacet below).
 *
 *  ═══════════════════════════════════════════════════════════════════════════════════════════
 *  ⚠️  THE cacheKey IS A DOLLAR AMOUNT — one of the most cost-sensitive levers in the system.
 *  Cloudflare bills EVERY DISTINCT value ever passed to `LOADER.get` as a Dynamic Worker at
 *  $0.002/worker/day. apps/os PR #2504: a per-request random nonce in the key produced ~3.9M
 *  identities ≈ $7.8k in ~3 weeks, plus a cold isolate build on every dispatch (~5MB, 1-2s).
 *  Key components must be LOW-CARDINALITY and each one priced: deploy version × owning context
 *  × content hash — NEVER a random nonce, timestamp, request id, or offset. (The tension the
 *  nonce papered over is real — a loaded isolate captures the minting host's `env.ITX`/
 *  `globalOutbound`, which can die with the host's incarnation; we accept the rare
 *  re-dial failure and re-key on DEPLOY, not per use.)
 *  ═══════════════════════════════════════════════════════════════════════════════════════════ */
/** The cacheKey is MINTED HERE — the one audit point for the dollar lever. `kind` is a CLOSED
 *  union (`code` = a stateless isolate; `facet` = a durable class hosted as a facet — the merge
 *  of the old `procfacet`/`stateful`, which differed only in module set) so a new key family is a
 *  deliberate type change; `owner` is composed collision-free by `facetLoaderOwner`;
 *  `contentHash` versions the source. */
import { toExpression, type Expression } from "./expression.ts";
import { hashSource } from "./hash.ts";
import { PROCESSOR_SDK_MODULE } from "../generated/processor-sdk.ts";

/** Compose the loader cacheKey `owner` (context + a discriminator: a processor slug or a stateful
 *  className) COLLISION-FREE. The naive `${context}:${discriminator}` aliased across a different
 *  split — context "/x:y"+class "Door" and context "/x"+class "y:Door" both became
 *  "…/x:y:Door", a SHARED loader cacheKey = silent cross-context authority transfer (the isolate's
 *  whole world is the host stub baked in at first materialization). Length-prefixing the context
 *  makes the split unambiguous regardless of `:` in either half. (wave2-sweep.test.ts) */
export function facetLoaderOwner(contextName: string, discriminator: string): string {
  return `${contextName.length}#${contextName}#${discriminator}`;
}

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
    // handle back — every chain member needs the flag (see iterate-context-entrypoint.ts).
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
 *  The two used to inline this block each; unifying it is why "load the code" and "choose the host"
 *  are now visibly separate. `version` (the contentHash) rides back for the facet marker dance. */
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
}): Promise<{ worker: ReturnType<typeof confinedWorker>; version: string }> {
  const userModules = await resolveSource(opts.invoke, opts.source, opts.what);
  const version = hashSource(JSON.stringify(userModules));
  const worker = confinedWorker(
    opts.env,
    { kind: opts.kind, owner: opts.owner, contentHash: version },
    opts.mainModule,
    { ...userModules, "processor.js": PROCESSOR_SDK_MODULE, ...opts.extraModules },
    opts.host,
  );
  return { worker, version };
}

/** Materialize (or restart on a source change) a durable facet hosting a LOADED class, keeping
 *  its storage across restarts — the version-marker dance, stated once for both hosts (the
 *  stream's userspace processors and stateful facets). The deploy id is already in the
 *  loader cacheKey (confinedWorker); the marker catches CONTENT changes within a deploy. */
/** A source expression may evaluate to a modules record ({ name: code }) or to ONE module
 *  string (plain kv — increment 57 killed the files root); normalize to the loader's shape.
 *  Anything else is a loud error, not an empty worker. */
function asModules(result: unknown, what: string): Record<string, string> {
  if (typeof result === "string") return { "cap.js": result };
  if (result && typeof result === "object" && !Array.isArray(result))
    return result as Record<string, string>;
  throw new Error(`${what}: source expression produced no module code`);
}

/** A worker/facet SOURCE is a PRODUCER of module code, resolved the SAME way at every load site
 *  (stateless workers, stateful facets, processor facets — the three callers that used to inline
 *  `asModules(await invoke(source))` each). Two shapes, both bottoming out here:
 *   • an itx-Expression producer — the norm. `itx.kv.get('src/x.js')` IS a callback that fetches
 *     the code; a repo fetch is just `itx.repo.get(...)`; a provided capnweb/Workers-RPC callback
 *     is any expression that invokes it. Re-derivable across incarnations — the durable form,
 *     mirroring apps/os `env.LOADER.get(cacheKey, () => code)` with the producer on the wire.
 *   • `{ type: "inline", files }` — the code handed over literally (apps/os `WorkerFileSource`
 *     inline), the one shape with no producer to invoke.
 *  `type:"repo"` is deliberately NOT a third branch here — it is surface sugar that compiles to a
 *  producer expression, so there is ONE resolve path, not a per-variant fan-out. */
export type WorkerSource = string | Expression | { type: "inline"; files: Record<string, string> };
export async function resolveSource(
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
