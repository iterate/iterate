import { DaytonaProvider } from "./daytona/provider.ts";
import { DockerProvider } from "./docker/provider.ts";
import { FlyProvider } from "./fly/provider.ts";
import type { MachineType, ProviderState, Sandbox } from "./types.ts";

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

function parsePortFromUrl(url: string): number {
  const parsed = new URL(url);
  if (parsed.port) {
    return Number(parsed.port);
  }
  if (parsed.protocol === "https:") return 443;
  if (parsed.protocol === "http:") return 80;
  throw new Error(`Could not parse port from URL: ${url}`);
}

function toRawEnv(
  env: Record<string, unknown>,
  overrides?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const entries = Object.entries(env).map(([key, value]) => [
    key,
    typeof value === "string" ? value : undefined,
  ]);

  return {
    ...Object.fromEntries(entries),
    ...(overrides ?? {}),
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
    getPreviewUrl,
  };
}

function createSandboxRuntime<TSandbox extends Sandbox>(options: {
  type: Exclude<MachineType, "local">;
  externalId: string;
  provider: SandboxHandleProvider<TSandbox>;
  createSandbox(config: CreateMachineConfig): Promise<TSandbox>;
  createResult(config: CreateMachineConfig, sandbox: TSandbox): Promise<MachineRuntimeResult>;
}): MachineRuntime {
  const { type, externalId, provider, createSandbox, createResult } = options;

  const getSandbox = (providerId: string): TSandbox => {
    const sandbox = provider.get(providerId);
    if (!sandbox) {
      throw new Error(`Invalid ${type} provider id: ${providerId}`);
    }
    return sandbox;
  };

  return {
    type,
    async create(config: CreateMachineConfig): Promise<MachineRuntimeResult> {
      const sandbox = await createSandbox(config);
      return createResult(config, sandbox);
    },
    async start(): Promise<void> {
      await getSandbox(externalId).start();
    },
    async stop(): Promise<void> {
      await getSandbox(externalId).stop();
    },
    async restart(): Promise<void> {
      await getSandbox(externalId).restart();
    },
    async archive(): Promise<void> {
      await getSandbox(externalId).stop();
    },
    async delete(): Promise<void> {
      await getSandbox(externalId).delete();
    },
    async getPreviewUrl(port: number): Promise<string> {
      return getSandbox(externalId).getPreviewUrl({ port });
    },
    async getProviderState(): Promise<ProviderState> {
      return getSandbox(externalId).getState();
    },
  };
}

function createDockerRuntime(options: CreateMachineRuntimeOptions): MachineRuntime {
  const { env, externalId, metadata } = options;
  const typedMetadata = metadata as DockerMetadata;
  const localDockerConfig = typedMetadata.localDocker ?? {};
  const imageName = asString(localDockerConfig.imageName);
  const syncRepo = asBoolean(localDockerConfig.syncRepo);

  const provider = new DockerProvider(
    toRawEnv(env, {
      ...(imageName ? { DOCKER_IMAGE_NAME: imageName } : {}),
      ...(syncRepo === undefined
        ? {}
        : { DOCKER_SYNC_FROM_HOST_REPO: syncRepo ? "true" : "false" }),
    }),
  );

  return createSandboxRuntime({
    type: "docker",
    externalId,
    provider,
    async createSandbox(config: CreateMachineConfig) {
      return provider.create({
        id: config.machineId,
        name: config.name,
        envVars: config.envVars,
        ...(imageName ? { providerSnapshotId: imageName } : {}),
      });
    },
    async createResult(_config: CreateMachineConfig, sandbox): Promise<MachineRuntimeResult> {
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
  const provider = new DaytonaProvider(toRawEnv(env));
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
    async createResult(_config: CreateMachineConfig, sandbox): Promise<MachineRuntimeResult> {
      return {
        externalId: sandbox.providerId,
        metadata: {
          snapshotName: snapshotName ?? provider.defaultSnapshotId,
        },
      };
    },
  });
}

function createFlyRuntime(options: CreateMachineRuntimeOptions): MachineRuntime {
  const { env, externalId, metadata } = options;
  const provider = new FlyProvider(toRawEnv(env));
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
    async createResult(_config: CreateMachineConfig, sandbox): Promise<MachineRuntimeResult> {
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
