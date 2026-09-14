import { defineConfig } from "tsdown";

// Two entries, one ordinary library build. `.` is what a project worker, the
// voicelab CLI, and the mobile app import: refs, the installer, VoiceAgentApp,
// types — nothing that runs the agent. `./worker` is the agent, which a
// config repo's voice-agent.ts re-exports and the platform bundles like any
// other file in the repo, resolving `iterate` and `zod` from the repo's own
// package.json. So both stay external here, as every dependency does; only
// Cloudflare's runtime API is named because it is not a package at all.
//
// No dts: rolldown-plugin-dts's printer crashes on function types inside
// interfaces (the same limitation packages/iterate documents for its sdk
// entry); `tsc -p tsconfig.dts.json` emits the declarations instead.
export default defineConfig({
  entry: { index: "src/index.ts", worker: "src/worker.ts" },
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
    neverBundle: ["cloudflare:workers"],
  },
  dts: false,
  sourcemap: true,
});
