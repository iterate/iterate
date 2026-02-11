import { DaytonaProvider } from "./daytona/provider.ts";
import { DockerProvider, type DockerSandbox } from "./docker/provider.ts";
import { FlyProvider } from "./fly/provider.ts";
import type { MachineType, ProviderState, Sandbox, SandboxFetcher } from "./types.ts";
import { asRecord } from "./utils.ts";

export interface CreateMachineConfig {
  machineId: string;
  externalId: string;
  name: string;
  envVars: Record<string, string>;
}

export interface MachineStubResult {
  metadata?: Record<string, unknown>;
}

export interface MachineStub {
  readonly type: MachineType;
  create(config: CreateMachineConfig): Promise<MachineStubResult>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  archive(): Promise<void>;
  delete(): Promise<void>;
  getFetcher(port: number): Promise<SandboxFetcher>;
  getBaseUrl(port: number): Promise<string>;
  getProviderState?(): Promise<ProviderState>;
}

export interface CreateMachineStubOptions {
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
  docker?: {
    containerRef?: string;
  };
  snapshotName?: string;
  ports?: Record<string, number>;
  port?: number;
};

type FlyMetadata = {
  snapshotName?: string;
  providerSnapshotId?: string;
  flyMachineCpus?: number;
  fly?: {
    machineId?: string;
  };
};

