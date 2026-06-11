// Wire refs: the serializable names that cross connect/stub boundaries.
// Deliberately import-free (browser components and Node clients import this;
// itx.ts — the core — imports cloudflare:workers and never loads off-platform).
// Everything here is a pure name with zero authority: the restorer
// (entrypoint.ts) and connect-time auth (fetch.ts) are where names become
// live handles.

/**
 * The ONE serializable parameterization in the system (Law 2: props carry
 * identity, never composition or authority-by-content).
 *
 * - `context` is a sturdy ref: "global", a project id, or a child context id.
 *   The restorer (ItxEntrypoint.context) turns it into a live handle; that
 *   resolution is the only authority gate besides connect-time auth.
 * - `access` is the simplified access model: which projects a GLOBAL handle
 *   may narrow to. Ignored (forced to the context's own project) on
 *   project-context handles, mirroring the old "project workers cannot
 *   escalate scopes" rule.
 * - `capabilityPath` is pure attribution: which capability's isolate this is
 *   (the dotted route). It grants nothing; it labels egress and audit records.
 */
export type ItxProps = {
  context: string;
  access?: ProjectAccess;
  capabilityPath?: string;
};

export type ProjectAccess = "all" | string[];

export const GLOBAL_CONTEXT_ID = "global";

/** Child context ids: `ctx_…` TypeIDs; project contexts use the project id. */
export const CHILD_CONTEXT_PREFIX = "ctx";

export function isChildContextId(contextId: string): boolean {
  return contextId.startsWith(`${CHILD_CONTEXT_PREFIX}_`);
}

/** Stream path (inside the context's namespace) for itx audit events. */
export const ITX_AUDIT_STREAM_PATH = "/itx";
