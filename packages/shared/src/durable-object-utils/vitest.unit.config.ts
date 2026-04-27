import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defaultExclude, defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("../..", import.meta.url).href);
const wranglerConfigPath = resolve(
  root,
  ".wrangler",
  "durable-object-utils-vitest",
  "wrangler.jsonc",
);

mkdirSync(resolve(root, ".wrangler", "durable-object-utils-vitest"), { recursive: true });
writeFileSync(
  wranglerConfigPath,
  JSON.stringify(
    {
      name: "shared-durable-object-utils-vitest",
      main: "./src/durable-object-utils/test-harness/initialize-fronting-worker.ts",
      compatibility_date: "2026-04-01",
      durable_objects: {
        bindings: [
          {
            name: "ROOMS",
            class_name: "InitializeTestRoom",
          },
          {
            name: "INSPECTORS",
            class_name: "InspectorTestRoom",
          },
          {
            name: "LISTED_ROOMS",
            class_name: "ListedRoom",
          },
        ],
      },
      d1_databases: [
        {
          binding: "DO_LISTINGS",
          database_id: "durable-object-utils-listings-test",
          database_name: "durable-object-utils-listings-test",
          preview_database_id: "durable-object-utils-listings-test",
        },
      ],
      migrations: [
        {
          tag: "v1",
          new_sqlite_classes: ["InitializeTestRoom", "InspectorTestRoom", "ListedRoom"],
        },
      ],
    },
    null,
    2,
  ),
);

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/durable-object-utils/test-harness/initialize-fronting-worker.ts",
      wrangler: {
        configPath: wranglerConfigPath,
      },
    }),
  ],
  test: {
    include: ["./src/durable-object-utils/**/*.unit.test.ts"],
    exclude: [...defaultExclude],
    hookTimeout: 60_000,
    testTimeout: 45_000,
  },
  root,
});
