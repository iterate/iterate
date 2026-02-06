import { DaytonaProvider } from "@iterate-com/sandbox/providers/daytona";
import { DockerProvider } from "@iterate-com/sandbox/providers/docker";
import { FlyProvider, decodeFlyProviderId } from "@iterate-com/sandbox/providers/fly";
import type { ProviderState } from "@iterate-com/sandbox/providers/types";
import type { CloudflareEnv } from "../env.ts";
import * as schema from "./db/schema.ts";
import { DAEMON_DEFINITIONS } from "./daemons.ts";

export interface CreateMachineConfig {
  machineId: string;
  name: string;
  envVars: Record<string, string>;
}

export interface MachineRuntimeResult {
  externalId: string;
  metadata?: Record<string, unknown>;
}

export interface MachineDisplayInfo {
  label: string;
}

export interface MachineRuntime {
  readonly type: (typeof schema.MachineType)[number];
  create(config: CreateMachineConfig): Promise<MachineRuntimeResult>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  archive(): Promise<void>;
  delete(): Promise<void>;
  getPreviewUrl(port: number): Promise<string>;
  readonly displayInfo: MachineDisplayInfo;
  getProviderState?(): Promise<ProviderState>;
}

export interface CreateMachineRuntimeOptions {
  type: (typeof schema.MachineType)[number];
  env: CloudflareEnv;
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
  flyAppName?: string;
  flyMachineId?: string;
  snapshotName?: string;
  providerSnapshotId?: string;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function toRawEnv(
  env: CloudflareEnv,
  overrides?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    ...(env as unknown as Record<string, string | undefined>),
    ...(overrides ?? {}),
  };
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

function createLocalRuntime(
  metadata: Record<string, unknown>,
  _externalId: string,
): MachineRuntime {
  const typedMetadata = metadata as LocalMetadata;
  const host = typedMetadata.host ?? "localhost";
  const ports = typedMetadata.ports ?? {};
  const displayPort = ports["iterate-daemon"] ?? typedMetadata.port ?? 3000;

  const getPreviewUrl = async (port: number): Promise<string> => {
    const daemon = DAEMON_DEFINITIONS.find((definition) => definition.internalPort === port);
    if (daemon && ports[daemon.id]) {
      return `http://${host}:${ports[daemon.id]}`;
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
    displayInfo: {
      label: `Local ${host}:${displayPort}`,
    },
  };
}

async function createDockerRuntime(options: CreateMachineRuntimeOptions): Promise<MachineRuntime> {
  const { env, externalId, metadata } = options;
  if (!import.meta.env.DEV) {
    throw new Error("docker provider only available in development");
  }

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

  const getSandbox = (providerId: string) => {
    const sandbox = provider.get(providerId);
    if (!sandbox) {
      throw new Error(`Invalid docker provider id: ${providerId}`);
    }
    return sandbox;
  };

  const previewPort = typedMetadata.ports?.["iterate-daemon"] ?? typedMetadata.port;

  return {
    type: "docker",
    async create(machineConfig: CreateMachineConfig): Promise<MachineRuntimeResult> {
      const sandbox = await provider.create({
        id: machineConfig.machineId,
        name: machineConfig.name,
        envVars: machineConfig.envVars,
        ...(imageName ? { providerSnapshotId: imageName } : {}),
      });

      const daemonPortPairs = await Promise.all(
        DAEMON_DEFINITIONS.map(async (daemon) => {
          const url = await sandbox.getPreviewUrl({ port: daemon.internalPort });
          return [daemon.id, parsePortFromUrl(url)] as const;
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
          ...(typedMetadata ?? {}),
          ...(imageName || syncRepo !== undefined
            ? {
                localDocker: {
                  ...(imageName ? { imageName } : {}),
                  ...(syncRepo === undefined ? {} : { syncRepo }),
                },
              }
            : {}),
          containerId: sandbox.providerId,
          ports,
        },
      };
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
    displayInfo: {
      label: `Local Docker :${previewPort ?? "?"}`,
    },
    async getProviderState(): Promise<ProviderState> {
      return getSandbox(externalId).getState();
    },
  };
}

function createDaytonaRuntime(options: CreateMachineRuntimeOptions): MachineRuntime {
  const { env, externalId, metadata } = options;
  const provider = new DaytonaProvider(toRawEnv(env));
  const typedMetadata = metadata as { snapshotName?: string };

  const getSandbox = (providerId: string) => {
    const sandbox = provider.get(providerId);
    if (!sandbox) {
      throw new Error(`Invalid daytona provider id: ${providerId}`);
    }
    return sandbox;
  };

  return {
    type: "daytona",
    async create(machineConfig: CreateMachineConfig): Promise<MachineRuntimeResult> {
      const snapshotName = typedMetadata.snapshotName;
      const sandbox = await provider.create({
        id: machineConfig.machineId,
        name: machineConfig.name,
        envVars: machineConfig.envVars,
        ...(snapshotName ? { providerSnapshotId: snapshotName } : {}),
      });
      return {
        externalId: sandbox.providerId,
        metadata: {
          snapshotName: snapshotName ?? provider.defaultSnapshotId,
          sandboxName: sandbox.providerId,
        },
      };
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
    displayInfo: {
      label: "Daytona",
    },
    async getProviderState(): Promise<ProviderState> {
      return getSandbox(externalId).getState();
    },
  };
}

function createFlyRuntime(options: CreateMachineRuntimeOptions): MachineRuntime {
  const { env, externalId, metadata } = options;
  const provider = new FlyProvider(toRawEnv(env));
  const typedMetadata = metadata as FlyMetadata;
  const parsedProviderId = decodeFlyProviderId(externalId);
  const appNameFromId = parsedProviderId?.appName ?? typedMetadata.flyAppName;

  const getSandbox = (providerId: string) => {
    const sandbox = provider.get(providerId);
    if (!sandbox) {
      throw new Error(`Invalid fly provider id: ${providerId}`);
    }
    return sandbox;
  };

  return {
    type: "fly",
    async create(machineConfig: CreateMachineConfig): Promise<MachineRuntimeResult> {
      const snapshotName = typedMetadata.providerSnapshotId ?? typedMetadata.snapshotName;
      const sandbox = await provider.create({
        id: machineConfig.machineId,
        name: machineConfig.name,
        envVars: machineConfig.envVars,
        ...(snapshotName ? { providerSnapshotId: snapshotName } : {}),
      });
      return {
        externalId: sandbox.providerId,
        metadata: {
          flyAppName: sandbox.appName,
          flyMachineId: sandbox.machineId,
          snapshotName: snapshotName ?? provider.defaultSnapshotId,
        },
      };
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
    displayInfo: {
      label: appNameFromId ? `Fly.io ${appNameFromId}` : "Fly.io",
    },
    async getProviderState(): Promise<ProviderState> {
      return getSandbox(externalId).getState();
    },
  };
}

export async function createMachineRuntime(
  options: CreateMachineRuntimeOptions,
): Promise<MachineRuntime> {
  const { type, externalId, metadata } = options;

  switch (type) {
    case "local":
      return createLocalRuntime(metadata, externalId);
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
