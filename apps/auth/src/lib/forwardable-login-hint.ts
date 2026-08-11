import { z } from "zod/v4";

/**
 * Which `login_hint` values the relying-party `/login` route forwards into
 * the authorization request: the login page's two mode selectors, or an
 * email address (standard OIDC semantics — say who is signing in). The
 * validation mirrors the login page's search schema (utils/login-hint.ts
 * holds the presentation side), so nothing forwarded gets ignored there.
 * Anything else is dropped.
 */
export function forwardableLoginHint(hint: string | null): string | null {
  if (hint === "email" || hint === "google") return hint;
  if (hint && z.email().safeParse(hint).success) return hint;
  return null;
}
