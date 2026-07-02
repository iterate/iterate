import type { KnipConfig } from "knip";

type WorkspaceConfig = NonNullable<KnipConfig["workspaces"]>[string];

function makeOsCloudflareAppWorkspace(workerEnvShim: string): WorkspaceConfig {
  const base = makeCloudflareTanStackAppWorkspace(workerEnvShim);
  return {
    ...base,
    ignore: [
      // Reached only through the vitest.config.ts `cloudflare:workers` alias,
      // which knip does not traverse.
      "src/test/cloudflare-workers-shim.ts",
      // Preserved oRPC e2e reference (imports the removed oRPC stack;
      // intentionally not `.test.ts`, never imported by active code). See
      // e2e/AGENTS.md.
      "e2e/**/*.orpc-legacy.ts",
    ],
    entry: [
      ...(base.entry ?? []).filter(
        (entry) => entry !== "scripts/router.ts" && entry !== "src/worker.ts!",
      ),
      // One entry module per deployed worker (docs/worker-topology.md).
      "src/workers/*.ts!",
      "src/workers/*.ts!",
      "e2e/vitest.config.ts",
      "e2e/tui-test/tui-test.config.ts",
      "e2e/tui-test/run.ts",
      "e2e/tui-test/data-layer-smoke.ts",
      // Local operational commands mounted by scripts/cli.ts.
      "scripts/cli.ts",
      "scripts/dev.ts",
      "scripts/itx.ts",
      // Operational smoke for the create-project -> onboarding-greeting path.
      "e2e/vitest/onboarding-smoke.ts",
      // Used by apps/streams-example-app through its `~` alias into apps/os
      // src; knip does not resolve that cross-workspace alias.
      "src/domains/streams/client-libraries/processors/browser-event-feed/contract.ts",
      "src/domains/streams/client-libraries/processors/browser-event-feed/implementation.ts",
    ],
    ignoreDependencies: [
      ...(base.ignoreDependencies ?? []),
      "@opentui/core",
      "@opentui/react",
      "iterate",
      "miniflare",
    ],
  };
}

function makeSemaphoreCloudflareAppWorkspace(workerEnvShim: string): WorkspaceConfig {
  const base = makeCloudflareTanStackAppWorkspace(workerEnvShim);
  return {
    ...base,
    entry: [
      ...(base.entry ?? []),
      "scripts/cli.ts",
      "scripts/seed-environment-config-leases.ts",
      "sqlfu.config.ts",
    ],
    ignoreDependencies: [...(base.ignoreDependencies ?? []), "miniflare"],
  };
}

function makeStreamsExampleAppWorkspace(): WorkspaceConfig {
  return {
    entry: [
      "alchemy.run.ts",
      "vite.config.ts",
      "playwright.config.ts",
      "vitest.config.ts",
      "src/worker.ts!",
      "e2e/**/*.ts",
    ],
    project: ["src/**/*.{ts,tsx}!", "e2e/**/*.ts", "!dist/**!", "!.alchemy/**!"],
    ignore: [
      // TanStack Start client entry, referenced by framework convention.
      "src/client.ts",
      // Kept as the Worker/DO counterpart to the browser and Node stream
      // Cap'n Web helpers in the example app.
      "src/lib/workers-stream-connection.ts",
      // Type-only RequestContext slice reached via an exact-match tsconfig
      // path, which knip does not traverse.
      "src/os-shims/request-context.ts",
    ],
    vite: false,
    paths: {
      "~/*": ["../os/src/*"],
    },
    ignoreDependencies: [
      "cloudflare",
      "tailwindcss",
      // Used by OS stream-engine source imported through the example app's
      // `~` alias; knip attributes that import to the OS workspace instead.
      "@journeyapps/wa-sqlite",
    ],
    ignoreBinaries: ["playwright"],
  };
}

function makeCloudflareTanStackAppWorkspace(workerEnvShim: string): WorkspaceConfig {
  return {
    entry: ["alchemy.run.ts", "vite.config.ts", "scripts/router.ts", "src/worker.ts!"],
    project: [
      "*.test.ts",
      "e2e/**/*.ts",
      "scripts/**/*.ts",
      "src/**/*.{ts,tsx}!",
      "!drizzle/**!",
      "!.output/**!",
      "!dist/**!",
      "!.alchemy/**!",
    ],
    vite: false,
    paths: {
      "cloudflare:workers": [workerEnvShim],
    },
    ignoreBinaries: ["doppler", "read", "sqlite3"],
    ignoreDependencies: ["cloudflare", "tailwindcss"],
  };
}

function makeSharedWorkspace(): WorkspaceConfig {
  return {
    // This package exposes many subpath exports from package.json rather than a
    // single `src/index.ts`, so keep the workspace config minimal and let Knip
    // use the declared export map as the public entry surface.
    entry: ["src/**/*.test.ts"],
    project: ["src/**/*.ts"],
    ignoreDependencies: ["alchemy", "cloudflare", "wrangler"],
  };
}

const config: KnipConfig = {
  // Keep the config honest in CI/local runs: if Knip thinks our patterns or
  // workspace setup drifted, fail instead of silently warning.
  treatConfigHintsAsErrors: true,
  include: [
    "files",
    "dependencies",
    "unlisted",
    "unresolved",
    "exports",
    "nsExports",
    "types",
    "nsTypes",
    "enumMembers",
    "namespaceMembers",
    "duplicates",
  ],
  entry: ["playwright.config.ts", "specs/**/*.spec.ts"],
  project: ["playwright.config.ts", "specs/**/*.ts"],
  // Keep this root command intentionally scoped. When Knip includes dependent
  // workspaces for a selected package, we still do not want it wandering into
  // unrelated apps with heavyweight config loading.
  ignoreWorkspaces: [
    "apps/*",
    "!apps/os",
    "!apps/semaphore",
    "!apps/streams-example-app",
    "packages/*",
    "!packages/shared",
  ],
  ignoreIssues: {
    "apps/os/e2e/test-support/app-config-env.ts": ["files", "exports"],
    "apps/os/src/**": ["exports", "types"],
    "apps/os/e2e/test-support/**": ["exports", "types"],
    // Example-matrix harness modules export helpers consumed across the
    // matrix/browser suites and root Playwright specs; keep the same policy
    // they had under src/**.
    "apps/os/e2e/examples/**": ["exports", "types"],
    "apps/streams-example-app/src/lib/use-initial-tail-scroll.ts": ["types"],
    // TanStack Start resolves the router factory by convention from the
    // entrypoint, so there is no direct import Knip can follow.
    "apps/semaphore/src/router.tsx": ["exports"],
  },
  workspaces: {
    "apps/semaphore": makeSemaphoreCloudflareAppWorkspace("./src/lib/worker-env.d.ts"),
    "apps/os": makeOsCloudflareAppWorkspace("./src/lib/worker-env.d.ts"),
    "apps/streams-example-app": makeStreamsExampleAppWorkspace(),
    "packages/shared": makeSharedWorkspace(),
  },
};

export default config;
