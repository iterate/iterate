import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { x } from "tinyexec";
import { fetchBootstrapData, startBootstrapRefreshScheduler } from "../bootstrap-refresh.ts";
import { reportStatusToPlatform } from "../report-status.ts";
import { createTRPCRouter, publicProcedure } from "./init.ts";

const ITERATE_REPO = process.env.ITERATE_REPO || "/home/iterate/src/github.com/iterate/iterate";
const LOCAL_REPO_MOUNT = "/local-iterate-repo";
const LOCAL_DOCKER_SYNC_SCRIPT = "/home/iterate/.local/bin/local-docker-sync.sh";
// Prevent restart loops: auto bootstrap restarts PM2 which restarts the daemon.
// We drop a short-lived marker so the next auto run can skip restarting.
const RESTART_GUARD_MARKER = "/tmp/.iterate-bootstrap-restart";
const RESTART_GUARD_MS = 2 * 60 * 1000;
const ECOSYSTEM_PATH = join(ITERATE_REPO, "apps/os/sandbox/ecosystem.config.cjs");

type BootstrapMode = "auto" | "manual" | "refresh";

type BootstrapResult = {
  localSync: boolean;
  localSyncResult?: {
    ran: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
  };
  envChanged: boolean;
  restarted: boolean;
  restartSkipped: boolean;
};

function shouldSkipAutoRestart(): boolean {
  try {
    const stats = statSync(RESTART_GUARD_MARKER);
    return Date.now() - stats.mtimeMs < RESTART_GUARD_MS;
  } catch {
    return false;
  }
}

async function restartEcosystem(): Promise<void> {
  writeFileSync(RESTART_GUARD_MARKER, new Date().toISOString(), { encoding: "utf8" });
  await x("pm2", ["restart", ECOSYSTEM_PATH], { throwOnError: true });
}

function isLocalDockerProvider(): boolean {
  if (process.env.ITERATE_MACHINE_PROVIDER === "local-docker") return true;
  return existsSync(LOCAL_REPO_MOUNT);
}

function truncateOutput(value: string, limit = 20_000): string {
  if (value.length <= limit) return value;
  return value.slice(-limit);
}

async function localDockerSyncRepo(): Promise<BootstrapResult["localSyncResult"]> {
  if (!existsSync(LOCAL_DOCKER_SYNC_SCRIPT)) {
    return {
      ran: false,
      exitCode: 127,
      stdout: "",
      stderr: `Missing sync script at ${LOCAL_DOCKER_SYNC_SCRIPT}`,
    };
  }
  if (!existsSync(LOCAL_REPO_MOUNT)) {
    return { ran: false, exitCode: 0, stdout: "", stderr: "" };
  }

  console.log("[bootstrap] Local-docker mode detected, running sync script...");
  const result = await x("bash", [LOCAL_DOCKER_SYNC_SCRIPT], { throwOnError: false });

  return {
    ran: true,
    exitCode: result.exitCode ?? null,
    stdout: truncateOutput(result.stdout ?? ""),
    stderr: truncateOutput(result.stderr ?? ""),
  };
}

export async function bootstrapSandbox({
  mode = "manual",
}: { mode?: BootstrapMode } = {}): Promise<BootstrapResult> {
  // Local-docker images bake ITERATE_MACHINE_PROVIDER=local-docker; fall back to mount detection.
  const shouldSyncLocal = mode !== "refresh" && isLocalDockerProvider();
  const localSyncResult = shouldSyncLocal ? await localDockerSyncRepo() : undefined;
  const localSync = localSyncResult?.ran ? localSyncResult.exitCode === 0 : false;

  if (mode !== "refresh") {
    await reportStatusToPlatform();
  }

  const envResult = await fetchBootstrapData();
  startBootstrapRefreshScheduler();

  const envChanged = Boolean(envResult?.envChanged);
  const shouldRestart = localSync || envChanged;
  const restartSkipped = mode === "auto" && shouldSkipAutoRestart();

  if (shouldRestart && !restartSkipped) {
    console.log("[bootstrap] Restarting PM2 ecosystem to apply updates...");
    await restartEcosystem();
    return { localSync, localSyncResult, envChanged, restarted: true, restartSkipped: false };
  }

  return { localSync, localSyncResult, envChanged, restarted: false, restartSkipped };
}

export const bootstrapRouter = createTRPCRouter({
  bootstrapSandbox: publicProcedure.mutation(async () => {
    const result = await bootstrapSandbox({ mode: "manual" });
    return { success: true, ...result };
  }),
});

export type BootstrapRouter = typeof bootstrapRouter;
