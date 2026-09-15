import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

// Shards already recorded telemetry and flakes. Merging must not emit them twice.
export default defineConfig({
  reporter: [
    [
      "html",
      {
        outputFolder: resolve(import.meta.dirname, "../../test-results/playwright-html"),
        open: "never",
      },
    ],
    [
      "json",
      { outputFile: resolve(import.meta.dirname, "../../test-results/playwright-results.json") },
    ],
  ],
});
