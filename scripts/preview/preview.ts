import { promises as dns } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { resolve } from "node:path";
import { Octokit } from "@octokit/rest";
import { z } from "zod";
import {
  isNewStyleCloudflareAppSlug,
  newStyleCloudflareApps,
  runNewStyleCloudflareAppAlchemy,
} from "../../packages/shared/src/apps/new-style-cloudflare-apps.ts";
import { stripAnsi } from "../../packages/shared/src/jonasland/strip-ansi.ts";
import { runCommand } from "../../packages/shared/src/node/run-command.ts";
import {
  CloudflarePreviewAppEntry,
  type EnvironmentConfigLease,
  type CloudflarePreviewState,
  readCloudflarePreviewState,
  updateCloudflarePreviewState,
} from "./state.ts";
import { splitRepositoryFullName } from "./repository-full-name.ts";
import {
  CloudflarePreviewAppSlug,
  type CloudflarePreviewAppSlug as CloudflarePreviewAppSlugType,
  cloudflarePreviewApps,
  cloudflarePreviewSharedPaths,
} from "./apps.ts";
import {
  ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
  parseEnvironmentConfigLeaseData,
} from "./preview-inventory.ts";

const defaultSemaphoreBaseUrl = "https://semaphore.iterate.com";
const defaultPreviewLeaseMs = 60 * 60 * 1000;
// Routed previews can be healthy before Cloudflare has finished issuing edge
// certificates for newly-created hostnames. Some apps record a separate
// project-subdomain URL; wait on that URL only when it is expected to be
// certificate-covered in the preview environment.
// https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/#full-setup
// https://developers.cloudflare.com/ssl/edge-certificates/additional-options/total-tls/
// Keep this long enough for first issuance of supported hostnames while still
// returning immediately once the health endpoint is reachable.
const defaultPreviewReadyTimeoutMs = 600_000;
const defaultPreviewReadyUrlPath = "/api/__internal/health";
const defaultPreviewTestMaxAttempts = 2;
const defaultPreviewTestRetryDelayMs = 5_000;
export type PreviewSemaphoreResourceClient = {
  acquire: (input: { leaseMs: number; type: string; waitMs?: number }) => Promise<{
    data: Record<string, unknown>;
    expiresAt: number;
    leaseId: string;
    slug: string;
    type: string;
  }>;
  acquireSpecific: (input: { leaseMs: number; slug: string; type: string }) => Promise<{
    data: Record<string, unknown>;
    expiresAt: number;
    leaseId: string;
    slug: string;
    type: string;
  } | null>;
  renew: (input: { leaseId: string; leaseMs: number; slug: string; type: string }) => Promise<{
    data: Record<string, unknown>;
    expiresAt: number;
    leaseId: string;
    slug: string;
    type: string;
  } | null>;
  release: (input: { leaseId: string; slug: string; type: string }) => Promise<{
    released: boolean;
  }>;
};

type PreviewLifecycleResult = {
  ok: boolean;
  skipped?: boolean;
  state: CloudflarePreviewState;
};

type PreviewAppRuntime = (typeof cloudflarePreviewApps)[CloudflarePreviewAppSlugType];

export function createCloudflarePreviewSyncInputSchema(env: NodeJS.ProcessEnv) {
  return z.object({
    githubToken: requiredStringWithEnvDefault(env, "GITHUB_TOKEN"),
    pullRequestHeadRefName: optionalStringWithEnvDefault(env, "GITHUB_HEAD_REF"),
    pullRequestHeadSha: optionalStringWithEnvDefault(env, "GITHUB_SHA"),
    pullRequestBaseSha: optionalStringWithEnvDefault(env, "GITHUB_PR_BASE_SHA"),
    pullRequestNumber: requiredNumberWithEnvDefault(env, "GITHUB_PR_NUMBER"),
    repositoryFullName: requiredStringWithEnvDefault(env, "GITHUB_REPOSITORY", {
      defaultValue: "iterate/iterate",
    }),
    semaphoreApiToken: optionalSemaphoreApiTokenWithEnvDefault(env),
    semaphoreBaseUrl: z.string().trim().url().default(defaultSemaphoreBaseUrl),
    workflowRunUrl: optionalUrlWithEnvDefault(env, "WORKFLOW_RUN_URL", {
      defaultValue: makeDefaultWorkflowRunUrl(env),
    }),
    leaseMs: requiredNumberWithEnvDefault(env, "PREVIEW_LEASE_MS", {
      defaultValue: defaultPreviewLeaseMs,
    }),
    waitMs: optionalNumberWithEnvDefault(env, "PREVIEW_WAIT_MS"),
    isFork: optionalBooleanWithEnvDefault(env, "GITHUB_PR_IS_FORK"),
    force: optionalBooleanWithEnvDefault(env, "PREVIEW_FORCE"),
  });
}

