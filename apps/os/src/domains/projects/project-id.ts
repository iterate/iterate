// One home for "what is a project id". The **auth worker is the ONLY
// minter**: user creates mint via the org flow, and even OS operator/recovery
// creates round-trip through auth's `/internal/project/mint-project-id` — OS
// never mints locally, so the `prj_` id space has exactly one source.
//
// `proj_` is the LEGACY OS-typeid prefix. We no longer mint it, but older rows
// may still carry it, so `isProjectId` keeps recognising it.

/**
 * True when `value` is a project id rather than a slug. `prj_` is the canonical
 * auth-minted prefix; `proj_` is the legacy OS typeid still present on old rows.
 * Shared by every slug-or-id resolver so they can't drift (the drift is exactly
 * what produced the "Project prj_… not found" prod bug).
 */
export function isProjectId(value: string): boolean {
  return value.startsWith("prj_") || value.startsWith("proj_");
}
