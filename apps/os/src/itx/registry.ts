// ContextRegistry: the capability registry every context node embeds.
//
// A context node (today: the Project Durable Object; later: ContextDO for
// child contexts) is the SUPERVISOR for its capabilities — every invocation
// flows through `invoke()` here, which is the single audit/policy point in
// the system (DECISIONS.md D4). The registry owns:
//
//   - durable entries in the host's SQLite (worker/facet source, live-cap
//     records) — the authoritative state (D1),
//   - the in-memory live connection table — runtime-only by design; live
//     stubs die with their session and providers reconnect (Law 1),
//   - dispatch: members-replay or one path-call, per entry (Law 6).
//
// The host stays in charge of identity and wiring via ContextRegistryHost;
// the registry never touches authority — by the time a call reaches it, the
// caller already held a handle on this context.

import {
  assertDefinableCapTarget,
  assertValidCapName,
  capSourceCacheKey,
  DEFAULT_DIALABLE_TARGETS,
  ITX_EVENT_TYPES,
  normalizeCapTarget,
  type CapDescription,
  type CapInvoke,
  type CapKind,
  type CapMeta,
  type CapSource,
  type DialableTargets,
  type PathCall,
  type PathCallTarget,
  type SerializableCapTarget,
} from "./protocol.ts";
import { replayPathCall } from "./path-proxy.ts";
import type { CodeContext } from "./code-contexts.ts";

const DEFAULT_CAP_COMPATIBILITY_DATE = "2026-04-27";
const DEFAULT_CAP_COMPATIBILITY_FLAGS = ["nodejs_compat"];

/**
 * A live provider's stub as the registry sees it. Structural because the
 * stub may arrive over Cap'n Web (browser/Node provider) or Workers RPC and
 * we only rely on the protocol-level controls.
 */
export type LiveCapTarget = {
  dup?: () => LiveCapTarget;
  onRpcBroken?: (callback: (error: unknown) => void) => void;
  [Symbol.dispose]?: () => void;
} & Record<string, unknown>;

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

export type ContextRegistryHost = {
  /** This context's id — also the `owner` field in descriptions. */
  contextId: string;
  /** The owning project (egress + worker-cap itx scoping). */
  projectId: string;
  sql: SqlStorage;
  /** Worker Loader for source-ref caps; absent in environments without it. */
  loader?: WorkerLoaderLike;
  /**
   * Resolve an env binding by name for `{ type: "binding" }` worker refs.
   * The registry gates lookups on DIALABLE_BINDINGS before calling this.
   */
  binding?: (name: string) => unknown;
  /**
   * Create a loopback service-binding stub for a named export of the parent
   * worker, parameterized by props. Used to hand worker caps their
   * env.ITERATE (an ItxEntrypoint scoped to THIS context — a cap can never
   * reach wider than its home) and their globalOutbound (ProjectEgress).
   */
  loopback: (exportName: string, props: Record<string, unknown>) => unknown;
  /**
   * Append an audit event to the context stream. Fire-and-forget: the SQLite
   * table is the authoritative state, the stream is history (D1).
   */
  audit: (event: { type: string; payload: Record<string, unknown> }) => void;
  /**
   * Instantiate a Durable Object Facet of the hosting DO (Cloudflare's
   * supervisor pattern, verbatim). Present only on DO hosts whose runtime
   * supports `ctx.facets`; facet-kind caps get their own private SQLite
   * database stored inside the hosting context node.
   */
  facets?: (
    name: string,
    getClass: () => { class: unknown } | Promise<{ class: unknown }>,
  ) => unknown;
  /**
   * A code-defined parent context (itx-next.md §8): the final fallthrough
   * link of cap lookup, resolved in-process. Own SQLite rows shadow it;
   * describe() reports its caps with the code context's name as owner.
   */
  defaults?: CodeContext;
  /**
   * The dial allowlists for binding/loopback refs — hardcoded defaults plus
   * the deployment's config additions (resolveDialableTargets). Absent means
   * defaults only.
   */
  dialable?: DialableTargets;
};

/**
 * `kind` is stored raw: new rows carry a CapKind ("live" | "rpc" | "url"),
 * rows written before CapTarget landed carry the legacy "worker"/"facet".
 * `targetOf()` is the single place legacy rows normalize.
 */
