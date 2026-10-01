import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { expect, test } from "vitest";

// The public copies (copybara/copy.bara.sky) hold only their own folders, so a relative markdown
// link from core/ to docs/ or test/ is dead on github.com/iterate/core. Link outside a copy with a
// github.com URL, or name the path without linking it. Fails naming each dead link.

const repoRoot = resolve(import.meta.dirname, "..");

test("a public copy's markdown links only to files the copy holds", () => {
  const copies = [
    // copy.bara.sky's origin_files (a trailing / is a folder), and copybara/<name>/, which lands
    // at the copy's root
    {
      name: "core",
      paths: ["core/", "patches/", "tsconfig.base.json", "tsconfig.app.json", ".nvmrc", "LICENSE"],
      rootFiles: "copybara/core/",
    },
    {
      name: "packages",
      paths: ["packages/", "configs/", "LICENSE"],
      rootFiles: "copybara/packages/",
    },
  ];
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const dead: string[] = [];
  for (const copy of copies) {
    // each path in the copy → the file here it is copied from
    const sources = new Map<string, string>();
    for (const file of tracked) {
      if (copy.paths.some((path) => (path.endsWith("/") ? file.startsWith(path) : file === path)))
        sources.set(file, file);
      if (file.startsWith(copy.rootFiles)) sources.set(file.slice(copy.rootFiles.length), file);
    }
    const folders = new Set(
      [...sources.keys()].flatMap((path) => {
        const ancestors = [];
        for (let folder = dirname(path); folder !== "."; folder = dirname(folder))
          ancestors.push(folder);
        return ancestors;
      }),
    );
    for (const [path, source] of sources) {
      // the AI linter's fixtures are rule files copied verbatim, links and all
      if (!path.endsWith(".md") || source.includes("/fixtures/")) continue;
      for (const [, href] of readFileSync(join(repoRoot, source), "utf8").matchAll(
        /\]\(([^)\s]+)\)/g,
      )) {
        if (/^([a-z]+:|#)/.test(href)) continue;
        const target = normalize(join(dirname(path), href.split("#")[0])).replace(/\/$/, "");
        if (!sources.has(target) && !folders.has(target))
          dead.push(`iterate/${copy.name}: ${path} links ${href}`);
      }
    }
  }
  expect(dead).toEqual([]);
});
