import { redirect } from "react-router";
import { eq, and } from "drizzle-orm";
import { WebClient } from "@slack/web-api";
import { waitUntil } from "../../env.ts";
import { GlobalLoading } from "../components/global-loading.tsx";
import { getDb } from "../../backend/db/client.ts";
import { getAuth } from "../../backend/auth/auth.ts";
import { getUserOrganizationsWithEstates } from "../../backend/trpc/trpc.ts";
import * as schema from "../../backend/db/schema.ts";
import { createUserOrganizationAndEstate } from "../../backend/org-utils.ts";
import { syncSlackUsersInBackground } from "../../backend/integrations/slack/slack.ts";
import { logger } from "../../backend/tag-logger.ts";
import type { EstateOnboardingState } from "../../types/estate-onboarding.ts";
import type { Route } from "./+types/redirect";
import { appendEstatePath } from "./append-estate-path.ts";

type EstatePathInput = {
  organizationId: string;
  estateId: string | null | undefined;
  onboardingId: string | null;
  onboardingState: EstateOnboardingState | null;
};

function getEstatePath({
  organizationId,
  estateId,
  onboardingId,
  onboardingState,
}: EstatePathInput) {
  if (!estateId) {
    return "/no-access";
  }

  if (onboardingId && onboardingState !== "completed") {
    return `/${organizationId}/${estateId}/onboarding`;
  }

  return `/${organizationId}/${estateId}`;
}

// Server-side business logic for determining where to redirect
async function determineRedirectPath(userId: string, cookieHeader: string | null) {
  const db = getDb();

  // Get user's estates from the database (excluding external orgs)
  const userOrganizations = await getUserOrganizationsWithEstates(db, userId);

  if (userOrganizations.length === 0) {
    // No organizations, do first time setup
    const user = await db.query.user.findFirst({
      where: eq(schema.user.id, userId),
    });
    if (!user) {
      throw new Error(`User ${userId} not found - this should never happen.`);
    }
    const newOrgAndEstate = await createUserOrganizationAndEstate(db, user);
    // If the user has a Slack bot account, automatically connect it to the new estate
    // and sync Slack users to the organization
    if (newOrgAndEstate.estate) {
      const estateId = newOrgAndEstate.estate.id;
      waitUntil(
        (async () => {
          const slackBotAccount = await db.query.account.findFirst({
            where: and(
              eq(schema.account.userId, userId),
              eq(schema.account.providerId, "slack-bot"),
            ),
          });

          if (slackBotAccount?.accessToken) {
            // Connect the bot account to the estate
            await db
              .insert(schema.estateAccountsPermissions)
              .values({
                accountId: slackBotAccount.id,
                estateId,
              })
              .onConflictDoNothing();

            // Get team info from Slack API to create provider-estate mapping
            try {
              const slackClient = new WebClient(slackBotAccount.accessToken);
              const authTest = await slackClient.auth.test();

              if (authTest.ok && authTest.team_id) {
                await db
                  .insert(schema.providerEstateMapping)
                  .values({
                    internalEstateId: estateId,
                    externalId: authTest.team_id,
                    providerId: "slack-bot",
                    providerMetadata: {
                      botUserId: slackBotAccount.accountId,
                      team: {
                        id: authTest.team_id,
                        name: authTest.team,
                      },
                    },
                  })
                  .onConflictDoUpdate({
                    target: [
                      schema.providerEstateMapping.providerId,
                      schema.providerEstateMapping.externalId,
                    ],
                    set: {
                      internalEstateId: estateId,
                      providerMetadata: {
                        botUserId: slackBotAccount.accountId,
                        team: {
                          id: authTest.team_id,
                          name: authTest.team,
                        },
                      },
                    },
                  });
              }
            } catch (error) {
              logger.error("Failed to create provider-estate mapping for Slack", error);
              // Continue even if this fails - the main thing is syncing users
            }

            // Sync Slack users to the organization
            await syncSlackUsersInBackground(db, slackBotAccount.accessToken, estateId);
            logger.info(`Auto-connected Slack bot to estate ${estateId} and synced users`);
          }
        })().catch((error) => {
          logger.error("Failed to auto-connect Slack bot to new estate", error);
        }),
      );
    }

    return getEstatePath({
      organizationId: newOrgAndEstate.organization.id,
      estateId: newOrgAndEstate.estate?.id,
      onboardingId: newOrgAndEstate.estate?.onboardingId ?? null,
      onboardingState: newOrgAndEstate.estate?.onboardingId ? "pending" : null,
    });
  }

  // Flatten estates from all organizations
  const userEstates = userOrganizations.flatMap(({ organization }) =>
    organization.estates.map((estate) => ({
      id: estate.id,
      name: estate.name,
      organizationId: estate.organizationId,
      onboardingId: estate.onboardingId ?? null,
      onboardingState: estate.onboarding?.state ?? null,
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
      return getEstatePath({
        organizationId: savedEstate.organizationId,
        estateId: savedEstate.estateId,
        onboardingId: validEstate.onboardingId ?? null,
        onboardingState: validEstate.onboardingState ?? null,
      });
    }
  }

  // No valid saved estate, use the first available estate
  const defaultEstate = userEstates[0];
  if (defaultEstate) {
    return getEstatePath({
      organizationId: defaultEstate.organizationId,
      estateId: defaultEstate.id,
      onboardingId: defaultEstate.onboardingId ?? null,
      onboardingState: defaultEstate.onboardingState ?? null,
    });
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
  let redirectPath = await determineRedirectPath(session.user.id, request.headers.get("Cookie"));

  if (redirectPath.match(/\/org_\w+\/est_\w+$/)) {
    const estatePath = new URL(request.url).searchParams.get("estate_path");
    if (estatePath) {
      redirectPath = appendEstatePath(redirectPath, estatePath);
    }
  }

  throw redirect(redirectPath);
}

// The component is minimal since all logic is in the loader
export default function RootRedirect() {
  // This should never render as the loader always redirects
  return <GlobalLoading />;
}
