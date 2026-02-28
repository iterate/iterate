/**
 * Utility for spawning a child process and waiting for its HTTP port to be ready.
 * Used by all third-party service wrappers.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";

export interface SpawnInnerOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Port the inner process listens on (non-ephemeral for third-party binaries) */
  port: number;
  /** URL path to poll for readiness (default "/") */
  healthPath?: string;
  /** Consider any status < this as ready (default 400) */
  healthMaxStatus?: number;
  /** How long to wait for the process to become ready (default 60s) */
  timeoutMs?: number;
}

export interface SpawnInnerHandle {
  port: number;
  process: ChildProcess;
  kill(): void;
}

/**
 * Spawn a child process and poll its HTTP endpoint until ready.
 *
 * Third-party binaries typically bind to a fixed port (they don't
 * support port 0). The wrapper knows which port to expect and polls
 * until the process responds to HTTP.
 */
export async function spawnInner(opts: SpawnInnerOptions): Promise<SpawnInnerHandle> {
  const {
    command,
    args = [],
    env,
    port,
    healthPath = "/",
    healthMaxStatus = 400,
    timeoutMs = 60_000,
  } = opts;

  const proc = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: "pipe",
  });

  // Forward child stdout/stderr so logs are visible
  proc.stdout?.pipe(process.stdout);
  proc.stderr?.pipe(process.stderr);

  // Wait for the HTTP port to respond
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const ready = await checkHttp(port, healthPath, healthMaxStatus);
    if (ready) {
      return {
        port,
        process: proc,
        kill() {
          proc.kill("SIGTERM");
        },
      };
    }
    // Check if process exited unexpectedly
    if (proc.exitCode !== null) {
      throw new Error(`inner process exited with code ${String(proc.exitCode)} before becoming ready`);
    }
    await sleep(500);
  }

  proc.kill("SIGTERM");
  throw new Error(`inner process on port ${String(port)} did not become ready within ${String(timeoutMs)}ms`);
}

function checkHttp(port: number, path: string, maxStatus: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest(
      { hostname: "127.0.0.1", port, path, method: "GET", timeout: 2000 },
      (res) => {
        res.resume(); // drain
        resolve((res.statusCode ?? 999) < maxStatus);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
