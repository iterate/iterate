// built-ins.ts — THE BUILT-INS: a plain record whose KEYS are the physical-layer roots (`whoami`,
// `kv`, `stream`, `cd`, `rpcStubs`, `facets`, `workers`, `runScript`). A call `itx.<root>…`
// resolves DIRECTLY against these (capability-table-processor.ts `resolve`, built-in first) — no
// config, no mount. Userspace `provide` mounts resolve against `{ itx }` alone and recurse through
// the `itx` symbol to reach a root; a bare root is unspellable, so the built-ins are unshadowable.

import {
  CODE_CAP_RUNNER,
  confinedWorker,
  resolveSource,
  type WorkerSource,
} from "./core/agent-runtime.ts";
import { PROCESSOR_SDK_MODULE } from "./generated/processor-sdk.ts";
import { itxEntrypointFor } from "./itx-entrypoint.ts";
import { toExpression, type Expression } from "./core/expression.ts";
import { InvokeHandle } from "./core/invoke-handle.ts";
import type { Context } from "./core/stream.ts";
import type { StreamEventInput } from "./core/events.ts";
import { hashSource } from "./core/hash.ts";

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

/** `facets.get(ref)` → a dotted method proxy over ONE facet (a durable object run as a facet of
 *  this stream) — ANY method it exposes (facet stubs are non-transferable, so the walk happens
 *  parent-side). `ref` is a STRING (address an already-running facet by name — processors, built-in
 *  slugs) OR `{ source, className }` (materialize the loaded `className` durable object as a facet).
 *  The mirror of `workers.get(ref)` (a stateless WorkerEntrypoint): entrypoint vs durable object. */
type FacetsView = {
  get(ref: string | { source: unknown; className: string }): unknown;
};

/** Run STATELESS code in this context — a fresh confined isolate, a `{ run, fetch }` handle (no DO,
 *  no storage). `get({ source })` loads code from a source; scope-level `runScript(script)` is sugar
 *  for wrapping a lambda STRING and `get({ source }).run(...)`. Durable classes hosted as facets are
 *  the mirror door, `itx.facets.get({ source, className })`. */
type WorkersView = {
  get(ref: { source: unknown }): unknown;
};
import type { StreamDurableObject } from "./stream-durable-object.ts";

/** The bindings roots-building needs — present in BOTH hosts (the worker env). */
export interface BuiltInsEnv {
  CONTEXT: DurableObjectNamespace<StreamDurableObject>;
  LOADER: WorkerLoader;
  ITX_KV?: KVNamespace;
  SECRETS_KV?: KVNamespace;
  /** Deploy identity — reduced into loader cacheKeys so a redeploy mints fresh isolates. */
  CF_VERSION_METADATA?: { id: string };
  /** The shell this context's egress + `itx.os` bottom out at (a whole control plane). */
  FALLBACK: Fetcher & { invokeCapability(callPath: string, args?: unknown[]): Promise<unknown> };
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
   *  durable object hosted as a facet of this stream; the runner DO died in increment 57 — accepted
   *  trade: a busy stateful facet pins its stream). */
  facets: FacetsView;
  /** The ctx whose `exports` mints the ItxEntrypoint loopback (the loaded-worker
   *  host — see iterate-context-entrypoint.ts for why it is never a raw getByName stub). */
  hostCtx: unknown;
}

/** Assemble the host scope for one context. Every entry closes over the context's identity —
 *  PRE-SCOPED, not policed: cross-project access is unspellable by construction. The builder
 *  must never register `itx` (asserted below — the resolver's recursion symbol always wins). */
