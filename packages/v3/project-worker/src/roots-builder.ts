// roots-builder.ts — ONE place Roots are assembled, for EITHER host of the iterate-context
// processor: the Stream DO (same-isolate closures) or the built-in ProcessorFacet (which reaches
// the parent BY NAME per call — sockets live on the parent forever, so its clients view is thin
// RPC wrappers over the parent's stub facade). What varies between hosts is injected (`invoke`,
// `context`, `clients`); what doesn't — the workers view, the file reader, the binding gate — is
// built here from the shared worker env (a built-in facet inherits the WORKER's env, so both
// hosts see the same bindings).

import { CODE_CAP_RUNNER, confinedWorker } from "./core/agent-runtime.ts";
import { itxEntrypointFor } from "./iterate-context-entrypoint.ts";
import { pathProxy, toExpression, type Expression } from "./core/expression.ts";
import { hashSource } from "./core/hash.ts";
import { Roots, type ClientsView, type FacetsView, type WorkersView } from "./core/roots.ts";
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

/** Assemble the Roots for one context. Every getter closes over the context's identity — the
 *  pre-scoped-not-policed rule (core/roots.ts) is enforced here, at construction. */
export function buildRoots(deps: BuildRootsDeps): Roots {
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
    facets: deps.facets,
    workers,
    readFile: (p) => {
      const content = HELLO_FILES[p];
      if (content == null) throw new Error(`roots.files: no file "${p}"`);
      return { "cap.js": content };
    },
  });
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
    get: (key) => pathProxy((segments, args) => parent().stubInvoke(key, segments, args)),
    at: (path) => ({ call: (method, args) => parent().stubFanOut(path, method, args) }),
    list: () => parent().stubList(),
    connections: (path) => parent().stubConnections(path),
    close: (key) => parent().stubClose(key),
  };
}
