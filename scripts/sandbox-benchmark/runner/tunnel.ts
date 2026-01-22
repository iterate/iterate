/**
 * Cloudflared tunnel management for benchmark callbacks
 *
 * Uses cloudflared quick tunnel to expose local callback server to the internet.
 * Pattern taken from apps/os/sandbox/daytona-bootstrap.test.ts
 */

import { spawn, type ChildProcess } from "node:child_process";

export interface CloudflaredTunnel {
  process: ChildProcess;
  url: string;
}

/**
 * Start a cloudflared quick tunnel to expose a local port
 */
export async function startCloudflaredTunnel(localPort: number): Promise<CloudflaredTunnel> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timeout waiting for cloudflared tunnel URL (30s)"));
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

/**
 * Stop a cloudflared tunnel
 */
export function stopCloudflaredTunnel(tunnel: CloudflaredTunnel): void {
  console.log("[cloudflared] Stopping tunnel...");
  tunnel.process.kill();
}
