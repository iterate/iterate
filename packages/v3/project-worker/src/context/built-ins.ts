// built-ins.ts — THE BUILT-INS: a plain record whose KEYS are the physical-layer roots (`whoami`,
// `kv`, `append`, `read`, `cd`, `fetch`, `rpcStubs`, `facets`, `subscriptions`, `load`, `runScript`). A call
// `itx.<root>…` resolves DIRECTLY against these (capability-table.ts `resolve`, built-in
// first) — no config, no mount. Userspace `provide` mounts resolve against `{ itx }` alone and
// recurse through the `itx` symbol to reach a root; a bare root is unspellable, so the built-ins
// are unshadowable.
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

import { itxEntrypointFor } from "../itx-entrypoint.ts";
import type { Context } from "../stream/stream.ts";
import type { StreamEventInput } from "../stream/events.ts";
import type { IterateContextDurableObject } from "../iterate-context-durable-object.ts";
import { loadConfinedWorker, type WorkerSource } from "./worker-loader.ts";
import { resolveContextPath } from "./durable-object-names.ts";
import type { Expression } from "./expression.ts";
import { FacetHandle, InvokeHandle, RpcStubHandle } from "./invoke-handle.ts";

/** The `rpcStubs` view every context has: the live-stub REGISTRY, surfaced. One entry per parked
 *  live capnweb value (client callbacks and live subscribers — one registry), keyed by the string
 *  it was parked under (the mount path, when it came through `itx.provide(path, fn)`). Physical
 *  by nature: nothing here is event-sourced; a mount reaches an entry through the pure-data
 *  target `itx.rpcStubs.get('<key>')`. */
type RpcStubsView = {
  /** One stub by key: a pipelinable handle over its transport (page → RetainedCallbackInvoker leg
   *  → invoke). Deep dots walk; a root call reaches the bare parked callable; offline ⇒
   *  CONNECTION_OFFLINE at call time. Branded `RpcStubHandle`: the subscription delivery loop reads
   *  the brand to know the callee owns its own progress. */
  get(key: string): RpcStubHandle;
  /** PRESENCE — the keys with an open transport right now. */
  list(): string[] | Promise<string[]>;
};

/** The `subscriptions` view: the subscriptions table (an inline reduce) joined with each cursor
 *  target's cursor (kv, effect-side truth). Small and read-only — `subscribe` is edge sugar over the
 *  `subscription-configured` event, never a verb here. */
type SubscriptionsView = {
  list(): SubscriptionListEntry[];
  get(name: string): SubscriptionListEntry | null;
};
export type SubscriptionListEntry = {
  name: string;
  target: string;
  consumes?: string[];
  configuredAtOffset: number;
  /** Present only when the STREAM keeps the cursor (a target that cannot own its progress). */
  cursor?: { confirmedOffset: number; attempt: number; nextAttemptAtMs?: number };
  halted?: { afterOffset: number; attempts: number; error?: string };
};

/** The DEP shape (context-injected): the facet door reaches ANY method a facet's durable object
 *  exposes (facet stubs are non-transferable, so the walk happens parent-side). `ref` is a STRING
 *  (address an already-running facet by name — processors, named instances) OR `{ source, className,
 *  name? }` (materialize the loaded `className` durable object as a facet — the form `itx.load(...)
 *  .getDurableObjectClass(...).get(...)` routes here internally). The PUBLIC `itx.facets` root is
 *  string-only; the object form is spelled through `itx.load`. `delete` removes a facet, storage
 *  included (the mirror of `ctx.facets.delete`). */
type FacetsView = {
  get(ref: string | { source?: unknown; className?: string; name?: string }): FacetHandle;
  delete(name: string): void;
};

/** The bindings roots-building needs — present in BOTH hosting lanes (the worker env). */
export interface BuiltInsEnv {
  CONTEXT: DurableObjectNamespace<IterateContextDurableObject>;
  LOADER: WorkerLoader;
  ITX_KV?: KVNamespace;
  SECRETS_KV?: KVNamespace;
  /** Deploy identity — reduced into loader cacheKeys so a redeploy mints fresh isolates. */
  CF_VERSION_METADATA?: { id: string };
  /** The egress terminal this context's `fetch` bottoms out at (secret-substituted, then sent). */
  FALLBACK: Fetcher;
}

