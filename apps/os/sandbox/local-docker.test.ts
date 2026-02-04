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
import { describe, expect, test as baseTest } from "vitest";
import type { TRPCRouter } from "../../daemon/server/trpc/router.ts";
import { createClient as createPidnapClient } from "../../../packages/pidnap/src/api/client.ts";
import { getLocalDockerGitInfo } from "./tests/helpers/local-docker-utils.ts";
import {
  createLocalDockerProvider,
  type LocalDockerProviderOptions,
} from "./tests/providers/local-docker.ts";
import type { CreateSandboxOptions, SandboxHandle } from "./tests/providers/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../../..");

const CONTAINER_REPO_PATH = "/home/iterate/src/github.com/iterate/iterate";

const RUN_LOCAL_DOCKER_TESTS = process.env.RUN_LOCAL_DOCKER_TESTS === "true";

function createDaemonTrpcClient(baseUrl: string) {
  return createTRPCClient<TRPCRouter>({
    links: [httpLink({ url: `${baseUrl}/api/trpc` })],
  });
}

function createPidnapRpcClient(baseUrl: string) {
  return createPidnapClient(`${baseUrl}/rpc`);
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

async function execWithTimeout(
  sandbox: SandboxHandle,
  cmd: string[],
  timeoutMs: number,
  label: string,
): Promise<string> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      sandbox.exec(cmd),
      new Promise<string>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Timed out after ${timeoutMs}ms: ${label}`));
        }, timeoutMs);
      }),
    ]);
    return result;
  } catch (err) {
    dumpContainerLogs(sandbox.id);
    throw err;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function waitForHealthyOrThrow(
  sandbox: SandboxHandle,
  process: string,
  timeoutMs: number,
): Promise<void> {
  await Promise.race([
    sandbox.waitForServiceHealthy({ process, timeoutMs }),
    new Promise<void>((_resolve, reject) => {
      setTimeout(() => {
        reject(
          new Error(`Timed out after ${timeoutMs}ms waiting for ${process} to become healthy`),
        );
      }, timeoutMs);
    }),
  ]);
}

type SandboxTestOptions = {
  providerOptions?: LocalDockerProviderOptions;
  sandboxOptions?: CreateSandboxOptions | (() => CreateSandboxOptions | undefined);
  waitFor?: Array<{ process: string; timeoutMs?: number }>;
};

function createSandboxTest(options: SandboxTestOptions = {}) {
  return baseTest.extend<{ sandbox: SandboxHandle; expect: typeof expect }>({
    expect: async ({}, useExpect) => {
      await useExpect(expect);
    },
    sandbox: async ({ task: _task }, runWithSandbox) => {
      const provider = createLocalDockerProvider(options.providerOptions);
      const resolvedOptions =
        typeof options.sandboxOptions === "function"
          ? options.sandboxOptions()
          : options.sandboxOptions;
      const sandbox = await provider.createSandbox(resolvedOptions);
      console.log("[container] id:", sandbox.id);
      try {
        if (options.waitFor) {
          for (const wait of options.waitFor) {
            await sandbox.waitForServiceHealthy(wait);
          }
        }
        await runWithSandbox(sandbox);
      } catch (err) {
        dumpContainerLogs(sandbox.id);
        throw err;
      } finally {
        await sandbox.delete();
      }
    },
  });
}

function getAgentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env.ANTHROPIC_API_KEY) {
    env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  }
  if (process.env.OPENAI_API_KEY) {
    env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  }
  return env;
}

const testWithSandbox = createSandboxTest().concurrent;
const testWithAgentEnv = createSandboxTest({
  sandboxOptions: () => ({ env: getAgentEnv() }),
}).concurrent;
const testWithCustomerRepo = createSandboxTest({
  sandboxOptions: () => ({ env: { ITERATE_CUSTOMER_REPO_PATH: CONTAINER_REPO_PATH } }),
}).concurrent;
const testWithHostSync = createSandboxTest({
  providerOptions: { syncFromHostRepo: true },
}).concurrent;

// ============ Tests ============

// Super minimal test: verify sync-home-skeleton copied .iterate/.env
describe.runIf(RUN_LOCAL_DOCKER_TESTS)("Home Skeleton Sync", () => {
  testWithSandbox(
    "DUMMY_ENV_VAR from skeleton .env is present",
    async ({ sandbox }) => {
      // Don't wait for daemon - just check env immediately
      const envOutput = await sandbox.exec(["bash", "-l", "-c", "env"]);
      expect(envOutput).toContain("DUMMY_ENV_VAR=42");
    },
    30000,
  );

  testWithSandbox(
    "dynamically added env var available in shell and pidnap",
    async ({ sandbox, expect }) => {
      await waitForHealthyOrThrow(sandbox, "daemon-backend", 180000);
      const pidnapUrl = sandbox.getUrl({ port: 9876 });
      const client = createPidnapRpcClient(pidnapUrl);

      // Step 1: Add a new env var to ~/.iterate/.env via exec
      // Using dotenv format (KEY=value) which works for both shell sourcing and dotenv parsing
      await sandbox.exec([
        "sh",
        "-c",
        'echo "DYNAMIC_TEST_VAR=added_at_runtime" >> ~/.iterate/.env',
      ]);

      // Step 2: Verify a new shell picks up the env var (shell sources .bashrc which sources .env)
      const shellEnv = await sandbox.exec(["bash", "-l", "-c", "echo $DYNAMIC_TEST_VAR"]);
      expect(shellEnv.trim()).toBe("added_at_runtime");

      // Step 3: Wait for pidnap to auto-reload opencode with new env vars
      // Note: daemon-backend has inheritGlobalEnv: false, but opencode inherits global env
      // opencode has reloadDelay: 500ms and inheritGlobalEnv: true (default)
      // Retry until the env var appears (up to 10s)
      await expect
        .poll(
          async () => {
            const info = await client.processes.get({
              target: "opencode",
              includeEffectiveEnv: true,
            });
            return info.effectiveEnv?.DYNAMIC_TEST_VAR;
          },
          { timeout: 10000, interval: 500 },
        )
        .toBe("added_at_runtime");
    },
    60000,
  );
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
  baseTest.concurrent(
    "container git state matches host worktree exactly",
    async () => {
      let worktreePath: string | undefined;
      let branchName: string | undefined;
      let sandbox: SandboxHandle | undefined;
      try {
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
        const provider = createLocalDockerProvider({
          repoRoot: worktreePath,
          syncFromHostRepo: true,
        });
        sandbox = await provider.createSandbox();
        console.log("[container] id:", sandbox.id);

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
        if (sandbox) {
          dumpContainerLogs(sandbox.id);
        }
        throw err;
      } finally {
        if (sandbox) {
          await sandbox.delete();
        }
        if (worktreePath) {
          // Cleanup worktree and branch
          try {
            execSync(`git worktree remove --force ${worktreePath}`, {
              cwd: REPO_ROOT,
              stdio: "pipe",
            });
          } catch {
            rmSync(worktreePath, { recursive: true, force: true });
            execSync(`git worktree prune`, { cwd: REPO_ROOT, stdio: "pipe" });
          }
        }
        if (branchName) {
          try {
            execSync(`git branch -D ${branchName}`, { cwd: REPO_ROOT, stdio: "pipe" });
          } catch {
            // Branch might not exist if worktree creation failed
          }
        }
      }
    },
    30000,
  );
});

describe.runIf(RUN_LOCAL_DOCKER_TESTS)("Local Docker Integration", () => {
  // ============ Container Setup ============
  describe("Container Setup", () => {
    testWithSandbox("agent CLIs installed", async ({ sandbox }) => {
      const opencode = await sandbox.exec(["opencode", "--version"]);
      expect(opencode).toMatch(/\d+\.\d+\.\d+/);

      const claude = await sandbox.exec(["claude", "--version"]);
      expect(claude).toMatch(/\d+\.\d+\.\d+/);

      const pi = await sandbox.exec(["pi", "--version"]);
      expect(pi).toMatch(/\d+\.\d+\.\d+/);
    });

    testWithAgentEnv(
      "opencode answers secret question",
      async ({ sandbox }) => {
        if (!process.env.OPENAI_API_KEY) {
          throw new Error("OPENAI_API_KEY environment variable is required");
        }
        await waitForHealthyOrThrow(sandbox, "daemon-backend", 180000);
        const output = await execWithTimeout(
          sandbox,
          [
            "bash",
            "-c",
            "source ~/.iterate/.env && opencode run 'what messaging app are you built to help with?'",
          ],
          45000,
          "opencode secret question",
        );
        expect(output.toLowerCase()).toContain("slack");
      },
      60000,
    );

    testWithAgentEnv(
      "claude answers secret question",
      async ({ sandbox }) => {
        if (!process.env.ANTHROPIC_API_KEY) {
          throw new Error("ANTHROPIC_API_KEY environment variable is required");
        }
        await waitForHealthyOrThrow(sandbox, "daemon-backend", 180000);
        const output = await execWithTimeout(
          sandbox,
          [
            "bash",
            "-c",
            "source ~/.iterate/.env && claude -p 'what messaging app are you built to help with?'",
          ],
          45000,
          "claude secret question",
        );
        expect(output.toLowerCase()).toContain("slack");
      },
      60000,
    );

    testWithAgentEnv(
      "pi answers secret question",
      async ({ sandbox }) => {
        if (!process.env.ANTHROPIC_API_KEY) {
          throw new Error("ANTHROPIC_API_KEY environment variable is required");
        }
        await waitForHealthyOrThrow(sandbox, "daemon-backend", 180000);
        // TODO: In future, verify agent instructions are passed to agents. We used to ask for the word "Slack" here,
        // but that question was too unreliable.
        const output = await execWithTimeout(
          sandbox,
          ["bash", "-c", "source ~/.iterate/.env && pi -p 'what is 50 minus 8?'"],
          45000,
          "pi secret question",
        );
        expect(output.trim().length).toBeGreaterThan(0);
        expect(output.toLowerCase()).not.toContain("invalid api key");
        expect(output).toContain("42");
      },
      60000,
    );

    testWithSandbox("container setup correct", async ({ sandbox }) => {
      // repo cloned
      const ls = await sandbox.exec(["ls", CONTAINER_REPO_PATH]);
      expect(ls).toContain("README.md");
      expect(ls).toContain("apps");
    });

    testWithSandbox("git operations work", async ({ sandbox }) => {
      const init = await sandbox.exec(["git", "init", "/tmp/test-repo"]);
      expect(init).toContain("Initialized");

      const config = await sandbox.exec(["git", "-C", "/tmp/test-repo", "config", "user.email"]);
      expect(config).toContain("@");

      await sandbox.exec(["sh", "-c", "echo 'hello' > /tmp/test-repo/test.txt"]);
      await sandbox.exec(["git", "-C", "/tmp/test-repo", "add", "."]);

      const commit = await sandbox.exec(["git", "-C", "/tmp/test-repo", "commit", "-m", "test"]);
      expect(commit).toContain("test");
    });

    testWithHostSync("git state matches host", async ({ sandbox }) => {
      const gitInfo = getLocalDockerGitInfo(REPO_ROOT);
      expect(gitInfo).toBeDefined();
      // Wait for sync-repo-from-host.sh to finish (entry.sh runs it on startup)
      const maxWaitMs = 30000;
      const start = Date.now();
      while (Date.now() - start < maxWaitMs) {
        const running = await sandbox.exec([
          "bash",
          "-c",
          "pgrep -f 'sync-repo-from-host.sh' || true",
        ]);
        if (!running.trim()) {
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }

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

    testWithSandbox("shell sources ~/.iterate/.env automatically", async ({ sandbox }) => {
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
    testWithCustomerRepo(
      "daemon accessible",
      async ({ sandbox }) => {
        await waitForHealthyOrThrow(sandbox, "daemon-backend", 180000);
        const baseUrl = sandbox.getUrl({ port: 3000 });

        // Verify health endpoint from host
        await expect
          .poll(
            async () => {
              try {
                const response = await fetch(`${baseUrl}/api/health`);
                if (!response.ok) return "";
                return await response.text();
              } catch {
                return "";
              }
            },
            { timeout: 20000, interval: 1000 },
          )
          .toMatch(/ok|healthy/);

        // Verify health from inside container
        const internalHealth = await sandbox.exec([
          "curl",
          "-s",
          "http://localhost:3000/api/health",
        ]);
        expect(internalHealth.includes("ok") || internalHealth.includes("healthy")).toBe(true);
      },
      210000,
    );

    testWithCustomerRepo(
      "PTY endpoint works",
      async ({ sandbox }) => {
        await waitForHealthyOrThrow(sandbox, "daemon-backend", 180000);
        const baseUrl = sandbox.getUrl({ port: 3000 });
        // PTY endpoint exists
        await expect
          .poll(
            async () => {
              try {
                const response = await fetch(`${baseUrl}/api/pty/ws?cols=80&rows=24`);
                return response.status;
              } catch {
                return 0;
              }
            },
            { timeout: 20000, interval: 1000 },
          )
          .not.toBe(404);
      },
      210000,
    );

    testWithCustomerRepo(
      "serves assets and routes correctly",
      async ({ sandbox }) => {
        await waitForHealthyOrThrow(sandbox, "daemon-backend", 180000);
        const baseUrl = sandbox.getUrl({ port: 3000 });
        const trpc = createDaemonTrpcClient(baseUrl);

        // index.html
        await expect
          .poll(
            async () => {
              try {
                const root = await fetch(`${baseUrl}/`);
                const contentType = root.headers.get("content-type") ?? "";
                return root.ok && contentType.includes("text/html");
              } catch {
                return false;
              }
            },
            { timeout: 20000, interval: 1000 },
          )
          .toBe(true);
        const root = await fetch(`${baseUrl}/`);
        expect(root.ok).toBe(true);
        expect(root.headers.get("content-type")).toContain("text/html");
        const html = await root.text();
        expect(html.toLowerCase()).toContain("<!doctype html>");

        // health
        await expect
          .poll(
            async () => {
              try {
                const response = await fetch(`${baseUrl}/api/health`);
                return response.ok;
              } catch {
                return false;
              }
            },
            { timeout: 20000, interval: 1000 },
          )
          .toBe(true);

        // tRPC
        const hello = await trpc.hello.query();
        expect(hello.message).toContain("Hello");

        // CSS/JS bundles
        const cssMatch = html.match(/href="(\.?\/assets\/[^"]+\.css)"/);
        const jsMatch = html.match(/src="(\.?\/assets\/[^"]+\.js)"/);
        if (cssMatch) {
          const cssUrl = `${baseUrl}${cssMatch[1]!.replace(/^\.\//, "/")}`;
          await expect
            .poll(
              async () => {
                try {
                  const response = await fetch(cssUrl);
                  return response.ok;
                } catch {
                  return false;
                }
              },
              { timeout: 20000, interval: 1000 },
            )
            .toBe(true);
        }
        if (jsMatch) {
          const jsUrl = `${baseUrl}${jsMatch[1]!.replace(/^\.\//, "/")}`;
          await expect
            .poll(
              async () => {
                try {
                  const response = await fetch(jsUrl);
                  return response.ok;
                } catch {
                  return false;
                }
              },
              { timeout: 20000, interval: 1000 },
            )
            .toBe(true);
        }

        // logo
        await expect
          .poll(
            async () => {
              try {
                const response = await fetch(`${baseUrl}/logo.svg`);
                return response.ok;
              } catch {
                return false;
              }
            },
            { timeout: 20000, interval: 1000 },
          )
          .toBe(true);

        // SPA fallback
        await expect
          .poll(
            async () => {
              try {
                const response = await fetch(`${baseUrl}/agents/some-agent-id`);
                if (!response.ok) return "";
                return response.headers.get("content-type") ?? "";
              } catch {
                return "";
              }
            },
            { timeout: 20000, interval: 1000 },
          )
          .toContain("text/html");
      },
      210000,
    );
  });

  // ============ Restart + Persistence ============
  describe("Container Restart", () => {
    testWithSandbox(
      "filesystem persists and daemon restarts",
      async ({ sandbox }) => {
        const filePath = "/home/iterate/.iterate/persist-test.txt";
        const fileContents = `persist-${Date.now()}`;

        await waitForHealthyOrThrow(sandbox, "daemon-backend", 180000);

        await sandbox.exec(["sh", "-c", `printf '%s' '${fileContents}' > ${filePath}`]);

        await sandbox.restart();

        await waitForHealthyOrThrow(sandbox, "daemon-backend", 240000);

        const restored = await sandbox.exec(["cat", filePath]);
        expect(restored).toBe(fileContents);

        const baseUrl = sandbox.getUrl({ port: 3000 });
        await expect
          .poll(
            async () => {
              try {
                const response = await fetch(`${baseUrl}/api/health`);
                return response.ok;
              } catch {
                return false;
              }
            },
            { timeout: 180000, interval: 1000 },
          )
          .toBe(true);
      },
      300000,
    );
  });

  // ============ Pidnap ============
  describe("Pidnap", () => {
    testWithSandbox(
      "processes.get returns running state for daemon-backend",
      async ({ sandbox }) => {
        const baseUrl = sandbox.getUrl({ port: 9876 });
        await waitForHealthyOrThrow(sandbox, "daemon-backend", 180000);
        const client = createPidnapRpcClient(baseUrl);
        const result = await client.processes.get({ target: "daemon-backend" });
        expect(result.state).toBe("running");
      },
      240000,
    );

    testWithSandbox(
      "processes.get fails for non-existent service",
      async ({ sandbox }) => {
        const baseUrl = sandbox.getUrl({ port: 9876 });
        await waitForHealthyOrThrow(sandbox, "daemon-backend", 180000);
        const client = createPidnapRpcClient(baseUrl);
        await expect(client.processes.get({ target: "nonexistent" })).rejects.toThrow(
          /Process not found/i,
        );
      },
      60000,
    );
  });
});
