import { eq, asc } from "drizzle-orm";
import type { DB } from "./db/client.ts";
import * as schema from "./db/schema.ts";
import { getUserOrganizations } from "./trpc/trpc.ts";
import { hasBlockingOnboardingSteps } from "./onboarding-user-steps.ts";
import { createUserOrganizationAndEstate } from "./org-utils.ts";

/**
 * Centralized logic for determining where to redirect a user.
 * This is the single source of truth for user routing.
 *
 * Handles:
 * - Creating org/estate if user doesn't have one
 * - Checking for pending onboarding steps
 * - Routing to appropriate page
 */
export async function determineUserRedirect(
  db: DB,
  user: {
    id: string;
    email: string;
    name: string;
  },
): Promise<{
  redirect: string;
  shouldProcessOnboarding: boolean;
  estateId?: string;
}> {
  // Get user's organizations
  let userOrgs = await getUserOrganizations(db, user.id);

  // If no organizations, create one (this can happen if user was created
  // via admin endpoints or other flows that bypass normal signup)
  if (userOrgs.length === 0) {
    const { organization, estate } = await createUserOrganizationAndEstate(db, user);
    if (!estate) {
      return {
        redirect: "/no-access",
        shouldProcessOnboarding: false,
      };
    }
    // Refresh userOrgs after creation
    userOrgs = await getUserOrganizations(db, user.id);
  }

  // Get first organization and its estate
  const { organization } = userOrgs[0];
  const estate = await db.query.estate.findFirst({
    where: eq(schema.estate.organizationId, organization.id),
    orderBy: asc(schema.estate.createdAt),
  });

  if (!estate) {
    throw new Error(`Organization ${organization.id} has no estate`);
  }

  // Check for pending user onboarding steps
  const hasPendingSteps = await hasBlockingOnboardingSteps(db, estate.id);

  if (hasPendingSteps) {
    return {
      redirect: `/${organization.id}/${estate.id}/onboarding`,
      shouldProcessOnboarding: true,
      estateId: estate.id,
    };
  }

  // All onboarding complete, go to dashboard
  return {
    redirect: `/${organization.id}/${estate.id}`,
    shouldProcessOnboarding: true,
    estateId: estate.id,
  };
}

