/**
 * Local Docker + s6 Integration Tests
 *
 * These tests verify the sandbox container setup with s6 process supervision.
 * The image is rebuilt from the local repo and runs without bind mounts.
 *
 * EXPECTED DURATION:
 * - Fast MacBook Pro (M-series, cached layers): ~30 seconds
 * - First run (needs pnpm install + vite build inside container): ~2-3 minutes
 * - CI environments: expect 3-5+ minutes depending on resources
 *
 * REQUIREMENTS:
 * - Docker with TCP API enabled on port 2375 (OrbStack has this by default)
 * - Set RUN_LOCAL_DOCKER_TESTS=true to run these tests
 *
 * RUN WITH:
 *   RUN_LOCAL_DOCKER_TESTS=true pnpm vitest run sandbox/local-docker.test.ts
 */

import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { TRPCRouter } from "../../daemon/server/trpc/router.ts";
import { dockerApi, DOCKER_API_URL } from "../backend/providers/local-docker.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../../..");

const IMAGE_NAME = "iterate-sandbox-test";
const CONTAINER_NAME = `sandbox-integration-test-${Date.now()}`;
const ITERATE_DAEMON_HOST_PORT = 13000 + Math.floor(Math.random() * 1000);

// The repo path inside the container (cloned by entry.ts to ~/src/github.com/iterate/iterate)
const CONTAINER_REPO_PATH = "/root/src/github.com/iterate/iterate";

const RUN_LOCAL_DOCKER_TESTS = process.env.RUN_LOCAL_DOCKER_TESTS === "true";

function createDaemonTrpcClient(port: number) {
  return createTRPCClient<TRPCRouter>({
    links: [
      httpBatchLink({
        url: `http://localhost:${port}/api/trpc`,
        transformer: superjson,
      }),
    ],
  });
}

async function getContainerLogs(containerId: string): Promise<string> {
  const response = await fetch(
    `${DOCKER_API_URL}/containers/${containerId}/logs?stdout=true&stderr=true&timestamps=true`,
  );
  if (!response.ok) throw new Error("Failed to get logs");
  const buffer = await response.arrayBuffer();
  return decodeDockerLogs(new Uint8Array(buffer));
}

