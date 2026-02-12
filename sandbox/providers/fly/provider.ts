import { z } from "zod/v4";
import {
  Sandbox,
  SandboxProvider,
  type CreateSandboxOptions,
  type ProviderState,
  type SandboxInfo,
  type SnapshotInfo,
} from "../types.ts";
import { MAX_CANONICAL_MACHINE_NAME_LENGTH, sanitizeNamePart } from "../naming.ts";
import { asRecord } from "../utils.ts";

const FLY_API_BASE = "https://api.machines.dev";
const FLY_GRAPHQL_BASE = "https://api.fly.io/graphql";
const WAIT_TIMEOUT_SECONDS = 300;
const MAX_WAIT_TIMEOUT_SECONDS = 60;
const DEFAULT_WEB_INTERNAL_PORT = 8080;
const DEFAULT_SERVICE_PORTS: number[] = [];
const DEFAULT_FLY_ORG = "iterate";
const DEFAULT_FLY_REGION = "lhr";
const DEFAULT_FLY_MACHINE_CPUS = 4;
const DEFAULT_FLY_MACHINE_MEMORY_MB = 4096;
const EXEC_RETRY_LIMIT = 3;
const LIST_APPS_PAGE_SIZE = 100;
const FLY_MACHINE_NAME = "sandbox";

const FlyEnv = z.object({
  FLY_API_TOKEN: z.string(),
  FLY_ORG: z.string().default(DEFAULT_FLY_ORG),
  FLY_DEFAULT_REGION: z.string().default(DEFAULT_FLY_REGION),
  FLY_DEFAULT_IMAGE: z
    .string()
    .describe(
      "Fully-qualified image tag, e.g. registry.fly.io/iterate-sandbox:sha-abc123. Set via Doppler.",
    ),
  FLY_DEFAULT_CPUS: z.coerce.number().int().positive().default(DEFAULT_FLY_MACHINE_CPUS),
  FLY_DEFAULT_MEMORY_MB: z.coerce.number().int().positive().default(DEFAULT_FLY_MACHINE_MEMORY_MB),
  SANDBOX_NAME_PREFIX: z.enum(["dev", "stg", "prd"]),
  FLY_NETWORK: z.string().optional(),
  FLY_BASE_DOMAIN: z.string().default("fly.dev"),
});

type FlyEnv = z.infer<typeof FlyEnv>;

type FlyGraphQlResponse<TData> = {
  data?: TData;
  errors?: Array<{ message?: string }>;
};

type FlyAppNetwork = {
  app: {
    sharedIpAddress: string | null;
  } | null;
};

type FlyAllocateIp = {
  allocateIpAddress: {
    ipAddress: {
      address: string;
      type: string;
      region: string;
    } | null;
  } | null;
};

type FlyOrgApps = {
  organization: {
    apps: {
      nodes: Array<{ name: string }>;
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
    };
  } | null;
};

const FLY_APP_NETWORK_QUERY = `
  query FlyAppNetwork($appName: String!) {
    app(name: $appName) {
      sharedIpAddress
    }
  }
`;

const FLY_ALLOCATE_SHARED_V4_MUTATION = `
  mutation FlyAllocateSharedV4($appId: ID!) {
    allocateIpAddress(input: { appId: $appId, type: shared_v4 }) {
      ipAddress {
        address
        type
        region
      }
    }
  }
`;

