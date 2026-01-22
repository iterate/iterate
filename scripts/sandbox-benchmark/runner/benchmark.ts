/**
 * Main benchmark orchestration
 *
 * Flow:
 * 1. Load & validate config
 * 2. Start cloudflared tunnel + callback server
 * 3. Create all sandboxes in parallel
 * 4. Wait for cold boot callbacks → record measurements
 * 5. For each sandbox (if restart enabled): stop, start, measure restart time
 * 6. For each sandbox (if request latency enabled): make N requests
 * 7. Cleanup (unless keepAlive)
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { BenchmarkConfig, ProviderConfig } from "../config.ts";
import { validateConfig } from "../config.ts";
import {
  initDatabase,
  insertRun,
  finishRun,
  insertSandbox,
  insertMeasurement,
  updateSandboxUrls,
  getRunSummary,
} from "../db/index.ts";
import { getProvider, type SandboxHandle } from "../providers/index.ts";
import { DaytonaProvider } from "../providers/daytona.ts";
import { startCloudflaredTunnel, stopCloudflaredTunnel, type CloudflaredTunnel } from "./tunnel.ts";
import { startCallbackServer, type CallbackServer } from "./callback-server.ts";

const BENCHMARK_SERVER_PORT = 8080;
const _COLD_BOOT_TIMEOUT_MS = 30_000; // 30 seconds (reduced for debugging)
const RESTART_TIMEOUT_MS = 30_000; // 30 seconds (reduced for debugging)
const HEALTH_CHECK_TIMEOUT_MS = 30_000; // 30 seconds (reduced for debugging)
const HEALTH_CHECK_INTERVAL_MS = 1000; // 1 second between checks

interface SandboxContext {
  id: string; // Our internal ID
  config: ProviderConfig;
  sandboxIndex: number;
  handle: SandboxHandle;
  tunnelUrl: string | null;
  terminalUrl: string | null;
  createStartedAt: number; // Timestamp when create was initiated
  becameHealthyAt: number | null; // Timestamp when health check passed
}

export async function runBenchmark(config: BenchmarkConfig): Promise<string> {
  // Validate config
  const totalSandboxes = validateConfig(config);
  console.log(`[benchmark] Starting benchmark with ${totalSandboxes} sandboxes`);

  // Initialize database
  const db = initDatabase(config.output);
  const runId = randomUUID();

  // Insert run record with full config JSON for reproducibility
  insertRun(db, {
    id: runId,
    startedAt: new Date().toISOString(),
    machinesPerConfig: config.machinesPerConfig,
    requestsPerMachine: config.requestsPerMachine,
    batchSize: config.batchSize,
    restartCycles: config.restartCyclesPerMachine,
    notes: null,
    configJson: JSON.stringify(config, null, 2),
  });

  let tunnel: CloudflaredTunnel | null = null;
  let callbackServer: CallbackServer | null = null;
  const sandboxes: SandboxContext[] = [];

  try {
    // Start callback server
    callbackServer = await startCallbackServer();

    // Start cloudflared tunnel
    console.log("[benchmark] Starting cloudflared tunnel...");
    tunnel = await startCloudflaredTunnel(callbackServer.port);
    console.log(`[benchmark] Tunnel URL: ${tunnel.url}`);

    // Create all sandboxes in parallel
    console.log("[benchmark] Creating sandboxes...");
    const createPromises: Promise<SandboxContext>[] = [];

    for (const providerConfig of config.configs) {
      for (let i = 0; i < config.machinesPerConfig; i++) {
        createPromises.push(createSandboxWithTracking(db, runId, providerConfig, i, tunnel.url));
      }
    }

    const createdSandboxes = await Promise.all(createPromises);
    sandboxes.push(...createdSandboxes);

    console.log(`[benchmark] Created ${sandboxes.length} sandboxes`);

    // Wait for cold boot callbacks
    if (config.measurements.coldBoot) {
      console.log("[benchmark] Measuring cold boot times...");
      await measureColdBoots(db, callbackServer, sandboxes);
    }

    // Update sandbox URLs in database
    for (const sandbox of sandboxes) {
      if (sandbox.tunnelUrl || sandbox.terminalUrl) {
        updateSandboxUrls(db, sandbox.id, sandbox.tunnelUrl ?? "", sandbox.terminalUrl ?? "");
      }
    }

    // Restart measurements
    if (config.measurements.restart && config.restartCyclesPerMachine > 0) {
      console.log("[benchmark] Measuring restart times...");
      await measureRestarts(db, callbackServer, sandboxes, config.restartCyclesPerMachine);
    }

    // Request latency measurements
    if (config.measurements.requestLatency && config.requestsPerMachine > 0) {
      console.log("[benchmark] Measuring request latency...");
      await measureRequestLatency(db, sandboxes, config.requestsPerMachine, config.batchSize);
    }

    // Finish run
    finishRun(db, runId);

    // Print summary
    const summary = getRunSummary(db, runId);
    console.log("\n[benchmark] Run complete!");
    console.log(`  Run ID: ${runId}`);
    console.log(`  Total sandboxes: ${summary.totalSandboxes}`);
    console.log(`  Total measurements: ${summary.totalMeasurements}`);
    console.log(`  Cold boot measurements: ${summary.measurementsByType.cold_boot}`);
    console.log(`  Restart measurements: ${summary.measurementsByType.restart}`);
    console.log(`  Request latency measurements: ${summary.measurementsByType.request_latency}`);

    // Print connection info if keepAlive
    if (config.keepAlive) {
      console.log("\n[benchmark] Sandboxes kept alive. Connection info:");
      for (const sandbox of sandboxes) {
        console.log(`\n  ${sandbox.config.name} #${sandbox.sandboxIndex}:`);
        console.log(`    Provider ID: ${sandbox.handle.id}`);
        if (sandbox.tunnelUrl) console.log(`    Server URL: ${sandbox.tunnelUrl}`);
        if (sandbox.terminalUrl) console.log(`    Terminal: ${sandbox.terminalUrl}`);
      }
    }

    return runId;
  } finally {
    // Cleanup
    if (!config.keepAlive) {
      console.log("[benchmark] Cleaning up sandboxes...");
      await cleanupSandboxes(sandboxes);
    }

    if (tunnel) {
      stopCloudflaredTunnel(tunnel);
    }

    if (callbackServer) {
      await callbackServer.close();
    }

    db.close();
  }
}

/**
 * Wait for sandbox server to be healthy by polling /health endpoint
 */
