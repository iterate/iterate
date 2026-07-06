import type { SemaphorePrincipal } from "~/auth.ts";
import type { RequestContext } from "~/request-context.ts";

/**
 * Server functions are HTTP-invokable endpoints regardless of route gating,
 * so each one asserts authorization itself: everything semaphore exposes is
 * operator tooling, and operators are iterate admins.
 */
export function requireAdminPrincipal(
  context: Pick<RequestContext, "principal">,
): SemaphorePrincipal {
  const principal = context.principal ?? null;
  if (!principal?.isAdmin) {
    throw new Error(
      "This action requires an iterate admin identity. Sign in through /api/iterate-auth/login.",
    );
  }
  return principal;
}
