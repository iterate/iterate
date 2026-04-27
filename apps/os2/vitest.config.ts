import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultExclude, defineConfig } from "vitest/config";

const appRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    // Vitest does not apply tsconfig `paths` for `~/` reliably; mirror `~/*` -> `./src/*`.
    alias: {
      "~": resolve(appRoot, "src"),
    },
  },
  test: {
    // Route `/api2/test` is implemented as `api2.test.ts` — not a Vitest file.
    exclude: [...defaultExclude, "**/src/routes/**/*.test.ts"],
    fileParallelism: false,
    pool: "forks",
    hookTimeout: 60_000,
    testTimeout: 45_000,
  },
});
