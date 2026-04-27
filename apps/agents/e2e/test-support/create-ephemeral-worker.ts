import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));

export interface EphemeralWorkerHandle {
  url: string;
  stage: string;
}

/**
 * Deploys a temporary CF worker via `alchemy.run.ts` with `ALCHEMY_LOCAL=false`.
 * On dispose, runs `alchemy.run.ts --destroy` to tear it down.
 */
export async function createEphemeralWorker(opts: {
  eventsBaseUrl: string;
  eventsProjectSlug: string;
  egressProxy?: string;
  extraEnv?: Record<string, string>;
}): Promise<EphemeralWorkerHandle & AsyncDisposable> {
  const stage = `e2e-${randomBytes(4).toString("hex")}`;

  const env: Record<string, string> = {
    ...stripInheritedAppConfig(process.env),
    ALCHEMY_LOCAL: "false",
    ALCHEMY_STAGE: stage,
    APP_CONFIG_EVENTS_BASE_URL: opts.eventsBaseUrl,
    APP_CONFIG_EVENTS_PROJECT_SLUG: opts.eventsProjectSlug,
    ...opts.extraEnv,
  };
  if (opts.egressProxy) {
    env.APP_CONFIG_EXTERNAL_EGRESS_PROXY = opts.egressProxy;
  }

  if (!env.ALCHEMY_STATE_TOKEN) {
    throw new Error(
      "ALCHEMY_STATE_TOKEN is required for ephemeral worker deploys. " +
        "It should be inherited from _shared in doppler.",
    );
  }

  console.info(`[e2e] Deploying ephemeral worker stage=${stage}...`);

  const { url, output: deployOutput } = await runAlchemy({
    args: [],
    env,
    timeoutMs: 180_000,
  });

  console.info(`[e2e] Ephemeral worker deployed: ${url} (stage=${stage})`);

  // Health-check the deployed worker
  await waitForHealth({ url, timeoutMs: 30_000 });

  return {
    url,
    stage,
    async [Symbol.asyncDispose]() {
      console.info(`[e2e] Destroying ephemeral worker stage=${stage}...`);
      try {
        await runAlchemy({
          args: ["--destroy"],
          env,
          timeoutMs: 60_000,
        });
        console.info(`[e2e] Ephemeral worker destroyed: stage=${stage}`);
      } catch (error) {
        console.error(
          `[e2e] Failed to destroy ephemeral worker stage=${stage}:`,
          error instanceof Error ? error.message : error,
        );
      }
    },
  };
}

async function runAlchemy(opts: {
  args: string[];
  env: Record<string, string>;
  timeoutMs: number;
}): Promise<{ url: string; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "tsx", "./alchemy.run.ts", ...opts.args], {
      cwd: appRoot,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    child.stdout?.on("data", (data: Buffer) => chunks.push(data));
    child.stderr?.on("data", (data: Buffer) => chunks.push(data));

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      const output = Buffer.concat(chunks).toString("utf8");
      reject(
        new Error(
          `alchemy timed out after ${opts.timeoutMs}ms\n--- output ---\n${output.slice(-2000)}`,
        ),
      );
    }, opts.timeoutMs);

    child.once("exit", (code) => {
      clearTimeout(timeout);
      const output = Buffer.concat(chunks).toString("utf8");

      if (code !== 0) {
        reject(
          new Error(`alchemy exited with code ${code}\n--- output ---\n${output.slice(-2000)}`),
        );
        return;
      }

      // alchemy.run.ts prints `{ url: '...' }` via console.dir
      const urlMatch = output.match(/url:\s*'(https?:\/\/[^']+)'/);
      if (!urlMatch) {
        // --destroy doesn't print a URL
        resolve({ url: "", output });
        return;
      }

      resolve({ url: urlMatch[1], output });
    });
  });
}

async function waitForHealth(opts: { url: string; timeoutMs: number }) {
  const deadline = Date.now() + opts.timeoutMs;
  const healthUrl = new URL("/api/__internal/health", opts.url);
  let lastError: string | undefined;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) return;
      lastError = `GET ${healthUrl} -> ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(1_000);
  }

  throw new Error(`Ephemeral worker health check failed: ${lastError}`);
}

function stripInheritedAppConfig(env: NodeJS.ProcessEnv): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === "APP_CONFIG" || key.startsWith("APP_CONFIG_")) continue;
    if (value != null) next[key] = value;
  }
  return next;
}