export function buildBuiltIns(deps: BuildBuiltInsDeps): Record<string, unknown> {
  const { projectId, path, contextName, env } = deps;

  /** PRIMITIVE — load a stateless, non-facet confined worker (kind "code"): its own isolate,
   *  no DO, no storage, `env.ITX` bound. Returns the `{ run, fetch }` handle. `source` is a
   *  producer (an itx-Expression, or `{ type:"inline", files }`), resolved by the one shared
   *  `resolveSource` path. */
  const statelessHandle = (source: WorkerSource) => {
    const entrypoint = async () => {
      const modules = await resolveSource(deps.invoke, source, "workers.get");
      const worker = confinedWorker(
        env,
        { kind: "code", owner: contextName, contentHash: hashSource(JSON.stringify(modules)) },
        "run.js",
        { "run.js": CODE_CAP_RUNNER, "processor.js": PROCESSOR_SDK_MODULE, ...modules },
        itxEntrypointFor(deps.hostCtx, contextName),
      );
      return worker.getEntrypoint() as unknown as {
        run(...a: unknown[]): Promise<unknown>;
        fetch(r: Request): Promise<Response>;
      };
    };
    return {
      run: async (...args: unknown[]) => (await entrypoint()).run(...args),
      fetch: async (request: Request) => (await entrypoint()).fetch(request),
    };
  };
  const workers: WorkersView = {
    get: (ref) => statelessHandle(ref.source as WorkerSource),
  };

  const itxKv = env.ITX_KV;
  const kvPrefix = `${projectId}:`;
  const own = () => deps.context(path);

  /** One prefixed view over the shared namespace — the prefix IS the isolation. */
  const prefixedKv = (prefix: string, what: string) => {
    const kv = () => {
      if (!itxKv) throw new Error(`${what}: no ITX_KV bound`);
      return itxKv;
    };
    return {
      get: (k: string) => kv().get(prefix + k),
      put: async (k: string, v: string) => {
        await kv().put(prefix + k, String(v));
        return { ok: true };
      },
      delete: async (k: string) => {
        await kv().delete(prefix + k);
        return { ok: true };
      },
      keys: async (start = "") => {
        // Paginate on the cursor: Cloudflare KV caps ONE list page at 1000 keys, so a single
        // `list()` would silently present page 1 as the whole truth (sweep/GC over it would leave
        // key 1001+ as permanent orphans). Drain every page.
        const out: string[] = [];
        for (let cursor: string | undefined; ; ) {
          const page = await kv().list({ prefix: prefix + start, ...(cursor ? { cursor } : {}) });
          for (const k of page.keys) out.push(k.name.slice(prefix.length));
          if (page.list_complete) return out;
          cursor = page.cursor;
        }
      },
    };
  };
  const projectKv = prefixedKv(kvPrefix, "kv");

  const scope: Record<string, unknown> = {
    whoami: () => ({ projectId, path }),
    /** Project-prefixed KV. */
    kv: {
      get: projectKv.get,
      put: projectKv.put,
      delete: projectKv.delete,
      list: async (start = "") => ({ keys: await projectKv.keys(start) }),
    },
    /** MY OWN stream — a deliberate, chosen surface (append/read), never the raw DO stub. */
    stream: {
      append: (...e: StreamEventInput[]) => own().append(...e),
      read: (after?: number, limit?: number) => own().read(after, limit),
      /** The facets that reduce THIS stream's log — THIN SUGAR over `itx.facets.get(ref)` (a
       *  processor is a facet driven by the stream's commits). Address one by name to read its
       *  reduce (`itx.stream.processors.get('tally').snapshot()`) or materialize a loaded class. */
      processors: {
        get: (ref: string | { source: unknown; className: string }) => deps.facets.get(ref),
      },
    },
    /** Navigate to a SIBLING context, ROUTED: `cd('/x').anything(...)` resolves through the
     *  SIBLING's own table (its mounts answer, its default route falls through) — a named,
     *  shadowable whole-context capability. append/read skip the facet hop (the physical fast
     *  path — the log door needs no routing). Codec-named, so only THIS project is reachable. */
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
    facets: deps.facets,
    workers,
    /** Run a STATELESS lambda — a string like `"async (itx, ...args) => …"` (same as apps/os). It
     *  is wrapped in a WorkerEntrypoint whose `run()` injects `itx`, then run with `...args`. To run
     *  code loaded from a source (kv, a repo, inline files), use `workers.get({ source }).run(...)`. */
    runScript: (script: string, ...args: unknown[]) =>
      statelessHandle({ type: "inline", files: { "cap.js": `export default ${script};` } }).run(
        ...args,
      ),
  };
  if (Object.hasOwn(scope, "itx")) throw new Error("host scope must never register 'itx'");
  return scope;
}
