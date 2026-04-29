import { redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { auth } from "@clerk/tanstack-react-start/server";
import type { ClerkAuth } from "~/context.ts";

export interface ActiveOrganizationAuth {
  userId: string;
  sessionId: string;
  orgId: string;
  orgRole: string | null;
  orgSlug: string | null;
  orgPermissions: string[];
}

export const requireActiveOrganizationForRoute = createServerFn({ method: "GET" }).handler(
  async () => {
    const session = await auth();

    if (!session.isAuthenticated) {
      throw redirect({ to: "/sign-in" });
    }

    if (!session.orgId) {
      throw redirect({ to: "/organization" });
    }

    return normalizeActiveOrganizationAuth(session);
  },
);

export const requireSignedInForOrganizationRoute = createServerFn({ method: "GET" }).handler(
  async () => {
    const session = await auth();

    if (!session.isAuthenticated) {
      throw redirect({ to: "/sign-in" });
    }

    if (session.orgId) {
      throw redirect({ to: "/" });
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

    if (!session.orgId) {
      throw redirect({ to: "/organization" });
    }

    throw redirect({ to: "/" });
  },
);

export function normalizeActiveOrganizationAuth(session: ClerkAuth): ActiveOrganizationAuth {
  if (!session.isAuthenticated || !session.orgId) {
    throw new Error("Expected authenticated Clerk session with active organization.");
  }

  return {
    userId: session.userId,
    sessionId: session.sessionId,
    orgId: session.orgId,
    orgRole: session.orgRole ?? null,
    orgSlug: session.orgSlug ?? null,
    orgPermissions: session.orgPermissions ?? [],
  };
}
