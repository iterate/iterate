import { eq, and } from "drizzle-orm";
import { WebClient } from "@slack/web-api";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { getRequestHeader, getRequestUrl } from "@tanstack/react-start/server";
import { waitUntil } from "../../env.ts";
import { getUserOrganizationsWithInstallations } from "../../backend/trpc/trpc.ts";
import * as schema from "../../backend/db/schema.ts";
import { createUserOrganizationAndInstallation } from "../../backend/org-utils.ts";
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
  // Get user's installations from the database (excluding external orgs)
  const userOrganizations = await getUserOrganizationsWithInstallations(db, userId);

  if (userOrganizations.length === 0) {
    // No organizations, do first time setup
    const user = await db.query.user.findFirst({
      where: eq(schema.user.id, userId),
    });
    if (!user) {
      throw new Error(`User ${userId} not found - this should never happen.`);
    }
    const newOrgAndInstallation = await createUserOrganizationAndInstallation(db, user);

    // If the user has a Slack bot account, automatically connect it to the new installation
    // and sync Slack users to the organization
    if (newOrgAndInstallation.installation) {
      const installationId = newOrgAndInstallation.installation.id;
      waitUntil(
        (async () => {
          const slackBotAccount = await db.query.account.findFirst({
            where: and(
              eq(schema.account.userId, userId),
              eq(schema.account.providerId, "slack-bot"),
            ),
          });

          if (slackBotAccount?.accessToken) {
            // Connect the bot account to the installation
            await db
              .insert(schema.installationAccountsPermissions)
              .values({
                accountId: slackBotAccount.id,
                installationId,
              })
              .onConflictDoNothing();

            // Get team info from Slack API to create provider-installation mapping
            let teamId: string | undefined;
            let appId: string | undefined;
            try {
              const slackClient = new WebClient(slackBotAccount.accessToken);
              const authTest = await slackClient.auth.test();

              if (authTest.ok && authTest.team_id) {
                teamId = authTest.team_id;

                // Get appId from any existing providerInstallationMapping for this team
                // (will exist if user has another installation with this Slack workspace already linked)
                const existingMapping = await db.query.providerInstallationMapping.findFirst({
                  where: and(
                    eq(schema.providerInstallationMapping.providerId, "slack-bot"),
                    eq(schema.providerInstallationMapping.externalId, authTest.team_id),
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
                  `[redirect.tsx] Creating providerInstallationMapping for installation ${installationId}, team ${authTest.team_id}, appId=${appId}, botUserId=${slackBotAccount.accountId}`,
                );

                await db
                  .insert(schema.providerInstallationMapping)
                  .values({
                    internalInstallationId: installationId,
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
                      schema.providerInstallationMapping.providerId,
                      schema.providerInstallationMapping.externalId,
                    ],
                    set: {
                      internalInstallationId: installationId,
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
                  `[redirect.tsx] Successfully stored providerInstallationMapping with appId=${appId}`,
                );
              }
            } catch (error) {
              logger.error("Failed to create provider-installation mapping for Slack", error);
              // Continue even if this fails - the main thing is syncing users
            }

            // Sync Slack users to the organization
            if (teamId) {
              await syncSlackUsersInBackground(
                db,
                slackBotAccount.accessToken,
                installationId,
                teamId,
              );
              logger.info(
                `Auto-connected Slack bot to installation ${installationId} and synced users`,
              );
            } else {
              logger.warn("Skipped syncing Slack users - no team ID available");
            }
          }
        })().catch((error) => {
          logger.error("Failed to auto-connect Slack bot to new installation", error);
        }),
      );
    }

    return `/${newOrgAndInstallation.organization.id}/${newOrgAndInstallation.installation?.id}`;
  }

  // Flatten installations from all organizations
  const userInstallations = userOrganizations.flatMap(({ organization }) =>
    organization.installations.map((installation) => ({
      id: installation.id,
      name: installation.name,
      organizationId: installation.organizationId,
      connectedRepoId: installation.sources.at(0)?.repoId ?? null,
      parentOrgName: organization.name,
    })),
  );

  if (userInstallations.length === 0) {
    throw new Response("You don't have access to any installations, this should never happen.", {
      status: 403,
    });
  }

  // Try to parse saved installation from cookie header
  let savedInstallation = null;
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

    const installationCookie = cookies["iterate-selected-installation"];
    if (installationCookie) {
      try {
        savedInstallation = JSON.parse(decodeURIComponent(installationCookie));
      } catch {
        // Invalid cookie, ignore
      }
    }
  }

  // If we have a saved installation, verify it's still valid
  if (savedInstallation) {
    const validInstallation = userInstallations.find(
      (e) =>
        e.id === savedInstallation.installationId &&
        e.organizationId === savedInstallation.organizationId,
    );

    if (validInstallation) {
      return `/${savedInstallation.organizationId}/${savedInstallation.installationId}`;
    }
  }

  // No valid saved installation, use the first available installation
  const defaultInstallation = userInstallations[0];
  if (defaultInstallation) {
    return `/${defaultInstallation.organizationId}/${defaultInstallation.id}`;
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

  if (redirectPath.match(/\/org_\w+\/inst_\w+$/)) {
    const installationPath = requestUrl.searchParams.get("installation_path");
    if (installationPath) {
      redirectPath = appendEstatePath(redirectPath, installationPath);
    }
  }

  throw redirect({
    to: redirectPath,
  });
});

export const Route = createFileRoute("/_auth.layout/")({
  beforeLoad: () => handleRedirect(),
});
