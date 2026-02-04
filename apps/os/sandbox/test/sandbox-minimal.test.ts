/**
 * Minimal Sandbox Tests (No Pidnap/Daemon)
 *
 * These tests run against a container using `sleep infinity` as the entrypoint,
 * bypassing pidnap process supervision entirely. This is useful for fast tests
 * that only need basic container functionality (git, shell, file system).
 *
 * The entry.sh script supports this pattern: when arguments are passed to the
 * container, it execs them directly instead of starting pidnap. See:
 * apps/os/sandbox/entry.sh: `if [[ $# -gt 0 ]]; then exec "$@"; fi`
 *
 * RUN WITH:
 *   RUN_LOCAL_DOCKER_TESTS=true pnpm vitest run sandbox/test/sandbox-minimal.test.ts
 */

import { describe, expect } from "vitest";
import { test, ITERATE_REPO_PATH, RUN_LOCAL_DOCKER_TESTS } from "./helpers.ts";

/**
 * Tests that don't require pidnap or daemon - just a running container.
 * Uses `sleep infinity` as the command to keep container alive without starting pidnap.
 */
describe.runIf(RUN_LOCAL_DOCKER_TESTS).concurrent("Minimal Container Tests", () => {
  // Override sandbox command to skip pidnap - entry.sh will exec this directly
  test.scoped({ sandboxOptions: { command: ["sleep", "infinity"] } });

  describe("Container Setup", () => {
    test("agent CLIs installed", async ({ sandbox }) => {
      const opencode = await sandbox.exec(["opencode", "--version"]);
      expect(opencode).toMatch(/\d+\.\d+\.\d+/);

      const claude = await sandbox.exec(["claude", "--version"]);
      expect(claude).toMatch(/\d+\.\d+\.\d+/);

      const pi = await sandbox.exec(["pi", "--version"]);
      expect(pi).toMatch(/\d+\.\d+\.\d+/);
    });

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

    test("basic env from skeleton .env is present", async ({ sandbox }) => {
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
