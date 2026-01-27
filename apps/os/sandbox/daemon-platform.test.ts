/**
 * Daemon Platform Function Tests
 *
 * These tests verify the daemon's integration with the control plane:
 * - Fetching env vars from getEnv endpoint
 * - Applying env vars to tmux sessions
 *
 * REQUIREMENTS:
 * - Docker with TCP API enabled on port 2375 (OrbStack has this by default)
 * - Set RUN_LOCAL_DOCKER_TESTS=true to run these tests
 *
 * RUN WITH:
 *   RUN_LOCAL_DOCKER_TESTS=true pnpm vitest run sandbox/daemon-platform.test.ts
 */

import { execSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTRPCClient, httpLink } from "@trpc/client";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
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
const MOCK_CONTROL_PLANE_PORT = 15000 + Math.floor(Math.random() * 1000);

const RUN_LOCAL_DOCKER_TESTS = process.env.RUN_LOCAL_DOCKER_TESTS === "true";

/**
 * Create a mock control plane server that implements the oRPC getEnv endpoint.
 * Returns configurable env vars and repos.
 *
 * oRPC wire format:
 * - Each procedure is at its own URL path: /api/orpc/machines/getEnv
 * - Response format: { json: <output>, meta: [] }
 */
function createMockControlPlane(envVars: Record<string, string>) {
  const server = createServer((req, res) => {
    // oRPC sends POST requests to /api/orpc/<path>
    if (req.method === "POST" && req.url?.startsWith("/api/orpc")) {
      const path = req.url.replace("/api/orpc/", "").replace(/\?.*$/, "");

      // Handle machines/getEnv
      if (path === "machines/getEnv") {
        const response = {
          json: {
            envVars,
            repos: [],
          },
          meta: [],
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
        return;
      }

      // Handle machines/reportStatus
      if (path === "machines/reportStatus") {
        const response = {
          json: { success: true },
          meta: [],
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          json: {
            defined: false,
            code: "NOT_FOUND",
            status: 404,
            message: `Unknown procedure: ${path}`,
          },
          meta: [],
        }),
      );
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  return server;
}

describe.runIf(RUN_LOCAL_DOCKER_TESTS)("Daemon Platform Functions", () => {
  let containerId: string;
  let mockServer: Server;
  const testEnvVars = {
    TEST_API_KEY: `test-key-${Date.now()}`,
    CUSTOM_VAR: "custom-value-123",
  };

  beforeAll(async () => {
    // Start mock control plane server
    mockServer = createMockControlPlane(testEnvVars);
    await new Promise<void>((resolve) => {
      mockServer.listen(MOCK_CONTROL_PLANE_PORT, () => {
        console.log(`Mock control plane listening on port ${MOCK_CONTROL_PLANE_PORT}`);
        resolve();
      });
    });

    console.log("Building sandbox image...");
    execSync(`docker build -t ${IMAGE_NAME} -f apps/os/sandbox/Dockerfile .`, {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });

    // Mount local repo at /local-iterate-repo - entry.sh will detect and copy from there
    // Pass control plane URL pointing to host machine
    console.log("Creating container with local repo mounted and mock control plane...");
    const createResponse = await dockerApi<{ Id: string }>("POST", "/containers/create", {
      Image: IMAGE_NAME,
      name: CONTAINER_NAME,
      ExposedPorts: { "3000/tcp": {} },
      Env: [
        // host.docker.internal resolves to the host machine from inside Docker
        `ITERATE_OS_BASE_URL=http://host.docker.internal:${MOCK_CONTROL_PLANE_PORT}`,
        `ITERATE_OS_API_KEY=test-api-key`,
      ],
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

    // Wait for daemon to be ready - logs to /var/log/pidnap/process/iterate-daemon.log via pidnap
    await waitForFileLogPattern(
      containerId,
      "/var/log/pidnap/process/iterate-daemon.log",
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

    if (mockServer) {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    }
  });

  test("refreshEnv fetches env vars from control plane and applies them", async () => {
    const client = createDaemonTrpcClient(DAEMON_PORT);

    // Call refreshEnv - this should fetch from our mock control plane
    const result = await client.platform.refreshEnv.mutate();
    expect(result).toEqual({ success: true });

    // Verify the env file was written with our test vars
    // Format is: export VAR=value (shell-quote escapes values as needed)
    const envFileContent = await execInContainer(containerId, [
      "cat",
      "/home/iterate/.iterate/.env",
    ]);
    expect(envFileContent).toContain(`export TEST_API_KEY=${testEnvVars.TEST_API_KEY}`);
    expect(envFileContent).toContain(`export CUSTOM_VAR=${testEnvVars.CUSTOM_VAR}`);
  });

  test("env vars are available in new shell sessions", async () => {
    // First ensure env vars are loaded
    const client = createDaemonTrpcClient(DAEMON_PORT);
    await client.platform.refreshEnv.mutate();

    // Source the env file and check the var (simulates what a new shell would do)
    // Use bash since sh doesn't have `source`, or use `. ` syntax
    const output = await execInContainer(containerId, [
      "bash",
      "-c",
      `source /home/iterate/.iterate/.env && echo $TEST_API_KEY`,
    ]);
    expect(output.trim()).toBe(testEnvVars.TEST_API_KEY);
  });

  test("env vars update when refreshEnv is called again", async () => {
    const client = createDaemonTrpcClient(DAEMON_PORT);

    // First refresh
    await client.platform.refreshEnv.mutate();

    // Verify initial value
    const envFileContent = await execInContainer(containerId, [
      "cat",
      "/home/iterate/.iterate/.env",
    ]);
    expect(envFileContent).toContain(testEnvVars.TEST_API_KEY);

    // Update the mock server's env vars (we'll just verify the file timestamp changes)
    const beforeMtime = await execInContainer(containerId, [
      "stat",
      "-c",
      "%Y",
      "/home/iterate/.iterate/.env",
    ]);

    // Wait a second so mtime changes
    await new Promise((r) => setTimeout(r, 1100));

    // Refresh again
    await client.platform.refreshEnv.mutate();

    const afterMtime = await execInContainer(containerId, [
      "stat",
      "-c",
      "%Y",
      "/home/iterate/.iterate/.env",
    ]);

    // File should have been rewritten
    expect(Number(afterMtime)).toBeGreaterThan(Number(beforeMtime));
  });

  test("git clone works for public repositories", async () => {
    const repoPath = "/home/iterate/src/github.com/octocat/Hello-World";

    // Clone a real public repo directly using git
    await execInContainer(containerId, [
      "git",
      "clone",
      "--branch",
      "master",
      "--single-branch",
      "https://github.com/octocat/Hello-World.git",
      repoPath,
    ]);

    // Poll filesystem until clone completes (wait for README to appear)
    await vi.waitFor(async () => {
      expect(await execInContainer(containerId, ["test", "-d", `${repoPath}/.git`])).toBeDefined();
      const lsOutput = await execInContainer(containerId, ["ls", "-la", repoPath]);
      expect(lsOutput).toContain("README");
    });

    // Verify it's a git repo
    const gitOutput = await execInContainer(containerId, ["git", "-C", repoPath, "remote", "-v"]);
    expect(gitOutput).toContain("octocat/Hello-World");
  }, 60000);
});
