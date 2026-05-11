import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export type StartServerOptions = {
  host?: string;
  port?: number | string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const serverEntry = resolve(scriptDir, "../.output/server/index.mjs");

export async function runBuiltServer(options: StartServerOptions = {}) {
  const host =
    options.host?.trim() ||
    options.env?.NITRO_HOST?.trim() ||
    options.env?.HOST?.trim() ||
    "127.0.0.1";
  const port = resolvePort(
    options.port != null
      ? String(options.port)
      : options.env?.NITRO_PORT?.trim() || options.env?.PORT?.trim() || "0",
  );

  console.log(
    `[example:start] HOST=${host} PORT=${port}${port === "0" ? " (ephemeral; wait for Nitro banner)" : ""}`,
  );

  const env: NodeJS.ProcessEnv = {
    ...options.env,
    HOST: host,
    NITRO_HOST: host,
    PORT: port,
    NITRO_PORT: port,
  };

  delete env.TEST;

  const child = spawn(process.execPath, ["--enable-source-maps", serverEntry], {
    env,
    stdio: "inherit",
  });

  const disposeCallbacks: Array<() => void> = [];
  const dispose = () => {
    for (const callback of disposeCallbacks.splice(0)) {
      callback();
    }
  };

  const killChild = (signal: NodeJS.Signals) => {
    if (child.exitCode === null && !child.killed) {
      child.kill(signal);
    }
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const onSignal = () => {
      killChild(signal);
    };

    process.on(signal, onSignal);
    disposeCallbacks.push(() => {
      process.off(signal, onSignal);
    });
  }

  if (options.signal) {
    const onAbort = () => {
      killChild("SIGTERM");
    };

    if (options.signal.aborted) {
      onAbort();
    } else {
      options.signal.addEventListener("abort", onAbort, { once: true });
      disposeCallbacks.push(() => {
        options.signal?.removeEventListener("abort", onAbort);
      });
    }
  }

  return await new Promise<number>((resolve, reject) => {
    child.on("error", (error) => {
      dispose();
      reject(error);
    });

    child.on("exit", (code, signal) => {
      dispose();
      resolve(signal ? signalToExitCode(signal) : (code ?? 0));
    });
  });
}

function resolvePort(value: string) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`Invalid --port value: ${value}`);
  }

  return String(parsed);
}

function signalToExitCode(signal: NodeJS.Signals) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

function parseStartArgs(args: string[]) {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    strict: false,
    options: {
      host: {
        type: "string",
      },
      port: {
        type: "string",
        short: "p",
      },
    },
  });

  return {
    host: asTrimmedString(values.host),
    port: asTrimmedString(values.port),
  };
}

function asTrimmedString(value: string | boolean | undefined) {
  return typeof value === "string" ? value.trim() : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const { host, port } = parseStartArgs(process.argv.slice(2));
  const code = await runBuiltServer({
    host,
    port,
    env: process.env,
  });
  process.exit(code);
}
