import { Daytona } from "@daytonaio/sdk";
import { resolveLatestSnapshot } from "../integrations/daytona/snapshot-resolver.ts";
import type {
  MachineProvider,
  CreateMachineConfig,
  MachineProviderResult,
  MachineDisplayInfo,
  MachineCapabilities,
} from "./types.ts";

export function createDaytonaProvider(apiKey: string, snapshotPrefix: string): MachineProvider {
  const daytona = new Daytona({ apiKey });

  return {
    type: "daytona",

    async create(config: CreateMachineConfig): Promise<MachineProviderResult> {
      const snapshotName = await resolveLatestSnapshot(snapshotPrefix, { apiKey });

      const sandbox = await daytona.create({
        name: config.machineId,
        snapshot: snapshotName,
        envVars: config.envVars,
        autoStopInterval: snapshotPrefix.includes("dev")
          ? 12 * 60 // 12 hours
          : 0,
        autoDeleteInterval: snapshotPrefix.includes("dev")
          ? 12 * 60 // 12 hours
          : 0,
        public: true,
      });
      return { externalId: sandbox.id, metadata: { snapshotName } };
    },

    async start(externalId: string): Promise<void> {
      const sandbox = await daytona.get(externalId);
      await sandbox.start();
    },

    async stop(externalId: string): Promise<void> {
      const sandbox = await daytona.get(externalId);
      if (sandbox.state === "started") {
        await sandbox.stop();
      }
    },

    async restart(externalId: string): Promise<void> {
      const sandbox = await daytona.get(externalId);
      if (sandbox.state === "started") {
        await sandbox.stop();
      }
      await sandbox.start();
    },

    async archive(externalId: string): Promise<void> {
      const sandbox = await daytona.get(externalId);
      if (sandbox.state === "started") {
        await sandbox.stop();
      }
      await sandbox.archive();
    },

    async delete(externalId: string): Promise<void> {
      const sandbox = await daytona.get(externalId);
      if (sandbox.state === "started") {
        await sandbox.stop();
      }
      await sandbox.delete();
    },

    getPreviewUrl(externalId: string, _metadata?: Record<string, unknown>, port = 3000): string {
      return `https://${port}-${externalId}.proxy.daytona.works`;
    },

    getDisplayInfo(_metadata?: Record<string, unknown>): MachineDisplayInfo {
      return {
        label: "Daytona",
        isDevOnly: false,
      };
    },

    getCapabilities(): MachineCapabilities {
      return {
        hasNativeTerminal: true,
        hasProxyTerminal: true,
        hasDockerExec: false,
        hasContainerLogs: false,
        hasS6Services: true,
      };
    },
  };
}
