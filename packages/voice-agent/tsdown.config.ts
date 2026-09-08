import { defineConfig } from "tsdown";

export default defineConfig([
  {
    // The physical guest worker: the file a project's worker ref names inside
    // node_modules. The dynamic worker host installs only what the config
    // repo's package.json declares, never this package's own dependencies,
    // so the file carries its complete runtime graph — the SDK's processor
    // machinery included, the way iterate's own github-ai-linter entry does.
    // Only Cloudflare's runtime API stays external. `onlyBundle` is the
    // documented graph: an unlisted dependency reaching this bundle fails
    // the build instead of shipping unnoticed.
    entry: { "configured-worker": "src/configured-worker.ts" },
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
      alwaysBundle: ["@iterate-com/capnweb", "iterate", "yaml", "zod"],
      neverBundle: ["cloudflare:workers"],
      onlyBundle: ["@iterate-com/capnweb", "iterate", "yaml", "zod"],
    },
    dts: false,
    sourcemap: true,
    clean: false,
  },
  {
    // The library entry a project's worker.ts, the voicelab CLI, and the
    // mobile app import: worker refs, the installer, and types. Nothing in it
    // runs the agent, and its one dependency (zod, for the package.json
    // boundary) rides inside — the SDK's types would bring Cloudflare's
    // runtime types with them, which a phone does not have (ref.ts spells the
    // ref shapes locally for that reason). No dts: rolldown-plugin-dts's
    // printer crashes on function types inside interfaces; `tsc -p
    // tsconfig.dts.json` emits the declarations instead.
    entry: { index: "src/index.ts" },
    format: "esm",
    fixedExtension: true,
    platform: "neutral",
    target: "es2022",
    deps: {
      alwaysBundle: ["zod"],
      onlyBundle: ["zod"],
    },
    dts: false,
    sourcemap: true,
    clean: false,
  },
]);
