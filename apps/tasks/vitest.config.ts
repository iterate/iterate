import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Standalone on purpose: vite.config.ts wires the Cloudflare workerd runner,
// which the pure unit tests neither need nor survive.
export default defineConfig({
  resolve: {
    // Same `~` → apps/os alias the app config wires (shared collab fold).
    alias: {
      "~": fileURLToPath(new URL("../os/src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
