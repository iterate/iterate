import { Daytona } from "@daytonaio/sdk";
import type {
  MachineProvider,
  CreateMachineConfig,
  MachineProviderResult,
  ProviderState,
} from "./types.ts";

// Common log paths in sandbox (pidnap process manager)
const DAEMON_LOG = "/var/log/pidnap/process/iterate-daemon.log";
const OPENCODE_LOG = "/var/log/pidnap/process/opencode.log";
const PIDNAP_STATUS_CMD = "pidnap status";

const TERMINAL_PORT = 22222;
const DEFAULT_DAEMON_PORT = 3000;

export interface DaytonaProviderConfig {
  apiKey: string;
  snapshotName: string; // iterate-sandbox-{commitSha}
  autoStopInterval: number; // minutes, 0 = disabled
  autoDeleteInterval: number; // minutes, -1 = disabled, 0 = delete on stop
  externalId: string;
  buildProxyUrl: (port: number) => string;
}

export function createDaytonaProvider(config: DaytonaProviderConfig): MachineProvider {
  const { apiKey, snapshotName, autoStopInterval, autoDeleteInterval, externalId, buildProxyUrl } =
    config;
  const daytona = new Daytona({ apiKey });

  const getNativeUrl = (port: number) => `https://${port}-${externalId}.proxy.daytona.works`;

  return {
    type: "daytona",

    async create(machineConfig: CreateMachineConfig): Promise<MachineProviderResult> {
      const sandbox = await daytona.create({
        name: machineConfig.machineId,
        snapshot: snapshotName,
        envVars: machineConfig.envVars,
        autoStopInterval,
        autoDeleteInterval,
        public: true,
      });
      return { externalId: sandbox.id, metadata: { snapshotName } };
    },

    async start(): Promise<void> {
      const sandbox = await daytona.get(externalId);
      await sandbox.start();
    },

    async stop(): Promise<void> {
      const sandbox = await daytona.get(externalId);
      if (sandbox.state === "started") {
        await sandbox.stop();
      }
    },

    async restart(): Promise<void> {
      const sandbox = await daytona.get(externalId);
      if (sandbox.state === "started") {
        await sandbox.stop();
      }
      await sandbox.start();
    },

    async archive(): Promise<void> {
      const sandbox = await daytona.get(externalId);
      if (sandbox.state === "started") {
        await sandbox.stop();
      }
      await sandbox.archive();
    },

    async delete(): Promise<void> {
      const sandbox = await daytona.get(externalId);
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
      { label: "Service status", command: PIDNAP_STATUS_CMD },
    ],

    terminalOptions: [
      { label: "Direct", url: getNativeUrl(TERMINAL_PORT) },
      { label: "Proxy", url: buildProxyUrl(TERMINAL_PORT) },
    ],

    async getProviderState(): Promise<ProviderState> {
      const sandbox = await daytona.get(externalId);
      return {
        state: sandbox.state ?? "unknown",
        errorReason: sandbox.errorReason,
      };
    },
  };
}
