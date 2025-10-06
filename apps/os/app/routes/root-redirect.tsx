import { redirect } from "react-router";
import { eq } from "drizzle-orm";
import { waitUntil } from "cloudflare:workers";
import { GlobalLoading } from "../components/global-loading.tsx";
import { getDb } from "../../backend/db/client.ts";
import { getAuth } from "../../backend/auth/auth.ts";
import * as schema from "../../backend/db/schema.ts";
import { createUserOrganizationAndEstate } from "../../backend/org-utils.ts";
import { createStripeCustomerAndSubscriptionForOrganization } from "../../backend/integrations/stripe/stripe.ts";
import type { Route } from "./+types/root-redirect";

// Server-side business logic for determining where to redirect
async function determineRedirectPath(userId: string, cookieHeader: string | null) {
  const db = getDb();

  // Get user's estates from the database
  const userOrganizations = await db.query.organizationUserMembership.findMany({
    where: eq(schema.organizationUserMembership.userId, userId),
    with: {
      organization: {
        with: {
          estates: true,
        },
      },
    },
  });

  if (userOrganizations.length === 0) {
    // No organizations, do first time setup
    const user = await db.query.user.findFirst({
      where: eq(schema.user.id, userId),
    });
    if (!user) {
      throw new Error(`User ${userId} not found - this should never happen.`);
    }
    const newOrgAndEstate = await createUserOrganizationAndEstate(db, userId, user.name);
    waitUntil(
      createStripeCustomerAndSubscriptionForOrganization(
        db,
        newOrgAndEstate.organization,
        user,
      ).catch(() => {
        // Error is already logged in the helper function
      }),
    );

    return `/${newOrgAndEstate.organization.id}/${newOrgAndEstate.estate?.id}`;
  }

  // Flatten estates from all organizations
  const userEstates = userOrganizations.flatMap(({ organization }) =>
    organization.estates.map((estate) => ({
      id: estate.id,
      name: estate.name,
      organizationId: estate.organizationId,
    })),
  );

  // If user has no estates, redirect to no-access page
  if (userEstates.length === 0) {
    return "/no-access";
  }

  // Try to parse saved estate from cookie header
  let savedEstate = null;
  if (cookieHeader) {
    const cookies = cookieHeader.split(";").reduce(
      (acc, cookie) => {
        const [key, value] = cookie.trim().split("=");
        if (key) {
          acc[key] = value;
        }
        return acc;
      },
      {} as Record<string, string>,
    );

    const estateCookie = cookies["iterate-selected-estate"];
    if (estateCookie) {
      try {
        savedEstate = JSON.parse(decodeURIComponent(estateCookie));
      } catch {
        // Invalid cookie, ignore
      }
    }
  }

  // If we have a saved estate, verify it's still valid
  if (savedEstate) {
    const validEstate = userEstates.find(
      (e) => e.id === savedEstate.estateId && e.organizationId === savedEstate.organizationId,
    );

    if (validEstate) {
      return `/${savedEstate.organizationId}/${savedEstate.estateId}`;
    }
  }

  // No valid saved estate, use the first available estate
  const defaultEstate = userEstates[0];
  if (defaultEstate) {
    return `/${defaultEstate.organizationId}/${defaultEstate.id}`;
  }

  // Fallback (shouldn't happen)
  return "/no-access";
}

// Server-side loader that handles all the redirect logic
export async function loader({ request }: Route.LoaderArgs) {
  // Get the database and auth instances
  const db = getDb();
  const auth = getAuth(db);

  // Get session using Better Auth's getSession with the request headers
  const session = await auth.api.getSession({
    headers: request.headers,
  });

  if (!session?.user?.id) {
    throw redirect("/login");
  }

  // Determine where to redirect based on user's estates
  const redirectPath = await determineRedirectPath(session.user.id, request.headers.get("Cookie"));

  throw redirect(redirectPath);
}

// The component is minimal since all logic is in the loader
export default function RootRedirect() {
  // This should never render as the loader always redirects
  return <GlobalLoading />;
}
