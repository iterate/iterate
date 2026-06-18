import { promises as dns } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { resolve } from "node:path";
import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { createSemaphoreClient } from "../../apps/semaphore/src/contract.ts";
import { stripAnsi } from "../../packages/shared/src/dev/strip-ansi.ts";
import { runCommand } from "../../packages/shared/src/node/run-command.ts";
import {
  CloudflarePreviewAppEntry,
  type EnvironmentConfigLease,
  type CloudflarePreviewState,
  formatDurationMs,
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
import { reconcileEnvironmentConfigLeaseResources } from "./reconcile-environment-config-leases.ts";

const defaultSemaphoreBaseUrl = "https://semaphore.iterate.com";
const defaultRepositoryFullName = "iterate/iterate";
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
const defaultPreviewTestMaxAttempts = 1;
const defaultPreviewTestRetryDelayMs = 5_000;
const defaultPreviewDeployConcurrency = 5;
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
  list: (input: { type: string }) => Promise<
    Array<{
      data: Record<string, unknown>;
      lastAcquiredAt: number | null;
      lastReleasedAt: number | null;
      leaseState: "available" | "leased";
      leasedUntil: number | null;
      slug: string;
    }>
  >;
};

type PreviewLifecycleResult = {
  ok: boolean;
  skipped?: boolean;
  state: CloudflarePreviewState;
};

export type PreviewAppRuntime = (typeof cloudflarePreviewApps)[CloudflarePreviewAppSlugType];

type PullRequestCommandOptions = {
  /** GitHub token. Defaults to GITHUB_TOKEN. */
  githubToken?: string;
  /** Pull request number. Defaults to GITHUB_PR_NUMBER. */
  pullRequestNumber?: number;
};

type AcquireOptions = {
  /** Preview slot: a number (9) or slug (preview-9 / preview_9). */
  slot: string;
  /** Manual lease length in hours. */
  hours?: number;
};

type ReleaseOptions = {
  /** Preview slot: a number (9) or slug (preview-9 / preview_9). */
  slot: string;
  /** Lease id returned by `pnpm preview acquire`. */
  leaseId: string;
};

type PreviewRuntime = {
  commandEnvironment: NodeJS.ProcessEnv;
  createPreviewSemaphoreResourceClient: () => PreviewSemaphoreResourceClient;
  repositoryRoot: string;
  signal?: AbortSignal;
};

type PullRequestPreviewContext = {
  githubToken: string;
  pullRequestBaseSha: string;
  pullRequestHeadSha: string;
  pullRequestNumber: number;
  repositoryFullName: string;
  workflowRunUrl: string | null;
};

/**
 * Deploy affected preview apps for a pull request, run preview tests, and update the managed PR preview section.
 */
export default async function sync(options: PullRequestCommandOptions = {}) {
  const runtime = createPreviewRuntime();
  const result = await syncPreviewForPullRequest({
    ...runtime,
    context: await resolvePullRequestPreviewContext({
      commandEnvironment: runtime.commandEnvironment,
      githubToken: resolveGithubToken(options, runtime.commandEnvironment),
      pullRequestNumber: resolvePullRequestNumber(options, runtime.commandEnvironment),
    }),
  });

  if (!result.ok) {
    throw new Error("Failed to sync Cloudflare preview apps.");
  }

  return result;
}

/**
 * Deploy affected preview apps for a pull request without running preview e2e.
 */
export async function deploy(options: PullRequestCommandOptions = {}) {
  const runtime = createPreviewRuntime();
  const result = await deployPreviewForPullRequest({
    ...runtime,
    context: await resolvePullRequestPreviewContext({
      commandEnvironment: runtime.commandEnvironment,
      githubToken: resolveGithubToken(options, runtime.commandEnvironment),
      pullRequestNumber: resolvePullRequestNumber(options, runtime.commandEnvironment),
    }),
  });

  if (!result.ok) {
    throw new Error("Failed to deploy Cloudflare preview apps.");
  }

  return result;
}

/**
 * Run preview e2e against deployed apps recorded in the managed PR preview section.
 */
