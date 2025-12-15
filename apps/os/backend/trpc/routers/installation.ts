import * as path from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { inspect } from "node:util";
import * as semver from "semver";
import * as tarStream from "tar-stream";
import * as fflate from "fflate/browser";
import { z } from "zod";
import { eq, desc, and, notInArray, or } from "drizzle-orm";
import dedent from "dedent";
import { TRPCError } from "@trpc/server";
import {
  protectedProcedure,
  installationProtectedProcedure,
  getUserInstallationAccess,
  router,
  protectedProcedureWithNoInstallationRestrictions,
} from "../trpc.ts";
import {
  installation,
  agentInstance,
  iterateConfig,
  organizationUserMembership,
  organization,
} from "../../db/schema.ts";
import {
  getOctokitForInstallation,
  githubAppInstance,
  triggerGithubBuild,
} from "../../integrations/github/github-utils.ts";
import { schema, type DB } from "../../db/client.ts";
import { type CloudflareEnv } from "../../../env.ts";
import type { OnboardingData } from "../../agent/onboarding-agent.ts";
import { getAgentStubByName, toAgentClassName } from "../../agent/agents/stub-getters.ts";
import { slackChannelOverrideExists } from "../../utils/trial-channel-setup.ts";
import { logger } from "../../tag-logger.ts";
import { recentActiveSources } from "../../db/helpers.ts";
import { CreateCommitOnBranchInput } from "./github-schemas.ts";

export const RepoData = z.object({
  id: z.number(),
  full_name: z.string(),
  html_url: z.string(),
  clone_url: z.string(),
});

const getInstallationScopedContext = async (options: {
  db: DB;
  installationId: string;
  connectedRepoId: number;
  connectedRepoAccountId: string;
}) => {
  const scopedOctokit = await getOctokitForInstallation(options.connectedRepoAccountId);

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
  };
};

const githubInstallationScopedProcedure = installationProtectedProcedure.use(
  async ({ ctx, next }) => {
    if (!ctx.installation.connectedRepoId)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "No GitHub repository connected to this installation",
      });

    const { octokit, repoData } = await getInstallationScopedContext({
      db: ctx.db,
      installationId: ctx.installation.id,
      connectedRepoId: ctx.installation.connectedRepoId,
      connectedRepoAccountId: ctx.installation.connectedRepoAccountId,
    });

    return next({
      ctx: {
        ...ctx,
        installation: { ...ctx.installation, connectedRepoId: ctx.installation.connectedRepoId },
        github: octokit,
        repo: { owner: repoData.full_name.split("/")[0], repo: repoData.full_name.split("/")[1] },
        repoData,
        connectedRepoPathWithoutLeadingSlash:
          ctx.installation.connectedRepoPath?.replace(/^\//, "") || "",
        refName: ctx.installation.connectedRepoRef,
      },
    });
  },
);

export async function triggerInstallationRebuild(params: {
  db: DB;
  env: CloudflareEnv;
  installationId: string;
  commitHash: string;
  commitMessage: string;
  isManual?: boolean;
}) {
  const { db, installationId, commitHash, commitMessage, isManual = false } = params;

  const _installationWithRepo = await db.query.installation.findFirst({
    where: eq(installation.id, installationId),
    with: recentActiveSources,
  });

  const installationWithRepo = _installationWithRepo && {
    ..._installationWithRepo,
    connectedRepoId: _installationWithRepo?.sources?.[0]?.repoId,
    connectedRepoPath: _installationWithRepo?.sources?.[0]?.path,
    connectedRepoRef: _installationWithRepo?.sources?.[0]?.branch,
    connectedRepoAccountId: _installationWithRepo?.sources?.[0]?.accountId,
  };

  if (!installationWithRepo?.connectedRepoId || !installationWithRepo?.connectedRepoAccountId) {
    throw new Error("No GitHub repository connected to this installation");
  }

  const { repoData } = await getInstallationScopedContext({
    db,
    installationId,
    connectedRepoId: installationWithRepo.connectedRepoId,
    connectedRepoAccountId: installationWithRepo.connectedRepoAccountId,
  });

  const installationToken =
    await githubAppInstance().octokit.rest.apps.createInstallationAccessToken({
      installation_id: parseInt(installationWithRepo.connectedRepoAccountId),
      repository_ids: [installationWithRepo.connectedRepoId],
    });

  if (installationToken.status !== 201) {
    throw new Error(
      `Failed to create installation token: ${installationToken.status} ${JSON.stringify(installationToken.data)}`,
    );
  }

  return await triggerGithubBuild({
    installationId: installationId, // TODO: rename to installationId in triggerGithubBuild
    commitHash,
    commitMessage,
    repoUrl: repoData.clone_url,
    installationToken: installationToken.data.token,
    connectedRepoPath: installationWithRepo.connectedRepoPath || "/",
    branch: installationWithRepo.connectedRepoRef || "main",
    isManual,
  });
}

