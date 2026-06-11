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
 * - `context` is a sturdy ref: "global", a project id, or a child context id.
 *   The restorer (ItxEntrypoint.context) turns it into a live handle; that
 *   resolution is the only authority gate besides connect-time auth.
 * - `contextAddress`/`projectId` are the resolved coordinate, passed by
 *   platform wiring so a child context's isolates skip the directory lookup.
 *   Pure names (an address grants nothing); absent on bare-id restores,
 *   which resolve through the itx context catalog instead.
 * - `access` is the simplified access model: which projects a GLOBAL handle
 *   may narrow to. Ignored (forced to the context's own project) on
 *   project-context handles, mirroring the old "project workers cannot
 *   escalate scopes" rule.
 * - `capabilityPath` is pure attribution: which capability's isolate this is
 *   (the dotted route). It grants nothing; it labels egress and journal records.
 */
/** A CapabilityAddress as it rides in props — structurally typed so this
 * module stays import-light (the real type is itx.ts's CapabilityAddress). */
export type ItxWireAddress = { type: "rpc" | "url" } & Record<string, unknown>;

export type ItxProps = {
  context: string;
  contextAddress?: ItxWireAddress | null;
  projectId?: string | null;
  access?: ProjectAccess;
  capabilityPath?: string;
};

export type ProjectAccess = "all" | string[];

export const GLOBAL_CONTEXT_ID = "global";

/** Child context ids: `itx_…` TypeIDs; project contexts use the project id. */
export const CHILD_CONTEXT_PREFIX = "itx";

export function isChildContextId(contextId: string): boolean {
  return contextId.startsWith(`${CHILD_CONTEXT_PREFIX}_`);
}
