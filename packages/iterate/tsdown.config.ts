import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/stream-tui/event-stream-terminal.tsx"],
  format: "esm",
  dts: {
    resolver: "tsc",
  },
  sourcemap: true,
});
