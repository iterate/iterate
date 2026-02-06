import { randomBytes } from "node:crypto";
import { z } from "zod/v4";
import {
  Sandbox,
  SandboxProvider,
  type CreateSandboxOptions,
  type ProviderState,
  type SandboxInfo,
  type SnapshotInfo,
} from "../types.ts";
import { slugify } from "../utils.ts";

const FLY_API_BASE = "https://api.machines.dev";
const WAIT_TIMEOUT_SECONDS = 300;
const MAX_WAIT_TIMEOUT_SECONDS = 60;
const DEFAULT_SERVICE_PORTS = [3000, 3001, 4096, 7777, 9876];
const DEFAULT_FLY_ORG = "iterate";
const DEFAULT_FLY_IMAGE = "registry.fly.io/iterate-sandbox-image:main";
const EXEC_RETRY_LIMIT = 3;

const FlyEnv = z.object({
  FLY_API_TOKEN: z.string(),
  FLY_ORG: z.string().default(DEFAULT_FLY_ORG),
  FLY_REGION: z.string().default("ord"),
  FLY_IMAGE: z.string().default(DEFAULT_FLY_IMAGE),
  SANDBOX_FLY_APP_NAME: z.string(),
  FLY_NETWORK: z.string().optional(),
  FLY_BASE_DOMAIN: z.string().default("fly.dev"),
});

type FlyEnv = z.infer<typeof FlyEnv>;

function withFlyToken(env: Record<string, string | undefined>): Record<string, string | undefined> {
  if (env.FLY_API_TOKEN || !env.FLY_API_KEY) {
    return env;
  }
  return {
    ...env,
    FLY_API_TOKEN: env.FLY_API_KEY,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function flyApi<T = unknown>(params: {
  env: FlyEnv;
  method: string;
  path: string;
  body?: unknown;
}): Promise<T> {
  const { env, method, path, body } = params;
  const response = await fetch(`${FLY_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.FLY_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path} failed (${response.status}): ${text}`);
  }

  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

async function waitForState(params: {
  env: FlyEnv;
  appName: string;
  machineId: string;
  state: string;
  timeoutSeconds?: number;
}): Promise<void> {
  const { env, appName, machineId, state, timeoutSeconds = WAIT_TIMEOUT_SECONDS } = params;
  const startedAt = Date.now();
  while (true) {
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    const remainingSeconds = timeoutSeconds - elapsedSeconds;
    if (remainingSeconds <= 0) {
      throw new Error(`Timed out waiting for Fly machine ${machineId} to reach '${state}'`);
    }

    const stepTimeoutSeconds = Math.max(1, Math.min(remainingSeconds, MAX_WAIT_TIMEOUT_SECONDS));
    try {
      await flyApi({
        env,
        method: "GET",
        path: `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}/wait?state=${encodeURIComponent(state)}&timeout=${stepTimeoutSeconds}`,
      });
      return;
    } catch (error) {
      const message = String(error).toLowerCase();
      if (!message.includes("deadline_exceeded") && !message.includes("(408)")) {
        throw error;
      }
    }
  }
}

function buildPreviewUrl(params: { baseDomain: string; appName: string; port: number }): string {
  const { baseDomain, appName, port } = params;
  if (port === 443) return `https://${appName}.${baseDomain}`;
  if (port === 80) return `http://${appName}.${baseDomain}`;
  return `http://${appName}.${baseDomain}:${port}`;
}

function makeService(port: number): Record<string, unknown> {
  return {
    protocol: "tcp",
    internal_port: port,
    ports: [{ port, handlers: ["http"] }],
  };
}

function isTransientFlyError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return (
    message.includes("deadline_exceeded") ||
    message.includes("(408)") ||
    message.includes("client.timeout exceeded")
  );
}

function isAlreadyExistsError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return message.includes("already exists") || message.includes("has already been taken");
}

function isNotFoundError(error: unknown): boolean {
  return String(error).toLowerCase().includes("(404)");
}

