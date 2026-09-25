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
    // The types it names resolve from each extending app's own dependencies.
    "tsconfig.app.json": ["unlisted", "unresolved"],
  },
  workspaces: {
    ".": {
      // The config-repo templates: the platform loads worker.ts as a project's config worker, and
      // an app's folder (agents/index.ts) as that app's source.
      entry: ["configs/*/worker.ts", "configs/*/*/index.ts"],
      project: ["*.ts", "specs/**/*.ts", "configs/**/*.{ts,js}"],
      ignoreDependencies: [
        // The .depot/workflows steps run these bins from the root (`pnpm tsx scripts/ci/…`).
        "trpc-cli",
        "tsx",
        // The `iterate` bin: `pnpm exec iterate` from the root (docs/dev-environments.md).
        "@iterate-com/cli",
        // `cloudflare:workers` parses as the "cloudflare" package.
        "cloudflare",
      ],
    },
    scripts: {
      // The programs .depot/workflows run (knip reads no Depot workflows); the modules beside them
      // get unused-export checks.
      entry: [
        "ci/{create-release,do-duration-alert,do-duration-probe,loc-report,main-e2e-alert,merges-with-main,notify,os-latency-guard,pr-dashboard,pr-ttg-guard,prd-fault-alarm,prd-post-deploy-check,preview-paths,preview-tested-commit,shadcn-drift,sync-ci-telemetry,test-evidence,upload-test-telemetry}.ts",
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
        // the e2e suite's test files are entries; e2e/support/** is project code, so an unused support
        // export is reported
        "e2e/**/*.e2e.test.ts",
        // read as text and handed over as the presence facet's source (e2e/support/sources.ts)
        "e2e/support/presence/durable-object.ts",
        "perf/**/*.perf.test.ts",
        "__workers-tests__/**/*.ts",
        "bench/**/*.ts",
        "src/**/*.test.ts",
        // the node programs (build/dev/deploy/preview and the operator CLIs) and their tests, so the
        // library modules beside them (preview-config, preview-sweep, generate-wrangler-config) get
        // unused-export checks
        "scripts/{build,dev,deploy,preview,ensure-resources,erase-data,control-plane-load,project-seed,e2e-soak,inspect-context}.ts",
        // read by the sqlfu CLI (`pnpm db:*`)
        "sqlfu.config.ts",
        "scripts/*.test.ts",
        "examples/**/*.ts",
      ],
      project: [
        "src/**/*.{ts,tsx,css}!",
        "scripts/**/*.ts",
        "examples/**/*.ts",
        "e2e/**/*.ts",
        "perf/**/*.ts",
        "__workers-tests__/**/*.ts",
        "bench/**/*.ts",
      ],
      // sqlfu writes these whole (`pnpm db:generate`): barrels and a migrations bundle the code
      // does not import, beside the query modules it does.
      ignore: ["src/control-plane/db/**/.generated/**"],
      // `cloudflare:workers` parses as the "cloudflare" package; knip does not count
      // src/styles.css's `@import "tailwindcss"`.
      ignoreDependencies: ["cloudflare", "tailwindcss"],
    },
    "apps/agents": {
      entry: ["scripts/**/*.ts", "e2e/**/*.e2e.test.ts", "__workers-tests__/**/*.test.ts"],
      project: [
        "scripts/**/*.ts",
        "src/**/*.{ts,tsx,css}!",
        "e2e/**/*.ts",
        "__workers-tests__/**/*.ts",
      ],
      vite: false,
      wrangler: false,
      ignoreDependencies: ["tailwindcss", "cloudflare"],
    },
    // The Start apps: knip's vite and TanStack Start plugins find the Worker entry.
    ...Object.fromEntries(
      ["admin", "dash", "kit", "notes", "voice"].map((app) => [
        `apps/${app}`,
        {
          entry: ["scripts/**/*.ts"],
          project: ["scripts/**/*.ts", "src/**/*.{ts,tsx,css}!"],
          // knip does not count src/styles.css's `@import "tailwindcss"`.
          ignoreDependencies: ["tailwindcss"],
        },
      ]),
    ),
    "apps/dummy-petshop": {
      // vite.config.ts names the Worker's main inline.
      entry: ["src/worker.ts!"],
      // `cloudflare:workers` parses as the "cloudflare" package.
      ignoreDependencies: ["cloudflare"],
    },
    "apps/ci-reports": {
      // vite.config.ts names the Worker's main inline.
      entry: ["src/worker.ts!"],
    },
    "apps/spa": {
      // public/index.html loads app.js, and its import map resolves @iterate-com/capnweb from a CDN.
      entry: ["public/app.js"],
      ignoreDependencies: ["@iterate-com/capnweb"],
    },
    "packages/ui": {
      // The package.json export map is the public entry surface (many subpath
      // exports, no src/index.ts) — same posture as packages/shared.
      entry: ["src/**/*.test.{ts,tsx}"],
      project: ["src/**/*.{ts,tsx,css}"],
    },
    // The userspace apps a project installs: their export maps are the entries, and index.ts the
    // classes a project's folder re-exports.
    "packages/agents": {
      entry: ["src/**/*.test.ts"],
      project: ["src/**/*.ts", "tsdown*.ts"],
      ignoreDependencies: ["cloudflare"],
    },
    "packages/voice": {
      entry: ["src/**/*.test.ts"],
      project: ["src/**/*.ts", "tsdown*.ts"],
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
