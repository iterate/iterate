/**
 * Sandbox + Pidnap Integration Tests (SLOW!)
 *
 * Tests that require the full pidnap process supervision and daemon-backend.
 * Uses the default entry.sh entrypoint which starts pidnap.
 *
 * These tests verify:
 * - Pidnap process supervision (env var reloading, process state)
 * - Daemon-backend HTTP endpoints and tRPC
 * - Container restart with daemon recovery
 *
 * For lightweight tests that don't need pidnap/daemon (git, CLI tools, container setup),
 * see sandbox-without-daemon.test.ts which uses provider entrypoint args to bypass pidnap.
 *
 * RUN WITH:
 *   RUN_SANDBOX_TESTS=true pnpm sandbox test
 *
 * See sandbox/test/helpers.ts for full configuration options.
 */

import { describe } from "vitest";
import type { TRPCRouter } from "../../apps/daemon/server/trpc/router.ts";
import { getDaemonClientForSandbox, getPidnapClientForSandbox } from "../providers/clients.ts";
import type { Sandbox } from "../providers/types.ts";
import {
  test,
  ITERATE_REPO_PATH,
  RUN_SANDBOX_TESTS,
  POLL_DEFAULTS,
  TEST_CONFIG,
} from "./helpers.ts";

class TerminalProcessStateError extends Error {}

async function fetchWithTimeout(url: string, timeoutMs = 10_000): Promise<Response | null> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return null;
  }
}

/**
 * Wait for a process to become healthy using pidnap client.
 *
 * NOTE: Currently failing on Daytona due to oRPC routing issue.
 * See tasks/daytona-provider-testing.md for details.
 */