/** The one bare-lambda wrapper — `itx.runScript("async (itx, x) => …")`. The lambda STRING becomes
 *  a `WorkerEntrypoint`'s default export, so `runScript` bottoms out at the SAME `load(...)
 *  .getEntrypoint()` path as any exported entrypoint (no separate loader branch). `run()` injects
 *  the itx scope via `env.ITX.get()` — mid-chain handles/callbacks pipeline natively, exactly like a
 *  capnweb client after `session.get()`. This used to be a host-injected wrapper on EVERY stateless
 *  load (`CODE_CAP_RUNNER`); it now rides only this one bare-lambda door. */
const RUN_SCRIPT_ENTRYPOINT = (script: string) => /* js */ `
import { WorkerEntrypoint } from "cloudflare:workers";
const cap = ${script};
export default class RunScript extends WorkerEntrypoint {
  async run(...args) {
    if (typeof cap !== "function") throw new Error("runScript: expected a function");
    return await cap(await this.env.ITX.get(), ...args);
  }
  fetch(request) {
    if (typeof cap?.fetch === "function") return cap.fetch(request, this.env, this.ctx);
    return new Response("this script serves no fetch\\n", { status: 405 });
  }
}
`;

/** THE built-in scope, as ONE interface — the physical-layer roots a context resolves `itx.<root>…`
 *  against DIRECTLY (capability-table.ts `resolve`, built-in first; no config, no mount).
 *  This is the clean-room's whole kernel surface. It is a PLAIN OBJECT, not an RpcTarget class, on
 *  purpose: the resolver spreads it (`{ ...builtIns, itx }`) and gates on `Object.hasOwn`, so a
 *  prototype-method class would spread to `{}` and every root would go unreachable. */
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
   *  RpcTarget exactly: `itx.append({...})` is one spelling on every lane. */
  append(...events: StreamEventInput[]): Promise<unknown>;
  /** Read a page of the durable log — `itx.read(afterOffset?, limit?)`, the flattened twin of
   *  `append` (non-minting: a probe never wakes storage). */
  read(afterOffset?: number, limit?: number): Promise<unknown>;
  /** Navigate to another context of THIS project, routed through its own table. Absolute by
   *  convention ("/agents/x"); relative ("agents/x", "../inbox") resolves against this context's
   *  path — the same resolver the edge `cd` uses (resolveContextPath). */
  cd(path: string): unknown;
  /** Egress: `{{secret:project:NAME}}` placeholders substituted, then the FALLBACK terminal — the
   *  same door a loaded worker's `globalOutbound` and the edge `itx.fetch(request)` land on. */
  fetch(request: Request): Promise<Response>;
  /** The live rpc-stub REGISTRY — physical, never event-sourced: a client's live capnweb value
   *  parked under a key (the edge's `itx.rpcStubs.provide(value, { key? })` — relay-side, DON'T-PIN).
   *  `get(key)` is how a MOUNT names one: `itx.provide(path, fn)` is sugar for parking under `path`
   *  and mounting the pure-data target `itx.rpcStubs.get('<path>')`. Offline ⇒ CONNECTION_OFFLINE
   *  at call time; `list()` is presence (which keys have a transport right now). */
  rpcStubs: RpcStubsView;
  /** Address a facet that is ALREADY RUNNING by name (a processor, a named instance) — no source;
   *  to LOAD and host a class, use `itx.load(src).getDurableObjectClass(name).get(name?)`. `delete`
   *  removes it, storage included. */
  facets: { get(name: string): unknown; delete(name: string): void };
  /** The subscriptions layer, read: the table (an inline reduce) joined with the stream-kept
   *  cursors. `subscribe` lives on the edge as sugar over the `subscription-configured` event. */
  subscriptions: SubscriptionsView;
  /** Load dynamic code → a WORKER, then pick the host (mirror of Cloudflare's Worker Loader):
   *  `.getEntrypoint(name?, { props? })` → a stateless `WorkerEntrypoint` — ANY method it exports,
   *  reached by name (`run`, `fetch`, `processEventBatch`, …); `props` is Cloudflare's own
   *  WorkerStubEntrypointOptions.props, read back as `this.ctx.props` (a url, a key name, …);
   *  `.getDurableObjectClass(name)` → a `DurableObject` class whose `.get(instance?)` is a durable
   *  facet of this stream. `source` is a producer expression, a bare string, or `{ type:"inline" }`. */
  load(source: WorkerSource): unknown;
  /** Run a stateless lambda STRING — sugar: wrap into a `WorkerEntrypoint`, then
   *  `load(...).getEntrypoint().run(...)`. The one bare-lambda ergonomic (same as apps/os). */
  runScript(script: string, ...args: unknown[]): Promise<unknown>;
}

