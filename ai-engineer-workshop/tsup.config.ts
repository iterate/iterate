import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "cli.ts",
    contract: "contract.ts",
    sdk: "sdk.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  dts: {
    resolve: true,
  },
  sourcemap: true,
  bundle: true,
  splitting: false,
  shims: false,
  noExternal: [/^@iterate-com\//],
});
