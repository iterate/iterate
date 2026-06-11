// The host boundary of the itx core: everything a context-node Durable
// Object adds around the pure Itx (itx.ts).
//
//   - makeDial: the ONE effectful function injected into the core — it owns
//     REACH (which bindings/loopbacks/namespaces are dialable, gated at dial
//     time = first invoke) while the core owns structure.
//   - DurableItx: the INTERIM persistence wrapper — provide/revoke write
//     through to the host's existing itx_capabilities SQLite table and emit
//     the ITX_EVENT_TYPES audit events. Wave (f) of itx-next.md replaces this
//     class with the ItxProcessor journal (the stream becomes the only
//     authority and this file's SQLite half dies).
//   - PLATFORM_PROJECT_CAPABILITIES: the platform defaults, passed as the
//     core's constructor `capabilities` by the Project DO only — child
//     contexts inherit them through the parent chain (itx-next.md §8: code
//     holds composition; only overrides are data).

import {
  capabilitySourceCacheKey,
  Itx,
  ITX_EVENT_TYPES,
  replayPathCall,
  type CapabilityAddress,
  type CapabilityDial,
  type CapabilityKind,
  type CapabilityMeta,
  type CapabilitySource,
  type DialableTargets,
  type ItxStub,
  type PathCallable,
  type ProvideCapabilityInput,
} from "./itx.ts";
import { wireIsolateEnv } from "./isolate.ts";

type WorkerLoaderLike = {
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
    getEntrypoint(name?: string): unknown;
    getDurableObjectClass?(name?: string): unknown;
  };
};

export type DialHost = {
  /** The hosting context — source-cap isolates are scoped to it (a cap can
   * never reach wider than its home) and it keys the loader cache. */
  contextId: string;
  /** The owning project — {capability, context, projectId} prop injection
   * (spoof-proofing: a provider can never point a dialable loopback at
   * someone else's project) and the itx:<projectId>:<name> DO scoping. */
  projectId: string;
  /** Env bindings for `{ type: "binding" }` and `{ type: "durable-object" }`
   * refs; gated on the allowlists before any lookup. */
  env: unknown;
  /** The hosting worker's loopback exports (ctx.exports). */
  exports: Record<string, (options: { props: Record<string, unknown> }) => unknown>;
  /** Worker Loader for source-ref caps; absent in environments without it. */
  loader?: WorkerLoaderLike;
  /** Durable Object facet instantiation (durableObjectFacetsHook). */
  facets?: (
    name: string,
    getClass: () => { class: unknown } | Promise<{ class: unknown }>,
  ) => unknown;
  /** Hardcoded defaults ∪ deployment config (resolveDialableTargets). */
  allowlists: DialableTargets;
};

/**
 * The single dial function a context node injects into its core. Allowlist
 * (reachability) errors surface HERE — at dial time, i.e. the capability's
 * first call — never at provide time (the old provide-time fail-fast was
 * deliberately dropped: provide is structural only).
 */
export function makeDial(host: DialHost): CapabilityDial {
  const loopback = (exportName: string, props: Record<string, unknown>): unknown => {
    const factory = host.exports[exportName];
    if (typeof factory !== "function") {
      throw new Error(`Loopback export ${exportName} is not available.`);
    }
    return factory({ props });
  };

  const loadWorker = (name: string, source: CapabilitySource) => {
    if (!host.loader) throw new Error("Source capabilities need a LOADER binding.");
    return host.loader.get(
      `itx-cap:${host.contextId}:${name}:${capabilitySourceCacheKey(source)}`,
      () =>
        wireIsolateEnv({
          capability: name,
          code: source,
          contextId: host.contextId,
          loopback: (exportName, options) => loopback(exportName, options.props),
          projectId: host.projectId,
        }),
    );
  };

  return (address, attribution): PathCallable => {
    const name = attribution.capability;
    // Attribution wins over provider-supplied props, by spread order.
    // `context` is the ORIGINATING context (chain delegation carries it), so
    // context-scoped first-party caps — the workspace — bind to the caller's
    // context even when the definition is inherited.
    const injected = {
      capability: name,
      context: attribution.origin,
      projectId: host.projectId,
    };

    if (address.type === "url") {
      // Law 7: the Cap'n Web session must terminate in a stateless worker,
      // never this DO — the call crosses to the UrlDial entrypoint as data
      // and UrlDial replays it against the REMOTE main.
      const stub = loopback("UrlDial", { headers: address.headers, url: address.url, ...injected });
      return stub as PathCallable;
    }
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
        return inProcessPathCallable(binding);
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
        // INNER borrow when the core's call ends.
        const source = worker.source;
        if (source.exportType === "durable-object") {
          const facets = host.facets;
          if (!facets) {
            throw new Error("Durable-object caps need a Durable-Object host with ctx.facets.");
          }
          // Facet name deliberately excludes the cache key: the facet's
          // private SQLite survives code upgrades (new source, same data) —
          // the same property Cloudflare's AppRunner example relies on.
          const facetTarget = facets(`cap:${name}`, () => {
            const facetClass = loadWorker(name, source).getDurableObjectClass?.(source.entrypoint);
            if (!facetClass) {
              throw new Error(
                `Capability "${name}" did not yield a DurableObject class ` +
                  `(durable-object caps must export one, and the runtime must support getDurableObjectClass).`,
              );
            }
            return { class: facetClass };
          });
          return inProcessPathCallable(facetTarget, () => disposeIfPossible(facetTarget));
        }
        const entrypoint = loadWorker(name, source).getEntrypoint(source.entrypoint);
        return inProcessPathCallable(entrypoint, () => disposeIfPossible(entrypoint));
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
        // Names are scoped under the owning project, so two projects naming
        // the same instance get DISJOINT objects — an allowlisted namespace
        // never lets one project dial another's instances. The stub is remote
        // (never concrete here), so the DO class itself must implement
        // call({ path, args }) — namespaces opt in via config and are
        // designed to be reached this way.
        return namespace.getByName(`itx:${host.projectId}:${worker.name}`) as PathCallable;
      }
    }
  };
}

