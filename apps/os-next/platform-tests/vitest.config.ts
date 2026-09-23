import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["native-rpc-facet-reuse.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    passWithNoTests: false,
  },
});
