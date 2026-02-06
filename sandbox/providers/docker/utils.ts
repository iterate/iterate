/**
 * Git and Docker utilities for the Docker provider.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

/**
 * Git info for Docker provider repo sync.
 */
export interface DockerGitInfo {
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
 * Get git info for Docker provider.
 *
 * Handles git worktrees: when .git is a file (worktree reference),
 * resolves to the main .git directory.
 */
export function getGitInfo(repoRoot: string): DockerGitInfo | undefined {
  try {
    const runGit = (command: string) =>
      execSync(command, { cwd: repoRoot, encoding: "utf-8" }).trim();
    const resolvePath = (value: string) =>
      realpathSync(isAbsolute(value) ? value : join(repoRoot, value));

    const commit = runGit("git rev-parse HEAD");
    const gitDirRaw = runGit("git rev-parse --git-dir");
    const commonDirRaw = runGit("git rev-parse --git-common-dir");
    const branch = runGit("git branch --show-current") || undefined;

    const gitDirResolved = resolvePath(gitDirRaw);
    let gitDir = gitDirResolved;
    try {
      if (statSync(gitDirResolved).isFile()) {
        const gitFile = readFileSync(gitDirResolved, "utf-8").trim();
        const match = gitFile.match(/^gitdir:\s*(.+)$/);
        if (match) {
          gitDir = resolvePath(match[1]);
        }
      }
    } catch {
      // Fall back to the resolved gitDir if we can't inspect the path
    }

    return {
      repoRoot: realpathSync(repoRoot),
      gitDir,
      commonDir: resolvePath(commonDirRaw),
      commit,
      branch,
    };
  } catch (err) {
    console.warn("Failed to get Docker git info:", err);
    return undefined;
  }
}

/**
 * Get a deterministic compose project name for a repo.
 */
export function getComposeProjectName(repoRoot: string): string {
  const resolvedRoot = realpathSync(repoRoot);
  const dirHash = createHash("sha256").update(resolvedRoot).digest("hex").slice(0, 4);
  const dirName = basename(resolvedRoot);
  return `iterate-${dirName}-${dirHash}`;
}

/**
 * Get default compose project name from repo root basename.
 */
function getDefaultComposeProjectName(repoRoot: string): string {
  const repoName = basename(repoRoot);
  return repoName.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

/**
 * Get environment variables for Docker provider.
 */
export function getDockerEnvVars(repoRoot: string): Record<string, string> {
  const gitInfo = getGitInfo(repoRoot);
  if (!gitInfo) return {};

  const envVars: Record<string, string> = {
    DOCKER_COMPOSE_PROJECT_NAME: getComposeProjectName(gitInfo.repoRoot),
    DOCKER_GIT_COMMON_DIR: gitInfo.commonDir,
    DOCKER_GIT_GITDIR: gitInfo.gitDir,
    DOCKER_GIT_COMMIT: gitInfo.commit,
    DOCKER_GIT_REPO_ROOT: gitInfo.repoRoot,
  };

  if (gitInfo.branch) {
    envVars.DOCKER_GIT_BRANCH = gitInfo.branch;
  }

  return envVars;
}

/**
 * Resolve the base image for Docker containers.
 * Prefers local tags, then baked main tags, then compose-derived fallback.
 */
export function resolveBaseImage(params: { repoRoot: string; imageName?: string }): string {
  const { repoRoot, imageName } = params;
  if (imageName) {
    return imageName;
  }

  const envImage = process.env.DOCKER_IMAGE_NAME;
  if (envImage) {
    return envImage;
  }

  const localDefaults = ["iterate-sandbox:local"];
  for (const localDefault of localDefaults) {
    try {
      execSync(`docker image inspect ${localDefault}`, { stdio: "ignore" });
      return localDefault;
    } catch {
      // fall through
    }
  }

  const bakedDefaults = ["iterate-sandbox:main", "registry.fly.io/iterate-sandbox-image:main"];
  for (const bakedDefault of bakedDefaults) {
    try {
      execSync(`docker image inspect ${bakedDefault}`, { stdio: "ignore" });
      return bakedDefault;
    } catch {
      // fall through
    }
  }

  const baseProjectName = getDefaultComposeProjectName(repoRoot);
  return `${baseProjectName}-sandbox`;
}

/**
 * Ensure the pnpm store volume exists.
 */
export function ensurePnpmStoreVolume(repoRoot: string): void {
  try {
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