/** What the CONTEXT (the stream DO) injects: identity, bindings, and the three context seams. */
interface BuildBuiltInsDeps {
  projectId: string;
  path: string;
  /** The codec name of the context these roots belong to (loader cache keys, self-stubs). */
  contextName: string;
  env: BuiltInsEnv;
  /** Resolve one call through THIS context's dispatch (dynamic-worker module loading). */
  invoke: (call: Expression) => Promise<unknown>;
  /** A context stream by CANONICAL path — the own-path parent adapter same-isolate, by-name DO
   *  stubs otherwise. Both satisfy Context (uniform-async, real-typed — see stream/stream.ts). */
  context: (path: string) => Context;
  /** The context's egress terminal (secret substitution → FALLBACK). */
  egress: (request: Request) => Promise<Response>;
  /** The rpcStubs view — PARENT-LOCAL closures over the context's transport table (the pager
   *  sockets live in the DO and can never move). */
  rpcStubs: RpcStubsView;
  /** The subscriptions view — the inline reduce ⋈ the delivery loop's cursors. */
  subscriptions: SubscriptionsView;
  /** `facets.get(ref)` — address a facet by name, OR materialize `{ source, className }` (a loaded
   *  durable object hosted as a facet of this stream; accepted trade: a busy stateful facet pins
   *  its stream). */
  facets: FacetsView;
  /** The ctx whose `exports` mints the ItxEntrypoint loopback — a loaded worker's whole world
   *  (see itx-entrypoint.ts for why it is never a raw getByName stub). */
  exportsCtx: unknown;
}

/** Assemble the built-in scope for one context. Every entry closes over the context's identity —
 *  PRE-SCOPED, not policed: cross-project access is unspellable by construction. The builder
 *  must never register `itx` (asserted below — the resolver's recursion symbol always wins). */
