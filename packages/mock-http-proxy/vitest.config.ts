import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "e2e",
          environment: "node",
          include: ["e2e-tests/**/*.test.ts"],
        },
      },
    ],
  },
});