async function waitForHealthy(
  url: string,
  sandboxName: string,
  timeoutMs: number = HEALTH_CHECK_TIMEOUT_MS,
): Promise<boolean> {
  const startTime = Date.now();
  const healthUrl = `${url}/health`;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        console.log(`[benchmark] Sandbox ${sandboxName} is healthy`);
        return true;
      }
    } catch {
      // Ignore errors, keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_CHECK_INTERVAL_MS));
  }

  console.warn(`[benchmark] Sandbox ${sandboxName} did not become healthy within ${timeoutMs}ms`);
  return false;
}

async function createSandboxWithTracking(
  db: Database.Database,
  runId: string,
  config: ProviderConfig,
  sandboxIndex: number,
  tunnelUrl: string,
): Promise<SandboxContext> {
  const provider = getProvider(config.provider);
  const sandboxId = randomUUID();
  const sandboxName = `benchmark-${config.name}-${sandboxIndex}-${Date.now()}`;

  // Determine resources from config
  let cpu: number | undefined;
  let memoryMb: number | undefined;
  let region: string | undefined;

  if (config.provider === "daytona") {
    cpu = config.cpu;
    memoryMb = config.memoryMb;
    region = config.region;
  } else if (config.provider === "fly") {
    cpu = config.cpus;
    memoryMb = config.memoryMb;
    region = config.region;
  }

  // Track when we start creating the sandbox (for cold boot measurement)
  const createStartedAtMs = Date.now();
  const createStartedAt = new Date(createStartedAtMs).toISOString();

  // Create sandbox
  const handle = await provider.createSandbox({
    image: config.image,
    name: sandboxName,
    envVars: {
      BENCHMARK_CALLBACK_URL: `${tunnelUrl}/callback/${sandboxId}`,
      BENCHMARK_SANDBOX_ID: sandboxId,
    },
    resources: cpu || memoryMb ? { cpu, memoryMb } : undefined,
    region,
  });

  // Insert sandbox record
  insertSandbox(db, {
    id: sandboxId,
    runId,
    configName: config.name,
    provider: config.provider,
    providerSandboxId: handle.id,
    cpu: cpu ?? null,
    memoryMb: memoryMb ?? null,
    region: region ?? null,
    dockerfile: config.image.dockerfile,
    sandboxIndex,
    tunnelUrl: null,
    terminalUrl: null,
    createdAt: createStartedAt,
  });

  // Record when sandbox creation completed (provider says it's ready)
  const createCompletedAtMs = Date.now();

  // Get URLs
  let tunnelUrlForSandbox: string | null = null;
  let terminalUrl: string | null = null;
  try {
    tunnelUrlForSandbox = await provider.getPublicUrl(handle, BENCHMARK_SERVER_PORT);
    terminalUrl = await provider.getPublicUrl(handle, 8080); // Terminal on same port as server
  } catch (error) {
    console.warn(`[benchmark] Could not get URLs for sandbox ${sandboxId}:`, error);
  }

  // Wait for sandbox to be healthy before proceeding
  // If health check fails, fall back to using createCompletedAt as the "ready" time
  let becameHealthyAt: number | null = null;
  if (tunnelUrlForSandbox) {
    const healthy = await waitForHealthy(tunnelUrlForSandbox, sandboxName);
    if (healthy) {
      becameHealthyAt = Date.now();
    } else {
      // Fall back to provider-level "ready" time
      console.log(
        `[benchmark] Using provider-level ready time for ${sandboxName} (no health endpoint)`,
      );
      becameHealthyAt = createCompletedAtMs;
    }
  } else {
    // No URL available, use provider-level ready time
    console.log(`[benchmark] Using provider-level ready time for ${sandboxName} (no URL)`);
    becameHealthyAt = createCompletedAtMs;
  }

  return {
    id: sandboxId,
    config,
    sandboxIndex,
    handle,
    tunnelUrl: tunnelUrlForSandbox,
    terminalUrl,
    createStartedAt: createStartedAtMs,
    becameHealthyAt,
  };
}

