/**
 * Shared test helpers and fixtures for sandbox integration tests.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTRPCClient, httpLink } from "@trpc/client";
import { Agent, request } from "undici";
import { test as baseTest } from "vitest";
import { createClient as createPidnapClient } from "pidnap/client";
import type { TRPCRouter } from "../../../daemon/server/trpc/router.ts";
import { getDockerHostConfig, dockerApi } from "../../backend/providers/local-docker.ts";
import {
  createLocalDockerProvider,
  type LocalDockerProviderOptions,
} from "../providers/local-docker.ts";
import type { CreateSandboxOptions, SandboxHandle } from "../providers/types.ts";

// Re-export types for convenience
export type { LocalDockerProviderOptions } from "../providers/local-docker.ts";
export type { CreateSandboxOptions, SandboxHandle } from "../providers/types.ts";

// ============ Constants ============

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ITERATE_REPO_PATH_ON_HOST = join(__dirname, "../../../..");
export const ITERATE_REPO_PATH = "/home/iterate/src/github.com/iterate/iterate";
export const RUN_LOCAL_DOCKER_TESTS =
  !!process.env.RUN_LOCAL_DOCKER_TESTS &&
  process.env.RUN_LOCAL_DOCKER_TESTS !== "0" &&
  process.env.RUN_LOCAL_DOCKER_TESTS !== "false";

/** Default poll options for sandbox integration tests (services take time to start) */
export const POLL_DEFAULTS = { timeout: 20_000, interval: 500 } as const;

// ============ Docker API Helpers ============

export { dockerApi };

const dockerConfig = getDockerHostConfig();
export const DOCKER_API_URL = dockerConfig.url;

const dockerDispatcher = dockerConfig.socketPath
  ? new Agent({ connect: { socketPath: dockerConfig.socketPath } })
  : undefined;

export function decodeDockerLogs(buffer: Uint8Array): string {
  const lines: string[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) break;

    const size =
      (buffer[offset + 4]! << 24) |
      (buffer[offset + 5]! << 16) |
      (buffer[offset + 6]! << 8) |
      buffer[offset + 7]!;

    offset += 8;
    if (offset + size > buffer.length) break;

    const line = new TextDecoder().decode(buffer.slice(offset, offset + size));
    lines.push(line);
    offset += size;
  }

  return lines.join("");
}

export async function execInContainer(containerId: string, cmd: string[]): Promise<string> {
  const execCreate = await dockerApi<{ Id: string }>("POST", `/containers/${containerId}/exec`, {
    AttachStdout: true,
    AttachStderr: true,
    Cmd: cmd,
  });

  const response = await request(`${DOCKER_API_URL}/exec/${execCreate.Id}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ Detach: false, Tty: false }),
    dispatcher: dockerDispatcher,
  });

  const buffer = await response.body.arrayBuffer();
  return decodeDockerLogs(new Uint8Array(buffer));
}

export async function getContainerLogs(containerId: string): Promise<string> {
  const response = await request(
    `${DOCKER_API_URL}/containers/${containerId}/logs?stdout=true&stderr=true&timestamps=true`,
    { method: "GET", dispatcher: dockerDispatcher },
  );
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error("Failed to get logs");
  }
  const buffer = await response.body.arrayBuffer();
  return decodeDockerLogs(new Uint8Array(buffer));
}

export async function waitForLogPattern(
  containerId: string,
  pattern: RegExp,
  timeoutMs = 60000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const logs = await getContainerLogs(containerId);
    if (pattern.test(logs)) return logs;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timeout waiting for log pattern: ${pattern}`);
}

export async function getServiceFileLogs(containerId: string, logPath: string): Promise<string> {
  return execInContainer(containerId, ["cat", logPath]);
}

export async function waitForFileLogPattern(
  containerId: string,
  logPath: string,
  pattern: RegExp,
  timeoutMs = 60000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const logs = await execInContainer(containerId, ["cat", logPath]);
      if (pattern.test(logs)) return logs;
    } catch {
      // File might not exist yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timeout waiting for file log pattern in ${logPath}: ${pattern}`);
}

