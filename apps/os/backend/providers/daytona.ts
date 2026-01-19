import { Daytona } from "@daytonaio/sdk";
import { resolveLatestSnapshot } from "../integrations/daytona/snapshot-resolver.ts";
import type { MachineProvider, CreateMachineConfig, MachineProviderResult } from "./types.ts";

// Common log paths in sandbox
const DAEMON_LOG = "/var/log/iterate-daemon/current";
const OPENCODE_LOG = "/var/log/opencode/current";
const S6_STATUS_CMD =
  'export S6DIR=/home/iterate/src/github.com/iterate/iterate/apps/os/sandbox/s6-daemons && for svc in $S6DIR/*/; do echo "=== $(basename $svc) ==="; s6-svstat "$svc"; done';

const TERMINAL_PORT = 22222;
const DEFAULT_DAEMON_PORT = 3000;

export interface DaytonaProviderConfig {
  apiKey: string;
  snapshotPrefix: string;
  externalId: string;
  buildProxyUrl: (port: number) => string;
}

export function createDaytonaProvider(config: DaytonaProviderConfig): MachineProvider {
  const { apiKey, snapshotPrefix, externalId, buildProxyUrl } = config;
  const daytona = new Daytona({ apiKey });

  const getNativeUrl = (port: number) => `https://${port}-${externalId}.proxy.daytona.works`;

  return {
    type: "daytona",

    async create(machineConfig: CreateMachineConfig): Promise<MachineProviderResult> {
      const snapshotName = await resolveLatestSnapshot(snapshotPrefix, { apiKey });

      const sandbox = await daytona.create({
        name: machineConfig.machineId,
        snapshot: snapshotName,
        envVars: machineConfig.envVars,
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

    async start(extId: string): Promise<void> {
      const sandbox = await daytona.get(extId);
      await sandbox.start();
    },

    async stop(extId: string): Promise<void> {
      const sandbox = await daytona.get(extId);
      if (sandbox.state === "started") {
        await sandbox.stop();
      }
    },

    async restart(extId: string): Promise<void> {
      const sandbox = await daytona.get(extId);
      if (sandbox.state === "started") {
        await sandbox.stop();
      }
      await sandbox.start();
    },

    async archive(extId: string): Promise<void> {
      const sandbox = await daytona.get(extId);
      if (sandbox.state === "started") {
        await sandbox.stop();
      }
      await sandbox.archive();
    },

    async delete(extId: string): Promise<void> {
      const sandbox = await daytona.get(extId);
      if (sandbox.state === "started") {
        await sandbox.stop();
      }
      await sandbox.delete();
    },

    getPreviewUrl(port: number): string {
      return getNativeUrl(port);
    },

    previewUrl: getNativeUrl(DEFAULT_DAEMON_PORT),

    displayInfo: {
      label: "Daytona",
      isDevOnly: false,
    },

    commands: [
      { label: "Daemon logs", command: `tail -f ${DAEMON_LOG}` },
      { label: "OpenCode logs", command: `tail -f ${OPENCODE_LOG}` },
      { label: "Service status", command: S6_STATUS_CMD },
    ],

    terminalOptions: [
      { label: "Direct", url: getNativeUrl(TERMINAL_PORT) },
      { label: "Proxy", url: buildProxyUrl(TERMINAL_PORT) },
    ],
  };
}