export const installationRouter = router({
  list: protectedProcedure
    .input(z.object({ organizationId: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const memberships = await ctx.db.query.organizationUserMembership.findMany({
        where: and(
          eq(organizationUserMembership.userId, ctx.user.id),
          input?.organizationId
            ? eq(organizationUserMembership.organizationId, input.organizationId)
            : undefined,
        ),
        with: {
          organization: {
            with: {
              installations: true,
            },
          },
        },
      });

      const installations = memberships.flatMap(({ organization }) =>
        organization.installations.map((inst) => ({
          id: inst.id,
          name: inst.name,
          slug: inst.slug,
          organizationId: inst.organizationId,
          organizationName: organization.name,
          createdAt: inst.createdAt,
          updatedAt: inst.updatedAt,
        })),
      );

      return installations;
    }),

  checkAccess: protectedProcedureWithNoInstallationRestrictions
    .input(
      z.object({
        installationId: z.string(),
        organizationId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      try {
        const result = await getUserInstallationAccess(
          ctx.db,
          ctx.user.id,
          input.installationId,
          input.organizationId,
        );

        if (result.hasAccess && result.installation) {
          return {
            hasAccess: true,
            installation: {
              id: result.installation.id,
              name: result.installation.name,
              slug: result.installation.slug,
              organizationId: result.installation.organizationId,
            },
          };
        }

        return { hasAccess: false, installation: null };
      } catch {
        return { hasAccess: false, installation: null };
      }
    }),

  getBySlug: protectedProcedureWithNoInstallationRestrictions
    .input(z.object({ slug: z.string() }))
    .query(async ({ ctx, input }) => {
      const inst = await ctx.db.query.installation.findFirst({
        where: eq(installation.slug, input.slug),
        with: {
          organization: true,
        },
      });

      if (!inst) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Installation with slug "${input.slug}" not found`,
        });
      }

      const membership = await ctx.db.query.organizationUserMembership.findFirst({
        where: and(
          eq(organizationUserMembership.userId, ctx.user.id),
          eq(organizationUserMembership.organizationId, inst.organizationId),
        ),
      });

      if (!membership && ctx.user.role !== "admin") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You do not have access to this installation",
        });
      }

      return {
        id: inst.id,
        slug: inst.slug,
        name: inst.name,
        organizationId: inst.organizationId,
        organization: {
          id: inst.organization.id,
          name: inst.organization.name,
        },
        createdAt: inst.createdAt,
        updatedAt: inst.updatedAt,
      };
    }),

  get: installationProtectedProcedure.query(async ({ ctx }) => {
    const userInstallation = ctx.installation;

    const org = await ctx.db.query.organization.findFirst({
      where: eq(organization.id, userInstallation.organizationId),
    });

    const isTrial = await slackChannelOverrideExists(ctx.db, userInstallation.id);

    return {
      id: userInstallation.id,
      slug: userInstallation.slug,
      name: userInstallation.name,
      organizationId: userInstallation.organizationId,
      onboardingAgentName: userInstallation.onboardingAgentName ?? null,
      isTrialInstallation: isTrial,
      organization: org
        ? {
            id: org.id,
            name: org.name,
          }
        : undefined,
      createdAt: userInstallation.createdAt,
      updatedAt: userInstallation.updatedAt,
    };
  }),

  listAllForUser: protectedProcedure.query(async ({ ctx }) => {
    const memberships = await ctx.db.query.organizationUserMembership.findMany({
      where: and(
        eq(organizationUserMembership.userId, ctx.user.id),
        notInArray(organizationUserMembership.role, ["external", "guest"]),
      ),
      with: {
        organization: {
          with: {
            installations: true,
          },
        },
      },
    });

    const installations = await Promise.all(
      memberships.flatMap((membership) =>
        membership.organization.installations.map(async (inst) => ({
          id: inst.id,
          slug: inst.slug,
          name: inst.name,
          organizationId: inst.organizationId,
          organization: {
            id: membership.organization.id,
            name: membership.organization.name,
          },
          isTrialInstallation: await slackChannelOverrideExists(ctx.db, inst.id),
          createdAt: inst.createdAt,
          updatedAt: inst.updatedAt,
        })),
      ),
    );

    return installations;
  }),

  getCompiledIterateConfig: installationProtectedProcedure.query(async ({ ctx }) => {
    const record = await ctx.db.query.iterateConfig.findFirst({
      where: eq(iterateConfig.installationId, ctx.installation.id),
      with: { build: true },
    });

    return {
      config: record?.build?.config ?? null,
      updatedAt: record?.updatedAt ?? null,
    };
  }),

  updateName: installationProtectedProcedure
    .input(
      z.object({
        name: z
          .string()
          .min(1, "Installation name cannot be empty")
          .max(100, "Installation name too long"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const installationId = ctx.installation.id;

      const updatedInstallation = await ctx.db
        .update(installation)
        .set({
          name: input.name,
          updatedAt: new Date(),
        })
        .where(eq(installation.id, installationId))
        .returning();

      if (!updatedInstallation[0]) {
        throw new Error("Failed to update installation");
      }

      return {
        id: updatedInstallation[0].id,
        slug: updatedInstallation[0].slug,
        name: updatedInstallation[0].name,
        organizationId: updatedInstallation[0].organizationId,
        createdAt: updatedInstallation[0].createdAt,
        updatedAt: updatedInstallation[0].updatedAt,
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
        const defaultBranch = await ctx.github.rest.repos.getBranch({
          owner: ctx.repo.owner,
          repo: ctx.repo.repo,
          branch: ctx.installation.connectedRepoRef!,
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

      let branch = requestedBranch;
      let branchExists = true;
      let sha: string | undefined;
      try {
        const branchResponse = await ctx.github.rest.repos.getBranch({
          owner: ctx.repo.owner,
          repo: ctx.repo.repo,
          branch: requestedBranch,
        });
        sha = branchResponse.data?.commit?.sha;
        if (branchResponse.status !== 200) {
          branchExists = false;
          branch = defaultBranch;
        }
      } catch (_error: unknown) {
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
            filename.split("/").slice(1).join("/"),
            fflate.strFromU8(data),
          ])
          .filter(([k, v]) => !k.endsWith("/") && v.trim())
          .flatMap(([k, v]) => {
            const relativePath = path.relative(pathPrefix, k);
            if (relativePath.startsWith("..")) return [];
            return [[relativePath, v] as const];
          }),
      );
      sha ||= Object.keys(unzipped)[0].split("/")[0].split("-").pop()!;
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
      return pulls.filter((p) => p.head.ref.match(/\bide\//));
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
        overrides: z.record(z.string(), z.string()).optional(),
      }),
    )
    .query(async ({ input }) => {
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
                const filename = zipballPath.split("/").slice(1).join("/");
                return [filename, data] as const;
              })
              .filter(([filename]) => filename.endsWith(".d.ts") || filename === "package.json")
              .map(([filename, data]) => [filename, fflate.strFromU8(data)])
              .filter(([k, v]) => !k.endsWith("/") && v.trim()),
          );
          return { files: filesystem, packageJson: JSON.parse(filesystem["package.json"]!) };
        }

        let url: string;
        if (`${name}@${specifier}` in (input.overrides || {})) {
          const override = input.overrides![`${name}@${specifier}`];
          url = override;
        } else if (specifier?.match(/^https?:/)) {
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

  getBuilds: installationProtectedProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(20).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { installationId } = input;
      const limit = input.limit || 20;

      const buildsWithConfig = await ctx.db.query.builds.findMany({
        where: eq(schema.builds.installationId, installationId),
        orderBy: desc(schema.builds.createdAt),
        limit: limit,
      });

      const activeConfig = await ctx.db.query.iterateConfig.findFirst({
        where: eq(schema.iterateConfig.installationId, installationId),
      });

      return buildsWithConfig.map((b) => ({
        ...b,
        isActive: b.id === activeConfig?.buildId,
      }));
    }),

  getOnboardingStatus: installationProtectedProcedure.query(async ({ ctx }) => {
    const installationId = ctx.installation.id;

    const installationData = await ctx.db.query.installation.findFirst({
      where: eq(installation.id, installationId),
    });

    if (!installationData) {
      throw new Error("Installation not found");
    }

    if (!installationData.onboardingAgentName) {
      return {
        status: "completed" as const,
        agentName: null,
        onboardingData: null,
      };
    }

    const agent = await ctx.db.query.agentInstance.findFirst({
      where: and(
        eq(agentInstance.installationId, installationId),
        eq(agentInstance.durableObjectName, installationData.onboardingAgentName),
      ),
    });

    if (!agent) {
      return {
        status: "in-progress" as const,
        agentName: installationData.onboardingAgentName,
        onboardingData: {},
      };
    }

    try {
      const stub = await getAgentStubByName(toAgentClassName(agent.className), {
        db: ctx.db,
        agentInstanceName: agent.durableObjectName,
      });

      const response = await stub.raw.fetch("http://do/state" as never);
      const state = (await response.json()) as { onboardingData?: OnboardingData };

      return {
        status: "in-progress" as const,
        agentName: installationData.onboardingAgentName,
        onboardingData: state.onboardingData ?? {},
      };
    } catch (_error) {
      return {
        status: "in-progress" as const,
        agentName: installationData.onboardingAgentName,
        onboardingData: {},
      };
    }
  }),

  getOnboardingResults: installationProtectedProcedure.query(async ({ ctx }) => {
    const installationId = ctx.installation.id;

    const installationData = await ctx.db.query.installation.findFirst({
      where: eq(installation.id, installationId),
    });

    if (!installationData?.onboardingAgentName) {
      return { results: {} as Record<string, unknown> };
    }

    const agent = await ctx.db.query.agentInstance.findFirst({
      where: and(
        eq(agentInstance.installationId, installationId),
        eq(agentInstance.durableObjectName, installationData.onboardingAgentName),
      ),
    });

    if (!agent) {
      return { results: {} as Record<string, unknown> };
    }

    const stub = await getAgentStubByName(toAgentClassName(agent.className), {
      db: ctx.db,
      agentInstanceName: agent.durableObjectName,
    });

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
        useExisting: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { installationId, target, targetType } = input;

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

      if (input.useExisting) {
        const existing = await ctx.db.query.builds.findFirst({
          where: and(
            eq(schema.builds.installationId, installationId),
            eq(schema.builds.commitHash, commitHash),
            or(eq(schema.builds.status, "in_progress"), eq(schema.builds.status, "queued")),
          ),
        });
        if (existing) {
          return {
            buildId: existing.id,
            status: "in_progress",
            message: existing.commitMessage,
          };
        }
      }

      const build = await triggerInstallationRebuild({
        db: ctx.db,
        env: ctx.env,
        installationId,
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

  rollbackToBuild: githubInstallationScopedProcedure
    .input(z.object({ buildId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { buildId } = input;
      const updated = await ctx.db
        .insert(schema.iterateConfig)
        .values({ buildId, installationId: ctx.installation.id })
        .onConflictDoUpdate({
          target: [schema.iterateConfig.installationId],
          set: { buildId },
        })
        .returning();
      return { updated: updated.length };
    }),

  completeUserOnboardingStep: installationProtectedProcedure
    .input(
      z.object({
        step: z.enum(["confirm_org", "slack"]),
        detail: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.db.transaction(async (tx) => {
        await tx
          .insert(schema.installationOnboardingEvent)
          .values({
            installationId: ctx.installation.id,
            organizationId: ctx.installation.organizationId,
            eventType: input.step === "confirm_org" ? "OrgNameConfirmed" : "SlackAdded",
            category: "user",
            detail: input.detail ?? null,
            metadata: { skipped: false },
          })
          .onConflictDoNothing();

        await tx
          .insert(schema.installationOnboardingEvent)
          .values({
            installationId: input.installationId,
            organizationId: ctx.installation.organizationId,
            eventType: "OnboardingCompleted",
            category: "user",
          })
          .onConflictDoNothing();
      });

      return { success: true } as const;
    }),
});
