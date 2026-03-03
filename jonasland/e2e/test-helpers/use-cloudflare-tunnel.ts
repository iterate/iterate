import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

const TRYCLOUDFLARE_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;

export interface UseCloudflareTunnelOptions {
  localPort: number;
  localHost?: string;
  cloudflaredBin?: string;
  timeoutMs?: number;
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
}): Promise<string> {
  let settled = false;

  const fail = (reject: (error: Error) => void, message: string) => {
    if (settled) return;
    settled = true;
    reject(new Error(`${message}\ncloudflared logs:\n${params.logs.join("")}`));
  };

  return await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      fail(
        reject,
        `timed out waiting for cloudflared tunnel URL after ${String(params.timeoutMs)}ms`,
      );
    }, params.timeoutMs);

    const onChunk = (chunk: Buffer | string) => {
      const text = String(chunk);
      params.logs.push(text);
      TRYCLOUDFLARE_URL_REGEX.lastIndex = 0;
      const match = TRYCLOUDFLARE_URL_REGEX.exec(text);
      if (!match || !match[0]) return;
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(match[0]);
    };

    params.child.stdout.on("data", onChunk);
    params.child.stderr.on("data", onChunk);
    params.child.once("error", (error) => {
      fail(reject, `cloudflared failed to start: ${error.message}`);
    });
    params.child.once("exit", (code, signal) => {
      fail(
        reject,
        `cloudflared exited before tunnel URL was discovered (code=${String(code)}, signal=${String(signal)})`,
      );
    });
  });
}

export async function useCloudflareTunnel(
  options: UseCloudflareTunnelOptions,
): Promise<CloudflareTunnelHandle> {
  const cloudflaredBin = options.cloudflaredBin?.trim() || "cloudflared";
  const exists = await commandExists(cloudflaredBin);
  if (!exists) {
    throw new Error(
      `cloudflared binary not found: ${cloudflaredBin} (install cloudflared or set cloudflaredBin)`,
    );
  }

  const timeoutMs = options.timeoutMs ?? 45_000;
  const localHost = options.localHost ?? "127.0.0.1";
  const targetUrl = `http://${localHost}:${String(options.localPort)}`;
  const logs: string[] = [];

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
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([waitForExit, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForExit;
    }
  };

  try {
    const tunnelUrl = await waitForTryCloudflareUrl({
      child,
      timeoutMs,
      logs,
    });

    return {
      tunnelUrl,
      logs: () => logs.join(""),
      stop,
      async [Symbol.asyncDispose]() {
        await stop();
      },
    };
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
}
