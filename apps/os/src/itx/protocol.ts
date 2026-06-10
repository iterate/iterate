// itx protocol: the (deliberately tiny) set of types and rules that cross
// boundaries. Everything here is either serializable data or a method
// signature — never composition. See apps/os/docs/itx-spec.md §1 (the Laws).

/**
 * The ONE serializable parameterization in the system (Law 2: props carry
 * identity, never composition or authority-by-content).
 *
 * - `context` is a sturdy ref: "global", a project id, or (later) a child
 *   context id. The restorer (ItxEntrypoint.context) turns it into a live
 *   handle; that resolution is the only authority gate besides connect-time
 *   auth.
 * - `access` is the simplified access model: which projects a GLOBAL handle
 *   may narrow to. Ignored (forced to the context's own project) on
 *   project-context handles, mirroring the old "config workers cannot
 *   escalate scopes" rule.
 * - `cap` is pure attribution: which capability's isolate this is. It grants
 *   nothing; it labels egress and audit records.
 */
export type ItxProps = {
  context: string;
  access?: ProjectAccess;
  cap?: string;
};

export type ProjectAccess = "all" | string[];

export const GLOBAL_CONTEXT_ID = "global";

/**
 * How a capability is invoked (Law 6: one wire protocol, two modes).
 *
 * - "members": the registry replays the property path on the target and
 *   calls the terminal method on its parent (receiver-preserving). Right for
 *   plain RpcTargets, functions, and objects-of-functions.
 * - "path-call": the registry makes ONE call, `target.call({ path, args })`.
 *   Right for SDK-shaped surfaces with method trees we don't predeclare —
 *   the provider implements a single method and the public Slack SDK docs
 *   become the tool docs ("use itx.slack exactly like @slack/web-api").
 */
export type CapInvoke = "members" | "path-call";

export type PathCall = { path: string[]; args: unknown[] };

/** The full shape a "path-call" capability provider implements. */
export type PathCallTarget = { call(input: PathCall): unknown };

/**
 * A capability's kind is its target's type (design of record: types.ts).
 * Stored rows may still carry the legacy kinds "worker"/"facet"; they
 * normalize to "rpc" on read.
 */
export type CapKind = "live" | "rpc" | "url";

/**
 * Source for a `{ type: "source" }` worker ref. `cacheKey` MUST change
 * whenever the module contents change — the Worker Loader caches the
 * materialized isolate by it (a content hash is the ideal value). `codeId`
 * is the legacy spelling, still accepted.
 */
export type CapSource = {
  cacheKey?: string;
  /** @deprecated legacy spelling of `cacheKey`. */
  codeId?: string;
  mainModule: string;
  modules: Record<string, string>;
  /** Named export to use; defaults to the default export. */
  entrypoint?: string;
  /**
   * What the entrypoint export IS: "worker-entrypoint" (default; stateless,
   * fresh isolate per call) or "durable-object" (stateful; a NAMED export
   * extending DurableObject, instantiated as a facet of the hosting context
   * node with its own private SQLite).
   */
  exportType?: "worker-entrypoint" | "durable-object";
  compatibilityDate?: string;
};

export function capSourceCacheKey(source: CapSource): string {
  const key = source.cacheKey ?? source.codeId;
  if (!key) {
    throw new Error(
      "CapSource needs a cacheKey (rotate it whenever modules change; a content hash is ideal).",
    );
  }
  return key;
}

/** Where an rpc target's worker lives (design of record: types.ts). */
export type WorkerRef =
  | { type: "binding"; binding: string }
  | { type: "loopback" }
  | { type: "project-worker" }
  | { type: "durable-object"; binding: string; name: string }
  | { type: "source"; source: CapSource };

/**
 * The serializable capability targets — this realm's sturdy refs. The
 * non-serializable `live` kind never appears here: live stubs exist only in
 * the registry's in-memory connection table.
 */
export type SerializableCapTarget =
  | {
      type: "rpc";
      worker: WorkerRef;
      /** Named export to instantiate (loopback refs require it). For
       * `source` refs the export is named by `source.entrypoint` instead. */
      entrypoint?: string;
      /** Instantiation props (the ProjectEgress pattern). The registry adds
       * `{ cap, context }` attribution at dial time. */
      props?: Record<string, unknown>;
    }
  | { type: "url"; url: string; headers?: Record<string, string> };

