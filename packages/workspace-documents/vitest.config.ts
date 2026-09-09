import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Atomic ships extensionless ESM imports; Vite resolves them as in the app.
    server: { deps: { inline: ["@atomic-editor/editor"] } },
  },
});
