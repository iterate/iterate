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

function makeAgentsTanStackAppWorkspace(workerEnvShim: string): WorkspaceConfig {
  const base = makeCloudflareTanStackAppWorkspace(workerEnvShim);
  return {
    ...base,
    entry: [
      ...(base.entry ?? []),
      "e2e/vitest.config.ts",
      "e2e/tui-test/tui-test.config.ts",
      "scripts/event-stream-terminal.tsx",
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
    entry: [
      ...(workspace.entry ?? []),
      "scripts/demo/router.ts",
      "sqlfu.config.ts",
      "src/entry.workerd.vitest.ts",
    ],
    ignore: ["src/db/migrations/.generated/migrations.ts", "src/durable-objects/sqlfu.config.ts"],
    ignoreBinaries: [...(workspace.ignoreBinaries ?? []), "sqlfu"],
    ignoreDependencies: [...(workspace.ignoreDependencies ?? []), "miniflare"],
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
    entry: [
      "bin/iterate-app-cli.js",
      "src/apps/cli-entry.ts",
      "src/durable-object-utils/e2e/alchemy.run.ts",
      "src/streams/sqlfu.config.ts",
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
  // unrelated apps with heavyweight config loading like `apps/os`.
  ignoreWorkspaces: [
    "apps/*",
    "!apps/agents",
    "!apps/agents-contract",
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
    "apps/agents/src/router.tsx": ["exports"],
    "apps/example/src/router.tsx": ["exports"],
    "apps/ingress-proxy-contract/src/client.ts": ["types"],
    "apps/semaphore-contract/src/client.ts": ["types"],
    "apps/semaphore/src/router.tsx": ["exports"],
    "apps/semaphore/scripts/seed-cloudflare-tunnel-pool.ts": ["exports"],
    "apps/agents/src/lib/events-orpc-client.ts": ["exports", "types"],
    "apps/agents/src/lib/mcp-tool-providers.ts": ["types"],
    "apps/agents/src/lib/openapi-tool-provider.ts": ["types"],
    "apps/agents/src/lib/llm-normalization.ts": ["exports"],
    "apps/agents/src/durable-objects/agent-chat-stream-processor-runner.ts": ["types"],
    "apps/agents/src/durable-objects/agent-stream-processor-runner.ts": ["types"],
    "apps/agents/src/durable-objects/cloudflare-ai-stream-processor-runner.ts": ["types"],
    "apps/agents/src/durable-objects/codemode-stream-processor-runner.ts": ["types"],
    "apps/agents/src/durable-objects/openai-ws-stream-processor-runner.ts": ["types"],
    "apps/agents/src/entrypoints/stream-api.ts": ["types"],
    "apps/agents/src/stream-processors/codemode/cloudflare-code-executor.ts": ["types"],
    "apps/agents/src/stream-processors/pull-runner.ts": ["types"],
    "apps/agents/src/stream-tui/command-invocation.ts": ["types"],
    "apps/agents/src/stream-tui/command-router.ts": ["types"],
    "apps/agents/src/stream-tui/feed-formatting.ts": ["exports"],
    "apps/agents/src/stream-tui/navigation-state.ts": ["types"],
    "apps/agents/src/stream-tui/pilotty-command.ts": ["types"],
    "apps/agents/src/stream-tui/stream-tree.ts": ["types"],
    // Generated SQLFU bundles/configs are loaded by scripts/runtime conventions.
    "apps/events/src/db/migrations/.generated/migrations.ts": ["files", "exports", "types"],
    "apps/events/src/durable-objects/db/migrations/.generated/migrations.ts": ["exports", "types"],
    "apps/events/src/durable-objects/db/queries/.generated/tables.ts": ["types"],
    "apps/events/src/db/queries/.generated/tables.ts": ["types"],
    "apps/events/src/durable-objects/sqlfu.config.ts": ["files"],
    "apps/events/src/lib/custom-html-renderers.ts": ["exports"],
    "apps/events/src/lib/stream-feed-summary.ts": ["types"],
    "apps/events/src/lib/stream-helpers.ts": ["exports"],
    "packages/shared/src/streams/db/migrations/.generated/migrations.ts": ["exports", "types"],
    "packages/shared/src/streams/db/queries/.generated/tables.ts": ["types"],
    // Cloudflare discovers DO default exports through Worker bindings.
    "apps/example/src/durable-objects/example-counter.ts": ["exports"],
    "packages/shared/src/callable/entry.workerd.vitest.ts": ["exports"],
    "packages/shared/src/durable-object-utils/test-harness/initialize-fronting-worker.ts": [
      "exports",
      "types",
    ],
  },
  workspaces: {
    "apps/agents": makeAgentsTanStackAppWorkspace("./src/lib/worker-env.d.ts"),
    "apps/agents-contract": makePrivateContractWorkspace(),
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