const FLY_ORG_APPS_QUERY = `
  query FlyOrgApps($orgSlug: String!, $first: Int!, $after: String) {
    organization(slug: $orgSlug) {
      apps(first: $first, after: $after) {
        nodes {
          name
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function sanitizeFlyAppName(value: string): string {
  return sanitizeNamePart(value).slice(0, MAX_CANONICAL_MACHINE_NAME_LENGTH).replace(/-+$/, "");
}

function isSandboxAppName(params: { env: FlyEnv; appName: string }): boolean {
  const { env, appName } = params;
  return appName.startsWith(`${env.SANDBOX_NAME_PREFIX}-`);
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

async function flyGraphQL<TData>(params: {
  env: FlyEnv;
  query: string;
  variables?: Record<string, unknown>;
}): Promise<TData> {
  const { env, query, variables } = params;
  const response = await fetch(FLY_GRAPHQL_BASE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.FLY_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = (await response.json()) as FlyGraphQlResponse<TData>;
  if (!response.ok) {
    throw new Error(`GraphQL request failed (${response.status}): ${JSON.stringify(payload)}`);
  }

  if (payload.errors?.length) {
    const message = payload.errors
      .map((error) => error.message)
      .filter((value): value is string => Boolean(value))
      .join("; ");
    throw new Error(`GraphQL request failed: ${message || "unknown error"}`);
  }

  if (!payload.data) {
    throw new Error("GraphQL request returned no data");
  }

  return payload.data;
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
  if (port === DEFAULT_WEB_INTERNAL_PORT) return `https://${appName}.${baseDomain}`;
  if (port === 443) return `https://${appName}.${baseDomain}`;
  if (port === 80) return `http://${appName}.${baseDomain}`;
  return `http://${appName}.${baseDomain}:${port}`;
}

function makeService(params: {
  internalPort: number;
  externalPorts: Array<{ port: number; handlers?: string[] }>;
}): Record<string, unknown> {
  const { internalPort, externalPorts } = params;
  return {
    protocol: "tcp",
    internal_port: internalPort,
    ports: externalPorts.map((portConfig) => ({
      port: portConfig.port,
      ...(portConfig.handlers?.length ? { handlers: portConfig.handlers } : {}),
    })),
  };
}

function buildServices(): Array<Record<string, unknown>> {
  return [
    makeService({
      internalPort: DEFAULT_WEB_INTERNAL_PORT,
      externalPorts: [
        { port: 80, handlers: ["http"] },
        { port: 443, handlers: ["tls", "http"] },
      ],
    }),
    ...DEFAULT_SERVICE_PORTS.map((port) =>
      makeService({
        internalPort: port,
        externalPorts: [{ port }],
      }),
    ),
  ];
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

function isGraphQlNotFoundError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return (
    message.includes("not found") ||
    message.includes("couldn't resolve") ||
    message.includes("cannot return null")
  );
}

function isMachineStillActiveError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return message.includes("failed_precondition") && message.includes("still active");
}

