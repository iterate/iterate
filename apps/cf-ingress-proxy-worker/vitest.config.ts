import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globals: true,
    include: ["./*.test.ts"],
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
