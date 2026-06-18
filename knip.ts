import type { KnipConfig } from "knip";

type WorkspaceConfig = NonNullable<KnipConfig["workspaces"]>[string];

function makeOsCloudflareAppWorkspace(workerEnvShim: string): WorkspaceConfig {
  const base = makeCloudflareTanStackAppWorkspace(workerEnvShim);
  return {
    ...base,
    ignore: [
      // Handwritten design-of-record types for the itx protocol; intentionally unreferenced.
      "src/itx/types.ts",
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
      "e2e/vitest.config.ts",
      "e2e/tui-test/tui-test.config.ts",
      "e2e/tui-test/run.ts",
      // Mounted into the CLI by packages/iterate/src/os/router.ts, which knip
      // doesn't traverse (the iterate package isn't a knip workspace).
      "scripts/dev.ts",
      "scripts/itx-agent-smoke.ts",
      "scripts/itx-run.ts",
      "scripts/seed-iterate-config-base-repo.ts",
      "scripts/setup-artifact-event-subscriptions.ts",
      "sqlfu.config.ts",
      "src/durable-objects/codemode-session.vitest.config.ts",
      "src/durable-objects/codemode-session-test-entry.ts",
      "src/durable-objects/iterate-mcp-server.vitest.config.ts",
      "src/durable-objects/iterate-mcp-server-test-entry.ts",
      "src/durable-objects/project-ingress.vitest.config.ts",
      "src/durable-objects/project-ingress-test-entry.ts",
      "src/durable-objects/itx-stream-subscribe.vitest.config.ts",
      "src/durable-objects/itx-stream-subscribe-test-entry.ts",
      "src/domains/streams/engine/vitest.workers.config.ts",
      "src/domains/streams/engine/vitest.config.ts",
      "src/domains/streams/engine/workers/test-entry.ts",
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
    entry: [...(base.entry ?? []), "sqlfu.config.ts"],
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
    entry: [
      "bin/iterate-app-cli.js",
      "src/apps/cli-entry.ts",
      "src/durable-object-utils/e2e/alchemy.run.ts",
      "src/**/*.test.ts",
    ],
    project: ["src/**/*.ts"],
    ignoreDependencies: ["alchemy", "cloudflare", "wrangler"],
  };
}

const config: KnipConfig = {
  // Keep the config honest in CI/local runs: if Knip thinks our patterns or
  // workspace setup drifted, fail instead of silently warning.
  treatConfigHintsAsErrors: true,
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
    "apps/os/src/db/migrations/.generated/migrations.ts": ["files", "exports", "types"],
    "apps/os/src/db/queries/.generated/index.ts": ["files", "exports", "types"],
    "apps/os/src/db/queries/.generated/tables.ts": ["files", "types"],
    "apps/os/e2e/test-support/app-config-env.ts": ["files", "exports"],
    "apps/os/src/**": ["exports", "types"],
    "apps/os/e2e/test-support/**": ["exports", "types"],
    "apps/streams-example-app/src/lib/use-initial-tail-scroll.ts": ["types"],
    // TanStack Start resolves the router factory by convention from the
    // entrypoint, so there is no direct import Knip can follow.
    "apps/semaphore/src/router.tsx": ["exports"],
    "packages/shared/src/callable/entry.workerd.vitest.ts": ["exports"],
    "packages/shared/src/durable-object-utils/test-harness/initialize-fronting-worker.ts": [
      "exports",
      "types",
    ],
    "packages/shared/src/durable-object-utils/mixins/fetch-mixin-utils.ts": ["types"],
  },
  workspaces: {
    "apps/semaphore": makeSemaphoreCloudflareAppWorkspace("./src/lib/worker-env.d.ts"),
    "apps/os": makeOsCloudflareAppWorkspace("./src/lib/worker-env.d.ts"),
    "apps/streams-example-app": makeStreamsExampleAppWorkspace(),
    "packages/shared": makeSharedWorkspace(),
  },
};

export default config;