export function createCloudflarePreviewCleanupInputSchema(env: NodeJS.ProcessEnv) {
  return z.object({
    githubToken: requiredStringWithEnvDefault(env, "GITHUB_TOKEN"),
    pullRequestNumber: requiredNumberWithEnvDefault(env, "GITHUB_PR_NUMBER"),
    repositoryFullName: requiredStringWithEnvDefault(env, "GITHUB_REPOSITORY", {
      defaultValue: "iterate/iterate",
    }),
    semaphoreApiToken: optionalSemaphoreApiTokenWithEnvDefault(env),
    semaphoreBaseUrl: z.string().trim().url().default(defaultSemaphoreBaseUrl),
  });
}

export function createCloudflarePreviewTestInputSchema(env: NodeJS.ProcessEnv) {
  return z.object({
    githubToken: requiredStringWithEnvDefault(env, "GITHUB_TOKEN"),
    pullRequestHeadSha: optionalStringWithEnvDefault(env, "GITHUB_SHA"),
    pullRequestNumber: requiredNumberWithEnvDefault(env, "GITHUB_PR_NUMBER"),
    repositoryFullName: requiredStringWithEnvDefault(env, "GITHUB_REPOSITORY", {
      defaultValue: "iterate/iterate",
    }),
    workflowRunUrl: optionalUrlWithEnvDefault(env, "WORKFLOW_RUN_URL", {
      defaultValue: makeDefaultWorkflowRunUrl(env),
    }),
  });
}

export async function syncCloudflarePreviewForPullRequest(
  params: z.infer<ReturnType<typeof createCloudflarePreviewSyncInputSchema>> & {
    commandEnvironment: NodeJS.ProcessEnv;
    createPreviewSemaphoreResourceClient: (input: {
      semaphoreApiToken: string;
      semaphoreBaseUrl: string;
    }) => PreviewSemaphoreResourceClient;
    repositoryRoot: string;
    signal?: AbortSignal;
  },
): Promise<PreviewLifecycleResult> {
  const deployResult = await deployCloudflarePreviewForPullRequest(params);
  if (!deployResult.ok || deployResult.skipped) {
    return deployResult;
  }

  return await testCloudflarePreviewForPullRequest({
    commandEnvironment: params.commandEnvironment,
    githubToken: params.githubToken,
    pullRequestHeadSha: params.pullRequestHeadSha,
    pullRequestNumber: params.pullRequestNumber,
    repositoryFullName: params.repositoryFullName,
    repositoryRoot: params.repositoryRoot,
    signal: params.signal,
    workflowRunUrl: params.workflowRunUrl,
  });
}

