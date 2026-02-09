import { z } from "zod/v4";
import { eq, and, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import * as arctic from "arctic";
import {
  router,
  protectedProcedure,
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
import {
  revokeGoogleToken,
  createGoogleClient,
  GOOGLE_OAUTH_SCOPES,
} from "../../integrations/google/google.ts";
import { decrypt } from "../../utils/encryption.ts";
import { callClaudeHaiku } from "../../services/claude-haiku.ts";
import { validateJsonataExpression } from "../../egress-proxy/egress-rules.ts";
import { linkExternalIdToGroups } from "../../lib/posthog.ts";

export const projectRouter = router({
  // Get minimal project info by ID (for conflict resolution, no org access required)
  // Returns just enough info to display the project/org names and slugs
  getProjectInfoById: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ ctx, input }) => {
      const proj = await ctx.db.query.project.findFirst({
        where: eq(project.id, input.projectId),
        with: { organization: true },
      });

      if (!proj) {
        throw new TRPCError({
          code: "NOT_FOUND",
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
  list: orgProtectedProcedure.query(async ({ ctx }) => {
    const projects = await ctx.db.query.project.findMany({
      where: eq(project.organizationId, ctx.organization.id),
      orderBy: (proj, { desc }) => [desc(proj.createdAt)],
    });

    return projects;
  }),

  // Get project by slug (project slugs are globally unique)
  // Returns project with organization info
  bySlug: projectProtectedProcedure.query(async ({ ctx }) => {
    return {
      ...ctx.project,
      organization: ctx.organization,
    };
  }),

  create: orgAdminMutation
    .input(
      z.object({
        name: z.string().min(1).max(100),
        slug: z.string().min(1).max(50).optional(), // Optional: defaults to org slug if first project
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Determine base slug: use provided slug, or org slug for first project, or slugify name
      const orgProjects = await ctx.db.query.project.findMany({
        where: eq(project.organizationId, ctx.organization.id),
      });
      const isFirstProject = orgProjects.length === 0;
      const baseSlug = input.slug ?? (isFirstProject ? ctx.organization.slug : slugify(input.name));

      // Check global uniqueness (project slugs are now globally unique)
      const existing = await ctx.db.query.project.findFirst({
        where: eq(project.slug, baseSlug),
      });

      const slug = existing ? slugifyWithSuffix(baseSlug) : baseSlug;

      const [newProject] = await ctx.db
        .insert(project)
        .values({ name: input.name, slug, organizationId: ctx.organization.id })
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

      // Link GitHub repo to org/project in PostHog
      linkExternalIdToGroups(ctx.env, {
        distinctId: `github:${input.owner}/${input.name}`,
        organizationId: ctx.organization.id,
        projectId: ctx.project.id,
      });

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

  // Transfer Slack connection from one project to another
  // Used when a Slack workspace is already connected elsewhere and user wants to switch
  transferSlackConnection: projectProtectedMutation
    .input(
      z.object({
        slackTeamId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Find existing connection by Slack team ID
      const existingConnection = await ctx.db.query.projectConnection.findFirst({
        where: and(
          eq(projectConnection.provider, "slack"),
          eq(projectConnection.externalId, input.slackTeamId),
        ),
        with: { project: { with: { organization: true } } },
      });

      if (!existingConnection) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Slack workspace connection not found",
        });
      }

      // TODO: In the future, we may want to verify user has access to both projects.
      // For now, if the user has a valid Slack authorization (they authorized the bot
      // for this workspace), we trust that's sufficient permission to move the connection.

      // Check if target project already has a Slack connection
      const targetProjectConnection = ctx.project.connections.find((c) => c.provider === "slack");
      if (targetProjectConnection) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Target project already has a Slack connection. Disconnect it first.",
        });
      }

      const sourceProjectId = existingConnection.projectId;
      const targetProjectId = ctx.project.id;
      const encryptedAccessToken = (
        existingConnection.providerData as { encryptedAccessToken?: string } | null
      )?.encryptedAccessToken;

      // Keep connection and secret in sync when moving Slack workspaces between projects.
      await ctx.db.transaction(async (tx) => {
        await tx
          .update(projectConnection)
          .set({
            projectId: targetProjectId,
          })
          .where(eq(projectConnection.id, existingConnection.id));

        if (!encryptedAccessToken) return;

        const targetSecret = await tx.query.secret.findFirst({
          where: and(
            eq(schema.secret.projectId, targetProjectId),
            eq(schema.secret.key, "slack.access_token"),
            isNull(schema.secret.userId),
          ),
        });

        if (targetSecret) {
          await tx
            .update(schema.secret)
            .set({
              encryptedValue: encryptedAccessToken,
              organizationId: ctx.organization.id,
              egressProxyRule: `$contains(url.hostname, 'slack.com')`,
              lastSuccessAt: new Date(),
            })
            .where(eq(schema.secret.id, targetSecret.id));
        } else {
          await tx.insert(schema.secret).values({
            key: "slack.access_token",
            encryptedValue: encryptedAccessToken,
            organizationId: ctx.organization.id,
            projectId: targetProjectId,
            egressProxyRule: `$contains(url.hostname, 'slack.com')`,
            lastSuccessAt: new Date(),
          });
        }

        if (sourceProjectId !== targetProjectId) {
          await tx
            .delete(schema.secret)
            .where(
              and(
                eq(schema.secret.projectId, sourceProjectId),
                eq(schema.secret.key, "slack.access_token"),
                isNull(schema.secret.userId),
              ),
            );
        }
      });

      return {
        success: true,
        previousProjectSlug: existingConnection.project?.slug,
        previousOrgSlug: existingConnection.project?.organization?.slug,
      };
    }),

  // Start Google OAuth flow (user-scoped connection)
  startGoogleOAuthFlow: projectProtectedMutation
    .input(
      z.object({
        callbackURL: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const state = arctic.generateState();
      const codeVerifier = arctic.generateCodeVerifier();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

      const data = JSON.stringify({
        userId: ctx.user.id,
        projectId: ctx.project.id,
        callbackURL: input.callbackURL,
        codeVerifier,
      });

      await ctx.db.insert(verification).values({
        identifier: state,
        value: data,
        expiresAt,
      });

      const google = createGoogleClient(ctx.env);
      const authorizationUrl = google.createAuthorizationURL(
        state,
        codeVerifier,
        GOOGLE_OAUTH_SCOPES,
      );

      // Request offline access to get refresh token
      authorizationUrl.searchParams.set("access_type", "offline");
      // Force consent screen to ensure we get a refresh token even for returning users
      authorizationUrl.searchParams.set("prompt", "consent");

      return { authorizationUrl: authorizationUrl.toString() };
    }),

  // Get Google connection status for the current user in this project
  getGoogleConnection: projectProtectedProcedure.query(async ({ ctx }) => {
    // Google connections are user-scoped, so filter by userId
    const connection = ctx.project.connections.find(
      (c) => c.provider === "google" && c.userId === ctx.user.id,
    );

    const providerData = connection?.providerData as {
      googleUserId?: string;
      email?: string;
      name?: string;
      picture?: string;
    } | null;

    return {
      connected: !!connection,
      email: providerData?.email ?? null,
      name: providerData?.name ?? null,
      picture: providerData?.picture ?? null,
    };
  }),

  // Disconnect Google (user-scoped)
  disconnectGoogle: projectProtectedMutation.mutation(async ({ ctx }) => {
    // Google connections are user-scoped
    const connection = ctx.project.connections.find(
      (c) => c.provider === "google" && c.userId === ctx.user.id,
    );

    if (!connection) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "No Google connection found for your account in this project",
      });
    }

    // Revoke the Google token (best effort - don't fail disconnect if revocation fails)
    const providerData = connection.providerData as { encryptedAccessToken?: string };
    if (providerData.encryptedAccessToken) {
      try {
        const accessToken = await decrypt(providerData.encryptedAccessToken);
        await revokeGoogleToken(accessToken);
      } catch {
        // Token revocation failed, but we still delete the connection
      }
    }

    await ctx.db.transaction(async (tx) => {
      // Delete the connection
      await tx
        .delete(schema.projectConnection)
        .where(
          and(
            eq(projectConnection.projectId, ctx.project.id),
            eq(projectConnection.provider, "google"),
            eq(projectConnection.userId, ctx.user.id),
          ),
        );

      // Delete the associated secret
      await tx
        .delete(schema.secret)
        .where(
          and(
            eq(schema.secret.projectId, ctx.project.id),
            eq(schema.secret.key, "google.access_token"),
            eq(schema.secret.userId, ctx.user.id),
          ),
        );
    });

    return { success: true };
  }),

  listEgressPolicies: projectProtectedProcedure.query(async ({ ctx }) => {
    const policies = await ctx.db.query.egressPolicy.findMany({
      where: eq(schema.egressPolicy.projectId, ctx.project.id),
      orderBy: (policy, { asc }) => [asc(policy.priority)],
    });
    return policies.map((policy) => ({
      ...policy,
      rule: policy.urlPattern ?? "",
    }));
  }),

  createEgressPolicy: projectProtectedMutation
    .input(
      z.object({
        rule: z.string().min(1),
        decision: z.enum(["allow", "deny", "human_approval"]),
        priority: z.number().int().min(0).max(1000).optional(),
        reason: z.string().max(200).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const validationError = validateJsonataExpression(input.rule);
      if (validationError) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Invalid JSONata expression: ${validationError}`,
        });
      }

      const [policy] = await ctx.db
        .insert(schema.egressPolicy)
        .values({
          projectId: ctx.project.id,
          urlPattern: input.rule,
          decision: input.decision,
          priority: input.priority ?? 100,
          reason: input.reason ?? null,
        })
        .returning();

      return policy;
    }),

  deleteEgressPolicy: projectProtectedMutation
    .input(z.object({ policyId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const [deleted] = await ctx.db
        .delete(schema.egressPolicy)
        .where(
          and(
            eq(schema.egressPolicy.id, input.policyId),
            eq(schema.egressPolicy.projectId, ctx.project.id),
          ),
        )
        .returning();

      if (!deleted) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Policy not found" });
      }

      return deleted;
    }),

  updateEgressPolicy: projectProtectedMutation
    .input(
      z.object({
        policyId: z.string(),
        rule: z.string().min(1),
        decision: z.enum(["allow", "deny", "human_approval"]),
        priority: z.number().int().min(0).max(1000).optional(),
        reason: z.string().max(200).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const validationError = validateJsonataExpression(input.rule);
      if (validationError) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Invalid JSONata expression: ${validationError}`,
        });
      }

      const [updated] = await ctx.db
        .update(schema.egressPolicy)
        .set({
          urlPattern: input.rule,
          decision: input.decision,
          priority: input.priority ?? 100,
          reason: input.reason ?? null,
        })
        .where(
          and(
            eq(schema.egressPolicy.id, input.policyId),
            eq(schema.egressPolicy.projectId, ctx.project.id),
          ),
        )
        .returning();

      if (!updated) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Policy not found" });
      }

      return updated;
    }),

  summarizeEgressApproval: projectProtectedMutation
    .input(z.object({ approvalId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const approval = await ctx.db.query.egressApproval.findFirst({
        where: and(
          eq(schema.egressApproval.id, input.approvalId),
          eq(schema.egressApproval.projectId, ctx.project.id),
        ),
      });

      if (!approval) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Approval not found" });
      }

      const prompt = buildApprovalSummaryPrompt(approval);
      const summary = await callClaudeHaiku(ctx.env, {
        system: "Summarize the request in plain English. Keep it short and actionable.",
        user: prompt,
        maxTokens: 200,
      });

      return { summary };
    }),

  suggestEgressRule: projectProtectedMutation
    .input(
      z.object({
        approvalId: z.string().optional(),
        instruction: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const approval = input.approvalId
        ? await ctx.db.query.egressApproval.findFirst({
            where: and(
              eq(schema.egressApproval.id, input.approvalId),
              eq(schema.egressApproval.projectId, ctx.project.id),
            ),
          })
        : null;

      if (input.approvalId && !approval) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Approval not found" });
      }

      const prompt = buildRuleSuggestionPrompt(approval ?? null, input.instruction);
      const suggestion = await callClaudeHaiku(ctx.env, {
        system: `You generate JSONata boolean expressions to match outbound HTTP requests from AI agents.

The input object has these fields:
- method: HTTP method string (GET, POST, etc.)
- url: Object with { hostname, pathname, href, protocol, port }
- headers: Object with lowercase header names as keys
- body: Request body as string (may be JSON)

Common patterns:
- Match hostname: url.hostname = "api.example.com"
- Match path prefix: $startsWith(url.pathname, "/v1/")
- Contains in URL: $contains(url.href, "gmail.googleapis.com")
- Match subdomain pattern: $contains(url.hostname, "googleapis.com")
- Check header: headers.authorization != null
- Parse JSON body: $eval(body).recipient = "user@example.com"
- Combine conditions: url.hostname = "api.stripe.com" and method = "POST"

Return ONLY the JSONata expression, no explanation.`,
        user: prompt,
        maxTokens: 200,
      });

      return { rule: extractRuleExpression(suggestion) };
    }),
});

function serializeRequestForPrompt(approval: typeof schema.egressApproval.$inferSelect): string {
  return JSON.stringify(
    {
      method: approval.method,
      url: approval.url,
      headers: truncateObject(approval.headers, 50),
      body: approval.body ? truncateString(approval.body, 2000) : undefined,
    },
    null,
    2,
  );
}

function buildApprovalSummaryPrompt(approval: typeof schema.egressApproval.$inferSelect) {
  return ["Request details:", serializeRequestForPrompt(approval)].join("\n");
}

function buildRuleSuggestionPrompt(
  approval: typeof schema.egressApproval.$inferSelect | null,
  instruction: string,
) {
  const parts = ["User instruction:", instruction.trim()];
  if (approval) {
    parts.push("", "Example HTTP request to match:", serializeRequestForPrompt(approval));
  }
  return parts.join("\n");
}

function extractRuleExpression(response: string) {
  const fenced = response.match(/```(?:jsonata)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  return response.trim().split("\n")[0] ?? "";
}

function truncateString(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…`;
}

function truncateObject(value: Record<string, string>, maxEntries: number) {
  const entries = Object.entries(value).slice(0, maxEntries);
  return Object.fromEntries(entries);
}
