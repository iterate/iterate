import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { CloudflareTunnelData, cloudflareTunnelType } from "@iterate-com/semaphore-contract";
import { useSemaphoreLease } from "./use-semaphore-lease.ts";

const DEFAULT_HEALTHCHECK_PATH = "/api/__internal/health";
const DEFAULT_TUNNEL_TIMEOUT_MS = 60_000;

export interface CloudflareTunnelHandle extends AsyncDisposable {
  publicUrl: string;
}

export interface CloudflareTunnelLeaseHandle extends AsyncDisposable {
  slug: string;
  leaseId: string;
  expiresAt: number;
  publicUrl: string;
  service: string;
  tunnelToken: string;
}

export type UseCloudflareTunnelOptions =
  | {
      token: string;
      publicUrl: string;
      cloudflaredBin?: string;
      timeoutMs?: number;
      healthcheckPath?: string;
    }
  | {
      url: string;
      cloudflaredBin?: string;
      timeoutMs?: number;
      healthcheckPath?: string;
    };

/**
 * Acquire a Cloudflare tunnel lease from Semaphore and expose the typed tunnel
 * data needed to later run `cloudflared tunnel run --token ...`.
 */
export async function useCloudflareTunnelLease(options: {
  semaphoreApiToken?: string;
  semaphoreBaseUrl?: string;
  timeoutMs?: number;
}): Promise<CloudflareTunnelLeaseHandle> {
  const lease = await useSemaphoreLease({
    type: cloudflareTunnelType,
    parseData: (data) => CloudflareTunnelData.parse(data),
    apiToken: options.semaphoreApiToken,
    baseUrl: options.semaphoreBaseUrl,
    waitMs: options.timeoutMs ?? DEFAULT_TUNNEL_TIMEOUT_MS,
  });

  return {
    slug: lease.slug,
    leaseId: lease.leaseId,
    expiresAt: lease.expiresAt,
    publicUrl: `https://${lease.data.publicHostname}`,
    service: lease.data.service,
    tunnelToken: lease.data.tunnelToken,
    async [Symbol.asyncDispose]() {
      await lease[Symbol.asyncDispose]();
    },
  };
}

/**
 * Run `cloudflared tunnel` in one of the two modes we currently care about:
 * - `--url <local target>` for quick tunnels
 * - `run --token <token>` for remotely-managed named tunnels
 */
export async function useCloudflareTunnel(
  options: UseCloudflareTunnelOptions,
): Promise<CloudflareTunnelHandle> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TUNNEL_TIMEOUT_MS;
  const healthcheckPath = options.healthcheckPath ?? DEFAULT_HEALTHCHECK_PATH;
  const logs: Buffer[] = [];
  const cloudflaredBin = options.cloudflaredBin?.trim() || "cloudflared";

  const child = spawn(
    cloudflaredBin,
    "token" in options
      ? [
          "tunnel",
          "--loglevel",
          "warn",
          "--protocol",
          "http2",
          "--no-autoupdate",
          "run",
          "--token",
          options.token,
        ]
      : ["tunnel", "--url", options.url, "--no-autoupdate", "--loglevel", "warn"],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  child.stdout?.on("data", (data: Buffer) => {
    logs.push(Buffer.from(data));
  });
  child.stderr?.on("data", (data: Buffer) => {
    logs.push(Buffer.from(data));
  });

  try {
    const publicUrl =
      "token" in options
        ? options.publicUrl
        : await waitForTryCloudflareUrlFromChild({
            child,
            timeoutMs,
            logs,
          });
    await waitForTunnelReady({
      child,
      publicUrl,
      healthcheckPath,
      timeoutMs,
    });

    return {
      publicUrl,
      async [Symbol.asyncDispose]() {
        await stopCloudflared(child).catch(() => {});
      },
    };
  } catch (error) {
    await stopCloudflared(child).catch(() => {});
    const output = Buffer.concat(logs).toString("utf8");
    throw new Error(
      `Failed to open Cloudflare tunnel: ${error instanceof Error ? error.message : String(error)}${
        output ? `\n--- cloudflared output ---\n${output}` : ""
      }`,
    );
  }
}

async function waitForTunnelReady(args: {
  child: ReturnType<typeof spawn>;
  publicUrl: string;
  healthcheckPath: string;
  timeoutMs: number;
}) {
  const deadline = Date.now() + args.timeoutMs;
  let lastError = "unknown failure";
  const healthcheckUrl = new URL(args.healthcheckPath, args.publicUrl);

  while (Date.now() < deadline) {
    if (args.child.exitCode !== null) {
      throw new Error(`cloudflared exited with code ${String(args.child.exitCode)}`);
    }

    try {
      const response = await fetch(healthcheckUrl, {
        signal: AbortSignal.timeout(5_000),
        redirect: "manual",
      });
      if (response.ok) {
        return;
      }
      lastError = `GET ${healthcheckUrl.toString()} -> ${String(response.status)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await delay(500);
  }

  throw new Error(lastError);
}

async function stopCloudflared(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.killed) {
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(5_000).then(() => {
      child.kill("SIGKILL");
    }),
  ]);
}

function parseSeededServiceUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "http:") {
    throw new Error(
      `Expected seeded tunnel service to use http:, received ${JSON.stringify(value)}`,
    );
  }
  if (!url.port) {
    throw new Error(
      `Expected seeded tunnel service to include an explicit port: ${JSON.stringify(value)}`,
    );
  }

  return {
    hostname: url.hostname,
    port: Number(url.port),
  };
}

export function getCloudflareTunnelServicePort(service: string) {
  return parseSeededServiceUrl(service).port;
}

async function waitForTryCloudflareUrlFromChild(args: {
  child: ReturnType<typeof spawn>;
  timeoutMs: number;
  logs: Buffer[];
}) {
  return await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(`Timed out waiting for trycloudflare URL after ${String(args.timeoutMs)}ms`),
      );
    }, args.timeoutMs);
    const onChunk = (chunk: Buffer) => {
      args.logs.push(Buffer.from(chunk));
      const text = String(chunk);
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (!match?.[0]) {
        return;
      }

      clearTimeout(timeout);
      resolve(match[0]);
    };

    args.child.stdout?.on("data", onChunk);
    args.child.stderr?.on("data", onChunk);
    args.child.once("error", reject);
    args.child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `cloudflared exited before exposing a trycloudflare URL (code=${String(code)}, signal=${String(
            signal,
          )})`,
        ),
      );
    });
  });
}
