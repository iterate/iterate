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
 *   project-context handles, mirroring the old "project workers cannot
 *   escalate scopes" rule.
 * - `capability` is pure attribution: which capability's isolate this is. It
 *   grants nothing; it labels egress and audit records.
 */
export type ItxProps = {
  context: string;
  access?: ProjectAccess;
  capability?: string;
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
export type CapabilityInvoke = "members" | "path-call";

export type PathCall = { path: string[]; args: unknown[] };

/** The full shape a "path-call" capability provider implements. */
export type PathCallTarget = { call(input: PathCall): unknown };

/** A capability's kind is its target's type (design of record: types.ts). */
export type CapabilityKind = "live" | "rpc" | "url";

/**
 * Source for a `{ type: "source" }` worker ref. `cacheKey` MUST change
 * whenever the module contents change — the Worker Loader caches the
 * materialized isolate by it (a content hash is the ideal value).
 */
export type CapabilitySource = {
  cacheKey?: string;
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

export function capabilitySourceCacheKey(source: CapabilitySource): string {
  const key = source.cacheKey;
  if (!key) {
    throw new Error(
      "CapabilitySource needs a cacheKey (rotate it whenever modules change; a content hash is ideal).",
    );
  }
  return key;
}

/** Where an rpc target's worker lives (design of record: types.ts). The
 * project worker is NOT a kind: it is the `ProjectWorker` loopback
 * forwarder (user export + inner invoke mode ride in props). */
export type WorkerRef =
  | { type: "binding"; binding: string }
  | { type: "loopback" }
  | { type: "durable-object"; binding: string; name: string }
  | { type: "source"; source: CapabilitySource };

/**
 * The serializable capability targets — this realm's sturdy refs. The
 * non-serializable `live` kind never appears here: live stubs exist only in
 * the registry's in-memory connection table.
 */
export type SerializableCapabilityTarget =
  | {
      type: "rpc";
      worker: WorkerRef;
      /** Named export to instantiate (loopback refs require it). For
       * `source` refs the export is named by `source.entrypoint` instead. */
      entrypoint?: string;
      /** Instantiation props (the ProjectEgress pattern). The registry adds
       * `{ capability, context }` attribution at dial time. */
      props?: Record<string, unknown>;
    }
  | {
      /** A remote Cap'n Web server. The dial terminates in the UrlDial
       * stateless worker (Law 7); `headers` ride the WebSocket handshake and
       * pass through egress getSecret() substitution (Law 5). */
      type: "url";
      url: string;
      headers?: Record<string, string>;
    };

/**
 * Which env bindings / loopback exports an rpc target may dial. Binding and
 * loopback refs reach PLATFORM resources, so an open list would let any
 * project handle reach e.g. the deployment D1, or mint itx handles on
 * arbitrary projects via ItxEntrypoint props. Checked at provide time (fail
 * fast) and again at dial time (authoritative). A deployment widens the
 * lists via config (`APP_CONFIG_ITX` → {@link DialableTargets}); the
 * hardcoded defaults always apply.
 */
export const DIALABLE_BINDINGS: ReadonlySet<string> = new Set(["AI"]);
/**
 * Loopback entrypoints listed here MUST scope strictly by the dial-time
 * props the registry injects ({ capability, context, projectId }) — never by
 * provider-supplied props — because anyone with a handle on a context can
 * provide a cap dialing them.
 */
export const DIALABLE_LOOPBACKS: ReadonlySet<string> = new Set([
  "AgentCapability",
  "AgentToolsCapability",
  "BindingCapability",
  "EgressPipe",
  "GmailCapability",
  "McpClient",
  "OrpcCapability",
  "ProjectWorker",
  "ReposCapability",
  "SlackCapability",
  "StreamsCapability",
  "WorkspaceCapability",
]);

/**
 * Durable Object namespace bindings dialable via `{ type: "durable-object" }`
 * refs. The registry scopes every dial under the owning project
 * (`itx:<projectId>:<name>`), so an allowlisted namespace's itx-reachable
 * instances are disjoint per project. Still empty by default: namespaces
 * whose EXISTING instances matter (PROJECT, STREAM, …) must not be
 * allowlisted — itx-created instances would be fresh/empty objects under the
 * scoped name, not the real ones. Deployments opt namespaces in via config
 * once they have one designed to be reached this way.
 */
export const DIALABLE_DURABLE_OBJECTS: ReadonlySet<string> = new Set();

/** The dial allowlists a host resolves once (defaults ∪ deployment config). */
export type DialableTargets = {
  bindings: ReadonlySet<string>;
  durableObjects: ReadonlySet<string>;
  loopbacks: ReadonlySet<string>;
};

export const DEFAULT_DIALABLE_TARGETS: DialableTargets = {
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

/**
 * Provide-time validation of a serializable target. The same checks run
 * again at dial time inside the registry; this exists so misconfigured
 * targets fail at provideCapability() with a useful error instead of at
 * first call.
 */
export function assertProvidableCapabilityTarget(
  name: string,
  target: SerializableCapabilityTarget,
  dialable: DialableTargets = DEFAULT_DIALABLE_TARGETS,
): void {
  if (target.type === "url") {
    let protocol: string;
    try {
      protocol = new URL(target.url).protocol;
    } catch {
      throw new Error(`Capability "${name}": ${JSON.stringify(target.url)} is not a valid URL.`);
    }
    if (!["http:", "https:", "ws:", "wss:"].includes(protocol)) {
      throw new Error(
        `Capability "${name}": url targets must be http(s) or ws(s), got ${JSON.stringify(target.url)}.`,
      );
    }
    return;
  }
  const worker = target.worker;
  switch (worker.type) {
    case "binding":
      if (!dialable.bindings.has(worker.binding)) {
        throw new Error(
          `Capability "${name}": binding "${worker.binding}" is not dialable. ` +
            `Dialable bindings: ${[...dialable.bindings].join(", ") || "(none)"}.`,
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
      if (!dialable.loopbacks.has(target.entrypoint)) {
        throw new Error(
          `Capability "${name}": loopback export "${target.entrypoint}" is not dialable. ` +
            `Dialable exports: ${[...dialable.loopbacks].join(", ") || "(none)"}.`,
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
      capabilitySourceCacheKey(worker.source);
      return;
    case "durable-object":
      if (!dialable.durableObjects.has(worker.binding)) {
        throw new Error(
          `Capability "${name}": Durable Object namespace "${worker.binding}" is not dialable. ` +
            `Dialable namespaces: ${[...dialable.durableObjects].join(", ") || "(none — opt in via APP_CONFIG_ITX)"}.`,
        );
      }
      if (!worker.name) {
        throw new Error(`Capability "${name}": durable-object refs need a non-empty name.`);
      }
      return;
  }
}

/**
 * Arbitrary metadata, stored verbatim and surfaced by describe(). There is
 * no schema — the named fields below are conventions:
 * - `instructions`: a sentence for the human/agent who finds this cap.
 * - `http`: HTTP routing flags (spec §8).
 */
export type CapabilityMeta = {
  instructions?: string;
  providedBy?: { type: "user" | "agent" | "system"; id: string };
  http?: { expose: boolean; public?: boolean };
  [key: string]: unknown;
};

/** A registry entry as reported by describe(); never contains live stubs. */
export type CapabilityDescription = {
  name: string;
  kind: CapabilityKind;
  invoke: CapabilityInvoke;
  /** Which context owns the entry — provenance for shadowing visibility. */
  owner: string;
  /** Live caps only: is the provider currently connected? */
  connected?: boolean;
  /** Lifted from meta for convenience: the one thing to read first. */
  instructions?: string;
  meta: CapabilityMeta;
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
 *
 * `fetch` is deliberately NOT here: project egress is a `platform:project`
 * default capability, and providing your own `fetch` (e.g. a live provider)
 * is how egress interception works. The handle's real `fetch` method still
 * wins property lookup; it routes through the registry anyway.
 */
const ITX_BUILTIN_NAMES = [
  "capability",
  "describe",
  "fork",
  "invoke",
  "project",
  "projects",
  "provideCapability",
  "revokeCapability",
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
export const RESERVED_CAPABILITY_NAMES: ReadonlySet<string> = new Set([
  ...ITX_BUILTIN_NAMES,
  ...RESERVED_PATH_SEGMENTS,
]);

/**
 * Every path segment must be a flat JS identifier so `itx.<a>.<b>` works via
 * the fallthrough proxy, and the dot-joined form stays unambiguous as the
 * registry's storage key.
 */
export function assertValidCapabilityName(name: string): void {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
    throw new Error(
      `Capability name ${JSON.stringify(name)} must be a plain JavaScript identifier.`,
    );
  }
  if (RESERVED_CAPABILITY_NAMES.has(name)) {
    throw new Error(`Capability name ${JSON.stringify(name)} is reserved.`);
  }
}

/**
 * Definitions live at PATHS (itx-next.md §4): a name is a 1-segment path.
 * The two reserved sets split by position: the FIRST segment must not shadow
 * the trust kernel (it is reachable as `itx.<name>`, so it competes with the
 * built-ins), deeper segments only need the protocol-level path filter — the
 * built-in names are perfectly good method names there.
 */
export function assertValidCapabilityPath(path: string[]): void {
  if (path.length === 0) {
    throw new Error("A capability path needs at least one segment.");
  }
  assertValidCapabilityName(path[0]!);
  for (const segment of path.slice(1)) {
    if (!/^[A-Za-z_$][\w$]*$/.test(segment)) {
      throw new Error(
        `Capability path segment ${JSON.stringify(segment)} must be a plain JavaScript identifier.`,
      );
    }
    if (RESERVED_PATH_SEGMENTS.has(segment)) {
      throw new Error(`Capability path segment ${JSON.stringify(segment)} is reserved.`);
    }
  }
}

/**
 * provideCapability/revokeCapability address an entry by `name` (the common
 * case — one segment) OR `path` (multi-segment). Exactly one must be present;
 * both normalize to segments here.
 */
export function capabilityPathFrom(input: { name?: string; path?: string[] }): string[] {
  if ((input.name === undefined) === (input.path === undefined)) {
    throw new Error("Provide exactly one of `name` or `path`.");
  }
  return input.path ? [...input.path] : [input.name!];
}

/** Stream path (inside the context's namespace) for registry audit events. */
export const ITX_AUDIT_STREAM_PATH = "/itx";

/** Registry audit event types appended to the context stream (spec §4.2). */
export const ITX_EVENT_TYPES = {
  /**
   * ONE provide event for every target kind: `kind` in the payload records
   * what was provided — "live" (a session-bound provider stub) vs "rpc"/"url"
   * (a durable serializable target). Durable payloads also carry the worker
   * ref type and, for source refs, the cacheKey.
   */
  capabilityProvided: "events.iterate.com/itx/capability-provided",
  capabilityRevoked: "events.iterate.com/itx/capability-revoked",
  capabilityDisconnected: "events.iterate.com/itx/capability-disconnected",
  contextForked: "events.iterate.com/itx/context-forked",
  /**
   * Script execution record (itx-next.md §4, record-only mode): the runner
   * appends `scriptExecutionRequested` before the script starts and
   * `scriptExecutionCompleted` when it settles. The events are the durable record,
   * not the transport — everything between them is invisible to the stream.
   * These two events replace codemode's six-event execution protocol.
   */
  scriptExecutionRequested: "events.iterate.com/itx/script-execution-requested",
  scriptExecutionCompleted: "events.iterate.com/itx/script-execution-completed",
} as const;

/** Child context ids: `ctx_…` TypeIDs; project contexts use the project id. */
export const CHILD_CONTEXT_PREFIX = "ctx";

export function isChildContextId(contextId: string): boolean {
  return contextId.startsWith(`${CHILD_CONTEXT_PREFIX}_`);
}
