import { redirect } from "@tanstack/react-router";
import { createServerFn, getGlobalStartContext } from "@tanstack/react-start";
import { getRequestUrl } from "@tanstack/react-start/server";
import { auth } from "@clerk/tanstack-react-start/server";
import { z } from "zod";
export type { ActiveOrganizationAuth } from "~/lib/active-organization-auth.ts";
export { normalizeActiveOrganizationAuth } from "~/lib/active-organization-auth.ts";
import { normalizeActiveOrganizationAuth } from "~/lib/active-organization-auth.ts";
import {
  normalizeRequestHostname,
  resolveProjectSlugFromHostname,
} from "~/lib/project-host-routing.ts";

const RouteAuthInput = z
  .object({
    organizationSlug: z.string().optional(),
  })
  .optional();

export const requireActiveOrganizationForRoute = createServerFn({ method: "GET" }).handler(
  async () => {
    const session = await auth();

    if (!session.isAuthenticated) {
      throw redirectToSignIn();
    }

    if (!session.orgId || !session.orgSlug) {
      throw redirect({ to: "/organization" });
    }

    return normalizeActiveOrganizationAuth(session);
  },
);

export const requireActiveOrganizationForOrgRoute = createServerFn({ method: "GET" })
  .inputValidator(RouteAuthInput)
  .handler(async ({ data }) => {
    const session = await auth();

    if (!session.isAuthenticated) {
      throw redirectToSignIn();
    }

    if (!session.orgId || !session.orgSlug) {
      throw redirect({ to: "/organization" });
    }

    if (data?.organizationSlug && session.orgSlug !== data.organizationSlug) {
      throw redirect({ to: "/organization" });
    }

    return normalizeActiveOrganizationAuth(session);
  });

export const requireSignedInForOrganizationRoute = createServerFn({ method: "GET" }).handler(
  async () => {
    const session = await auth();

    if (!session.isAuthenticated) {
      throw redirectToSignIn();
    }

    if (session.orgId && session.orgSlug) {
      throw redirect({
        to: "/orgs/$organizationSlug",
        params: { organizationSlug: session.orgSlug },
      });
    }

    return { userId: session.userId, sessionId: session.sessionId };
  },
);

export const redirectAuthenticatedUserFromAuthRoute = createServerFn({ method: "GET" }).handler(
  async () => {
    const session = await auth();

    if (!session.isAuthenticated) {
      return null;
    }

    if (!session.orgId || !session.orgSlug) {
      throw redirect({ to: "/organization" });
    }

    throw redirect({
      to: "/orgs/$organizationSlug",
      params: { organizationSlug: session.orgSlug },
    });
  },
);

export const requireAuthenticatedRootRedirectTarget = createServerFn({ method: "GET" }).handler(
  async () => {
    const session = await auth();

    if (!session.isAuthenticated) {
      throw redirectToSignIn();
    }

    if (!session.orgId || !session.orgSlug) {
      throw redirect({ to: "/organization" });
    }

    return {
      orgSlug: session.orgSlug,
      projectSlug: resolveCurrentProjectHostSlug(),
    };
  },
);

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

  // Clerk returns custom sign-in flows to `/` after authentication. For project
  // hosts, the root route must recover the project slug from the hostname so
  // `<project>.iterate-preview-N.app` lands directly in that project's app/OS.
  return (
    resolveProjectSlugFromHostname(requestHostname, context?.projectHostnameBases ?? []) ?? null
  );
}
