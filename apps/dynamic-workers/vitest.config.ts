import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const appRoot = fileURLToPath(new URL(".", import.meta.url).toString());
const wranglerConfigPath = resolve(appRoot, ".wrangler", "vitest", "wrangler.jsonc");

mkdirSync(resolve(appRoot, ".wrangler", "vitest"), { recursive: true });
writeFileSync(
  wranglerConfigPath,
  JSON.stringify(
    {
      name: "dynamic-worker-sqlite-test",
      main: "src/entry.vitest.ts",
      compatibility_date: "2026-02-05",
      durable_objects: {
        bindings: [
          {
            name: "DYNAMIC_WORKER_DO",
            class_name: "DynamicWorkerDO",
          },
        ],
      },
      migrations: [
        {
          tag: "v1",
          new_sqlite_classes: ["DynamicWorkerDO"],
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
      main: "./src/entry.vitest.ts",
      wrangler: {
        configPath: wranglerConfigPath,
      },
    }),
  ],
  resolve: {
    alias: {
      "~": resolve(appRoot, "src"),
    },
  },
  test: {
    globals: true,
    include: ["./src/**/*.test.ts"],
    testTimeout: 45_000,
    hookTimeout: 60_000,
  },
});
