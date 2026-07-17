import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/index.ts", "src/stream-tui/agent-chat-terminal.tsx"],
    format: "esm",
    // The CLI + TUI are STANDALONE PROCESS artifacts (bin/iterate spawns the
    // TUI as its own bun process; nothing imports these files in-process), so
    // this bundle is deliberately self-contained: react + react-query inline
    // here (they are peers for the library entries, where the consumer's app
    // must own the one copy), and the TUI carries its own private copy of the
    // keeper — module-state sharing with the library entries is a non-goal
    // across process boundaries.
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
    // The itx client LIBRARY entries. ONE config object on purpose: rolldown
    // splits their shared modules (the session keeper, live-state) into common
    // chunks, so every importable entry shares ONE keeper module instance in
    // the published artifact — separate objects would inline a private copy
    // each and fork the one-socket module state. (The TUI bundle above is the
    // deliberate exception: a spawned-process artifact, never imported.) No
    // dts here for the same reason as sdk (the generated contract crashes
    // rolldown-plugin-dts); declarations come from `tsc -p tsconfig.sdk.json`.
    entry: ["src/client.ts", "src/live-state.ts", "src/node.ts", "src/react.ts"],
    format: "esm",
    dts: false,
    sourcemap: true,
    clean: false,
  },
]);
