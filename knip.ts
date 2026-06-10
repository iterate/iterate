import type { KnipConfig } from "knip";

type WorkspaceConfig = NonNullable<KnipConfig["workspaces"]>[string];

function makeOsCloudflareAppWorkspace(workerEnvShim: string): WorkspaceConfig {
  const base = makeCloudflareTanStackAppWorkspace(workerEnvShim);
  return {
    ...base,
    entry: [
      ...(base.entry ?? []).filter((entry) => entry !== "scripts/router.ts"),
      "e2e/vitest.config.ts",
      "e2e/tui-test/tui-test.config.ts",
      "e2e/tui-test/run.ts",
      "scripts/sync-clerk-apps.ts",
      "sqlfu.config.ts",
      "src/durable-objects/codemode-session.vitest.config.ts",
      "src/durable-objects/codemode-session-test-entry.ts",
      "src/durable-objects/iterate-mcp-server.vitest.config.ts",
      "src/durable-objects/iterate-mcp-server-test-entry.ts",
      "src/durable-objects/project-ingress.vitest.config.ts",
      "src/durable-objects/project-ingress-test-entry.ts",
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

function makePrivateContractWorkspace(): WorkspaceConfig {
  return {
    // These contract packages are private, tiny, and self-contained, so report
    // unused exports even from the public entry file.
    entry: ["src/index.ts!"],
    project: ["src/**/*.ts!"],
    includeEntryExports: true,
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
      "src/streams/sqlfu.config.ts",
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
  // Keep this root command intentionally scoped. When Knip includes dependent
  // workspaces for a selected package, we still do not want it wandering into
  // unrelated apps with heavyweight config loading.
  ignoreWorkspaces: [
    "apps/*",
    "!apps/os",
    "!apps/os-contract",
    "!apps/semaphore",
    "packages/*",
    "!packages/shared",
  ],
  ignoreIssues: {
    // TanStack Start resolves these router factories by convention from the
    // entrypoint, so there is no direct import Knip can follow.
    "apps/os/src/router.tsx": ["exports"],
    "apps/os-contract/src/index.ts": ["exports", "types"],
    "apps/os/src/db/migrations/.generated/migrations.ts": ["files", "exports", "types"],
    "apps/os/src/db/queries/.generated/index.ts": ["files", "exports", "types"],
    "apps/os/src/db/queries/.generated/tables.ts": ["files", "types"],
    "apps/os/src/durable-objects/mock-artifacts-binding.ts": ["exports"],
    "apps/os/src/durable-objects/test-stream-durable-object.ts": ["files", "exports"],
    "apps/os/src/domains/codemode/examples.ts": ["exports"],
    "apps/os/e2e/test-support/app-config-env.ts": ["files", "exports"],
    "apps/os/e2e/test-support/create-local-dev-server.ts": ["files", "exports"],
    "apps/os/e2e/test-support/create-mock-internet.ts": ["files", "exports"],
    "apps/os/src/**": ["exports", "types"],
    "apps/os/e2e/test-support/**": ["exports", "types"],
    "apps/semaphore/src/router.tsx": ["exports"],
    "apps/semaphore/scripts/seed-cloudflare-tunnel-pool.ts": ["exports"],
    "packages/shared/src/streams/db/migrations/.generated/migrations.ts": ["exports", "types"],
    "packages/shared/src/streams/db/queries/.generated/tables.ts": ["types"],
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
    "apps/os-contract": makePrivateContractWorkspace(),
    "packages/shared": makeSharedWorkspace(),
  },
};

export default config;