/** An in-process borrow that speaks the calling convention: replays the path
 * on the concrete object the dial just resolved, and (optionally) disposes
 * the inner borrow when the core finishes the call. Never crosses RPC — the
 * core consumes it in-process, so no RpcTarget wrapper is needed. */
function inProcessPathCallable(target: unknown, dispose?: () => void): PathCallable {
  return {
    call: (input) => replayPathCall(target, input),
    ...(dispose ? { [Symbol.dispose]: dispose } : {}),
  };
}

function disposeIfPossible(target: unknown): void {
  const dispose = (target as Partial<Disposable> | null)?.[Symbol.dispose];
  if (typeof dispose === "function") Reflect.apply(dispose, target, []);
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

// ---- interim persistence ------------------------------------------------------

type CapabilityRow = {
  name: string;
  kind: CapabilityKind;
  target_json: string | null;
  meta_json: string;
  updated_at_ms: number;
};

/**
 * The durable host's core: same Itx, but the two write verbs ALSO write
 * through to the host's SQLite table and emit the audit events — and
 * construction loads the stored rows back, applied AFTER the constructor
 * defaults so they win per last-write-wins. Live rows restore disconnected
 * (a connection cannot be persisted). INTERIM: wave (f) replaces this class
 * with ItxProcessor (journal writes + replay; the SQLite table dies).
 */
export class DurableItx extends Itx {
  readonly #sql: SqlStorage;
  readonly #audit: (event: { type: string; payload: Record<string, unknown> }) => void;

  constructor(input: {
    contextId: string;
    dial: CapabilityDial;
    parentItx?: ItxStub;
    capabilities?: ProvideCapabilityInput[];
    sql: SqlStorage;
    /** Append an audit event to the context stream. Fire-and-forget: the
     * SQLite table stays authoritative until wave (f) inverts that. */
    audit: (event: { type: string; payload: Record<string, unknown> }) => void;
  }) {
    input.sql.exec(`CREATE TABLE IF NOT EXISTS itx_capabilities (
      name TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      target_json TEXT,
      meta_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )`);
    super(input);
    this.#sql = input.sql;
    this.#audit = input.audit;
    const rows = input.sql
      .exec<CapabilityRow>(
        `SELECT name, kind, target_json, meta_json, updated_at_ms FROM itx_capabilities ORDER BY name`,
      )
      .toArray();
    for (const row of rows) {
      this.restoreCapability({
        address: row.target_json ? (JSON.parse(row.target_json) as CapabilityAddress) : null,
        kind: row.kind,
        meta: JSON.parse(row.meta_json) as CapabilityMeta,
        name: row.name,
        owner: input.contextId,
        updatedAtMs: row.updated_at_ms,
      });
    }
  }

  override provideCapability(input: ProvideCapabilityInput): void {
    super.provideCapability(input);
    const name = (input.path ?? [input.name!]).join(".");
    const entry = this.providedCapability(name)!;
    this.#sql.exec(
      `INSERT INTO itx_capabilities (name, kind, target_json, meta_json, updated_at_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         kind = excluded.kind,
         target_json = excluded.target_json,
         meta_json = excluded.meta_json,
         updated_at_ms = excluded.updated_at_ms`,
      entry.name,
      entry.kind,
      entry.address ? JSON.stringify(entry.address) : null,
      JSON.stringify(entry.meta),
      entry.updatedAtMs,
    );
    this.#audit({
      type: ITX_EVENT_TYPES.capabilityProvided,
      payload: {
        kind: entry.kind,
        name: entry.name,
        ...(entry.address?.type === "rpc" ? { worker: entry.address.worker.type } : {}),
        ...(entry.address?.type === "rpc" && entry.address.worker.type === "source"
          ? { cacheKey: capabilitySourceCacheKey(entry.address.worker.source) }
          : {}),
      },
    });
  }

  override revokeCapability(input: { name?: string; path?: string[] }): void {
    super.revokeCapability(input); // throws on platform defaults — nothing persists
    const name = (input.path ?? [input.name!]).join(".");
    this.#sql.exec(`DELETE FROM itx_capabilities WHERE name = ?`, name);
    this.#audit({ type: ITX_EVENT_TYPES.capabilityRevoked, payload: { name } });
  }

  protected override capabilityDisconnected(name: string): void {
    this.#audit({ type: ITX_EVENT_TYPES.capabilityDisconnected, payload: { name } });
  }
}

