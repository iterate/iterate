// The dial: the ONE effectful function injected into the itx core — it owns
// REACH (which bindings/loopbacks/namespaces are dialable, gated at dial
// time = first invoke) while the core owns structure. Allowlist
// (reachability) errors surface HERE — at the capability's first call —
// never at provide time (provide is structural only, itx.ts).

import {
  disposeIfPossible,
  type CapabilityDial,
  type PathCallable,
  type WorkerSource,
} from "./itx.ts";
import { replayPathCall } from "./path-proxy.ts";
import { wireIsolateEnv } from "./isolate.ts";
import { resolveWorkerSource, type SourceBuildEnv } from "./source-build.ts";
import { formatDurableObjectName } from "~/domains/durable-object-names.ts";

/** The Worker Loader binding as every itx load site uses it — the dial here
 * and the project worker's non-dial loaders (project-worker-runtime.ts). */
export type WorkerLoaderBinding = {
  get(
    id: string,
    getCode: () => {
      compatibilityDate: string;
      compatibilityFlags: string[];
      env?: Record<string, unknown>;
      globalOutbound?: unknown;
      mainModule: string;
      modules: Record<string, unknown>;
    },
  ): {
    getEntrypoint(name?: string, options?: { props?: Record<string, unknown> }): unknown;
    getDurableObjectClass?(name?: string): unknown;
  };
};

export type DialHost = {
  /** The hosting context's ref — stateful (facet) capabilities key their
   * private storage by it: a cap's data belongs to the context it was
   * provided on. */
  contextRef: string;
  /** The hosting context's own address — facet isolates (host-scoped) get it
   * as their dial-back coordinate. */
  contextAddress: import("./itx.ts").CapabilityAddress;
  /** The owning project — {capabilityPath, context, projectId} prop
   * injection (spoof-proofing: a provider can never point a dialable
   * loopback at someone else's project) and itx:<projectId>:<name> DO
   * scoping. */
  projectId: string;
  /** Env bindings for `{ type: "binding" }` and `{ type: "durable-object" }`
   * refs; gated on the allowlists before any lookup. */
  env: unknown;
  /** The hosting worker's loopback exports (ctx.exports). */
  exports: Record<string, (options: { props: Record<string, unknown> }) => unknown>;
  /** Worker Loader for source-ref caps; absent in environments without it. */
  loader?: WorkerLoaderBinding;
  /** Durable Object facet instantiation (durableObjectFacetsHook). */
  facets?: (
    name: string,
    getClass: () => { class: unknown } | Promise<{ class: unknown }>,
  ) => unknown;
  /** Hardcoded defaults ∪ deployment config (resolveDialableTargets). */
  allowlists: DialableTargets;
};

