/**
 * Shared utilities for Local Docker machine provider.
 * Used by local Docker sandbox tests.
 *
 * NOTE: Workerd can't exec, even in local development. These helpers run on the
 * host side (scripts like local-docker-snapshot.ts or alchemy.run.ts) to derive
 * git/compose env vars before they're injected into the worker.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

export interface LocalDockerGitInfo {
  /** Repo root */
  repoRoot: string;
  /** Path to main .git directory (resolves worktrees) */
  gitDir: string;
  /** Path to git common dir (resolves worktrees) */
  commonDir: string;
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
    const runGit = (command: string) =>
      execSync(command, { cwd: repoRoot, encoding: "utf-8" }).trim();
    const resolvePath = (value: string) =>
      realpathSync(isAbsolute(value) ? value : join(repoRoot, value));

    const commit = runGit("git rev-parse HEAD");
    const gitDirRaw = runGit("git rev-parse --git-dir");
    const commonDirRaw = runGit("git rev-parse --git-common-dir");
    // git branch --show-current returns empty in detached HEAD state (e.g., CI checkout)
    // We don't use GITHUB_HEAD_REF because that branch may not exist in the local git clone
    const branch = runGit("git branch --show-current") || undefined;

    return {
      repoRoot: realpathSync(repoRoot),
      gitDir: resolvePath(gitDirRaw),
      commonDir: resolvePath(commonDirRaw),
      commit,
      branch,
    };
  } catch (err) {
    console.warn("Failed to get local Docker git info:", err);
    return undefined;
  }
}

export function getLocalDockerComposeProjectName(repoRoot: string): string {
  const resolvedRoot = realpathSync(repoRoot);
  const dirHash = createHash("sha256").update(resolvedRoot).digest("hex").slice(0, 4);
  const dirName = basename(resolvedRoot);
  return `iterate-${dirName}-${dirHash}`;
}

export function getLocalDockerEnvVars(repoRoot: string): Record<string, string> {
  const gitInfo = getLocalDockerGitInfo(repoRoot);
  if (!gitInfo) return {};

  const envVars: Record<string, string> = {
    LOCAL_DOCKER_COMPOSE_PROJECT_NAME: getLocalDockerComposeProjectName(gitInfo.repoRoot),
    LOCAL_DOCKER_GIT_COMMON_DIR: gitInfo.commonDir,
    LOCAL_DOCKER_GIT_GITDIR: gitInfo.gitDir,
    LOCAL_DOCKER_GIT_COMMIT: gitInfo.commit,
    LOCAL_DOCKER_GIT_REPO_ROOT: gitInfo.repoRoot,
  };

  if (gitInfo.branch) {
    envVars.LOCAL_DOCKER_GIT_BRANCH = gitInfo.branch;
  }

  return envVars;
}

export function ensureIteratePnpmStoreVolume(repoRoot: string): void {
  try {
    // Check if volume exists first to make this idempotent
    const volumeExists = execSync("docker volume ls -q -f name=iterate-pnpm-store", {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();

    if (!volumeExists) {
      execSync("docker volume create iterate-pnpm-store", {
        cwd: repoRoot,
        stdio: "inherit",
      });
    }
  } catch (err) {
    console.error("Failed to create iterate-pnpm-store volume:", err);
    throw err;
  }
}
