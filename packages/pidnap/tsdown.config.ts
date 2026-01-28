import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    cli: "./src/cli.ts",
    index: "./src/index.ts",
    client: "./src/api/client.ts",
  },
  format: "esm",
  target: "esnext",
  dts: true,
});
