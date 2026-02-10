/**
 * Shared test helpers and fixtures for sandbox integration tests.
 *
 * ## Test Configuration Environment Variables
 *
 * SANDBOX_TEST_PROVIDER
 *   Which provider to run tests against: "docker" | "fly" | "daytona"
 *   Default: "docker"
 *
 * SANDBOX_TEST_SNAPSHOT_ID
 *   Image/snapshot override to use for tests.
 *   Default for Docker: uses DOCKER_DEFAULT_IMAGE env var
 *   Default for Fly: uses FLY_DEFAULT_IMAGE env var
 *   Default for Daytona: reads from DAYTONA_DEFAULT_SNAPSHOT env var
 *
 * RUN_SANDBOX_TESTS
 *   Set to "true" to enable sandbox integration tests (they're slow).
 *   Tests are skipped when this is not set.
 *
 * KEEP_SANDBOX_CONTAINER
 *   Set to "true" to keep containers after tests (for debugging).
 *
 * ## Provider-Specific Environment Variables
 *
 * Docker provider requires:
 *   - DOCKER_HOST (optional, defaults to tcp://127.0.0.1:2375)
 *   - DOCKER_DEFAULT_SERVICE_TRANSPORT (optional: "port-map" | "cloudflare-tunnel")
 *
 * Daytona provider requires (typically from Doppler):
 *   - DAYTONA_API_KEY
 *   - DAYTONA_ORG_ID (optional)
 *   - DAYTONA_DEFAULT_SNAPSHOT (used as default if SANDBOX_TEST_SNAPSHOT_ID not set)
 *
 * Fly provider requires (typically from Doppler):
 *   - FLY_API_TOKEN
 *   - FLY_DEFAULT_IMAGE (optional, defaults to registry.fly.io/iterate-sandbox-image:main)
 *
 * ## Usage Examples
 *
 * Run Docker tests with local image:
 *   RUN_SANDBOX_TESTS=true pnpm sandbox test
 *
 * Run Docker tests with specific image:
 *   RUN_SANDBOX_TESTS=true SANDBOX_TEST_SNAPSHOT_ID=iterate-sandbox:sha-abc123 pnpm sandbox test
 *
 * Run Fly tests:
 *   RUN_SANDBOX_TESTS=true SANDBOX_TEST_PROVIDER=fly doppler run -- pnpm sandbox test test/provider-base-image.test.ts --maxWorkers=1
 *
 * Run Daytona tests:
 *   RUN_SANDBOX_TESTS=true SANDBOX_TEST_PROVIDER=daytona doppler run -- pnpm sandbox test
 *
 * Run Daytona tests with specific snapshot:
 *   RUN_SANDBOX_TESTS=true SANDBOX_TEST_PROVIDER=daytona SANDBOX_TEST_SNAPSHOT_ID=my-snapshot doppler run -- pnpm sandbox test
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, request } from "undici";
import { test as baseTest } from "vitest";
import { DockerProvider, DockerSandbox } from "../providers/docker/provider.ts";
import { DaytonaProvider, DaytonaSandbox } from "../providers/daytona/provider.ts";
import { FlyProvider, FlySandbox } from "../providers/fly/provider.ts";
import { getDockerHostConfig, dockerApi, execInContainer } from "../providers/docker/api.ts";
import {
  getGitInfo,
  getComposeProjectName,
  getDockerEnvVars,
  ensurePnpmStoreVolume,
} from "../providers/docker/utils.ts";
import type { CreateSandboxOptions, Sandbox, SandboxProvider } from "../providers/types.ts";

// Re-export types and utilities for convenience
export type { CreateSandboxOptions, Sandbox, SandboxProvider } from "../providers/types.ts";
export type { DockerGitInfo } from "../providers/docker/utils.ts";
export { DockerProvider, DockerSandbox, DaytonaProvider, DaytonaSandbox, FlyProvider, FlySandbox };
export { getDockerEnvVars, getGitInfo, getComposeProjectName, ensurePnpmStoreVolume };

// ============ Test Configuration ============

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Provider type for tests */
export type TestProviderType = "docker" | "daytona" | "fly";

/**
 * Test configuration parsed from environment variables.
 */
export const TEST_CONFIG = {
  /** Which provider to test: "docker" | "fly" | "daytona" */
  provider: (process.env.SANDBOX_TEST_PROVIDER ?? "docker") as TestProviderType,

  /** Snapshot/image ID override (provider uses its default if not set) */
  snapshotId: process.env.SANDBOX_TEST_SNAPSHOT_ID,

  /** Whether sandbox tests should run (they're slow, so opt-in) */
  enabled:
    !!process.env.RUN_SANDBOX_TESTS &&
    process.env.RUN_SANDBOX_TESTS !== "0" &&
    process.env.RUN_SANDBOX_TESTS !== "false",

  /** Keep containers after tests for debugging */
  keepContainers: process.env.KEEP_SANDBOX_CONTAINER === "true",
} as const;

const TEST_BASE_SNAPSHOTS = {
  docker: process.env.DOCKER_DEFAULT_IMAGE ?? "",
  daytona: process.env.DAYTONA_DEFAULT_SNAPSHOT ?? "",
  fly: process.env.FLY_DEFAULT_IMAGE ?? "",
} as const;

export const TEST_BASE_SNAPSHOT_ID = TEST_BASE_SNAPSHOTS[TEST_CONFIG.provider];

// Log test configuration at startup
if (TEST_CONFIG.enabled) {
  console.log(`[sandbox-test] provider=${TEST_CONFIG.provider}`);
  if (TEST_CONFIG.snapshotId) {
    console.log(`[sandbox-test] snapshotId=${TEST_CONFIG.snapshotId}`);
  }
}

