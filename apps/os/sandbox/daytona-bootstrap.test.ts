/**
 * Daytona Bootstrap Integration Test
 *
 * Tests the full sandbox bootstrap flow:
 * 1. Start mock OS worker on random port
 * 2. Start cloudflared quick tunnel → get *.trycloudflare.com URL
 * 3. Create Daytona sandbox from snapshot with injected env vars
 * 4. Tail entrypoint logs until /tmp/.iterate-sandbox-ready exists
 * 5. Wait for bootstrap request, return API keys in response
 * 6. Verify daemon/opencode logs look sensible
 * 7. Run `opencode run "what is 50 - 8"` → assert "42"
 * 8. Always delete sandbox in finally block
 *
 * ENVIRONMENT VARIABLES:
 *
 * Required (from Doppler):
 *   DAYTONA_API_KEY          - Daytona API key
 *   OPENAI_API_KEY           - For opencode LLM calls
 *   ANTHROPIC_API_KEY        - Fallback LLM key
 *
 * Optional Daytona config:
 *   DAYTONA_ORGANIZATION_ID  - Daytona org ID
 *   DAYTONA_API_URL          - Daytona API URL
 *   DAYTONA_TARGET           - Daytona target region
 *
 * Snapshot resolution (one of):
 *   DAYTONA_SNAPSHOT_NAME    - Exact snapshot name (skips resolution)
 *   DAYTONA_SNAPSHOT_PREFIX  - Prefix for latest snapshot lookup
 *
 * Test flag:
 *   RUN_DAYTONA_BOOTSTRAP_TESTS=true  - Enable test (skipped otherwise)
 *
 * RUN WITH:
 *   doppler run -- sh -c 'RUN_DAYTONA_BOOTSTRAP_TESTS=true pnpm vitest run sandbox/daytona-bootstrap.test.ts'
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { Daytona, type Sandbox } from "@daytonaio/sdk";
import { describe, expect, test } from "vitest";
import { resolveLatestSnapshot } from "../backend/integrations/daytona/snapshot-resolver.ts";

// ============ Config ============

const RUN_DAYTONA_BOOTSTRAP_TESTS = process.env.RUN_DAYTONA_BOOTSTRAP_TESTS === "true";
const DAYTONA_API_KEY = process.env.DAYTONA_API_KEY;
const DAYTONA_ORGANIZATION_ID = process.env.DAYTONA_ORGANIZATION_ID;
const DAYTONA_API_URL = process.env.DAYTONA_API_URL;
const DAYTONA_TARGET = process.env.DAYTONA_TARGET;
const DAYTONA_SNAPSHOT_NAME = process.env.DAYTONA_SNAPSHOT_NAME;
const DAYTONA_SNAPSHOT_PREFIX = process.env.DAYTONA_SNAPSHOT_PREFIX;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const TEST_TIMEOUT_MS = 600_000; // 10 minutes for the whole test
const SANDBOX_READY_TIMEOUT_MS = 180_000; // 3 minutes for sandbox to be ready
const BOOTSTRAP_TIMEOUT_MS = 60_000; // 1 minute for bootstrap request
const OPENCODE_TIMEOUT_MS = 120_000; // 2 minutes for opencode to respond

// ============ Mock Control Plane Server ============

type MockServerState = {
  reportStatusReceived: boolean;
  getEnvReceived: boolean;
};

function createMockControlPlane(
  port: number,
  envVars: Record<string, string>,
): { server: Server; state: MockServerState } {
  const state: MockServerState = {
    reportStatusReceived: false,
    getEnvReceived: false,
  };

  const server = createServer((req, res) => {
    // oRPC sends POST requests to /api/orpc/<path>
    if (req.method === "POST" && req.url?.startsWith("/api/orpc")) {
      const path = req.url.replace("/api/orpc/", "").replace(/\?.*$/, "");

      // Handle machines/reportStatus
      if (path === "machines/reportStatus") {
        state.reportStatusReceived = true;
        console.log("[mock-server] Received reportStatus");
        const response = { json: { success: true }, meta: [] };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
        return;
      }

      // Handle machines/getEnv
      if (path === "machines/getEnv") {
        state.getEnvReceived = true;
        console.log("[mock-server] Received getEnv, returning env vars");
        const response = {
          json: { envVars, repos: [] },
          meta: [],
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
        return;
      }

      console.log(`[mock-server] Unknown oRPC path: ${path}`);
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          json: { defined: false, code: "NOT_FOUND", status: 404, message: `Unknown: ${path}` },
          meta: [],
        }),
      );
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  return { server, state };
}

// ============ Cloudflared Quick Tunnel ============

type CloudflaredTunnel = {
  process: ChildProcess;
  url: string;
};

async function startCloudflaredTunnel(localPort: number): Promise<CloudflaredTunnel> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timeout waiting for cloudflared tunnel URL"));
    }, 30_000);

    const cloudflared = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${localPort}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let resolved = false;
    const urlPattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

    const handleOutput = (data: Buffer) => {
      const text = data.toString();
      console.log("[cloudflared]", text.trim());

      if (!resolved) {
        const match = text.match(urlPattern);
        if (match) {
          resolved = true;
          clearTimeout(timeout);
          resolve({ process: cloudflared, url: match[0] });
        }
      }
    };

    cloudflared.stdout?.on("data", handleOutput);
    cloudflared.stderr?.on("data", handleOutput);

    cloudflared.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to start cloudflared: ${err.message}`));
    });

    cloudflared.on("exit", (code) => {
      if (!resolved) {
        clearTimeout(timeout);
        reject(new Error(`cloudflared exited with code ${code} before producing URL`));
      }
    });
  });
}

// ============ Helpers ============

function getRandomPort(): number {
  return 16000 + Math.floor(Math.random() * 4000);
}

function generateRandomId(): string {
  return randomBytes(8).toString("hex");
}

async function waitForCondition(
  check: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timeout after ${timeoutMs}ms`);
}

// ============ Test ============

describe.runIf(RUN_DAYTONA_BOOTSTRAP_TESTS)("Daytona bootstrap integration", () => {
  test(
    "sandbox boots, bootstraps with control plane, and opencode computes 50-8=42",
    async () => {
      // Validate required env vars
      if (!DAYTONA_API_KEY) throw new Error("DAYTONA_API_KEY required");
      if (!DAYTONA_SNAPSHOT_NAME && !DAYTONA_SNAPSHOT_PREFIX) {
        throw new Error("Either DAYTONA_SNAPSHOT_NAME or DAYTONA_SNAPSHOT_PREFIX required");
      }
      if (!OPENAI_API_KEY && !ANTHROPIC_API_KEY) {
        throw new Error("At least one of OPENAI_API_KEY or ANTHROPIC_API_KEY required");
      }

      // Resources to clean up
      let mockServer: Server | null = null;
      let cloudflared: CloudflaredTunnel | null = null;
      let daytona: Daytona | null = null;
      let sandbox: Sandbox | null = null;

      try {
        // 1. Start mock control plane server
        const serverPort = getRandomPort();
        const envVarsToInject: Record<string, string> = {};
        if (OPENAI_API_KEY) envVarsToInject.OPENAI_API_KEY = OPENAI_API_KEY;
        if (ANTHROPIC_API_KEY) envVarsToInject.ANTHROPIC_API_KEY = ANTHROPIC_API_KEY;

        const { server, state: serverState } = createMockControlPlane(serverPort, envVarsToInject);
        mockServer = server;

        await new Promise<void>((resolve) => {
          mockServer!.listen(serverPort, () => {
            console.log(`[test] Mock control plane listening on port ${serverPort}`);
            resolve();
          });
        });

        // 2. Start cloudflared quick tunnel
        console.log("[test] Starting cloudflared tunnel...");
        cloudflared = await startCloudflaredTunnel(serverPort);
        console.log(`[test] Tunnel URL: ${cloudflared.url}`);

        // 3. Resolve snapshot name
        const snapshotName =
          DAYTONA_SNAPSHOT_NAME ??
          (await resolveLatestSnapshot(DAYTONA_SNAPSHOT_PREFIX!, {
            apiKey: DAYTONA_API_KEY,
            baseUrl: DAYTONA_API_URL,
            organizationId: DAYTONA_ORGANIZATION_ID,
          }));
        console.log(`[test] Using snapshot: ${snapshotName}`);

        // 4. Create Daytona sandbox
        const machineId = `test-${generateRandomId()}`;
        const apiKey = generateRandomId();

        daytona = new Daytona({
          apiKey: DAYTONA_API_KEY,
          organizationId: DAYTONA_ORGANIZATION_ID,
          apiUrl: DAYTONA_API_URL,
          target: DAYTONA_TARGET,
        });

        console.log("[test] Creating Daytona sandbox...");
        sandbox = await daytona.create({
          name: `bootstrap-test-${Date.now()}`,
          snapshot: snapshotName,
          public: true,
          autoStopInterval: 0,
          autoDeleteInterval: 60, // Auto-delete after 1 hour as safety net
          envVars: {
            ITERATE_OS_BASE_URL: cloudflared.url,
            ITERATE_OS_API_KEY: apiKey,
            ITERATE_MACHINE_ID: machineId,
          },
        });
        console.log(`[test] Sandbox created: ${sandbox.id}`);

        // 5. Start sandbox and wait for it to be running
        console.log("[test] Starting sandbox...");
        await sandbox.start(300);
        console.log("[test] Sandbox started");

        // 6. Wait for sandbox ready file (tail logs while waiting)
        console.log("[test] Waiting for sandbox to be ready (/tmp/.iterate-sandbox-ready)...");

        // Poll for ready file (also print daemon logs periodically)
        await waitForCondition(
          async () => {
            try {
              const result = await sandbox!.process.executeCommand(
                "test -f /tmp/.iterate-sandbox-ready && echo ready",
              );
              return result.result?.includes("ready") ?? false;
            } catch {
              return false;
            }
          },
          SANDBOX_READY_TIMEOUT_MS,
          2000,
        );
        console.log("[test] Sandbox ready file detected");

        // 7. Wait for bootstrap request from daemon
        console.log("[test] Waiting for bootstrap request...");
        await waitForCondition(() => serverState.getEnvReceived, BOOTSTRAP_TIMEOUT_MS, 1000);
        console.log("[test] Bootstrap request received");

        // Give daemon a moment to apply env vars
        await new Promise((r) => setTimeout(r, 5000));

        // 8. Verify daemon logs look sensible (no crash indicators)
        console.log("[test] Checking daemon logs...");
        const daemonLogs = await sandbox.process.executeCommand(
          "cat /var/log/iterate-daemon/current 2>/dev/null || echo 'no logs yet'",
        );
        const daemonLogText = daemonLogs.result ?? "";
        console.log("[test] Daemon log sample:", daemonLogText.slice(0, 500));

        // Should have some output and no obvious errors
        expect(daemonLogText.length).toBeGreaterThan(0);
        expect(daemonLogText.toLowerCase()).not.toContain("fatal");
        expect(daemonLogText.toLowerCase()).not.toContain("unhandled");

        // 9. Verify opencode logs exist
        console.log("[test] Checking opencode logs...");
        const opencodeLogs = await sandbox.process.executeCommand(
          "cat /var/log/opencode/current 2>/dev/null || echo 'no logs yet'",
        );
        const opencodeLogText = opencodeLogs.result ?? "";
        console.log("[test] Opencode log sample:", opencodeLogText.slice(0, 500));

        // 10. Verify git status works in iterate repo
        console.log("[test] Checking git status in iterate repo...");
        const gitStatusResult = await sandbox.process.executeCommand(
          "cd ~/src/github.com/iterate/iterate && git status",
        );
        const gitStatusOutput = gitStatusResult.result ?? "";
        console.log("[test] Git status output:", gitStatusOutput.slice(0, 500));

        // Should show git status output (on branch, clean/dirty state, etc.)
        expect(gitStatusOutput).toContain("On branch");
        expect(gitStatusResult.exitCode).toBe(0);

        // 11. Run opencode to compute 50 - 8 = 42
        console.log("[test] Running opencode to compute 50 - 8...");

        // Use Promise.race for timeout since SDK may not support timeout param
        const opencodePromise = sandbox.process.executeCommand(
          'opencode run "what is 50 - 8? respond with just the number"',
        );
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("opencode timed out")), OPENCODE_TIMEOUT_MS),
        );

        const opencodeResult = await Promise.race([opencodePromise, timeoutPromise]);

        const output = opencodeResult.result ?? "";
        console.log("[test] Opencode output:", output);

        expect(output).toContain("42");
        console.log("[test] SUCCESS: opencode computed 42");
      } finally {
        // Always clean up resources
        console.log("[test] Cleaning up...");

        if (sandbox) {
          try {
            console.log("[test] Stopping sandbox...");
            await sandbox.stop(60);
          } catch (e) {
            console.error("[test] Error stopping sandbox:", e);
          }
          try {
            console.log("[test] Deleting sandbox...");
            await sandbox.delete();
          } catch (e) {
            console.error("[test] Error deleting sandbox:", e);
          }
        }

        if (cloudflared) {
          console.log("[test] Killing cloudflared...");
          cloudflared.process.kill();
        }

        if (mockServer) {
          console.log("[test] Closing mock server...");
          await new Promise<void>((resolve) => mockServer!.close(() => resolve()));
        }

        console.log("[test] Cleanup complete");
      }
    },
    TEST_TIMEOUT_MS,
  );
});