export async function test(options: PullRequestCommandOptions = {}) {
  const runtime = createPreviewRuntime();
  const result = await testPreviewForPullRequest({
    ...runtime,
    context: await resolvePullRequestPreviewContext({
      commandEnvironment: runtime.commandEnvironment,
      githubToken: resolveGithubToken(options, runtime.commandEnvironment),
      pullRequestNumber: resolvePullRequestNumber(options, runtime.commandEnvironment),
    }),
  });

  if (!result.ok) {
    throw new Error("Failed to run Cloudflare preview tests.");
  }

  return result;
}

/**
 * Tear down deployed apps recorded in the managed PR preview section and release the environment config lease.
 */
export async function cleanup(options: PullRequestCommandOptions = {}) {
  const runtime = createPreviewRuntime();
  const result = await cleanupPreviewForPullRequest({
    ...runtime,
    context: await resolvePullRequestPreviewContext({
      commandEnvironment: runtime.commandEnvironment,
      githubToken: resolveGithubToken(options, runtime.commandEnvironment),
      pullRequestNumber: resolvePullRequestNumber(options, runtime.commandEnvironment),
    }),
  });

  if (!result.ok) {
    throw new Error("Failed to clean up Cloudflare preview apps.");
  }

  return result;
}

/**
 * Show environment config lease inventory and active leases for PR previews.
 */
export async function status() {
  const runtime = createPreviewRuntime();
  const semaphore = runtime.createPreviewSemaphoreResourceClient();
  const now = Date.now();
  const resources = await semaphore.list({
    type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
  });
  const available = resources
    .filter((resource) => resource.leaseState === "available")
    .map((resource) => ({
      data: resource.data,
      slug: resource.slug,
      lastReleasedAt:
        resource.lastReleasedAt === null ? null : new Date(resource.lastReleasedAt).toISOString(),
    }));
  const leased = resources
    .filter((resource) => resource.leaseState === "leased")
    .map((resource) => ({
      data: resource.data,
      slug: resource.slug,
      leasedUntil:
        resource.leasedUntil === null ? null : new Date(resource.leasedUntil).toISOString(),
      expiresInMs: resource.leasedUntil === null ? null : resource.leasedUntil - now,
      lastAcquiredAt:
        resource.lastAcquiredAt === null ? null : new Date(resource.lastAcquiredAt).toISOString(),
    }))
    .sort((left, right) => {
      if (left.leasedUntil === null) return 1;
      if (right.leasedUntil === null) return -1;
      return left.leasedUntil.localeCompare(right.leasedUntil);
    });

  return {
    checkedAt: new Date(now).toISOString(),
    semaphoreBaseUrl: defaultSemaphoreBaseUrl,
    type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
    total: resources.length,
    availableCount: available.length,
    leasedCount: leased.length,
    nextLeaseExpiryAt: leased[0]?.leasedUntil ?? null,
    available,
    leased,
  };
}

/**
 * Lease a specific preview slot for manual deploys so PR cleanup cannot destroy it.
 */
export async function acquire(options: AcquireOptions) {
  const runtime = createPreviewRuntime();
  const semaphore = runtime.createPreviewSemaphoreResourceClient();
  const slug = normalizePreviewSlotSlug(options.slot);
  const lease = await semaphore.acquireSpecific({
    leaseMs: (options.hours || 3) * 3_600_000,
    slug,
    type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
  });
  if (!lease) {
    throw new Error(`Could not lease ${slug}: it is already leased or unknown.`);
  }

  return {
    ...lease,
    expiresAt: new Date(lease.expiresAt).toISOString(),
    releaseCommand: `pnpm preview release --slot ${slug} --lease-id ${lease.leaseId}`,
  };
}

/**
 * Release a preview slot lease acquired with `preview acquire`.
 */
export async function release(options: ReleaseOptions) {
  const runtime = createPreviewRuntime();
  const semaphore = runtime.createPreviewSemaphoreResourceClient();
  const slug = normalizePreviewSlotSlug(options.slot);
  const result = await semaphore.release({
    leaseId: options.leaseId,
    slug,
    type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
  });
  if (!result.released) {
    throw new Error(`Semaphore did not release ${slug}: wrong or expired leaseId.`);
  }

  return { released: true, slug };
}

/**
 * Check live Semaphore environment config leases against Doppler configs and Cloudflare preview domain zones.
 */
export async function reconcile() {
  const runtime = createPreviewRuntime();
  return await reconcileEnvironmentConfigLeaseResources({
    client: runtime.createPreviewSemaphoreResourceClient(),
    commandEnvironment: runtime.commandEnvironment,
    repositoryRoot: runtime.repositoryRoot,
    semaphoreBaseUrl: defaultSemaphoreBaseUrl,
  });
}

