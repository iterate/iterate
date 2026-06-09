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
  assertValidCapName,
  ITX_EVENT_TYPES,
  type CapDescription,
  type CapInvoke,
  type CapKind,
  type CapMeta,
  type CapSource,
  type PathCall,
  type PathCallTarget,
} from "./protocol.ts";
import { replayPathCall } from "./path-proxy.ts";

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
  ): { getEntrypoint(name?: string): unknown };
};

export type ContextRegistryHost = {
  /** This context's id — also the `owner` field in descriptions. */
  contextId: string;
  /** The owning project (egress + worker-cap itx scoping). */
  projectId: string;
  sql: SqlStorage;
  /** Worker Loader for worker-kind caps; absent in environments without it. */
  loader?: WorkerLoaderLike;
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
};

type CapRow = {
  name: string;
  kind: CapKind;
  invoke: CapInvoke;
  source_json: string | null;
  meta_json: string;
  updated_at_ms: number;
};

type LiveConnection = {
  target: LiveCapTarget;
  [Symbol.dispose]: () => void;
};

export class CapOfflineError extends Error {
  constructor(name: string) {
    super(
      `Capability "${name}" is registered but its provider is not connected. ` +
        `Live capabilities last as long as the provider's session; the provider must reconnect and provide() again.`,
    );
  }
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
      source: null,
    });
    this.host.audit({
      type: ITX_EVENT_TYPES.capProvided,
      payload: { invoke, name: input.name },
    });
    return { name: input.name, ok: true };
  }

  /**
   * Register a durable capability from source. Loaded on demand via the
   * Worker Loader; `source.codeId` must rotate with content (loader caches
   * by id).
   */
  define(input: {
    name: string;
    source: CapSource;
    kind?: Exclude<CapKind, "live">;
    invoke?: CapInvoke;
    meta?: CapMeta;
  }): { name: string; ok: true } {
    assertValidCapName(input.name);
    const kind = input.kind ?? "worker";
    if (kind === "facet") {
      throw new Error("Facet capabilities are not implemented yet (itx-spec §10 phase 5).");
    }
    const invoke = input.invoke ?? "members";

    this.upsertRow({
      invoke,
      kind,
      meta: input.meta ?? {},
      name: input.name,
      source: input.source,
    });
    this.host.audit({
      type: ITX_EVENT_TYPES.capDefined,
      payload: { codeId: input.source.codeId, invoke, kind, name: input.name },
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
    return this.rows().map((row) => ({
      connected: row.kind === "live" ? this.#live.has(row.name) : undefined,
      invoke: row.invoke,
      kind: row.kind,
      meta: JSON.parse(row.meta_json) as CapMeta,
      name: row.name,
      owner: this.host.contextId,
      updatedAtMs: row.updated_at_ms,
    }));
  }

  has(name: string): boolean {
    return this.row(name) !== null;
  }

  /** The only dispatch in the system (spec §4.4). */
  async invoke(name: string, call: PathCall): Promise<unknown> {
    const row = this.row(name);
    if (!row) {
      throw new Error(`No capability named "${name}" in context ${this.host.contextId}.`);
    }

    const target = this.targetFor(row);
    if (row.invoke === "path-call") {
      // One RPC: the provider implements call({ path, args }) and owns its
      // own method-tree semantics (e.g. forwarding to the Slack web API).
      return await (target as PathCallTarget).call(call);
    }
    return await replayPathCall(target, call);
  }

  private targetFor(row: CapRow): unknown {
    switch (row.kind) {
      case "live": {
        const connection = this.#live.get(row.name);
        if (!connection) throw new CapOfflineError(row.name);
        return connection.target;
      }
      case "worker":
        return this.loadWorkerCap(row);
      case "facet":
        throw new Error("Facet capabilities are not implemented yet.");
    }
  }

  private loadWorkerCap(row: CapRow): unknown {
    const loader = this.host.loader;
    if (!loader) throw new Error("Worker capabilities need a LOADER binding.");
    const source = JSON.parse(row.source_json ?? "null") as CapSource | null;
    if (!source) throw new Error(`Capability "${row.name}" has no stored source.`);

    const worker = loader.get(
      `itx-cap:${this.host.contextId}:${row.name}:${source.codeId}`,
      () => ({
        compatibilityDate: source.compatibilityDate ?? DEFAULT_CAP_COMPATIBILITY_DATE,
        compatibilityFlags: DEFAULT_CAP_COMPATIBILITY_FLAGS,
        env: {
          // The cap's own itx is scoped to its home context — a cap can never
          // reach wider than where it is defined (Law 4). `cap` is attribution.
          ITERATE: this.host.loopback("ItxEntrypoint", {
            props: { cap: row.name, context: this.host.contextId },
          }),
        },
        // Bare fetch() inside the cap IS project egress: secret substitution
        // and (future) policy live in the Project DO, and the cap's isolate
        // never sees secret material (Law 5).
        globalOutbound: this.host.loopback("ProjectEgress", {
          props: { cap: row.name, context: this.host.contextId, project: this.host.projectId },
        }),
        mainModule: source.mainModule,
        modules: source.modules,
      }),
    );
    return worker.getEntrypoint(source.entrypoint);
  }

  private upsertRow(input: {
    name: string;
    kind: CapKind;
    invoke: CapInvoke;
    source: CapSource | null;
    meta: CapMeta;
  }) {
    this.host.sql.exec(
      `INSERT INTO itx_caps (name, kind, invoke, source_json, meta_json, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         kind = excluded.kind,
         invoke = excluded.invoke,
         source_json = excluded.source_json,
         meta_json = excluded.meta_json,
         updated_at_ms = excluded.updated_at_ms`,
      input.name,
      input.kind,
      input.invoke,
      input.source ? JSON.stringify(input.source) : null,
      JSON.stringify(input.meta),
      Date.now(),
    );
  }

  private rows(): CapRow[] {
    return this.host.sql
      .exec<CapRow>(
        `SELECT name, kind, invoke, source_json, meta_json, updated_at_ms FROM itx_caps ORDER BY name`,
      )
      .toArray();
  }

  private row(name: string): CapRow | null {
    return (
      this.host.sql
        .exec<CapRow>(
          `SELECT name, kind, invoke, source_json, meta_json, updated_at_ms FROM itx_caps WHERE name = ?`,
          name,
        )
        .toArray()[0] ?? null
    );
  }
}
