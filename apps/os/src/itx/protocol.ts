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

export type CapKind = "live" | "worker" | "facet";

/**
 * Source for durable (worker/facet) caps. `codeId` MUST change whenever the
 * module contents change — the Worker Loader caches by id (same discipline
 * as the AppRunner example in Cloudflare's Facets announcement).
 */
export type CapSource = {
  codeId: string;
  mainModule: string;
  modules: Record<string, string>;
  /** Named export to use; defaults to the default export. */
  entrypoint?: string;
  compatibilityDate?: string;
};

export type CapMeta = {
  definedBy?: { type: "user" | "agent" | "system"; id: string };
  /** HTTP routing flags (spec §8); consumed when cap routing lands. */
  http?: { expose: boolean; public?: boolean };
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

const RESERVED_PROTOCOL_NAMES = [...RESERVED_PATH_SEGMENTS] as const;

export const RESERVED_CAP_NAMES: ReadonlySet<string> = new Set([
  ...ITX_BUILTIN_NAMES,
  ...RESERVED_PROTOCOL_NAMES,
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
} as const;

/** Child context ids: `ctx_…` TypeIDs; project contexts use the project id. */
export const CHILD_CONTEXT_PREFIX = "ctx";

export function isChildContextId(contextId: string): boolean {
  return contextId.startsWith(`${CHILD_CONTEXT_PREFIX}_`);
}
