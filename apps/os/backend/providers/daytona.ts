import { Daytona } from "@daytonaio/sdk";
import { resolveLatestSnapshot } from "../integrations/daytona/snapshot-resolver.ts";
import type {
  MachineProvider,
  CreateMachineConfig,
  MachineProviderResult,
  MachineDisplayInfo,
  MachineCommands,
} from "./types.ts";

// Common log paths in sandbox
const DAEMON_LOG = "/var/log/iterate-daemon/current";
const OPENCODE_LOG = "/var/log/opencode/current";
const S6_STATUS_CMD =
  'export S6DIR=/home/iterate/src/github.com/iterate/iterate/apps/os/sandbox/s6-daemons && for svc in $S6DIR/*/; do echo "=== $(basename $svc) ==="; s6-svstat "$svc"; done';

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

    getCommands(_metadata?: Record<string, unknown>): MachineCommands {
      // Daytona: commands run in web terminal, no docker exec needed
      return {
        daemonLogs: `tail -f ${DAEMON_LOG}`,
        opencodeLogs: `tail -f ${OPENCODE_LOG}`,
        serviceStatus: S6_STATUS_CMD,
      };
    },

    hasNativeTerminal(): boolean {
      return true;
    },

    hasProxyTerminal(): boolean {
      return true;
    },
  };
}
