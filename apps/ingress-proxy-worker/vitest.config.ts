import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["./proxy.test.ts"],
    environment: "node",
  },
});
