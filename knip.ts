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
      // The config-repo templates, core's and iterate's: the platform loads worker.ts as a
      // project's config entrypoint, agents.ts as the module the agents app's facets load their
      // classes from, and voice.ts as voice's service and relay.
      entry: [
        "core/configs/*/worker.ts",
        "core/configs/*/agents.ts",
        "configs/*/worker.ts",
        "configs/*/agents.ts",
        "configs/*/voice.ts",
      ],
      project: ["*.ts", "core/configs/**/*.{ts,js}", "configs/**/*.{ts,js}"],
      ignoreDependencies: [
        // `cloudflare:workers` parses as the "cloudflare" package.
        "cloudflare",
      ],
    },
    scripts: {
      // The programs .depot/workflows run (knip reads no Depot workflows); the modules beside them
      // get unused-export checks.
      entry: [
        "ci/{context-sweep,copybara,create-release,loc-report,merges-with-main,notify,pr-dashboard,prd-fault-alarm,prd-post-deploy-check,preview-paths,preview-tested-commit,shadcn-drift,shadcn-registry,specs-shards,sync-ci-telemetry,test-evidence,test-telemetry-finalizer}.ts",
        "monitors/{health,do-duration-probe}.ts",
        "ci/flake-dashboard/update.ts",
        "ci/tracing/{cli,tracing}.ts",
        // iterate's core/os tooling, run by the root package.json's `preview` and `os:*` scripts
        "os/{deploy,preview,ensure-resources,erase-data,control-plane-load,project-seed,seed-instance-secrets,e2e-soak}.ts",
      ],
    },
    "core/os": {
      // The platform worker. Knip's vitest plugin reads vitest.config.ts (its global
      // setup); the rest are entries here. Every test beyond a simple unit test is test/'s.
      entry: [
        "src/worker.ts!",
        "src/**/*.test.ts",
        // the node programs (build and dev; iterate's deploy and preview tooling is scripts/os at the
        // root) and their tests, so the library modules beside them (generate-wrangler-config) get
        // unused-export checks
        "scripts/{build,dev}.ts",
        // read by the sqlfu CLI (`pnpm db:*`)
        "sqlfu.config.ts",
        "scripts/*.test.ts",
        "examples/**/*.ts",
        // shadcn's components, vendored whole and never edited (packages/ui/AGENTS.md): the exports
        // core/os does not use are upstream's
        "src/components/ui/*.tsx",
      ],
      project: ["src/**/*.{ts,tsx,css}!", "scripts/**/*.ts", "examples/**/*.ts"],
      // sqlfu writes these whole (`pnpm db:generate`): barrels and a migrations bundle the code
      // does not import, beside the query modules it does.
      ignore: ["src/control-plane/db/**/.generated/**"],
      // `cloudflare:workers` parses as the "cloudflare" package
      ignoreDependencies: ["cloudflare"],
    },
    "apps/agents": {
      entry: ["scripts/**/*.ts"],
      project: ["scripts/**/*.ts", "src/**/*.{ts,tsx,css}!"],
      vite: false,
      wrangler: false,
      ignoreDependencies: ["tailwindcss", "cloudflare"],
    },
    lint: {
      // oxlint loads it as a JS plugin (.oxlintrc.json `jsPlugins`), and with it lint/rules/*
      entry: ["oxlint-plugin-iterate.ts"],
    },
    test: {
      // The tests outside every app: in-process, the Workers pool, against a running worker, and in
      // a browser. Knip's vitest and Playwright plugins read the two configs (their global setups,
      // the in-process and Workers tests); the suites' files are entries, and helpers/** is project
      // code, so an unused helper export is reported.
      entry: [
        "vitest/**/*.e2e.test.ts",
        "vitest/os-workers/**/*.ts",
        "vitest/agents-workers/**/*.ts",
        "vitest/os/perf/**/*.perf.test.ts",
        "vitest/os/bench/**/*.ts",
        // read as text and handed over as the presence facet's source (helpers/sources.ts)
        "helpers/presence/durable-object.ts",
        "playwright/**/*.spec.ts",
        "helpers/*.spec.ts",
      ],
      project: ["helpers/**/*.ts", "vitest/**/*.ts", "playwright/**/*.ts"],
    },
    // The Start apps: knip's vite and TanStack Start plugins find the Worker entry.
    ...Object.fromEntries(
      ["admin", "dash", "docs", "notes", "voice"].map((app) => [
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
      // The deploy (scripts/lib/deploy-app.ts) runs `pnpm exec wrangler` in the app's directory.
      entry: ["public/app.js"],
      ignoreDependencies: ["@iterate-com/capnweb", "wrangler"],
    },
    "apps/browser-extension": {
      // public/index.html loads panel.js and the manifest names background.js; panel.js's
      // ./capnweb.js and ./oauth.js are the ones the build copies into dist/.
      entry: ["public/panel.js", "public/background.js"],
      ignoreUnresolved: ["./capnweb.js", "./oauth.js"],
    },
    "packages/ui": {
      // The package.json export map is the public entry surface (many subpath
      // exports, no src/index.ts) — same posture as packages/shared.
      entry: ["src/**/*.test.{ts,tsx}"],
      project: ["src/**/*.{ts,tsx,css}"],
    },
    // The userspace apps a project installs: their export maps are the entries, and index.ts the
    // classes a project's folder re-exports.
    "packages/voice": {
      entry: ["src/**/*.test.ts"],
      project: ["src/**/*.ts", "tsdown*.ts"],
    },
    "packages/github-sync": {
      entry: ["src/**/*.test.ts"],
      project: ["src/**/*.ts", "tsdown*.ts"],
    },
    "packages/docs": {
      entry: ["src/**/*.test.ts"],
      project: ["src/**/*.ts", "tsdown*.ts"],
    },
    "packages/ai-linter": {
      entry: ["src/**/*.test.ts"],
      project: ["src/**/*.ts", "tsdown*.ts"],
    },
    "core/lib": {
      // The `iterate/*` SDK is the package.json export map; the CLI's entry is its `iterate` bin.
      entry: ["src/**/*.test.{ts,tsx}"],
      project: ["src/**/*.{ts,tsx}", "bin/**/*.js", "tsdown*.ts"],
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