async function ensureFlyAppExists(env: FlyEnv): Promise<void> {
  try {
    await flyApi({
      env,
      method: "POST",
      path: "/v1/apps",
      body: {
        app_name: env.SANDBOX_FLY_APP_NAME,
        org_slug: env.FLY_ORG,
        ...(env.FLY_NETWORK ? { network: env.FLY_NETWORK } : {}),
      },
    });
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }
  }
}

function resolveMachineId(payload: unknown): string {
  const machine = asRecord(payload);
  const machineId = asString(machine.id);
  if (!machineId) {
    throw new Error("Fly machine creation response did not include an id");
  }
  return machineId;
}

function resolveState(payload: unknown): ProviderState {
  const machine = asRecord(payload);
  return {
    state: asString(machine.state) ?? "unknown",
    errorReason: asString(machine.error),
  };
}

export class FlySandbox extends Sandbox {
  readonly type = "fly" as const;
  readonly providerId: string;
  readonly appName: string;
  readonly machineId: string;

  private readonly env: FlyEnv;

  constructor(env: FlyEnv, machineId: string) {
    super();
    this.env = env;
    this.appName = env.SANDBOX_FLY_APP_NAME;
    this.machineId = machineId;
    this.providerId = machineId;
  }

  async getPreviewUrl(opts: { port: number }): Promise<string> {
    return buildPreviewUrl({
      baseDomain: this.env.FLY_BASE_DOMAIN,
      appName: this.appName,
      port: opts.port,
    });
  }

  async exec(cmd: string[]): Promise<string> {
    if (cmd.length === 0) {
      throw new Error("Fly exec requires at least one command token");
    }
    let payload: unknown;
    for (let attempt = 1; attempt <= EXEC_RETRY_LIMIT; attempt += 1) {
      try {
        payload = await flyApi<unknown>({
          env: this.env,
          method: "POST",
          path: `/v1/apps/${encodeURIComponent(this.appName)}/machines/${encodeURIComponent(this.machineId)}/exec`,
          body: {
            command: cmd,
            timeout: 60,
          },
        });
        break;
      } catch (error) {
        if (attempt >= EXEC_RETRY_LIMIT || !isTransientFlyError(error)) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
      }
    }
    if (payload === undefined) {
      throw new Error("Fly exec did not return a payload");
    }

    const result = asRecord(payload);
    const exitCode = typeof result.exit_code === "number" ? result.exit_code : 0;
    const stdout = asString(result.stdout) ?? "";
    const stderr = asString(result.stderr) ?? "";

    if (exitCode !== 0) {
      throw new Error(`Fly exec failed (exit=${exitCode}): ${stderr || stdout}`);
    }

    return stdout || stderr;
  }

  async getState(): Promise<ProviderState> {
    try {
      const payload = await flyApi<unknown>({
        env: this.env,
        method: "GET",
        path: `/v1/apps/${encodeURIComponent(this.appName)}/machines/${encodeURIComponent(this.machineId)}`,
      });
      return resolveState(payload);
    } catch (error) {
      return {
        state: "error",
        errorReason: String(error),
      };
    }
  }

  async start(): Promise<void> {
    await flyApi({
      env: this.env,
      method: "POST",
      path: `/v1/apps/${encodeURIComponent(this.appName)}/machines/${encodeURIComponent(this.machineId)}/start`,
      body: {},
    });
    await waitForState({
      env: this.env,
      appName: this.appName,
      machineId: this.machineId,
      state: "started",
    });
  }

  async stop(): Promise<void> {
    try {
      await flyApi({
        env: this.env,
        method: "POST",
        path: `/v1/apps/${encodeURIComponent(this.appName)}/machines/${encodeURIComponent(this.machineId)}/stop`,
        body: {},
      });
      await waitForState({
        env: this.env,
        appName: this.appName,
        machineId: this.machineId,
        state: "stopped",
      });
    } catch {
      // best effort
    }
  }

