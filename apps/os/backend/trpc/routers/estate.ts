import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import * as semver from "semver";
import * as tarStream from "tar-stream";
import * as fflate from "fflate";
import { z } from "zod";
import { eq, desc, and } from "drizzle-orm";
import dedent from "dedent";
import { Octokit } from "octokit";
import {
  protectedProcedure,
  estateProtectedProcedure,
  getUserEstateAccess,
  router,
} from "../trpc.ts";
import { estate, builds, agentInstance, iterateConfig } from "../../db/schema.ts";
import {
  getGithubInstallationForEstate,
  getGithubInstallationToken,
  triggerGithubBuild,
} from "../../integrations/github/github-utils.ts";
import type { DB } from "../../db/client.ts";
import type { CloudflareEnv } from "../../../env.ts";
import type { OnboardingData } from "../../agent/onboarding-agent.ts";
import { getAgentStubByName, toAgentClassName } from "../../agent/agents/stub-getters.ts";
import { logger } from "../../tag-logger.ts";
import { CreateCommitOnBranchInput } from "./CreateCommitOnBranchInput.ts";

const iterateBotGithubProcedure = estateProtectedProcedure.use(async ({ ctx, next }) => {
  const githubStuff = await getGithubInstallationForEstate(ctx.db, ctx.estate.id);
  if (!githubStuff) {
    throw new Error("GitHub installation not found for this estate");
  }
  if (!ctx.estate.connectedRepoId) {
    throw new Error("No GitHub repository connected to this estate");
  }
  const { repoData, installationToken } = await getRepoDetails(
    ctx.estate.connectedRepoId,
    githubStuff.accountId,
  );
  return next({
    ctx: { ...ctx, repoData, installationToken, refName: ctx.estate.connectedRepoRef },
  });
});

