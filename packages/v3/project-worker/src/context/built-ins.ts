// built-ins.ts — THE BUILT-INS: a plain record whose KEYS are the physical-layer roots (`whoami`,
// `kv`, `append`, `read`, `waitForEvent`, `cd`, `fetch`, `rpcStubs`, `expressionRewriteRules`,
// `facets`, `subscriptions`, `load`, `runScript`). A call `itx.<root>…` resolves DIRECTLY against
// these (itx-expression-rewriting.ts `ItxExpressionResolver`, built-in first) — no rule. Rewrite
// rules name `itx.…` targets that rewrite through the same rules to reach a root; a bare root is
// unspellable, so the built-ins are unshadowable.
//
// LOADING DYNAMIC CODE — `itx.load(source)` mirrors Cloudflare's Worker Loader: it loads the code
// and hands back a WORKER, then you pick the host EXPLICITLY, the same two accessors Cloudflare
// exposes:
//   • `itx.load(src).getEntrypoint(name?).run(...)` — a STATELESS `WorkerEntrypoint` (its own
//     isolate, no storage) — the mirror of `worker.getEntrypoint()`.
//   • `itx.load(src).getDurableObjectClass('C').get(name?).method(...)` — a `DurableObject` class
//     hosted as a durable FACET of this stream (own storage; a `name` is an independent instance)
//     — the mirror of `worker.getDurableObjectClass()` + `ctx.facets.get(name, { class })`.
// `itx.facets.get(name)` is the SEPARATE door for a facet that is ALREADY RUNNING (processors,
// named instances) — address by name, no source. `itx.runScript(lambda)` is sugar for the one
// bare-lambda case (wrap → `load(...).getEntrypoint().run`).

