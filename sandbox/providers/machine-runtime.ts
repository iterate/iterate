import { DaytonaProvider } from "./daytona/provider.ts";
import { DockerProvider, type DockerSandbox } from "./docker/provider.ts";
import { FlyProvider } from "./fly/provider.ts";
import type { MachineType, ProviderState, Sandbox, SandboxFetcher } from "./types.ts";

export interface CreateMachineConfig {
  machineId: string;
  name: string;
  envVars: Record<string, string>;
}

export interface MachineRuntimeResult {
  externalId: string;
  metadata?: Record<string, unknown>;
}

export interface MachineRuntime {
  readonly type: MachineType;
  create(config: CreateMachineConfig): Promise<MachineRuntimeResult>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  archive(): Promise<void>;
  delete(): Promise<void>;
  getFetcher(port: number): Promise<SandboxFetcher>;
  getPreviewUrl(port: number): Promise<string>;
  getProviderState?(): Promise<ProviderState>;
}

export interface CreateMachineRuntimeOptions {
  type: MachineType;
  env: Record<string, unknown>;
  externalId: string;
  metadata: Record<string, unknown>;
}

type LocalMetadata = {
  host?: string;
  ports?: Record<string, number>;
  port?: number;
};

type DockerMetadata = {
  localDocker?: {
    imageName?: string;
    syncRepo?: boolean;
  };
  ports?: Record<string, number>;
  port?: number;
};

type FlyMetadata = {
  snapshotName?: string;
  providerSnapshotId?: string;
};

type DaytonaMetadata = {
  snapshotName?: string;
};

type SandboxHandleProvider<TSandbox extends Sandbox> = {
  get(providerId: string): TSandbox | null;
};

