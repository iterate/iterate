/**
 * Local Docker + s6 Integration Tests
 *
 * These tests verify the sandbox container setup with s6 process supervision.
 * They use selective bind mounts: source code from host, but node_modules
 * shadowed by anonymous volumes so the container uses Linux-compiled native modules.
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
 *   RUN_LOCAL_DOCKER_TESTS=true pnpm vitest run sandbox/local-docker.integration.test.ts
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../../..");

const DOCKER_API_URL = "http://127.0.0.1:2375";
const IMAGE_NAME = "iterate-sandbox-test";
const CONTAINER_NAME = `sandbox-integration-test-${Date.now()}`;
const ITERATE_SERVER_HOST_PORT = 13000 + Math.floor(Math.random() * 1000);

const RUN_LOCAL_DOCKER_TESTS = process.env.RUN_LOCAL_DOCKER_TESTS === "true";

async function dockerApi<T>(
  method: string,
  endpoint: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${DOCKER_API_URL}${endpoint}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(`Docker API error: ${(error as { message?: string }).message}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : ({} as T);
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
    execSync(`docker build -t ${IMAGE_NAME} -f apps/os2/sandbox/Dockerfile .`, {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });

    console.log("Creating container with selective bind mount (source only, not node_modules)...");
    const createResponse = await dockerApi<{ Id: string }>("POST", "/containers/create", {
      Image: IMAGE_NAME,
      name: CONTAINER_NAME,
      Env: ["ITERATE_DEV=true"],
      ExposedPorts: { "3000/tcp": {} },
      HostConfig: {
        // Selective bind mount: mount source code but shadow node_modules with anonymous volumes
        // This lets us use host's source code while container uses its own Linux-compiled native modules
        // Note: dist/ is NOT shadowed - it gets rebuilt inside container with Linux binaries
        Binds: [
          `${REPO_ROOT}:/iterate-repo`,
          "/iterate-repo/node_modules",
          "/iterate-repo/apps/daemon2/node_modules",
          "/iterate-repo/apps/os2/node_modules",
        ],
        PortBindings: {
          "3000/tcp": [{ HostPort: String(ITERATE_SERVER_HOST_PORT) }],
        },
      },
    });
    containerId = createResponse.Id;

    console.log(
      `Starting container ${containerId.slice(0, 12)} with port ${ITERATE_SERVER_HOST_PORT}...`,
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
      "/iterate-repo/s6-daemons/example-service-a",
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
    const response = await execInContainer(containerId, [
      "curl",
      "-s",
      "http://localhost:3002/ping",
    ]);
    expect(response).toContain("pong from service-a");
    expect(response).toContain("-> service-b");
  }, 10000);

  test("iterate-server daemon starts and logs are written to /var/log/iterate-server/current", async () => {
    await expect
      .poll(
        async () => {
          const logs = await execInContainer(containerId, [
            "cat",
            "/var/log/iterate-server/current",
          ]);
          return logs.includes("Listening") || logs.includes("localhost:3000");
        },
        { timeout: 120000, interval: 3000 },
      )
      .toBe(true);

    const logs = await execInContainer(containerId, ["cat", "/var/log/iterate-server/current"]);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).toContain("Listening");
  }, 130000);

  test("iterate-server health check responds OK from inside container", async () => {
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

  test("iterate-server accessible from host via exposed port", async () => {
    await expect
      .poll(
        async () => {
          try {
            const response = await fetch(`http://localhost:${ITERATE_SERVER_HOST_PORT}/api/health`);
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

  test("bind mount reflects local file changes", async () => {
    const runFilePath = join(REPO_ROOT, "s6-daemons/example-service-a/run");
    const originalContent = readFileSync(runFilePath, "utf-8");

    try {
      const modifiedContent = originalContent.replace(
        "--name service-a",
        "--name service-a-modified",
      );
      writeFileSync(runFilePath, modifiedContent);

      await execInContainer(containerId, [
        "s6-svc",
        "-r",
        "/iterate-repo/s6-daemons/example-service-a",
      ]);

      const logs = await waitForLogPattern(
        containerId,
        /\[service-a-modified\] Listening on port 3001/,
        15000,
      );
      expect(logs).toContain("[service-a-modified] Listening on port 3001");
    } finally {
      writeFileSync(runFilePath, originalContent);

      await execInContainer(containerId, [
        "s6-svc",
        "-r",
        "/iterate-repo/s6-daemons/example-service-a",
      ]);
      await waitForLogPattern(containerId, /\[service-a\] Listening on port 3001/, 15000);
    }
  }, 30000);
});