/**
 * Which env bindings / loopback exports an rpc target may dial. Deliberately
 * hardcoded constants for now (config-driven later — itx-next.md §2):
 * binding and loopback refs reach PLATFORM resources, so an open list would
 * let any project handle reach e.g. the deployment D1, or mint itx handles
 * on arbitrary projects via ItxEntrypoint props. Checked at define time
 * (fail fast) and again at dial time (authoritative).
 */
export const DIALABLE_BINDINGS: ReadonlySet<string> = new Set(["AI"]);
/**
 * Loopback entrypoints listed here MUST scope strictly by the dial-time
 * props the registry injects ({ cap, context, projectId }) — never by
 * definer-supplied props — because anyone with a handle on a context can
 * define a cap dialing them.
 */
export const DIALABLE_LOOPBACKS: ReadonlySet<string> = new Set([
  "AgentCapability",
  "AgentToolsCapability",
  "BindingCapability",
  "GmailCapability",
  "McpClient",
  "OrpcCapability",
  "SlackCapability",
]);

/**
 * Normalize a define() input to a serializable target. Legacy callers pass
 * `source` (+ optional `kind: "worker" | "facet"`); they normalize to an
 * rpc/source target, with "facet" becoming `exportType: "durable-object"`.
 */
export function normalizeCapTarget(input: {
  target?: SerializableCapTarget;
  source?: CapSource;
  kind?: "worker" | "facet";
}): SerializableCapTarget {
  if (input.target) {
    if (input.source || input.kind) {
      throw new Error("caps.define takes either target or legacy source/kind, not both.");
    }
    return input.target;
  }
  if (!input.source) throw new Error("caps.define needs a target.");
  const source: CapSource = {
    ...input.source,
    exportType:
      input.source.exportType ?? (input.kind === "facet" ? "durable-object" : "worker-entrypoint"),
  };
  return { type: "rpc", worker: { source, type: "source" } };
}

/**
 * Define-time validation of a serializable target. The same checks run
 * again at dial time inside the registry; this exists so misconfigured
 * targets fail at define() with a useful error instead of at first call.
 */
export function assertDefinableCapTarget(name: string, target: SerializableCapTarget): void {
  if (target.type === "url") {
    throw new Error(
      `Capability "${name}": url targets are not implemented yet (Law 7: Cap'n Web must terminate ` +
        `in a stateless worker, never a DO — the dial path for url refs is a follow-up).`,
    );
  }
  const worker = target.worker;
  switch (worker.type) {
    case "binding":
      if (!DIALABLE_BINDINGS.has(worker.binding)) {
        throw new Error(
          `Capability "${name}": binding "${worker.binding}" is not dialable. ` +
            `Dialable bindings: ${[...DIALABLE_BINDINGS].join(", ") || "(none)"}.`,
        );
      }
      if (target.entrypoint) {
        throw new Error(
          `Capability "${name}": binding refs take no entrypoint — the binding object itself is the target.`,
        );
      }
      return;
    case "loopback":
      if (!target.entrypoint) {
        throw new Error(
          `Capability "${name}": loopback refs need an entrypoint (the export name).`,
        );
      }
      if (!DIALABLE_LOOPBACKS.has(target.entrypoint)) {
        throw new Error(
          `Capability "${name}": loopback export "${target.entrypoint}" is not dialable. ` +
            `Dialable exports: ${[...DIALABLE_LOOPBACKS].join(", ") || "(none)"}.`,
        );
      }
      return;
    case "source":
      if (worker.source.exportType === "durable-object" && !worker.source.entrypoint) {
        // Default-export DO classes make workerd's facet instantiation fail
        // with an opaque internal error; a NAMED export works (DECISIONS D12).
        throw new Error(
          `Capability "${name}" needs source.entrypoint naming an exported ` +
            `"class X extends DurableObject" (default exports do not work as facet classes).`,
        );
      }
      capSourceCacheKey(worker.source);
      return;
    case "durable-object":
    case "project-worker":
      throw new Error(
        `Capability "${name}": ${worker.type} refs are not implemented yet (itx-next.md §1).`,
      );
  }
}

/**
 * Arbitrary metadata, stored verbatim and surfaced by describe(). There is
 * no schema — the named fields below are conventions:
 * - `instructions`: a sentence for the human/agent who finds this cap.
 * - `http`: HTTP routing flags (spec §8).
 */
