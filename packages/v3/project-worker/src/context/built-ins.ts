// built-ins.ts — THE BUILT-INS: a plain record whose KEYS are the physical-layer roots (`whoami`,
// `kv`, `append`, `read`, `waitForEvent`, `cd`, `fetch`, `rpcStubs`, `rewriteRules`,
// `facets`, `subscriptions`, `workers`, `runScript`). A call `itx.<root>…` resolves DIRECTLY against
// these (itx-expression-rewriting.ts `ItxExpressionResolver`, built-in first) — no rule. Rewrite
// rules name `itx.…` targets that rewrite through the same rules to reach a root; a bare root is
// unspellable, so the built-ins are unshadowable.
//
// LOADING DYNAMIC CODE — two doors, ONE PER HOST KIND, each a `get` on a noun:
//   • `itx.workers.get({ source, className?, props? }).method(...)` — a STATELESS `WorkerEntrypoint`
//     (its own isolate, no storage). No name: a stateless worker has no identity beyond its spec, so
//     the spec IS the address (naming one is a rewrite rule's job).
//   • `itx.facets.get(name, { source, className }).method(...)` — a `DurableObject` class hosted as
//     the durable FACET `name` of this stream (own storage) — the mirror of `ctx.facets.get(name,
//     startupCallback)`. Without the spec, `itx.facets.get(name)` ADDRESSES a facet that is already
//     running (a processor, a named instance) — same door, no source.
// Both bottom out in Cloudflare's Worker Loader (`env.LOADER.get(cacheKey, …)` then
// `worker.getEntrypoint()` / `worker.getDurableObjectClass()`); the two-step is folded into one door
// per host on purpose (BUILD-LOG 2026-09-02). `itx.runScript(lambda)` is sugar for the one bare-lambda
// case (wrap → `workers.get({ source }).run`).

import type { ReachableContext, StreamPage, WaitForEventFilter } from "../stream/stream.ts";
import type { StreamEvent, StreamEventInput } from "../stream/events.ts";
import { loadConfinedWorker, type WorkerCacheKey, type WorkerSource } from "./worker-loader.ts";
import { resolveContextPath } from "./durable-object-names.ts";
import { print, type ItxExpression } from "./expression.ts";
import { FacetHandle, InvokeHandle, RpcStubHandle } from "./invoke-handle.ts";

/** One row of `itx.subscriptions.list()`. */
export type SubscriptionListEntry = {
  name: string;
  target: string;
  consumes?: string[];
  configuredAtOffset: number;
  /** Present only when the STREAM keeps the cursor (a target that cannot own its progress). */
  cursor?: { confirmedOffset: number; attempt: number; nextAttemptAtMs?: number };
  halted?: { afterOffset: number; attempts: number; error?: string };
};

/** The one bare-lambda wrapper — `itx.runScript("async (itx, x) => …")`. The lambda STRING becomes
 *  a `WorkerEntrypoint`'s default export, so `runScript` bottoms out at the SAME `workers.get({
 *  source })` path as any exported entrypoint (no separate loader branch). `run()` injects
 *  the itx scope via `env.ITX.get()` — mid-chain handles/callbacks pipeline natively, exactly like a
 *  capnweb client after `projects.get(id)`. */
const RUN_SCRIPT_ENTRYPOINT = (script: string) => /* js */ `
import { WorkerEntrypoint } from "cloudflare:workers";
const cap = ${script};
export default class RunScript extends WorkerEntrypoint {
  async run(...args) {
    if (typeof cap !== "function") throw new Error("runScript: expected a function");
    return await cap(await this.env.ITX.get(), ...args);
  }
}
`;

/** THE built-in scope, as ONE interface — the physical-layer roots a context resolves `itx.<root>…`
 *  against DIRECTLY (itx-expression-rewriting.ts, built-in first; no rule).
 *  This is the clean-room's whole kernel surface. It is a PLAIN OBJECT, not an RpcTarget class, on
 *  purpose: the resolver gates on `Object.hasOwn`, so a prototype-method class would leave every
 *  root unreachable. Exported for ONE reader: the edge `IterateContext`'s TYPE merges it in
 *  (iterate-context.ts), so what rides the dotted hop is typed where a client holds it. */
