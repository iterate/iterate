import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function createMinimalGitDirForSha(opts: {
  repoRoot: string;
  cacheDir: string;
  gitSha: string;
  log?: (message: string) => void;
}): string {
  const { repoRoot, cacheDir, gitSha, log = () => {} } = opts;
  const gitDirPath = join(cacheDir, `minimal-git-${gitSha}`);

  const packDir = join(gitDirPath, "objects", "pack");
  if (existsSync(packDir)) {
    const packFiles = readdirSync(packDir).filter((f) => f.endsWith(".pack"));
    if (packFiles.length > 0) {
      log(`Using cached minimal .git for ${gitSha}`);
      return gitDirPath;
    }
  }

  log(`Creating minimal .git with packed objects for ${gitSha}...`);

  rmSync(gitDirPath, { recursive: true, force: true });
  mkdirSync(gitDirPath, { recursive: true });

  writeFileSync(join(gitDirPath, "HEAD"), `${gitSha}\n`);
  writeFileSync(
    join(gitDirPath, "config"),
    `[core]
\trepositoryformatversion = 0
\tfilemode = true
\tbare = false
`,
  );

  mkdirSync(packDir, { recursive: true });
  mkdirSync(join(gitDirPath, "refs", "heads"), { recursive: true });

  const rootTreeSha = execSync(`git rev-parse ${gitSha}^{tree}`, {
    cwd: repoRoot,
    encoding: "utf-8",
    maxBuffer: 100 * 1024 * 1024,
  }).trim();

  // Include only the current commit and current tree objects (no history).
  const treeObjects = execSync(`git ls-tree -r -t --object-only ${gitSha}`, {
    cwd: repoRoot,
    encoding: "utf-8",
    maxBuffer: 100 * 1024 * 1024,
  })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const objectList = Array.from(new Set([gitSha, rootTreeSha, ...treeObjects]))
    .sort()
    .join("\n");

  const packBasename = join(packDir, "pack");
  execSync(`git pack-objects --threads=1 ${packBasename}`, {
    cwd: repoRoot,
    input: objectList,
    encoding: "utf-8",
    maxBuffer: 100 * 1024 * 1024,
  });

  const createdPacks = readdirSync(packDir).filter((f) => f.endsWith(".pack"));
  if (createdPacks.length === 0) {
    throw new Error("Failed to create git pack file");
  }

  const packSize = createdPacks
    .map((f) => statSync(join(packDir, f)).size)
    .reduce((a, b) => a + b, 0);

  log(`Created pack file: ${(packSize / 1024 / 1024).toFixed(1)}MB`);

  return gitDirPath;
}
