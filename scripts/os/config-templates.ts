// scripts/os/config-templates.ts — ITERATE'S PROJECT TEMPLATES (configs/*) AS THE PLATFORM'S BUILD
// TAKES THEM (core/os/scripts/build.ts `ConfigTemplate`): what os.iterate.com, a preview and the test
// suites offer a creation. Each template is its tracked files (not the node_modules/ an `npm install`
// for a local `tsc` leaves there), its agents and voice at this checkout's pkg.pr.new build, never
// `@main`, which moves, under its GitHub reference at this checkout's commit.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pkgPrNewVersion } from "iterate/pkg-pr-new";
import type { ConfigTemplate } from "../../core/os/scripts/build.ts";
import { checkoutPublishedPackageCommit } from "./published-package-commit.ts";

export function configTemplates(repoRoot: string): ConfigTemplate[] {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  // this checkout's build of the packages, worked out only when a template names `@main`
  let packagesCommit: string | undefined;
  const configs = path.join(repoRoot, "configs");
  return readdirSync(configs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      reference: `github:iterate/iterate#${commit.trim()}&path:configs/${entry.name}`,
      files: execFileSync("git", ["ls-files", "-z"], {
        cwd: path.join(configs, entry.name),
        encoding: "utf8",
      })
        .split("\0")
        .filter(Boolean)
        .map((file) => {
          const content = readFileSync(path.join(configs, entry.name, file), "utf8");
          if (file !== "package.json") return { path: file, content };
          const manifest = JSON.parse(content);
          // every package of ours the template takes from pkg.pr.new's moving `@main`; `iterate`
          // itself is not one: the loader links it to the deployment's own build
          const ours = Object.entries<string>(manifest.dependencies || {}).flatMap(
            ([dependency, version]) =>
              dependency.startsWith("@iterate-com/") &&
              /^https:\/\/pkg\.pr\.new\/.*@main$/.test(version)
                ? [dependency]
                : [],
          );
          if (!ours.length) return { path: file, content };
          packagesCommit ||= checkoutPublishedPackageCommit(repoRoot, process.env.PREVIEW_HEAD_SHA);
          for (const dependency of ours)
            manifest.dependencies[dependency] = pkgPrNewVersion(dependency, packagesCommit);
          return { path: file, content: `${JSON.stringify(manifest, null, 2)}\n` };
        }),
    }));
}
