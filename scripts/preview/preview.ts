import { spawn } from "node:child_process";
import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { stripAnsi } from "../../packages/shared/src/jonasland/strip-ansi.ts";
import {
  CloudflarePreviewEntry,
  type CloudflarePreviewEntry as CloudflarePreviewEntryType,
  clearCloudflarePreviewDestroyPayload,
  readCloudflarePreviewState,
  upsertCloudflarePreviewStateEntry,
} from "./state.ts";
import { splitRepositoryFullName } from "./repository-full-name.ts";

const defaultSemaphoreBaseUrl = "https://semaphore.iterate.com";
const defaultPreviewLeaseMs = 60 * 60 * 1000;
const defaultPreviewReadyTimeoutMs = 30_000;
const defaultPreviewReadyUrlPath = "/api/__common/health";
const defaultPreviewTestMaxAttempts = 2;
const defaultPreviewTestRetryDelayMs = 5_000;

export type PreviewSemaphoreResourceClient = {
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
  entry: CloudflarePreviewEntryType | null;
  ok: boolean;
  skipped?: boolean;
};

function createPreviewCreateInputSchema(env: NodeJS.ProcessEnv) {
  return z.object({
    pullRequestHeadRefName: requiredStringWithEnvDefault(env, "GITHUB_HEAD_REF"),
    pullRequestHeadSha: requiredStringWithEnvDefault(env, "GITHUB_SHA"),
    pullRequestNumber: requiredNumberWithEnvDefault(env, "GITHUB_PR_NUMBER"),
    repositoryFullName: requiredStringWithEnvDefault(env, "GITHUB_REPOSITORY"),
    semaphoreApiToken: semaphoreApiTokenWithEnvDefault(env),
    semaphoreBaseUrl: z.string().trim().url().default(defaultSemaphoreBaseUrl),
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
    semaphoreBaseUrl: z.string().trim().url().default(defaultSemaphoreBaseUrl),
  });
}