async function measureColdBoots(
  db: Database.Database,
  _callbackServer: CallbackServer,
  sandboxes: SandboxContext[],
): Promise<void> {
  // Cold boot time = time from createSandbox call to health check passing
  // We already captured these timestamps during sandbox creation
  for (const sandbox of sandboxes) {
    const startedAt = new Date(sandbox.createStartedAt).toISOString();

    if (sandbox.becameHealthyAt) {
      const durationMs = sandbox.becameHealthyAt - sandbox.createStartedAt;

      insertMeasurement(db, {
        sandboxId: sandbox.id,
        measurementType: "cold_boot",
        sequenceIndex: 0,
        startedAt,
        completedAt: new Date(sandbox.becameHealthyAt).toISOString(),
        durationMs,
        statusCode: null,
        error: null,
        sandboxProcessStartMs: sandbox.createStartedAt,
        sandboxReadyMs: sandbox.becameHealthyAt,
        metadata: null,
      });

      console.log(
        `[benchmark] Cold boot ${sandbox.config.name}#${sandbox.sandboxIndex}: ${durationMs}ms`,
      );
    } else {
      insertMeasurement(db, {
        sandboxId: sandbox.id,
        measurementType: "cold_boot",
        sequenceIndex: 0,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: null,
        statusCode: null,
        error: "Sandbox never became healthy",
        sandboxProcessStartMs: null,
        sandboxReadyMs: null,
        metadata: null,
      });

      console.error(
        `[benchmark] Cold boot failed for ${sandbox.config.name}#${sandbox.sandboxIndex}: never became healthy`,
      );
    }
  }
}

async function measureRestarts(
  db: Database.Database,
  _callbackServer: CallbackServer,
  sandboxes: SandboxContext[],
  cycles: number,
): Promise<void> {
  // Note: Using polling instead of callbacks since Daytona sandboxes can't make outbound requests
  for (let cycle = 0; cycle < cycles; cycle++) {
    console.log(`[benchmark] Restart cycle ${cycle + 1}/${cycles}`);

    for (const sandbox of sandboxes) {
      const provider = getProvider(sandbox.config.provider);
      const startedAt = new Date().toISOString();

      try {
        if (!sandbox.tunnelUrl) {
          throw new Error("No tunnel URL available for sandbox");
        }

        // Stop sandbox
        await provider.stopSandbox(sandbox.handle);

        // Wait for stopped (Daytona-specific)
        if (provider instanceof DaytonaProvider) {
          await provider.waitForState(sandbox.handle, "stopped", 60_000);
        }

        // Start sandbox and measure
        const startMs = Date.now();
        await provider.startSandbox(sandbox.handle);

        // Wait for sandbox to be healthy by polling /health
        await waitForHealthy(
          sandbox.tunnelUrl,
          `${sandbox.config.name}#${sandbox.sandboxIndex}`,
          RESTART_TIMEOUT_MS,
        );

        // Fetch debug info to get timing
        const debugUrl = `${sandbox.tunnelUrl}/debug`;
        const debugResponse = await fetch(debugUrl);

        if (!debugResponse.ok) {
          throw new Error(`Debug endpoint returned ${debugResponse.status}`);
        }

        const debugInfo = (await debugResponse.json()) as {
          uptime: number;
        };

        const serverStartMs = Date.now() - debugInfo.uptime;
        const durationMs = serverStartMs - startMs;

        insertMeasurement(db, {
          sandboxId: sandbox.id,
          measurementType: "restart",
          sequenceIndex: cycle,
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Math.max(0, durationMs),
          statusCode: null,
          error: null,
          sandboxProcessStartMs: serverStartMs,
          sandboxReadyMs: serverStartMs,
          metadata: JSON.stringify({ polled: true, uptime: debugInfo.uptime }),
        });

        console.log(
          `[benchmark] Restart ${sandbox.config.name}#${sandbox.sandboxIndex}: ${Math.max(0, durationMs)}ms (polled)`,
        );
      } catch (error) {
        insertMeasurement(db, {
          sandboxId: sandbox.id,
          measurementType: "restart",
          sequenceIndex: cycle,
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: null,
          statusCode: null,
          error: String(error),
          sandboxProcessStartMs: null,
          sandboxReadyMs: null,
          metadata: null,
        });

        console.error(
          `[benchmark] Restart failed for ${sandbox.config.name}#${sandbox.sandboxIndex}:`,
          error,
        );
      }
    }
  }
}

