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
    // The sdk + stream-processor machinery + its node test harness, ONE
    // config object on purpose: sdk.ts hosts createProcessorHost, which
    // constructs the registry/runner over processor instances built from the
    // `iterate/processors` entry — rolldown must split that machinery into
    // shared chunks so all four entries hold ONE StreamProcessor class.
    // Separate objects would inline private copies, and the runner's static
    // driver touches processor PRIVATE FIELDS, which throw across class
    // copies ("Receiver must be an instance of class anonymous" from a live
    // guestbook). Worker-targeted (the registry imports cloudflare:workers
    // tracing), so cloudflare:* stays external; zod/capnweb are ordinary
    // dependencies and stay external like every library entry. No dts: the
    // generated itx contract crashes rolldown-plugin-dts's babel printer
    // (getter signatures); declarations come from `tsc -p tsconfig.sdk.json`
    // in the build script instead.
    entry: {
      sdk: "src/sdk.ts",
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
      node: "src/node.ts",
      "sdk/capnweb": "src/sdk/capnweb/index.ts",
      "sdk/capnweb/react": "src/sdk/capnweb/react.tsx",
      "sdk/itx/react": "src/sdk/itx/react.ts",
      // Self-contained codec; shares no modules with the entries above, so
      // joining this group adds no chunk coupling. Declarations come from the
      // tsconfig.sdk.json tsc pass like the rest of the group.
      "annotated-markdown": "src/annotated-markdown/index.ts",
    },
    format: "esm",
    dts: false,
    sourcemap: true,
    clean: false,
  },
]);
