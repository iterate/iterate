// vitest.global-setup.ts — the ONE build every lane needs before it runs: src/generated/* (the processor
// SDK bundle the host injects into every loaded isolate; gitignored). Idempotent — build-sdk.mjs writes
// only when the content changed, so a no-op rebuild leaves the watched `src` untouched.
import { execSync } from "node:child_process";

export default function setup(): void {
  execSync("node build-sdk.mjs", { cwd: import.meta.dirname, stdio: "inherit" });
}