/** Whether any sandbox tests are enabled */
export const RUN_SANDBOX_TESTS = TEST_CONFIG.enabled;

// ============ Constants ============

export const ITERATE_REPO_PATH_ON_HOST = join(__dirname, "../..");
export const ITERATE_REPO_PATH = "/home/iterate/src/github.com/iterate/iterate";

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

export async function waitForLogPattern(params: {
  containerId: string;
  pattern: RegExp;
  timeoutMs?: number;
}): Promise<string> {
  const { containerId, pattern, timeoutMs = 60000 } = params;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const logs = await getContainerLogs(containerId);
    if (pattern.test(logs)) return logs;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timeout waiting for log pattern: ${pattern}`);
}

export async function getServiceFileLogs(params: {
  containerId: string;
  logPath: string;
}): Promise<string> {
  const { containerId, logPath } = params;
  return execInContainer({ containerId, cmd: ["cat", logPath] });
}

export async function waitForFileLogPattern(params: {
  containerId: string;
  logPath: string;
  pattern: RegExp;
  timeoutMs?: number;
}): Promise<string> {
  const { containerId, logPath, pattern, timeoutMs = 60000 } = params;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const logs = await execInContainer({ containerId, cmd: ["cat", logPath] });
      if (pattern.test(logs)) return logs;
    } catch {
      // File might not exist yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timeout waiting for file log pattern in ${logPath}: ${pattern}`);
}

// ============ Test Helpers ============

/** Dump container logs to stdout for debugging test failures */
export function dumpContainerLogs(containerId: string): void {
  // Only works for Docker containers
  if (TEST_CONFIG.provider !== "docker") {
    console.log(`[debug] Log dumping not supported for ${TEST_CONFIG.provider} provider`);
    return;
  }
  try {
    const logs = execSync(`docker logs ${containerId} 2>&1`, { encoding: "utf-8" });
    console.log(`\n=== Container logs for ${containerId} ===\n${logs}\n=== End logs ===\n`);
  } catch {
    console.log(`[debug] Could not fetch logs for container ${containerId}`);
  }
}

/** Creates a temp directory and cleans it up after the callback completes. */
export async function withTempDir<T>(params: {
  prefix: string;
  fn: (tempDir: string) => Promise<T>;
}): Promise<T> {
  const { prefix, fn } = params;
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
export async function withWorktree<T>(params: {
  repoRoot: string;
  fn: (worktree: WorktreeInfo) => Promise<T>;
}): Promise<T> {
  const { repoRoot, fn } = params;
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

// ============ Provider Factory ============

/**
 * Create a sandbox provider based on TEST_CONFIG.
 */
export function createTestProvider(envOverrides?: Record<string, string>): SandboxProvider {
  const env = { ...process.env, ...envOverrides } as Record<string, string | undefined>;

  // Apply snapshot ID override if set
  if (TEST_CONFIG.snapshotId) {
    if (TEST_CONFIG.provider === "docker") {
      env.DOCKER_DEFAULT_IMAGE = TEST_CONFIG.snapshotId;
    } else if (TEST_CONFIG.provider === "daytona") {
      env.DAYTONA_DEFAULT_SNAPSHOT = TEST_CONFIG.snapshotId;
    } else {
      env.FLY_DEFAULT_IMAGE = TEST_CONFIG.snapshotId;
    }
  }

  switch (TEST_CONFIG.provider) {
    case "docker":
      env.DOCKER_HOST_GIT_REPO_ROOT ??= ITERATE_REPO_PATH_ON_HOST;
      return new DockerProvider(env);
    case "daytona":
      return new DaytonaProvider(env);
    case "fly":
      return new FlyProvider(env);
    default:
      throw new Error(`Unknown provider: ${TEST_CONFIG.provider}`);
  }
}

/**
 * Sandbox lifecycle helper: logs sandbox id, dumps logs on error, cleans up.
 * Works with both Docker and Daytona providers.
 */
export async function withSandbox<T>(params: {
  envOverrides?: Record<string, string | undefined>;
  sandboxOptions?: CreateSandboxOptions;
  fn: (sandbox: Sandbox) => Promise<T>;
}): Promise<T> {
  const { envOverrides, sandboxOptions, fn } = params;
  const provider = createTestProvider(envOverrides as Record<string, string> | undefined);

  // Use default options if none provided
  const opts = sandboxOptions ?? {
    id: `test-${Date.now()}`,
    name: `test-sandbox`,
    envVars: {},
  };

  const sandbox = await provider.create(opts);
  console.log(`[sandbox] provider=${TEST_CONFIG.provider} id=${sandbox.providerId}`);

  try {
    return await fn(sandbox);
  } catch (err) {
    if (TEST_CONFIG.provider === "docker") {
      dumpContainerLogs(sandbox.providerId);
    }
    throw err;
  } finally {
    if (TEST_CONFIG.keepContainers) {
      console.log(`[debug] Keeping sandbox ${sandbox.providerId}`);
    } else {
      await sandbox.delete();
    }
  }
}

// ============ Vitest Fixtures ============

/**
 * Extended test with configurable sandbox fixture.
 * Use `test.scoped()` to override `envOverrides` or `sandboxOptions` per describe block.
 *
 * The provider is determined by SANDBOX_TEST_PROVIDER env var (default: "docker").
 */
export const test = baseTest.extend<{
  sandbox: Sandbox;
  envOverrides: Record<string, string | undefined>;
  sandboxOptions: CreateSandboxOptions | undefined;
}>({
  envOverrides: {},
  sandboxOptions: undefined,
  sandbox: async ({ envOverrides, sandboxOptions }, use) => {
    await withSandbox({ envOverrides, sandboxOptions, fn: use });
  },
});