export function createCloudflarePreviewSyncInputSchema(env: NodeJS.ProcessEnv) {
  return z.object({
    githubToken: requiredStringWithEnvDefault(env, "GITHUB_TOKEN"),
    pullRequestHeadRefName: requiredStringWithEnvDefault(env, "GITHUB_HEAD_REF"),
    pullRequestHeadSha: requiredStringWithEnvDefault(env, "GITHUB_SHA"),
    pullRequestBaseSha: requiredStringWithEnvDefault(env, "GITHUB_PR_BASE_SHA"),
    pullRequestNumber: requiredNumberWithEnvDefault(env, "GITHUB_PR_NUMBER"),
    repositoryFullName: requiredStringWithEnvDefault(env, "GITHUB_REPOSITORY"),
    semaphoreApiToken: optionalSemaphoreApiTokenWithEnvDefault(env),
    semaphoreBaseUrl: z.string().trim().url().default(defaultSemaphoreBaseUrl),
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

export function createCloudflarePreviewCleanupInputSchema(env: NodeJS.ProcessEnv) {
  return z.object({
    githubToken: requiredStringWithEnvDefault(env, "GITHUB_TOKEN"),
    pullRequestNumber: requiredNumberWithEnvDefault(env, "GITHUB_PR_NUMBER"),
    repositoryFullName: requiredStringWithEnvDefault(env, "GITHUB_REPOSITORY"),
    semaphoreApiToken: optionalSemaphoreApiTokenWithEnvDefault(env),
    semaphoreBaseUrl: z.string().trim().url().default(defaultSemaphoreBaseUrl),
  });
}

export async function syncCloudflarePreviewForPullRequest(
  params: z.infer<ReturnType<typeof createCloudflarePreviewSyncInputSchema>> & {
    appDisplayName: string;
    appSlug: string;
    commandEnvironment: NodeJS.ProcessEnv;
    createPreviewSemaphoreResourceClient: (input: {
      semaphoreApiToken: string;
      semaphoreBaseUrl: string;
    }) => PreviewSemaphoreResourceClient;
    dopplerProject: string;
    paths: readonly string[];
    previewResourceType: string;
    previewTestBaseUrlEnvVar: string;
    previewTestCommandArgs: readonly [string, ...string[]];
    signal?: AbortSignal;
    workingDirectory: string;
  },
): Promise<PreviewSyncResult> {
  if (params.isFork) {
    const entry = CloudflarePreviewEntry.parse({
      appDisplayName: params.appDisplayName,
      appSlug: params.appSlug,
      headSha: params.pullRequestHeadSha,
      message: "Preview environments are unavailable for fork pull requests.",
      runUrl: params.workflowRunUrl,
      shortSha: params.pullRequestHeadSha.slice(0, 7),
      status: "fork-unavailable",
      updatedAt: new Date().toISOString(),
    });
    try {
      await upsertCloudflarePreviewStateEntry({
        entry,
        githubToken: params.githubToken,
        repositoryFullName: params.repositoryFullName,
        pullRequestNumber: params.pullRequestNumber,
      });
    } catch {
      // Fork PRs do not create preview resources, so a denied PR-body write should not fail the job.
    }
    return {
      entry,
      ok: true,
    };
  }

  const current = await readCloudflarePreviewState({
    githubToken: params.githubToken,
    repositoryFullName: params.repositoryFullName,
    pullRequestNumber: params.pullRequestNumber,
  });
  const previousEntry = current.state[params.appSlug];
  const syncDecision = await shouldSyncPreviewEnvironment({
    appPaths: params.paths,
    githubToken: params.githubToken,
    pullRequestNumber: params.pullRequestNumber,
    pullRequestBaseSha: params.pullRequestBaseSha,
    pullRequestHeadSha: params.pullRequestHeadSha,
    previousEntry,
    repositoryFullName: params.repositoryFullName,
  });
  if (!syncDecision.shouldSync) {
    const nextEntry =
      previousEntry && previousEntry.headSha !== params.pullRequestHeadSha
        ? CloudflarePreviewEntry.parse({
            ...previousEntry,
            headSha: params.pullRequestHeadSha,
            runUrl: params.workflowRunUrl,
            shortSha: params.pullRequestHeadSha.slice(0, 7),
            updatedAt: new Date().toISOString(),
          })
        : (previousEntry ?? null);

    if (nextEntry) {
      await upsertCloudflarePreviewStateEntry({
        entry: nextEntry,
        githubToken: params.githubToken,
        repositoryFullName: params.repositoryFullName,
        pullRequestNumber: params.pullRequestNumber,
      });
    }

    return {
      entry: nextEntry,
      ok: true,
      skipped: true,
    };
  }

  if (hasPreviewDestroyPayload(previousEntry)) {
    const cleanupResult = await destroyPreviewEnvironment({
      commandEnvironment: params.commandEnvironment,
      createPreviewSemaphoreResourceClient: params.createPreviewSemaphoreResourceClient,
      dopplerProject: params.dopplerProject,
      previewEnvironmentAlchemyStageName: previousEntry.previewEnvironmentAlchemyStageName,
      previewEnvironmentDopplerConfigName: previousEntry.previewEnvironmentDopplerConfigName,
      previewEnvironmentIdentifier: previousEntry.previewEnvironmentIdentifier,
      previewEnvironmentSemaphoreLeaseId: previousEntry.previewEnvironmentSemaphoreLeaseId,
      previewEnvironmentSlug: previousEntry.previewEnvironmentSlug,
      previewEnvironmentType: previousEntry.previewEnvironmentType,
      semaphoreApiToken: requireValue(
        params.semaphoreApiToken,
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
      } satisfies CloudflarePreviewEntryType;
      await upsertCloudflarePreviewStateEntry({
        entry: CloudflarePreviewEntry.parse(cleanupEntry),
        githubToken: params.githubToken,
        repositoryFullName: params.repositoryFullName,
        pullRequestNumber: params.pullRequestNumber,
      });
      return {
        entry: CloudflarePreviewEntry.parse(cleanupEntry),
        ok: false,
      };
    }
  }

  const createResult = await createPreviewEnvironment({
    appDisplayName: params.appDisplayName,
    appSlug: params.appSlug,
    commandEnvironment: params.commandEnvironment,
    createPreviewSemaphoreResourceClient: params.createPreviewSemaphoreResourceClient,
    dopplerProject: params.dopplerProject,
    leaseMs: params.leaseMs,
    previewResourceType: params.previewResourceType,
    previewTestBaseUrlEnvVar: params.previewTestBaseUrlEnvVar,
    previewTestCommandArgs: params.previewTestCommandArgs,
    pullRequestHeadRefName: params.pullRequestHeadRefName,
    pullRequestHeadSha: params.pullRequestHeadSha,
    pullRequestNumber: params.pullRequestNumber,
    repositoryFullName: params.repositoryFullName,
    semaphoreApiToken: requireValue(
      params.semaphoreApiToken,
      "SEMAPHORE_API_TOKEN is required to create a preview.",
    ),
    semaphoreBaseUrl: params.semaphoreBaseUrl ?? defaultSemaphoreBaseUrl,
    signal: params.signal,
    waitMs: params.waitMs,
    workflowRunUrl: params.workflowRunUrl,
    workingDirectory: params.workingDirectory,
  });
  try {
    await upsertCloudflarePreviewStateEntry({
      entry: createResult.entry!,
      githubToken: params.githubToken,
      repositoryFullName: params.repositoryFullName,
      pullRequestNumber: params.pullRequestNumber,
    });
  } catch (error) {
    if (createResult.entry && hasPreviewDestroyPayload(createResult.entry)) {
      try {
        await destroyPreviewEnvironment({
          commandEnvironment: params.commandEnvironment,
          createPreviewSemaphoreResourceClient: params.createPreviewSemaphoreResourceClient,
          dopplerProject: params.dopplerProject,
          previewEnvironmentAlchemyStageName: createResult.entry.previewEnvironmentAlchemyStageName,
          previewEnvironmentDopplerConfigName:
            createResult.entry.previewEnvironmentDopplerConfigName,
          previewEnvironmentIdentifier: createResult.entry.previewEnvironmentIdentifier,
          previewEnvironmentSemaphoreLeaseId: createResult.entry.previewEnvironmentSemaphoreLeaseId,
          previewEnvironmentSlug: createResult.entry.previewEnvironmentSlug,
          previewEnvironmentType: createResult.entry.previewEnvironmentType,
          semaphoreApiToken: requireValue(
            params.semaphoreApiToken,
            "SEMAPHORE_API_TOKEN is required to clean up an unrecorded preview.",
          ),
          semaphoreBaseUrl: params.semaphoreBaseUrl ?? defaultSemaphoreBaseUrl,
          signal: params.signal,
          workingDirectory: params.workingDirectory,
        });
      } catch {
        // best-effort cleanup when the PR body cannot be updated
      }
    }

    throw error;
  }
  return createResult;
}

export async function cleanupCloudflarePreviewForPullRequest(
  params: z.infer<ReturnType<typeof createCloudflarePreviewCleanupInputSchema>> & {
    appDisplayName: string;
    appSlug: string;
    commandEnvironment: NodeJS.ProcessEnv;
    createPreviewSemaphoreResourceClient: (input: {
      semaphoreApiToken: string;
      semaphoreBaseUrl: string;
    }) => PreviewSemaphoreResourceClient;
    dopplerProject: string;
    signal?: AbortSignal;
    workingDirectory: string;
  },
) {
  const current = await readCloudflarePreviewState({
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
    commandEnvironment: params.commandEnvironment,
    createPreviewSemaphoreResourceClient: params.createPreviewSemaphoreResourceClient,
    dopplerProject: params.dopplerProject,
    previewEnvironmentAlchemyStageName: existingEntry.previewEnvironmentAlchemyStageName,
    previewEnvironmentDopplerConfigName: existingEntry.previewEnvironmentDopplerConfigName,
    previewEnvironmentIdentifier: existingEntry.previewEnvironmentIdentifier,
    previewEnvironmentSemaphoreLeaseId: existingEntry.previewEnvironmentSemaphoreLeaseId,
    previewEnvironmentSlug: existingEntry.previewEnvironmentSlug,
    previewEnvironmentType: existingEntry.previewEnvironmentType,
    semaphoreApiToken: requireValue(
      params.semaphoreApiToken,
      "SEMAPHORE_API_TOKEN is required to clean up previews.",
    ),
    semaphoreBaseUrl: params.semaphoreBaseUrl ?? defaultSemaphoreBaseUrl,
    signal: params.signal,
    workingDirectory: params.workingDirectory,
  });

  const nextEntry = CloudflarePreviewEntry.parse(
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
  await upsertCloudflarePreviewStateEntry({
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
    commandEnvironment: NodeJS.ProcessEnv;
    createPreviewSemaphoreResourceClient: (input: {
      semaphoreApiToken: string;
      semaphoreBaseUrl: string;
    }) => PreviewSemaphoreResourceClient;
    dopplerProject: string;
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
      headSha: params.pullRequestHeadSha,
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
      environment: params.commandEnvironment,
      signal: params.signal,
      workingDirectory: params.workingDirectory,
    });
    if (deployResult.exitCode !== 0) {
      return {
        entry: CloudflarePreviewEntry.parse({
          ...baseEntry,
          message: commandFailureMessage(deployResult, "Preview deployment failed."),
          status: "deploy-failed",
        }),
        ok: false,
      };
    }

    const readiness = await waitForHttpReadiness({
      signal: params.signal,
      timeoutMs: defaultPreviewReadyTimeoutMs,
      url: new URL(defaultPreviewReadyUrlPath, previewEnvironment.publicUrl),
    });
    if (!readiness.ok) {
      return {
        entry: CloudflarePreviewEntry.parse({
          ...baseEntry,
          message: readiness.message,
          status: "deploy-failed",
        }),
        ok: false,
      };
    }

    const testResult = await runCommandWithRetries({
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
      environment: params.commandEnvironment,
      maxAttempts: defaultPreviewTestMaxAttempts,
      retryDelayMs: defaultPreviewTestRetryDelayMs,
      signal: params.signal,
      workingDirectory: params.workingDirectory,
    });
    if (testResult.exitCode !== 0) {
      return {
        entry: CloudflarePreviewEntry.parse({
          ...baseEntry,
          message: commandFailureMessage(testResult, "Preview tests failed after deploy."),
          status: "tests-failed",
        }),
        ok: false,
      };
    }

    return {
      entry: CloudflarePreviewEntry.parse({
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
      entry: CloudflarePreviewEntry.parse({
        appDisplayName: params.appDisplayName,
        appSlug: params.appSlug,
        headSha: params.pullRequestHeadSha,
        message: formatPreviewErrorMessage(error),
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
    commandEnvironment: NodeJS.ProcessEnv;
    createPreviewSemaphoreResourceClient: (input: {
      semaphoreApiToken: string;
      semaphoreBaseUrl: string;
    }) => PreviewSemaphoreResourceClient;
    dopplerProject: string;
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
    environment: params.commandEnvironment,
    signal: params.signal,
    workingDirectory: params.workingDirectory,
  });
  const destroyMessage =
    destroyResult.exitCode === 0
      ? null
      : commandFailureMessage(destroyResult, "Preview teardown failed.");

  if (destroyResult.exitCode !== 0) {
    return {
      message: destroyMessage ?? "Preview teardown failed.",
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
      message: joinPreviewMessages(
        destroyMessage,
        released.released ? "Preview environment released." : "Semaphore lease was already gone.",
      ),
      ok: destroyResult.exitCode === 0,
    };
  } catch (error) {
    return {
      message: joinPreviewMessages(
        destroyMessage,
        error instanceof Error ? error.message : String(error),
      ),
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
  entry: CloudflarePreviewEntryType | undefined,
): entry is CloudflarePreviewEntryType & {
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

async function runCommandWithRetries(
  params: Parameters<typeof runCommand>[0] & {
    maxAttempts: number;
    retryDelayMs: number;
  },
) {
  let attempt = 1;
  let lastResult = await runCommand(params);

  while (attempt < params.maxAttempts && lastResult.exitCode !== 0) {
    console.error(
      `Command failed on attempt ${attempt}/${params.maxAttempts}. Retrying in ${params.retryDelayMs}ms...`,
    );
    await sleep(params.retryDelayMs, params.signal);
    attempt += 1;
    lastResult = await runCommand(params);
  }

  return lastResult;
}

async function waitForHttpReadiness(params: { signal?: AbortSignal; timeoutMs: number; url: URL }) {
  const deadline = Date.now() + params.timeoutMs;
  let lastFailure = "No response received yet.";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(params.url, {
        method: "GET",
        redirect: "follow",
        signal: params.signal,
      });
      if (response.ok) {
        return { ok: true as const };
      }

      lastFailure = `Readiness check returned ${response.status} for ${params.url.toString()}.`;
    } catch (error) {
      lastFailure = formatPreviewErrorMessage(error);
    }

    await sleep(1_000, params.signal);
  }

  return {
    message: `Timed out waiting for preview readiness at ${params.url.toString()}. ${lastFailure}`,
    ok: false as const,
  };
}

async function shouldSyncPreviewEnvironment(params: {
  appPaths: readonly string[];
  githubToken: string;
  pullRequestNumber: number;
  pullRequestBaseSha: string;
  pullRequestHeadSha: string;
  previousEntry: CloudflarePreviewEntryType | undefined;
  repositoryFullName: string;
}) {
  const compareBaseSha = await resolvePreviewCompareBaseSha(params);
  if (!compareBaseSha || compareBaseSha === params.pullRequestHeadSha) {
    return { shouldSync: false as const };
  }

  const octokit = new Octokit({ auth: params.githubToken });
  const [owner, repo] = splitRepositoryFullName(params.repositoryFullName);
  const comparison = await octokit.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${compareBaseSha}...${params.pullRequestHeadSha}`,
  });
  const changedFiles =
    comparison.data.files?.flatMap((file) => (file.filename ? [file.filename] : [])) ?? [];

  return {
    shouldSync: changedFiles.some((filename) => matchesPreviewPath(filename, params.appPaths)),
  };
}

async function resolvePreviewCompareBaseSha(params: {
  githubToken: string;
  pullRequestNumber: number;
  pullRequestBaseSha: string;
  pullRequestHeadSha: string;
  previousEntry: CloudflarePreviewEntryType | undefined;
  repositoryFullName: string;
}) {
  const previousPullRequestHeadSha = await resolvePreviousPullRequestHeadSha(params);
  if (previousPullRequestHeadSha) {
    return previousPullRequestHeadSha;
  }

  if (params.previousEntry?.headSha) {
    return params.previousEntry.headSha;
  }

  const octokit = new Octokit({ auth: params.githubToken });
  const [owner, repo] = splitRepositoryFullName(params.repositoryFullName);
  const workflowRunId = parseWorkflowRunId(params.previousEntry?.runUrl ?? null);
  if (workflowRunId !== null) {
    try {
      const workflowRun = await octokit.rest.actions.getWorkflowRun({
        owner,
        repo,
        run_id: workflowRunId,
      });
      const headSha = workflowRun.data.head_sha?.trim();
      if (headSha) {
        return headSha;
      }
    } catch {
      // Fall back to commit-prefix lookup.
    }
  }

  const shortSha = params.previousEntry?.shortSha?.trim();
  if (!shortSha) {
    return params.pullRequestBaseSha;
  }

  const commits = await octokit.paginate(octokit.rest.pulls.listCommits, {
    owner,
    pull_number: params.pullRequestNumber,
    repo,
    per_page: 100,
  });
  const matchingCommit = commits.find((commit) => commit.sha.startsWith(shortSha));
  return matchingCommit?.sha ?? params.pullRequestBaseSha;
}

async function resolvePreviousPullRequestHeadSha(params: {
  githubToken: string;
  pullRequestNumber: number;
  pullRequestHeadSha: string;
  repositoryFullName: string;
}) {
  const octokit = new Octokit({ auth: params.githubToken });
  const [owner, repo] = splitRepositoryFullName(params.repositoryFullName);
  const commits = await octokit.paginate(octokit.rest.pulls.listCommits, {
    owner,
    pull_number: params.pullRequestNumber,
    repo,
    per_page: 100,
  });
  const currentHeadIndex = commits.findIndex((commit) => commit.sha === params.pullRequestHeadSha);
  if (currentHeadIndex <= 0) {
    return null;
  }

  return commits[currentHeadIndex - 1]?.sha ?? null;
}

function parseWorkflowRunId(runUrl: string | null) {
  if (!runUrl) {
    return null;
  }

  const match = /\/actions\/runs\/(\d+)(?:\/|$)/.exec(runUrl);
  return match ? Number(match[1]) : null;
}

function matchesPreviewPath(filename: string, patterns: readonly string[]) {
  return patterns.some((pattern) => {
    if (pattern.endsWith("/**")) {
      return filename.startsWith(pattern.slice(0, -2));
    }

    return filename === pattern;
  });
}

async function sleep(ms: number, signal?: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    if (!signal) {
      return;
    }

    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason ?? new Error("Aborted"));
    };

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function commandFailureMessage(
  result: {
    stderr?: string;
    stdout?: string;
  },
  fallback: string,
) {
  const text = sanitizePreviewOutput(
    [result.stderr, result.stdout]
      .filter((value) => typeof value === "string" && value.trim().length > 0)
      .join("\n")
      .trim(),
  );
  if (!text) {
    return fallback;
  }

  const maxLength = 4_000;
  if (text.length <= maxLength) {
    return text;
  }

  return `…(truncated)\n${text.slice(-maxLength)}`;
}

function joinPreviewMessages(...parts: Array<string | null | undefined>) {
  return parts.filter((part) => typeof part === "string" && part.trim().length > 0).join("\n");
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
  return requiredStringWithEnvDefault(env, "SEMAPHORE_API_TOKEN");
}

function optionalSemaphoreApiTokenWithEnvDefault(env: NodeJS.ProcessEnv) {
  return optionalStringWithEnvDefault(env, "SEMAPHORE_API_TOKEN");
}

function requireValue<T>(value: T | undefined, message: string) {
  if (value === undefined || value === null || value === "") {
    throw new Error(message);
  }

  return value;
}

function formatPreviewErrorMessage(error: unknown) {
  if (error instanceof z.ZodError) {
    return sanitizePreviewOutput(`${error.message}: ${JSON.stringify(error.issues)}`);
  }

  return sanitizePreviewOutput(error instanceof Error ? error.message : String(error));
}

function sanitizePreviewOutput(value: string) {
  return stripAnsi(value)
    .replaceAll("\r\n", "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