export async function deployCloudflarePreviewForPullRequest(
  params: z.infer<ReturnType<typeof createCloudflarePreviewSyncInputSchema>> & {
    commandEnvironment: NodeJS.ProcessEnv;
    createPreviewSemaphoreResourceClient: (input: {
      semaphoreApiToken: string;
      semaphoreBaseUrl: string;
    }) => PreviewSemaphoreResourceClient;
    repositoryRoot: string;
    signal?: AbortSignal;
  },
): Promise<PreviewLifecycleResult> {
  const pullRequest = await resolvePullRequestPreviewContext(params);

  if (pullRequest.isFork) {
    const appSlugs = Object.keys(cloudflarePreviewApps) as CloudflarePreviewAppSlugType[];
    const state = await recordForkUnavailable({
      appSlugs,
      params,
      pullRequestHeadSha: pullRequest.pullRequestHeadSha,
    }).catch(() => ({
      apps: {},
      environmentConfigLease: null,
    }));
    return { ok: true, state };
  }

  const current = await readCloudflarePreviewState({
    githubToken: params.githubToken,
    repositoryFullName: params.repositoryFullName,
    pullRequestNumber: params.pullRequestNumber,
  });
  const selectedApps = await selectPreviewAppsForPullRequest({
    force: params.force ?? false,
    githubToken: params.githubToken,
    previousState: current.state,
    pullRequestBaseSha: pullRequest.pullRequestBaseSha,
    pullRequestHeadSha: pullRequest.pullRequestHeadSha,
    pullRequestNumber: params.pullRequestNumber,
    repositoryFullName: params.repositoryFullName,
  });

  if (selectedApps.length === 0) {
    return {
      ok: true,
      skipped: true,
      state: current.state,
    };
  }

  const environmentConfigLease = await claimEnvironmentConfigLease({
    createPreviewSemaphoreResourceClient: params.createPreviewSemaphoreResourceClient,
    leaseMs: params.leaseMs,
    previousEnvironmentConfigLease: current.state.environmentConfigLease,
    semaphoreApiToken: requireValue(
      params.semaphoreApiToken,
      "SEMAPHORE_API_TOKEN is required to create a preview.",
    ),
    semaphoreBaseUrl: params.semaphoreBaseUrl ?? defaultSemaphoreBaseUrl,
    waitMs: params.waitMs,
  });
  await updatePreviewState(params, (state) => ({
    ...state,
    environmentConfigLease,
  }));

  let ok = true;
  let latestState = current.state;
  for (const app of selectedApps) {
    const entry = await deployPreviewAppWithStatus({
      app,
      commandEnvironment: params.commandEnvironment,
      dopplerConfig: environmentConfigLease.dopplerConfig,
      pullRequestHeadSha: pullRequest.pullRequestHeadSha,
      repositoryRoot: params.repositoryRoot,
      runUrl: params.workflowRunUrl ?? null,
      signal: params.signal,
    });
    if (entry.status === "deploy-failed") {
      ok = false;
    }

    const update = await updatePreviewState(params, (state) => ({
      ...state,
      environmentConfigLease,
      apps: {
        ...state.apps,
        [app.slug]: entry,
      },
    }));
    latestState = update.state;
  }

  return {
    ok,
    state: latestState,
  };
}

export async function testCloudflarePreviewForPullRequest(
  params: z.infer<ReturnType<typeof createCloudflarePreviewTestInputSchema>> & {
    commandEnvironment: NodeJS.ProcessEnv;
    repositoryRoot: string;
    signal?: AbortSignal;
  },
): Promise<PreviewLifecycleResult> {
  const current = await readCloudflarePreviewState({
    githubToken: params.githubToken,
    repositoryFullName: params.repositoryFullName,
    pullRequestNumber: params.pullRequestNumber,
  });
  const environmentConfigLease = current.state.environmentConfigLease;
  if (environmentConfigLease == null) {
    return {
      ok: true,
      skipped: true,
      state: current.state,
    };
  }

  const testableApps = Object.values(current.state.apps)
    .filter((entry) => canRunPreviewTests(entry))
    .filter((entry) => !params.pullRequestHeadSha || entry.headSha === params.pullRequestHeadSha)
    .map((entry) => cloudflarePreviewApps[entry.appSlug as CloudflarePreviewAppSlugType])
    .filter((app): app is PreviewAppRuntime => app != null);

  if (testableApps.length === 0) {
    return {
      ok: true,
      skipped: true,
      state: current.state,
    };
  }

  let ok = true;
  let latestState = current.state;
  for (const app of testableApps) {
    const existingEntry = latestState.apps[app.slug];
    if (!existingEntry?.publicUrl) {
      continue;
    }

    const testResult = await runCommandWithRetries({
      args: [
        "run",
        "--project",
        app.dopplerProject,
        "--config",
        environmentConfigLease.dopplerConfig,
        "--",
        "env",
        `${app.previewTestBaseUrlEnvVar}=${existingEntry.publicUrl}`,
        ...app.previewTestCommandArgs,
      ],
      command: "doppler",
      environment: params.commandEnvironment,
      maxAttempts: defaultPreviewTestMaxAttempts,
      retryDelayMs: defaultPreviewTestRetryDelayMs,
      signal: params.signal,
      workingDirectory: resolve(params.repositoryRoot, app.appPath),
    });

    const entry = CloudflarePreviewAppEntry.parse({
      ...existingEntry,
      appDisplayName: app.displayName,
      appSlug: app.slug,
      message:
        testResult.exitCode === 0
          ? null
          : commandFailureMessage(testResult, "Preview tests failed after deploy."),
      runUrl: params.workflowRunUrl ?? existingEntry.runUrl ?? null,
      status: testResult.exitCode === 0 ? "deployed" : "tests-failed",
      updatedAt: new Date().toISOString(),
    });
    if (entry.status === "tests-failed") {
      ok = false;
    }

    const update = await updatePreviewState(params, (state) => ({
      ...state,
      apps: {
        ...state.apps,
        [app.slug]: entry,
      },
    }));
    latestState = update.state;
  }

  return {
    ok,
    state: latestState,
  };
}