// ============ Git Helpers ============

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

// ============ Test Helpers ============

export function createDaemonTrpcClient(baseUrl: string) {
  return createTRPCClient<TRPCRouter>({
    links: [httpLink({ url: `${baseUrl}/api/trpc` })],
  });
}

export function createPidnapRpcClient(baseUrl: string) {
  return createPidnapClient(baseUrl);
}

/** Dump container logs to stdout for debugging test failures */
export function dumpContainerLogs(containerId: string): void {
  try {
    const logs = execSync(`docker logs ${containerId} 2>&1`, { encoding: "utf-8" });
    console.log(`\n=== Container logs for ${containerId} ===\n${logs}\n=== End logs ===\n`);
  } catch {
    console.log(`[debug] Could not fetch logs for container ${containerId}`);
  }
}

/** Creates a temp directory and cleans it up after the callback completes. */
export async function withTempDir<T>(
  prefix: string,
  fn: (tempDir: string) => Promise<T>,
): Promise<T> {
  const tempDir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await fn(tempDir);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export interface WorktreeInfo {
  path: string;
  branch: string;
}

/** Creates a git worktree and cleans it up after the callback completes. */
export async function withWorktree<T>(
  repoRoot: string,
  fn: (worktree: WorktreeInfo) => Promise<T>,
): Promise<T> {
  const path = mkdtempSync(join(tmpdir(), "git-worktree-"));
  const branch = `test-worktree-${Date.now()}`;
  const keepWorktree = process.env.KEEP_WORKTREE === "true";

  execSync(`git worktree add -b ${branch} ${path}`, {
    cwd: repoRoot,
    stdio: "pipe",
  });

  try {
    return await fn({ path, branch });
  } finally {
    if (keepWorktree) {
      console.log(`[debug] Keeping worktree at ${path}`);
    } else {
      // Cleanup worktree
      try {
        execSync(`git worktree remove --force ${path}`, { cwd: repoRoot, stdio: "pipe" });
      } catch {
        rmSync(path, { recursive: true, force: true });
        execSync(`git worktree prune`, { cwd: repoRoot, stdio: "pipe" });
      }
      // Cleanup branch
      try {
        execSync(`git branch -D ${branch}`, { cwd: repoRoot, stdio: "pipe" });
      } catch {
        // Branch might not exist if worktree creation failed
      }
    }
  }
}

/**
 * Sandbox lifecycle helper: logs container id, dumps logs on error, cleans up.
 * Used by both the vitest fixture and tests needing dynamic provider options.
 */
export async function withSandbox<T>(
  providerOptions: LocalDockerProviderOptions,
  sandboxOptions: CreateSandboxOptions | undefined,
  fn: (sandbox: SandboxHandle) => Promise<T>,
): Promise<T> {
  const provider = createLocalDockerProvider(providerOptions);
  const sandbox = await provider.createSandbox(sandboxOptions);
  const keepContainer = process.env.KEEP_SANDBOX_CONTAINER === "true";
  console.log("[container] id:", sandbox.id);
  try {
    return await fn(sandbox);
  } catch (err) {
    dumpContainerLogs(sandbox.id);
    throw err;
  } finally {
    if (keepContainer) {
      console.log(`[debug] Keeping container ${sandbox.id}`);
    } else {
      await sandbox.delete();
    }
  }
}

// ============ Vitest Fixtures ============

/**
 * Extended test with configurable sandbox fixture.
 * Use `test.scoped()` to override `providerOptions` or `sandboxOptions` per describe block.
 */
export const test = baseTest.extend<{
  sandbox: SandboxHandle;
  providerOptions: LocalDockerProviderOptions;
  sandboxOptions: CreateSandboxOptions | undefined;
}>({
  providerOptions: {},
  sandboxOptions: undefined,
  sandbox: async ({ providerOptions, sandboxOptions }, use) => {
    await withSandbox(providerOptions, sandboxOptions, use);
  },
});