export function makeDial(host: DialHost): CapabilityDial {
  const loopback = (exportName: string, props: Record<string, unknown>): unknown => {
    const factory = host.exports[exportName];
    if (typeof factory !== "function") {
      throw new Error(`Loopback export ${exportName} is not available.`);
    }
    return factory({ props });
  };

  const loadWorker = async (
    name: string,
    origin: { ref: string; address: unknown },
    source: WorkerSource,
  ) => {
    if (!host.loader) throw new Error("Source capabilities need a LOADER binding.");
    // Inline sources are already code; repo sources resolve through the
    // per-commit R2 build memo (source-build.ts) — a warm key never builds.
    const resolved = await resolveWorkerSource({
      env: host.env as SourceBuildEnv,
      projectId: host.projectId,
      source,
    });
    // The isolate is scoped to the ORIGINATING context, not the definition's
    // home: an inherited source cap invoked through a child context gets the
    // child's itx AND the child's egress, so its bare fetch() dials back
    // through the child's chain (and any `fetch` shadow there) — the
    // origin-dial-back property. The cache key carries the origin so two
    // contexts never share a differently-scoped isolate.
    return host.loader.get(sourceIsolateKey({ cacheKey: resolved.cacheKey, name, origin }), () =>
      wireIsolateEnv({
        capabilityPath: name,
        code: resolved,
        contextRef: origin.ref,
        loopback: (exportName, options) => loopback(exportName, options.props),
      }),
    );
  };

  return (address, attribution): PathCallable => {
    const name = attribution.capabilityPath;
    // Attribution wins over provider-supplied props, by spread order.
    // `context` is the ORIGINATING context (chain delegation carries it) —
    // pure attribution for records and policy.
    const injected = {
      capabilityPath: name,
      context: attribution.origin.ref,
      projectId: host.projectId,
    };

    const worker = address.worker;
    switch (worker.type) {
      case "binding": {
        if (!host.allowlists.bindings.has(worker.binding)) {
          throw new Error(`Capability "${name}": binding "${worker.binding}" is not dialable.`);
        }
        const binding = (host.env as Record<string, unknown>)[worker.binding];
        if (binding == null) {
          throw new Error(
            `Capability "${name}": binding "${worker.binding}" is not available on this host.`,
          );
        }
        // The binding is a concrete env object that doesn't speak the calling
        // convention — wrap it here, where it is real. Env bindings are
        // long-lived host objects, never per-call borrows: no dispose.
        return inProcessPathCallable(binding, { capability: name });
      }
      case "loopback": {
        // First-party loopback entrypoints all implement call({ path, args })
        // themselves — member-shaped ones self-replay via replayPathCall.
        if (!address.entrypoint || !host.allowlists.loopbacks.has(address.entrypoint)) {
          throw new Error(
            `Capability "${name}": loopback export "${address.entrypoint}" is not dialable.`,
          );
        }
        return loopback(address.entrypoint, { ...address.props, ...injected }) as PathCallable;
      }
      case "source": {
        // Loader entrypoints and facet stubs are this dial's OWN borrows —
        // the user's class just exports methods, so the wrap (and the members
        // replay inside it) lives here. The wrapper's dispose releases the
        // INNER borrow when the core's call ends. Loading is lazy-async
        // because repo sources may build on a cold key; the loader callbacks
        // accept promises, so the dial itself stays synchronous.
        const source = worker.source;
        if (source.exportType === "durable-object") {
          const facets = host.facets;
          if (!facets) {
            throw new Error("Durable-object caps need a Durable-Object host with ctx.facets.");
          }
          // Facet name deliberately excludes the cache key: the facet's
          // private SQLite survives code upgrades (new source, same data) —
          // the same property Cloudflare's AppRunner example relies on. It
          // also keys by the HOST context, not the origin: a stateful cap's
          // data belongs to the context it was provided on.
          // Asymmetry vs the stateless path: a "latest"-commit source here
          // resolves at facet START and stays on that build until the DO is
          // evicted; the worker-entrypoint path below re-resolves per dial
          // (≤10s staleness via the latest-probe window).
          const facetTarget = facets(`cap:${name}`, async () => {
            const worker = await loadWorker(
              name,
              { address: host.contextAddress, ref: host.contextRef },
              source,
            );
            const facetClass = worker.getDurableObjectClass?.(source.entrypoint);
            if (!facetClass) {
              throw new Error(
                `Capability "${name}" did not yield a DurableObject class ` +
                  `(durable-object caps must export one, and the runtime must support getDurableObjectClass).`,
              );
            }
            return { class: facetClass };
          });
          return inProcessPathCallable(facetTarget, {
            capability: name,
            dispose: () => disposeIfPossible(facetTarget),
          });
        }
        const entrypoint = loadWorker(name, attribution.origin, source).then((worker) =>
          worker.getEntrypoint(source.entrypoint),
        );
        // The borrow may be disposed without ever being called; observe the
        // load failure so it cannot become an unhandled rejection (the call
        // path still awaits the original promise and gets the real error).
        entrypoint.catch(() => {});
        const borrowed: PathCallable & Disposable = {
          call: async (input) => replayPathCall(await entrypoint, input, { capability: name }),
          [Symbol.dispose]: () => void entrypoint.then(disposeIfPossible, () => {}),
        };
        return borrowed;
      }
      case "durable-object": {
        if (!host.allowlists.durableObjects.has(worker.binding)) {
          throw new Error(
            `Capability "${name}": Durable Object namespace "${worker.binding}" is not dialable.`,
          );
        }
        const namespace = (host.env as Record<string, unknown>)[worker.binding] as
          | { getByName(name: string): unknown }
          | undefined;
        if (typeof namespace?.getByName !== "function") {
          throw new Error(
            `Capability "${name}": "${worker.binding}" is not a Durable Object namespace on this host.`,
          );
        }
        // Names are scoped under the owning project via the same
        // `{ projectId, path }` durable-object naming convention as domain
        // objects. The stub is remote (never concrete here), so the DO class
        // itself must implement call({ path, args }) and explicitly opt in.
        return namespace.getByName(
          formatDurableObjectName({
            projectId: host.projectId,
            path: itxDurableObjectPath(worker.name),
          }),
        ) as PathCallable;
      }
    }
  };
}

/**
 * The loader cache key for a source capability's isolate. Exported so the
 * non-dial loaders of the project worker (HTTP ingress, root-stream event
 * forwarding) share the SAME warm isolates as `itx.worker` dials.
 */
export function sourceIsolateKey(input: {
  cacheKey: string;
  name: string;
  origin: { ref: string };
}): string {
  return `itx-cap:${input.origin.ref}:${input.name}:${input.cacheKey}`;
}

/** An in-process borrow that speaks the calling convention: replays the path
 * on the concrete object the dial just resolved, and (optionally) disposes
 * the inner borrow when the core finishes the call. Never crosses RPC — the
 * core consumes it in-process, so no RpcTarget wrapper is needed. */
function inProcessPathCallable(
  target: unknown,
  opts?: { capability?: string; dispose?: () => void },
): PathCallable {
  return {
    call: (input) => replayPathCall(target, input, { capability: opts?.capability }),
    ...(opts?.dispose ? { [Symbol.dispose]: opts.dispose } : {}),
  };
}

/**
 * Adapt a Durable Object's `ctx.facets` (open beta) to the dial's hook.
 * Returns the hook even when the runtime lacks facets — the error surfaces
 * at invoke time with a clear message instead of at construction.
 */