export async function cleanupCloudflarePreviewForPullRequest(
  params: z.infer<ReturnType<typeof createCloudflarePreviewCleanupInputSchema>> & {
    commandEnvironment: NodeJS.ProcessEnv;
    createPreviewSemaphoreResourceClient: (input: {
      semaphoreApiToken: string;
      semaphoreBaseUrl: string;
    }) => PreviewSemaphoreResourceClient;
    repositoryRoot: string;
    signal?: AbortSignal;
  },
) {
  const current = await readCloudflarePreviewState({
    githubToken: params.githubToken,
    repositoryFullName: params.repositoryFullName,
    pullRequestNumber: params.pullRequestNumber,
  });
  const environmentConfigLease = current.state.environmentConfigLease;
  if (environmentConfigLease == null) {
    return {
      ok: true,
      released: false,
      state: current.state,
    };
  }

  let ok = true;
  let latestState = current.state;
  for (const appSlug of Object.keys(current.state.apps) as CloudflarePreviewAppSlugType[]) {
    const app = cloudflarePreviewApps[appSlug];
    if (!app) {
      continue;
    }

    const destroyResult = await runPreviewAlchemyCommand({
      app,
      commandEnvironment: params.commandEnvironment,
      dopplerConfig: environmentConfigLease.dopplerConfig,
      operation: "down",
      repositoryRoot: params.repositoryRoot,
      signal: params.signal,
    });
    const existingEntry = latestState.apps[app.slug];
    const entry = CloudflarePreviewAppEntry.parse({
      ...existingEntry,
      appDisplayName: app.displayName,
      appSlug: app.slug,
      message:
        destroyResult.exitCode === 0
          ? "Preview app released."
          : commandFailureMessage(destroyResult, "Preview teardown failed."),
      status: destroyResult.exitCode === 0 ? "released" : "cleanup-failed",
      updatedAt: new Date().toISOString(),
    });
    if (entry.status === "cleanup-failed") {
      ok = false;
    }

    const update = await updatePreviewState(params, (state) => ({
      ...state,
      apps: {
        ...state.apps,
        [app.slug]: entry,
      },
    }));
    latestState = update.state;
  }

  if (!ok) {
    return {
      ok: false,
      released: false,
      state: latestState,
    };
  }

  const semaphore = params.createPreviewSemaphoreResourceClient({
    semaphoreApiToken: requireValue(
      params.semaphoreApiToken,
      "SEMAPHORE_API_TOKEN is required to clean up previews.",
    ),
    semaphoreBaseUrl: params.semaphoreBaseUrl ?? defaultSemaphoreBaseUrl,
  });
  const released = await semaphore.release({
    type: environmentConfigLease.type,
    slug: environmentConfigLease.slug,
    leaseId: environmentConfigLease.leaseId,
  });
  const update = await updatePreviewState(params, (state) => ({
    ...state,
    environmentConfigLease: null,
  }));

  return {
    ok: true,
    released: released.released,
    state: update.state,
  };
}

async function recordForkUnavailable(input: {
  appSlugs: CloudflarePreviewAppSlugType[];
  params: {
    githubToken: string;
    pullRequestNumber: number;
    repositoryFullName: string;
    workflowRunUrl?: string;
  };
  pullRequestHeadSha: string;
}) {
  const updatedAt = new Date().toISOString();
  const update = await updatePreviewState(input.params, (state) => ({
    ...state,
    apps: {
      ...state.apps,
      ...Object.fromEntries(
        input.appSlugs.map((appSlug) => {
          const app = cloudflarePreviewApps[appSlug];
          return [
            appSlug,
            CloudflarePreviewAppEntry.parse({
              appDisplayName: app.displayName,
              appSlug,
              headSha: input.pullRequestHeadSha,
              message: "Preview environments are unavailable for fork pull requests.",
              runUrl: input.params.workflowRunUrl ?? null,
              shortSha: input.pullRequestHeadSha.slice(0, 7),
              status: "fork-unavailable",
              updatedAt,
            }),
          ];
        }),
      ),
    },
  }));

  return update.state;
}

