import alchemy from "alchemy";
import { WranglerJson } from "alchemy/cloudflare";

process.env.ALCHEMY_CI_STATE_STORE_CHECK ??= "false";

const compatibilityDate = "2025-02-24";
const testDatabaseId = "00000000-0000-0000-0000-000000000000";

const app = await alchemy("semaphore");

await WranglerJson({
  path: "./wrangler.jsonc",
  worker: {
    name: "semaphore-test",
    entrypoint: "./server.ts",
    compatibilityDate,
    bindings: {
      DB: {
        type: "d1",
        id: testDatabaseId,
        name: "semaphore-test",
        migrationsDir: "./migrations",
        dev: {
          id: testDatabaseId,
          remote: false,
        },
      },
      RESOURCE_COORDINATOR: {
        type: "durable_object_namespace",
        className: "ResourceCoordinator",
        sqlite: true,
      },
      SEMAPHORE_API_TOKEN: "test-token",
    },
  },
  secrets: false,
});

await app.finalize({ noop: true });
