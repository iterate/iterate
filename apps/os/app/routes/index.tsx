import { eq, and } from "drizzle-orm";
import { WebClient } from "@slack/web-api";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { getRequestHeader, getRequestUrl } from "@tanstack/react-start/server";
import { waitUntil } from "../../env.ts";
import { getUserOrganizationsWithEstates } from "../../backend/trpc/trpc.ts";
import * as schema from "../../backend/db/schema.ts";
import {
  createGithubRepoInEstatePool,
  createUserOrganizationAndEstate,
} from "../../backend/org-utils.ts";
import { syncSlackUsersInBackground } from "../../backend/integrations/slack/slack.ts";
import { logger } from "../../backend/tag-logger.ts";
import type { DB } from "../../backend/db/client.ts";
import { authenticatedServerFn } from "../lib/auth-middleware.ts";
import { appendEstatePath } from "./append-estate-path.ts";

// Server-side business logic for determining where to redirect
async function determineRedirectPath({
  userId,
  cookieHeader,
  db,
}: {
  userId: string;
  cookieHeader?: string;
  db: DB;
}) {
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
            let teamId: string | undefined;
            let appId: string | undefined;
            try {
              const slackClient = new WebClient(slackBotAccount.accessToken);
              const authTest = await slackClient.auth.test();

              if (authTest.ok && authTest.team_id) {
                teamId = authTest.team_id;

                // Get appId from any existing providerEstateMapping for this team
                // (will exist if user has another estate with this Slack workspace already linked)
                const existingMapping = await db.query.providerEstateMapping.findFirst({
                  where: and(
                    eq(schema.providerEstateMapping.providerId, "slack-bot"),
                    eq(schema.providerEstateMapping.externalId, authTest.team_id),
                  ),
                });

                if (existingMapping) {
                  const existingMetadata = existingMapping.providerMetadata as { appId?: string };
                  appId = existingMetadata?.appId;
                  logger.info(
                    `[redirect.tsx] Found existing mapping with appId=${appId} for team ${authTest.team_id}`,
                  );
                } else {
                  logger.info(
                    `[redirect.tsx] No existing mapping found for team ${authTest.team_id}, appId will be undefined`,
                  );
                }

                logger.info(
                  `[redirect.tsx] Creating providerEstateMapping for estate ${estateId}, team ${authTest.team_id}, appId=${appId}, botUserId=${slackBotAccount.accountId}`,
                );

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
                      appId, // Include appId for cross-workspace bot matching
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
                        appId, // Include appId for cross-workspace bot matching
                      },
                    },
                  });

                logger.info(
                  `[redirect.tsx] Successfully stored providerEstateMapping with appId=${appId}`,
                );
              }
            } catch (error) {
              logger.error("Failed to create provider-estate mapping for Slack", error);
              // Continue even if this fails - the main thing is syncing users
            }

            // Sync Slack users to the organization
            if (teamId) {
              await syncSlackUsersInBackground(db, slackBotAccount.accessToken, estateId, teamId);
              logger.info(`Auto-connected Slack bot to estate ${estateId} and synced users`);
            } else {
              logger.warn("Skipped syncing Slack users - no team ID available");
            }
          }
        })().catch((error) => {
          logger.error("Failed to auto-connect Slack bot to new estate", error);
        }),
      );
    }

    return `/${newOrgAndEstate.organization.id}/${newOrgAndEstate.estate?.id}`;
  }

  // Flatten estates from all organizations
  const userEstates = userOrganizations.flatMap(({ organization }) =>
    organization.estates.map((estate) => ({
      id: estate.id,
      name: estate.name,
      organizationId: estate.organizationId,
      connectedRepoId: estate.connectedRepoId,
      parentOrgName: organization.name,
    })),
  );

  // If any estate has no connected repo, create one in the estate pool
  await Promise.allSettled(
    userEstates
      .filter((estate) => !estate.connectedRepoId)
      .map(async (estate) => {
        const repo = await createGithubRepoInEstatePool({
          organizationName: estate.parentOrgName,
          organizationId: estate.organizationId,
        }).catch((error) => {
          logger.error("Failed to create Github repo in estate pool", {
            estateId: estate.id,
            error,
          });
          return null;
        });
        if (repo) {
          await db
            .update(schema.estate)
            .set({
              connectedRepoId: repo.id,
              connectedRepoRef: repo.default_branch,
              connectedRepoPath: `/`,
            })
            .where(eq(schema.estate.id, estate.id));
        }
      }),
  );

  // If user has no estates, throw a 403 response
  if (userEstates.length === 0) {
    throw new Response("You don't have access to any estates, this should never happen.", {
      status: 403,
    });
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
  throw new Error("Failed to determine redirect path, please contact support if this persists.");
}

const handleRedirect = authenticatedServerFn.handler(async ({ context }) => {
  const { session, db } = context.variables;

  const cookies = getRequestHeader("Cookie");

  let redirectPath = await determineRedirectPath({
    userId: session.user.id,
    cookieHeader: cookies,
    db,
  });

  const requestUrl = getRequestUrl();

  if (redirectPath.match(/\/org_\w+\/est_\w+$/)) {
    const estatePath = requestUrl.searchParams.get("estate_path");
    if (estatePath) {
      redirectPath = appendEstatePath(redirectPath, estatePath);
    }
  }

  throw redirect({
    to: redirectPath,
  });
});

export const Route = createFileRoute("/_auth.layout/")({
  beforeLoad: () => handleRedirect(),
});
