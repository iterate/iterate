/**
 * Daemon Platform Endpoint Tests
 *
 * These tests verify the platform tRPC endpoints used for machine bootstrap:
 * - platform.setEnvVars - inject environment variables
 * - platform.cloneRepos - trigger repo cloning
 *
 * REQUIREMENTS:
 * - Docker with TCP API enabled on port 2375 (OrbStack has this by default)
 * - Set RUN_LOCAL_DOCKER_TESTS=true to run these tests
 *
 * RUN WITH:
 *   RUN_LOCAL_DOCKER_TESTS=true pnpm vitest run sandbox/daemon-platform.test.ts
 */

import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTRPCClient, httpLink } from "@trpc/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { TRPCRouter } from "../../daemon/server/trpc/router.ts";
import { dockerApi, execInContainer, waitForFileLogPattern } from "./test-helpers.ts";

function createDaemonTrpcClient(port: number) {
  return createTRPCClient<TRPCRouter>({
    links: [
      httpLink({
        url: `http://localhost:${port}/api/trpc`,
      }),
    ],
  });
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../../..");

const IMAGE_NAME = "iterate-sandbox-test";
const CONTAINER_NAME = `platform-test-${Date.now()}`;
const DAEMON_PORT = 14000 + Math.floor(Math.random() * 1000);

const RUN_LOCAL_DOCKER_TESTS = process.env.RUN_LOCAL_DOCKER_TESTS === "true";

describe.runIf(RUN_LOCAL_DOCKER_TESTS)("Daemon Platform Endpoints", () => {
  let containerId: string;

  beforeAll(async () => {
    // Compute hash of entry.ts to bust Docker cache when file changes
    const entryTsHash = execSync(
      "md5 -q apps/os/sandbox/entry.ts || md5sum apps/os/sandbox/entry.ts | cut -d' ' -f1",
      {
        cwd: REPO_ROOT,
        encoding: "utf-8",
      },
    ).trim();

    console.log(`Building sandbox image (entry.ts hash: ${entryTsHash})...`);
    execSync(
      `docker build --build-arg ENTRY_TS_HASH=${entryTsHash} -t ${IMAGE_NAME} -f apps/os/sandbox/Dockerfile .`,
      {
        cwd: REPO_ROOT,
        stdio: "inherit",
      },
    );

    // Mount local repo at /local-iterate-repo - entry.ts will detect and copy from there
    console.log("Creating container with local repo mounted...");
    const createResponse = await dockerApi<{ Id: string }>("POST", "/containers/create", {
      Image: IMAGE_NAME,
      name: CONTAINER_NAME,
      ExposedPorts: { "3000/tcp": {} },
      HostConfig: {
        PortBindings: {
          "3000/tcp": [{ HostPort: String(DAEMON_PORT) }],
        },
        Binds: [`${REPO_ROOT}:/local-iterate-repo:ro`],
      },
    });
    containerId = createResponse.Id;

    console.log(`Starting container ${containerId.slice(0, 12)} with port ${DAEMON_PORT}...`);
    await dockerApi("POST", `/containers/${containerId}/start`, {});

    // Wait for daemon to be ready - logs to /var/log/iterate-daemon/current via s6
    await waitForFileLogPattern(
      containerId,
      "/var/log/iterate-daemon/current",
      /Server running at/i,
      120000,
    );
    console.log("Daemon is ready");
  }, 300000);

  afterAll(async () => {
    if (containerId) {
      console.log("Stopping and removing container...");
      try {
        await dockerApi("POST", `/containers/${containerId}/stop?t=5`, {});
      } catch {
        // might already be stopped
      }
      await dockerApi("DELETE", `/containers/${containerId}?force=true`, undefined);
    }
  });

  test("platform.setEnvVars injects environment variables", async () => {
    const client = createDaemonTrpcClient(DAEMON_PORT);
    const uniqueValue = `test_value_${Date.now()}`;

    const result = await client.platform.setEnvVars.mutate({
      vars: { TEST_VAR: uniqueValue, ANOTHER_VAR: "another_value" },
    });

    expect(result.success).toBe(true);
    expect(result.injectedCount).toBe(2);
    expect(result.envFilePath).toContain(".iterate-platform-env");

    // Verify the env file was written with correct content
    const envFileContent = await execInContainer(containerId, [
      "cat",
      "/root/.iterate-platform-env",
    ]);
    expect(envFileContent).toContain(`export TEST_VAR="${uniqueValue}"`);
    expect(envFileContent).toContain('export ANOTHER_VAR="another_value"');
  });

  test("platform.setEnvVars makes vars available in tmux sessions", async () => {
    const client = createDaemonTrpcClient(DAEMON_PORT);
    const uniqueValue = `tmux_test_${Date.now()}`;

    // First create a tmux session
    const sessionName = `env-test-${Date.now()}`;
    await execInContainer(containerId, ["tmux", "new-session", "-d", "-s", sessionName]);

    // Inject env var (this should send source command to tmux)
    const result = await client.platform.setEnvVars.mutate({
      vars: { TMUX_TEST_VAR: uniqueValue },
    });
    expect(result.success).toBe(true);

    // Give tmux a moment to source the file
    await new Promise((r) => setTimeout(r, 500));

    // Send echo command to tmux and capture output
    await execInContainer(containerId, [
      "tmux",
      "send-keys",
      "-t",
      sessionName,
      "echo $TMUX_TEST_VAR",
      "Enter",
    ]);

    // Give command time to execute
    await new Promise((r) => setTimeout(r, 200));

    // Capture tmux pane content
    const paneContent = await execInContainer(containerId, [
      "tmux",
      "capture-pane",
      "-t",
      sessionName,
      "-p",
    ]);

    expect(paneContent).toContain(uniqueValue);

    // Cleanup
    await execInContainer(containerId, ["tmux", "kill-session", "-t", sessionName]);
  }, 30000);

  test("platform.setEnvVars rejects invalid input", async () => {
    const client = createDaemonTrpcClient(DAEMON_PORT);

    // @ts-expect-error - intentionally passing invalid input
    await expect(client.platform.setEnvVars.mutate({})).rejects.toThrow();
  });

  test("platform.cloneRepos clones a real repository", async () => {
    const client = createDaemonTrpcClient(DAEMON_PORT);
    const repoPath = "/root/src/github.com/octocat/Hello-World";

    // Request clone of a real public repo
    const result = await client.platform.cloneRepos.mutate({
      repos: [
        {
          url: "https://github.com/octocat/Hello-World.git",
          branch: "master",
          path: repoPath,
          owner: "octocat",
          name: "Hello-World",
        },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0]).toMatchObject({ owner: "octocat", name: "Hello-World" });

    // Poll filesystem until clone completes (check for .git directory)
    const pollForCloneComplete = async () => {
      const maxAttempts = 30;
      for (let i = 0; i < maxAttempts; i++) {
        try {
          const execResult = await execInContainer(containerId, ["test", "-d", `${repoPath}/.git`]);
          // If test command succeeds (no error), .git exists
          if (execResult !== undefined) {
            return;
          }
        } catch {
          // .git doesn't exist yet, keep polling
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error("Clone did not complete in time");
    };

    await pollForCloneComplete();

    // Verify the repo actually exists on disk
    const lsOutput = await execInContainer(containerId, ["ls", "-la", repoPath]);
    expect(lsOutput).toContain("README");

    // Verify it's a git repo
    const gitOutput = await execInContainer(containerId, ["git", "-C", repoPath, "remote", "-v"]);
    expect(gitOutput).toContain("octocat/Hello-World");
  }, 60000);
});