export function durableObjectFacetsHook(ctx: DurableObjectState): NonNullable<DialHost["facets"]> {
  return (name, getClass) => {
    const facets = (
      ctx as unknown as {
        facets?: {
          get(
            name: string,
            getClass: () => { class: unknown } | Promise<{ class: unknown }>,
          ): unknown;
        };
      }
    ).facets;
    if (!facets) {
      throw new Error(
        "Durable Object facets are not available in this runtime " +
          "(ctx.facets is missing — facet caps need the Facets beta).",
      );
    }
    return facets.get(name, getClass);
  };
}

// ---- dialable allowlists ------------------------------------------------------

/**
 * Which env bindings / loopback exports an rpc address may dial. Binding and
 * loopback refs reach PLATFORM resources, so an open list would let any
 * project handle reach e.g. the deployment D1, or mint itx handles on
 * arbitrary projects via ItxEntrypoint props. Checked at dial time (= first
 * invoke; provide is structural only). A deployment widens the lists via
 * config (`APP_CONFIG_ITX` → {@link DialableTargets}); the hardcoded
 * defaults always apply.
 */
const DIALABLE_BINDINGS: ReadonlySet<string> = new Set(["AI"]);
/**
 * Loopback entrypoints listed here MUST scope strictly by the dial-time
 * props the dial injects ({ capabilityPath, context, projectId }) — never by
 * provider-supplied props — because anyone with a handle on a context can
 * provide a cap dialing them.
 */
const DIALABLE_LOOPBACKS: ReadonlySet<string> = new Set([
  "AgentCapability",
  // Routes to the agent DO's sendMessage scoped strictly by the dial-injected
  // projectId (props.projectId, always overwritten by the injection), so a
  // provider can never reach another project's agents.
  "AgentsCapability",
  "AgentToolsCapability",
  "BindingCapability",
  "EgressPipe",
  "GmailCapability",
  // Project integrations (OAuth connect/disconnect/status) scoped strictly by
  // the dial-injected projectId; the OAuth callback re-verifies the user.
  "IntegrationsCapability",
  "McpClient",
  // Like McpClient: only provider props (specUrl/baseUrl/headers) + the
  // dial-injected attribution — every fetch rides the originating project's
  // egress, so a handle holder providing it grants nothing beyond HTTP
  // through their own project's pipe.
  "OpenApiClient",
  "ReposCapability",
  // Scopes strictly by the dial-injected projectId (SecretsCapability reads
  // ctx.props.projectId, which the injection spread always overwrites), so a
  // provider can never point it at another project's secrets.
  "SecretsCapability",
  "SlackCapability",
  "StreamsCapability",
  "WorkspaceCapability",
]);

/**
 * Durable Object namespace bindings dialable via `{ type: "durable-object" }`
 * refs. The dial scopes every instance name under the owning project using
 * `/itx/durable-objects/<name>`, so an allowlisted namespace's itx-reachable
 * instances are disjoint per project. Still empty by default: namespaces
 * whose EXISTING instances matter (PROJECT, STREAM, …) must not be
 * allowlisted — itx-created instances would be fresh/empty objects under the
 * scoped name, not the real ones.
 */
const DIALABLE_DURABLE_OBJECTS: ReadonlySet<string> = new Set();

function itxDurableObjectPath(name: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`Durable Object capability name must be one path segment, got "${name}".`);
  }
  return `/itx/durable-objects/${name}`;
}

/** The dial allowlists a host resolves once (defaults ∪ deployment config). */
export type DialableTargets = {
  bindings: ReadonlySet<string>;
  durableObjects: ReadonlySet<string>;
  loopbacks: ReadonlySet<string>;
};

const DEFAULT_DIALABLE_TARGETS: DialableTargets = {
  bindings: DIALABLE_BINDINGS,
  durableObjects: DIALABLE_DURABLE_OBJECTS,
  loopbacks: DIALABLE_LOOPBACKS,
};

/**
 * Merge the hardcoded defaults with a deployment's config additions
 * (`APP_CONFIG_ITX`). Config can only WIDEN — the defaults always apply, so
 * a misconfigured deployment never loses first-party caps.
 */
export function resolveDialableTargets(config?: {
  dialableBindings?: readonly string[];
  dialableDurableObjects?: readonly string[];
  dialableLoopbacks?: readonly string[];
}): DialableTargets {
  if (
    !config?.dialableBindings?.length &&
    !config?.dialableDurableObjects?.length &&
    !config?.dialableLoopbacks?.length
  ) {
    return DEFAULT_DIALABLE_TARGETS;
  }
  return {
    bindings: new Set([...DIALABLE_BINDINGS, ...(config.dialableBindings ?? [])]),
    durableObjects: new Set([
      ...DIALABLE_DURABLE_OBJECTS,
      ...(config.dialableDurableObjects ?? []),
    ]),
    loopbacks: new Set([...DIALABLE_LOOPBACKS, ...(config.dialableLoopbacks ?? [])]),
  };
}
