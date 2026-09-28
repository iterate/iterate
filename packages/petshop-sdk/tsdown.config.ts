import { defineConfig } from "tsdown";

// One neutral ES module and its declarations; capnweb stays a dependency, resolved by the consumer.
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: "esm",
  fixedExtension: true,
  platform: "neutral",
  target: "es2022",
  dts: true,
  clean: true,
});
