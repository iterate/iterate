import * as path from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { inspect } from "node:util";
import * as semver from "semver";
import * as tarStream from "tar-stream";
import * as fflate from "fflate/browser";
import { z } from "zod";
import { eq, desc, and, notInArray } from "drizzle-orm";
import dedent from "dedent";
import { TRPCError } from "@trpc/server";
import {
  protectedProcedure,
  estateProtectedProcedure,
  getUserEstateAccess,
  router,
  protectedProcedureWithNoEstateRestrictions,
} from "../trpc.ts";
import {
  estate,
  builds,
  agentInstance,
  iterateConfig,
  organizationUserMembership,
  organization,
} from "../../db/schema.ts";
import {
  getGithubInstallationForEstate,
  getOctokitForInstallation,
  githubAppInstance,
  triggerGithubBuild,
} from "../../integrations/github/github-utils.ts";
import { schema, type DB } from "../../db/client.ts";
import { env, type CloudflareEnv } from "../../../env.ts";
import type { OnboardingData } from "../../agent/onboarding-agent.ts";
import { getAgentStubByName, toAgentClassName } from "../../agent/agents/stub-getters.ts";
import { slackChannelOverrideExists } from "../../utils/trial-channel-setup.ts";
import { logger } from "../../tag-logger.ts";
import { CreateCommitOnBranchInput } from "./github-schemas.ts";

export const RepoData = z.object({
  id: z.number(),
  full_name: z.string(),
  html_url: z.string(),
  clone_url: z.string(),
});

const getInstallationScopedContext = async (options: {
  db: DB;
  estateId: string;
  connectedRepoId: number;
}) => {
  const githubInstallation = await getGithubInstallationForEstate(options.db, options.estateId);
  const scopedOctokit = await getOctokitForInstallation(
    githubInstallation?.accountId ?? env.GITHUB_ESTATES_DEFAULT_INSTALLATION_ID,
  );

  const repoRes = await scopedOctokit.request("GET /repositories/{repository_id}", {
    repository_id: options.connectedRepoId,
  });

  if (repoRes.status !== 200) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Failed to fetch repository details",
    });
  }

  const repoData = RepoData.parse(repoRes.data);

  return {
    octokit: scopedOctokit,
    repoData,
    githubInstallation,
  };
};

const githubInstallationScopedProcedure = estateProtectedProcedure.use(async ({ ctx, next }) => {
  if (!ctx.estate.connectedRepoId)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "No GitHub repository connected to this estate",
    });

  const { octokit, repoData } = await getInstallationScopedContext({
    db: ctx.db,
    estateId: ctx.estate.id,
    connectedRepoId: ctx.estate.connectedRepoId,
  });

  return next({
    ctx: {
      ...ctx,
      estate: { ...ctx.estate, connectedRepoId: ctx.estate.connectedRepoId },
      github: octokit,
      /** owner and repo in format needed for octokit.rest api */
      repo: { owner: repoData.full_name.split("/")[0], repo: repoData.full_name.split("/")[1] },
      repoData,
      connectedRepoPathWithoutLeadingSlash: ctx.estate.connectedRepoPath?.replace(/^\//, "") || "",
      refName: ctx.estate.connectedRepoRef,
    },
  });
});

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

  const { repoData, githubInstallation } = await getInstallationScopedContext({
    db,
    estateId,
    connectedRepoId: estateWithRepo.connectedRepoId,
  });

  const installationToken =
    await githubAppInstance().octokit.rest.apps.createInstallationAccessToken({
      installation_id: parseInt(
        githubInstallation?.accountId ?? env.GITHUB_ESTATES_DEFAULT_INSTALLATION_ID,
      ),
      repository_ids: [estateWithRepo.connectedRepoId],
    });

  if (installationToken.status !== 201) {
    throw new Error(
      `Failed to create installation token: ${installationToken.status} ${JSON.stringify(installationToken.data)}`,
    );
  }

  // Use the common build trigger function
  return await triggerGithubBuild({
    db,
    env,
    estateId,
    commitHash,
    commitMessage,
    repoUrl: repoData.clone_url,
    installationToken: installationToken.data.token,
    connectedRepoPath: estateWithRepo.connectedRepoPath || "/",
    branch: estateWithRepo.connectedRepoRef || "main",
    isManual,
  });
}

