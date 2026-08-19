// built-ins.ts — THE BUILT-INS: a plain record whose KEYS are the expression roots that exist
// ONLY for config-provenance targets (the provenance gate is a scope-KEY-SET decision — config
// mounts resolve against { ...builtIns, itx }, event mounts against { itx } alone; nothing is
// policed, the keys are simply absent). Config-mount targets read `kv`, `stream`,
// `contexts.get('/x')`, `bindings.get('FALLBACK')` — the vocabulary, unbundled.

import { asModules, CODE_CAP_RUNNER, confinedWorker } from "./core/agent-runtime.ts";
import { itxEntrypointFor } from "./itx-entrypoint.ts";
import { pathProxy, toExpression, type Expression } from "./core/expression.ts";
import { hashSource } from "./core/hash.ts";

/** The `connections` view every context has: the ItxConnectionRegistry, surfaced. One entry per
 *  attached ItxConnection (client callbacks and parked live capabilities — one registry). */
type ConnectionsView = {
  /** One connection by connectionKey or connectionId: a method proxy over its retained callback
   *  (wake → RetainedCallbackInvoker leg → invoke). Deep dots walk; throws when offline. */
  get(key: string): unknown;
  /** Fan out one (dotted) method call over EVERY connection attached to this context
   *  (allSettled; a dead connection drops out of the results). */
  each(method: string, ...args: unknown[]): Promise<unknown[]>;
  /** The currently connected clients of this context. */
  list(): unknown[] | Promise<unknown[]>;
  /** Close a connection's stub pager WebSocket (idempotent — unknown keys are a no-op). */
  close(key: string): { ok: true } | Promise<{ ok: true }>;
};

/** `facets.get(slug)` → a dotted method proxy over ONE enabled facet — ANY method its durable
 *  object exposes (facet stubs are non-transferable, so the walk happens parent-side). */
type FacetsView = {
  get(slug: string): unknown;
};

/** Run code in this context — THE fundamental context operation. `className` present = host
 *  that exported class durably; absent = run the default export in a fresh confined isolate. */
type WorkersView = {
  get(ref: { source: unknown; className?: string; type?: string }): unknown;
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
  /** A context stream by path — same-isolate closures for the own path parent-side; by-name
   *  stubs facet-side (the parent IS the own stream). */
  context: (path: string) => {
    append(...e: unknown[]): unknown;
    read(after?: number, limit?: number): unknown;
  };
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

  const loadModules = async (source: Expression): Promise<Record<string, string>> =>
    asModules(await deps.invoke(source), "workers.get");

  /** RUN CODE IN THIS CONTEXT — the fundamental context operation (owner: "one of the key,
   *  key, key APIs"). `workers.get({source, className?})`: `className` present → the class is
   *  hosted DURABLY (a facet of the runner DO, any deep dotted method + fetch); absent → run
   *  the default export in a fresh confined isolate (`run(...args)` — a real RPC method, so
   *  callbacks/Dates/bytes ride natively — plus `fetch` when the source serves one). ONE
   *  isolate and ONE billed loader identity per source either way. The isolate's whole world
   *  is the interposition entrypoint, never a raw DO stub (iterate-context-entrypoint.ts). */
  const workers: WorkersView = {
    get: (ref) => {
      const source = toExpression(ref.source as string | Expression);
      const className = ref.className;
      if (!className) {
        const worker = async () => {
          const modules = await loadModules(source);
          return confinedWorker(
            env,
            { kind: "code", owner: contextName, contentHash: hashSource(JSON.stringify(modules)) },
            "run.js",
            { "run.js": CODE_CAP_RUNNER, ...modules },
            itxEntrypointFor(deps.hostCtx, contextName),
          );
        };
        return {
          run: async (...args: unknown[]) =>
            (
              (await worker()).getEntrypoint() as unknown as {
                run(...a: unknown[]): Promise<unknown>;
              }
            ).run(...args),
          fetch: async (request: Request) => (await worker()).getEntrypoint().fetch(request),
        };
      }
      // Durable class: a FACET of this stream — a method proxy that walks deep dots natively;
      // a top-level `.fetch` forwards to the facet's own fetch (101s pass, no header protocol).
      return pathProxy((segments, args) => {
        if (segments.length === 1 && segments[0] === "fetch")
          return deps.statefulWorkers.fetch({ source, className }, args[0] as Request);
        return deps.statefulWorkers.invoke({ source, className }, segments, args);
      });
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
      keys: async (start = "") =>
        (await kv().list({ prefix: prefix + start })).keys.map((x) => x.name.slice(prefix.length)),
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
    /** MY OWN stream — a deliberate, chosen surface (append/read), never the raw DO stub.
     *  The append door FENCES platform-reserved idempotencyKey namespaces: a public writer must
     *  not be able to squat `capability-table/revoke:<n>` and make a later revoke conflict —
     *  which would leave the capability unrevocable forever (the apps/os internal-key fence). */
    stream: {
      append: (...events: unknown[]) => {
        for (const e of events) {
          const key = (e as { idempotencyKey?: unknown }).idempotencyKey;
          if (typeof key === "string" && key.startsWith("capability-table/"))
            throw new Error(
              `idempotencyKey ${JSON.stringify(key)} is in a platform-reserved namespace`,
            );
        }
        return own().append(...events);
      },
      read: (after?: number, limit?: number) => own().read(after, limit),
    },
    /** Sibling contexts, ROUTED: `contexts.get('/x').anything(...)` resolves through the
     *  SIBLING's own table (its mounts answer, its default route falls through) — a named,
     *  shadowable whole-context capability. append/read skip the facet hop (the physical fast
     *  path — the log door needs no routing). Codec-named, so only THIS project is reachable. */
    contexts: {
      get: (siblingPath: string) =>
        pathProxy((segments, args) => {
          const sibling = deps.context(siblingPath) as unknown as {
            append(...e: unknown[]): unknown;
            read(a?: number, l?: number): unknown;
            invoke(call: unknown): Promise<unknown>;
          };
          if (segments.length === 1 && (segments[0] === "append" || segments[0] === "read"))
            return segments[0] === "append"
              ? sibling.append(...args)
              : sibling.read(...(args as [number?, number?]));
          const last = segments[segments.length - 1] as string;
          return sibling.invoke(["itx", ...segments.slice(0, -1), [last, ...args]]);
        }),
    },
    connections: deps.connections,
    facets: deps.facets,
    workers,
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
