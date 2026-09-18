import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ["worker-per-run.e2e.test.ts"],
    environment: "node",
    retry: 0,
    // Real deploys and disposable cleanup have their own command/request/poll bounds.
    testTimeout: 0,
    silent: false,
    reporters: ["verbose"],
  },
});
