// built-ins.ts — THE BUILT-INS: a plain record whose KEYS are the physical-layer roots (`whoami`,
// `kv`, `stream`, `cd`, `rpcStubs`, `facets`, `load`, `runScript`, `connectToCapnweb`). A call
// `itx.<root>…` resolves DIRECTLY against these (capability-table-processor.ts `resolve`, built-in
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

import { loadConfinedWorker, type WorkerSource } from "./core/worker-loader.ts";
import { itxEntrypointFor } from "./itx-entrypoint.ts";
import { newHttpBatchRpcSession } from "capnweb";
import type { Expression } from "./core/expression.ts";
import { InvokeHandle } from "./core/invoke-handle.ts";
import type { Context } from "./core/stream.ts";
import type { StreamEventInput } from "./core/events.ts";

/** The `rpcStubs` view every context has: the live-stub registry, surfaced. One entry per held
 *  live capnweb stub (client callbacks and parked subscribers — one registry). */
type RpcStubsView = {
  /** One stub by key: a method proxy over its retained callback (wake → RetainedCallbackInvoker
   *  leg → invoke). Deep dots walk; throws when offline. */
  get(key: string): unknown;
  /** The keys currently held by this context. Fan-out is `list()` + map over `get(key)` (no
   *  built-in `each` — the caller owns the allSettled over live members). */
  list(): unknown[] | Promise<unknown[]>;
  /** Close a stub's pager WebSocket (idempotent — unknown keys are a no-op). */
  close(key: string): { ok: true } | Promise<{ ok: true }>;
};

/** The DEP shape (host-injected): the facet door reaches ANY method a facet's durable object
 *  exposes (facet stubs are non-transferable, so the walk happens parent-side). `ref` is a STRING
 *  (address an already-running facet by name — processors, named instances) OR `{ source, className,
 *  name? }` (materialize the loaded `className` durable object as a facet — the form `itx.load(...)
 *  .getDurableObjectClass(...).get(...)` routes here internally). The PUBLIC `itx.facets` root is
 *  string-only; the object form is spelled through `itx.load`. */
type FacetsView = {
  get(ref: string | { source?: unknown; className?: string; name?: string }): unknown;
};

/** THE built-in scope, as ONE interface — the physical-layer roots a context resolves `itx.<root>…`
 *  against DIRECTLY (capability-table-processor.ts `resolve`, built-in first; no config, no mount).
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
  /** This context's append-only event log (the facets that REDUCE it are `itx.facets.get(name)`). */
  stream: {
    append(...events: StreamEventInput[]): Promise<unknown>;
    read(afterOffset?: number, limit?: number): Promise<unknown>;
  };
  /** Navigate to a SIBLING context, routed through its own table. */
  cd(path: string): unknown;
  /** The live rpc-stub registry (`get`/`list`/`close`; `provide` is relay-side — DON'T-PIN). */
  rpcStubs: RpcStubsView;
  /** Address a facet that is ALREADY RUNNING by name (an enabled processor, a named instance). No
   *  source — to LOAD and host a class, use `itx.load(src).getDurableObjectClass(name).get(name?)`. */
  facets: { get(name: string): unknown };
  /** Load dynamic code → a WORKER, then pick the host (mirror of Cloudflare's Worker Loader):
   *  `.getEntrypoint(name?)` → a stateless `WorkerEntrypoint` (`.run`/`.fetch`);
   *  `.getDurableObjectClass(name)` → a `DurableObject` class whose `.get(instance?)` is a durable
   *  facet of this stream. `source` is a producer expression, a bare string, or `{ type:"inline" }`. */
  load(source: WorkerSource): unknown;
  /** Run a stateless lambda STRING — sugar: wrap into a `WorkerEntrypoint`, then
   *  `load(...).getEntrypoint().run(...)`. The one bare-lambda ergonomic (same as apps/os). */
  runScript(script: string, ...args: unknown[]): Promise<unknown>;
  /** Dial a REMOTE capnweb API by URL (one HTTP batch — no persistent socket). */
  connectToCapnweb(url: string): unknown;
}
import type { StreamDurableObject } from "./stream-durable-object.ts";

/** The bindings roots-building needs — present in BOTH hosts (the worker env). */
export interface BuiltInsEnv {
  CONTEXT: DurableObjectNamespace<StreamDurableObject>;
  LOADER: WorkerLoader;
  ITX_KV?: KVNamespace;
  SECRETS_KV?: KVNamespace;
  /** Deploy identity — reduced into loader cacheKeys so a redeploy mints fresh isolates. */
  CF_VERSION_METADATA?: { id: string };
  /** The egress terminal this context's `fetch` bottoms out at (secret-substituted, then sent). */
  FALLBACK: Fetcher;
}

/** What the hosting side injects: identity, bindings, and the three host-specific seams. */
interface BuildBuiltInsDeps {
  projectId: string;
  path: string;
  /** The codec name of the context these roots belong to (loader cache keys, self-stubs). */
  contextName: string;
  env: BuiltInsEnv;
  /** Resolve one call through THIS context's dispatch (dynamic-worker module loading). */
  invoke: (call: Expression) => Promise<unknown>;
  /** A context stream by path — the own-path parent adapter same-isolate, by-name DO stubs
   *  facet-side. Both satisfy Context (uniform-async, real-typed — see core/stream.ts). */
  context: (path: string) => Context;
  /** The rpcStubs view (parent-local closures over the HibernatableRpcStubManager). */
  rpcStubs: RpcStubsView;
  /** `facets.get(ref)` — address a facet by name, OR materialize `{ source, className }` (a loaded
   *  durable object hosted as a facet of this stream; accepted trade: a busy stateful facet pins
   *  its stream). */
  facets: FacetsView;
  /** The ctx whose `exports` mints the ItxEntrypoint loopback (the loaded-worker
   *  host — see itx-entrypoint.ts for why it is never a raw getByName stub). */
  hostCtx: unknown;
}

