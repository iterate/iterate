// Typechecks the seeded config-repo template: the repo-root program
// (worker.ts + modules it imports) and every modular app under
// config-repo-template/apps — the same programs a seeded project's editor
// sees. Dependency resolution walks up to apps/os/node_modules, so `iterate`
// resolves to the workspace-linked packages/iterate SOURCE (this branch's
// types, not a published build).
//
// The rule is structural, not a name list: an app with a `src/` directory is
// a modular createWorker app and MUST ship a tsconfig — a new app cannot
// silently opt out of CI typechecking. createApp browser pairs (flat
// client.tsx/server.tsx whose clients import React from esm.sh URLs tsc
// cannot resolve) stay out unless they add a tsconfig of their own.
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
    if (existsSync(path.resolve(project, "src"))) {
      console.error(
        `${label}: missing tsconfig.json — modular template apps must be typecheckable`,
      );
      failed = true;
    }
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
