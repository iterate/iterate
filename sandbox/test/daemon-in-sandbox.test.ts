/**
 * Sandbox + Pidnap Integration Tests (SLOW!)
 *
 * Tests that require the full pidnap process supervision and daemon-backend.
 * Uses the default entry.sh entrypoint which starts pidnap.
 *
 * These tests verify:
 * - Pidnap process supervision (env var reloading, process state)
 * - Daemon-backend HTTP endpoints and oRPC
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

import { describe, expect } from "vitest";
import { getDaemonClientForSandbox, getPidnapClientForSandbox } from "../providers/clients.ts";
import type { Sandbox } from "../providers/types.ts";
import { test, ITERATE_REPO_PATH, RUN_SANDBOX_TESTS, POLL_DEFAULTS } from "./helpers.ts";

type WaitForInput = {
  processes: Record<string, "healthy">;
  timeoutMs?: number;
};

type WaitForResponse = {
  allMet: boolean;
};

type GetProcessInput = {
  target: string | number;
  includeEffectiveEnv?: boolean;
};

type GetProcessResponse = {
  state: string;
  effectiveEnv?: Record<string, string>;
};

type PidnapLikeClient = {
  processes: {
    waitFor(input: WaitForInput): Promise<WaitForResponse>;
    get(input: GetProcessInput): Promise<GetProcessResponse>;
  };
};

async function callPidnapViaSandbox<T>(params: {
  sandbox: Sandbox;
  action: "waitFor" | "get";
  input: WaitForInput | GetProcessInput;
}): Promise<T> {
  const encodedInput = Buffer.from(JSON.stringify(params.input)).toString("base64");
  const script = [
    `import { createClient } from "${ITERATE_REPO_PATH}/packages/pidnap/src/api/client.ts";`,
    'const client = createClient("http://127.0.0.1:9876/rpc");',
    "const action = process.env.PIDNAP_ACTION;",
    'const input = JSON.parse(Buffer.from(process.env.PIDNAP_INPUT_B64 ?? "", "base64").toString("utf8"));',
    "const result =",
    '  action === "waitFor"',
    "    ? await client.processes.waitFor(input)",
    "    : await client.processes.get(input);",
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  const encodedScript = Buffer.from(script).toString("base64");
  const output = await params.sandbox.exec([
    "sh",
    "-c",
    `PIDNAP_ACTION='${params.action}' PIDNAP_INPUT_B64='${encodedInput}' tsx -e "$(echo '${encodedScript}' | base64 -d)"`,
  ]);
  const line = output
    .trim()
    .split("\n")
    .map((v) => v.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) {
    throw new Error("Missing pidnap response payload");
  }
  return JSON.parse(line) as T;
}

async function getPidnapClient(sandbox: Sandbox): Promise<PidnapLikeClient> {
  if (sandbox.type !== "fly") {
    return (await getPidnapClientForSandbox(sandbox)) as unknown as PidnapLikeClient;
  }

  return {
    processes: {
      waitFor: (input) =>
        callPidnapViaSandbox<WaitForResponse>({
          sandbox,
          action: "waitFor",
          input,
        }),
      get: (input) =>
        callPidnapViaSandbox<GetProcessResponse>({
          sandbox,
          action: "get",
          input,
        }),
    },
  };
}

async function fetchWithTimeout(url: string, timeoutMs = 10_000): Promise<Response | null> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return null;
  }
}

async function waitForProcessesHealthy(params: {
  sandbox: Sandbox;
  processes: Record<string, "healthy">;
  timeoutMs: number;
}): Promise<void> {
  const { sandbox, processes, timeoutMs } = params;
  await expect
    .poll(
      async () => {
        try {
          const client = await getPidnapClient(sandbox);
          const status = await client.processes.waitFor({
            processes,
            timeoutMs: 5_000,
          });
          return status.allMet;
        } catch {
          return false;
        }
      },
      {
        timeout: timeoutMs,
        interval: 500,
      },
    )
    .toBe(true);
}

// ============ Pidnap-Specific Tests ============

describe.runIf(RUN_SANDBOX_TESTS)("Pidnap Integration", () => {
  describe("Env Var Hot Reload", () => {
    test("dynamically added env var available in shell and pidnap", async ({ sandbox, expect }) => {
      const client = await getPidnapClient(sandbox);
      const backendReady = await client.processes.waitFor({
        processes: { "daemon-backend": "healthy" },
        timeoutMs: 30_000,
      });
      expect(backendReady.allMet).toBe(true);

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
      const client = await getPidnapClient(sandbox);
      const backendReady = await client.processes.waitFor({
        processes: { "daemon-backend": "healthy" },
        timeoutMs: 60_000,
      });
      expect(backendReady.allMet).toBe(true);
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
      externalId: "test-daemon-test",
      id: "daemon-test",
      name: "Daemon Test",
      envVars: { ITERATE_CUSTOMER_REPO_PATH: ITERATE_REPO_PATH },
    },
  });

  test("daemon accessible", async ({ sandbox, expect }) => {
    const client = await getPidnapClient(sandbox);
    const backendReady = await client.processes.waitFor({
      processes: { "daemon-backend": "healthy" },
      timeoutMs: 60_000,
    });
    expect(backendReady.allMet).toBe(true);
    const baseUrl = await sandbox.getBaseUrl({ port: 3000 });

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
    const client = await getPidnapClient(sandbox);
    const daemonReady = await client.processes.waitFor({
      processes: {
        "daemon-backend": "healthy",
        "daemon-frontend": "healthy",
      },
      timeoutMs: 60_000,
    });
    expect(daemonReady.allMet).toBe(true);

    const baseUrl = await sandbox.getBaseUrl({ port: 3000 });

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
    const client = await getPidnapClient(sandbox);
    const backendReady = await client.processes.waitFor({
      processes: { "daemon-backend": "healthy" },
      timeoutMs: 60_000,
    });
    expect(backendReady.allMet).toBe(true);
    const baseUrl = await sandbox.getBaseUrl({ port: 3000 });
    const orpc = (await getDaemonClientForSandbox(sandbox)) as any;

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

    // oRPC
    const hello = await orpc.daemon.hello();
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

describe.runIf(RUN_SANDBOX_TESTS)("Container Restart", () => {
  test("filesystem persists and daemon restarts", async ({ sandbox, expect }) => {
    const filePath = "/home/iterate/.iterate/persist-test.txt";
    const fileContents = `persist-${Date.now()}`;
    await waitForProcessesHealthy({
      sandbox,
      processes: { "daemon-backend": "healthy" },
      timeoutMs: 60_000,
    });

    await sandbox.exec(["sh", "-c", `printf '%s' '${fileContents}' > ${filePath}`]);

    await sandbox.restart();
    await waitForProcessesHealthy({
      sandbox,
      processes: { "daemon-backend": "healthy" },
      timeoutMs: 60_000,
    });

    const restored = await sandbox.exec(["cat", filePath]);
    expect(restored).toBe(fileContents);

    const baseUrl = await sandbox.getBaseUrl({ port: 3000 });
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