export interface BuiltInScope {
  /** Identify this context. */
  whoami(): { projectId: string; path: string };
  /** Project-prefixed durable key/value (the `${projectId}:` prefix IS the isolation). */
  kv: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<{ ok: true }>;
    delete(key: string): Promise<{ ok: true }>;
    list(prefix?: string): Promise<{ keys: string[] }>;
  };
  /** Append to this context's append-only event log (the facets that REDUCE it are
   *  `itx.facets.get(name)`). A top-level root, so the expression surface mirrors the edge
   *  RpcTarget exactly: `itx.append({...})` is one spelling on every hop. */
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
  /** Read a page of the durable log — `itx.read(afterOffset?, limit?)`, the flattened twin of
   *  `append` (non-minting: a probe never wakes storage). */
  read(afterOffset?: number, limit?: number): Promise<StreamPage>;
  /** Wait for the next event matching `filter` (Stream.waitForEvent owns the contract: type filter,
   *  afterOffset default = the head, 30s/120s timeout → WAIT_TIMEOUT). A root, so the edge declares
   *  nothing for it. */
  waitForEvent(filter?: WaitForEventFilter): Promise<StreamEvent>;
  /** Navigate to another context of THIS project, routed through its own table. Absolute by
   *  convention ("/agents/x"); relative ("agents/x", "../inbox") resolves against this context's
   *  path — the same resolver the edge `cd` uses (resolveContextPath). */
  cd(path: string): InvokeHandle;
  /** Egress: `{{secret:project:NAME}}` placeholders substituted, then the FALLBACK terminal — the
   *  same door a loaded worker's `globalOutbound` and the edge `itx.fetch(request)` land on. */
  fetch(request: Request): Promise<Response>;
  /** The rpc-stub REGISTRY — physical, never event-sourced: a client's live capnweb value lent under
   *  an OPAQUE key by its session (relay-side, DON'T-PIN — the edge owns it, this side borrows).
   *  `get(rpcStubKey)` is how a REWRITE RULE names one: `itx.provide(match, stub)` lends the stub
   *  under the key = the canonical match and configures the pure-data rule `match ⇒
   *  itx.rpcStubs.get('<match>')`. */
  rpcStubs: {
    /** One stub by key: a pipelinable handle over its transport (borrowed, or paged then borrowed).
     *  Deep dots walk; a root call reaches the bare lent callable; offline ⇒ RPC_STUB_OFFLINE at call
     *  time. Branded `RpcStubHandle`: the subscription delivery loop reads the brand to know the
     *  callee owns its own progress. */
    get(rpcStubKey: string): RpcStubHandle;
    /** PRESENCE — the keys borrowed or pager-backed right now. */
    list(): string[];
  };
  /** The itx-expression rewrite-rule table, read (a slice of core) — the rules every call goes
   *  through. Written by `itx.provide(match, target | null)` on the edge (sugar over the ONE
   *  `itx/rewrite-rule-configured` event), never a verb here. */
  rewriteRules: {
    list(): { match: string; target: string }[];
    get(match: string): { match: string; target: string } | null;
  };
  /** The facets of this context. `get(name)` ADDRESSES one that is already running (a processor, a
   *  named instance) — no source; `get(name, { source, cacheKey?, className })` LOADS the class and
   *  hosts it as the durable facet `name` (own storage) — the mirror of Cloudflare's
   *  `ctx.facets.get(name, startupCallback)`; `source`/`cacheKey` as for `workers.get` (a new key
   *  restarts the facet, its storage surviving). `delete` removes it, storage included (the mirror of
   *  `ctx.facets.delete`). */
  facets: {
    get(
      name: string,
      spec?: { source: WorkerSource; cacheKey?: WorkerCacheKey; className: string },
    ): FacetHandle;
    delete(name: string): void;
  };
  /** The subscriptions layer, read: the table (a slice of core) joined with the stream-kept
   *  cursors. Read-only — `subscribe` lives on the edge as sugar over the `subscription-configured`
   *  event, never a verb here. */
  subscriptions: {
    list(): SubscriptionListEntry[];
    get(name: string): SubscriptionListEntry | null;
  };
  /** The stateless host: `get({ source, cacheKey?, className?, props? })` → a `WorkerEntrypoint` in
   *  its own confined isolate (no DO, no storage) — ANY method it exports, reached by name (`run`,
   *  `fetch`, `processEventBatch`, …). `source` is the worker's MODULES, literally (`{ "cap.js": code,
   *  … }`), OR an itx EXPRESSION that produces them — then `cacheKey` is REQUIRED and the producer runs
   *  only when no isolate is warm under it (worker-loader.ts: Cloudflare's `get(id, getCode)`
   *  contract; the caller owns "same key ⇒ same code"). `className` names the exported class (default:
   *  the default export); `props` is Cloudflare's own WorkerStubEntrypointOptions.props, read back as
   *  `this.ctx.props` (a url, a key name, …). No name and no `list`: a stateless worker is its spec. */
  workers: {
    get(spec: {
      source: WorkerSource;
      cacheKey?: WorkerCacheKey;
      className?: string;
      props?: unknown;
    }): InvokeHandle;
  };
  /** Run a stateless lambda STRING — sugar: wrap into a `WorkerEntrypoint`, then
   *  `workers.get({ source }).run(...)`. The one bare-lambda ergonomic (same as apps/os). */
  runScript(script: string, ...args: unknown[]): Promise<unknown>;
}

