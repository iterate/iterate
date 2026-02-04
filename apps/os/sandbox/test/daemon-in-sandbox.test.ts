/**
 * Local Docker + Pidnap Integration Tests
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
import {
  test,
  ITERATE_REPO_PATH,
  RUN_LOCAL_DOCKER_TESTS,
  createDaemonTrpcClient,
  createPidnapRpcClient,
} from "./helpers.ts";

// ============ Pidnap-Specific Tests ============

describe.runIf(RUN_LOCAL_DOCKER_TESTS).concurrent("Pidnap Integration", () => {
  describe("Env Var Hot Reload", () => {
    test("dynamically added env var available in shell and pidnap", async ({ sandbox, expect }) => {
      await sandbox.waitForServiceHealthy({ process: "daemon-backend", timeoutMs: 180000 });
      const pidnapUrl = sandbox.getUrl({ port: 9876 });
      const client = createPidnapRpcClient(pidnapUrl);

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
      // Retry until the env var appears (up to 10s)
      await expect
        .poll(
          async () => {
            const info = await client.processes.get({
              target: "opencode",
              includeEffectiveEnv: true,
            });
            return info.effectiveEnv?.DYNAMIC_TEST_VAR;
          },
          { timeout: 10000, interval: 500 },
        )
        .toBe("added_at_runtime");
    }, 60000);
  });

  describe("Process Management", () => {
    test("processes.get returns running state for daemon-backend", async ({ sandbox, expect }) => {
      const baseUrl = sandbox.getUrl({ port: 9876 });
      await sandbox.waitForServiceHealthy({ process: "daemon-backend", timeoutMs: 180000 });
      const client = createPidnapRpcClient(baseUrl);
      const result = await client.processes.get({ target: "daemon-backend" });
      expect(result.state).toBe("running");
    }, 240000);

    test("processes.get fails for non-existent service", async ({ sandbox, expect }) => {
      const baseUrl = sandbox.getUrl({ port: 9876 });
      await sandbox.waitForServiceHealthy({ process: "daemon-backend", timeoutMs: 180000 });
      const client = createPidnapRpcClient(baseUrl);
      await expect(client.processes.get({ target: "nonexistent" })).rejects.toThrow(
        /Process not found/i,
      );
    }, 60000);
  });
});

// ============ Daemon Tests ============

describe.runIf(RUN_LOCAL_DOCKER_TESTS).concurrent("Daemon Integration", () => {
  test.scoped({ sandboxOptions: { env: { ITERATE_CUSTOMER_REPO_PATH: ITERATE_REPO_PATH } } });

  test("daemon accessible", async ({ sandbox, expect }) => {
    await sandbox.waitForServiceHealthy({ process: "daemon-backend", timeoutMs: 180000 });
    const baseUrl = sandbox.getUrl({ port: 3000 });

    // Verify health endpoint from host
    await expect
      .poll(
        async () => {
          try {
            const response = await fetch(`${baseUrl}/api/health`);
            if (!response.ok) return "";
            return await response.text();
          } catch {
            return "";
          }
        },
        { timeout: 20000, interval: 1000 },
      )
      .toMatch(/ok|healthy/);

    // Verify health from inside container
    const internalHealth = await sandbox.exec(["curl", "-s", "http://localhost:3000/api/health"]);
    expect(internalHealth.includes("ok") || internalHealth.includes("healthy")).toBe(true);
  }, 210000);

  test("PTY endpoint works", async ({ sandbox, expect }) => {
    await sandbox.waitForServiceHealthy({ process: "daemon-backend", timeoutMs: 180000 });
    const baseUrl = sandbox.getUrl({ port: 3000 });
    // PTY endpoint exists
    await expect
      .poll(
        async () => {
          try {
            const response = await fetch(`${baseUrl}/api/pty/ws?cols=80&rows=24`);
            return response.status;
          } catch {
            return 0;
          }
        },
        { timeout: 20000, interval: 1000 },
      )
      .not.toBe(404);
  }, 210000);

  test("serves assets and routes correctly", async ({ sandbox, expect }) => {
    await sandbox.waitForServiceHealthy({ process: "daemon-backend", timeoutMs: 180000 });
    const baseUrl = sandbox.getUrl({ port: 3000 });
    const trpc = createDaemonTrpcClient(baseUrl);

    // index.html
    await expect
      .poll(
        async () => {
          try {
            const root = await fetch(`${baseUrl}/`);
            const contentType = root.headers.get("content-type") ?? "";
            return root.ok && contentType.includes("text/html");
          } catch {
            return false;
          }
        },
        { timeout: 20000, interval: 1000 },
      )
      .toBe(true);
    const root = await fetch(`${baseUrl}/`);
    expect(root.ok).toBe(true);
    expect(root.headers.get("content-type")).toContain("text/html");
    const html = await root.text();
    expect(html.toLowerCase()).toContain("<!doctype html>");

    // health
    await expect
      .poll(
        async () => {
          try {
            const response = await fetch(`${baseUrl}/api/health`);
            return response.ok;
          } catch {
            return false;
          }
        },
        { timeout: 20000, interval: 1000 },
      )
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
        .poll(
          async () => {
            try {
              const response = await fetch(cssUrl);
              return response.ok;
            } catch {
              return false;
            }
          },
          { timeout: 20000, interval: 1000 },
        )
        .toBe(true);
    }
    if (jsMatch) {
      const jsUrl = `${baseUrl}${jsMatch[1]!.replace(/^\.\//, "/")}`;
      await expect
        .poll(
          async () => {
            try {
              const response = await fetch(jsUrl);
              return response.ok;
            } catch {
              return false;
            }
          },
          { timeout: 20000, interval: 1000 },
        )
        .toBe(true);
    }

    // logo
    await expect
      .poll(
        async () => {
          try {
            const response = await fetch(`${baseUrl}/logo.svg`);
            return response.ok;
          } catch {
            return false;
          }
        },
        { timeout: 20000, interval: 1000 },
      )
      .toBe(true);

    // SPA fallback
    await expect
      .poll(
        async () => {
          try {
            const response = await fetch(`${baseUrl}/agents/some-agent-id`);
            if (!response.ok) return "";
            return response.headers.get("content-type") ?? "";
          } catch {
            return "";
          }
        },
        { timeout: 20000, interval: 1000 },
      )
      .toContain("text/html");
  }, 210000);
});

// ============ Container Restart Tests ============

describe.runIf(RUN_LOCAL_DOCKER_TESTS).concurrent("Container Restart", () => {
  test("filesystem persists and daemon restarts", async ({ sandbox, expect }) => {
    const filePath = "/home/iterate/.iterate/persist-test.txt";
    const fileContents = `persist-${Date.now()}`;

    await sandbox.waitForServiceHealthy({ process: "daemon-backend", timeoutMs: 180000 });

    await sandbox.exec(["sh", "-c", `printf '%s' '${fileContents}' > ${filePath}`]);

    await sandbox.restart();

    await sandbox.waitForServiceHealthy({ process: "daemon-backend", timeoutMs: 240000 });

    const restored = await sandbox.exec(["cat", filePath]);
    expect(restored).toBe(fileContents);

    const baseUrl = sandbox.getUrl({ port: 3000 });
    await expect
      .poll(
        async () => {
          try {
            const response = await fetch(`${baseUrl}/api/health`);
            return response.ok;
          } catch {
            return false;
          }
        },
        { timeout: 180000, interval: 1000 },
      )
      .toBe(true);
  }, 300000);
});
