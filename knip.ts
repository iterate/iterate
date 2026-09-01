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
    ],
    entry: [
      ...(base.entry ?? []).filter((entry) => entry !== "scripts/router.ts"),
      "e2e/vitest.config.ts",
      "e2e/tui-test/tui-test.config.ts",
      "e2e/tui-test/run.ts",
      "e2e/tui-test/data-layer-smoke.ts",
      // The sidecar worker entries (wrangler.{worker-bundler,typechecker}.jsonc,
      // generated and gitignored — knip cannot see the configs that
      // reference them).
      "src/worker-bundler.ts",
      "src/typechecker.ts",
      // Local operational commands mounted by scripts/cli.ts.
      "scripts/cli.ts",
      "scripts/dev.ts",
      "scripts/itx.ts",
      // Operational smoke for the create-project -> generic agent reply path.
      "e2e/vitest/agent-smoke.ts",
    ],
    ignoreDependencies: [
      ...(base.ignoreDependencies ?? []),
      // Used while root-level config templates are staged under apps/os for
      // typechecking; that script-driven import graph is opaque to Knip.
      "@iterate-com/docs",
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
      "vite.config.ts",
      "playwright.config.ts",
      "vitest.config.ts",
      "scripts/**/*.ts",
      "src/worker.ts!",
      "e2e/**/*.ts",
    ],
    project: ["src/**/*.{ts,tsx}!", "e2e/**/*.ts", "!dist/**!"],
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

function makeTanstackTodoWorkspace(): WorkspaceConfig {
  return {
    entry: ["vite.config.ts", "playwright.config.ts", "src/worker.ts!", "e2e/**/*.ts"],
    project: ["src/**/*.{ts,tsx}!", "e2e/**/*.ts", "!dist/**!"],
    vite: false,
    // wrangler backs the @cloudflare/vite-plugin at runtime; nothing imports
    // it directly in this minimal app.
    ignoreDependencies: ["cloudflare", "wrangler"],
    ignoreBinaries: ["playwright"],
  };
}

function makeKitWorkspace(): WorkspaceConfig {
  return {
    entry: ["vite.config.ts", "vitest.config.ts", "scripts/**/*.ts"],
    project: ["scripts/**/*.ts", "src/**/*.{ts,tsx}!", "!dist/**!"],
    vite: false,
    // TanStack Start resolves this factory by convention, while Wrangler and
    // Tailwind back plugins rather than direct runtime imports.
    ignoreDependencies: ["cloudflare", "tailwindcss", "wrangler"],
  };
}

function makeDocsWorkspace(): WorkspaceConfig {
  return {
    entry: ["vite.config.ts", "vitest.config.ts", "src/worker.ts!", "scripts/**/*.ts"],
    project: ["src/**/*.{ts,tsx}!", "scripts/**/*.ts", "!dist/**!", "!dist-package/**!"],
    vite: false,
    // tailwindcss backs @tailwindcss/vite and the shared UI stylesheet.
    // `cloudflare:workers` parses as the "cloudflare" package.
    ignoreDependencies: ["cloudflare", "tailwindcss"],
  };
}

function makeBrowserExtensionWorkspace(): WorkspaceConfig {
  return {
    entry: ["vite.config.ts", "src/background.ts", "src/main.tsx"],
    project: ["src/**/*.{ts,tsx}", "vite.config.ts"],
    vite: false,
  };
}

function makeCloudflareTanStackAppWorkspace(workerEnvShim: string): WorkspaceConfig {
  return {
    entry: ["vite.config.ts", "scripts/router.ts", "scripts/**/*.ts", "src/worker.ts!"],
    project: [
      "*.test.ts",
      "e2e/**/*.ts",
      "scripts/**/*.ts",
      "src/**/*.{ts,tsx}!",
      "!.output/**!",
      "!dist/**!",
    ],
    vite: false,
    paths: {
      "cloudflare:workers": [workerEnvShim],
    },
    ignoreBinaries: ["doppler", "read", "sqlite3"],
    ignoreDependencies: ["cloudflare", "tailwindcss"],
  };
}