// ---- platform defaults ----------------------------------------------------------

/**
 * The defaults every project context starts with (§8's "cap #0 disappears"
 * direction), passed as the core's constructor `capabilities` by the Project
 * DO — literal, legible entries; shipping a new default is a deploy, not a
 * migration of thousands of registries. Child contexts deliberately do NOT
 * get these: their misses delegate up the real chain to the project node,
 * which is where shadowing rows must win.
 */
export const PLATFORM_PROJECT_CAPABILITIES: ProvideCapabilityInput[] = [
  {
    instructions:
      "Workers AI. Use it like an env.AI binding: itx.ai.run(model, inputs). " +
      "Shadow it with your own `ai` cap to swap providers.",
    name: "ai",
    provider: {
      entrypoint: "BindingCapability",
      props: { binding: "AI" },
      type: "rpc",
      worker: { type: "loopback" },
    },
  },
  {
    // The DEFAULT egress pipe: itx.fetch(...) and bare fetch() in every
    // platform-loaded isolate dispatch through THIS entry. The target is the
    // terminal, stateless EgressPipe (path: [], args: [request]): secret
    // placeholder substitution + the real fetch, no Durable Object in the
    // path. The dispatcher (ProjectEgress.fetch) routes core-first and the
    // default is a DIFFERENT entrypoint — that is what breaks the loop.
    instructions:
      "Project egress: itx.fetch(request) and bare fetch() inside platform-loaded " +
      "isolates both flow through this cap. Shadow it with your own `fetch` (e.g. a " +
      "live provider whose call({ path: [], args: [request] }) returns a Response) to " +
      "intercept ALL project egress while connected; revoke the shadow and this " +
      "default resurfaces. A shadow provider receives getSecret(...) placeholders " +
      "UNSUBSTITUTED — secret material only exists in the default pipe.",
    name: "fetch",
    provider: { entrypoint: "EgressPipe", type: "rpc", worker: { type: "loopback" } },
  },
  {
    instructions:
      "Event streams in this project's namespace: itx.streams.get('/path') returns a " +
      "stream handle with append/read/getState/subscribe; get also takes absolute " +
      "refs ('ns:/path') checked against this project's access. Chained calls ride " +
      "RPC promise pipelining.",
    name: "streams",
    provider: { entrypoint: "StreamsCapability", type: "rpc", worker: { type: "loopback" } },
  },
  {
    instructions:
      "The project's git repos: itx.repos.ensureIterateConfigInfo({ projectSlug }), " +
      "list(), create({ slug }), get({ slug }) — repo handles expose commitFiles/readFiles/readLog.",
    name: "repos",
    provider: { entrypoint: "ReposCapability", type: "rpc", worker: { type: "loopback" } },
  },
  {
    instructions:
      "A persistent workspace filesystem: itx.workspace.readFile/writeFile plus the flat " +
      "git methods gitClone/gitAdd/gitCommit/gitPush/gitStatus. Project contexts share " +
      "one workspace; forked child contexts each get their own.",
    name: "workspace",
    provider: { entrypoint: "WorkspaceCapability", type: "rpc", worker: { type: "loopback" } },
  },
  {
    // The forwarder hop speaks call({ path, args }); how it treats the
    // user's default export — members replay — rides in ITS props.
    instructions:
      "The project's own iterate-config worker, rebuilt from the repo on every call: " +
      "itx.worker.someExportedFunction(args) reaches any public method of its default export.",
    name: "worker",
    provider: {
      entrypoint: "ProjectWorker",
      props: { invoke: "members" },
      type: "rpc",
      worker: { type: "loopback" },
    },
  },
];
