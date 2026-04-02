import { spawn } from "node:child_process";
import { os } from "@orpc/server";
import { z } from "zod";
import {
  CloudflarePreviewCommentEntry,
  type CloudflarePreviewCommentEntry as CloudflarePreviewCommentEntryType,
  clearCloudflarePreviewDestroyPayload,
  readCloudflarePreviewCommentState,
  upsertCloudflarePreviewCommentEntry,
} from "./cloudflare-preview-comment.ts";

const defaultSemaphoreBaseUrl = "https://semaphore.iterate.com";
const defaultPreviewLeaseMs = 30 * 24 * 60 * 60 * 1000;

type PreviewSemaphoreResourceClient = {
  acquire: (input: { leaseMs: number; type: string; waitMs?: number }) => Promise<{
    expiresAt: number;
    leaseId: string;
    slug: string;
  }>;
  release: (input: { leaseId: string; slug: string; type: string }) => Promise<{
    released: boolean;
  }>;
};

type PreviewSyncResult = {
  entry: CloudflarePreviewCommentEntryType;
  ok: boolean;
};

type CreateCloudflarePreviewScriptRouterOptions = {
  appDisplayName: string;
  appSlug: string;
  createPreviewSemaphoreResourceClient: (input: {
    semaphoreApiToken: string;
    semaphoreBaseUrl: string;
  }) => PreviewSemaphoreResourceClient;
  dopplerProject: string;
  env: NodeJS.ProcessEnv;
  previewResourceType: string;
  previewTestBaseUrlEnvVar: string;
  previewTestCommandArgs: readonly [string, ...string[]];
  workingDirectory: string;
};

export function createCloudflarePreviewScriptRouter(
  options: CreateCloudflarePreviewScriptRouterOptions,
) {
  const previewCreateInput = createPreviewCreateInputSchema(options.env);
  const previewDestroyInput = createPreviewDestroyInputSchema(options.env);
  const previewSyncPrInput = createPreviewSyncPrInputSchema(options.env);
  const previewCleanupPrInput = createPreviewCleanupPrInputSchema(options.env);
  const previewCommentReadInput = createPreviewCommentReadInputSchema(options.env);
  const previewCommentUpsertInput = createPreviewCommentUpsertInputSchema(options.env);

  return {
    "preview-create": os
      .input(previewCreateInput)
      .meta({
        description: `Acquire, deploy, and test a ${options.appDisplayName} preview environment`,
      })
      .handler(async ({ input, signal }) => {
        return createPreviewEnvironment({
          ...input,
          signal,
          ...options,
        });
      }),
    "preview-destroy": os
      .input(previewDestroyInput)
      .meta({
        description: `Tear down and release a ${options.appDisplayName} preview environment`,
      })
      .handler(async ({ input, signal }) => {
        return destroyPreviewEnvironment({
          ...input,
          signal,
          ...options,
        });
      }),
    "preview-comment-read": os
      .input(previewCommentReadInput)
      .meta({
        description: `Read the shared sticky GitHub preview comment for ${options.appDisplayName}`,
      })
      .handler(async ({ input }) => {
        return readCloudflarePreviewCommentState({
          ...input,
          appSlug: options.appSlug,
        });
      }),
    "preview-comment-upsert": os
      .input(previewCommentUpsertInput)
      .meta({
        description: `Upsert the ${options.appDisplayName} entry in the shared sticky GitHub preview comment`,
      })
      .handler(async ({ input }) => {
        return upsertCloudflarePreviewCommentEntry(input);
      }),
    "preview-sync-pr": os
      .input(previewSyncPrInput)
      .meta({
        description: `Recreate the ${options.appDisplayName} preview for the current pull request and update the sticky GitHub comment`,
      })
      .handler(async ({ input, signal }) => {
        const result = await syncPreviewForPullRequest({
          ...input,
          signal,
          ...options,
        });
        if (!result.ok) {
          throw new Error(
            result.entry.message ?? `Failed to sync ${options.appDisplayName} preview.`,
          );
        }
        return result;
      }),
    "preview-cleanup-pr": os
      .input(previewCleanupPrInput)
      .meta({
        description: `Clean up the ${options.appDisplayName} preview recorded on the sticky GitHub comment`,
      })
      .handler(async ({ input, signal }) => {
        const result = await cleanupPreviewForPullRequest({
          ...input,
          signal,
          ...options,
        });
        if (!result.ok) {
          throw new Error(
            result.entry?.message ?? `Failed to clean up ${options.appDisplayName} preview.`,
          );
        }
        return result;
      }),
  };
}