async function ensureFlyAppExists(params: { env: FlyEnv; appName: string }): Promise<void> {
  const { env, appName } = params;
  try {
    await flyApi({
      env,
      method: "POST",
      path: "/v1/apps",
      body: {
        app_name: appName,
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

async function ensureFlyIngress(params: { env: FlyEnv; appName: string }): Promise<void> {
  const { env, appName } = params;

  const appNetwork = await flyGraphQL<FlyAppNetwork>({
    env,
    query: FLY_APP_NETWORK_QUERY,
    variables: { appName },
  });
  if (!appNetwork.app) {
    throw new Error(`Fly app ${appName} not found after creation`);
  }

  if (appNetwork.app.sharedIpAddress) {
    return;
  }

  await flyGraphQL<FlyAllocateIp>({
    env,
    query: FLY_ALLOCATE_SHARED_V4_MUTATION,
    variables: { appId: appName },
  });

  const verify = await flyGraphQL<FlyAppNetwork>({
    env,
    query: FLY_APP_NETWORK_QUERY,
    variables: { appName },
  });
  if (!verify.app?.sharedIpAddress) {
    throw new Error(`Failed to allocate shared IPv4 for Fly app ${appName}`);
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

function resolveSandboxMachine(payload: unknown): Record<string, unknown> | null {
  if (!Array.isArray(payload)) return null;
  const records = payload.map(asRecord);

  const byName = records.find((record) => asString(record.name) === FLY_MACHINE_NAME);
  if (byName) return byName;

  const byMetadata = records.find((record) => {
    const config = asRecord(record.config);
    const metadata = asRecord(config.metadata);
    return metadata["com.iterate.sandbox"] === "true";
  });
  if (byMetadata) return byMetadata;

  return records.length === 1 ? records[0] : null;
}

export class FlySandbox extends Sandbox {
  readonly type = "fly" as const;
  readonly providerId: string;
  readonly appName: string;
  machineId: string | undefined;

  private readonly env: FlyEnv;

  constructor(params: { env: FlyEnv; appName: string; machineId?: string }) {
    super();
    this.env = params.env;
    this.appName = params.appName;
    this.machineId = params.machineId;
    this.providerId = this.appName;
  }

  private async resolveMachineId(): Promise<string> {
    if (this.machineId) return this.machineId;

    const machinesPayload = await flyApi<unknown>({
      env: this.env,
      method: "GET",
      path: `/v1/apps/${encodeURIComponent(this.appName)}/machines`,
    });
    const machine = resolveSandboxMachine(machinesPayload);
    const machineId = machine ? asString(machine.id) : undefined;
    if (!machineId) {
      throw new Error(`Could not resolve Fly machine for app ${this.appName}`);
    }

    this.machineId = machineId;
    return machineId;
  }

  async getBaseUrl(opts: { port: number }): Promise<string> {
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

    const machineId = await this.resolveMachineId();

    let payload: unknown;
    for (let attempt = 1; attempt <= EXEC_RETRY_LIMIT; attempt += 1) {
      try {
        payload = await flyApi<unknown>({
          env: this.env,
          method: "POST",
          path: `/v1/apps/${encodeURIComponent(this.appName)}/machines/${encodeURIComponent(machineId)}/exec`,
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
      const machineId = await this.resolveMachineId();
      const payload = await flyApi<unknown>({
        env: this.env,
        method: "GET",
        path: `/v1/apps/${encodeURIComponent(this.appName)}/machines/${encodeURIComponent(machineId)}`,
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
    const machineId = await this.resolveMachineId();

    for (let attempt = 1; attempt <= EXEC_RETRY_LIMIT; attempt += 1) {
      try {
        await flyApi({
          env: this.env,
          method: "POST",
          path: `/v1/apps/${encodeURIComponent(this.appName)}/machines/${encodeURIComponent(machineId)}/start`,
          body: {},
        });
        break;
      } catch (error) {
        if (!isMachineStillActiveError(error) || attempt >= EXEC_RETRY_LIMIT) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }

    await waitForState({
      env: this.env,
      appName: this.appName,
      machineId,
      state: "started",
    });
  }

  async stop(): Promise<void> {
    try {
      const machineId = await this.resolveMachineId();
      await flyApi({
        env: this.env,
        method: "POST",
        path: `/v1/apps/${encodeURIComponent(this.appName)}/machines/${encodeURIComponent(machineId)}/stop`,
        body: {},
      });

      await waitForState({
        env: this.env,
        appName: this.appName,
        machineId,
        state: "stopped",
      });
    } catch {
      // best effort
    }
  }

  async restart(): Promise<void> {
    const machineId = await this.resolveMachineId();

    try {
      await flyApi({
        env: this.env,
        method: "POST",
        path: `/v1/apps/${encodeURIComponent(this.appName)}/machines/${encodeURIComponent(machineId)}/restart`,
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
      machineId,
      state: "started",
    });
  }

  async delete(): Promise<void> {
    try {
      const machineId = await this.resolveMachineId();
      await flyApi({
        env: this.env,
        method: "DELETE",
        path: `/v1/apps/${encodeURIComponent(this.appName)}/machines/${encodeURIComponent(machineId)}?force=true`,
      });
    } catch {
      // best effort cleanup
    }

    try {
      await flyApi({
        env: this.env,
        method: "DELETE",
        path: `/v1/apps/${encodeURIComponent(this.appName)}`,
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
    this.parseEnv(rawEnv);
  }

  get defaultSnapshotId(): string {
    return this.env.FLY_DEFAULT_IMAGE;
  }

  async create(opts: CreateSandboxOptions): Promise<FlySandbox> {
    // Fly app names can be rejected by abuse filters even when they are technically valid
    // (for example names containing certain phishing-related words). Our canonical
    // external ID currently includes project slug; if this becomes noisy in production,
    // switch the canonical builder to use project ID instead of project slug.
    const appName = sanitizeFlyAppName(opts.externalId);
    if (!appName) {
      throw new Error("Fly create requires a non-empty externalId");
    }
    if (appName !== opts.externalId) {
      throw new Error(`Fly externalId '${opts.externalId}' contains invalid app-name characters`);
    }

    const entrypointArguments = opts.entrypointArguments;
    const hasEntrypointArguments = Boolean(entrypointArguments?.length);
    const envVars = {
      ...opts.envVars,
      __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS:
        opts.envVars?.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS ?? ".fly.dev",
    };

    await ensureFlyAppExists({ env: this.env, appName });
    await ensureFlyIngress({ env: this.env, appName });
    const snapshotId = opts.providerSnapshotId ?? this.defaultSnapshotId;
    if (snapshotId.includes("registry.fly.io/iterate-sandbox-image:")) {
      throw new Error(
        `FLY_DEFAULT_IMAGE is still using deprecated registry app 'iterate-sandbox-image': ${snapshotId}. Update Doppler to registry.fly.io/iterate-sandbox:sha-...`,
      );
    }

    const createPayload = await flyApi<unknown>({
      env: this.env,
      method: "POST",
      path: `/v1/apps/${encodeURIComponent(appName)}/machines`,
      body: {
        name: FLY_MACHINE_NAME,
        region: this.env.FLY_DEFAULT_REGION,
        skip_launch: false,
        config: {
          image: snapshotId,
          env: envVars,
          guest: {
            cpu_kind: "shared",
            cpus: this.env.FLY_DEFAULT_CPUS,
            memory_mb: this.env.FLY_DEFAULT_MEMORY_MB,
          },
          restart: { policy: "always" },
          services: buildServices(),
          metadata: {
            "com.iterate.sandbox": "true",
            "com.iterate.machine_type": "fly",
            "com.iterate.external_id": opts.externalId,
          },
          ...(hasEntrypointArguments ? { init: { exec: entrypointArguments } } : {}),
        },
      },
    });

    const machineId = resolveMachineId(createPayload);
    await waitForState({ env: this.env, appName, machineId, state: "started" });

    return new FlySandbox({
      env: this.env,
      appName,
      machineId,
    });
  }

  get(providerId: string): FlySandbox | null {
    return this.getWithMachineId({ providerId });
  }

  getWithMachineId(params: { providerId: string; machineId?: string }): FlySandbox | null {
    const appName = sanitizeFlyAppName(params.providerId);
    if (!appName) return null;

    return new FlySandbox({
      env: this.env,
      appName,
      machineId: params.machineId,
    });
  }

  async listSandboxes(): Promise<SandboxInfo[]> {
    const appNames: string[] = [];
    let after: string | null = null;

    while (true) {
      const appsPage: FlyOrgApps = await flyGraphQL<FlyOrgApps>({
        env: this.env,
        query: FLY_ORG_APPS_QUERY,
        variables: {
          orgSlug: this.env.FLY_ORG,
          first: LIST_APPS_PAGE_SIZE,
          after,
        },
      });

      const apps = appsPage.organization?.apps;
      if (!apps) break;

      apps.nodes
        .map((node: { name: string }) => node.name)
        .filter((appName: string) => isSandboxAppName({ env: this.env, appName }))
        .forEach((appName: string) => appNames.push(appName));

      if (!apps.pageInfo.hasNextPage) break;
      after = apps.pageInfo.endCursor;
      if (!after) break;
    }

    const lists = await Promise.all(
      appNames.map(async (appName) => {
        try {
          const machinesPayload = await flyApi<unknown>({
            env: this.env,
            method: "GET",
            path: `/v1/apps/${encodeURIComponent(appName)}/machines`,
          });
          return { appName, machinesPayload };
        } catch (error) {
          if (isNotFoundError(error) || isGraphQlNotFoundError(error)) {
            return { appName, machinesPayload: [] };
          }
          throw error;
        }
      }),
    );

    const sandboxes: SandboxInfo[] = [];

    for (const list of lists) {
      const machine = resolveSandboxMachine(list.machinesPayload);
      if (!machine) continue;

      const config = asRecord(machine.config);
      const metadata = asRecord(config.metadata);
      const isSandbox = metadata["com.iterate.sandbox"] === "true";
      if (!isSandbox) continue;

      sandboxes.push({
        type: "fly" as const,
        providerId: list.appName,
        name: list.appName,
        state: asString(machine.state) ?? "unknown",
      });
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