async function waitForServiceHealthy(params: {
  sandbox: Sandbox;
  process: string;
  timeoutMs?: number;
}): Promise<void> {
  const { sandbox, process, timeoutMs = 60_000 } = params;

  if (sandbox.type === "fly" && (process === "daemon-backend" || process === "daemon-frontend")) {
    const healthUrl =
      process === "daemon-backend"
        ? "http://127.0.0.1:3001/api/health"
        : "http://127.0.0.1:3000/api/health";
    const start = Date.now();
    let lastError: unknown;

    while (Date.now() - start < timeoutMs) {
      try {
        const response = await sandbox.exec(["curl", "-sf", "--max-time", "5", healthUrl]);
        if (response.includes('"status":"ok"')) return;
      } catch (error) {
        lastError = error;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    throw new Error(`Timeout waiting for ${process} to become healthy: ${String(lastError)}`);
  }

  const start = Date.now();
  let lastError: unknown;

  while (Date.now() - start < timeoutMs) {
    const remainingMs = timeoutMs - (Date.now() - start);
    try {
      const client = await getPidnapClientForSandbox(sandbox);
      const status = await client.processes.waitForRunning({
        target: process,
        timeoutMs: Math.min(10_000, remainingMs),
        pollIntervalMs: 500,
        includeLogs: true,
        logTailLines: 120,
      });

      if (status.state === "running") return;
      if (status.state === "stopped" || status.state === "max-restarts-reached") {
        throw new TerminalProcessStateError(
          `Process ${process} failed while starting. Final state=${status.state}. Logs:\n${status.logs ?? "(none)"}`,
        );
      }
    } catch (error) {
      if (error instanceof TerminalProcessStateError) throw error;
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(`Timeout waiting for ${process} to become healthy: ${String(lastError)}`);
}

// ============ Pidnap-Specific Tests ============

describe.runIf(RUN_SANDBOX_TESTS && TEST_CONFIG.provider !== "fly")("Pidnap Integration", () => {
  describe("Env Var Hot Reload", () => {
    test("dynamically added env var available in shell and pidnap", async ({ sandbox, expect }) => {
      await waitForServiceHealthy({ sandbox, process: "daemon-backend", timeoutMs: 30000 });
      const client = await getPidnapClientForSandbox(sandbox);

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
      await expect
        .poll(async () => {
          const info = await client.processes.get({
            target: "opencode",
            includeEffectiveEnv: true,
          });
          return info.effectiveEnv?.DYNAMIC_TEST_VAR;
        }, POLL_DEFAULTS)
        .toBe("added_at_runtime");
    }, 180000);
  });

  describe("Process Management", () => {
    test("processes.get returns running state for daemon-backend", async ({ sandbox, expect }) => {
      await waitForServiceHealthy({ sandbox, process: "daemon-backend" });
      const client = await getPidnapClientForSandbox(sandbox);
      const result = await client.processes.get({ target: "daemon-backend" });
      expect(result.state).toBe("running");
      await expect(client.processes.get({ target: "nonexistent" })).rejects.toThrow(
        /Process not found/i,
      );
    }, 90000);
  });
});

// ============ Daemon Tests ============

describe.runIf(RUN_SANDBOX_TESTS)("Daemon Integration", () => {
  test.scoped({
    sandboxOptions: {
      id: "daemon-test",
      name: "Daemon Test",
      envVars: { ITERATE_CUSTOMER_REPO_PATH: ITERATE_REPO_PATH },
    },
  });

  test("daemon accessible", async ({ sandbox, expect }) => {
    await waitForServiceHealthy({ sandbox, process: "daemon-backend" });
    const baseUrl = await sandbox.getPreviewUrl({ port: 3000 });

    // Verify health endpoint from host
    await expect
      .poll(async () => {
        const response = await fetchWithTimeout(`${baseUrl}/api/health`);
        if (!response?.ok) return "";
        return await response.text();
      }, POLL_DEFAULTS)
      .toMatch(/ok|healthy/);

    // Verify health from inside container
    const internalHealth = await sandbox.exec(["curl", "-s", "http://localhost:3000/api/health"]);
    expect(internalHealth.includes("ok") || internalHealth.includes("healthy")).toBe(true);
  }, 90000);

  test("PTY endpoint works", async ({ sandbox, expect }) => {
    // Wait for both backend (has the PTY endpoint) and frontend (Vite proxy for WebSocket)
    await waitForServiceHealthy({ sandbox, process: "daemon-backend" });
    await waitForServiceHealthy({ sandbox, process: "daemon-frontend" });

    const baseUrl = await sandbox.getPreviewUrl({ port: 3000 });

    // First verify the proxy is working by polling for health endpoint
    await expect
      .poll(async () => {
        const response = await fetchWithTimeout(`${baseUrl}/api/health`);
        return response?.ok ?? false;
      }, POLL_DEFAULTS)
      .toBe(true);

    // Now test the WebSocket PTY endpoint (proxied through Vite to backend)
    const wsUrl = `${baseUrl.replace(/^http/, "ws")}/api/pty/ws?cols=80&rows=24`;

    await expect
      .poll(async () => {
        return new Promise<string>((resolve) => {
          const ws = new WebSocket(wsUrl);
          const timeout = setTimeout(() => {
            ws.close();
            resolve("timeout");
          }, 3000);
          ws.onopen = () => {
            clearTimeout(timeout);
            ws.close();
            resolve("connected");
          };
          ws.onerror = () => {
            clearTimeout(timeout);
            resolve("error");
          };
        });
      }, POLL_DEFAULTS)
      .toBe("connected");
  }, 90000);

  test("serves assets and routes correctly", async ({ sandbox, expect }) => {
    await waitForServiceHealthy({ sandbox, process: "daemon-backend" });
    const baseUrl = await sandbox.getPreviewUrl({ port: 3000 });
    const trpc = await getDaemonClientForSandbox<TRPCRouter>(sandbox);

    // index.html
    await expect
      .poll(async () => {
        const root = await fetchWithTimeout(`${baseUrl}/`);
        if (!root) return false;
        const contentType = root.headers.get("content-type") ?? "";
        return root.ok && contentType.includes("text/html");
      }, POLL_DEFAULTS)
      .toBe(true);
    const root = await fetchWithTimeout(`${baseUrl}/`);
    if (!root) throw new Error("Timed out fetching daemon index page");
    expect(root.ok).toBe(true);
    expect(root.headers.get("content-type")).toContain("text/html");
    const html = await root.text();
    expect(html.toLowerCase()).toContain("<!doctype html>");

    // health
    await expect
      .poll(async () => {
        const response = await fetchWithTimeout(`${baseUrl}/api/health`);
        return response?.ok ?? false;
      }, POLL_DEFAULTS)
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
        .poll(async () => {
          const response = await fetchWithTimeout(cssUrl);
          return response?.ok ?? false;
        }, POLL_DEFAULTS)
        .toBe(true);
    }
    if (jsMatch) {
      const jsUrl = `${baseUrl}${jsMatch[1]!.replace(/^\.\//, "/")}`;
      await expect
        .poll(async () => {
          const response = await fetchWithTimeout(jsUrl);
          return response?.ok ?? false;
        }, POLL_DEFAULTS)
        .toBe(true);
    }

    // logo
    await expect
      .poll(async () => {
        const response = await fetchWithTimeout(`${baseUrl}/logo.svg`);
        return response?.ok ?? false;
      }, POLL_DEFAULTS)
      .toBe(true);

    // SPA fallback
    await expect
      .poll(async () => {
        const response = await fetchWithTimeout(`${baseUrl}/agents/some-agent-id`);
        if (!response?.ok) return "";
        return response.headers.get("content-type") ?? "";
      }, POLL_DEFAULTS)
      .toContain("text/html");
  }, 90000);
});

// ============ Container Restart Tests ============

describe.runIf(RUN_SANDBOX_TESTS && TEST_CONFIG.provider !== "fly")("Container Restart", () => {
  test("filesystem persists and daemon restarts", async ({ sandbox, expect }) => {
    const filePath = "/home/iterate/.iterate/persist-test.txt";
    const fileContents = `persist-${Date.now()}`;

    await waitForServiceHealthy({ sandbox, process: "daemon-backend" });

    await sandbox.exec(["sh", "-c", `printf '%s' '${fileContents}' > ${filePath}`]);

    await sandbox.restart();

    await waitForServiceHealthy({ sandbox, process: "daemon-backend" });

    const restored = await sandbox.exec(["cat", filePath]);
    expect(restored).toBe(fileContents);

    const baseUrl = await sandbox.getPreviewUrl({ port: 3000 });
    await expect
      .poll(
        async () => {
          const response = await fetchWithTimeout(`${baseUrl}/api/health`);
          return response?.ok ?? false;
        },
        { timeout: 60_000, interval: 500 }, // longer timeout for container restart
      )
      .toBe(true);
  }, 120000);
});