function decodeDockerLogs(buffer: Uint8Array): string {
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

async function waitForLogPattern(
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

async function getServiceFileLogs(containerId: string, logPath: string): Promise<string> {
  return execInContainer(containerId, ["cat", logPath]);
}

async function waitForFileLogPattern(
  containerId: string,
  logPath: string,
  pattern: RegExp,
  timeoutMs = 60000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const logs = await getServiceFileLogs(containerId, logPath);
      if (pattern.test(logs)) return logs;
    } catch {
      // File might not exist yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timeout waiting for file log pattern in ${logPath}: ${pattern}`);
}

async function execInContainer(containerId: string, cmd: string[]): Promise<string> {
  const execCreate = await dockerApi<{ Id: string }>("POST", `/containers/${containerId}/exec`, {
    AttachStdout: true,
    AttachStderr: true,
    Cmd: cmd,
  });

  const response = await fetch(`${DOCKER_API_URL}/exec/${execCreate.Id}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ Detach: false, Tty: false }),
  });

  const buffer = await response.arrayBuffer();
  return decodeDockerLogs(new Uint8Array(buffer));
}

describe.runIf(RUN_LOCAL_DOCKER_TESTS)("Local Docker + s6 Integration", () => {
  let containerId: string;

  beforeAll(async () => {
    console.log("Building sandbox image...");
    execSync(`docker build -t ${IMAGE_NAME} -f apps/os/sandbox/Dockerfile .`, {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });

    console.log("Creating container without bind mounts...");
    const createResponse = await dockerApi<{ Id: string }>("POST", "/containers/create", {
      Image: IMAGE_NAME,
      name: CONTAINER_NAME,
      ExposedPorts: { "3000/tcp": {} },
      HostConfig: {
        PortBindings: {
          "3000/tcp": [{ HostPort: String(ITERATE_DAEMON_HOST_PORT) }],
        },
      },
    });
    containerId = createResponse.Id;

    console.log(
      `Starting container ${containerId.slice(0, 12)} with port ${ITERATE_DAEMON_HOST_PORT}...`,
    );
    await dockerApi("POST", `/containers/${containerId}/start`, {});
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

  test("s6-svscan starts successfully", async () => {
    const logs = await waitForLogPattern(containerId, /Starting s6-svscan/);
    expect(logs).toContain("Starting s6-svscan");
  }, 60000);

  test("container uses image filesystem without bind mounts", async () => {
    const inspect = await dockerApi<{ HostConfig?: { Binds?: string[] } }>(
      "GET",
      `/containers/${containerId}/json`,
    );
    const binds = inspect.HostConfig?.Binds ?? [];
    expect(binds).toMatchInlineSnapshot("[]");
  });

  test("service-a starts (slow starter, 2s delay)", async () => {
    const logs = await waitForLogPattern(containerId, /\[service-a\] Listening on port 3001/);
    expect(logs).toContain("[service-a] Listening on port 3001");
  }, 30000);

  test("service-b starts with file-based log rotation", async () => {
    const serviceBLogPath = "/var/log/example-service-b/current";

    const logs = await waitForFileLogPattern(
      containerId,
      serviceBLogPath,
      /\[service-b\] Listening on port 3002/,
    );
    expect(logs).toContain("[service-b] Listening on port 3002");
    expect(logs).toContain("[service-b] Ready immediately");
  }, 30000);

  test("service-a becomes ready (stdout logs)", async () => {
    const logsWithReady = await waitForLogPattern(
      containerId,
      /\[service-a\] Ready after 2000ms delay/,
    );
    expect(logsWithReady).toContain("[service-a] Ready after 2000ms delay");
  }, 30000);

  test("can tail stdout logs using docker CLI (service-a, not service-b)", async () => {
    const result = execSync(`docker logs --tail 20 ${containerId}`, {
      encoding: "utf-8",
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result).toMatch(/s6|service-a/i);
  });

  test("can tail file-based logs for service-b", async () => {
    const logs = await getServiceFileLogs(containerId, "/var/log/example-service-b/current");
    expect(logs).toContain("[service-b]");
    expect(logs).toContain("Listening on port 3002");
  });

  test("can restart s6 service and see it in logs", async () => {
    const logsBefore = await getContainerLogs(containerId);
    const restartCountBefore = (logsBefore.match(/\[service-a\] Listening/g) ?? []).length;

    await execInContainer(containerId, [
      "s6-svc",
      "-r",
      `${CONTAINER_REPO_PATH}/s6-daemons/example-service-a`,
    ]);

    await new Promise((r) => setTimeout(r, 5000));

    const logsAfter = await getContainerLogs(containerId);
    const restartCountAfter = (logsAfter.match(/\[service-a\] Listening/g) ?? []).length;

    expect(restartCountAfter).toBeGreaterThan(restartCountBefore);
  }, 30000);

  test("health endpoints respond correctly", async () => {
    const serviceAHealth = await execInContainer(containerId, [
      "curl",
      "-s",
      "http://localhost:3001/health",
    ]);
    expect(serviceAHealth).toContain('"status":"ok"');

    const serviceBHealth = await execInContainer(containerId, [
      "curl",
      "-s",
      "http://localhost:3002/health",
    ]);
    expect(serviceBHealth).toContain('"status":"ok"');
  }, 10000);

  test("service-b successfully proxies to service-a via /ping", async () => {
    // service-b's upstream is configured to service-a's /health endpoint
    // so /ping returns the health JSON response + " -> service-b"
    const response = await execInContainer(containerId, [
      "curl",
      "-s",
      "http://localhost:3002/ping",
    ]);
    expect(response).toContain('"status":"ok"');
    expect(response).toContain('"name":"service-a"');
    expect(response).toContain("-> service-b");
  }, 10000);

  // FLAKY: Container clones from GitHub, not local checkout. Log path depends on what's
  // deployed to main branch. Will fail if local changes to s6-daemons/iterate-daemon
  // haven't been pushed yet.
  test.skip("iterate-daemon starts and logs are written to file", async () => {
    await expect
      .poll(
        async () => {
          const logs = await execInContainer(containerId, [
            "cat",
            "/var/log/iterate-daemon/current",
          ]);
          return /Server running at http:\/\/.+:3000/.test(logs);
        },
        { timeout: 120000, interval: 3000 },
      )
      .toBe(true);
  }, 130000);

  test("iterate-daemon health check responds OK from inside container", async () => {
    await expect
      .poll(
        async () => {
          const response = await execInContainer(containerId, [
            "curl",
            "-s",
            "http://localhost:3000/api/health",
          ]);
          return response.includes("ok") || response.includes("healthy");
        },
        { timeout: 30000, interval: 2000 },
      )
      .toBe(true);
  }, 40000);

  test("iterate-daemon accessible from host via exposed port", async () => {
    await expect
      .poll(
        async () => {
          try {
            const response = await fetch(`http://localhost:${ITERATE_DAEMON_HOST_PORT}/api/health`);
            const text = await response.text();
            return response.ok && (text.includes("ok") || text.includes("healthy"));
          } catch {
            return false;
          }
        },
        { timeout: 30000, interval: 2000 },
      )
      .toBe(true);
  }, 40000);

  test("repo is cloned and accessible in container", async () => {
    // The container clones from GitHub, so we just verify the repo exists and has expected structure
    const result = await execInContainer(containerId, ["ls", `${CONTAINER_REPO_PATH}`]);
    expect(result).toContain("README.md");
    expect(result).toContain("apps");
    expect(result).toContain("s6-daemons");
  });

  // ============ Tmux + PTY tests ============

  test("tmux is installed in container", async () => {
    const result = await execInContainer(containerId, ["which", "tmux"]);
    expect(result.trim()).toBe("/usr/bin/tmux");
  });

  test("can create and list tmux sessions via tRPC", async () => {
    const trpc = createDaemonTrpcClient(ITERATE_DAEMON_HOST_PORT);
    const testSessionName = `test-session-${Date.now()}`;

    // Create a tmux session via tRPC
    const createResult = await trpc.ensureTmuxSession.mutate({
      sessionName: testSessionName,
      command: "bash",
    });
    expect(createResult.created).toBe(true);

    // List sessions and verify it exists
    const sessions = await trpc.listTmuxSessions.query();
    expect(sessions.some((s: { name: string }) => s.name === testSessionName)).toBe(true);
  }, 30000);

  test("can create tmux session directly in container and verify it exists", async () => {
    const sessionName = `direct-test-${Date.now()}`;

    // Create tmux session directly via exec (bypassing daemon)
    const createResult = await execInContainer(containerId, [
      "tmux",
      "new-session",
      "-d",
      "-s",
      sessionName,
    ]);
    // tmux returns empty on success
    expect(createResult.trim()).toBe("");

    // Verify the session exists
    const listResult = await execInContainer(containerId, ["tmux", "list-sessions"]);
    expect(listResult).toContain(sessionName);

    // Clean up
    await execInContainer(containerId, ["tmux", "kill-session", "-t", sessionName]);
  }, 30000);

  test("PTY endpoint route exists", async () => {
    // Node's fetch can't do WebSocket upgrades, so just verify the route exists
    // by making a regular GET request - should get 400 Bad Request (not 404)
    const response = await fetch(
      `http://localhost:${ITERATE_DAEMON_HOST_PORT}/api/pty/ws?cols=80&rows=24`,
    );
    // Route should exist (not 404) - will likely be 400 or 426 since it expects WebSocket
    expect(response.status).not.toBe(404);
  });

  // ============ Client asset serving tests ============

  test("daemon serves index.html at root", async () => {
    const response = await fetch(`http://localhost:${ITERATE_DAEMON_HOST_PORT}/`);
    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type")).toContain("text/html");

    const html = await response.text();
    expect(html.toLowerCase()).toContain("<!doctype html>");
    expect(html).toContain("<title>");
    // Should reference the built JS bundle (either absolute or relative path)
    expect(html).toMatch(/src="\.?\/assets\/index-[a-zA-Z0-9]+\.js"/);
  });

  test("daemon serves CSS bundle", async () => {
    // First get index.html to find the actual CSS filename
    const indexResponse = await fetch(`http://localhost:${ITERATE_DAEMON_HOST_PORT}/`);
    const html = await indexResponse.text();

    // Extract CSS filename from the HTML (e.g., /assets/index-B298OPQd.css or ./assets/...)
    const cssMatch = html.match(/href="(\.?\/assets\/index-[a-zA-Z0-9]+\.css)"/);
    expect(cssMatch).not.toBeNull();

    const cssPath = cssMatch![1]!.replace(/^\.\//, "/"); // Normalize ./assets to /assets
    const cssResponse = await fetch(`http://localhost:${ITERATE_DAEMON_HOST_PORT}${cssPath}`);
    expect(cssResponse.ok).toBe(true);
    expect(cssResponse.headers.get("content-type")).toContain("text/css");

    const css = await cssResponse.text();
    expect(css.length).toBeGreaterThan(1000); // Should be a substantial CSS file
  });

  test("daemon serves JS bundle", async () => {
    // First get index.html to find the actual JS filename
    const indexResponse = await fetch(`http://localhost:${ITERATE_DAEMON_HOST_PORT}/`);
    const html = await indexResponse.text();

    // Extract JS filename from the HTML (e.g., /assets/index-ZAeYHw86.js or ./assets/...)
    const jsMatch = html.match(/src="(\.?\/assets\/index-[a-zA-Z0-9]+\.js)"/);
    expect(jsMatch).not.toBeNull();

    const jsPath = jsMatch![1]!.replace(/^\.\//, "/"); // Normalize ./assets to /assets
    const jsResponse = await fetch(`http://localhost:${ITERATE_DAEMON_HOST_PORT}${jsPath}`);
    expect(jsResponse.ok).toBe(true);
    expect(jsResponse.headers.get("content-type")).toContain("javascript");

    const js = await jsResponse.text();
    expect(js.length).toBeGreaterThan(10000); // Should be a substantial JS bundle
  });

  // ============ Proxy compatibility tests ============
  // These verify that all paths the os worker proxy would forward to work correctly

  test("all proxy-forwarded routes respond correctly", async () => {
    const baseUrl = `http://localhost:${ITERATE_DAEMON_HOST_PORT}`;
    const trpc = createDaemonTrpcClient(ITERATE_DAEMON_HOST_PORT);

    // 1. Root path (index.html) - used when accessing /org/.../proxy/3000/
    const rootResponse = await fetch(`${baseUrl}/`);
    expect(rootResponse.ok).toBe(true);
    expect(rootResponse.headers.get("content-type")).toContain("text/html");

    // 2. Health endpoint - used by proxy health checks
    const healthResponse = await fetch(`${baseUrl}/api/health`);
    expect(healthResponse.ok).toBe(true);
    const healthBody = await healthResponse.text();
    expect(healthBody).toMatch(/ok|healthy/i);

    // 3. tRPC endpoints - the main API surface
    const serverCwd = await trpc.getServerCwd.query();
    expect(serverCwd.cwd).toBe(`${CONTAINER_REPO_PATH}/apps/daemon`);
    expect(serverCwd.homeDir).toBe("/root");

    // 4. Static assets with cache-busted filenames
    const indexHtml = await (await fetch(`${baseUrl}/`)).text();
    const cssMatch = indexHtml.match(/href="(\.?\/assets\/[^"]+\.css)"/);
    const jsMatch = indexHtml.match(/src="(\.?\/assets\/[^"]+\.js)"/);

    if (cssMatch) {
      const cssPath = cssMatch[1]!.replace(/^\.\//, "/");
      const cssResponse = await fetch(`${baseUrl}${cssPath}`);
      expect(cssResponse.ok).toBe(true);
    }

    if (jsMatch) {
      const jsPath = jsMatch[1]!.replace(/^\.\//, "/");
      const jsResponse = await fetch(`${baseUrl}${jsPath}`);
      expect(jsResponse.ok).toBe(true);
    }

    // 5. Favicon/logo
    const logoResponse = await fetch(`${baseUrl}/logo.svg`);
    expect(logoResponse.ok).toBe(true);
    expect(logoResponse.headers.get("content-type")).toContain("svg");

    // 6. SPA fallback - non-existent paths should return index.html for client-side routing
    const spaResponse = await fetch(`${baseUrl}/agents/some-agent-id`);
    expect(spaResponse.ok).toBe(true);
    expect(spaResponse.headers.get("content-type")).toContain("text/html");
    const spaHtml = await spaResponse.text();
    expect(spaHtml).toContain("<title>");
  });
});
