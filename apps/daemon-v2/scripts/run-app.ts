import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createDaemonClient } from "@iterate-com/daemon-v2-contract";
import { localHostForService } from "@iterate-com/shared/jonasland";
import getPort from "get-port";
import { z } from "zod";

const DEFAULT_BIND_HOST = "0.0.0.0";
const DEFAULT_HEALTH_CHECK_PATH = "/api/__common/health";
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_INTERVAL_MS = 300;
const DEFAULT_REGISTRATION_TIMEOUT_MS = 30_000;
const DEFAULT_REGISTRATION_INTERVAL_MS = 500;
const scriptPath = fileURLToPath(import.meta.url);

const AppManifest = z.object({
  packageName: z.string().trim().min(1),
  version: z.string().trim().min(1),
  slug: z.string().trim().min(1),
  description: z.string().trim().min(1),
});

type AppManifest = z.infer<typeof AppManifest>;

interface RunAppCliOptions {
  app: string;
  cwd: string;
  command: string;
  args: string[];
  host?: string;
  port?: number;
  healthCheck?: string;
  tags: string[];
  registryBaseUrl?: string;
}

interface RunRegisteredAppOptions extends RunAppCliOptions {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
  registrationTimeoutMs?: number;
  registrationIntervalMs?: number;
}

interface RuntimeBinding {
  bindHost: string;
  connectHost: string;
  port: number;
}

interface ChildExitState {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function asTrimmedString(value: string | boolean | undefined) {
  return typeof value === "string" ? value.trim() : undefined;
}

function normalizeTags(tags: string[]) {
  return [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))];
}

function resolveConnectHost(bindHost: string) {
  const normalized = bindHost.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized === "[::]" ||
    normalized === "localhost"
  ) {
    return "127.0.0.1";
  }
  return bindHost;
}

function formatTarget(connectHost: string, port: number) {
  const host = connectHost.includes(":") ? `[${connectHost}]` : connectHost;
  return `${host}:${String(port)}`;
}

export async function resolveRuntimeBinding(options: {
  host?: string;
  port?: number;
}): Promise<RuntimeBinding> {
  const bindHost = options.host?.trim() || DEFAULT_BIND_HOST;
  const connectHost = resolveConnectHost(bindHost);
  const port = options.port ?? (await getPort({ host: connectHost }));
  return {
    bindHost,
    connectHost,
    port,
  };
}

export function resolveHealthCheckUrl(options: {
  healthCheck?: string;
  connectHost: string;
  port: number;
}) {
  const rawValue = options.healthCheck?.trim() || DEFAULT_HEALTH_CHECK_PATH;
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(rawValue)) {
    return new URL(rawValue).toString();
  }
  const path = rawValue.startsWith("/") ? rawValue : `/${rawValue}`;
  return new URL(path, `http://${formatTarget(options.connectHost, options.port)}/`).toString();
}

async function loadAppManifest(appPath: string): Promise<AppManifest> {
  const module = await import(pathToFileURL(appPath).href);
  return AppManifest.parse(module.default);
}

function resolveRegistryBaseUrl(options: { registryBaseUrl?: string; env?: NodeJS.ProcessEnv }) {
  const explicitBaseUrl = options.registryBaseUrl?.trim();
  if (explicitBaseUrl) {
    return new URL(explicitBaseUrl).toString();
  }
  const registrySlug = options.env?.ITERATE_INGRESS_DEFAULT_APP?.trim() || "registry";
  return new URL(`http://${localHostForService({ slug: registrySlug })}`).toString();
}

async function waitForHealthCheck(options: {
  url: string;
  childExitState: () => ChildExitState | null;
  timeoutMs: number;
  intervalMs: number;
  signal?: AbortSignal;
}) {
  const deadline = Date.now() + options.timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    if (options.signal?.aborted) {
      throw new Error("Aborted while waiting for app health check.");
    }

    const childExit = options.childExitState();
    if (childExit) {
      throw new Error(
        `App exited before becoming healthy (${describeExit(childExit.code, childExit.signal)}).`,
      );
    }

    try {
      const response = await fetch(options.url, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        return;
      }
      lastError = new Error(`Health check returned ${response.status} for ${options.url}`);
    } catch (error) {
      lastError = error;
    }

    await delay(options.intervalMs);
  }

  throw new Error(
    `Timed out waiting for app health check at ${options.url}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function registerAppRoute(options: {
  app: AppManifest;
  connectHost: string;
  port: number;
  tags: string[];
  registryBaseUrl: string;
  childExitState: () => ChildExitState | null;
  timeoutMs: number;
  intervalMs: number;
  signal?: AbortSignal;
}) {
  const client = createDaemonClient({
    url: new URL("/api", options.registryBaseUrl).toString(),
  });
  const host = localHostForService({ slug: options.app.slug });
  const target = formatTarget(options.connectHost, options.port);
  const deadline = Date.now() + options.timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    if (options.signal?.aborted) {
      throw new Error("Aborted while registering app route.");
    }

    const childExit = options.childExitState();
    if (childExit) {
      throw new Error(
        `App exited before registry registration completed (${describeExit(childExit.code, childExit.signal)}).`,
      );
    }

    try {
      await client.routes.upsert({
        host,
        target,
        metadata: {
          source: "run-app",
          title: options.app.slug,
          description: options.app.description,
          openapiPath: "/api/openapi.json",
        },
        tags: options.tags,
      });
      return;
    } catch (error) {
      lastError = error;
    }

    await delay(options.intervalMs);
  }

  throw new Error(
    `Timed out registering ${options.app.slug} with registry at ${options.registryBaseUrl}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function stopChildProcess(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolvePromise) => {
      child.once("exit", () => {
        resolvePromise();
      });
    }),
    delay(3_000).then(() => {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGKILL");
      }
    }),
  ]);
}

