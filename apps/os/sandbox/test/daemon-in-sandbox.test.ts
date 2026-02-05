/**
 * Local Docker + Pidnap Integration Tests (SLOW!)
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
 * see sandbox-minimal.test.ts which uses `command: ["sleep", "infinity"]` to bypass pidnap.
 *
 * RUN WITH:
 *   RUN_LOCAL_DOCKER_TESTS=true pnpm vitest run sandbox/test/sandbox.test.ts
 */

import { describe } from "vitest";
import { test, ITERATE_REPO_PATH, RUN_LOCAL_DOCKER_TESTS, POLL_DEFAULTS } from "./helpers.ts";

// ============ Pidnap-Specific Tests ============

describe.runIf(RUN_LOCAL_DOCKER_TESTS).concurrent("Pidnap Integration", () => {
  describe("Env Var Hot Reload", () => {
    test("dynamically added env var available in shell and pidnap", async ({ sandbox, expect }) => {
      await sandbox.waitForServiceHealthy({ process: "daemon-backend" });
      const client = sandbox.pidnapOrpcClient();

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
    }, 120_000);
  });

  describe("Process Management", () => {
    test("processes.get returns running state for daemon-backend", async ({ sandbox, expect }) => {
      await sandbox.waitForServiceHealthy({ process: "daemon-backend" });
      const client = sandbox.pidnapOrpcClient();
      const result = await client.processes.get({ target: "daemon-backend" });
      expect(result.state).toBe("running");
      await expect(client.processes.get({ target: "nonexistent" })).rejects.toThrow(
        /Process not found/i,
      );
    }, 120_000);
  });
});

// ============ Daemon Tests ============

describe.runIf(RUN_LOCAL_DOCKER_TESTS).concurrent("Daemon Integration", () => {
  test.scoped({ sandboxOptions: { env: { ITERATE_CUSTOMER_REPO_PATH: ITERATE_REPO_PATH } } });

  test("daemon accessible", async ({ sandbox, expect }) => {
    await sandbox.waitForServiceHealthy({ process: "daemon-backend" });
    const baseUrl = sandbox.getUrl({ port: 3000 });

    // Verify health endpoint from host
    await expect
      .poll(async () => {
        const response = await fetch(`${baseUrl}/api/health`);
        if (!response.ok) return "";
        return await response.text();
      }, POLL_DEFAULTS)
      .toMatch(/ok|healthy/);

    // Verify health from inside container
    const internalHealth = await sandbox.exec(["curl", "-s", "http://localhost:3000/api/health"]);
    expect(internalHealth.includes("ok") || internalHealth.includes("healthy")).toBe(true);
  }, 120_000);

  test("PTY endpoint works", async ({ sandbox, expect }) => {
    // Wait for both backend (has the PTY endpoint) and frontend (Vite proxy for WebSocket)
    await sandbox.waitForServiceHealthy({ process: "daemon-backend" });
    await sandbox.waitForServiceHealthy({ process: "daemon-frontend" });

    const baseUrl = sandbox.getUrl({ port: 3000 });

    // First verify the proxy is working by polling for health endpoint
    await expect
      .poll(async () => {
        const response = await fetch(`${baseUrl}/api/health`).catch(() => null);
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
  }, 120_000);

  test("serves assets and routes correctly", async ({ sandbox, expect }) => {
    await sandbox.waitForServiceHealthy({ process: "daemon-backend" });
    const baseUrl = sandbox.getUrl({ port: 3000 });
    const trpc = sandbox.daemonTrpcClient();

    // index.html
    await expect
      .poll(async () => {
        const root = await fetch(`${baseUrl}/`);
        const contentType = root.headers.get("content-type") ?? "";
        return root.ok && contentType.includes("text/html");
      }, POLL_DEFAULTS)
      .toBe(true);
    const root = await fetch(`${baseUrl}/`);
    expect(root.ok).toBe(true);
    expect(root.headers.get("content-type")).toContain("text/html");
    const html = await root.text();
    expect(html.toLowerCase()).toContain("<!doctype html>");

    // health
    await expect
      .poll(async () => {
        const response = await fetch(`${baseUrl}/api/health`);
        return response.ok;
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
          const response = await fetch(cssUrl);
          return response.ok;
        }, POLL_DEFAULTS)
        .toBe(true);
    }
    if (jsMatch) {
      const jsUrl = `${baseUrl}${jsMatch[1]!.replace(/^\.\//, "/")}`;
      await expect
        .poll(async () => {
          const response = await fetch(jsUrl);
          return response.ok;
        }, POLL_DEFAULTS)
        .toBe(true);
    }

    // logo
    await expect
      .poll(async () => {
        const response = await fetch(`${baseUrl}/logo.svg`);
        return response.ok;
      }, POLL_DEFAULTS)
      .toBe(true);

    // SPA fallback
    await expect
      .poll(async () => {
        const response = await fetch(`${baseUrl}/agents/some-agent-id`);
        if (!response.ok) return "";
        return response.headers.get("content-type") ?? "";
      }, POLL_DEFAULTS)
      .toContain("text/html");
  }, 120_000);
});

// ============ Container Restart Tests ============

describe.runIf(RUN_LOCAL_DOCKER_TESTS).concurrent("Container Restart", () => {
  test("filesystem persists and daemon restarts", async ({ sandbox, expect }) => {
    const filePath = "/home/iterate/.iterate/persist-test.txt";
    const fileContents = `persist-${Date.now()}`;

    await sandbox.waitForServiceHealthy({ process: "daemon-backend" });

    await sandbox.exec(["sh", "-c", `printf '%s' '${fileContents}' > ${filePath}`]);

    await sandbox.restart();

    await sandbox.waitForServiceHealthy({ process: "daemon-backend" });

    const restored = await sandbox.exec(["cat", filePath]);
    expect(restored).toBe(fileContents);

    const baseUrl = sandbox.getUrl({ port: 3000 });
    await expect
      .poll(
        async () => {
          const response = await fetch(`${baseUrl}/api/health`);
          return response.ok;
        },
        { timeout: 60_000, interval: 500 }, // longer timeout for container restart
      )
      .toBe(true);
  }, 180_000);
});
