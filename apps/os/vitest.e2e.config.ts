import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.e2e.ts"],
    testTimeout: 120_000, // unfortunately evalite reads from this config and isn't configurable. might be possible to run via vanilla vitest some day.
    provide: {
      vitestBatchId: `batch-${Date.now()}`,
    },
    outputFile: { html: "e2e-ignoreme/index.html" },
    watch: false,
    fileParallelism: false, // while we're on step 1 of "make it work, make it right, make it fast"
  },
});

declare module "vitest" {
  export interface ProvidedContext {
    vitestBatchId: string;
    cwd: string;
  }
}