type CapRow = {
  name: string;
  kind: CapKind | "worker" | "facet";
  invoke: CapInvoke;
  source_json: string | null;
  target_json: string | null;
  meta_json: string;
  updated_at_ms: number;
};

type LiveConnection = {
  target: LiveCapTarget;
  [Symbol.dispose]: () => void;
};

/**
 * Adapt a Durable Object's `ctx.facets` (open beta) to the registry's hook.
 * Returns the hook even when the runtime lacks facets — the error surfaces
 * at invoke time with a clear message instead of at registry construction.
 */
export function durableObjectFacetsHook(
  ctx: DurableObjectState,
): NonNullable<ContextRegistryHost["facets"]> {
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

export class CapOfflineError extends Error {
  constructor(name: string) {
    super(
      `Capability "${name}" is registered but its provider is not connected. ` +
        `Live capabilities last as long as the provider's session; the provider must reconnect and provide() again.`,
    );
  }
}

/** Dispose a borrowed RPC stub if it is disposable (in-process targets aren't). */
function disposeIfPossible(target: unknown): void {
  const dispose = (target as Partial<Disposable> | null)?.[Symbol.dispose];
  if (typeof dispose === "function") Reflect.apply(dispose, target, []);
}

export class ContextRegistry {
  // In-memory only, on purpose: live stubs cannot be persisted. When workerd
  // ships hibernation-surviving outbound stub storage (workerd#6087) this
  // map is the one thing to swap out.
  #live = new Map<string, LiveConnection>();

  constructor(private readonly host: ContextRegistryHost) {
    host.sql.exec(`CREATE TABLE IF NOT EXISTS itx_caps (
      name TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      invoke TEXT NOT NULL,
      source_json TEXT,
      meta_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )`);
    // CapTarget storage; rows from before this column exist with NULL and
    // normalize from kind + source_json on read (targetOf).
    const columns = host.sql.exec(`PRAGMA table_info(itx_caps)`).toArray() as { name: string }[];
    if (!columns.some((column) => column.name === "target_json")) {
      host.sql.exec(`ALTER TABLE itx_caps ADD COLUMN target_json TEXT`);
    }
  }

  /**
   * Register a live capability. Session-bound: the entry survives in SQLite
   * (so describe() can report "registered but offline") but the stub lives
   * only in memory and is torn down when the provider's session breaks.
   */
  provide(input: { name: string; target: LiveCapTarget; invoke?: CapInvoke; meta?: CapMeta }): {
    name: string;
    ok: true;
  } {
    assertValidCapName(input.name);
    const invoke = input.invoke ?? "members";

    // RPC disposes argument stubs when the call returns; keep a duplicate
    // (and hand further dups to borrowers) — both directions of the dup()
    // discipline from the original capnweb learnings.
    const target = input.target.dup ? input.target.dup() : input.target;
    const connection: LiveConnection = {
      target,
      [Symbol.dispose]: () => {
        if (this.#live.get(input.name) === connection) {
          this.#live.delete(input.name);
          this.host.audit({
            type: ITX_EVENT_TYPES.capDisconnected,
            payload: { name: input.name },
          });
        }
        target[Symbol.dispose]?.();
      },
    };

    this.#live.get(input.name)?.[Symbol.dispose]();
    this.#live.set(input.name, connection);
    target.onRpcBroken?.(() => connection[Symbol.dispose]());

    this.upsertRow({
      invoke,
      kind: "live",
      meta: input.meta ?? {},
      name: input.name,
      target: null,
    });
    this.host.audit({
      type: ITX_EVENT_TYPES.capProvided,
      payload: { invoke, name: input.name },
    });
    return { name: input.name, ok: true };
  }

  /**
   * Register a durable capability: a name plus a serializable target
   * (types.ts is the design of record). Legacy callers pass `source`
   * (+ optional kind "worker"/"facet"); both normalize to an rpc/source
   * target. Targets are validated here so misconfiguration fails at
   * define(), and again at dial time (the authoritative gate).
   */
  define(input: {
    name: string;
    target?: SerializableCapTarget;
    source?: CapSource;
    kind?: "worker" | "facet";
    invoke?: CapInvoke;
    meta?: CapMeta;
  }): { name: string; ok: true } {
    assertValidCapName(input.name);
    const target = normalizeCapTarget(input);
    assertDefinableCapTarget(input.name, target, this.dialable());
    const invoke = input.invoke ?? "members";

    this.upsertRow({
      invoke,
      kind: target.type,
      meta: input.meta ?? {},
      name: input.name,
      target,
    });
    this.host.audit({
      type: ITX_EVENT_TYPES.capDefined,
      payload: {
        invoke,
        kind: target.type,
        name: input.name,
        ...(target.type === "rpc" ? { worker: target.worker.type } : {}),
        ...(target.type === "rpc" && target.worker.type === "source"
          ? { cacheKey: capSourceCacheKey(target.worker.source) }
          : {}),
      },
    });
    return { name: input.name, ok: true };
  }

  revoke(input: { name: string }): { name: string; ok: true } {
    this.#live.get(input.name)?.[Symbol.dispose]();
    this.host.sql.exec(`DELETE FROM itx_caps WHERE name = ?`, input.name);
    this.host.audit({ type: ITX_EVENT_TYPES.capRevoked, payload: { name: input.name } });
    return { name: input.name, ok: true };
  }

  describe(): CapDescription[] {
    const own = this.rows().map((row): CapDescription => {
      const meta = JSON.parse(row.meta_json) as CapMeta;
      return {
        connected: row.kind === "live" ? this.#live.has(row.name) : undefined,
        instructions: typeof meta.instructions === "string" ? meta.instructions : undefined,
        invoke: row.invoke,
        kind: normalizeKind(row.kind),
        meta,
        name: row.name,
        owner: this.host.contextId,
        updatedAtMs: row.updated_at_ms,
      };
    });
    const defaults = this.host.defaults;
    if (!defaults) return own;
    // Code-context defaults appear with their context's name as owner, own
    // rows shadow by name — the same merged-chain semantics itxDescribe()
    // gives parent DOs, one link earlier and without the hop.
    const shadowed = new Set(own.map((description) => description.name));
    const inherited = [...defaults.caps]
      .filter(([name]) => !shadowed.has(name))
      .map(
        ([name, cap]): CapDescription => ({
          instructions:
            typeof cap.meta.instructions === "string" ? cap.meta.instructions : undefined,
          invoke: cap.invoke,
          kind: cap.target.type,
          meta: cap.meta,
          name,
          owner: defaults.name,
          updatedAtMs: 0,
        }),
      );
    return [...own, ...inherited];
  }

  has(name: string): boolean {
    return this.row(name) !== null || (this.host.defaults?.caps.has(name) ?? false);
  }

  /** The only dispatch in the system (spec §4.4). */
  async invoke(name: string, call: PathCall): Promise<unknown> {
    const row = this.row(name) ?? this.defaultRow(name);
    if (!row) {
      throw new Error(`No capability named "${name}" in context ${this.host.contextId}.`);
    }

    // Every dispatch works on a BORROW that is disposed when the call ends,
    // never on a long-lived object:
    //  - live   → a .dup() of the stored stub (the dup-on-borrow half of the
    //             capnweb discipline; the stored connection is left intact so
    //             concurrent / back-to-back calls never share or close it),
    //  - worker → the fresh per-call entrypoint stub,
    //  - facet  → the per-call facet stub.
    // project-worker refs return a custom dispatch instead of a target: the
    // call crosses to the Project DO as data and is replayed there.
    const { dispatch, target, dispose } = this.borrowTarget(row);
    try {
      if (dispatch) return await dispatch(call);
      if (row.invoke === "path-call") {
        // One RPC: the provider implements call({ path, args }) and owns its
        // own method-tree semantics (e.g. forwarding to the Slack web API).
        return await (target as PathCallTarget).call(call);
      }
      return await replayPathCall(target, call);
    } catch (error) {
      // Log at the supervisor: errors crossing the RPC boundary back to the
      // caller can be masked as "internal error; reference = …", so the only
      // place the real failure is visible is here.
      console.error(
        `[itx] cap "${name}" (${row.kind}/${row.invoke}) failed in ${this.host.contextId} ` +
          `at path ${call.path.join(".") || "<call>"}:`,
        error,
      );
      throw error;
    } finally {
      dispose();
    }
  }

  /**
   * The two-case shape (types.ts): a capability is either held up by a live
   * connection, or its serializable target is resolved at invoke time.
   */
  private borrowTarget(row: CapRow): {
    target?: unknown;
    dispose: () => void;
    dispatch?: (call: PathCall) => Promise<unknown>;
  } {
    if (row.kind === "live") {
      const connection = this.#live.get(row.name);
      if (!connection) throw new CapOfflineError(row.name);
      // Borrow a duplicate, not the stored stub itself. Disposing the borrow
      // releases only this call's reference; the registered target stays
      // callable for the next caller (matches the original getConnection
      // dup-on-borrow behaviour).
      const target = connection.target.dup ? connection.target.dup() : connection.target;
      return { target, dispose: () => disposeIfPossible(target) };
    }
    return this.resolveTarget(row.name, targetOf(row), row.invoke);
  }

  private resolveTarget(
    name: string,
    target: SerializableCapTarget,
    invoke: CapInvoke,
  ): {
    target?: unknown;
    dispose: () => void;
    dispatch?: (call: PathCall) => Promise<unknown>;
  } {
    if (target.type === "url") {
      // Law 7: the Cap'n Web session must terminate in a stateless worker,
      // never this DO — so the call crosses to the UrlDial entrypoint as
      // data (a custom dispatch, like ProjectWorker), and UrlDial applies
      // the cap's invoke mode against the REMOTE main. `invoke` here would
      // otherwise be interpreted against the UrlDial stub itself.
      const stub = this.host.loopback("UrlDial", {
        props: {
          headers: target.headers,
          invoke,
          url: target.url,
          // Attribution + secret scope; same spoof-proofing as loopback refs.
          cap: name,
          context: this.host.contextId,
          projectId: this.host.projectId,
        },
      }) as { call(call: PathCall): Promise<unknown> };
      return {
        dispatch: async (call) => await stub.call(call),
        dispose: () => disposeIfPossible(stub),
      };
    }
    const worker = target.worker;
    switch (worker.type) {
      case "binding": {
        // Authoritative allowlist gate (define-time check is fail-fast only).
        if (!this.dialable().bindings.has(worker.binding)) {
          throw new Error(`Capability "${name}": binding "${worker.binding}" is not dialable.`);
        }
        const binding = this.host.binding?.(worker.binding);
        if (binding == null) {
          throw new Error(
            `Capability "${name}": binding "${worker.binding}" is not available on this host.`,
          );
        }
        // Env bindings are long-lived host objects, never per-call borrows —
        // do NOT dispose them.
        return { target: binding, dispose: () => {} };
      }
      case "loopback": {
        if (!target.entrypoint || !this.dialable().loopbacks.has(target.entrypoint)) {
          throw new Error(
            `Capability "${name}": loopback export "${target.entrypoint}" is not dialable.`,
          );
        }
        const stub = this.host.loopback(target.entrypoint, {
          props: {
            ...target.props,
            // Attribution wins over definer-supplied props, by spread order.
            cap: name,
            context: this.host.contextId,
            // Spoof-proofing: first-party entrypoints that scope by project
            // read props.projectId; the registry forces it to the owning
            // project so a definer can never point a dialable loopback at
            // someone else's project.
            projectId: this.host.projectId,
          },
        });
        return { target: stub, dispose: () => disposeIfPossible(stub) };
      }
      case "source": {
        const source = worker.source;
        if (source.exportType === "durable-object") {
          const facets = this.host.facets;
          if (!facets) {
            throw new Error("Durable-object caps need a Durable-Object host with ctx.facets.");
          }
          // Facet name deliberately excludes the cache key: the facet's
          // private SQLite survives code upgrades (new source, same data) —
          // the same property Cloudflare's AppRunner example relies on.
          const facetTarget = facets(`cap:${name}`, () => {
            const facetClass = this.loadWorker(name, source).getDurableObjectClass?.(
              source.entrypoint,
            );
            if (!facetClass) {
              throw new Error(
                `Capability "${name}" did not yield a DurableObject class ` +
                  `(durable-object caps must export one, and the runtime must support getDurableObjectClass).`,
              );
            }
            return { class: facetClass };
          });
          return { target: facetTarget, dispose: () => disposeIfPossible(facetTarget) };
        }
        const entrypoint = this.loadWorker(name, source).getEntrypoint(source.entrypoint);
        return { target: entrypoint, dispose: () => disposeIfPossible(entrypoint) };
      }
      case "durable-object":
        throw new Error(
          `Capability "${name}": ${worker.type} refs are not implemented yet (itx-next.md §1).`,
        );
    }
  }

  private loadWorker(name: string, source: CapSource): ReturnType<WorkerLoaderLike["get"]> {
    const loader = this.host.loader;
    if (!loader) throw new Error("Source capabilities need a LOADER binding.");

    return loader.get(
      `itx-cap:${this.host.contextId}:${name}:${capSourceCacheKey(source)}`,
      () => ({
        compatibilityDate: source.compatibilityDate ?? DEFAULT_CAP_COMPATIBILITY_DATE,
        compatibilityFlags: DEFAULT_CAP_COMPATIBILITY_FLAGS,
        env: {
          // The cap's own itx is scoped to its home context — a cap can never
          // reach wider than where it is defined (Law 4). `cap` is attribution.
          ITERATE: this.host.loopback("ItxEntrypoint", {
            props: { cap: name, context: this.host.contextId },
          }),
        },
        // Bare fetch() inside the cap IS project egress: secret substitution
        // and (future) policy live in the Project DO, and the cap's isolate
        // never sees secret material (Law 5).
        globalOutbound: this.host.loopback("ProjectEgress", {
          props: { cap: name, context: this.host.contextId, project: this.host.projectId },
        }),
        mainModule: source.mainModule,
        modules: source.modules,
      }),
    );
  }

  private upsertRow(input: {
    name: string;
    kind: CapKind;
    invoke: CapInvoke;
    target: SerializableCapTarget | null;
    meta: CapMeta;
  }) {
    this.host.sql.exec(
      `INSERT INTO itx_caps (name, kind, invoke, source_json, target_json, meta_json, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         kind = excluded.kind,
         invoke = excluded.invoke,
         source_json = excluded.source_json,
         target_json = excluded.target_json,
         meta_json = excluded.meta_json,
         updated_at_ms = excluded.updated_at_ms`,
      input.name,
      input.kind,
      input.invoke,
      // source_json kept in sync for source targets so a rollback to the
      // pre-CapTarget code can still read rows written by this version.
      input.target?.type === "rpc" && input.target.worker.type === "source"
        ? JSON.stringify(input.target.worker.source)
        : null,
      input.target ? JSON.stringify(input.target) : null,
      JSON.stringify(input.meta),
      Date.now(),
    );
  }

  private rows(): CapRow[] {
    return this.host.sql
      .exec<CapRow>(
        `SELECT name, kind, invoke, source_json, target_json, meta_json, updated_at_ms FROM itx_caps ORDER BY name`,
      )
      .toArray();
  }

  private dialable(): DialableTargets {
    return this.host.dialable ?? DEFAULT_DIALABLE_TARGETS;
  }

  /** A code-context default, shaped as the row it would be if it were data. */
  private defaultRow(name: string): CapRow | null {
    const cap = this.host.defaults?.caps.get(name);
    if (!cap) return null;
    return {
      invoke: cap.invoke,
      kind: cap.target.type,
      meta_json: JSON.stringify(cap.meta),
      name,
      source_json: null,
      target_json: JSON.stringify(cap.target),
      updated_at_ms: 0,
    };
  }

  private row(name: string): CapRow | null {
    return (
      this.host.sql
        .exec<CapRow>(
          `SELECT name, kind, invoke, source_json, target_json, meta_json, updated_at_ms FROM itx_caps WHERE name = ?`,
          name,
        )
        .toArray()[0] ?? null
    );
  }
}

/** Legacy stored kinds ("worker"/"facet") report as "rpc" — their targets
 * normalize to rpc/source refs in targetOf(). */
function normalizeKind(kind: CapRow["kind"]): CapKind {
  return kind === "worker" || kind === "facet" ? "rpc" : kind;
}

/**
 * The single place a stored row becomes a serializable target. Rows written
 * before target_json existed (kind "worker"/"facet" + source_json) normalize
 * here; "facet" becomes exportType "durable-object".
 */
function targetOf(row: CapRow): SerializableCapTarget {
  if (row.target_json) return JSON.parse(row.target_json) as SerializableCapTarget;
  const source = JSON.parse(row.source_json ?? "null") as CapSource | null;
  if (!source) throw new Error(`Capability "${row.name}" has no stored target.`);
  return {
    type: "rpc",
    worker: {
      source: {
        ...source,
        exportType:
          source.exportType ?? (row.kind === "facet" ? "durable-object" : "worker-entrypoint"),
      },
      type: "source",
    },
  };
}
