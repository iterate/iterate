import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as dns } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { resolve } from "node:path";
import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { createSemaphoreClient } from "../../apps/semaphore/src/contract.ts";
import { markdownAnnotator } from "../../packages/shared/src/dev/markdown-annotator.ts";
import { stripAnsi } from "../../packages/shared/src/dev/strip-ansi.ts";
import { runCommand } from "../../packages/shared/src/node/run-command.ts";

type PullRequestCommandOptions = {
  /** GitHub token. Defaults to GITHUB_TOKEN. */
  githubToken?: string;
  /** Pull request number. Defaults to GITHUB_PR_NUMBER. */
  pullRequestNumber?: number;
};

/**
 * Deploy affected preview apps for a pull request without running preview e2e.
 */
export async function deploy(options: PullRequestCommandOptions = {}) {
  const runtime = createPreviewRuntime();
  const context = await resolvePullRequestPreviewContext({
    commandEnvironment: runtime.commandEnvironment,
    githubToken: resolveGithubToken(options, runtime.commandEnvironment),
    pullRequestNumber: resolvePullRequestNumber(options, runtime.commandEnvironment),
  });

  const current = await readCloudflarePreviewState(context);
  const selectedApps = await selectPreviewAppsForPullRequest({
    ...context,
    previousState: current.state,
  });

  if (selectedApps.length === 0) {
    return {
      ok: true,
      skipped: true,
      state: current.state,
    };
  }

  const environmentConfigLease = await claimEnvironmentConfigLease({
    createPreviewSemaphoreResourceClient: runtime.createPreviewSemaphoreResourceClient,
    leaseMs: defaultPreviewLeaseMs,
    previousEnvironmentConfigLease: current.state.environmentConfigLease,
  });
  const leaseUpdate = await updatePreviewState(context, (state) => ({
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
          commandEnvironment: runtime.commandEnvironment,
          dopplerConfig: environmentConfigLease.dopplerConfig,
          pullRequestHeadSha: context.pullRequestHeadSha,
          repositoryRoot: runtime.repositoryRoot,
          runUrl: context.workflowRunUrl,
          signal: runtime.signal,
        });
      },
    );
    if (entries.some((entry) => entry.status === "deploy-failed")) {
      ok = false;
    }

    const update = await updatePreviewState(context, (state) => ({
      ...state,
      environmentConfigLease,
      apps: {
        ...state.apps,
        ...Object.fromEntries(entries.map((entry) => [entry.appSlug, entry])),
      },
    }));
    latestState = update.state;
  }

  const result = {
    ok,
    state: latestState,
  };

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
  const context = await resolvePullRequestPreviewContext({
    commandEnvironment: runtime.commandEnvironment,
    githubToken: resolveGithubToken(options, runtime.commandEnvironment),
    pullRequestNumber: resolvePullRequestNumber(options, runtime.commandEnvironment),
  });

  const current = await readCloudflarePreviewState(context);
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
    .filter((entry) => entry.headSha === context.pullRequestHeadSha)
    .map((entry) => cloudflarePreviewApps[entry.appSlug as CloudflarePreviewAppSlugType])
    .filter((app): app is PreviewAppRuntime => app != null);

  if (testableApps.length === 0) {
    return {
      ok: true,
      skipped: true,
      state: current.state,
    };
  }

  const entries: CloudflarePreviewAppEntry[] = [];
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
      environment: runtime.commandEnvironment,
      maxAttempts: defaultPreviewTestMaxAttempts,
      retryDelayMs: defaultPreviewTestRetryDelayMs,
      signal: runtime.signal,
      workingDirectory: resolve(runtime.repositoryRoot, app.appPath),
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
        runUrl: context.workflowRunUrl ?? existingEntry.runUrl ?? null,
        status: testResult.exitCode === 0 ? "deployed" : "tests-failed",
        testDurationMs,
        updatedAt: new Date().toISOString(),
      } satisfies CloudflarePreviewAppEntry),
    );
  }

  const ok = !entries.some((entry) => entry.status === "tests-failed");
  if (entries.length > 0) {
    const update = await updatePreviewState(context, (state) => ({
      ...state,
      apps: {
        ...state.apps,
        ...Object.fromEntries(entries.map((entry) => [entry.appSlug, entry])),
      },
    }));
    const result = {
      ok,
      state: update.state,
    };

    if (!result.ok) {
      throw new Error("Failed to run Cloudflare preview tests.");
    }

    return result;
  }

  const result = {
    ok,
    state: current.state,
  };

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
type AcquireOptions = {
  /** Preview slot: a number (9) or slug (preview-9 / preview_9). */
  slot: string;
  /** Manual lease length in hours. */
  hours?: number;
};

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
type ReleaseOptions = {
  /** Preview slot: a number (9) or slug (preview-9 / preview_9). */
  slot: string;
  /** Lease id returned by `pnpm preview acquire`. */
  leaseId: string;
};

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

/**
 * Ensure preview auth, OS, and streams-example Doppler configs contain per-slot constants.
 */
type ProvisionAuthPreviewConfigsOptions = {
  /** Regenerate OAuth client secrets and app auth tokens instead of keeping existing values. */
  rotate?: boolean;
};

export async function provisionAuthPreviewConfigs(
  options: ProvisionAuthPreviewConfigsOptions = {},
) {
  await ensureAuthPreviewConfigs({
    rotate: Boolean(options.rotate),
  });

  return {
    rotated: Boolean(options.rotate),
    slots: previewEnvironmentSlotNumbers.length,
  };
}

