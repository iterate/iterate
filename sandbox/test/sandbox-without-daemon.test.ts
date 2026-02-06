/**
 * Minimal Sandbox Tests (No Pidnap/Daemon)
 *
 * These are reasonably fast, though there are currently three tests that do hit LLMs.
 *
 * These tests run against a container using `sleep infinity` provider entrypoint args,
 * bypassing pidnap process supervision entirely. This is useful for fast tests
 * that only need basic container functionality (git, shell, file system, CLI tools).
 *
 * The entry.sh script supports this pattern: when entrypoint args are passed
 * (directly or via SANDBOX_ENTRY_ARGS), it execs them instead of starting pidnap. See:
 * sandbox/entry.sh: `if [[ $# -gt 0 ]]; then exec "$@"; fi`
 *
 * IMPORTANT: The sync scripts (sync-home-skeleton.sh, sync-repo-from-host.sh) run
 * BEFORE the entrypoint-args override check in entry.sh, so host sync still works.
 *
 * For tests that require pidnap/daemon (process supervision, daemon endpoints),
 * see daemon-in-sandbox.test.ts which uses the default entry.sh entrypoint.
 *
 * RUN WITH:
 *   RUN_SANDBOX_TESTS=true pnpm sandbox test
 *
 * See sandbox/test/helpers.ts for full configuration options.
 */

import { describe, expect } from "vitest";
import { test, ITERATE_REPO_PATH, RUN_SANDBOX_TESTS, TEST_CONFIG } from "./helpers.ts";

const BASE_TEST_TIMEOUT_MS = TEST_CONFIG.provider === "daytona" ? 180_000 : 30_000;
const CLI_TEST_TIMEOUT_MS = TEST_CONFIG.provider === "daytona" ? 60_000 : 15_000;

// ============ Minimal Container Tests ============

/**
 * Tests that don't require pidnap or daemon - just a running container.
 * Uses `sleep infinity` provider entrypoint args to keep container alive without starting pidnap.
 */
describe.runIf(RUN_SANDBOX_TESTS)("Minimal Container Tests", () => {
  // Override provider entrypoint args to skip pidnap - entry.sh will exec these directly
  test.scoped({
    sandboxOptions: {
      id: "minimal-test",
      name: "Minimal Test",
      envVars: {},
      entrypointArguments: ["sleep", "infinity"],
    },
  });

  describe("Container Setup", () => {
    test(
      "container setup correct",
      async ({ sandbox }) => {
        // repo cloned
        const ls = await sandbox.exec(["ls", ITERATE_REPO_PATH]);
        expect(ls).toContain("README.md");
        expect(ls).toContain("apps");
      },
      BASE_TEST_TIMEOUT_MS,
    );

    test(
      "git operations work",
      async ({ sandbox }) => {
        const init = await sandbox.exec(["git", "init", "/tmp/test-repo"]);
        expect(init).toContain("Initialized");

        const config = await sandbox.exec(["git", "-C", "/tmp/test-repo", "config", "user.email"]);
        expect(config).toContain("@");

        await sandbox.exec(["sh", "-c", "echo 'hello' > /tmp/test-repo/test.txt"]);
        await sandbox.exec(["git", "-C", "/tmp/test-repo", "add", "."]);

        const commit = await sandbox.exec(["git", "-C", "/tmp/test-repo", "commit", "-m", "test"]);
        expect(commit).toContain("test");
      },
      BASE_TEST_TIMEOUT_MS,
    );

    test(
      "shell sources ~/.iterate/.env automatically",
      async ({ sandbox }) => {
        // Write env var to ~/.iterate/.env
        await sandbox.exec([
          "sh",
          "-c",
          'echo "TEST_ITERATE_ENV_VAR=hello_from_env_file" >> ~/.iterate/.env',
        ]);

        // Start a new login shell and check if env var is available
        const envOutput = await sandbox.exec([
          "bash",
          "-l",
          "-c",
          "env | grep TEST_ITERATE_ENV_VAR",
        ]);

        expect(envOutput).toContain("hello_from_env_file");
      },
      BASE_TEST_TIMEOUT_MS,
    );

    test(
      "DUMMY_ENV_VAR from skeleton .env is present",
      async ({ sandbox }) => {
        // The sync-home-skeleton.sh runs even with sleep infinity since it's baked into the image
        // Check that DUMMY_ENV_VAR from skeleton .env is available
        const envOutput = await sandbox.exec(["bash", "-l", "-c", "env"]);
        expect(envOutput).toContain("DUMMY_ENV_VAR=42");
      },
      BASE_TEST_TIMEOUT_MS,
    );
  });

  describe("Git Repository State", () => {
    test(
      "repo is a valid git repository",
      async ({ sandbox }) => {
        const gitStatus = await sandbox.exec(["git", "-C", ITERATE_REPO_PATH, "status", "--short"]);
        // Should not throw - just verify git works
        expect(typeof gitStatus).toBe("string");
      },
      BASE_TEST_TIMEOUT_MS,
    );

    test(
      "can read git branch",
      async ({ sandbox }) => {
        const branch = await sandbox.exec([
          "git",
          "-C",
          ITERATE_REPO_PATH,
          "branch",
          "--show-current",
        ]);
        // Branch might be empty string (detached HEAD) or a branch name
        expect(typeof branch.trim()).toBe("string");
      },
      BASE_TEST_TIMEOUT_MS,
    );

    test(
      "can read git commit",
      async ({ sandbox }) => {
        const commit = await sandbox.exec(["git", "-C", ITERATE_REPO_PATH, "rev-parse", "HEAD"]);
        // Should be a 40-char SHA
        expect(commit.trim()).toMatch(/^[a-f0-9]{40}$/);
      },
      BASE_TEST_TIMEOUT_MS,
    );
  });
});

// ============ Agent CLI Tests ============

/**
 * Agent CLI tests that verify the CLIs work with API keys.
 * These don't need pidnap/daemon - just the CLI binaries and API keys.
 *
 * The provider writes env vars to ~/.iterate/.env, and .bashrc sources this file,
 * so any login shell (bash -l) automatically has access to the env vars.
 */
// Skip if API keys not available (checked at test registration time, not module load)
const hasApiKeys = Boolean(process.env.OPENAI_API_KEY && process.env.ANTHROPIC_API_KEY);

describe.runIf(RUN_SANDBOX_TESTS && hasApiKeys)("Agent CLI Tests", () => {
  test.scoped({
    sandboxOptions: {
      id: "agent-cli-test",
      name: "Agent CLI Test",
      entrypointArguments: ["sleep", "infinity"],
      envVars: {
        OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
      },
    },
  });

  test(
    "opencode answers question",
    async ({ sandbox }) => {
      const output = await sandbox.exec(["bash", "-l", "-c", "opencode run 'what is 50 minus 8?'"]);
      expect(output).toContain("42");
    },
    CLI_TEST_TIMEOUT_MS,
  );

  test(
    "claude answers question",
    async ({ sandbox }) => {
      const output = await sandbox.exec(["bash", "-l", "-c", "claude -p 'what is 50 minus 8?'"]);
      expect(output).toContain("42");
    },
    CLI_TEST_TIMEOUT_MS,
  );

  test(
    "pi answers question",
    async ({ sandbox }) => {
      const output = await sandbox.exec(["bash", "-l", "-c", "pi -p 'what is 50 minus 8?'"]);
      expect(output).toContain("42");
    },
    CLI_TEST_TIMEOUT_MS,
  );
});
