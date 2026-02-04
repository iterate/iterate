import { Daytona } from "@daytonaio/sdk";
import { slugify } from "../utils/slug.ts";
import type {
  MachineProvider,
  CreateMachineConfig,
  MachineProviderResult,
  ProviderState,
} from "./types.ts";

// Common log paths in sandbox (pidnap process manager)
const DAEMON_LOG = "/var/log/pidnap/process/daemon-backend.log";
const OPENCODE_LOG = "/var/log/pidnap/process/opencode.log";
const PIDNAP_STATUS_CMD = "pidnap status";

const TERMINAL_PORT = 22222;
const DEFAULT_DAEMON_PORT = 3000;

export interface DaytonaProviderConfig {
  apiKey: string;
  organizationId?: string;
  snapshotName: string; // iterate-sandbox-{commitSha}
  autoStopInterval: number; // minutes, 0 = disabled
  autoDeleteInterval: number; // minutes, -1 = disabled, 0 = delete on stop
  externalId: string;
  buildProxyUrl: (port: number) => string;
  dopplerConfig?: string;
  appStage?: string;
}

export function createDaytonaProvider(config: DaytonaProviderConfig): MachineProvider {
  const {
    apiKey,
    organizationId,
    snapshotName,
    autoStopInterval,
    autoDeleteInterval,
    externalId,
    buildProxyUrl,
    dopplerConfig,
    appStage,
  } = config;
  const daytona = new Daytona({
    apiKey,
    organizationId,
  });

  const getNativeUrl = (port: number) => `https://${port}-${externalId}.proxy.daytona.works`;

  return {
    type: "daytona",

    async create(machineConfig: CreateMachineConfig): Promise<MachineProviderResult> {
      const configSlug = slugify(dopplerConfig ?? appStage ?? "unknown").slice(0, 30);
      const projectSlug = slugify(machineConfig.envVars["ITERATE_PROJECT_SLUG"] ?? "project").slice(
        0,
        30,
      );
      const machineSlugRaw = slugify(machineConfig.name);
      const machineSlug = (
        machineSlugRaw === "unnamed" ? slugify(machineConfig.machineId) : machineSlugRaw
      ).slice(0, 30);
      const sandboxName = `${configSlug}--${projectSlug}--${machineSlug}`.slice(0, 63);
      const sandbox = await daytona.create({
        name: sandboxName,
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
