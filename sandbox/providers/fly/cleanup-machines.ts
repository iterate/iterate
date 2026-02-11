import { parseArgs } from "node:util";
import { z } from "zod/v4";

const FLY_API_BASE = "https://api.machines.dev";
const DEFAULT_TIMEFRAME = "24h";
const DEFAULT_ACTION = "stop";
const ALLOWED_APP_NAMES = new Set(["iterate-dev", "iterate-stg"]);

const FlyEnv = z.object({
  FLY_API_TOKEN: z.string().optional(),
  FLY_APP_NAME_PREFIX: z.string().optional(),
});

type FlyEnv = z.infer<typeof FlyEnv>;
type CleanupAction = "stop" | "delete";

type FlyMachine = {
  id?: string;
  name?: string;
  state?: string;
  updated_at?: string;
  config?: {
    metadata?: Record<string, unknown>;
  };
};

function resolveFlyToken(env: FlyEnv): string {
  return env.FLY_API_TOKEN ?? "";
}

function parseDuration(input: string): number {
  const trimmed = input.trim().toLowerCase();
  const match = /^(\d+)([smhd])$/.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid timeframe '${input}'. Use formats like 30m, 24h, 7d.`);
  }

  const value = Number.parseInt(match[1], 10);
  const unit = match[2];
  const unitMs =
    unit === "s"
      ? 1000
      : unit === "m"
        ? 60 * 1000
        : unit === "h"
          ? 60 * 60 * 1000
          : 24 * 60 * 60 * 1000;
  return value * unitMs;
}

async function flyApi<T>(params: {
  token: string;
  method: string;
  path: string;
  body?: unknown;
}): Promise<T> {
  const { token, method, path, body } = params;
  const response = await fetch(`${FLY_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path} failed (${response.status}): ${text}`);
  }

  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

function isIterateSandboxMachine(machine: FlyMachine): boolean {
  const metadata = machine.config?.metadata;
  if (!metadata || typeof metadata !== "object") return false;
  return metadata["com.iterate.sandbox"] === "true";
}

function shouldSkipForStop(state: string | undefined): boolean {
  if (!state) return false;
  return state === "stopped" || state === "suspended" || state === "destroyed";
}

function resolveAppName(positional: string[], env: FlyEnv): string {
  const argAppName = positional[2];
  const appName = argAppName ?? env.FLY_APP_NAME_PREFIX;
  if (!appName) {
    throw new Error("Missing app name. Pass it explicitly or set FLY_APP_NAME_PREFIX.");
  }
  if (!ALLOWED_APP_NAMES.has(appName)) {
    throw new Error(
      `App '${appName}' is not allowed. This script is intentionally limited to iterate-dev/iterate-stg.`,
    );
  }
  return appName;
}

async function main(): Promise<void> {
  const env = FlyEnv.parse(process.env);
  const token = resolveFlyToken(env);
  if (!token) {
    throw new Error("Missing FLY_API_TOKEN.");
  }

  const { positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
  });

  const timeframeArg = positionals[0] ?? DEFAULT_TIMEFRAME;
  const action = (positionals[1] ?? DEFAULT_ACTION) as CleanupAction;
  const appName = resolveAppName(positionals, env);

  if (action !== "stop" && action !== "delete") {
    throw new Error(`Invalid action '${action}'. Use 'stop' or 'delete'.`);
  }

  const timeframeMs = parseDuration(timeframeArg);
  const cutoff = Date.now() - timeframeMs;

  const machines = await flyApi<FlyMachine[]>({
    token,
    method: "GET",
    path: `/v1/apps/${encodeURIComponent(appName)}/machines`,
  });

  const candidates = machines.filter((machine) => {
    if (!isIterateSandboxMachine(machine)) return false;
    if (!machine.updated_at) return false;
    const updatedAt = Date.parse(machine.updated_at);
    if (!Number.isFinite(updatedAt)) return false;
    return updatedAt < cutoff;
  });

  let stoppedCount = 0;
  let deletedCount = 0;
  let skippedCount = 0;

  console.log(
    `fly cleanup: app=${appName} action=${action} timeframe=${timeframeArg} cutoff=${new Date(cutoff).toISOString()}`,
  );
  console.log(`found ${machines.length} machines, ${candidates.length} stale candidates`);

  for (const machine of candidates) {
    if (!machine.id) {
      skippedCount += 1;
      continue;
    }

    if (action === "stop") {
      if (shouldSkipForStop(machine.state)) {
        skippedCount += 1;
        continue;
      }
      await flyApi({
        token,
        method: "POST",
        path: `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machine.id)}/stop`,
        body: {},
      });
      stoppedCount += 1;
      continue;
    }

    await flyApi({
      token,
      method: "DELETE",
      path: `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machine.id)}?force=true`,
    });
    deletedCount += 1;
  }

  console.log(
    `done: stopped=${stoppedCount} deleted=${deletedCount} skipped=${skippedCount} candidates=${candidates.length}`,
  );
}

await main();
