/**
 * Local Docker + pidnap Integration Tests
 *
 * Verifies sandbox container setup with pidnap process supervision.
 * Uses the local-docker provider for container management.
 *
 * RUN WITH:
 *   RUN_LOCAL_DOCKER_TESTS=true pnpm vitest run sandbox/local-docker.test.ts
 */

import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTRPCClient, httpLink } from "@trpc/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { TRPCRouter } from "../../daemon/server/trpc/router.ts";
import { createClient as createPidnapClient } from "../../../packages/pidnap/src/api/client.ts";
import { getLocalDockerGitInfo } from "./tests/helpers/local-docker-utils.ts";
import { createLocalDockerProvider } from "./tests/providers/local-docker.ts";
import type { SandboxHandle } from "./tests/providers/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../../..");

const CONTAINER_REPO_PATH = "/home/iterate/src/github.com/iterate/iterate";

const RUN_LOCAL_DOCKER_TESTS = process.env.RUN_LOCAL_DOCKER_TESTS === "true";

function createDaemonTrpcClient(port: number) {
  return createTRPCClient<TRPCRouter>({
    links: [httpLink({ url: `http://127.0.0.1:${port}/api/trpc` })],
  });
}

function createPidnapRpcClient(port: number) {
  return createPidnapClient(`http://127.0.0.1:${port}/rpc`);
}

/** Dump container logs to stdout for debugging test failures */
function dumpContainerLogs(containerId: string): void {
  try {
    const logs = execSync(`docker logs ${containerId} 2>&1`, { encoding: "utf-8" });
    console.log(`\n=== Container logs for ${containerId} ===\n${logs}\n=== End logs ===\n`);
  } catch {
    console.log(`[debug] Could not fetch logs for container ${containerId}`);
  }
}

// ============ Tests ============

// Super minimal test: verify sync-home-skeleton copied .iterate/.env
describe.runIf(RUN_LOCAL_DOCKER_TESTS)("Home Skeleton Sync", () => {
  const provider = createLocalDockerProvider();

  test("DUMMY_ENV_VAR from skeleton .env is present", async () => {
    const sandbox = await provider.createSandbox();
    try {
      // Don't wait for daemon - just check env immediately
      const envOutput = await sandbox.exec(["bash", "-l", "-c", "env"]);
      expect(envOutput).toContain("DUMMY_ENV_VAR=42");
    } catch (err) {
      dumpContainerLogs(sandbox.id);
      throw err;
    } finally {
      await sandbox.delete();
    }
  }, 10000);
});

/**
 * Git Worktree Sync Test
 *
 * WHAT: Tests that sync-repo-from-host.sh correctly syncs a git worktree into the container.
 *
 * WHY: Many developers use git worktrees for parallel work. When the host repo is a worktree,
 * its .git is a file (not a directory) pointing to the main repo's gitdir. The sync mechanism
 * must handle this correctly - mounting and merging both the worktree's gitdir and the shared
 * commondir so that git commands inside the container see the correct state.
 *
 * HOW: We create a fresh worktree with known dirty state:
 * - A unique branch name (verifies branch syncs correctly)
 * - Staged changes (new file added to index)
 * - Unstaged changes (modified existing file)
 * - Untracked files
 *
 * Then verify the container sees EXACTLY the same git state via `git status --porcelain`:
 * - Correct branch name
 * - Correct commit SHA
 * - All staged/unstaged/untracked changes match exactly
 */
