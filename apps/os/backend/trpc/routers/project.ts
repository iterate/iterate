import { z } from "zod/v4";
import { eq, and } from "drizzle-orm";
import * as arctic from "arctic";
import {
  ORPCError,
  protectedProcedure,
  orgProtectedProcedure,
  projectProtectedProcedure,
  projectProtectedMutation,
  withProjectMutationInput,
  withOrgAdminMutationInput,
} from "../trpc.ts";
import { project, verification, projectRepo, projectConnection } from "../../db/schema.ts";
import * as schema from "../../db/schema.ts";
import { slugify, slugifyWithSuffix } from "../../utils/slug.ts";
import {
  listInstallationRepositories,
  deleteGitHubInstallation,
} from "../../integrations/github/github.ts";
import { revokeSlackToken, SLACK_BOT_SCOPES } from "../../integrations/slack/slack.ts";
import { decrypt } from "../../utils/encryption.ts";

export const projectRouter = {
  // Get minimal project info by ID (for conflict resolution, no org access required)
  // Returns just enough info to display the project/org names and slugs
  getProjectInfoById: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .handler(async ({ context, input }) => {
      const proj = await context.db.query.project.findFirst({
        where: eq(project.id, input.projectId),
        with: { organization: true },
      });

      if (!proj) {
        throw new ORPCError("NOT_FOUND", {
          message: "Project not found",
        });
      }

      return {
        id: proj.id,
        name: proj.name,
        slug: proj.slug,
        organizationName: proj.organization.name,
        organizationSlug: proj.organization.slug,
      };
    }),

  // List projects in organization
  list: orgProtectedProcedure.handler(async ({ context }) => {
    const projects = await context.db.query.project.findMany({
      where: eq(project.organizationId, context.organization.id),
      orderBy: (proj, { desc }) => [desc(proj.createdAt)],
    });

    return projects;
  }),

  // Get project by slug
  bySlug: projectProtectedProcedure.handler(async ({ context }) => {
    return context.project;
  }),

  create: withOrgAdminMutationInput({
    name: z.string().min(1).max(100),
  }).handler(async ({ context, input }) => {
    const baseSlug = slugify(input.name);
    const existing = await context.db.query.project.findFirst({
      where: and(eq(project.organizationId, context.organization.id), eq(project.slug, baseSlug)),
    });

    const slug = existing ? slugifyWithSuffix(input.name) : baseSlug;

    const [newProject] = await context.db
      .insert(project)
      .values({ name: input.name, slug, organizationId: context.organization.id })
      .returning();

    if (!newProject) {
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: "Failed to create project",
      });
    }

    return newProject;
  }),

  // Update project settings
  update: withProjectMutationInput({
    name: z.string().min(1).max(100).optional(),
  }).handler(async ({ context, input }) => {
    const [updated] = await context.db
      .update(project)
      .set({
        ...(input.name && { name: input.name }),
      })
      .where(eq(project.id, context.project.id))
      .returning();

    return updated;
  }),

  // Delete project
  delete: projectProtectedMutation.handler(async ({ context }) => {
    // Check if this is the last project in the organization
    const projectCount = await context.db.query.project.findMany({
      where: eq(project.organizationId, context.organization.id),
    });

    if (projectCount.length <= 1) {
      throw new ORPCError("FORBIDDEN", {
        message: "Cannot delete the last project in an organization",
      });
    }

    await context.db.delete(project).where(eq(project.id, context.project.id));

    return { success: true };
  }),

  // Start GitHub App installation flow
  startGithubInstallFlow: withProjectMutationInput({
    callbackURL: z.string().optional(),
  }).handler(async ({ context, input }) => {
    const state = arctic.generateState();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    const redirectUri = `${context.env.VITE_PUBLIC_URL}/api/integrations/github/callback`;
    const data = JSON.stringify({
      userId: context.user.id,
      projectId: context.project.id,
      redirectUri,
      callbackURL: input.callbackURL,
    });

    await context.db.insert(verification).values({
      identifier: state,
      value: data,
      expiresAt,
    });

    const installationUrl = `https://github.com/apps/${context.env.GITHUB_APP_SLUG}/installations/new?state=${state}`;

    return { installationUrl };
  }),

  // List available GitHub repos from connected installation
  listAvailableGithubRepos: projectProtectedProcedure.handler(async ({ context }) => {
    const connection = context.project.connections.find((c) => c.provider === "github-app");

    if (!connection) {
      return { connected: false as const, repositories: [] };
    }

    const providerData = connection.providerData as {
      installationId: number;
      encryptedAccessToken: string;
    };

    try {
      const accessToken = await decrypt(providerData.encryptedAccessToken);
      const repositories = await listInstallationRepositories(
        accessToken,
        providerData.installationId,
      );

      return { connected: true as const, repositories };
    } catch (error) {
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: "Failed to fetch repositories from GitHub",
        cause: error,
      });
    }
  }),

  listProjectRepos: projectProtectedProcedure.handler(async ({ context }) => {
    return context.project.projectRepos;
  }),

  addProjectRepo: withProjectMutationInput({
    repoId: z.number(),
    owner: z.string(),
    name: z.string(),
    defaultBranch: z.string().default("main"),
  }).handler(async ({ context, input }) => {
    const existingRepo = await context.db.query.projectRepo.findFirst({
      where: and(
        eq(projectRepo.projectId, context.project.id),
        eq(projectRepo.owner, input.owner),
        eq(projectRepo.name, input.name),
      ),
    });

    if (existingRepo) {
      await context.db
        .update(projectRepo)
        .set({
          externalId: input.repoId.toString(),
          defaultBranch: input.defaultBranch,
        })
        .where(eq(projectRepo.id, existingRepo.id));
    } else {
      await context.db.insert(projectRepo).values({
        projectId: context.project.id,
        provider: "github",
        externalId: input.repoId.toString(),
        owner: input.owner,
        name: input.name,
        defaultBranch: input.defaultBranch,
      });
    }

    return { success: true };
  }),

  removeProjectRepo: withProjectMutationInput({
    repoId: z.string(),
  }).handler(async ({ context, input }) => {
    await context.db
      .delete(projectRepo)
      .where(and(eq(projectRepo.projectId, context.project.id), eq(projectRepo.id, input.repoId)));

    return { success: true };
  }),

  // Get GitHub connection status
  getGithubConnection: projectProtectedProcedure.handler(async ({ context }) => {
    const connection = context.project.connections.find((c) => c.provider === "github-app");
    return {
      connected: !!connection,
      installationId: connection
        ? (connection.providerData as { installationId?: number }).installationId
        : null,
    };
  }),

  // Disconnect GitHub (removes connection and repo, revokes installation)
  disconnectGithub: projectProtectedMutation.handler(async ({ context }) => {
    const connection = context.project.connections.find((c) => c.provider === "github-app");
    const installationId = connection
      ? (connection.providerData as { installationId?: number }).installationId
      : null;

    if (installationId) {
      const githubUninstalled = await deleteGitHubInstallation(context.env, installationId);
      if (!githubUninstalled) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message:
            "Failed to revoke GitHub App installation. Please try again or remove it manually from GitHub Settings.",
        });
      }
    }

    await context.db.transaction(async (tx) => {
      await tx
        .delete(schema.projectConnection)
        .where(
          and(
            eq(projectConnection.projectId, context.project.id),
            eq(projectConnection.provider, "github-app"),
          ),
        );

      await tx.delete(schema.projectRepo).where(eq(projectRepo.projectId, context.project.id));
    });

    return { success: true };
  }),

  // Start Slack OAuth flow
  startSlackOAuthFlow: withProjectMutationInput({
    callbackURL: z.string().optional(),
  }).handler(async ({ context, input }) => {
    const state = arctic.generateState();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    const data = JSON.stringify({
      userId: context.user.id,
      projectId: context.project.id,
      callbackURL: input.callbackURL,
    });

    await context.db.insert(verification).values({
      identifier: state,
      value: data,
      expiresAt,
    });

    // Build Slack OAuth v2 URL manually
    // arctic.Slack uses OpenID Connect endpoint which only supports user auth scopes
    // For bot scopes, we need /oauth/v2/authorize
    const redirectUri = `${context.env.VITE_PUBLIC_URL}/api/integrations/slack/callback`;
    const authorizationUrl = new URL("https://slack.com/oauth/v2/authorize");
    authorizationUrl.searchParams.set("client_id", context.env.SLACK_CLIENT_ID);
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));

    return { authorizationUrl: authorizationUrl.toString() };
  }),

  // Get Slack connection status
  getSlackConnection: projectProtectedProcedure.handler(async ({ context }) => {
    const connection = context.project.connections.find((c) => c.provider === "slack");
    const providerData = connection?.providerData as {
      teamId?: string;
      teamName?: string;
      teamDomain?: string;
    } | null;

    return {
      connected: !!connection,
      teamId: providerData?.teamId ?? null,
      teamName: providerData?.teamName ?? null,
      teamDomain: providerData?.teamDomain ?? null,
    };
  }),

  // Disconnect Slack
  disconnectSlack: projectProtectedMutation.handler(async ({ context }) => {
    const connection = context.project.connections.find((c) => c.provider === "slack");

    if (!connection) {
      throw new ORPCError("NOT_FOUND", {
        message: "No Slack connection found for this project",
      });
    }

    // Revoke the Slack token (best effort - don't fail disconnect if revocation fails)
    const providerData = connection.providerData as { encryptedAccessToken?: string };
    if (providerData.encryptedAccessToken) {
      try {
        const accessToken = await decrypt(providerData.encryptedAccessToken);
        await revokeSlackToken(accessToken);
      } catch {
        // Token revocation failed, but we still delete the connection
      }
    }

    await context.db
      .delete(schema.projectConnection)
      .where(
        and(
          eq(projectConnection.projectId, context.project.id),
          eq(projectConnection.provider, "slack"),
        ),
      );

    return { success: true };
  }),

  // Transfer Slack connection from one project to another
  // Used when a Slack workspace is already connected elsewhere and user wants to switch
  transferSlackConnection: withProjectMutationInput({
    slackTeamId: z.string(),
  }).handler(async ({ context, input }) => {
    // Find existing connection by Slack team ID
    const existingConnection = await context.db.query.projectConnection.findFirst({
      where: and(
        eq(projectConnection.provider, "slack"),
        eq(projectConnection.externalId, input.slackTeamId),
      ),
      with: { project: { with: { organization: true } } },
    });

    if (!existingConnection) {
      throw new ORPCError("NOT_FOUND", {
        message: "Slack workspace connection not found",
      });
    }

    // TODO: In the future, we may want to verify user has access to both projects.
    // For now, if the user has a valid Slack authorization (they authorized the bot
    // for this workspace), we trust that's sufficient permission to move the connection.

    // Check if target project already has a Slack connection
    const targetProjectConnection = context.project.connections.find((c) => c.provider === "slack");
    if (targetProjectConnection) {
      throw new ORPCError("CONFLICT", {
        message: "Target project already has a Slack connection. Disconnect it first.",
      });
    }

    // Transfer the connection to the new project
    await context.db
      .update(projectConnection)
      .set({
        projectId: context.project.id,
      })
      .where(eq(projectConnection.id, existingConnection.id));

    return {
      success: true,
      previousProjectSlug: existingConnection.project?.slug,
      previousOrgSlug: existingConnection.project?.organization?.slug,
    };
  }),
};
