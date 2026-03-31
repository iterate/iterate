import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultExclude, defineConfig } from "vitest/config";

const appRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "~": resolve(appRoot, "src"),
    },
  },
  test: {
    exclude: [...defaultExclude, "**/src/routes/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 45_000,
  },
});