import type { Context, StreamPage, WaitForEventFilter } from "../stream/stream.ts";
import type { StreamEvent, StreamEventInput } from "../stream/events.ts";
import { loadConfinedWorker, type WorkerSource } from "./worker-loader.ts";
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
 *  a `WorkerEntrypoint`'s default export, so `runScript` bottoms out at the SAME `load(...)
 *  .getEntrypoint()` path as any exported entrypoint (no separate loader branch). `run()` injects
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
 *  root unreachable. */
interface BuiltInScope {
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
   *  `get(rpcStubKey)` is how a REWRITE RULE names one: `itx.provide(key, { stub, rewrite })` is
   *  sugar for lending under `key` and configuring the pure-data rule `rewrite ⇒
   *  itx.rpcStubs.get('<key>')`. */
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
   *  through. Written by `itx.rewrite(match, target | null)` on the edge (sugar over the ONE
   *  `itx/rewrite-rule-configured` event), never a verb here. */
  expressionRewriteRules: {
    list(): { match: string; target: string }[];
    get(match: string): { match: string; target: string } | null;
  };
  /** Address a facet that is ALREADY RUNNING by name (a processor, a named instance) — no source;
   *  to LOAD and host a class, use `itx.load(src).getDurableObjectClass(name).get(name?)`. `delete`
   *  removes it, storage included (the mirror of `ctx.facets.delete`). */
  facets: { get(name: string): FacetHandle; delete(name: string): void };
  /** The subscriptions layer, read: the table (a slice of core) joined with the stream-kept
   *  cursors. Read-only — `subscribe` lives on the edge as sugar over the `subscription-configured`
   *  event, never a verb here. */
  subscriptions: {
    list(): SubscriptionListEntry[];
    get(name: string): SubscriptionListEntry | null;
  };
  /** Load dynamic code → a WORKER, then pick the host (mirror of Cloudflare's Worker Loader):
   *  `.getEntrypoint(name?, { props? })` → a stateless `WorkerEntrypoint` — ANY method it exports,
   *  reached by name (`run`, `fetch`, `processEventBatch`, …); `props` is Cloudflare's own
   *  WorkerStubEntrypointOptions.props, read back as `this.ctx.props` (a url, a key name, …);
   *  `.getDurableObjectClass(name)` → a `DurableObject` class whose `.get(instance?)` is a durable
   *  facet of this stream. `source` is a producer expression, a bare string, or `{ type:"inline" }`. */
  load(source: WorkerSource): InvokeHandle;
  /** Run a stateless lambda STRING — sugar: wrap into a `WorkerEntrypoint`, then
   *  `load(...).getEntrypoint().run(...)`. The one bare-lambda ergonomic (same as apps/os). */
  runScript(script: string, ...args: unknown[]): Promise<unknown>;
}

/** What the CONTEXT (the DO) injects: identity, the bindings, and the seams only it can serve. */
interface BuildBuiltInsDeps {
  projectId: string;
  path: string;
  /** The codec name of the context these roots belong to (loader cache keys). */
  contextName: string;
  /** The bindings the built-ins reach: the loader (+ the deploy id its cacheKey folds in) and the
   *  project kv (bound in both wrangler configs). */
  env: { LOADER: WorkerLoader; ITX_KV: KVNamespace; CF_VERSION_METADATA?: { id: string } };
  /** Resolve one call through THIS context's dispatch (dynamic-worker module loading). */
  invoke: (call: ItxExpression) => Promise<unknown>;
  /** A context stream by CANONICAL path — the own-path parent adapter same-isolate, by-name DO
   *  stubs otherwise. Both satisfy Context (uniform-async, real-typed — see stream/stream.ts). */
  context: (path: string) => Context;
  /** The context's egress terminal (secret substitution → FALLBACK). */
  egress: (request: Request) => Promise<Response>;
  /** The rpcStubs view — PARENT-LOCAL closures over the context's transport table (the pager
   *  sockets live in the DO and can never move). */
  rpcStubs: BuiltInScope["rpcStubs"];
  /** The subscriptions view — the core slice ⋈ the delivery loop's cursors. */
  subscriptions: BuiltInScope["subscriptions"];
  /** The rewrite-rule view — the core slice, printed. */
  expressionRewriteRules: BuiltInScope["expressionRewriteRules"];
  /** The stream's waitForEvent (the own context's — a wait never crosses a hop). */
  waitForEvent: BuiltInScope["waitForEvent"];
  /** `facets.get(ref)` — address a facet by name, OR materialize `{ source, className, name? }` (a
   *  loaded durable object hosted as a facet of this stream — the form `itx.load(...)
   *  .getDurableObjectClass(...).get(...)` routes here; accepted trade: a busy stateful facet pins
   *  its stream). The PUBLIC `itx.facets` root is string-only. */
  facets: {
    get(ref: string | { source: WorkerSource; className: string; name?: string }): FacetHandle;
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
  const { projectId, path, contextName, env } = deps;
  const { host } = deps;

  /** THE stateless host — `worker.getEntrypoint(className?)`: a fresh confined isolate (no DO, no
   *  storage, `env.ITX` bound) over the loaded WorkerEntrypoint, and ONE method on it by name — `run`,
   *  `fetch`, `processEventBatch`, whatever the class declares. A terminal `fetch(request)` is this
   *  same call: `entrypoint.fetch(request)` IS the entrypoint's fetch channel, socket-bearing
   *  Responses included (fetch/rpc-stub-fetch.ts doctrine, points 1 & 4). The source EXPORTS the
   *  entrypoint (no host-injected wrapper — the mirror of Cloudflare's `worker.getEntrypoint()`).
   *  Re-resolves per call, but the loader caches by contentHash so a warm isolate is reused. */
  const callEntrypoint = async (
    source: WorkerSource,
    className: string | undefined,
    props: unknown,
    method: string,
    args: unknown[],
  ) => {
    const { worker } = await loadConfinedWorker({
      env,
      invoke: deps.invoke,
      host,
      kind: "code",
      owner: contextName,
      source,
      where: "load.getEntrypoint",
    });
    const entrypoint = worker.getEntrypoint(
      className,
      props === undefined ? undefined : { props },
    ) as Fetcher & Record<string, (...a: unknown[]) => Promise<unknown>>;
    const fn = entrypoint[method];
    if (typeof fn !== "function")
      throw new Error(`load(src).getEntrypoint(): the entrypoint has no method "${method}"`);
    return Reflect.apply(fn, entrypoint, args);
  };

  const kvPrefix = `${projectId}:`;
  const own = () => deps.context(path);

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
    append: (...e: StreamEventInput[]) => own().append(...e),
    read: (after?: number, limit?: number) => own().read(after, limit),
    waitForEvent: deps.waitForEvent,
    // `cd` routes through the target context's own table, EXCEPT append/read, which skip the facet
    // hop straight to the log door (the physical fast path). Codec-named, so only THIS project is
    // reachable; the path resolves against THIS context (absolute, or relative with `.`/`..`).
    cd: (target: string) =>
      new InvokeHandle((itxExpressionSteps) => {
        const sibling = deps.context(resolveContextPath(path, target)); // a Context — real-typed seam
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
      get: (name: string) => {
        if (typeof name !== "string")
          throw new Error(
            "itx.facets.get(name): address a RUNNING facet by name. To load & host a class use itx.load(src).getDurableObjectClass('Class').get(name?)",
          );
        return deps.facets.get(name);
      },
      delete: (name: string) => deps.facets.delete(name),
    },
    subscriptions: deps.subscriptions,
    expressionRewriteRules: deps.expressionRewriteRules,
    // Each hop is its own InvokeHandle, so the whole `load(src).getEntrypoint().run()` /
    // `.getDurableObjectClass('C').get(name?)` chain pipelines on every lane (workerd#6873).
    load: (source: WorkerSource) =>
      new InvokeHandle((itxExpressionSteps) => {
        const [first] = itxExpressionSteps;
        const oneCall = itxExpressionSteps.length === 1 && Array.isArray(first) ? first : undefined;
        if (oneCall?.[0] === "getEntrypoint") {
          const [, className, options] = oneCall as [string, string?, { props?: unknown }?];
          return new InvokeHandle((methodSteps) => {
            const [call] = methodSteps;
            if (methodSteps.length !== 1 || !Array.isArray(call) || call[0] === "")
              throw new Error(
                `load(src).getEntrypoint().${print(methodSteps)}: a WorkerEntrypoint exposes flat methods`,
              );
            return callEntrypoint(source, className, options?.props, call[0], call.slice(1));
          });
        }
        if (oneCall?.[0] === "getDurableObjectClass") {
          const className = oneCall[1];
          if (typeof className !== "string")
            throw new Error("load(src).getDurableObjectClass(name): name the exported class");
          return new InvokeHandle((methodSteps) => {
            const [call] = methodSteps;
            // .get(instance?) → the durable facet; deps.facets.get reduces the rest into the DO's facet door.
            if (methodSteps.length === 1 && Array.isArray(call) && call[0] === "get")
              return deps.facets.get({ source, className, name: call[1] as string | undefined });
            throw new Error(
              `load(src).getDurableObjectClass('${className}').${print(methodSteps)}: call .get(name?)`,
            );
          });
        }
        throw new Error(
          `load(src).${print(itxExpressionSteps)}: call .getEntrypoint(name?) or .getDurableObjectClass(name)`,
        );
      }),
    // `RUN_SCRIPT_ENTRYPOINT` wraps the lambda string into a WorkerEntrypoint default export, so even
    // this bare-lambda door bottoms out at `load(...).getEntrypoint().run(...)`.
    runScript: (script: string, ...args: unknown[]) =>
      callEntrypoint(
        { type: "inline", files: { "cap.js": RUN_SCRIPT_ENTRYPOINT(script) } },
        undefined,
        undefined,
        "run",
        args,
      ),
  } satisfies BuiltInScope;
}
