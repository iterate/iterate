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
const WAIT_TIMEOUT_SECONDS = 90;
const DEFAULT_SERVICE_PORTS = [3000, 3001, 4096, 7777, 9876];

const FlyEnv = z.object({
  FLY_API_TOKEN: z.string(),
  FLY_ORG: z.string().default("personal"),
  FLY_REGION: z.string().default("ord"),
  FLY_IMAGE: z.string().default("ghcr.io/iterate/sandbox:main"),
  FLY_APP_PREFIX: z.string().default("iterate-sandbox"),
  FLY_NETWORK: z.string().optional(),
  FLY_BASE_DOMAIN: z.string().default("fly.dev"),
  FLY_APPS: z.string().optional(),
});

type FlyEnv = z.infer<typeof FlyEnv>;

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function encodeFlyProviderId(appName: string, machineId: string): string {
  return `${appName}:${machineId}`;
}

export function decodeFlyProviderId(
  providerId: string,
): { appName: string; machineId: string } | null {
  const separator = providerId.indexOf(":");
  if (separator <= 0 || separator >= providerId.length - 1) {
    return null;
  }

  return {
    appName: providerId.slice(0, separator),
    machineId: providerId.slice(separator + 1),
  };
}

async function flyApi<T = unknown>(
  env: FlyEnv,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
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

async function waitForState(
  env: FlyEnv,
  appName: string,
  machineId: string,
  state: string,
  timeoutSeconds = WAIT_TIMEOUT_SECONDS,
): Promise<void> {
  await flyApi(
    env,
    "GET",
    `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}/wait?state=${encodeURIComponent(state)}&timeout=${timeoutSeconds}`,
  );
}

function buildPreviewUrl(baseDomain: string, appName: string, port: number): string {
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

function isAlreadyExistsError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return message.includes("already exists") || message.includes("has already been taken");
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

  constructor(env: FlyEnv, appName: string, machineId: string) {
    super();
    this.env = env;
    this.appName = appName;
    this.machineId = machineId;
    this.providerId = encodeFlyProviderId(appName, machineId);
  }

  async getFetch(opts: { port: number }): Promise<typeof fetch> {
    const baseUrl = await this.getPreviewUrl(opts);
    return (input: string | Request | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? `${baseUrl}${input}` : input;
      return fetch(url, init);
    };
  }

  async getPreviewUrl(opts: { port: number }): Promise<string> {
    return buildPreviewUrl(this.env.FLY_BASE_DOMAIN, this.appName, opts.port);
  }

  async exec(cmd: string[]): Promise<string> {
    const payload = await flyApi<unknown>(
      this.env,
      "POST",
      `/v1/apps/${encodeURIComponent(this.appName)}/machines/${encodeURIComponent(this.machineId)}/exec`,
      {
        cmd,
        timeout: 60,
      },
    );

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
      const payload = await flyApi<unknown>(
        this.env,
        "GET",
        `/v1/apps/${encodeURIComponent(this.appName)}/machines/${encodeURIComponent(this.machineId)}`,
      );
      return resolveState(payload);
    } catch (error) {
      return {
        state: "error",
        errorReason: String(error),
      };
    }
  }

  async start(): Promise<void> {
    await flyApi(
      this.env,
      "POST",
      `/v1/apps/${encodeURIComponent(this.appName)}/machines/${encodeURIComponent(this.machineId)}/start`,
      {},
    );
    await waitForState(this.env, this.appName, this.machineId, "started");
  }

  async stop(): Promise<void> {
    try {
      await flyApi(
        this.env,
        "POST",
        `/v1/apps/${encodeURIComponent(this.appName)}/machines/${encodeURIComponent(this.machineId)}/stop`,
        {},
      );
      await waitForState(this.env, this.appName, this.machineId, "stopped");
    } catch {
      // best effort
    }
  }

  async restart(): Promise<void> {
    try {
      await flyApi(
        this.env,
        "POST",
        `/v1/apps/${encodeURIComponent(this.appName)}/machines/${encodeURIComponent(this.machineId)}/restart`,
        {},
      );
    } catch {
      await this.stop();
      await this.start();
      return;
    }
    await waitForState(this.env, this.appName, this.machineId, "started");
  }

  async delete(): Promise<void> {
    try {
      await flyApi(
        this.env,
        "DELETE",
        `/v1/apps/${encodeURIComponent(this.appName)}/machines/${encodeURIComponent(this.machineId)}?force=true`,
      );
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
    this.parseEnv(rawEnv);
  }

  get defaultSnapshotId(): string {
    return this.env.FLY_IMAGE;
  }

  async create(opts: CreateSandboxOptions): Promise<FlySandbox> {
    const suffix = randomBytes(4).toString("hex");
    const base = slugify(opts.id ?? opts.name) || "sandbox";
    const appName = `${this.env.FLY_APP_PREFIX}-${base}-${suffix}`.slice(0, 63);
    const entrypointArguments = opts.providerOptions?.fly?.entrypointArguments;
    const hasEntrypointArguments = Boolean(entrypointArguments?.length);

    try {
      await flyApi(this.env, "POST", "/v1/apps", {
        app_name: appName,
        org_slug: this.env.FLY_ORG,
        ...(this.env.FLY_NETWORK ? { network: this.env.FLY_NETWORK } : {}),
      });
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }

    const createPayload = await flyApi<unknown>(
      this.env,
      "POST",
      `/v1/apps/${encodeURIComponent(appName)}/machines`,
      {
        name: `sandbox-${base}`.slice(0, 63),
        region: this.env.FLY_REGION,
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
    );

    const machineId = resolveMachineId(createPayload);
    await waitForState(this.env, appName, machineId, "started");

    return new FlySandbox(this.env, appName, machineId);
  }

  get(providerId: string): FlySandbox | null {
    const parsed = decodeFlyProviderId(providerId);
    if (!parsed) return null;
    return new FlySandbox(this.env, parsed.appName, parsed.machineId);
  }

  async listSandboxes(): Promise<SandboxInfo[]> {
    const appNames = new Set<string>();

    const staticApps =
      this.env.FLY_APPS?.split(",")
        .map((value) => value.trim())
        .filter(Boolean) ?? [];
    for (const appName of staticApps) appNames.add(appName);

    try {
      const appsPayload = await flyApi<unknown>(
        this.env,
        "GET",
        `/v1/apps?org_slug=${encodeURIComponent(this.env.FLY_ORG)}`,
      );

      const appList = Array.isArray(appsPayload)
        ? appsPayload
        : asArray(asRecord(appsPayload).apps);

      for (const app of appList) {
        const appName = asString(asRecord(app).name) ?? asString(asRecord(app).app_name);
        if (!appName) continue;
        if (!appName.startsWith(this.env.FLY_APP_PREFIX)) continue;
        appNames.add(appName);
      }
    } catch {
      // fallback to FLY_APPS only
    }

    const sandboxes: SandboxInfo[] = [];

    for (const appName of appNames) {
      try {
        const machinesPayload = await flyApi<unknown>(
          this.env,
          "GET",
          `/v1/apps/${encodeURIComponent(appName)}/machines`,
        );

        const machineList = Array.isArray(machinesPayload)
          ? machinesPayload
          : asArray(asRecord(machinesPayload).machines);

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
            providerId: encodeFlyProviderId(appName, machineId),
            name: asString(machineRecord.name) ?? machineId,
            state: asString(machineRecord.state) ?? "unknown",
          });
        }
      } catch {
        // ignore app-level failures
      }
    }

    return sandboxes;
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
