import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/index.ts", "src/stream-tui/agent-chat-terminal.tsx"],
    format: "esm",
    dts: {
      resolver: "tsc",
    },
    sourcemap: true,
    // The native half of `iterate approve` ships as Swift source, compiled
    // on the user's Mac on first use (see approval-keys.ts).
    copy: [{ from: "src/enclave-approver.swift", to: "dist" }],
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
    // Browser/server code inside OS imports the exact processor layer it
    // needs, while project workers use the combined virtual `iterate/sdk`
    // entry above. Keeping these as separate entries prevents a browser-side
    // schema import from pulling in the Workers-only base classes.
    entry: [
      "src/durable-object-processor-durability.ts",
      "src/live-state.ts",
      "src/live-state-diff.ts",
      "src/live-state-protocol.ts",
      "src/processor-contracts.ts",
      "src/processor-host-capabilities.ts",
      "src/rpc-retain.ts",
      "src/stream-events.ts",
      "src/stream-processor.ts",
      "src/stream-processor-keepalive.ts",
      "src/stream-processor-registry.ts",
      "src/stream-processor-revival.ts",
      "src/stream-processor-runner.ts",
      "src/stream-runtime-metrics.ts",
      "src/subscriber-metrics.ts",
    ],
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
