// vitest.global-setup.ts — the build the workers, e2e and bench projects need before they run: THE
// VITE BUILD (dist/server/index.js + wrangler.json, dist/client — the worker a deploy ships, the
// console's Start server entry resolved inside it). The unit project needs nothing built: the SDK the
// host injects is a virtual module every project resolves (scripts/vite-plugin-processor-sdk.ts).
import { execSync } from "node:child_process";
import type { TestProject } from "vitest/node";

const NEEDS_VITE_BUILD = new Set(["workers", "e2e", "bench"]);

export default function setup(project: TestProject): void {
  const names = project.vitest.projects.map((candidate) => candidate.name);
  if (!names.some((name) => NEEDS_VITE_BUILD.has(name))) return;
  execSync("pnpm exec vite build", { cwd: import.meta.dirname, stdio: "inherit" });
}
