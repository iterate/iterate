import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("../..", import.meta.url).href);

export default defineConfig({
  test: {
    include: ["./src/stream-processors/**/*.type.test.ts"],
    typecheck: {
      checker: "tsc",
      enabled: true,
      only: true,
      include: ["./src/stream-processors/**/*.type.test.ts"],
      tsconfig: "./src/stream-processors/tsconfig.type-tests.json",
    },
  },
  root,
});
