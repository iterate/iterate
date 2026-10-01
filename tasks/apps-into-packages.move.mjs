// #3487's move script (apps/os -> core/os), kept here unchanged for tasks/apps-into-packages.md.
// Before running it for that task: replace FILE_MOVES and dirMoves with the task's table, and let it
// rewrite open task files (it skips all of tasks/; only tasks/complete/ is history).
//
// Moves apps/os to core/os, configs/ to core/configs/ and two scripts/lib helpers into core/os/scripts,
// recomputing relative imports and markdown links from each file's new place, and rewriting
// repo-root path mentions.
// Run from the repo root: node move.mjs [--dry]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";

const dry = process.argv.includes("--dry");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" });

const FILE_MOVES = {
  "scripts/lib/vite-build.ts": "core/os/scripts/vite-build.ts",
  "scripts/lib/wrangler-config.ts": "core/os/scripts/wrangler-config.ts",
};
/** directory moves, longest first */
const dirMoves = [
  ["apps/os", "core/os"],
  ["configs", "core/configs"],
];
/** file moves: old repo path -> new repo path */
const moves = new Map(Object.entries(FILE_MOVES));
for (const file of git("ls-files", ...dirMoves.map(([from]) => from))
  .split("\n")
  .filter(Boolean)) {
  for (const [from, to] of dirMoves)
    if (file.startsWith(from + "/")) moves.set(file, to + file.slice(from.length));
}

/** where a repo path (file or directory) ends up */
function mapPath(p) {
  if (moves.has(p)) return moves.get(p);
  for (const [from, to] of dirMoves) {
    if (p === from) return to;
    if (p.startsWith(from + "/")) return to + p.slice(from.length);
  }
  return p;
}

const newPathOf = (file) => moves.get(file) || file;

/** a relative specifier in `file`, as it must read from the file's new place */
function respecify(file, spec) {
  const [bare, suffix = ""] = spec.split(/(?=[?#])/);
  const trailingSlash = bare.endsWith("/") ? "/" : "";
  const oldTarget = path.posix.normalize(path.posix.join(path.posix.dirname(file), bare));
  if (oldTarget.startsWith("..")) return spec; // outside the repo
  const newTarget = mapPath(oldTarget);
  const newFile = newPathOf(file);
  if (newTarget === oldTarget && newFile === file) return spec;
  let rel = path.posix.relative(path.posix.dirname(newFile), newTarget) || ".";
  if (!rel.startsWith(".")) rel = "./" + rel;
  if (trailingSlash && !rel.endsWith("/")) rel += "/";
  return rel + suffix;
}

const CODE = /\.(ts|tsx|mts|js|mjs|cjs)$/;
const SPEC =
  /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\(\s*|new URL\(\s*|vi\.mock\(\s*)(["'])(\.{1,2}\/[^"'\n]*)\2/g;
const MD_LINK = /\]\((\.{0,2}\/?[^)\s#:]+(?:#[^)\s]*)?)\)/g;

const ROOT_MENTIONS = [...Object.entries(FILE_MOVES), ...dirMoves];

function rewriteRootMentions(text) {
  for (const [from, to] of ROOT_MENTIONS) {
    // `apps/os` anywhere a path could start (`../apps/os/...` too, same depth as core/os); `configs`
    // only as a repo-root path segment (`configs/…`, not `src/configs/…`, not the word)
    const lookbehind = from === "configs" ? "(?<![\\w./@-])" : "(?<![\\w-])";
    const lookahead = from === "configs" ? "(?=/)" : "(?![\\w-])";
    text = text.replace(
      new RegExp(
        `${lookbehind}${from.replaceAll("/", "\\/").replaceAll(".", "\\.")}${lookahead}`,
        "g",
      ),
      to,
    );
  }
  return text;
}

const skip = (f) =>
  f === "pnpm-lock.yaml" ||
  f.startsWith("patches/") ||
  f.startsWith("tasks/") ||
  f.startsWith("packages/ai-linter/src/fixtures/") ||
  !/\.(ts|tsx|mts|js|mjs|cjs|md|json|jsonc|yml|yaml)$/.test(f);

const changed = [];
for (const file of git("ls-files").split("\n").filter(Boolean)) {
  if (skip(file) || !existsSync(file) || statSync(file).isDirectory()) continue;
  const before = readFileSync(file, "utf8");
  let text = before;
  if (CODE.test(file))
    text = text.replace(SPEC, (m, pre, q, spec) => `${pre}${q}${respecify(file, spec)}${q}`);
  if (file.endsWith(".md"))
    text = text.replace(MD_LINK, (m, target) =>
      /^(https?:|mailto:|#)/.test(target) ? m : `](${respecify(file, target)})`,
    );
  text = rewriteRootMentions(text);
  if (text !== before || moves.has(file))
    changed.push({ file, text, contentChanged: text !== before });
}

for (const { file, text, contentChanged } of changed) {
  const to = newPathOf(file);
  if (dry) {
    if (contentChanged || to !== file)
      console.log(`${file}${to !== file ? ` -> ${to}` : ""}${contentChanged ? " (edited)" : ""}`);
    continue;
  }
  if (to !== file) {
    mkdirSync(path.dirname(to), { recursive: true });
    git("mv", file, to);
  }
  writeFileSync(to, text);
}
console.log(`${moves.size} moved, ${changed.filter((c) => c.contentChanged).length} edited`);