function createPreviewCreateInputSchema(env: NodeJS.ProcessEnv) {
  return z.object({
    pullRequestHeadRefName: requiredStringWithEnvDefault(env, "GITHUB_HEAD_REF"),
    pullRequestHeadSha: requiredStringWithEnvDefault(env, "GITHUB_SHA"),
    pullRequestNumber: requiredNumberWithEnvDefault(env, "GITHUB_PR_NUMBER"),
    repositoryFullName: requiredStringWithEnvDefault(env, "GITHUB_REPOSITORY"),
    semaphoreApiToken: semaphoreApiTokenWithEnvDefault(env),
    semaphoreBaseUrl: requiredUrlWithEnvDefault(env, "SEMAPHORE_BASE_URL", {
      defaultValue: defaultSemaphoreBaseUrl,
    }),
    waitMs: optionalNumberWithEnvDefault(env, "PREVIEW_WAIT_MS"),
    workflowRunUrl: requiredUrlWithEnvDefault(env, "WORKFLOW_RUN_URL", {
      defaultValue: makeDefaultWorkflowRunUrl(env),
    }),
    leaseMs: requiredNumberWithEnvDefault(env, "PREVIEW_LEASE_MS", {
      defaultValue: defaultPreviewLeaseMs,
    }),
  });
}

function createPreviewDestroyInputSchema(env: NodeJS.ProcessEnv) {
  return z.object({
    previewEnvironmentAlchemyStageName: requiredStringWithEnvDefault(
      env,
      "PREVIEW_ENVIRONMENT_ALCHEMY_STAGE_NAME",
    ),
    previewEnvironmentDopplerConfigName: requiredStringWithEnvDefault(
      env,
      "PREVIEW_ENVIRONMENT_DOPPLER_CONFIG_NAME",
    ),
    previewEnvironmentIdentifier: requiredStringWithEnvDefault(
      env,
      "PREVIEW_ENVIRONMENT_IDENTIFIER",
    ),
    previewEnvironmentSemaphoreLeaseId: requiredStringWithEnvDefault(
      env,
      "PREVIEW_ENVIRONMENT_SEMAPHORE_LEASE_ID",
    ).pipe(z.string().trim().uuid()),
    previewEnvironmentSlug: requiredStringWithEnvDefault(env, "PREVIEW_ENVIRONMENT_SLUG"),
    previewEnvironmentType: requiredStringWithEnvDefault(env, "PREVIEW_ENVIRONMENT_TYPE"),
    semaphoreApiToken: semaphoreApiTokenWithEnvDefault(env),
    semaphoreBaseUrl: requiredUrlWithEnvDefault(env, "SEMAPHORE_BASE_URL", {
      defaultValue: defaultSemaphoreBaseUrl,
    }),
  });
}

function createPreviewSyncPrInputSchema(env: NodeJS.ProcessEnv) {
  return z.object({
    githubToken: requiredStringWithEnvDefault(env, "GITHUB_TOKEN"),
    pullRequestHeadRefName: requiredStringWithEnvDefault(env, "GITHUB_HEAD_REF"),
    pullRequestHeadSha: requiredStringWithEnvDefault(env, "GITHUB_SHA"),
    pullRequestNumber: requiredNumberWithEnvDefault(env, "GITHUB_PR_NUMBER"),
    repositoryFullName: requiredStringWithEnvDefault(env, "GITHUB_REPOSITORY"),
    semaphoreApiToken: optionalSemaphoreApiTokenWithEnvDefault(env),
    semaphoreBaseUrl: optionalUrlWithEnvDefault(env, "SEMAPHORE_BASE_URL", {
      defaultValue: defaultSemaphoreBaseUrl,
    }),
    workflowRunUrl: requiredUrlWithEnvDefault(env, "WORKFLOW_RUN_URL", {
      defaultValue: makeDefaultWorkflowRunUrl(env),
    }),
    leaseMs: requiredNumberWithEnvDefault(env, "PREVIEW_LEASE_MS", {
      defaultValue: defaultPreviewLeaseMs,
    }),
    waitMs: optionalNumberWithEnvDefault(env, "PREVIEW_WAIT_MS"),
    isFork: requiredBooleanWithEnvDefault(env, "GITHUB_PR_IS_FORK", {
      defaultValue: false,
    }),
  });
}

