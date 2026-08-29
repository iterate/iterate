// built-ins.ts — THE BUILT-INS: a plain record whose KEYS are the expression roots that exist
// ONLY for config-provenance targets (the provenance gate is a scope-KEY-SET decision — config
// mounts resolve against { ...builtIns, itx }, event mounts against { itx } alone; nothing is
// policed, the keys are simply absent). Config-mount targets read `kv`, `stream`,
// `cd('/x')`, `bindings.get('FALLBACK')` — the vocabulary, unbundled.

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

/** The `connections` view every context has: the ItxConnectionRegistry, surfaced. One entry per
 *  attached ItxConnection (client callbacks and parked live capabilities — one registry). */
type ConnectionsView = {
  /** One connection by connectionKey or connectionId: a method proxy over its retained callback
   *  (wake → RetainedCallbackInvoker leg → invoke). Deep dots walk; throws when offline. */
  get(key: string): unknown;
  /** The currently connected clients of this context. Fan-out is `list()` + map over `get(key)`
   *  (no built-in `each` — the caller owns the allSettled over live members). */
  list(): unknown[] | Promise<unknown[]>;
  /** Close a connection's stub pager WebSocket (idempotent — unknown keys are a no-op). */
  close(key: string): { ok: true } | Promise<{ ok: true }>;
};

/** `facets.get(slug)` → a dotted method proxy over ONE enabled facet — ANY method its durable
 *  object exposes (facet stubs are non-transferable, so the walk happens parent-side). */
type FacetsView = {
  get(slug: string): unknown;
};

/** Run code in this context — THE fundamental context operation, mirroring apps/os
 *  `DynamicWorkerRef`. `get` takes a discriminated ref: `type:"stateless"` → a fresh confined
 *  isolate, a `{ run, fetch }` handle (no DO, no storage); `type:"stateful"` → the exported
 *  `className` hosted DURABLY as a facet of this stream (a deep dotted method proxy + `.fetch`).
 *  Scope-level `runScript(source, ...)` is one-hop sugar for `get({ type:"stateless", source }).run(...)`. */
type WorkersView = {
  get(
    ref:
      | { type: "stateless"; source: unknown; props?: Record<string, unknown> }
      | { type: "stateful"; source: unknown; className: string },
  ): unknown;
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
  /** The connections view (parent-local closures over the HibernatableRpcStubManager). */
  connections: ConnectionsView;
  facets: FacetsView;
  /** Host a stateful loaded class as a FACET of this stream (the dedicated runner DO died in
   *  increment 57 — accepted trade: a busy stateful worker pins its stream). */
  statefulWorkers: {
    invoke(
      ref: { source: Expression; className: string },
      segments: string[],
      args: unknown[],
    ): Promise<unknown>;
    fetch(ref: { source: Expression; className: string }, request: Request): Promise<Response>;
  };
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
   *  `resolveSource` path. `props` (apps/os parity) seed the entrypoint's `ctx.props`. */
  const statelessHandle = (source: WorkerSource, props?: Record<string, unknown>) => {
    const entrypoint = async () => {
      const modules = await resolveSource(deps.invoke, source, "workers.get");
      const worker = confinedWorker(
        env,
        { kind: "code", owner: contextName, contentHash: hashSource(JSON.stringify(modules)) },
        "run.js",
        { "run.js": CODE_CAP_RUNNER, "processor.js": PROCESSOR_SDK_MODULE, ...modules },
        itxEntrypointFor(deps.hostCtx, contextName),
      );
      return (props !== undefined
        ? worker.getEntrypoint(undefined, { props })
        : worker.getEntrypoint()) as unknown as {
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
    get: (ref) => {
      if (ref.type === "stateful") {
        // Durable class: a FACET of this stream — a method proxy that walks deep dots natively;
        // a top-level `.fetch` forwards to the facet's own fetch (101s pass, no header protocol).
        const source = toExpression(ref.source as string | Expression);
        const className = ref.className;
        // A GENUINE RpcTarget (not a bare pathProxy) so a mid-chain call on a stateful loaded
        // class pipelines — `itx.workers.get(ref).demo.timer.callLater(cb)` from one dynamic
        // worker to another rides one round trip (workerd#6873; see core/invoke-handle.ts).
        return new InvokeHandle((segments, args) => {
          if (segments.length === 1 && segments[0] === "fetch")
            return deps.statefulWorkers.fetch({ source, className }, args[0] as Request);
          return deps.statefulWorkers.invoke({ source, className }, segments, args);
        });
      }
      return statelessHandle(ref.source as WorkerSource, ref.props);
    },
  };

  const { itxKv, secretsKv } = { itxKv: env.ITX_KV, secretsKv: env.SECRETS_KV };
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
    /** Write-only secret store. Values come back out ONLY as `{{secret:NAME}}` substitution at
     *  the egress terminal — never through a read here. */
    secrets: {
      set: async (name: string, value: string) => {
        if (!secretsKv) throw new Error("secrets: no SECRETS_KV bound");
        // The name feeds `secret:${projectId}:${name}` AND is read back only through the egress
        // token grammar — a ":" is both a cross-project write primitive and an unreadable value.
        if (!/^[A-Za-z0-9._-]+$/.test(name))
          throw new Error(`invalid secret name ${JSON.stringify(name)}: only [A-Za-z0-9._-]`);
        await secretsKv.put(`secret:${projectId}:${name}`, String(value));
        return { ok: true };
      },
    },
    /** MY OWN stream — a deliberate, chosen surface (append/read), never the raw DO stub. */
    stream: {
      append: (...e: StreamEventInput[]) => own().append(...e),
      read: (after?: number, limit?: number) => own().read(after, limit),
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
    connections: deps.connections,
    facets: deps.facets,
    workers,
    /** Run stateless code in this context — sugar for `workers.get({type:'stateless',source}).run(…)`. */
    runScript: (source: unknown, ...args: unknown[]) =>
      statelessHandle(source as WorkerSource).run(...args),
    /** The forker door: any wrangler service binding, referenced by name from a config seed. */
    bindings: {
      get: (name: string) => {
        if (name !== "FALLBACK") throw new Error(`bindings.get: no binding "${name}"`);
        return env.FALLBACK;
      },
    },
  };
  if (Object.hasOwn(scope, "itx")) throw new Error("host scope must never register 'itx'");
  return scope;
}
