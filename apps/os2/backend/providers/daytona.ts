import { Daytona } from "@daytonaio/sdk";
import { resolveLatestSnapshot } from "../integrations/daytona/snapshot-resolver.ts";
import type { MachineProvider, CreateMachineConfig, MachineProviderResult } from "./types.ts";

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
        autoStopInterval: 0,
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
  };
}
