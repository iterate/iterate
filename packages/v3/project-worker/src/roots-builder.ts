// roots-builder.ts — THE HOST SCOPE: a plain record whose KEYS are the expression roots that
// exist ONLY for config-provenance targets (the provenance gate is a scope-KEY-SET decision —
// seeds resolve against { ...hostScope, itx }, event mounts against { itx } alone; nothing is
// policed, the keys are simply absent). There is no Roots object anymore: the RpcTarget shell
// was vestigial since increment 28 (it never crossed a hop; the tests faked it with literals),
// and deleting the object deleted its naming debate. Seed targets now read `kv`, `stream`,
// `contexts.get('/x')`, `bindings.get('FALLBACK')` — the vocabulary, unbundled.

import { CODE_CAP_RUNNER, confinedWorker } from "./core/agent-runtime.ts";
import { itxEntrypointFor } from "./iterate-context-entrypoint.ts";
import { pathProxy, toExpression, type Expression } from "./core/expression.ts";
import { hashSource } from "./core/hash.ts";

/** The parked-stub registry view (clients + live capabilities — one registry). */
export type ClientsView = {
  /** Single-target: a method proxy over one parked stub (wake → leg → invoke). Deep dots walk. */
  get(key: string): unknown;
  /** Fan-out over every connection at a client path (allSettled; dead connections drop out). */
  at(path: string): { call(method: string[], args: unknown[]): Promise<unknown[]> };
  /** Promise-valued when the view is RPC-backed (the facet host) — evaluation awaits every step. */
  list(): unknown[] | Promise<unknown[]>;
  connections(path: string): unknown[] | Promise<unknown[]>;
  close(key: string): { ok: true } | Promise<{ ok: true }>;
};

/** `facets.get(slug)` → a dotted method proxy over ONE enabled facet — ANY method its durable
 *  object exposes (facet stubs are non-transferable, so the walk happens parent-side). */
export type FacetsView = {
  get(slug: string): unknown;
};

/** Run code in this context — THE fundamental context operation. `className` present = host
 *  that exported class durably; absent = run the default export in a fresh confined isolate. */
export type WorkersView = {
  get(ref: { source: unknown; className?: string; type?: string }): unknown;
};
import { HELLO_FILES } from "./hello-files.ts";
import type { StatefulWorkerDurableObject } from "./stateful-worker-durable-object.ts";
import type { StreamDurableObject } from "./stream-durable-object.ts";

/** The bindings roots-building needs — present in BOTH hosts (the worker env). */
export interface RootsEnv {
  CONTEXT: DurableObjectNamespace<StreamDurableObject>;
  STATEFUL_WORKER: DurableObjectNamespace<StatefulWorkerDurableObject>;
  LOADER: WorkerLoader;
  ITX_KV?: KVNamespace;
  SECRETS_KV?: KVNamespace;
  /** Deploy identity — folded into loader cacheKeys so a redeploy mints fresh isolates. */
  CF_VERSION_METADATA?: { id: string };
  /** The shell this context's egress + `itx.os` bottom out at (a whole control plane). */
  FALLBACK: Fetcher & { invokeCapability(callPath: string, args?: unknown[]): Promise<unknown> };
}

/** What the hosting side injects: identity, bindings, and the three host-specific seams. */
export interface BuildRootsDeps {
  projectId: string;
  path: string;
  /** The codec name of the context these roots belong to (loader cache keys, self-stubs). */
  contextName: string;
  env: RootsEnv;
  /** Resolve one call through THIS context's dispatch (dynamic-worker module loading). */
  invoke: (call: Expression) => Promise<unknown>;
  /** A context stream by path — same-isolate closures for the own path parent-side; by-name
   *  stubs facet-side (the parent IS the own stream). */
  context: (path: string) => {
    append(...e: unknown[]): unknown;
    read(after?: number, limit?: number): unknown;
  };
  /** The parked-stub registry view (host-specific: in-DO closures or the parent facade). */
  clients: ClientsView;
  facets: FacetsView;
  /** The ctx whose `exports` mints the IterateContextEntrypoint loopback (the loaded-worker
   *  host — see iterate-context-entrypoint.ts for why it is never a raw getByName stub). */
  hostCtx: unknown;
}

/** Assemble the host scope for one context. Every entry closes over the context's identity —
 *  PRE-SCOPED, not policed: cross-project access is unspellable by construction. The builder
 *  must never register `itx` (asserted below — the resolver's recursion symbol always wins). */
