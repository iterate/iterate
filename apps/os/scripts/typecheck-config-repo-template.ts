// Typechecks the seeded config-repo template: the repo-root program
// (worker.ts + modules it imports) and every modular app under
// config-repo-template/apps that ships a tsconfig — the same programs a
// seeded project's editor sees. Dependency resolution walks up to
// apps/os/node_modules, so `iterate` resolves to the workspace-linked
// packages/iterate SOURCE (this branch's types, not a published build).
// createApp browser pairs (todo/guestbook) stay out of this pass unless they
// add a tsconfig; modular createWorker apps MUST have one.
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const templateRoot = path.resolve(root, "config-repo-template");
const appsRoot = path.resolve(templateRoot, "apps");

/** Apps built as separate createWorker entrypoints — each needs a tsconfig. */
const requiredModularApps = ["hello", "internal", "counter", "review-bot"];

const projects = [
  templateRoot,
  ...readdirSync(appsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.resolve(appsRoot, entry.name)),
];

let failed = false;
for (const required of requiredModularApps) {
  const dir = path.resolve(appsRoot, required);
  if (!existsSync(path.resolve(dir, "tsconfig.json"))) {
    console.error(
      `apps/${required}: missing tsconfig.json — modular template apps must be typecheckable`,
    );
    failed = true;
  }
}

for (const project of projects) {
  const label = path.relative(root, project);
  if (!existsSync(path.resolve(project, "tsconfig.json"))) {
    // Optional: createApp browser pairs may omit a tsconfig.
    continue;
  }
  const result = spawnSync("pnpm", ["exec", "tsc", "-p", project, "--noEmit"], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`${label}: typecheck failed`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log("config-repo-template typecheck ok");
