import { execFileSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { diffLines } from "diff";
import type { Rule } from "eslint";

/** Compare the actual linted source with the PR merge base, including autofix passes. */
export function prChangedLines(context: Rule.RuleContext, base: string) {
  if (!/^[a-f0-9]{40,64}$/.test(base)) throw new Error("ITERATE_LINT_PR_BASE must be a commit SHA");
  const filename = context.physicalFilename;
  if (!filename || filename.startsWith("<")) return null;
  const file = resolve(context.cwd, filename);
  // Literal encoding keeps Git's output typed as text.
  const options = {
    cwd: dirname(file),
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 32 * 1024 * 1024,
  } as const;
  const prefix = execFileSync("git", ["rev-parse", "--show-prefix"], options).trimEnd();
  let basePath = prefix + basename(file);
  const exists = execFileSync(
    "git",
    ["--literal-pathspecs", "ls-tree", "--name-only", "-z", base, "--", basename(file)],
    options,
  );
  if (!exists) {
    // Preserve unchanged lines when Git recognizes a rename, including moves between folders.
    const changes = execFileSync(
      "git",
      ["diff", "--name-status", "-z", "--find-renames", base, "HEAD"],
      options,
    ).split("\0");
    basePath = "";
    for (let index = 0; index < changes.length - 1; ) {
      const status = changes[index++];
      const before = changes[index++];
      if (status.startsWith("R")) {
        const after = changes[index++];
        if (after === prefix + basename(file)) basePath = before;
      }
    }
  }
  const before = basePath ? execFileSync("git", ["show", `${base}:${basePath}`], options) : "";
  const changes = diffLines(before, context.sourceCode.text, { timeout: 1000 });
  if (!changes) throw new Error(`PR lint diff timed out for ${filename}`);
  const added = new Set<number>();
  let line = 1;
  for (const change of changes) {
    if (change.removed) continue;
    if (change.added) {
      for (let offset = 0; offset < change.count; offset++) added.add(line + offset);
    }
    line += change.count;
  }
  return added;
}