export const CloudflarePreviewAppSlug = z.enum(["os", "semaphore", "auth", "streams-example-app"]);

export type CloudflarePreviewAppSlug = z.infer<typeof CloudflarePreviewAppSlug>;
type CloudflarePreviewAppSlugType = CloudflarePreviewAppSlug;

export type CloudflarePreviewApp = {
  slug: CloudflarePreviewAppSlug;
  displayName: string;
  appPath: `apps/${string}`;
  deployCommandArgs?: readonly [string, ...string[]];
  destroyCommandArgs?: readonly [string, ...string[]];
  dopplerProject: string;
  paths: string[];
  previewDependencies?: CloudflarePreviewAppSlug[];
  /** Readiness probe path on the app's public URL (default /api/__internal/health). */
  previewReadyUrlPath?: string;
  previewTestBaseUrlEnvVar: string;
  previewTestArtifacts?: readonly [string, ...string[]];
  previewTestCommandArgs: readonly [string, ...string[]];
};

// Deployed apps compile in @iterate-com/shared via many subpath exports (streams,
// durable-object-utils, callable, codemode, config, evlog, ...), so trigger on the
// whole package rather than chasing individual subdirectories. Deploys are idempotent,
// so over-triggering is safe; under-triggering means prod silently misses deploys.
export const cloudflareAppSharedPaths = [
  "packages/shared/**",
  "packages/ui/**",
  "packages/mock-http-proxy/**",
] as const;

export const cloudflarePreviewSharedPaths = [
  ".github/workflows/cloudflare-previews.yml",
  ".github/ts-workflows/workflows/cloudflare-previews.ts",
  ...cloudflareAppSharedPaths,
  "scripts/preview/**",
] as const;

/** Trigger preview workflow runs; apps here are not necessarily redeployed. */
export const cloudflarePreviewAdditionalTriggerPaths = [
  "apps/iterate-com/**",
  "apps/auth-example/**",
] as const;

export const cloudflarePreviewApps: Record<CloudflarePreviewAppSlug, CloudflarePreviewApp> = {
  os: {
    slug: "os",
    displayName: "OS",
    appPath: "apps/os",
    deployCommandArgs: ["pnpm", "run-script", "deploy"],
    destroyCommandArgs: ["pnpm", "run-script", "destroy"],
    dopplerProject: "os",
    // oRPC's /api/__internal/health is gone with the teardown — readiness now
    // probes the plain /api/health route that replaced it. Without this, the
    // preview deploy waits the full 10min readiness timeout on a 404 and fails.
    previewReadyUrlPath: "/api/health",
    paths: [
      "apps/os/**",
      "apps/auth/**",
      "apps/auth-contract/**",
      "apps/os/src/domains/streams/**",
    ],
    // OS bakes auth JWKS during deployment, so the slot's auth deployment must
    // finish before OS deploy starts.
    previewDependencies: ["auth"],
    previewTestArtifacts: [
      "test-results",
      "apps/os/test-results",
      "/tmp/os-e2e-*",
      "/tmp/os-itx-e2e-*",
    ],
    previewTestBaseUrlEnvVar: "OS_BASE_URL",
    // The full apps/os e2e Vitest suite (preview smoke + engine + itx lanes)
    // and the itx e2e (node project only — the browser project needs a
    // Playwright chromium install the preview e2e job doesn't have) read
    // APP_CONFIG_BASE_URL + APP_CONFIG_ADMIN_API_SECRET from the leased
    // preview Doppler config. Root Playwright specs run after those Vitest
    // lanes, using the same preview Doppler config.
    previewTestCommandArgs: [
      "bash",
      "-c",
      [
        "set -euo pipefail",
        "pnpm --dir ../.. exec playwright install chromium",
        "pnpm e2e",
        "OS_ITX_E2E_FILE_PARALLELISM=true OS_ITX_E2E_SKIP_MATRIX=true pnpm e2e:itx --project node",
        "pnpm e2e:itx --project node src/itx/e2e/itx.e2e.test.ts -t 'catalogue example'",
        "pnpm --dir ../.. spec",
      ].join("; "),
    ],
  },
  semaphore: {
    slug: "semaphore",
    displayName: "Semaphore",
    appPath: "apps/semaphore",
    dopplerProject: "semaphore",
    paths: ["apps/semaphore/**"],
    previewTestBaseUrlEnvVar: "SEMAPHORE_BASE_URL",
    previewTestCommandArgs: ["pnpm", "test:e2e:preview"],
  },
  // Every preview slot runs its own auth deployment (auth.iterate-preview-N.com)
  // so e2e starts from a completely clean, controlled slate. OAuth client
  // credentials are constants in Doppler (`preview provision-auth-preview-configs`);
  // the auth deploy reseeds them into its database on every run, so auth and
  // OS tests can run after both apps have finished deploying.
  auth: {
    slug: "auth",
    displayName: "Auth",
    appPath: "apps/auth",
    dopplerProject: "auth",
    paths: ["apps/auth/**", "apps/auth-contract/**"],
    // better-auth's liveness endpoint; auth has no /api/__internal/health.
    previewReadyUrlPath: "/api/auth/ok",
    previewTestBaseUrlEnvVar: "AUTH_BASE_URL",
    previewTestCommandArgs: [
      "bash",
      "-c",
      'curl -fsS "$AUTH_BASE_URL/api/auth/.well-known/openid-configuration" | grep -q \'"authorization_endpoint"\'',
    ],
  },
  "streams-example-app": {
    slug: "streams-example-app",
    displayName: "Streams Example App",
    appPath: "apps/streams-example-app",
    dopplerProject: "streams-example-app",
    paths: ["apps/streams-example-app/**", "apps/os/src/domains/streams/**"],
    previewTestBaseUrlEnvVar: "WORKER_URL",
    previewTestCommandArgs: [
      "bash",
      "-c",
      [
        "pnpm exec playwright install chromium & install_pid=$!",
        "STREAM_STAGING_E2E=true pnpm vitest -t @preview & vitest_pid=$!",
        "install_status=0",
        "vitest_status=0",
        'wait "$install_pid" || install_status=$?',
        'wait "$vitest_pid" || vitest_status=$?',
        'if [ "$install_status" -ne 0 ] || [ "$vitest_status" -ne 0 ]; then exit 1; fi',
        "pnpm playwright --grep @preview --reporter=list",
      ].join("; "),
    ],
  },
};

