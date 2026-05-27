import { redirect } from "@tanstack/react-router";
import { createServerFn, getGlobalStartContext } from "@tanstack/react-start";
import { getRequestUrl } from "@tanstack/react-start/server";
import { z } from "zod";
import type { UserPrincipal } from "~/auth/principal.ts";
import { normalizeActiveOrganizationAuth } from "~/lib/active-organization-auth.ts";
import {
  normalizeRequestHostname,
  resolveProjectSlugFromHostname,
} from "~/lib/project-host-routing.ts";

export type { ActiveOrganizationAuth } from "~/lib/active-organization-auth.ts";
export { normalizeActiveOrganizationAuth } from "~/lib/active-organization-auth.ts";

const RouteAuthInput = z
  .object({
    organizationSlug: z.string().optional(),
  })
  .optional();

export const requireActiveOrganizationForRoute = createServerFn({ method: "GET" }).handler(
  async () => {
    const principal = requireUserPrincipal();

    if (principal.organizations.length === 0) {
      throw redirect({ to: "/organization" });
    }

    return normalizeActiveOrganizationAuth(principal);
  },
);

export const requireActiveOrganizationForOrgRoute = createServerFn({ method: "GET" })
  .inputValidator(RouteAuthInput)
  .handler(async ({ data }) => {
    const principal = requireUserPrincipal();
    const organization = data?.organizationSlug
      ? principal.organizations.find((org) => org.slug === data.organizationSlug)
      : principal.organizations[0];

    if (!organization) {
      throw redirect({ to: "/organization" });
    }

    return normalizeActiveOrganizationAuth({
      ...principal,
      organizations: [
        organization,
        ...principal.organizations.filter((org) => org !== organization),
      ],
    });
  });

export const requireSignedInForOrganizationRoute = createServerFn({ method: "GET" }).handler(
  async () => {
    const principal = requireUserPrincipal();
    const organization = principal.organizations[0];

    if (organization) {
      throw redirect({
        to: "/org/$organizationSlug",
        params: { organizationSlug: organization.slug },
      });
    }

    return { userId: principal.userId, sessionId: principal.sessionId ?? principal.userId };
  },
);

export const redirectAuthenticatedUserFromAuthRoute = createServerFn({ method: "GET" }).handler(
  async () => {
    const principal = getUserPrincipal();
    if (!principal) {
      return null;
    }

    const organization = principal.organizations[0];
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
    const organization = principal.organizations[0];

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
  const principal = getGlobalStartContext()?.principal;
  return principal?.type === "user" ? principal : null;
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
    to: "/sign-in",
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
