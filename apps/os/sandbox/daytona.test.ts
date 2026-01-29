/**
 * Daytona Integration Test
 *
 * Tests the full sandbox bootstrap flow:
 * 1. Build snapshot if DAYTONA_SNAPSHOT_NAME not provided
 * 2. Start mock OS worker on random port
 * 3. Start cloudflared quick tunnel → get *.trycloudflare.com URL
 * 4. Create Daytona sandbox from snapshot with injected env vars
 * 5. Wait for bootstrap request, return API keys in response
 * 6. Verify daemon/opencode logs look sensible
 * 7. Run `opencode run "what messaging platform is this agent for"` → assert "slack"
 * 8. Run `claude -p "what messaging platform is this agent for"` → assert "slack"
 * 9. Run `pi -p "what messaging platform is this agent for"` → assert "slack"
 * 10. Verify `git status` works in iterate repo
 * 11. Always delete sandbox in finally block
 *
 * ENVIRONMENT VARIABLES:
 *
 * Required (from Doppler):
 *   DAYTONA_API_KEY          - Daytona API key
 *   OPENAI_API_KEY           - For opencode LLM calls
 *   ANTHROPIC_API_KEY        - For claude and pi LLM calls
 *
 * Optional:
 *   DAYTONA_SNAPSHOT_NAME       - Use existing snapshot (skips build)
 *   SANDBOX_ITERATE_REPO_REF    - Git ref for snapshot build (default: current commit SHA)
 *
 * Test flag:
 *   RUN_DAYTONA_TESTS=true  - Enable test (skipped otherwise)
 *
 * RUN WITH:
 *   pnpm snapshot:daytona:test
 */

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Daytona, type Sandbox } from "@daytonaio/sdk";
import { beforeAll, describe, expect, test } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../../..");

// ============ Config ============

const RUN_DAYTONA_TESTS = process.env.RUN_DAYTONA_TESTS === "true";
const DAYTONA_API_KEY = process.env.DAYTONA_API_KEY;
const DAYTONA_ORGANIZATION_ID = process.env.DAYTONA_ORGANIZATION_ID;
const DAYTONA_API_URL = process.env.DAYTONA_API_URL;
const DAYTONA_TARGET = process.env.DAYTONA_TARGET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Snapshot: use provided name or build one
let snapshotName = process.env.DAYTONA_SNAPSHOT_NAME;

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
  _port: number,
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

