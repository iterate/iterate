import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./sdk/index.ts"],
  outDir: "./dist",
  format: "esm",
  dts: true,
});
