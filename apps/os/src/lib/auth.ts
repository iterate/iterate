import { redirect } from "@tanstack/react-router";
import { createServerFn, getGlobalStartContext } from "@tanstack/react-start";
import { getRequestUrl } from "@tanstack/react-start/server";
import type { UserPrincipal } from "~/auth/principal.ts";
import {
  getUserOrganization,
  getUserPrincipal as getUserPrincipalFromPrincipal,
  normalizeActiveOrganizationAuth,
  withActiveOrganization,
} from "~/lib/active-organization-auth.ts";

export type { ActiveOrganizationAuth } from "~/lib/active-organization-auth.ts";
export { normalizeActiveOrganizationAuth } from "~/lib/active-organization-auth.ts";

export const requireActiveOrganizationForRoute = createServerFn({ method: "GET" }).handler(
  async () => {
    const principal = requireUserPrincipal();

    const activePrincipal = withActiveOrganization(principal);
    if (!activePrincipal) {
      redirectToProjectAccess();
    }

    return normalizeActiveOrganizationAuth(activePrincipal);
  },
);

export const redirectAuthenticatedUserFromAuthRoute = createServerFn({ method: "GET" }).handler(
  async () => {
    const principal = getUserPrincipal();
    if (!principal) {
      return null;
    }

    const organization = getUserOrganization(principal);
    if (!organization) {
      redirectToProjectAccess();
    }

    throw redirect({
      to: "/projects",
    });
  },
);

export const requireAuthenticatedRootRedirectTarget = createServerFn({ method: "GET" }).handler(
  async () => {
    const principal = requireUserPrincipal();
    const organization = getUserOrganization(principal);

    if (!organization) {
      redirectToProjectAccess();
    }

    return null;
  },
);

function getUserPrincipal(): UserPrincipal | null {
  return getUserPrincipalFromPrincipal(getGlobalStartContext()?.principal);
}

function requireUserPrincipal(): UserPrincipal {
  const principal = getUserPrincipal();
  if (!principal) {
    throw redirectToSignIn();
  }
  return principal;
}

function redirectToSignIn(): never {
  const request = getRequestUrl();
  throw redirect({
    to: "/sign-in/$",
    params: { _splat: "" },
    search: {
      redirect_url: request.pathname + request.search,
    },
  });
}

function redirectToProjectAccess(): never {
  throw redirect({ href: authWorkerUrl("/project-access") });
}

function authWorkerUrl(path: string) {
  const origin = authWorkerOrigin();
  return new URL(path, `${origin}/`).toString();
}

function authWorkerOrigin() {
  const issuer = getGlobalStartContext()?.config.iterateAuth?.issuer;
  if (issuer) {
    try {
      return new URL(issuer).origin;
    } catch {
      // Fall through to the production auth origin.
    }
  }
  return "https://auth.iterate.com";
}
