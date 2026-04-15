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
 */
export async function useDevServer(options: UseDevServerOptions): Promise<DevServerHandle> {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
      PORT: String(options.port),
      ...(options.host ? { HOST: options.host } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: Buffer[] = [];

  child.stdout?.on("data", (data: Buffer) => {
    output.push(Buffer.from(data));
  });
  child.stderr?.on("data", (data: Buffer) => {
    output.push(Buffer.from(data));
  });

  const baseUrl = `http://${DEFAULT_PROBE_HOST}:${String(options.port)}`;

  try {
    await waitForHealth({
      baseUrl,
      child,
      healthcheckPath: options.healthcheckPath ?? DEFAULT_HEALTHCHECK_PATH,
      output,
      timeoutMs: options.timeoutMs ?? 45_000,
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
      `Failed to start dev server at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}${
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
}) {
  const healthcheckUrl = new URL(args.healthcheckPath, args.baseUrl);
  const deadline = Date.now() + args.timeoutMs;
  let lastError: string | undefined;

  while (Date.now() < deadline) {
    if (args.child.exitCode !== null) {
      throw new Error(`process exited with code ${String(args.child.exitCode)}`);
    }

    try {
      const response = await fetch(healthcheckUrl, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        return;
      }

      lastError = `GET ${healthcheckUrl.toString()} -> ${String(response.status)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await delay(300);
  }

  throw new Error(lastError ?? `timed out waiting for ${healthcheckUrl.toString()}`);
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
