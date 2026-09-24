import { defineConfig } from "vitest/config";

// Its own config so Vitest does not load vite.config.ts, whose Cloudflare plugin would start a Worker.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
