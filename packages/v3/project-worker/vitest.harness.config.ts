// The HARNESS lane: node-pool vitest booting the real worker via wrangler createTestHarness
// (__tests__/harness.ts). Separate config on purpose — the unit lane (vitest.config.ts) stays
// fast; run this one with `pnpm test:harness`.
import { defineConfig } from "vitest/config";
import capnwebValidate from "capnweb-validate/vite";

export default defineConfig({
  plugins: [capnwebValidate()],
  test: {
    include: ["__tests__/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // one worker: each file boots its own workerd; parallel boots thrash the port + CPU
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
