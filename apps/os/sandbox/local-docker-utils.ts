/**
 * Shared utilities for Local Docker machine provider.
 * Used by alchemy.run.ts and local-docker.test.ts.
 */

import { execSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

export interface LocalDockerGitInfo {
  /** Path to main .git directory (resolves worktrees) */
  gitDir: string;
  /** Current commit SHA */
  commit: string;
  /** Current branch name (undefined if detached HEAD) */
  branch?: string;
}

/**
 * Get git info for local Docker machine provider.
 *
 * Handles git worktrees: when .git is a file (worktree reference), resolves to the main .git directory.
 * The main .git dir is mounted into the container, which then clones from it.
 *
 * @param repoRoot - Path to the repository root
 * @returns Git info or undefined if git info cannot be determined
 */
export function getLocalDockerGitInfo(repoRoot: string): LocalDockerGitInfo | undefined {
  try {
    const gitPath = join(repoRoot, ".git");
    const stat = statSync(gitPath);

    let mainGitDir: string;
    if (stat.isFile()) {
      // Worktree: .git is a file containing "gitdir: /path/to/.git/worktrees/name"
      const content = readFileSync(gitPath, "utf-8");
      const match = content.match(/^gitdir:\s*(.+)/);
      if (!match) throw new Error("Invalid .git file format");
      // Resolve from .git/worktrees/name to main .git directory
      const worktreeGitDir = match[1].trim();
      mainGitDir = join(worktreeGitDir, "..", "..");
    } else {
      // Regular repo: .git is a directory
      mainGitDir = gitPath;
    }

    const commit = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf-8" }).trim();
    const branch = execSync("git branch --show-current", {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();

    return {
      gitDir: realpathSync(mainGitDir), // Resolve symlinks for clean path
      commit,
      branch: branch || undefined,
    };
  } catch (err) {
    console.warn("Failed to get local Docker git info:", err);
    return undefined;
  }
}
