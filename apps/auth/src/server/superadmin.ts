/**
 * Superadmin model
 * ----------------
 * `user.role === "admin"` (the better-auth admin plugin's role column on the
 * user table) is the single source of truth for superadmin status. Everything
 * else is derived from it:
 *
 * - oRPC middleware (orpc.ts) lets superadmins through organization/project
 *   membership checks.
 * - Access tokens get the `superadmin` scope added server-side
 *   (oauth-project-selection.ts); resource servers like the OS MCP handler
 *   trust that scope. Clients cannot grant it to themselves — it is stripped
 *   from requested scopes unless the role says otherwise.
 * - ID tokens / userinfo expose it as the is_admin / role claims
 *   (auth-plugins.ts).
 *
 * The role is granted three ways:
 * - the signup hook in auth.ts, for emails matching SUPERADMIN_ALLOWLIST
 *   (default `*@nustom.com`),
 * - the deploy-time seed SQL (scripts/render-superadmin-seed.ts), which
 *   backfills users who existed before their email domain was allowlisted —
 *   once per pattern, so it never overrides a later manual demotion,
 * - manually, via the better-auth admin API.
 *
 * Nothing demotes automatically: someone whose email leaves the allowlist
 * keeps the role until it is cleared by hand. Role changes reach access
 * tokens within their 30-minute TTL and sessions within the 5-minute cookie
 * cache.
 *
 * Not to be confused with per-organization membership roles
 * ("owner"/"admin"/"member" on the member table) — see orpc.ts.
 */
export function isSuperadminUser(
  user: { role?: unknown } | Record<string, unknown> | null | undefined,
): boolean {
  return user?.role === "admin";
}
