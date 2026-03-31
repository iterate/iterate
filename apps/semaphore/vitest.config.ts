import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import { defaultExclude } from "vitest/config";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const wranglerConfigPath = resolve(appRoot, ".wrangler", "vitest", "wrangler.jsonc");

mkdirSync(resolve(appRoot, ".wrangler", "vitest"), { recursive: true });
writeFileSync(
  wranglerConfigPath,
  JSON.stringify(
    {
      name: "semaphore",
      main: "src/entry.workerd.ts",
      compatibility_date: "2025-02-24",
      compatibility_flags: [],
      durable_objects: {
        bindings: [
          {
            name: "RESOURCE_COORDINATOR",
            class_name: "ResourceCoordinator",
            script_name: "semaphore",
          },
        ],
      },
      d1_databases: [
        {
          binding: "DB",
          database_id: "b2ee54e6-e2e6-493d-a99e-f65095d708c6",
          database_name: "semaphore-resources",
          migrations_dir: "./migrations",
          preview_database_id: "b2ee54e6-e2e6-493d-a99e-f65095d708c6",
        },
      ],
      migrations: [
        {
          tag: "v1",
          new_sqlite_classes: ["ResourceCoordinator"],
          new_classes: [],
        },
      ],
      vars: {
        APP_CONFIG: '{"sharedApiSecret":"test-token","posthog":{"apiKey":"phc_test"}}',
      },
    },
    null,
    2,
  ),
);

export default defineWorkersConfig({
  resolve: {
    alias: {
      "~": resolve(appRoot, "src"),
    },
  },
  test: {
    globals: true,
    include: ["./src/**/*.test.ts"],
    exclude: [...defaultExclude, "**/src/routes/**/*.test.ts", "./client.e2e.test.ts", "./e2e/**"],
    poolOptions: {
      workers: {
        // This Worker's Durable Object uses SQLite alarms. Per-test storage snapshots
        // currently trip over the SQLite sidecar files on CI, so these tests share
        // a single storage instance and reset visible state in hooks instead.
        isolatedStorage: false,
        wrangler: {
          configPath: wranglerConfigPath,
        },
      },
    },
    hookTimeout: 60_000,
    testTimeout: 45_000,
  },
});
