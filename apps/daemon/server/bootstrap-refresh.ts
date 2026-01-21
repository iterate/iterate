import { createWorkerClient } from "./orpc/client.ts";
import {
  applyEnvVars,
  configureGitHubCredential,
  clearGitHubCredentials,
  cloneRepos,
} from "./trpc/platform.ts";

const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const JITTER_MS = 5 * 60 * 1000; // +/- 5 minutes

let schedulerRunning = false;

/**
 * Start the bootstrap refresh scheduler.
 * Periodically fetches bootstrap data (env vars, repos) from the control plane.
 */
export function startBootstrapRefreshScheduler(): void {
  // Don't start if not connected to the control plane
  if (!process.env.ITERATE_OS_BASE_URL || !process.env.ITERATE_OS_API_KEY) {
    console.log("[bootstrap-refresh] Not connected to control plane, skipping scheduler");
    return;
  }

  if (schedulerRunning) {
    console.log("[bootstrap-refresh] Scheduler already running");
    return;
  }

  schedulerRunning = true;
  console.log("[bootstrap-refresh] Starting bootstrap refresh scheduler");

  const scheduleNext = () => {
    // Add jitter to avoid all daemons hitting the control plane at the same time
    const jitter = Math.random() * JITTER_MS * 2 - JITTER_MS;
    const delay = REFRESH_INTERVAL_MS + jitter;

    console.log(`[bootstrap-refresh] Next refresh in ${Math.round(delay / 1000 / 60)} minutes`);

    setTimeout(async () => {
      try {
        const { bootstrapSandbox } = await import("./trpc/bootstrap.ts");
        await bootstrapSandbox({ mode: "refresh" });
      } catch (err) {
        // Don't crash on periodic refresh failures - just log and continue
        console.error("[bootstrap-refresh] Failed to fetch bootstrap data:", err);
      }
      scheduleNext();
    }, delay);
  };

  // Schedule first refresh (immediate fetch happens in startup, so just schedule next)
  scheduleNext();
}

/**
 * Fetch bootstrap data from the control plane and apply it.
 * Throws on error - callers should handle errors appropriately.
 *
 * This is called:
 * 1. Immediately after daemon reports ready (throws to crash on failure)
 * 2. Periodically by the scheduler (catches errors to continue)
 * 3. When poked by the control plane via refreshEnv (catches errors)
 */
export type BootstrapEnvResult = {
  injectedCount: number;
  removedCount: number;
  changedCount: number;
  envChanged: boolean;
  envFilePath: string;
  reposCount: number;
};

export async function fetchBootstrapData(): Promise<BootstrapEnvResult | null> {
  // Skip if not connected to the control plane
  if (!process.env.ITERATE_OS_BASE_URL || !process.env.ITERATE_OS_API_KEY) {
    console.log("[bootstrap-refresh] Not connected to control plane, skipping fetch");
    return null;
  }
  const machineId = process.env.ITERATE_MACHINE_ID;
  if (!machineId) {
    console.error("[bootstrap-refresh] ITERATE_MACHINE_ID not set, cannot fetch env");
    return null;
  }

  console.log("[bootstrap-refresh] Fetching env data...");
  const client = createWorkerClient();
  const result = await client.machines.getEnv({ machineId });

  // Apply environment variables (always call to replace/clear stale vars)
  const { injectedCount, removedCount, changedCount, envFilePath } = await applyEnvVars(
    result.envVars,
  );
  const envChanged = changedCount > 0 || removedCount > 0;
  console.log(
    `[bootstrap-refresh] Applied ${injectedCount} env vars, removed ${removedCount} stale`,
  );

  // Configure or clear git credentials based on GitHub token presence
  if (result.envVars.ITERATE_GITHUB_ACCESS_TOKEN) {
    await configureGitHubCredential(result.envVars.ITERATE_GITHUB_ACCESS_TOKEN);
  } else {
    // Clear stale GitHub credentials when GitHub is disconnected
    await clearGitHubCredentials();
  }

  // Clone repos if any
  if (result.repos.length > 0) {
    cloneRepos(result.repos);
    console.log(`[bootstrap-refresh] Triggered clone for ${result.repos.length} repos`);
  }

  return {
    injectedCount,
    removedCount,
    changedCount,
    envChanged,
    envFilePath,
    reposCount: result.repos.length,
  };
}
