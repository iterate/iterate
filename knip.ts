import type { KnipConfig } from "knip";

type WorkspaceConfig = NonNullable<KnipConfig["workspaces"]>[string];

function makeDualRuntimeAppWorkspace(workerEnvShim: string): WorkspaceConfig {
  return {
    // Treat the real runtime roots as explicit entries instead of asking Knip
    // to infer reachability through Vite/TanStack Start config loading.
    // `!` marks files that should also count in `knip --production`.
    entry: [
      // Alchemy is the non-obvious Cloudflare entry root in these apps.
      "alchemy.run.ts",
      // Keep Vite configs as static entries so config-only build deps are
      // counted, without making Knip execute those config modules.
      "vite.config.ts",
      "vite.cf.config.ts",
      // This script is the package.json `start` target for the built server.
      "scripts/start.ts",
      // The local iterate router script is launched by package scripts, but the
      // custom CLI args are easier to model explicitly here.
      "scripts/router.ts",
      "src/entry.node.ts!",
      "src/entry.workerd.ts!",
    ],
    // Keep the project boundary focused on app source and exclude build
    // artifacts from unused-file analysis. We intentionally keep generated
    // route trees in-project so route discovery can mark route files as used.
    project: [
      // Include non-production helpers in the default run so Knip can flag
      // orphaned tests and local scripts in these small app workspaces too.
      "*.test.ts",
      "scripts/**/*.ts",
      "src/**/*.{ts,tsx}!",
      "!drizzle/**!",
      "!.output/**!",
      "!dist/**!",
      "!.alchemy/**!",
    ],
    // Disabled on purpose: these apps eagerly validate runtime env in Vite
    // config, so explicit entries are a cleaner fit than plugin execution.
    vite: false,
    paths: {
      // Model the Workers runtime import so Knip does not treat it like a
      // normal package import from app source.
      "cloudflare:workers": [workerEnvShim],
    },
    ignoreBinaries: [
      // `doppler` is a globally installed CLI in this repo's workflow rather
      // than a package dependency inside each app workspace.
      "doppler",
      // These app scripts shell out to the local iterate CLI package by binary
      // name, which Knip does not infer from the import graph.
      "iterate",
    ],
    ignoreDependencies: [
      // Knip reports the Workers runtime specifier as `cloudflare`.
      "cloudflare",
      // These app scripts shell out to the local iterate CLI package by binary
      // name, which Knip does not infer from the import graph.
      "iterate",
      // The router launches nodemon as a subprocess via tinyexec, which Knip
      // cannot infer from the import graph.
      "nodemon",
      // CSS `@import "tailwindcss"` usage is outside the TS import graph.
      "tailwindcss",
    ],
  };
}

function makeCloudflareTanStackAppWorkspace(workerEnvShim: string): WorkspaceConfig {
  return {
    entry: ["alchemy.run.ts", "vite.config.ts", "scripts/router.ts", "src/entry.workerd.ts!"],
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

function makeEventsCloudflareWorkspace(workerEnvShim: string): WorkspaceConfig {
  const workspace = makeCloudflareTanStackAppWorkspace(workerEnvShim);

  return {
    ...workspace,
    entry: [...(workspace.entry ?? []), "scripts/demo/router.ts"],
  };
}

function makeNodeOnlyAppWorkspace(): WorkspaceConfig {
  return {
    entry: ["vite.config.ts", "scripts/start.ts", "scripts/router.ts", "src/entry.node.ts!"],
    project: [
      "*.test.ts",
      "scripts/**/*.ts",
      "src/**/*.{ts,tsx}!",
      "!drizzle/**!",
      "!.output/**!",
      "!dist/**!",
    ],
    vite: false,
    ignoreBinaries: ["doppler"],
    ignoreDependencies: ["nodemon", "tailwindcss"],
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
    entry: ["bin/iterate-app-cli.js", "src/apps/cli-entry.ts"],
    project: ["src/**/*.ts"],
  };
}

const config: KnipConfig = {
  // Keep the config honest in CI/local runs: if Knip thinks our patterns or
  // workspace setup drifted, fail instead of silently warning.
  treatConfigHintsAsErrors: true,
  // Keep this root command intentionally scoped. When Knip includes dependent
  // workspaces for a selected package, we still do not want it wandering into
  // unrelated apps with heavyweight config loading like `apps/os`.
  ignoreWorkspaces: [
    "apps/*",
    "!apps/example",
    "!apps/example-contract",
    "!apps/events",
    "!apps/events-contract",
    "!apps/ingress-proxy",
    "!apps/ingress-proxy-contract",
    "!apps/semaphore",
    "!apps/semaphore-contract",
    "!apps/daemon-v2",
    "!apps/daemon-v2-contract",
    "packages/*",
    "!packages/shared",
  ],
  ignoreIssues: {
    // This file is generated from Fly's OpenAPI schema and intentionally emits
    // a couple of placeholder exported types that are never imported directly.
    "packages/shared/src/jonasland/deployment/fly-api/generated/openapi.gen.ts": ["types"],
    // TanStack Start resolves these router factories by convention from the
    // entrypoint, so there is no direct import Knip can follow.
    "apps/daemon-v2/src/router.tsx": ["exports"],
    "apps/example/src/router.tsx": ["exports"],
    "apps/ingress-proxy-contract/src/client.ts": ["types"],
    "apps/semaphore-contract/src/client.ts": ["types"],
    "apps/semaphore/src/router.tsx": ["exports"],
  },
  workspaces: {
    "apps/example": makeDualRuntimeAppWorkspace("./src/lib/worker-env.d.ts"),
    "apps/example-contract": makePrivateContractWorkspace(),
    "apps/events": makeEventsCloudflareWorkspace("./src/lib/worker-env.d.ts"),
    "apps/events-contract": makePrivateContractWorkspace(),
    "apps/ingress-proxy": makeCloudflareTanStackAppWorkspace("./src/lib/worker-env.d.ts"),
    "apps/ingress-proxy-contract": makePrivateContractWorkspace(),
    "apps/semaphore": makeCloudflareTanStackAppWorkspace("./src/lib/worker-env.d.ts"),
    "apps/semaphore-contract": makePrivateContractWorkspace(),
    "apps/daemon-v2": makeNodeOnlyAppWorkspace(),
    "apps/daemon-v2-contract": makePrivateContractWorkspace(),
    "packages/shared": makeSharedWorkspace(),
  },
};

export default config;