type DaytonaMetadata = {
  snapshotName?: string;
  daytona?: {
    sandboxId?: string;
  };
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

function asPositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
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

function createLocalStub(metadata: Record<string, unknown>): MachineStub {
  const typedMetadata = metadata as LocalMetadata;
  const host = typedMetadata.host ?? "localhost";
  const ports = typedMetadata.ports ?? {};

  const getBaseUrl = async (port: number): Promise<string> => {
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
    async create(): Promise<MachineStubResult> {
      return {
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
      const baseUrl = await getBaseUrl(port);
      return createUrlFetcher(baseUrl);
    },
    getBaseUrl,
  };
}

function createSandboxStub<TSandbox extends Sandbox>(options: {
  type: Exclude<MachineType, "local">;
  externalId: string;
  provider: SandboxHandleProvider<TSandbox>;
  createSandbox(config: CreateMachineConfig): Promise<TSandbox>;
  createResult(params: {
    config: CreateMachineConfig;
    sandbox: TSandbox;
  }): Promise<Record<string, unknown> | undefined>;
  archiveSandbox?: (sandbox: TSandbox) => Promise<void>;
}): MachineStub {
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
    async create(config: CreateMachineConfig): Promise<MachineStubResult> {
      const sandbox = await createSandbox(config);
      sandboxHandle = sandbox;
      const metadata = await createResult({ config, sandbox });
      return metadata ? { metadata } : {};
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
    async getBaseUrl(port: number): Promise<string> {
      return getSandbox().getBaseUrl({ port });
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

function createDockerStub(options: CreateMachineStubOptions): MachineStub {
  const { env, externalId, metadata } = options;
  const typedMetadata = metadata as DockerMetadata;
  const localDockerConfig = typedMetadata.localDocker ?? {};
  const dockerMetadata = asRecord(typedMetadata.docker);
  const imageName = asString(localDockerConfig.imageName) ?? asString(typedMetadata.snapshotName);
  const syncRepo = asBoolean(localDockerConfig.syncRepo);
  const knownContainerRef = asString(dockerMetadata.containerRef);

  const provider = new DockerProvider(
    toRawEnv({
      env,
      overrides: {
        ...(imageName ? { DOCKER_DEFAULT_IMAGE: imageName } : {}),
        ...(syncRepo === undefined
          ? {}
          : { DOCKER_HOST_SYNC_ENABLED: syncRepo ? "true" : "false" }),
      },
    }),
  );
  const knownPorts = resolveDockerPortsFromMetadata(typedMetadata);
  const providerHandle: SandboxHandleProvider<DockerSandbox> = {
    get(providerId) {
      return provider.getWithPorts({
        providerId: knownContainerRef ?? providerId,
        knownPorts: { ...knownPorts },
      });
    },
  };

  return createSandboxStub({
    type: "docker",
    externalId,
    provider: providerHandle,
    async createSandbox(config: CreateMachineConfig) {
      return provider.create({
        externalId: config.externalId,
        id: config.machineId,
        name: config.name,
        envVars: config.envVars,
        ...(imageName ? { providerSnapshotId: imageName } : {}),
      });
    },
    async createResult({ sandbox }): Promise<Record<string, unknown>> {
      const daemonPortPairs = await Promise.all(
        Object.entries(LOCAL_SERVICE_KEY_BY_PORT)
          .filter(([port]) => Number(port) !== 9876)
          .map(async ([port, serviceKey]) => {
            const url = await sandbox.getBaseUrl({ port: Number(port) });
            return [serviceKey, parsePortFromUrl(url)] as const;
          }),
      );

      const pidnapUrl = await sandbox.getBaseUrl({ port: 9876 });
      const ports = Object.fromEntries([
        ...daemonPortPairs,
        ["pidnap", parsePortFromUrl(pidnapUrl)],
      ]);

      return {
        ...(imageName || syncRepo !== undefined
          ? {
              localDocker: {
                ...(imageName ? { imageName } : {}),
                ...(syncRepo === undefined ? {} : { syncRepo }),
              },
            }
          : {}),
        ports,
        docker: {
          containerRef: sandbox.runtimeId ?? sandbox.providerId,
        },
      };
    },
  });
}

function createDaytonaStub(options: CreateMachineStubOptions): MachineStub {
  const { env, externalId, metadata } = options;
  const provider = new DaytonaProvider(toRawEnv({ env }));
  const typedMetadata = metadata as DaytonaMetadata;
  const snapshotName = typedMetadata.snapshotName;
  const daytonaMetadata = asRecord(typedMetadata.daytona);
  const knownSandboxId = asString(daytonaMetadata.sandboxId);

  return createSandboxStub({
    type: "daytona",
    externalId,
    provider: {
      get(providerId) {
        return provider.getWithSandboxId({ providerId, sandboxId: knownSandboxId });
      },
    },
    async createSandbox(config: CreateMachineConfig) {
      return provider.create({
        externalId: config.externalId,
        id: config.machineId,
        name: config.name,
        envVars: config.envVars,
        ...(snapshotName ? { providerSnapshotId: snapshotName } : {}),
      });
    },
    async createResult({ sandbox }): Promise<Record<string, unknown>> {
      return {
        snapshotName: snapshotName ?? provider.defaultSnapshotId,
        daytona: {
          sandboxId: sandbox.runtimeSandboxId ?? sandbox.providerId,
        },
      };
    },
    async archiveSandbox(sandbox) {
      await sandbox.archive();
    },
  });
}

function createFlyStub(options: CreateMachineStubOptions): MachineStub {
  const { env, externalId, metadata } = options;
  const typedMetadata = metadata as FlyMetadata;
  const snapshotName = typedMetadata.providerSnapshotId ?? typedMetadata.snapshotName;
  const flyMachineCpus = asPositiveInteger(typedMetadata.flyMachineCpus);
  const provider = new FlyProvider(
    toRawEnv({
      env,
      overrides: flyMachineCpus ? { FLY_DEFAULT_CPUS: String(flyMachineCpus) } : {},
    }),
  );
  const flyMetadata = asRecord(typedMetadata.fly);
  const knownMachineId = asString(flyMetadata.machineId);

  return createSandboxStub({
    type: "fly",
    externalId,
    provider: {
      get(providerId) {
        return provider.getWithMachineId({ providerId, machineId: knownMachineId });
      },
    },
    async createSandbox(config: CreateMachineConfig) {
      return provider.create({
        externalId: config.externalId,
        id: config.machineId,
        name: config.name,
        envVars: config.envVars,
        ...(snapshotName ? { providerSnapshotId: snapshotName } : {}),
      });
    },
    async createResult({ sandbox }): Promise<Record<string, unknown>> {
      return {
        snapshotName: snapshotName ?? provider.defaultSnapshotId,
        fly: {
          machineId: sandbox.machineId,
        },
      };
    },
  });
}

export async function createMachineStub(options: CreateMachineStubOptions): Promise<MachineStub> {
  const { type, metadata } = options;

  switch (type) {
    case "local":
      return createLocalStub(metadata);
    case "docker":
      return createDockerStub(options);
    case "daytona":
      return createDaytonaStub(options);
    case "fly":
      return createFlyStub(options);
    default: {
      const exhaustiveCheck: never = type;
      throw new Error(`Unknown machine type: ${exhaustiveCheck}`);
    }
  }
}
