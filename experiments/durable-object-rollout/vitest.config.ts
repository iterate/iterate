import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ["rollout.e2e.test.ts"],
    environment: "node",
    retry: 0,
    // Deploys, requests and polling already have bounds. Let disposal finish cloud cleanup
    // instead of interrupting the experiment with Vitest's default five-second timeout.
    testTimeout: 0,
  },
});
