import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { expect, test } from "vitest";

// The public copies (copybara/copy.bara.sky), github.com/iterate/core and iterate/packages, hold
// only some of this repository's folders, and what is written in those folders is read there.

const repoRoot = resolve(import.meta.dirname, "..");

// A relative markdown link from core/ to docs/ or test/ is dead on github.com/iterate/core. Link
// outside a copy with a github.com URL, or name the path without linking it. Fails naming each
// dead link.
test("a public copy's markdown links only to files the copy holds", () => {
  const dead: string[] = [];
  for (const copy of publicCopies()) {
    const folders = new Set(
      [...copy.sources.keys()].flatMap((path) => {
        const ancestors = [];
        for (let folder = dirname(path); folder !== "."; folder = dirname(folder))
          ancestors.push(folder);
        return ancestors;
      }),
    );
    for (const [path, source] of copy.sources) {
      // the AI linter's fixtures are rule files copied verbatim, links and all
      if (!path.endsWith(".md") || source.includes("/fixtures/")) continue;
      for (const [, href] of readFileSync(join(repoRoot, source), "utf8").matchAll(
        /\]\(([^)\s]+)\)/g,
      )) {
        if (/^([a-z]+:|#)/.test(href)) continue;
        const target = normalize(join(dirname(path), href.split("#")[0])).replace(/\/$/, "");
        if (!copy.sources.has(target) && !folders.has(target))
          dead.push(`iterate/${copy.name}: ${path} links ${href}`);
      }
    }
  }
  expect(dead).toEqual([]);
});

// On github.com/iterate/core a bare `#2922` reads as iterate/core's issue 2922, not the
// iterate/iterate PR it meant. Name the repository: iterate/iterate#2922 for a PR from before the
// move to iterate/private, iterate/private#N after it, workerd#6800 for another project's. A `#`
// and 3–5 digits with no leading zero counts, so colours (`#000`, `#171717`) pass and `#1`, far
// more often a list item than a PR, is not checked. Inside backticks it is literal text, as it is
// to GitHub. Fails naming each file, line and ref.
test("a public copy names a PR or issue as owner/repo#N, never a bare #N", () => {
  const bare: string[] = [];
  for (const copy of publicCopies()) {
    for (const source of copy.sources.values()) {
      if (source.includes("/fixtures/") || BINARY_FILE.test(source)) continue;
      readFileSync(join(repoRoot, source), "utf8")
        .split("\n")
        .forEach((line, index) => {
          for (const [ref] of line.replaceAll(/`[^`]*`/g, "").matchAll(BARE_REF))
            bare.push(`iterate/${copy.name}: ${source}:${index + 1} ${ref}`);
        });
    }
  }
  expect(bare).toEqual([]);
});

const BARE_REF = /(?<![\w/&#-])#[1-9]\d{2,4}\b/g;
const BINARY_FILE = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip|gz|wasm|bin)$/i;

/** Each public copy and every file it holds: the path in the copy → the file here it is copied
 *  from. */
function publicCopies() {
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
  return copies.map((copy) => {
    const sources = new Map<string, string>();
    for (const file of tracked) {
      if (copy.paths.some((path) => (path.endsWith("/") ? file.startsWith(path) : file === path)))
        sources.set(file, file);
      if (file.startsWith(copy.rootFiles)) sources.set(file.slice(copy.rootFiles.length), file);
    }
    return { name: copy.name, sources };
  });
}
