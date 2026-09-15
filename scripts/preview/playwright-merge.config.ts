import { defineConfig } from "@playwright/test";

// Shards already recorded telemetry and flakes. Merging must not emit them twice.
export default defineConfig({
  reporter: [
    ["html", { outputFolder: "test-results/playwright-html", open: "never" }],
    ["json", { outputFile: "test-results/playwright-results.json" }],
  ],
});