function createPreviewCleanupPrInputSchema(env: NodeJS.ProcessEnv) {
  return z.object({
    githubToken: requiredStringWithEnvDefault(env, "GITHUB_TOKEN"),
    pullRequestNumber: requiredNumberWithEnvDefault(env, "GITHUB_PR_NUMBER"),
    repositoryFullName: requiredStringWithEnvDefault(env, "GITHUB_REPOSITORY"),
    semaphoreApiToken: optionalSemaphoreApiTokenWithEnvDefault(env),
    semaphoreBaseUrl: optionalUrlWithEnvDefault(env, "SEMAPHORE_BASE_URL", {
      defaultValue: defaultSemaphoreBaseUrl,
    }),
  });
}

function createPreviewCommentReadInputSchema(env: NodeJS.ProcessEnv) {
  return z.object({
    githubToken: requiredStringWithEnvDefault(env, "GITHUB_TOKEN"),
    pullRequestNumber: requiredNumberWithEnvDefault(env, "GITHUB_PR_NUMBER"),
    repositoryFullName: requiredStringWithEnvDefault(env, "GITHUB_REPOSITORY"),
  });
}

function createPreviewCommentUpsertInputSchema(env: NodeJS.ProcessEnv) {
  return z.object({
    entry: CloudflarePreviewCommentEntry,
    githubToken: requiredStringWithEnvDefault(env, "GITHUB_TOKEN"),
    pullRequestNumber: requiredNumberWithEnvDefault(env, "GITHUB_PR_NUMBER"),
    repositoryFullName: requiredStringWithEnvDefault(env, "GITHUB_REPOSITORY"),
  });
}

