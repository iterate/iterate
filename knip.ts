import type { KnipConfig } from "knip";

type WorkspaceConfig = NonNullable<KnipConfig["workspaces"]>[string];

function makeOsNextWorkspace(): WorkspaceConfig {
  // The os-next platform worker. Knip's vitest and Playwright plugins read vitest.config.ts (its
  // global setups) and playwright.config.ts; the rest are entries here.
  return {
    entry: [
      "src/worker.ts!",
      "src/client/**/*.{ts,tsx}",
      // the e2e lane's test files are entries; e2e/support/** is project code, so an unused support
      // export is reported
      "e2e/**/*.e2e.test.ts",
      "__workers-tests__/**/*.ts",
      "bench/**/*.ts",
      "specs/**/*.ts",
      "src/**/*.test.ts",
      // the node programs: build/dev/deploy/preview and the voice operator tools
      "scripts/*.ts",
      "examples/**/*.ts",
    ],
    project: [
      "src/**/*.{ts,tsx}!",
      "scripts/**/*.ts",
      "examples/**/*.ts",
      "e2e/**/*.ts",
      "__workers-tests__/**/*.ts",
      "bench/**/*.ts",
      "specs/**/*.ts",
    ],
    // `cloudflare:workers` parses as the "cloudflare" package.
    ignoreDependencies: ["cloudflare"],
  };
}

function makeKitWorkspace(): WorkspaceConfig {
  return {
    // The worker entry is declared here, not read from wrangler.jsonc: that file is generated
    // (gitignored, `pnpm gen:wrangler` inside kit's typecheck) and CI runs knip in parallel with
    // typecheck, so knip's view of it would be a race.
    entry: ["vite.config.ts", "src/worker.ts!", "scripts/**/*.ts"],
    project: ["scripts/**/*.ts", "src/**/*.{ts,tsx}!", "!dist/**!"],
    vite: false,
    wrangler: false,
    // Tailwind backs a Vite plugin rather than a direct runtime import.
    ignoreDependencies: ["tailwindcss"],
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

function makeIterateWorkspace(): WorkspaceConfig {
  return {
    // The `iterate/next/*` SDK is the package.json export map; the CLI is the bin.
    entry: ["src/**/*.test.{ts,tsx}"],
    project: ["src/**/*.{ts,tsx}", "bin/**/*.js", "tsdown*.ts"],
    // `cloudflare:workers` (typed by src/cloudflare-workers.d.ts) parses as
    // the "cloudflare" package — same posture as the app workspaces.
    ignoreDependencies: ["cloudflare"],
  };
}

function makeSharedWorkspace(): WorkspaceConfig {
  return {
    // This package exposes many subpath exports from package.json rather than a
    // single `src/index.ts`, so keep the workspace config minimal and let Knip
    // use the declared export map as the public entry surface. The flake-test fixture is run by a
    // child vitest that flake-test.test.ts spawns with its own config.
    entry: ["src/**/*.test.ts", "src/test-support/flake-test-fixture/*.ts"],
    project: ["src/**/*.ts"],
  };
}

const config: KnipConfig = {
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
  // Keep this root command intentionally scoped (the root `knip` script also names its workspaces).
  // When Knip includes dependent workspaces for a selected package, we still do not want it wandering
  // into apps that have never been configured for it.
  ignoreWorkspaces: [
    "apps/*",
    "!apps/os",
    "!apps/kit",
    "packages/*",
    "!packages/shared",
    "!packages/ui",
    "!packages/iterate",
  ],
  ignoreIssues: {
    // Loaded code: the platform injects ./processor.js into the isolate it loads this example into.
    "apps/os/examples/mini-app.ts": ["unresolved"],
  },
  workspaces: {
    "apps/os": makeOsNextWorkspace(),
    "apps/kit": makeKitWorkspace(),
    "packages/shared": makeSharedWorkspace(),
    "packages/ui": makeUiWorkspace(),
    "packages/iterate": makeIterateWorkspace(),
  },
};

export default config;
