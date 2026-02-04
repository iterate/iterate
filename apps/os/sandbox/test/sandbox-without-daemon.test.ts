/**
 * Minimal Sandbox Tests (No Pidnap/Daemon)
 *
 * These tests run against a container using `sleep infinity` as the command,
 * bypassing pidnap process supervision entirely. This is useful for fast tests
 * that only need basic container functionality (git, shell, file system, CLI tools).
 *
 * The entry.sh script supports this pattern: when arguments are passed to the
 * container, it execs them directly instead of starting pidnap. See:
 * apps/os/sandbox/entry.sh: `if [[ $# -gt 0 ]]; then exec "$@"; fi`
 *
 * IMPORTANT: The sync scripts (sync-home-skeleton.sh, sync-repo-from-host.sh) run
 * BEFORE the command override check in entry.sh, so host sync still works.
 *
 * For tests that require pidnap/daemon (process supervision, daemon endpoints),
 * see sandbox.test.ts which uses the default entry.sh entrypoint.
 *
 * RUN WITH:
 *   RUN_LOCAL_DOCKER_TESTS=true pnpm vitest run sandbox/test/sandbox-minimal.test.ts
 */

import { execSync } from "node:child_process";
import { writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test as baseTest } from "vitest";
import {
  test,
  ITERATE_REPO_PATH_ON_HOST,
  ITERATE_REPO_PATH,
  RUN_LOCAL_DOCKER_TESTS,
  getLocalDockerGitInfo,
  withSandbox,
  withWorktree,
} from "./helpers.ts";

// ============ Minimal Container Tests ============

/**
 * Tests that don't require pidnap or daemon - just a running container.
 * Uses `sleep infinity` as the command to keep container alive without starting pidnap.
 */
