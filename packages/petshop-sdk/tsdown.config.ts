import { defineConfig } from "tsdown";

// One neutral ES module (tsconfig.build.json emits its declarations); capnweb stays a dependency, resolved by the consumer.
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: "esm",
  fixedExtension: true,
  platform: "neutral",
  target: "es2022",
  dts: false,
  clean: true,
});