async function getRepoDetails(repoId: number, installationId: string) {
  const installationToken = await getGithubInstallationToken(installationId);

  // Get repository details
  const repoResponse = await fetch(`https://api.github.com/repositories/${repoId}`, {
    headers: {
      Authorization: `Bearer ${installationToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "Iterate OS",
    },
  });

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

  return { repoData, installationToken };
}

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
  const { repoData, installationToken } = await getRepoDetails(
    estateWithRepo.connectedRepoId,
    githubInstallation.accountId,
  );

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
      onboardingAgentName: userEstate.onboardingAgentName ?? null,
      createdAt: userEstate.createdAt,
      updatedAt: userEstate.updatedAt,
    };
  }),

  getCompiledIterateConfig: estateProtectedProcedure.query(async ({ ctx }) => {
    const record = await ctx.db.query.iterateConfig.findFirst({
      where: eq(iterateConfig.estateId, ctx.estate.id),
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

  updateRepo: iterateBotGithubProcedure
    .input(
      z.object({
        commit: CreateCommitOnBranchInput.omit({ branch: true }),
        format: z.enum(["base64", "plaintext"]),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (input.format === "plaintext") {
        input.commit.fileChanges.additions?.forEach((addition) => {
          addition.contents = Buffer.from(addition.contents).toString("base64");
        });
      }
      const github = new Octokit({ auth: ctx.installationToken });
      const result = await github.graphql(
        dedent`
          mutation ($input: CreateCommitOnBranchInput!) {
            createCommitOnBranch(input: $input) {
              commit {
                url
              }
            }
          }
        `,
        {
          input: {
            ...input.commit,
            branch: {
              branchName: ctx.estate.connectedRepoRef!,
              repositoryNameWithOwner: ctx.repoData.full_name,
            },
          } satisfies CreateCommitOnBranchInput,
        },
      );
      return result;
    }),
  getRepoFilesystem: iterateBotGithubProcedure.query(async ({ ctx }) => {
    const zipballResponse = await fetch(
      `https://api.github.com/repos/${ctx.repoData.full_name}/zipball/${ctx.refName}`,
      { headers: { Authorization: `Bearer ${ctx.installationToken}`, "User-Agent": "Iterate OS" } },
    );

    if (!zipballResponse.ok) {
      throw new Error(
        `Failed to fetch zipball ${zipballResponse.url}: ${await zipballResponse.text()}`,
      );
    }

    const zipball = await zipballResponse.arrayBuffer();
    const unzipped = fflate.unzipSync(new Uint8Array(zipball));

    const filesystem: Record<string, string | null> = Object.fromEntries(
      Object.entries(unzipped)
        .map(([filename, data]) => [
          filename.split("/").slice(1).join("/"), // root directory is `${owner}-${repo}-${sha}`
          fflate.strFromU8(data),
        ])
        .filter(([k, v]) => !k.endsWith("/") && v.trim()),
    );
    const sha = Object.keys(unzipped)[0].split("/")[0].split("-").pop()!;
    return { repoData: ctx.repoData, filesystem, sha };
  }),

  getDTS: protectedProcedure
    .input(
      z.object({
        packageJson: z.object({
          dependencies: z.record(z.string(), z.string()).optional(),
          devDependencies: z.record(z.string(), z.string()).optional(),
        }),
      }),
    )
    .query(async ({ input }) => {
      // todo: consider moving to frontend? will break api.github.com requests unless a cors proxy is used
      // who needs pnpm when you can just fetch the tarball and extract the dts files?
      const deps = { ...input.packageJson.dependencies, ...input.packageJson.devDependencies };
      type GottenPackage = {
        packageJson: import("type-fest").PackageJson;
        files: Record<string, string>;
      };
      const getPackage = async (name: string, version: string): Promise<GottenPackage> => {
        if (version.startsWith("github:")) {
          const [ownerAndRepo, ref = "main"] = version.replace("github:", "").split("#");
          const zipballUrl = `https://api.github.com/repos/${ownerAndRepo}/zipball/${ref}`;
          const zipballResponse = await fetch(zipballUrl, {
            headers: { "User-Agent": "iterate.com OS" },
          });

          if (!zipballResponse.ok) {
            throw new Error(`Failed to fetch zipball: ${await zipballResponse.text()}`);
          }

          const zipball = await zipballResponse.arrayBuffer();
          const unzipped = fflate.unzipSync(new Uint8Array(zipball));

          const filesystem: Record<string, string> = Object.fromEntries(
            Object.entries(unzipped)
              .map(([zipballPath, data]) => {
                const filename = zipballPath.split("/").slice(1).join("/"); // root dir is `${owner}-${repo}-${sha}`
                return [filename, data] as const;
              })
              .filter(([filename]) => filename.endsWith(".d.ts") || filename === "package.json")
              .map(([filename, data]) => [filename, fflate.strFromU8(data)])
              .filter(([k, v]) => !k.endsWith("/") && v.trim()),
          );
          return { files: filesystem, packageJson: JSON.parse(filesystem["package.json"]!) };
        }
        const url = version?.match(/^https?:/)
          ? version
          : `https://registry.npmjs.org/${name}/-/${name}-${version.replace(/^[~^]/, "")}.tgz`;
        const res = await fetch(url);
        const extract = tarStream.extract({});

        // Load into buffer first to avoid streaming issues in Workers
        const buffer = Buffer.from(await res.arrayBuffer());

        const files: Record<string, string> = {};

        // eslint-disable-next-line no-async-promise-executor -- can't be bothered to avoid async await in this one case
        await new Promise<void>(async (resolve, reject) => {
          const nodeStream = Readable.from(buffer);

          nodeStream.on("error", (error) => {
            logger.error("nodeStream error", error);
            reject(error);
          });

          const gunzip = createGunzip();

          gunzip.on("error", (error) => {
            logger.error("gunzip error", error);
            reject(error);
          });

          nodeStream.pipe(gunzip).pipe(extract);

          for await (const entry of extract) {
            const tgzPath = entry.header.name;
            const filename = tgzPath.replace("package/", "");
            const isInteresting = filename.endsWith(".d.ts") || filename === "package.json";
            if (!isInteresting) {
              entry.resume();
              continue;
            }
            const chunks: Buffer[] = [];
            for await (const chunk of entry) {
              chunks.push(chunk);
            }
            const content = Buffer.concat(chunks).toString("utf-8");
            files[filename] = content;
          }
          resolve();
        });
        const packageJson = JSON.parse(files["package.json"]!) as import("type-fest").PackageJson;

        if (!packageJson.name) {
          throw new Error(`Couldn't find valid package.json for ${name}@${version}`);
        }
        return { packageJson, files };
      };

      const packages: GottenPackage[] = [];
      const remainingDeps = { ...deps };
      for (let i = 100; i >= 0 && Object.keys(remainingDeps).length > 0; i--) {
        if (i === 0)
          throw new Error("Too many dependencies: " + Object.keys(remainingDeps).join(", "));
        for (const [name, version] of Object.entries(remainingDeps)) {
          const existing = packages.find(
            (p) => p.packageJson.name === name && semver.satisfies(p.packageJson.version!, version),
          );
          delete remainingDeps[name];
          if (existing) {
            logger.debug(
              `package ${name}@${existing.packageJson.version} exists and matches ${version}`,
            );
            continue;
          }
          logger.debug(`package ${name}@${version} not found, getting it...`);
          const pkg = await getPackage(name, version);
          logger.debug(`package ${name}@${version} gotten.`);
          packages.push(pkg);
          for (const [depName, depVersion] of Object.entries(pkg.packageJson.dependencies ?? {})) {
            logger.debug(
              `adding dependency ${depName}@${depVersion} to remaining deps because it's a dependency of ${name}@${version}`,
            );
            remainingDeps[depName] = depVersion!;
          }
        }
      }
      logger.debug(
        `got ${packages.length} packages: ${packages.map((p) => p.packageJson.name).join(", ")}`,
      );
      return packages;
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

  getOnboardingStatus: estateProtectedProcedure.query(async ({ ctx }) => {
    const estateId = ctx.estate.id;

    // Get the estate with onboarding agent name
    const estateData = await ctx.db.query.estate.findFirst({
      where: eq(estate.id, estateId),
    });

    if (!estateData) {
      throw new Error("Estate not found");
    }

    // If no onboarding agent name, onboarding is completed
    if (!estateData.onboardingAgentName) {
      return {
        status: "completed" as const,
        agentName: null,
        onboardingData: null,
      };
    }

    // Find the agent instance for this estate and agent name
    const agent = await ctx.db.query.agentInstance.findFirst({
      where: and(
        eq(agentInstance.estateId, estateId),
        eq(agentInstance.durableObjectName, estateData.onboardingAgentName),
      ),
    });

    if (!agent) {
      return {
        status: "in-progress" as const,
        agentName: estateData.onboardingAgentName,
        onboardingData: {},
      };
    }

    try {
      // Get the agent stub using the existing helper
      const stub = await getAgentStubByName(toAgentClassName(agent.className), {
        db: ctx.db,
        agentInstanceName: agent.durableObjectName,
      });

      const response = await stub.fetch("http://do/state");
      const state = (await response.json()) as { onboardingData?: OnboardingData };

      return {
        status: "in-progress" as const,
        agentName: estateData.onboardingAgentName,
        onboardingData: state.onboardingData ?? {},
      };
    } catch (_error) {
      // If we can't fetch the state, return empty onboarding data
      return {
        status: "in-progress" as const,
        agentName: estateData.onboardingAgentName,
        onboardingData: {},
      };
    }
  }),

  // Get latest onboarding results by calling the agent's getResults() tool
  getOnboardingResults: estateProtectedProcedure.query(async ({ ctx }) => {
    const estateId = ctx.estate.id;

    // Read the onboarding agent name from the estate
    const estateData = await ctx.db.query.estate.findFirst({
      where: eq(estate.id, estateId),
    });

    if (!estateData?.onboardingAgentName) {
      return { results: {} as Record<string, unknown> };
    }

    // Find the agent instance for this estate and agent name
    const agent = await ctx.db.query.agentInstance.findFirst({
      where: and(
        eq(agentInstance.estateId, estateId),
        eq(agentInstance.durableObjectName, estateData.onboardingAgentName),
      ),
    });

    if (!agent) {
      return { results: {} as Record<string, unknown> };
    }

    // Get the agent stub and call getResults() if it's an OnboardingAgent
    const stub = await getAgentStubByName(toAgentClassName(agent.className), {
      db: ctx.db,
      agentInstanceName: agent.durableObjectName,
    });

    // Narrow to onboarding agent based on class name
    if (agent.className === "OnboardingAgent") {
      try {
        const results = await (stub as any).getResults({});
        return { results: results ?? {} };
      } catch (_err) {
        return { results: {} as Record<string, unknown> };
      }
    }

    return { results: {} as Record<string, unknown> };
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
