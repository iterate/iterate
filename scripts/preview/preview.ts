import { spawn } from "node:child_process";
import { promises as dns } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { resolve } from "node:path";
import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { stripAnsi } from "../../packages/shared/src/jonasland/strip-ansi.ts";
import {
  CloudflarePreviewAppEntry,
  type CloudflarePreviewEnvironment,
  type CloudflarePreviewState,
  readCloudflarePreviewState,
  updateCloudflarePreviewState,
} from "./state.ts";
import { splitRepositoryFullName } from "./repository-full-name.ts";
import { type CloudflarePreviewAppSlug, cloudflarePreviewApps } from "./apps.ts";
import {
  CLOUDFLARE_PREVIEW_RESOURCE_TYPE,
  parsePreviewEnvironmentData,
} from "./preview-inventory.ts";

const defaultSemaphoreBaseUrl = "https://semaphore.iterate.com";
const defaultPreviewLeaseMs = 60 * 60 * 1000;
const defaultPreviewReadyTimeoutMs = 600_000;
const defaultPreviewReadyUrlPath = "/api/__internal/health";
const defaultPreviewTestMaxAttempts = 2;
const defaultPreviewTestRetryDelayMs = 5_000;
const sharedPreviewDependencyPaths = [
  ".github/workflows/cloudflare-previews.yml",
  ".github/ts-workflows/workflows/cloudflare-previews.ts",
  "packages/shared/src/alchemy/**",
  "packages/shared/src/apps/**",
  "scripts/preview/**",
] as const;

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

