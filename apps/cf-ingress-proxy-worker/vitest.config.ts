import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globals: true,
    include: ["./*.test.ts"],
    exclude: ["./live-e2e.test.ts"],
    server: {
      deps: {
        inline: ["typeid-js", "uuid"],
      },
    },
    poolOptions: {
      workers: {
        wrangler: {
          configPath: "./wrangler.jsonc",
        },
      },
    },
  },
});
