import { z } from "zod/v4";
import { eq, and } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import * as arctic from "arctic";
import {
  router,
  orgProtectedProcedure,
  projectProtectedProcedure,
  orgAdminMutation,
  projectProtectedMutation,
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

export const projectRouter = router({
  // List projects in organization
  list: orgProtectedProcedure.query(async ({ ctx }) => {
    const projects = await ctx.db.query.project.findMany({
      where: eq(project.organizationId, ctx.organization.id),
      orderBy: (proj, { desc }) => [desc(proj.createdAt)],
    });

    return projects;
  }),

  // Get project by slug
  bySlug: projectProtectedProcedure.query(async ({ ctx }) => {
    return ctx.project;
  }),

  create: orgAdminMutation
    .input(
      z.object({
        name: z.string().min(1).max(100),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const baseSlug = slugify(input.name);
      const existing = await ctx.db.query.project.findFirst({
        where: and(eq(project.organizationId, ctx.organization.id), eq(project.slug, baseSlug)),
      });

      const slug = existing ? slugifyWithSuffix(input.name) : baseSlug;

      const [newProject] = await ctx.db
        .insert(project)
        .values({
          name: input.name,
          slug,
          organizationId: ctx.organization.id,
        })
        .returning();

      if (!newProject) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create project",
        });
      }

      return newProject;
    }),

  // Update project settings
  update: projectProtectedMutation
    .input(
      z.object({
        name: z.string().min(1).max(100).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(project)
        .set({
          ...(input.name && { name: input.name }),
        })
        .where(eq(project.id, ctx.project.id))
        .returning();

      return updated;
    }),

  // Delete project
  delete: projectProtectedMutation.mutation(async ({ ctx }) => {
    // Check if this is the last project in the organization
    const projectCount = await ctx.db.query.project.findMany({
      where: eq(project.organizationId, ctx.organization.id),
    });

    if (projectCount.length <= 1) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Cannot delete the last project in an organization",
      });
    }

    await ctx.db.delete(project).where(eq(project.id, ctx.project.id));

    return { success: true };
  }),

  // Start GitHub App installation flow
  startGithubInstallFlow: projectProtectedMutation
    .input(
      z.object({
        callbackURL: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const state = arctic.generateState();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

      const redirectUri = `${ctx.env.VITE_PUBLIC_URL}/api/integrations/github/callback`;
      const data = JSON.stringify({
        userId: ctx.user.id,
        projectId: ctx.project.id,
        redirectUri,
        callbackURL: input.callbackURL,
      });

      await ctx.db.insert(verification).values({
        identifier: state,
        value: data,
        expiresAt,
      });

      const installationUrl = `https://github.com/apps/${ctx.env.GITHUB_APP_SLUG}/installations/new?state=${state}`;

      return { installationUrl };
    }),

  // List available GitHub repos from connected installation
  listAvailableGithubRepos: projectProtectedProcedure.query(async ({ ctx }) => {
    const connection = ctx.project.connections.find((c) => c.provider === "github-app");

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
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch repositories from GitHub",
        cause: error,
      });
    }
  }),

  listProjectRepos: projectProtectedProcedure.query(async ({ ctx }) => {
    return ctx.project.projectRepos;
  }),

  addProjectRepo: projectProtectedMutation
    .input(
      z.object({
        repoId: z.number(),
        owner: z.string(),
        name: z.string(),
        defaultBranch: z.string().default("main"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existingRepo = await ctx.db.query.projectRepo.findFirst({
        where: and(
          eq(projectRepo.projectId, ctx.project.id),
          eq(projectRepo.owner, input.owner),
          eq(projectRepo.name, input.name),
        ),
      });

      if (existingRepo) {
        await ctx.db
          .update(projectRepo)
          .set({
            externalId: input.repoId.toString(),
            defaultBranch: input.defaultBranch,
          })
          .where(eq(projectRepo.id, existingRepo.id));
      } else {
        await ctx.db.insert(projectRepo).values({
          projectId: ctx.project.id,
          provider: "github",
          externalId: input.repoId.toString(),
          owner: input.owner,
          name: input.name,
          defaultBranch: input.defaultBranch,
        });
      }

      return { success: true };
    }),

  removeProjectRepo: projectProtectedMutation
    .input(
      z.object({
        repoId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .delete(projectRepo)
        .where(and(eq(projectRepo.projectId, ctx.project.id), eq(projectRepo.id, input.repoId)));

      return { success: true };
    }),

  // Get GitHub connection status
  getGithubConnection: projectProtectedProcedure.query(async ({ ctx }) => {
    const connection = ctx.project.connections.find((c) => c.provider === "github-app");
    return {
      connected: !!connection,
      installationId: connection
        ? (connection.providerData as { installationId?: number }).installationId
        : null,
    };
  }),

  // Disconnect GitHub (removes connection and repo, revokes installation)
  disconnectGithub: projectProtectedMutation.mutation(async ({ ctx }) => {
    const connection = ctx.project.connections.find((c) => c.provider === "github-app");
    const installationId = connection
      ? (connection.providerData as { installationId?: number }).installationId
      : null;

    if (installationId) {
      const githubUninstalled = await deleteGitHubInstallation(ctx.env, installationId);
      if (!githubUninstalled) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "Failed to revoke GitHub App installation. Please try again or remove it manually from GitHub Settings.",
        });
      }
    }

    await ctx.db.transaction(async (tx) => {
      await tx
        .delete(schema.projectConnection)
        .where(
          and(
            eq(projectConnection.projectId, ctx.project.id),
            eq(projectConnection.provider, "github-app"),
          ),
        );

      await tx.delete(schema.projectRepo).where(eq(projectRepo.projectId, ctx.project.id));
    });

    return { success: true };
  }),

  // Start Slack OAuth flow
  startSlackOAuthFlow: projectProtectedMutation
    .input(
      z.object({
        callbackURL: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const state = arctic.generateState();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

      const data = JSON.stringify({
        userId: ctx.user.id,
        projectId: ctx.project.id,
        callbackURL: input.callbackURL,
      });

      await ctx.db.insert(verification).values({
        identifier: state,
        value: data,
        expiresAt,
      });

      // Build Slack OAuth v2 URL manually
      // arctic.Slack uses OpenID Connect endpoint which only supports user auth scopes
      // For bot scopes, we need /oauth/v2/authorize
      const redirectUri = `${ctx.env.VITE_PUBLIC_URL}/api/integrations/slack/callback`;
      const authorizationUrl = new URL("https://slack.com/oauth/v2/authorize");
      authorizationUrl.searchParams.set("client_id", ctx.env.SLACK_CLIENT_ID);
      authorizationUrl.searchParams.set("redirect_uri", redirectUri);
      authorizationUrl.searchParams.set("state", state);
      authorizationUrl.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));

      return { authorizationUrl: authorizationUrl.toString() };
    }),

  // Get Slack connection status
  getSlackConnection: projectProtectedProcedure.query(async ({ ctx }) => {
    const connection = ctx.project.connections.find((c) => c.provider === "slack");
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
  disconnectSlack: projectProtectedMutation.mutation(async ({ ctx }) => {
    const connection = ctx.project.connections.find((c) => c.provider === "slack");

    if (!connection) {
      throw new TRPCError({
        code: "NOT_FOUND",
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

    await ctx.db
      .delete(schema.projectConnection)
      .where(
        and(
          eq(projectConnection.projectId, ctx.project.id),
          eq(projectConnection.provider, "slack"),
        ),
      );

    return { success: true };
  }),
});