async function syncPreviewForPullRequest(
  params: z.infer<ReturnType<typeof createPreviewSyncPrInputSchema>> & {
    appDisplayName: string;
    appSlug: string;
    createPreviewSemaphoreResourceClient: (input: {
      semaphoreApiToken: string;
      semaphoreBaseUrl: string;
    }) => PreviewSemaphoreResourceClient;
    dopplerProject: string;
    env: NodeJS.ProcessEnv;
    previewResourceType: string;
    previewTestBaseUrlEnvVar: string;
    previewTestCommandArgs: readonly [string, ...string[]];
    signal?: AbortSignal;
    workingDirectory: string;
  },
): Promise<PreviewSyncResult> {
  if (params.isFork) {
    const entry = CloudflarePreviewCommentEntry.parse({
      appDisplayName: params.appDisplayName,
      appSlug: params.appSlug,
      message: "Preview environments are unavailable for fork pull requests.",
      runUrl: params.workflowRunUrl,
      shortSha: params.pullRequestHeadSha.slice(0, 7),
      status: "fork-unavailable",
      updatedAt: new Date().toISOString(),
    });
    try {
      await upsertCloudflarePreviewCommentEntry({
        entry,
        githubToken: params.githubToken,
        repositoryFullName: params.repositoryFullName,
        pullRequestNumber: params.pullRequestNumber,
      });
    } catch {
      // Fork PRs do not create preview resources, so a denied comment write should not fail the job.
    }
    return {
      entry,
      ok: true,
    };
  }

  const current = await readCloudflarePreviewCommentState({
    appSlug: params.appSlug,
    githubToken: params.githubToken,
    repositoryFullName: params.repositoryFullName,
    pullRequestNumber: params.pullRequestNumber,
  });
  const previousEntry = current.state[params.appSlug];
  if (hasPreviewDestroyPayload(previousEntry)) {
    const cleanupResult = await destroyPreviewEnvironment({
      appDisplayName: params.appDisplayName,
      appSlug: params.appSlug,
      createPreviewSemaphoreResourceClient: params.createPreviewSemaphoreResourceClient,
      dopplerProject: params.dopplerProject,
      env: params.env,
      previewEnvironmentAlchemyStageName: previousEntry.previewEnvironmentAlchemyStageName,
      previewEnvironmentDopplerConfigName: previousEntry.previewEnvironmentDopplerConfigName,
      previewEnvironmentIdentifier: previousEntry.previewEnvironmentIdentifier,
      previewEnvironmentSemaphoreLeaseId: previousEntry.previewEnvironmentSemaphoreLeaseId,
      previewEnvironmentSlug: previousEntry.previewEnvironmentSlug,
      previewEnvironmentType: previousEntry.previewEnvironmentType,
      previewResourceType: params.previewResourceType,
      previewTestBaseUrlEnvVar: params.previewTestBaseUrlEnvVar,
      previewTestCommandArgs: params.previewTestCommandArgs,
      semaphoreApiToken: requireValue(
        params.semaphoreApiToken ?? params.env.APP_CONFIG_SHARED_API_SECRET?.trim(),
        "SEMAPHORE_API_TOKEN is required to destroy an existing preview.",
      ),
      semaphoreBaseUrl: params.semaphoreBaseUrl ?? defaultSemaphoreBaseUrl,
      signal: params.signal,
      workingDirectory: params.workingDirectory,
    });
    if (!cleanupResult.ok) {
      const cleanupEntry = {
        ...previousEntry,
        appDisplayName: params.appDisplayName,
        appSlug: params.appSlug,
        message: cleanupResult.message,
        runUrl: params.workflowRunUrl,
        shortSha: params.pullRequestHeadSha.slice(0, 7),
        status: "cleanup-failed",
        updatedAt: new Date().toISOString(),
      } satisfies CloudflarePreviewCommentEntryType;
      await upsertCloudflarePreviewCommentEntry({
        entry: CloudflarePreviewCommentEntry.parse(cleanupEntry),
        githubToken: params.githubToken,
        repositoryFullName: params.repositoryFullName,
        pullRequestNumber: params.pullRequestNumber,
      });
      return {
        entry: CloudflarePreviewCommentEntry.parse(cleanupEntry),
        ok: false,
      };
    }
  }

  const createResult = await createPreviewEnvironment({
    appDisplayName: params.appDisplayName,
    appSlug: params.appSlug,
    createPreviewSemaphoreResourceClient: params.createPreviewSemaphoreResourceClient,
    dopplerProject: params.dopplerProject,
    env: params.env,
    leaseMs: params.leaseMs,
    previewResourceType: params.previewResourceType,
    previewTestBaseUrlEnvVar: params.previewTestBaseUrlEnvVar,
    previewTestCommandArgs: params.previewTestCommandArgs,
    pullRequestHeadRefName: params.pullRequestHeadRefName,
    pullRequestHeadSha: params.pullRequestHeadSha,
    pullRequestNumber: params.pullRequestNumber,
    repositoryFullName: params.repositoryFullName,
    semaphoreApiToken: requireValue(
      params.semaphoreApiToken ?? params.env.APP_CONFIG_SHARED_API_SECRET?.trim(),
      "SEMAPHORE_API_TOKEN is required to create a preview.",
    ),
    semaphoreBaseUrl: params.semaphoreBaseUrl ?? defaultSemaphoreBaseUrl,
    signal: params.signal,
    waitMs: params.waitMs,
    workflowRunUrl: params.workflowRunUrl,
    workingDirectory: params.workingDirectory,
  });
  await upsertCloudflarePreviewCommentEntry({
    entry: createResult.entry,
    githubToken: params.githubToken,
    repositoryFullName: params.repositoryFullName,
    pullRequestNumber: params.pullRequestNumber,
  });
  return createResult;
}

