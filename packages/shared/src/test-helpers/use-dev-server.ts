import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_HEALTHCHECK_PATH = "/api/__internal/health";
const DEFAULT_PROBE_HOST = "127.0.0.1";

export interface UseDevServerOptions {
  cwd: string;
  command: string;
  args: string[];
  port: number;
  env?: NodeJS.ProcessEnv;
  healthcheckPath?: string;
  host?: string;
  timeoutMs?: number;
}

export interface DevServerHandle extends AsyncDisposable {
  baseUrl: string;
}

/**
 * Start a dev server process, wait for a health check to succeed, and stop the
 * process on dispose.
 *
 * For Semaphore + `cloudflared` e2e: acquire {@link useCloudflareTunnelLease} first,
 * then pass `port: lease.localPort`
 * so the dev server listens where the tunnel forwards (e.g. `PORT` for `pnpm dev`).
 */
export async function useDevServer(options: UseDevServerOptions): Promise<DevServerHandle> {
  const mergedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    PORT: String(options.port),
    // Probe uses 127.0.0.1; Vite default HOST `::` can leave IPv4 unroutable on some systems.
    HOST: options.host ?? "127.0.0.1",
  };
  // Vitest and many CI runners set `CI=true`. Alchemy/Vite treat CI as "non-interactive"
  // and may exit or skip long-running dev behavior; local dev subprocesses should not inherit it.
  delete mergedEnv.CI;

  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: mergedEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: Buffer[] = [];

  child.stdout?.on("data", (data: Buffer) => {
    output.push(Buffer.from(data));
  });
  child.stderr?.on("data", (data: Buffer) => {
    output.push(Buffer.from(data));
  });

  const expectedBaseUrl = `http://${DEFAULT_PROBE_HOST}:${String(options.port)}`;

  try {
    const baseUrl = await waitForHealth({
      baseUrl: expectedBaseUrl,
      child,
      healthcheckPath: options.healthcheckPath ?? DEFAULT_HEALTHCHECK_PATH,
      output,
      timeoutMs: options.timeoutMs ?? 40_000,
    });

    return {
      baseUrl,
      async [Symbol.asyncDispose]() {
        await stopChild(child);
      },
    };
  } catch (error) {
    await stopChild(child).catch(() => {});
    const logs = Buffer.concat(output).toString("utf8");
    throw new Error(
      `Failed to start dev server at ${expectedBaseUrl}: ${error instanceof Error ? error.message : String(error)}${
        logs ? `\n--- dev server output ---\n${logs}` : ""
      }`,
    );
  }
}

async function waitForHealth(args: {
  baseUrl: string;
  child: ReturnType<typeof spawn>;
  healthcheckPath: string;
  output: Buffer[];
  timeoutMs: number;
}): Promise<string> {
  const deadline = Date.now() + args.timeoutMs;
  let lastError: string | undefined;

  while (Date.now() < deadline) {
    if (args.child.exitCode !== null) {
      throw new Error(`process exited with code ${String(args.child.exitCode)}`);
    }

    const healthcheckUrl = new URL(args.healthcheckPath, args.baseUrl);

    try {
      const response = await fetch(healthcheckUrl, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        return args.baseUrl;
      }

      lastError = `GET ${healthcheckUrl.toString()} -> ${String(response.status)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await delay(300);
  }

  throw new Error(lastError ?? `timed out waiting for health check`);
}

async function stopChild(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.killed) {
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(3_000).then(() => {
      child.kill("SIGKILL");
    }),
  ]);
}