function signalToExitCode(signal: NodeJS.Signals) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

function describeExit(code: number | null, signal: NodeJS.Signals | null) {
  if (signal) return `signal ${signal}`;
  return `code ${code ?? 0}`;
}

export async function runRegisteredApp(options: RunRegisteredAppOptions) {
  const cwd = resolve(options.cwd);
  const appPath = resolve(cwd, options.app);
  const app = await loadAppManifest(appPath);
  const binding = await resolveRuntimeBinding({
    host: options.host,
    port: options.port,
  });
  const healthCheckUrl = resolveHealthCheckUrl({
    healthCheck: options.healthCheck,
    connectHost: binding.connectHost,
    port: binding.port,
  });
  const registryBaseUrl = resolveRegistryBaseUrl({
    registryBaseUrl: options.registryBaseUrl,
    env: options.env,
  });
  const tags = normalizeTags(options.tags);

  console.log(
    `[run-app] app=${app.slug} command=${options.command} cwd=${cwd} host=${binding.bindHost} port=${binding.port}`,
  );
  console.log(`[run-app] health=${healthCheckUrl} registry=${registryBaseUrl}`);

  const child = spawn(options.command, options.args, {
    cwd,
    env: {
      ...options.env,
      HOST: binding.bindHost,
      PORT: String(binding.port),
      NITRO_HOST: binding.bindHost,
      NITRO_PORT: String(binding.port),
    },
    stdio: "inherit",
  });

  const disposeCallbacks: Array<() => void> = [];
  let childExitState: ChildExitState | null = null;

  const exitPromise = new Promise<number>((resolvePromise, rejectPromise) => {
    child.on("error", (error) => {
      rejectPromise(error);
    });
    child.on("exit", (code, signal) => {
      childExitState = { code, signal };
      resolvePromise(signal ? signalToExitCode(signal) : (code ?? 0));
    });
  });

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

  try {
    await waitForHealthCheck({
      url: healthCheckUrl,
      childExitState: () => childExitState,
      timeoutMs: options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
      intervalMs: options.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS,
      signal: options.signal,
    });
    await registerAppRoute({
      app,
      connectHost: binding.connectHost,
      port: binding.port,
      tags,
      registryBaseUrl,
      childExitState: () => childExitState,
      timeoutMs: options.registrationTimeoutMs ?? DEFAULT_REGISTRATION_TIMEOUT_MS,
      intervalMs: options.registrationIntervalMs ?? DEFAULT_REGISTRATION_INTERVAL_MS,
      signal: options.signal,
    });
    return await exitPromise;
  } catch (error) {
    await stopChildProcess(child);
    await exitPromise.catch(() => undefined);
    throw error;
  } finally {
    for (const dispose of disposeCallbacks.splice(0)) {
      dispose();
    }
  }
}

export function parseRunAppArgs(args: string[]): RunAppCliOptions {
  const separatorIndex = args.indexOf("--");
  const optionArgs = separatorIndex >= 0 ? args.slice(0, separatorIndex) : args;
  const childArgs = separatorIndex >= 0 ? args.slice(separatorIndex + 1) : [];

  const { values } = parseArgs({
    args: optionArgs,
    strict: true,
    allowPositionals: false,
    options: {
      app: {
        type: "string",
      },
      cwd: {
        type: "string",
      },
      host: {
        type: "string",
      },
      port: {
        type: "string",
        short: "p",
      },
      "health-check": {
        type: "string",
      },
      tag: {
        type: "string",
        multiple: true,
      },
      "registry-base-url": {
        type: "string",
      },
    },
  });

  if (childArgs.length === 0) {
    throw new Error("Missing child command. Pass it after `--`.");
  }

  const app = asTrimmedString(values.app);
  if (!app) {
    throw new Error("Missing required `--app`.");
  }

  const cwd = asTrimmedString(values.cwd);
  if (!cwd) {
    throw new Error("Missing required `--cwd`.");
  }

  const portValue = asTrimmedString(values.port);
  const parsedPort =
    portValue === undefined
      ? undefined
      : z.coerce.number().int().min(1).max(65535).parse(portValue);

  return {
    app,
    cwd,
    command: childArgs[0]!,
    args: childArgs.slice(1),
    host: asTrimmedString(values.host),
    port: parsedPort,
    healthCheck: asTrimmedString(values["health-check"]),
    tags: normalizeTags(values.tag ?? []),
    registryBaseUrl: asTrimmedString(values["registry-base-url"]),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const options = parseRunAppArgs(process.argv.slice(2));
  const code = await runRegisteredApp({
    ...options,
    env: process.env,
  });
  process.exit(code);
}
