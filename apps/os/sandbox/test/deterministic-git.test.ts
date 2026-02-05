import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMinimalGitDirForSha } from "../minimal-git-dir.ts";

function hashDirectory(dirPath: string): string {
  const hash = createHash("sha256");
  const entries: string[] = [];

  function walkDir(currentPath: string, relativePath = ""): void {
    const items = readdirSync(currentPath).sort();
    for (const item of items) {
      const fullPath = join(currentPath, item);
      const relPath = relativePath ? `${relativePath}/${item}` : item;
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        entries.push(`dir:${relPath}`);
        walkDir(fullPath, relPath);
      } else {
        const content = readFileSync(fullPath);
        entries.push(`file:${relPath}:${content.toString("hex")}`);
      }
    }
  }

  walkDir(dirPath);
  hash.update(entries.join("\n"));
  return hash.digest("hex");
}

function objectExists(gitDir: string, objectId: string): boolean {
  try {
    execSync(`git --git-dir="${gitDir}" cat-file -e ${objectId}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function createGitRepo(repoPath: string): { firstSha: string; secondSha: string } {
  mkdirSync(repoPath, { recursive: true });
  execSync("git init", { cwd: repoPath, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: repoPath, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: repoPath, stdio: "pipe" });

  writeFileSync(join(repoPath, "file.txt"), "hello world\n");
  execSync("git add .", { cwd: repoPath, stdio: "pipe" });
  execSync('git commit -m "first"', { cwd: repoPath, stdio: "pipe" });
  const firstSha = execSync("git rev-parse HEAD", { cwd: repoPath, encoding: "utf-8" }).trim();

  writeFileSync(join(repoPath, "file.txt"), "hello world v2\n");
  execSync("git add .", { cwd: repoPath, stdio: "pipe" });
  execSync('git commit -m "second"', { cwd: repoPath, stdio: "pipe" });
  const secondSha = execSync("git rev-parse HEAD", { cwd: repoPath, encoding: "utf-8" }).trim();

  return { firstSha, secondSha };
}

describe("createMinimalGitDirForSha", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "minimal-git-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("produces deterministic output for the same SHA", () => {
    const repoPath = join(tempDir, "repo");
    const { secondSha } = createGitRepo(repoPath);

    const gitDir1 = createMinimalGitDirForSha({
      repoRoot: repoPath,
      cacheDir: join(tempDir, "cache1"),
      gitSha: secondSha,
    });
    const gitDir2 = createMinimalGitDirForSha({
      repoRoot: repoPath,
      cacheDir: join(tempDir, "cache2"),
      gitSha: secondSha,
    });

    expect(hashDirectory(gitDir1)).toBe(hashDirectory(gitDir2));
  });

  it("produces different output for different SHAs", () => {
    const repoPath = join(tempDir, "repo");
    const { firstSha, secondSha } = createGitRepo(repoPath);

    const gitDir1 = createMinimalGitDirForSha({
      repoRoot: repoPath,
      cacheDir: join(tempDir, "cache1"),
      gitSha: firstSha,
    });
    const gitDir2 = createMinimalGitDirForSha({
      repoRoot: repoPath,
      cacheDir: join(tempDir, "cache2"),
      gitSha: secondSha,
    });

    expect(hashDirectory(gitDir1)).not.toBe(hashDirectory(gitDir2));
  });

  it("packs HEAD objects but not parent commit objects", () => {
    const repoPath = join(tempDir, "repo");
    const { firstSha, secondSha } = createGitRepo(repoPath);

    const minimalGitDir = createMinimalGitDirForSha({
      repoRoot: repoPath,
      cacheDir: join(tempDir, "cache"),
      gitSha: secondSha,
    });

    expect(objectExists(minimalGitDir, secondSha)).toBe(true);
    expect(objectExists(minimalGitDir, firstSha)).toBe(false);
  });
});