async function cleanupPreviewForPullRequest(
  params: z.infer<ReturnType<typeof createPreviewCleanupPrInputSchema>> & {
    appDisplayName: string;
    appSlug: string;
    createPreviewSemaphoreResourceClient: (input: {
      semaphoreApiToken: string;
      semaphoreBaseUrl: string;
    }) => PreviewSemaphoreResourceClient;
    dopplerProject: string;
    env: NodeJS.ProcessEnv;
    previewResourceType: string;
    previewTestBaseUrlEnvVar: string;
    previewTestCommandArgs: readonly [string, ...string[]];
    signal?: AbortSignal;
    workingDirectory: string;
  },
) {
  const current = await readCloudflarePreviewCommentState({
    appSlug: params.appSlug,
    githubToken: params.githubToken,
    repositoryFullName: params.repositoryFullName,
    pullRequestNumber: params.pullRequestNumber,
  });
  const existingEntry = current.state[params.appSlug];
  if (!hasPreviewDestroyPayload(existingEntry)) {
    return {
      entry: existingEntry ?? null,
      ok: true,
      released: false,
    };
  }

  const destroyResult = await destroyPreviewEnvironment({
    appDisplayName: params.appDisplayName,
    appSlug: params.appSlug,
    createPreviewSemaphoreResourceClient: params.createPreviewSemaphoreResourceClient,
    dopplerProject: params.dopplerProject,
    env: params.env,
    previewEnvironmentAlchemyStageName: existingEntry.previewEnvironmentAlchemyStageName,
    previewEnvironmentDopplerConfigName: existingEntry.previewEnvironmentDopplerConfigName,
    previewEnvironmentIdentifier: existingEntry.previewEnvironmentIdentifier,
    previewEnvironmentSemaphoreLeaseId: existingEntry.previewEnvironmentSemaphoreLeaseId,
    previewEnvironmentSlug: existingEntry.previewEnvironmentSlug,
    previewEnvironmentType: existingEntry.previewEnvironmentType,
    previewResourceType: params.previewResourceType,
    previewTestBaseUrlEnvVar: params.previewTestBaseUrlEnvVar,
    previewTestCommandArgs: params.previewTestCommandArgs,
    semaphoreApiToken: requireValue(
      params.semaphoreApiToken ?? params.env.APP_CONFIG_SHARED_API_SECRET?.trim(),
      "SEMAPHORE_API_TOKEN is required to clean up previews.",
    ),
    semaphoreBaseUrl: params.semaphoreBaseUrl ?? defaultSemaphoreBaseUrl,
    signal: params.signal,
    workingDirectory: params.workingDirectory,
  });

  const nextEntry = CloudflarePreviewCommentEntry.parse(
    destroyResult.ok
      ? {
          ...clearCloudflarePreviewDestroyPayload(existingEntry),
          appDisplayName: params.appDisplayName,
          appSlug: params.appSlug,
          message: destroyResult.message,
          status: "released",
          updatedAt: new Date().toISOString(),
        }
      : {
          ...existingEntry,
          appDisplayName: params.appDisplayName,
          appSlug: params.appSlug,
          message: destroyResult.message,
          status: "cleanup-failed",
          updatedAt: new Date().toISOString(),
        },
  );
  await upsertCloudflarePreviewCommentEntry({
    entry: nextEntry,
    githubToken: params.githubToken,
    repositoryFullName: params.repositoryFullName,
    pullRequestNumber: params.pullRequestNumber,
  });

  return {
    entry: nextEntry,
    ok: destroyResult.ok,
    released: destroyResult.ok,
  };
}