const cloudflarePreviewSectionLabel = "CLOUDFLARE_PREVIEW";
const cloudflarePreviewStateLabel = "CLOUDFLARE_PREVIEW_STATE";
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
const ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE = "environment-config-lease";
const previewEnvironmentSlotNumbers = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
const sharedAuthPreviewSecretsCopiedFromDev = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "RESEND_BOT_DOMAIN",
  "RESEND_BOT_API_KEY",
  "SIGNUP_ALLOWLIST",
] as const;

export const EnvironmentConfigLease = z.object({
  dopplerConfig: z.string().trim().min(1),
  leasedUntil: z.number().int().positive(),
  leaseId: z.string().uuid(),
  slug: z.string().trim().min(1),
  type: z.string().trim().min(1),
});

const CloudflarePreviewStatus = z.enum([
  "awaiting-tests",
  "claim-failed",
  "cleanup-failed",
  "deploy-failed",
  "deployed",
  "fork-unavailable",
  "released",
  "tests-failed",
]);

export const CloudflarePreviewAppEntry = z.object({
  appDisplayName: z.string().trim().min(1),
  appSlug: z.string().trim().min(1),
  status: CloudflarePreviewStatus,
  updatedAt: z.string().trim().min(1),
  headSha: z.string().trim().min(1).nullable().optional(),
  message: z.string().trim().min(1).nullable().optional(),
  publicUrl: z.string().trim().url().nullable().optional(),
  runUrl: z.string().trim().url().nullable().optional(),
  shortSha: z.string().trim().min(1).nullable().optional(),
  cleanupDurationMs: z.number().nonnegative().finite().nullable().optional(),
  deployDurationMs: z.number().nonnegative().finite().nullable().optional(),
  testDurationMs: z.number().nonnegative().finite().nullable().optional(),
});
export type CloudflarePreviewAppEntry = z.infer<typeof CloudflarePreviewAppEntry>;

const CloudflarePreviewState = z.object({
  apps: z.record(z.string().trim().min(1), CloudflarePreviewAppEntry).default({}),
  environmentConfigLease: EnvironmentConfigLease.nullable().default(null),
});