export function buildHostScope(deps: BuildRootsDeps): Record<string, unknown> {
  const { projectId, path, contextName, env } = deps;

  const loadModules = async (source: Expression): Promise<Record<string, string>> =>
    (await deps.invoke(source)) as Record<string, string>;

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
      // Durable class: a method proxy onto the dedicated runner DO (deep dots ride the wire
      // joined, the runner walks segments). A top-level `.fetch` forwards natively (101s pass).
      const runner = env.STATEFUL_WORKER.getByName(
        `${projectId}::${path}::${className}:${hashSource(JSON.stringify(source))}`,
      );
      return pathProxy((segments, args) => {
        if (segments.length === 1 && segments[0] === "fetch") {
          const request = args[0] as Request;
          const headers = new Headers(request.headers);
          headers.set("x-itx-source", JSON.stringify(source));
          headers.set("x-itx-class", className);
          return runner.fetch(new Request(request, { headers }));
        }
        return runner.invokeCapability({ source, className, method: segments.join("."), args });
      });
    },
  };

  const { itxKv, secretsKv } = { itxKv: env.ITX_KV, secretsKv: env.SECRETS_KV };
  const kvPrefix = `${projectId}:`;
  const repoPrefix = `${projectId}:repo:`;
  const own = () => deps.context(path);

  const scope: Record<string, unknown> = {
    whoami: () => ({ projectId, path }),
    /** Project-prefixed KV — the raw namespace is shared; the prefix is the isolation. */
    kv: {
      get: (k: string) => {
        if (!itxKv) throw new Error("kv: no ITX_KV bound");
        return itxKv.get(kvPrefix + k);
      },
      put: async (k: string, v: string) => {
        if (!itxKv) throw new Error("kv: no ITX_KV bound");
        await itxKv.put(kvPrefix + k, String(v));
        return { ok: true };
      },
      delete: async (k: string) => {
        if (!itxKv) throw new Error("kv: no ITX_KV bound");
        await itxKv.delete(kvPrefix + k);
        return { ok: true };
      },
      list: async (start = "") => {
        if (!itxKv) throw new Error("kv: no ITX_KV bound");
        return {
          keys: (await itxKv.list({ prefix: kvPrefix + start })).keys.map((x) =>
            x.name.slice(kvPrefix.length),
          ),
        };
      },
    },
    /** The project's file store (`repo:`-prefixed kv view) — where the config worker lives. */
    repo: {
      get: (k: string) => {
        if (!itxKv) throw new Error("repo: no ITX_KV bound");
        return itxKv.get(repoPrefix + k);
      },
      put: async (k: string, v: string) => {
        if (!itxKv) throw new Error("repo: no ITX_KV bound");
        await itxKv.put(repoPrefix + k, String(v));
        return { ok: true };
      },
      list: async () => {
        if (!itxKv) throw new Error("repo: no ITX_KV bound");
        return {
          files: (await itxKv.list({ prefix: repoPrefix })).keys.map((x) =>
            x.name.slice(repoPrefix.length),
          ),
        };
      },
    },
    /** Write-only secret store. Values come back out ONLY as `{{secret:NAME}}` substitution at
     *  the egress terminal — never through a read here. */
    secrets: {
      set: async (name: string, value: string) => {
        if (!secretsKv) throw new Error("secrets: no SECRETS_KV bound");
        await secretsKv.put(`secret:${projectId}:${name}`, String(value));
        return { ok: true };
      },
    },
    /** MY OWN stream — a deliberate, chosen surface (append/read), never the raw DO stub. */
    stream: {
      append: (...e: unknown[]) => own().append(...e),
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
    clients: deps.clients,
    facets: deps.facets,
    workers,
    /** The file store the source expressions read: demo files first, then THE REPO — put real
     *  source with `itx.repo.put('/my.js', src)` and run it with
     *  `itx.workers.get({ source: "itx.files.read('/my.js')" })`. (The smallest possible repo;
     *  the apps/os repo DO grows from this seam.) */
    files: {
      read: async (p: string) => {
        const content = HELLO_FILES[p] ?? (itxKv ? await itxKv.get(repoPrefix + p) : null);
        if (content == null) throw new Error(`files: no file "${p}"`);
        return { "cap.js": content };
      },
    },
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

/** The facet address as the resolver sees it: `facets.get(slug).anyMethod(...)` rides ONE
 *  generic parent door (`facetInvoke`) — the walk stays parent-side because facet stubs are
 *  non-transferable. Same thin-wrapper shape as the clients view. */
export function facetAddressView(parent: () => DurableObjectStub<StreamDurableObject>): FacetsView {
  return {
    get: (slug) => pathProxy((segments, args) => parent().facetInvoke(slug, segments, args)),
  };
}

/** The clients view as the FACET sees it: thin RPC wrappers over the parent's stub facade
 *  (stubInvoke/stubFanOut/stubList/stubConnections/stubClose). The parent is resolved BY NAME
 *  per call — never a retained stub (the back-channel rule). Promise-valued reads are fine:
 *  expression evaluation awaits every step. */
export function facetClientsView(
  parent: () => DurableObjectStub<StreamDurableObject>,
): ClientsView {
  return {
    get: (key) =>
      pathProxy((segments, args) => parent().stubInvoke(key, segments, args), {
        allowRootCall: true,
      }),
    at: (path) => ({ call: (method, args) => parent().stubFanOut(path, method, args) }),
    list: () => parent().stubList(),
    connections: (path) => parent().stubConnections(path),
    close: (key) => parent().stubClose(key),
  };
}