async function deployPreviewAppWithStatus(input: {
  app: PreviewAppRuntime;
  commandEnvironment: NodeJS.ProcessEnv;
  dopplerConfig: string;
  pullRequestHeadSha: string;
  repositoryRoot: string;
  runUrl: string | null;
  signal?: AbortSignal;
}) {
  try {
    return await deployPreviewApp(input);
  } catch (error) {
    return CloudflarePreviewAppEntry.parse({
      appDisplayName: input.app.displayName,
      appSlug: input.app.slug,
      headSha: input.pullRequestHeadSha,
      message: formatPreviewErrorMessage(error),
      runUrl: input.runUrl,
      shortSha: input.pullRequestHeadSha.slice(0, 7),
      status: "deploy-failed",
      updatedAt: new Date().toISOString(),
    });
  }
}

async function deployPreviewApp(input: {
  app: PreviewAppRuntime;
  commandEnvironment: NodeJS.ProcessEnv;
  dopplerConfig: string;
  pullRequestHeadSha: string;
  repositoryRoot: string;
  runUrl: string | null;
  signal?: AbortSignal;
}) {
  const appConfig = await readPreviewAppConfig({
    app: input.app,
    commandEnvironment: input.commandEnvironment,
    dopplerConfig: input.dopplerConfig,
    signal: input.signal,
    repositoryRoot: input.repositoryRoot,
  });
  const baseEntry = {
    appDisplayName: input.app.displayName,
    appSlug: input.app.slug,
    headSha: input.pullRequestHeadSha,
    publicUrl: appConfig.baseUrl,
    runUrl: input.runUrl,
    shortSha: input.pullRequestHeadSha.slice(0, 7),
    updatedAt: new Date().toISOString(),
  } as const;

  const deployResult = await runPreviewAlchemyCommand({
    app: input.app,
    commandEnvironment: input.commandEnvironment,
    dopplerConfig: input.dopplerConfig,
    operation: "up",
    repositoryRoot: input.repositoryRoot,
    signal: input.signal,
  });
  if (deployResult.exitCode !== 0) {
    return CloudflarePreviewAppEntry.parse({
      ...baseEntry,
      message: commandFailureMessage(deployResult, "Preview deployment failed."),
      status: "deploy-failed",
    });
  }

  const readiness = await waitForPreviewAppReadiness({
    projectHostnameBases: appConfig.projectHostnameBases,
    publicUrl: appConfig.baseUrl,
    signal: input.signal,
    timeoutMs: defaultPreviewReadyTimeoutMs,
  });
  if (!readiness.ok) {
    return CloudflarePreviewAppEntry.parse({
      ...baseEntry,
      message: readiness.message,
      status: "deploy-failed",
    });
  }

  return CloudflarePreviewAppEntry.parse({
    ...baseEntry,
    status: "awaiting-tests",
  });
}

async function readPreviewAppConfig(input: {
  app: PreviewAppRuntime;
  commandEnvironment: NodeJS.ProcessEnv;
  dopplerConfig: string;
  repositoryRoot: string;
  signal?: AbortSignal;
}) {
  const isNewStyleApp = isNewStyleCloudflareAppSlug(input.app.slug);
  const script = isNewStyleApp
    ? [
        'import { resolveNewStyleCloudflareAppBaseUrlFromEnv } from "@iterate-com/shared/apps/new-style-cloudflare-apps";',
        "function parseStringArrayEnv(value) {",
        "  if (!value?.trim()) return [];",
        "  const parsed = JSON.parse(value);",
        "  return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : [];",
        "}",
        "function parseAppConfigProjectHostnameBases() {",
        "  if (!process.env.APP_CONFIG?.trim()) return [];",
        "  const parsed = JSON.parse(process.env.APP_CONFIG);",
        "  return Array.isArray(parsed.projectHostnameBases) ? parsed.projectHostnameBases.filter((entry) => typeof entry === 'string') : [];",
        "}",
        "const config = {",
        "  baseUrl: resolveNewStyleCloudflareAppBaseUrlFromEnv(process.env) ?? null,",
        "  projectHostnameBases: (() => {",
        "    const envBases = parseStringArrayEnv(process.env.APP_CONFIG_PROJECT_HOSTNAME_BASES);",
        "    return envBases.length > 0 ? envBases : parseAppConfigProjectHostnameBases();",
        "  })(),",
        "};",
        "console.log(JSON.stringify(config));",
      ].join("\n")
    : [
        "const config = { baseUrl: process.env.APP_CONFIG_BASE_URL ?? null, projectHostnameBases: [] };",
        "console.log(JSON.stringify(config));",
      ].join("\n");
  const result = await runCommand({
    args: [
      "run",
      "--project",
      input.app.dopplerProject,
      "--config",
      input.dopplerConfig,
      "--",
      isNewStyleApp ? "pnpm" : "node",
      ...(isNewStyleApp ? ["exec", "tsx", "-e"] : []),
      ...(!isNewStyleApp ? ["-e"] : []),
      script,
    ],
    command: "doppler",
    echoOutput: false,
    environment: input.commandEnvironment,
    signal: input.signal,
    workingDirectory: resolve(input.repositoryRoot, input.app.appPath),
  });
  if (result.exitCode !== 0) {
    throw new Error(commandFailureMessage(result, "Failed to read preview app config."));
  }

  const parsed = z
    .object({
      baseUrl: z.string().trim().url(),
      projectHostnameBases: z.array(z.string().trim().min(1)).default([]),
    })
    .parse(JSON.parse(result.stdout));
  return parsed;
}