const CloudflareZonesResponse = z
  .object({
    success: z.boolean(),
    errors: z
      .array(
        z
          .object({
            message: z.string().optional(),
          })
          .passthrough(),
      )
      .default([]),
    result: z
      .array(
        z
          .object({
            name: z.string(),
            account: z
              .object({
                id: z.string(),
              })
              .passthrough()
              .optional(),
            status: z.string().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

export type EnvironmentConfigLease = z.infer<typeof EnvironmentConfigLease>;
type CloudflarePreviewState = z.infer<typeof CloudflarePreviewState>;

type EnvironmentConfigLeaseResourceData = {
  dopplerConfig: string;
};

type EnvironmentConfigLeaseInventoryItem = {
  type: typeof ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE;
  slug: string;
  data: EnvironmentConfigLeaseResourceData;
};

export const environmentConfigLeaseInventory = previewEnvironmentSlotNumbers.map((leaseNumber) => {
  return {
    type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
    slug: `preview-${leaseNumber}`,
    data: {
      dopplerConfig: `preview_${leaseNumber}`,
    },
  };
}) satisfies EnvironmentConfigLeaseInventoryItem[];

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

export type PreviewAppRuntime = (typeof cloudflarePreviewApps)[CloudflarePreviewAppSlugType];

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

type CheckResult = {
  ok: boolean;
  message?: string;
};

type CloudflareCredentialsResult =
  | {
      ok: true;
      accountId: string;
      apiToken: string;
      project: string;
    }
  | {
      ok: false;
      message: string;
      project: string;
    };

type EnvironmentConfigLeaseReconcileIssue = {
  check: "resource-data" | "doppler-config" | "cloudflare-credentials" | "cloudflare-zone";
  message: string;
  resourceSlug: string;
};

const previewManagedDopplerProjects = [
  ...new Set(Object.values(cloudflarePreviewApps).map((app) => app.dopplerProject)),
].sort();

const previewCloudflareCredentialsProject = cloudflarePreviewApps.os.dopplerProject;

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

type PreviewInventoryClient = {
  add: (input: EnvironmentConfigLeaseInventoryItem) => Promise<unknown>;
  delete: (input: { slug: string; type: string }) => Promise<unknown>;
  list: (input: {
    type: string;
  }) => Promise<Array<{ slug: string; data: Record<string, unknown> }>>;
};

async function syncPreviewInventory(input: {
  client: PreviewInventoryClient;
  inventory?: readonly EnvironmentConfigLeaseInventoryItem[];
}) {
  const inventory = input.inventory || environmentConfigLeaseInventory;
  const expectedBySlug = new Map(inventory.map((resource) => [resource.slug, resource]));
  const existingResources = await input.client.list({
    type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
  });

  for (const existing of existingResources) {
    const expected = expectedBySlug.get(existing.slug);
    if (expected && isSameResourceData(existing.data, expected.data)) {
      continue;
    }

    await input.client.delete({
      type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
      slug: existing.slug,
    });
  }

  const currentResources = await input.client.list({
    type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
  });
  const currentSlugs = new Set(currentResources.map((resource) => resource.slug));

  for (const resource of inventory) {
    if (currentSlugs.has(resource.slug)) {
      continue;
    }

    await input.client.add(resource);
  }

  return {
    type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
    total: inventory.length,
  };
}

function parseEnvironmentConfigLeaseData(
  data: Record<string, unknown>,
): EnvironmentConfigLeaseResourceData {
  if (typeof data.dopplerConfig !== "string" || data.dopplerConfig.trim().length === 0) {
    throw new Error("Environment config lease data must include dopplerConfig.");
  }

  return {
    dopplerConfig: data.dopplerConfig.trim(),
  };
}

function isSameResourceData(
  left: Record<string, unknown>,
  right: EnvironmentConfigLeaseResourceData,
) {
  try {
    const parsed = parseEnvironmentConfigLeaseData(left);
    return parsed.dopplerConfig === right.dopplerConfig && Object.keys(left).length === 1;
  } catch {
    return false;
  }
}

async function readCloudflarePreviewState(params: {
  githubToken: string;
  repositoryFullName: string;
  pullRequestNumber: number;
}) {
  const body = await readPullRequestBody(params);

  return {
    body,
    state: parseCloudflarePreviewState(body),
  };
}

async function updateCloudflarePreviewState(params: {
  githubToken: string;
  repositoryFullName: string;
  pullRequestNumber: number;
  update: (state: CloudflarePreviewState) => CloudflarePreviewState;
}) {
  const current = await readCloudflarePreviewState(params);
  const nextState = CloudflarePreviewState.parse(params.update(current.state));

  await writePullRequestBody({
    ...params,
    body: renderCloudflarePreviewPullRequestBody(current.body, nextState),
  });

  return { state: nextState };
}

function parseCloudflarePreviewState(body: string): CloudflarePreviewState {
  const current = markdownAnnotator(body, cloudflarePreviewStateLabel).current;
  if (!current) {
    return CloudflarePreviewState.parse({});
  }

  try {
    const parsed = JSON.parse(unwrapHiddenStateBlock(current));
    return CloudflarePreviewState.parse(parsed);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return CloudflarePreviewState.parse({});
    }

    throw error;
  }
}

function renderCloudflarePreviewPullRequestBody(body: string, state: CloudflarePreviewState) {
  return markdownAnnotator(body, cloudflarePreviewSectionLabel).update(
    renderCloudflarePreviewSection(CloudflarePreviewState.parse(state)),
  );
}

function renderCloudflarePreviewSection(state: CloudflarePreviewState) {
  const entries = Object.values(state.apps).sort((left, right) =>
    left.appDisplayName.localeCompare(right.appDisplayName),
  );
  const table = entries.length > 0 ? renderPreviewAppTable(entries) : null;
  const failureDetails = entries.map(renderPreviewAppFailureDetails).filter(Boolean).join("\n\n");

  return [
    "## Environment Config Lease",
    markdownAnnotator("", cloudflarePreviewStateLabel).update(wrapHiddenStateBlock(state)),
    renderPreviewAppTableDetails({
      summary: state.environmentConfigLease
        ? renderEnvironmentConfigLeaseSummary(state.environmentConfigLease)
        : "No active environment config lease.",
      table,
    }),
    failureDetails || null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function renderEnvironmentConfigLeaseSummary(lease: EnvironmentConfigLease) {
  return [
    `Lease: ${lease.slug}`,
    `Doppler config: ${lease.dopplerConfig}`,
    `Type: ${lease.type}`,
    `Leased until: ${new Date(lease.leasedUntil).toISOString()}`,
  ].join(" | ");
}

function renderPreviewAppTableDetails(input: { summary: string; table: string | null }) {
  return [
    "<details>",
    `<summary>${escapeHtml(input.summary)}</summary>`,
    "",
    input.table || "No preview apps recorded.",
    "",
    "</details>",
  ].join("\n");
}

function renderPreviewAppTable(entries: z.infer<typeof CloudflarePreviewAppEntry>[]) {
  const headers = [
    "app",
    "status",
    "commit",
    "preview",
    "deploy duration",
    "test duration",
    "cleanup duration",
    "workflow run",
    "updated",
    "summary",
  ];

  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...entries.map(renderPreviewAppTableRow),
  ].join("\n");
}

function renderPreviewAppTableRow(entry: z.infer<typeof CloudflarePreviewAppEntry>) {
  const summary = summarizePreviewMessage(entry.message);
  const cells = [
    entry.appDisplayName,
    renderStatusLabel(entry.status),
    entry.shortSha ? `\`${entry.shortSha}\`` : "",
    entry.publicUrl ? `[${entry.publicUrl}](${entry.publicUrl})` : "",
    entry.deployDurationMs != null ? formatDurationMs(entry.deployDurationMs) : "",
    entry.testDurationMs != null ? formatDurationMs(entry.testDurationMs) : "",
    entry.cleanupDurationMs != null ? formatDurationMs(entry.cleanupDurationMs) : "",
    entry.runUrl ? `[Workflow run](${entry.runUrl})` : "",
    entry.updatedAt,
    summary || "",
  ];

  return `| ${cells.map((value) => value.replaceAll("\n", "<br>").replaceAll("|", "\\|")).join(" | ")} |`;
}

function renderPreviewAppFailureDetails(entry: z.infer<typeof CloudflarePreviewAppEntry>) {
  const details = readPreviewMessage(entry.message);
  const showFailureDetails = entry.status !== "deployed" && entry.status !== "released" && details;

  if (!showFailureDetails) {
    return null;
  }

  return [
    "<details>",
    `<summary>${escapeHtml(entry.appDisplayName)} failure details</summary>`,
    "",
    `<pre>${escapeHtml(details)}</pre>`,
    "",
    "</details>",
  ].join("\n");
}

function formatDurationMs(durationMs: number) {
  if (durationMs < 1_000) {
    return `${Math.round(durationMs)}ms`;
  }

  return `${(durationMs / 1_000).toFixed(1)}s`;
}

function readPreviewMessage(message: string | null | undefined) {
  return message?.trim() || null;
}

function summarizePreviewMessage(message: string | null | undefined) {
  const details = readPreviewMessage(message);
  if (!details) {
    return null;
  }

  const lines = details
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return null;
  }

  const interestingLine =
    lines.find((line) =>
      /(assertionerror|error:|failed|timed out|cannot |malformed|unavailable|released|already gone)/i.test(
        line,
      ),
    ) || lines[0];

  return interestingLine.length <= 180 ? interestingLine : `${interestingLine.slice(0, 179)}...`;
}

function renderStatusLabel(status: z.infer<typeof CloudflarePreviewAppEntry>["status"]) {
  switch (status) {
    case "awaiting-tests":
      return "awaiting tests";
    case "deployed":
      return "deployed";
    case "tests-failed":
      return "tests failed";
    case "deploy-failed":
      return "deploy failed";
    case "claim-failed":
      return "claim failed";
    case "released":
      return "released";
    case "cleanup-failed":
      return "cleanup failed";
    case "fork-unavailable":
      return "unavailable for forks";
  }
}

/** Escape command output before embedding it in the preview status markdown block. */
function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Pair with unwrapHiddenStateBlock: serialize preview state into a hidden markdown comment. */
function wrapHiddenStateBlock(state: CloudflarePreviewState) {
  return ["<!--", JSON.stringify(state, null, 2), "-->"].join("\n");
}

function unwrapHiddenStateBlock(contents: string) {
  const lines = contents.trim().split("\n");
  if (lines[0] === "<!--" && lines.at(-1) === "-->") {
    return lines.slice(1, -1).join("\n");
  }

  return contents;
}

async function readPullRequestBody(params: {
  githubToken: string;
  repositoryFullName: string;
  pullRequestNumber: number;
}) {
  const octokit = new Octokit({
    auth: params.githubToken,
  });
  const [owner, repo] = splitRepositoryFullName(params.repositoryFullName);
  const pullRequest = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: params.pullRequestNumber,
  });

  return pullRequest.data.body || "";
}

async function writePullRequestBody(params: {
  body: string;
  githubToken: string;
  repositoryFullName: string;
  pullRequestNumber: number;
}) {
  const octokit = new Octokit({
    auth: params.githubToken,
  });
  const [owner, repo] = splitRepositoryFullName(params.repositoryFullName);
  await octokit.rest.pulls.update({
    body: params.body,
    owner,
    repo,
    pull_number: params.pullRequestNumber,
  });
}

type EnvironmentConfigLeaseReconcileResult = {
  checkedAt: string;
  ok: boolean;
  semaphoreBaseUrl: string;
  type: typeof ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE;
  resources: Array<{
    dopplerConfig: string | null;
    domains: string[];
    issues: EnvironmentConfigLeaseReconcileIssue[];
    leaseState: "available" | "leased";
    leasedUntil: string | null;
    slug: string;
  }>;
  summary: {
    resourceCount: number;
    issueCount: number;
  };
};

type EnvironmentConfigLeaseResourceRecord = {
  slug: string;
  data: Record<string, unknown>;
  leaseState: "available" | "leased";
  leasedUntil: number | null;
};

async function reconcileEnvironmentConfigLeaseResources(input: {
  checkCloudflareZone?: (input: {
    accountId: string;
    apiToken: string;
    domain: string;
    signal?: AbortSignal;
  }) => Promise<CheckResult>;
  checkDopplerConfig?: (input: {
    commandEnvironment: NodeJS.ProcessEnv;
    config: string;
    project: string;
    repositoryRoot: string;
    signal?: AbortSignal;
  }) => Promise<CheckResult>;
  client: {
    list: (input: { type: string }) => Promise<EnvironmentConfigLeaseResourceRecord[]>;
  };
  commandEnvironment: NodeJS.ProcessEnv;
  readCloudflareCredentials?: (input: {
    commandEnvironment: NodeJS.ProcessEnv;
    config: string;
    project: string;
    repositoryRoot: string;
    signal?: AbortSignal;
  }) => Promise<CloudflareCredentialsResult>;
  repositoryRoot: string;
  semaphoreBaseUrl: string;
  signal?: AbortSignal;
}): Promise<EnvironmentConfigLeaseReconcileResult> {
  const checkDopplerConfig = input.checkDopplerConfig || checkDopplerConfigWithCli;
  const readCloudflareCredentials =
    input.readCloudflareCredentials || readCloudflareCredentialsWithCli;
  const checkCloudflareZone = input.checkCloudflareZone || checkCloudflareZoneWithApi;
  const resources = (
    await input.client.list({
      type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
    })
  ).sort((left, right) => left.slug.localeCompare(right.slug));

  const reconciledResources = [];
  for (const resource of resources) {
    const issues: EnvironmentConfigLeaseReconcileIssue[] = [];
    let dopplerConfig: string | null = null;
    let domains: string[] = [];

    try {
      const data = parseEnvironmentConfigLeaseData(resource.data);
      dopplerConfig = data.dopplerConfig;
      if (Object.keys(resource.data).length !== 1) {
        issues.push({
          check: "resource-data",
          resourceSlug: resource.slug,
          message: "Resource data must contain only dopplerConfig.",
        });
      }
    } catch (error) {
      issues.push({
        check: "resource-data",
        resourceSlug: resource.slug,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    if (dopplerConfig !== null) {
      for (const project of previewManagedDopplerProjects) {
        const configCheck = await checkDopplerConfig({
          commandEnvironment: input.commandEnvironment,
          config: dopplerConfig,
          project,
          repositoryRoot: input.repositoryRoot,
          signal: input.signal,
        });
        if (!configCheck.ok) {
          issues.push({
            check: "doppler-config",
            resourceSlug: resource.slug,
            message: `${project}/${dopplerConfig}: ${configCheck.message || "config check failed"}`,
          });
        }
      }

      const previewNumber = parsePreviewConfigNumber(dopplerConfig);
      if (previewNumber === null) {
        issues.push({
          check: "resource-data",
          resourceSlug: resource.slug,
          message: `Doppler config must match preview_N, got ${dopplerConfig}.`,
        });
      } else {
        domains = [`iterate-preview-${previewNumber}.com`, `iterate-preview-${previewNumber}.app`];
        const credentials = await readCloudflareCredentials({
          commandEnvironment: input.commandEnvironment,
          config: dopplerConfig,
          project: previewCloudflareCredentialsProject,
          repositoryRoot: input.repositoryRoot,
          signal: input.signal,
        });
        if (!credentials.ok) {
          issues.push({
            check: "cloudflare-credentials",
            resourceSlug: resource.slug,
            message: `${credentials.project}/${dopplerConfig}: ${credentials.message}`,
          });
        } else {
          for (const domain of domains) {
            const zoneCheck = await checkCloudflareZone({
              accountId: credentials.accountId,
              apiToken: credentials.apiToken,
              domain,
              signal: input.signal,
            });
            if (!zoneCheck.ok) {
              issues.push({
                check: "cloudflare-zone",
                resourceSlug: resource.slug,
                message: `${domain}: ${zoneCheck.message || "zone check failed"}`,
              });
            }
          }
        }
      }
    }

    reconciledResources.push({
      dopplerConfig,
      domains,
      issues,
      leaseState: resource.leaseState,
      leasedUntil:
        resource.leasedUntil === null ? null : new Date(resource.leasedUntil).toISOString(),
      slug: resource.slug,
    });
  }

  const issueCount = reconciledResources.reduce(
    (total, resource) => total + resource.issues.length,
    0,
  );

  return {
    checkedAt: new Date().toISOString(),
    ok: issueCount === 0,
    semaphoreBaseUrl: input.semaphoreBaseUrl,
    type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
    resources: reconciledResources,
    summary: {
      resourceCount: resources.length,
      issueCount,
    },
  };
}

function parsePreviewConfigNumber(config: string) {
  const match = /^preview_(\d+)$/.exec(config);
  if (!match || match[1] == null) return null;
  return Number.parseInt(match[1], 10);
}

async function checkDopplerConfigWithCli(input: {
  commandEnvironment: NodeJS.ProcessEnv;
  config: string;
  project: string;
  repositoryRoot: string;
  signal?: AbortSignal;
}): Promise<CheckResult> {
  try {
    const result = await runCommand({
      command: "doppler",
      args: ["configs", "get", input.config, "--project", input.project, "--json"],
      echoOutput: false,
      environment: input.commandEnvironment,
      signal: input.signal,
      workingDirectory: input.repositoryRoot,
    });
    return result.exitCode === 0
      ? { ok: true }
      : { ok: false, message: commandFailureSummary(result) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

async function readCloudflareCredentialsWithCli(input: {
  commandEnvironment: NodeJS.ProcessEnv;
  config: string;
  project: string;
  repositoryRoot: string;
  signal?: AbortSignal;
}): Promise<CloudflareCredentialsResult> {
  try {
    const result = await runCommand({
      command: "doppler",
      args: [
        "secrets",
        "download",
        "--no-file",
        "--format",
        "json",
        "--project",
        input.project,
        "--config",
        input.config,
      ],
      echoOutput: false,
      environment: input.commandEnvironment,
      signal: input.signal,
      workingDirectory: input.repositoryRoot,
    });
    if (result.exitCode !== 0) {
      return {
        ok: false,
        project: input.project,
        message: commandFailureSummary(result),
      };
    }

    const secrets = z
      .object({
        CLOUDFLARE_ACCOUNT_ID: z.string().trim().min(1),
        CLOUDFLARE_API_TOKEN: z.string().trim().min(1),
      })
      .passthrough()
      .parse(JSON.parse(result.stdout));

    return {
      ok: true,
      project: input.project,
      accountId: secrets.CLOUDFLARE_ACCOUNT_ID,
      apiToken: secrets.CLOUDFLARE_API_TOKEN,
    };
  } catch (error) {
    return {
      ok: false,
      project: input.project,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkCloudflareZoneWithApi(input: {
  accountId: string;
  apiToken: string;
  domain: string;
  signal?: AbortSignal;
}): Promise<CheckResult> {
  const url = new URL("https://api.cloudflare.com/client/v4/zones");
  url.searchParams.set("name", input.domain);
  url.searchParams.set("per_page", "50");
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${input.apiToken}`,
    },
    signal: input.signal,
  });
  const parsed = CloudflareZonesResponse.parse(await response.json());
  if (!response.ok || !parsed.success) {
    return {
      ok: false,
      message:
        parsed.errors
          .map((error) => error.message)
          .filter(Boolean)
          .join("; ") || `${response.status} ${response.statusText}`,
    };
  }

  return evaluateCloudflareZoneCheck({
    accountId: input.accountId,
    domain: input.domain,
    zones: parsed.result,
  });
}

function evaluateCloudflareZoneCheck(input: {
  accountId: string;
  domain: string;
  zones: Array<{
    account?: { id?: string };
    name: string;
    status?: string;
  }>;
}): CheckResult {
  const matchingZones = input.zones.filter((zone) => zone.name === input.domain);
  const matchingActiveZone = matchingZones.find((zone) => zone.status === "active");
  const matchingAccountZone = matchingZones.find((zone) => zone.account?.id === input.accountId);
  if (matchingActiveZone?.account?.id === input.accountId) {
    return { ok: true };
  }

  if (matchingActiveZone) {
    return {
      ok: false,
      message: `active zone belongs to Cloudflare account ${matchingActiveZone.account?.id || "unknown"}, expected ${input.accountId}`,
    };
  }

  if (matchingAccountZone) {
    return {
      ok: false,
      message: `zone in Cloudflare account ${input.accountId} is ${matchingAccountZone.status || "not active"}`,
    };
  }

  if (matchingZones.length === 0) {
    return {
      ok: false,
      message: `zone not found in Cloudflare account ${input.accountId}`,
    };
  }

  return {
    ok: false,
    message: `zone exists but not in Cloudflare account ${input.accountId}`,
  };
}

function commandFailureSummary(result: { stderr: string; stdout: string }) {
  const output = `${result.stderr}\n${result.stdout}`
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join("\n");
  return output || "command failed";
}

async function ensureAuthPreviewConfigs(input: { rotate: boolean }) {
  const rootValues: Record<string, string> = {
    VITE_ENABLE_EMAIL_OTP_SIGNIN: "true",
  };
  for (const name of sharedAuthPreviewSecretsCopiedFromDev) {
    if (getDopplerSecret("auth", "preview", name)) continue;
    const value = getDopplerSecret("auth", "dev", name);
    if (!value) throw new Error(`auth/dev is missing ${name}`);
    rootValues[name] = value;
  }
  setDopplerSecrets("auth", "preview", rootValues);
  console.log("auth/preview root config ensured");

  const workersSubdomain = await getWorkersDevSubdomain("streams-example-app", "preview");
  for (const slot of previewEnvironmentSlotNumbers) {
    const config = `preview_${slot}`;
    const authOrigin = `https://auth.iterate-preview-${slot}.com`;
    const osOrigin = `https://os.iterate-preview-${slot}.com`;
    const streamsExampleOrigin = `https://streams-example-app-preview-${slot}.${workersSubdomain}.workers.dev`;
    const clientId = `os-preview-${slot}`;

    ensureDopplerConfig("auth", config);
    ensureDopplerConfig("streams-example-app", config);

    const existingSeed = input.rotate
      ? null
      : getDopplerSecret("auth", config, "AUTH_SEED_OAUTH_CLIENTS");
    const existingSecret = existingSeed
      ? (JSON.parse(existingSeed) as { clientSecret: string }[])[0]?.clientSecret
      : null;
    const clientSecret = existingSecret || freshSecret();

    const existingServiceToken = input.rotate
      ? null
      : getDopplerSecret("auth", config, "SERVICE_AUTH_TOKEN");
    const serviceToken = existingServiceToken || freshSecret();
    const existingBetterAuthSecret = input.rotate
      ? null
      : getDopplerSecret("auth", config, "BETTER_AUTH_SECRET");
    const betterAuthSecret = existingBetterAuthSecret || freshSecret();

    const seed = JSON.stringify([
      {
        clientId,
        clientSecret,
        clientName: `OS preview ${slot} web`,
        redirectURIs: [`${osOrigin}/api/iterate-auth/callback`],
        referenceId: `os:${config}:web`,
        skipConsent: true,
      },
    ]);

    setDopplerSecrets("auth", config, {
      VITE_AUTH_APP_ORIGIN: authOrigin,
      // readPreviewAppConfig reads APP_CONFIG_BASE_URL to learn the app's public URL.
      APP_CONFIG_BASE_URL: authOrigin,
      WORKER_ROUTES: `auth.iterate-preview-${slot}.com`,
      BETTER_AUTH_SECRET: betterAuthSecret,
      SERVICE_AUTH_TOKEN: serviceToken,
      AUTH_SEED_OAUTH_CLIENTS: seed,
    });

    setDopplerSecrets("os", config, {
      APP_CONFIG_ITERATE_AUTH__ISSUER: `${authOrigin}/api/auth`,
      APP_CONFIG_ITERATE_AUTH__CLIENT_ID: clientId,
      APP_CONFIG_ITERATE_AUTH__CLIENT_SECRET: clientSecret,
      APP_CONFIG_ITERATE_AUTH__SERVICE_TOKEN: serviceToken,
    });

    setDopplerSecrets("streams-example-app", config, {
      APP_CONFIG_BASE_URL: streamsExampleOrigin,
    });

    console.log(
      `slot ${slot}: auth/${config} + os/${config} + streams-example-app/${config} ensured (client ${clientId})`,
    );
  }

  console.log("done");
}

function runDoppler(args: string[], input?: string) {
  return execFileSync("doppler", args, {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function getDopplerSecret(project: string, config: string, name: string): string | null {
  try {
    return runDoppler([
      "secrets",
      "get",
      name,
      "--project",
      project,
      "--config",
      config,
      "--plain",
    ]);
  } catch {
    return null;
  }
}

function setDopplerSecrets(project: string, config: string, secrets: Record<string, string>) {
  const args = ["secrets", "set", "--project", project, "--config", config, "--silent"];
  for (const [key, value] of Object.entries(secrets)) {
    args.push(`${key}=${value}`);
  }
  runDoppler(args);
}

function ensureDopplerConfig(project: string, config: string) {
  const existing = runDoppler(["configs", "--project", project, "--json"]);
  const names = (JSON.parse(existing) as { name: string }[]).map((dopplerConfig) => {
    return dopplerConfig.name;
  });
  if (!names.includes(config)) {
    runDoppler(["configs", "create", config, "--project", project]);
    console.log(`created config ${project}/${config}`);
  }
}

function freshSecret() {
  return randomBytes(32).toString("hex");
}

async function getWorkersDevSubdomain(project: string, config: string) {
  const accountId = getDopplerSecret(project, config, "CLOUDFLARE_ACCOUNT_ID");
  const apiToken = getDopplerSecret(project, config, "CLOUDFLARE_API_TOKEN");
  if (!accountId || !apiToken) {
    throw new Error(`${project}/${config} is missing Cloudflare credentials`);
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
    { headers: { authorization: `Bearer ${apiToken}` } },
  );
  const parsed = (await response.json()) as {
    errors?: Array<{ message?: string }>;
    result?: { subdomain?: unknown };
    success?: boolean;
  };
  if (!response.ok || parsed.success !== true) {
    const message =
      parsed.errors
        ?.map((error) => error.message)
        .filter(Boolean)
        .join("; ") || `${response.status} ${response.statusText}`;
    throw new Error(`Failed to read Workers subdomain for ${project}/${config}: ${message}`);
  }

  if (typeof parsed.result?.subdomain !== "string" || parsed.result.subdomain.trim() === "") {
    throw new Error(`Cloudflare returned no Workers subdomain for ${project}/${config}`);
  }

  return parsed.result.subdomain.trim();
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

function splitRepositoryFullName(repositoryFullName: string) {
  const parts = repositoryFullName.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Expected repository full name to look like owner/repo. Got: ${repositoryFullName}`,
    );
  }

  return parts as [string, string];
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

    const update = await updatePreviewState(params.context, (state) => ({
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
  const update = await updatePreviewState(params.context, (state) => ({
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
  const previousLease = input.previousEnvironmentConfigLease;

  const lease =
    (previousLease
      ? await ignoreEnvironmentConfigLeaseReuseError(() =>
          semaphore.renew({
            type: previousLease.type,
            slug: previousLease.slug,
            leaseId: previousLease.leaseId,
            leaseMs: input.leaseMs,
          }),
        )
      : null) ??
    (previousLease
      ? await ignoreEnvironmentConfigLeaseReuseError(() =>
          semaphore.acquireSpecific({
            type: previousLease.type,
            slug: previousLease.slug,
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
  ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
  evaluateCloudflareZoneCheck,
  expandPreviewDependencies,
  orderPreviewDeployBatches,
  parseCloudflarePreviewState,
  parseEnvironmentConfigLeaseData,
  reconcileEnvironmentConfigLeaseResources,
  renderCloudflarePreviewPullRequestBody,
  resolvePreviewCompareBaseSha,
  resolvePreviewReadinessUrls,
  selectPreviewAppsNeedingRetry,
  splitRepositoryFullName,
  syncPreviewInventory,
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
  context: PullRequestPreviewContext,
  update: (state: CloudflarePreviewState) => CloudflarePreviewState,
) {
  return await updateCloudflarePreviewState({
    ...context,
    update,
  });
}

function canRunPreviewTests(entry: z.infer<typeof CloudflarePreviewAppEntry> | undefined) {
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