const LOCAL_SERVICE_KEY_BY_PORT: Record<number, string> = {
  3000: "iterate-daemon",
  3001: "iterate-daemon-server",
  4096: "opencode",
  9876: "pidnap",
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parsePortFromUrl(url: string): number {
  const parsed = new URL(url);
  if (parsed.port) {
    return Number(parsed.port);
  }
  if (parsed.protocol === "https:") return 443;
  if (parsed.protocol === "http:") return 80;
  throw new Error(`Could not parse port from URL: ${url}`);
}

function toRawEnv(params: {
  env: Record<string, unknown>;
  overrides?: Record<string, string | undefined>;
}): Record<string, string | undefined> {
  const { env, overrides } = params;
  const entries = Object.entries(env).map(([key, value]) => [
    key,
    typeof value === "string" ? value : undefined,
  ]);

  return {
    ...Object.fromEntries(entries),
    ...(overrides ?? {}),
  };
}

function createUrlFetcher(baseUrl: string): SandboxFetcher {
  return async (input: string | Request | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" && !/^https?:\/\//.test(input) ? `${baseUrl}${input}` : input;
    return fetch(url, init);
  };
}

function createLocalRuntime(metadata: Record<string, unknown>): MachineRuntime {
  const typedMetadata = metadata as LocalMetadata;
  const host = typedMetadata.host ?? "localhost";
  const ports = typedMetadata.ports ?? {};

  const getPreviewUrl = async (port: number): Promise<string> => {
    const serviceKey = LOCAL_SERVICE_KEY_BY_PORT[port];
    if (serviceKey && ports[serviceKey]) {
      return `http://${host}:${ports[serviceKey]}`;
    }

    const explicitPort = ports[String(port)];
    if (explicitPort) {
      return `http://${host}:${explicitPort}`;
    }

    if (port === 3000 && typedMetadata.port) {
      return `http://${host}:${typedMetadata.port}`;
    }

    if (ports["iterate-daemon"]) {
      return `http://${host}:${ports["iterate-daemon"]}`;
    }

    return `http://${host}:${port}`;
  };

  return {
    type: "local",
    async create(machineConfig: CreateMachineConfig): Promise<MachineRuntimeResult> {
      return {
        externalId: machineConfig.machineId,
        metadata: {
          host,
          ports,
          daemonStatus: "ready",
          daemonReadyAt: new Date().toISOString(),
        },
      };
    },
    async start(): Promise<void> {},
    async stop(): Promise<void> {},
    async restart(): Promise<void> {},
    async archive(): Promise<void> {},
    async delete(): Promise<void> {},
    async getFetcher(port: number): Promise<SandboxFetcher> {
      const baseUrl = await getPreviewUrl(port);
      return createUrlFetcher(baseUrl);
    },
    getPreviewUrl,
  };
}

function createSandboxRuntime<TSandbox extends Sandbox>(options: {
  type: Exclude<MachineType, "local">;
  externalId: string;
  provider: SandboxHandleProvider<TSandbox>;
  createSandbox(config: CreateMachineConfig): Promise<TSandbox>;
  createResult(params: {
    config: CreateMachineConfig;
    sandbox: TSandbox;
  }): Promise<MachineRuntimeResult>;
  archiveSandbox?: (sandbox: TSandbox) => Promise<void>;
}): MachineRuntime {
  const { type, externalId, provider, createSandbox, createResult, archiveSandbox } = options;
  let sandboxHandle: TSandbox | null = null;

  const getSandbox = (): TSandbox => {
    if (sandboxHandle) return sandboxHandle;
    const sandbox = provider.get(externalId);
    if (!sandbox) {
      throw new Error(`Invalid ${type} provider id: ${externalId}`);
    }
    sandboxHandle = sandbox;
    return sandboxHandle;
  };

  return {
    type,
    async create(config: CreateMachineConfig): Promise<MachineRuntimeResult> {
      const sandbox = await createSandbox(config);
      sandboxHandle = sandbox;
      return createResult({ config, sandbox });
    },
    async start(): Promise<void> {
      await getSandbox().start();
    },
    async stop(): Promise<void> {
      await getSandbox().stop();
    },
    async restart(): Promise<void> {
      await getSandbox().restart();
    },
    async archive(): Promise<void> {
      const sandbox = getSandbox();
      if (archiveSandbox) {
        await archiveSandbox(sandbox);
        return;
      }
      await sandbox.stop();
    },
    async delete(): Promise<void> {
      await getSandbox().delete();
    },
    async getFetcher(port: number): Promise<SandboxFetcher> {
      return getSandbox().getFetcher({ port });
    },
    async getPreviewUrl(port: number): Promise<string> {
      return getSandbox().getPreviewUrl({ port });
    },
    async getProviderState(): Promise<ProviderState> {
      return getSandbox().getState();
    },
  };
}

function resolveDockerPortsFromMetadata(metadata: DockerMetadata): Record<number, number> {
  const metadataPorts = metadata.ports ?? {};
  const mappedPorts: Record<number, number> = {};

  for (const [internalPort, serviceKey] of Object.entries(LOCAL_SERVICE_KEY_BY_PORT)) {
    const hostPort = asNumber(metadataPorts[serviceKey]);
    if (!hostPort || hostPort <= 0) continue;
    mappedPorts[Number(internalPort)] = hostPort;
  }

  for (const [internalPort, hostPortRaw] of Object.entries(metadataPorts)) {
    const hostPort = asNumber(hostPortRaw);
    const internalPortNumber = Number(internalPort);
    if (!hostPort || hostPort <= 0) continue;
    if (!Number.isInteger(internalPortNumber) || internalPortNumber <= 0) continue;
    mappedPorts[internalPortNumber] = hostPort;
  }

  return mappedPorts;
}

function createDockerRuntime(options: CreateMachineRuntimeOptions): MachineRuntime {
  const { env, externalId, metadata } = options;
  const typedMetadata = metadata as DockerMetadata;
  const localDockerConfig = typedMetadata.localDocker ?? {};
  const imageName = asString(localDockerConfig.imageName);
  const syncRepo = asBoolean(localDockerConfig.syncRepo);

  const provider = new DockerProvider(
    toRawEnv({
      env,
      overrides: {
        ...(imageName ? { DOCKER_IMAGE_NAME: imageName } : {}),
        ...(syncRepo === undefined
          ? {}
          : { DOCKER_SYNC_FROM_HOST_REPO: syncRepo ? "true" : "false" }),
      },
    }),
  );
  const knownPorts = resolveDockerPortsFromMetadata(typedMetadata);
  const providerHandle: SandboxHandleProvider<DockerSandbox> = {
    get(providerId) {
      return provider.getWithPorts({ providerId, knownPorts: { ...knownPorts } });
    },
  };

  return createSandboxRuntime({
    type: "docker",
    externalId,
    provider: providerHandle,
    async createSandbox(config: CreateMachineConfig) {
      return provider.create({
        id: config.machineId,
        name: config.name,
        envVars: config.envVars,
        ...(imageName ? { providerSnapshotId: imageName } : {}),
      });
    },
    async createResult({ sandbox }): Promise<MachineRuntimeResult> {
      const daemonPortPairs = await Promise.all(
        Object.entries(LOCAL_SERVICE_KEY_BY_PORT)
          .filter(([port]) => Number(port) !== 9876)
          .map(async ([port, serviceKey]) => {
            const url = await sandbox.getPreviewUrl({ port: Number(port) });
            return [serviceKey, parsePortFromUrl(url)] as const;
          }),
      );

      const pidnapUrl = await sandbox.getPreviewUrl({ port: 9876 });
      const ports = Object.fromEntries([
        ...daemonPortPairs,
        ["pidnap", parsePortFromUrl(pidnapUrl)],
      ]);

      return {
        externalId: sandbox.providerId,
        metadata: {
          ...(imageName || syncRepo !== undefined
            ? {
                localDocker: {
                  ...(imageName ? { imageName } : {}),
                  ...(syncRepo === undefined ? {} : { syncRepo }),
                },
              }
            : {}),
          ports,
        },
      };
    },
  });
}

function createDaytonaRuntime(options: CreateMachineRuntimeOptions): MachineRuntime {
  const { env, externalId, metadata } = options;
  const provider = new DaytonaProvider(toRawEnv({ env }));
  const typedMetadata = metadata as DaytonaMetadata;
  const snapshotName = typedMetadata.snapshotName;

  return createSandboxRuntime({
    type: "daytona",
    externalId,
    provider,
    async createSandbox(config: CreateMachineConfig) {
      return provider.create({
        id: config.machineId,
        name: config.name,
        envVars: config.envVars,
        ...(snapshotName ? { providerSnapshotId: snapshotName } : {}),
      });
    },
    async createResult({ sandbox }): Promise<MachineRuntimeResult> {
      return {
        externalId: sandbox.providerId,
        metadata: {
          snapshotName: snapshotName ?? provider.defaultSnapshotId,
        },
      };
    },
    async archiveSandbox(sandbox) {
      await sandbox.archive();
    },
  });
}

function createFlyRuntime(options: CreateMachineRuntimeOptions): MachineRuntime {
  const { env, externalId, metadata } = options;
  const provider = new FlyProvider(toRawEnv({ env }));
  const typedMetadata = metadata as FlyMetadata;
  const snapshotName = typedMetadata.providerSnapshotId ?? typedMetadata.snapshotName;

  return createSandboxRuntime({
    type: "fly",
    externalId,
    provider,
    async createSandbox(config: CreateMachineConfig) {
      return provider.create({
        id: config.machineId,
        name: config.name,
        envVars: config.envVars,
        ...(snapshotName ? { providerSnapshotId: snapshotName } : {}),
      });
    },
    async createResult({ sandbox }): Promise<MachineRuntimeResult> {
      return {
        externalId: sandbox.providerId,
        metadata: {
          snapshotName: snapshotName ?? provider.defaultSnapshotId,
        },
      };
    },
  });
}

export async function createMachineRuntime(
  options: CreateMachineRuntimeOptions,
): Promise<MachineRuntime> {
  const { type, metadata } = options;

  switch (type) {
    case "local":
      return createLocalRuntime(metadata);
    case "docker":
      return createDockerRuntime(options);
    case "daytona":
      return createDaytonaRuntime(options);
    case "fly":
      return createFlyRuntime(options);
    default: {
      const exhaustiveCheck: never = type;
      throw new Error(`Unknown machine type: ${exhaustiveCheck}`);
    }
  }
}
