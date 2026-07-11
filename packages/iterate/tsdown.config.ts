import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/index.ts", "src/stream-tui/agent-chat-terminal.tsx"],
    format: "esm",
    dts: {
      resolver: "tsc",
    },
    sourcemap: true,
  },
  {
    // No dts here: the generated itx contract crashes rolldown-plugin-dts's
    // babel printer (getter signatures). Declarations come from
    // `tsc -p tsconfig.sdk.json` in the build script instead.
    entry: ["src/sdk.ts"],
    format: "esm",
    deps: {
      neverBundle: ["cloudflare:workers"],
    },
    dts: false,
    sourcemap: true,
    clean: false,
  },
  {
    entry: ["src/worker.ts"],
    format: "esm",
    deps: {
      neverBundle: ["cloudflare:workers"],
    },
    dts: false,
    sourcemap: true,
    clean: false,
    copy: [{ from: "src/worker.d.mts", to: "dist" }],
  },
]);