async function runPreviewAlchemyCommand(input: {
  app: PreviewAppRuntime;
  commandEnvironment: NodeJS.ProcessEnv;
  dopplerConfig: string;
  operation: "up" | "down";
  repositoryRoot: string;
  signal?: AbortSignal;
}) {
  if (isNewStyleCloudflareAppSlug(input.app.slug)) {
    return await runNewStyleCloudflareAppAlchemy({
      app: newStyleCloudflareApps[input.app.slug],
      commandEnvironment: input.commandEnvironment,
      dopplerConfig: input.dopplerConfig,
      operation: input.operation,
      repositoryRoot: input.repositoryRoot,
      signal: input.signal,
    });
  }

  return await runCommand({
    args: [
      "run",
      "--project",
      input.app.dopplerProject,
      "--config",
      input.dopplerConfig,
      "--",
      "pnpm",
      input.operation === "up" ? "alchemy:up" : "alchemy:down",
    ],
    command: "doppler",
    environment: input.commandEnvironment,
    signal: input.signal,
    workingDirectory: resolve(input.repositoryRoot, input.app.appPath),
  });
}

async function claimEnvironmentConfigLease(input: {
  createPreviewSemaphoreResourceClient: (input: {
    semaphoreApiToken: string;
    semaphoreBaseUrl: string;
  }) => PreviewSemaphoreResourceClient;
  leaseMs: number;
  previousEnvironmentConfigLease: EnvironmentConfigLease | null;
  semaphoreApiToken: string;
  semaphoreBaseUrl: string;
  waitMs?: number;
}) {
  const semaphore = input.createPreviewSemaphoreResourceClient({
    semaphoreApiToken: input.semaphoreApiToken,
    semaphoreBaseUrl: input.semaphoreBaseUrl,
  });

  const lease =
    (input.previousEnvironmentConfigLease
      ? await ignoreEnvironmentConfigLeaseReuseError(() =>
          semaphore.renew({
            type: input.previousEnvironmentConfigLease.type,
            slug: input.previousEnvironmentConfigLease.slug,
            leaseId: input.previousEnvironmentConfigLease.leaseId,
            leaseMs: input.leaseMs,
          }),
        )
      : null) ??
    (input.previousEnvironmentConfigLease
      ? await ignoreEnvironmentConfigLeaseReuseError(() =>
          semaphore.acquireSpecific({
            type: input.previousEnvironmentConfigLease.type,
            slug: input.previousEnvironmentConfigLease.slug,
            leaseMs: input.leaseMs,
          }),
        )
      : null) ??
    (await semaphore.acquire({
      type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
      leaseMs: input.leaseMs,
      waitMs: input.waitMs,
    }));

  const data = parseEnvironmentConfigLeaseData(lease.data);
  return {
    dopplerConfig: data.dopplerConfig,
    leasedUntil: lease.expiresAt,
    leaseId: lease.leaseId,
    slug: lease.slug,
    type: lease.type,
  } satisfies EnvironmentConfigLease;
}

async function ignoreEnvironmentConfigLeaseReuseError<T>(claim: () => Promise<T | null>) {
  try {
    return await claim();
  } catch {
    return null;
  }
}

