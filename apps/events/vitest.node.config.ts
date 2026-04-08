import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["./src/durable-objects/dynamic-worker-bundler.test.ts"],
  },
});