async function measureRequestLatency(
  db: Database.Database,
  sandboxes: SandboxContext[],
  requestsPerMachine: number,
  batchSize: number,
): Promise<void> {
  for (const sandbox of sandboxes) {
    if (!sandbox.tunnelUrl) {
      console.warn(
        `[benchmark] No tunnel URL for ${sandbox.config.name}#${sandbox.sandboxIndex}, skipping latency`,
      );
      continue;
    }

    const pingUrl = `${sandbox.tunnelUrl}/ping`;
    console.log(
      `[benchmark] Measuring latency for ${sandbox.config.name}#${sandbox.sandboxIndex} (${requestsPerMachine} requests)...`,
    );

    for (let i = 0; i < requestsPerMachine; i += batchSize) {
      const batch = Math.min(batchSize, requestsPerMachine - i);
      const promises: Promise<void>[] = [];

      for (let j = 0; j < batch; j++) {
        const requestIndex = i + j;
        promises.push(measureSingleRequest(db, sandbox.id, pingUrl, requestIndex));
      }

      await Promise.all(promises);
    }

    console.log(
      `[benchmark] Completed ${requestsPerMachine} requests for ${sandbox.config.name}#${sandbox.sandboxIndex}`,
    );
  }
}

async function measureSingleRequest(
  db: Database.Database,
  sandboxId: string,
  url: string,
  requestIndex: number,
): Promise<void> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  try {
    const response = await fetch(url);
    const durationMs = Date.now() - startMs;

    insertMeasurement(db, {
      sandboxId,
      measurementType: "request_latency",
      sequenceIndex: requestIndex,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs,
      statusCode: response.status,
      error: response.ok ? null : `HTTP ${response.status}`,
      sandboxProcessStartMs: null,
      sandboxReadyMs: null,
      metadata: null,
    });
  } catch (error) {
    const durationMs = Date.now() - startMs;

    insertMeasurement(db, {
      sandboxId,
      measurementType: "request_latency",
      sequenceIndex: requestIndex,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs,
      statusCode: null,
      error: String(error),
      sandboxProcessStartMs: null,
      sandboxReadyMs: null,
      metadata: null,
    });
  }
}

async function cleanupSandboxes(sandboxes: SandboxContext[]): Promise<void> {
  const promises = sandboxes.map(async (sandbox) => {
    try {
      const provider = getProvider(sandbox.config.provider);
      await provider.deleteSandbox(sandbox.handle);
    } catch (error) {
      console.warn(`[benchmark] Error deleting sandbox ${sandbox.id}:`, error);
    }
  });

  await Promise.all(promises);
}

/**
 * Cleanup orphaned benchmark sandboxes for a provider
 */
export async function cleanupProvider(providerName: "daytona" | "e2b" | "fly"): Promise<number> {
  const provider = getProvider(providerName);
  const sandboxes = await provider.listSandboxes();

  console.log(`[cleanup] Found ${sandboxes.length} benchmark sandboxes for ${providerName}`);

  let deleted = 0;
  for (const sandbox of sandboxes) {
    try {
      await provider.deleteSandbox(sandbox);
      deleted++;
      console.log(`[cleanup] Deleted ${sandbox.id}`);
    } catch (error) {
      console.warn(`[cleanup] Error deleting ${sandbox.id}:`, error);
    }
  }

  return deleted;
}
