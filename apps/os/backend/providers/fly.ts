import { FlyProvider, decodeFlyProviderId } from "@iterate-com/sandbox/providers/fly";
import type {
  CreateMachineConfig,
  MachineProvider,
  MachineProviderResult,
  ProviderState,
} from "./types.ts";

const DEFAULT_DAEMON_PORT = 3000;
const DEFAULT_FLY_BASE_DOMAIN = "fly.dev";

type FlyMachineMetadata = {
  flyAppName?: string;
  flyMachineId?: string;
  snapshotName?: string;
  providerSnapshotId?: string;
};

export interface FlyMachineProviderConfig {
  externalId: string;
  metadata: Record<string, unknown>;
  rawEnv: Record<string, string | undefined>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getFlySnapshotOverride(metadata: Record<string, unknown>): string | undefined {
  const typed = metadata as FlyMachineMetadata;
  return typed.providerSnapshotId ?? typed.snapshotName;
}

function buildFlyPreviewUrl(baseDomain: string, appName: string, port: number): string {
  if (port === 443) return `https://${appName}.${baseDomain}`;
  if (port === 80) return `http://${appName}.${baseDomain}`;
  return `http://${appName}.${baseDomain}:${port}`;
}

function resolveProviderId(
  externalId: string,
  metadata: Record<string, unknown>,
): { providerId: string; appName: string; machineId: string } | null {
  const parsedExternalId = decodeFlyProviderId(externalId);
  if (parsedExternalId) {
    return {
      providerId: externalId,
      appName: parsedExternalId.appName,
      machineId: parsedExternalId.machineId,
    };
  }

  const appName = asString(metadata["flyAppName"]);
  const machineId = asString(metadata["flyMachineId"]);
  if (!appName || !machineId) return null;

  return {
    providerId: `${appName}:${machineId}`,
    appName,
    machineId,
  };
}

export function createFlyProvider(config: FlyMachineProviderConfig): MachineProvider {
  const { externalId, metadata, rawEnv } = config;
  const provider = new FlyProvider(rawEnv);
  const baseDomain = rawEnv.FLY_BASE_DOMAIN ?? DEFAULT_FLY_BASE_DOMAIN;

  const resolved = resolveProviderId(externalId, metadata);
  let currentProviderId = resolved?.providerId ?? "";
  let currentAppName = resolved?.appName;

  const getSandbox = () => {
    if (!currentProviderId) {
      throw new Error("Fly machine has no provider id");
    }
    const sandbox = provider.get(currentProviderId);
    if (!sandbox) {
      throw new Error(`Invalid fly provider id: ${currentProviderId}`);
    }
    return sandbox;
  };

  return {
    type: "fly",

    async create(machineConfig: CreateMachineConfig): Promise<MachineProviderResult> {
      const snapshotOverride = getFlySnapshotOverride(metadata);
      const sandbox = await provider.create({
        id: machineConfig.machineId,
        name: machineConfig.name,
        envVars: machineConfig.envVars,
        providerSnapshotId: snapshotOverride,
      });

      currentProviderId = sandbox.providerId;
      currentAppName = sandbox.appName;

      return {
        externalId: sandbox.providerId,
        metadata: {
          flyAppName: sandbox.appName,
          flyMachineId: sandbox.machineId,
          snapshotName: snapshotOverride ?? provider.defaultSnapshotId,
        },
      };
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
      await getSandbox().stop();
    },

    async delete(): Promise<void> {
      await getSandbox().delete();
    },

    getPreviewUrl(port: number): string {
      if (!currentAppName) {
        throw new Error("Fly machine has no app name");
      }
      return buildFlyPreviewUrl(baseDomain, currentAppName, port);
    },

    get previewUrl(): string {
      return this.getPreviewUrl(DEFAULT_DAEMON_PORT);
    },

    get displayInfo() {
      return {
        label: currentAppName ? `Fly.io ${currentAppName}` : "Fly.io",
      };
    },

    async getProviderState(): Promise<ProviderState> {
      return getSandbox().getState();
    },
  };
}