/** Assemble the host scope for one context. Every entry closes over the context's identity —
 *  PRE-SCOPED, not policed: cross-project access is unspellable by construction. The builder
 *  must never register `itx` (asserted below — the resolver's recursion symbol always wins). */
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

export function buildBuiltIns(deps: BuildBuiltInsDeps): Record<string, unknown> {
  const { projectId, path, contextName, env } = deps;

  /** THE stateless host — `worker.getEntrypoint(className?)`: a fresh confined isolate (no DO, no
   *  storage, `env.ITX` bound), a `{ run, fetch }` handle over the loaded WorkerEntrypoint. Loading
   *  is the shared `loadConfinedWorker` (kind "code"); the source EXPORTS the entrypoint (no
   *  host-injected wrapper — the mirror of Cloudflare's `worker.getEntrypoint()`). Re-resolves per
   *  call, but the loader caches by contentHash so a warm isolate is reused. */
  const statelessHandle = (source: WorkerSource, className?: string) => {
    const entrypoint = async () => {
      const { worker } = await loadConfinedWorker({
        env,
        invoke: deps.invoke,
        host: itxEntrypointFor(deps.hostCtx, contextName),
        kind: "code",
        owner: contextName,
        source,
        mainModule: "cap.js",
        what: "load.getEntrypoint",
      });
      return worker.getEntrypoint(className) as unknown as {
        run(...a: unknown[]): Promise<unknown>;
        fetch(r: Request): Promise<Response>;
      };
    };
    return {
      run: async (...args: unknown[]) => (await entrypoint()).run(...args),
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
            ...(cursor ? { cursor } : {}),
          });
          for (const k of page.keys) out.push(k.name.slice(kvPrefix.length));
          if (page.list_complete) return { keys: out };
          cursor = page.cursor;
        }
      },
    },
    stream: {
      append: (...e: StreamEventInput[]) => own().append(...e),
      read: (after?: number, limit?: number) => own().read(after, limit),
    },
    // `cd` routes through the SIBLING's own table, EXCEPT append/read, which skip the facet hop
    // straight to the log door (the physical fast path). Codec-named, so only THIS project is reachable.
    cd: (siblingPath: string) =>
      new InvokeHandle((segments, args) => {
        const sibling = deps.context(siblingPath); // a Context — no cast (real-typed seam)
        if (segments.length === 1 && (segments[0] === "append" || segments[0] === "read"))
          return segments[0] === "append"
            ? sibling.append(...(args as StreamEventInput[]))
            : sibling.read(...(args as [number?, number?]));
        const last = segments[segments.length - 1] as string;
        return sibling.invoke(["itx", ...segments.slice(0, -1), [last, ...args]]);
      }),
    rpcStubs: deps.rpcStubs,
    facets: {
      get: (name: string) => {
        if (typeof name !== "string")
          throw new Error(
            "itx.facets.get(name): address a RUNNING facet by name. To load & host a class use itx.load(src).getDurableObjectClass('Class').get(name?)",
          );
        return deps.facets.get(name);
      },
    },
    // Each hop is its own InvokeHandle, so the whole `load(src).getEntrypoint().run()` /
    // `.getDurableObjectClass('C').get(name?)` chain pipelines on every lane (workerd#6873).
    load: (source: WorkerSource) => {
      const entrypointHandle = (className?: string) => {
        const h = statelessHandle(source, className);
        return new InvokeHandle((seg, args) => {
          if (seg.length === 1 && seg[0] === "run") return h.run(...args);
          if (seg.length === 1 && seg[0] === "fetch") return h.fetch(args[0] as Request);
          throw new Error(
            `load(src).getEntrypoint().${seg.join(".")}: a WorkerEntrypoint exposes run|fetch`,
          );
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
          return entrypointHandle(args[0] as string | undefined);
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
      }).run(...args),
    // HTTP batch (not a WebSocket) on purpose: no persistent socket, so it never pins this DO
    // (workerd#6087). The outbound-capnweb primitive — a named `itx.os` becomes a mount over it.
    connectToCapnweb: (url: string) =>
      new InvokeHandle((path, args) => {
        // Walk the remote stub via capnweb's NATIVE promise pipelining — NO intervening awaits, or
        // the one-shot HTTP batch flushes early and every hop after the first dies with capnweb's
        // "Batch RPC request ended" (build the whole chain with no awaits; workerd/capnweb#26 +
        // prove_connect_multihop.mjs). Property access pipelines; the TERMINAL call sends the batch,
        // and the caller awaits once on its result. (This is why we can't route through the generic
        // `walkSteps`, which awaits every intermediate.)
        const session = newHttpBatchRpcSession(url) as unknown as Record<string, unknown>;
        let target = session;
        for (const seg of path.slice(0, -1)) target = target[seg] as Record<string, unknown>;
        return (target[path.at(-1)!] as (...a: unknown[]) => unknown)(...args);
      }),
  } satisfies BuiltInScope;
  if (Object.hasOwn(scope, "itx")) throw new Error("host scope must never register 'itx'");
  return scope;
}
