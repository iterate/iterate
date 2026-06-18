import { z } from "zod";

export const CloudflarePreviewAppSlug = z.enum(["os", "semaphore", "auth", "streams-example-app"]);

export type CloudflarePreviewAppSlug = z.infer<typeof CloudflarePreviewAppSlug>;

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
    // The itx e2e (node project only — the browser project needs a Playwright
    // chromium install the preview e2e job doesn't have) reads
    // APP_CONFIG_BASE_URL + APP_CONFIG_ADMIN_API_SECRET from the leased
    // preview Doppler config, same as the preview smoke. Root Playwright specs
    // run after those Vitest lanes, using the same preview Doppler config.
    previewTestCommandArgs: [
      "bash",
      "-c",
      [
        "set -euo pipefail",
        "pnpm --dir ../.. exec playwright install chromium",
        'pnpm e2e -t "OS preview smoke"',
        "OS_ITX_E2E_FILE_PARALLELISM=true OS_ITX_E2E_EGRESS_CONCURRENT=true OS_ITX_E2E_LIVE_CONCURRENT=true OS_ITX_E2E_SKIP_MATRIX=true pnpm e2e:itx --project node",
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
  // credentials are constants in Doppler (provision-auth-preview-configs.ts);
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
