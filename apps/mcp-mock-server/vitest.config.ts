import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    alias: {
      "cloudflare:workers": "agents/mock-cloudflare-workers",
    },
  },
});