/** What the CONTEXT (the DO) injects: identity, the bindings, and the seams only it can serve. */
interface BuildBuiltInsDeps {
  projectId: string;
  path: string;
  /** The codec name of the context these roots belong to (loader cache keys). */
  iterateContextName: string;
  /** The bindings the built-ins reach: the loader (+ the deploy id its cacheKey folds in) and the
   *  project kv (bound in both wrangler configs). */
  env: { LOADER: WorkerLoader; ITX_KV: KVNamespace; CF_VERSION_METADATA?: { id: string } };
  /** Evaluate a producer source expression through THIS context's dispatch (inside the loader's
   *  `getCode`, so only on a cold isolate). */
  invoke: (call: ItxExpression) => Promise<unknown>;
  /** A context stream by CANONICAL path — the own-path parent adapter same-isolate, by-name DO
   *  stubs otherwise. Both satisfy ReachableContext (uniform-async, real-typed — see stream/stream.ts). */
  context: (path: string) => ReachableContext;
  /** The context's egress terminal (secret substitution → FALLBACK). */
  egress: (request: Request) => Promise<Response>;
  /** The rpcStubs view — PARENT-LOCAL closures over the context's transport table (the pager
   *  sockets live in the DO and can never move). */
  rpcStubs: BuiltInScope["rpcStubs"];
  /** The subscriptions view — the core slice ⋈ the delivery loop's cursors. */
  subscriptions: BuiltInScope["subscriptions"];
  /** The rewrite-rule view — the core slice, printed. */
  rewriteRules: BuiltInScope["rewriteRules"];
  /** The stream's waitForEvent (the own context's — a wait never crosses a hop). */
  waitForEvent: BuiltInScope["waitForEvent"];
  /** `facets.get(ref)` — address a facet by name, OR materialize `{ name, source, cacheKey?,
   *  className }` (a loaded durable object hosted as the facet `name` of this stream — the public
   *  `itx.facets.get(name, spec)` routes here; accepted trade: a busy stateful facet pins its
   *  stream). */
  facets: {
    get(
      ref:
        | string
        | { name: string; source: WorkerSource; cacheKey?: WorkerCacheKey; className: string },
    ): FacetHandle;
    delete(name: string): void;
  };
  /** The `env.ITX` / `globalOutbound` stub every worker this context loads receives — the
   *  ItxEntrypoint loopback minted once for this context (the DO's `#itxHost`; itx-entrypoint.ts
   *  for why it is never a raw getByName stub). */
  host: Fetcher;
}

/** Assemble the built-in scope for one context. Every entry closes over the context's identity —
 *  PRE-SCOPED, not policed: cross-project access is unspellable by construction. */