describe.runIf(RUN_LOCAL_DOCKER_TESTS)("Git Worktree Sync", () => {
  let worktreePath: string;
  let branchName: string;

  beforeAll(() => {
    // Create a fresh git worktree in a temp directory
    worktreePath = mkdtempSync(join(tmpdir(), "git-sync-test-"));
    branchName = `test-git-sync-${Date.now()}`;

    execSync(`git worktree add -b ${branchName} ${worktreePath}`, {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });

    // Create dirty git state:
    // 1. Staged new file
    writeFileSync(join(worktreePath, "staged-new.txt"), "staged content");
    execSync("git add staged-new.txt", { cwd: worktreePath });

    // 2. Unstaged modification to existing file
    appendFileSync(join(worktreePath, "README.md"), "\n# test modification for git sync test");

    // 3. Untracked file
    writeFileSync(join(worktreePath, "untracked.txt"), "untracked content");
  });

  afterAll(() => {
    // Cleanup worktree and branch
    try {
      execSync(`git worktree remove --force ${worktreePath}`, { cwd: REPO_ROOT, stdio: "pipe" });
    } catch {
      rmSync(worktreePath, { recursive: true, force: true });
      execSync(`git worktree prune`, { cwd: REPO_ROOT, stdio: "pipe" });
    }
    try {
      execSync(`git branch -D ${branchName}`, { cwd: REPO_ROOT, stdio: "pipe" });
    } catch {
      // Branch might not exist if worktree creation failed
    }
  });

  test("container git state matches host worktree exactly", async () => {
    // Capture host git state
    const hostBranch = execSync("git branch --show-current", {
      cwd: worktreePath,
      encoding: "utf-8",
    }).trim();
    const hostCommit = execSync("git rev-parse HEAD", {
      cwd: worktreePath,
      encoding: "utf-8",
    }).trim();
    const hostStatus = execSync("git status --porcelain", {
      cwd: worktreePath,
      encoding: "utf-8",
    }).trim();

    console.log("[host] branch:", hostBranch);
    console.log("[host] commit:", hostCommit);
    console.log("[host] status:\n", hostStatus);

    // Create container from worktree
    const provider = createLocalDockerProvider({ repoRoot: worktreePath });
    const sandbox = await provider.createSandbox();
    console.log("[container] id:", sandbox.id);

    try {
      // No need to wait for daemon - sync happens in entry.sh before pidnap starts
      // Just give it a moment for sync-repo-from-host.sh to complete
      await new Promise((r) => setTimeout(r, 2000));

      // Get container git state
      const containerBranch = (
        await sandbox.exec(["git", "-C", CONTAINER_REPO_PATH, "branch", "--show-current"])
      ).trim();
      const containerCommit = (
        await sandbox.exec(["git", "-C", CONTAINER_REPO_PATH, "rev-parse", "HEAD"])
      ).trim();
      const containerStatus = (
        await sandbox.exec(["git", "-C", CONTAINER_REPO_PATH, "status", "--porcelain"])
      ).trim();

      console.log("[container] branch:", containerBranch);
      console.log("[container] commit:", containerCommit);
      console.log("[container] status:\n", containerStatus);

      // Verify exact match
      expect(containerBranch).toBe(hostBranch);
      expect(containerCommit).toBe(hostCommit);
      expect(containerStatus).toBe(hostStatus);
    } catch (err) {
      dumpContainerLogs(sandbox.id);
      throw err;
    } finally {
      await sandbox.delete();
    }
  }, 30000);
});

