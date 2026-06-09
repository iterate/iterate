import { redirect } from "@tanstack/react-router";
import { createServerFn, getGlobalStartContext } from "@tanstack/react-start";
import { getRequestUrl } from "@tanstack/react-start/server";
import { z } from "zod";
import type { UserPrincipal } from "~/auth/principal.ts";
import {
  getUserOrganization,
  getUserPrincipal as getUserPrincipalFromPrincipal,
  normalizeActiveOrganizationAuth,
  withActiveOrganization,
} from "~/lib/active-organization-auth.ts";
import {
  normalizeRequestHostname,
  resolveProjectSlugFromHostname,
} from "~/lib/project-host-routing.ts";

export type { ActiveOrganizationAuth } from "~/lib/active-organization-auth.ts";
export { normalizeActiveOrganizationAuth } from "~/lib/active-organization-auth.ts";

export type OrganizationRouteAuth = {
  authProjectAccessUrl: string | null;
  sessionId: string;
  userId: string;
};

const RouteAuthInput = z
  .object({
    organizationSlug: z.string().optional(),
  })
  .optional();

export const requireActiveOrganizationForRoute = createServerFn({ method: "GET" }).handler(
  async () => {
    const principal = requireUserPrincipal();

    const activePrincipal = withActiveOrganization(principal);
    if (!activePrincipal) {
      throw redirect({ to: "/organization" });
    }

    return normalizeActiveOrganizationAuth(activePrincipal);
  },
);

export const requireActiveOrganizationForOrgRoute = createServerFn({ method: "GET" })
  .inputValidator(RouteAuthInput)
  .handler(async ({ data }) => {
    const principal = requireUserPrincipal();
    const activePrincipal = withActiveOrganization(principal, data?.organizationSlug);

    if (!activePrincipal) {
      throw redirect({ to: "/organization" });
    }

    return normalizeActiveOrganizationAuth(activePrincipal);
  });

export const requireSignedInForOrganizationRoute = createServerFn({ method: "GET" }).handler(
  async (): Promise<OrganizationRouteAuth> => {
    const principal = requireUserPrincipal();
    const organization = getUserOrganization(principal);

    if (organization) {
      throw redirect({
        to: "/org/$organizationSlug",
        params: { organizationSlug: organization.slug },
      });
    }

    const projectAccessUrl = getAuthProjectAccessUrl();
    if (projectAccessUrl) {
      throw redirect({ href: projectAccessUrl });
    }

    return {
      authProjectAccessUrl: projectAccessUrl,
      userId: principal.userId,
      sessionId: principal.sessionId ?? principal.userId,
    };
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
      throw redirect({ to: "/organization" });
    }

    throw redirect({
      to: "/org/$organizationSlug",
      params: { organizationSlug: organization.slug },
    });
  },
);

export const requireAuthenticatedRootRedirectTarget = createServerFn({ method: "GET" }).handler(
  async () => {
    const principal = requireUserPrincipal();
    const organization = getUserOrganization(principal);

    if (!organization) {
      throw redirect({ to: "/organization" });
    }

    return {
      orgSlug: organization.slug,
      projectSlug: resolveCurrentProjectHostSlug(),
    };
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

function resolveCurrentProjectHostSlug() {
  const context = getGlobalStartContext();
  const requestUrl = getRequestUrl();
  const dashboardHostname = context?.config.baseUrl
    ? normalizeRequestHostname(new URL(context.config.baseUrl).hostname)
    : null;
  const requestHostname = normalizeRequestHostname(requestUrl.hostname);
  if (dashboardHostname && requestHostname === dashboardHostname) return null;

  // Auth redirects can land at `/` after authentication. For project hosts, the
  // root route must recover the project slug from the hostname so
  // `<project>.iterate-preview-N.app` lands directly in that project's app/OS.
  return (
    resolveProjectSlugFromHostname(requestHostname, context?.projectHostnameBases ?? []) ?? null
  );
}

function getAuthProjectAccessUrl() {
  const issuer = getGlobalStartContext()?.config.iterateAuth?.issuer;
  return issuer ? `${new URL(issuer).origin}/project-access` : null;
}