async function selectPreviewAppsForPullRequest(input: {
  force: boolean;
  githubToken: string;
  previousState: CloudflarePreviewState;
  pullRequestBaseSha: string;
  pullRequestHeadSha: string;
  pullRequestNumber: number;
  repositoryFullName: string;
}) {
  if (input.force) {
    return Object.values(cloudflarePreviewApps);
  }

  const compareBaseSha = resolvePreviewCompareBaseSha(input);
  if (!compareBaseSha) {
    return [];
  }
  if (compareBaseSha === input.pullRequestHeadSha) {
    return selectPreviewAppsNeedingRetry({
      previousState: input.previousState,
      pullRequestHeadSha: input.pullRequestHeadSha,
    });
  }

  const octokit = new Octokit({ auth: input.githubToken });
  const [owner, repo] = splitRepositoryFullName(input.repositoryFullName);
  const comparison = await octokit.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${compareBaseSha}...${input.pullRequestHeadSha}`,
  });
  const changedFiles =
    comparison.data.files?.flatMap((file) => (file.filename ? [file.filename] : [])) ?? [];

  if (changedFiles.some((filename) => matchesPreviewPath(filename, cloudflarePreviewSharedPaths))) {
    return Object.values(cloudflarePreviewApps);
  }

  const selectedSlugs = new Set<CloudflarePreviewAppSlugType>();
  for (const app of Object.values(cloudflarePreviewApps)) {
    if (changedFiles.some((filename) => matchesPreviewPath(filename, app.paths))) {
      selectedSlugs.add(app.slug);
    }
  }

  return expandPreviewDependencies([...selectedSlugs]).map((slug) => cloudflarePreviewApps[slug]);
}

export function selectPreviewAppsNeedingRetry(params: {
  previousState: CloudflarePreviewState;
  pullRequestHeadSha: string;
}) {
  const retrySlugs = Object.values(params.previousState.apps)
    .filter((entry) => entry.headSha === params.pullRequestHeadSha)
    .filter((entry) => ["awaiting-tests", "deploy-failed", "tests-failed"].includes(entry.status))
    .map((entry) => CloudflarePreviewAppSlug.parse(entry.appSlug));

  return expandPreviewDependencies(retrySlugs).map((slug) => cloudflarePreviewApps[slug]);
}

export function expandPreviewDependencies(appSlugs: readonly CloudflarePreviewAppSlugType[]) {
  const selected = new Set(appSlugs);
  const visit = (appSlug: CloudflarePreviewAppSlugType) => {
    const app = cloudflarePreviewApps[appSlug];
    for (const dependency of app.previewDependencies ?? []) {
      if (selected.has(dependency)) {
        continue;
      }

      selected.add(dependency);
      visit(dependency);
    }
  };

  for (const appSlug of appSlugs) {
    visit(appSlug);
  }

  return Object.values(cloudflarePreviewApps)
    .map((app) => app.slug)
    .filter((appSlug) => selected.has(appSlug));
}

async function waitForPreviewAppReadiness(params: {
  projectHostnameBases: readonly string[];
  publicUrl: string;
  signal?: AbortSignal;
  timeoutMs: number;
}) {
  const urls = [
    new URL(defaultPreviewReadyUrlPath, params.publicUrl),
    ...params.projectHostnameBases.map(
      (base) =>
        new URL(defaultPreviewReadyUrlPath, `https://project.${normalizeHostnameBase(base)}`),
    ),
  ];

  for (const url of urls) {
    const readiness = await waitForHttpReadiness({
      signal: params.signal,
      timeoutMs: params.timeoutMs,
      url,
    });
    if (!readiness.ok) return readiness;
  }

  return { ok: true as const };
}

function normalizeHostnameBase(base: string) {
  return base.trim().replace(/^\*\./, "");
}

async function waitForHttpReadiness(params: { signal?: AbortSignal; timeoutMs: number; url: URL }) {
  const deadline = Date.now() + params.timeoutMs;
  let lastFailure = "No response received yet.";

  while (Date.now() < deadline) {
    try {
      const status = await fetchReadinessStatus(params.url, params.signal);
      if (status >= 200 && status < 300) {
        return { ok: true as const };
      }

      lastFailure = `Readiness check returned ${status} for ${params.url.toString()}.`;
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

async function fetchReadinessStatus(url: URL, signal: AbortSignal | undefined): Promise<number> {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal,
    });
    return response.status;
  } catch (error) {
    if (!isDnsLookupError(error)) {
      throw error;
    }

    return await requestStatusWithDnsResolve(url, signal);
  }
}

