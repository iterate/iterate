import { defineConfig } from "tsdown";

// The `iterate` bin's build. The SDK (`iterate/*`) stays a dependency, never bundled.
export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: "esm",
  fixedExtension: true,
  platform: "node",
  target: "node22",
  dts: false,
  sourcemap: true,
  clean: true,
});
