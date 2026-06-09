import { redirect } from "@tanstack/react-router";
import type { PublicSessionResponse } from "@iterate-com/auth/client";
import { createUserPrincipal, type UserPrincipal } from "~/auth/principal.ts";

export type OrganizationRouteAuth = {
  authProjectAccessUrl: string | null;
  sessionId: string;
  userId: string;
};

export function requireOrganizationMemberForSession(
  session: PublicSessionResponse | null | undefined,
  location: { href: string },
) {
  const principal = requireUserPrincipalFromSession(session, location);
  if (principal.organizations.length === 0) {
    throw redirect({ to: "/organization" });
  }

  return null;
}

export function requireOrganizationRouteAccessForSession(
  session: PublicSessionResponse | null | undefined,
  location: { href: string },
  organizationSlug: string,
) {
  const principal = requireUserPrincipalFromSession(session, location);
  if (principal.organizations.length === 0) {
    throw redirect({ to: "/organization" });
  }

  if (!principal.organizations.some((organization) => organization.slug === organizationSlug)) {
    throw redirect({ to: "/projects" });
  }

  return null;
}

export function requireSignedInForOrganizationSession(
  session: PublicSessionResponse | null | undefined,
  location: { href: string },
  issuer: string | undefined,
): OrganizationRouteAuth {
  const principal = requireUserPrincipalFromSession(session, location);

  if (principal.organizations.length > 0) {
    throw redirect({ to: "/projects" });
  }

  const projectAccessUrl = issuer ? `${new URL(issuer).origin}/project-access` : null;
  if (projectAccessUrl) {
    throw redirect({ href: projectAccessUrl });
  }

  return {
    authProjectAccessUrl: projectAccessUrl,
    userId: principal.userId,
    sessionId: principal.sessionId ?? principal.userId,
  };
}

export function requireAuthenticatedRootRedirectTargetFromSession(
  session: PublicSessionResponse | null | undefined,
  location: { href: string },
  currentProjectHostSlug: string | null | undefined,
) {
  const principal = requireUserPrincipalFromSession(session, location);

  if (principal.organizations.length === 0) {
    throw redirect({ to: "/organization" });
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
    organizations: session.session.organizations,
    projects: session.session.projects,
  });
}

function requireUserPrincipalFromSession(
  session: PublicSessionResponse | null | undefined,
  location: { href: string },
): UserPrincipal {
  const principal = getUserPrincipalFromSession(session);
  if (!principal) {
    throw redirectToSignIn(location.href);
  }
  return principal;
}

function redirectToSignIn(redirectUrl?: string): never {
  throw redirect({
    to: "/sign-in/$",
    params: { _splat: "" },
    search: {
      redirect_url: redirectUrl ?? "/",
    },
  });
}