describe.runIf(RUN_LOCAL_DOCKER_TESTS).concurrent("Minimal Container Tests", () => {
  // Override sandbox command to skip pidnap - entry.sh will exec this directly
  test.scoped({ sandboxOptions: { command: ["sleep", "infinity"] } });

  describe("Container Setup", () => {
    test("container setup correct", async ({ sandbox }) => {
      // repo cloned
      const ls = await sandbox.exec(["ls", ITERATE_REPO_PATH]);
      expect(ls).toContain("README.md");
      expect(ls).toContain("apps");
    });

    test("git operations work", async ({ sandbox }) => {
      const init = await sandbox.exec(["git", "init", "/tmp/test-repo"]);
      expect(init).toContain("Initialized");

      const config = await sandbox.exec(["git", "-C", "/tmp/test-repo", "config", "user.email"]);
      expect(config).toContain("@");

      await sandbox.exec(["sh", "-c", "echo 'hello' > /tmp/test-repo/test.txt"]);
      await sandbox.exec(["git", "-C", "/tmp/test-repo", "add", "."]);

      const commit = await sandbox.exec(["git", "-C", "/tmp/test-repo", "commit", "-m", "test"]);
      expect(commit).toContain("test");
    });

    test("shell sources ~/.iterate/.env automatically", async ({ sandbox }) => {
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

    test("DUMMY_ENV_VAR from skeleton .env is present", async ({ sandbox }) => {
      // The sync-home-skeleton.sh runs even with sleep infinity since it's baked into the image
      // Check that DUMMY_ENV_VAR from skeleton .env is available
      const envOutput = await sandbox.exec(["bash", "-l", "-c", "env"]);
      expect(envOutput).toContain("DUMMY_ENV_VAR=42");
    }, 30000);
  });

  describe("Git Repository State", () => {
    test("repo is a valid git repository", async ({ sandbox }) => {
      const gitStatus = await sandbox.exec(["git", "-C", ITERATE_REPO_PATH, "status", "--short"]);
      // Should not throw - just verify git works
      expect(typeof gitStatus).toBe("string");
    });

    test("can read git branch", async ({ sandbox }) => {
      const branch = await sandbox.exec([
        "git",
        "-C",
        ITERATE_REPO_PATH,
        "branch",
        "--show-current",
      ]);
      // Branch might be empty string (detached HEAD) or a branch name
      expect(typeof branch.trim()).toBe("string");
    });

    test("can read git commit", async ({ sandbox }) => {
      const commit = await sandbox.exec(["git", "-C", ITERATE_REPO_PATH, "rev-parse", "HEAD"]);
      // Should be a 40-char SHA
      expect(commit.trim()).toMatch(/^[a-f0-9]{40}$/);
    });
  });
});

// ============ Host Sync Tests ============

describe.runIf(RUN_LOCAL_DOCKER_TESTS).concurrent("Host Sync (Minimal)", () => {
  test.scoped({
    providerOptions: { syncFromHostRepo: true },
    sandboxOptions: { command: ["sleep", "infinity"] },
  });

  test("git state matches host", async ({ sandbox }) => {
    const gitInfo = getLocalDockerGitInfo(ITERATE_REPO_PATH_ON_HOST);
    expect(gitInfo).toBeDefined();

    // Check branch matches (empty string if detached HEAD on both)
    const containerBranch = (
      await sandbox.exec(["git", "-C", ITERATE_REPO_PATH, "branch", "--show-current"])
    ).trim();
    expect(containerBranch).toBe(gitInfo!.branch ?? "");

    // Check commit matches
    const containerCommit = (
      await sandbox.exec(["git", "-C", ITERATE_REPO_PATH, "rev-parse", "HEAD"])
    ).trim();
    expect(containerCommit).toBe(gitInfo!.commit);
  });
});

// ============ Git Worktree Sync Test ============

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
 *
 * NOTE: Uses sleep infinity command override since we don't need pidnap for git verification.
 */
describe.runIf(RUN_LOCAL_DOCKER_TESTS)("Git Worktree Sync", () => {
  baseTest.concurrent(
    "container git state matches host worktree exactly",
    async () => {
      await withWorktree(ITERATE_REPO_PATH_ON_HOST, async (worktree) => {
        // Create dirty git state: staged, unstaged, and untracked files
        writeFileSync(join(worktree.path, "staged-new.txt"), "staged content");
        execSync("git add staged-new.txt", { cwd: worktree.path });
        appendFileSync(join(worktree.path, "README.md"), "\n# test modification");
        writeFileSync(join(worktree.path, "untracked.txt"), "untracked content");

        // Capture host git state
        const hostGitState = execSync(
          "git branch --show-current; git rev-parse HEAD; git status --porcelain",
          { cwd: worktree.path, encoding: "utf-8" },
        ).trim();

        // Create container from worktree and verify git state matches
        await withSandbox(
          { repoRoot: worktree.path, syncFromHostRepo: true },
          { command: ["sleep", "infinity"] },
          async (sandbox) => {
            const containerGitState = (
              await sandbox.exec([
                "bash",
                "-c",
                `cd ${ITERATE_REPO_PATH} && git branch --show-current; git rev-parse HEAD; git status --porcelain`,
              ])
            ).trim();

            expect(containerGitState).toBe(hostGitState);
          },
        );
      });
    },
    30000,
  );
});

// ============ Agent CLI Tests ============

/**
 * Agent CLI tests that verify the CLIs work with API keys.
 * These don't need pidnap/daemon - just the CLI binaries and API keys.
 *
 * The provider writes env vars to ~/.iterate/.env, and .bashrc sources this file,
 * so any login shell (bash -l) automatically has access to the env vars.
 */
describe.runIf(RUN_LOCAL_DOCKER_TESTS).concurrent("Agent CLI Tests", () => {
  if (!process.env.OPENAI_API_KEY || !process.env.ANTHROPIC_API_KEY) {
    throw new Error("OPENAI_API_KEY and ANTHROPIC_API_KEY environment variables are required");
  }

  test.scoped({
    sandboxOptions: {
      command: ["sleep", "infinity"],
      env: {
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      },
    },
  });

  test("opencode answers question", async ({ sandbox }) => {
    const output = await sandbox.exec(["bash", "-l", "-c", "opencode run 'what is 50 minus 8?'"]);
    expect(output).toContain("42");
  }, 15000);

  test("claude answers question", async ({ sandbox }) => {
    const output = await sandbox.exec(["bash", "-l", "-c", "claude -p 'what is 50 minus 8?'"]);
    expect(output).toContain("42");
  }, 15000);

  test("pi answers question", async ({ sandbox }) => {
    const output = await sandbox.exec(["bash", "-l", "-c", "pi -p 'what is 50 minus 8?'"]);
    expect(output).toContain("42");
  }, 15000);
});
