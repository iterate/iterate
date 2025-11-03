import { join } from "node:path";
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./sdk/index.ts"],
  outDir: "dist/sdk",
  format: "esm",
  dts: {
    resolve: ["type-fest"],
  },
  clean: true,
  sourcemap: false,
  nodeProtocol: true,
  treeshake: { moduleSideEffects: false },
  copy: [
    {
      from: "dist/sdk",
      to: join(import.meta.dirname, "../../packages/sdk/dist"),
    },
  ],
});