describe.runIf(RUN_LOCAL_DOCKER_TESTS)("Local Docker Integration", () => {
  const provider = createLocalDockerProvider();

  // ============ Container Setup ============
  describe("Container Setup", () => {
    let sandbox: SandboxHandle;

    beforeAll(async () => {
      sandbox = await provider.createSandbox();
      await sandbox.waitForServiceHealthy("daemon-backend");
      await sandbox.waitForServiceHealthy("daemon-frontend");
    }, 300000);

    afterAll(async () => {
      await sandbox?.delete();
    }, 30000);

    test("agent CLIs installed", async () => {
      const opencode = await sandbox.exec(["opencode", "--version"]);
      expect(opencode).toMatch(/\d+\.\d+\.\d+/);

      const claude = await sandbox.exec(["claude", "--version"]);
      expect(claude).toMatch(/\d+\.\d+\.\d+/);

      const pi = await sandbox.exec(["pi", "--version"]);
      expect(pi).toMatch(/\d+\.\d+\.\d+/);
    });

    test.runIf(process.env.OPENAI_API_KEY)(
      "opencode answers secret question",
      async () => {
        const output = await sandbox.exec([
          "opencode",
          "run",
          "what messaging app are you built to help with?",
        ]);
        expect(output.toLowerCase()).toContain("slack");
      },
      30000,
    );

    test.runIf(process.env.ANTHROPIC_API_KEY)(
      "claude answers secret question",
      async () => {
        const output = await sandbox.exec([
          "claude",
          "-p",
          "what messaging app are you built to help with?",
        ]);
        expect(output.toLowerCase()).toContain("slack");
      },
      30000,
    );

    test.runIf(process.env.ANTHROPIC_API_KEY)(
      "pi answers secret question",
      async () => {
        const output = await sandbox.exec([
          "pi",
          "-p",
          "what messaging app are you built to help with?",
        ]);
        expect(output.toLowerCase()).toContain("slack");
      },
      30000,
    );

    test("container setup correct", async () => {
      // repo cloned
      const ls = await sandbox.exec(["ls", CONTAINER_REPO_PATH]);
      expect(ls).toContain("README.md");
      expect(ls).toContain("apps");
    });

    test("git operations work", async () => {
      const init = await sandbox.exec(["git", "init", "/tmp/test-repo"]);
      expect(init).toContain("Initialized");

      const config = await sandbox.exec(["git", "-C", "/tmp/test-repo", "config", "user.email"]);
      expect(config).toContain("@");

      await sandbox.exec(["sh", "-c", "echo 'hello' > /tmp/test-repo/test.txt"]);
      await sandbox.exec(["git", "-C", "/tmp/test-repo", "add", "."]);

      const commit = await sandbox.exec(["git", "-C", "/tmp/test-repo", "commit", "-m", "test"]);
      expect(commit).toContain("test");
    });

    test("git state matches host", async () => {
      const gitInfo = getLocalDockerGitInfo(REPO_ROOT);
      expect(gitInfo).toBeDefined();

      // Check branch matches (empty string if detached HEAD on both)
      const containerBranch = (
        await sandbox.exec(["git", "-C", CONTAINER_REPO_PATH, "branch", "--show-current"])
      ).trim();
      expect(containerBranch).toBe(gitInfo!.branch ?? "");

      // Check commit matches
      const containerCommit = (
        await sandbox.exec(["git", "-C", CONTAINER_REPO_PATH, "rev-parse", "HEAD"])
      ).trim();
      expect(containerCommit).toBe(gitInfo!.commit);
    });

    test("shell sources ~/.iterate/.env automatically", async () => {
      // Write env var to ~/.iterate/.env
      await sandbox.exec([
        "sh",
        "-c",
        'echo "TEST_ITERATE_ENV_VAR=hello_from_env_file" >> ~/.iterate/.env',
      ]);

      // Start a new login shell and check if env var is available
      const envOutput = await sandbox.exec(["bash", "-l", "-c", "env | grep TEST_ITERATE_ENV_VAR"]);

      expect(envOutput).toContain("hello_from_env_file");
    });
  });

  // ============ Daemon ============
  describe("Daemon", () => {
    let sandbox: SandboxHandle;

    beforeAll(async () => {
      sandbox = await provider.createSandbox();
      await sandbox.waitForServiceHealthy("daemon-backend");
    }, 300000);

    afterAll(async () => {
      await sandbox?.delete();
    }, 30000);

    test("daemon accessible", async () => {
      const port3000 = sandbox.getHostPort(3000);

      // Verify health endpoint from host
      const healthResponse = await fetch(`http://127.0.0.1:${port3000}/api/health`);
      expect(healthResponse.ok).toBe(true);
      const healthText = await healthResponse.text();
      expect(healthText.includes("ok") || healthText.includes("healthy")).toBe(true);

      // Verify health from inside container
      const internalHealth = await sandbox.exec(["curl", "-s", "http://localhost:3000/api/health"]);
      expect(internalHealth.includes("ok") || internalHealth.includes("healthy")).toBe(true);
    }, 210000);

    test("PTY endpoint works", async () => {
      const port3000 = sandbox.getHostPort(3000);
      // PTY endpoint exists
      const ptyResponse = await fetch(`http://127.0.0.1:${port3000}/api/pty/ws?cols=80&rows=24`);
      expect(ptyResponse.status).not.toBe(404);
    }, 210000);

    test("serves assets and routes correctly", async () => {
      const port3000 = sandbox.getHostPort(3000);
      const baseUrl = `http://127.0.0.1:${port3000}`;
      const trpc = createDaemonTrpcClient(port3000);

      // index.html
      const root = await fetch(`${baseUrl}/`);
      expect(root.ok).toBe(true);
      expect(root.headers.get("content-type")).toContain("text/html");
      const html = await root.text();
      expect(html.toLowerCase()).toContain("<!doctype html>");

      // health
      const health = await fetch(`${baseUrl}/api/health`);
      expect(health.ok).toBe(true);

      // tRPC
      const cwd = await trpc.getServerCwd.query();
      expect(cwd.cwd).toBe(`${CONTAINER_REPO_PATH}/apps/daemon`);

      // CSS/JS bundles
      const cssMatch = html.match(/href="(\.?\/assets\/[^"]+\.css)"/);
      const jsMatch = html.match(/src="(\.?\/assets\/[^"]+\.js)"/);
      if (cssMatch) {
        const css = await fetch(`${baseUrl}${cssMatch[1]!.replace(/^\.\//, "/")}`);
        expect(css.ok).toBe(true);
      }
      if (jsMatch) {
        const js = await fetch(`${baseUrl}${jsMatch[1]!.replace(/^\.\//, "/")}`);
        expect(js.ok).toBe(true);
      }

      // logo
      const logo = await fetch(`${baseUrl}/logo.svg`);
      expect(logo.ok).toBe(true);

      // SPA fallback
      const spa = await fetch(`${baseUrl}/agents/some-agent-id`);
      expect(spa.ok).toBe(true);
      expect(spa.headers.get("content-type")).toContain("text/html");
    }, 210000);
  });

  // ============ Pidnap ============
  describe("Pidnap", () => {
    let sandbox: SandboxHandle;

    beforeAll(async () => {
      sandbox = await provider.createSandbox();
      await sandbox.waitForServiceHealthy("daemon-backend");
    }, 300000);

    afterAll(async () => {
      await sandbox?.delete();
    }, 30000);

    test("processes.get returns running state for daemon-backend", async () => {
      const port9876 = sandbox.getHostPort(9876);
      // daemon-backend is already running (waited in beforeAll)
      const client = createPidnapRpcClient(port9876);
      const result = await client.processes.get({ target: "daemon-backend" });
      expect(result.state).toBe("running");
    }, 210000);

    test("processes.get fails for non-existent service", async () => {
      const port9876 = sandbox.getHostPort(9876);
      const client = createPidnapRpcClient(port9876);
      await expect(client.processes.get({ target: "nonexistent" })).rejects.toThrow(
        /Process not found/i,
      );
    }, 30000);
  });
});