async function requestStatusWithDnsResolve(url: URL, signal: AbortSignal | undefined) {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported readiness URL protocol: ${url.protocol}`);
  }

  const addresses = await dns.resolve4(url.hostname);
  const address = addresses[0];
  if (!address) {
    throw new Error(`No A record found for ${url.hostname}`);
  }

  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  const resolvedUrl = new URL(url);
  resolvedUrl.hostname = address;

  return await new Promise<number>((resolve, reject) => {
    const req = request(
      resolvedUrl,
      {
        headers: { Host: url.host },
        method: "GET",
        servername: url.hostname,
        signal,
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;
        response.resume();
        response.on("end", () => resolve(statusCode));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function isDnsLookupError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const cause = "cause" in error ? error.cause : null;
  return (
    ("code" in error && error.code === "ENOTFOUND") ||
    (cause instanceof Error && "code" in cause && cause.code === "ENOTFOUND")
  );
}

async function resolvePullRequestPreviewContext(params: {
  githubToken: string;
  isFork?: boolean;
  pullRequestBaseSha?: string;
  pullRequestHeadSha?: string;
  pullRequestNumber: number;
  repositoryFullName: string;
}) {
  if (params.pullRequestHeadSha && params.pullRequestBaseSha && params.isFork !== undefined) {
    return {
      isFork: params.isFork,
      pullRequestBaseSha: params.pullRequestBaseSha,
      pullRequestHeadSha: params.pullRequestHeadSha,
    };
  }

  const octokit = new Octokit({ auth: params.githubToken });
  const [owner, repo] = splitRepositoryFullName(params.repositoryFullName);
  const pullRequest = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: params.pullRequestNumber,
  });

  return {
    isFork: pullRequest.data.head.repo?.fork ?? false,
    pullRequestBaseSha: params.pullRequestBaseSha ?? pullRequest.data.base.sha,
    pullRequestHeadSha: params.pullRequestHeadSha ?? pullRequest.data.head.sha,
  };
}

export function resolvePreviewCompareBaseSha(params: {
  previousState: CloudflarePreviewState;
  pullRequestBaseSha: string;
}) {
  const previousHeadSha = Object.values(params.previousState.apps)
    .map((entry) => entry.headSha)
    .find((headSha): headSha is string => typeof headSha === "string" && headSha.length > 0);
  return previousHeadSha ?? params.pullRequestBaseSha;
}

function matchesPreviewPath(filename: string, patterns: readonly string[]) {
  return patterns.some((pattern) => {
    if (pattern.endsWith("/**")) {
      return filename.startsWith(pattern.slice(0, -2));
    }

    return filename === pattern;
  });
}

async function updatePreviewState(
  params: {
    githubToken: string;
    pullRequestNumber: number;
    repositoryFullName: string;
  },
  update: (state: CloudflarePreviewState) => CloudflarePreviewState,
) {
  return await updateCloudflarePreviewState({
    githubToken: params.githubToken,
    pullRequestNumber: params.pullRequestNumber,
    repositoryFullName: params.repositoryFullName,
    update,
  });
}

function canRunPreviewTests(entry: CloudflarePreviewAppEntry | undefined) {
  return Boolean(
    entry?.publicUrl && ["awaiting-tests", "deployed", "tests-failed"].includes(entry.status),
  );
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

  return `...(truncated)\n${text.slice(-maxLength)}`;
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

function optionalBooleanWithEnvDefault(env: NodeJS.ProcessEnv, key: string) {
  const schema = z.stringbool();
  const rawDefaultValue = env[key]?.trim();
  return rawDefaultValue ? schema.default(schema.parse(rawDefaultValue)) : schema.optional();
}

function optionalSemaphoreApiTokenWithEnvDefault(env: NodeJS.ProcessEnv) {
  return optionalStringWithEnvDefault(env, "SEMAPHORE_API_TOKEN");
}

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined || value === "") {
    throw new Error(message);
  }

  return value;
}

function formatPreviewErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function sanitizePreviewOutput(value: string) {
  const text = stripAnsi(value);
  const lines = text.split("\n");
  const sanitizedLines = lines.map((line) => {
    if (/^DOPPLER_TOKEN=/i.test(line)) {
      return "DOPPLER_TOKEN=[redacted]";
    }

    return line;
  });

  return sanitizedLines.join("\n");
}
