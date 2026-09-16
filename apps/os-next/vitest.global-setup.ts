// vitest.global-setup.ts — the build the workers, e2e and bench lanes need before they run: THE VITE
// BUILD (dist/server/index.js + wrangler.json, dist/client — the worker a deploy ships, the console's
// Start server entry resolved inside it). The unit lane needs nothing built: the SDK the host injects
// is a virtual module every project resolves (scripts/vite-plugin-processor-sdk.ts).
import { execSync } from "node:child_process";
import type { TestProject } from "vitest/node";

const NEEDS_VITE_BUILD = new Set(["workers", "e2e", "bench"]);

export default function setup(project: TestProject): void {
  const lanes = project.vitest.projects.map((lane) => lane.name);
  if (!lanes.some((lane) => NEEDS_VITE_BUILD.has(lane))) return;
  execSync("pnpm exec vite build", { cwd: import.meta.dirname, stdio: "inherit" });
}