async function createPreviewEnvironment(
  params: z.infer<ReturnType<typeof createPreviewCreateInputSchema>> & {
    appDisplayName: string;
    appSlug: string;
    createPreviewSemaphoreResourceClient: (input: {
      semaphoreApiToken: string;
      semaphoreBaseUrl: string;
    }) => PreviewSemaphoreResourceClient;
    dopplerProject: string;
    env: NodeJS.ProcessEnv;
    previewResourceType: string;
    previewTestBaseUrlEnvVar: string;
    previewTestCommandArgs: readonly [string, ...string[]];
    signal?: AbortSignal;
    workingDirectory: string;
  },
): Promise<PreviewSyncResult> {
  let lease: {
    expiresAt: number;
    leaseId: string;
    slug: string;
  } | null = null;

  try {
    const semaphore = params.createPreviewSemaphoreResourceClient({
      semaphoreApiToken: params.semaphoreApiToken,
      semaphoreBaseUrl: params.semaphoreBaseUrl,
    });
    lease = await semaphore.acquire({
      type: params.previewResourceType,
      leaseMs: params.leaseMs,
      waitMs: params.waitMs,
    });
    const previewEnvironment = derivePreviewEnvironment({
      appSlug: params.appSlug,
      previewEnvironmentSlug: lease.slug,
      previewEnvironmentType: params.previewResourceType,
    });
    const baseEntry = {
      appDisplayName: params.appDisplayName,
      appSlug: params.appSlug,
      leasedUntil: lease.expiresAt,
      previewEnvironmentAlchemyStageName: previewEnvironment.previewEnvironmentAlchemyStageName,
      previewEnvironmentDopplerConfigName: previewEnvironment.previewEnvironmentDopplerConfigName,
      previewEnvironmentIdentifier: previewEnvironment.previewEnvironmentIdentifier,
      previewEnvironmentSemaphoreLeaseId: lease.leaseId,
      previewEnvironmentSlug: lease.slug,
      previewEnvironmentType: params.previewResourceType,
      publicUrl: previewEnvironment.publicUrl,
      runUrl: params.workflowRunUrl,
      shortSha: params.pullRequestHeadSha.slice(0, 7),
      updatedAt: new Date().toISOString(),
    } as const;

    const deployResult = await runCommand({
      args: [
        "run",
        "--project",
        params.dopplerProject,
        "--config",
        previewEnvironment.previewEnvironmentDopplerConfigName,
        "--",
        "env",
        `ALCHEMY_STAGE=${previewEnvironment.previewEnvironmentAlchemyStageName}`,
        "WORKER_ROUTES=",
        "pnpm",
        "alchemy:up",
      ],
      command: "doppler",
      environment: params.env,
      signal: params.signal,
      workingDirectory: params.workingDirectory,
    });
    if (deployResult.exitCode !== 0) {
      return {
        entry: CloudflarePreviewCommentEntry.parse({
          ...baseEntry,
          message: commandFailureMessage(deployResult, "Preview deployment failed."),
          status: "deploy-failed",
        }),
        ok: false,
      };
    }

    const testResult = await runCommand({
      args: [
        "run",
        "--project",
        params.dopplerProject,
        "--config",
        previewEnvironment.previewEnvironmentDopplerConfigName,
        "--",
        "env",
        `${params.previewTestBaseUrlEnvVar}=${previewEnvironment.publicUrl}`,
        ...params.previewTestCommandArgs,
      ],
      command: "doppler",
      environment: params.env,
      signal: params.signal,
      workingDirectory: params.workingDirectory,
    });
    if (testResult.exitCode !== 0) {
      return {
        entry: CloudflarePreviewCommentEntry.parse({
          ...baseEntry,
          message: commandFailureMessage(testResult, "Preview tests failed after deploy."),
          status: "tests-failed",
        }),
        ok: false,
      };
    }

    return {
      entry: CloudflarePreviewCommentEntry.parse({
        ...baseEntry,
        status: "deployed",
      }),
      ok: true,
    };
  } catch (error) {
    if (lease) {
      try {
        const semaphore = params.createPreviewSemaphoreResourceClient({
          semaphoreApiToken: params.semaphoreApiToken,
          semaphoreBaseUrl: params.semaphoreBaseUrl,
        });
        await semaphore.release({
          type: params.previewResourceType,
          slug: lease.slug,
          leaseId: lease.leaseId,
        });
      } catch {
        // best-effort cleanup for failures before the normal preview payload is recorded
      }
    }

    return {
      entry: CloudflarePreviewCommentEntry.parse({
        appDisplayName: params.appDisplayName,
        appSlug: params.appSlug,
        message: error instanceof Error ? error.message : String(error),
        runUrl: params.workflowRunUrl,
        shortSha: params.pullRequestHeadSha.slice(0, 7),
        status: "claim-failed",
        updatedAt: new Date().toISOString(),
      }),
      ok: false,
    };
  }
}