function createPreviewRuntime(): PreviewRuntime {
  return {
    commandEnvironment: process.env,
    createPreviewSemaphoreResourceClient: () => createPreviewSemaphoreResourceClient(process.env),
    repositoryRoot: process.cwd(),
  };
}

function createPreviewSemaphoreResourceClient(
  env: NodeJS.ProcessEnv,
): PreviewSemaphoreResourceClient {
  const apiKey = env.SEMAPHORE_API_TOKEN?.trim() || env.APP_CONFIG_SHARED_API_SECRET?.trim();
  if (!apiKey) {
    throw new Error(
      "SEMAPHORE_API_TOKEN or APP_CONFIG_SHARED_API_SECRET is required. Run under `doppler run --project _shared --config prd`.",
    );
  }

  const semaphore = createSemaphoreClient({
    apiKey,
    baseURL: defaultSemaphoreBaseUrl,
  });

  return {
    acquire: ({ leaseMs, type, waitMs }) => semaphore.resources.acquire({ leaseMs, type, waitMs }),
    acquireSpecific: ({ leaseMs, slug, type }) =>
      semaphore.resources.acquireSpecific({ leaseMs, slug, type }),
    renew: ({ leaseId, leaseMs, slug, type }) =>
      semaphore.resources.renew({ leaseId, leaseMs, slug, type }),
    release: ({ leaseId, slug, type }) => semaphore.resources.release({ leaseId, slug, type }),
    list: ({ type }) => semaphore.resources.list({ type }),
  };
}

function resolveGithubToken(options: PullRequestCommandOptions, env: NodeJS.ProcessEnv): string {
  return requireValue(options.githubToken || env.GITHUB_TOKEN?.trim(), "GITHUB_TOKEN is required.");
}

function resolvePullRequestNumber(
  options: PullRequestCommandOptions,
  env: NodeJS.ProcessEnv,
): number {
  const value = options.pullRequestNumber || Number(env.GITHUB_PR_NUMBER);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("A pull request number is required.");
  }

  return value;
}

function normalizePreviewSlotSlug(slot: string) {
  const trimmed = slot.trim().toLowerCase().replaceAll("_", "-");
  return /^\d+$/.test(trimmed) ? `preview-${trimmed}` : trimmed;
}

async function syncPreviewForPullRequest(
  params: PreviewRuntime & { context: PullRequestPreviewContext },
): Promise<PreviewLifecycleResult> {
  const deployResult = await deployPreviewForPullRequest(params);
  if (!deployResult.ok || deployResult.skipped) {
    return deployResult;
  }

  return await testPreviewForPullRequest(params);
}

async function deployPreviewForPullRequest(
  params: PreviewRuntime & { context: PullRequestPreviewContext },
): Promise<PreviewLifecycleResult> {
  const current = await readCloudflarePreviewState({
    githubToken: params.context.githubToken,
    repositoryFullName: params.context.repositoryFullName,
    pullRequestNumber: params.context.pullRequestNumber,
  });
  const selectedApps = await selectPreviewAppsForPullRequest({
    githubToken: params.context.githubToken,
    previousState: current.state,
    pullRequestBaseSha: params.context.pullRequestBaseSha,
    pullRequestHeadSha: params.context.pullRequestHeadSha,
    pullRequestNumber: params.context.pullRequestNumber,
    repositoryFullName: params.context.repositoryFullName,
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
    leaseMs: defaultPreviewLeaseMs,
    previousEnvironmentConfigLease: current.state.environmentConfigLease,
  });
  const leaseUpdate = await updatePreviewState(params, (state) => ({
    ...state,
    environmentConfigLease,
  }));

  let ok = true;
  let latestState = leaseUpdate.state;
  for (const batch of orderPreviewDeployBatches(selectedApps)) {
    const entries = await mapWithConcurrency(
      batch,
      defaultPreviewDeployConcurrency,
      async (app) => {
        return await deployPreviewAppWithStatus({
          app,
          commandEnvironment: params.commandEnvironment,
          dopplerConfig: environmentConfigLease.dopplerConfig,
          pullRequestHeadSha: params.context.pullRequestHeadSha,
          repositoryRoot: params.repositoryRoot,
          runUrl: params.context.workflowRunUrl,
          signal: params.signal,
        });
      },
    );
    if (entries.some((entry) => entry.status === "deploy-failed")) {
      ok = false;
    }

    const update = await updatePreviewState(params, (state) => ({
      ...state,
      environmentConfigLease,
      apps: {
        ...state.apps,
        ...Object.fromEntries(entries.map((entry) => [entry.appSlug, entry])),
      },
    }));
    latestState = update.state;
  }

  return {
    ok,
    state: latestState,
  };
}

