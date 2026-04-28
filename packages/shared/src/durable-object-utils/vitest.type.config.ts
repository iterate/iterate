import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("../..", import.meta.url).href);

export default defineConfig({
  test: {
    include: ["./src/durable-object-utils/**/*.type.test.ts"],
    typecheck: {
      checker: "tsc",
      enabled: true,
      only: true,
      include: ["./src/durable-object-utils/**/*.type.test.ts"],
      tsconfig: "./src/durable-object-utils/tsconfig.type-tests.json",
    },
  },
  root,
});