async function destroyPreviewEnvironment(
  params: z.infer<ReturnType<typeof createPreviewDestroyInputSchema>> & {
    appDisplayName: string;
    appSlug: string;
    createPreviewSemaphoreResourceClient: (input: {
      semaphoreApiToken: string;
      semaphoreBaseUrl: string;
    }) => PreviewSemaphoreResourceClient;
    dopplerProject: string;
    env: NodeJS.ProcessEnv;
    previewResourceType: string;
    previewTestBaseUrlEnvVar: string;
    previewTestCommandArgs: readonly [string, ...string[]];
    signal?: AbortSignal;
    workingDirectory: string;
  },
) {
  const destroyResult = await runCommand({
    args: [
      "run",
      "--project",
      params.dopplerProject,
      "--config",
      params.previewEnvironmentDopplerConfigName,
      "--",
      "env",
      `ALCHEMY_STAGE=${params.previewEnvironmentAlchemyStageName}`,
      "WORKER_ROUTES=",
      "pnpm",
      "alchemy:down",
    ],
    command: "doppler",
    environment: params.env,
    signal: params.signal,
    workingDirectory: params.workingDirectory,
  });
  if (destroyResult.exitCode !== 0) {
    return {
      message: commandFailureMessage(destroyResult, "Preview teardown failed."),
      ok: false,
    };
  }

  try {
    const semaphore = params.createPreviewSemaphoreResourceClient({
      semaphoreApiToken: params.semaphoreApiToken,
      semaphoreBaseUrl: params.semaphoreBaseUrl,
    });
    const released = await semaphore.release({
      type: params.previewEnvironmentType,
      slug: params.previewEnvironmentSlug,
      leaseId: params.previewEnvironmentSemaphoreLeaseId,
    });
    return {
      message: released.released
        ? "Preview environment released."
        : "Preview deployment was torn down. The Semaphore lease was already gone.",
      ok: true,
    };
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : String(error),
      ok: false,
    };
  }
}

function derivePreviewEnvironment(input: {
  appSlug: string;
  previewEnvironmentSlug: string;
  previewEnvironmentType: string;
}) {
  const prefix = `${input.appSlug}-preview-`;
  if (!input.previewEnvironmentSlug.startsWith(prefix)) {
    throw new Error(
      `Preview slug ${input.previewEnvironmentSlug} does not match expected ${prefix}<slot>.`,
    );
  }

  const slot = Number(input.previewEnvironmentSlug.slice(prefix.length));
  if (!Number.isInteger(slot) || slot <= 0) {
    throw new Error(
      `Preview slug ${input.previewEnvironmentSlug} does not end with a valid slot number.`,
    );
  }

  return {
    previewEnvironmentAlchemyStageName: `preview-${slot}`,
    previewEnvironmentDopplerConfigName: `stg_${slot}`,
    previewEnvironmentIdentifier: input.previewEnvironmentSlug,
    previewEnvironmentSlug: input.previewEnvironmentSlug,
    previewEnvironmentType: input.previewEnvironmentType,
    publicUrl: `https://${input.previewEnvironmentSlug}.iterate.workers.dev`,
  };
}

function hasPreviewDestroyPayload(
  entry: CloudflarePreviewCommentEntryType | undefined,
): entry is CloudflarePreviewCommentEntryType & {
  previewEnvironmentAlchemyStageName: string;
  previewEnvironmentDopplerConfigName: string;
  previewEnvironmentIdentifier: string;
  previewEnvironmentSemaphoreLeaseId: string;
  previewEnvironmentSlug: string;
  previewEnvironmentType: string;
} {
  return Boolean(
    entry?.previewEnvironmentAlchemyStageName &&
    entry.previewEnvironmentDopplerConfigName &&
    entry.previewEnvironmentIdentifier &&
    entry.previewEnvironmentSemaphoreLeaseId &&
    entry.previewEnvironmentSlug &&
    entry.previewEnvironmentType,
  );
}

async function runCommand(params: {
  args: string[];
  command: string;
  environment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  workingDirectory: string;
}) {
  return await new Promise<{
    exitCode: number | null;
    stderr: string;
    stdout: string;
  }>((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const child = spawn(params.command, params.args, {
      cwd: params.workingDirectory,
      env: params.environment,
      signal: params.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(Buffer.from(chunk));
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(Buffer.from(chunk));
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode,
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      });
    });
  });
}

