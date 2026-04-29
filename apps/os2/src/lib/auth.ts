import { redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequestUrl } from "@tanstack/react-start/server";
import { auth } from "@clerk/tanstack-react-start/server";
import { z } from "zod";
import type { ClerkAuth } from "~/context.ts";

export interface ActiveOrganizationAuth {
  userId: string;
  sessionId: string;
  orgId: string;
  orgRole: string | null;
  orgSlug: string;
  orgPermissions: string[];
}

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

export function normalizeActiveOrganizationAuth(session: ClerkAuth): ActiveOrganizationAuth {
  if (!session.isAuthenticated || !session.orgId || !session.orgSlug) {
    throw new Error("Expected authenticated Clerk session with active organization.");
  }

  return {
    userId: session.userId,
    sessionId: session.sessionId,
    orgId: session.orgId,
    orgRole: session.orgRole ?? null,
    orgSlug: session.orgSlug,
    orgPermissions: session.orgPermissions ?? [],
  };
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
