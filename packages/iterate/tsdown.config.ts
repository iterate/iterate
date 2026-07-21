import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/index.ts", "src/stream-tui/agent-chat-terminal.tsx"],
    format: "esm",
    // The CLI + TUI are STANDALONE PROCESS artifacts (bin/iterate spawns the
    // TUI as its own bun process; nothing imports these files in-process). The
    // TUI carries its own private copy of the keeper — module-state sharing
    // with the library entries is a non-goal across process boundaries — but
    // react/react-query must stay EXTERNAL here: @opentui/react (the renderer,
    // also external) owns the hook dispatcher, and an inlined react is a
    // second copy → invalid-hook-call at first render (proven by the PTY
    // spec). Their runtime presence comes from being real dependencies; the
    // peer declaration is what makes a consuming app's copy win.
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
    // The stream-processor machinery + its node test harness. Worker-targeted
    // (the registry imports cloudflare:workers tracing), so cloudflare:*
    // stays external; zod/capnweb are ordinary dependencies and stay external
    // like every library entry. No module-state sharing with the client
    // entries (the shared live-state modules are stateless codecs), so a
    // separate config object is safe. No dts for the sdk reason above.
    entry: {
      processors: "src/processors/index.ts",
      "processors-cloudflare": "src/processors/cloudflare.ts",
      "processors-testing": "src/processors/testing.ts",
    },
    format: "esm",
    deps: {
      neverBundle: ["cloudflare:workers"],
    },
    dts: false,
    sourcemap: true,
    clean: false,
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
    entry: {
      client: "src/client.ts",
      "live-state": "src/live-state/index.ts",
      "live-state-react": "src/live-state/react.tsx",
      node: "src/node.ts",
      react: "src/react.ts",
    },
    format: "esm",
    dts: false,
    sourcemap: true,
    clean: false,
  },
]);
