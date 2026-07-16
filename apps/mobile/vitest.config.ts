import { defineConfig } from "vitest/config";

// Only the pure-TS pieces (chat reducer, path/slug helpers) run here — this is
// what root `pnpm test` picks up. The live chat round-trip against a real
// deployment is the separate opt-in lane: `pnpm test:e2e`
// (vitest.e2e.config.ts), excluded here because it needs a running server and
// credentials.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.e2e.test.ts"],
    environment: "node",
  },
});
