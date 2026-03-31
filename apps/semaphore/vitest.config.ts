import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultExclude } from "vitest/config";

const appRoot = fileURLToPath(new URL(".", import.meta.url));

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
          configPath: "./wrangler.jsonc",
        },
      },
    },
    hookTimeout: 60_000,
    testTimeout: 45_000,
  },
});
