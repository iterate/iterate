// Typechecks every checked-in config repository and each app-level tsconfig.
// Sources live at the repository root, outside the apps/os dependency graph,
// so each template is staged under apps/os temporarily. Resolution then walks
// up to apps/os/node_modules and reaches this branch's workspace-linked
// packages instead of a published build.
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const configsRoot = path.resolve(root, "../..", "configs");
const stagingRoot = mkdtempSync(path.resolve(root, ".config-template-typecheck-"));

try {
  const configDirectories = readdirSync(configsRoot, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  );
  let failed = false;
  for (const configDirectory of configDirectories) {
    const source = path.resolve(configsRoot, configDirectory.name);
    const staged = path.resolve(stagingRoot, configDirectory.name);
    cpSync(source, staged, { recursive: true });
    const appsRoot = path.resolve(staged, "apps");
    const projects = [
      staged,
      ...(existsSync(appsRoot)
        ? readdirSync(appsRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => path.resolve(appsRoot, entry.name))
        : []),
    ];

    for (const project of projects) {
      const label = path.relative(stagingRoot, project);
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
  }

  if (failed) process.exitCode = 1;
  else console.log("config repository templates typecheck ok");
} finally {
  rmSync(stagingRoot, { force: true, recursive: true });
}