function commandFailureMessage(
  result: {
    stderr?: string;
    stdout?: string;
  },
  fallback: string,
) {
  const text = [result.stderr, result.stdout]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .trim();
  return text || fallback;
}

function makeDefaultWorkflowRunUrl(env: NodeJS.ProcessEnv) {
  if (!env.GITHUB_SERVER_URL || !env.GITHUB_REPOSITORY || !env.GITHUB_RUN_ID) {
    return undefined;
  }

  return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
}

function requiredStringWithEnvDefault(
  env: NodeJS.ProcessEnv,
  key: string,
  options: {
    defaultValue?: string;
  } = {},
) {
  const schema = z.string().trim().min(1);
  const defaultValue = env[key]?.trim() || options.defaultValue;
  return defaultValue ? schema.default(defaultValue) : schema;
}

function optionalStringWithEnvDefault(
  env: NodeJS.ProcessEnv,
  key: string,
  options: {
    defaultValue?: string;
  } = {},
) {
  const schema = z.string().trim().min(1);
  const defaultValue = env[key]?.trim() || options.defaultValue;
  return defaultValue ? schema.default(defaultValue) : schema.optional();
}

function requiredUrlWithEnvDefault(
  env: NodeJS.ProcessEnv,
  key: string,
  options: {
    defaultValue?: string;
  } = {},
) {
  const schema = z.string().trim().url();
  const defaultValue = env[key]?.trim() || options.defaultValue;
  return defaultValue ? schema.default(defaultValue) : schema;
}

function optionalUrlWithEnvDefault(
  env: NodeJS.ProcessEnv,
  key: string,
  options: {
    defaultValue?: string;
  } = {},
) {
  const schema = z.string().trim().url();
  const defaultValue = env[key]?.trim() || options.defaultValue;
  return defaultValue ? schema.default(defaultValue) : schema.optional();
}

function requiredNumberWithEnvDefault(
  env: NodeJS.ProcessEnv,
  key: string,
  options: {
    defaultValue?: number;
  } = {},
) {
  const schema = z.coerce.number().int().positive();
  const rawDefaultValue = env[key]?.trim();
  if (rawDefaultValue) {
    return schema.default(Number(rawDefaultValue));
  }

  return options.defaultValue !== undefined ? schema.default(options.defaultValue) : schema;
}

function optionalNumberWithEnvDefault(env: NodeJS.ProcessEnv, key: string) {
  const schema = z.coerce.number().int().nonnegative();
  const rawDefaultValue = env[key]?.trim();
  return rawDefaultValue ? schema.default(Number(rawDefaultValue)) : schema.optional();
}

function requiredBooleanWithEnvDefault(
  env: NodeJS.ProcessEnv,
  key: string,
  options: {
    defaultValue?: boolean;
  } = {},
) {
  const schema = z.union([z.boolean(), z.stringbool()]).transform(Boolean);
  const rawDefaultValue = env[key]?.trim();
  if (rawDefaultValue) {
    return schema.default(z.stringbool().parse(rawDefaultValue));
  }

  return options.defaultValue !== undefined ? schema.default(options.defaultValue) : schema;
}

function semaphoreApiTokenWithEnvDefault(env: NodeJS.ProcessEnv) {
  return requiredStringWithEnvDefault(
    {
      ...env,
      SEMAPHORE_API_TOKEN:
        env.SEMAPHORE_API_TOKEN?.trim() || env.APP_CONFIG_SHARED_API_SECRET?.trim(),
    },
    "SEMAPHORE_API_TOKEN",
  );
}

function optionalSemaphoreApiTokenWithEnvDefault(env: NodeJS.ProcessEnv) {
  return optionalStringWithEnvDefault(
    {
      ...env,
      SEMAPHORE_API_TOKEN:
        env.SEMAPHORE_API_TOKEN?.trim() || env.APP_CONFIG_SHARED_API_SECRET?.trim(),
    },
    "SEMAPHORE_API_TOKEN",
  );
}

function requireValue<T>(value: T | undefined, message: string) {
  if (value === undefined || value === null || value === "") {
    throw new Error(message);
  }

  return value;
}
