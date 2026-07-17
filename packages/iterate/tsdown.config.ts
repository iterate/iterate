import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/index.ts", "src/stream-tui/agent-chat-terminal.tsx"],
    format: "esm",
    // react + react-query are PEERS for the library entries (the consumer's
    // app must own one copy), but the published CLI/TUI is its own process and
    // must not depend on a package manager auto-installing peers — inline them
    // into this bundle only.
    deps: {
      alwaysBundle: ["react", "@tanstack/react-query"],
    },
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
  {
    // The itx client entries. ONE config object on purpose: rolldown splits
    // their shared modules (the session keeper, live-state) into common chunks,
    // so `iterate/client` and `iterate/react` share ONE keeper module instance
    // in the published artifact — separate objects would inline a private copy
    // each and fork the one-socket module state. No dts here for the same
    // reason as sdk (the generated contract crashes rolldown-plugin-dts);
    // declarations come from `tsc -p tsconfig.sdk.json`.
    entry: ["src/client.ts", "src/node.ts", "src/react.ts"],
    format: "esm",
    dts: false,
    sourcemap: true,
    clean: false,
  },
]);