async function testPreviewForPullRequest(
  params: PreviewRuntime & { context: PullRequestPreviewContext },
): Promise<PreviewLifecycleResult> {
  const current = await readCloudflarePreviewState({
    githubToken: params.context.githubToken,
    repositoryFullName: params.context.repositoryFullName,
    pullRequestNumber: params.context.pullRequestNumber,
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
    .filter((entry) => entry.headSha === params.context.pullRequestHeadSha)
    .map((entry) => cloudflarePreviewApps[entry.appSlug as CloudflarePreviewAppSlugType])
    .filter((app): app is PreviewAppRuntime => app != null);

  if (testableApps.length === 0) {
    return {
      ok: true,
      skipped: true,
      state: current.state,
    };
  }

  const entries: z.infer<typeof CloudflarePreviewAppEntry>[] = [];
  // Preview e2e commands are full app-level suites. Run them one at a time so
  // unrelated app checks do not multiply load against the same preview slot.
  for (const app of testableApps) {
    const existingEntry = current.state.apps[app.slug];
    if (!existingEntry?.publicUrl) {
      continue;
    }

    const startedAt = Date.now();
    console.error(`[preview] test start: ${app.slug}`);
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
    const testDurationMs = Date.now() - startedAt;
    console.error(
      `[preview] test ${testResult.exitCode === 0 ? "passed" : "failed"}: ${app.slug} (${formatDurationMs(testDurationMs)})`,
    );

    entries.push(
      CloudflarePreviewAppEntry.parse({
        ...existingEntry,
        appDisplayName: app.displayName,
        appSlug: app.slug,
        message:
          testResult.exitCode === 0
            ? null
            : commandFailureMessage(testResult, "Preview tests failed after deploy."),
        runUrl: params.context.workflowRunUrl ?? existingEntry.runUrl ?? null,
        status: testResult.exitCode === 0 ? "deployed" : "tests-failed",
        testDurationMs,
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  const ok = !entries.some((entry) => entry.status === "tests-failed");
  if (entries.length > 0) {
    const update = await updatePreviewState(params, (state) => ({
      ...state,
      apps: {
        ...state.apps,
        ...Object.fromEntries(entries.map((entry) => [entry.appSlug, entry])),
      },
    }));
    return {
      ok,
      state: update.state,
    };
  }

  return {
    ok,
    state: current.state,
  };
}

async function cleanupPreviewForPullRequest(
  params: PreviewRuntime & { context: PullRequestPreviewContext },
) {
  const current = await readCloudflarePreviewState({
    githubToken: params.context.githubToken,
    repositoryFullName: params.context.repositoryFullName,
    pullRequestNumber: params.context.pullRequestNumber,
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
  const appsToCleanUp = (Object.keys(current.state.apps) as CloudflarePreviewAppSlugType[])
    .map((appSlug) => cloudflarePreviewApps[appSlug])
    .filter((app): app is PreviewAppRuntime => app != null);
  const cleanupBatches = [...orderPreviewDeployBatches(appsToCleanUp)].reverse();
  for (const batch of cleanupBatches) {
    const entries = await mapWithConcurrency(
      batch,
      defaultPreviewDeployConcurrency,
      async (app) => {
        const startedAt = Date.now();
        console.error(`[preview] cleanup start: ${app.slug}`);
        const destroyResult = await runPreviewAlchemyCommand({
          app,
          commandEnvironment: params.commandEnvironment,
          dopplerConfig: environmentConfigLease.dopplerConfig,
          operation: "down",
          repositoryRoot: params.repositoryRoot,
          signal: params.signal,
        });
        const cleanupDurationMs = Date.now() - startedAt;
        console.error(
          `[preview] cleanup ${destroyResult.exitCode === 0 ? "passed" : "failed"}: ${app.slug} (${formatDurationMs(cleanupDurationMs)})`,
        );
        const existingEntry = latestState.apps[app.slug];
        return CloudflarePreviewAppEntry.parse({
          ...existingEntry,
          appDisplayName: app.displayName,
          appSlug: app.slug,
          message:
            destroyResult.exitCode === 0
              ? "Preview app released."
              : commandFailureMessage(destroyResult, "Preview teardown failed."),
          cleanupDurationMs,
          status: destroyResult.exitCode === 0 ? "released" : "cleanup-failed",
          updatedAt: new Date().toISOString(),
        });
      },
    );
    if (entries.some((entry) => entry.status === "cleanup-failed")) {
      ok = false;
    }

    const update = await updatePreviewState(params, (state) => ({
      ...state,
      apps: {
        ...state.apps,
        ...Object.fromEntries(entries.map((entry) => [entry.appSlug, entry])),
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

  const semaphore = params.createPreviewSemaphoreResourceClient();
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

async function deployPreviewAppWithStatus(input: {
  app: PreviewAppRuntime;
  commandEnvironment: NodeJS.ProcessEnv;
  dopplerConfig: string;
  pullRequestHeadSha: string;
  repositoryRoot: string;
  runUrl: string | null;
  signal?: AbortSignal;
}) {
  const startedAt = Date.now();
  console.error(`[preview] deploy start: ${input.app.slug}`);
  try {
    const entry = await deployPreviewApp(input);
    const deployDurationMs = Date.now() - startedAt;
    console.error(
      `[preview] deploy ${entry.status === "awaiting-tests" ? "passed" : "failed"}: ${input.app.slug} (${formatDurationMs(deployDurationMs)})`,
    );
    return CloudflarePreviewAppEntry.parse({
      ...entry,
      deployDurationMs,
    });
  } catch (error) {
    const deployDurationMs = Date.now() - startedAt;
    console.error(
      `[preview] deploy failed: ${input.app.slug} (${formatDurationMs(deployDurationMs)})`,
    );
    return CloudflarePreviewAppEntry.parse({
      appDisplayName: input.app.displayName,
      appSlug: input.app.slug,
      deployDurationMs,
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
    publicUrl: appConfig.baseUrl,
    readyUrlPath: input.app.previewReadyUrlPath,
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
  const script = [
    "function parseStringArrayEnv(value) {",
    "  if (!value?.trim()) return [];",
    "  const parsed = JSON.parse(value);",
    "  return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : [];",
    "}",
    "function parseAppConfig() {",
    "  if (!process.env.APP_CONFIG?.trim()) return {};",
    "  return JSON.parse(process.env.APP_CONFIG);",
    "}",
    "const appConfig = parseAppConfig();",
    "const envBases = parseStringArrayEnv(process.env.APP_CONFIG_PROJECT_HOSTNAME_BASES);",
    "const config = {",
    "  baseUrl: process.env.APP_CONFIG_BASE_URL || appConfig.baseUrl || null,",
    "  projectHostnameBases: envBases.length > 0 ? envBases : Array.isArray(appConfig.projectHostnameBases) ? appConfig.projectHostnameBases.filter((entry) => typeof entry === 'string') : [],",
    "};",
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
      "node",
      "-e",
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
  const commandArgs =
    input.operation === "down"
      ? (input.app.destroyCommandArgs ?? ["pnpm", "tsx", "./alchemy.run.ts", "--destroy"])
      : (input.app.deployCommandArgs ?? ["pnpm", "tsx", "./alchemy.run.ts"]);

  return await runCommand({
    args: [
      "run",
      "--project",
      input.app.dopplerProject,
      "--config",
      input.dopplerConfig,
      "--",
      ...commandArgs,
    ],
    command: "doppler",
    environment: input.commandEnvironment,
    signal: input.signal,
    workingDirectory: resolve(input.repositoryRoot, input.app.appPath),
  });
}

async function claimEnvironmentConfigLease(input: {
  createPreviewSemaphoreResourceClient: () => PreviewSemaphoreResourceClient;
  leaseMs: number;
  previousEnvironmentConfigLease: EnvironmentConfigLease | null;
}) {
  const semaphore = input.createPreviewSemaphoreResourceClient();

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
  githubToken: string;
  previousState: CloudflarePreviewState;
  pullRequestBaseSha: string;
  pullRequestHeadSha: string;
  pullRequestNumber: number;
  repositoryFullName: string;
}) {
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

function selectPreviewAppsNeedingRetry(params: {
  previousState: CloudflarePreviewState;
  pullRequestHeadSha: string;
}) {
  const retrySlugs = Object.values(params.previousState.apps)
    .filter((entry) => entry.headSha === params.pullRequestHeadSha)
    .filter((entry) => ["awaiting-tests", "deploy-failed", "tests-failed"].includes(entry.status))
    .map((entry) => CloudflarePreviewAppSlug.parse(entry.appSlug));

  return expandPreviewDependencies(retrySlugs).map((slug) => cloudflarePreviewApps[slug]);
}

function expandPreviewDependencies(appSlugs: readonly CloudflarePreviewAppSlugType[]) {
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

function orderPreviewDeployBatches(apps: readonly PreviewAppRuntime[]) {
  const os = apps.find((app) => app.slug === "os");
  const auth = apps.find((app) => app.slug === "auth");
  if (!os || !auth) {
    return apps.length > 0 ? [[...apps]] : [];
  }

  return [apps.filter((app) => app.slug !== "os"), [os]];
}

async function mapWithConcurrency<T, Result>(
  items: readonly T[],
  concurrency: number,
  mapItem: (item: T, index: number) => Promise<Result>,
) {
  const results = new Array<Result>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(items.length, concurrency);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapItem(items[index] as T, index);
      }
    }),
  );

  return results;
}

async function waitForPreviewAppReadiness(params: {
  publicUrl: string;
  readyUrlPath?: string;
  signal?: AbortSignal;
  timeoutMs: number;
}) {
  const urls = resolvePreviewReadinessUrls({
    publicUrl: params.publicUrl,
    readyUrlPath: params.readyUrlPath,
  });

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

function resolvePreviewReadinessUrls(params: {
  projectHostnameBases?: readonly string[];
  publicUrl: string;
  readyUrlPath?: string;
}) {
  // Project hostname bases are routed by app data and wildcard DNS, so a
  // synthetic host like project.<base> is not a reliable app-health signal.
  return [new URL(params.readyUrlPath ?? defaultPreviewReadyUrlPath, params.publicUrl)];
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
  commandEnvironment: NodeJS.ProcessEnv;
  githubToken: string;
  pullRequestNumber: number;
}): Promise<PullRequestPreviewContext> {
  const repositoryFullName =
    params.commandEnvironment.GITHUB_REPOSITORY?.trim() || defaultRepositoryFullName;
  const octokit = new Octokit({ auth: params.githubToken });
  const [owner, repo] = splitRepositoryFullName(repositoryFullName);
  const pullRequest = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: params.pullRequestNumber,
  });

  return {
    githubToken: params.githubToken,
    pullRequestBaseSha: pullRequest.data.base.sha,
    pullRequestHeadSha: pullRequest.data.head.sha,
    pullRequestNumber: params.pullRequestNumber,
    repositoryFullName,
    workflowRunUrl:
      makeDefaultWorkflowRunUrl(params.commandEnvironment) || pullRequest.data.html_url || null,
  };
}

function resolvePreviewCompareBaseSha(params: {
  previousState: CloudflarePreviewState;
  pullRequestBaseSha: string;
}) {
  const previousHeadSha = Object.values(params.previousState.apps)
    .map((entry) => entry.headSha)
    .find((headSha): headSha is string => typeof headSha === "string" && headSha.length > 0);
  return previousHeadSha ?? params.pullRequestBaseSha;
}

export const previewInternals = {
  expandPreviewDependencies,
  orderPreviewDeployBatches,
  resolvePreviewCompareBaseSha,
  resolvePreviewReadinessUrls,
  selectPreviewAppsNeedingRetry,
};

function matchesPreviewPath(filename: string, patterns: readonly string[]) {
  return patterns.some((pattern) => {
    if (pattern.endsWith("/**")) {
      return filename.startsWith(pattern.slice(0, -2));
    }

    return filename === pattern;
  });
}

async function updatePreviewState(
  params: { context: PullRequestPreviewContext },
  update: (state: CloudflarePreviewState) => CloudflarePreviewState,
) {
  return await updateCloudflarePreviewState({
    githubToken: params.context.githubToken,
    pullRequestNumber: params.context.pullRequestNumber,
    repositoryFullName: params.context.repositoryFullName,
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
