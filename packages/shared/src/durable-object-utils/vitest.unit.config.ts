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
            name: "ALARM_ROOMS",
            class_name: "AlarmTestRoom",
          },
          {
            name: "ALARM_FORWARDING_ROOMS",
            class_name: "AlarmForwardingTestRoom",
          },
          {
            name: "SCHEDULE_ROOMS",
            class_name: "SchedulerTestRoom",
          },
          {
            name: "INSPECTORS",
            class_name: "InspectorTestRoom",
          },
          {
            name: "LISTED_ROOMS",
            class_name: "ListedRoom",
          },
          {
            name: "PUBLIC_ROUTE_ROOMS",
            class_name: "PublicRouteTestRoom",
          },
          {
            name: "APP_CONFIG_ROOMS",
            class_name: "AppConfigTestRoom",
          },
          {
            name: "HIBERNATING_WEBSOCKET_ROOMS",
            class_name: "HibernatingWebSocketTestRoom",
          },
          {
            name: "DURABLE_OBJECT_VIEW_ROOMS",
            class_name: "DurableObjectViewTestRoom",
          },
        ],
      },
      vars: {
        APP_CONFIG: JSON.stringify({
          serviceName: "base-service",
          feature: {
            enabled: false,
            limit: 4,
          },
          integrations: {
            posthog: {
              projectApiKey: "base-posthog-key",
              captureEndpoint: "https://base.example.com/capture",
              sampling: {
                enabled: false,
                rate: 0.25,
              },
            },
          },
          limits: {
            queue: {
              maxBatchSize: 10,
              tags: ["base"],
            },
          },
        }),
        APP_CONFIG_SERVICE_NAME: "override-service",
        APP_CONFIG_FEATURE__ENABLED: "true",
        APP_CONFIG_INTEGRATIONS__POSTHOG__PROJECT_API_KEY: "override-posthog-key",
        APP_CONFIG_INTEGRATIONS__POSTHOG__SAMPLING: JSON.stringify({
          enabled: true,
          rate: 0.5,
        }),
        APP_CONFIG_LIMITS__QUEUE: JSON.stringify({
          maxBatchSize: 25,
          tags: ["override", "nested"],
        }),
      },
      d1_databases: [
        {
          binding: "DO_CATALOG",
          database_id: "durable-object-utils-catalog-test",
          database_name: "durable-object-utils-catalog-test",
          preview_database_id: "durable-object-utils-catalog-test",
        },
      ],
      migrations: [
        {
          tag: "v1",
          new_sqlite_classes: [
            "InitializeTestRoom",
            "AlarmTestRoom",
            "AlarmForwardingTestRoom",
            "SchedulerTestRoom",
            "InspectorTestRoom",
            "ListedRoom",
            "PublicRouteTestRoom",
            "AppConfigTestRoom",
            "HibernatingWebSocketTestRoom",
            "DurableObjectViewTestRoom",
          ],
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
    // KNOWN_RRULE_SOURCEMAP_WARNING: `rrule@2.8.1` ships sourcemap references
    // to source files that are not included in the published package. Vite
    // prints noisy warnings during this suite. Leave test behavior untouched
    // here unless we decide to solve it at a broader tooling boundary.
    testTimeout: 45_000,
  },
  root,
});
