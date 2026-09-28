import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * How often `name` appears as a whole word in the repository's other code files, outside import
 * and re-export statements: iterate/no-single-use-helpers counts an exported helper's uses with it.
 * Mentions in comments and strings count too, so a helper is never called single-use because a
 * word went unseen. Undefined outside a git checkout, where the repository's files are unknown.
 */
export function countWordInOtherFiles(input: { cwd: string; fileName: string; name: string }) {
  if (!countsByCwd.has(input.cwd)) countsByCwd.set(input.cwd, countRepositoryWords(input.cwd));
  const counts = countsByCwd.get(input.cwd);
  if (!counts) return undefined;
  const own = counts.textByFile.get(resolve(input.cwd, input.fileName));
  const escaped = input.name.replaceAll("$", "\\$");
  const ownCount = own?.match(new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`, "g"))?.length || 0;
  return (counts.byWord.get(input.name) || 0) - ownCount;
}

const countsByCwd = new Map<string, ReturnType<typeof countRepositoryWords>>();

/** Every tracked or untracked-but-not-ignored code file's words, read once per lint run. */
function countRepositoryWords(cwd: string) {
  const listed = spawnSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "*.[cm][jt]s",
      "*.[jt]s",
      "*.[jt]sx",
    ],
    { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (listed.status !== 0) return null;
  const byWord = new Map<string, number>();
  const textByFile = new Map<string, string>();
  for (const path of new Set(listed.stdout.split("\0"))) {
    if (!path) continue;
    let text: string;
    try {
      text = readFileSync(resolve(cwd, path), "utf8");
    } catch {
      continue; // listed but deleted from the working tree
    }
    // Naming a helper in an import or a re-export is not a use of it.
    text = text.replaceAll(
      /^\s*(?:import|export)\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?|[\w$]+)\s+from\s*["'][^"'\n]+["'];?/gm,
      "",
    );
    textByFile.set(resolve(cwd, path), text);
    for (const [word] of text.matchAll(/[A-Za-z_$][\w$]*/g))
      byWord.set(word, (byWord.get(word) || 0) + 1);
  }
  return { byWord, textByFile };
}