type PreviewAppRuntime = (typeof cloudflarePreviewApps)[CloudflarePreviewAppSlug];

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
    const appSlugs = Object.keys(cloudflarePreviewApps) as CloudflarePreviewAppSlug[];
    const state = await recordForkUnavailable({
      appSlugs,
      params,
      pullRequestHeadSha: pullRequest.pullRequestHeadSha,
    }).catch(() => ({
      apps: {},
      environment: null,
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

  const environment = await claimPreviewEnvironment({
    createPreviewSemaphoreResourceClient: params.createPreviewSemaphoreResourceClient,
    leaseMs: params.leaseMs,
    previousEnvironment: current.state.environment,
    semaphoreApiToken: requireValue(
      params.semaphoreApiToken,
      "SEMAPHORE_API_TOKEN is required to create a preview.",
    ),
    semaphoreBaseUrl: params.semaphoreBaseUrl ?? defaultSemaphoreBaseUrl,
    waitMs: params.waitMs,
  });
  await updatePreviewState(params, (state) => ({
    ...state,
    environment,
  }));

  let ok = true;
  let latestState = current.state;
  for (const app of selectedApps) {
    const entry = await deployPreviewAppWithStatus({
      app,
      commandEnvironment: params.commandEnvironment,
      dopplerConfig: environment.dopplerConfig,
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
      environment,
      apps: {
        ...state.apps,
        [app.slug]: entry,
      },
    }));
    latestState = update.state;

    if (!ok) {
      break;
    }
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
  const environment = current.state.environment;
  if (environment == null) {
    return {
      ok: true,
      skipped: true,
      state: current.state,
    };
  }

  const testableApps = Object.values(current.state.apps)
    .filter((entry) => canRunPreviewTests(entry))
    .filter((entry) => !params.pullRequestHeadSha || entry.headSha === params.pullRequestHeadSha)
    .map((entry) => cloudflarePreviewApps[entry.appSlug as CloudflarePreviewAppSlug])
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
        environment.dopplerConfig,
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
  const environment = current.state.environment;
  if (environment == null) {
    return {
      ok: true,
      released: false,
      state: current.state,
    };
  }

  let ok = true;
  let latestState = current.state;
  for (const appSlug of Object.keys(current.state.apps) as CloudflarePreviewAppSlug[]) {
    const app = cloudflarePreviewApps[appSlug];
    if (!app) {
      continue;
    }

    const destroyResult = await runCommand({
      args: [
        "run",
        "--project",
        app.dopplerProject,
        "--config",
        environment.dopplerConfig,
        "--",
        "pnpm",
        "alchemy:down",
      ],
      command: "doppler",
      environment: params.commandEnvironment,
      signal: params.signal,
      workingDirectory: resolve(params.repositoryRoot, app.appPath),
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
    type: environment.type,
    slug: environment.slug,
    leaseId: environment.leaseId,
  });
  const update = await updatePreviewState(params, (state) => ({
    ...state,
    environment: null,
  }));

  return {
    ok: released.released,
    released: released.released,
    state: update.state,
  };
}

async function recordForkUnavailable(input: {
  appSlugs: CloudflarePreviewAppSlug[];
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
    commandEnvironment: input.commandEnvironment,
    dopplerConfig: input.dopplerConfig,
    dopplerProject: input.app.dopplerProject,
    signal: input.signal,
    workingDirectory: resolve(input.repositoryRoot, input.app.appPath),
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

  const deployResult = await runCommand({
    args: [
      "run",
      "--project",
      input.app.dopplerProject,
      "--config",
      input.dopplerConfig,
      "--",
      "pnpm",
      "alchemy:up",
    ],
    command: "doppler",
    environment: input.commandEnvironment,
    signal: input.signal,
    workingDirectory: resolve(input.repositoryRoot, input.app.appPath),
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
  commandEnvironment: NodeJS.ProcessEnv;
  dopplerConfig: string;
  dopplerProject: string;
  signal?: AbortSignal;
  workingDirectory: string;
}) {
  const script = [
    "const config = { baseUrl: process.env.APP_CONFIG_BASE_URL ?? null };",
    "console.log(JSON.stringify(config));",
  ].join("\n");
  const result = await runCommand({
    args: [
      "run",
      "--project",
      input.dopplerProject,
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
    workingDirectory: input.workingDirectory,
  });
  if (result.exitCode !== 0) {
    throw new Error(commandFailureMessage(result, "Failed to read preview app config."));
  }

  const parsed = z
    .object({
      baseUrl: z.string().trim().url(),
    })
    .parse(JSON.parse(result.stdout));
  return parsed;
}

async function claimPreviewEnvironment(input: {
  createPreviewSemaphoreResourceClient: (input: {
    semaphoreApiToken: string;
    semaphoreBaseUrl: string;
  }) => PreviewSemaphoreResourceClient;
  leaseMs: number;
  previousEnvironment: CloudflarePreviewEnvironment | null;
  semaphoreApiToken: string;
  semaphoreBaseUrl: string;
  waitMs?: number;
}) {
  const semaphore = input.createPreviewSemaphoreResourceClient({
    semaphoreApiToken: input.semaphoreApiToken,
    semaphoreBaseUrl: input.semaphoreBaseUrl,
  });

  const lease =
    (input.previousEnvironment
      ? await semaphore.renew({
          type: input.previousEnvironment.type,
          slug: input.previousEnvironment.slug,
          leaseId: input.previousEnvironment.leaseId,
          leaseMs: input.leaseMs,
        })
      : null) ??
    (input.previousEnvironment
      ? await semaphore.acquireSpecific({
          type: input.previousEnvironment.type,
          slug: input.previousEnvironment.slug,
          leaseMs: input.leaseMs,
        })
      : null) ??
    (await semaphore.acquire({
      type: CLOUDFLARE_PREVIEW_RESOURCE_TYPE,
      leaseMs: input.leaseMs,
      waitMs: input.waitMs,
    }));

  const data = parsePreviewEnvironmentData(lease.data);
  return {
    dopplerConfig: data.dopplerConfig,
    leasedUntil: lease.expiresAt,
    leaseId: lease.leaseId,
    slug: lease.slug,
    type: lease.type,
  } satisfies CloudflarePreviewEnvironment;
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

  const compareBaseSha = await resolvePreviewCompareBaseSha(input);
  if (!compareBaseSha || compareBaseSha === input.pullRequestHeadSha) {
    return [];
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

  if (changedFiles.some((filename) => matchesPreviewPath(filename, sharedPreviewDependencyPaths))) {
    return Object.values(cloudflarePreviewApps);
  }

  const selectedSlugs = new Set<CloudflarePreviewAppSlug>();
  for (const app of Object.values(cloudflarePreviewApps)) {
    if (changedFiles.some((filename) => matchesPreviewPath(filename, app.paths))) {
      selectedSlugs.add(app.slug);
    }
  }

  return expandPreviewDependencies([...selectedSlugs]).map((slug) => cloudflarePreviewApps[slug]);
}

export function expandPreviewDependencies(appSlugs: readonly CloudflarePreviewAppSlug[]) {
  const selected = new Set(appSlugs);
  const visit = (appSlug: CloudflarePreviewAppSlug) => {
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
  publicUrl: string;
  signal?: AbortSignal;
  timeoutMs: number;
}) {
  return await waitForHttpReadiness({
    signal: params.signal,
    timeoutMs: params.timeoutMs,
    url: new URL(defaultPreviewReadyUrlPath, params.publicUrl),
  });
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

async function resolvePreviewCompareBaseSha(params: {
  githubToken: string;
  previousState: CloudflarePreviewState;
  pullRequestNumber: number;
  pullRequestBaseSha: string;
  pullRequestHeadSha: string;
  repositoryFullName: string;
}) {
  const previousPullRequestHeadSha = await resolvePreviousPullRequestHeadSha(params);
  if (previousPullRequestHeadSha) {
    return previousPullRequestHeadSha;
  }

  const previousHeadSha = Object.values(params.previousState.apps)
    .map((entry) => entry.headSha)
    .find((headSha): headSha is string => typeof headSha === "string" && headSha.length > 0);
  return previousHeadSha ?? params.pullRequestBaseSha;
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

async function runCommand(params: {
  args: string[];
  command: string;
  echoOutput?: boolean;
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
      if (params.echoOutput !== false) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(Buffer.from(chunk));
      if (params.echoOutput !== false) process.stderr.write(chunk);
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
