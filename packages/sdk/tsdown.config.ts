import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./src/sdk.ts"],
  outDir: "./dist",
  format: "esm",
  dts: true,
});
