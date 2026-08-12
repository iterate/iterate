import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

const guestbookClientSource = readFileSync(
  new URL("./dist/starter-apps/guestbook/client.mjs", import.meta.url),
  "utf8",
);
const todoClientSource = readFileSync(
  new URL("./dist/starter-apps/todo/client.mjs", import.meta.url),
  "utf8",
);

const appClientSourcePlugin = {
  name: "app-client-sources",
  resolveId(source: string) {
    if (source === "iterate:guestbook-client-source") {
      return "\0iterate:guestbook-client-source";
    }
    if (source === "iterate:todo-client-source") return "\0iterate:todo-client-source";
  },
  load(id: string) {
    if (id === "\0iterate:guestbook-client-source") {
      return `export default ${JSON.stringify(guestbookClientSource)};`;
    }
    if (id !== "\0iterate:todo-client-source") return;
    return `export default ${JSON.stringify(todoClientSource)};`;
  },
};

export default defineConfig([
  {
    // These physical app workers carry their Durable Objects, persistence,
    // Cap'n Web servers, and separately prebuilt browser clients. Config
    // supplies only package.json so worker-bundler can resolve these files.
    entry: {
      "starter-apps/guestbook/configured-worker": "src/starter-apps/guestbook/configured-worker.ts",
      "starter-apps/media/configured-worker": "src/starter-apps/media/configured-worker.ts",
      "starter-apps/notes/configured-worker": "src/starter-apps/notes/configured-worker.ts",
      "starter-apps/todo/configured-worker": "src/starter-apps/todo/configured-worker.ts",
    },
    format: "esm",
    fixedExtension: true,
    platform: "neutral",
    target: "es2022",
    plugins: [appClientSourcePlugin],
    inputOptions: {
      resolve: {
        conditionNames: ["workerd", "worker", "import", "default"],
      },
    },
    deps: {
      alwaysBundle: ["@iterate-com/capnweb", "sqlfu", "zod"],
      neverBundle: ["cloudflare:workers"],
    },
    dts: false,
    sourcemap: true,
    clean: false,
  },
  {
    // The dynamic worker host installs the config repo's dependencies, not
    // transitive dependencies inside iterate's tarball. This physical entry
    // therefore carries its complete runtime graph; only Cloudflare's API and
    // the per-install virtual config remain external.
    entry: {
      "starter-apps/github-ai-linter/configured-worker":
        "src/starter-apps/github-ai-linter/configured-worker.ts",
    },
    format: "esm",
    fixedExtension: true,
    platform: "neutral",
    target: "es2022",
    inputOptions: {
      resolve: {
        conditionNames: ["workerd", "worker", "import", "default"],
      },
    },
    deps: {
      alwaysBundle: ["@iterate-com/capnweb", "yaml", "zod"],
      neverBundle: ["cloudflare:workers", "iterate:github-ai-linter-config"],
      onlyBundle: ["@iterate-com/capnweb", "yaml", "zod"],
    },
    dts: false,
    sourcemap: true,
    clean: false,
  },
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
    clean: false,
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
      "starter-apps/github-ai-linter/index": "src/starter-apps/github-ai-linter/index.ts",
      "starter-apps/github-ai-linter/worker": "src/starter-apps/github-ai-linter/worker.ts",
      "starter-apps/guestbook/index": "src/starter-apps/guestbook/index.ts",
      "starter-apps/guestbook/worker": "src/starter-apps/guestbook/worker.ts",
      "starter-apps/media/index": "src/starter-apps/media/index.ts",
      "starter-apps/media/ref": "src/starter-apps/media/ref.ts",
      "starter-apps/media/worker": "src/starter-apps/media/worker.ts",
      "starter-apps/notes/index": "src/starter-apps/notes/index.ts",
      "starter-apps/notes/ref": "src/starter-apps/notes/ref.ts",
      "starter-apps/notes/worker": "src/starter-apps/notes/worker.ts",
      "starter-apps/todo/index": "src/starter-apps/todo/index.ts",
      processors: "src/processors/index.ts",
      "processors-cloudflare": "src/processors/cloudflare.ts",
      "processors-testing": "src/processors/testing.ts",
    },
    format: "esm",
    plugins: [appClientSourcePlugin],
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
      // The React viewer imports the codec entry's modules — same group so
      // they share one chunk instead of inlining a second copy.
      "annotated-markdown-react": "src/annotated-markdown/react/index.ts",
    },
    format: "esm",
    dts: false,
    sourcemap: true,
    clean: false,
  },
]);
