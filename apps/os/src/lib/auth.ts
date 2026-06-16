import { redirect } from "@tanstack/react-router";
import type { PublicSessionResponse } from "@iterate-com/auth/client";
import { createUserPrincipal, type UserPrincipal } from "~/auth/principal.ts";

type RouteLocation = {
  pathname: string;
  searchStr?: string;
};

export function requireOrganizationMemberForSession(
  session: PublicSessionResponse | null | undefined,
  location: RouteLocation,
  issuer: string | undefined,
) {
  const principal = requireUserPrincipalFromSession(session, location);
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
) {
  const principal = requireUserPrincipalFromSession(session, location);

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
): UserPrincipal {
  const principal = getUserPrincipalFromSession(session);
  if (!principal) {
    throw redirectToSignIn(location);
  }
  return principal;
}

function redirectToSignIn(location: RouteLocation): never {
  throw redirect({
    to: "/sign-in/$",
    params: { _splat: "" },
    search: {
      // The sign-in page only accepts same-origin relative paths, so pass
      // pathname + search rather than a full href.
      redirect_url: `${location.pathname}${location.searchStr ?? ""}`,
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
