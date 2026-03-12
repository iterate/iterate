import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

const TRYCLOUDFLARE_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;

export interface UseCloudflareTunnelOptions {
  localPort: number;
  localHost?: string;
  cloudflaredBin?: string;
  timeoutMs?: number;
  onDebug?: (message: string) => void;
  waitForReady?: boolean;
}

export interface CloudflareTunnelHandle extends AsyncDisposable {
  tunnelUrl: string;
  logs(): string;
  stop(): Promise<void>;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

async function commandExists(command: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawn("sh", ["-lc", `command -v ${shellSingleQuote(command)} >/dev/null 2>&1`], {
      stdio: "ignore",
    });
    child.once("exit", (code) => resolve(code === 0));
    child.once("error", () => resolve(false));
  });
}

async function waitForTryCloudflareUrl(params: {
  child: ChildProcessByStdio<null, Readable, Readable>;
  timeoutMs: number;
  logs: string[];
  onDebug?: (message: string) => void;
}): Promise<string> {
  let settled = false;
  const debug = params.onDebug ?? (() => {});
  const startedAt = Date.now();

  const fail = (reject: (error: Error) => void, message: string) => {
    if (settled) return;
    settled = true;
    debug(`[cloudflare-tunnel] fail: ${message}`);
    reject(new Error(`${message}\ncloudflared logs:\n${params.logs.join("")}`));
  };

  return await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      fail(
        reject,
        `timed out waiting for cloudflared tunnel URL after ${String(params.timeoutMs)}ms`,
      );
    }, params.timeoutMs);
    const heartbeat = setInterval(() => {
      if (settled) return;
      const elapsedMs = Date.now() - startedAt;
      debug(`[cloudflare-tunnel] waiting for URL elapsed=${String(elapsedMs)}ms`);
    }, 5_000);

    const onChunk = (source: "stdout" | "stderr", chunk: Buffer | string) => {
      const text = String(chunk);
      params.logs.push(text);
      const trimmed = text.trim();
      if (trimmed.length > 0) {
        debug(`[cloudflare-tunnel:${source}] ${trimmed}`);
      }
      TRYCLOUDFLARE_URL_REGEX.lastIndex = 0;
      const match = TRYCLOUDFLARE_URL_REGEX.exec(text);
      if (!match || !match[0]) return;
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(heartbeat);
      debug(`[cloudflare-tunnel] discovered tunnel URL: ${match[0]}`);
      resolve(match[0]);
    };

    params.child.stdout.on("data", (chunk) => onChunk("stdout", chunk));
    params.child.stderr.on("data", (chunk) => onChunk("stderr", chunk));
    params.child.once("error", (error) => {
      clearInterval(heartbeat);
      fail(reject, `cloudflared failed to start: ${error.message}`);
    });
    params.child.once("exit", (code, signal) => {
      clearInterval(heartbeat);
      fail(
        reject,
        `cloudflared exited before tunnel URL was discovered (code=${String(code)}, signal=${String(signal)})`,
      );
    });
  });
}

async function waitForTunnelReady(params: {
  tunnelUrl: string;
  timeoutMs: number;
  logs: string[];
  onDebug?: (message: string) => void;
}): Promise<void> {
  const deadline = Date.now() + params.timeoutMs;
  let lastFailure = "unknown failure";
  const probeUrl = new URL("/__iterate/health", params.tunnelUrl).toString();
  const debug = params.onDebug ?? (() => {});
  debug(`[cloudflare-tunnel] probing readiness at ${probeUrl}`);

  while (Date.now() < deadline) {
    try {
      const response = await fetch(probeUrl, {
        method: "GET",
        redirect: "manual",
      });
      if (response.ok) {
        debug(`[cloudflare-tunnel] readiness OK (${String(response.status)})`);
        return;
      }
      const body = await response.text().catch(() => "");
      lastFailure = `status=${String(response.status)} body=${body.slice(0, 200)}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `timed out waiting for cloudflared tunnel readiness at ${probeUrl}: ${lastFailure}\ncloudflared logs:\n${params.logs.join("")}`,
  );
}

export async function useCloudflareTunnelToLocalhost(
  options: UseCloudflareTunnelOptions,
): Promise<CloudflareTunnelHandle> {
  const debug = options.onDebug ?? (() => {});
  const cloudflaredBin = options.cloudflaredBin?.trim() || "cloudflared";
  debug(`[cloudflare-tunnel] checking binary ${cloudflaredBin}`);
  const exists = await commandExists(cloudflaredBin);
  if (!exists) {
    throw new Error(
      `cloudflared binary not found: ${cloudflaredBin} (install cloudflared or set cloudflaredBin)`,
    );
  }

  const timeoutMs = options.timeoutMs ?? 45_000;
  const waitForReady = options.waitForReady ?? true;
  const localHost = options.localHost ?? "127.0.0.1";
  const targetUrl = `http://${localHost}:${String(options.localPort)}`;
  const logs: string[] = [];
  debug(`[cloudflare-tunnel] starting: ${cloudflaredBin} tunnel --url ${targetUrl}`);

  const child = spawn(
    cloudflaredBin,
    ["tunnel", "--url", targetUrl, "--no-autoupdate", "--loglevel", "info"],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stopped = false;
  const waitForExit = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    debug("[cloudflare-tunnel] stopping cloudflared");
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([waitForExit, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForExit;
    }
    debug("[cloudflare-tunnel] stopped");
  };

  try {
    const tunnelUrl = await waitForTryCloudflareUrl({
      child,
      timeoutMs,
      logs,
      onDebug: debug,
    });
    if (waitForReady) {
      await waitForTunnelReady({
        tunnelUrl,
        timeoutMs,
        logs,
        onDebug: debug,
      });
    } else {
      debug("[cloudflare-tunnel] skipping readiness probe");
    }

    return {
      tunnelUrl,
      logs: () => logs.join(""),
      stop,
      async [Symbol.asyncDispose]() {
        if (process.env.E2E_NO_DISPOSE) return;
        await stop();
      },
    };
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
}

export const useCloudflareTunnel = useCloudflareTunnelToLocalhost;