export function buildBuiltIns(deps: BuildBuiltInsDeps): Record<string, unknown> {
  const { projectId, path, contextName, env } = deps;

  /** THE stateless host — `worker.getEntrypoint(className?)`: a fresh confined isolate (no DO, no
   *  storage, `env.ITX` bound), a `{ run, fetch }` handle over the loaded WorkerEntrypoint. Loading
   *  is the shared `loadConfinedWorker` (kind "code"); the source EXPORTS the entrypoint (no
   *  host-injected wrapper — the mirror of Cloudflare's `worker.getEntrypoint()`). Re-resolves per
   *  call, but the loader caches by contentHash so a warm isolate is reused. */
  const statelessHandle = (source: WorkerSource, className?: string, props?: unknown) => {
    const entrypoint = async () => {
      const { worker } = await loadConfinedWorker({
        env,
        invoke: deps.invoke,
        host: itxEntrypointFor(deps.exportsCtx, contextName),
        kind: "code",
        owner: contextName,
        source,
        mainModule: "cap.js",
        what: "load.getEntrypoint",
      });
      return worker.getEntrypoint(
        className,
        props === undefined ? undefined : { props },
      ) as Fetcher & Record<string, (...a: unknown[]) => Promise<unknown>>;
    };
    return {
      /** Any exported method by name — `run`, `processEventBatch`, whatever the class declares. */
      call: async (method: string, args: unknown[]) => {
        const ep = await entrypoint();
        const fn = ep[method];
        if (typeof fn !== "function")
          throw new Error(`load(src).getEntrypoint(): the entrypoint has no method "${method}"`);
        return Reflect.apply(fn, ep, args);
      },
      fetch: async (request: Request) => (await entrypoint()).fetch(request),
    };
  };

  const kvPrefix = `${projectId}:`;
  const own = () => deps.context(path);
  const kvBinding = () => {
    if (!env.ITX_KV) throw new Error("kv: no ITX_KV bound");
    return env.ITX_KV;
  };

  // Each root implements one member of the BuiltInScope interface above (the canonical doc of the
  // kernel surface); the comments here add only what the interface can't say — the WHY of a code branch.
  const scope = {
    whoami: () => ({ projectId, path }),
    kv: {
      get: (k: string) => kvBinding().get(kvPrefix + k),
      put: async (k: string, v: string) => {
        await kvBinding().put(kvPrefix + k, String(v));
        return { ok: true };
      },
      delete: async (k: string) => {
        await kvBinding().delete(kvPrefix + k);
        return { ok: true };
      },
      list: async (start = "") => {
        // Paginate on the cursor: Cloudflare KV caps ONE list page at 1000 keys, so a single
        // `list()` would present page 1 as the whole truth (sweep/GC would orphan key 1001+). Drain.
        const out: string[] = [];
        for (let cursor: string | undefined; ; ) {
          const page = await kvBinding().list({
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
    // `cd` routes through the target context's own table, EXCEPT append/read, which skip the facet
    // hop straight to the log door (the physical fast path). Codec-named, so only THIS project is
    // reachable; the path resolves against THIS context (absolute, or relative with `.`/`..`).
    cd: (target: string) =>
      new InvokeHandle((segments, args) => {
        const sibling = deps.context(resolveContextPath(path, target)); // a Context — real-typed seam
        if (segments.length === 1 && (segments[0] === "append" || segments[0] === "read"))
          return segments[0] === "append"
            ? sibling.append(...(args as StreamEventInput[]))
            : sibling.read(...(args as [number?, number?]));
        const last = segments[segments.length - 1] as string;
        return sibling.invoke(["itx", ...segments.slice(0, -1), [last, ...args]]);
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
    // Each hop is its own InvokeHandle, so the whole `load(src).getEntrypoint().run()` /
    // `.getDurableObjectClass('C').get(name?)` chain pipelines on every lane (workerd#6873).
    load: (source: WorkerSource) => {
      const entrypointHandle = (className?: string, opts?: { props?: unknown }) => {
        const h = statelessHandle(source, className, opts?.props);
        return new InvokeHandle((seg, args) => {
          if (seg.length !== 1)
            throw new Error(
              `load(src).getEntrypoint().${seg.join(".")}: a WorkerEntrypoint exposes flat methods`,
            );
          // Terminal fetch rides the entrypoint's REAL fetch channel — the only hop kind that
          // carries socket Responses (fetch/fetch-capabilities.ts doctrine, points 1 & 4).
          if (seg[0] === "fetch") return h.fetch(args[0] as Request);
          return h.call(seg[0], args);
        });
      };
      const classHandle = (className: string) =>
        new InvokeHandle((seg, args) => {
          if (seg.length === 1 && seg[0] === "get")
            // .get(instance?) → the durable facet; deps.facets.get folds the rest into facetInvoke.
            return deps.facets.get({ source, className, name: args[0] as string | undefined });
          throw new Error(
            `load(src).getDurableObjectClass('${className}').${seg.join(".")}: call .get(name?)`,
          );
        });
      return new InvokeHandle((seg, args) => {
        if (seg.length === 1 && seg[0] === "getEntrypoint")
          return entrypointHandle(args[0] as string | undefined, args[1] as { props?: unknown });
        if (seg.length === 1 && seg[0] === "getDurableObjectClass") {
          if (typeof args[0] !== "string")
            throw new Error("load(src).getDurableObjectClass(name): name the exported class");
          return classHandle(args[0]);
        }
        throw new Error(
          `load(src).${seg.join(".")}: call .getEntrypoint(name?) or .getDurableObjectClass(name)`,
        );
      });
    },
    // `RUN_SCRIPT_ENTRYPOINT` wraps the lambda string into a WorkerEntrypoint default export, so even
    // this bare-lambda door bottoms out at `load(...).getEntrypoint().run(...)`.
    runScript: (script: string, ...args: unknown[]) =>
      statelessHandle({
        type: "inline",
        files: { "cap.js": RUN_SCRIPT_ENTRYPOINT(script) },
      }).call("run", args),
  } satisfies BuiltInScope;
  if (Object.hasOwn(scope, "itx")) throw new Error("built-in scope must never register 'itx'");
  return scope;
}
