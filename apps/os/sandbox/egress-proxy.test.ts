/**
 * Egress Proxy Integration Tests
 *
 * Tests the mitmproxy-based egress proxy that intercepts outbound traffic
 * and forwards it through the worker endpoint for API token injection.
 *
 * RUN WITH:
 *   RUN_LOCAL_DOCKER_TESTS=true pnpm vitest run sandbox/egress-proxy.test.ts
 *
 * REQUIRES:
 *   - Local dev server running (pnpm dev in apps/os) OR
 *   - VITE_PUBLIC_URL set to a reachable endpoint
 */

import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dockerApi, execInContainer } from "./test-helpers.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../../..");

const IMAGE_NAME = "iterate-sandbox-egress-test";
const CONTAINER_REPO_PATH = "/home/iterate/src/github.com/iterate/iterate";

const RUN_LOCAL_DOCKER_TESTS = process.env.RUN_LOCAL_DOCKER_TESTS === "true";

// ============ Helpers ============

function createContainerName(): string {
  return `egress-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function waitForDaemonHealthy(containerId: string, timeoutMs = 180000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await execInContainer(containerId, [
        "curl",
        "-sf",
        "--max-time",
        "2",
        "http://localhost:3000/api/health",
      ]);
      if (response.includes("ok") || response.includes("healthy")) {
        return;
      }
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Timeout waiting for daemon to be ready");
}

// ============ Tests ============

describe.runIf(RUN_LOCAL_DOCKER_TESTS)("Egress Proxy", () => {
  let containerId: string;

  beforeAll(async () => {
    console.log("Building sandbox image...");
    execSync(`pnpm snapshot:local-docker`, {
      cwd: join(REPO_ROOT, "apps/os"),
      stdio: "inherit",
      env: { ...process.env, LOCAL_DOCKER_IMAGE_NAME: IMAGE_NAME },
    });

    console.log("Creating container...");
    const envVars = [
      "PATH=/home/iterate/.local/bin:/home/iterate/.npm-global/bin:/home/iterate/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    ];

    const createResponse = await dockerApi<{ Id: string }>("POST", "/containers/create", {
      Image: IMAGE_NAME,
      name: createContainerName(),
      Env: envVars,
      Tty: false,
      HostConfig: {
        AutoRemove: false,
        Binds: [`${REPO_ROOT}:/local-iterate-repo:ro`],
        ExtraHosts: ["host.docker.internal:host-gateway"],
      },
    });
    containerId = createResponse.Id;

    console.log(`Starting container ${containerId.slice(0, 12)}...`);
    await dockerApi("POST", `/containers/${containerId}/start`, {});

    console.log("Waiting for daemon to be healthy...");
    await waitForDaemonHealthy(containerId);
    console.log("Daemon ready!");
  }, 300000);

  afterAll(async () => {
    if (containerId) {
      console.log("Cleaning up container...");
      try {
        await dockerApi("POST", `/containers/${containerId}/stop?t=5`, {});
      } catch {
        // might already be stopped
      }
      await dockerApi("DELETE", `/containers/${containerId}?force=true`, undefined);
    }
  }, 30000);

  test("mitmproxy is installed", async () => {
    const result = await execInContainer(containerId, ["which", "mitmdump"]);
    expect(result.trim()).toContain("mitmdump");
  });

  test("addon script exists", async () => {
    const result = await execInContainer(containerId, [
      "cat",
      `${CONTAINER_REPO_PATH}/apps/os/sandbox/egress-proxy-addon.py`,
    ]);
    expect(result).toContain("EgressProxyAddon");
    expect(result).toContain("mitmproxy");
  });

  test("passthrough mode intercepts HTTP/HTTPS via env vars", async () => {
    // Start mitmproxy in passthrough mode (no addon, no worker)
    await execInContainer(containerId, ["sh", "-c", "mitmdump -p 8888 --ssl-insecure -q &"]);
    await new Promise((r) => setTimeout(r, 2000));

    // HTTP request using HTTP_PROXY env var (no -x flag!)
    const httpResult = await execInContainer(containerId, [
      "sh",
      "-c",
      "HTTP_PROXY=http://127.0.0.1:8888 curl -s --max-time 5 http://httpbin.org/get 2>&1",
    ]);
    expect(httpResult).toContain("origin");

    // HTTPS request using HTTPS_PROXY env var (with -k for self-signed cert)
    const httpsResult = await execInContainer(containerId, [
      "sh",
      "-c",
      "HTTPS_PROXY=http://127.0.0.1:8888 curl -sk --max-time 5 https://httpbin.org/get 2>&1",
    ]);
    expect(httpsResult).toContain("origin");

    // Cleanup
    await execInContainer(containerId, ["sh", "-c", "pkill mitmdump || true"]);
  }, 30000);

  test("forwards to worker endpoint and injects OpenAI token via HTTPS_PROXY", async () => {
    // Use host.docker.internal to reach host's localhost
    const baseUrl = (process.env.VITE_PUBLIC_URL || "http://localhost:5173").replace(
      "localhost",
      "host.docker.internal",
    );
    const healthUrl = `${baseUrl}/api/health`;
    const addonPath = `${CONTAINER_REPO_PATH}/apps/os/sandbox/egress-proxy-addon.py`;

    // Check worker is reachable - FAIL if not (don't skip)
    const healthCheck = await execInContainer(containerId, [
      "sh",
      "-c",
      `curl -sk --max-time 3 ${healthUrl} 2>&1`,
    ]);

    if (
      !healthCheck ||
      healthCheck.includes("Connection refused") ||
      healthCheck.includes("curl:")
    ) {
      throw new Error(
        `Worker not reachable at ${healthUrl}. ` +
          `Run 'pnpm dev' in apps/os or set VITE_PUBLIC_URL to a reachable endpoint.`,
      );
    }

    // Start mitmproxy with addon pointing to egress proxy endpoint
    const egressProxyUrl = `${baseUrl}/api/egress-proxy`;
    await execInContainer(containerId, [
      "sh",
      "-c",
      `ITERATE_EGRESS_PROXY_URL="${egressProxyUrl}" ITERATE_OS_API_KEY="test-key" mitmdump -p 8889 -s ${addonPath} --ssl-insecure -q &`,
    ]);
    await new Promise((r) => setTimeout(r, 2000));

    // Request OpenAI API using HTTPS_PROXY env var (no -x flag!)
    // This is how real code in the sandbox will work
    const result = await execInContainer(containerId, [
      "sh",
      "-c",
      "HTTPS_PROXY=http://127.0.0.1:8889 curl -sk --max-time 10 https://api.openai.com/v1/models 2>&1",
    ]);

    // If token was injected correctly, we get a models list (contains "object")
    // If not, we get 401 unauthorized
    expect(result).toContain("object");

    // Cleanup
    await execInContainer(containerId, ["sh", "-c", "pkill mitmdump || true"]);
  }, 30000);
});
