// Wire refs: the serializable names that cross connect/stub boundaries.
// Deliberately import-light (browser components and Node clients import
// this; itx.ts — the core — pulls in the streams framework and never loads
// off-platform). Everything here is a pure name with zero authority: the
// restorer (entrypoint.ts) and connect-time auth (fetch.ts) are where names
// become live handles.

/**
 * The ONE serializable parameterization in the system (Law 2: props carry
 * identity, never composition or authority-by-content).
 *
 * - `context` is the sturdy ref: "global" (a connect-minted view with no
 *   node) or a context's stream coordinate `<namespace>:<path>`. Identity,
 *   node address, and owning project are all projections of it — there is
 *   nothing else to resolve (coordinates.ts).
 * - `access` is the simplified access model: which projects a GLOBAL handle
 *   may narrow to. Ignored (forced to the context's own project) on
 *   context handles, mirroring the old "project workers cannot escalate
 *   scopes" rule.
 * - `capabilityPath` is pure attribution: which capability's isolate this is
 *   (the dotted route). It grants nothing; it labels egress and records.
 */
export type ItxProps = {
  context: string;
  access?: ProjectAccess;
  capabilityPath?: string;
};

export type ProjectAccess = "all" | string[];

export const GLOBAL_CONTEXT_ID = "global";