export function buildBuiltIns(deps: BuildBuiltInsDeps): Record<string, unknown> {
  const { projectId, path, iterateContextName, env } = deps;
  const { host } = deps;

  /** THE stateless host — `itx.workers.get(spec)`: a fresh confined isolate (no DO, no storage,
   *  `env.ITX` bound) over the loaded WorkerEntrypoint, and ONE method on it by name — `run`,
   *  `fetch`, `processEventBatch`, whatever the class declares. A terminal `fetch(request)` is this
   *  same call: `entrypoint.fetch(request)` IS the entrypoint's fetch channel, socket-bearing
   *  Responses included (fetch/rpc-stub-fetch.ts doctrine, points 1 & 4). The source EXPORTS the
   *  entrypoint (no host-injected wrapper — Cloudflare's `worker.getEntrypoint()` underneath).
   *  Re-resolves per call, but the loader caches by the key (cacheKey | content hash) so a warm
   *  isolate is reused and a producer expression never re-runs. */
  const callEntrypoint = async (
    spec: { source: WorkerSource; cacheKey?: WorkerCacheKey; className?: string; props?: unknown },
    method: string,
    args: unknown[],
  ) => {
    const { worker } = await loadConfinedWorker({
      env,
      host,
      kind: "code",
      owner: iterateContextName,
      source: spec.source,
      cacheKey: spec.cacheKey,
      invoke: deps.invoke,
      where: "workers.get",
    });
    const entrypoint = worker.getEntrypoint(
      spec.className,
      spec.props === undefined ? undefined : { props: spec.props },
    ) as Fetcher & Record<string, (...a: unknown[]) => Promise<unknown>>;
    const fn = entrypoint[method];
    if (typeof fn !== "function")
      throw new Error(`workers.get(spec): the entrypoint has no method "${method}"`);
    return Reflect.apply(fn, entrypoint, args);
  };

  const kvPrefix = `${projectId}:`;
  const ownContext = () => deps.context(path);

  // Each root implements one member of the BuiltInScope interface above (the canonical doc of the
  // kernel surface); the comments here add only what the interface can't say — the WHY of a code branch.
  return {
    whoami: () => ({ projectId, path }),
    kv: {
      get: (k: string) => env.ITX_KV.get(kvPrefix + k),
      put: async (k: string, v: string) => {
        await env.ITX_KV.put(kvPrefix + k, String(v));
        return { ok: true };
      },
      delete: async (k: string) => {
        await env.ITX_KV.delete(kvPrefix + k);
        return { ok: true };
      },
      list: async (start = "") => {
        // Paginate on the cursor: Cloudflare KV caps ONE list page at 1000 keys, so a single
        // `list()` would present page 1 as the whole truth (sweep/GC would orphan key 1001+). Drain.
        const out: string[] = [];
        for (let cursor: string | undefined; ; ) {
          const page = await env.ITX_KV.list({
            prefix: kvPrefix + start,
            ...(cursor && { cursor }),
          });
          for (const k of page.keys) out.push(k.name.slice(kvPrefix.length));
          if (page.list_complete) return { keys: out };
          cursor = page.cursor;
        }
      },
    },
    // Own-enumerable closures (NOT prototype methods) — the resolver's `Object.hasOwn` gate is why.
    append: (...e: StreamEventInput[]) => ownContext().append(...e),
    read: (after?: number, limit?: number) => ownContext().read(after, limit),
    waitForEvent: deps.waitForEvent,
    // `cd` routes through the target context's own table, EXCEPT append/read, which skip the facet
    // hop straight to the log door (the physical fast path). Codec-named, so only THIS project is
    // reachable; the path resolves against THIS context (absolute, or relative with `.`/`..`).
    cd: (target: string) =>
      new InvokeHandle((itxExpressionSteps) => {
        const sibling = deps.context(resolveContextPath(path, target)); // a ReachableContext — real-typed seam
        const [first] = itxExpressionSteps;
        if (itxExpressionSteps.length === 1 && Array.isArray(first) && first[0] === "append")
          return sibling.append(...(first.slice(1) as StreamEventInput[]));
        if (itxExpressionSteps.length === 1 && Array.isArray(first) && first[0] === "read")
          return sibling.read(...(first.slice(1) as [number?, number?]));
        return sibling.invoke(["itx", ...itxExpressionSteps]);
      }),
    fetch: (request: Request) => deps.egress(request),
    rpcStubs: deps.rpcStubs,
    facets: {
      get: (
        name: string,
        spec?: { source: WorkerSource; cacheKey?: WorkerCacheKey; className: string },
      ) => {
        if (typeof name !== "string")
          throw new Error(
            "itx.facets.get(name, spec?): name the facet; pass { source, className } to load and host it",
          );
        return deps.facets.get(
          spec
            ? {
                name,
                source: spec.source,
                ...(spec.cacheKey !== undefined && { cacheKey: spec.cacheKey }),
                className: spec.className,
              }
            : name,
        );
      },
      delete: (name: string) => deps.facets.delete(name),
    },
    subscriptions: deps.subscriptions,
    rewriteRules: deps.rewriteRules,
    // A genuine InvokeHandle, so `workers.get(spec).run()` pipelines on every lane (workerd#6873).
    workers: {
      get: (spec: {
        source: WorkerSource;
        cacheKey?: WorkerCacheKey;
        className?: string;
        props?: unknown;
      }) =>
        new InvokeHandle((methodSteps) => {
          const [call] = methodSteps;
          if (methodSteps.length !== 1 || !Array.isArray(call) || call[0] === "")
            throw new Error(
              `workers.get(spec).${print(methodSteps)}: a WorkerEntrypoint exposes flat methods`,
            );
          return callEntrypoint(spec, call[0], call.slice(1));
        }),
    },
    // `RUN_SCRIPT_ENTRYPOINT` wraps the lambda string into a WorkerEntrypoint default export, so even
    // this bare-lambda door bottoms out at `workers.get({ source }).run(...)`.
    runScript: (script: string, ...args: unknown[]) =>
      callEntrypoint({ source: { "cap.js": RUN_SCRIPT_ENTRYPOINT(script) } }, "run", args),
  } satisfies BuiltInScope;
}
