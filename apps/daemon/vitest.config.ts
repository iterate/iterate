import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    environment: "jsdom",
    include: [
      "server/**/*.test.ts",
      "client/**/*.test.ts",
      "client/**/*.test.tsx",
      "scripts/**/*.test.ts",
    ],
    testTimeout: 30_000,
    passWithNoTests: true,
  },
});
