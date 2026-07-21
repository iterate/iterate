// Typechecks the seeded config-repo template: the repo-root program
// (worker.ts + modules it imports) and every app under
// config-repo-template/apps against its own tsconfig — the same programs a
// seeded project's editor sees. Dependency resolution walks up to
// apps/os/node_modules, so `iterate` resolves to the workspace-linked
// packages/iterate SOURCE (this branch's types, not a published build).
// Every app directory MUST ship a tsconfig — a new app cannot silently opt
// out of CI typechecking.
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const templateRoot = path.resolve(root, "config-repo-template");
const appsRoot = path.resolve(templateRoot, "apps");

const projects = [
  templateRoot,
  ...readdirSync(appsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.resolve(appsRoot, entry.name)),
];

let failed = false;
for (const project of projects) {
  const label = path.relative(root, project);
  if (!existsSync(path.resolve(project, "tsconfig.json"))) {
    console.error(`${label}: missing tsconfig.json — every template app must be typecheckable`);
    failed = true;
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
