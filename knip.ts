import type { KnipConfig } from "knip";

export default {
  // Keep the config honest in CI/local runs: if Knip thinks our patterns or
  // workspace setup drifted, fail instead of silently warning.
  treatConfigHintsAsErrors: true,
  // A TYPE exported for a holder's benefit and used in its own file (a connector's option or result
  // type, a config shape) is not dead; a VALUE export still needs an importer.
  ignoreExportsUsedInFile: { interface: true, type: true },
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
  ignoreIssues: {
    // apps/agents' runtime:build output: the platform injects ./processor.js when it loads it.
    "configs/with-agents/agents.js": ["unresolved"],
    // The types it names resolve from each extending app's own dependencies.
    "tsconfig.base.json": ["unlisted", "unresolved"],
  },
  workspaces: {
    ".": {
      // The config-repo templates: the platform loads worker.ts as a project's config worker.
      entry: ["configs/*/worker.ts"],
      project: ["*.ts", "specs/**/*.ts", "configs/**/*.{ts,js}"],
      ignoreDependencies: [
        // .oxlintrc.json loads these as jsPlugins, which knip's oxlint plugin does not read.
        "@tanstack/eslint-plugin-router",
        "eslint-plugin-codegen",
        "eslint-plugin-eslint-comments",
        "eslint-plugin-import",
        // The .depot/workflows steps run this bin from the root.
        "trpc-cli",
        // The `iterate` bin: `pnpm exec iterate` from the root (docs/dev-environments.md).
        "@iterate-com/cli",
        // `cloudflare:workers` parses as the "cloudflare" package.
        "cloudflare",
      ],
    },
    lint: {
      // .oxlintrc.json's jsPlugins entry.
      entry: ["oxlint-plugin-iterate.ts"],
    },
    scripts: {
      // The programs .depot/workflows run (knip reads no Depot workflows); the modules beside them
      // get unused-export checks.
      entry: [
        "ci/{create-release,do-duration-alert,do-duration-probe,loc-report,main-e2e-alert,notify,pr-dashboard,prd-fault-alarm,prd-post-deploy-check,preview-tested-commit,sync-ci-telemetry,upload-test-telemetry}.ts",
        "ci/flake-dashboard/update.ts",
        "ci/tracing/{cli,tracing}.ts",
        "depot-ci/dependencies.mjs",
      ],
    },
    "apps/os": {
      // The platform worker. Knip's vitest plugin reads vitest.config.ts (its global
      // setups); the rest are entries here. The browser specs are the root suite (specs/AGENTS.md).
      entry: [
        "src/worker.ts!",
        "src/client/**/*.{ts,tsx}",
        // the e2e suite's test files are entries; e2e/support/** is project code, so an unused support
        // export is reported
        "e2e/**/*.e2e.test.ts",
        "perf/**/*.perf.test.ts",
        "__workers-tests__/**/*.ts",
        "bench/**/*.ts",
        "src/**/*.test.ts",
        // the node programs (build/dev/deploy/preview and the operator CLIs) and their tests, so the
        // library modules beside them (preview-config, preview-sweep, generate-wrangler-config) get
        // unused-export checks
        "scripts/{build,dev,deploy,preview,ensure-resources,erase-data,replay-directory,control-plane-load,project-seed,e2e-soak,inspect-context}.ts",
        "scripts/*.test.ts",
        "examples/**/*.ts",
      ],
      project: [
        "src/**/*.{ts,tsx}!",
        "scripts/**/*.ts",
        "examples/**/*.ts",
        "e2e/**/*.ts",
        "perf/**/*.ts",
        "__workers-tests__/**/*.ts",
        "bench/**/*.ts",
      ],
      // `cloudflare:workers` parses as the "cloudflare" package. Tailwind is imported by
      // src/styles.css, which knip does not read.
      ignoreDependencies: ["cloudflare", "tailwindcss"],
    },
    "apps/agents": {
      // scripts/build-runtime.ts bundles runtime/index.ts into the with-agents template;
      // scripts/build-voice-install.ts bundles the voice entries into the installer.
      entry: [
        "vite.config.ts",
        "src/server.ts!",
        "scripts/**/*.ts",
        "runtime/index.ts",
        "voice/{voice-agent,voice-delegate,worker}.ts",
        "e2e/**/*.e2e.test.ts",
        "__workers-tests__/**/*.test.ts",
      ],
      project: [
        "scripts/**/*.ts",
        "src/**/*.{ts,tsx}!",
        "runtime/**/*.ts",
        "voice/**/*.ts",
        "e2e/**/*.ts",
        "__workers-tests__/**/*.ts",
      ],
      vite: false,
      wrangler: false,
      ignoreDependencies: ["tailwindcss", "cloudflare", "@cloudflare/workers-types"],
    },
    "apps/{dash,kit,notes,voice}": {
      // The Worker entry is declared here: there is no wrangler file to read it from (the Worker
      // config is scripts/lib/start-app.ts's, handed to the Cloudflare Vite plugin).
      entry: ["vite.config.ts", "src/server.ts!", "scripts/**/*.ts"],
      project: ["scripts/**/*.ts", "src/**/*.{ts,tsx}!", "!dist/**!"],
      vite: false,
      wrangler: false,
      // Tailwind backs a Vite plugin rather than a direct runtime import. `cloudflare:workers` parses
      // as the "cloudflare" package; the Workers types are named by the shared tsconfig.base.json.
      ignoreDependencies: ["tailwindcss", "cloudflare", "@cloudflare/workers-types"],
    },
    "apps/dummy-petshop": {
      // vite.config.ts names the Worker's main inline.
      entry: ["src/worker.ts!"],
      // As in the Start apps: `cloudflare:workers` parses as the "cloudflare" package; the Workers
      // types are named by tsconfig.base.json.
      ignoreDependencies: ["cloudflare", "@cloudflare/workers-types"],
    },
    "apps/ci-reports": {
      // vite.config.ts names the Worker's main inline.
      entry: ["src/worker.ts!"],
      // The Workers types are named by tsconfig.base.json.
      ignoreDependencies: ["@cloudflare/workers-types"],
    },
    "apps/spa": {
      // public/index.html loads app.js, and its import map resolves @iterate-com/capnweb from a CDN.
      entry: ["public/app.js"],
      // scripts/deploy.ts runs `pnpm exec wrangler`.
      ignoreDependencies: ["@iterate-com/capnweb", "wrangler"],
    },
    "packages/ui": {
      // The package.json export map is the public entry surface (many subpath
      // exports, no src/index.ts) — same posture as packages/shared.
      entry: ["src/**/*.test.{ts,tsx}"],
      project: ["src/**/*.{ts,tsx}"],
    },
    "packages/cli": {
      // The `iterate` bin (package.json `bin`).
      entry: ["src/**/*.test.ts"],
      project: ["src/**/*.ts", "bin/**/*.js", "tsdown*.ts"],
    },
    "packages/iterate": {
      // The `iterate/*` SDK is the package.json export map.
      entry: ["src/**/*.test.{ts,tsx}"],
      project: ["src/**/*.{ts,tsx}", "tsdown*.ts"],
      // `cloudflare:workers` (typed by src/cloudflare-workers.d.ts) parses as
      // the "cloudflare" package — same posture as the app workspaces.
      ignoreDependencies: ["cloudflare"],
    },
    "packages/shared": {
      // This package exposes many subpath exports from package.json rather than a
      // single `src/index.ts`, so keep the workspace config minimal and let Knip
      // use the declared export map as the public entry surface. The flake-test fixture is run by a
      // child vitest that flake-test.test.ts spawns with its own config.
      entry: ["src/**/*.test.ts", "src/test-support/flake-test-fixture/*.ts"],
      project: ["src/**/*.ts"],
    },
  },
} satisfies KnipConfig;