export type CapMeta = {
  instructions?: string;
  definedBy?: { type: "user" | "agent" | "system"; id: string };
  http?: { expose: boolean; public?: boolean };
  [key: string]: unknown;
};

/** A registry entry as reported by describe(); never contains live stubs. */
export type CapDescription = {
  name: string;
  kind: CapKind;
  invoke: CapInvoke;
  /** Which context owns the entry — provenance for shadowing visibility. */
  owner: string;
  /** Live caps only: is the provider currently connected? */
  connected?: boolean;
  /** Lifted from meta for convenience: the one thing to read first. */
  instructions?: string;
  meta: CapMeta;
  updatedAtMs: number;
};

/**
 * Names that may never be capability names. Three sources of truth collapse
 * into this single registration-time check (it replaces the scattered
 * blocklists in the old path proxies):
 *
 * - itx built-ins: a cap must not shadow the trust kernel.
 * - JS/RPC protocol names: `then` makes proxies thenable, `dup`/`onRpcBroken`
 *   are capnweb stub controls, `constructor`/`__proto__` are prototype
 *   pollution vectors, `map` is capnweb's magic promise method.
 */
const ITX_BUILTIN_NAMES = [
  "caps",
  "describe",
  "fetch",
  "fork",
  "project",
  "projects",
  "repos",
  "streams",
  "worker",
  "workspace",
] as const;

/**
 * Names that must never traverse a dynamic surface — prototype-pollution
 * vectors, capnweb stub controls, and thenable/`Function.prototype` traps.
 * The single source of truth for BOTH the consumer-side path proxy
 * (path-proxy.ts) and the server-side path replay (`replayPathCall`), so a
 * hand-built `path` reaching `itxInvoke` directly is filtered identically.
 */
export const RESERVED_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__proto__",
  "apply",
  "bind",
  "call",
  "catch",
  "constructor",
  "dup",
  "finally",
  "hasOwnProperty",
  "isPrototypeOf",
  "map",
  "onRpcBroken",
  "propertyIsEnumerable",
  "prototype",
  "then",
  "toLocaleString",
  "toString",
  "valueOf",
]);

/** A cap name may shadow neither an itx built-in nor a reserved path segment. */
export const RESERVED_CAP_NAMES: ReadonlySet<string> = new Set([
  ...ITX_BUILTIN_NAMES,
  ...RESERVED_PATH_SEGMENTS,
]);

/**
 * Cap names must be flat JS identifiers so `itx.<name>` works via the
 * fallthrough proxy. No dots: nesting belongs to the provided object
 * (`provide("tools", { slack, github })`), not to the registry — nested
 * *names* would reintroduce path resolution into the platform (spec §4.5).
 */
export function assertValidCapName(name: string): void {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
    throw new Error(
      `Capability name ${JSON.stringify(name)} must be a plain JavaScript identifier.`,
    );
  }
  if (RESERVED_CAP_NAMES.has(name)) {
    throw new Error(`Capability name ${JSON.stringify(name)} is reserved.`);
  }
}

/** Stream path (inside the context's namespace) for registry audit events. */
export const ITX_AUDIT_STREAM_PATH = "/itx";

/** Registry audit event types appended to the context stream (spec §4.2). */
export const ITX_EVENT_TYPES = {
  capDefined: "events.iterate.com/itx/cap-defined",
  capProvided: "events.iterate.com/itx/cap-provided",
  capRevoked: "events.iterate.com/itx/cap-revoked",
  capDisconnected: "events.iterate.com/itx/cap-disconnected",
  contextForked: "events.iterate.com/itx/context-forked",
  /**
   * Script execution record (itx-next.md §4, record-only mode): the runner
   * appends `executionRequested` before the script starts and
   * `executionCompleted` when it settles. The events are the durable record,
   * not the transport — everything between them is invisible to the stream.
   * These two events replace codemode's six-event execution protocol.
   */
  executionRequested: "events.iterate.com/itx/execution-requested",
  executionCompleted: "events.iterate.com/itx/execution-completed",
} as const;

/** Child context ids: `ctx_…` TypeIDs; project contexts use the project id. */
export const CHILD_CONTEXT_PREFIX = "ctx";

export function isChildContextId(contextId: string): boolean {
  return contextId.startsWith(`${CHILD_CONTEXT_PREFIX}_`);
}
