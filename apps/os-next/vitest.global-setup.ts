// vitest.global-setup.ts — the builds the lanes need before they run. Every lane: src/generated/* (the
// processor SDK bundle the host injects into every loaded isolate; gitignored — build-sdk.mjs writes
// only when the content changed, so a no-op rebuild leaves the watched `src` untouched). The workers
// and e2e lanes: THE VITE BUILD (dist/server/index.js + wrangler.json, dist/client — the
// worker a deploy ships, the console's Start server entry resolved inside it), which runs build-sdk
// itself (vite.config.ts) — so a run that includes either lane builds once here, and a unit-only run
// pays only the SDK bundle.
import { execSync } from "node:child_process";
import type { TestProject } from "vitest/node";

const NEEDS_VITE_BUILD = new Set(["workers", "e2e", "bench"]);

export default function setup(project: TestProject): void {
  const lanes = project.vitest.projects.map((lane) => lane.name);
  const command = lanes.some((lane) => NEEDS_VITE_BUILD.has(lane))
    ? "pnpm exec vite build"
    : "node build-sdk.mjs";
  execSync(command, { cwd: import.meta.dirname, stdio: "inherit" });
}
