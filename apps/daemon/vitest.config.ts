import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    environment: "jsdom",
    include: [
      "server/**/*.test.ts",
      "server/**/*.test.tsx",
      "client/**/*.test.ts",
      "client/**/*.test.tsx",
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
    ],
    testTimeout: 30_000,
    passWithNoTests: true,
  },
});