  async restart(): Promise<void> {
    try {
      await flyApi({
        env: this.env,
        method: "POST",
        path: `/v1/apps/${encodeURIComponent(this.appName)}/machines/${encodeURIComponent(this.machineId)}/restart`,
        body: {},
      });
    } catch {
      await this.stop();
      await this.start();
      return;
    }
    await waitForState({
      env: this.env,
      appName: this.appName,
      machineId: this.machineId,
      state: "started",
    });
  }

  async delete(): Promise<void> {
    try {
      await flyApi({
        env: this.env,
        method: "DELETE",
        path: `/v1/apps/${encodeURIComponent(this.appName)}/machines/${encodeURIComponent(this.machineId)}?force=true`,
      });
    } catch {
      // best effort cleanup
    }
  }
}

export class FlyProvider extends SandboxProvider {
  protected readonly envSchema = FlyEnv;
  declare protected readonly env: FlyEnv;

  readonly type = "fly" as const;

  constructor(rawEnv: Record<string, string | undefined>) {
    super(rawEnv);
    this.parseEnv(withFlyToken(rawEnv));
  }

  get defaultSnapshotId(): string {
    return this.env.FLY_IMAGE;
  }

  async create(opts: CreateSandboxOptions): Promise<FlySandbox> {
    const suffix = randomBytes(4).toString("hex");
    const base = slugify(opts.id ?? opts.name) || "sandbox";
    const entrypointArguments = opts.entrypointArguments;
    const hasEntrypointArguments = Boolean(entrypointArguments?.length);
    const appName = this.env.SANDBOX_FLY_APP_NAME;
    await ensureFlyAppExists(this.env);

    const createPayload = await flyApi<unknown>({
      env: this.env,
      method: "POST",
      path: `/v1/apps/${encodeURIComponent(appName)}/machines`,
      body: {
        name: `sandbox-${base}-${suffix}`.slice(0, 63),
        region: this.env.FLY_REGION,
        skip_launch: false,
        config: {
          image: opts.providerSnapshotId ?? this.defaultSnapshotId,
          env: opts.envVars,
          guest: { cpu_kind: "shared", cpus: 1, memory_mb: 1024 },
          restart: { policy: "always" },
          services: DEFAULT_SERVICE_PORTS.map((port) => makeService(port)),
          metadata: {
            "com.iterate.sandbox": "true",
            "com.iterate.machine_type": "fly",
          },
          ...(hasEntrypointArguments ? { init: { exec: entrypointArguments } } : {}),
        },
      },
    });

    const machineId = resolveMachineId(createPayload);
    await waitForState({ env: this.env, appName, machineId, state: "started" });

    return new FlySandbox(this.env, machineId);
  }

  get(providerId: string): FlySandbox | null {
    if (!providerId.trim()) return null;
    return new FlySandbox(this.env, providerId);
  }

  async listSandboxes(): Promise<SandboxInfo[]> {
    try {
      const machinesPayload = await flyApi<unknown>({
        env: this.env,
        method: "GET",
        path: `/v1/apps/${encodeURIComponent(this.env.SANDBOX_FLY_APP_NAME)}/machines`,
      });
      const machineList = Array.isArray(machinesPayload) ? machinesPayload : [];
      const sandboxes: SandboxInfo[] = [];
      for (const machine of machineList) {
        const machineRecord = asRecord(machine);
        const machineId = asString(machineRecord.id);
        if (!machineId) continue;

        const config = asRecord(machineRecord.config);
        const metadata = asRecord(config.metadata);
        const isSandbox = metadata["com.iterate.sandbox"] === "true";
        if (!isSandbox) continue;

        sandboxes.push({
          type: "fly" as const,
          providerId: machineId,
          name: asString(machineRecord.name) ?? machineId,
          state: asString(machineRecord.state) ?? "unknown",
        });
      }
      return sandboxes;
    } catch (error) {
      if (isNotFoundError(error)) {
        return [];
      }
      throw error;
    }
  }

  async listSnapshots(): Promise<SnapshotInfo[]> {
    return [
      {
        type: "fly" as const,
        snapshotId: this.defaultSnapshotId,
        name: this.defaultSnapshotId,
      },
    ];
  }
}
