import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: ["probe.spec.ts", "controls.spec.ts"],
  fullyParallel: true,
  workers: 2,
  retries: 1,
  timeout: 15_000,
  outputDir: "./results.ignoreme",
  reporter: [["list"]],
  use: { browserName: "chromium", headless: true, trace: "off" },
});
