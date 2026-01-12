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

    console.log("Creating container with dev mode (bind mount)...");
    const createResponse = await dockerApi<{ Id: string }>("POST", "/containers/create", {
      Image: IMAGE_NAME,
      name: CONTAINER_NAME,
      Env: ["ITERATE_DEV=true"],
      HostConfig: {
        Binds: [`${REPO_ROOT}:/iterate-repo`],
      },
    });
    containerId = createResponse.Id;

    console.log(`Starting container ${containerId.slice(0, 12)}...`);
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

  test("service-b starts and both services become ready", async () => {
    const logs = await waitForLogPattern(containerId, /\[service-b\] Listening on port 3002/);
    expect(logs).toContain("[service-b] Listening on port 3002");

    const logsWithReady = await waitForLogPattern(
      containerId,
      /\[service-a\] Ready after 2000ms delay/,
    );
    expect(logsWithReady).toContain("[service-a] Ready after 2000ms delay");
    expect(logsWithReady).toContain("[service-b] Ready immediately");
  }, 30000);

  test("can tail logs using docker CLI", async () => {
    const result = execSync(`docker logs --tail 10 ${containerId}`, {
      encoding: "utf-8",
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result).toMatch(/s6|service-a|service-b/i);
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