function makeUiWorkspace(): WorkspaceConfig {
  return {
    // The package.json export map is the public entry surface (many subpath
    // exports, no src/index.ts) — same posture as packages/shared.
    entry: ["src/**/*.test.{ts,tsx}"],
    project: ["src/**/*.{ts,tsx}"],
  };
}

function makeIterateCliWorkspace(): WorkspaceConfig {
  return {
    entry: [
      "src/index.ts",
      "src/worker.ts",
      "src/cli.ts",
      "bin/iterate.js",
      "scripts/*.ts",
      // CI post-steps invoke this directly via `pnpm tsx`; nothing imports it.
      "src/scripts/report-flake-records.ts",
      "tsdown.app-clients.config.ts",
      "tsdown.config.ts",
      "vitest.config.ts",
      // tsdown reads these entrypoint paths as data; Knip cannot follow them
      // from the config object into the two standalone browser programs.
      "src/starter-apps/{guestbook,todo}/client.tsx",
      "src/**/*.test.{ts,tsx}",
    ],
    project: ["src/**/*.{ts,tsx}", "bin/**/*.js", "scripts/**/*.ts", "tsdown*.ts"],
    // `cloudflare:workers` (typed by src/cloudflare-workers.d.ts) parses as
    // the "cloudflare" package — same posture as the app workspaces.
    ignoreDependencies: ["cloudflare"],
  };
}

function makeSharedWorkspace(): WorkspaceConfig {
  return {
    // This package exposes many subpath exports from package.json rather than a
    // single `src/index.ts`, so keep the workspace config minimal and let Knip
    // use the declared export map as the public entry surface.
    // The flake-test fixture is only reached by a child vitest process
    // spawned from flake-test.test.ts, so knip cannot see it in the import
    // graph.
    entry: ["src/**/*.test.ts", "src/test-support/flake-test-fixture/*.ts"],
    project: ["src/**/*.ts"],
    ignoreDependencies: ["cloudflare", "wrangler"],
  };
}

function makeWorkspaceDocumentsWorkspace(): WorkspaceConfig {
  return {
    // package.json's subpath export map is the public entry surface.
    entry: ["src/**/*.test.ts"],
    project: ["src/**/*.{ts,tsx}"],
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
    // Nested under apps/mobile (itself ignored); "apps/*" doesn't reach it.
    "apps/mobile/website",
    "!apps/os",
    "!apps/semaphore",
    "!apps/streams-example-app",
    "!apps/tanstack",
    "!apps/kit",
    "!apps/docs",
    "!apps/browser-extension",
    "packages/*",
    "!packages/shared",
    "!packages/ui",
    "!packages/iterate",
    "!packages/workspace-documents",
  ],
  ignoreIssues: {
    "apps/os/e2e/test-support/app-config-env.ts": ["files", "exports"],
    "apps/os/e2e/test-support/**": ["exports", "types"],
    // Example-matrix harness modules export helpers consumed across the
    // matrix/browser suites and root Playwright specs; keep the same policy
    // they had under src/**.
    "apps/os/e2e/examples/**": ["exports", "types"],
    "apps/streams-example-app/src/lib/use-initial-tail-scroll.ts": ["types"],
    // TanStack Start resolves the router factory by convention from the
    // entrypoint, so there is no direct import Knip can follow.
    "apps/semaphore/src/router.tsx": ["exports"],
    "apps/tanstack/src/router.tsx": ["exports"],
    "apps/kit/src/router.tsx": ["exports"],
    "apps/docs/src/router.tsx": ["exports"],
  },
  workspaces: {
    "apps/semaphore": makeSemaphoreCloudflareAppWorkspace("./src/lib/worker-env.d.ts"),
    "apps/os": makeOsCloudflareAppWorkspace("./src/lib/worker-env.d.ts"),
    "apps/streams-example-app": makeStreamsExampleAppWorkspace(),
    "apps/tanstack": makeTanstackTodoWorkspace(),
    "apps/kit": makeKitWorkspace(),
    "apps/docs": makeDocsWorkspace(),
    "apps/browser-extension": makeBrowserExtensionWorkspace(),
    "packages/shared": makeSharedWorkspace(),
    "packages/ui": makeUiWorkspace(),
    "packages/iterate": makeIterateCliWorkspace(),
    "packages/workspace-documents": makeWorkspaceDocumentsWorkspace(),
  },
};

export default config;
