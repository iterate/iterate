import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globals: true,
    include: ["./*.test.ts"],
    exclude: ["./client.e2e.test.ts", "./live-e2e.test.ts"],
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
  },
});
