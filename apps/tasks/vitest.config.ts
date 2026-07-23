import { defineConfig } from "vitest/config";

// Standalone on purpose: vite.config.ts wires the Cloudflare workerd runner,
// which the pure unit tests neither need nor survive.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
