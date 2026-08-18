// roots-builder.ts — ONE place Roots are assembled, for EITHER host of the iterate-context
// processor: the Stream DO (same-isolate closures) or the built-in ProcessorFacet (which reaches
// the parent BY NAME per call — sockets live on the parent forever, so its clients view is thin
// RPC wrappers over the parent's stub facade). What varies between hosts is injected (`invoke`,
// `context`, `clients`); what doesn't — the workers view, the file reader, the binding gate — is
// built here from the shared worker env (a built-in facet inherits the WORKER's env, so both
// hosts see the same bindings).

import { CODE_CAP_RUNNER, ITX_SURFACE_MODULE } from "./core/agent-runtime.ts";
import { toExpression, type Expression } from "./core/expression.ts";
import { hashSource } from "./core/hash.ts";
import { Roots, type ClientsView, type WorkersView } from "./core/roots.ts";
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
}

/** Assemble the Roots for one context. Every getter closes over the context's identity — the
 *  pre-scoped-not-policed rule (core/roots.ts) is enforced here, at construction. */
export function buildRoots(deps: BuildRootsDeps): Roots {
  const { projectId, path, contextName, env } = deps;

  const loadModules = async (source: Expression): Promise<Record<string, string>> =>
    (await deps.invoke(source)) as Record<string, string>;

  /** Load a confined dynamic worker: `itx.js` injected, env.ITX = globalOutbound = a self-stub. */
  const loaderWorker = (cacheKey: string, mainModule: string, modules: Record<string, string>) => {
    const self = env.CONTEXT.getByName(contextName);
    return env.LOADER.get(cacheKey, () => ({
      compatibilityDate: "2026-07-01",
      mainModule,
      modules: { "itx.js": ITX_SURFACE_MODULE, ...modules },
      env: { ITX: self },
      globalOutbound: self,
    }));
  };

  /** `roots.workers.get({type, source, className?})` — run code in this context.
   *  stateless → a loader isolate: `{ run(...args), fetch(request) }`;
   *  stateful  → the runner DO's facet: any (deep dotted) method + fetch. */
  const workers: WorkersView = {
    get: (ref) => {
      const source = toExpression(ref.source as string | Expression);
      if (ref.type === "stateless") {
        return {
          run: async (...args: unknown[]) => {
            const modules = await loadModules(source);
            const v = env.CF_VERSION_METADATA?.id ?? "unversioned";
            const worker = loaderWorker(
              `code:${v}:${contextName}:${hashSource(JSON.stringify(modules))}`,
              "run.js",
              { "run.js": CODE_CAP_RUNNER, ...modules },
            );
            const resp = await worker.getEntrypoint().fetch(
              new Request("https://code.local/", {
                method: "POST",
                body: JSON.stringify(args),
              }),
            );
            return ((await resp.json()) as { result: unknown }).result;
          },
          fetch: async (request: Request) => {
            const modules = await loadModules(source);
            const v = env.CF_VERSION_METADATA?.id ?? "unversioned";
            const worker = loaderWorker(
              `code-fetch:${v}:${contextName}:${hashSource(JSON.stringify(modules))}`,
              "cap.js",
              modules,
            );
            return worker.getEntrypoint().fetch(request);
          },
        };
      }
      // stateful: a method proxy onto the dedicated runner DO (deep dots ride the wire joined,
      // the runner walks segments). fetch forwards natively so a 101 passes through.
      const className = ref.className;
      if (!className) throw new Error("workers.get: stateful ref needs a className");
      const runner = env.STATEFUL_WORKER.getByName(
        `${projectId}::${path}::${className}:${hashSource(JSON.stringify(source))}`,
      );
      const proxyFor = (segments: string[]): unknown =>
        new Proxy(function () {} as object, {
          get: (_t, p) => {
            if (p === "then" || typeof p === "symbol") return undefined;
            if (p === "fetch" && segments.length === 0)
              return (request: Request) => {
                const headers = new Headers(request.headers);
                headers.set("x-itx-source", JSON.stringify(source));
                headers.set("x-itx-class", className);
                return runner.fetch(new Request(request, { headers }));
              };
            return proxyFor([...segments, p as string]);
          },
          apply: (_t, _this, args) =>
            runner.invokeCapability({
              source,
              className,
              method: segments.join("."),
              args: args as unknown[],
            }),
        });
      return proxyFor([]);
    },
  };

  return new Roots({
    projectId,
    path,
    itxKv: env.ITX_KV,
    secretsKv: env.SECRETS_KV,
    binding: (name) => {
      if (name !== "FALLBACK") throw new Error(`roots.binding: no binding "${name}"`);
      return env.FALLBACK;
    },
    context: deps.context,
    clients: deps.clients,
    workers,
    readFile: (p) => {
      const content = HELLO_FILES[p];
      if (content == null) throw new Error(`roots.files: no file "${p}"`);
      return { "cap.js": content };
    },
  });
}

/** The clients view as the FACET sees it: thin RPC wrappers over the parent's stub facade
 *  (stubInvoke/stubFanOut/stubList/stubConnections/stubClose). The parent is resolved BY NAME
 *  per call — never a retained stub (the back-channel rule). Promise-valued reads are fine:
 *  expression evaluation awaits every step. */
export function facetClientsView(
  parent: () => DurableObjectStub<StreamDurableObject>,
): ClientsView {
  const proxyFor = (key: string, segments: string[]): unknown =>
    new Proxy(function () {} as object, {
      get: (_t, p) =>
        p === "then" || typeof p === "symbol"
          ? undefined
          : proxyFor(key, [...segments, p as string]),
      apply: (_t, _this, args) => parent().stubInvoke(key, segments, args as unknown[]),
    });
  return {
    get: (key) => proxyFor(key, []),
    at: (path) => ({ call: (method, args) => parent().stubFanOut(path, method, args) }),
    list: () => parent().stubList(),
    connections: (path) => parent().stubConnections(path),
    close: (key) => parent().stubClose(key),
  };
}
