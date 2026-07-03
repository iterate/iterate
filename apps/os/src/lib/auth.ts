import { redirect } from "@tanstack/react-router";
import type { PublicSessionResponse } from "@iterate-com/auth/client";
import type { SignInAuthError } from "~/auth/errors.ts";
import { createUserPrincipal, type UserPrincipal } from "~/auth/principal.ts";

type RouteLocation = {
  pathname: string;
  searchStr?: string;
};

export function requireOrganizationMemberForSession(
  session: PublicSessionResponse | null | undefined,
  location: RouteLocation,
  issuer: string | undefined,
  authError: SignInAuthError | undefined,
) {
  const principal = requireUserPrincipalFromSession(session, location, authError);
  if (principal.organizations.length === 0) {
    throw redirectToProjectAccess(issuer);
  }

  return null;
}

export function requireAuthenticatedRootRedirectTargetFromSession(
  session: PublicSessionResponse | null | undefined,
  location: RouteLocation,
  issuer: string | undefined,
  currentProjectHostSlug: string | null | undefined,
  authError: SignInAuthError | undefined,
) {
  const principal = requireUserPrincipalFromSession(session, location, authError);

  if (principal.organizations.length === 0) {
    throw redirectToProjectAccess(issuer);
  }

  return {
    projectSlug: currentProjectHostSlug ?? null,
  };
}

function getUserPrincipalFromSession(
  session: PublicSessionResponse | null | undefined,
): UserPrincipal | null {
  if (!session?.authenticated) return null;

  return createUserPrincipal({
    userId: session.user.id,
    sessionId: session.session.sessionId,
    isAdmin: session.user.isAdmin === true || session.user.role === "admin",
    organizations: session.session.organizations,
    projects: session.session.projects,
  });
}

function requireUserPrincipalFromSession(
  session: PublicSessionResponse | null | undefined,
  location: RouteLocation,
  authError: SignInAuthError | undefined,
): UserPrincipal {
  const principal = getUserPrincipalFromSession(session);
  if (!principal) {
    throw redirectToSignIn(location, authError);
  }
  return principal;
}

function redirectToSignIn(location: RouteLocation, authError: SignInAuthError | undefined): never {
  throw redirect({
    to: "/sign-in/$",
    params: { _splat: "" },
    search: {
      // The sign-in page only accepts same-origin relative paths, so pass
      // pathname + search rather than a full href.
      redirect_url: `${location.pathname}${location.searchStr ?? ""}`,
      auth_error: authError,
    },
  });
}

function redirectToProjectAccess(issuer: string | undefined): never {
  throw redirect({ href: new URL("/project-access", `${authWorkerOrigin(issuer)}/`).toString() });
}

function authWorkerOrigin(issuer: string | undefined) {
  if (issuer) {
    try {
      return new URL(issuer).origin;
    } catch {
      // Fall through to the production auth origin.
    }
  }
  return "https://auth.iterate.com";
}
