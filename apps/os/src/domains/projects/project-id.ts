// One home for "what is a project id, and who is allowed to mint one".
//
// The **auth worker is the canonical minter** of project ids: every project
// lives in an organization there, and minting in one place is what keeps the
// id space free of collisions. Auth mints with `generateId("prj")` →
// `prj_<uuid>` (see apps/auth .../routers/_shared.ts).
//
// OS only mints in the operator/recovery path, where there is no auth
// organization to own the project (admin-created projects). It uses the SAME
// `prj_` prefix and format so there is a single id space — never a second
// `proj_` typeid namespace that resolvers then have to special-case.
//
// `proj_` is the LEGACY OS-typeid prefix. We no longer mint it, but older rows
// may still carry it, so `isProjectId` keeps recognising it.

export const PROJECT_ID_PREFIX = "prj";

/**
 * Mint a project id in the auth worker's format. Use ONLY where OS legitimately
 * owns minting (operator/admin create with no auth org). For normal user
 * creates, let the auth worker mint and adopt the id it returns.
 */
export function mintProjectId(): string {
  return `${PROJECT_ID_PREFIX}_${crypto.randomUUID().replace(/-/g, "")}`;
}

/**
 * True when `value` is a project id rather than a slug. `prj_` is the canonical
 * auth-minted prefix; `proj_` is the legacy OS typeid still present on old rows.
 * Shared by every slug-or-id resolver so they can't drift (the drift is exactly
 * what produced the "Project prj_… not found" prod bug).
 */
export function isProjectId(value: string): boolean {
  return value.startsWith("prj_") || value.startsWith("proj_");
}