describe.runIf(RUN_DAYTONA_TESTS)("Daytona Integration", () => {
  // Build snapshot once before all tests (if not using existing snapshot)
  beforeAll(async () => {
    if (snapshotName) {
      console.log(`Using existing snapshot: ${snapshotName}`);
      return;
    }

    // Get git ref for snapshot - use env var or current commit SHA
    const repoRef =
      process.env.SANDBOX_ITERATE_REPO_REF ??
      execSync("git rev-parse HEAD", { cwd: REPO_ROOT, encoding: "utf-8" }).trim();

    console.log(`Building Daytona snapshot from ref: ${repoRef}`);
    console.log("This may take several minutes...");

    // Run snapshot creation and capture output to get snapshot name
    // Uses current APP_STAGE from doppler (dev-$ITERATE_USER locally, prd in CI)
    const output = execSync(`pnpm snapshot:daytona`, {
      cwd: join(REPO_ROOT, "apps/os"),
      encoding: "utf-8",
      env: {
        ...process.env,
        SANDBOX_ITERATE_REPO_REF: repoRef,
        APP_STAGE: process.env.APP_STAGE || "dev",
      },
      stdio: ["inherit", "pipe", "inherit"],
    });
    console.log(output);

    // Parse snapshot name from output (format: "Creating snapshot: dev-jonas--20260116-230007" or "prd--...")
    const match = output.match(/Creating snapshot: ([\w-]+)/);
    if (!match) {
      throw new Error("Could not parse snapshot name from build output");
    }
    snapshotName = match[1];
    console.log(`Snapshot built: ${snapshotName}`);
  }, 600_000); // 10 min timeout for snapshot build

  // TODO: unskip once x-api-key header issue is fixed (see https://github.com/iterate/iterate/actions/runs/21475375981)
  test.skip(
    "sandbox boots, bootstraps with control plane, and agents answer the secret",
    async () => {
      // Validate required env vars
      if (!DAYTONA_API_KEY) throw new Error("DAYTONA_API_KEY required");
      if (!snapshotName) throw new Error("Snapshot name not set (beforeAll should have built one)");
      if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY required (for opencode)");
      if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY required (for claude and pi)");

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
        // Note: Resources (CPU/memory) can't be overridden when using a snapshot.
        // To use smaller resources, create a snapshot with smaller resources.
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

        // Print preview URLs prominently
        const terminalPreview = await sandbox.getPreviewLink(22222);
        const daemonPreview = await sandbox.getPreviewLink(3000);
        const terminalUrl =
          typeof terminalPreview === "string" ? terminalPreview : terminalPreview.url;
        const daemonUrl = typeof daemonPreview === "string" ? daemonPreview : daemonPreview.url;
        console.log("");
        console.log(
          "╔══════════════════════════════════════════════════════════════════════════════╗",
        );
        console.log(
          "║  SANDBOX PREVIEW URLS                                                        ║",
        );
        console.log(
          "╠══════════════════════════════════════════════════════════════════════════════╣",
        );
        console.log(`║  Terminal (22222): ${terminalUrl}`);
        console.log(`║  Daemon (3000):    ${daemonUrl}`);
        console.log(`║  Sandbox ID:       ${sandbox.id}`);
        console.log(
          "╚══════════════════════════════════════════════════════════════════════════════╝",
        );
        console.log("");

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

        // 7. Comprehensive diagnostics - show everything useful for debugging
        const printSection = (title: string) => {
          console.log("");
          console.log("━".repeat(80));
          console.log(`  ${title}`);
          console.log("━".repeat(80));
        };

        printSection("PROCESS STATUS");
        const allProcs = await sandbox.process.executeCommand("ps aux");
        console.log(allProcs.result);

        printSection("ENTRY.SH STDOUT (sandbox boot log)");
        // entry.sh output goes to the main container log, which we can see via journal or docker logs
        // For Daytona, we check dmesg or the pidnap output
        const entryLogs = await sandbox.process.executeCommand(
          "dmesg 2>/dev/null | tail -50 || echo '(dmesg not available)'",
        );
        console.log(entryLogs.result);

        printSection("DAEMON LOGS (/var/log/pidnap/process/iterate-daemon.log)");
        const daemonLogsEarly = await sandbox.process.executeCommand(
          "cat /var/log/pidnap/process/iterate-daemon.log 2>/dev/null || echo '(no daemon logs yet)'",
        );
        console.log(daemonLogsEarly.result);

        printSection("OPENCODE LOGS (/var/log/pidnap/process/opencode.log)");
        const opencodeLogsEarly = await sandbox.process.executeCommand(
          "cat /var/log/pidnap/process/opencode.log 2>/dev/null || echo '(no opencode logs yet)'",
        );
        console.log(opencodeLogsEarly.result);

        printSection("ENVIRONMENT VARIABLES (ITERATE_*)");
        const envCheck = await sandbox.process.executeCommand(
          "env | grep -E '^ITERATE_' | sort || echo '(no ITERATE_* env vars)'",
        );
        console.log(envCheck.result);

        printSection("GIT STATUS");
        const gitStatus = await sandbox.process.executeCommand(
          "cd ~/src/github.com/iterate/iterate && git log --oneline -3 && echo '' && git status --short",
        );
        console.log(gitStatus.result);

        // 8. Wait for bootstrap request from daemon
        printSection("WAITING FOR BOOTSTRAP");
        console.log("Waiting for daemon to call control plane...");
        await waitForCondition(() => serverState.getEnvReceived, BOOTSTRAP_TIMEOUT_MS, 1000);
        console.log("✓ Bootstrap request received from daemon");

        // Give daemon a moment to apply env vars
        await new Promise((r) => setTimeout(r, 5000));

        // 9. Show full logs after bootstrap
        printSection("DAEMON LOGS (FULL - after bootstrap)");
        const daemonLogs = await sandbox.process.executeCommand(
          "cat /var/log/pidnap/process/iterate-daemon.log 2>/dev/null || echo '(no logs)'",
        );
        const daemonLogText = daemonLogs.result ?? "";
        console.log(daemonLogText);

        // Verify bootstrap succeeded
        expect(daemonLogText.length).toBeGreaterThan(0);
        expect(daemonLogText.toLowerCase()).toContain("server running");
        expect(daemonLogText.toLowerCase()).toContain("applied");
        expect(daemonLogText.toLowerCase()).toContain("env vars");

        printSection("OPENCODE LOGS (FULL - after bootstrap)");
        const opencodeLogs = await sandbox.process.executeCommand(
          "cat /var/log/pidnap/process/opencode.log 2>/dev/null || echo '(no logs)'",
        );
        console.log(opencodeLogs.result);

        // 10. Run opencode smoketest
        printSection("OPENCODE SMOKETEST: 'what messaging platform is this agent for?'");
        console.log('Running: opencode run "what messaging platform is this agent for"');
        console.log("");

        const opencodePromise = sandbox.process.executeCommand(
          'bash -c "source ~/.iterate/.env && opencode run \\"what messaging platform is this agent for\\""',
        );
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("opencode timed out")), OPENCODE_TIMEOUT_MS),
        );

        const opencodeResult = await Promise.race([opencodePromise, timeoutPromise]);
        const opencodeOutput = opencodeResult.result ?? "";

        console.log(
          "┌─────────────────────────────────────────────────────────────────────────────┐",
        );
        console.log(
          "│ OPENCODE RESPONSE:                                                          │",
        );
        console.log(
          "├─────────────────────────────────────────────────────────────────────────────┤",
        );
        // Print each line of the response
        for (const line of opencodeOutput.split("\n")) {
          console.log(`│ ${line}`);
        }
        console.log(
          "└─────────────────────────────────────────────────────────────────────────────┘",
        );

        expect(opencodeOutput.toLowerCase()).toContain("slack");
        console.log("");
        console.log("✓ SUCCESS: opencode correctly identified the messaging platform");

        // 11. Run claude smoketest
        printSection("CLAUDE SMOKETEST: 'what messaging platform is this agent for?'");
        console.log('Running: claude -p "what messaging platform is this agent for"');
        console.log("");

        const claudePromise = sandbox.process.executeCommand(
          'bash -c "source ~/.iterate/.env && claude -p \\"what messaging platform is this agent for\\""',
        );
        const claudeTimeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("claude timed out")), OPENCODE_TIMEOUT_MS),
        );

        const claudeResult = await Promise.race([claudePromise, claudeTimeoutPromise]);
        const claudeOutput = claudeResult.result ?? "";

        console.log(
          "┌─────────────────────────────────────────────────────────────────────────────┐",
        );
        console.log(
          "│ CLAUDE RESPONSE:                                                            │",
        );
        console.log(
          "├─────────────────────────────────────────────────────────────────────────────┤",
        );
        for (const line of claudeOutput.split("\n")) {
          console.log(`│ ${line}`);
        }
        console.log(
          "└─────────────────────────────────────────────────────────────────────────────┘",
        );

        expect(claudeOutput.toLowerCase()).toContain("slack");
        console.log("");
        console.log("✓ SUCCESS: claude correctly identified the messaging platform");

        // 12. Run pi smoketest
        printSection("PI SMOKETEST: 'what messaging platform is this agent for?'");
        console.log('Running: pi -p "what messaging platform is this agent for"');
        console.log("");

        const piPromise = sandbox.process.executeCommand(
          'bash -c "source ~/.iterate/.env && pi -p \\"what messaging platform is this agent for\\""',
        );
        const piTimeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("pi timed out")), OPENCODE_TIMEOUT_MS),
        );

        const piResult = await Promise.race([piPromise, piTimeoutPromise]);
        const piOutput = piResult.result ?? "";

        console.log(
          "┌─────────────────────────────────────────────────────────────────────────────┐",
        );
        console.log(
          "│ PI RESPONSE:                                                                │",
        );
        console.log(
          "├─────────────────────────────────────────────────────────────────────────────┤",
        );
        for (const line of piOutput.split("\n")) {
          console.log(`│ ${line}`);
        }
        console.log(
          "└─────────────────────────────────────────────────────────────────────────────┘",
        );

        expect(piOutput.toLowerCase()).toContain("slack");
        console.log("");
        console.log("✓ SUCCESS: pi correctly identified the messaging platform");

        // 13. Verify git status works in iterate repo
        printSection("GIT STATUS CHECK");
        const gitStatusResult = await sandbox.process.executeCommand(
          "git -C ~/src/github.com/iterate/iterate status",
        );
        const gitStatusOutput = gitStatusResult.result ?? "";
        console.log(gitStatusOutput);

        // In CI, the repo is checked out at a specific SHA (detached HEAD), not a branch
        // So we check for either "On branch" or "HEAD detached at" to verify git status works
        expect(
          gitStatusOutput.includes("On branch") || gitStatusOutput.includes("HEAD detached at"),
        ).toBe(true);
        console.log("");
        console.log("✓ SUCCESS: git status works correctly");
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
