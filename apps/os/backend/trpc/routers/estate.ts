import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import {
  protectedProcedure,
  estateProtectedProcedure,
  getUserEstateAccess,
  router,
} from "../trpc.ts";
import { estate, builds, iterateConfig } from "../../db/schema.ts";
import {
  getGithubInstallationForEstate,
  getGithubInstallationToken,
  triggerGithubBuild,
} from "../../integrations/github/github-utils.ts";
import type { DB } from "../../db/client.ts";
import type { CloudflareEnv } from "../../../env.ts";

// Helper function to trigger a rebuild for a given commit
export async function triggerEstateRebuild(params: {
  db: DB;
  env: CloudflareEnv;
  estateId: string;
  commitHash: string;
  commitMessage: string;
  isManual?: boolean;
}) {
  const { db, env, estateId, commitHash, commitMessage, isManual = false } = params;

  // Get the estate details
  const estateWithRepo = await db.query.estate.findFirst({
    where: eq(estate.id, estateId),
  });

  if (!estateWithRepo?.connectedRepoId) {
    throw new Error("No GitHub repository connected to this estate");
  }

  // Get the GitHub installation
  const githubInstallation = await getGithubInstallationForEstate(db, estateId);
  if (!githubInstallation) {
    throw new Error("GitHub installation not found for this estate");
  }

  // Get installation token
  const installationToken = await getGithubInstallationToken(githubInstallation.accountId);

  // Get repository details
  const repoResponse = await fetch(
    `https://api.github.com/repositories/${estateWithRepo.connectedRepoId}`,
    {
      headers: {
        Authorization: `Bearer ${installationToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "Iterate OS",
      },
    },
  );

  if (!repoResponse.ok) {
    throw new Error("Failed to fetch repository details");
  }

  const repoData = z
    .object({
      id: z.number(),
      full_name: z.string(),
      html_url: z.string(),
      clone_url: z.string(),
    })
    .parse(await repoResponse.json());

  // Use the common build trigger function
  return await triggerGithubBuild({
    db,
    env,
    estateId,
    commitHash,
    commitMessage,
    repoUrl: repoData.clone_url,
    installationToken,
    connectedRepoPath: estateWithRepo.connectedRepoPath || "/",
    branch: estateWithRepo.connectedRepoRef || "main",
    isManual,
  });
}

export const estateRouter = router({
  // Check if user has access to a specific estate (non-throwing version)
  checkAccess: protectedProcedure
    .input(
      z.object({
        estateId: z.string(),
        organizationId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      try {
        // Use the shared helper function
        const result = await getUserEstateAccess(
          ctx.db,
          ctx.user.id,
          input.estateId,
          input.organizationId,
        );

        if (result.hasAccess && result.estate) {
          return {
            hasAccess: true,
            estate: {
              id: result.estate.id,
              name: result.estate.name,
              organizationId: result.estate.organizationId,
            },
          };
        }

        return { hasAccess: false, estate: null };
      } catch {
        // Return false on any error instead of throwing
        return { hasAccess: false, estate: null };
      }
    }),

  // Get a specific estate (with permission check)
  get: estateProtectedProcedure.query(async ({ ctx }) => {
    // The estate is already validated and available in context
    const userEstate = ctx.estate;

    return {
      id: userEstate.id,
      name: userEstate.name,
      organizationId: userEstate.organizationId,
      createdAt: userEstate.createdAt,
      updatedAt: userEstate.updatedAt,
    };
  }),

  getCompiledIterateConfig: estateProtectedProcedure.query(async ({ ctx, input }) => {
    const record = await ctx.db.query.iterateConfig.findFirst({
      where: eq(iterateConfig.estateId, input.estateId),
    });

    return {
      config: record?.config ?? null,
      updatedAt: record?.updatedAt ?? null,
    };
  }),

  // Update estate name
  updateName: estateProtectedProcedure
    .input(
      z.object({
        name: z.string().min(1, "Estate name cannot be empty").max(100, "Estate name too long"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // The estate is already validated and available in context
      const estateId = ctx.estate.id;

      // Update the estate name
      const updatedEstate = await ctx.db
        .update(estate)
        .set({
          name: input.name,
          updatedAt: new Date(),
        })
        .where(eq(estate.id, estateId))
        .returning();

      if (!updatedEstate[0]) {
        throw new Error("Failed to update estate");
      }

      return {
        id: updatedEstate[0].id,
        name: updatedEstate[0].name,
        organizationId: updatedEstate[0].organizationId,
        createdAt: updatedEstate[0].createdAt,
        updatedAt: updatedEstate[0].updatedAt,
      };
    }),

  // Get builds for an estate
  getBuilds: estateProtectedProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(20).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { estateId } = input;
      const limit = input.limit || 20;

      const estateBuilds = await ctx.db
        .select()
        .from(builds)
        .where(eq(builds.estateId, estateId))
        .orderBy(desc(builds.createdAt))
        .limit(limit);

      return estateBuilds;
    }),

  triggerRebuild: estateProtectedProcedure
    .input(
      z.object({
        target: z.string().min(1, "Target is required"),
        targetType: z.enum(["branch", "commit"]).default("branch"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { estateId, target, targetType } = input;

      // Get the connected GitHub repo for this estate
      const estateWithRepo = await ctx.db.query.estate.findFirst({
        where: eq(estate.id, estateId),
      });

      if (!estateWithRepo?.connectedRepoId) {
        throw new Error("No GitHub repository connected to this estate");
      }

      // Get the GitHub installation
      const githubInstallation = await getGithubInstallationForEstate(ctx.db, estateId);
      if (!githubInstallation) {
        throw new Error("GitHub installation not found for this estate");
      }

      // Get installation token
      const installationToken = await getGithubInstallationToken(githubInstallation.accountId);

      // GitHub API response schemas
      const GitHubCommitResponse = z.object({
        sha: z.string(),
        commit: z.object({
          message: z.string(),
        }),
      });

      const GitHubBranchResponse = z.object({
        commit: z.object({
          sha: z.string(),
          commit: z.object({
            message: z.string(),
          }),
        }),
      });

      let commitHash: string;
      let commitMessage: string;

      if (targetType === "commit") {
        // Fetch the commit details
        const commitResponse = await fetch(
          `https://api.github.com/repositories/${estateWithRepo.connectedRepoId}/commits/${target}`,
          {
            headers: {
              Authorization: `Bearer ${installationToken}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "Iterate OS",
            },
          },
        );

        if (!commitResponse.ok) {
          throw new Error(`Failed to fetch commit details: ${target}`);
        }

        const commitData = GitHubCommitResponse.parse(await commitResponse.json());
        commitHash = commitData.sha;
        commitMessage = commitData.commit.message;
      } else {
        // Fetch the latest commit on the branch
        const branchResponse = await fetch(
          `https://api.github.com/repositories/${estateWithRepo.connectedRepoId}/branches/${target}`,
          {
            headers: {
              Authorization: `Bearer ${installationToken}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "Iterate OS",
            },
          },
        );

        if (!branchResponse.ok) {
          throw new Error(`Failed to fetch branch details: ${target}`);
        }

        const branchData = GitHubBranchResponse.parse(await branchResponse.json());
        commitHash = branchData.commit.sha;
        commitMessage = branchData.commit.commit.message;
      }

      // Use the helper function to trigger the rebuild
      const build = await triggerEstateRebuild({
        db: ctx.db,
        env: ctx.env,
        estateId,
        commitHash,
        commitMessage,
        isManual: true,
      });

      return {
        buildId: build.id,
        status: "in_progress",
        message: "Build triggered successfully",
      };
    }),
});
