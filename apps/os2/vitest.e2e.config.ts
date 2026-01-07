import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.e2e.ts"],
    testTimeout: 120_000,
    watch: false,
    fileParallelism: false,
    reporters: ["verbose"],
    globalSetup: ["./e2e/global-setup.ts"],
  },
});