export const estateRouter = router({
  // Check if user has access to a specific estate (non-throwing version)
  checkAccess: protectedProcedureWithNoEstateRestrictions // we're going to carefully make sure we only give info to authorized users
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

    // Fetch the organization
    const org = await ctx.db.query.organization.findFirst({
      where: eq(organization.id, userEstate.organizationId),
    });

    // Check if this is a trial estate
    const isTrial = await slackChannelOverrideExists(ctx.db, userEstate.id);

    return {
      id: userEstate.id,
      name: userEstate.name,
      organizationId: userEstate.organizationId,
      onboardingAgentName: userEstate.onboardingAgentName ?? null,
      isTrialEstate: isTrial,
      organization: org
        ? {
            id: org.id,
            name: org.name,
          }
        : undefined,
      createdAt: userEstate.createdAt,
      updatedAt: userEstate.updatedAt,
    };
  }),

  // List all estates the user has access to
  listAllForUser: protectedProcedure.query(async ({ ctx }) => {
    // Get all organizations the user is a member of (excluding external and guest roles)
    const memberships = await ctx.db.query.organizationUserMembership.findMany({
      where: and(
        eq(organizationUserMembership.userId, ctx.user.id),
        notInArray(organizationUserMembership.role, ["external", "guest"]),
      ),
      with: {
        organization: {
          with: {
            estates: true,
          },
        },
      },
    });

    // Flatten estates from all organizations and check trial status
    const estates = await Promise.all(
      memberships.flatMap((membership) =>
        membership.organization.estates.map(async (est) => ({
          id: est.id,
          name: est.name,
          organizationId: est.organizationId,
          organization: {
            id: membership.organization.id,
            name: membership.organization.name,
          },
          isTrialEstate: await slackChannelOverrideExists(ctx.db, est.id),
          createdAt: est.createdAt,
          updatedAt: est.updatedAt,
        })),
      ),
    );

    return estates;
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

  updateRepo: githubInstallationScopedProcedure
    .input(
      z.object({
        commit: CreateCommitOnBranchInput,
        format: z.enum(["base64", "plaintext"]),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (input.format === "plaintext") {
        input.commit.fileChanges.additions?.forEach((addition) => {
          addition.contents = Buffer.from(addition.contents).toString("base64");
        });
      }
      input.commit.fileChanges.additions?.forEach((addition) => {
        addition.path = path.join(ctx.connectedRepoPathWithoutLeadingSlash, addition.path);
      });
      input.commit.fileChanges.deletions?.forEach((deletion) => {
        deletion.path = path.join(ctx.connectedRepoPathWithoutLeadingSlash, deletion.path);
      });

      const branchName = input.commit.branch.branchName;
      const branch = await ctx.github.rest.repos
        .getBranch({
          owner: ctx.repo.owner,
          repo: ctx.repo.repo,
          branch: branchName,
        })
        .catch(() => null);

      let sha = input.commit.expectedHeadOid;

      if (!branch || branch.status !== 200) {
        // create the branch
        const defaultBranch = await ctx.github.rest.repos.getBranch({
          owner: ctx.repo.owner,
          repo: ctx.repo.repo,
          branch: ctx.estate.connectedRepoRef!,
        });
        const { data: newRef } = await ctx.github.rest.git.createRef({
          owner: ctx.repo.owner,
          repo: ctx.repo.repo,
          ref: `refs/heads/${branchName}`,
          sha: defaultBranch.data.commit.sha,
        });
        sha = newRef.object.sha;
      }

      const result = await ctx.github.graphql(
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
              branchName: branchName,
              repositoryNameWithOwner: ctx.repoData.full_name,
            },
            expectedHeadOid: sha,
          } satisfies CreateCommitOnBranchInput,
        },
      );
      return result;
    }),
  createPullRequest: githubInstallationScopedProcedure
    .input(
      z.object({
        fromBranch: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      try {
        await ctx.github.rest.repos.getBranch({
          owner: ctx.repo.owner,
          repo: ctx.repo.repo,
          branch: input.fromBranch,
        });
      } catch (_error: unknown) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Branch not found: ${input.fromBranch}`,
        });
      }

      const pullRequest = await ctx.github.rest.pulls.create({
        owner: ctx.repo.owner,
        repo: ctx.repo.repo,
        head: input.fromBranch,
        base: ctx.refName ?? "main",
        title: `Update from in-browser IDE (${input.fromBranch})`,
      });

      return pullRequest;
    }),
  getRepoFilesystem: githubInstallationScopedProcedure
    .input(
      z.object({
        branch: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const requestedBranch = input?.branch ?? ctx.refName ?? "main";
      const defaultBranch = ctx.refName ?? "main";

      // Check if the requested branch exists, fall back to default branch if not
      let branch = requestedBranch;
      let branchExists = true;
      try {
        const branchResponse = await ctx.github.rest.repos.getBranch({
          owner: ctx.repo.owner,
          repo: ctx.repo.repo,
          branch: requestedBranch,
        });
        if (branchResponse.status !== 200) {
          branchExists = false;
          branch = defaultBranch;
        }
      } catch (_error: unknown) {
        // Branch doesn't exist (404) or other error, use default branch
        branchExists = false;
        branch = defaultBranch;
      }

      const zipball = await ctx.github.rest.repos.downloadZipballArchive({
        owner: ctx.repo.owner,
        repo: ctx.repo.repo,
        ref: branch,
      });

      if (!(zipball.data instanceof ArrayBuffer)) {
        logger.error(
          `Failed to download repo filesystem: ${inspect(zipball, { depth: null, colors: true })}`,
        );
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to download repo filesystem`,
        });
      }

      const unzipped = fflate.unzipSync(new Uint8Array(zipball.data));

      const pathPrefix = "./" + ctx.connectedRepoPathWithoutLeadingSlash;
      const filesystem: Record<string, string | null> = Object.fromEntries(
        Object.entries(unzipped)
          .map(([filename, data]) => [
            filename.split("/").slice(1).join("/"), // root directory is `${owner}-${repo}-${sha}`
            fflate.strFromU8(data),
          ])
          .filter(([k, v]) => !k.endsWith("/") && v.trim())
          .flatMap(([k, v]) => {
            const relativePath = path.relative(pathPrefix, k);
            if (relativePath.startsWith("..")) return [];
            return [[relativePath, v] as const];
          }),
      );
      const sha = Object.keys(unzipped)[0].split("/")[0].split("-").pop()!;
      return {
        repoData: ctx.repoData,
        pathPrefix,
        filesystem,
        sha,
        branch,
        requestedBranch: requestedBranch,
        branchExists,
        defaultBranch,
      };
    }),

  listPulls: githubInstallationScopedProcedure
    .input(
      z.object({
        state: z.enum(["open", "closed", "all"]).default("open"),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { data: pulls } = await ctx.github.rest.pulls.list({ ...ctx.repo, state: input.state });
      return pulls.filter((p) => p.head.ref.includes("ide/"));
    }),

  mergePull: githubInstallationScopedProcedure
    .input(
      z.object({
        pullNumber: z.number(),
        mergeMethod: z.enum(["merge", "squash", "rebase"]).default("squash"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { data: pull } = await ctx.github.rest.pulls.merge({
        owner: ctx.repo.owner,
        repo: ctx.repo.repo,
        pull_number: input.pullNumber,
        merge_method: input.mergeMethod,
      });
      return pull;
    }),

  closePull: githubInstallationScopedProcedure
    .input(
      z.object({
        pullNumber: z.number(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { data: pull } = await ctx.github.rest.pulls.update({
        owner: ctx.repo.owner,
        repo: ctx.repo.repo,
        pull_number: input.pullNumber,
        state: "closed",
      });
      return pull;
    }),

  getDTS: protectedProcedure
    .meta({
      description: `kinda like "pnpm install" - it recursively fetches all dependencies for a packageJson struct but only gives you the typescript definition, for usage in an in-browser mini-IDE. Doesn't handle many edge cases tho so types might be missing for some packages/uncommon specifiers`,
    })
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
      const getPackage = async (name: string, specifier: string): Promise<GottenPackage> => {
        if (specifier.startsWith("github:")) {
          const [ownerAndRepo, ref = "main"] = specifier.replace("github:", "").split("#");
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

        let url: string;
        if (specifier?.match(/^https?:/)) {
          url = specifier;
        } else if (semver.validRange(specifier)) {
          const packageInfo: { versions: Record<string, {}> } = await fetch(
            `https://registry.npmjs.org/${name}`,
          ).then((r) => r.json());
          const allVersions = Object.keys(packageInfo.versions);
          const resolvedVersion =
            semver.maxSatisfying(allVersions, specifier) || specifier.replace(/^[~^]/, "");
          url = `https://registry.npmjs.org/${name}/-/${name}-${resolvedVersion}.tgz`;
        } else if (specifier.match(/^[\w-.]+$/)) {
          // looks like a dist-tag to me
          const packageInfo: {
            "dist-tags": Record<string, string>;
            versions: Record<string, { version: string }>;
          } = await fetch(`https://registry.npmjs.org/${name}`).then((r) => r.json());

          const distTagVersion = packageInfo["dist-tags"][specifier];
          if (!distTagVersion) {
            throw new Error(`No dist-tag "${specifier}" found for ${name}`);
          }

          const resolvedVersion = packageInfo.versions[distTagVersion]?.version;
          if (!resolvedVersion) {
            throw new Error(
              `${name} dist-tag ${specifier} resolved to version ${distTagVersion} but that version wasn't found on the registry.`,
            );
          }

          url = `https://registry.npmjs.org/${name}/-/${name}-${resolvedVersion}.tgz`;
        } else {
          throw new Error(`Unsupported package specifier: ${specifier}`);
        }

        const res = await fetch(url);
        const extract = tarStream.extract({});

        const files: Record<string, string> = {};

        // Stream the response directly through gunzip into tar-stream
        const nodeStream = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
        const gunzip = createGunzip();
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

        if (!files["package.json"]) {
          throw new Error(`package.json not found in ${name}@${specifier}`);
        }

        const packageJson = JSON.parse(files["package.json"]) as import("type-fest").PackageJson;

        if (!packageJson.name) {
          throw new Error(`Couldn't find valid package.json for ${name}@${specifier}`);
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

      const response = await stub.raw.fetch("http://do/state" as never);
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

  triggerRebuild: githubInstallationScopedProcedure
    .input(
      z.object({
        target: z.string().min(1, "Target is required"),
        targetType: z.enum(["branch", "commit"]).default("branch"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { estateId, target, targetType } = input;

      let commitHash: string;
      let commitMessage: string;

      if (targetType === "commit") {
        const commitResponse = await ctx.github.rest.repos.getCommit({
          owner: ctx.repo.owner,
          repo: ctx.repo.repo,
          ref: target,
        });

        if (commitResponse.status !== 200) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Failed to fetch commit details: ${target}`,
          });
        }

        commitHash = commitResponse.data.sha;
        commitMessage = commitResponse.data.commit.message;
      } else {
        const branchResponse = await ctx.github.rest.repos.getBranch({
          owner: ctx.repo.owner,
          repo: ctx.repo.repo,
          branch: target,
        });

        if (branchResponse.status !== 200) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Failed to fetch branch details: ${target}`,
          });
        }

        commitHash = branchResponse.data.commit.sha;
        commitMessage = branchResponse.data.commit.commit.message;
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

  // Mark a user onboarding step as completed
  completeUserOnboardingStep: estateProtectedProcedure
    .input(
      z.object({
        step: z.enum(["confirm_org", "slack"]),
        detail: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.db.transaction(async (tx) => {
        // Append immutable confirmation event
        await tx
          .insert(schema.estateOnboardingEvent)
          .values({
            estateId: ctx.estate.id,
            organizationId: ctx.estate.organizationId,
            eventType: input.step === "confirm_org" ? "OrgNameConfirmed" : "SlackAdded",
            category: "user",
            detail: input.detail ?? null,
            metadata: { skipped: false },
          })
          .onConflictDoNothing();

        await tx
          .insert(schema.estateOnboardingEvent)
          .values({
            estateId: input.estateId,
            organizationId: ctx.estate.organizationId,
            eventType: "OnboardingCompleted",
            category: "user",
          })
          .onConflictDoNothing();
      });

      return { success: true } as const;
    }),
});
