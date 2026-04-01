import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defaultExclude, defineConfig } from "vitest/config";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const wranglerConfigPath = resolve(appRoot, ".wrangler", "vitest", "wrangler.jsonc");

mkdirSync(resolve(appRoot, ".wrangler", "vitest"), { recursive: true });
writeFileSync(
  wranglerConfigPath,
  JSON.stringify(
    {
      name: "events",
      main: "src/entry.workerd.vitest.ts",
      compatibility_date: "2026-04-01",
      compatibility_flags: [],
      durable_objects: {
        bindings: [
          {
            name: "STREAM",
            class_name: "StreamDurableObject",
          },
          {
            name: "TEST_SCHEDULE_STREAM",
            class_name: "TestScheduleStreamDurableObject",
          },
          {
            name: "TEST_STARTUP_SCHEDULE_WARN_STREAM",
            class_name: "TestStartupScheduleWarnStreamDurableObject",
          },
          {
            name: "TEST_STARTUP_SCHEDULE_NO_WARN_STREAM",
            class_name: "TestStartupScheduleNoWarnStreamDurableObject",
          },
          {
            name: "TEST_STARTUP_SCHEDULE_EXPLICIT_FALSE_STREAM",
            class_name: "TestStartupScheduleExplicitFalseStreamDurableObject",
          },
        ],
      },
      d1_databases: [
        {
          binding: "DB",
          database_id: "f55d561e-3d7f-4e2a-91d8-9b8d6a1f5a41",
          database_name: "events-test-db",
          migrations_dir: "./drizzle",
          preview_database_id: "f55d561e-3d7f-4e2a-91d8-9b8d6a1f5a41",
        },
      ],
      migrations: [
        {
          tag: "v1",
          new_sqlite_classes: [
            "StreamDurableObject",
            "TestScheduleStreamDurableObject",
            "TestStartupScheduleWarnStreamDurableObject",
            "TestStartupScheduleNoWarnStreamDurableObject",
            "TestStartupScheduleExplicitFalseStreamDurableObject",
          ],
          new_classes: [],
        },
      ],
      vars: {
        APP_CONFIG: JSON.stringify({
          posthog: {
            apiKey: "phc_test",
          },
        }),
      },
    },
    null,
    2,
  ),
);

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/entry.workerd.vitest.ts",
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
    exclude: [...defaultExclude, "**/src/routes/**/*.test.ts", "./e2e/**"],
    hookTimeout: 60_000,
    testTimeout: 45_000,
  },
});
